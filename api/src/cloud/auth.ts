import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import type { CloudSession } from '../../../shared/cloud-contract';
import { ApiError, LIMITS, loadConfig, normalizeUsername, parsePasswordHash, type Account, type CloudConfig } from './config';
import { encode, readJson, updateJson, type BlobStore } from './store';

export const COOKIE_NAME = '__Host-fim-session';
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const accountStamp = (account: Account): string => digest(JSON.stringify(account));
const equal = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

interface SessionRecord {
  userId: string;
  stamp: string;
  csrfToken: string;
  expiresAt: number;
  revoked: boolean;
}

export interface Authenticated {
  account: Account;
  session: CloudSession;
  key: string;
  token: string;
}

let activeHashes = 0;
export async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= 2) throw new ApiError(503, 'auth_busy');
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 },
        (error, result) => error ? reject(new ApiError(503, 'auth_unavailable')) : resolve(result));
    });
  } finally { activeHashes--; }
}

// SameSite=None: the API is hosted on a separate origin (standalone Function App) from the
// frontend (Static Web App); the session cookie must be sent cross-site. The Origin header
// exact-match and CSRF token checks in origin()/authenticate() remain the binding defenses.
export function cookie(token: string, expiresAt: number): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Expires=${new Date(expiresAt).toUTCString()}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}

export class CloudAuth {
  constructor(readonly store: BlobStore, readonly env: () => NodeJS.ProcessEnv, readonly now: () => number = Date.now) {}

  config(): CloudConfig { return loadConfig(this.env()); }

  origin(headers: Headers): void {
    // The frontend and API are on different origins by design; 'cross-site' is expected and
    // accepted here, but the exact Origin header match below remains the binding check.
    const site = headers.get('sec-fetch-site');
    if (headers.get('origin') !== this.config().origin ||
        (site !== null && site !== 'same-origin' && site !== 'cross-site')) {
      throw new ApiError(403, 'origin_forbidden');
    }
  }

  token(headers: Headers): string | null {
    const raw = headers.get('cookie') ?? '';
    if (raw.length > 8192) throw new ApiError(401, 'signin_required');
    const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
    if (!matches.length) return null;
    const token = matches[0]!.slice(COOKIE_NAME.length + 1);
    if (matches.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, 'signin_required');
    return token;
  }

  async authenticate(headers: Headers, write = false, editor = false): Promise<Authenticated> {
    const config = this.config();
    const token = this.token(headers);
    if (!token) throw new ApiError(401, 'signin_required');
    const key = `sessions/${digest(token)}`;
    const stored = await readJson<SessionRecord>(this.store, key, 4096);
    const record = stored?.value;
    const account = config.accounts.find(candidate => candidate.id === record?.userId);
    if (!record || record.revoked || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= this.now() ||
        !account?.enabled || record.stamp !== accountStamp(account)) throw new ApiError(401, 'signin_required');
    if (write) {
      this.origin(headers);
      const csrf = headers.get('x-csrf-token') ?? '';
      if (csrf.length > 128 || !equal(csrf, record.csrfToken)) throw new ApiError(403, 'csrf_invalid');
    }
    if (editor && account.role === 'player') throw new ApiError(403, 'forbidden');
    return { account, key, token, session: {
      user: { id: account.id, username: account.username, role: account.role, authVersion: account.authVersion },
      expiresAt: record.expiresAt, csrfToken: record.csrfToken,
    } };
  }

  async throttle(username: string): Promise<void> {
    const now = this.now();
    const windowMs = 15 * 60 * 1000;
    const charge = async (key: string, limit: number): Promise<void> => {
      await updateJson<number[]>(this.store, key, () => [], previous => {
        if (!Array.isArray(previous) || previous.some(time => !Number.isSafeInteger(time) || time > now)) {
          throw new ApiError(503, 'storage_unavailable');
        }
        const recent = previous.filter(time => time > now - windowMs);
        if (recent.length >= limit) throw new ApiError(429, 'login_throttled');
        return [...recent, now];
      });
    };
    await charge(`throttle/global-${randomInt(8)}`, 8);
    await charge(`throttle/account-${Number.parseInt(digest(username).slice(0, 4), 16) % 64}`, 5);
  }

  async login(headers: Headers, input: unknown): Promise<{ session: CloudSession; setCookie: string }> {
    this.origin(headers);
    const config = this.config();
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'password,username') throw new ApiError(400, 'invalid_input');
    const { username, password } = input as Record<string, unknown>;
    if (typeof username !== 'string' || username.length > 128 || typeof password !== 'string' ||
        Buffer.byteLength(password) > 1024 || !password.length) throw new ApiError(401, 'invalid_credentials');
    const normalized = normalizeUsername(username);
    await this.throttle(normalized);
    let existing: Authenticated | undefined;
    if (this.token(headers)) {
      try { existing = await this.authenticate(headers, true); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
    }
    const account = config.accounts.find(candidate => candidate.username === normalized);
    const hash = parsePasswordHash(account?.passwordHash ?? config.accounts[0]!.passwordHash);
    const actual = await derivePassword(password, hash.salt);
    const correct = timingSafeEqual(actual, hash.hash);
    if (!account?.enabled || !correct) throw new ApiError(401, 'invalid_credentials');
    const fresh = this.config().accounts.find(candidate => candidate.id === account.id);
    if (!fresh || accountStamp(fresh) !== accountStamp(account)) throw new ApiError(401, 'invalid_credentials');
    if (existing) await this.logout(headers);
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = { userId: account.id, stamp: accountStamp(account),
      csrfToken: randomBytes(32).toString('base64url'), expiresAt: this.now() + LIMITS.sessionMs, revoked: false };
    await this.store.put(`sessions/${digest(token)}`, encode(record), null);
    return { session: { user: { id: account.id, username: account.username, role: account.role, authVersion: account.authVersion },
      csrfToken: record.csrfToken, expiresAt: record.expiresAt }, setCookie: cookie(token, record.expiresAt) };
  }

  async logout(headers: Headers): Promise<void> {
    const auth = await this.authenticate(headers, true);
    await updateJson<SessionRecord>(this.store, auth.key, () => { throw new ApiError(401, 'signin_required'); },
      record => ({ ...record, revoked: true }));
  }
}