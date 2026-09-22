/// <reference types="vite/client" />
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import './styles.css';
import { ArrowRight, Bell, BellOff, Check, Copy, Hand, Headphones, ListMusic, LockKeyhole,
  Maximize2, Mic, Minimize2, Moon, MoveHorizontal, Pause, Pencil, Play, Plus, Save, Settings2, SkipBack, SkipForward, Square, Sun, UnlockKeyhole, X,
  CloudUpload, Download, RefreshCw, Send, Trash2, Star, Minus, Ellipsis, ChevronDown } from 'lucide';
import { allRoutineTracks, cueSeconds, newRoutine, validateRoutine, type Cue, type Routine, type Track } from '../../shared/routine';
import type { PlayerState } from '../../shared/player-contract';
import { createPlayer } from './player';
import { createAudioPreview } from './audio-preview';
import { detectTrackBpm } from './bpm';
import { analyzeTrackLoudness } from './loudness';
import { cacheCloudRoutine, createDemoRoutine, deleteRoutine, getCachedClassSetup, getPreparedClass, getCloudRoutine, getFillerRecordingBlob, getReadiness, getRoutine, listRoutines, publishRoutine, saveRoutine, setActiveRoutine, storeTrack } from './offline';
import { getFillerBuffer } from './filler-audio';
import type { CloudRoutine, CloudRoutineSummary } from '../../shared/cloud-contract';
import { captureCloudIdentity, getCloudContext, getCloudRole, refreshCloudSession, subscribeCloudSession, CloudRequestError } from './cloud-client';
import { cloudHash, createCloudLibrary, routineRecordings, type CloudTransfer } from './cloud-library';
import { createClassLibrary, type ClassSelection } from './class-library';
import { createClassPanel } from './class-panel';
import { createPlaylistEditor } from './playlist-editor';
import { createClassComposition } from './class-composition';
import { createDraftProtection, createRecoveryPanel } from './draft-protection';
import { createRoutineSave, sameSavedContent } from './routine-save';
import { createAudioLibraryPicker } from './audio-library-picker';
import { cacheCloudTrack, clearActiveRoutine, deleteRoutineAndWorkingCopy, deleteRoutineWorkingCopy, getActiveRoutineSelection, getRoutineWorkingCopy, listCachedClassSetups, listClassSetups, listCloudRoutines, listRoutinePublications, listRoutineWorkingCopies, reconcileRoutineWorkingCopy, saveRoutineWorkingCopy, setActiveRoutineSelection, type RoutineWorkingCopy } from './offline';
import { routineClassAudio } from '../../shared/class-plan';
import type { ClassAudio, ClassPhase } from '../../shared/class-plan';
import { formatCueTime, parseCueTime } from './cue-time';
import { cloudErrorMessage, cloudStatusMessage, confirmCloudNavigation,
  recalledCloudSelection, rememberCloudSelection, recalledClassSelection, rememberClassSelection, type CloudSelection } from './cloud-ui';
import { contentFingerprint, duplicateDraft, hasInvalidCueTimes, renderEditor, sortedCues, type EditorSession } from './editor';
import { createExportPanel } from './export-panel';
import { createFillerLibrary } from './filler-library';
import { createMediaLibrary } from './media-library';
import { errorMessage, formatNumber, formatTime, locale, t, trackCount, validationMessage, type MessageKey } from './i18n';
import { accents, applyTheme, palette, readPreferences, savePreferences } from './theme';
import { actionMenu, createClassMode, createTransportOperation, cueAtSeconds, element, field, iconButton, makeRange, nextMoveCountdown, setButtonIcon, transientText, watchOfflineShell } from './ui';
import { hostedCloudSelectionKey, hostedInvalidationEvent } from './hosted-session';

const hostedPilot = import.meta.env.VITE_HOSTED_PILOT === 'true';
const cloudLibrary = createCloudLibrary();
const routineSaver = createRoutineSave(cloudLibrary);
let workingCopy: RoutineWorkingCopy | null = null;
let workingCopies: RoutineWorkingCopy[] = [];
let localPublications: Routine[] = [];
let cachedCloudRoutines: Routine[] = [];
let legacyClasses: ClassSelection[] = [];
let draftMedia: CloudRoutine['media'] = {};
let routineOpen = false;
let chooserOpen = true;
let autoPrepareRequested = false;
let preparationFailed = false;
let retryingPending = false;
let pendingSyncRequested = false;
let pendingSessionRefresh = false;
let cloudEnvelope: CloudRoutine | null = null;
let cloudSelection: CloudSelection | null = null;
let cloudRoutines: CloudRoutineSummary[] = [];
let cloudController: AbortController | null = null;
let unsubscribeCloud = () => {};
const canEdit = () => !draft.published && (!hostedPilot || ['owner', 'editor'].includes(getCloudRole() ?? ''));
const preferences = readPreferences();
applyTheme(preferences);
document.documentElement.lang = locale;
document.title = t('appName');
const player = createPlayer();
let draft = newRoutine();
draft.name = t('newName');
draft.filler.sound = 'lofi';
let loaded: Routine | null = null;
let preparedAudio: ClassAudio | undefined;
let preparedName = '';
let persistedRevision: number | null = null;
let savedRoutines: Routine[] = [];
let dirty = false;
let draftGeneration = 0;
let cueEditing = false;
let selectedCueId = '';
let cueStep = 0.1;
let cueTimeInvalid = false;
let preparedCloudBase = '';
let selectedClass: ClassSelection | null = null;
let preparedClassKey = '';
let preparedSourceFingerprint = '';
let shareMode: 'create' | 'replace' = 'replace';
let classPanel: ReturnType<typeof createClassPanel> | undefined;
let playlistEditor: ReturnType<typeof createPlaylistEditor> | undefined;
let composition: ReturnType<typeof createClassComposition> | undefined;
let mediaLibrary: ReturnType<typeof createMediaLibrary> | undefined;
const classLibrary = createClassLibrary();
const selectionKey = () => JSON.stringify(cloudSelection ? [cloudSelection.id, cloudSelection.revision, cloudSelection.published, !!cloudSelection.cached, cloudEnvelope?.media] : null);
const classKey = () => JSON.stringify(selectedClass);
let editorBusy = true;
let appDisposed = false;
let state: PlayerState;
let displayedTrack = '';
let activeTab: 'teach' | 'edit' | 'playlists' | 'settings' = 'teach';
let validationErrors: string[] = [];
let editorSession: EditorSession | undefined;
interface CueDrag {
  pointerId: number;
  button: HTMLButtonElement;
  cueId: string;
  trackId: string;
  trackIndex: number;
  routine: Routine;
  editingDraft: Routine;
  fingerprint: string;
  status: PlayerState['status'];
  duration: number;
  startX: number;
  startSeconds: number;
  seconds: number;
  moved: boolean;
}
let cueDrag: CueDrag | null = null;
let suppressSeekClick = false;
let preparation: { current: () => boolean; controller: AbortController } | null = null;
const transportOperation = createTransportOperation(() => {
  if (preparation && !preparation.current()) preparation.controller.abort();
  renderPlayback();
}, error => notify(hostedPilot ? cloudErrorMessage(error) : errorMessage(error), true));
const audioPreview = createAudioPreview(() => {
  if (transportOperation.pending || ['playing', 'filler'].includes(state?.status)) transportOperation.cancel(() => player.pause());
});

const app = document.querySelector<HTMLDivElement>('#app')!;
const shell = element('div', 'app-shell');
const header = element('header', 'app-header');
const identity = element('div', 'identity');
const mark = element('img', 'brand-mark');
mark.src = '/icon-192.png';
mark.alt = '';
mark.width = mark.height = 40;
identity.append(mark, element('span', 'brand-name', t('appName')));
header.append(identity, element('span', 'local-status', t(hostedPilot ? 'hosted' : 'local')));
const navigation = element('nav', 'tabs');
navigation.setAttribute('aria-label', t('navigation'));
navigation.setAttribute('role', 'tablist');
const main = element('main');
const cloudPanel = element('section', 'cloud-panel');
cloudPanel.hidden = !hostedPilot;
cloudPanel.setAttribute('aria-label', t('cloudRoutines'));
const panels = { teach: element('section', 'teach-panel'), edit: element('section', 'edit-panel'), playlists: element('section', 'playlists-panel'), settings: element('section', 'settings-panel') };
const tabButtons = new Map<string, HTMLButtonElement>();
for (const [name, icon] of [['teach', Headphones], ['edit', Pencil], ['playlists', ListMusic], ['settings', Settings2]] as const) {
  const button = iconButton(t(name), icon, () => selectTab(name), true);
  button.id = `tab-${name}`;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', `panel-${name}`);
  button.addEventListener('keydown', event => {
    const names: Array<typeof activeTab> = ['teach', 'edit', 'playlists', 'settings'];
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!offset && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'teach' : event.key === 'End' ? 'settings' : names[(names.indexOf(name) + offset + names.length) % names.length]!;
    selectTab(next);
    tabButtons.get(next)?.focus();
  });
  tabButtons.set(name, button);
  navigation.append(button);
  panels[name].id = `panel-${name}`;
  panels[name].setAttribute('role', 'tabpanel');
  panels[name].setAttribute('aria-labelledby', button.id);
  main.append(panels[name]);
}
const notice = element('div', 'notice');
notice.hidden = true;
const noticeText = element('p');
const noticeDisplay = transientText(noticeText, visible => { notice.hidden = !visible; });
noticeText.setAttribute('role', 'status');
noticeText.setAttribute('aria-live', 'polite');
noticeText.setAttribute('aria-atomic', 'true');
notice.append(noticeText, iconButton(t('dismiss'), X, () => noticeDisplay.dismiss()));
const classToolbar = element('div', 'class-toolbar');
classToolbar.hidden = true;
const exitClass = iconButton(t('exitClass'), Minimize2, () => {}, true);
classToolbar.append(element('span', 'eyebrow', t('classMode')), exitClass);
const footer = element('footer', 'app-footer muted', t('appBuild', {
  version: import.meta.env.VITE_APP_VERSION || 'dev', build: import.meta.env.VITE_APP_BUILD_ID || 'dev',
}));
shell.append(header, navigation, classToolbar, notice, main, footer);
app.replaceChildren(shell);

function notify(message: string, error = false): void {
  notice.hidden = false;
  notice.classList.toggle('notice-error', error);
  noticeText.setAttribute('role', error ? 'alert' : 'status');
  noticeDisplay.show(message, error);
}

function selectTab(tab: typeof activeTab): void {
  const previous = activeTab;
  // A confirmation describes the workspace that produced it; leaving retires it so the next one is its own.
  if (previous !== tab && !notice.classList.contains('notice-error')) noticeDisplay.dismiss();
  if (activeTab !== tab) cancelCueDrag();
  if (tab !== 'teach') { cueEditing = false; cueTimeInvalid = false; }
  if (activeTab === 'edit' && tab !== 'edit') { fillerLibrary.leave(); stopEditorAudio(); }
  if (activeTab === 'settings' && tab !== 'settings') { mediaLibrary?.leave(); fillerLibrary.leave(); audioPreview.stop(); }
  if (activeTab === 'playlists' && tab !== 'playlists') playlistEditor?.leave();
  activeTab = tab;
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = name !== tab;
    const button = tabButtons.get(name)!;
    button.setAttribute('aria-selected', String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
  }
  editorSession?.syncAvailability();
  if (tab === 'playlists') playlistEditor?.enter();
  fillerLibrary.sync();
  if (previous !== tab && (tab === 'settings' || tab === 'edit')) void fillerLibrary.refresh();
  if (previous !== tab && tab === 'edit' && hostedPilot && !cloudRoutines.length && getCloudContext().access === 'online') void runCloud(loadHousehold);
  syncPracticeControls();
  if (tab === 'teach' && routineOpen) requestPreparation();
}

function stopEditorAudio(): void {
  cancelCueDrag();
  editorSession?.cancelJobs();
  audioPreview.stop();
}

async function runEditor(action: () => Promise<void>): Promise<void> {
  if (editorBusy || appDisposed || transportOperation.pending) return;
  editorBusy = true;
  stopEditorAudio();
  syncAvailability();
  try { await action(); }
  catch (error) { notify(errorMessage(error), true); }
  finally { editorBusy = false; syncAvailability(); schedulePreparation(); }
}

const fileInput = element('input', 'visually-hidden');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.accept = 'audio/*,.opus,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm';
fileInput.tabIndex = -1;
fileInput.setAttribute('aria-label', t('import'));
fileInput.setAttribute('aria-hidden', 'true');
app.append(fileInput);
const importButtons: HTMLButtonElement[] = [];
const demoButtons: HTMLButtonElement[] = [];
function importButton(): HTMLButtonElement {
  const button = iconButton(t('import'), Plus, () => { if (canEdit() && !editorBusy && !draft.locked) fileInput.click(); }, true);
  importButtons.push(button);
  return button;
}
function demoButton(): HTMLButtonElement {
  const button = iconButton(t('demo'), ListMusic, () => { void runEditor(async () => {
    if (preferences.disableDemos) return;
    if (!canEdit() || cloudSelection) throw new Error('cloud_head_required');
    if (draft.locked) throw new Error(t('lockedError'));
    if ((draft.tracks.length || dirty) && !confirm(t('confirmDemo', { name: draft.name }))) return;
    draft = await createDemoRoutine();
    routineOpen = true; chooserOpen = false;
    draft.name = t('demoName');
    persistedRevision = null;
    dirty = true;
    refreshDraft(true);
    notify(t('demoToast'));
  }); }, true);
  demoButtons.push(button);
  return button;
}
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = '';
  if (!files.length) return;
  void runEditor(async () => {
    if (!canEdit()) throw new Error('cloud_head_required');
    if (draft.locked) throw new Error(t('lockedError'));
    if (allRoutineTracks(draft).length + files.length > 100) throw new Error(t('tooManyTracks'));
    routineOpen = true; chooserOpen = false;
    let imported = 0;
    const failures: string[] = [];
    for (const file of files) {
      notify(t('preparingAudio', { name: file.name }));
      try { draft.tracks.push(await storeTrack(file)); imported += 1; dirty = true; }
      catch (error) { failures.push(t('importFailure', { name: file.name, error: errorMessage(error) })); }
    }
    refreshDraft(true);
    notify([t('importedToast', { count: imported }), ...failures].join('\n'), failures.length > 0);
  });
});

const cloudStatus = element('p', 'cloud-status');
cloudStatus.setAttribute('role', 'status');
const cloudMode = element('select');
cloudMode.setAttribute('aria-label', t('cloudVersion'));
for (const [value, label] of [['draft', 'cloudDrafts'], ['published', 'cloudPublications']] as const) {
  const option = element('option', '', t(label));
  option.value = value;
  cloudMode.append(option);
}
cloudMode.value = getCloudRole() === 'player' ? 'published' : 'draft';
const cloudSelect = element('select');
cloudSelect.setAttribute('aria-label', t('cloudRoutines'));
cloudSelect.addEventListener('change', () => syncCloudControls());
const cloudProgress = element('progress');
cloudProgress.max = 100;
cloudProgress.value = 0;
cloudProgress.hidden = true;
cloudProgress.setAttribute('aria-label', t('cloudWorking'));
const cloudFeedback = element('p', 'cloud-feedback');
cloudFeedback.setAttribute('role', 'status');
const cloudFeedbackErrors = transientText(cloudFeedback);

async function runCloud(action: (transfer: CloudTransfer) => Promise<void>): Promise<void> {
  if (!hostedPilot || editorBusy || appDisposed || transportOperation.pending) return;
  editorBusy = true;
  const controller = new AbortController();
  cloudController = controller;
  cloudFeedbackErrors.show(t('cloudWorking'), false);
  cloudProgress.hidden = true;
  syncAvailability();
  try {
    await action({ signal: controller.signal, progress: (completed, total) => {
      if (appDisposed || controller.signal.aborted) return;
      cloudProgress.hidden = false;
      cloudProgress.value = total ? Math.min(100, completed / total * 100) : 0;
      cloudFeedbackErrors.show(t('cloudProgress', { percent: Math.floor(cloudProgress.value) }), false);
    } });
    if (!appDisposed) cloudFeedbackErrors.dismiss();
  } catch (error) {
    if (!appDisposed) { cloudFeedbackErrors.show(cloudErrorMessage(error)); notify(cloudErrorMessage(error), true); }
  } finally {
    cloudController = null;
    cloudProgress.hidden = true;
    editorBusy = false;
    if (!appDisposed) { syncAvailability(); schedulePreparation(); }
  }
}

function renderCloudList(): void {
  const selected = cloudSelect.value;
  cloudSelect.replaceChildren();
  const placeholder = element('option', '', t('cloudChoose'));
  placeholder.value = '';
  cloudSelect.append(placeholder);
  const routines = [...new Map([...cachedCloudRoutines, ...cloudRoutines].map(value => [`${value.id}:${value.published}`, value])).values()];
  for (const routine of routines) {
    const option = element('option', '', `${routine.name} / ${t(routine.published ? 'exportPublished' : 'draft')}`);
    option.value = routine.id;
    cloudSelect.append(option);
  }
  cloudSelect.value = routines.some(routine => routine.id === selected) ? selected : '';
  syncCloudControls();
  renderRoutineLibrary();
}

async function refreshHousehold(transfer: CloudTransfer): Promise<void> {
  await refreshCloudSession();
  await loadHousehold(transfer);
}

async function loadHousehold(transfer: CloudTransfer): Promise<void> {
  if (transfer.signal?.aborted || appDisposed) throw new CloudRequestError('cancelled');
  const drafts = getCloudRole() === 'player' ? [] : await cloudLibrary.list(false, transfer);
  const published = await cloudLibrary.list(true, transfer);
  cloudRoutines = [...drafts, ...published];
  const classes = getCloudRole() === 'player' ? [] : await classLibrary.listClasses(false, transfer);
  const classPublications = await classLibrary.listClasses(true, transfer);
  if (transfer.signal?.aborted || appDisposed) throw new CloudRequestError('cancelled');
  legacyClasses = [...legacyClasses.filter(value => value.source === 'local'), ...[...classes, ...classPublications].map(setup => ({ setup, source: 'household' as const }))];
  renderCloudList();
}

const cloudRefresh = iconButton(t('cloudRefresh'), RefreshCw, () => { void runCloud(async transfer => {
  await refreshHousehold(transfer);
  await syncPending(transfer);
}); });
cloudMode.addEventListener('change', () => {
  cloudRoutines = [];
  renderCloudList();
  void runCloud(refreshHousehold);
});
async function openCloudRoutine(id: string, published: boolean, transfer: CloudTransfer, confirmed = false): Promise<void> {
  if (!id || (!confirmed && dirty && !confirm(t('confirmSwitch', { name: draft.name })))) return;
  stopEditorAudio();
  const local = !published ? await getRoutineWorkingCopy(id) : null;
  if (local?.pendingCloud) { acceptWorkingCopy(local); requestPreparation(); return; }
  if (getCloudContext().access !== 'online' || navigator.onLine === false) {
    const reference = cachedCloudRoutines.find(value => value.id === id && value.published === published);
    const cached = reference ? await getCloudRoutine(id, reference.revision, published) : null;
    if (!cached) throw new Error('class_cache_unavailable');
    clearCloudSelection();
    cloudSelection = { id, revision: cached.revision, published, cached: true };
    workingCopy = local; draft = structuredClone(cached); draftMedia = structuredClone(local?.envelope.media ?? {});
    routineOpen = true; chooserOpen = false; persistedRevision = cached.revision; dirty = false; draftGeneration++;
    selectedClass = null; rememberSelection(); refreshDraft(true); requestPreparation();
    return;
  }
  const envelope = await cloudLibrary.open(id, published, transfer);
  await acceptCloudEnvelope(envelope, published);
}
const cloudOpen = iconButton(t('cloudOpen'), Download, () => {
  const id = cloudSelect.value;
  const published = cloudMode.value === 'published';
  void runCloud(transfer => openCloudRoutine(id, published, transfer));
});
const cloudUpload = iconButton(t('shareRoutine'), CloudUpload, () => { void runCloud(transfer => saveCloudDraft('save', transfer)); }, true);
const cloudOpenDraft = iconButton(t('cloudOpenDraft'), Pencil, () => { void runCloud(async transfer => {
  if (!cloudSelection || !['owner', 'editor'].includes(getCloudRole() ?? '')) return;
  if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
  const local = await getRoutineWorkingCopy(cloudSelection.id);
  if (local?.pendingCloud) { stopEditorAudio(); acceptWorkingCopy(local); requestPreparation(); return; }
  const head = await cloudLibrary.readHead(cloudSelection.id, transfer);
  const downloaded = await cloudLibrary.download(head, transfer);
  stopEditorAudio();
  await acceptCloudEnvelope(downloaded, false);
}); }, true);
const cloudReplace = iconButton(t('cloudReplace'), Save, () => { void runCloud(async transfer => {
  if (cloudSelection || !canEdit() || !cloudSelect.value || cloudMode.value !== 'draft') return;
  assertValid();
  const source = draft;
  const fingerprint = contentFingerprint(source);
  const targetId = cloudSelect.value;
  const result = await cloudLibrary.replace(source, targetId, (head, snapshot) =>
    !appDisposed && source === draft && fingerprint === contentFingerprint(draft)
      && confirm(t('cloudConfirmReplace', { name: head.routine.name, id: head.routine.id, revision: head.routine.revision,
        source: snapshot.name, status: t(dirty || persistedRevision === null ? 'exportUnsaved' : 'exportSaved') })), transfer);
  if (!result) return;
  await acceptCloudEnvelope(result, false);
  await cacheCloudRoutine(result.routine);
  notify(t('cloudSaved'));
}); }, true);
const cloudPublish = iconButton(t('cloudPublish'), Send, () => { void runCloud(async transfer => {
  if (!cloudEnvelope || !cloudSelection || cloudSelection.published || dirty || workingCopy?.pendingCloud) throw new Error('cloud_save_first');
  if (!confirm(t('cloudConfirmPublish', { name: draft.name }))) return;
  const result = await cloudLibrary.command(cloudEnvelope, 'publish', false, transfer);
  await acceptCloudEnvelope(result, true);
  await cacheCloudRoutine(result.routine);
  notify(t('cloudPublished'));
}); });
const deleteSelectedCloudRoutine = () => { void runCloud(async transfer => {
  if (!cloudEnvelope || !cloudSelection || cloudSelection.published) throw new Error('cloud_head_required');
  if (!confirm(t('cloudConfirmDelete', { name: draft.name }))) return;
  if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
  const copy = workingCopy;
  const id = cloudEnvelope.routine.id;
  await cloudLibrary.command(cloudEnvelope, 'delete', false, transfer);
  if (copy) await deleteRoutineWorkingCopy(id, copy.localVersion);
  await clearActiveRoutine();
  workingCopies = workingCopies.filter(value => value.envelope.routine.id !== id);
  cloudRoutines = cloudRoutines.filter(routine => routine.id !== id);
  cachedCloudRoutines = cachedCloudRoutines.filter(routine => routine.id !== id);
  clearCloudSelection();
  routineOpen = false; chooserOpen = true; selectedClass = null;
  draft = newRoutine();
  draft.name = t('newName');
  persistedRevision = null;
  dirty = false;
  refreshDraft(true);
  renderCloudList();
  notify(t('cloudDeleted'));
}); };
const cloudDelete = iconButton(t('cloudDelete'), Trash2, deleteSelectedCloudRoutine);
cloudDelete.classList.add('danger');
const cloudCancel = iconButton(t('cloudCancel'), X, () => {
  cloudController?.abort();
  cloudProgress.hidden = true;
  cloudFeedbackErrors.show(t('cloudCancelling'), false);
  syncCloudControls();
});
const cloudSignIn = element('a', 'button', t('cloudSignIn'));
cloudSignIn.href = '/signin.html';
cloudSignIn.addEventListener('click', event => {
  event.preventDefault();
  if (getCloudContext().access !== 'signin-required') return;
  confirmCloudNavigation(() => confirm(t('cloudConfirmSignin')), () => disposeApp(), () => window.location.assign(cloudSignIn.href));
});
const cloudControls = element('div', 'cloud-controls');
cloudControls.append(field(t('cloudRoutines'), cloudSelect), cloudMode, cloudRefresh, cloudOpen, cloudSignIn);
const cloudActions = element('div', 'action-row');
cloudActions.append(cloudUpload, cloudReplace, cloudOpenDraft, cloudPublish, cloudDelete, cloudCancel);
cloudPanel.append(cloudStatus, cloudControls, cloudActions, cloudProgress, cloudFeedback);

function syncCloudControls(): void {
  if (!hostedPilot) return;
  const context = getCloudContext();
  const mutable = ['owner', 'editor'].includes(context.user?.role ?? '');
  const busy = editorBusy || transportOperation.pending;
  cloudStatus.textContent = cloudStatusMessage(context);
  cloudSignIn.hidden = context.access !== 'signin-required';
  cloudRefresh.disabled = busy;
  cloudMode.disabled = busy || !mutable;
  cloudSelect.disabled = busy || (!cloudRoutines.length && !cachedCloudRoutines.length);
  cloudOpen.disabled = busy || !cloudSelect.value || ((context.access !== 'online' || navigator.onLine === false)
    && !cachedCloudRoutines.some(value => value.id === cloudSelect.value && value.published === (cloudMode.value === 'published')));
  cloudCancel.hidden = !cloudController;
  cloudCancel.disabled = cloudController?.signal.aborted ?? false;
  cloudUpload.hidden = !mutable || !!cloudSelection || shareMode !== 'create';
  cloudUpload.disabled = busy || !canEdit() || draft.locked || context.access !== 'online' || validationErrors.length > 0;
  for (const button of [cloudPublish, cloudDelete]) {
    button.hidden = !mutable || !cloudSelection || cloudSelection.published;
    button.disabled = busy || !cloudEnvelope || !canEdit() || draft.locked || context.access !== 'online';
  }
  cloudPublish.disabled ||= dirty || !!workingCopy?.pendingCloud || !draft.tracks.length;
  cloudReplace.hidden = !mutable || !!cloudSelection || shareMode !== 'replace';
  cloudReplace.disabled = busy || !canEdit() || draft.locked || !cloudSelect.value || cloudMode.value !== 'draft'
    || context.access !== 'online' || validationErrors.length > 0;
  cloudOpenDraft.hidden = !mutable || !cloudSelection || (!cloudSelection.published && !cloudSelection.cached);
  cloudOpenDraft.disabled = busy || context.access !== 'online';
}

function rememberSelection(): void {
  if (!hostedPilot) return;
  try {
    captureCloudIdentity()();
    const owner = getCloudContext().user;
    if (owner) rememberCloudSelection(localStorage, owner, cloudSelection);
  } catch { notify(t('activeSelectionFailure'), true); }
}

function clearCloudSelection(): void {
  cloudEnvelope = null;
  cloudSelection = null;
  workingCopy = null;
  draftMedia = {};
  rememberSelection();
}

async function acceptCloudEnvelope(envelope: CloudRoutine, published: boolean): Promise<void> {
  const identity = captureCloudIdentity();
  published ||= envelope.routine.published;
  const reconciled = published ? null : await reconcileRoutineWorkingCopy(envelope);
  identity();
  if (appDisposed) return;
  workingCopies = await listRoutineWorkingCopies(); identity();
  cachedCloudRoutines = [...cachedCloudRoutines.filter(value => value.id !== envelope.routine.id || value.published !== published), structuredClone(envelope.routine)];
  cloudRoutines = [...cloudRoutines.filter(value => value.id !== envelope.routine.id || value.published !== published), structuredClone(envelope.routine)];
  selectedClass = null;
  if (reconciled?.pendingCloud && !published) { acceptWorkingCopy(reconciled); requestPreparation(); return; }
  cloudEnvelope = structuredClone(envelope);
  draftMedia = structuredClone(envelope.media);
  workingCopy = reconciled;
  routineOpen = true; chooserOpen = false;
  cloudSelection = { id: envelope.routine.id, revision: envelope.routine.revision, published };
  draft = structuredClone(envelope.routine);
  draftGeneration++;
  persistedRevision = envelope.routine.revision;
  dirty = false;
  rememberSelection();
  refreshDraft(true);
  requestPreparation();
}

async function saveCloudDraft(action: 'save' | 'lock', transfer: CloudTransfer): Promise<void> {
  if (!canEdit()) throw new Error('cloud_head_required');
  if (workingCopy?.pendingCloud && action !== 'lock') throw new Error('cloud_save_first');
  assertValid();
  const snapshot = structuredClone(draft);
  const source = draft;
  const generation = draftGeneration;
  const fingerprint = contentFingerprint(source);
  const base = selectionKey();
  const assertSource = () => {
    if (appDisposed || source !== draft || generation !== draftGeneration || base !== selectionKey()
      || fingerprint !== contentFingerprint(draft)) throw new CloudRequestError('cancelled');
  };
  if (action === 'lock') {
    if (!confirm(t('cloudConfirmLock', { name: snapshot.name }))) return;
    await saveWorkingRoutine(transfer);
    if (!workingCopy || workingCopy.pendingCloud || !cloudEnvelope || !cloudSelection || cloudSelection.published
      || cloudEnvelope.routine.id !== source.id || cloudEnvelope.routine.revision !== workingCopy.cloudBaseRevision) throw new Error('cloud_save_first');
    const result = await cloudLibrary.command(cloudEnvelope, 'lock', false, transfer);
    const matchesPrepared = loaded?.id === source.id && contentFingerprint(loaded) === fingerprint
      && contentFingerprint(result.routine) === fingerprint;
    await acceptCloudEnvelope(result, false);
    if (matchesPrepared && loaded) { loaded.revision = result.routine.revision; loaded.locked = result.routine.locked; preparedCloudBase = selectionKey(); }
    await cacheCloudRoutine(result.routine);
    notify(t('lockedToast'));
    return;
  }
  let head = cloudEnvelope;
  if (cloudSelection) {
    if (!head || cloudSelection.published || cloudSelection.cached) throw new Error('cloud_head_required');
    const currentHead = await cloudLibrary.readHead(cloudSelection.id, transfer);
    assertSource();
    if (currentHead.routine.locked) throw new CloudRequestError('cloud_http_error', 423, 'routine_locked');
    if (currentHead.routine.revision !== head.routine.revision) throw new CloudRequestError('cloud_http_error', 412, 'routine_conflict');
    if (JSON.stringify(currentHead.media) !== JSON.stringify(head.media)) throw new Error('cloud_head_required');
    head = currentHead;
  }
  const confirmation = head
    ? t('cloudConfirmSave', { name: head.routine.name, id: head.routine.id, revision: head.routine.revision })
    : t('cloudConfirmUpload', { name: snapshot.name });
  if (!confirm(confirmation)) return;
  if (!cloudSelection) { snapshot.revision = 1; snapshot.published = false; }
  const result = await cloudLibrary.save(snapshot, head, action, transfer, draftMedia);
  assertSource();
  const matchesPrepared = loaded?.id === source.id && contentFingerprint(loaded) === fingerprint
    && contentFingerprint(result.routine) === fingerprint;
  await acceptCloudEnvelope(result, false);
  if (matchesPrepared && loaded) { loaded.revision = result.routine.revision; loaded.locked = result.routine.locked; preparedCloudBase = selectionKey(); }
  await cacheCloudRoutine(result.routine);
  notify(t('cloudSaved'));
}

const routineHeading = element('div', 'routine-heading');
const headingText = element('div');
const routineTitle = element('h1');
const routineMeta = element('p', 'muted');
headingText.append(element('p', 'eyebrow', t('routine')), routineTitle, routineMeta);
const prepare = iconButton(t('retryPreparation'), RefreshCw, () => { if (preparationFailed) requestPreparation(); }, true);
prepare.classList.add('primary');
const startClass = iconButton(t('startClass'), Maximize2, () => {
  if (!loaded || editorBusy || appDisposed || transportOperation.pending) return;
  stopEditorAudio();
  selectTab('teach');
  classMode.enter(false);
}, true);
startClass.hidden = true;
startClass.setAttribute('aria-controls', 'panel-teach');
const preparationActions = element('div', 'action-row');
function openClassMusic(): void {
  if (!playlistEditor || editorBusy || transportOperation.pending) return;
  selectTab('playlists');
  playlistEditor.enter(routineOpen);
  tabButtons.get('playlists')?.focus({ preventScroll: true });
}
const classMusic = iconButton(t('classMusic'), ListMusic, openClassMusic, true);
const practiceOpenDraft = iconButton(t('cloudOpenDraft'), Pencil, () => cloudOpenDraft.click(), true);
prepare.hidden = true;
preparationActions.append(prepare, practiceOpenDraft, startClass);
routineHeading.append(headingText, preparationActions);
const snapshotStatus = element('p', 'snapshot-status');
const empty = element('div', 'empty-state');
empty.append(element('h2', '', t('emptyTitle')), element('p', 'muted', t('emptyBody')));
const emptyActions = element('div', 'action-row');
emptyActions.append(iconButton(t('edit'), Pencil, () => selectTab('edit'), true));
empty.append(emptyActions);

const rehearsal = element('div', 'rehearsal-layout');
const stage = element('div', 'stage');
const trackHeader = element('div', 'track-header');
const trackInfo = element('div', 'track-info');
const trackPosition = element('p', 'eyebrow');
const trackTitle = element('h2', 'playing-title');
const bodyArea = element('p', 'muted');
trackInfo.append(trackPosition, trackTitle, bodyArea);
const playbackStatus = element('span', 'playback-status');
trackHeader.append(trackInfo, playbackStatus);
const moves = element('div', 'moves');
const currentMove = element('div', 'current-move');
const currentNote = element('p', 'move-note');
currentNote.setAttribute('aria-live', 'polite');
currentNote.setAttribute('aria-atomic', 'true');
currentMove.append(element('h3', 'eyebrow', t('now')), currentNote);
const upcomingMove = element('div', 'upcoming-move');
const nextNote = element('p', 'next-note');
const nextCueTrack = element('p', 'next-cue-track');
nextCueTrack.hidden = true;
const nextCueTime = element('p', 'next-cue-time mono');
upcomingMove.append(element('h3', 'eyebrow', t('nextMove')), nextNote, nextCueTrack, nextCueTime);
moves.append(currentMove, upcomingMove);
const progress = element('div', 'progress');
progress.setAttribute('role', 'progressbar');
progress.setAttribute('aria-label', t('trackProgress'));
progress.setAttribute('aria-valuemin', '0');
const progressFill = element('div', 'progress-fill');
const markers = element('div', 'cue-markers');
markers.setAttribute('aria-hidden', 'true');
progress.append(progressFill, markers);
const timeline = element('div', 'timeline');
const progressSurface = element('div', 'progress-surface');
const practiceSeek = element('div', 'practice-seek');
practiceSeek.setAttribute('role', 'slider');
practiceSeek.setAttribute('aria-label', t('seekSong'));
practiceSeek.setAttribute('aria-valuemin', '0');
practiceSeek.setAttribute('aria-orientation', 'horizontal');
const cueHandles = element('div', 'cue-handles');
cueHandles.setAttribute('role', 'group');
cueHandles.setAttribute('aria-label', t('cueTiming'));
const cueMarkers = new Map<string, { button: HTMLButtonElement; marker: HTMLSpanElement; cue: Cue; seconds: number }>();
progressSurface.append(progress, practiceSeek);
timeline.append(progressSurface, cueHandles);
for (const target of [progress, practiceSeek]) {
  target.addEventListener('pointerdown', () => { if (!cueDrag) suppressSeekClick = false; });
  target.addEventListener('click', event => {
    if (suppressSeekClick) { suppressSeekClick = false; return; }
    if (!practiceTrack() || cueDrag) return;
    const bounds = progress.getBoundingClientRect();
    if (bounds.width > 0) seekPractice((event.clientX - bounds.left) / bounds.width * state.duration);
  });
}
practiceSeek.addEventListener('keydown', event => {
  if (!practiceTrack() || cueDrag) return;
  const direction = arrowDirection(event.key);
  if (!direction && !['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? state.duration
    : state.elapsed + (direction ? direction * (event.shiftKey ? 10 : 1) : event.key === 'PageUp' ? 10 : -10);
  seekPractice(target);
});
const clocks = element('div', 'clocks');
const elapsed = element('span', 'clock');
const remaining = element('span', 'clock');
const classElapsed = element('span', 'class-clock');
for (const [label, value] of [['elapsed', elapsed], ['remaining', remaining], ['classElapsed', classElapsed]] as const) {
  const item = element('div');
  item.append(element('span', 'clock-label', t(label)), value);
  clocks.append(item);
}
const fillerState = element('p', 'filler-state');
const transport = element('div', 'transport');
const stop = iconButton(t('stop'), Square, () => { stopEditorAudio(); transportOperation.cancel(() => player.stop()); });
const previous = iconButton(t('previous'), SkipBack, () => { stopEditorAudio(); void transportOperation.run(() => player.previous()); });
const play = iconButton(t('play'), Play, () => {
  stopEditorAudio();
  if (transportOperation.pending || state.status === 'playing' || state.status === 'filler') {
    transportOperation.cancel(() => player.pause());
  } else { void transportOperation.run(() => player.play()); }
});
play.classList.add('play-button', 'primary');
const next = iconButton(t('next'), SkipForward, () => { stopEditorAudio(); void transportOperation.run(() => player.next()); });
const hold = iconButton(t('hold'), Hand, () => { stopEditorAudio(); player.hold(); });
const continueButton = iconButton(t('continue'), ArrowRight, () => { stopEditorAudio(); void transportOperation.run(() => player.continue()); });
const advance = iconButton(t('advancePhase', { phase: t('phaseRoutine') }), ArrowRight, () => {
  if (!state.canAdvance || state.status === 'paused' || !player.advance || transportOperation.pending) return;
  stopEditorAudio(); void transportOperation.run(() => player.advance!());
}, true);
transport.append(stop, previous, play, next, hold, continueButton, advance);
const practiceTools = element('div', 'practice-tools');
const editCueToggle = iconButton(t('editCueTimes'), Pencil, () => {
  if (!cueEditing && !eligiblePracticeTrack()) return;
  cancelCueDrag(); cueEditing = !cueEditing; cueTimeInvalid = false; syncPracticeControls();
}, true);
const practiceSave = iconButton(t('save'), Save, () => save.click(), true);
const cuePanel = element('div', 'selected-cue-panel');
const cueChoice = element('select'); cueChoice.setAttribute('aria-label', t('selectedCue'));
cueChoice.addEventListener('change', () => { selectedCueId = cueChoice.value; cueTimeInvalid = false; syncPracticeControls(); });
const cueTime = element('input'); cueTime.type = 'text'; cueTime.inputMode = 'text';
cueTime.setAttribute('aria-label', t('cueTime'));
cueTime.addEventListener('change', () => {
  const seconds = parseCueTime(cueTime.value);
  if (!editablePracticeTrack()) return;
  cueTimeInvalid = seconds === null || seconds >= state.duration;
  cueTime.setAttribute('aria-invalid', String(cueTimeInvalid));
  if (!cueTimeInvalid) commitCue(selectedCueId, seconds!);
  syncAvailability();
});
const stepChoice = element('select'); stepChoice.setAttribute('aria-label', t('cueStep'));
for (const seconds of [0.1, 1]) { const option = element('option', '', `${seconds} s`); option.value = String(seconds); stepChoice.append(option); }
stepChoice.value = '0.1'; stepChoice.addEventListener('change', () => { cueStep = Number(stepChoice.value); });
const nudgeCue = (direction: number) => {
  const track = editablePracticeTrack(); const cue = track?.cues.find(item => item.id === selectedCueId);
  if (track && cue && (cue.anchor.kind !== 'count' || track.bpm !== undefined)) { cueTimeInvalid = false; commitCue(cue.id, cueSeconds(cue, track) + direction * (cue.anchor.kind === 'count' ? 60 / track.bpm! : cueStep)); }
};
const earlierCue = iconButton(t('earlierCue'), Minus, () => nudgeCue(-1));
const laterCue = iconButton(t('laterCue'), Plus, () => nudgeCue(1));
const beatStep = element('span', 'muted', t('oneBeat'));
cuePanel.append(field(t('selectedCue'), cueChoice), field(t('cueTime'), cueTime), stepChoice, beatStep, earlierCue, laterCue);
practiceTools.append(editCueToggle, practiceSave, cuePanel);
const sessionSound = element('div', 'session-sound');
const duck = iconButton(t('duck'), Mic, () => player.setDucked(!state.ducked));
const muteBeeps = iconButton(t('muteBeeps'), Bell, () => player.setBeepsMuted(!state.beepsMuted));
sessionSound.append(duck, makeRange(t('musicVolume'), 0, 100, 80, value => player.setVolume(value / 100)), muteBeeps);
const playbackError = element('p', 'playback-error');
const playbackErrors = transientText(playbackError);
let lastPlaybackError = '';
playbackError.hidden = true;
playbackError.setAttribute('role', 'alert');
stage.append(trackHeader, moves, timeline, practiceTools, clocks, fillerState, transport, sessionSound, playbackError);
const sidebar = element('aside', 'playlist');
sidebar.append(element('h2', '', t('playlist')));
const playlist = element('ol', 'playlist-items');
sidebar.append(playlist);
const cueSheet = element('details', 'cue-sheet');
cueSheet.append(element('summary', '', t('cues')));
const cueTable = element('div', 'cue-table-wrap');
cueSheet.append(cueTable);
rehearsal.append(stage, sidebar, cueSheet);
panels.teach.append(routineHeading, snapshotStatus, empty, rehearsal);
const classMode = createClassMode(shell, exitClass,
  () => (startClass.disabled ? tabButtons.get('teach')! : startClass).focus({ preventScroll: true }), active => {
  cancelCueDrag();
  for (const node of [header, navigation, routineHeading, snapshotStatus, sidebar, cueSheet, footer, readyPanel]) node.hidden = active;
  cloudPanel.hidden = active || !hostedPilot;
  classToolbar.hidden = !active;
  empty.hidden = active || !!(loaded ?? draft).tracks.length;
  if (active) {
    panels.teach.setAttribute('role', 'region');
    panels.teach.removeAttribute('aria-labelledby');
    panels.teach.setAttribute('aria-label', t('classMode'));
    if (!notice.classList.contains('notice-error')) notice.hidden = true;
  } else {
    panels.teach.setAttribute('role', 'tabpanel');
    panels.teach.removeAttribute('aria-label');
    panels.teach.setAttribute('aria-labelledby', 'tab-teach');
  }
  syncPracticeControls();
});
classToolbar.append(iconButton(t('fullscreen'), Maximize2, () => classMode.enter()));

const editorHeading = element('header', 'editor-heading');
const editorTitle = element('div', 'editor-identity');
const editorHeadingActions = element('div', 'editor-heading-actions');
const editorRoutineTitle = element('h1', 'routine-title');
editorTitle.append(editorRoutineTitle);
const draftStatus = element('span', 'draft-status');
editorHeading.append(editorTitle, editorHeadingActions);
const routineSelect = element('select');
routineSelect.setAttribute('aria-label', t('savedRoutines'));
routineSelect.addEventListener('change', () => {
  const id = routineSelect.value;
  routineSelect.value = cloudSelection || dirty || persistedRevision === null || draft.published ? '' : draft.id;
  if (!id || (id === draft.id && !dirty && !cloudSelection && !draft.published)) return;
  void runEditor(async () => {
    if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
    const saved = await getRoutine(id);
    if (!saved) throw new Error('routine_not_found');
    await setActiveRoutine(saved.id);
    clearCloudSelection();
    const copy = await getRoutineWorkingCopy(saved.id);
    if (copy) { acceptWorkingCopy(copy); requestPreparation(); }
    else acceptSavedRoutine(saved);
  });
});
const editorActions = element('div', 'action-row editor-actions');
// Lets the sticky per-track preview bar (.track-preview) stack below the sticky save bar instead
// of both pinning to the same inset-block-start and overlapping -- the bar's height varies (mobile
// 2-row layout, wrapped status text), so measure it instead of guessing a fixed offset.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--editor-actions-height', `${Math.ceil(editorActions.getBoundingClientRect().height)}px`);
  }).observe(editorActions);
}
const newDraft = iconButton(t('newRoutine'), Plus, () => {
  if (routineOpen || editorBusy || transportOperation.pending || (hostedPilot && getCloudRole() === 'player')) return;
  if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
  stopEditorAudio(); clearCloudSelection(); draft = newRoutine(); draft.name = t('newName'); draft.filler.sound = 'lofi';
  routineOpen = true; chooserOpen = false; selectedClass = null;
  persistedRevision = null; dirty = true; draftGeneration++; selectedCueId = ''; cueEditing = false; refreshDraft(true);
}, true);
const save = iconButton(t('save'), Save, () => {
  void runEditor(() => saveWorkingRoutine());
});
const saveLabel = element('span', '', t('save'));
save.classList.toggle('icon-button', false);
save.append(saveLabel);
const lock = iconButton(t('lock'), LockKeyhole, () => {
  if (cloudSelection || (hostedPilot && !draft.locked)) {
    void runCloud(async transfer => {
      if (!canEdit()) throw new Error('cloud_head_required');
      if (!draft.locked) { await saveCloudDraft('lock', transfer); return; }
      if (!cloudEnvelope) throw new Error('cloud_head_required');
      if (!confirm(t('cloudConfirmUnlock', { name: draft.name }))) return;
      const result = await cloudLibrary.command(cloudEnvelope, 'unlock', false, transfer);
      await acceptCloudEnvelope(result, false);
      await cacheCloudRoutine(result.routine);
      notify(t('unlockedToast'));
    });
    return;
  }
  void runEditor(async () => {
  if (!confirm(t(draft.locked ? 'confirmUnlock' : 'confirmLock', { name: draft.name }))) return;
  await persistDraft(draft.locked ? 'unlock' : 'lock');
  notify(t(draft.locked ? 'lockedToast' : 'unlockedToast'));
}); });
const duplicate = iconButton(t('duplicate'), Copy, () => {
  if (appDisposed || editorBusy) return;
  if (hasInvalidCueTimes(draft)) { notify(t('invalidCueTime'), true); return; }
  if (hostedPilot && !['owner', 'editor'].includes(getCloudRole() ?? '')) return;
  nameRoutine(t('duplicate'), t('copyName', { name: draft.name.slice(0, 153) }), name => runEditor(async () => {
    const snapshot = await independentRoutine(draft, name, draftMedia);
    stopEditorAudio(); clearCloudSelection();
    draft = snapshot.routine; draftMedia = snapshot.media; routineOpen = true; chooserOpen = false; selectedClass = null;
    persistedRevision = null; dirty = true; draftGeneration++; refreshDraft(true);
  }));
});
save.classList.add('primary');
const localPublish = iconButton(t('localPublish'), Send, () => { void runEditor(async () => {
  if (cloudSelection || !canEdit() || draft.locked) throw new Error('routine_locked');
  if (dirty || persistedRevision === null) throw new Error(t('saveRoutineFirst'));
  if (!confirm(t('confirmLibraryAction', { action: t('libraryPublish', { name: draft.name }) }))) return;
  const source = draft;
  let revision = persistedRevision;
  if (workingCopy) {
    const saved = await saveRoutine(structuredClone(source), savedRoutines.find(value => value.id === source.id)?.revision ?? null);
    revision = saved.revision;
  }
  const publication = await publishRoutine(source.id, revision);
  localPublications = [...localPublications.filter(value => value.id !== source.id), publication];
  const head = await getRoutine(source.id);
  if (!head || draft !== source) throw new Error('routine_conflict');
  acceptSavedRoutine(head); notify(t('localPublished'));
}); });
const deleteSelectedLocalRoutine = () => { void runEditor(async () => {
  if (cloudSelection || !canEdit() || draft.locked) throw new Error('routine_locked');
  if (persistedRevision === null) throw new Error(t('saveRoutineFirst'));
  if (!confirm(t('confirmLibraryAction', { action: t('libraryDelete', { name: draft.name }) }))) return;
  const source = draft;
  if (workingCopy) {
    const attempt = workingCopy.cloudAttempt;
    if (hostedPilot && attempt) {
      const identity = captureCloudIdentity();
      let head: CloudRoutine | null = null;
      try { head = await cloudLibrary.readHead(source.id); }
      catch (error) { if (!(error instanceof CloudRequestError && error.status === 404 && attempt.baseRevision === null)) throw error; }
      identity();
      if (head) {
        if (head.routine.revision !== (attempt.baseRevision ?? 0) + 1 || !sameSavedContent(head, attempt.envelope)) throw new Error('routine_conflict');
        await cloudLibrary.command(head, 'delete'); identity();
      }
    }
    const head = savedRoutines.find(value => value.id === source.id);
    if (head) await deleteRoutineAndWorkingCopy(source.id, head.revision, workingCopy.localVersion);
    else await deleteRoutineWorkingCopy(source.id, workingCopy.localVersion);
  } else await deleteRoutine(source.id, persistedRevision);
  if (draft !== source) throw new Error('routine_conflict');
  await clearActiveRoutine();
  workingCopies = workingCopies.filter(value => value.envelope.routine.id !== source.id);
  clearCloudSelection(); routineOpen = false; chooserOpen = true; selectedClass = null;
  stopEditorAudio(); savedRoutines = savedRoutines.filter(value => value.id !== source.id);
  draft = newRoutine(); draft.name = t('newName'); draft.filler.sound = 'lofi';
  persistedRevision = null; dirty = false; draftGeneration++; refreshDraft(true); notify(t('localDeleted'));
}); };
const localDelete = iconButton(t('localDelete'), Trash2, deleteSelectedLocalRoutine);
const moreMenu = actionMenu(t('moreActions'), Ellipsis);
const routineOverflow = moreMenu.element;
const overflowActions = moreMenu.commands;
const shareOptions = element('div', 'segmented');
const shareButtons = new Map<string, HTMLButtonElement>();
for (const mode of ['create', 'replace'] as const) {
  const button = iconButton(t(mode === 'create' ? 'shareCreate' : 'shareReplace'), mode === 'create' ? Plus : Save, () => {
    if (editorBusy || transportOperation.pending) return;
    shareMode = mode;
    if (mode === 'replace' && cloudMode.value !== 'draft') { cloudMode.value = 'draft'; cloudRoutines = []; }
    syncAvailability();
    if (mode === 'replace' && !cloudRoutines.length) void runCloud(refreshHousehold);
  }, true);
  shareButtons.set(mode, button); shareOptions.append(button);
}
overflowActions.append(lock, cloudOpenDraft, duplicate, cloudPublish, localPublish, cloudDelete, localDelete);
for (const command of [lock, duplicate, cloudPublish, cloudDelete, localPublish, localDelete]) {
  command.classList.remove('icon-button'); command.append(element('span', '', command.title));
}
cloudActions.replaceChildren(cloudCancel);
const editorPrepare = iconButton(t('retryPreparation'), RefreshCw, () => { if (preparationFailed) requestPreparation(); }, true);
editorPrepare.hidden = true;
const editorDemo = demoButton();
editorActions.append(newDraft, editorDemo, save, routineOverflow, editorPrepare);
const audioPicker = createAudioLibraryPicker({ library: cloudLibrary,
  preview: audioPreview, beforePreview: stopEditorAudio,
  restoreFocus: () => { if (!appDisposed && routineOpen && activeTab === 'edit') addTrackMenu.trigger.focus({ preventScroll: true }); },
  hosted: hostedPilot, known: () => [{ routine: draft, media: { ...cloudEnvelope?.media, ...draftMedia } }],
  available: () => routineOpen && canEdit() && !draft.locked && !editorBusy && !transportOperation.pending && !appDisposed,
  identity: () => `${draft.id}:${draftGeneration}`, remaining: () => 100 - allRoutineTracks(draft).length,
  added: (tracks, media) => { draft.tracks.push(...tracks); Object.assign(draftMedia, media); dirty = true; draftGeneration++; refreshDraft(true); },
});
const addTrackMenu = actionMenu(t('addTrack'), Plus, true);
const addTrackChevron = element('span', 'menu-chevron'); setButtonIcon(addTrackChevron, ChevronDown);
addTrackMenu.trigger.append(addTrackChevron);
addTrackMenu.commands.append(audioPicker.element, importButton());
const validation = element('div', 'validation');
let validationSignature = '';
const validationTitle = element('h2');
const validationDisplay = transientText(validationTitle, visible => { validation.hidden = !visible; });
validation.setAttribute('aria-live', 'polite');
const editor = element('div');
const draftIdentity = element('p', 'draft-identity');
draftIdentity.setAttribute('role', 'status');
const exportPanel = createExportPanel(() => ({ routine: draft, unsaved: dirty || persistedRevision === null,
  busy: editorBusy || appDisposed || hasInvalidCueTimes(draft) }));
const localSelection = field(t('savedRoutines'), routineSelect);
localSelection.hidden = true;
cloudControls.replaceChildren(cloudRefresh, cloudSignIn);
const routineLibrary = element('section', 'routine-library');
routineLibrary.setAttribute('aria-label', t('routines'));
const chooserDialog = element('dialog', 'library-dialog chooser-dialog routine-chooser');
chooserDialog.setAttribute('aria-label', t('openRoutineDialog'));
const chooserFeedback = element('p', 'chooser-feedback'); chooserFeedback.setAttribute('role', 'status');
const chooserErrors = transientText(chooserFeedback);
const searchRoutines = element('input'); searchRoutines.type = 'search';
searchRoutines.placeholder = t('searchRoutines'); searchRoutines.setAttribute('aria-label', t('searchRoutines'));
searchRoutines.addEventListener('input', () => renderRoutineLibrary());
const chooserHeader = element('div', 'chooser-heading');
const chooserClose = iconButton(t('closeChooser'), X, () => dismissChooser());
chooserHeader.append(element('h2', '', t('openRoutineDialog')), chooserClose);
chooserDialog.append(chooserHeader, chooserFeedback);
chooserDialog.addEventListener('cancel', event => { event.preventDefault(); dismissChooser(); });
chooserDialog.addEventListener('click', event => { if (event.target === chooserDialog) dismissChooser(); });
shell.append(chooserDialog);

function dismissChooser(accepted = false): void {
  if (!chooserDialog.open || (!accepted && (editorBusy || transportOperation.pending))) return;
  chooserDialog.close(); chooserOpen = !routineOpen;
  chooserErrors.dismiss();
  document.documentElement.classList.remove('routine-chooser-open');
  panels.edit.insertBefore(routineLibrary, editorActions);
  syncAvailability();
  (accepted ? editorRoutineTitle : openDifferent).focus({ preventScroll: true });
}

async function confirmRoutineSwitch(): Promise<'save' | 'discard' | null> {
  if (!dirty) return 'discard';
  return new Promise(resolve => {
    const dialog = element('dialog', 'library-dialog'); dialog.setAttribute('aria-label', t('switchRoutine'));
    const finish = (result: 'save' | 'discard' | null) => { dialog.close(); dialog.remove(); resolve(result); };
    const saveFirst = iconButton(t('saveChanges'), Save, () => finish('save'), true);
    saveFirst.disabled = !canEdit() || draft.locked || validationErrors.length > 0 || !!composition?.pending();
    dialog.append(element('h2', '', t('saveBeforeSwitch', { name: draft.name })), saveFirst,
      iconButton(t('discard'), Trash2, () => finish('discard'), true), iconButton(t('cancel'), X, () => finish(null), true));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    shell.append(dialog); dialog.showModal();
  });
}

async function switchLibraryRoutine(action: (transfer: CloudTransfer) => Promise<void | false>): Promise<void> {
  if (editorBusy || transportOperation.pending || appDisposed) return;
  const source = draft;
  const generation = draftGeneration;
  const decision = await confirmRoutineSwitch();
  if (!decision || appDisposed || source !== draft || generation !== draftGeneration || editorBusy) return;
  const work = async (transfer: CloudTransfer = {}) => {
    chooserErrors.dismiss();
    try {
      if (decision === 'save') await saveWorkingRoutine(transfer);
      if (appDisposed) return;
      if (await action(transfer) === false) return;
      if (!appDisposed) {
        if (!selectedClass) rememberClassSelection(localStorage, hostedPilot ? getCloudContext().user : null, null);
        dismissChooser(true);
      }
    } catch (error) { chooserErrors.show(cloudErrorMessage(error)); throw error; }
  };
  if (hostedPilot) await runCloud(work);
  else await runEditor(work);
}
const routineRows = element('div', 'routine-library-rows');
const locationMenu = element('details', 'filter-menu');
const locationSummary = element('summary', 'button', t('location')); locationMenu.append(locationSummary);
const libraryFilters = element('div', 'filter-options'); locationMenu.append(libraryFilters);
libraryFilters.setAttribute('role', 'group'); libraryFilters.setAttribute('aria-label', t('routines'));
const librarySources = new Set<'local' | 'household'>(hostedPilot ? ['local', 'household'] : ['local']);
const sourceButtons = new Map<string, HTMLInputElement>();
libraryFilters.setAttribute('aria-label', t('location'));
for (const source of ['local', 'household'] as const) {
  if (source === 'household' && !hostedPilot) continue;
  const button = element('input'); button.type = 'checkbox'; button.checked = librarySources.has(source);
  button.addEventListener('change', () => { if (button.checked) librarySources.add(source); else librarySources.delete(source); renderRoutineLibrary(); });
  sourceButtons.set(source, button); libraryFilters.append(field(t(source === 'local' ? 'localFilter' : 'householdFilter'), button));
}
const statusMenu = element('details', 'filter-menu');
const statusSummary = element('summary', 'button', t('statusFilter')); statusMenu.append(statusSummary);
const versionFilters = element('div', 'filter-options'); statusMenu.append(versionFilters);
versionFilters.setAttribute('role', 'group'); versionFilters.setAttribute('aria-label', t('statusFilter'));
for (const [menu, summary] of [[locationMenu, locationSummary], [statusMenu, statusSummary]] as const) {
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); menu.open = false; summary.focus(); } });
}
const libraryVersions = new Set(['draft', 'published']);
const versionButtons = new Map<string, HTMLInputElement>();
for (const version of ['draft', 'published'] as const) {
  const button = element('input'); button.type = 'checkbox'; button.checked = true;
  button.addEventListener('change', () => { if (button.checked) libraryVersions.add(version); else libraryVersions.delete(version); renderRoutineLibrary(); });
  versionButtons.set(version, button); versionFilters.append(field(t(version === 'draft' ? 'draft' : 'cloudPublications'), button));
}
const favoritesOnly = element('input'); favoritesOnly.type = 'checkbox';
favoritesOnly.addEventListener('change', () => renderRoutineLibrary());
let libraryFavorites = new Set<string>();
let libraryRecent: string[] = [];
const libraryPreferenceKey = 'fitness-routine-library';
const preferenceOwner = () => hostedPilot ? JSON.stringify(getCloudContext().user && [getCloudContext().user!.id, getCloudContext().user!.authVersion]) : 'local';
try {
  const stored = JSON.parse(sessionStorage.getItem(libraryPreferenceKey) ?? 'null');
  if (stored?.owner === preferenceOwner()) {
    libraryFavorites = new Set((stored.favorites ?? []).filter((id: unknown): id is string => typeof id === 'string')
      .map((id: string) => id.replace(/^(local|household):/, '').replace(/:(draft|published)$/, '')).slice(0, 512));
    libraryRecent = (stored.recent ?? []).filter((id: unknown) => typeof id === 'string').slice(0, 20);
  } else sessionStorage.removeItem(libraryPreferenceKey);
} catch {}
function rememberLibrary(id?: string): void {
  if (id) libraryRecent = [id, ...libraryRecent.filter(value => value !== id)].slice(0, 20);
  try { sessionStorage.setItem(libraryPreferenceKey, JSON.stringify({ owner: preferenceOwner(), favorites: [...libraryFavorites], recent: libraryRecent })); } catch {}
}

async function deleteChooserRoutine(value: CloudRoutineSummary, source: 'local' | 'household', listedCopy?: RoutineWorkingCopy): Promise<void> {
  if (editorBusy || transportOperation.pending || appDisposed || value.locked || value.published
    || (hostedPilot && !['owner', 'editor'].includes(getCloudRole() ?? ''))) return;
  const current = routineOpen && !selectedClass && draft.id === value.id && !draft.published
    && source === (cloudSelection ? 'household' : 'local');
  if (current) {
    if (cloudSelection) deleteSelectedCloudRoutine(); else deleteSelectedLocalRoutine();
    return;
  }
  const work = async (transfer: CloudTransfer = {}) => {
    const identity = hostedPilot ? captureCloudIdentity() : () => {};
    const assert = () => { identity(); if (appDisposed || transfer.signal?.aborted) throw new Error('cloud_cancelled'); };
    const copy = await getRoutineWorkingCopy(value.id); assert();
    if (listedCopy && (!copy || copy.localVersion !== listedCopy.localVersion)) throw new Error('routine_conflict');
    if (copy?.envelope.routine.locked || copy?.envelope.routine.published) throw new Error('routine_locked');
    const local = await getRoutine(value.id); assert();
    const remote = source === 'household' || copy?.cloudBaseRevision != null || !!copy?.cloudAttempt;
    let head: CloudRoutine | null = null;
    if (remote) {
      if (!hostedPilot || getCloudContext().access !== 'online' || navigator.onLine === false) throw new Error('cloud_head_required');
      try { head = await cloudLibrary.readHead(value.id, transfer); }
      catch (error) {
        if (!(error instanceof CloudRequestError && error.status === 404 && source === 'local' && copy?.cloudAttempt?.baseRevision === null)) throw error;
      }
      assert();
      if (head) {
        if (head.routine.locked || head.routine.published) throw new Error('routine_locked');
        const attempt = copy?.cloudAttempt;
        const acknowledged = attempt && head.routine.revision === (attempt.baseRevision ?? 0) + 1 && sameSavedContent(head, attempt.envelope);
        if (!acknowledged && head.routine.revision !== (copy?.cloudBaseRevision ?? value.revision)) throw new Error('routine_conflict');
      }
    } else if (!copy && (!local || local.revision !== value.revision)) throw new Error('routine_conflict');
    if (local?.locked || local?.published) throw new Error('routine_locked');
    if (!confirm(t('confirmLibraryAction', { action: t('libraryDelete', { name: value.name }) }))) return;
    assert();
    if (head) await cloudLibrary.command(head, 'delete', false, transfer);
    assert();
    if (copy && local) await deleteRoutineAndWorkingCopy(value.id, local.revision, copy.localVersion);
    else if (copy) await deleteRoutineWorkingCopy(value.id, copy.localVersion);
    else if (local && !remote) await deleteRoutine(value.id, local.revision);
    assert();
    workingCopies = workingCopies.filter(item => item.envelope.routine.id !== value.id);
    savedRoutines = savedRoutines.filter(item => item.id !== value.id);
    if (remote) {
      cloudRoutines = cloudRoutines.filter(item => item.id !== value.id);
      cachedCloudRoutines = cachedCloudRoutines.filter(item => item.id !== value.id);
    }
    renderRoutineLibrary(); notify(t(remote ? 'cloudDeleted' : 'localDeleted'));
  };
  if (hostedPilot) await runCloud(work);
  else {
    editorBusy = true; syncAvailability();
    try { await work(); } catch (error) { chooserErrors.show(errorMessage(error)); }
    finally { editorBusy = false; syncAvailability(); }
  }
}
function renderRoutineLibrary(): void {
  const playerRole = hostedPilot && getCloudRole() === 'player';
  for (const [source, button] of sourceButtons) {
    button.disabled = editorBusy || (playerRole && source === 'local');
    button.checked = librarySources.has(source as 'local' | 'household') && !(playerRole && source === 'local');
  }
  for (const [version, button] of versionButtons) {
    button.disabled = editorBusy || (playerRole && version === 'draft');
    button.checked = libraryVersions.has(version) && !(playerRole && version === 'draft');
  }
  cloudPanel.hidden = !hostedPilot || (routineOpen && !chooserDialog.open);
  routineRows.replaceChildren();
  type Row = { value: CloudRoutineSummary; source: 'local' | 'household'; copy?: RoutineWorkingCopy; legacy?: ClassSelection };
  const entries: Row[] = [...savedRoutines, ...localPublications].map(value => ({ value, source: 'local' }));
  const heads = [...new Map([...cachedCloudRoutines, ...cloudRoutines].map(value => [`${value.id}:${value.published}`, value])).values()];
  entries.push(...heads.map(value => ({ value, source: 'household' as const })));
  for (const copy of workingCopies) {
    entries.push({ value: copy.envelope.routine, source: 'local', copy });
    if (copy.cloudBaseRevision !== null && !copy.pendingCloud && !heads.some(value => value.id === copy.envelope.routine.id && !value.published)) {
      entries.push({ value: copy.envelope.routine, source: 'household', copy });
    }
  }
  entries.push(...legacyClasses.map(legacy => ({ value: legacy.setup, source: legacy.source, legacy })));
  const key = (row: Row) => `${row.legacy ? 'class:' : ''}${row.value.id}`;
  const query = searchRoutines.value.trim().toLocaleLowerCase(locale);
  const matches = entries.filter(row => row.value.name.toLocaleLowerCase(locale).includes(query)
    && librarySources.has(row.source) && libraryVersions.has(row.value.published ? 'published' : 'draft')
    && (!playerRole || (row.source === 'household' && row.value.published)) && (!favoritesOnly.checked || libraryFavorites.has(key(row))));
  const values = [...new Map(matches.map(row => [`${key(row)}:${row.source}:${row.value.published}`, row])).values()];
  values.sort((first, second) => Number(libraryFavorites.has(key(second))) - Number(libraryFavorites.has(key(first)))
    || first.value.name.localeCompare(second.value.name));
  if (!values.length) routineRows.append(element('p', 'chooser-empty', t('noRoutineMatches')));
  for (const rowValue of values) {
    const { value, source, copy, legacy } = rowValue;
    const row = element('div', 'routine-library-row');
    const name = element('span', 'library-row-name', legacy ? t('legacyVariant', { name: value.name }) : value.name);
    const meta = element('span', 'muted', `${t(source === 'local' ? 'localFilter' : 'householdFilter')} / ${t(value.published ? 'exportPublished' : 'draft')}`);
    const text = element('div'); text.append(name, meta);
    const favorite = iconButton(t('favorite', { name: value.name }), Star, () => {
      const id = key(rowValue); if (libraryFavorites.has(id)) libraryFavorites.delete(id); else libraryFavorites.add(id);
      rememberLibrary(); renderRoutineLibrary();
    });
    favorite.setAttribute('aria-pressed', String(libraryFavorites.has(key(rowValue))));
    const current = routineOpen && (legacy ? selectedClass?.setup.id === value.id && selectedClass.source === source
      : !selectedClass && draft.id === value.id && draft.published === value.published
        && draft.revision === value.revision && source === (cloudSelection ? 'household' : 'local'));
    if (current) text.append(element('span', 'current-routine', t('currentRoutine')));
    const open = iconButton(t('openRoutine', { name: value.name }), Download, () => {
      if (current && !legacy) { dismissChooser(); return; }
      void switchLibraryRoutine(async transfer => {
        if (legacy) {
          if (getCloudRole() !== 'player' && !confirm(t('confirmLegacyOpen', { name: legacy.setup.name }))) return false;
          await openLegacyRoutine(legacy, true);
        } else if (copy) {
          const identity = hostedPilot ? captureCloudIdentity() : () => {};
          const current = await getRoutineWorkingCopy(value.id); if (!current) throw new Error('routine_not_found');
          identity();
          if (appDisposed) return;
          if (current.cloudBaseRevision !== null && !current.pendingCloud && getCloudContext().access === 'online' && navigator.onLine !== false) {
            const head = await cloudLibrary.readHead(value.id, transfer); identity();
            await acceptCloudEnvelope(await cloudLibrary.download(head, transfer), false);
          } else {
            await setActiveRoutine(value.id); identity();
            if (appDisposed) return;
            clearCloudSelection(); acceptWorkingCopy(current); selectedClass = null; requestPreparation();
          }
        } else if (source === 'household') { await openCloudRoutine(value.id, value.published, transfer, true); }
        else if (value.published) {
          const identity = hostedPilot ? captureCloudIdentity() : () => {};
          const saved = await getRoutine(value.id, value.revision, true); if (!saved) throw new Error('routine_not_found');
          identity(); await setActiveRoutineSelection({ id: saved.id, revision: saved.revision, published: true }); identity();
          if (appDisposed) return;
          clearCloudSelection(); acceptSavedRoutine(saved); selectedClass = null;
        } else {
          const identity = hostedPilot ? captureCloudIdentity() : () => {};
          const saved = await getRoutine(value.id); identity();
          if (!saved) throw new Error('routine_not_found');
          const copy = await getRoutineWorkingCopy(value.id); identity();
          await setActiveRoutine(value.id); identity();
          if (appDisposed) return;
          clearCloudSelection(); selectedClass = null;
          if (copy) { acceptWorkingCopy(copy); requestPreparation(); } else acceptSavedRoutine(saved);
        }
        rememberLibrary(key(rowValue));
      });
    });
    open.disabled = editorBusy || transportOperation.pending;
    row.append(text, favorite, open);
    if (!playerRole && !legacy && !value.locked && !value.published) {
      const remove = iconButton(t('deleteRoutine'), Trash2, () => { void deleteChooserRoutine(value, source, copy); }, true);
      remove.classList.add('danger'); remove.disabled = editorBusy || transportOperation.pending
        || (source === 'household' && (getCloudContext().access !== 'online' || navigator.onLine === false));
      remove.dataset.cloudRoutineDelete = String(source === 'household');
      row.append(remove);
    }
    routineRows.append(row);
  }
}
const replaceTarget = field(t('cloudReplace'), cloudSelect);
const replaceDialog = element('dialog', 'library-dialog');
replaceDialog.setAttribute('aria-label', t('replaceAnother'));
const replaceAnother = iconButton(t('replaceAnother'), Copy, () => {
  if (editorBusy || transportOperation.pending || cloudSelection) return;
  replaceDialog.showModal(); cloudSelect.focus();
}, true);
const closeReplace = () => { if (!editorBusy) { replaceDialog.close(); moreMenu.trigger.focus({ preventScroll: true }); } };
replaceDialog.addEventListener('cancel', event => { event.preventDefault(); closeReplace(); });
replaceDialog.append(element('h2', '', t('replaceAnother')), replaceTarget, cloudReplace,
  iconButton(t('cancel'), X, closeReplace, true));
shell.append(replaceDialog); overflowActions.insertBefore(replaceAnother, cloudDelete);
const libraryToolbar = element('div', 'library-toolbar');
libraryToolbar.append(locationMenu, statusMenu, field(t('favoritesOnly'), favoritesOnly), cloudRefresh);
cloudRefresh.hidden = !hostedPilot;
routineLibrary.append(searchRoutines, libraryToolbar, cloudPanel, routineRows);
editorTitle.append(draftIdentity);
panels.edit.append(editorHeading, routineLibrary, editorActions, validation, editor);
editorHeadingActions.append(exportPanel.element);
const openDifferent = iconButton(t('openDifferent'), ListMusic, () => {
  if (editorBusy || transportOperation.pending || chooserDialog.open) return;
  chooserOpen = true; chooserErrors.dismiss();
  chooserDialog.append(routineLibrary); chooserDialog.showModal();
  document.documentElement.classList.add('routine-chooser-open');
  renderRoutineLibrary(); syncAvailability(); searchRoutines.focus({ preventScroll: true });
}, true);
editorRoutineTitle.tabIndex = -1;
editorHeadingActions.append(openDifferent);
const close = iconButton(t('closeRoutine'), X, () => closeRoutine(), true);
const deleteSelectedRoutine = iconButton(t('deleteRoutine'), Trash2, () => {
  if (!routineOpen || editorBusy || transportOperation.pending || !canEdit() || draft.locked) return;
  if (cloudSelection) deleteSelectedCloudRoutine(); else deleteSelectedLocalRoutine();
}, true);
deleteSelectedRoutine.classList.add('danger');
const editorFooter = element('footer', 'editor-footer'); editorFooter.append(close, deleteSelectedRoutine); panels.edit.append(editorFooter);

function nameRoutine(label: string, initial: string, action: (name: string) => Promise<void>): void {
  cancelCueDrag();
  const dialog = element('dialog', 'library-dialog'); dialog.setAttribute('aria-label', label);
  const input = element('input'); input.type = 'text'; input.maxLength = 160; input.required = true; input.value = initial;
  const feedback = element('p'); const error = transientText(feedback);
  const dismiss = () => { error.dispose(); dialog.close(); dialog.remove(); };
  const apply = iconButton(t('apply'), Check, () => {
    const value = input.value.trim();
    if (!value || value.length > 160) { input.reportValidity(); return; }
    apply.disabled = true;
    void action(value).then(dismiss).catch(reason => { error.show(errorMessage(reason)); apply.disabled = false; });
  }, true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.append(element('h2', '', label), field(t('routineName'), input), feedback, iconButton(t('cancel'), X, dismiss, true), apply);
  shell.append(dialog); dialog.showModal(); input.focus(); input.select();
}

async function independentRoutine(source: Routine, name: string, media: CloudRoutine['media']): Promise<CloudRoutine> {
  const identity = hostedPilot ? captureCloudIdentity() : () => {};
  const copy = duplicateDraft(source); copy.schemaVersion = 2; copy.name = name; delete copy.savedAt;
  const copiedMedia: CloudRoutine['media'] = {};
  for (const track of allRoutineTracks(copy)) {
    const originalId = track.id;
    const blob = await import('./offline').then(module => module.getTrackBlob(originalId)); identity();
    if (!blob) throw new Error('missing_audio');
    const hash = await cloudHash(blob); identity();
    track.id = crypto.randomUUID(); track.cues = track.cues.map(cue => ({ ...cue, id: crypto.randomUUID() }));
    await cacheCloudTrack(track.id, blob, hash); identity();
    if (media[originalId]) copiedMedia[track.id] = structuredClone(media[originalId]);
  }
  return { routine: copy, media: copiedMedia };
}

async function openLegacyRoutine(selection: ClassSelection, confirmed = false): Promise<void> {
  if (!confirmed && dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
  const identity = hostedPilot ? captureCloudIdentity() : () => {};
  const resolved = await classLibrary.legacy(selection).catch(error => { throw new Error(cloudErrorMessage(error)); });
  identity(); if (appDisposed) return;
  if (hostedPilot && getCloudRole() === 'player') {
    if (selection.source !== 'household' || !selection.setup.published || !resolved.routine.published) throw new Error('cloud_head_required');
    stopEditorAudio(); clearCloudSelection();
    selectedClass = structuredClone(selection);
    cloudSelection = { id: resolved.routine.id, revision: resolved.routine.revision, published: true, cached: true };
    cloudEnvelope = resolved.envelope ?? null; draftMedia = structuredClone(resolved.envelope?.media ?? {});
    draft = structuredClone(resolved.routine); persistedRevision = draft.revision;
    dirty = false; routineOpen = true; chooserOpen = false; draftGeneration++;
    rememberSelection(); rememberClassSelection(localStorage, getCloudContext().user, selection);
    refreshDraft(true); requestPreparation(); return;
  }
  const sequence: NonNullable<Routine['sequence']> = { crossfade: resolved.audio.crossfade ?? 2 };
  for (const phase of ['before', 'after'] as const) if (resolved.audio[phase]) sequence[phase] = structuredClone(resolved.audio[phase]);
  for (const phase of ['walkIn', 'walkOut'] as const) {
    const playlist = resolved.audio[phase];
    if (playlist?.tracks.length) sequence[phase] = { name: playlist.name, tracks: structuredClone(playlist.tracks), source: selection.setup[phase] };
  }
  const snapshot = await independentRoutine({ ...resolved.routine, sequence, schemaVersion: 2 }, selection.setup.name, resolved.media ?? resolved.envelope?.media ?? {});
  clearCloudSelection(); draft = snapshot.routine; draftMedia = snapshot.media; selectedClass = null;
  persistedRevision = null; dirty = true; routineOpen = true; chooserOpen = false; draftGeneration++; refreshDraft(true); requestPreparation();
}

function closeRoutine(): void {
  if (!routineOpen || editorBusy || transportOperation.pending || appDisposed) return;
  const id = draft.id;
  const dialog = element('dialog', 'library-dialog'); dialog.setAttribute('aria-label', t('closeRoutine'));
  const feedback = element('p'); const error = transientText(feedback);
  const dismiss = (restoreFocus = true) => { error.dispose(); dialog.close(); dialog.remove(); if (restoreFocus) close.focus(); };
  const finish = async (saving: boolean) => {
    if (editorBusy || draft.id !== id) return;
    let completed = false;
    editorBusy = true; syncAvailability();
    try {
      if (saving) await saveWorkingRoutine();
      if (appDisposed || draft.id !== id) return;
      if (loaded && ['playing', 'filler', 'paused'].includes(state.status) && !confirm(t('confirmPrepare'))) return;
      await clearActiveRoutine();
      stopEditorAudio(); transportOperation.cancel(() => player.unload());
      loaded = null; preparedAudio = undefined; preparedName = ''; selectedClass = null;
      rememberClassSelection(localStorage, hostedPilot ? getCloudContext().user : null, null);
      clearCloudSelection(); routineOpen = false; chooserOpen = true; autoPrepareRequested = false;
      draft = newRoutine(); persistedRevision = null; dirty = false; draftGeneration++;
      refreshDraft(true); dismiss(false); completed = true;
    } catch (reason) { error.show(errorMessage(reason)); }
    finally {
      editorBusy = false; syncAvailability();
      if (completed && !appDisposed) (newDraft.hidden ? searchRoutines : newDraft).focus({ preventScroll: true });
    }
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!editorBusy) dismiss(); });
  const saveClose = iconButton(t(hostedPilot ? 'cloudSave' : 'save'), Save, () => { void finish(true); }, true);
  saveClose.disabled = !canEdit() || draft.locked || !!composition?.pending() || validationErrors.length > 0;
  dialog.append(element('h2', '', t('closeRoutinePrompt', { name: draft.name })), feedback, saveClose,
    iconButton(t('discard'), Trash2, () => { void finish(false); }, true), iconButton(t('cancel'), X, () => { if (!editorBusy) dismiss(); }, true));
  shell.append(dialog); dialog.showModal();
}

const protection = createDraftProtection({
  editable: () => !appDisposed && !editorBusy && !transportOperation.pending && canEdit() && !draft.locked && !shell.classList.contains('class-mode'),
  apply: (value, attachments) => {
    if (!('filler' in value)) return;
    stopEditorAudio(); draft = value; draftMedia = attachments.media; composition?.restore(attachments.editorState);
    dirty = true; draftGeneration++; refreshDraft(true);
  },
});
editorActions.insertBefore(draftStatus, editorActions.firstChild);
editorActions.insertBefore(protection.element, draftStatus);
const recoveries = createRecoveryPanel({
  allowed: () => !appDisposed && !editorBusy && !transportOperation.pending && !shell.classList.contains('class-mode')
    && (!hostedPilot || ['owner', 'editor'].includes(getCloudRole() ?? '')),
  message: notify,
  restore: async record => {
    if (record.kind === 'class' && 'routine' in record.value) {
      await runEditor(() => openLegacyRoutine({ setup: { ...record.value as import('../../shared/class-plan').ClassSetup,
        name: t('recoveryCopy', { name: record.value.name }) }, source: record.source }));
      return;
    }
    if (record.kind === 'playlist') { selectTab('playlists'); await playlistEditor?.initialize(); await playlistEditor?.restoreRecovery(record); return; }
    await runEditor(async () => {
      if (!('filler' in record.value) || (dirty && !confirm(t('confirmSwitch', { name: draft.name })))) return;
      const assertIdentity = hostedPilot ? captureCloudIdentity() : () => {};
      const restored = await independentRoutine(record.value, t('recoveryCopy', { name: record.value.name }), record.media);
      assertIdentity(); clearCloudSelection();
      draft = restored.routine; draftMedia = restored.media; routineOpen = true; chooserOpen = false; selectedClass = null;
      persistedRevision = null; dirty = true; draftGeneration++; refreshDraft(true); selectTab('edit');
    });
  },
});
draftIdentity.after(recoveries.element);

const readyPanel = element('section', 'settings-section readiness');
readyPanel.setAttribute('aria-label', t('readiness'));
const readyIdentity = element('p');
const readyState = element('p'); readyState.setAttribute('role', 'status');
const readyQueue = element('dl');
readyPanel.append(element('h2', '', t('readiness')), readyIdentity, readyState, readyQueue);
panels.teach.insertBefore(readyPanel, rehearsal);

function renderReadiness() {
  readyIdentity.textContent = loaded ? preparedName : draft.name;
  const changed = !!loaded && (preparedClassKey !== classKey() || (!selectedClass && contentFingerprint(draft) !== contentFingerprint(loaded)));
  readyState.textContent = !loaded ? t('preparePrompt') : changed ? t('readinessChanged') : t('verifiedLocal');
  readyQueue.replaceChildren();
  for (const [label, value] of [
    ['phaseWalkIn', preparedAudio?.walkIn?.tracks.length ? preparedAudio.walkIn.name : undefined],
    ['beforeAnnouncement', preparedAudio?.before?.recording?.name ?? preparedAudio?.before?.sound],
    ['routine', loaded?.name],
    ['afterAnnouncement', preparedAudio?.after?.recording?.name ?? preparedAudio?.after?.sound],
    ['phaseWalkOut', preparedAudio?.walkOut?.tracks.length ? preparedAudio.walkOut.name : undefined],
  ] as const) readyQueue.append(element('dt', '', t(label)), element('dd', '', value ?? t('notQueued')));
  readyPanel.hidden = shell.classList.contains('class-mode');
}

const settingsHeading = element('div', 'section-heading');
settingsHeading.append(element('h1', '', t('settings')));
const appearance = element('section', 'settings-section');
appearance.append(element('h2', '', t('appearance')));
const modes = element('div', 'segmented');
const modeButtons = new Map<string, HTMLButtonElement>();
for (const [mode, icon] of [['light', Sun], ['dark', Moon]] as const) {
  const button = iconButton(t(mode), icon, () => { preferences.mode = mode; updatePreferences(); }, true);
  modeButtons.set(mode, button);
  modes.append(button);
}
const contrastLabel = element('label', 'switch-label');
const contrastInput = element('input');
contrastInput.type = 'checkbox';
contrastInput.checked = preferences.highContrast;
contrastInput.addEventListener('change', () => { preferences.highContrast = contrastInput.checked; updatePreferences(); });
contrastLabel.append(contrastInput, element('span', '', t('highContrast')));
const swatches = element('div', 'swatches');
swatches.setAttribute('role', 'group');
swatches.setAttribute('aria-label', t('accent'));
const swatchButtons = new Map<string, HTMLButtonElement>();
for (const accent of accents) {
  const swatch = iconButton(t(accent), Check, () => { preferences.accent = accent; updatePreferences(); });
  swatch.classList.add('swatch');
  swatch.dataset.swatch = accent;
  swatchButtons.set(accent, swatch);
  swatches.append(swatch);
}
appearance.append(modes, contrastLabel, field(t('accent'), swatches),
  makeRange(t('progressHeight'), 44, 120, preferences.progressHeight, value => { preferences.progressHeight = value; updatePreferences(); }, 'pixels'));
const demoSettings = element('section', 'settings-section');
const disableDemosLabel = element('label', 'switch-label');
const disableDemosInput = element('input');
disableDemosInput.type = 'checkbox';
disableDemosInput.checked = preferences.disableDemos === true;
disableDemosInput.addEventListener('change', () => {
  preferences.disableDemos = disableDemosInput.checked;
  updatePreferences();
  syncAvailability();
});
disableDemosLabel.append(disableDemosInput, element('span', '', t('disableDemos')));
demoSettings.append(element('h2', '', t('demoSettings')), disableDemosLabel);
const fillerLibraryCurrent = () => !appDisposed && (activeTab === 'settings' || activeTab === 'edit') && !shell.classList.contains('class-mode');
const fillerLibrary = createFillerLibrary({ hosted: hostedPilot, cloud: cloudLibrary, preview: audioPreview,
  managed: hostedPilot,
  busy: () => editorBusy || retryingPending || transportOperation.pending,
  working: value => { editorBusy = value; syncAvailability(); },
  analyzeLoudness: analyzeTrackLoudness,
  isCurrent: fillerLibraryCurrent,
  changed: () => editorSession?.refreshFillers(),
  message: (message, error) => { if (activeTab === 'edit') notify(message, error); },
});
classPanel = createClassPanel({ hosted: hostedPilot, draft: () => draft,
  preview: audioPreview, beforePreview: stopEditorAudio,
  currentSelection: () => selectedClass,
  routineMedia: () => cloudEnvelope?.routine.id === draft.id ? cloudEnvelope.media : {},
  busy: () => editorBusy || transportOperation.pending || !!composition?.working() || shell.classList.contains('class-mode'), recordings: fillerLibrary.choices,
  message: notify, selected: selection => {
    if (composition && !composition.discard()) return;
    selectedClass = selection;
    try { rememberClassSelection(localStorage, hostedPilot ? getCloudContext().user : null, selection); }
    catch { notify(t('activeSelectionFailure'), true); }
    notify(selection ? t('classSelected', { name: selection.setup.name, revision: selection.setup.revision }) : t('routineOnly'));
    refreshDraft(false);
  },
});
playlistEditor = createPlaylistEditor({ hosted: hostedPilot, preview: audioPreview,
  busy: () => editorBusy || retryingPending || transportOperation.pending || !!composition?.working() || shell.classList.contains('class-mode'),
  working: value => { editorBusy = value; syncAvailability(); if (!value) schedulePreparation(); },
  visible: () => activeTab === 'playlists',
  known: () => [{ routine: draft, media: { ...cloudEnvelope?.media, ...draftMedia } }],
  returnToRoutine: () => { selectTab('edit'); tabButtons.get('edit')?.focus({ preventScroll: true }); }, message: notify,
});
panels.playlists.append(playlistEditor.element);
composition = createClassComposition({
  hosted: hostedPilot, routine: () => draft, routineSaved: () => persistedRevision !== null && !dirty,
  source: () => cloudSelection ? 'household' : 'local', selection: () => selectedClass,
  busy: () => editorBusy || transportOperation.pending || shell.classList.contains('class-mode'),
  recordings: fillerLibrary.choices, message: notify, managePlaylists: openClassMusic,
  editable: canEdit,
  adoptMedia: media => { Object.assign(draftMedia, media); },
  changed: () => { dirty = true; draftGeneration++; refreshDraft(false, false); },
  status: () => syncAvailability(),
  select: selection => {
    selectedClass = selection;
    try { rememberClassSelection(localStorage, hostedPilot ? getCloudContext().user : null, selection); }
    catch { notify(t('activeSelectionFailure'), true); }
    refreshDraft(false);
  },
});
editorActions.after(composition.controls);
const editorClassMusic = iconButton(t('classMusic'), ListMusic, openClassMusic, true);
editorClassMusic.hidden = true;
const storage = element('section', 'settings-section');
const offlineStatus = element('p', 'muted storage-notice', t(import.meta.env.PROD ? 'offlinePending' : 'offlineDevelopment'));
const offlineStatusDisplay = transientText(offlineStatus);
offlineStatus.setAttribute('role', 'status');
const updateStatus = element('p', 'muted storage-notice', t('offlineUpdateWaiting'));
updateStatus.setAttribute('role', 'status');
updateStatus.hidden = true;
const buildId = import.meta.env.VITE_APP_BUILD_ID;
const buildStatus = element('p', 'muted storage-notice', t('buildIdentity', {
  id: typeof buildId === 'string' && buildId.trim() ? buildId : t('buildUnknown'),
}));
storage.append(element('h2', '', t(hostedPilot ? 'hostedStorage' : 'localStorage')), offlineStatus, updateStatus, buildStatus,
  element('p', 'muted storage-notice', t(hostedPilot ? 'hostedStorageNotice' : 'storageNotice')));
if (hostedPilot) {
  const signOutNotice = element('p', 'muted storage-notice', t('hostedSignOutNotice'));
  signOutNotice.id = 'hosted-signout-notice';
  const signOut = element('a', 'button hosted-signout', t('hostedSignOut'));
  signOut.href = '/signout.html';
  signOut.setAttribute('aria-describedby', signOutNotice.id);
  signOut.addEventListener('click', event => {
    event.preventDefault();
    confirmCloudNavigation(() => confirm(t('cloudConfirmSignout')), () => {
      localStorage.removeItem(hostedCloudSelectionKey);
      disposeApp();
    }, () => window.location.assign(signOut.href));
  });
  storage.append(signOutNotice, signOut);
}
mediaLibrary = createMediaLibrary({ hosted: hostedPilot, cloud: cloudLibrary, preview: audioPreview,
  known: () => [
    { routine: draft, media: { ...cloudEnvelope?.media, ...draftMedia } },
    ...(playlistEditor?.currentMedia() ?? []),
    ...(loaded ? [{ routine: loaded, media: {} }] : []),
    ...(loaded && preparedAudio ? [{ routine: { ...loaded, schemaVersion: 2 as const,
      sequence: { crossfade: preparedAudio.crossfade, before: preparedAudio.before, after: preparedAudio.after } }, media: {} }] : []),
    ...[preparedAudio?.walkIn, preparedAudio?.walkOut].flatMap(playlist => playlist ? [{ playlist, media: {} }] : []),
  ],
  busy: () => editorBusy || retryingPending || transportOperation.pending || !!composition?.working() || shell.classList.contains('class-mode'),
  working: value => { editorBusy = value; syncAvailability(); if (!value) schedulePreparation(); },
  visible: () => activeTab === 'settings' && !appDisposed && !shell.classList.contains('class-mode'),
  beforePreview: () => { stopEditorAudio(); if (['playing', 'filler'].includes(state?.status)) transportOperation.cancel(() => player.pause()); },
  changed: () => { void fillerLibrary.refresh(); },
  catalog: items => fillerLibrary.catalog(items),
});
if (hostedPilot) mediaLibrary.element.append(fillerLibrary.element);
panels.settings.append(settingsHeading, appearance, demoSettings, mediaLibrary.element,
  ...(hostedPilot ? [] : [fillerLibrary.element]), storage);

function updatePreferences(persist = true): void {
  applyTheme(preferences);
  for (const [mode, button] of modeButtons) button.setAttribute('aria-pressed', String(mode === preferences.mode));
  for (const accent of accents) {
    const button = swatchButtons.get(accent)!;
    button.style.setProperty('--swatch', palette[accent][preferences.mode]);
    button.setAttribute('aria-pressed', String(accent === preferences.accent));
  }
  if (persist && !savePreferences(preferences)) notify(t('storageFailure'), true);
}

function assertValid(): void {
  if (composition?.pending()) throw new Error(t('choosePhasePlaylist'));
  if (hasInvalidCueTimes(draft) || cueTimeInvalid) throw new Error(t('invalidCueTime'));
  const errors = validateRoutine(draft);
  if (errors.length) throw new Error(errors.map(validationMessage).join('\n'));
}

function acceptSavedRoutine(saved: Routine): void {
  if (appDisposed) return;
  stopEditorAudio();
  if (!selectedClass && loaded?.id === saved.id && contentFingerprint(loaded) === contentFingerprint(saved)) {
    loaded = { ...loaded, revision: saved.revision, locked: saved.locked, published: saved.published };
    preparedCloudBase = selectionKey();
  }
  draft = structuredClone(saved);
  routineOpen = true; chooserOpen = false;
  draftGeneration++;
  persistedRevision = saved.revision;
  dirty = false;
  if (saved.published) {
    localPublications = [...localPublications.filter(value => value.id !== saved.id || value.revision !== saved.revision), structuredClone(saved)];
  } else {
    const index = savedRoutines.findIndex(routine => routine.id === saved.id);
    if (index < 0) savedRoutines.push(structuredClone(saved));
    else savedRoutines[index] = structuredClone(saved);
  }
  refreshDraft(true);
  requestPreparation();
}

async function saveWorkingRoutine(transfer: CloudTransfer = {}): Promise<void> {
  if (!canEdit() || draft.locked) throw new Error('routine_locked');
  assertValid();
  const source = draft;
  const generation = draftGeneration;
  const assertIdentity = hostedPilot ? captureCloudIdentity() : () => {};
  const envelope = await routineSaver.snapshot(draft, draftMedia);
  assertIdentity();
  if (appDisposed || draft !== source || generation !== draftGeneration) throw new Error('routine_conflict');
  const cloud = hostedPilot;
  const cloudBaseRevision = workingCopy?.cloudBaseRevision ?? (cloudSelection ? cloudSelection.revision : null);
  const saved = await saveRoutineWorkingCopy(envelope, { expectedLocalVersion: workingCopy?.localVersion ?? null, cloud, cloudBaseRevision });
  assertIdentity();
  workingCopy = saved; draft = structuredClone(saved.envelope.routine); draftMedia = structuredClone(saved.envelope.media);
  persistedRevision = draft.revision; dirty = false; draftGeneration++;
  workingCopies = await listRoutineWorkingCopies();
  refreshDraft(true);
  notify(t(cloud ? 'savedPending' : 'savedToast'));
  if (cloud && getCloudContext().access === 'online') {
    try {
      const result = await routineSaver.sync(saved, transfer);
      assertIdentity();
      if (result) { acceptWorkingCopy(result); notify(t(result.pendingCloud ? 'savedPending' : 'cloudSaved')); }
    } catch (error) {
      const latest = await getRoutineWorkingCopy(saved.envelope.routine.id); assertIdentity();
      if (latest && draft.id === latest.envelope.routine.id && !dirty) {
        workingCopy = latest; draftMedia = structuredClone(latest.envelope.media); draft = structuredClone(latest.envelope.routine); refreshDraft(true);
      }
      notify(`${t('savedPending')} ${cloudErrorMessage(error)}`, true);
    }
  }
}

function acceptWorkingCopy(copy: RoutineWorkingCopy): void {
  workingCopy = structuredClone(copy);
  workingCopies = [...workingCopies.filter(value => value.envelope.routine.id !== copy.envelope.routine.id), structuredClone(copy)];
  if (copy.cloudBaseRevision !== null && !copy.pendingCloud) {
    const routine = copy.envelope.routine;
    cloudRoutines = [...cloudRoutines.filter(value => value.id !== routine.id || value.published !== routine.published), structuredClone(routine)];
    cachedCloudRoutines = [...cachedCloudRoutines.filter(value => value.id !== routine.id || value.published !== routine.published), structuredClone(routine)];
  }
  draft = structuredClone(copy.envelope.routine); draftMedia = structuredClone(copy.envelope.media);
  if (copy.cloudBaseRevision === null) {
    const head = savedRoutines.find(value => value.id === draft.id);
    if (head) { draft.locked = head.locked; draft.revision = head.revision; }
  }
  cloudEnvelope = copy.cloudBaseRevision !== null ? structuredClone(copy.envelope) : null;
  cloudSelection = copy.cloudBaseRevision !== null ? { id: draft.id, revision: copy.cloudBaseRevision, published: false } : null;
  if (loaded?.id === draft.id && contentFingerprint(loaded) === contentFingerprint(draft)) {
    loaded.revision = draft.revision; loaded.locked = draft.locked; preparedCloudBase = selectionKey();
  }
  persistedRevision = draft.revision; dirty = false; routineOpen = true; chooserOpen = false; draftGeneration++;
  rememberSelection(); refreshDraft(true);
}

function requestPreparation(): void { preparationFailed = false; autoPrepareRequested = true; schedulePreparation(); }
function schedulePreparation(): void {
  if (!autoPrepareRequested || appDisposed || editorBusy || retryingPending || transportOperation.pending || composition?.working()) return;
  if (!routineOpen || !draft.tracks.length || validateRoutine(draft).length || composition?.pending()) { autoPrepareRequested = false; return; }
  if (loaded && state.status !== 'error' && preparedClassKey === classKey() && (selectedClass
    ? loaded.id === selectedClass.setup.routine.id && loaded.revision === selectedClass.setup.routine.revision
    : loaded.id === draft.id && loaded.revision === draft.revision && preparedCloudBase === selectionKey()
      && contentFingerprint(loaded) === contentFingerprint(draft))) { autoPrepareRequested = false; return; }
  queueMicrotask(() => {
    if (autoPrepareRequested && !appDisposed && !editorBusy && !retryingPending && !transportOperation.pending && !composition?.working()) {
      autoPrepareRequested = false;
      preparationFailed = false;
      stopEditorAudio();
      void transportOperation.run(async current => {
        try { await prepareRoutine(current); }
        catch (error) { if (current() && !appDisposed) preparationFailed = true; throw error; }
      }).finally(schedulePreparation);
    }
  });
}

async function retryPending(): Promise<void> {
  if (!hostedPilot || appDisposed || getCloudContext().access !== 'online' && !pendingSessionRefresh) {
    pendingSyncRequested = false;
    return;
  }
  pendingSyncRequested = true;
  if (editorBusy || appDisposed || transportOperation.pending || composition?.working()) return;
  pendingSyncRequested = false;
  editorBusy = true; syncAvailability();
  try {
    if (pendingSessionRefresh && hostedPilot) {
      pendingSessionRefresh = false;
      const identity = captureCloudIdentity(); await refreshCloudSession(); identity();
    }
    await syncPending(); await playlistEditor?.syncPending();
  } catch (error) { if (!appDisposed) notify(cloudErrorMessage(error), true); }
  finally { editorBusy = false; syncAvailability(); schedulePreparation(); }
}

function onOnline(): void { pendingSessionRefresh = hostedPilot; void retryPending(); }

async function syncPending(transfer: CloudTransfer = {}): Promise<void> {
  if (!hostedPilot || retryingPending || appDisposed || getCloudContext().access !== 'online') return;
  retryingPending = true;
  const identity = captureCloudIdentity();
  try {
    const copies = await listRoutineWorkingCopies(); identity();
    for (const copy of copies.filter(value => value.pendingCloud)) {
      const source = draft;
      const result = await routineSaver.sync(copy, transfer); identity();
      if (appDisposed) return;
      if (result && routineOpen && draft === source && draft.id === result.envelope.routine.id && workingCopy?.localVersion === copy.localVersion) {
        if (!dirty) {
          acceptWorkingCopy(result);
          if (!loaded || !['playing', 'filler', 'paused'].includes(state.status)) requestPreparation();
        }
        else {
          workingCopy = result; draft.revision = result.envelope.routine.revision; draft.savedAt = result.envelope.routine.savedAt;
          cloudEnvelope = structuredClone(result.envelope); cloudSelection = { id: draft.id, revision: draft.revision, published: false };
          Object.assign(draftMedia, result.envelope.media); refreshDraft(false);
        }
      }
    }
  } catch (error) { if (!appDisposed) notify(cloudErrorMessage(error), true); }
  finally { retryingPending = false; schedulePreparation(); }
}

async function persistDraft(action: 'save' | 'lock' | 'unlock'): Promise<void> {
  if (cloudSelection || !canEdit()) throw new Error('cloud_head_required');
  assertValid();
  const source = draft;
  const fingerprint = contentFingerprint(source);
  const generation = draftGeneration;
  const expected = workingCopy ? savedRoutines.find(value => value.id === source.id)?.revision ?? null : persistedRevision;
  const saved = await saveRoutine(structuredClone(source), expected, action);
  if (appDisposed || source !== draft || generation !== draftGeneration || contentFingerprint(draft) !== fingerprint) throw new Error('routine_conflict');
  if (loaded?.id === source.id && contentFingerprint(loaded) === fingerprint) { loaded.revision = saved.revision; loaded.locked = saved.locked; }
  acceptSavedRoutine(saved);
  try { await setActiveRoutine(saved.id); }
  catch { throw new Error(t('activeSelectionFailure')); }
}

async function prepareRoutine(current: () => boolean): Promise<void> {
  if (composition?.pending()) throw new Error(t('choosePhasePlaylist'));
  if (!selectedClass) {
    assertValid();
    if (!draft.tracks.length) throw new Error(t('noTracksError'));
  }
  const requestedClass = classKey();
  const sameRoutine = selectedClass ? loaded?.id === selectedClass.setup.routine.id && loaded.revision === selectedClass.setup.routine.revision
    && contentFingerprint(loaded) === preparedSourceFingerprint
    : loaded?.id === draft.id && loaded.revision === draft.revision && contentFingerprint(loaded) === contentFingerprint(draft)
      && preparedCloudBase === selectionKey();
  if (loaded && sameRoutine && preparedClassKey === requestedClass && state.status !== 'error') {
    return;
  }
  if (loaded && ['playing', 'filler', 'paused'].includes(state.status) && !confirm(t('confirmPrepare'))) return;
  const source = draft;
  let snapshot = structuredClone(draft);
  let classAudio: ClassAudio | undefined = routineClassAudio(snapshot);
  const fingerprint = contentFingerprint(draft);
  const selection = cloudSelection;
  const assertIdentity = hostedPilot ? captureCloudIdentity() : () => {};
  const controller = new AbortController();
  const active = { controller, current };
  const assert = () => {
    assertIdentity();
    if (!current() || appDisposed || controller.signal.aborted || draft !== source || cloudSelection !== selection
      || contentFingerprint(draft) !== fingerprint || requestedClass !== classKey()) {
      controller.abort();
      throw new CloudRequestError('cancelled');
    }
  };
  preparation = active;
  try {
    assert();
    if (selectedClass) {
      const resolved = await classLibrary.prepare(selectedClass, { signal: controller.signal });
      assert(); snapshot = resolved.routine; classAudio = resolved.audio;
    } else if (hostedPilot && getCloudRole() === 'player' && (!selection?.published || !snapshot.published)) throw new Error('cloud_head_required');
    const authority = selectedClass?.source === 'household' && selectedClass.setup.published
      ? { classId: selectedClass.setup.id, revision: selectedClass.setup.revision }
      : !selectedClass && selection?.published ? { routineId: selection.id, revision: selection.revision } : undefined;
    for (const recording of [...routineRecordings(snapshot), ...[classAudio?.before, classAudio?.after].flatMap(filler => filler?.recording ? [filler.recording] : [])]) {
      const cached = await getFillerRecordingBlob(recording);
      assert();
      if (!cached) {
        if (!hostedPilot) throw new Error('missing_audio');
        await cloudLibrary.ensureFiller(recording, { signal: controller.signal, progress: () => assert() },
          authority);
        assert();
      }
    }
    let readiness = await getReadiness(snapshot);
    if (!readiness.ready && !selectedClass && Object.keys(draftMedia).length && hostedPilot) {
      await cloudLibrary.downloadTracks(allRoutineTracks(snapshot).filter(track => !!draftMedia[track.id]), draftMedia, { signal: controller.signal }, authority);
      assert(); readiness = await getReadiness(snapshot);
    }
    if (!readiness.ready && !selectedClass && selection && hostedPilot) {
      const envelope = cloudEnvelope ?? await cloudLibrary.open(selection.id, selection.published, { signal: controller.signal }, selection.revision);
      assert();
      if (envelope.routine.revision !== snapshot.revision) throw new Error('cloud_head_required');
      if (cloudEnvelope) await cloudLibrary.download(envelope, { signal: controller.signal }, selection.published);
      assert(); readiness = await getReadiness(snapshot);
    }
    assert();
    if (!readiness.ready) {
      const missing = readiness.missing.map(id => allRoutineTracks(snapshot).find(track => track.id === id)?.title ?? id);
      throw new Error(t('missingMedia', { tracks: missing.join(', ') }));
    }
    for (const playlist of [classAudio?.walkIn, classAudio?.walkOut]) {
      if (!playlist || playlist.tracks.length === 0) continue;
      const ready = await getReadiness({ ...newRoutine(), tracks: playlist.tracks, filler: { ...newRoutine().filler, mode: 'none' } });
      assert();
      if (!ready.ready) throw new Error(t('missingMedia', { tracks: ready.missing.join(', ') }));
    }
    if (hostedPilot && snapshot.filler.mode !== 'none' && snapshot.filler.sound === 'lofi') {
      await getFillerBuffer(new OfflineAudioContext(1, 1, 22050), snapshot.filler);
    }
    assert();
    loaded = null;
    refreshDraft(false);
    if (classAudio) await player.load(snapshot, classAudio);
    else await player.load(snapshot);
    if (!current()) return;
    loaded = snapshot;
    preparedAudio = classAudio;
    preparedName = selectedClass?.setup.name ?? snapshot.name;
    preparedCloudBase = selectionKey(); preparedClassKey = requestedClass;
    preparedSourceFingerprint = contentFingerprint(snapshot);
    cueEditing = false; selectedCueId = ''; cueTimeInvalid = false;
    displayedTrack = '';
    refreshDraft(false);
    renderPlayback();
  } finally { if (preparation === active) preparation = null; }
}

function refreshDraft(structural: boolean, grouped = !structural): void {
  if (appDisposed) return;
  composition?.sync();
  protection.observe({ kind: 'routine', source: cloudSelection ? 'household' : 'local', value: draft,
    baseRevision: persistedRevision, media: draftMedia }, dirty, grouped, composition?.snapshot());
  renderReadiness();
  cancelCueDrag();
  validationErrors = validateRoutine(draft);
  if (hasInvalidCueTimes(draft)) validationErrors.push(t('invalidCueTime'));
  const signature = JSON.stringify(validationErrors);
  if (signature !== validationSignature) {
    validationSignature = signature;
    validationDisplay.show(validationErrors.length ? t('validationTitle') : '');
  }
  validation.replaceChildren();
  if (validationErrors.length) {
    const list = element('ul');
    for (const error of new Set(validationErrors)) list.append(element('li', '', validationMessage(error)));
    validation.append(validationTitle, list);
  }
  if (structural) {
    editorSession?.dispose();
    const editingDraft = draft;
    editorSession = renderEditor(editor, draft, (structure = false) => { dirty = true; draftGeneration++; refreshDraft(structure); }, {
      preview: audioPreview, detectBpm: detectTrackBpm, analyzeLoudness: analyzeTrackLoudness,
      fillerRecordings: fillerLibrary.choices, previewFiller: fillerLibrary.audition,
      beforeTracks: composition?.beforeTracks, afterTracks: composition?.afterTracks,
      trackActions: addTrackMenu.element,
      isBusy: () => editorBusy || transportOperation.pending || shell.classList.contains('class-mode'), canEdit,
      isCurrent: () => !appDisposed && draft === editingDraft && activeTab === 'edit',
    });
  }
  routineSelect.replaceChildren();
  if (cloudSelection || dirty || persistedRevision === null) {
    const unsaved = element('option', '', t('unsavedRoutine', { name: draft.name }));
    unsaved.value = '';
    unsaved.disabled = true;
    routineSelect.append(unsaved);
  }
  for (const routine of savedRoutines) {
    const option = element('option', '', t('savedRoutineOption', {
      name: routine.name, revision: routine.revision, lock: t(routine.locked ? 'locked' : 'unlocked'),
    }));
    option.value = routine.id;
    routineSelect.append(option);
  }
  routineSelect.value = cloudSelection || dirty || persistedRevision === null ? '' : draft.id;
  routineTitle.textContent = loaded?.name ?? draft.name;
  routineMeta.textContent = loaded ? loaded.name : trackCount(draft.tracks.length);
  editorRoutineTitle.textContent = routineOpen ? draft.name : t('routines');
  snapshotStatus.textContent = loaded
    ? t((selectedClass ? preparedClassKey === classKey() && contentFingerprint(loaded) === preparedSourceFingerprint
      : contentFingerprint(draft) === contentFingerprint(loaded)) ? 'prepared' : 'snapshotChanged')
    : t(draft.tracks.length ? 'preparePrompt' : 'notPrepared');
  draftStatus.textContent = t('draftState', { lock: t(draft.locked ? 'locked' : 'unlocked'),
    save: t(dirty || persistedRevision === null ? 'unsaved' : cloudSelection?.cached ? 'cloudCached' : cloudSelection ? 'cloudSavedStatus' : 'saved') });
  draftIdentity.replaceChildren();
  if (routineOpen) {
    for (const value of [t('lastSaved', { time: draft.savedAt === undefined ? t('unknownValue') : new Date(draft.savedAt).toLocaleString(locale) }),
      t('revisionValue', { revision: persistedRevision ?? t('unknownValue') }), t(draft.published ? 'exportPublished' : 'draft')]) {
      draftIdentity.append(element('span', 'identity-value', value));
    }
    draftIdentity.append(element('span', 'identity-id', `ID ${draft.id}`));
  }
  draftStatus.textContent = workingCopy?.pendingCloud ? t('savedPending') : dirty ? t('unsaved')
    : cloudSelection?.cached ? t('cloudCached') : cloudSelection ? t('cloudSavedStatus') : t('saved');
  empty.hidden = !!(loaded ?? draft).tracks.length;
  rehearsal.hidden = !(loaded ?? draft).tracks.length;
  if (!loaded) { displayedTrack = ''; renderPlayback(); }
  renderRoutineLibrary();
  syncAvailability();
}

function syncAvailability(): void {
  if (appDisposed) return;
  if (pendingSyncRequested && !editorBusy && !transportOperation.pending && !composition?.working()) {
    queueMicrotask(() => { if (pendingSyncRequested && !appDisposed) void retryPending(); });
  }
  audioPicker.sync();
  exportPanel.syncAvailability();
  const busy = editorBusy || transportOperation.pending;
  openDifferent.hidden = !routineOpen; openDifferent.disabled = busy;
  chooserClose.disabled = busy;
  editorFooter.hidden = !routineOpen; close.disabled = busy;
  deleteSelectedRoutine.hidden = !routineOpen || !canEdit() || draft.locked;
  deleteSelectedRoutine.disabled = busy || persistedRevision === null || (!!cloudSelection && (!cloudEnvelope || getCloudContext().access !== 'online'));
  fileInput.hidden = hostedPilot && getCloudRole() === 'player';
  fileInput.disabled = busy || draft.locked || !canEdit();
  for (const button of [...importButtons, ...demoButtons]) {
    button.disabled = busy || draft.locked || !canEdit();
    button.hidden = hostedPilot && getCloudRole() === 'player';
  }
  for (const button of demoButtons) {
    button.hidden ||= preferences.disableDemos === true;
    button.disabled ||= !!cloudSelection || preferences.disableDemos === true;
  }
  for (const fieldset of editor.querySelectorAll<HTMLFieldSetElement>('fieldset[data-editor-content]')) {
    fieldset.disabled = busy || draft.locked || !canEdit();
  }
  editorSession?.syncAvailability();
  save.disabled = busy || !canEdit() || draft.locked || validationErrors.length > 0 || cueTimeInvalid || !!composition?.pending() || !!composition?.working();
  save.title = t('saveChanges');
  saveLabel.textContent = save.title;
  save.setAttribute('aria-label', save.title);
  const author = !hostedPilot || ['owner', 'editor'].includes(getCloudRole() ?? '');
  for (const button of [save, lock, duplicate]) button.hidden = !author || !routineOpen;
  localSelection.hidden = true;
  newDraft.hidden = !author || routineOpen; newDraft.disabled = busy;
  editorDemo.hidden ||= routineOpen;
  addTrackMenu.element.hidden = !author || !routineOpen;
  addTrackMenu.trigger.setAttribute('aria-disabled', String(busy || draft.locked || !canEdit()));
  if (busy || draft.locked || !canEdit()) addTrackMenu.close();
  lock.querySelector('span')!.textContent = t(draft.locked ? 'unlock' : 'lock');
  routineLibrary.hidden = routineOpen && !chooserOpen && !chooserDialog.open;
  cloudPanel.hidden = !hostedPilot || (routineOpen && !chooserDialog.open);
  editor.hidden = !routineOpen; draftIdentity.hidden = !routineOpen;
  exportPanel.element.hidden = !routineOpen; protection.element.hidden = !routineOpen;
  if (composition) composition.controls.hidden = !routineOpen;
  routineOverflow.hidden = !author || !routineOpen;
  for (const button of [localPublish, localDelete]) {
    button.hidden = !author || !!cloudSelection || (button === localPublish && hostedPilot);
    button.disabled = busy || !canEdit() || draft.locked || persistedRevision === null;
  }
  localPublish.disabled ||= dirty || !draft.tracks.length || validationErrors.length > 0;
  replaceTarget.hidden = !hostedPilot || !!cloudSelection || shareMode !== 'replace';
  replaceAnother.hidden = !hostedPilot || !!cloudSelection;
  replaceAnother.disabled = busy || !canEdit() || draft.locked || getCloudContext().access !== 'online';
  shareOptions.hidden = !hostedPilot || !!cloudSelection;
  for (const [mode, button] of shareButtons) { button.disabled = busy; button.setAttribute('aria-pressed', String(mode === shareMode)); }
  if (!hostedPilot) for (const button of [cloudUpload, cloudReplace, cloudOpenDraft, cloudPublish, cloudDelete]) button.hidden = true;
  lock.disabled = busy || !canEdit() || validationErrors.length > 0;
  duplicate.disabled = busy || hasInvalidCueTimes(draft) || !!composition?.pending() || (hostedPilot && !['owner', 'editor'].includes(getCloudRole() ?? ''));
  duplicate.title = t(cloudSelection ? 'cloudDuplicate' : 'duplicate');
  duplicate.setAttribute('aria-label', duplicate.title);
  if (cloudSelection && getCloudContext().access !== 'online') {
    lock.disabled = true;
  }
  routineSelect.disabled = busy || savedRoutines.length === 0;
  prepare.disabled = busy || !!composition?.pending() || (!selectedClass && (!draft.tracks.length || validationErrors.length > 0));
  prepare.disabled ||= hostedPilot && getCloudRole() === 'player' && !(selectedClass?.setup.published ?? cloudSelection?.published);
  editorPrepare.disabled = prepare.disabled;
  prepare.hidden = editorPrepare.hidden = !routineOpen || !preparationFailed;
  classMusic.disabled = editorClassMusic.disabled = busy;
  for (const button of routineRows.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy
    || (button.dataset.cloudRoutineDelete === 'true' && (getCloudContext().access !== 'online' || navigator.onLine === false));
  for (const [source, button] of sourceButtons) button.disabled = busy || (hostedPilot && getCloudRole() === 'player' && source === 'local');
  for (const [version, button] of versionButtons) button.disabled = busy || (hostedPilot && getCloudRole() === 'player' && version === 'draft');
  classPanel?.sync();
  playlistEditor?.sync();
  mediaLibrary?.sync();
  fillerLibrary.sync();
  composition?.sync();
  if (composition && !routineOpen) composition.controls.hidden = true;
  protection.sync();
  recoveries.element.hidden = !author;
  recoveries.sync();
  readyPanel.hidden = shell.classList.contains('class-mode');
  prepare.setAttribute('aria-busy', String(transportOperation.pending));
  startClass.hidden = !loaded;
  startClass.disabled = !loaded || editorBusy || transportOperation.pending || !!composition?.pending() || contentFingerprint(draft) !== contentFingerprint(loaded);
  const lockLabel = t(draft.locked ? 'unlock' : 'lock');
  if (lock.title !== lockLabel) {
    setButtonIcon(lock, draft.locked ? UnlockKeyhole : LockKeyhole);
    lock.title = lockLabel;
    lock.setAttribute('aria-label', lockLabel);
  }
  for (const button of [play, stop]) button.disabled = !loaded && !transportOperation.pending;
  for (const button of [previous, next, hold, continueButton]) button.disabled = transportOperation.pending || !loaded;
  if (state) {
    hold.disabled ||= state.holding || !['playing', 'filler'].includes(state.status);
    continueButton.disabled ||= state.status !== 'filler';
    next.disabled ||= state.status === 'finished';
    const routinePhase = !state.phase || state.phase === 'routine';
    hold.hidden = !routinePhase;
    continueButton.hidden = !routinePhase || !inFiller();
    next.hidden = !!state.phase && !['routine', 'walk-in', 'walk-out'].includes(state.phase);
    previous.hidden = !!state.phase && ['before', 'after'].includes(state.phase);
    advance.hidden = !state.phase || !state.nextPhase || state.phase === 'routine' || !player.advance;
    advance.disabled = busy || !state.canAdvance || state.status === 'paused' || !['playing', 'filler'].includes(state.status);
    const advanceLabel = t('advancePhase', { phase: phaseLabel(state.nextPhase ?? 'routine') });
    advance.title = advanceLabel; advance.setAttribute('aria-label', advanceLabel);
    const label = advance.querySelector('span'); if (label) label.textContent = advanceLabel;
  }
  syncCloudControls();
  practiceOpenDraft.hidden = cloudOpenDraft.hidden;
  practiceOpenDraft.disabled = cloudOpenDraft.disabled;
  syncPracticeControls();
}

function inFiller(): boolean {
  return !!loaded && (state.status === 'filler' || (state.status === 'paused' &&
    (state.fillerRemaining !== null || (state.holding && state.duration === 0))));
}

function practiceTrack(): Track | null {
  if (appDisposed || !state || !loaded || shell.classList.contains('class-mode') || activeTab !== 'teach'
    || transportOperation.pending || inFiller() || (state.phase && state.phase !== 'routine') || !['idle', 'playing', 'paused'].includes(state.status)
    || !Number.isFinite(state.duration) || state.duration <= 0) return null;
  return loaded.tracks[state.trackIndex] ?? null;
}

function eligiblePracticeTrack(): Track | null {
  const track = practiceTrack();
  if (!canEdit() || !track || !loaded || editorBusy || loaded.locked || loaded.published || draft.locked || draft.id !== loaded.id
    || draft.tracks[state.trackIndex]?.id !== track.id || contentFingerprint(draft) !== contentFingerprint(loaded)) return null;
  if (cloudSelection && (!cloudEnvelope || cloudSelection.cached || cloudSelection.published || preparedCloudBase !== selectionKey()
    || cloudEnvelope.routine.revision !== draft.revision || cloudSelection.revision !== draft.revision)) return null;
  return draft.tracks[state.trackIndex]!;
}

function editablePracticeTrack(): Track | null { return cueEditing ? eligiblePracticeTrack() : null; }

function arrowDirection(key: string): number {
  return key === 'ArrowRight' || key === 'ArrowUp' ? 1 : key === 'ArrowLeft' || key === 'ArrowDown' ? -1 : 0;
}

function seekPractice(seconds: number): void {
  if (cueEditing || !practiceTrack() || !Number.isFinite(seconds)) return;
  stopEditorAudio();
  void transportOperation.run(() => player.seek(Math.max(0, Math.min(state.duration, seconds))));
}

function positionCueMarker(cueId: string, seconds: number, duration: number): void {
  const entry = cueMarkers.get(cueId);
  if (!entry || duration <= 0) return;
  const percent = 100 * seconds / duration;
  entry.marker.style.insetInlineStart = `${percent}%`;
  entry.button.style.insetInlineStart = `clamp(22px, ${percent}%, calc(100% - 22px))`;
  const label = t('adjustCue', { note: entry.cue.note, time: formatNumber(seconds) });
  entry.button.title = label;
  entry.button.setAttribute('aria-label', label);
}

function dragIsCurrent(drag: CueDrag): boolean {
  const track = editablePracticeTrack();
  return !!track && loaded === drag.routine && draft === drag.editingDraft && track.id === drag.trackId
    && state.trackIndex === drag.trackIndex && state.status === drag.status && state.duration === drag.duration
    && contentFingerprint(draft) === drag.fingerprint && cueMarkers.get(drag.cueId)?.button === drag.button;
}

function cancelCueDrag(): void {
  const drag = cueDrag;
  if (!drag) return;
  cueDrag = null;
  positionCueMarker(drag.cueId, drag.startSeconds, drag.duration);
  drag.button.classList.toggle('dragging', false);
  if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
}

function syncPracticeControls(): void {
  const track = practiceTrack();
  const editable = !!editablePracticeTrack();
  if (cueDrag && !dragIsCurrent(cueDrag)) cancelCueDrag();
  practiceSeek.hidden = shell.classList.contains('class-mode');
  practiceSeek.tabIndex = track && !cueEditing ? 0 : -1;
  practiceSeek.setAttribute('aria-disabled', String(!track || cueEditing));
  cueTime.setAttribute('aria-invalid', String(cueTimeInvalid));
  cueHandles.hidden = !cueEditing || shell.classList.contains('class-mode') || !loaded || inFiller() || !cueMarkers.size || (state.phase !== undefined && state.phase !== 'routine');
  practiceTools.hidden = shell.classList.contains('class-mode') || !track || !canEdit();
  editCueToggle.disabled = !eligiblePracticeTrack() && !cueEditing; editCueToggle.setAttribute('aria-pressed', String(cueEditing));
  cuePanel.hidden = !cueEditing;
  practiceSave.hidden = !cueEditing; practiceSave.disabled = save.disabled;
  practiceSave.title = save.title; practiceSave.setAttribute('aria-label', save.title);
  const saveText = practiceSave.querySelector('span'); if (saveText) saveText.textContent = save.title;
  const cues = track ? sortedCues(track) : [];
  const choiceKey = JSON.stringify(cues.map(item => [item.cue.id, item.seconds, item.cue.note]));
  if (cueChoice.dataset.choiceKey !== choiceKey) {
    cueChoice.dataset.choiceKey = choiceKey; cueChoice.replaceChildren();
    for (const { cue, seconds } of cues) {
      const option = element('option', '', `${formatCueTime(seconds)} / ${cue.note}`); option.value = cue.id; cueChoice.append(option);
    }
  }
  if (!cues.some(item => item.cue.id === selectedCueId)) selectedCueId = cues[0]?.cue.id ?? '';
  cueChoice.value = selectedCueId;
  const selected = cues.find(item => item.cue.id === selectedCueId);
  if (document.activeElement !== cueTime && !cueTimeInvalid) cueTime.value = selected ? formatCueTime(selected.seconds) : '';
  const counted = selected?.cue.anchor.kind === 'count';
  stepChoice.hidden = !!counted; beatStep.hidden = !counted;
  for (const control of [cueChoice, cueTime, stepChoice, earlierCue, laterCue]) control.disabled = !editable || !selected;
  for (const { button } of cueMarkers.values()) {
    button.disabled = !editable;
    button.tabIndex = editable ? 0 : -1;
  }
}

function commitCue(cueId: string, seconds: number): void {
  const track = editablePracticeTrack();
  if (!track || !loaded) return;
  const cue = track.cues.find(item => item.id === cueId);
  if (!cue) return;
  const updated = cueAtSeconds(track, cue, seconds, state.duration);
  if (!updated || JSON.stringify(updated.anchor) === JSON.stringify(cue.anchor)) return;
  const cues = sortedCues({ ...track, cues: track.cues.map(item => item.id === cueId ? updated : item) }, true).map(item => item.cue);
  try { player.updateCues(state.trackIndex, structuredClone(cues)); }
  catch (error) { notify(errorMessage(error), true); return; }
  track.cues = cues;
  loaded.tracks[state.trackIndex]!.cues = structuredClone(cues);
  dirty = true;
  draftGeneration++;
  const restoreFocus = document.activeElement === cueMarkers.get(cueId)?.button;
  displayedTrack = '';
  refreshDraft(true);
  renderPlayback();
  if (restoreFocus) cueMarkers.get(cueId)?.button.focus({ preventScroll: true });
  cueTime.value = formatCueTime(cueSeconds(updated, track));
}

function addCueMarker(cue: Cue, seconds: number, duration: number): void {
  const marker = element('span', 'cue-marker');
  const button = iconButton(t('adjustCue', { note: cue.note, time: formatNumber(seconds) }), MoveHorizontal, () => {});
  button.classList.add('cue-handle');
  button.dataset.cueId = cue.id;
  button.setAttribute('aria-description', t('cueKeyboard'));
  button.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
  const currentButton = () => cueMarkers.get(cue.id)?.button === button;
  button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (editablePracticeTrack()) { selectedCueId = cue.id; cueTimeInvalid = false; syncPracticeControls(); }
  });
  button.addEventListener('keydown', event => {
    const direction = arrowDirection(event.key);
    if (!direction || !currentButton() || !editablePracticeTrack()) return;
    event.preventDefault();
    event.stopPropagation();
    if (cueDrag) return;
    const track = editablePracticeTrack()!;
    const current = track.cues.find(item => item.id === cue.id);
    if (!current || (current.anchor.kind === 'count' && track.bpm === undefined)) return;
    const step = current.anchor.kind === 'count' ? 60 / track.bpm! : 1;
    commitCue(cue.id, cueSeconds(current, track) + direction * step * (event.shiftKey ? 10 : 1));
  });
  button.addEventListener('pointerdown', event => {
    const track = editablePracticeTrack();
    if (!track || !loaded || !currentButton() || cueDrag || event.button !== 0 || !event.isPrimary) return;
    const current = track.cues.find(item => item.id === cue.id);
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressSeekClick = true;
    selectedCueId = cue.id; cueTimeInvalid = false; syncPracticeControls();
    const startSeconds = cueSeconds(current, track);
    cueDrag = { pointerId: event.pointerId, button, cueId: cue.id, trackId: track.id, trackIndex: state.trackIndex,
      routine: loaded, editingDraft: draft, fingerprint: contentFingerprint(draft), status: state.status,
      duration: state.duration, startX: event.clientX, startSeconds, seconds: startSeconds, moved: false };
    button.focus({ preventScroll: true });
    try { button.setPointerCapture(event.pointerId); }
    catch { cancelCueDrag(); return; }
    button.classList.add('dragging');
  });
  const move = (event: PointerEvent) => {
    const drag = cueDrag;
    if (!drag || drag.pointerId !== event.pointerId || drag.button !== button) return;
    if (!dragIsCurrent(drag)) { cancelCueDrag(); return; }
    const width = progress.getBoundingClientRect().width;
    if (width <= 0) { cancelCueDrag(); return; }
    drag.moved ||= Math.abs(event.clientX - drag.startX) > 2;
    if (!drag.moved) return;
    const track = editablePracticeTrack()!;
    const current = track.cues.find(item => item.id === cue.id)!;
    const updated = cueAtSeconds(track, current, drag.startSeconds + (event.clientX - drag.startX) / width * drag.duration, drag.duration);
    if (!updated) { cancelCueDrag(); return; }
    drag.seconds = cueSeconds(updated, track);
    positionCueMarker(cue.id, drag.seconds, drag.duration);
  };
  button.addEventListener('pointermove', move);
  button.addEventListener('pointerup', event => {
    if (!cueDrag || cueDrag.pointerId !== event.pointerId || cueDrag.button !== button) return;
    event.preventDefault();
    event.stopPropagation();
    move(event);
    const drag = cueDrag;
    const commit = drag && drag.moved && dragIsCurrent(drag);
    cancelCueDrag();
    if (commit && drag) commitCue(drag.cueId, drag.seconds);
  });
  for (const name of ['pointercancel', 'lostpointercapture'] as const) {
    button.addEventListener(name, event => {
      if (cueDrag?.button === button && cueDrag.pointerId === event.pointerId) cancelCueDrag();
    });
  }
  cueMarkers.set(cue.id, { marker, button, cue, seconds });
  markers.append(marker);
  cueHandles.append(button);
  positionCueMarker(cue.id, seconds, duration);
}

function cancelDragOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && cueDrag) { event.preventDefault(); cancelCueDrag(); }
}

function cancelHiddenDrag(): void {
  if (document.hidden) cancelCueDrag();
}

function updateText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

// Shrinks the move note's font size (bounded) so it fits the CSS max-height instead of pushing
// the rest of the page down; resets first since the applicable class (long-note/multiline) alone
// may already fit. max-height is defined in em, so it shrinks together with the font -- re-read
// clientHeight every iteration instead of caching it, or the loop stops against a stale (larger) target.
function fitMoveNote(node: HTMLElement): void {
  node.style.fontSize = '';
  if (!node.clientHeight) return;
  for (let step = 0; step < 20 && node.scrollHeight > node.clientHeight + 1; step++) {
    const current = Number.parseFloat(getComputedStyle(node).fontSize);
    if (!Number.isFinite(current) || current <= 10) break;
    node.style.fontSize = `${current * 0.92}px`;
  }
}

function phaseLabel(phase: ClassPhase): string {
  return t(({ 'walk-in': 'phaseWalkIn', before: 'phaseBefore', routine: 'phaseRoutine', after: 'phaseAfter',
    'walk-out': 'phaseWalkOut', finished: 'finished' } as const)[phase]);
}

function renderPlayback(): void {
  if (appDisposed || !state) return;
  const routine = loaded ?? draft;
  const routinePhase = !loaded || !state.phase || state.phase === 'routine';
  const index = routinePhase ? loaded ? Math.max(0, state.trackIndex) : 0 : -1;
  const track = routine.tracks[index];
  const duration = loaded ? state.duration : track?.duration ?? 0;
  const key = `${routine.id}:${track?.id ?? ''}:${index}:${duration}:${state.phase ?? 'routine'}`;
  if (displayedTrack !== key) {
    cancelCueDrag();
    displayedTrack = key;
    trackPosition.textContent = track ? t('trackPosition', { current: index + 1, total: routine.tracks.length }) : '';
    trackTitle.textContent = track?.title ?? t('emptyTracks');
    bodyArea.textContent = track?.bodyArea ?? '';
    playlist.replaceChildren();
    routine.tracks.forEach((item, trackIndex) => {
      const row = element('li', trackIndex === index ? 'playlist-item current-track' : 'playlist-item');
      if (trackIndex === index) row.setAttribute('aria-current', 'true');
      const text = element('div', 'playlist-text');
      text.append(element('span', 'track-title', item.title), element('span', 'muted', item.bodyArea));
      row.append(element('span', 'track-number', String(trackIndex + 1).padStart(2, '0')), text,
        element('span', 'mono muted', formatTime(item.duration)));
      if (loaded) {
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', t('loadTrack', { name: item.title }));
        const load = () => {
          if (cueEditing) return;
          stopEditorAudio();
          void transportOperation.run(() => player.skipToTrack?.(trackIndex) ?? Promise.resolve());
        };
        row.addEventListener('click', load);
        row.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          load();
        });
      }
      playlist.append(row);
    });
    markers.replaceChildren();
    cueHandles.replaceChildren();
    cueMarkers.clear();
    cueTable.replaceChildren();
    if (track) {
      const table = element('table');
      const caption = element('caption', 'visually-hidden', t('cues'));
      const head = element('thead');
      const headRow = element('tr');
      for (const label of ['source', 'value', 'note'] as const) {
        const cell = element('th', '', t(label)); cell.scope = 'col'; headRow.append(cell);
      }
      head.append(headRow);
      const body = element('tbody');
      for (const { cue, seconds } of sortedCues(track)) {
        if (seconds < duration) addCueMarker(cue, seconds, duration);
        const row = element('tr');
        row.dataset.seconds = String(seconds);
        row.append(element('td', '', t(cue.anchor.kind)),
          element('td', 'mono', cue.anchor.kind === 'count' ? `${formatNumber(cue.anchor.count)} (${formatCueTime(seconds)})` : formatCueTime(seconds)),
          element('td', 'cue-note-cell', cue.note));
        body.append(row);
      }
      table.append(caption, head, body);
      cueTable.append(track.cues.length ? table : element('p', 'muted', t('emptyCues')));
    }
  }
  const filler = inFiller();
  const otherPhase = !!state.phase && state.phase !== 'routine';
  cueSheet.hidden = shell.classList.contains('class-mode') || otherPhase;
  markers.hidden = filler || otherPhase;
  updateText(trackTitle, filler ? t('filler') : track?.title ?? t('emptyTracks'));
  bodyArea.hidden = filler;
  const moveText = loaded && state.currentCue ? state.currentCue : filler ? t(state.holding ? 'holding' : 'filler') : t('noMove');
  if (currentNote.textContent !== moveText) {
    currentNote.textContent = moveText;
    currentNote.classList.toggle('multiline', moveText.includes('\n'));
    currentNote.classList.toggle('long-note', !moveText.includes('\n') && moveText.length > 90);
    fitMoveNote(currentNote);
  }
  updateText(nextNote, loaded && state.nextCue ? state.nextCue : t('noNextMove'));
  const nextTrackTitle = loaded ? state.nextCueTrackTitle : null;
  nextCueTrack.hidden = nextTrackTitle == null;
  updateText(nextCueTrack, nextTrackTitle == null ? '' : t('nextCueTrack', { track: nextTrackTitle }));
  updateText(nextCueTime, loaded ? nextMoveCountdown(state) : '');
  nextCueTime.hidden = !nextCueTime.textContent;
  updateText(playbackStatus, loaded ? t(state.status) : t('notPrepared'));
  const currentError = loaded && state.error ? errorMessage(state.error) : '';
  if (currentError !== lastPlaybackError) { lastPlaybackError = currentError; playbackErrors.show(currentError); }
  updateText(elapsed, formatTime(loaded ? state.elapsed : 0));
  updateText(remaining, formatTime(loaded ? Math.max(0, state.duration - state.elapsed) : track?.duration ?? 0));
  updateText(classElapsed, formatTime(loaded ? state.classElapsed : 0));
  const position = loaded ? Math.min(duration, Math.max(0, state.elapsed)) : 0;
  progressFill.style.width = `${duration > 0 ? 100 * position / duration : 0}%`;
  progress.setAttribute('aria-valuemax', String(duration));
  progress.setAttribute('aria-valuenow', String(Math.floor(position)));
  progress.setAttribute('aria-valuetext', t('progressTime', { elapsed: formatTime(position), duration: formatTime(duration) }));
  practiceSeek.setAttribute('aria-valuemax', String(duration));
  practiceSeek.setAttribute('aria-valuenow', String(position));
  practiceSeek.setAttribute('aria-valuetext', t('progressTime', { elapsed: formatTime(position), duration: formatTime(duration) }));
  updateText(fillerState, loaded && state.holding ? t(filler ? 'openHold' : 'holdQueued')
    : filler && state.fillerRemaining !== null ? t('fillerCountdown', { time: formatTime(state.fillerRemaining) }) : '');
  fillerState.hidden = !fillerState.textContent;
  if (otherPhase) {
    updateText(currentNote, phaseLabel(state.phase!));
    updateText(nextNote, state.nextPhase ? phaseLabel(state.nextPhase) : t('finished'));
    updateText(trackTitle, state.phaseTrackTitle ?? '');
    updateText(trackPosition, phaseLabel(state.phase!) + (state.phaseTrackIndex === undefined ? '' : ` / ${state.phaseTrackIndex + 1}`));
    bodyArea.hidden = true; nextCueTime.hidden = true; nextCueTrack.hidden = true; fillerState.hidden = true;
  }
  const running = transportOperation.pending || (loaded && (state.status === 'playing' || state.status === 'filler'));
  const playLabel: MessageKey = running ? 'pause' : !loaded ? 'play' : state.status === 'paused' ? 'resume' : state.status === 'finished' ? 'replay' : 'play';
  if (play.title !== t(playLabel)) {
    play.title = t(playLabel);
    play.setAttribute('aria-label', play.title);
    setButtonIcon(play, running ? Pause : Play);
  }
  duck.setAttribute('aria-pressed', String(state.ducked));
  duck.title = t(state.ducked ? 'restore' : 'duck');
  duck.setAttribute('aria-label', duck.title);
  if (muteBeeps.title !== t(state.beepsMuted ? 'unmuteBeeps' : 'muteBeeps')) {
    muteBeeps.title = t(state.beepsMuted ? 'unmuteBeeps' : 'muteBeeps');
    muteBeeps.setAttribute('aria-label', muteBeeps.title);
    setButtonIcon(muteBeeps, state.beepsMuted ? BellOff : Bell);
  }
  muteBeeps.setAttribute('aria-pressed', String(state.beepsMuted));
  hold.setAttribute('aria-pressed', String(state.holding));
  syncAvailability();
}

const unsubscribe = player.subscribe(nextState => {
  const priorError = state?.error;
  state = nextState;
  renderPlayback();
  if (state.error && state.error !== priorError) notify(errorMessage(state.error), true);
});
player.setVolume(0.8);
updatePreferences(false);
selectTab('teach');
refreshDraft(true);
if (hostedPilot) {
  renderCloudList();
  unsubscribeCloud = subscribeCloudSession(() => { syncAvailability(); fillerLibrary.sync(); void retryPending(); });
}
void (async () => {
  try {
    const assertIdentity = hostedPilot ? captureCloudIdentity() : () => {};
    const owner = hostedPilot ? getCloudContext().user : null;
    const remembered = owner ? recalledCloudSelection(localStorage, owner) : null;
    const cached = remembered ? await getCloudRoutine(remembered.id, remembered.revision, remembered.published) : null;
    assertIdentity();
    if (appDisposed) return;
    if (cached && remembered && cached.revision === remembered.revision && cached.published === remembered.published) {
      cloudSelection = remembered;
      routineOpen = true; chooserOpen = false;
      draft = structuredClone(cached);
      persistedRevision = cached.revision;
      dirty = false;
      refreshDraft(true);
    } else if (owner) rememberCloudSelection(localStorage, owner, null);
    if (!hostedPilot || getCloudRole() !== 'player') {
      const activeSelection = await getActiveRoutineSelection(); assertIdentity();
      const [saved, routines] = await Promise.all([activeSelection
        ? getRoutine(activeSelection.id, activeSelection.revision, activeSelection.published) : getRoutine(), listRoutines()]);
      assertIdentity();
      if (appDisposed) return;
      savedRoutines = routines;
      localPublications = await listRoutinePublications(); assertIdentity();
      const classes = await listClassSetups(); assertIdentity();
      legacyClasses = classes.map(setup => ({ setup, source: 'local' }));
      workingCopies = await listRoutineWorkingCopies(); assertIdentity();
      const activeCopy = workingCopies.find(copy => copy.envelope.routine.id === (cloudSelection?.id ?? saved?.id));
      if (activeCopy && !cloudSelection?.published && !activeSelection?.published) acceptWorkingCopy(activeCopy);
      else if (!cloudSelection && saved) acceptSavedRoutine(saved);
      else refreshDraft(true);
    }
    if (hostedPilot) {
      const classes = await listCachedClassSetups(); assertIdentity();
      legacyClasses.push(...classes.filter(setup => getCloudRole() !== 'player' || setup.published)
        .map(setup => ({ setup, source: 'household' as const })));
      cachedCloudRoutines = await listCloudRoutines(); assertIdentity(); renderCloudList();
    }
    if (hostedPilot && getCloudRole() === 'player') {
      empty.querySelector('h2')!.textContent = t('cloudPlayerEmpty');
      empty.querySelector('p')!.textContent = '';
    }
    const classReference = recalledClassSelection(localStorage, owner);
    if (classReference && !routineOpen && getCloudRole() === 'player') {
      const setup = classReference.source === 'household'
        ? await getCachedClassSetup(classReference.id, classReference.revision, classReference.published)
        : (await getPreparedClass(classReference.id, classReference.revision, 'local', classReference.published))?.setup;
      assertIdentity();
      if (appDisposed) return;
      if (setup && setup.id === classReference.id && setup.revision === classReference.revision && setup.published === classReference.published) {
        await openLegacyRoutine({ setup, source: classReference.source });
      } else notify(t('classCacheUnavailable'), true);
    }
  } catch (error) { notify(errorMessage(error), true); }
  finally {
    editorBusy = false;
    syncAvailability();
    if (hostedPilot && !appDisposed && getCloudContext().access === 'online') await runCloud(async transfer => {
      await loadHousehold(transfer);
      await syncPending(transfer);
      await playlistEditor?.syncPending(transfer);
    });
    // A tab selection while startup is busy skips its usual filler refresh.
    if (!hostedPilot && fillerLibraryCurrent()) void fillerLibrary.refresh();
    if (routineOpen) requestPreparation();
  }
})();
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty || playlistEditor?.hasUnsaved() || classPanel?.hasUnsaved() || composition?.hasUnsaved() || (loaded && ['playing', 'filler', 'paused'].includes(state.status))) event.preventDefault();
}
window.addEventListener('beforeunload', onBeforeUnload);
window.addEventListener('blur', cancelCueDrag);
document.addEventListener('keydown', cancelDragOnEscape);
document.addEventListener('visibilitychange', cancelHiddenDrag);
if (import.meta.env.PROD) {
  if ('serviceWorker' in navigator) {
    const register = () => { void watchOfflineShell(navigator.serviceWorker, status => {
      offlineStatusDisplay.show(t(({ pending: 'offlinePending', ready: 'offlineReady', failed: 'offlineFailed' } as const)[status]), status === 'failed');
    }, waiting => { updateStatus.hidden = !waiting; }); };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } else { offlineStatusDisplay.show(t('offlineUnavailable'), false); }
}
function disposeApp(): void {
  if (appDisposed) return;
  cancelCueDrag();
  appDisposed = true;
  noticeDisplay.dispose(); validationDisplay.dispose(); cloudFeedbackErrors.dispose(); playbackErrors.dispose(); offlineStatusDisplay.dispose();
  window.removeEventListener('online', onOnline);
  protection.dispose();
  recoveries.dispose();
  classPanel?.dispose();
  playlistEditor?.dispose();
  composition?.dispose();
  mediaLibrary?.dispose();
  fillerLibrary.dispose();
  audioPicker.dispose();
  exportPanel.dispose();
  moreMenu.dispose(); addTrackMenu.dispose();
  chooserErrors.dispose();
  if (chooserDialog.open) chooserDialog.close();
  document.documentElement.classList.remove('routine-chooser-open');
  cloudController?.abort();
  unsubscribeCloud();
  classMode.dispose();
  stopEditorAudio();
  transportOperation.cancel(() => player.stop());
  editorSession?.dispose();
  audioPreview.dispose();
  unsubscribe();
  player.dispose();
  window.removeEventListener(hostedInvalidationEvent, disposeApp);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('blur', cancelCueDrag);
  document.removeEventListener('keydown', cancelDragOnEscape);
  document.removeEventListener('visibilitychange', cancelHiddenDrag);
}
function onPageHide(event: PageTransitionEvent): void {
  cancelCueDrag();
  if (event.persisted) {
    classMode.exit(false);
    mediaLibrary?.leave();
    stopEditorAudio();
    transportOperation.cancel(() => player.pause());
  } else disposeApp();
}
window.addEventListener('pagehide', onPageHide);
window.addEventListener('online', onOnline);
if (hostedPilot) window.addEventListener(hostedInvalidationEvent, disposeApp);
if (hostedPilot) window.addEventListener(hostedInvalidationEvent, () => {
  libraryFavorites.clear(); libraryRecent = [];
  try { sessionStorage.removeItem(libraryPreferenceKey); } catch {}
}, { once: true });
if (import.meta.hot) import.meta.hot.dispose(disposeApp);
