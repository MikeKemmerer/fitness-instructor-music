import type { Track } from '../../shared/routine';
import { element } from './ui';

interface ReorderOptions {
  editable: () => boolean;
  tracks: () => readonly Track[];
  fingerprint: () => string;
  commit: (trackId: string, destination: number) => void;
}

export function createTrackReorder(list: HTMLElement, options: ReorderOptions) {
  const entries: { track: Track; card: HTMLElement; grip: HTMLButtonElement }[] = [];
  const line = element('div', 'track-insertion-line');
  line.hidden = true;
  line.setAttribute('aria-hidden', 'true');
  list.append(line);
  let frame: number | null = null;
  let drag: {
    track: Track; card: HTMLElement; grip: HTMLButtonElement; pointerId: number;
    order: readonly Track[]; ids: string[]; fingerprint: string;
    startX: number; startY: number; clientX: number; clientY: number;
    moved: boolean; destination: number; time: number | null;
  } | null = null;

  const rendered = () => options.editable() && list.isConnected
    && entries.length === options.tracks().length
    && entries.every((entry, index) => entry.track === options.tracks()[index]);
  const valid = () => rendered() && !!drag
    && drag.order.every((track, index) => track === options.tracks()[index] && track.id === drag!.ids[index]);
  const inside = (clientX: number, clientY: number) => {
    const bounds = list.getBoundingClientRect();
    return clientX >= Math.max(0, bounds.left) && clientX <= Math.min(window.innerWidth, bounds.right)
      && clientY >= Math.max(0, bounds.top) && clientY <= Math.min(window.innerHeight, bounds.bottom);
  };
  const cancel = () => {
    const previous = drag;
    drag = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    line.hidden = true;
    document.removeEventListener('keydown', escape, true);
    if (!previous) return;
    previous.card.classList.toggle('track-dragging', false);
    previous.grip.setAttribute('aria-pressed', 'false');
    if (previous.grip.hasPointerCapture(previous.pointerId)) previous.grip.releasePointerCapture(previous.pointerId);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  };
  const position = () => {
    if (!drag) return false;
    const others = entries.filter(entry => entry.track !== drag!.track).map(entry => entry.card.getBoundingClientRect());
    const last = others.at(-1);
    if (!last) { cancel(); return false; }
    const next = others.findIndex(bounds => drag!.clientY < bounds.top + bounds.height / 2);
    drag.destination = next < 0 ? others.length : next;
    const edge = next < 0 ? last.bottom : others[next]!.top;
    const bounds = list.getBoundingClientRect();
    line.style.setProperty('top', `${Math.max(0, Math.min(bounds.height, edge - bounds.top))}px`);
    line.hidden = false;
    return true;
  };
  const tick = (time: number) => {
    frame = null;
    if (!valid() || !drag || !inside(drag.clientX, drag.clientY)) { cancel(); return; }
    if (drag.moved) {
      const bounds = list.getBoundingClientRect();
      const margin = Math.min(64, window.innerHeight / 3);
      const speed = drag.clientY < margin ? -Math.min(1, (margin - drag.clientY) / margin)
        : drag.clientY > window.innerHeight - margin ? Math.min(1, (drag.clientY - window.innerHeight + margin) / margin) : 0;
      const elapsed = drag.time === null ? 16 : Math.min(32, Math.max(0, time - drag.time));
      const distance = Math.max(Math.min(0, bounds.top - drag.clientY + 1),
        Math.min(Math.max(0, bounds.bottom - drag.clientY - 1), speed * elapsed * 0.72));
      if (distance) window.scrollBy({ top: distance, behavior: 'instant' });
      if (!position()) return;
    }
    drag.time = time;
    frame = requestAnimationFrame(tick);
  };
  const bind = (track: Track, card: HTMLElement, grip: HTMLButtonElement) => {
    entries.push({ track, card, grip });
    grip.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
    grip.addEventListener('pointerdown', event => {
      if (drag || event.button !== 0 || !event.isPrimary || !rendered() || entries.length < 2
        || !grip.isConnected || !inside(event.clientX, event.clientY)) return;
      event.preventDefault();
      event.stopPropagation();
      grip.focus({ preventScroll: true });
      drag = { track, card, grip, pointerId: event.pointerId, order: [...options.tracks()],
        ids: options.tracks().map(entry => entry.id), fingerprint: options.fingerprint(),
        startX: event.clientX, startY: event.clientY, clientX: event.clientX, clientY: event.clientY,
        moved: false, destination: entries.findIndex(entry => entry.track === track), time: null };
      try { grip.setPointerCapture(event.pointerId); }
      catch { cancel(); return; }
      document.addEventListener('keydown', escape, true);
      frame = requestAnimationFrame(tick);
    });
    grip.addEventListener('pointermove', event => {
      if (!drag || drag.grip !== grip || event.pointerId !== drag.pointerId) return;
      if (!valid() || !inside(event.clientX, event.clientY)) { cancel(); return; }
      event.preventDefault();
      drag.clientX = event.clientX; drag.clientY = event.clientY;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) {
        drag.moved = true;
        card.classList.toggle('track-dragging', true);
        grip.setAttribute('aria-pressed', 'true');
      }
      if (drag.moved) position();
    });
    grip.addEventListener('pointerup', event => {
      if (!drag || drag.grip !== grip || event.pointerId !== drag.pointerId) return;
      const commit = valid() && drag.moved && inside(event.clientX, event.clientY)
        && drag.fingerprint === options.fingerprint();
      drag.clientX = event.clientX; drag.clientY = event.clientY;
      if (commit && !position()) return;
      const destination = drag.destination;
      cancel();
      if (commit) options.commit(track.id, destination);
    });
    for (const name of ['pointercancel', 'lostpointercapture'] as const) {
      grip.addEventListener(name, event => { if (drag?.grip === grip && event.pointerId === drag.pointerId) cancel(); });
    }
    grip.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault(); event.stopPropagation();
      if (!rendered() || !grip.isConnected) return;
      cancel();
      const source = options.tracks().findIndex(entry => entry.id === track.id);
      const destination = Math.max(0, Math.min(options.tracks().length - 1, source + (event.key === 'ArrowUp' ? -1 : 1)));
      if (source >= 0 && source !== destination) options.commit(track.id, destination);
    });
  };
  return { bind, cancel, sync: () => {
    if (drag && (!valid() || drag.fingerprint !== options.fingerprint())) cancel();
    for (const entry of entries) entry.grip.disabled = !rendered() || entries.length < 2;
  } };
}