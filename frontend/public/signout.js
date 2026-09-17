import { accessKeys, createAccessFeedback, isCloudSession, requestAuth } from './signin.js';

export const signoutKeys = accessKeys;
export const logoutUrl = '/signin.html';

export async function retireHostedWorkers(serviceWorker) {
  if (!serviceWorker) return;
  const registrations = await serviceWorker.getRegistrations();
  for (const registration of registrations) {
    if (new URL(registration.scope).origin !== location.origin) continue;
    const workers = [...new Set([registration.installing, registration.waiting, registration.active].filter(Boolean))];
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('worker_timeout')); }, 10000);
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data?.retired === true) resolve();
        else reject(new Error('worker_retirement_failed'));
      };
      try { worker.postMessage({ type: 'RETIRE_REHEARSAL' }, [channel.port2]); }
      catch (error) { clearTimeout(timer); channel.port1.close(); reject(error); }
    })));
    if (!await registration.unregister()) throw new Error('worker_unregister_failed');
  }
}

export function deleteLocalDatabase(database) {
  return new Promise((resolve, reject) => {
    const request = database.deleteDatabase('fitness-rehearsal');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('cleanup_failed'));
    request.onblocked = () => reject(new Error('cleanup_blocked'));
  });
}

export async function purgeHostedSession({ storage, cacheStorage, database, replace, resetId,
  fetch: fetcher = globalThis.fetch, events, retireWorkers = async () => {}, timeoutMs = 15_000 }) {
  const reset = `logout:${resetId()}`;
  storage.setItem(signoutKeys.reset, reset);
  events?.dispatchEvent(new Event('fitness-hosted-invalidate'));
  let active = true;
  const checkCurrent = () => {
    if (!active || storage.getItem(signoutKeys.reset) !== reset) throw new Error('session_changed');
  };
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('cleanup_timeout')), timeoutMs);
  });
  const purge = async () => {
    await retireWorkers();
    checkCurrent();
    const names = await cacheStorage.keys();
    checkCurrent();
    await Promise.all(names.filter(name => name.startsWith('fitness-rehearsal')).map(name => cacheStorage.delete(name)));
    checkCurrent();
    const remaining = await cacheStorage.keys();
    checkCurrent();
    if (remaining.some(name => name.startsWith('fitness-rehearsal'))) throw new Error('cleanup_failed');
    await deleteLocalDatabase(database);
  };
  try { await Promise.race([purge(), timeout]); }
  finally { active = false; clearTimeout(timer); }
  if (storage.getItem(signoutKeys.reset) !== reset) throw new Error('session_changed');
  storage.removeItem(signoutKeys.user);
  storage.removeItem(signoutKeys.preferences);
  storage.removeItem('fitness-class-active');
  const checkLogout = () => {
    if (storage.getItem(signoutKeys.reset) !== reset || storage.getItem(signoutKeys.user) !== null) {
      throw new Error('session_changed');
    }
  };
  try {
    checkLogout();
    const session = await requestAuth('/api/auth/session', { method: 'GET' }, fetcher, timeoutMs);
    checkLogout();
    if (!isCloudSession(session)) throw new Error('auth_failed');
    await requestAuth('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } }, fetcher, timeoutMs);
  } catch (error) {
    if (error?.status !== 401) throw new Error('server_logout_failed');
  }
  checkLogout();
  storage.removeItem(signoutKeys.reset);
  replace(logoutUrl);
}

export function startSignOutPage(owner = document) {
  const status = owner.getElementById('signout-status');
  const retry = owner.getElementById('signout-retry');
  if (!status || !retry) return;
  let running = false;
  const feedback = createAccessFeedback(status, owner, window);
  let generation = 0;
  window.addEventListener?.('pagehide', () => { generation++; });
  const run = async () => {
    if (running || !feedback.active) return;
    running = true;
    const current = ++generation;
    retry.hidden = true;
    status.className = '';
    status.setAttribute('role', 'status');
    feedback.show('Removing this app\'s local data before signing out...');
    try {
      await purgeHostedSession({
        storage: window.localStorage, cacheStorage: window.caches, database: window.indexedDB,
        fetch: window.fetch.bind(window), events: window,
        retireWorkers: () => retireHostedWorkers(window.navigator.serviceWorker),
        replace: url => window.location.replace(url), resetId: () => window.crypto.randomUUID(),
      });
    } catch (error) {
      if (!feedback.active || current !== generation) return;
      status.className = 'access-error';
      status.setAttribute('role', 'alert');
      feedback.show(error?.message === 'server_logout_failed'
        ? 'Local data was removed, but server sign-out could not be confirmed. Check your connection and retry.'
        : 'Local data could not be fully cleared, so sign-out has not continued. Close other Fitness Music Player tabs, allow site storage, then retry.', true);
      retry.hidden = false;
      retry.focus();
    } finally { running = false; }
  };
  retry.addEventListener('click', () => { void run(); });
  void run();
}

if (typeof document !== 'undefined') startSignOutPage();