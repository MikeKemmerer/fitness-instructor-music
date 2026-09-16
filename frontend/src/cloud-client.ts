import { cloudAccessAfterFailure, type CloudAccess, type CloudSession, type CloudUser } from '../../shared/cloud-contract';

export type CloudIdentity = Pick<CloudUser, 'id' | 'authVersion' | 'role'>;
export interface CloudContext {
  access: CloudAccess;
  user: (CloudIdentity & { username?: string }) | null;
  expiresAt: number | null;
}

export type CloudErrorCode = 'signin_required' | 'forbidden' | 'network_unavailable' | 'invalid_session'
  | 'session_changed' | 'invalid_cloud_path' | 'cloud_http_error' | 'response_too_large' | 'cancelled';
export const CLOUD_CHUNK_BYTES = 2 * 1024 * 1024;
export const CLOUD_TIMEOUT_MS = 40_000;
const deadline = (value = CLOUD_TIMEOUT_MS) => Number.isFinite(value) ? Math.max(1, Math.min(45_000, value)) : CLOUD_TIMEOUT_MS;

export class CloudRequestError extends Error {
  readonly code: CloudErrorCode;
  readonly status?: number;
  readonly serverCode?: string;
  constructor(code: CloudErrorCode, status?: number, serverCode?: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.serverCode = serverCode;
  }
}

export function parseCloudIdentity(value: unknown): CloudIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, authVersion, role } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(authVersion)
    || (authVersion as number) < 1 || !['owner', 'editor', 'player'].includes(role as string)) return null;
  return { id, authVersion: authVersion as number, role: role as CloudUser['role'] };
}

export function parseCloudSession(value: unknown, now = Date.now()): CloudSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { user, expiresAt, csrfToken } = value as Record<string, unknown>;
  const identity = parseCloudIdentity(user);
  const username = user && typeof user === 'object' ? (user as Record<string, unknown>).username : null;
  if (!identity || typeof username !== 'string' || !username.trim() || typeof expiresAt !== 'number'
    || !Number.isFinite(expiresAt) || expiresAt <= now || typeof csrfToken !== 'string' || !csrfToken.trim()) return null;
  return { user: { ...identity, username }, expiresAt, csrfToken };
}

async function boundedRequest<Result>(work: (signal: AbortSignal) => Promise<Result>, timeoutMs: number,
  signal?: AbortSignal | null,
  cancellationError = () => new CloudRequestError('network_unavailable')): Promise<Result> {
  const controller = new AbortController();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(cancellationError()); };
  });
  const timer = setTimeout(cancel, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new CloudRequestError('network_unavailable');
      return work(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function boundedBlob(response: Response, maximum: number, signal: AbortSignal,
  assertCurrent: () => void = () => {}): Promise<Blob> {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => {});
    throw new CloudRequestError('response_too_large');
  }
  if (!response.body) throw new CloudRequestError('cloud_http_error', response.status);
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      assertCurrent();
      if (signal.aborted) throw new CloudRequestError('cancelled');
      const chunk = await reader.read();
      assertCurrent();
      if (signal.aborted) throw new CloudRequestError('cancelled');
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new CloudRequestError('response_too_large');
      chunks.push(new Uint8Array(chunk.value).buffer);
    }
    if (length !== null && Number(length) !== bytes) throw new CloudRequestError('cloud_http_error');
    return new Blob(chunks, { type: response.headers.get('Content-Type') ?? '' });
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

async function httpError(response: Response, signal: AbortSignal): Promise<CloudRequestError> {
  let serverCode: string | undefined;
  try {
    const payload: unknown = JSON.parse(await (await boundedBlob(response, 16_384, signal)).text());
    if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      && /^[a-z0-9_]{1,100}$/.test(payload.error)) serverCode = payload.error;
  } catch {}
  const status = response.status;
  return new CloudRequestError(status === 401 ? 'signin_required' : status === 403 ? 'forbidden' : 'cloud_http_error', status, serverCode);
}

export async function fetchCloudSession(fetcher: typeof fetch, timeoutMs = CLOUD_TIMEOUT_MS): Promise<CloudSession> {
  let receivedResponse = false;
  return boundedRequest(async signal => {
    let response: Response;
    try {
      response = await fetcher('/api/auth/session', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      });
    } catch (error) {
      throw new CloudRequestError(error instanceof TypeError || signal.aborted ? 'network_unavailable' : 'invalid_session');
    }
    receivedResponse = true;
    if (response.redirected) throw new CloudRequestError('invalid_session');
    if (!response.ok) throw await httpError(response, signal);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new CloudRequestError('invalid_session'); }
    const session = parseCloudSession(payload);
    if (!session) throw new CloudRequestError('invalid_session');
    return session;
  }, deadline(timeoutMs), undefined, () => new CloudRequestError(receivedResponse ? 'invalid_session' : 'network_unavailable'));
}

export interface CloudClientDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export function createCloudClient(dependencies: CloudClientDependencies = {}) {
  const fetcher: typeof fetch = (...args) => (dependencies.fetch ?? globalThis.fetch)(...args);
  const now = dependencies.now ?? Date.now;
  let context: CloudContext = { access: 'signin-required', user: null, expiresAt: null };
  let csrfToken: string | null = null;
  let generation = 0;
  let admissionGuard: () => void = () => {};
  const subscribers = new Set<(state: CloudContext) => void>();
  const getContext = (): CloudContext => ({ ...context, user: context.user ? { ...context.user } : null });
  const notify = () => {
    for (const listener of subscribers) {
      try { listener(getContext()); } catch {}
    }
  };
  const setAccess = (access: CloudAccess) => {
    context = { ...context, access };
    csrfToken = null;
    generation++;
    notify();
  };
  const assertAdmission = () => {
    try { admissionGuard(); }
    catch { throw new CloudRequestError('session_changed'); }
  };
  const captureIdentity = () => {
    assertAdmission();
    const owner = context.user;
    if (!owner) throw new CloudRequestError('signin_required', 401);
    return () => {
      assertAdmission();
      if (context.user?.id !== owner.id || context.user.authVersion !== owner.authVersion || context.user.role !== owner.role) {
        throw new CloudRequestError('session_changed');
      }
    };
  };
  const admitSession = (value: CloudSession, guard: () => void = admissionGuard,
    _onIdentityChange: () => void = () => {}) => {
    const session = parseCloudSession(value, now());
    if (!session) throw new CloudRequestError('invalid_session');
    guard();
    context = { access: 'online', user: session.user, expiresAt: session.expiresAt };
    csrfToken = session.csrfToken;
    admissionGuard = guard;
    generation++;
    notify();
  };
  const admitLocal = (user: CloudIdentity, access: 'offline' | 'signin-required', guard: () => void,
    _onIdentityChange: () => void = () => {}) => {
    guard();
    admissionGuard = guard;
    context = { access, user: { ...user }, expiresAt: null };
    setAccess(access);
  };
  const applyFailure = (error: unknown) => {
    if (!(error instanceof CloudRequestError) || error.code === 'session_changed') return;
    if (error.status === 401 || error.status === 403 || error.code === 'network_unavailable') {
      setAccess(cloudAccessAfterFailure(error.status));
    } else if (error.code === 'invalid_session') setAccess('signin-required');
  };
  const refreshSession = async (): Promise<CloudContext> => {
    assertAdmission();
    const version = generation;
    try {
      const session = await fetchCloudSession(fetcher, dependencies.timeoutMs);
      assertAdmission();
      if (version !== generation) throw new CloudRequestError('session_changed');
      if (context.user && (context.user.id !== session.user.id || context.user.authVersion !== session.user.authVersion
        || context.user.role !== session.user.role)) {
        setAccess('signin-required');
        throw new CloudRequestError('session_changed');
      }
      admitSession(session);
      return getContext();
    } catch (error) {
      if (version === generation) applyFailure(error);
      throw error;
    }
  };
  const request = async <Result = unknown>(path: string, options: RequestInit & { responseType?: 'blob' | 'json-response' } = {}): Promise<Result> => {
    const url = new URL(path, 'https://cloud.invalid');
    if (!path.startsWith('/api/') || path.includes('\\') || url.origin !== 'https://cloud.invalid'
      || !url.pathname.startsWith('/api/') || /^\/api\/auth(?:\/|$)/i.test(url.pathname) || url.hash) {
      throw new CloudRequestError('invalid_cloud_path');
    }
    const assertIdentity = captureIdentity();
    if (context.expiresAt !== null && context.expiresAt <= now() && context.access === 'online') setAccess('signin-required');
    if (context.access !== 'online' || !csrfToken) {
      throw new CloudRequestError(context.access === 'forbidden' ? 'forbidden'
        : context.access === 'offline' ? 'network_unavailable' : 'signin_required');
    }
    const version = generation;
    const assertCurrent = () => {
      assertIdentity();
      if (version !== generation) throw new CloudRequestError('session_changed');
    };
    const headers = new Headers(options.headers);
    const method = (options.method ?? 'GET').toUpperCase();
    headers.delete('X-CSRF-Token');
    if (!['GET', 'HEAD'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
    try {
      return await boundedRequest(async signal => {
        assertCurrent();
        let response: Response;
        try {
          response = await fetcher(url.pathname + url.search, {
            ...options, method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
          });
        } catch { throw new CloudRequestError('network_unavailable'); }
        assertCurrent();
        if (response.redirected) throw new CloudRequestError('invalid_session');
        if (!response.ok) {
          const error = await httpError(response, signal);
          assertCurrent();
          throw error;
        }
        let result: unknown;
        try {
          result = response.status === 204 || method === 'HEAD' ? undefined
            : options.responseType === 'blob' ? await boundedBlob(response, CLOUD_CHUNK_BYTES, signal, assertCurrent)
              : await response.json();
        }
        catch (error) {
          if (error instanceof CloudRequestError) throw error;
          if (error instanceof TypeError) throw new CloudRequestError('network_unavailable');
          throw new CloudRequestError('cloud_http_error', response.status);
        }
        assertCurrent();
        if (signal.aborted) throw new CloudRequestError('network_unavailable');
        return (options.responseType === 'json-response' ? { status: response.status, body: result } : result) as Result;
      }, deadline(dependencies.timeoutMs), options.signal, () => new CloudRequestError(options.signal?.aborted ? 'cancelled' : 'network_unavailable'));
    } catch (error) {
      if (version === generation) applyFailure(error);
      throw error;
    }
  };
  return {
    getContext,
    getUser: () => getContext().user,
    getRole: () => context.user?.role ?? null,
    subscribe(listener: (state: CloudContext) => void) {
      subscribers.add(listener);
      listener(getContext());
      return () => { subscribers.delete(listener); };
    },
    admitSession, admitLocal, refreshSession, request, captureIdentity,
    requestJson: <Result = unknown>(path: string, options: RequestInit = {}) =>
      request<{ status: number; body: Result }>(path, { ...options, responseType: 'json-response' }),
    requestBlob: (path: string, options: RequestInit = {}) => request<Blob>(path, { ...options, responseType: 'blob' }),
    invalidate() { context = { access: 'signin-required', user: null, expiresAt: null }; setAccess('signin-required'); },
  };
}

export type CloudClient = ReturnType<typeof createCloudClient>;
export const cloudClient = createCloudClient();
export const getCloudContext = cloudClient.getContext;
export const getCloudUser = cloudClient.getUser;
export const getCloudRole = cloudClient.getRole;
export const subscribeCloudSession = cloudClient.subscribe;
export const refreshCloudSession = cloudClient.refreshSession;
export const requestCloud = cloudClient.request;
export const requestCloudBlob = cloudClient.requestBlob;
export const captureCloudIdentity = cloudClient.captureIdentity;