import { createElement, type IconNode } from 'lucide';
import type { Cue, Track } from '../../shared/routine';
import type { PlayerState } from '../../shared/player-contract';
import { formatTime, t } from './i18n';

export function cueAtSeconds(track: Track, cue: Cue, seconds: number, duration: number): Cue | null {
  const end = Math.min(track.duration, duration);
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || !Number.isFinite(track.duration) || end <= 0) return null;
  const maximum = end - Math.min(0.001, end / 2);
  const position = Math.max(0, Math.min(maximum, seconds));
  if (cue.anchor.kind !== 'count') return { ...cue, anchor: { kind: cue.anchor.kind, seconds: position } };
  if (!Number.isFinite(track.bpm) || track.bpm <= 0 || !Number.isFinite(track.firstBeat)
    || track.firstBeat < 0 || track.firstBeat >= end) return null;
  let lastCount = Math.ceil((end - track.firstBeat) * track.bpm / 60);
  if (track.firstBeat + (lastCount - 1) * 60 / track.bpm >= end) lastCount -= 1;
  const count = Math.max(1, Math.min(lastCount, Math.round((position - track.firstBeat) * track.bpm / 60) + 1));
  return { ...cue, anchor: { kind: 'count', count } };
}

export function nextMoveCountdown(state: Pick<PlayerState, 'nextCue' | 'nextCueIn'>): string {
  if (!state.nextCue) return '';
  if (state.nextCueIn === null || !Number.isFinite(state.nextCueIn)) return t('nextWaiting');
  return t('nextIn', { time: formatTime(Math.ceil(Math.max(0, state.nextCueIn))) });
}

export function createClassMode(root: HTMLElement, exitButton: HTMLButtonElement,
  returnFocus: () => void, changed: (active: boolean) => void) {
  const owner = root.ownerDocument;
  let active = false;
  let disposed = false;
  let requestPending = false;
  let nativeEntered = false;
  const exitFullscreen = () => {
    if (owner.fullscreenElement !== root || typeof owner.exitFullscreen !== 'function') return;
    try { void owner.exitFullscreen().catch(() => {}); }
    catch {}
  };
  const leave = (restoreFocus = true) => {
    if (!active) return;
    active = false;
    nativeEntered = false;
    root.classList.toggle('class-mode', false);
    owner.documentElement.classList.toggle('class-mode-open', false);
    exitButton.hidden = true;
    changed(false);
    if (restoreFocus) returnFocus();
    exitFullscreen();
  };
  const fullscreenChanged = () => {
    if (owner.fullscreenElement === root) {
      nativeEntered = true;
      if (!active || disposed) exitFullscreen();
    } else if (nativeEntered) {
      nativeEntered = false;
      leave();
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (active && event.key === 'Escape') { event.preventDefault(); leave(); }
  };
  const exitClicked = () => leave();
  owner.addEventListener('fullscreenchange', fullscreenChanged);
  owner.addEventListener('keydown', keydown);
  exitButton.addEventListener('click', exitClicked);
  exitButton.hidden = true;
  return {
    enter(fullscreen = true): void {
      if (disposed) return;
      if (!active) {
        active = true;
        root.classList.toggle('class-mode', true);
        owner.documentElement.classList.toggle('class-mode-open', true);
        exitButton.hidden = false;
        changed(true);
        exitButton.focus({ preventScroll: true });
      }
      if (!fullscreen || typeof root.requestFullscreen !== 'function' || owner.fullscreenElement || requestPending) return;
      requestPending = true;
      try {
        void root.requestFullscreen().then(() => {
          requestPending = false;
          fullscreenChanged();
        }, () => { requestPending = false; });
      } catch { requestPending = false; }
    },
    exit: leave,
    dispose(): void {
      disposed = true;
      leave(false);
      owner.removeEventListener('fullscreenchange', fullscreenChanged);
      owner.removeEventListener('keydown', keydown);
      exitButton.removeEventListener('click', exitClicked);
    },
  };
}

export async function watchOfflineShell(
  serviceWorker: Pick<ServiceWorkerContainer, 'register' | 'ready'>,
  status: (value: 'pending' | 'ready' | 'failed') => void,
  updateWaiting: (waiting: boolean) => void,
): Promise<void> {
  status('pending');
  try {
    const registration = await serviceWorker.register('/sw.js');
    const update = () => updateWaiting(Boolean(registration.waiting));
    const watchInstallation = () => {
      update();
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        update();
        if (installing.state === 'redundant' && !registration.active) status('failed');
      });
    };
    registration.addEventListener('updatefound', watchInstallation);
    watchInstallation();
    await serviceWorker.ready;
    status('ready');
    update();
  } catch { status('failed'); }
}

export function createTransportOperation(changed: () => void, failed: (error: unknown) => void) {
  let generation = 0;
  let pending = false;
  return {
    get pending(): boolean { return pending; },
    async run(action: (current: () => boolean) => Promise<void>): Promise<void> {
      if (pending) return;
      const operation = ++generation;
      const current = () => operation === generation;
      pending = true;
      changed();
      try { await action(current); }
      catch (error) { if (current()) failed(error); }
      finally { if (current()) { pending = false; changed(); } }
    },
    cancel(action: () => void): void {
      generation += 1;
      pending = false;
      try { action(); }
      catch (error) { failed(error); }
      finally { changed(); }
    },
  };
}

export function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text?: string): HTMLElementTagNameMap[Tag] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

export function iconButton(label: string, icon: IconNode, action: () => void, showLabel = false): HTMLButtonElement {
  const button = element('button', showLabel ? 'button labeled' : 'button icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  setButtonIcon(button, icon);
  if (showLabel) button.append(element('span', '', label));
  button.addEventListener('click', action);
  return button;
}

export function setButtonIcon(button: HTMLButtonElement, icon: IconNode): void {
  button.querySelector('svg')?.remove();
  button.prepend(createElement(icon, { width: 22, height: 22, 'aria-hidden': 'true', 'stroke-width': 1.8 }));
}

export function field(label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = element('label', 'field');
  wrapper.append(element('span', 'field-label', label), control);
  return wrapper;
}

export function textInput(value: string, maximum: number, change: (value: string) => void): HTMLInputElement {
  const input = element('input');
  input.type = 'text';
  input.value = value;
  input.maxLength = maximum;
  input.addEventListener('input', () => change(input.value));
  return input;
}

export function numberInput(value: number, minimum: number, maximum: number, change: (value: number) => void, step = 'any'): HTMLInputElement {
  const input = element('input');
  input.type = 'number';
  input.inputMode = step === '1' ? 'numeric' : 'decimal';
  input.min = String(minimum);
  input.max = String(maximum);
  input.step = step;
  input.value = String(value);
  input.required = true;
  input.addEventListener('input', () => change(input.valueAsNumber));
  return input;
}

export function selectInput<Value extends string>(value: Value, options: readonly { value: Value; label: string }[], change: (value: Value) => void): HTMLSelectElement {
  const select = element('select');
  for (const option of options) {
    const node = element('option', '', option.label);
    node.value = option.value;
    select.append(node);
  }
  select.value = value;
  select.addEventListener('change', () => change(select.value as Value));
  return select;
}