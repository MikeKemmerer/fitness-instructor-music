import { API_ORIGIN } from './api-config.js';

// Must match SESSION_TOKEN_STORAGE_KEY in frontend/src/cloud-client.ts: a bearer-token fallback
// for browsers (Safari ITP, and increasingly Chrome/Firefox) that block the cross-site session
// cookie set by the standalone API origin.
const SESSION_TOKEN_KEY = 'fitness-cloud-session-token';

export const accessKeys = {
  user: 'fitness-hosted-user', reset: 'fitness-hosted-reset', preferences: 'barre.appearance.v1',
};

export function applyAccessPreferences(owner = document, storage = window.localStorage) {
  try {
    const preferences = JSON.parse(storage.getItem(accessKeys.preferences) ?? 'null');
    if (!preferences || typeof preferences !== 'object') return;
    const root = owner.documentElement;
    if (['light', 'dark'].includes(preferences.mode)) root.dataset.mode = preferences.mode;
    if (['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet'].includes(preferences.accent)) {
      root.dataset.accent = preferences.accent;
    }
    root.dataset.contrast = String(preferences.highContrast === true);
  } catch {}
}

export function isCloudSession(value) {
  const user = value?.user;
  return Boolean(user && typeof user.id === 'string' && user.id.trim()
    && typeof user.username === 'string' && user.username.trim()
    && ['owner', 'editor', 'player'].includes(user.role)
    && Number.isSafeInteger(user.authVersion) && user.authVersion > 0
    && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()
    && typeof value.csrfToken === 'string' && value.csrfToken.trim());
}

export async function requestAuth(path, options, fetcher = window.fetch.bind(window), timeoutMs = 10_000, storage = window.localStorage) {
  if (!['/api/auth/session', '/api/auth/login', '/api/auth/logout'].includes(path)) throw new Error('auth_failed');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('auth_timeout')); }, timeoutMs);
  });
  const request = async () => {
    let token;
    try { token = storage.getItem(SESSION_TOKEN_KEY); } catch {}
    const headers = { ...(options?.headers ?? {}) };
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(API_ORIGIN + path, {
      ...options, headers, credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (response.redirected) throw new Error('auth_failed');
    if (!response.ok) throw Object.assign(new Error('auth_failed'), { status: response.status });
    return response.status === 204 || path === '/api/auth/logout' ? undefined : await response.json();
  };
  try { return await Promise.race([request(), timeout]); }
  finally { clearTimeout(timer); }
}

export async function signIn({ username, password, fetch: fetcher, storage, replace, resetId, timeoutMs }) {
  const previousReset = storage.getItem(accessKeys.reset);
  if (previousReset?.startsWith('logout:') || previousReset?.startsWith('signin:')) throw new Error('auth_busy');
  const previousUser = storage.getItem(accessKeys.user);
  const assertCurrent = () => {
    if (storage.getItem(accessKeys.reset) !== previousReset || storage.getItem(accessKeys.user) !== previousUser) {
      throw new Error('session_changed');
    }
  };
  let currentSession;
  try {
    currentSession = await requestAuth('/api/auth/session', { method: 'GET' }, fetcher, timeoutMs, storage);
    if (!isCloudSession(currentSession)) throw new Error('auth_failed');
  } catch (error) {
    if (error?.status !== 401) throw error;
  }
  assertCurrent();
  const headers = { 'Content-Type': 'application/json' };
  if (currentSession) headers['X-CSRF-Token'] = currentSession.csrfToken;
  const session = await requestAuth('/api/auth/login', {
    method: 'POST', headers, body: JSON.stringify({ username, password }),
  }, fetcher, timeoutMs, storage);
  if (!isCloudSession(session)) throw new Error('auth_failed');
  assertCurrent();
  if (typeof session.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(session.token)) {
    storage.setItem(SESSION_TOKEN_KEY, session.token);
  }
  let remembered;
  try { remembered = JSON.parse(previousUser ?? 'null'); } catch {}
  if (remembered?.id !== session.user.id || remembered?.authVersion !== session.user.authVersion
    || remembered?.role !== session.user.role) storage.setItem(accessKeys.reset, `switch:${resetId()}`);
  replace('/');
}

export function createAccessFeedback(status, owner, platform) {
  let timer;
  let deadline = 0;
  let disposed = false;
  let suspended = false;
  const expire = () => {
    if (!disposed && deadline && Date.now() >= deadline) { clearTimeout(timer); deadline = 0; status.textContent = ''; }
  };
  const dispose = () => {
    disposed = true; clearTimeout(timer);
    owner.removeEventListener?.('visibilitychange', expire);
    platform.removeEventListener?.('pagehide', hide);
    platform.removeEventListener?.('pageshow', resume);
  };
  const hide = event => { suspended = true; clearTimeout(timer); if (!event.persisted) dispose(); };
  const resume = () => {
    if (disposed) return;
    suspended = false; expire();
    if (deadline) timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  };
  owner.addEventListener?.('visibilitychange', expire);
  platform.addEventListener?.('pagehide', hide);
  platform.addEventListener?.('pageshow', resume);
  return {
    get active() { return !disposed && !suspended; },
    show(text, error = false) {
      if (disposed || suspended) return;
      clearTimeout(timer); status.textContent = text;
      deadline = error && text ? Date.now() + 30000 : 0;
      if (deadline) timer = setTimeout(expire, 30000);
    },
    dispose,
  };
}

export function startSignInPage(owner = document, platform = window) {
  const form = owner.getElementById('signin-form');
  const username = owner.getElementById('signin-username');
  const password = owner.getElementById('signin-password');
  const submit = owner.getElementById('signin-submit');
  const status = owner.getElementById('signin-status');
  const cleanup = owner.getElementById('signin-cleanup');
  if (!form || !username || !password || !submit || !status || !cleanup) return;
  let running = false;
  const feedback = createAccessFeedback(status, owner, platform);
  let generation = 0;
  platform.addEventListener?.('pagehide', () => { generation++; });
  submit.disabled = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (running || !feedback.active || !form.reportValidity()) return;
    running = true;
    const current = ++generation;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.className = '';
    status.setAttribute('role', 'status');
    feedback.show('Signing in...');
    cleanup.hidden = true;
    try {
      const attempt = signIn({
        username: username.value.trim(), password: password.value, fetch: platform.fetch.bind(platform),
        storage: platform.localStorage, replace: url => { if (feedback.active && current === generation) platform.location.replace(url); },
        resetId: () => platform.crypto.randomUUID(),
      });
      password.value = '';
      await attempt;
    } catch (error) {
      if (!feedback.active || current !== generation) return;
      status.className = 'access-error';
      status.setAttribute('role', 'alert');
      feedback.show(error?.status === 429 ? 'Unable to sign in. Please wait before trying again.'
        : 'Unable to sign in. Check your credentials and connection, then try again.', true);
      cleanup.hidden = error?.message !== 'auth_busy' && error?.message !== 'session_changed';
    } finally {
      password.value = '';
      form.removeAttribute('aria-busy');
      submit.disabled = false;
      running = false;
    }
  });
}

if (typeof document !== 'undefined') {
  try { applyAccessPreferences(); } catch {}
  startSignInPage();
}