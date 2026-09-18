import { Check, Pause, Play, Plus, RefreshCw, Square, X } from 'lucide';
import type { CloudAudioItem, CloudRoutine } from '../../shared/cloud-contract';
import type { AudioPreview } from '../../shared/preview-contract';
import { allRoutineTracks, type Track } from '../../shared/routine';
import { captureCloudIdentity, getCloudContext, getCloudRole, subscribeCloudSession } from './cloud-client';
import { cloudErrorMessage } from './cloud-ui';
import { cloudHash, createCloudLibrary } from './cloud-library';
import { cacheCloudTrack, getTrackBlob, listCloudRoutines, listRoutines, listRoutineWorkingCopies } from './offline';
import { formatNumber, t } from './i18n';
import { element, field, iconButton, transientText } from './ui';

export async function audioDuration(blob: Blob, signal: AbortSignal): Promise<number> {
  const audio = document.createElement('audio');
  const url = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      const cancel = () => reject(new Error('cloud_cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      const finish = () => { signal.removeEventListener('abort', cancel); clearTimeout(timer); };
      audio.onloadedmetadata = () => { finish(); Number.isFinite(audio.duration) && audio.duration > 0 && audio.duration <= 1200 ? resolve(audio.duration) : reject(new Error('invalid_audio')); };
      audio.onerror = () => { finish(); reject(new Error('invalid_audio')); };
      timer = setTimeout(() => { finish(); reject(new Error('audio_decode_timeout')); }, 15_000);
      if (signal.aborted) { finish(); cancel(); return; }
      audio.preload = 'metadata'; audio.src = url;
    });
  } finally { clearTimeout(timer); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
}

export function createAudioLibraryPicker(context: {
  library: ReturnType<typeof createCloudLibrary>;
  hosted?: boolean;
  known?(): CloudRoutine[];
  available(): boolean;
  identity(): string;
  remaining(): number;
  added(tracks: Track[], media: CloudRoutine['media']): void;
  preview?: AudioPreview;
  beforePreview?(): void;
  restoreFocus?(): void;
  duration?(blob: Blob, signal: AbortSignal): Promise<number>;
}) {
  const command = iconButton(t('existingAudio'), Plus, open, true);
  let dialog: HTMLDialogElement | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  let dismiss: (() => void) | undefined;
  let checkCurrent: (() => void) | undefined;
  const author = () => context.hosted === false || ['owner', 'editor'].includes(getCloudRole() ?? '');
  const online = () => context.hosted !== false && getCloudContext().access === 'online' && globalThis.navigator?.onLine !== false;
  function open() {
    if (disposed || dialog || !context.available() || !author()) return;
    const source = context.identity();
    const identity = context.hosted === false ? () => {} : captureCloudIdentity();
    const root = element('dialog', 'audio-library-dialog'); dialog = root; root.setAttribute('aria-label', t('existingAudio'));
    const search = element('input'); search.type = 'search';
    const feedback = element('p'); const error = transientText(feedback);
    const rows = element('div', 'audio-library-rows');
    type Item = CloudAudioItem & { cacheTrackId?: string };
    const items = new Map<string, Item>();
    const selected = new Map<string, Item>();
    let cursor: string | undefined;
    let busy = false;
    let generation = 0;
    let previewGeneration = 0;
    let previewController: AbortController | null = null;
    let previewItem: Item | null = null;
    let previewPending = false;
    let previewStatus = '';
    const current = () => { identity(); if (disposed || dialog !== root || source !== context.identity() || !context.available() || !author()) throw new Error('cloud_cancelled'); };
    const cancelPreview = (pause = false, release = true) => {
      previewGeneration++; previewController?.abort(); previewController = null; previewPending = false;
      const previous = previewItem;
      const owned = previous !== null; previewItem = null;
      if (owned && release) { if (pause) context.preview?.pause(); else context.preview?.stop(); }
      if (pause && previous?.cacheTrackId && context.preview?.getState().trackId === previous.cacheTrackId) previewItem = previous;
      if (dialog === root) render();
    };
    let unsubscribePreview = () => {};
    let unsubscribeIdentity = () => {};
    dismiss = () => {
      if (dialog !== root) return;
      generation++; controller?.abort(); controller = null; dialog = null;
      unsubscribePreview(); unsubscribeIdentity(); cancelPreview(); checkCurrent = undefined;
      error.dispose(); root.close(); root.remove();
      if (!disposed) {
        if (context.restoreFocus) context.restoreFocus(); else command.focus();
      }
    };
    checkCurrent = () => { try { current(); } catch { dismiss?.(); } };
    const run = async (action: (signal: AbortSignal) => Promise<void>) => {
      if (busy) return;
      busy = true; const epoch = ++generation; const active = new AbortController(); controller = active; render();
      try { current(); await action(active.signal); current(); }
      catch (reason) { if (dialog === root && epoch === generation) error.show(cloudErrorMessage(reason)); }
      finally { if (dialog === root && epoch === generation) { busy = false; controller = null; render(); } }
    };
    const load = () => run(async signal => {
      if (!online()) {
        const copies = await listRoutineWorkingCopies(); current();
        const envelopes = [...(context.known?.() ?? []), ...copies.map(copy => copy.envelope)];
        const local = await listRoutines(); current();
        const cloud = context.hosted === false ? [] : await listCloudRoutines(); current();
        const assets = Object.assign({}, ...envelopes.map(envelope => envelope.media)) as CloudRoutine['media'];
        for (const routine of [...envelopes.map(envelope => envelope.routine), ...local, ...cloud]) {
          for (const track of allRoutineTracks(routine)) {
            const asset = assets[track.id];
            if (!asset || items.has(asset.id)) continue;
            const blob = await getTrackBlob(track.id); current();
            if (!blob || blob.size !== asset.bytes) continue;
            const hash = await cloudHash(blob); current();
            if (hash !== asset.sha256) continue;
            items.set(asset.id, { asset: structuredClone(asset), title: track.title, duration: track.duration,
              ...(track.bpm === undefined ? {} : { bpm: track.bpm }), cacheTrackId: track.id });
          }
        }
        cursor = undefined; return;
      }
      const page = await context.library.managedPage('song', cursor, { signal }); current();
      for (const item of page.items) items.set(item.asset.id, { asset: item.asset, title: item.metadata.title,
        ...(item.metadata.duration === undefined ? {} : { duration: item.metadata.duration }),
        ...(item.metadata.bpm === undefined ? {} : { bpm: item.metadata.bpm }) });
      cursor = page.cursor;
    });
    const more = iconButton(t('moreAudio'), RefreshCw, () => { if (cursor) void load(); }, true);
    const prepareItem = async (item: Item, signal: AbortSignal, assert: () => void): Promise<Track> => {
      const track: Track = { id: item.cacheTrackId ?? crypto.randomUUID(), title: item.title || item.asset.id,
        duration: item.duration ?? 0, firstBeat: 0, bodyArea: '', cues: [] };
      if (item.bpm !== undefined) track.bpm = item.bpm;
      const check = () => { assert(); if (signal.aborted) throw new Error('cloud_cancelled'); };
      check();
      if (!item.cacheTrackId) {
        if (!online()) throw new Error('missing_audio');
        await context.library.downloadTracks([track], { [track.id]: item.asset }, { signal }); check();
      }
      const blob = await getTrackBlob(track.id); check();
      if (!blob || blob.size !== item.asset.bytes) throw new Error('missing_audio');
      const hash = await cloudHash(blob); check();
      if (hash !== item.asset.sha256) throw new Error('cloud_hash_mismatch');
      const duration = await (context.duration ?? audioDuration)(blob, signal); check();
      if (item.duration !== undefined && Math.abs(duration - item.duration) > 0.1) throw new Error('audio_duration_mismatch');
      track.duration = duration; item.cacheTrackId = track.id;
      return track;
    };
    const preview = async (item: Item) => {
      if (!context.preview || busy || previewPending || !selected.has(item.asset.id)) return;
      const state = context.preview.getState();
      const startSeconds = state.trackId === item.cacheTrackId && state.elapsed < state.duration ? state.elapsed : 0;
      cancelPreview();
      const epoch = ++previewGeneration;
      const active = new AbortController();
      try {
        current(); context.beforePreview?.(); context.preview.stop(); current();
        previewController = active; previewItem = item; previewPending = true; render();
        const assert = () => { current(); if (active.signal.aborted || epoch !== previewGeneration) throw new Error('cloud_cancelled'); };
        const track = await prepareItem(item, active.signal, assert); assert();
        previewPending = false;
        await context.preview.playTrack(track, startSeconds); assert();
      } catch (reason) {
        if (dialog === root && epoch === previewGeneration) { cancelPreview(); error.show(cloudErrorMessage(reason)); }
      } finally {
        if (dialog === root && epoch === previewGeneration) { previewPending = false; previewController = null; render(); }
      }
    };
    const add = iconButton(t('addSelectedAudio'), Check, () => { void run(async signal => {
      cancelPreview();
      if (!selected.size || selected.size > context.remaining()) throw new Error('invalid_routine');
      const tracks: Track[] = [];
      const media: CloudRoutine['media'] = {};
      for (const item of selected.values()) {
        const track = await prepareItem(item, signal, current);
        const blob = await getTrackBlob(track.id); current(); if (!blob) throw new Error('missing_audio');
        track.id = crypto.randomUUID();
        await cacheCloudTrack(track.id, blob, item.asset.sha256); current();
        tracks.push(track); media[track.id] = structuredClone(item.asset);
      }
      current(); context.added(tracks, media); dismiss?.();
    }); }, true);
    function render() {
      rows.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase('en-US');
      for (const item of items.values()) {
        if (query && !item.title.toLocaleLowerCase('en-US').includes(query)) continue;
        const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(item.asset.id); checkbox.disabled = busy;
        checkbox.addEventListener('change', () => {
          if (busy) return;
          try { current(); } catch { dismiss?.(); return; }
          if (checkbox.checked) selected.set(item.asset.id, item);
          else { selected.delete(item.asset.id); if (previewItem === item) cancelPreview(); }
          render();
        });
        const row = element('div', 'audio-library-row');
        row.append(field(item.title || item.asset.id, checkbox));
        row.append(element('span', 'muted', `${item.duration === undefined ? t('unknownDuration') : `${formatNumber(item.duration)} s`}${item.bpm === undefined ? '' : ` / ${formatNumber(item.bpm)} BPM`}`));
        if (context.preview) {
          const controls = element('div', 'action-row');
          const state = context.preview.getState();
          const active = previewItem === item;
          const pause = active && (previewPending || state.playing || state.loading);
          const play = iconButton(t(pause ? 'pausePreview' : 'playPreview'), pause ? Pause : Play, () => {
            if (pause) cancelPreview(true); else void preview(item);
          });
          play.disabled = busy || !selected.has(item.asset.id) || (previewPending && !active);
          const stop = iconButton(t('stop'), Square, () => cancelPreview()); stop.disabled = !active;
          controls.append(play, stop);
          row.append(controls);
        }
        rows.append(row);
      }
      if (!rows.children.length) rows.append(element('p', 'muted', t('noAudioMatches')));
      more.hidden = !cursor; more.disabled = busy; search.disabled = busy;
      add.disabled = busy || !selected.size || selected.size > context.remaining();
    }
    search.addEventListener('input', render);
    root.addEventListener('cancel', event => { event.preventDefault(); dismiss?.(); });
    root.addEventListener('close', () => { if (dialog === root) dismiss?.(); });
    root.append(element('h2', '', t('existingAudio')), field(t('searchAudio'), search), rows, feedback, more, add, iconButton(t('cancel'), X, () => dismiss?.(), true));
    unsubscribePreview = context.preview?.subscribe(state => {
      if (!previewItem) return;
      if (previewPending || state.trackId !== previewItem.cacheTrackId) { cancelPreview(false, false); return; }
      const status = `${state.playing}:${state.loading}:${state.error}`;
      if (status === previewStatus) return;
      previewStatus = status;
      if (state.error) error.show(cloudErrorMessage(new Error(state.error)));
      render();
    }) ?? (() => {});
    if (context.hosted !== false) unsubscribeIdentity = subscribeCloudSession(() => checkCurrent?.());
    document.body.append(root); root.showModal(); void load();
  }
  return { element: command,
    leave() { dismiss?.(); },
    sync() { command.hidden = !author(); command.disabled = !context.available(); checkCurrent?.(); },
    dispose() { disposed = true; dismiss?.(); },
  };
}