export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export const LIMITS = Object.freeze({
  accounts: 32,
  sessionMs: 12 * 60 * 60 * 1000,
  uploadMs: 24 * 60 * 60 * 1000,
  chunkBytes: 2 * 1024 * 1024,
  assetBytes: 128 * 1024 * 1024,
  quotaBytes: 5 * 1024 * 1024 * 1024,
  jsonBytes: 1024 * 1024,
  routines: 512,
  fillers: 512,
  assets: 4096,
  pendingUploads: 64,
});

export type AccountRole = 'owner' | 'editor' | 'player';
export interface Account {
  id: string;
  username: string;
  passwordHash: string;
  role: AccountRole;
  enabled: boolean;
  authVersion: number;
}

export interface CloudConfig {
  origin: string;
  connectionString: string;
  container: string;
  accounts: Account[];
}

export const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);

export const normalizeUsername = (value: string): string => value.trim().toLowerCase();

export function parsePasswordHash(value: unknown): { salt: Buffer; hash: Buffer } {
  if (typeof value !== 'string' || !/^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(value)) {
    throw new ApiError(503, 'unconfigured');
  }
  const fields = value.split('$');
  return { salt: Buffer.from(fields[4]!, 'hex'), hash: Buffer.from(fields[5]!, 'hex') };
}

export function loadConfig(env: NodeJS.ProcessEnv): CloudConfig {
  try {
    const origin = env.FIM_ORIGIN ?? '';
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error();
    const connectionString = env.FIM_STORAGE_CONNECTION_STRING ?? '';
    if (connectionString.length > 4096) throw new Error();
    const settings = new Map<string, string>();
    for (const part of connectionString.replace(/;$/, '').split(';')) {
      const separator = part.indexOf('=');
      const key = part.slice(0, separator);
      if (separator < 1 || settings.has(key)) throw new Error();
      settings.set(key, part.slice(separator + 1));
    }
    if (settings.size !== 4 || settings.get('DefaultEndpointsProtocol') !== 'https' ||
        settings.get('EndpointSuffix') !== 'core.windows.net' || !/^[a-z0-9]{3,24}$/.test(settings.get('AccountName') ?? '') ||
        !/^[A-Za-z0-9+/]{86}==$/.test(settings.get('AccountKey') ?? '') ||
        Buffer.from(settings.get('AccountKey')!, 'base64').toString('base64') !== settings.get('AccountKey')) throw new Error();
    const container = env.FIM_STORAGE_CONTAINER ?? '';
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(container) || container.includes('--')) throw new Error();
    const raw = env.FIM_ACCOUNTS_JSON ?? '';
    if (Buffer.byteLength(raw) > 32768) throw new Error();
    const accounts: unknown = JSON.parse(raw);
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > LIMITS.accounts) throw new Error();
    const ids = new Set<string>();
    const usernames = new Set<string>();
    for (const account of accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account) ||
          Object.keys(account).sort().join(',') !== 'authVersion,enabled,id,passwordHash,role,username' ||
          !safeId(account.id) || typeof account.username !== 'string' ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(account.username) ||
          !['owner', 'editor', 'player'].includes(account.role) || typeof account.enabled !== 'boolean' ||
          !Number.isSafeInteger(account.authVersion) || account.authVersion < 1 ||
          ids.has(account.id) || usernames.has(account.username)) throw new Error();
      parsePasswordHash(account.passwordHash);
      ids.add(account.id);
      usernames.add(account.username);
    }
    if (!accounts.some(account => account.enabled && account.role === 'owner')) throw new Error();
    return { origin, connectionString, container, accounts: accounts as Account[] };
  } catch {
    throw new ApiError(503, 'unconfigured');
  }
}