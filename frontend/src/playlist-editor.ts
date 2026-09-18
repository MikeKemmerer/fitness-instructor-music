import { ArrowDown, ArrowLeft, ArrowUp, Check, Copy, Download, Ellipsis, GripVertical, ListMusic,
  LockKeyhole, Pause, Play, Plus, RefreshCw, Save, Send, Square, Star, Trash2, UnlockKeyhole, X } from 'lucide';
import { newMusicPlaylist, validateMusicPlaylist, type CloudMusicPlaylist, type MusicPlaylist } from '../../shared/class-plan';
import { newRoutine } from '../../shared/routine';
import type { CloudRoutine } from '../../shared/cloud-contract';
import type { AudioPreview } from '../../shared/preview-contract';
import { captureCloudIdentity, getCloudContext, getCloudRole, refreshCloudSession } from './cloud-client';
import { cloudErrorMessage } from './cloud-ui';
import { cloudHash, createCloudLibrary, type CloudTransfer } from './cloud-library';
import { createClassLibrary } from './class-library';
import { createPlaylistSave, samePlaylistContent } from './playlist-save';
import * as offline from './offline';
import { createDraftProtection } from './draft-protection';
import { createAudioLibraryPicker } from './audio-library-picker';
import { createTrackReorder } from './track-reorder';
import { formatTime, t } from './i18n';
import { actionMenu, element, field, gainSlider, iconButton, setButtonIcon, transientText } from './ui';

interface PlaylistContext {
  hosted: boolean;
  busy(): boolean;
  working(value: boolean): void;
  visible(): boolean;
  preview: AudioPreview;
  known(): CloudRoutine[];
  returnToRoutine(): void;
  message(message: string, error?: boolean): void;
}
type Source = 'local' | 'household';
interface Choice { playlist: MusicPlaylist; source: Source; copy?: offline.PlaylistWorkingCopy }
interface Staged { envelope: CloudMusicPlaylist; source: Source; copy: offline.PlaylistWorkingCopy | null }

export function createPlaylistEditor(context: PlaylistContext) {
  const root = element('section', 'playlist-workspace');
  root.setAttribute('aria-label', t('playlists'));
  const media = createCloudLibrary();
  const library = createClassLibrary(undefined, media);
  const saver = createPlaylistSave(library);
  let playlist: MusicPlaylist | null = null;
  let assets: CloudMusicPlaylist['media'] = {};
  let envelope: CloudMusicPlaylist | null = null;
  let copy: offline.PlaylistWorkingCopy | null = null;
  let source: Source = context.hosted ? 'household' : 'local';
  let persisted = false;
  let dirty = false;
  let busy = false;
  let disposed = false;
  let initialized = false;
  let initializing: Promise<void> | null = null;
  let generation = 0;
  let catalogGeneration = 0;
  let controller: AbortController | null = null;
  let choices: Choice[] = [];
  let knownPlaylists: CloudMusicPlaylist[] = [];
  let ownedPreview: string | null = null;
  let returnVisible = false;
  let dialog: HTMLDialogElement | null = null;
  let dialogDispose: (() => void) | null = null;
  let reorder: ReturnType<typeof createTrackReorder> | null = null;
  const rowSync: Array<() => void> = [];
  const author = () => !context.hosted || ['owner', 'editor'].includes(getCloudRole() ?? '');
  const online = () => context.hosted && getCloudContext().access === 'online' && navigator.onLine !== false;
  const available = () => !disposed && !busy && !context.busy();
  const editable = () => available() && author() && !!playlist && !playlist.locked && !playlist.published;
  const currentEnvelope = (): CloudMusicPlaylist => ({ playlist: structuredClone(playlist!), media: structuredClone(assets) });
  const fail = (error: unknown) => {
    const code = error instanceof Error ? error.message : '';
    const message = t(code === 'playlist_conflict' ? 'playlistConflict' : code === 'playlist_unavailable' ? 'playlistUnavailable'
      : code === 'invalid_playlist' ? 'playlistInvalid' : 'cloudFailed') + (code.startsWith('playlist_') || code === 'invalid_playlist' ? '' : ` ${cloudErrorMessage(error)}`);
    if (chooserDialog.open) chooserErrors.show(message); else context.message(message, true);
  };
  function stopPreview() {
    if (ownedPreview && context.preview.getState().trackId === ownedPreview) context.preview.stop();
    ownedPreview = null;
  }
  async function run(work: (transfer: CloudTransfer, assert: () => void) => Promise<void>, shared = false) {
    if (disposed || busy || (!shared && context.busy())) return;
    busy = true;
    const active = new AbortController(); controller = active;
    const epoch = generation;
    let identity = () => {};
    const assert = () => { identity(); if (disposed || active.signal.aborted || epoch !== generation) throw new Error('cloud_cancelled'); };
    if (!shared) context.working(true);
    sync();
    try { identity = context.hosted ? captureCloudIdentity() : () => {}; assert(); await work({ signal: active.signal }, assert); }
    catch (error) { if (!disposed && (!(error instanceof Error) || error.message !== 'cloud_cancelled')) fail(error); }
    finally {
      if (controller === active) { busy = false; controller = null; }
      if (!shared) context.working(false);
      if (!disposed) { renderMetadata(); sync(); }
    }
  }
  const heading = element('div', 'editor-heading');
  const headingText = element('div', 'editor-heading-copy');
  const title = element('h1', '', t('playlists'));
  const metadata = element('p', 'draft-identity'); metadata.setAttribute('role', 'status');
  headingText.append(title, metadata);
  const headingActions = element('div', 'editor-heading-actions');
  const openDifferent = iconButton(t('openDifferentPlaylist'), Download, openChooser, true);
  const back = iconButton(t('returnToRoutine'), ArrowLeft, () => { if (available()) context.returnToRoutine(); }, true);
  headingActions.append(back, openDifferent); heading.append(headingText, headingActions);
  const workspace = element('div', 'playlist-editor');
  const toolbar = element('div', 'action-row editor-actions');
  const status = element('span', 'playlist-save-status'); status.setAttribute('role', 'status');
  const more = actionMenu(t('moreActions'), Ellipsis);
  const add = actionMenu(t('addTrack'), Plus, true);
  const name = element('input'); name.type = 'text'; name.maxLength = 160;
  name.addEventListener('input', () => { if (editable() && playlist) { playlist.name = name.value; changed(true); } });
  const nameField = field(t('playlistName'), name);
  const tracksHeading = element('div', 'section-heading');
  const total = element('p', 'muted playlist-total');
  tracksHeading.append(element('h2', '', t('playlist')), add.element);
  const rows = element('div', 'playlist-entry-list');
  rows.setAttribute('role', 'list'); rows.setAttribute('aria-label', t('playlist'));
  const announcement = element('p', 'visually-hidden'); announcement.setAttribute('aria-live', 'polite');
  const file = element('input', 'visually-hidden'); file.type = 'file'; file.multiple = true; file.tabIndex = -1;
  file.accept = 'audio/*,.opus,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm'; file.setAttribute('aria-label', t('import'));
  const importAudio = iconButton(t('import'), Plus, () => { if (editable()) file.click(); }, true);
  const picker = createAudioLibraryPicker({ library: media, hosted: context.hosted,
    available: editable, identity: () => `${playlist?.id}:${generation}`, remaining: () => 100 - (playlist?.tracks.length ?? 0),
    known: () => [...context.known(), ...knownPlaylists.map(value => ({ routine: { ...newRoutine(), tracks: value.playlist.tracks }, media: value.media })),
      { routine: { ...newRoutine(), tracks: playlist?.tracks ?? [] }, media: assets }],
    restoreFocus: () => { if (!disposed && context.visible() && playlist) add.trigger.focus({ preventScroll: true }); },
    added: (tracks, addedAssets) => {
      if (!editable() || !playlist || playlist.tracks.length + tracks.length > 100) return;
      for (const track of tracks) { track.cues = []; delete track.after; }
      playlist.tracks.push(...tracks); Object.assign(assets, addedAssets); changed(); renderRows();
    },
  });
  add.commands.append(picker.element, importAudio);
  const protection = createDraftProtection({ editable, apply: (value, attachments) => {
    if (!('tracks' in value) || 'filler' in value) return;
    stopPreview(); playlist = value; assets = attachments.media; dirty = true; generation++;
    observe(); render();
  } });
  function observe(grouped = false) {
    if (playlist) protection.observe({ kind: 'playlist', source, value: playlist,
      baseRevision: copy ? copy.cloudBaseRevision : persisted ? playlist.revision : null, media: assets }, dirty, grouped);
  }
  function changed(grouped = false) { dirty = true; generation++; observe(grouped); renderMetadata(); sync(); }
  async function save(transfer: CloudTransfer, assert: () => void) {
    if (!playlist || !author() || playlist.locked || playlist.published) throw new Error('routine_locked');
    if (validateMusicPlaylist(playlist).length) throw new Error('invalid_playlist');
    const value = await saver.snapshot(playlist, assets); assert();
    const saved = await offline.savePlaylistWorkingCopy(value, { expectedLocalVersion: copy?.localVersion ?? null,
      cloud: source === 'household', cloudBaseRevision: copy ? copy.cloudBaseRevision : source === 'household' && persisted ? playlist.revision : null }); assert();
    copy = saved; playlist = structuredClone(saved.envelope.playlist); assets = structuredClone(saved.envelope.media);
    envelope = source === 'household' && saved.cloudBaseRevision !== null ? structuredClone(saved.envelope) : null;
    persisted = true; dirty = false; observe(); render();
    await remember(); assert();
    context.message(t(saved.pendingCloud ? 'savedPending' : 'playlistSaved'));
    if (saved.pendingCloud && online()) {
      try { const result = await saver.sync(saved, transfer); assert(); if (result) { acceptAcknowledgment(result, saved.localVersion); context.message(t(result.pendingCloud ? 'savedPending' : 'cloudSaved')); } }
      catch (error) {
        assert();
        const latest = await offline.getPlaylistWorkingCopy(saved.envelope.playlist.id); assert();
        if (latest) acceptAcknowledgment(latest, saved.localVersion);
        context.message(`${t('savedPending')} ${cloudErrorMessage(error)}`, true);
      }
    }
    await catalog(transfer, assert, false);
  }
  function acceptAcknowledgment(result: offline.PlaylistWorkingCopy, version: number) {
    if (!playlist || playlist.published || playlist.id !== result.envelope.playlist.id || copy?.localVersion !== version) return;
    const unchanged = !dirty && samePlaylistContent(currentEnvelope(), copy.envelope);
    copy = structuredClone(result);
    if (unchanged) { playlist = structuredClone(result.envelope.playlist); assets = structuredClone(result.envelope.media); }
    else { playlist.revision = result.envelope.playlist.revision; Object.assign(assets, result.envelope.media); }
    envelope = result.cloudBaseRevision === null ? null : structuredClone(result.envelope);
    observe(); render();
  }
  const saveButton = iconButton(t('saveChanges'), Save, () => { if (editable()) void run(save); }, true); saveButton.classList.add('primary');
  const duplicate = iconButton(t('duplicatePlaylist'), Copy, () => nameCopy(), true);
  const lock = iconButton(t('lockPlaylist'), LockKeyhole, () => { void command(playlist?.locked ? 'unlock' : 'lock'); }, true);
  const publish = iconButton(t('cloudPublish'), Send, () => { void command('publish'); }, true);
  const removePlaylist = iconButton(t('deletePlaylist'), Trash2, () => {
    if (!available() || !playlist || !author() || !persisted || dirty || playlist.locked || playlist.published || copy?.pendingCloud
      || (source === 'household' && (!online() || !envelope))) return;
    if (!confirm(t('confirmLibraryAction', { action: t('libraryDelete', { name: playlist.name }) }))) return;
    void run(async (transfer, assert) => {
      if (source === 'household') { await library.savePlaylist(playlist!, envelope, 'delete', transfer); assert(); }
      if (copy) await offline.deletePlaylistWorkingCopy(playlist!.id, copy.localVersion);
      else if (source === 'local') await offline.deleteMusicPlaylist(playlist!.id, playlist!.revision);
      assert(); await offline.clearActivePlaylistSelection(); assert(); stopPreview(); dirty = false; observe();
      playlist = null; assets = {}; envelope = null; copy = null; persisted = false;
      render(); await catalog(transfer, assert);
    });
  }, true);
  const openDraft = iconButton(t('cloudOpenDraft'), Download, () => {
    if (!available() || !playlist?.published || !author() || !online()) return;
    const id = playlist.id;
    void run(async (transfer, assert) => {
      const head = await library.readPlaylistHead(id, transfer); assert();
      const staged = await stage({ playlist: head.playlist, source: 'household' }, transfer, assert);
      await remember(staged); assert(); accept(staged); await catalog(transfer, assert, false);
    });
  }, true);
  more.commands.append(duplicate, openDraft, lock, publish, removePlaylist);
  toolbar.append(protection.element, status, saveButton, more.element);
  workspace.append(toolbar, nameField, tracksHeading, total, rows, announcement, file);
  const footer = element('footer', 'editor-footer');
  const close = iconButton(t('closePlaylist'), X, () => {
    if (!available() || !playlist) return;
    decide(t('closeRoutinePrompt', { name: playlist.name }), close, async (saving, transfer, assert) => {
      if (saving) await save(transfer, assert);
      await offline.clearActivePlaylistSelection(); assert();
      stopPreview(); dirty = false; observe(); playlist = null; assets = {}; envelope = null; copy = null; persisted = false;
      render(); await catalog(transfer, assert, false);
    });
  }, true);
  footer.append(close);
  const chooser = element('section', 'routine-library playlist-library');
  const search = element('input'); search.type = 'search'; search.setAttribute('aria-label', t('searchPlaylists')); search.placeholder = t('searchPlaylists');
  search.addEventListener('input', renderChoices);
  const filters = element('div', 'library-toolbar');
  const locations = new Set<Source>(author() ? ['local', 'household'] : ['household']);
  const statuses = new Set<string>(author() ? ['draft', 'published'] : ['published']);
  const favorites = new Set<string>();
  const locationMenu = actionMenu(t('location'), ListMusic, true);
  const statusMenu = actionMenu(t('statusFilter'), Check, true);
  for (const value of (context.hosted && author() ? ['local', 'household'] : context.hosted ? ['household'] : ['local']) as Source[]) {
    const input = element('input'); input.type = 'checkbox'; input.checked = locations.has(value);
    input.addEventListener('change', () => { input.checked ? locations.add(value) : locations.delete(value); renderChoices(); });
    locationMenu.commands.append(field(t(value === 'local' ? 'localFilter' : 'householdFilter'), input));
  }
  for (const value of (author() ? ['draft', 'published'] : ['published'])) {
    const input = element('input'); input.type = 'checkbox'; input.checked = true;
    input.addEventListener('change', () => { input.checked ? statuses.add(value) : statuses.delete(value); renderChoices(); });
    statusMenu.commands.append(field(t(value === 'draft' ? 'cloudDrafts' : 'cloudPublications'), input));
  }
  const favoritesOnly = element('input'); favoritesOnly.type = 'checkbox'; favoritesOnly.addEventListener('change', renderChoices);
  const refresh = iconButton(t('refreshPlaylists'), RefreshCw, () => { void run(async (transfer, assert) => {
    if (context.hosted && navigator.onLine !== false) { await refreshCloudSession(); assert(); }
    await syncQueue(transfer, assert); await catalog(transfer, assert);
  }); }, true);
  const newButton = iconButton(t('newPlaylist'), Plus, () => {
    if (!available() || !author() || playlist) return;
    playlist = newMusicPlaylist(); playlist.name = t('newPlaylist'); source = context.hosted ? 'household' : 'local';
    assets = {}; copy = null; envelope = null; persisted = false; dirty = true; generation++; observe(); render(); name.focus();
  }, true);
  filters.append(locationMenu.element, statusMenu.element, field(t('favoritesOnly'), favoritesOnly), refresh, newButton);
  const choiceRows = element('div', 'routine-library-rows');
  chooser.append(search, filters, choiceRows);
  const chooserHome = element('div'); chooserHome.append(chooser);
  const chooserDialog = element('dialog', 'library-dialog routine-chooser playlist-chooser'); chooserDialog.setAttribute('aria-label', t('openPlaylistDialog'));
  const chooserHeading = element('div', 'chooser-heading');
  const chooserClose = iconButton(t('closePlaylistChooser'), X, () => dismissChooser());
  chooserHeading.append(element('h2', '', t('openPlaylistDialog')), chooserClose);
  const chooserFeedback = element('p', 'muted');
  const chooserErrors = transientText(chooserFeedback);
  chooserDialog.append(chooserHeading, chooserFeedback);
  chooserDialog.addEventListener('cancel', event => { event.preventDefault(); dismissChooser(); });
  chooserDialog.addEventListener('click', event => { if (event.target === chooserDialog) dismissChooser(); });
  function openChooser() {
    if (!available() || !playlist || chooserDialog.open) return;
    chooserDialog.append(chooser); chooser.hidden = false;
    document.documentElement.classList.add('routine-chooser-open'); chooserDialog.showModal(); search.focus(); renderChoices();
  }
  function dismissChooser(accepted = false) {
    if ((!available() && !accepted) || !chooserDialog.open) return;
    chooserDialog.close(); document.documentElement.classList.remove('routine-chooser-open');
    chooserHome.append(chooser); chooser.hidden = !!playlist;
    if (!disposed && context.visible()) openDifferent.focus({ preventScroll: true });
  }
  function key(value: Choice) { return `${value.source}:${value.playlist.id}:${value.playlist.published}:${value.playlist.revision}`; }
  function isCurrent(value: Choice) {
    return !!playlist && value.source === source && value.playlist.id === playlist.id
      && value.playlist.published === playlist.published && value.playlist.revision === playlist.revision;
  }
  function renderChoices() {
    choiceRows.replaceChildren();
    for (const value of choices) {
      if (!locations.has(value.source) || !statuses.has(value.playlist.published ? 'published' : 'draft')
        || (favoritesOnly.checked && !favorites.has(key(value)))
        || !value.playlist.name.toLocaleLowerCase('en-US').includes(search.value.trim().toLocaleLowerCase('en-US'))) continue;
      const row = element('div', 'routine-library-row');
      const text = element('div', 'routine-library-info');
      text.append(element('strong', '', value.playlist.name), element('span', 'muted',
        `${t(value.source === 'local' ? 'localFilter' : 'householdFilter')} / ${t(value.playlist.published ? 'exportPublished' : 'draft')}${value.copy?.pendingCloud ? ` / ${t('savedPending')}` : ''}`));
      if (isCurrent(value)) { row.setAttribute('aria-current', 'true'); text.append(element('span', 'muted', t('currentPlaylist'))); }
      const favorite = iconButton(t('favorite', { name: value.playlist.name }), Star, () => {
        favorites.has(key(value)) ? favorites.delete(key(value)) : favorites.add(key(value)); renderChoices();
      }); favorite.setAttribute('aria-pressed', String(favorites.has(key(value))));
      const open = iconButton(t('openRoutine', { name: value.playlist.name }), Download, () => {
        if (!available() || isCurrent(value)) return;
        const action = async (saving: boolean, transfer: CloudTransfer, assert: () => void) => {
          const staged = await stage(value, transfer, assert);
          if (saving) await save(transfer, assert);
          await remember(staged); assert();
          if (playlist) { dirty = false; observe(); }
          accept(staged); dismissChooser(true);
        };
        if (dirty && playlist) decide(t('playlistSwitchPrompt', { name: playlist.name }), open, action);
        else void run((transfer, assert) => action(false, transfer, assert));
      }); open.disabled = !available() || isCurrent(value);
      open.dataset.current = String(isCurrent(value)); row.append(text, favorite, open); choiceRows.append(row);
    }
    if (!choiceRows.children.length) choiceRows.append(element('p', 'muted', t('noPlaylistMatches')));
  }
  async function catalog(transfer: CloudTransfer, assert: () => void, remote = true) {
    const request = ++catalogGeneration;
    const local = author() ? await offline.listMusicPlaylists() : []; assert();
    const publications = author() ? await offline.listMusicPlaylistPublications() : []; assert();
    const working = author() ? await offline.listPlaylistWorkingCopies() : []; assert();
    const cached = context.hosted ? await offline.listCachedMusicPlaylists() : []; assert();
    const result = new Map<string, Choice>();
    const addChoice = (value: Choice) => result.set(`${value.source}:${value.playlist.id}:${value.playlist.published}`, value);
    for (const value of [...local, ...publications]) addChoice({ playlist: value, source: 'local' });
    for (const value of cached) if (author() || value.playlist.published) addChoice({ playlist: value.playlist, source: 'household' });
    if (remote && online()) {
      for (const published of (author() ? [false, true] : [true])) {
        for (const [id, value] of result) if (value.source === 'household' && value.playlist.published === published) result.delete(id);
        for (const value of await library.listPlaylists(published, transfer)) addChoice({ playlist: value, source: 'household' });
        assert();
      }
    }
    for (const value of working) {
      const cloud = value.pendingCloud || value.cloudBaseRevision !== null;
      if (cloud) result.delete(`local:${value.envelope.playlist.id}:false`);
      addChoice({ playlist: value.envelope.playlist, source: cloud ? 'household' : 'local', copy: value });
    }
    assert(); if (request !== catalogGeneration) return;
    knownPlaylists = [...cached, ...working.map(value => value.envelope)];
    choices = [...result.values()]; renderChoices();
  }
  async function stage(value: Choice, transfer: CloudTransfer, assert: () => void): Promise<Staged> {
    const reference = value.playlist;
    if (!author() && (value.source !== 'household' || !reference.published)) throw new Error('forbidden');
    let savedCopy = reference.published ? null : await offline.getPlaylistWorkingCopy(reference.id); assert();
    let selected: CloudMusicPlaylist | null = null;
    if (savedCopy && (savedCopy.pendingCloud || value.source === 'local' || !online())) selected = structuredClone(savedCopy.envelope);
    else if (value.source === 'household') {
      selected = online() ? await library.readPlaylist(reference, transfer)
        : await offline.getCachedMusicPlaylist(reference.id, reference.revision, reference.published); assert();
      if (selected && online()) {
        await media.downloadTracks(selected.playlist.tracks, selected.media, transfer,
          reference.published ? { playlistId: reference.id, revision: reference.revision } : undefined); assert();
        await offline.cacheMusicPlaylist(selected); assert();
        if (!reference.published) { savedCopy = await offline.reconcilePlaylistWorkingCopy(selected); assert(); }
      }
    } else {
      const local = await offline.getMusicPlaylist(reference.id, reference.published ? reference.revision : undefined); assert();
      if (local) selected = { playlist: local, media: {} };
    }
    if (!selected || selected.playlist.id !== reference.id || selected.playlist.published !== reference.published) throw new Error('playlist_unavailable');
    if (reference.published && selected.playlist.revision !== reference.revision) throw new Error('playlist_unavailable');
    if (value.source === 'local' && savedCopy) {
      const head = await offline.getMusicPlaylist(reference.id); assert();
      if (head) { selected.playlist.locked = head.locked; selected.playlist.revision = head.revision; }
    }
    for (const track of selected.playlist.tracks) {
      if (!await offline.getTrackBlob(track.id)) throw new Error('playlist_unavailable'); assert();
    }
    return { envelope: selected, source: value.source, copy: savedCopy };
  }
  async function remember(value?: Staged) {
    const selected = value?.envelope.playlist ?? playlist;
    if (!selected) return;
    await offline.setActivePlaylistSelection({ id: selected.id, source: value?.source ?? source, published: selected.published,
      ...(selected.published ? { revision: selected.revision } : {}) });
  }
  function accept(value: Staged) {
    stopPreview(); playlist = structuredClone(value.envelope.playlist); assets = structuredClone(value.envelope.media);
    envelope = value.source === 'household' ? structuredClone(value.envelope) : null;
    source = value.source; copy = value.copy; dirty = false; persisted = true; observe(); render();
  }
  function decide(prompt: string, trigger: HTMLElement,
    action: (saving: boolean, transfer: CloudTransfer, assert: () => void) => Promise<void>) {
    if (dialog || !available()) return;
    if (!dirty) { void run(async (transfer, assert) => { await action(false, transfer, assert); }); return; }
    const modal = element('dialog', 'library-dialog'); dialog = modal;
    modal.setAttribute('aria-label', prompt);
    const feedback = element('p'); const errors = transientText(feedback);
    const dismiss = (focus = true) => {
      errors.dispose(); modal.close(); modal.remove(); dialog = null; dialogDispose = null;
      if (focus && !disposed && context.visible()) trigger.focus({ preventScroll: true });
    };
    dialogDispose = () => dismiss(false);
    const finish = (saving: boolean) => { if (available()) void run(async (transfer, assert) => {
      try { await action(saving, transfer, assert); dismiss(false); }
      catch (error) { errors.show(error instanceof Error && error.message === 'playlist_unavailable' ? t('playlistUnavailable') : cloudErrorMessage(error)); }
    }).then(() => { if (!dialog && context.visible()) (playlist ? openDifferent : newButton).focus({ preventScroll: true }); }); };
    const saveChoice = iconButton(t('saveChanges'), Save, () => finish(true), true); saveChoice.disabled = !editable() || !!validateMusicPlaylist(playlist!).length;
    modal.append(element('h2', '', prompt), feedback, saveChoice,
      iconButton(t('discard'), Trash2, () => finish(false), true), iconButton(t('cancel'), X, () => { if (available()) dismiss(); }, true));
    modal.addEventListener('cancel', event => { event.preventDefault(); if (available()) dismiss(); }); root.append(modal); modal.showModal();
  }
  async function independent(value: MusicPlaylist, known: CloudMusicPlaylist['media'], assert: () => void) {
    const result = { ...structuredClone(value), id: crypto.randomUUID(), revision: 1, locked: false, published: false };
    const resultMedia: CloudMusicPlaylist['media'] = {};
    for (const track of result.tracks) {
      const original = track.id; const blob = await offline.getTrackBlob(original); assert();
      if (!blob) throw new Error('playlist_unavailable');
      const hash = await cloudHash(blob); assert(); track.id = crypto.randomUUID(); track.cues = []; delete track.after;
      await offline.cacheCloudTrack(track.id, blob, hash); assert();
      if (known[original]) resultMedia[track.id] = structuredClone(known[original]);
    }
    return { playlist: result, media: resultMedia };
  }
  function nameCopy() {
    if (!available() || !playlist || !author() || dialog) return;
    const modal = element('dialog', 'library-dialog'); dialog = modal; modal.setAttribute('aria-label', t('duplicatePlaylist'));
    const input = element('input'); input.value = t('copyName', { name: playlist.name.slice(0, 153) }); input.maxLength = 160;
    const feedback = element('p'); const errors = transientText(feedback);
    const dismiss = () => { errors.dispose(); modal.close(); modal.remove(); dialog = null; dialogDispose = null; if (!disposed) more.trigger.focus({ preventScroll: true }); };
    dialogDispose = dismiss;
    modal.append(element('h2', '', t('duplicatePlaylist')), field(t('playlistName'), input), feedback,
      iconButton(t('duplicatePlaylist'), Copy, () => { if (!available() || !input.value.trim()) return; void run(async (_transfer, assert) => {
        try {
          const result = await independent(playlist!, assets, assert); result.playlist.name = input.value.trim();
          stopPreview(); playlist = result.playlist; assets = result.media; envelope = null; copy = null; persisted = false; dirty = true;
          observe(); render(); dismiss(); name.focus();
        } catch (error) { errors.show(cloudErrorMessage(error)); }
      }); }, true), iconButton(t('cancel'), X, () => { if (available()) dismiss(); }, true));
    modal.addEventListener('cancel', event => { event.preventDefault(); if (available()) dismiss(); }); root.append(modal); modal.showModal(); input.focus();
  }
  async function command(action: 'lock' | 'unlock' | 'publish') {
    if (!available() || !author() || !playlist || playlist.published || dirty || !persisted || copy?.pendingCloud
      || (playlist.locked && action !== 'unlock') || (source === 'household' && (!online() || !envelope))) return;
    if (!confirm(t('confirmLibraryAction', { action: t(action === 'lock' ? 'libraryLock' : action === 'unlock' ? 'libraryUnlock' : 'libraryPublish', { name: playlist.name }) }))) return;
    await run(async (transfer, assert) => {
      if (source === 'household') {
        const result = await library.savePlaylist(playlist!, envelope, action, transfer, assets); assert();
        await offline.cacheMusicPlaylist(result); assert();
        const head = result.playlist.published ? await library.readPlaylistHead(result.playlist.id, transfer) : result; assert();
        const reconciled = await offline.reconcilePlaylistWorkingCopy(head); assert();
        accept({ envelope: head, source, copy: reconciled });
      } else {
        const result = await offline.saveMusicPlaylist(playlist!, playlist!.revision, action); assert();
        const head = action === 'publish' ? await offline.getMusicPlaylist(result.id) : result; assert();
        if (!head) throw new Error('playlist_unavailable');
        playlist = structuredClone(head); copy = await offline.getPlaylistWorkingCopy(head.id); assert();
        if (copy) assets = structuredClone(copy.envelope.media);
        observe(); render();
      }
      await remember(); assert(); await catalog(transfer, assert, false);
    });
  }
  file.addEventListener('change', () => {
    add.close();
    const files = Array.from(file.files ?? []); file.value = '';
    if (!editable() || !files.length || !playlist) return;
    if (playlist.tracks.length + files.length > 100) { context.message(t('tooManyTracks'), true); return; }
    void run(async (transfer, assert) => {
      const failures: string[] = []; let imported = 0;
      for (const input of files) {
        try { const track = await offline.storeTrack(input, transfer.signal); assert(); track.cues = []; delete track.after; playlist!.tracks.push(track); dirty = true; imported++; }
        catch (error) { assert(); failures.push(cloudErrorMessage(error)); }
      }
      observe(); render(); context.message([t('importedToast', { count: imported }), ...failures].join('\n'), !!failures.length);
    });
  });
  function move(trackId: string, destination: number) {
    if (!editable() || !playlist) return;
    const index = playlist.tracks.findIndex(value => value.id === trackId);
    if (index < 0 || index === destination || destination < 0 || destination >= playlist.tracks.length) return;
    const track = playlist.tracks.splice(index, 1)[0]!; playlist.tracks.splice(destination, 0, track);
    changed(); renderRows(); announcement.textContent = `${destination + 1}. ${track.title}`;
    rows.querySelector<HTMLElement>(`[data-track-id="${trackId}"] .track-grip`)?.focus({ preventScroll: true });
  }
  function renderRows() {
    reorder?.cancel(); rows.replaceChildren(); rowSync.length = 0;
    reorder = createTrackReorder(rows, { editable, tracks: () => playlist?.tracks ?? [], fingerprint: () => JSON.stringify(playlist), commit: move });
    for (const [index, track] of (playlist?.tracks ?? []).entries()) {
      const row = element('div', 'playlist-entry'); row.dataset.trackId = track.id; row.setAttribute('role', 'listitem');
      const grip = iconButton(t('reorderTrack', { name: track.title }), GripVertical, () => {}); grip.classList.add('track-grip');
      const titleInput = element('input'); titleInput.type = 'text'; titleInput.maxLength = 200; titleInput.value = track.title;
      titleInput.setAttribute('aria-label', t('playlistSong'));
      titleInput.addEventListener('input', () => { if (editable()) { track.title = titleInput.value; changed(true); } });
      const song = element('div', 'playlist-entry-song'); song.append(titleInput, element('span', 'muted', formatTime(track.duration)));
      const gain = gainSlider(t('trackGain'), () => track.gain ?? 1, value => { if (editable()) { track.gain = value; changed(true); } }, editable);
      const preview = element('div', 'action-row playlist-entry-preview');
      const play = iconButton(t('playPreview'), Play, () => {
        if (!available() || !context.visible()) return;
        const state = context.preview.getState();
        if (ownedPreview === track.id && state.trackId === track.id && (state.playing || state.loading)) { context.preview.pause(); return; }
        ownedPreview = track.id;
        void context.preview.playTrack(track).catch(error => { if (!disposed && ownedPreview === track.id) fail(error); });
      });
      const stop = iconButton(t('stop'), Square, stopPreview); preview.append(play, stop);
      const actions = element('div', 'action-row playlist-entry-actions');
      const up = iconButton(t('moveUp'), ArrowUp, () => move(track.id, index - 1));
      const down = iconButton(t('moveDown'), ArrowDown, () => move(track.id, index + 1));
      const repeat = iconButton(t('repeatEntry'), Copy, () => {
        if (!editable() || !playlist || playlist.tracks.length >= 100) return;
        void run(async (_transfer, assert) => {
          const result = await independent({ ...playlist!, tracks: [track] }, assets, assert);
          playlist!.tracks.splice(index + 1, 0, result.playlist.tracks[0]!); Object.assign(assets, result.media); dirty = true; observe(); render();
        });
      });
      const remove = iconButton(t('removePlaylistEntry'), Trash2, () => {
        if (!editable() || !playlist || !confirm(t('confirmRemovePlaylistEntry', { name: track.title }))) return;
        if (ownedPreview === track.id) stopPreview(); playlist.tracks.splice(index, 1); delete assets[track.id]; changed(); renderRows();
      });
      actions.append(up, down, repeat, remove);
      row.append(grip, element('span', 'playlist-track-number', String(index + 1)), song, preview, gain.element, actions);
      rows.append(row); reorder.bind(track, row, grip);
      rowSync.push(() => {
        titleInput.disabled = !editable(); gain.sync(); up.disabled = !editable() || index === 0;
        down.disabled = !editable() || index === (playlist?.tracks.length ?? 0) - 1;
        repeat.disabled = !editable() || (playlist?.tracks.length ?? 0) >= 100; remove.disabled = !editable();
        const state = context.preview.getState(); const active = ownedPreview === track.id && state.trackId === track.id;
        const pausing = active && (state.playing || state.loading);
        const label = t(pausing ? 'pausePreview' : 'playPreview');
        if (play.title !== label) { play.title = label; play.setAttribute('aria-label', label); setButtonIcon(play, pausing ? Pause : Play); }
        play.disabled = !available(); stop.disabled = !active;
      });
    }
    renderMetadata(); sync();
  }
  const recovery = element('details', 'recovery-library'); recovery.append(element('summary', '', t('recoveries')));
  const recoveryRows = element('div'); let recoveryGeneration = 0; let recoveryAllowed = false;
  async function refreshRecovery() {
    if (!available() || !author()) return;
    const epoch = ++recoveryGeneration;
    try {
      const identity = context.hosted ? captureCloudIdentity() : () => {};
      const records = await offline.listDraftRecoveries(); identity();
      if (disposed || epoch !== recoveryGeneration || !available()) return;
      recoveryRows.replaceChildren();
      for (const record of records.filter(value => value.kind === 'playlist')) {
        const row = element('div', 'routine-library-row');
        row.append(element('span', '', `${record.value.name} / ${new Date(record.updatedAt).toLocaleString('en-US')}`),
          iconButton(t('restoreCopy'), Copy, () => { void restoreRecovery(record); }, true),
          iconButton(t('discardRecovery'), Trash2, () => { if (available() && confirm(t('confirmDelete', { name: record.value.name }))) void run(async (_transfer, assert) => {
            await offline.removeDraftRecovery(record.id, record.updatedAt); assert();
          }).then(refreshRecovery); })); recoveryRows.append(row);
      }
      if (!recoveryRows.children.length) recoveryRows.append(element('p', 'muted', t('recoveryEmpty')));
    } catch (error) { if (!disposed) fail(error); }
  }
  async function restoreRecovery(record: offline.DraftRecovery) {
    if (!available() || !author() || record.kind !== 'playlist' || !('tracks' in record.value) || 'filler' in record.value) return;
    const value = record.value;
    decide(t('playlistSwitchPrompt', { name: playlist?.name ?? '' }), recovery.querySelector('summary')!, async (saving, transfer, assert) => {
      const restored = await independent(value, record.media, assert);
      if (saving) await save(transfer, assert);
      stopPreview(); playlist = restored.playlist; playlist.name = t('recoveryCopy', { name: value.name }); assets = restored.media;
      envelope = null; copy = null; persisted = false; dirty = true; source = record.source;
      observe(); render();
    });
  }
  recovery.addEventListener('toggle', () => { if (recovery.open) void refreshRecovery(); });
  recovery.append(iconButton(t('refreshRecoveries'), RefreshCw, () => { void refreshRecovery(); }), recoveryRows);
  root.append(heading, recovery, chooserHome, workspace, footer, chooserDialog);
  function renderMetadata() {
    title.textContent = playlist?.name || t('playlists'); metadata.replaceChildren();
    if (playlist) {
      for (const value of [t('lastSaved', { time: copy ? new Date(copy.savedAt).toLocaleString('en-US') : t('unknownValue') }),
        t('revisionValue', { revision: !persisted ? t('unknownValue') : source === 'household' && copy ? copy.cloudBaseRevision ?? t('unknownValue') : playlist.revision }), t(playlist.published ? 'exportPublished' : 'draft'),
        t(source === 'household' ? 'householdDestination' : 'localDestination'), t(playlist.locked ? 'locked' : 'unlocked')]) metadata.append(element('span', 'identity-value', value));
      metadata.append(element('span', 'identity-id', `ID ${playlist.id}`));
    }
    status.textContent = [dirty ? t('unsaved') : '', copy?.pendingCloud ? t('savedPending') : !dirty ? t('saved') : ''].filter(Boolean).join(' / ');
    total.textContent = t('playlistTotal', { time: formatTime((playlist?.tracks ?? []).reduce((sum, track) => sum + track.duration, 0)) });
  }
  function sync() {
    if (disposed) return;
    const active = !!playlist; workspace.hidden = footer.hidden = metadata.hidden = !active;
    chooser.hidden = active && !chooserDialog.open; openDifferent.hidden = !active; openDifferent.disabled = !available();
    back.hidden = !returnVisible; back.disabled = !available(); close.disabled = !available(); chooserClose.disabled = !available();
    newButton.hidden = active || !author(); newButton.disabled = !available(); refresh.disabled = !available(); search.disabled = !available();
    name.disabled = !editable(); file.disabled = importAudio.disabled = !editable();
    saveButton.hidden = more.element.hidden = add.element.hidden = !author();
    saveButton.disabled = !editable() || (playlist ? validateMusicPlaylist(playlist).length > 0 : true);
    add.trigger.setAttribute('aria-disabled', String(!editable())); if (!editable()) add.close();
    duplicate.disabled = !available() || !active;
    openDraft.hidden = !author() || !playlist?.published || source !== 'household'; openDraft.disabled = !available() || !online();
    const clean = available() && active && author() && !dirty && persisted && !playlist?.published && !copy?.pendingCloud;
    lock.hidden = publish.hidden = removePlaylist.hidden = !!playlist?.published;
    lock.disabled = !clean || (source === 'household' && (!online() || !envelope));
    publish.disabled = lock.disabled || !!playlist?.locked || !playlist?.tracks.length;
    removePlaylist.disabled = lock.disabled || !!playlist?.locked;
    const lockLabel = t(playlist?.locked ? 'unlockPlaylist' : 'lockPlaylist');
    if (lock.title !== lockLabel) { lock.title = lockLabel; lock.setAttribute('aria-label', lockLabel); setButtonIcon(lock, playlist?.locked ? UnlockKeyhole : LockKeyhole); const label = lock.querySelector('span'); if (label) label.textContent = lockLabel; }
    publish.title = t(source === 'household' ? 'cloudPublish' : 'localPublish'); publish.setAttribute('aria-label', publish.title);
    const publishLabel = publish.querySelector('span'); if (publishLabel) publishLabel.textContent = publish.title;
    picker.sync(); protection.sync(); reorder?.sync(); for (const update of rowSync) update();
    recovery.hidden = !author(); const allowed = available() && author();
    if (allowed && !recoveryAllowed && recovery.open) void refreshRecovery(); recoveryAllowed = allowed;
    for (const button of choiceRows.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !available() || button.dataset.current === 'true';
    if (!initialized && context.visible() && available()) queueMicrotask(() => { if (!initialized && context.visible() && available()) void initialize(); });
  }
  function render() { name.value = playlist?.name ?? ''; renderRows(); renderChoices(); }
  async function syncQueue(transfer: CloudTransfer, assert: () => void) {
    if (!online() || !author()) return;
    const copies = await offline.listPlaylistWorkingCopies(); assert();
    for (const pending of copies.filter(value => value.pendingCloud)) {
      try {
        const result = await saver.sync(pending, transfer); assert();
        if (result) acceptAcknowledgment(result, pending.localVersion);
      } catch (error) {
        assert(); const latest = await offline.getPlaylistWorkingCopy(pending.envelope.playlist.id); assert();
        if (latest) acceptAcknowledgment(latest, pending.localVersion);
        throw error;
      }
    }
  }
  async function initialize() {
    if (initializing) return initializing;
    if (initialized || !available()) return;
    initialized = true;
    initializing = run(async (transfer, assert) => {
      await catalog(transfer, assert, false);
      const selection = await offline.getActivePlaylistSelection(); assert();
      if (selection && !playlist) {
        const value = choices.find(value => value.source === selection.source && value.playlist.id === selection.id
          && value.playlist.published === selection.published && (!selection.published || value.playlist.revision === selection.revision));
        if (value) accept(await stage(value, transfer, assert));
      }
      if (online()) await catalog(transfer, assert);
    });
    try { await initializing; } finally { initializing = null; }
  }
  const unsubscribePreview = context.preview.subscribe(() => { if (!disposed) for (const update of rowSync) update(); }) ?? (() => {});
  render();
  return {
    element: root, sync, restoreRecovery,
    currentMedia: (): CloudMusicPlaylist[] => playlist && !disposed ? [currentEnvelope()] : [],
    hasUnsaved: () => dirty, working: () => busy,
    enter(fromRoutine = false) { returnVisible = fromRoutine || returnVisible; sync(); if (!initialized && available()) void initialize(); },
    leave() { controller?.abort(); stopPreview(); reorder?.cancel(); picker.leave(); add.close(); more.close(); dismissChooser(true); },
    initialize,
    async syncPending(transfer: CloudTransfer = {}) {
      if (!online() || !author()) return;
      await run(async (activeTransfer, assert) => {
        const scoped = { ...transfer, signal: transfer.signal ?? activeTransfer.signal };
        await syncQueue(scoped, assert); await catalog(scoped, assert, false);
      }, true);
    },
    dispose() {
      disposed = true; generation++; catalogGeneration++; recoveryGeneration++; controller?.abort(); stopPreview(); reorder?.cancel();
      unsubscribePreview(); picker.dispose(); protection.dispose(); more.dispose(); add.dispose(); locationMenu.dispose(); statusMenu.dispose();
      chooserErrors.dispose();
      dialogDispose?.(); if (chooserDialog.open) chooserDialog.close(); document.documentElement.classList.remove('routine-chooser-open'); favorites.clear();
    },
  };
}