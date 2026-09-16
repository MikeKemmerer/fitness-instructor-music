import '@fontsource/dm-sans/400.css';
import './styles.css';
import { t } from './i18n';
import { HostedSessionError, startHostedSession } from './hosted-session';

export async function startApplication(root: HTMLElement, secure: boolean,
  load: () => Promise<unknown> = () => import('./main'),
  hosted = import.meta.env.VITE_HOSTED_PILOT === 'true',
  session: () => Promise<boolean> = startHostedSession): Promise<void> {
  const showError = (https: boolean, error?: unknown) => {
    root.className = 'bootstrap-error';
    root.setAttribute('role', 'alert');
    const heading = document.createElement('h1');
    heading.textContent = t(https ? 'httpsRequired' : 'startupFailed');
    const message = document.createElement('p');
    message.textContent = t(https ? 'httpsRequiredBody' : error instanceof HostedSessionError ? error.code
      : hosted ? 'hostedStartupFailedBody' : 'startupFailedBody');
    root.replaceChildren(heading, message);
    if (hosted && !https) {
      const retry = document.createElement('a');
      retry.className = 'button';
      retry.href = '/';
      retry.textContent = t('hostedRetry');
      root.append(retry);
    }
  };
  if (!secure) { showError(true); return; }
  try {
    if (hosted) {
      root.className = 'bootstrap-error';
      root.setAttribute('role', 'status');
      root.textContent = t('hostedChecking');
      if (!await session()) return;
      root.className = '';
      root.removeAttribute('role');
    }
    await load();
  } catch (error) { showError(false, error); }
}

if (typeof document !== 'undefined') {
  const root = document.querySelector<HTMLElement>('#app');
  if (root) void startApplication(root, globalThis.isSecureContext);
}