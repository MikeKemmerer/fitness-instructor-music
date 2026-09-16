import { cloudClient, CloudRequestError, fetchCloudSession, parseCloudIdentity, parseCloudSession,
  type CloudClient, type CloudIdentity } from './cloud-client';

export const hostedUserKey = 'fitness-hosted-user';
export const hostedResetKey = 'fitness-hosted-reset';
export const hostedCloudSelectionKey = 'fitness-cloud-active';
export const hostedDatabase = 'fitness-rehearsal';
export const hostedSignIn = '/signin.html';
export const hostedDenied = '/access-denied.html';
export const hostedInvalidationEvent = 'fitness-hosted-invalidate';

export class HostedSessionError extends Error {
  readonly code: 'hostedStorageFailed' | 'hostedCleanupFailed';
  constructor(code: 'hostedStorageFailed' | 'hostedCleanupFailed') {
    super(code);
    this.code = code;
  }
}

export type PrincipalDecision = { kind: 'admit'; userId: string } | { kind: 'signin' | 'denied' };

export function decidePrincipal(payload: unknown): PrincipalDecision {
  const session = parseCloudSession(payload);
  return session ? { kind: 'admit', userId: session.user.id } : { kind: 'signin' };
}

export function hostedIdentityMarker(identity: CloudIdentity): string {
  return JSON.stringify({ id: identity.id, authVersion: identity.authVersion, role: identity.role });
}

export function readHostedIdentity(marker: string | null): CloudIdentity | null {
  if (!marker) return null;
  try { return parseCloudIdentity(JSON.parse(marker)); }
  catch { return null; }
}

export function deleteHostedDatabase(database: Pick<IDBFactory, 'deleteDatabase'>,
  timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HostedSessionError('hostedCleanupFailed')), timeoutMs);
    const fail = () => { clearTimeout(timer); reject(new HostedSessionError('hostedCleanupFailed')); };
    try {
      const request = database.deleteDatabase(hostedDatabase);
      request.onsuccess = () => { clearTimeout(timer); resolve(); };
      request.onerror = fail;
      request.onblocked = fail;
    } catch { fail(); }
  });
}

export interface HostedSessionDependencies {
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  events: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;
  replace: (url: string) => void;
  deleteDatabase: () => Promise<void>;
  resetId: () => string;
  timeoutMs?: number;
  client?: CloudClient;
}

export async function establishHostedSession(dependencies: HostedSessionDependencies): Promise<boolean> {
  const { storage, events, replace } = dependencies;
  const client = dependencies.client ?? cloudClient;
  let invalidated = false;
  const redirect = (url = hostedSignIn): false => {
    if (!invalidated) {
      invalidated = true;
      client.invalidate();
      events.dispatchEvent(new Event(hostedInvalidationEvent));
      replace(url);
    }
    return false;
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key === null
      || (event.key === hostedResetKey && event.newValue !== null)
      || (event.key === hostedUserKey && event.newValue !== event.oldValue)) redirect();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) { invalidated = false; redirect('/'); }
  };
  events.addEventListener('storage', onStorage);
  events.addEventListener('pageshow', onPageShow);
  let admitted = false;
  try {
    let remembered: string | null;
    let resetting: string | null;
    try {
      remembered = storage.getItem(hostedUserKey);
      resetting = storage.getItem(hostedResetKey);
    } catch { throw new HostedSessionError('hostedStorageFailed'); }
    if (resetting?.startsWith('logout:') || resetting?.startsWith('signin:')) return redirect();
    const guard = (marker: string) => () => {
      try {
        if (!invalidated && storage.getItem(hostedUserKey) === marker && storage.getItem(hostedResetKey) === null) return;
      } catch {}
      redirect();
      throw new CloudRequestError('session_changed');
    };
    let session;
    try { session = await fetchCloudSession(dependencies.fetch, dependencies.timeoutMs); }
    catch (error) {
      if (invalidated) return false;
      const identity = readHostedIdentity(remembered);
      const access = error instanceof CloudRequestError && error.code === 'network_unavailable' ? 'offline'
        : error instanceof CloudRequestError && error.status === 401 ? 'signin-required' : null;
      if (access && identity && remembered && resetting === null
        && storage.getItem(hostedUserKey) === remembered && storage.getItem(hostedResetKey) === null) {
        client.admitLocal(identity, access, guard(remembered), () => { redirect(); });
        admitted = true;
        return true;
      }
      return redirect(error instanceof CloudRequestError && error.status === 403 ? hostedDenied : hostedSignIn);
    }
    if (invalidated) return false;
    if (storage.getItem(hostedUserKey) !== remembered || storage.getItem(hostedResetKey) !== resetting) return redirect();
    const marker = hostedIdentityMarker(session.user);
    if (remembered !== marker || resetting !== null) {
      const reset = dependencies.resetId();
      try { storage.setItem(hostedResetKey, reset); }
      catch { throw new HostedSessionError('hostedStorageFailed'); }
      try { await dependencies.deleteDatabase(); }
      catch { throw new HostedSessionError('hostedCleanupFailed'); }
      if (invalidated) return false;
      if (storage.getItem(hostedResetKey) !== reset || storage.getItem(hostedUserKey) !== remembered) return redirect();
      try {
        storage.removeItem(hostedCloudSelectionKey);
        storage.setItem(hostedUserKey, marker);
        storage.removeItem(hostedResetKey);
      } catch { throw new HostedSessionError('hostedStorageFailed'); }
    }
    client.admitSession(session, guard(marker), () => { redirect(); });
    admitted = true;
    return true;
  } finally {
    if (!admitted) {
      events.removeEventListener('storage', onStorage);
      events.removeEventListener('pageshow', onPageShow);
    }
  }
}

export function startHostedSession(): Promise<boolean> {
  try {
    return establishHostedSession({
      fetch: window.fetch.bind(window), storage: window.localStorage, events: window,
      replace: url => window.location.replace(url),
      deleteDatabase: () => deleteHostedDatabase(window.indexedDB),
      resetId: () => window.crypto.randomUUID(),
    });
  } catch { return Promise.reject(new HostedSessionError('hostedStorageFailed')); }
}