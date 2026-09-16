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

export async function requestAuth(path, options, fetcher = window.fetch.bind(window), timeoutMs = 10_000) {
  if (!['/api/auth/session', '/api/auth/login', '/api/auth/logout'].includes(path)) throw new Error('auth_failed');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('auth_timeout')); }, timeoutMs);
  });
  const request = async () => {
    const response = await fetcher(path, {
      ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
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
    currentSession = await requestAuth('/api/auth/session', { method: 'GET' }, fetcher, timeoutMs);
    if (!isCloudSession(currentSession)) throw new Error('auth_failed');
  } catch (error) {
    if (error?.status !== 401) throw error;
  }
  assertCurrent();
  const headers = { 'Content-Type': 'application/json' };
  if (currentSession) headers['X-CSRF-Token'] = currentSession.csrfToken;
  const session = await requestAuth('/api/auth/login', {
    method: 'POST', headers, body: JSON.stringify({ username, password }),
  }, fetcher, timeoutMs);
  if (!isCloudSession(session)) throw new Error('auth_failed');
  assertCurrent();
  let remembered;
  try { remembered = JSON.parse(previousUser ?? 'null'); } catch {}
  if (remembered?.id !== session.user.id || remembered?.authVersion !== session.user.authVersion
    || remembered?.role !== session.user.role) storage.setItem(accessKeys.reset, `switch:${resetId()}`);
  replace('/');
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
  submit.disabled = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (running || !form.reportValidity()) return;
    running = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.className = '';
    status.setAttribute('role', 'status');
    status.textContent = 'Signing in...';
    cleanup.hidden = true;
    try {
      const attempt = signIn({
        username: username.value.trim(), password: password.value, fetch: platform.fetch.bind(platform),
        storage: platform.localStorage, replace: url => platform.location.replace(url),
        resetId: () => platform.crypto.randomUUID(),
      });
      password.value = '';
      await attempt;
    } catch (error) {
      status.className = 'access-error';
      status.setAttribute('role', 'alert');
      status.textContent = error?.status === 429 ? 'Unable to sign in. Please wait before trying again.'
        : 'Unable to sign in. Check your credentials and connection, then try again.';
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