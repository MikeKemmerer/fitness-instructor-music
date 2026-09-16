/// <reference types="vite/client" />
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import './styles.css';
import { ArrowRight, Bell, BellOff, Check, Copy, Hand, Headphones, ListMusic, LockKeyhole,
  Maximize2, Mic, Minimize2, Moon, MoveHorizontal, Pause, Pencil, Play, Plus, Save, Settings2, SkipBack, SkipForward, Square, Sun, UnlockKeyhole, X,
  CloudUpload, Download, RefreshCw, Send, Trash2, Star, Minus } from 'lucide';
import { cueSeconds, newRoutine, validateRoutine, type Cue, type Routine, type Track } from '../../shared/routine';
import type { PlayerState } from '../../shared/player-contract';
import { createPlayer } from './player';
import { createAudioPreview } from './audio-preview';
import { detectTrackBpm } from './bpm';
import { analyzeTrackLoudness } from './loudness';
import { cacheCloudRoutine, createDemoRoutine, deleteRoutine, getCachedClassSetup, getPreparedClass, getCloudRoutine, getFillerRecordingBlob, getReadiness, getRoutine, listRoutines, publishRoutine, saveRoutine, setActiveRoutine, storeTrack } from './offline';
import { getFillerBuffer } from './filler-audio';
import type { CloudRoutine, CloudRoutineSummary } from '../../shared/cloud-contract';
import { captureCloudIdentity, getCloudContext, getCloudRole, refreshCloudSession, subscribeCloudSession, CloudRequestError } from './cloud-client';
import { createCloudLibrary, routineRecordings, type CloudTransfer } from './cloud-library';
import { createClassLibrary, type ClassSelection } from './class-library';
import { createClassPanel } from './class-panel';
import { createDraftProtection, createRecoveryPanel } from './draft-protection';
import type { ClassAudio, ClassPhase } from '../../shared/class-plan';
import { formatCueTime, parseCueTime } from './cue-time';
import { canEditCloudDraft, cloudErrorMessage, cloudStatusMessage, confirmCloudNavigation,
  recalledCloudSelection, rememberCloudSelection, recalledClassSelection, rememberClassSelection, type CloudSelection } from './cloud-ui';
import { contentFingerprint, duplicateDraft, hasInvalidCueTimes, renderEditor, sortedCues, type EditorSession } from './editor';
import { createExportPanel } from './export-panel';
import { createFillerLibrary } from './filler-library';
import { errorMessage, formatNumber, formatTime, locale, t, trackCount, validationMessage, type MessageKey } from './i18n';
import { accents, applyTheme, palette, readPreferences, savePreferences } from './theme';
import { createClassMode, createTransportOperation, cueAtSeconds, element, field, iconButton, nextMoveCountdown, setButtonIcon, watchOfflineShell } from './ui';
import { hostedCloudSelectionKey, hostedInvalidationEvent } from './hosted-session';

const hostedPilot = import.meta.env.VITE_HOSTED_PILOT === 'true';
const cloudLibrary = createCloudLibrary();
let cloudEnvelope: CloudRoutine | null = null;
let cloudSelection: CloudSelection | null = null;
let cloudRoutines: CloudRoutineSummary[] = [];
let cloudController: AbortController | null = null;
let unsubscribeCloud = () => {};
const canEdit = () => !draft.published && (!hostedPilot || canEditCloudDraft(getCloudContext(), cloudSelection));
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
let shareMode: 'create' | 'replace' = 'create';
let classPanel: ReturnType<typeof createClassPanel> | undefined;
const classLibrary = createClassLibrary();
const selectionKey = () => JSON.stringify(cloudSelection ? [cloudSelection.id, cloudSelection.revision, cloudSelection.published, !!cloudSelection.cached, cloudEnvelope?.media] : null);
const classKey = () => JSON.stringify(selectedClass);
let editorBusy = true;
let appDisposed = false;
let state: PlayerState;
let displayedTrack = '';
let activeTab: 'teach' | 'edit' | 'settings' = 'teach';
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
const panels = { teach: element('section', 'teach-panel'), edit: element('section', 'edit-panel'), settings: element('section', 'settings-panel') };
const tabButtons = new Map<string, HTMLButtonElement>();
for (const [name, icon] of [['teach', Headphones], ['edit', Pencil], ['settings', Settings2]] as const) {
  const button = iconButton(t(name), icon, () => selectTab(name), true);
  button.id = `tab-${name}`;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', `panel-${name}`);
  button.addEventListener('keydown', event => {
    const names: Array<'teach' | 'edit' | 'settings'> = ['teach', 'edit', 'settings'];
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
noticeText.setAttribute('role', 'status');
noticeText.setAttribute('aria-live', 'polite');
noticeText.setAttribute('aria-atomic', 'true');
notice.append(noticeText, iconButton(t('dismiss'), X, () => { notice.hidden = true; }));
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
  noticeText.textContent = message;
}

function selectTab(tab: typeof activeTab): void {
  const previous = activeTab;
  if (activeTab !== tab) cancelCueDrag();
  if (tab !== 'teach') { cueEditing = false; cueTimeInvalid = false; }
  if (activeTab === 'edit' && tab !== 'edit') { fillerLibrary.leave(); stopEditorAudio(); }
  if (activeTab === 'settings' && tab !== 'settings') { fillerLibrary.leave(); audioPreview.stop(); }
  activeTab = tab;
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = name !== tab;
    const button = tabButtons.get(name)!;
    button.setAttribute('aria-selected', String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
  }
  editorSession?.syncAvailability();
  fillerLibrary.sync();
  if (previous !== tab && (tab === 'settings' || tab === 'edit')) void fillerLibrary.refresh();
  if (previous !== tab && tab === 'edit' && hostedPilot && !cloudRoutines.length && getCloudContext().access === 'online') void runCloud(refreshHousehold);
  syncPracticeControls();
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
  finally { editorBusy = false; syncAvailability(); }
}

const fileInput = element('input', 'visually-hidden');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.accept = 'audio/*,.opus,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm';
fileInput.tabIndex = -1;
fileInput.setAttribute('aria-label', t('import'));
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
    if (draft.tracks.length + files.length > 100) throw new Error(t('tooManyTracks'));
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

async function runCloud(action: (transfer: CloudTransfer) => Promise<void>): Promise<void> {
  if (!hostedPilot || editorBusy || appDisposed || transportOperation.pending) return;
  editorBusy = true;
  const controller = new AbortController();
  cloudController = controller;
  cloudFeedback.textContent = t('cloudWorking');
  cloudProgress.hidden = true;
  syncAvailability();
  try {
    await action({ signal: controller.signal, progress: (completed, total) => {
      if (appDisposed || controller.signal.aborted) return;
      cloudProgress.hidden = false;
      cloudProgress.value = total ? Math.min(100, completed / total * 100) : 0;
      cloudFeedback.textContent = t('cloudProgress', { percent: Math.floor(cloudProgress.value) });
    } });
    if (!appDisposed) cloudFeedback.textContent = '';
  } catch (error) {
    if (!appDisposed) { cloudFeedback.textContent = cloudErrorMessage(error); notify(cloudErrorMessage(error), true); }
  } finally {
    cloudController = null;
    cloudProgress.hidden = true;
    editorBusy = false;
    if (!appDisposed) syncAvailability();
  }
}

function renderCloudList(): void {
  const selected = cloudSelect.value;
  cloudSelect.replaceChildren();
  const placeholder = element('option', '', t('cloudChoose'));
  placeholder.value = '';
  cloudSelect.append(placeholder);
  for (const routine of cloudRoutines) {
    const option = element('option', '', t('savedRoutineOption', {
      name: routine.name, revision: routine.revision, lock: t(routine.locked ? 'locked' : 'unlocked'),
    }));
    option.value = routine.id;
    cloudSelect.append(option);
  }
  cloudSelect.value = cloudRoutines.some(routine => routine.id === selected) ? selected : '';
  syncCloudControls();
  renderRoutineLibrary();
}

async function refreshHousehold(transfer: CloudTransfer): Promise<void> {
  await refreshCloudSession();
  if (transfer.signal?.aborted || appDisposed) throw new CloudRequestError('cancelled');
  cloudRoutines = await cloudLibrary.list(cloudMode.value === 'published', transfer);
  if (transfer.signal?.aborted || appDisposed) throw new CloudRequestError('cancelled');
  renderCloudList();
}

const cloudRefresh = iconButton(t('cloudRefresh'), RefreshCw, () => { void runCloud(refreshHousehold); });
cloudMode.addEventListener('change', () => {
  cloudRoutines = [];
  renderCloudList();
  void runCloud(refreshHousehold);
});
const cloudOpen = iconButton(t('cloudOpen'), Download, () => { void runCloud(async transfer => {
  if (!cloudSelect.value || (dirty && !confirm(t('confirmSwitch', { name: draft.name })))) return;
  const id = cloudSelect.value;
  const published = cloudMode.value === 'published';
  stopEditorAudio();
  const envelope = await cloudLibrary.open(id, published, transfer);
  acceptCloudEnvelope(envelope, published);
}); });
const cloudUpload = iconButton(t('shareRoutine'), CloudUpload, () => { void runCloud(transfer => saveCloudDraft('save', transfer)); }, true);
const cloudOpenDraft = iconButton(t('cloudOpenDraft'), Pencil, () => { void runCloud(async transfer => {
  if (!cloudSelection || !['owner', 'editor'].includes(getCloudRole() ?? '')) return;
  if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
  const head = await cloudLibrary.readHead(cloudSelection.id, transfer);
  const downloaded = await cloudLibrary.download(head, transfer);
  stopEditorAudio();
  acceptCloudEnvelope(downloaded, false);
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
  acceptCloudEnvelope(result, false);
  await cacheCloudRoutine(result.routine);
  notify(t('cloudSaved'));
}); }, true);
const cloudPublish = iconButton(t('cloudPublish'), Send, () => { void runCloud(async transfer => {
  if (!cloudEnvelope || !cloudSelection || cloudSelection.published || dirty) throw new Error('cloud_save_first');
  if (!confirm(t('cloudConfirmPublish', { name: draft.name }))) return;
  const result = await cloudLibrary.command(cloudEnvelope, 'publish', false, transfer);
  acceptCloudEnvelope(result, true);
  await cacheCloudRoutine(result.routine);
  notify(t('cloudPublished'));
}); });
const cloudDelete = iconButton(t('cloudDelete'), Trash2, () => { void runCloud(async transfer => {
  if (!cloudEnvelope || !cloudSelection || cloudSelection.published) throw new Error('cloud_head_required');
  if (!confirm(t('cloudConfirmDelete', { name: draft.name }))) return;
  if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
  await cloudLibrary.command(cloudEnvelope, 'delete', false, transfer);
  cloudRoutines = cloudRoutines.filter(routine => routine.id !== cloudEnvelope!.routine.id);
  clearCloudSelection();
  draft = newRoutine();
  draft.name = t('newName');
  persistedRevision = null;
  dirty = false;
  refreshDraft(true);
  renderCloudList();
  notify(t('cloudDeleted'));
}); });
cloudDelete.classList.add('danger');
const cloudCancel = iconButton(t('cloudCancel'), X, () => {
  cloudController?.abort();
  cloudProgress.hidden = true;
  cloudFeedback.textContent = t('cloudCancelling');
  syncCloudControls();
});
const cloudSignIn = element('a', 'button', t('cloudSignIn'));
cloudSignIn.href = '/signin.html';
cloudSignIn.addEventListener('click', event => {
  event.preventDefault();
  confirmCloudNavigation(() => confirm(t('cloudConfirmSignin')), () => disposeApp(), () => window.location.assign(cloudSignIn.href));
});
const cloudControls = element('div', 'cloud-controls');
cloudControls.append(field(t('cloudRoutines'), cloudSelect), cloudMode, cloudRefresh, cloudOpen, cloudSignIn);
const cloudActions = element('div', 'action-row');
cloudActions.append(cloudUpload, cloudReplace, cloudOpenDraft, cloudPublish, cloudDelete, cloudCancel);
cloudPanel.append(element('h2', '', t('cloudRoutines')), cloudStatus, cloudControls, cloudActions, cloudProgress, cloudFeedback);

function syncCloudControls(): void {
  if (!hostedPilot) return;
  const context = getCloudContext();
  const mutable = ['owner', 'editor'].includes(context.user?.role ?? '');
  const busy = editorBusy || transportOperation.pending;
  cloudStatus.textContent = cloudStatusMessage(context);
  cloudRefresh.disabled = busy;
  cloudMode.disabled = busy || !mutable;
  cloudSelect.disabled = busy || !cloudRoutines.length;
  cloudOpen.disabled = busy || !cloudSelect.value || context.access !== 'online';
  cloudCancel.hidden = !cloudController;
  cloudCancel.disabled = cloudController?.signal.aborted ?? false;
  cloudUpload.hidden = !mutable || !!cloudSelection || shareMode !== 'create';
  cloudUpload.disabled = busy || !canEdit() || draft.locked || context.access !== 'online' || validationErrors.length > 0;
  for (const button of [cloudPublish, cloudDelete]) {
    button.hidden = !mutable;
    button.disabled = busy || !cloudEnvelope || !canEdit() || draft.locked || context.access !== 'online';
  }
  cloudPublish.disabled ||= dirty || !draft.tracks.length;
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
  rememberSelection();
}

function acceptCloudEnvelope(envelope: CloudRoutine, published: boolean): void {
  if (appDisposed) return;
  captureCloudIdentity()();
  cloudEnvelope = structuredClone(envelope);
  cloudSelection = { id: envelope.routine.id, revision: envelope.routine.revision, published };
  draft = structuredClone(envelope.routine);
  draftGeneration++;
  persistedRevision = envelope.routine.revision;
  dirty = false;
  rememberSelection();
  refreshDraft(true);
}

async function saveCloudDraft(action: 'save' | 'lock', transfer: CloudTransfer): Promise<void> {
  if (!canEdit()) throw new Error('cloud_head_required');
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
  const confirmation = action === 'lock' ? t('cloudConfirmLock', { name: snapshot.name }) : head
    ? t('cloudConfirmSave', { name: head.routine.name, id: head.routine.id, revision: head.routine.revision })
    : t('cloudConfirmUpload', { name: snapshot.name });
  if (!confirm(confirmation)) return;
  if (!cloudSelection) { snapshot.revision = 1; snapshot.published = false; }
  const result = await cloudLibrary.save(snapshot, head, action, transfer);
  assertSource();
  const matchesPrepared = loaded?.id === source.id && contentFingerprint(loaded) === fingerprint
    && contentFingerprint(result.routine) === fingerprint;
  acceptCloudEnvelope(result, false);
  if (matchesPrepared && loaded) { loaded.revision = result.routine.revision; loaded.locked = result.routine.locked; preparedCloudBase = selectionKey(); }
  await cacheCloudRoutine(result.routine);
  notify(t('cloudSaved'));
}

const routineHeading = element('div', 'routine-heading');
const headingText = element('div');
const routineTitle = element('h1');
const routineMeta = element('p', 'muted');
headingText.append(element('p', 'eyebrow', t('routine')), routineTitle, routineMeta);
const prepare = iconButton(t('preparePractice'), Check, () => { stopEditorAudio(); void transportOperation.run(prepareRoutine); }, true);
prepare.classList.add('primary');
const startClass = iconButton(t('startClass'), Maximize2, () => {
  if (!loaded || editorBusy || appDisposed || transportOperation.pending) return;
  stopEditorAudio();
  selectTab('teach');
  classMode.enter(false);
});
startClass.hidden = true;
startClass.setAttribute('aria-controls', 'panel-teach');
const preparationActions = element('div', 'action-row');
function openClassMusic(): void {
  if (!classPanel || editorBusy || transportOperation.pending) return;
  selectTab('edit');
  classPanel.element.open = true;
  classPanel.element.scrollIntoView({ block: 'start' });
  classPanel.element.querySelector('summary')?.focus({ preventScroll: true });
}
const classMusic = iconButton(t('classMusic'), ListMusic, openClassMusic, true);
const practiceOpenDraft = iconButton(t('cloudOpenDraft'), Pencil, () => cloudOpenDraft.click(), true);
preparationActions.append(prepare, classMusic, practiceOpenDraft, startClass);
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
  if (track && cue) { cueTimeInvalid = false; commitCue(cue.id, cueSeconds(cue, track) + direction * (cue.anchor.kind === 'count' ? 60 / track.bpm : cueStep)); }
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

const editorHeading = element('div', 'section-heading');
const editorTitle = element('div');
editorTitle.append(element('p', 'eyebrow', t('draft')), element('h1', '', t('edit')));
const draftStatus = element('span', 'draft-status');
editorHeading.append(editorTitle, draftStatus);
const routineSelect = element('select');
routineSelect.setAttribute('aria-label', t('savedRoutines'));
routineSelect.addEventListener('change', () => {
  const id = routineSelect.value;
  routineSelect.value = cloudSelection || dirty || persistedRevision === null ? '' : draft.id;
  if (!id || (id === draft.id && !dirty && !cloudSelection)) return;
  void runEditor(async () => {
    if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
    const saved = await getRoutine(id);
    if (!saved) throw new Error('routine_not_found');
    await setActiveRoutine(saved.id);
    clearCloudSelection();
    acceptSavedRoutine(saved);
  });
});
const editorActions = element('div', 'action-row editor-actions');
const newDraft = iconButton(t('newRoutine'), Plus, () => {
  if (editorBusy || transportOperation.pending || (hostedPilot && getCloudRole() === 'player')) return;
  if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
  stopEditorAudio(); clearCloudSelection(); draft = newRoutine(); draft.name = t('newName'); draft.filler.sound = 'lofi';
  persistedRevision = null; dirty = true; draftGeneration++; selectedCueId = ''; cueEditing = false; refreshDraft(true);
}, true);
const save = iconButton(t('save'), Save, () => {
  if (cloudSelection) { void runCloud(transfer => saveCloudDraft('save', transfer)); return; }
  void runEditor(async () => {
  await persistDraft('save');
  notify(t('savedToast'));
}); });
const saveLabel = element('span', '', t('save'));
save.classList.toggle('icon-button', false);
save.append(saveLabel);
const lock = iconButton(t('lock'), LockKeyhole, () => {
  if (cloudSelection) {
    void runCloud(async transfer => {
      if (!cloudEnvelope || !canEdit()) throw new Error('cloud_head_required');
      if (!draft.locked) { await saveCloudDraft('lock', transfer); return; }
      if (!confirm(t('cloudConfirmUnlock', { name: draft.name }))) return;
      const result = await cloudLibrary.command(cloudEnvelope, 'unlock', false, transfer);
      acceptCloudEnvelope(result, false);
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
  if (hasInvalidCueTimes(draft)) { notify(t('invalidCueTime')); return; }
  if (cloudSelection) {
    void runCloud(async transfer => {
      if (!cloudEnvelope) throw new Error('cloud_head_required');
      if (dirty && !confirm(t('confirmSwitch', { name: draft.name }))) return;
      const result = await cloudLibrary.command(cloudEnvelope, 'duplicate', cloudSelection!.published, transfer);
      const downloaded = await cloudLibrary.download(result, transfer);
      acceptCloudEnvelope(downloaded, false);
      notify(t('cloudDuplicated'));
    });
    return;
  }
  if (!canEdit()) return;
  if (editorBusy) return;
  stopEditorAudio();
  draft = duplicateDraft(draft);
  persistedRevision = null;
  dirty = true;
  refreshDraft(true);
  notify(t('duplicatedToast'));
});
save.classList.add('primary');
const localPublish = iconButton(t('localPublish'), Send, () => { void runEditor(async () => {
  if (cloudSelection || !canEdit() || draft.locked) throw new Error('routine_locked');
  if (dirty || persistedRevision === null) throw new Error(t('saveRoutineFirst'));
  if (!confirm(t('confirmLibraryAction', { action: t('libraryPublish', { name: draft.name }) }))) return;
  const source = draft;
  await publishRoutine(source.id, persistedRevision);
  const head = await getRoutine(source.id);
  if (!head || draft !== source) throw new Error('routine_conflict');
  acceptSavedRoutine(head); notify(t('localPublished'));
}); });
const localDelete = iconButton(t('localDelete'), Trash2, () => { void runEditor(async () => {
  if (cloudSelection || !canEdit() || draft.locked) throw new Error('routine_locked');
  if (persistedRevision === null) throw new Error(t('saveRoutineFirst'));
  if (!confirm(t('confirmLibraryAction', { action: t('libraryDelete', { name: draft.name }) }))) return;
  const source = draft;
  await deleteRoutine(source.id, persistedRevision);
  if (draft !== source) throw new Error('routine_conflict');
  stopEditorAudio(); savedRoutines = savedRoutines.filter(value => value.id !== source.id);
  draft = newRoutine(); draft.name = t('newName'); draft.filler.sound = 'lofi';
  persistedRevision = null; dirty = false; draftGeneration++; refreshDraft(true); notify(t('localDeleted'));
}); });
const routineOverflow = element('details', 'routine-overflow');
routineOverflow.append(element('summary', '', t('moreActions')));
const overflowActions = element('div', 'action-row');
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
overflowActions.append(shareOptions);
overflowActions.append(cloudUpload, cloudReplace, cloudOpenDraft, duplicate, cloudPublish, cloudDelete, localPublish, localDelete);
routineOverflow.append(overflowActions);
cloudActions.replaceChildren(cloudCancel);
const editorPrepare = iconButton(t('preparePractice'), Check, () => prepare.click(), true);
editorActions.append(newDraft, importButton(), demoButton(), save, lock, editorPrepare, routineOverflow);
const validation = element('div', 'validation');
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
const routineRows = element('div', 'routine-library-rows');
const libraryFilters = element('div', 'segmented');
libraryFilters.setAttribute('role', 'group'); libraryFilters.setAttribute('aria-label', t('routines'));
let librarySource: 'local' | 'household' = hostedPilot ? 'household' : 'local';
const sourceButtons = new Map<string, HTMLButtonElement>();
for (const source of ['local', 'household'] as const) {
  if (source === 'household' && !hostedPilot) continue;
  const button = iconButton(t(source === 'local' ? 'localFilter' : 'householdFilter'), source === 'local' ? ListMusic : CloudUpload, () => {
    librarySource = source; renderRoutineLibrary();
    if (source === 'household' && !cloudRoutines.length) void runCloud(refreshHousehold);
  }, true);
  sourceButtons.set(source, button); libraryFilters.append(button);
}
const versionFilters = element('div', 'segmented');
const versionButtons = new Map<string, HTMLButtonElement>();
for (const version of ['draft', 'published'] as const) {
  const button = iconButton(t(version === 'draft' ? 'cloudDrafts' : 'cloudPublications'), version === 'draft' ? Pencil : Check, () => {
    if (editorBusy || (getCloudRole() === 'player' && version === 'draft')) return;
    cloudMode.value = version; cloudRoutines = []; renderRoutineLibrary(); void runCloud(refreshHousehold);
  }, true);
  versionButtons.set(version, button); versionFilters.append(button);
}
let libraryFavorites = new Set<string>();
let libraryRecent: string[] = [];
const libraryPreferenceKey = 'fitness-routine-library';
const preferenceOwner = () => hostedPilot ? JSON.stringify(getCloudContext().user && [getCloudContext().user!.id, getCloudContext().user!.authVersion]) : 'local';
try {
  const stored = JSON.parse(sessionStorage.getItem(libraryPreferenceKey) ?? 'null');
  if (stored?.owner === preferenceOwner()) {
    libraryFavorites = new Set((stored.favorites ?? []).filter((id: unknown) => typeof id === 'string').slice(0, 512));
    libraryRecent = (stored.recent ?? []).filter((id: unknown) => typeof id === 'string').slice(0, 20);
  } else sessionStorage.removeItem(libraryPreferenceKey);
} catch {}
function rememberLibrary(id?: string): void {
  if (id) libraryRecent = [id, ...libraryRecent.filter(value => value !== id)].slice(0, 20);
  try { sessionStorage.setItem(libraryPreferenceKey, JSON.stringify({ owner: preferenceOwner(), favorites: [...libraryFavorites], recent: libraryRecent })); } catch {}
}
function renderRoutineLibrary(): void {
  const playerRole = hostedPilot && getCloudRole() === 'player';
  if (playerRole) librarySource = 'household';
  for (const [source, button] of sourceButtons) {
    button.hidden = playerRole && source === 'local'; button.disabled = editorBusy;
    button.setAttribute('aria-pressed', String(source === librarySource));
  }
  versionFilters.hidden = librarySource !== 'household';
  for (const [version, button] of versionButtons) {
    button.hidden = playerRole && version === 'draft'; button.disabled = editorBusy;
    button.setAttribute('aria-pressed', String(version === cloudMode.value));
  }
  cloudPanel.hidden = librarySource !== 'household';
  routineRows.replaceChildren();
  const values = [...(librarySource === 'local' ? savedRoutines : cloudRoutines)];
  const prefId = (id: string) => `${librarySource}:${id}`;
  values.sort((first, second) => Number(libraryFavorites.has(prefId(second.id))) - Number(libraryFavorites.has(prefId(first.id)))
    || (libraryRecent.indexOf(prefId(first.id)) < 0 ? 999 : libraryRecent.indexOf(prefId(first.id)))
      - (libraryRecent.indexOf(prefId(second.id)) < 0 ? 999 : libraryRecent.indexOf(prefId(second.id))));
  for (const value of values) {
    const row = element('div', 'routine-library-row');
    const name = element('span', 'library-row-name', value.name);
    const meta = element('span', 'muted', `${value.revision} / ${t(value.published ? 'exportPublished' : 'draft')} / ${t(value.locked ? 'locked' : 'unlocked')}`);
    const text = element('div'); text.append(name, meta);
    const favorite = iconButton(t('favorite', { name: value.name }), Star, () => {
      const key = prefId(value.id); if (libraryFavorites.has(key)) libraryFavorites.delete(key); else libraryFavorites.add(key);
      rememberLibrary(); renderRoutineLibrary();
    });
    favorite.setAttribute('aria-pressed', String(libraryFavorites.has(prefId(value.id))));
    const open = iconButton(t('openRoutine', { name: value.name }), Download, () => {
      rememberLibrary(prefId(value.id));
      if (librarySource === 'household') { cloudSelect.value = value.id; syncCloudControls(); cloudOpen.click(); }
      else { routineSelect.value = value.id; routineSelect.dispatchEvent(new Event('change')); }
    });
    open.disabled = editorBusy || transportOperation.pending;
    row.append(text, favorite, open); routineRows.append(row);
  }
}
const replaceTarget = field(t('cloudReplace'), cloudSelect);
overflowActions.insertBefore(replaceTarget, cloudReplace);
routineLibrary.append(libraryFilters, versionFilters, routineRows);
panels.edit.append(editorHeading, routineLibrary, cloudPanel, draftIdentity, editorActions, exportPanel.element, validation, editor);

const protection = createDraftProtection({
  editable: () => !appDisposed && !editorBusy && !transportOperation.pending && canEdit() && !draft.locked && !shell.classList.contains('class-mode'),
  apply: value => {
    if (!('filler' in value)) return;
    stopEditorAudio(); draft = value; dirty = true; draftGeneration++; refreshDraft(true);
  },
});
editorActions.append(protection.element);
const recoveries = createRecoveryPanel({
  allowed: () => !appDisposed && !editorBusy && !transportOperation.pending && !shell.classList.contains('class-mode')
    && (!hostedPilot || ['owner', 'editor'].includes(getCloudRole() ?? '')),
  message: notify,
  restore: async record => {
    if (record.kind !== 'routine') { await classPanel?.restoreRecovery(record); return; }
    await runEditor(async () => {
      if (!('filler' in record.value) || (dirty && !confirm(t('confirmSwitch', { name: draft.name })))) return;
      const assertIdentity = hostedPilot ? captureCloudIdentity() : () => {};
      assertIdentity(); clearCloudSelection();
      draft = { ...structuredClone(record.value), id: crypto.randomUUID(), name: t('recoveryCopy', { name: record.value.name }), revision: 1, locked: false, published: false };
      persistedRevision = null; dirty = true; draftGeneration++; refreshDraft(true); selectTab('edit');
    });
  },
});
panels.edit.insertBefore(recoveries.element, draftIdentity);

const readyPanel = element('section', 'settings-section readiness');
readyPanel.setAttribute('aria-label', t('readiness'));
const readyIdentity = element('p');
const readyState = element('p'); readyState.setAttribute('role', 'status');
const readyQueue = element('dl');
const readySound = iconButton(t('soundCheck'), Play, () => {
  if (!loaded || editorBusy || transportOperation.pending || shell.classList.contains('class-mode') || ['playing', 'filler'].includes(state.status)) return;
  void audioPreview.playFiller({ ...newRoutine().filler, mode: 'timed', seconds: 8, sound: 'soft', gain: 0.3 })
    .catch(error => notify(errorMessage(error), true));
}, true);
const stopSound = iconButton(t('stopSoundCheck'), Square, () => audioPreview.stop());
readyPanel.append(element('h2', '', t('readiness')), readyIdentity, readyState, readyQueue, readySound, stopSound);
for (const label of ['speakerCheck', 'powerCheck'] as const) {
  const checkbox = element('input'); checkbox.type = 'checkbox';
  readyPanel.append(field(t(label), checkbox));
}
panels.teach.insertBefore(readyPanel, rehearsal);

function renderReadiness() {
  readyIdentity.textContent = loaded ? `${preparedName} / ${loaded.name} / ${loaded.revision}` : draft.name;
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
const soundSettings = element('section', 'settings-section');
soundSettings.append(element('h2', '', t('sessionSound')),
  makeRange(t('beepVolume'), 0, 100, 35, value => player.setBeepVolume(value / 100)));
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
const fillerLibrary = createFillerLibrary({ hosted: hostedPilot, cloud: cloudLibrary, preview: audioPreview,
  analyzeLoudness: analyzeTrackLoudness,
  isCurrent: () => !appDisposed && (activeTab === 'settings' || activeTab === 'edit') && !shell.classList.contains('class-mode'),
  changed: () => editorSession?.refreshFillers(),
  message: message => { if (activeTab === 'edit') notify(message); },
});
classPanel = createClassPanel({ hosted: hostedPilot, draft: () => draft,
  currentSelection: () => selectedClass,
  routineMedia: () => cloudEnvelope?.routine.id === draft.id ? cloudEnvelope.media : {},
  busy: () => editorBusy || transportOperation.pending || shell.classList.contains('class-mode'), recordings: fillerLibrary.choices,
  message: notify, selected: selection => {
    selectedClass = selection;
    try { rememberClassSelection(localStorage, hostedPilot ? getCloudContext().user : null, selection); }
    catch { notify(t('activeSelectionFailure'), true); }
    notify(selection ? t('classSelected', { name: selection.setup.name, revision: selection.setup.revision }) : t('routineOnly'));
    refreshDraft(false);
  },
});
panels.edit.append(classPanel.element);
const editorClassMusic = iconButton(t('classMusic'), ListMusic, openClassMusic, true);
editorPrepare.after(editorClassMusic);
const storage = element('section', 'settings-section');
const offlineStatus = element('p', 'muted storage-notice', t(import.meta.env.PROD ? 'offlinePending' : 'offlineDevelopment'));
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
panels.settings.append(settingsHeading, appearance, soundSettings, demoSettings, fillerLibrary.element, storage);

function makeRange(label: string, minimum: number, maximum: number, value: number, change: (value: number) => void, unit: 'pixels' | 'percent' = 'percent'): HTMLLabelElement {
  const input = element('input');
  input.type = 'range';
  input.min = String(minimum);
  input.max = String(maximum);
  input.step = '1';
  input.value = String(value);
  const output = element('output', 'range-value', t(unit, { count: formatNumber(value) }));
  const labelElement = field(label, input);
  labelElement.classList.add('range-field');
  labelElement.append(output);
  input.setAttribute('aria-valuetext', output.value);
  input.addEventListener('input', () => {
    output.value = t(unit, { count: formatNumber(input.valueAsNumber) });
    input.setAttribute('aria-valuetext', output.value);
    change(input.valueAsNumber);
  });
  return labelElement;
}

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
  if (hasInvalidCueTimes(draft) || cueTimeInvalid) throw new Error(t('invalidCueTime'));
  const errors = validateRoutine(draft);
  if (errors.length) throw new Error(errors.map(validationMessage).join('\n'));
}

function acceptSavedRoutine(saved: Routine): void {
  if (appDisposed) return;
  stopEditorAudio();
  draft = structuredClone(saved);
  draftGeneration++;
  persistedRevision = saved.revision;
  dirty = false;
  const index = savedRoutines.findIndex(routine => routine.id === saved.id);
  if (index < 0) savedRoutines.push(structuredClone(saved));
  else savedRoutines[index] = structuredClone(saved);
  refreshDraft(true);
}

async function persistDraft(action: 'save' | 'lock' | 'unlock'): Promise<void> {
  if (cloudSelection || !canEdit()) throw new Error('cloud_head_required');
  assertValid();
  const source = draft;
  const fingerprint = contentFingerprint(source);
  const generation = draftGeneration;
  const saved = await saveRoutine(structuredClone(source), persistedRevision, action);
  if (appDisposed || source !== draft || generation !== draftGeneration || contentFingerprint(draft) !== fingerprint) throw new Error('routine_conflict');
  if (loaded?.id === source.id && contentFingerprint(loaded) === fingerprint) { loaded.revision = saved.revision; loaded.locked = saved.locked; }
  acceptSavedRoutine(saved);
  try { await setActiveRoutine(saved.id); }
  catch { throw new Error(t('activeSelectionFailure')); }
}

async function prepareRoutine(current: () => boolean): Promise<void> {
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
    selectTab('teach'); return;
  }
  if (loaded && ['playing', 'filler', 'paused'].includes(state.status) && !confirm(t('confirmPrepare'))) return;
  const source = draft;
  let snapshot = structuredClone(draft);
  let classAudio: ClassAudio | undefined;
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
    if (!readiness.ready && !selectedClass && selection && hostedPilot) {
      const envelope = cloudEnvelope ?? await cloudLibrary.open(selection.id, selection.published, { signal: controller.signal }, selection.revision);
      assert();
      if (envelope.routine.revision !== snapshot.revision) throw new Error('cloud_head_required');
      if (cloudEnvelope) await cloudLibrary.download(envelope, { signal: controller.signal }, selection.published);
      assert(); readiness = await getReadiness(snapshot);
    }
    assert();
    if (!readiness.ready) {
      const missing = readiness.missing.map(id => snapshot.tracks.find(track => track.id === id)?.title ?? id);
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
    for (const checkbox of readyPanel.querySelectorAll<HTMLInputElement>('input')) checkbox.checked = false;
    preparedCloudBase = selectionKey(); preparedClassKey = requestedClass;
    preparedSourceFingerprint = contentFingerprint(snapshot);
    cueEditing = false; selectedCueId = ''; cueTimeInvalid = false;
    displayedTrack = '';
    refreshDraft(false);
    renderPlayback();
    selectTab('teach');
    notify(t('preparedToast'));
  } finally { if (preparation === active) preparation = null; }
}

function refreshDraft(structural: boolean): void {
  if (appDisposed) return;
  protection.observe({ kind: 'routine', source: cloudSelection ? 'household' : 'local', value: draft,
    baseRevision: persistedRevision, media: cloudEnvelope?.media ?? {} }, dirty, !structural);
  renderReadiness();
  cancelCueDrag();
  validationErrors = validateRoutine(draft);
  if (hasInvalidCueTimes(draft)) validationErrors.push(t('invalidCueTime'));
  validation.hidden = validationErrors.length === 0;
  validation.replaceChildren();
  if (validationErrors.length) {
    const list = element('ul');
    for (const error of new Set(validationErrors)) list.append(element('li', '', validationMessage(error)));
    validation.append(element('h2', '', t('validationTitle')), list);
  }
  if (structural) {
    editorSession?.dispose();
    const editingDraft = draft;
    editorSession = renderEditor(editor, draft, (structure = false) => { dirty = true; draftGeneration++; refreshDraft(structure); }, {
      preview: audioPreview, detectBpm: detectTrackBpm, analyzeLoudness: analyzeTrackLoudness,
      fillerRecordings: fillerLibrary.choices, previewFiller: fillerLibrary.audition,
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
  routineMeta.textContent = loaded ? t('readySummary', { name: loaded.name, revision: loaded.revision }) : trackCount(draft.tracks.length);
  snapshotStatus.textContent = loaded
    ? t((selectedClass ? preparedClassKey === classKey() && contentFingerprint(loaded) === preparedSourceFingerprint
      : contentFingerprint(draft) === contentFingerprint(loaded)) ? 'prepared' : 'snapshotChanged')
    : t(draft.tracks.length ? 'preparePrompt' : 'notPrepared');
  draftStatus.textContent = t('draftState', { lock: t(draft.locked ? 'locked' : 'unlocked'),
    save: t(dirty || persistedRevision === null ? 'unsaved' : cloudSelection?.cached ? 'cloudCached' : cloudSelection ? 'cloudSavedStatus' : 'saved') });
  draftIdentity.textContent = t('activeDraftIdentity', { name: draft.name, id: draft.id, revision: draft.revision,
    destination: t(cloudSelection ? 'householdDestination' : 'localDestination'),
    status: t(draft.published || cloudSelection?.cached ? 'readOnlySnapshot' : dirty || persistedRevision === null ? 'unsaved' : 'savedSnapshot') });
  empty.hidden = !!(loaded ?? draft).tracks.length;
  rehearsal.hidden = !(loaded ?? draft).tracks.length;
  if (!loaded) { displayedTrack = ''; renderPlayback(); }
  renderRoutineLibrary();
  syncAvailability();
}

function syncAvailability(): void {
  if (appDisposed) return;
  exportPanel.syncAvailability();
  const busy = editorBusy || transportOperation.pending;
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
  save.disabled = busy || !canEdit() || draft.locked || validationErrors.length > 0 || cueTimeInvalid;
  save.title = t(cloudSelection ? 'cloudSave' : 'save');
  saveLabel.textContent = save.title;
  save.setAttribute('aria-label', save.title);
  const author = !hostedPilot || ['owner', 'editor'].includes(getCloudRole() ?? '');
  for (const button of [save, lock, duplicate]) button.hidden = !author;
  localSelection.hidden = true;
  newDraft.hidden = !author; newDraft.disabled = busy;
  routineOverflow.hidden = !author;
  for (const button of [localPublish, localDelete]) {
    button.hidden = !author || !!cloudSelection;
    button.disabled = busy || !canEdit() || draft.locked || persistedRevision === null;
  }
  localPublish.disabled ||= dirty || !draft.tracks.length || validationErrors.length > 0;
  replaceTarget.hidden = !hostedPilot || !!cloudSelection || shareMode !== 'replace';
  shareOptions.hidden = !hostedPilot || !!cloudSelection;
  for (const [mode, button] of shareButtons) { button.disabled = busy; button.setAttribute('aria-pressed', String(mode === shareMode)); }
  if (!hostedPilot) for (const button of [cloudUpload, cloudReplace, cloudOpenDraft, cloudPublish, cloudDelete]) button.hidden = true;
  lock.disabled = busy || !canEdit() || validationErrors.length > 0;
  duplicate.disabled = busy || hasInvalidCueTimes(draft) || (hostedPilot && !['owner', 'editor'].includes(getCloudRole() ?? '')) || !!cloudSelection?.cached;
  duplicate.title = t(cloudSelection ? 'cloudDuplicate' : 'duplicate');
  duplicate.setAttribute('aria-label', duplicate.title);
  if (cloudSelection && getCloudContext().access !== 'online') {
    save.disabled = true;
    lock.disabled = true;
    duplicate.disabled = true;
  }
  routineSelect.disabled = busy || savedRoutines.length === 0;
  prepare.disabled = busy || (!selectedClass && (!draft.tracks.length || validationErrors.length > 0));
  prepare.disabled ||= hostedPilot && getCloudRole() === 'player' && !(selectedClass?.setup.published ?? cloudSelection?.published);
  editorPrepare.disabled = prepare.disabled;
  classMusic.disabled = editorClassMusic.disabled = busy;
  for (const button of routineRows.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy;
  classPanel?.sync();
  protection.sync();
  recoveries.element.hidden = !author;
  readyPanel.hidden = shell.classList.contains('class-mode');
  readySound.disabled = !loaded || busy || ['playing', 'filler'].includes(state?.status);
  prepare.setAttribute('aria-busy', String(transportOperation.pending));
  startClass.hidden = !loaded;
  startClass.disabled = !loaded || editorBusy || transportOperation.pending;
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
    if (!current) return;
    const step = current.anchor.kind === 'count' ? 60 / track.bpm : 1;
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
  updateText(currentNote, loaded && state.currentCue ? state.currentCue : filler ? t(state.holding ? 'holding' : 'filler') : t('noMove'));
  currentNote.classList.toggle('long-note', currentNote.textContent!.length > 90);
  updateText(nextNote, loaded && state.nextCue ? state.nextCue : t('noNextMove'));
  const nextTrackTitle = loaded ? state.nextCueTrackTitle : null;
  nextCueTrack.hidden = nextTrackTitle == null;
  updateText(nextCueTrack, nextTrackTitle == null ? '' : t('nextCueTrack', { track: nextTrackTitle }));
  updateText(nextCueTime, loaded ? nextMoveCountdown(state) : '');
  nextCueTime.hidden = !nextCueTime.textContent;
  updateText(playbackStatus, loaded ? t(state.status) : t('notPrepared'));
  updateText(playbackError, loaded && state.error ? errorMessage(state.error) : '');
  playbackError.hidden = !playbackError.textContent;
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
player.setBeepVolume(0.35);
updatePreferences(false);
selectTab('teach');
refreshDraft(true);
if (hostedPilot) {
  renderCloudList();
  unsubscribeCloud = subscribeCloudSession(() => { syncAvailability(); fillerLibrary.sync(); });
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
      draft = structuredClone(cached);
      persistedRevision = cached.revision;
      dirty = false;
      refreshDraft(true);
    } else if (owner) rememberCloudSelection(localStorage, owner, null);
    if (!hostedPilot || getCloudRole() !== 'player') {
      const [saved, routines] = await Promise.all([getRoutine(), listRoutines()]);
      assertIdentity();
      if (appDisposed) return;
      savedRoutines = routines;
      if (!cloudSelection && saved) acceptSavedRoutine(saved);
      else refreshDraft(true);
    }
    if (hostedPilot && getCloudRole() === 'player') {
      empty.querySelector('h2')!.textContent = t('cloudPlayerEmpty');
      empty.querySelector('p')!.textContent = '';
    }
    const classReference = recalledClassSelection(localStorage, owner);
    if (classReference) {
      const setup = classReference.source === 'household'
        ? await getCachedClassSetup(classReference.id, classReference.revision, classReference.published)
        : (await getPreparedClass(classReference.id, classReference.revision, 'local', classReference.published))?.setup;
      assertIdentity();
      if (appDisposed) return;
      if (setup && setup.id === classReference.id && setup.revision === classReference.revision && setup.published === classReference.published) {
        selectedClass = { setup, source: classReference.source };
        notify(t('classSelected', { name: setup.name, revision: setup.revision })); refreshDraft(false);
      } else notify(t('classCacheUnavailable'), true);
    }
  } catch (error) { notify(errorMessage(error), true); }
  finally { editorBusy = false; syncAvailability(); }
})();
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty || classPanel?.hasUnsaved() || (loaded && ['playing', 'filler', 'paused'].includes(state.status))) event.preventDefault();
}
window.addEventListener('beforeunload', onBeforeUnload);
window.addEventListener('blur', cancelCueDrag);
document.addEventListener('keydown', cancelDragOnEscape);
document.addEventListener('visibilitychange', cancelHiddenDrag);
if (import.meta.env.PROD) {
  if ('serviceWorker' in navigator) {
    const register = () => { void watchOfflineShell(navigator.serviceWorker, status => {
      offlineStatus.textContent = t(({ pending: 'offlinePending', ready: 'offlineReady', failed: 'offlineFailed' } as const)[status]);
    }, waiting => { updateStatus.hidden = !waiting; }); };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } else { offlineStatus.textContent = t('offlineUnavailable'); }
}
function disposeApp(): void {
  if (appDisposed) return;
  cancelCueDrag();
  appDisposed = true;
  protection.dispose();
  recoveries.dispose();
  classPanel?.dispose();
  fillerLibrary.dispose();
  exportPanel.dispose();
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
    stopEditorAudio();
    transportOperation.cancel(() => player.pause());
  } else disposeApp();
}
window.addEventListener('pagehide', onPageHide);
if (hostedPilot) window.addEventListener(hostedInvalidationEvent, disposeApp);
if (hostedPilot) window.addEventListener(hostedInvalidationEvent, () => {
  libraryFavorites.clear(); libraryRecent = [];
  try { sessionStorage.removeItem(libraryPreferenceKey); } catch {}
}, { once: true });
if (import.meta.hot) import.meta.hot.dispose(disposeApp);
