import { Check, CloudUpload, Pause, Pencil, Play, RefreshCw, Square, Trash2, X } from 'lucide';
import type { CloudRoutine, LibraryUsagePage, ManagedAudioItem } from '../../shared/cloud-contract';
import type { CloudMusicPlaylist, MusicPlaylist } from '../../shared/class-plan';
import type { AudioPreview } from '../../shared/preview-contract';
import { allRoutineFillers, allRoutineTracks, type Routine, type Track, type FillerRecording } from '../../shared/routine';
import * as offline from './offline';
import { captureCloudIdentity, CloudRequestError, getCloudContext, getCloudRole, refreshCloudSession, subscribeCloudSession } from './cloud-client';
import { cloudHash, validateLibraryIntakeDuration, validateLibraryIntakeFilename, type createCloudLibrary, type CloudTransfer } from './cloud-library';
import { cloudErrorMessage } from './cloud-ui';
import { audioDuration } from './audio-library-picker';
import { formatNumber, formatTime, t } from './i18n';
import { element, field, iconButton } from './ui';

export type KnownAudioEnvelope = CloudRoutine | CloudMusicPlaylist;
export type LocalAudioUsage = Pick<LibraryUsagePage, 'references' | 'complete'>;

export async function checkLocalAudioUsage(item: ManagedAudioItem, known: KnownAudioEnvelope[], assert: () => void): Promise<LocalAudioUsage> {
  const stored = await offline.inspectLocalAudioReferences(item.asset, item.kind === 'filler' ? item.id : undefined);
  assert();
  const references: LibraryUsagePage['references'] = [...stored.references];
  const seen = new Set(references.map(value => JSON.stringify([value.kind, value.id, value.revision])));
  let complete = stored.complete;
  let inspected = 0;
  let hashedBytes = 0;
  const add = (kind: 'routine' | 'playlist' | 'class', value: { id: string; name: string; revision: number }) => {
    const key = JSON.stringify([kind, value.id, value.revision]);
    if (!seen.has(key)) { seen.add(key); references.push({ kind, id: value.id, name: value.name, revision: value.revision }); }
  };
  const matchesRecording = (recording?: FillerRecording) => !!recording && (recording.asset.id === item.asset.id
    || recording.asset.sha256 === item.asset.sha256 || (item.kind === 'filler' && recording.id === item.id));
  const inspect = async (value: Routine | MusicPlaylist, media: CloudRoutine['media'] = {}) => {
    assert();
    const routine = 'filler' in value;
    if (routine && allRoutineFillers(value).some(filler => matchesRecording(filler.recording))) add('routine', value);
    for (const track of routine ? allRoutineTracks(value) : value.tracks) {
      if (++inspected > 2000) { complete = false; return; }
      const asset = media[track.id];
      if (asset?.id === item.asset.id || asset?.sha256 === item.asset.sha256 || track.id === item.asset.id) {
        add(routine ? 'routine' : 'playlist', value); break;
      }
      if (!asset) {
        const blob = await offline.getTrackBlob(track.id); assert();
        if (!blob) { complete = false; continue; }
        if (blob.size === item.asset.bytes && (hashedBytes += blob.size) > 128 * 1024 * 1024) { complete = false; continue; }
        if (blob?.size === item.asset.bytes && await cloudHash(blob) === item.asset.sha256) { add(routine ? 'routine' : 'playlist', value); break; }
        assert();
      }
    }
  };
  const inspectEnvelope = (envelope: KnownAudioEnvelope) => inspect('routine' in envelope ? envelope.routine : envelope.playlist, envelope.media);
  for (const envelope of known) await inspectEnvelope(envelope);
  assert();
  return { references, complete };
}

export interface MediaLibraryContext {
  hosted: boolean;
  cloud: ReturnType<typeof createCloudLibrary>;
  preview: AudioPreview;
  known(): KnownAudioEnvelope[];
  busy(): boolean;
  working(value: boolean): void;
  visible(): boolean;
  beforePreview(): void;
  changed(): void;
  catalog?(items: ManagedAudioItem[]): void;
  localUsage?(item: ManagedAudioItem, assert: () => void): Promise<LocalAudioUsage>;
}

export function createMediaLibrary(context: MediaLibraryContext) {
  const root = element('details', 'settings-section media-library');
  root.append(element('summary', '', t('uploadedAudio')));
  const tabs = element('div', 'segmented'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('uploadedAudio'));
  const search = element('input'); search.type = 'search'; search.setAttribute('aria-label', t('searchAudio'));
  const status = element('p', 'media-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const rows = element('div', 'media-table'); rows.setAttribute('role', 'table'); rows.setAttribute('aria-label', t('uploadedAudio'));
  const panel = element('div'); panel.id = 'managed-audio-panel'; panel.setAttribute('role', 'tabpanel');
  const progress = element('progress'); progress.max = 100; progress.hidden = true; progress.setAttribute('aria-label', t('cloudWorking'));
  const files = element('input'); files.type = 'file'; files.multiple = true; files.accept = 'audio/*,.opus,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm';
  files.setAttribute('aria-label', t('audioChooseFiles'));
  let kind: ManagedAudioItem['kind'] = 'song';
  let items: ManagedAudioItem[] = [];
  let cursor: string | undefined;
  let loaded = false;
  let loadRequested = false;
  let disposed = false;
  let controller: AbortController | null = null;
  let previewId: string | null = null;
  let previewLoading = false;
  let previewState = '';
  let closeDialog: (() => void) | null = null;
  let dialogFeedback: HTMLElement | null = null;
  let owner = '';
  let catalogChanged = false;
  type UploadPhase = 'asset' | 'intake' | 'metadata' | 'done';
  type PendingUpload = {
    file: File;
    kind: ManagedAudioItem['kind'];
    phase: UploadPhase;
    track?: Track;
    recording?: FillerRecording;
    committed?: ManagedAudioItem;
    intakeRevision?: number;
    intakeAttempted?: boolean;
    metadataAttempted?: boolean;
  };
  let batch: PendingUpload[] = [];
  const author = () => context.hosted && ['owner', 'editor'].includes(getCloudRole() ?? '');
  const online = () => getCloudContext().access === 'online' && globalThis.navigator?.onLine !== false;
  const active = () => !disposed && context.visible() && root.open && author();
  const blocked = () => !active() || !!controller || context.busy();
  const showError = (error: unknown) => {
    status.textContent = cloudErrorMessage(error);
    if (dialogFeedback) dialogFeedback.textContent = status.textContent;
  };
  const stopPreview = (pause = false) => {
    const id = previewId;
    if (id && context.preview.getState().trackId === id) {
      if (pause) context.preview.pause(); else context.preview.stop();
    }
    if (!pause) previewId = null;
    if (!pause) previewLoading = false;
  };
  const run = async (action: (transfer: CloudTransfer, assert: () => void) => Promise<void>, reconnect = false) => {
    if (blocked() || (!online() && !reconnect)) return;
    let identity: () => void;
    try { identity = captureCloudIdentity(); } catch (error) { showError(error); return; }
    const current = new AbortController(); controller = current;
    const assert = () => { identity(); if (!active() || current.signal.aborted) throw new CloudRequestError('cancelled'); };
    context.working(true); render();
    try {
      assert();
      if (reconnect && !online()) { await refreshCloudSession(); assert(); }
      await action({ signal: current.signal, progress: (completed, total) => {
        assert(); progress.hidden = false; progress.value = total ? Math.min(100, 100 * completed / total) : 0;
      } }, assert);
      assert();
    } catch (error) {
      if (!disposed) { try { identity(); if (!current.signal.aborted) showError(error); } catch {} }
    } finally {
      if (controller === current) controller = null;
      progress.hidden = true; context.working(false);
      if (!disposed) {
        render();
        if (catalogChanged) { catalogChanged = false; try { identity(); context.changed(); } catch {} }
      }
    }
  };
  const load = async (transfer: CloudTransfer, assert: () => void, reset: boolean) => {
    status.textContent = t('audioLoading');
    const page = await context.cloud.managedPage(kind, reset ? undefined : cursor, transfer); assert();
    if (!reset && page.cursor && page.cursor === cursor) throw new Error('cloud_invalid_response');
    items = [...new Map([...(reset ? [] : items), ...page.items].map(item => [item.id, item])).values()].slice(0, 2048);
    cursor = page.cursor; loaded = true;
    context.catalog?.(items);
    status.textContent = items.length >= 2048 ? t('audioPageLimit') : items.length ? '' : t('audioNoUploads');
  };
  const refresh = () => {
    if (blocked() || globalThis.navigator?.onLine === false) return Promise.resolve();
    loadRequested = true;
    return run(async (transfer, assert) => { stopPreview(); await load(transfer, assert, true); }, true);
  };
  const refreshButton = iconButton(t('refreshAudio'), RefreshCw, () => { void refresh(); }, true);
  const more = iconButton(t('moreAudio'), RefreshCw, () => { if (cursor) void run((transfer, assert) => load(transfer, assert, false)); }, true);
  const pendingBatch = () => batch.some(entry => entry.phase !== 'done');
  const cancel = iconButton(t('cancel'), X, () => { controller?.abort(); stopPreview(); status.textContent = t(pendingBatch() ? 'audioBatchCancelled' : 'audioCheckIncomplete'); }, true);
  const tabButtons = new Map<ManagedAudioItem['kind'], HTMLButtonElement>();
  for (const mode of ['song', 'filler'] as const) {
    const button = element('button', '', t(mode === 'song' ? 'managedSongs' : 'managedFillers')); button.type = 'button';
    button.id = `managed-audio-${mode}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    button.addEventListener('click', () => {
      if (kind === mode || (context.busy() && !controller)) return;
      controller?.abort(); stopPreview(); closeDialog?.(); kind = mode; items = []; cursor = undefined; loaded = false; loadRequested = false; render(); void refresh();
    });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const target = event.key === 'Home' ? 'song' : event.key === 'End' ? 'filler' : mode === 'song' ? 'filler' : 'song';
      tabButtons.get(target)?.click(); tabButtons.get(target)?.focus();
    });
    tabButtons.set(mode, button); tabs.append(button);
  }
  const openDialog = (label: string) => {
    closeDialog?.(); stopPreview();
    const dialog = element('dialog', 'library-dialog media-dialog'); dialog.setAttribute('aria-label', label);
    const feedback = element('p'); feedback.setAttribute('role', 'status');
    dialogFeedback = feedback;
    const dismiss = () => { controller?.abort(); dialog.close(); dialog.remove(); closeDialog = null; dialogFeedback = null; if (!disposed) refreshButton.focus(); };
    closeDialog = dismiss;
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.append(element('h2', '', label), feedback);
    root.append(dialog); dialog.showModal();
    return { dialog, feedback, dismiss, current: () => closeDialog === dismiss };
  };
  const edit = (item: ManagedAudioItem) => {
    if (blocked() || !online()) return;
    const { dialog, feedback, dismiss, current } = openDialog(t('editAudio'));
    const title = element('input'); title.maxLength = 300; title.value = item.metadata.title;
    const artist = element('input'); artist.maxLength = 300; artist.value = item.metadata.artist;
    const bpm = element('input'); bpm.type = 'number'; bpm.min = '40'; bpm.max = '220'; bpm.step = 'any'; bpm.value = item.metadata.bpm?.toString() ?? '';
    let revision = item.metadata.revision;
    let conflict = false;
    const save = iconButton(t('saveChanges'), Check, () => {
      if (!current() || blocked() || conflict) return;
      const value = { title: title.value, artist: artist.value, ...(bpm.value.trim() ? { bpm: Number(bpm.value) } : {}) };
      if (value.title.length > 300 || value.artist.length > 300 || (value.bpm !== undefined && (!Number.isFinite(value.bpm) || value.bpm < 40 || value.bpm > 220))) {
        feedback.textContent = t('audioMetadataInvalid'); return;
      }
      void run(async (transfer, assert) => {
        save.disabled = true;
        try {
          const metadata = await context.cloud.putLibraryMetadata(item.kind, item.id, revision, value, transfer); assert();
          if (!current()) return;
          item.metadata = metadata; context.catalog?.(items); status.textContent = t('audioMetadataSaved'); catalogChanged = true; dismiss();
        } catch (error) {
          if (current()) {
            conflict = error instanceof CloudRequestError && (error.status === 409 || error.status === 412);
            feedback.textContent = conflict ? t('audioMetadataConflict') : cloudErrorMessage(error);
            reload.hidden = !conflict;
          }
        } finally { save.disabled = conflict; }
      });
    }, true);
    const reload = iconButton(t('audioReloadRevision'), RefreshCw, () => {
      if (!current() || blocked()) return;
      void run(async (transfer, assert) => {
        const metadata = await context.cloud.libraryMetadata(item.kind, item.id, transfer); assert();
        if (!current()) return;
        item.metadata = metadata; revision = metadata.revision; conflict = false;
        title.value = metadata.title; artist.value = metadata.artist; bpm.value = metadata.bpm?.toString() ?? '';
        context.catalog?.(items);
        save.disabled = false; reload.hidden = true;
        feedback.textContent = `${metadata.title} / ${metadata.artist} / ${metadata.bpm ?? t('unknownValue')}`;
      });
    }, true); reload.hidden = true;
    dialog.append(element('p', 'muted', t('audioMetadataScope')),
      element('p', '', `${t('audioFilename')}: ${item.metadata.filename ?? t('unknownValue')} / ${t('playlistDuration')}: ${item.metadata.duration === undefined ? t('unknownValue') : formatTime(item.metadata.duration)}`),
      field(t('audioTitle'), title), field(t('audioArtist'), artist), field(t('audioBpm'), bpm), save, reload, iconButton(t('cancel'), X, dismiss, true));
    title.focus();
  };
  const remove = (item: ManagedAudioItem) => {
    if (blocked() || !online()) return;
    const { dialog, feedback, dismiss, current } = openDialog(t('deleteAudio'));
    const references = element('ul'); references.setAttribute('aria-label', t('audioReferences'));
    let local: LocalAudioUsage = { references: [], complete: false };
    let complete = false;
    let usageCursor: string | undefined;
    let hasReferences = false;
    let pending = false;
    let checked = false;
    let usagePages = 0;
    const appendReferences = (values: LibraryUsagePage['references']) => {
      hasReferences ||= values.length > 0;
      for (const value of values) references.append(element('li', '', `${value.name} / ${value.kind} / ${value.id}${value.revision === undefined ? '' : ` / ${value.revision}`}`));
    };
    const check = async (transfer: CloudTransfer, assert: () => void) => {
      feedback.textContent = t('audioChecking');
      if (usagePages >= 8) { feedback.textContent = t('audioCheckIncomplete'); continueCheck.hidden = true; confirmDelete.disabled = true; return; }
      if (!checked) {
        local = await (context.localUsage ? context.localUsage(item, assert) : checkLocalAudioUsage(item, context.known(), assert)); assert();
        if (!current()) return; appendReferences(local.references); checked = true;
      }
      const page = await context.cloud.libraryUsage(item.kind, item.id, usageCursor, transfer); assert();
      usagePages++;
      if (!current()) return;
      if (page.cursor && page.cursor === usageCursor) throw new Error('cloud_invalid_response');
      appendReferences(page.references); usageCursor = page.cursor; complete = page.complete && !page.cursor;
      feedback.textContent = t(hasReferences ? 'audioInUse' : !local.complete ? 'audioLocalUncertain' : complete ? 'audioDeleteScope' : 'audioCheckIncomplete');
      confirmDelete.disabled = hasReferences || !local.complete || !complete;
      continueCheck.hidden = complete || !usageCursor;
    };
    const confirmDelete = iconButton(t('deleteAudio'), Trash2, () => {
      if (!current() || blocked() || hasReferences || !local.complete || !complete) return;
      void run(async (transfer, assert) => {
        confirmDelete.disabled = true;
        const rechecked = await (context.localUsage ? context.localUsage(item, assert) : checkLocalAudioUsage(item, context.known(), assert)); assert();
        if (!current()) return;
        if (!rechecked.complete || rechecked.references.length) {
          local = rechecked; appendReferences(rechecked.references); feedback.textContent = t(hasReferences ? 'audioInUse' : 'audioLocalUncertain'); return;
        }
        feedback.textContent = t('audioChecking');
        try {
          const result = await context.cloud.deleteLibraryItem(item.kind, item.id, item.metadata.revision, transfer); assert();
          if (!current()) return;
          if ('pending' in result) {
            pending = true; feedback.textContent = t('audioDeletePending'); continueCheck.hidden = false;
          } else {
            items = items.filter(value => value.id !== item.id); status.textContent = t('audioDeleted'); catalogChanged = true; dismiss();
          }
        } catch (error) {
          if (!current()) return;
          pending = false; complete = false; confirmDelete.disabled = true;
          feedback.textContent = cloudErrorMessage(error);
          if (error instanceof CloudRequestError && error.status === 409) {
            feedback.textContent = t(error.serverCode === 'media_in_use' ? 'audioInUse' : 'audioCheckIncomplete');
            usageCursor = undefined; continueCheck.hidden = false;
            const page = await context.cloud.libraryUsage(item.kind, item.id, undefined, transfer); assert();
            if (current()) { appendReferences(page.references); usageCursor = page.cursor; }
          }
        }
      });
    }, true); confirmDelete.classList.add('danger'); confirmDelete.disabled = true;
    const continueCheck = iconButton(t('audioContinueCheck'), RefreshCw, () => {
      if (!current() || blocked()) return;
      if (pending) { confirmDelete.disabled = false; confirmDelete.click(); }
      else void run(check);
    }, true); continueCheck.hidden = true;
    dialog.append(element('p', '', item.metadata.title || item.metadata.filename || item.id), element('p', 'muted', t('audioDeleteScope')), references,
      confirmDelete, continueCheck, iconButton(t('cancel'), X, dismiss, true));
    void run(check);
  };
  const preview = (item: ManagedAudioItem) => {
    if (blocked() || !online()) return;
    const id = item.recording ? `filler-${item.asset.id}` : `library-${item.asset.id}`;
    const state = context.preview.getState();
    const offset = state.trackId === id && state.elapsed < state.duration ? state.elapsed : 0;
    stopPreview(); context.beforePreview();
    previewId = id; previewLoading = true;
    void run(async (transfer, assert) => {
      try {
        const track: Track = { id, title: item.metadata.title || item.id, duration: item.metadata.duration ?? item.recording?.duration ?? 0, firstBeat: 0, cues: [], bodyArea: '' };
        if (item.recording) await context.cloud.ensureFiller(item.recording, transfer);
        else await context.cloud.downloadTracks([track], { [id]: item.asset }, transfer);
        assert();
        const blob = await offline.getTrackBlob(id); assert();
        if (!blob || blob.size !== item.asset.bytes || await cloudHash(blob) !== item.asset.sha256) throw new Error('track_integrity_failed');
        assert();
        if (!track.duration) track.duration = await audioDuration(blob, transfer.signal!);
        assert();
        await context.preview.playTrack(track, offset); assert(); previewLoading = false; status.textContent = '';
      } catch (error) { stopPreview(); throw error; }
    });
  };
  const uploadBatch = () => run(async (transfer, assert) => {
    stopPreview();
    for (const [index, entry] of batch.entries()) {
      if (entry.phase === 'done') continue;
      assert(); status.textContent = t('audioBatchProgress', { current: index + 1, total: batch.length, name: entry.file.name });
      const filename = entry.file.name;
      const duration = () => entry.track?.duration ?? entry.recording!.duration;
      const desired = { title: filename.replace(/\.[^.]+$/, ''), artist: '' };
      const intakeMatches = (metadata: ManagedAudioItem['metadata']) => metadata.revision >= 1
        && metadata.filename === filename && metadata.duration === duration();
      const desiredMatches = (metadata: ManagedAudioItem['metadata']) => metadata.title === desired.title
        && metadata.artist === desired.artist && metadata.bpm === undefined;
      if (entry.phase === 'asset') {
        if (entry.kind === 'song') {
          entry.track ??= await offline.storeTrack(entry.file); assert();
          try { validateLibraryIntakeDuration(entry.kind, entry.track.duration); }
          catch (error) {
            try { await offline.removeTrack(entry.track.id); } catch {}
            batch = []; files.value = ''; throw error;
          }
          const blob = await offline.getTrackBlob(entry.track.id); assert(); if (!blob) throw new Error('missing_audio');
          const asset = await context.cloud.uploadAsset(blob, transfer); assert();
          entry.committed = { id: asset.id, kind: 'song', asset, metadata: { revision: 0, title: '', artist: '' } };
        } else {
          entry.recording ??= await offline.addFillerRecording(entry.file, filename.replace(/\.[^.]+$/, '').slice(0, 160)); assert();
          try { validateLibraryIntakeDuration(entry.kind, entry.recording.duration); }
          catch (error) {
            try { await offline.removeFillerRecording(entry.recording.id); } catch {}
            batch = []; files.value = ''; throw error;
          }
          const blob = await offline.getFillerRecordingBlob(entry.recording); assert(); if (!blob) throw new Error('missing_audio');
          const recording = await context.cloud.addFiller(entry.recording, blob, transfer); assert();
          entry.committed = { id: recording.id, kind: 'filler', asset: recording.asset, recording, metadata: { revision: 0, title: '', artist: '' } };
        }
        entry.phase = 'intake';
      }
      const item = entry.committed!;
      try {
        if (entry.phase === 'intake') {
          if (entry.intakeAttempted) {
            const authoritative = await context.cloud.libraryMetadata(item.kind, item.id, transfer); assert();
            if (intakeMatches(authoritative)) {
              item.metadata = authoritative;
              if (authoritative.revision === 1) {
                entry.intakeRevision = 1; entry.phase = 'metadata';
              } else if (desiredMatches(authoritative)) {
                entry.phase = 'done';
              } else {
                throw new CloudRequestError('cloud_http_error', 409, 'metadata_conflict');
              }
            } else if (authoritative.revision !== 0 || authoritative.filename !== undefined || authoritative.duration !== undefined) {
              throw new CloudRequestError('cloud_http_error', 409, 'metadata_conflict');
            }
          }
          if (entry.phase === 'intake') {
            entry.intakeAttempted = true;
            const metadata = await context.cloud.recordLibraryIntake(item.kind, item.id, filename, duration(), transfer); assert();
            item.metadata = metadata; entry.intakeRevision = metadata.revision; entry.phase = 'metadata';
          }
        }
        if (entry.phase === 'metadata') {
          if (entry.metadataAttempted) {
            const authoritative = await context.cloud.libraryMetadata(item.kind, item.id, transfer); assert();
            if (authoritative.revision !== entry.intakeRevision && intakeMatches(authoritative) && desiredMatches(authoritative)) {
              item.metadata = authoritative; entry.phase = 'done';
            } else if (authoritative.revision !== entry.intakeRevision) {
              throw new CloudRequestError('cloud_http_error', 409, 'metadata_conflict');
            } else {
              item.metadata = authoritative;
            }
          }
          if (entry.phase === 'metadata') {
            entry.metadataAttempted = true;
            item.metadata = await context.cloud.putLibraryMetadata(item.kind, item.id, entry.intakeRevision!, desired, transfer); assert();
            entry.phase = 'done';
          }
        }
      } catch (error) {
        files.value = '';
        if (!transfer.signal?.aborted) {
          status.textContent = t('audioUploadMetadataFailed');
          try { await load(transfer, assert, true); status.textContent = t('audioUploadMetadataFailed'); } catch { status.textContent = t('audioUploadMetadataFailed'); }
        }
        catalogChanged = true; return;
      }
      catalogChanged = true;
    }
    await load(transfer, assert, true); status.textContent = t('audioBatchDone'); files.value = '';
  });
  const upload = iconButton(t('uploadAudio'), CloudUpload, () => {
    if (blocked() || !online() || !files.files?.length || pendingBatch()) return;
    const selected = Array.from(files.files);
    if (selected.length > 100 || selected.some(file => !file.size || file.size > 32 * 1024 * 1024)) { status.textContent = t('audioByteLimit'); return; }
    try { for (const file of selected) validateLibraryIntakeFilename(file.name); }
    catch (error) { batch = []; files.value = ''; showError(error); render(); return; }
    batch = selected.map(file => ({ file, kind, phase: 'asset' })); void uploadBatch();
  }, true);
  const resume = iconButton(t('resumeAudioUpload'), CloudUpload, () => { if (pendingBatch()) void uploadBatch(); }, true);
  function sync() {
    if (disposed) return;
    const user = getCloudContext().user;
    const identity = JSON.stringify(user ? [user.id, user.authVersion, user.role] : null);
    if (owner !== identity) {
      owner = identity; controller?.abort(); stopPreview(); closeDialog?.(); items = []; cursor = undefined; loaded = false; loadRequested = false; batch = []; files.value = '';
      rows.replaceChildren();
    }
    root.hidden = !author();
    const unavailable = blocked() || !online();
    more.disabled = unavailable;
    refreshButton.disabled = blocked() || globalThis.navigator?.onLine === false;
    more.hidden = !cursor || items.length >= 2048;
    files.disabled = unavailable || pendingBatch();
    upload.disabled = unavailable || !files.files?.length || pendingBatch();
    resume.hidden = !pendingBatch(); resume.disabled = unavailable;
    cancel.hidden = !controller; cancel.disabled = controller?.signal.aborted ?? false;
    root.setAttribute('aria-busy', String(!!controller));
    panel.setAttribute('aria-labelledby', `managed-audio-${kind}`);
    for (const [mode, button] of tabButtons) {
      button.setAttribute('aria-selected', String(mode === kind)); button.tabIndex = mode === kind ? 0 : -1;
      button.disabled = context.busy() && !controller;
    }
    upload.title = t(kind === 'song' ? 'uploadAudio' : 'uploadFillers'); upload.setAttribute('aria-label', upload.title);
    const uploadLabel = upload.querySelector('span'); if (uploadLabel) uploadLabel.textContent = upload.title;
    if (!online()) status.textContent = t('audioOffline');
    if (active() && !loaded && !loadRequested && !unavailable) queueMicrotask(() => {
      if (active() && !loadRequested && !blocked()) void refresh();
    });
  }
  function render() {
    rows.replaceChildren();
    const header = element('div', 'media-row media-heading'); header.setAttribute('role', 'row');
    for (const label of ['audioFilename', 'audioTitle', 'audioArtist', 'playlistDuration', 'audioBpm', 'audioActions'] as const) {
      const cell = element('div', '', t(label)); cell.setAttribute('role', 'columnheader'); header.append(cell);
    }
    rows.append(header);
    const query = search.value.trim().toLocaleLowerCase('en-US');
    let matches = 0;
    for (const item of items) {
      const metadata = item.metadata;
      if (query && ![metadata.title, metadata.artist, metadata.filename ?? ''].some(value => value.toLocaleLowerCase('en-US').includes(query))) continue;
      matches++;
      const row = element('div', 'media-row'); row.setAttribute('role', 'row');
      for (const [label, value] of [[t('audioFilename'), metadata.filename], [t('audioTitle'), metadata.title], [t('audioArtist'), metadata.artist],
        [t('playlistDuration'), metadata.duration === undefined ? undefined : formatTime(metadata.duration)], [t('audioBpm'), metadata.bpm === undefined ? undefined : formatNumber(metadata.bpm)]]) {
        const cell = element('div', 'media-cell', value || t('unknownValue')); cell.setAttribute('role', 'cell'); cell.dataset.label = label; row.append(cell);
      }
      const controls = element('div', 'media-actions'); controls.setAttribute('role', 'cell');
      const id = item.recording ? `filler-${item.asset.id}` : `library-${item.asset.id}`;
      const owned = previewId === id;
      const playing = owned && (previewLoading || context.preview.getState().playing || context.preview.getState().loading);
      const play = iconButton(t(playing ? 'pausePreview' : 'playPreview'), playing ? Pause : Play, () => {
        if (playing) { if (previewLoading) controller?.abort(); stopPreview(true); render(); } else preview(item);
      });
      play.disabled = !playing && (blocked() || !online());
      const stop = iconButton(t('stop'), Square, () => { if (owned) { controller?.abort(); stopPreview(); render(); } }); stop.disabled = !owned;
      const editButton = iconButton(t('editAudio'), Pencil, () => edit(item));
      const deleteButton = iconButton(t('deleteAudio'), Trash2, () => remove(item));
      editButton.disabled = deleteButton.disabled = blocked() || !online();
      controls.append(play, stop, editButton, deleteButton); row.append(controls); rows.append(row);
    }
    if (!matches) rows.append(element('p', 'muted', t(loaded && !items.length ? 'audioNoUploads' : 'noAudioMatches')));
    sync();
  }
  search.addEventListener('input', render); files.addEventListener('change', sync);
  const tools = element('div', 'media-tools'); tools.append(field(t('searchAudio'), search), refreshButton, more);
  const intake = element('div', 'media-intake'); intake.append(files, upload, resume, cancel);
  panel.append(tools, rows, intake, progress, status); root.append(tabs, panel);
  root.addEventListener('toggle', () => {
    if (!root.open) leave(); else { render(); if (!loaded) void refresh(); }
  });
  const unsubscribe = context.preview.subscribe(state => {
    if (!previewId) return;
    const key = `${state.trackId}:${state.playing}:${state.loading}:${state.error}`;
    if (key === previewState) return; previewState = key;
    if ((state.trackId && state.trackId !== previewId) || (!state.trackId && !previewLoading)) { controller?.abort(); previewId = null; }
    if (state.error) status.textContent = cloudErrorMessage(new Error(state.error));
    render();
  }) ?? (() => {});
  const unsubscribeIdentity = subscribeCloudSession(() => { sync(); if (!disposed) render(); });
  function leave() { controller?.abort(); stopPreview(); closeDialog?.(); }
  sync();
  return { element: root, refresh, sync, leave, dispose() { leave(); disposed = true; unsubscribe(); unsubscribeIdentity(); items = []; batch = []; } };
}