import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClassMode, createTransportOperation, cueAtSeconds, gainSlider, nextMoveCountdown, transientText, watchOfflineShell } from '../frontend/src/ui';
import { fillerControls, fillerSoundLabel } from '../frontend/src/filler-controls';
import { createRoutineSave, sameSavedContent } from '../frontend/src/routine-save';
import { createAudioLibraryPicker } from '../frontend/src/audio-library-picker';
import { checkLocalAudioUsage, createMediaLibrary, type LocalAudioUsage } from '../frontend/src/media-library';
import type { ManagedAudioItem, ManagedAudioPage, LibraryMetadata } from '../shared/cloud-contract';
import * as cloudState from '../frontend/src/cloud-client';
import { CloudRequestError } from '../frontend/src/cloud-client';
import { cloudErrorMessage } from '../frontend/src/cloud-ui';
import type { CloudRoutine } from '../shared/cloud-contract';
import type { DraftRecovery, RoutineWorkingCopy } from '../frontend/src/offline';
import type { createCloudLibrary } from '../frontend/src/cloud-library';
import { cueSeconds, newRoutine, type Cue, type FillerRecording, type Routine, type Track } from '../shared/routine';
import type { PlayerState } from '../shared/player-contract';
import type { AudioPreview, PreviewState } from '../shared/preview-contract';
import { t } from '../frontend/src/i18n';
import { contentFingerprint, hasInvalidCueTimes, sortedCues } from '../frontend/src/editor';
import { createExportPanel } from '../frontend/src/export-panel';
import { defaultExportColumns, defaultPdfColumns, exportColumns, type ExportSnapshot } from '../frontend/src/exports';
import { startApplication } from '../frontend/src/bootstrap';
import { formatCueTime, parseCueTime } from '../frontend/src/cue-time';
import { createClassPanel } from '../frontend/src/class-panel';
import { createPlaylistEditor } from '../frontend/src/playlist-editor';
import { createClassComposition } from '../frontend/src/class-composition';
import { createRecoveryPanel } from '../frontend/src/draft-protection';
import type { ClassSetup, CloudMusicPlaylist, MusicPlaylist, PreparedClass, RevisionReference } from '../shared/class-plan';
import type { PlaylistWorkingCopy, ActivePlaylistSelection } from '../frontend/src/offline';
import { readFileSync } from 'node:fs';

describe('unified review source guards', () => {
  const source = (file: string) => readFileSync(new URL(`../frontend/src/${file}`, import.meta.url), 'utf8');
  it('limits visible numeric revisions to header metadata and chosen export content', () => {
    const catalog = source('locales/en-US.ts').split('\n').filter(line => line.includes('{revision}'));
    expect(catalog).toHaveLength(3);
    expect(catalog[0]).toContain('revisionValue:'); expect(catalog[1]).toContain('routineMetadata:'); expect(catalog[2]).toContain('exportPdfRevision:');
    expect(source('class-panel.ts')).not.toContain('${reference.revision}');
    expect(t('duplicate')).toBe('Duplicate to new routine'); expect(t('existingAudio')).toBe('From audio library');
    expect(t('cloudSave')).toBe('Save'); expect(t('save')).toBe('Save');
    expect(t('addTrack')).toBe('Add track'); expect(t('cloudPublish')).toBe('Publish for playback');
  });
  it('places name before chronological phases and uses symmetric spacing and stacked gain output', () => {
    const editor = source('editor.ts');
    expect(editor.indexOf('form.append(nameFields)')).toBeLessThan(editor.indexOf('form.append(context.beforeTracks)'));
    expect(editor.indexOf('form.append(context.beforeTracks)')).toBeLessThan(editor.indexOf('form.append(tracks)'));
    expect(editor.indexOf('form.append(tracks)')).toBeLessThan(editor.indexOf('form.append(context.afterTracks)'));
    const css = source('styles.css');
    expect(css).toMatch(/\.before-routine-phases, \.after-routine-phases \{[^}]*margin-block: 24px/);
    expect(css).toMatch(/\.routine-name-field \{[^}]*margin-block: 16px/);
    expect(css).toMatch(/\.gain-control \.field \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    for (const engine of ['webkit-slider-runnable-track', 'moz-range-track']) {
      expect(css).toContain(`::-${engine}`);
    }
    expect(css).toContain('var(--accent) 80%, #c93240 100%');
    expect(css).toMatch(/html \{[^}]*scrollbar-gutter: stable;/);
    expect(css).toContain('.routine-chooser-open { overflow: hidden; }');
    expect(css).toContain('.editor-heading-actions .export-section { position: static; }');
    expect(css).toMatch(/\.playlist-workspace \{[^}]*max-inline-size: 100%;[^}]*overflow-x: clip;/);
  });
  it('routes owned inline errors through deadline-aware helpers without direct error writes', () => {
    expect(source('filler-library.ts')).toContain("errors.show(t('audioByteLimit'))");
    expect(source('filler-library.ts')).not.toMatch(/feedback\.textContent\s*=/);
    expect(source('export-panel.ts')).not.toMatch(/feedback\.textContent\s*=/);
    expect(source('editor.ts')).not.toMatch(/timePreview\.textContent\s*=/);
    expect(source('draft-protection.ts')).toContain("feedback.show(t('recoveryFailed'))");
  });
  it('records staged attempts before committing and retains the final local CAS check', () => {
    const saver = source('routine-save.ts');
    expect(saver).toContain('sameSavedContent(head, attempt.envelope)');
    expect(saver.indexOf('saveRoutineWorkingCopy(staged')).toBeLessThan(saver.indexOf('recordRoutineSyncAttempt('));
    expect(saver.indexOf('recordRoutineSyncAttempt(')).toBeLessThan(saver.lastIndexOf('current.localVersion !== queued.localVersion'));
    expect(saver.lastIndexOf('current.localVersion !== queued.localVersion')).toBeLessThan(saver.indexOf('library.commit(staged'));
    expect(saver).toContain('if (queued.cloudBaseRevision === null) staged.routine.revision = 1');
  });
  it('reconciles authoritative lifecycle state and awaits the local row active pointer', () => {
    const main = source('main.ts');
    expect(main).toContain('await reconcileRoutineWorkingCopy(envelope)');
    expect(main).toMatch(/await setActiveRoutine\(value.id\); identity\(\);[\s\S]*clearCloudSelection\(\); acceptWorkingCopy\(current\)/);
    expect(main).toContain('await listCloudRoutines()'); expect(main).toContain('await listRoutinePublications()');
    expect(main).not.toContain('localDelete.disabled ||= !!workingCopy');
    expect(main.indexOf("await cloudLibrary.command(cloudEnvelope, 'delete'")).toBeLessThan(main.indexOf('await deleteRoutineWorkingCopy(id, copy.localVersion)'));
  });
  it('uses exact class authority and cache resolution without converting player selections', () => {
    const library = source('class-library.ts'); const main = source('main.ts');
    expect(library).toContain('{ classId: setup.id, revision: setup.revision }');
    expect(library).toContain('const resolved = await prepare(selection, transfer)');
    expect(library).not.toContain('await media.open(setup.routine.id');
    expect(main).toMatch(/selectedClass = structuredClone\(selection\);[\s\S]*rememberClassSelection\(localStorage, getCloudContext\(\).user, selection\)/);
    expect(main).toContain('if (playlist?.tracks.length) sequence[phase]');
  });
});

describe('cue time text', () => {
  it.each(['', ' ', '1:60', '1:60.1', '-1', 'NaN', 'Infinity', '1:2', '1:02:03', '1e2', '.5'])('rejects %j without coercion', value => {
    expect(parseCueTime(value)).toBeNull();
  });
  it.each([0, 59.999, 60, 60.125, 120, 3.14159, 1199.999])('round trips %s seconds', seconds => {
    expect(parseCueTime(formatCueTime(seconds))).toBe(seconds);
    expect(parseCueTime(String(seconds))).toBe(seconds);
  });
  it('formats minute boundaries without rounding and accepts padded seconds', () => {
    expect(formatCueTime(60)).toBe('1:00.0');
    expect(formatCueTime(59.999)).toBe('0:59.999');
    expect(parseCueTime(' 12:03.456 ')).toBe(723.456);
    expect(formatCueTime(Number.NaN)).toBe('');
    expect(formatCueTime(0.000000123456)).toBe('0:00.000000123456');
    expect(parseCueTime(formatCueTime(Number.MIN_VALUE))).toBe(Number.MIN_VALUE);
  });
});

const mocks = vi.hoisted(() => ({
  getRoutineWorkingCopy: vi.fn(), listRoutineWorkingCopies: vi.fn(async (): Promise<RoutineWorkingCopy[]> => []), saveRoutineWorkingCopy: vi.fn(), acknowledgeRoutineWorkingCopy: vi.fn(), clearActiveRoutine: vi.fn(),
  recordRoutineSyncAttempt: vi.fn(), reconcileRoutineWorkingCopy: vi.fn<(envelope: CloudRoutine) => Promise<RoutineWorkingCopy | null>>(async () => null), deleteRoutineWorkingCopy: vi.fn(),
  listCloudRoutines: vi.fn(async (): Promise<Routine[]> => []), listRoutinePublications: vi.fn(async (): Promise<Routine[]> => []),
  getCloudRoutine: vi.fn(), cacheCloudRoutine: vi.fn(),
  saveDraftRecovery: vi.fn(), removeDraftRecovery: vi.fn(), listDraftRecoveries: vi.fn(async (): Promise<DraftRecovery[]> => []),
  getRoutine: vi.fn(), listRoutines: vi.fn(), setActiveRoutine: vi.fn(), saveRoutine: vi.fn(),
  getActiveRoutineSelection: vi.fn<() => Promise<RevisionReference | null>>(async () => null), setActiveRoutineSelection: vi.fn(), listCachedClassSetups: vi.fn(async () => []),
  storeTrack: vi.fn(), removeTrack: vi.fn(), createDemoRoutine: vi.fn(), getReadiness: vi.fn(), renderEditor: vi.fn(),
  listFillerRecordings: vi.fn(), addFillerRecording: vi.fn(), removeFillerRecording: vi.fn(),
  cacheFillerRecording: vi.fn(), getFillerRecordingBlob: vi.fn(),
  listMusicPlaylists: vi.fn(), getMusicPlaylist: vi.fn(), saveMusicPlaylist: vi.fn(), cacheMusicPlaylist: vi.fn(), deleteMusicPlaylist: vi.fn(),
  getPlaylistWorkingCopy: vi.fn(), listPlaylistWorkingCopies: vi.fn(), savePlaylistWorkingCopy: vi.fn(),
  listMusicPlaylistPublications: vi.fn(), listCachedMusicPlaylists: vi.fn(), getCachedMusicPlaylist: vi.fn(),
  getActivePlaylistSelection: vi.fn(), setActivePlaylistSelection: vi.fn(), clearActivePlaylistSelection: vi.fn(),
  reconcilePlaylistWorkingCopy: vi.fn(), deletePlaylistWorkingCopy: vi.fn(),
  playlistSnapshot: vi.fn(), playlistSync: vi.fn(),
  listClassSetups: vi.fn(), getClassSetup: vi.fn(), saveClassSetup: vi.fn(), cacheClassSetup: vi.fn(), deleteClassSetup: vi.fn(),
  publishRoutine: vi.fn(), deleteRoutine: vi.fn(), deleteRoutineAndWorkingCopy: vi.fn(),
  getCachedClassSetup: vi.fn(), getPreparedClass: vi.fn(),
  getTrackBlob: vi.fn(), cacheCloudTrack: vi.fn(),
  inspectLocalAudioReferences: vi.fn(async (): Promise<LocalAudioUsage> => ({ references: [], complete: true })),
  createAudioPreview: vi.fn(), detectBpm: vi.fn(), analyzeLoudness: vi.fn(),
  exportExcel: vi.fn(), exportPdf: vi.fn(), downloadExport: vi.fn(),
  preview: { stop: vi.fn(), dispose: vi.fn(), playFiller: vi.fn(), playTrack: vi.fn(), pause: vi.fn(),
    getState: vi.fn(() => ({ kind: 'idle', trackId: null, playing: false, loading: false, elapsed: 0, duration: 0, error: null })),
    subscribe: vi.fn(() => () => {}) },
  editorSession: { syncAvailability: vi.fn(), cancelJobs: vi.fn(), refreshFillers: vi.fn(), dispose: vi.fn() },
  player: { unload: vi.fn(), load: vi.fn(), play: vi.fn(), pause: vi.fn(), stop: vi.fn(), previous: vi.fn(), next: vi.fn(),
    seek: vi.fn(), updateCues: vi.fn(), advance: vi.fn(),
    hold: vi.fn(), continue: vi.fn(), setVolume: vi.fn(), setBeepVolume: vi.fn(),
    setDucked: vi.fn(), setBeepsMuted: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() },
}));

const nodes: TestElement[] = [];
class TestElement extends EventTarget {
  children: TestElement[] = [];
  parentNode: TestElement | null = null;
  selectionStart = 0;
  selectionEnd = 0;
  disabled = false;
  checked = false;
  hidden = false;
  tabIndex = 0;
  title = '';
  value = '';
  files: File[] = [];
  open = false;
  type = '';
  showModal() { this.open = true; }
  close() { this.open = false; }
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style = { setProperty: vi.fn(), insetInlineStart: '', width: '' };
  captures = new Set<number>();
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (...names: string[]) => { for (const name of names) this.classList.toggle(name, true); },
    remove: (...names: string[]) => { for (const name of names) this.classList.toggle(name, false); },
    toggle: (name: string, force?: boolean): boolean => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      const enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
      return enabled;
    },
  };
  constructor(public tag: string, public className = '', public textContent = '') { super(); nodes.push(this); }
  get ownerDocument() { return document; }
  get firstChild() { return this.children[0] ?? null; }
  get isConnected(): boolean { return this === document.documentElement as unknown || !!this.parentNode?.isConnected; }
  get valueAsNumber() { return this.value.trim() ? Number(this.value) : Number.NaN; }
  getBoundingClientRect() { return { x: 100, y: 100, left: 100, right: 400, top: 100, bottom: 400, width: 300, height: 300 }; }
  setPointerCapture(pointerId: number) { this.captures.add(pointerId); }
  hasPointerCapture(pointerId: number) { return this.captures.has(pointerId); }
  releasePointerCapture(pointerId: number) {
    this.captures.delete(pointerId);
    this.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId }));
  }
  focus() { Object.assign(document, { activeElement: this }); }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  append(...children: TestElement[]) { for (const child of children) this.insertBefore(child, null); }
  prepend(...children: TestElement[]) { for (const child of [...children].reverse()) this.insertBefore(child, this.firstChild); }
  appendChild(child: TestElement) { return this.insertBefore(child, null); }
  after(...children: TestElement[]) {
    const parent = this.parentNode;
    if (!parent) return;
    const next = parent.children[parent.children.indexOf(this) + 1] ?? null;
    for (const child of children) parent.insertBefore(child, next);
  }
  replaceChildren(...children: TestElement[]) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  insertBefore(child: TestElement, next: TestElement | null) {
    if (child === next) return child;
    child.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  contains(child: TestElement): boolean { return child === this || this.children.some(node => node.contains(child)); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll(tag: string): TestElement[] {
    return this.children.flatMap(child => {
      const matches = child.tag === tag || (tag.startsWith('.') && child.classList.contains(tag.slice(1)))
        || (tag === 'fieldset[data-editor-content]' && child.tag === 'fieldset' && 'editorContent' in child.dataset)
        || (tag === 'fieldset[data-library-content]' && child.tag === 'fieldset' && 'libraryContent' in child.dataset)
        || (tag === 'details[data-track-id]' && child.tag === 'details' && 'trackId' in child.dataset);
      return [...(matches ? [child] : []), ...child.querySelectorAll(tag)];
    });
  }
  querySelector(tag: string): TestElement | null { return this.querySelectorAll(tag)[0] ?? null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

function stubDocument() {
  const owner = Object.assign(new EventTarget(), {
    documentElement: new TestElement('html'), activeElement: null as TestElement | null,
    fullscreenElement: null as TestElement | null,
    querySelector: () => new TestElement('div'),
    createElement: (tag: string) => new TestElement(tag),
    createElementNS: (_namespace: string, tag: string) => new TestElement(tag),
  });
  vi.stubGlobal('document', owner);
  vi.stubGlobal('HTMLElement', TestElement);
  vi.stubGlobal('HTMLTextAreaElement', TestElement);
  return owner;
}

vi.mock('../frontend/src/ui', async original => ({
  ...await original<typeof import('../frontend/src/ui')>(),
  element: (tag: string, className?: string, text?: string) => new TestElement(tag, className, text),
  field: (label: string, control: TestElement) => {
    const wrapper = new TestElement('label', '', label); wrapper.append(control); return wrapper;
  },
  iconButton: (label: string, _icon: unknown, action: () => void) => {
    const button = new TestElement('button'); button.title = label;
    button.addEventListener('click', action); return button;
  },
  setButtonIcon: vi.fn(),
}));
vi.mock('../frontend/src/offline', () => mocks);
vi.mock('../frontend/src/playlist-save', async original => ({
  ...await original<typeof import('../frontend/src/playlist-save')>(),
  createPlaylistSave: () => ({ snapshot: mocks.playlistSnapshot, sync: mocks.playlistSync }),
}));
vi.mock('../frontend/src/player', () => ({ createPlayer: () => mocks.player }));
vi.mock('../frontend/src/audio-preview', () => ({ createAudioPreview: mocks.createAudioPreview }));
vi.mock('../frontend/src/bpm', () => ({ detectTrackBpm: mocks.detectBpm }));
vi.mock('../frontend/src/loudness', () => ({ analyzeTrackLoudness: mocks.analyzeLoudness }));
vi.mock('../frontend/src/exports', async original => ({
  ...await original<typeof import('../frontend/src/exports')>(),
  createExcelBlob: mocks.exportExcel, createPdfBlob: mocks.exportPdf, downloadExport: mocks.downloadExport,
}));
vi.mock('../frontend/src/editor', async original => ({
  ...await original<typeof import('../frontend/src/editor')>(), renderEditor: mocks.renderEditor,
}));
vi.mock('../frontend/src/theme', async original => ({
  ...await original<typeof import('../frontend/src/theme')>(),
  readPreferences: () => ({ mode: 'light', accent: 'teal', highContrast: false, progressHeight: 64 }),
  applyTheme: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function pointer(target: TestElement, type: string, clientX: number, pointerId = 7): void {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX, pointerId, button: 0, isPrimary: true }));
}

function key(target: EventTarget, value: string, shiftKey = false): void {
  target.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: value, shiftKey }));
}

describe('unified routine controls', () => {
  beforeEach(() => { stubDocument(); vi.stubGlobal('window', new EventTarget()); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('loads an already-open recovery panel when startup or preparation becomes available', async () => {
    let allowed = false;
    const routine = newRoutine(); routine.name = 'Morning';
    const record = { id: 'morning-recovery', kind: 'routine' as const, source: 'local' as const,
      value: routine, baseRevision: null, media: {}, updatedAt: 1000 };
    mocks.listDraftRecoveries.mockReset().mockResolvedValue([record]);
    const restore = vi.fn(async () => {});
    const panel = createRecoveryPanel({ allowed: () => allowed, restore, message: vi.fn() });
    try {
      const root = panel.element as unknown as TestElement;
      root.open = true; root.dispatchEvent(new Event('toggle'));
      expect(mocks.listDraftRecoveries).not.toHaveBeenCalled();
      allowed = true; panel.sync();
      await vi.waitFor(() => expect(root.querySelectorAll('.routine-library-row')).toHaveLength(1));
      root.querySelectorAll('button').find(button => button.title === t('restoreCopy'))!.click();
      expect(restore).toHaveBeenCalledWith(record);
      panel.sync(); panel.sync();
      expect(mocks.listDraftRecoveries).toHaveBeenCalledTimes(1);
      root.open = false; allowed = false; panel.sync(); allowed = true; panel.sync();
      expect(mocks.listDraftRecoveries).toHaveBeenCalledTimes(1);
      panel.dispose(); root.open = true; allowed = false; panel.sync(); allowed = true; panel.sync();
      expect(mocks.listDraftRecoveries).toHaveBeenCalledTimes(1);
    } finally { panel.dispose(); mocks.listDraftRecoveries.mockReset().mockResolvedValue([]); }
  });

  it('retries an open recovery read interrupted by preparation and ignores stale results', async () => {
    let allowed = true;
    const routine = newRoutine(); routine.name = 'Morning';
    const record = { id: 'morning-recovery', kind: 'routine' as const, source: 'local' as const,
      value: routine, baseRevision: null, media: {}, updatedAt: 1000 };
    const first = deferred();
    mocks.listDraftRecoveries.mockReset().mockImplementationOnce(async () => { await first.promise; return []; }).mockResolvedValue([record]);
    const panel = createRecoveryPanel({ allowed: () => allowed, restore: vi.fn(async () => {}), message: vi.fn() });
    try {
      const root = panel.element as unknown as TestElement;
      root.open = true; root.dispatchEvent(new Event('toggle'));
      allowed = false; panel.sync();
      allowed = true; panel.sync();
      await vi.waitFor(() => expect(root.querySelectorAll('.routine-library-row')).toHaveLength(1));
      first.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(root.querySelectorAll('.routine-library-row')).toHaveLength(1);
      expect(mocks.listDraftRecoveries).toHaveBeenCalledTimes(2);
      panel.sync(); expect(mocks.listDraftRecoveries).toHaveBeenCalledTimes(2);
    } finally { first.resolve(); panel.dispose(); mocks.listDraftRecoveries.mockReset().mockResolvedValue([]); }
  });

  it('preserves an over-limit stored gain until the percentage slider is adjusted', () => {
    let gain = 1.5;
    const control = gainSlider(t('trackGain'), () => gain, value => { gain = value; });
    const root = control.element as unknown as TestElement;
    const slider = root.querySelector('input')!;
    expect(slider.type).toBe('range'); expect(root.querySelectorAll('input')).toHaveLength(1);
    expect(root.querySelector('output')!.textContent).toBe('150%'); expect(gain).toBe(1.5);
    expect(root.querySelector('.gain-warning')!.hidden).toBe(false);
    slider.value = '125'; slider.dispatchEvent(new Event('input'));
    expect(gain).toBe(1.25); expect(root.querySelector('output')!.textContent).toBe('125%');
  });

  it('does not change a disabled gain control through a dispatched event', () => {
    let gain = 1.4;
    const control = gainSlider(t('trackGain'), () => gain, value => { gain = value; }, () => false);
    const slider = (control.element as unknown as TestElement).querySelector('input')!;
    slider.value = '10'; slider.dispatchEvent(new Event('input')); expect(gain).toBe(1.4);
  });

  it('shows a blank held duration and restores the retained timed duration', () => {
    const filler = { ...newRoutine().filler, mode: 'hold' as const, seconds: 37 } as Routine['filler'];
    const root = fillerControls(filler, () => [], () => {}, () => true) as unknown as TestElement;
    const input = root.querySelectorAll('label').find(value => value.textContent === t('fillerDuration'))!.children[0]!;
    expect(input.value).toBe(''); expect(filler.seconds).toBe(37);
    const mode = root.querySelectorAll('select')[0]!; mode.value = 'timed'; mode.dispatchEvent(new Event('change'));
    expect(input.value).toBe('37'); expect(filler.seconds).toBe(37);
    expect(fillerSoundLabel({ ...filler, sound: 'lofi' })).toContain('(16 s)');
  });

  it('expires only the latest error and preserves unrelated invalid form state', async () => {
    vi.useFakeTimers();
    const feedback = new TestElement('p'); const input = new TestElement('input'); input.setAttribute('aria-invalid', 'true');
    const error = transientText(feedback as unknown as HTMLElement);
    error.show('First'); await vi.advanceTimersByTimeAsync(20_000); error.show('Second');
    await vi.advanceTimersByTimeAsync(10_000); expect(feedback.textContent).toBe('Second');
    await vi.advanceTimersByTimeAsync(20_000); expect(feedback.hidden).toBe(true);
    expect(input.attributes.get('aria-invalid')).toBe('true'); error.dispose();
  });

  it('clears overdue background errors on return without renewing errors during rendering', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const feedback = new TestElement('p'); const error = transientText(feedback as unknown as HTMLElement);
    error.show('Invalid'); vi.setSystemTime(20_000); error.refresh('Invalid');
    vi.setSystemTime(31_001); document.dispatchEvent(new Event('visibilitychange'));
    expect(feedback.hidden).toBe(true);
    error.refresh('Invalid'); expect(feedback.hidden).toBe(true);
    error.show('Invalid'); expect(feedback.hidden).toBe(false);
    error.dispose(); vi.setSystemTime(70_000); document.dispatchEvent(new Event('visibilitychange'));
    expect(feedback.textContent).toBe('Invalid'); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an enabled unselected phase incomplete and restores it without a second save or history', () => {
    const routine = newRoutine(); const changed = vi.fn();
    const composition = createClassComposition({ hosted: false, routine: () => routine, source: () => 'local', busy: () => false,
      recordings: () => [], managePlaylists: () => {}, changed, message: () => {} });
    composition.sync();
    composition.restore({ enabled: { walkIn: true, before: false, after: false, walkOut: false }, retained: {} });
    expect(composition.pending()).toBe(true);
    const root = composition.controls as unknown as TestElement;
    expect(root.querySelectorAll('button').some(button => button.title === t('saveClassSetup'))).toBe(false);
    expect(root.querySelectorAll('.draft-protection')).toHaveLength(0);
    const input = root.querySelectorAll('input')[0]!; input.checked = false; input.dispatchEvent(new Event('change'));
    expect(composition.pending()).toBe(false); expect(changed).toHaveBeenCalledTimes(1); composition.dispose();
  });

  it('edits owned walk-in and walk-out gains through routine history without altering the source playlist', () => {
    const routine = newRoutine(); const changed = vi.fn();
    const track: Track = { id: 'arrival', title: 'Arrival', duration: 30, firstBeat: 0, bodyArea: '', cues: [], gain: 1.4 };
    routine.sequence = { crossfade: 2, walkIn: { name: 'Arrival', tracks: [structuredClone(track)] }, walkOut: { name: 'Exit', tracks: [{ ...track, id: 'exit' }] } };
    const composition = createClassComposition({ hosted: false, routine: () => routine, source: () => 'local', busy: () => false,
      recordings: () => [], managePlaylists: () => {}, changed, message: () => {} });
    composition.sync();
    for (const [root, phase] of [[composition.beforeTracks, 'walkIn'], [composition.afterTracks, 'walkOut']] as const) {
      const slider = (root as unknown as TestElement).querySelector('.gain-control')!.querySelector('input')!;
      slider.value = '110'; slider.dispatchEvent(new Event('input'));
      expect(routine.sequence[phase]!.tracks[0]!.gain).toBe(1.1);
    }
    expect(changed).toHaveBeenCalledTimes(2); expect(track.gain).toBe(1.4);
    routine.locked = true;
    const slider = (composition.beforeTracks as unknown as TestElement).querySelector('.gain-control')!.querySelector('input')!;
    slider.value = '50'; slider.dispatchEvent(new Event('input'));
    expect(routine.sequence.walkIn!.tracks[0]!.gain).toBe(1.1); composition.dispose();
  });

  it('reenables owned phase sliders after preparation and lock transitions without rebuilding the sequence', () => {
    const routine = newRoutine(); let busy = true;
    routine.sequence = { crossfade: 2, walkIn: { name: 'Arrival', tracks: [{ id: 'arrival', title: 'Arrival', duration: 30, firstBeat: 0, bodyArea: '', cues: [] }] } };
    const composition = createClassComposition({ hosted: false, routine: () => routine, source: () => 'local', busy: () => busy,
      recordings: () => [], managePlaylists: () => {}, changed: () => {}, message: () => {} });
    composition.sync(); const input = (composition.beforeTracks as unknown as TestElement).querySelector('.gain-control')!.querySelector('input')!;
    expect(input.disabled).toBe(true); busy = false; composition.sync(); expect(input.disabled).toBe(false);
    routine.locked = true; composition.sync(); expect(input.disabled).toBe(true);
    routine.locked = false; composition.sync(); expect(input.disabled).toBe(false); composition.dispose();
  });

  it('refuses count conversion when imported BPM is unknown', () => {
    const track: Track = { id: 'unknown', title: 'Unknown', duration: 30, firstBeat: 0, bodyArea: '', cues: [] };
    expect(cueAtSeconds(track, { id: 'cue', note: 'Move', anchor: { kind: 'count', count: 1 } }, 5, 30)).toBeNull();
    expect(cueAtSeconds(track, { id: 'cue', note: 'Move', anchor: { kind: 'timestamp', seconds: 1 } }, 5, 30)?.anchor).toEqual({ kind: 'timestamp', seconds: 5 });
  });
});

describe('unified audio picker', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function previewHarness() {
    const owner = stubDocument(); const root = new TestElement('body'); Object.assign(owner, { body: root });
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'online', expiresAt: Date.now() + 3600_000,
      user: { id: 'author', username: 'author', role: 'editor', authVersion: 1 } });
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('editor');
    let validIdentity = true;
    vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => { if (!validIdentity) throw new Error('cloud_cancelled'); });
    let identityChanged = () => {};
    const unsubscribeIdentity = vi.fn();
    vi.spyOn(cloudState, 'subscribeCloudSession').mockImplementation(listener => {
      identityChanged = () => listener(cloudState.getCloudContext()); return unsubscribeIdentity;
    });
    const blob = new Blob([new Uint8Array(128)], { type: 'audio/wav' });
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');
    const items = ['First', 'Second'].map(title => ({ title, duration: 30,
      asset: { id: title.toLowerCase(), bytes: blob.size, contentType: blob.type, sha256 } }));
    const cache = new Map<string, Blob>();
    mocks.getTrackBlob.mockImplementation(async id => cache.get(id));
    mocks.cacheCloudTrack.mockImplementation(async (id, value) => { cache.set(id, value); });
    const library = { managedPage: vi.fn(async () => ({ items: items.map(item => ({ id: item.asset.id, kind: 'song', asset: item.asset,
      metadata: { revision: 0, title: item.title, artist: '', duration: item.duration } })) })),
      downloadTracks: vi.fn(async (tracks: Track[], _media: CloudRoutine['media'], _transfer: { signal?: AbortSignal }) => {
        cache.set(tracks[0]!.id, blob);
      }) };
    let state: PreviewState = { kind: 'idle', trackId: null, playing: false, loading: false, elapsed: 0, duration: 0, error: null };
    const listeners = new Set<(state: PreviewState) => void>();
    const emit = (value: Partial<PreviewState>) => { state = { ...state, ...value }; for (const listener of listeners) listener(state); };
    const unsubscribePreview = vi.fn();
    const preview: AudioPreview = {
      playTrack: vi.fn(async track => emit({ kind: 'track', trackId: track.id, playing: true, duration: track.duration })),
      playFiller: vi.fn(async () => {}), getState: () => state, seek: vi.fn(), dispose: vi.fn(),
      stop: vi.fn(() => emit({ kind: 'idle', trackId: null, playing: false, loading: false })),
      pause: vi.fn(() => emit({ playing: false, loading: false })),
      subscribe: listener => { listeners.add(listener); listener(state); return () => { listeners.delete(listener); unsubscribePreview(); }; },
    };
    const added = vi.fn(); const beforePreview = vi.fn(); let source = 'draft:1';
    const picker = createAudioLibraryPicker({ library: library as unknown as ReturnType<typeof createCloudLibrary>,
      preview, beforePreview, available: () => true, identity: () => source, remaining: () => 10, added, duration: async () => 30 });
    picker.element.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.audio-library-row')).toHaveLength(2));
    const row = (title = 'First') => root.querySelectorAll('.audio-library-row').find(node => node.querySelector('label')?.textContent === title)!;
    const choose = (title = 'First') => { const checkbox = row(title).querySelector('input')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); };
    const button = (label: string) => root.querySelectorAll('button').find(node => node.title === label)!;
    const play = (title = 'First') => row(title).querySelectorAll('button').find(node => node.title === t('playPreview'))!.click();
    return { root, picker, preview, library, added, beforePreview, items, cache, blob, row, choose, button, play,
      unsubscribeIdentity, unsubscribePreview, invalidate: () => { validIdentity = false; identityChanged(); },
      changeSource: () => { source = 'draft:2'; picker.sync(); } };
  }

  it('previews only a checked asset, keeps Open/search metadata-only, and reuses verified bytes on explicit Add', async () => {
    const harness = await previewHarness();
    const search = harness.root.querySelectorAll('input').find(node => node.type === 'search')!;
    search.value = 'First'; search.dispatchEvent(new Event('input'));
    harness.play();
    expect(harness.library.downloadTracks).not.toHaveBeenCalled(); expect(mocks.getTrackBlob).not.toHaveBeenCalled();
    expect(harness.preview.playTrack).not.toHaveBeenCalled();
    harness.choose(); harness.play();
    await vi.waitFor(() => expect(harness.preview.playTrack).toHaveBeenCalledOnce());
    const track = vi.mocked(harness.preview.playTrack).mock.calls[0]![0];
    expect(harness.library.downloadTracks).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ title: 'First' })],
      { [track.id]: harness.items[0]!.asset }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(harness.beforePreview).toHaveBeenCalledOnce(); expect(harness.added).not.toHaveBeenCalled();
    harness.button(t('pausePreview')).click(); expect(harness.preview.pause).toHaveBeenCalledOnce();
    harness.play(); await vi.waitFor(() => expect(harness.preview.playTrack).toHaveBeenCalledTimes(2));
    expect(harness.library.downloadTracks).toHaveBeenCalledOnce();
    harness.button(t('addSelectedAudio')).click(); await vi.waitFor(() => expect(harness.added).toHaveBeenCalledOnce());
    const [tracks, media] = harness.added.mock.calls[0]!;
    expect(tracks).toEqual([{ ...track, id: expect.any(String) }]); expect(tracks[0].id).not.toBe(track.id);
    expect(media).toEqual({ [tracks[0].id]: harness.items[0]!.asset });
    expect(harness.library.downloadTracks).toHaveBeenCalledOnce(); expect(harness.preview.getState().playing).toBe(false);
    expect(harness.root.querySelector('dialog')).toBeNull(); expect(harness.preview.dispose).not.toHaveBeenCalled();
    harness.picker.dispose();
  });

  it.each(['cancel', 'escape', 'close', 'dispose', 'identity', 'source', 'pause', 'stop', 'external-stop'] as const)(
    'cancels a pending preview on %s and never starts or inserts late audio', async action => {
      const harness = await previewHarness(); const wait = deferred();
      harness.library.downloadTracks.mockImplementation(async tracks => { await wait.promise; harness.cache.set(tracks[0]!.id, harness.blob); });
      harness.choose(); harness.play();
      await vi.waitFor(() => expect(harness.library.downloadTracks).toHaveBeenCalledOnce());
      const signal = harness.library.downloadTracks.mock.calls[0]![2].signal!;
      if (action === 'cancel') harness.button(t('cancel')).click();
      if (action === 'escape') harness.root.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (action === 'close') harness.root.querySelector('dialog')!.dispatchEvent(new Event('close'));
      if (action === 'dispose') harness.picker.dispose();
      if (action === 'identity') harness.invalidate();
      if (action === 'source') harness.changeSource();
      if (action === 'pause') harness.button(t('pausePreview')).click();
      if (action === 'stop') harness.button(t('stop')).click();
      if (action === 'external-stop') harness.preview.stop();
      expect(signal.aborted).toBe(true);
      wait.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(harness.preview.playTrack).not.toHaveBeenCalled(); expect(harness.added).not.toHaveBeenCalled();
      harness.picker.dispose(); expect(harness.unsubscribePreview).toHaveBeenCalledOnce(); expect(harness.unsubscribeIdentity).toHaveBeenCalledOnce();
      expect(harness.preview.dispose).not.toHaveBeenCalled();
    });

  it.each(['cancel', 'dispose', 'identity', 'source', 'stop'] as const)('stops audible preview on %s without changing the draft', async action => {
    const harness = await previewHarness(); harness.choose(); harness.play();
    await vi.waitFor(() => expect(harness.preview.getState().playing).toBe(true));
    if (action === 'cancel') harness.button(t('cancel')).click();
    if (action === 'dispose') harness.picker.dispose();
    if (action === 'identity') harness.invalidate();
    if (action === 'source') harness.changeSource();
    if (action === 'stop') harness.button(t('stop')).click();
    expect(harness.preview.getState().playing).toBe(false); expect(harness.added).not.toHaveBeenCalled(); harness.picker.dispose();
  });

  it('rejects mismatched asset bytes before preview or insertion', async () => {
    const harness = await previewHarness();
    harness.library.downloadTracks.mockImplementation(async tracks => { harness.cache.set(tracks[0]!.id, new Blob([new Uint8Array(128).fill(1)])); });
    harness.choose(); harness.play();
    await vi.waitFor(() => expect(harness.root.querySelectorAll('p').some(node => node.textContent === cloudErrorMessage(new Error('cloud_hash_mismatch')))).toBe(true));
    expect(harness.preview.playTrack).not.toHaveBeenCalled(); expect(harness.added).not.toHaveBeenCalled(); harness.picker.dispose();
  });

  it('offers only exact cached assets offline, including phase songs, with no catalog or download request', async () => {
    const owner = stubDocument(); Object.assign(owner, { body: new TestElement('body') });
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'offline', expiresAt: 0, user: { id: 'author', username: 'author', role: 'editor', authVersion: 1 } });
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('editor');
    vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => {});
    const blob = new Blob([new Uint8Array(128)], { type: 'audio/wav' });
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');
    const asset = { id: 'asset', bytes: 128, contentType: 'audio/wav', sha256: hash };
    const routine = newRoutine();
    const track: Track = { id: 'cached', title: 'Cached phase', duration: 30, firstBeat: 0, bodyArea: '', cues: [] };
    routine.sequence = { crossfade: 2, walkIn: { name: 'Arrival', tracks: [track] } };
    routine.tracks = [{ ...track, id: 'missing', title: 'Missing' }, { ...track, id: 'bad', title: 'Mismatch' }];
    mocks.listRoutineWorkingCopies.mockResolvedValue([{ envelope: { routine, media: { cached: asset, missing: { ...asset, id: 'missing' }, bad: { ...asset, id: 'bad', sha256: 'a'.repeat(64) } } }, localVersion: 1, cloudBaseRevision: 1, pendingCloud: false, savedAt: 1 }]);
    mocks.listRoutines.mockResolvedValue([]); mocks.listCloudRoutines.mockResolvedValue([]);
    mocks.getTrackBlob.mockImplementation(async id => id === 'missing' ? undefined : blob);
    mocks.cacheCloudTrack.mockResolvedValue(undefined);
    const library = { managedPage: vi.fn(), downloadTracks: vi.fn() }; const added = vi.fn();
    const picker = createAudioLibraryPicker({ library: library as unknown as ReturnType<typeof createCloudLibrary>, available: () => true,
      identity: () => 'draft', remaining: () => 5, added, duration: async () => 30 });
    picker.sync(); expect(picker.element.disabled).toBe(false); picker.element.click();
    const root = (owner as unknown as { body: TestElement }).body;
    await vi.waitFor(() => expect(root.querySelectorAll('.audio-library-row')).toHaveLength(1));
    const row = root.querySelector('.audio-library-row')!; expect(row.querySelector('label')!.textContent).toBe('Cached phase');
    const checkbox = row.querySelector('input')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    root.querySelectorAll('button').find(node => node.title === t('addSelectedAudio'))!.click();
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    expect(added.mock.calls[0]![0][0]).toMatchObject({ title: 'Cached phase', cues: [], duration: 30 });
    expect(added.mock.calls[0]![0][0].id).not.toBe('cached'); expect(added.mock.calls[0]![0][0].bpm).toBeUndefined();
    expect(mocks.cacheCloudTrack).toHaveBeenCalledWith(expect.any(String), blob, hash);
    expect(library.managedPage).not.toHaveBeenCalled(); expect(library.downloadTracks).not.toHaveBeenCalled(); picker.dispose();
  });

  it('browses metadata without downloading, then adds checked assets in selection order with fresh IDs', async () => {
    const owner = stubDocument(); Object.assign(owner, { body: new TestElement('body') });
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'online', expiresAt: Date.now() + 3600_000, user: { id: 'author', username: 'author', role: 'editor', authVersion: 1 } });
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('editor');
    vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => {});
    const blob = new Blob([new Uint8Array(128)], { type: 'audio/wav' });
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');
    const asset = (id: string) => ({ id, bytes: 128, contentType: 'audio/wav', sha256 });
    const library = { managedPage: vi.fn(async () => ({ items: [
      { id: 'first', kind: 'song', asset: asset('first'), metadata: { revision: 0, title: 'First', artist: '' } },
      { id: 'second', kind: 'song', asset: asset('second'), metadata: { revision: 3, title: 'Second', artist: '<Artist>', bpm: 120 } },
    ] })),
      downloadTracks: vi.fn(async () => {}) };
    mocks.getTrackBlob.mockResolvedValue(new Blob([new Uint8Array(128)], { type: 'audio/wav' }));
    const added = vi.fn();
    const picker = createAudioLibraryPicker({ library: library as unknown as ReturnType<typeof createCloudLibrary>, available: () => true,
      identity: () => 'routine:1', remaining: () => 10, added, duration: async () => 30 });
    picker.element.click();
    const root = (owner as unknown as { body: TestElement }).body;
    const choice = (name: string) => root.querySelectorAll('label').find(node => node.textContent === name)?.children[0];
    await vi.waitFor(() => expect(choice('First')).toBeDefined());
    expect(library.downloadTracks).not.toHaveBeenCalled(); expect(mocks.getTrackBlob).not.toHaveBeenCalled();
    for (const name of ['Second', 'First']) { const checkbox = choice(name)!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); }
    root.querySelectorAll('button').find(node => node.title === t('addSelectedAudio'))!.click();
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    const tracks = added.mock.calls[0]![0] as Track[];
    expect(tracks.map(track => track.title)).toEqual(['Second', 'First']);
    expect(new Set(tracks.map(track => track.id)).size).toBe(2); expect(tracks.map(track => track.id)).not.toContain('first');
    expect(tracks.every(track => track.cues.length === 0)).toBe(true); expect(tracks[1]!.bpm).toBeUndefined();
    expect(tracks[0]!.bpm).toBe(120); expect(tracks[0]).not.toHaveProperty('artist');
    expect(library.downloadTracks).toHaveBeenCalledTimes(2); picker.dispose();
  });
});

describe('uploaded audio manager', () => {
  beforeEach(() => { vi.clearAllMocks(); nodes.length = 0; stubDocument(); vi.stubGlobal('window', new EventTarget()); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function harness() {
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'online', expiresAt: Date.now() + 3600_000,
      user: { id: 'author', username: 'author', role: 'editor', authVersion: 1 } });
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('editor');
    vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => {});
    vi.spyOn(cloudState, 'subscribeCloudSession').mockReturnValue(() => {});
    const blob = new Blob([new Uint8Array(128)], { type: 'audio/wav' });
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');
    const item: ManagedAudioItem = { id: 'asset-manager', kind: 'song', asset: { id: 'asset-manager', bytes: 128, sha256: hash, contentType: 'audio/wav' },
      metadata: { revision: 0, title: '<House song>', artist: '<Artist>' } };
    type Transfer = { signal?: AbortSignal };
    const cloud = {
      managedPage: vi.fn(async (_kind: 'song' | 'filler', _cursor?: string, _transfer?: Transfer): Promise<ManagedAudioPage> => ({ items: [structuredClone(item)] })),
      libraryMetadata: vi.fn(async (): Promise<LibraryMetadata> => ({ revision: 3, title: '<Accepted title>', artist: 'Accepted artist', bpm: 132 })),
      putLibraryMetadata: vi.fn(async (_kind: string, _id: string, revision: number, value: Pick<LibraryMetadata, 'title' | 'artist' | 'bpm'>) => ({ ...value, revision: revision + 1 })),
      libraryUsage: vi.fn(async () => ({ references: [] as import('../shared/cloud-contract').LibraryUsagePage['references'], complete: true })),
      deleteLibraryItem: vi.fn(async (): Promise<import('../shared/cloud-contract').LibraryDeleteResult> => ({ deleted: true, bytesRetained: true })),
      downloadTracks: vi.fn(async (_tracks: Track[], _media: CloudRoutine['media'], _transfer: Transfer) => {}),
      uploadAsset: vi.fn(async () => item.asset),
      recordLibraryIntake: vi.fn(async (_kind: string, _id: string, filename: string, duration: number): Promise<LibraryMetadata> =>
        ({ revision: 1, title: '', artist: '', filename, duration })),
      addFiller: vi.fn(), ensureFiller: vi.fn(),
    };
    let state: PreviewState = { kind: 'idle', trackId: null, playing: false, loading: false, elapsed: 0, duration: 0, error: null };
    const listeners = new Set<(value: PreviewState) => void>();
    const emit = (value: Partial<PreviewState>) => { state = { ...state, ...value }; for (const listener of listeners) listener(state); };
    const preview: AudioPreview = { getState: () => state, dispose: vi.fn(), seek: vi.fn(), playFiller: vi.fn(async () => {}),
      playTrack: vi.fn(async track => emit({ kind: 'track', trackId: track.id, playing: true, duration: track.duration })),
      stop: vi.fn(() => emit({ kind: 'idle', trackId: null, playing: false })), pause: vi.fn(() => emit({ playing: false })),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
    let busy = false;
    const localUsage = vi.fn(async () => ({ references: [] as import('../shared/cloud-contract').LibraryUsagePage['references'], complete: true }));
    const beforePreview = vi.fn(); const changed = vi.fn(); const catalog = vi.fn();
    const manager = createMediaLibrary({ hosted: true, cloud: cloud as unknown as ReturnType<typeof createCloudLibrary>, preview,
      known: () => [], busy: () => busy, working: value => { busy = value; }, visible: () => true, beforePreview, changed, catalog, localUsage });
    const root = manager.element as unknown as TestElement;
    root.open = true; root.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(root.querySelectorAll('.media-row')).toHaveLength(2));
    await vi.waitFor(() => expect(busy).toBe(false));
    const button = (label: string, within = root) => within.querySelectorAll('button').find(node => node.title === label)!;
    const dialog = () => root.querySelector('dialog')!;
    const input = (label: string) => dialog().querySelectorAll('label').find(node => node.textContent === label)!.querySelector('input')!;
    return { manager, root, cloud, item, blob, preview, emit, beforePreview, changed, catalog, localUsage, button, dialog, input, idle: () => vi.waitFor(() => expect(busy).toBe(false)) };
  }

  it('browses text-only metadata and unknown intake without downloading, and searches loaded rows', async () => {
    const setup = await harness();
    expect(setup.cloud.downloadTracks).not.toHaveBeenCalled(); expect(mocks.getTrackBlob).not.toHaveBeenCalled();
    const cells = setup.root.querySelectorAll('.media-cell');
    expect(cells.map(cell => cell.textContent)).toEqual([t('unknownValue'), '<House song>', '<Artist>', t('unknownValue'), t('unknownValue')]);
    expect(cells.every(cell => cell.children.length === 0)).toBe(true);
    const search = setup.root.querySelectorAll('input').find(node => node.type === 'search')!;
    search.value = 'no match'; search.dispatchEvent(new Event('input'));
    expect(setup.root.querySelectorAll('.media-cell')).toHaveLength(0); expect(setup.cloud.managedPage).toHaveBeenCalledOnce();
    setup.manager.dispose();
  });

  it('retains metadata input on CAS conflict and requires an explicit revision reload', async () => {
    const setup = await harness();
    setup.cloud.putLibraryMetadata.mockRejectedValueOnce(new cloudState.CloudRequestError('cloud_http_error', 409, 'metadata_conflict'));
    setup.button(t('editAudio')).click(); setup.input(t('audioTitle')).value = '<Revised title>';
    setup.input(t('audioArtist')).value = 'Artist'; setup.input(t('audioBpm')).value = '128';
    setup.button(t('saveChanges'), setup.dialog()).click(); await setup.idle();
    expect(setup.input(t('audioTitle')).value).toBe('<Revised title>');
    expect(setup.button(t('saveChanges'), setup.dialog()).disabled).toBe(true);
    expect(setup.dialog().querySelectorAll('p').some(node => node.textContent === t('audioMetadataConflict'))).toBe(true);
    setup.button(t('audioReloadRevision'), setup.dialog()).click(); await setup.idle();
    expect(setup.input(t('audioTitle')).value).toBe('<Accepted title>');
    expect(setup.input(t('audioArtist')).value).toBe('Accepted artist');
    expect(setup.input(t('audioBpm')).value).toBe('132');
    expect(setup.catalog.mock.calls.at(-1)![0][0].metadata).toEqual({ revision: 3, title: '<Accepted title>', artist: 'Accepted artist', bpm: 132 });
    setup.button(t('saveChanges'), setup.dialog()).click(); await setup.idle();
    expect(setup.cloud.putLibraryMetadata.mock.calls.map(call => call[2])).toEqual([0, 3]);
    expect(setup.cloud.putLibraryMetadata.mock.lastCall![3]).toEqual({ title: '<Accepted title>', artist: 'Accepted artist', bpm: 132 });
    expect(setup.root.querySelector('dialog')).toBeNull(); expect(setup.cloud.uploadAsset).not.toHaveBeenCalled(); setup.manager.dispose();
  });

  it.each(['referenced', 'incomplete'] as const)('blocks %s local audio deletion and never deletes on opening or cancelling', async reason => {
    const setup = await harness();
    setup.localUsage.mockResolvedValue({ references: reason === 'referenced' ? [{ kind: 'routine', id: 'unsaved', name: '<Unsaved routine>' }] : [], complete: reason !== 'incomplete' });
    setup.button(t('deleteAudio')).click(); await setup.idle();
    expect(setup.button(t('deleteAudio'), setup.dialog()).disabled).toBe(true);
    expect(setup.cloud.deleteLibraryItem).not.toHaveBeenCalled();
    expect(setup.dialog().querySelectorAll('p').some(node => node.textContent === t(reason === 'referenced' ? 'audioInUse' : 'audioLocalUncertain'))).toBe(true);
    setup.button(t('cancel'), setup.dialog()).click(); expect(setup.root.querySelector('dialog')).toBeNull();
    expect(setup.cloud.deleteLibraryItem).not.toHaveBeenCalled(); setup.manager.dispose();
  });

  it('continues a pending deletion only on another explicit click with the same target revision', async () => {
    const setup = await harness(); setup.cloud.deleteLibraryItem.mockResolvedValueOnce({ pending: true });
    setup.button(t('deleteAudio')).click(); await setup.idle();
    expect(setup.cloud.deleteLibraryItem).not.toHaveBeenCalled();
    setup.button(t('deleteAudio'), setup.dialog()).click(); await setup.idle();
    expect(setup.cloud.deleteLibraryItem).toHaveBeenCalledOnce();
    expect(setup.dialog().querySelectorAll('p').some(node => node.textContent === t('audioDeletePending'))).toBe(true);
    setup.button(t('audioContinueCheck'), setup.dialog()).click(); await setup.idle();
    expect(setup.cloud.deleteLibraryItem.mock.calls).toHaveLength(2);
    expect(setup.root.querySelector('dialog')).toBeNull(); expect(setup.localUsage).toHaveBeenCalledTimes(3); setup.manager.dispose();
  });

  it.each(['leave', 'switch'] as const)('aborts a pending verified preview on %s and never starts late audio', async action => {
    const setup = await harness(); const waiting = deferred();
    setup.cloud.downloadTracks.mockImplementation(async () => waiting.promise);
    setup.button(t('playPreview')).click();
    await vi.waitFor(() => expect(setup.cloud.downloadTracks).toHaveBeenCalledOnce());
    expect(setup.beforePreview).toHaveBeenCalledOnce();
    const signal = setup.cloud.downloadTracks.mock.calls[0]![2].signal!;
    if (action === 'leave') setup.manager.leave();
    else {
      setup.cloud.managedPage.mockResolvedValue({ items: [] });
      setup.root.querySelectorAll('button').find(node => node.textContent === t('managedFillers'))!.click();
    }
    expect(signal.aborted).toBe(true); waiting.resolve(); await setup.idle();
    expect(setup.preview.playTrack).not.toHaveBeenCalled(); setup.manager.dispose();
  });

  it.each([
    ['song', 'intake-transient'], ['song', 'intake-lost'], ['song', 'metadata-transient'], ['song', 'metadata-lost'],
    ['filler', 'intake-transient'], ['filler', 'intake-lost'], ['filler', 'metadata-transient'], ['filler', 'metadata-lost'],
  ] as const)(
    'resumes a committed %s after %s without duplicating its bytes or catalog entry',
    async (kind, failure) => {
      const setup = await harness();
      const localRecording: FillerRecording = { id: 'local-filler', name: 'original', duration: 20, asset: setup.item.asset };
      const remoteRecording: FillerRecording = { ...localRecording, id: 'remote-filler' };
      mocks.storeTrack.mockResolvedValue({ id: 'local-song', title: 'original', duration: 20, firstBeat: 0, bodyArea: '', cues: [] });
      mocks.getTrackBlob.mockResolvedValue(setup.blob);
      mocks.addFillerRecording.mockResolvedValue(localRecording);
      mocks.getFillerRecordingBlob.mockResolvedValue(setup.blob);
      setup.cloud.addFiller.mockResolvedValue(remoteRecording);
      let authoritative: LibraryMetadata = { revision: 0, title: '', artist: '' };
      let intakeCalls = 0;
      setup.cloud.libraryMetadata.mockImplementation(async () => structuredClone(authoritative));
      setup.cloud.recordLibraryIntake.mockImplementation(async (_kind, _id, filename, duration) => {
        intakeCalls++;
        const accepted: LibraryMetadata = { revision: 1, title: '', artist: '', filename, duration };
        if (failure === 'intake-transient' && intakeCalls === 1) throw new Error('network_unavailable');
        authoritative = accepted;
        if (failure === 'intake-lost' && intakeCalls === 1) throw new Error('network_unavailable');
        return structuredClone(accepted);
      });
      let metadataCalls = 0;
      setup.cloud.putLibraryMetadata.mockImplementation(async (_kind, _id, revision, value) => {
        metadataCalls++;
        if (failure === 'metadata-transient' && metadataCalls === 1) throw new Error('network_unavailable');
        authoritative = { ...value, revision: revision + 1, filename: 'original.wav', duration: 20 };
        if (failure === 'metadata-lost' && metadataCalls === 1) throw new Error('network_unavailable');
        return structuredClone(authoritative);
      });
      if (kind === 'filler') {
        setup.root.querySelectorAll('button').find(node => node.textContent === t('managedFillers'))!.click();
        await setup.idle();
      }
      const files = setup.root.querySelectorAll('input').find(node => node.type === 'file')!;
      files.files = [new File([setup.blob], 'original.wav', { type: 'audio/wav' })]; files.dispatchEvent(new Event('change'));
      setup.button(kind === 'song' ? t('uploadAudio') : t('uploadFillers')).click(); await setup.idle();
      expect(setup.root.querySelector('.media-status')!.textContent).toBe(t('audioUploadMetadataFailed'));
      expect(setup.button(t('resumeAudioUpload')).hidden).toBe(false);
      setup.button(t('resumeAudioUpload')).click(); await setup.idle();
      expect(setup.root.querySelector('.media-status')!.textContent).toBe(t('audioBatchDone'));
      expect(setup.button(t('resumeAudioUpload')).hidden).toBe(true);
      expect(setup.cloud.recordLibraryIntake).toHaveBeenCalledTimes(failure === 'intake-transient' ? 2 : 1);
      expect(setup.cloud.putLibraryMetadata).toHaveBeenCalledTimes(failure === 'metadata-transient' ? 2 : 1);
      if (kind === 'song') {
        expect(mocks.storeTrack).toHaveBeenCalledOnce(); expect(setup.cloud.uploadAsset).toHaveBeenCalledOnce();
        expect(mocks.addFillerRecording).not.toHaveBeenCalled(); expect(setup.cloud.addFiller).not.toHaveBeenCalled();
      } else {
        expect(mocks.addFillerRecording).toHaveBeenCalledOnce(); expect(setup.cloud.addFiller).toHaveBeenCalledOnce();
        expect(mocks.storeTrack).not.toHaveBeenCalled(); expect(setup.cloud.uploadAsset).not.toHaveBeenCalled();
      }
      expect(mocks.removeTrack).not.toHaveBeenCalled();
      expect(mocks.removeFillerRecording).not.toHaveBeenCalled();
      setup.manager.dispose();
    },
  );

  it('uses the intake response revision for uploaded editable metadata', async () => {
    const setup = await harness();
    mocks.storeTrack.mockResolvedValue({ id: 'local-song', title: 'original', duration: 20, firstBeat: 0, bodyArea: '', cues: [] });
    mocks.getTrackBlob.mockResolvedValue(setup.blob);
    const files = setup.root.querySelectorAll('input').find(node => node.type === 'file')!;
    files.files = [new File([setup.blob], 'original.wav', { type: 'audio/wav' })]; files.dispatchEvent(new Event('change'));
    setup.button(t('uploadAudio')).click(); await setup.idle();
    expect(setup.cloud.recordLibraryIntake).toHaveBeenCalledWith('song', 'asset-manager', 'original.wav', 20, expect.any(Object));
    expect(setup.cloud.putLibraryMetadata).toHaveBeenCalledWith('song', 'asset-manager', 1, { title: 'original', artist: '' }, expect.any(Object));
    expect(setup.root.querySelector('.media-status')!.textContent).toBe(t('audioBatchDone'));
    setup.manager.dispose();
  });

  it.each([
    ['song', 'bad:name.wav', 20],
    ['filler', '.', 20],
    ['song', 'long.wav', 1201],
    ['filler', 'long.wav', 361],
  ] as const)('rejects permanent %s intake facts before cloud writes and accepts a later selection', async (kind, filename, duration) => {
    const setup = await harness();
    const track = { id: 'local-song', title: 'long', duration, firstBeat: 0, bodyArea: '', cues: [] };
    const recording: FillerRecording = { id: 'local-filler', name: 'long', duration, asset: setup.item.asset };
    mocks.storeTrack.mockResolvedValue(track);
    mocks.getTrackBlob.mockResolvedValue(setup.blob);
    mocks.addFillerRecording.mockResolvedValue(recording);
    mocks.getFillerRecordingBlob.mockResolvedValue(setup.blob);
    setup.cloud.addFiller.mockResolvedValue(recording);
    if (kind === 'filler' && duration > 360) mocks.removeFillerRecording.mockRejectedValue(new Error('cleanup_failed'));
    if (kind === 'filler') {
      setup.root.querySelectorAll('button').find(node => node.textContent === t('managedFillers'))!.click();
      await setup.idle();
    }
    const files = setup.root.querySelectorAll('input').find(node => node.type === 'file')!;
    files.files = [new File([setup.blob], filename, { type: 'audio/wav' })]; files.dispatchEvent(new Event('change'));
    setup.button(kind === 'song' ? t('uploadAudio') : t('uploadFillers')).click();
    await setup.idle();
    if (filename.includes(':') || filename === '.') {
      expect(mocks.storeTrack).not.toHaveBeenCalled(); expect(mocks.addFillerRecording).not.toHaveBeenCalled();
      expect(mocks.removeTrack).not.toHaveBeenCalled(); expect(mocks.removeFillerRecording).not.toHaveBeenCalled();
    } else if (kind === 'song') {
      expect(mocks.removeTrack).toHaveBeenCalledOnce(); expect(mocks.removeTrack).toHaveBeenCalledWith(track.id);
      expect(mocks.removeFillerRecording).not.toHaveBeenCalled();
      expect(setup.root.querySelector('.media-status')!.textContent).toBe('invalid_audio');
    } else {
      expect(mocks.removeFillerRecording).toHaveBeenCalledOnce(); expect(mocks.removeFillerRecording).toHaveBeenCalledWith(recording.id);
      expect(mocks.removeTrack).not.toHaveBeenCalled();
      expect(setup.root.querySelector('.media-status')!.textContent).toBe('invalid_audio');
    }
    expect(setup.cloud.uploadAsset).not.toHaveBeenCalled();
    expect(setup.cloud.addFiller).not.toHaveBeenCalled();
    expect(setup.cloud.recordLibraryIntake).not.toHaveBeenCalled();
    expect(setup.button(t('resumeAudioUpload')).hidden).toBe(true);

    const validDuration = 20;
    mocks.storeTrack.mockResolvedValue({ ...track, duration: validDuration });
    mocks.addFillerRecording.mockResolvedValue({ ...recording, duration: validDuration });
    files.files = [new File([setup.blob], 'later.wav', { type: 'audio/wav' })]; files.dispatchEvent(new Event('change'));
    setup.button(kind === 'song' ? t('uploadAudio') : t('uploadFillers')).click();
    await setup.idle();
    expect(setup.cloud.recordLibraryIntake).toHaveBeenCalledOnce();
    expect(mocks.removeTrack).toHaveBeenCalledTimes(kind === 'song' && duration > 360 ? 1 : 0);
    expect(mocks.removeFillerRecording).toHaveBeenCalledTimes(kind === 'filler' && duration > 360 ? 1 : 0);
    expect(setup.root.querySelector('.media-status')!.textContent).toBe(t('audioBatchDone'));
    setup.manager.dispose();
  });

  it.each(['song', 'filler'] as const)('clears a rejected local %s staging attempt so another batch can upload', async kind => {
    const setup = await harness();
    if (kind === 'song') {
      mocks.storeTrack.mockRejectedValueOnce(new Error('invalid_audio'));
      mocks.storeTrack.mockResolvedValue({ id: 'local-song', title: 'valid', duration: 20, firstBeat: 0, bodyArea: '', cues: [] });
      mocks.getTrackBlob.mockResolvedValue(setup.blob);
    } else {
      setup.root.querySelectorAll('button').find(node => node.textContent === t('managedFillers'))!.click();
      await setup.idle();
      const recording: FillerRecording = { id: 'local-filler', name: 'valid', duration: 20, asset: setup.item.asset };
      mocks.addFillerRecording.mockRejectedValueOnce(new Error('invalid_audio'));
      mocks.addFillerRecording.mockResolvedValue(recording);
      mocks.getFillerRecordingBlob.mockResolvedValue(setup.blob);
      setup.cloud.addFiller.mockResolvedValue(recording);
    }
    const files = setup.root.querySelectorAll('input').find(node => node.type === 'file')!;
    files.files = [new File([setup.blob], 'broken.wav', { type: 'audio/wav' })]; files.dispatchEvent(new Event('change'));
    setup.button(kind === 'song' ? t('uploadAudio') : t('uploadFillers')).click(); await setup.idle();
    expect(setup.button(t('resumeAudioUpload')).hidden).toBe(true);
    expect(files.disabled).toBe(false);

    files.files = [new File([setup.blob], 'valid.wav', { type: 'audio/wav' })]; files.dispatchEvent(new Event('change'));
    setup.button(kind === 'song' ? t('uploadAudio') : t('uploadFillers')).click(); await setup.idle();
    expect(setup.root.querySelector('.media-status')!.textContent).toBe(t('audioBatchDone'));
    expect(kind === 'song' ? mocks.storeTrack : mocks.addFillerRecording).toHaveBeenCalledTimes(2);
    setup.manager.dispose();
  });

  it('does not overwrite authoritative metadata changed after a lost metadata response', async () => {
    const setup = await harness();
    mocks.storeTrack.mockResolvedValue({ id: 'local-song', title: 'original', duration: 20, firstBeat: 0, bodyArea: '', cues: [] });
    mocks.getTrackBlob.mockResolvedValue(setup.blob);
    setup.cloud.putLibraryMetadata.mockRejectedValueOnce(new Error('network_unavailable'));
    setup.cloud.libraryMetadata.mockResolvedValue({
      revision: 2, title: 'Concurrent title', artist: 'Another editor', filename: 'original.wav', duration: 20,
    });
    const files = setup.root.querySelectorAll('input').find(node => node.type === 'file')!;
    files.files = [new File([setup.blob], 'original.wav', { type: 'audio/wav' })]; files.dispatchEvent(new Event('change'));
    setup.button(t('uploadAudio')).click(); await setup.idle();
    setup.button(t('resumeAudioUpload')).click(); await setup.idle();
    expect(setup.cloud.uploadAsset).toHaveBeenCalledOnce(); expect(setup.cloud.recordLibraryIntake).toHaveBeenCalledOnce();
    expect(setup.cloud.putLibraryMetadata).toHaveBeenCalledOnce();
    expect(setup.button(t('resumeAudioUpload')).hidden).toBe(false);
    expect(setup.root.querySelector('.media-status')!.textContent).toBe(t('audioUploadMetadataFailed'));
    setup.manager.dispose();
  });

  it.each([true, false])('combines unsaved playlist references with the durable scan (complete=%s)', async complete => {
    const setup = await harness();
    const retained = { kind: 'routine' as const, id: 'saved', name: 'Retained history', revision: 2 };
    mocks.inspectLocalAudioReferences.mockResolvedValue({ references: [retained], complete });
    const playlist: MusicPlaylist = { schemaVersion: 2, id: 'open-playlist', name: 'Unsaved playlist', revision: 1,
      locked: false, published: false, tracks: [{ id: 'entry', title: 'Private', duration: 30, firstBeat: 0, bodyArea: '', cues: [] }] };
    const result = await checkLocalAudioUsage(setup.item, [{ playlist, media: { entry: setup.item.asset } }], () => {});
    expect(result.references).toEqual([retained, { kind: 'playlist', id: playlist.id, name: playlist.name, revision: 1 }]);
    expect(result.complete).toBe(complete);
    expect(mocks.inspectLocalAudioReferences).toHaveBeenCalledWith(setup.item.asset, undefined); setup.manager.dispose();
  });
});

describe('unified saved snapshots', () => {
  const setup = () => {
    const envelope: CloudRoutine = { routine: newRoutine(), media: {} };
    const copy: RoutineWorkingCopy = { envelope, localVersion: 1, cloudBaseRevision: 3, pendingCloud: true, savedAt: 1 };
    envelope.routine.revision = 3;
    let stored = structuredClone(copy);
    const library = { readHead: vi.fn(async (): Promise<CloudRoutine> => structuredClone(envelope)),
      stage: vi.fn(async (routine: Routine, media: CloudRoutine['media']) => structuredClone({ routine, media })),
      commit: vi.fn(async (value: CloudRoutine, base: number | null) => ({ ...structuredClone(value), routine: { ...value.routine, revision: (base ?? 0) + 1 } })) };
    mocks.getRoutineWorkingCopy.mockReset().mockImplementation(async () => structuredClone(stored));
    mocks.recordRoutineSyncAttempt.mockReset().mockImplementation(async (_id, localVersion, value, baseRevision) => {
      if (stored.localVersion !== localVersion) throw new Error('routine_conflict');
      stored.cloudAttempt = { envelope: structuredClone(value), localVersion, baseRevision };
    });
    mocks.acknowledgeRoutineWorkingCopy.mockReset().mockImplementation(async (_id, localVersion, value) => {
      if (stored.localVersion === localVersion) stored = { ...stored, envelope: structuredClone(value), cloudBaseRevision: value.routine.revision, pendingCloud: false };
      else if (stored.cloudAttempt?.localVersion === localVersion) stored.cloudBaseRevision = value.routine.revision;
      delete stored.cloudAttempt;
    });
    mocks.saveRoutineWorkingCopy.mockReset().mockImplementation(async (value, options) => {
      if (options.expectedLocalVersion !== stored.localVersion) throw new Error('routine_conflict');
      stored = { ...stored, envelope: structuredClone(value), localVersion: stored.localVersion + 1 };
      return structuredClone(stored);
    });
    return { copy, envelope, library, saver: createRoutineSave(library as unknown as ReturnType<typeof createCloudLibrary>) };
  };
  it('acknowledges a lost successful response by full authoritative content without another write', async () => {
    const { copy, envelope, library, saver } = setup();
    copy.cloudAttempt = { envelope: structuredClone(envelope), localVersion: 1, baseRevision: 3 };
    const saved = { routine: { ...envelope.routine, revision: 4, savedAt: 900 }, media: {} };
    library.readHead.mockResolvedValue(saved);
    await saver.sync(copy);
    expect(mocks.acknowledgeRoutineWorkingCopy).toHaveBeenCalledWith(envelope.routine.id, 1, saved);
    expect(library.stage).not.toHaveBeenCalled(); expect(library.commit).not.toHaveBeenCalled();
  });
  it('does not mistake a changed sequence at the next revision for its lost acknowledgment', async () => {
    const { copy, envelope, library, saver } = setup();
    copy.cloudAttempt = { envelope: structuredClone(envelope), localVersion: 1, baseRevision: 3 };
    library.readHead.mockResolvedValue({ routine: { ...envelope.routine, revision: 4, sequence: { crossfade: 3 } }, media: {} });
    await expect(saver.sync(copy)).rejects.toThrow();
    expect(mocks.acknowledgeRoutineWorkingCopy).not.toHaveBeenCalled(); expect(library.commit).not.toHaveBeenCalled();
  });
  it('refuses a locked head without changing the pending local snapshot', async () => {
    const { copy, envelope, library, saver } = setup();
    library.readHead.mockResolvedValue({ routine: { ...envelope.routine, locked: true }, media: {} });
    await expect(saver.sync(copy)).rejects.toThrow();
    expect(copy.pendingCloud).toBe(true); expect(library.stage).not.toHaveBeenCalled();
  });
  it('checks the local version immediately before committing to Cloud', async () => {
    const { copy, library, saver } = setup();
    mocks.getRoutineWorkingCopy.mockResolvedValue({ ...copy, localVersion: 2 });
    await expect(saver.sync(copy)).rejects.toThrow('routine_conflict');
    expect(library.commit).not.toHaveBeenCalled();
  });
  it('requires a recorded attempt even when an unrelated head has identical content', async () => {
    const { copy, envelope, library, saver } = setup();
    library.readHead.mockResolvedValue({ ...envelope, routine: { ...envelope.routine, revision: 4 } });
    await expect(saver.sync(copy)).rejects.toThrow();
    expect(mocks.acknowledgeRoutineWorkingCopy).not.toHaveBeenCalled(); expect(library.commit).not.toHaveBeenCalled();
  });
  it.each(['delayed', 'lost'] as const)('rebases B only from the proven %s acknowledgment of in-flight A', async outcome => {
    const { copy, envelope, library, saver } = setup();
    const gate = deferred();
    const savedA = { ...structuredClone(envelope), routine: { ...envelope.routine, revision: 4 } };
    library.commit.mockImplementationOnce(async () => {
      await gate.promise;
      library.readHead.mockResolvedValue(savedA);
      if (outcome === 'lost') throw new Error('network');
      return savedA;
    });
    const first = saver.sync(copy);
    await vi.waitFor(() => expect(library.commit).toHaveBeenCalledTimes(1));
    const newer = await mocks.saveRoutineWorkingCopy({ ...envelope, routine: { ...envelope.routine, name: 'B' } }, { expectedLocalVersion: 1 });
    expect(newer.cloudAttempt.envelope.routine.name).toBe(envelope.routine.name);
    gate.resolve();
    if (outcome === 'lost') {
      await expect(first).rejects.toThrow('network');
      await saver.sync(await mocks.getRoutineWorkingCopy());
    } else await first;
    expect(mocks.acknowledgeRoutineWorkingCopy).toHaveBeenCalledWith(envelope.routine.id, 1, savedA);
    expect(library.commit).toHaveBeenCalledTimes(2);
    expect(library.commit.mock.calls[1]![0].routine.name).toBe('B');
    expect(library.commit.mock.calls[1]![1]).toBe(4);
    expect((await mocks.getRoutineWorkingCopy()).pendingCloud).toBe(false);
    expect((await mocks.getRoutineWorkingCopy()).envelope.routine.name).toBe('B');
  });
  it('persists uploaded immutable descriptors before recording the commit attempt', async () => {
    const { copy, envelope, library, saver } = setup();
    const media = { entry: { id: 'uploaded', bytes: 44, contentType: 'audio/wav', sha256: 'a'.repeat(64) } };
    library.stage.mockResolvedValue({ ...envelope, media });
    await saver.sync(copy);
    expect(mocks.saveRoutineWorkingCopy).toHaveBeenCalledWith({ ...envelope, media }, expect.objectContaining({ expectedLocalVersion: 1 }));
    expect(mocks.recordRoutineSyncAttempt).toHaveBeenCalledWith(envelope.routine.id, 2, { ...envelope, media }, 3);
    expect(mocks.saveRoutineWorkingCopy.mock.invocationCallOrder[0]).toBeLessThan(mocks.recordRoutineSyncAttempt.mock.invocationCallOrder[0]!);
    expect(mocks.recordRoutineSyncAttempt.mock.invocationCallOrder[0]).toBeLessThan(library.commit.mock.invocationCallOrder[0]!);
  });
  it('retries the immutable outstanding A before B when the first request never committed', async () => {
    const { copy, envelope, library, saver } = setup();
    library.commit.mockRejectedValueOnce(new Error('network'));
    await expect(saver.sync(copy)).rejects.toThrow('network');
    const newer = await mocks.saveRoutineWorkingCopy({ ...envelope, routine: { ...envelope.routine, name: 'B after failed send' } }, { expectedLocalVersion: 1 });
    library.commit.mockImplementation(async (value, base) => {
      const saved = { ...structuredClone(value), routine: { ...value.routine, revision: (base ?? 0) + 1 } };
      library.readHead.mockResolvedValue(saved); return saved;
    });
    await saver.sync(newer);
    expect(library.commit.mock.calls.map(call => [call[0].routine.name, call[1]])).toEqual([
      [envelope.routine.name, 3], [envelope.routine.name, 3], ['B after failed send', 4],
    ]);
    expect(mocks.recordRoutineSyncAttempt).toHaveBeenCalledTimes(2);
    expect((await mocks.getRoutineWorkingCopy()).pendingCloud).toBe(false);
  });
  it('creates a stable Cloud identity at revision one from local revision nine and recovers a lost create response', async () => {
    const { copy, library, saver } = setup();
    copy.cloudBaseRevision = null; copy.envelope.routine.revision = 9;
    library.readHead.mockRejectedValueOnce(new CloudRequestError('cloud_http_error', 404));
    library.commit.mockImplementationOnce(async value => {
      library.readHead.mockResolvedValue(structuredClone(value));
      throw new Error('network');
    });
    await expect(saver.sync(copy)).rejects.toThrow('network');
    expect(library.commit.mock.calls[0]![0].routine).toMatchObject({ id: copy.envelope.routine.id, revision: 1 });
    const pending = await mocks.getRoutineWorkingCopy(); pending.cloudBaseRevision = null;
    await saver.sync(pending);
    expect(library.commit).toHaveBeenCalledTimes(1);
    expect((await mocks.getRoutineWorkingCopy()).pendingCloud).toBe(false);
  });
  it('ignores field order and save timestamps but compares immutable media descriptors', () => {
    const { envelope } = setup();
    const reordered: CloudRoutine = { media: {}, routine: { ...Object.fromEntries(Object.entries(envelope.routine).reverse()) } as Routine };
    expect(sameSavedContent(envelope, reordered)).toBe(true);
    reordered.media['entry'] = { id: 'asset', bytes: 44, contentType: 'audio/wav', sha256: 'a'.repeat(64) };
    expect(sameSavedContent(envelope, reordered)).toBe(false);
  });
});

describe('practice cue timing and countdowns', () => {
  const track: Track = { id: 'song', title: 'Song', duration: 30, bpm: 120, firstBeat: 2, bodyArea: '', cues: [] };

  it.each(['timestamp', 'interval'] as const)('clamps %s cues inside actual audio duration without changing metadata', kind => {
    const cue: Cue = { id: 'move', note: '<Move>', beep: false, anchor: { kind, seconds: 10 } };
    expect(cueAtSeconds(track, cue, -5, 20)).toEqual({ ...cue, anchor: { kind, seconds: 0 } });
    expect(cueAtSeconds(track, cue, 99, 20)).toEqual({ ...cue, anchor: { kind, seconds: 19.999 } });
    expect(cueAtSeconds(track, cue, 12.375, 40)).toEqual({ ...cue, anchor: { kind, seconds: 12.375 } });
    expect(cue.anchor).toEqual({ kind, seconds: 10 });
  });

  it('snaps to the nearest valid count and excludes a count at the song end', () => {
    const cue: Cue = { id: 'move', note: 'Move', beep: true, anchor: { kind: 'count', count: 5 } };
    expect(cueAtSeconds(track, cue, 4.26, 30)).toEqual({ ...cue, anchor: { kind: 'count', count: 6 } });
    expect(cueAtSeconds(track, cue, -10, 30)?.anchor).toEqual({ kind: 'count', count: 1 });
    const last = cueAtSeconds(track, cue, 99, 20)!;
    expect(last.anchor).toEqual({ kind: 'count', count: 36 });
    expect(cueSeconds(last, track)).toBe(19.5);
    expect(cueAtSeconds({ ...track, bpm: 60, firstBeat: 3 }, cue, 7.6, 30)?.anchor).toEqual({ kind: 'count', count: 6 });
    expect(cueAtSeconds({ ...track, firstBeat: 29.9995 }, cue, 99, 30)?.anchor).toEqual({ kind: 'count', count: 1 });
  });

  it('rejects invalid targets, durations and beat grids without mutating the cue', () => {
    const cue: Cue = { id: 'move', note: 'Move', anchor: { kind: 'count', count: 1 } };
    for (const duration of [0, -1, Number.NaN, Infinity]) expect(cueAtSeconds(track, cue, 2, duration)).toBeNull();
    expect(cueAtSeconds(track, cue, Infinity, 30)).toBeNull();
    expect(cueAtSeconds({ ...track, bpm: 0 }, cue, 2, 30)).toBeNull();
    expect(cueAtSeconds(track, cue, 2, 1)).toBeNull();
    expect(cue.anchor).toEqual({ kind: 'count', count: 1 });
  });

  it('uses ceiling runtime seconds, waits for unknown timing, and omits countdowns without a next cue', () => {
    expect(nextMoveCountdown({ nextCue: 'Move', nextCueIn: 1.01 })).toBe(t('nextIn', { time: '0:02' }));
    expect(nextMoveCountdown({ nextCue: 'Move', nextCueIn: 60.1 })).toBe(t('nextIn', { time: '1:01' }));
    expect(nextMoveCountdown({ nextCue: 'Move', nextCueIn: 0 })).toBe(t('nextIn', { time: '0:00' }));
    expect(nextMoveCountdown({ nextCue: 'Move', nextCueIn: null })).toBe(t('nextWaiting'));
    expect(nextMoveCountdown({ nextCue: 'Move', nextCueIn: Infinity })).toBe(t('nextWaiting'));
    expect(nextMoveCountdown({ nextCue: '', nextCueIn: null })).toBe('');
    expect(nextMoveCountdown({ nextCue: '', nextCueIn: 2 })).toBe('');
  });
});

describe('editor cue ordering', () => {
  it('normalizes a missing single warning to off while fingerprinting enabled warnings independently', () => {
    const routine = newRoutine();
    delete routine.beepOnceRemaining;
    const fingerprint = contentFingerprint(routine);
    routine.beepOnceRemaining = 0;
    expect(contentFingerprint(routine)).toBe(fingerprint);
    routine.beepOnceRemaining = 60;
    expect(contentFingerprint(routine)).not.toBe(fingerprint);
    expect(routine.beepRemaining).toBe(10);
    expect(routine.beepEvery).toBe(0);
  });

  it('sorts across anchors by source seconds and preserves equal-time order', () => {
    const track = { id: 'track', title: 'Track', duration: 30, bpm: 120, firstBeat: 2, bodyArea: '', cues: [
      { id: 'later', anchor: { kind: 'timestamp' as const, seconds: 10 }, note: 'Later' },
      { id: 'count', anchor: { kind: 'count' as const, count: 5 }, note: 'Count' },
      { id: 'interval', anchor: { kind: 'interval' as const, seconds: 4 }, note: 'Interval' },
      { id: 'timestamp', anchor: { kind: 'timestamp' as const, seconds: 4 }, note: 'Timestamp' },
    ] };
    expect(sortedCues(track, true).map(item => item.cue.id)).toEqual(['count', 'interval', 'timestamp', 'later']);
    expect(sortedCues(track, true).map(item => item.seconds)).toEqual([4, 4, 4, 10]);
    track.bpm = 60;
    track.firstBeat = 6;
    expect(sortedCues(track, true).map(item => item.cue.id)).toEqual(['interval', 'timestamp', 'later', 'count']);
  });

  it('retains invalid rows at the end in stable order while teaching omits them', () => {
    const track = { id: 'track', title: 'Track', duration: 30, bpm: 120, firstBeat: 0, bodyArea: '', cues: [
      { id: 'nan', anchor: { kind: 'timestamp' as const, seconds: Number.NaN }, note: 'Empty' },
      { id: 'end', anchor: { kind: 'interval' as const, seconds: 30 }, note: 'End' },
      { id: 'zero', anchor: { kind: 'timestamp' as const, seconds: 0 }, note: 'Start' },
      { id: 'negative', anchor: { kind: 'timestamp' as const, seconds: -1 }, note: 'Negative' },
      { id: 'count', anchor: { kind: 'count' as const, count: 0 }, note: 'Invalid count' },
      { id: 'infinity', anchor: { kind: 'timestamp' as const, seconds: Infinity }, note: 'Infinite' },
    ] };
    expect(sortedCues(track, true).map(item => item.cue.id)).toEqual(['zero', 'nan', 'end', 'negative', 'count', 'infinity']);
    expect(sortedCues(track, true).slice(1).every(item => Number.isNaN(item.seconds))).toBe(true);
    expect(sortedCues(track).map(item => item.cue.id)).toEqual(['zero']);
    track.bpm = Number.NaN;
    track.cues[4]!.anchor = { kind: 'count', count: 1 };
    expect(sortedCues(track, true).map(item => item.cue.id)).toEqual(['zero', 'nan', 'end', 'negative', 'count', 'infinity']);
  });
});

describe('track reordering', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const setup = async (rerender = true, count = 3) => {
    const owner = stubDocument();
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((handle: number) => { frames.delete(handle); }));
    const scrollBy = vi.fn();
    vi.stubGlobal('window', { innerWidth: 600, innerHeight: 800, scrollBy });
    const routine = newRoutine();
    routine.tracks = ['first', 'second', 'third'].slice(0, count).map((id, index) => ({ id, title: `<${id}>`, duration: 30,
      bpm: 120, firstBeat: 0.125, gain: 0.5 + index / 4, bodyArea: 'Legs', cues: [
        { id: `${id}-cue`, note: '<Move>', beep: true, anchor: { kind: 'timestamp', seconds: 2.125 } },
      ] }));
    const original = [...routine.tracks];
    const prepared = structuredClone(routine);
    for (const track of prepared.tracks) {
      for (const cue of track.cues) { Object.freeze(cue.anchor); Object.freeze(cue); }
      Object.freeze(track.cues); Object.freeze(track);
    }
    Object.freeze(prepared.tracks); Object.freeze(prepared);
    const state: PreviewState = { kind: 'track', trackId: 'first', elapsed: 3.125, duration: 30,
      playing: true, loading: false, error: null };
    const preview: AudioPreview = { playTrack: vi.fn(async () => {}), playFiller: vi.fn(async () => {}), pause: vi.fn(),
      stop: vi.fn(), seek: vi.fn(), dispose: vi.fn(), getState: () => ({ ...state }),
      subscribe: listener => { listener(state); return vi.fn(); } };
    const guards = { busy: false, current: true, author: true };
    const host = new TestElement('div'); owner.documentElement.append(host);
    const actual = await vi.importActual<typeof import('../frontend/src/editor')>('../frontend/src/editor');
    let session: ReturnType<typeof actual.renderEditor>;
    const changed = vi.fn((structural?: boolean) => { if (structural && rerender) { session.dispose(); session = render(); } });
    const render = () => {
      const result = actual.renderEditor(host as unknown as HTMLElement, routine, changed, { preview,
        detectBpm: vi.fn(), isBusy: () => guards.busy, isCurrent: () => guards.current, canEdit: () => guards.author });
      const list = host.querySelectorAll('.track-list')[0]!;
      vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 100, left: 100, right: 400,
        top: 100, bottom: 430, width: 300, height: 330 });
      host.querySelectorAll('details[data-track-id]').forEach((card, index) => {
        vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 110 + index * 100,
          left: 100, right: 400, top: 110 + index * 100, bottom: 200 + index * 100, width: 300, height: 90 });
      });
      return result;
    };
    session = render();
    const grip = (id = 'first') => host.querySelectorAll('.track-reorder-grip').find(button => button.dataset.trackId === id)!;
    const send = (target: TestElement, type: string, clientY: number, clientX = 130, pointerType = 'mouse', pointerId = 7) => {
      const event = Object.assign(new Event(type, { cancelable: true }), { clientX, clientY, pointerId, pointerType, button: 0, isPrimary: true });
      target.dispatchEvent(event); return event;
    };
    const tick = (time = 16) => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(time); };
    return { host, routine, original, prepared, preview, state, guards, changed, grip, send, tick, frames, scrollBy,
      get session() { return session; }, line: () => host.querySelectorAll('.track-insertion-line')[0]! };
  };

  it.each(['mouse', 'touch'])('commits a captured %s drop once, preserving references, expansion, focus and audition', async pointerType => {
    const fixture = await setup();
    const { host, routine, original, prepared, preview, state, grip, send, changed } = fixture;
    const before = structuredClone(routine);
    const cues = original.map(track => track.cues);
    const cards = host.querySelectorAll('details[data-track-id]');
    cards[2]!.open = true;
    const handle = grip();
    expect(send(handle, 'pointerdown', 140, 130, pointerType).defaultPrevented).toBe(true);
    expect(handle.hasPointerCapture(7)).toBe(true);
    send(handle, 'pointermove', 385, 130, pointerType);
    expect(fixture.line().hidden).toBe(false);
    expect(routine).toEqual(before);
    expect(host.querySelectorAll('details[data-track-id]')).toEqual(cards);
    expect(changed).not.toHaveBeenCalled();
    send(handle, 'pointerup', 385, 130, pointerType);
    await Promise.resolve();
    expect(routine.tracks.map(track => track.id)).toEqual(['second', 'third', 'first']);
    expect(routine.tracks[2]).toBe(original[0]);
    for (const [index, track] of original.entries()) {
      expect(routine.tracks.find(entry => entry.id === track.id)).toBe(track);
      expect(track.cues).toBe(cues[index]); expect(track).toEqual(before.tracks[index]);
    }
    expect(prepared).toEqual(before);
    expect(state).toMatchObject({ trackId: 'first', elapsed: 3.125, playing: true });
    for (const command of [preview.stop, preview.pause, preview.dispose, preview.playTrack, preview.seek]) expect(command).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    expect(grip()).not.toBe(handle); expect(document.activeElement).toBe(grip());
    expect(host.querySelectorAll('details[data-track-id]').filter(card => card.open).map(card => card.dataset.trackId)).toEqual(['third', 'first']);
    expect(host.querySelectorAll('.visually-hidden')[0]!.textContent).toBe(t('trackReordered', { name: '<first>', position: 3, count: 3 }));
    expect(handle.hasPointerCapture(7)).toBe(false); expect(fixture.frames.size).toBe(0);
    fixture.session.dispose();
  });

  it('inserts the last entry before the first midpoint without changing its cue or gain references', async () => {
    const fixture = await setup();
    const last = fixture.original[2]!;
    const cues = last.cues;
    const handle = fixture.grip('third');
    fixture.send(handle, 'pointerdown', 340);
    fixture.send(handle, 'pointermove', 120);
    expect(fixture.changed).not.toHaveBeenCalled();
    fixture.send(handle, 'pointerup', 120);
    await Promise.resolve();
    expect(fixture.routine.tracks.map(track => track.id)).toEqual(['third', 'first', 'second']);
    expect(fixture.routine.tracks[0]).toBe(last); expect(last.cues).toBe(cues); expect(last.gain).toBe(1);
    expect(fixture.changed).toHaveBeenCalledExactlyOnceWith(true); fixture.session.dispose();
  });

  it('rejects a final drop when the draft changed without an availability refresh', async () => {
    const fixture = await setup();
    const handle = fixture.grip();
    fixture.send(handle, 'pointerdown', 140); fixture.send(handle, 'pointermove', 385);
    fixture.routine.tracks[1]!.gain = 0.125;
    const expected = structuredClone(fixture.routine);
    fixture.send(handle, 'pointerup', 385);
    expect(fixture.routine).toEqual(expected); expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0); fixture.session.dispose();
  });

  it('requires more than five pixels, suppresses summary clicks, and ignores same-position drops and foreign pointers', async () => {
    const fixture = await setup();
    const handle = fixture.grip();
    fixture.send(handle, 'pointerdown', 140);
    fixture.send(handle, 'pointermove', 145);
    expect(fixture.line().hidden).toBe(true);
    fixture.send(handle, 'pointermove', 390, 130, 'touch', 8);
    fixture.send(handle, 'pointerup', 390, 130, 'touch', 8);
    expect(handle.hasPointerCapture(7)).toBe(true);
    fixture.send(handle, 'pointerup', 145);
    fixture.send(handle, 'pointerdown', 140);
    fixture.send(handle, 'pointermove', 146);
    expect(fixture.line().hidden).toBe(false);
    fixture.send(handle, 'pointerup', 146);
    const click = new Event('click', { cancelable: true }); handle.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.changed).not.toHaveBeenCalled();
    const input = fixture.host.querySelectorAll('input')[0]!;
    expect(fixture.send(input, 'pointerdown', 140).defaultPrevented).toBe(false);
    expect(fixture.frames.size).toBe(0); fixture.session.dispose();
  });

  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'outside-column', 'outside-list', 'outside-viewport',
    'busy', 'lock', 'published', 'role', 'tab', 'order', 'replacement', 'revision', 'draft', 'dispose', 'jobs', 'detached'])(
    'cancels without a reorder after %s', async reason => {
      const fixture = await setup();
      const { routine, guards, grip, send } = fixture;
      const handle = grip(); send(handle, 'pointerdown', 140); send(handle, 'pointermove', 385);
      if (reason === 'Escape') key(document, 'Escape');
      if (reason === 'pointercancel' || reason === 'lostpointercapture') send(handle, reason, 385);
      if (reason === 'outside-column') send(handle, 'pointermove', 385, 401);
      if (reason === 'outside-list') send(handle, 'pointermove', 431);
      if (reason === 'outside-viewport') send(handle, 'pointerup', 801);
      if (reason === 'busy') guards.busy = true;
      if (reason === 'lock') routine.locked = true;
      if (reason === 'published') routine.published = true;
      if (reason === 'role') guards.author = false;
      if (reason === 'tab') guards.current = false;
      if (reason === 'order') routine.tracks.reverse();
      if (reason === 'replacement') routine.tracks[0] = structuredClone(routine.tracks[0]!);
      if (reason === 'revision') routine.revision += 1;
      if (reason === 'draft') routine.name = 'Changed';
      if (reason === 'dispose') fixture.session.dispose();
      if (reason === 'jobs') fixture.session.cancelJobs();
      if (reason === 'detached') fixture.host.remove();
      const expected = structuredClone(routine);
      fixture.session.syncAvailability(); fixture.tick();
      send(handle, 'pointerup', 385);
      expect(routine).toEqual(expected); expect(fixture.changed).not.toHaveBeenCalled();
      expect(fixture.line().hidden).toBe(true); expect(handle.hasPointerCapture(7)).toBe(false);
      expect(fixture.frames.size).toBe(0); fixture.session.dispose();
    });

  it.each(['lock', 'published', 'busy', 'role', 'tab', 'single', 'capture-failed'])('rejects forced pointer and keyboard handlers for %s', async reason => {
    const fixture = await setup();
    const { routine, guards, grip, send } = fixture;
    const handle = grip();
    if (reason === 'lock') routine.locked = true;
    if (reason === 'published') routine.published = true;
    if (reason === 'busy') guards.busy = true;
    if (reason === 'role') guards.author = false;
    if (reason === 'tab') guards.current = false;
    if (reason === 'single') routine.tracks.splice(1);
    if (reason === 'capture-failed') vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => { throw new Error('capture'); });
    fixture.session.syncAvailability();
    const before = structuredClone(routine);
    send(handle, 'pointerdown', 140); send(handle, 'pointermove', 385); send(handle, 'pointerup', 385);
    if (reason !== 'capture-failed') {
      key(handle, 'ArrowDown');
      fixture.host.querySelectorAll('button').find(button => button.title === t('moveDown'))!.dispatchEvent(new Event('click'));
    }
    expect(routine).toEqual(before); expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0); fixture.session.dispose();
  });

  it('keeps keyboard and button moves ID-based and rejects detached or stale grips', async () => {
    const fixture = await setup(false);
    const handle = fixture.grip();
    handle.focus(); key(handle, 'ArrowUp'); expect(fixture.changed).not.toHaveBeenCalled();
    key(handle, 'ArrowDown'); expect(fixture.routine.tracks.map(track => track.id)).toEqual(['second', 'first', 'third']);
    const down = fixture.host.querySelectorAll('button').find(button => button.title === t('moveDown'))!;
    down.dispatchEvent(new Event('click'));
    expect(fixture.routine.tracks.map(track => track.id)).toEqual(['second', 'third', 'first']);
    down.dispatchEvent(new Event('click')); expect(fixture.changed).toHaveBeenCalledTimes(2);
    fixture.send(handle, 'pointerdown', 140); key(handle, 'ArrowUp');
    expect(handle.hasPointerCapture(7)).toBe(false); expect(fixture.changed).toHaveBeenCalledTimes(2);
    fixture.session.dispose();
    down.dispatchEvent(new Event('click')); expect(fixture.changed).toHaveBeenCalledTimes(2);
  });

  it('keeps a rendered single track inert for pointer, arrows and forced move buttons', async () => {
    const fixture = await setup(true, 1);
    const before = structuredClone(fixture.routine);
    const handle = fixture.grip();
    expect(handle.disabled).toBe(true);
    for (const pointerType of ['mouse', 'touch']) {
      expect(fixture.send(handle, 'pointerdown', 140, 130, pointerType).defaultPrevented).toBe(false);
      fixture.send(handle, 'pointermove', 385, 130, pointerType);
      fixture.send(handle, 'pointerup', 385, 130, pointerType);
    }
    key(handle, 'ArrowUp'); key(handle, 'ArrowDown');
    for (const label of [t('moveUp'), t('moveDown')]) {
      const button = fixture.host.querySelectorAll('button').find(entry => entry.title === label)!;
      expect(button.disabled).toBe(true);
      button.dispatchEvent(new Event('click'));
    }
    fixture.tick();
    expect(fixture.routine).toEqual(before); expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.line().hidden).toBe(true); expect(handle.hasPointerCapture(7)).toBe(false);
    expect(fixture.frames.size).toBe(0); fixture.session.dispose();
  });

  it('treats first-up and last-down arrows as no-ops and restores focus after a keyboard move', async () => {
    const fixture = await setup();
    const before = structuredClone(fixture.routine);
    fixture.grip().focus(); key(fixture.grip(), 'ArrowUp');
    key(fixture.grip('third'), 'ArrowDown');
    expect(fixture.routine).toEqual(before); expect(fixture.changed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(fixture.grip());
    key(fixture.grip('third'), 'ArrowUp');
    await Promise.resolve();
    expect(fixture.routine.tracks).toEqual([before.tracks[0], before.tracks[2], before.tracks[1]]);
    expect(fixture.routine.tracks[1]).toBe(fixture.original[2]);
    expect(document.activeElement).toBe(fixture.grip('third'));
    expect(fixture.host.querySelectorAll('.visually-hidden')[0]!.textContent)
      .toBe(t('trackReordered', { name: '<third>', position: 2, count: 3 }));
    expect(fixture.changed).toHaveBeenCalledExactlyOnceWith(true); fixture.session.dispose();
  });

  it('retains invalid cue text on the same draft and cue objects after keyboard reorder', async () => {
    const fixture = await setup();
    const value = fixture.host.querySelectorAll('.cue-row')[0]!.children[1]!.children[0]!;
    value.value = '1:60'; value.dispatchEvent(new Event('input'));
    fixture.changed.mockClear();
    const handle = fixture.grip(); handle.focus(); key(handle, 'ArrowDown');
    await Promise.resolve();
    expect(hasInvalidCueTimes(fixture.routine)).toBe(true);
    const row = fixture.host.querySelectorAll('.cue-row').find(entry => entry.dataset.cueId === 'first-cue')!;
    expect(row.children[1]!.children[0]!.value).toBe('1:60');
    expect(fixture.routine.tracks[1]).toBe(fixture.original[0]);
    expect(document.activeElement).toBe(fixture.grip());
    expect(fixture.changed).toHaveBeenCalledExactlyOnceWith(true);
    fixture.send(handle, 'pointerdown', 140); key(handle, 'ArrowDown');
    expect(fixture.changed).toHaveBeenCalledOnce(); fixture.session.dispose();
  });

  it.each([11.2, 430])('retains capture at fractional list edge %s when browser scroll distances round to pixels', async clientY => {
    const fixture = await setup();
    Object.assign(window, { innerHeight: 440 });
    const list = fixture.host.querySelectorAll('.track-list')[0]!;
    const bounds = { x: 100, y: 10.6, left: 100, right: 400, top: 10.6, bottom: 430.6, width: 300, height: 420 };
    vi.mocked(list.getBoundingClientRect).mockImplementation(() => ({ ...bounds }));
    fixture.scrollBy.mockImplementation(({ top }: { top: number }) => {
      bounds.top -= Math.round(top); bounds.bottom -= Math.round(top);
    });
    const handle = fixture.grip();
    fixture.send(handle, 'pointerdown', 140);
    fixture.send(handle, 'pointermove', clientY);
    fixture.tick(16); fixture.tick(32);
    expect(handle.hasPointerCapture(7)).toBe(true);
    expect(fixture.line().hidden).toBe(false);
    expect(fixture.frames.size).toBe(1);
    expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.routine.tracks).toEqual(fixture.original);
    fixture.session.dispose();
  });

  it('scrolls only an active drag with bounded animation frames and cancels on a guard change without a pointer event', async () => {
    const fixture = await setup();
    Object.assign(window, { innerHeight: 440 });
    const handle = fixture.grip();
    fixture.send(handle, 'pointerdown', 140); fixture.tick();
    expect(fixture.scrollBy).not.toHaveBeenCalled();
    fixture.send(handle, 'pointermove', 425); fixture.tick(10000);
    expect(fixture.scrollBy).toHaveBeenCalledWith({ top: expect.any(Number), behavior: 'instant' });
    expect(Math.abs(fixture.scrollBy.mock.calls[0]![0].top)).toBeLessThanOrEqual(32 * 0.72);
    expect(fixture.frames.size).toBe(1);
    fixture.guards.busy = true; fixture.tick(10016);
    expect(fixture.frames.size).toBe(0); expect(handle.hasPointerCapture(7)).toBe(false);
    expect(fixture.changed).not.toHaveBeenCalled(); fixture.session.dispose();
  });
});

describe('editor committed controls', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const setup = async (recordings: FillerRecording[] = []) => {
    stubDocument();
    const routine = newRoutine();
    delete routine.beepOnceRemaining;
    routine.tracks.push({ id: 'song', title: 'Song', duration: 30, bpm: 120, firstBeat: 0, bodyArea: '', cues: [
      { id: 'later', note: 'Later', anchor: { kind: 'timestamp', seconds: 10 } },
      { id: 'count', note: 'Count', anchor: { kind: 'count', count: 5 } },
      { id: 'equal', note: 'Equal', anchor: { kind: 'timestamp', seconds: 2 } },
    ] });
    const state: PreviewState = { kind: 'track', trackId: 'song', elapsed: 3.14159, duration: 30,
      playing: false, loading: false, error: null };
    const preview: AudioPreview = {
      playTrack: vi.fn(async () => {}), playFiller: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), seek: vi.fn(),
      getState: vi.fn(() => ({ ...state })), dispose: vi.fn(),
      subscribe: vi.fn(listener => { listener(state); return vi.fn(); }),
    };
    const detectBpm = vi.fn(async () => ({ bpm: 60, firstBeat: 8 }));
    const analyzeLoudness = vi.fn(async () => ({ integratedLufs: -22, peakDbfs: -6, targetLufs: -8, recommendedGain: 1.25, limited: true, clippingRisk: false }));
    const guards = { current: true, busy: false };
    const changed = vi.fn();
    const host = new TestElement('div');
    const actual = await vi.importActual<typeof import('../frontend/src/editor')>('../frontend/src/editor');
    const session = actual.renderEditor(host as unknown as HTMLElement, routine, changed,
      { preview, detectBpm, analyzeLoudness, fillerRecordings: () => recordings,
        isBusy: () => guards.busy, isCurrent: () => guards.current });
    const input = (label: string) => {
      const wrapper = host.querySelectorAll('label').find(node => node.textContent === label || node.children.some(child => child.textContent === label))!;
      return wrapper.children.find(child => ['input', 'select', 'textarea'].includes(child.tag))!;
    };
    const button = (label: string) => host.querySelectorAll('button').find(node => node.title === label)!;
    const rows = () => host.querySelectorAll('.cue-row');
    return { routine, track: routine.tracks[0]!, preview, state, detectBpm, analyzeLoudness, guards, changed, host, session, input, button, rows };
  };

  it('clones custom selections, retains archived choices, fingerprints metadata and clears the descriptor only on an explicit built-in choice', async () => {
    const recording: FillerRecording = { id: 'custom-a', name: '<Private recording>', duration: 8,
      asset: { id: 'asset-a', bytes: 128, sha256: 'a'.repeat(64), contentType: 'audio/wav' } };
    const recordings = [recording];
    const { routine, input, host, session, button, preview } = await setup(recordings);
    const before = contentFingerprint(routine);
    const sound = input(t('fillerSound'));
    sound.value = 'recording:custom-a'; sound.dispatchEvent(new Event('change'));
    expect(routine.filler.recording).toEqual(recording);
    expect(routine.filler.recording).not.toBe(recording);
    expect(routine.filler.recording!.asset).not.toBe(recording.asset);
    expect(contentFingerprint(routine)).not.toBe(before);
    expect(input(t('fillerBpm')).disabled).toBe(true);
    input(t('fillerGain')).value = '50'; input(t('fillerGain')).dispatchEvent(new Event('input'));
    expect(routine.filler.gain).toBe(0.5);
    recordings.length = 0;
    const fingerprint = contentFingerprint(routine);
    session.refreshFillers();
    expect(sound.value).toBe('recording:custom-a');
    expect(contentFingerprint(routine)).toBe(fingerprint);
    expect(host.querySelectorAll('option').find(option => option.value === 'recording:custom-a')!.textContent).toContain(recording.name);
    expect(host.querySelectorAll('option').find(option => option.value === 'recording:custom-a')!.textContent).toContain('8 s');
    button(t('previewFiller')).click();
    expect(preview.playFiller).toHaveBeenCalledWith(expect.objectContaining({ sound: 'recording', recording, gain: 0.5 }));
    sound.value = 'drums'; sound.dispatchEvent(new Event('change'));
    expect(routine.filler.recording).toBeUndefined();
    expect(routine.filler.sound).toBe('drums');
    expect(input(t('fillerBpm')).disabled).toBe(false);
    session.dispose();
  });

  it('shows active custom filler immediately after its collapsed track and distinguishes dormant or disabled rules', async () => {
    const { routine, track, session, host, preview, changed, button } = await setup();
    routine.tracks.push({ ...structuredClone(track), id: 'next-song', title: 'Next song' });
    const status = host.querySelectorAll('.after-track-status')[0]!;
    const details = host.querySelectorAll('.track-editor')[0]!;
    details.open = false;
    session.syncAvailability(); expect(status.hidden).toBe(true);
    track.after = { mode: 'custom', filler: { mode: 'hold', sound: 'drums', bpm: 100, seconds: 0, gain: 0.5 }, crossfade: 2 };
    session.syncAvailability();
    expect(status.hidden).toBe(false); expect(status.classList.contains('active')).toBe(true);
    expect(status.children[0]!.textContent).toBe(t('customGapActive', { name: track.title }));
    expect(status.children[1]!.textContent).toContain(t('drums'));
    expect(status.children[1]!.textContent).toContain(t('openHold'));
    expect(details.parentNode!.children[details.parentNode!.children.indexOf(details) + 1]).toBe(status);
    expect(button(t('afterTrack', { name: track.title })).attributes.get('aria-describedby')).toBe(`after-track-${track.id}`);
    routine.locked = true; session.syncAvailability();
    expect(status.hidden).toBe(false); expect(button(t('afterTrack', { name: track.title })).disabled).toBe(true);
    routine.tracks.reverse(); session.syncAvailability();
    expect(status.classList.contains('active')).toBe(false);
    expect(status.children[0]!.textContent).toBe(t('customGapInactive', { name: track.title }));
    routine.tracks.reverse();
    track.after.filler.mode = 'timed'; track.after.filler.seconds = 12; session.syncAvailability();
    expect(status.children[1]!.textContent).toContain('12 s'); expect(status.classList.contains('active')).toBe(true);
    track.after.filler.seconds = 0; session.syncAvailability(); expect(status.classList.contains('active')).toBe(false);
    track.after = { mode: 'none' }; session.syncAvailability();
    expect(status.children[0]!.textContent).toBe(t('customGapDisabled', { name: track.title }));
    delete track.after; session.syncAvailability(); expect(status.hidden).toBe(true);
    expect(changed).not.toHaveBeenCalled(); expect(preview.playFiller).not.toHaveBeenCalled(); session.dispose();
  });

  it('retains invalid text and last valid seconds, marks the draft invalid, and accepts fractional timestamp correction', async () => {
    const { routine, track, rows, session } = await setup();
    const row = rows().find(row => row.dataset.cueId === 'later')!;
    const value = row.children[1]!.children[0]!;
    expect(value.type).toBe('text');
    expect(value.value).toBe('0:10.0');
    for (const text of ['', '1:60', '-1', 'NaN']) {
      value.value = text; value.dispatchEvent(new Event('input')); value.dispatchEvent(new Event('change'));
      expect(value.value).toBe(text);
      expect(value.attributes.get('aria-invalid')).toBe('true');
      expect(track.cues.find(cue => cue.id === 'later')!.anchor).toEqual({ kind: 'timestamp', seconds: 10 });
      expect(hasInvalidCueTimes(routine)).toBe(true);
    }
    value.value = '0:12.375'; value.dispatchEvent(new Event('input'));
    expect(track.cues.find(cue => cue.id === 'later')!.anchor).toEqual({ kind: 'timestamp', seconds: 12.375 });
    expect(hasInvalidCueTimes(routine)).toBe(false);
    const count = rows().find(row => row.dataset.cueId === 'count')!.children[1]!.children[0]!;
    expect(count.type).toBe('number');
    count.value = '1.5'; count.dispatchEvent(new Event('input'));
    expect(hasInvalidCueTimes(routine)).toBe(true);
    expect(track.cues.find(cue => cue.id === 'count')!.anchor).toEqual({ kind: 'count', count: 5 });
    session.dispose();
  });

  it.each([10, 10.26, 0.25, 29.9])('preserves effective cue time across kinds and rounds count at %s', async seconds => {
    const { track, rows, session } = await setup();
    track.firstBeat = 1;
    const cue = track.cues.find(cue => cue.id === 'later')!;
    cue.beep = true;
    const row = rows().find(row => row.dataset.cueId === cue.id)!;
    const kind = row.children[0]!.children[0]!;
    const value = row.children[1]!.children[0]!;
    value.value = String(seconds); value.dispatchEvent(new Event('input'));
    kind.value = 'interval'; kind.dispatchEvent(new Event('change'));
    expect(cue.anchor).toEqual({ kind: 'interval', seconds });
    kind.value = 'count'; kind.dispatchEvent(new Event('change'));
    const count = Math.max(1, Math.min(58, Math.round(1 + (seconds - 1) * 2)));
    expect(cue.anchor).toEqual({ kind: 'count', count });
    if (cueSeconds(cue, track) !== seconds) expect(row.children.at(-1)!.textContent).toContain('Snapped');
    kind.value = 'timestamp'; kind.dispatchEvent(new Event('change'));
    expect(cue).toEqual({ id: 'later', note: 'Later', beep: true, anchor: { kind: 'timestamp', seconds: 1 + (count - 1) / 2 } });
    kind.value = 'interval'; kind.dispatchEvent(new Event('change'));
    expect(cue.anchor).toEqual({ kind: 'interval', seconds: 1 + (count - 1) / 2 });
    session.dispose();
  });

  it('blocks a kind change while typed time is invalid and retains text for correction', async () => {
    const { routine, track, rows, session } = await setup();
    const row = rows().find(row => row.dataset.cueId === 'later')!;
    const kind = row.children[0]!.children[0]!;
    const value = row.children[1]!.children[0]!;
    value.value = '1:60'; value.dispatchEvent(new Event('input'));
    kind.value = 'count'; kind.dispatchEvent(new Event('change'));
    expect(kind.value).toBe('timestamp'); expect(value.value).toBe('1:60');
    expect(row.children.at(-1)!.hidden).toBe(false);
    expect(row.children.at(-1)!.textContent).toBe(t('invalidCueTime'));
    expect(hasInvalidCueTimes(routine)).toBe(true);
    expect(track.cues.find(cue => cue.id === 'later')!.anchor).toEqual({ kind: 'timestamp', seconds: 10 });
    value.value = '0:12.5'; value.dispatchEvent(new Event('input'));
    kind.value = 'count'; kind.dispatchEvent(new Event('change'));
    expect(track.cues.find(cue => cue.id === 'later')!.anchor).toEqual({ kind: 'count', count: 26 });
    expect(hasInvalidCueTimes(routine)).toBe(false); session.dispose();
  });

  it('refuses duplicate of invalid typed time without clearing the original error or labels', async () => {
    const { routine, track, rows, session } = await setup();
    const actual = await vi.importActual<typeof import('../frontend/src/editor')>('../frontend/src/editor');
    const value = rows().find(row => row.dataset.cueId === 'later')!.children[1]!.children[0]!;
    value.value = '1:60'; value.dispatchEvent(new Event('input'));
    const before = structuredClone(routine);
    expect(() => actual.duplicateDraft(routine)).toThrow(t('invalidCueTime'));
    expect(routine).toEqual(before); expect(value.value).toBe('1:60');
    expect(actual.hasInvalidCueTimes(routine)).toBe(true);
    expect(track.cues.find(cue => cue.id === 'later')!.note).toBe('Later');
    session.dispose();
  });

  it('confirms the cue and track by plain text; Cancel preserves focus, content and audio', async () => {
    const { routine, track, button, preview, changed, session } = await setup();
    const remove = button(t('deleteCue'));
    const cue = structuredClone(track.cues.find(cue => cue.id === remove.parentNode!.dataset.cueId)!);
    remove.focus();
    vi.stubGlobal('confirm', vi.fn(() => false));
    remove.click();
    expect(confirm).toHaveBeenCalledWith(t('confirmDeleteCue', { track: track.title, cue: cue.note }));
    expect(track.cues).toContainEqual(cue);
    expect(document.activeElement).toBe(remove);
    expect(changed).not.toHaveBeenCalled();
    expect(preview.stop).not.toHaveBeenCalled();
    expect(preview.pause).not.toHaveBeenCalled();
    vi.mocked(confirm).mockImplementation(() => { routine.locked = true; return true; });
    remove.click(); expect(track.cues).toContainEqual(cue);
    routine.locked = false;
    vi.mocked(confirm).mockReturnValue(true); remove.click();
    expect(track.cues).not.toContainEqual(cue);
    expect(preview.stop).not.toHaveBeenCalled();
    session.dispose();
  });

  it('renders accessible percentage markers and both Add Cue commands sample the fresh playhead', async () => {
    const { host, track, state, preview, session } = await setup();
    const markers = host.querySelectorAll('.preview-cue-marker');
    expect(markers).toHaveLength(3);
    expect(markers[0]!.title).toBe(t('cuePreview', { time: '0:02.0', note: 'Count' }));
    expect(Number.parseFloat(markers[0]!.style.insetInlineStart)).toBeCloseTo(2 / 30 * 100);
    markers[0]!.click();
    expect(preview.seek).toHaveBeenCalledExactlyOnceWith(2);
    expect(track.cues).toHaveLength(3);
    const add = host.querySelectorAll('button').filter(button => button.title === t('addCue'));
    expect(add).toHaveLength(2);
    for (const [index, button] of add.entries()) {
      state.elapsed = 5.123456 + index;
      button.click();
      expect(track.cues.some(cue => cue.anchor.kind === 'timestamp' && cue.anchor.seconds === state.elapsed)).toBe(true);
    }
    expect(host.querySelectorAll('.preview-cue-marker')).toHaveLength(5);
    expect(preview.stop).not.toHaveBeenCalled(); session.dispose();
  });

  it('keeps saved gains independent and applies a loudness suggestion only explicitly', async () => {
    const { routine, track, preview, input, button, session } = await setup();
    expect(input(t('trackGain')).value).toBe('100'); expect(input(t('fillerGain')).value).toBe('100');
    input(t('fillerGain')).value = '75'; input(t('fillerGain')).dispatchEvent(new Event('input'));
    expect(routine.filler.gain).toBe(0.75); expect(track.gain).toBeUndefined();
    expect(preview.stop).not.toHaveBeenCalled();
    button(t('analyzeLoudness')).click();
    await vi.waitFor(() => expect(button(t('applyGain')).disabled).toBe(false));
    expect(track.gain).toBeUndefined(); expect(preview.stop).not.toHaveBeenCalled();
    button(t('applyGain')).click();
    expect(track.gain).toBe(1.25); expect(routine.filler.gain).toBe(0.75);
    expect(preview.stop).toHaveBeenCalledOnce(); session.dispose();
  });

  it.each([true, false])('shows clipping risk independently of a unity recommendation: %s', async clippingRisk => {
    const { track, host, analyzeLoudness, button, input, session } = await setup();
    analyzeLoudness.mockResolvedValue({ integratedLufs: -8, peakDbfs: clippingRisk ? 2 : -2,
      targetLufs: -8, recommendedGain: 1, limited: false, clippingRisk });
    button(t('analyzeLoudness')).click();
    await vi.waitFor(() => expect(button(t('applyGain')).disabled).toBe(false));
    const warning = host.querySelectorAll('.clipping-warning')[0]!;
    expect(warning.hidden).toBe(!clippingRisk);
    expect(warning.textContent).toBe(clippingRisk ? t('clippingWarning') : '');
    expect(host.querySelectorAll('.loudness-analysis')[0]!.children.some(node => node.textContent?.includes('100%'))).toBe(true);
    expect(input(t('trackGain')).value).toBe('100');
    expect(track.gain).toBeUndefined();
    input(t('trackGain')).value = '80'; input(t('trackGain')).dispatchEvent(new Event('input'));
    expect(warning.hidden).toBe(true); session.dispose();
  });

  it.each(['locked', 'replaced', 'removed', 'busy', 'gain'] as const)('discards a loudness result after %s changes', async reason => {
    const { routine, track, guards, analyzeLoudness, button, input, session } = await setup();
    const wait = deferred();
    analyzeLoudness.mockImplementation(async () => { await wait.promise; return { integratedLufs: -22, peakDbfs: -6, targetLufs: -8, recommendedGain: 1.25, limited: true, clippingRisk: false }; });
    button(t('analyzeLoudness')).click();
    if (reason === 'locked') routine.locked = true;
    if (reason === 'replaced') guards.current = false;
    if (reason === 'removed') routine.tracks = [];
    if (reason === 'busy') guards.busy = true;
    if (reason === 'gain') { input(t('trackGain')).value = '50'; input(t('trackGain')).dispatchEvent(new Event('input')); }
    session.syncAvailability(); wait.resolve();
    await wait.promise; await Promise.resolve();
    expect(button(t('applyGain')).disabled).toBe(true);
    expect(track.gain).toBe(reason === 'gain' ? 0.5 : undefined); session.dispose();
  });

  it('shows an independent bounded warning, keeps old defaults, and locks edits without locking auditions', async () => {
    const { routine, preview, host, input, button, session } = await setup();
    const warning = input(t('beepOnceRemaining'));
    expect(warning.value).toBe('0');
    expect(Object.assign({}, warning)).toEqual(expect.objectContaining({ min: '0', max: '1200' }));
    expect(input(t('beepRemaining')).value).toBe('10');
    expect(t('beepRemaining')).toMatch(/^Countdown /);
    expect(routine.beepOnceRemaining).toBeUndefined();
    warning.value = '45';
    warning.dispatchEvent(new Event('input'));
    expect(routine.beepOnceRemaining).toBe(45);
    expect(routine.beepRemaining).toBe(10);
    expect(routine.beepEvery).toBe(0);
    routine.locked = true;
    session.syncAvailability();
    expect(host.querySelectorAll('fieldset').every(fields => fields.disabled)).toBe(true);
    warning.value = '1200';
    warning.dispatchEvent(new Event('input'));
    expect(routine.beepOnceRemaining).toBe(45);
    expect(button(t('playPreview')).disabled).toBe(false);
    button(t('playPreview')).click();
    expect(preview.playTrack).toHaveBeenCalledOnce();
    expect(button(t('previewFiller')).disabled).toBe(false);
    button(t('previewFiller')).click();
    expect(preview.playFiller).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('reorders timestamp and count commits in place with invalid rows last and no audition reset', async () => {
    const { track, preview, rows, session } = await setup();
    const originalRows = new Map(rows().map(row => [row.dataset.cueId, row]));
    expect(rows().map(row => row.dataset.cueId)).toEqual(['count', 'equal', 'later']);
    const time = originalRows.get('later')!.children[1]!.children[0]!;
    time.focus();
    time.value = '1';
    time.dispatchEvent(new Event('input'));
    expect(rows().map(row => row.dataset.cueId)).toEqual(['count', 'equal', 'later']);
    time.dispatchEvent(new Event('change'));
    expect(rows().map(row => row.dataset.cueId)).toEqual(['later', 'count', 'equal']);
    expect(document.activeElement).toBe(time);
    const count = originalRows.get('count')!.children[1]!.children[0]!;
    count.value = '';
    count.dispatchEvent(new Event('input'));
    count.dispatchEvent(new Event('blur'));
    expect(rows().map(row => row.dataset.cueId)).toEqual(['later', 'equal', 'count']);
    expect(track.cues.map(cue => cue.id)).toEqual(['later', 'equal', 'count']);
    for (const row of rows()) expect(row).toBe(originalRows.get(row.dataset.cueId));
    expect(preview.stop).not.toHaveBeenCalled();
    expect(preview.playTrack).not.toHaveBeenCalled();
    session.dispose();
  });

  it('reorders BPM and first-beat commits and inserts a cue at sampled audio time without rebuilding rows', async () => {
    const { track, preview, rows, input, button, changed, session } = await setup();
    const countRow = rows()[0]!;
    const bpm = input(t('bpm'));
    bpm.value = '60';
    bpm.dispatchEvent(new Event('input'));
    expect(rows().map(row => row.dataset.cueId)).toEqual(['count', 'equal', 'later']);
    bpm.dispatchEvent(new Event('change'));
    expect(rows().map(row => row.dataset.cueId)).toEqual(['equal', 'count', 'later']);
    const firstBeat = input(t('firstBeat'));
    firstBeat.value = '8';
    firstBeat.dispatchEvent(new Event('input'));
    firstBeat.dispatchEvent(new Event('blur'));
    expect(rows().map(row => row.dataset.cueId)).toEqual(['equal', 'later', 'count']);
    button(t('addCue')).click();
    const inserted = track.cues[1]!;
    expect(inserted.anchor).toEqual({ kind: 'timestamp', seconds: 3.14159 });
    expect(rows().map(row => row.dataset.cueId)).toEqual(['equal', inserted.id, 'later', 'count']);
    expect(rows()[3]).toBe(countRow);
    expect(document.activeElement).toBe(rows()[1]!.children[2]!.children[0]);
    expect(preview.stop).not.toHaveBeenCalled();
    expect(preview.playTrack).not.toHaveBeenCalled();
    expect(changed.mock.calls.every(call => call[0] === false)).toBe(true);
    session.dispose();
  });

  it('applies both estimated BPM and first beat only on explicit approval and then reorders count cues', async () => {
    const { track, preview, input, button, rows, session } = await setup();
    button(t('detectBpm')).click();
    await vi.waitFor(() => expect(button(t('applyBpm')).disabled).toBe(false));
    expect(track.bpm).toBe(120);
    expect(track.firstBeat).toBe(0);
    button(t('applyBpm')).click();
    expect(track.bpm).toBe(60);
    expect(track.firstBeat).toBe(8);
    expect(input(t('firstBeat')).value).toBe('8');
    expect(rows().map(row => row.dataset.cueId)).toEqual(['equal', 'later', 'count']);
    expect(preview.stop).not.toHaveBeenCalled();
    session.dispose();
  });

  it('defaults to the detected BPM alternative and labels an explicit choice before applying it', async () => {
    const { track, host, detectBpm, button, session } = await setup();
    const estimate = { bpm: 80, firstBeat: 1.25, alternatives: [40, 80, 160], confidence: 0.4 };
    detectBpm.mockResolvedValueOnce(estimate);
    button(t('detectBpm')).click();
    await vi.waitFor(() => expect(button(t('applyBpm')).disabled).toBe(false));
    const alternatives = host.querySelectorAll('select').find(node => node.attributes.get('aria-label') === t('bpmAlternative'))!;
    expect(alternatives.value).toBe('80');
    expect(alternatives.children.map(option => option.value)).toEqual(['80', '40', '160']);
    alternatives.value = '160'; alternatives.dispatchEvent(new Event('change'));
    expect(host.querySelectorAll('p').some(node => node.textContent.includes('Estimated BPM: 160'))).toBe(true);
    expect(track.bpm).toBe(120); expect(track.firstBeat).toBe(0);
    button(t('applyBpm')).click();
    expect(track.bpm).toBe(160); expect(track.firstBeat).toBe(1.25);
    session.dispose();
  });

  it('keeps first beat and cue anchors unchanged for manual half, double and tap BPM', async () => {
    const { track, input, button, session } = await setup();
    input(t('firstBeat')).value = '2'; input(t('firstBeat')).dispatchEvent(new Event('input'));
    const cues = structuredClone(track.cues);
    button(t('halfBpm')).click(); expect(track.bpm).toBe(60); expect(track.firstBeat).toBe(2);
    button(t('doubleBpm')).click(); expect(track.bpm).toBe(120); expect(track.firstBeat).toBe(2);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(10000).mockReturnValueOnce(10600).mockReturnValueOnce(11200);
    button(t('tapTempo')).click(); button(t('tapTempo')).click(); button(t('tapTempo')).click();
    expect(track.bpm).toBe(100); expect(track.firstBeat).toBe(2);
    expect(new Map(track.cues.map(cue => [cue.id, cue]))).toEqual(new Map(cues.map(cue => [cue.id, cue])));
    clock.mockRestore(); session.dispose();
  });

  it('auditions recorded filler at original tempo and preserves synthetic BPM through choice and lock changes', async () => {
    const { routine, input, host, session, button, preview } = await setup();
    const sound = input(t('fillerSound'));
    const bpm = input(t('fillerBpm'));
    expect(sound.children).toHaveLength(1);
    expect(sound.children[0]!.tag).toBe('optgroup');
    expect(sound.querySelectorAll('option').map(option => option.textContent)).toEqual(
      (['lofi', 'soft', 'bright', 'drums'] as const).map(sound => fillerSoundLabel({ ...routine.filler, sound })));
    expect(routine.filler.sound).toBe('soft');
    sound.value = 'lofi';
    sound.dispatchEvent(new Event('change'));
    session.syncAvailability();
    expect(routine.filler.sound).toBe('lofi');
    expect(bpm.disabled).toBe(true);
    expect(host.querySelectorAll('output').find(output => output.textContent === t('originalTempo'))!.hidden).toBe(false);
    bpm.value = '180';
    bpm.dispatchEvent(new Event('input'));
    expect(routine.filler.bpm).toBe(100);
    routine.locked = true;
    session.syncAvailability();
    expect(button(t('previewFiller')).disabled).toBe(false);
    button(t('previewFiller')).click();
    expect(preview.playFiller).toHaveBeenCalledWith(expect.objectContaining({ sound: 'lofi', bpm: 100 }));
    routine.locked = false;
    sound.value = 'bright';
    sound.dispatchEvent(new Event('change'));
    session.syncAvailability();
    expect(bpm.disabled).toBe(false);
    expect(routine.filler.bpm).toBe(100);
    const mode = input(t('fillerMode'));
    mode.value = 'none';
    mode.dispatchEvent(new Event('change'));
    session.syncAvailability();
    expect(button(t('previewFiller')).disabled).toBe(true);
    session.dispose();
  });
});

describe('secure application bootstrap', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not import the app on insecure LAN HTTP and renders a readable HTTPS error', async () => {
    stubDocument();
    const root = new TestElement('div');
    const load = vi.fn(async () => {});
    await startApplication(root as unknown as HTMLElement, false, load);
    expect(load).not.toHaveBeenCalled();
    expect(root.attributes.get('role')).toBe('alert');
    expect(root.children[0]!.textContent).toBe(t('httpsRequired'));
    expect(root.children[1]!.textContent).toBe(t('httpsRequiredBody'));
  });

  it('imports on secure contexts, including trusted localhost, without weakening crypto', async () => {
    stubDocument();
    const root = new TestElement('div');
    const load = vi.fn(async () => {});
    await startApplication(root as unknown as HTMLElement, true, load);
    expect(load).toHaveBeenCalledOnce();
    expect(root.children).toHaveLength(0);
  });

  it('shows a concise error when secure startup fails', async () => {
    stubDocument();
    const root = new TestElement('div');
    await startApplication(root as unknown as HTMLElement, true, async () => { throw new Error('startup failed'); });
    expect(root.children[0]!.textContent).toBe(t('startupFailed'));
  });
});

describe('export panel controls', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const setup = () => {
    stubDocument();
    const routine = newRoutine();
    routine.name = '<Private routine>';
    routine.locked = true;
    const state = { routine, unsaved: true, busy: false };
    const actions = {
      excel: vi.fn(async (_snapshot: ExportSnapshot, _columns: readonly string[]) => new Blob(['xlsx'])),
      pdf: vi.fn(async (_snapshot: ExportSnapshot, _columns: readonly string[]) => new Blob(['pdf'])), download: vi.fn(),
    };
    const panel = createExportPanel(() => state, actions);
    const root = panel.element as unknown as TestElement;
    (document.documentElement as unknown as TestElement).append(root);
    const active = () => root.querySelectorAll('dialog').find(dialog => dialog.open)!;
    const button = (label: string) => active()?.querySelectorAll('button').find(node => node.title === label)
      ?? root.querySelectorAll('button').find(node => node.title === label)!;
    return { panel, root, state, actions, button, active };
  };

  it('starts collapsed and provides plain grouped fields with independent defaults and zero-selection guards for both formats', () => {
    const { root, button, active, actions } = setup();
    expect(root.tag).toBe('details'); expect(root.open).toBe(false);
    button(t('exportExcel')).click();
    expect(actions.excel).not.toHaveBeenCalled();
    const checkboxes = active().querySelectorAll('input').filter(input => input.type === 'checkbox');
    expect(checkboxes).toHaveLength(exportColumns.length);
    expect(active().querySelectorAll('legend')).toHaveLength(5);
    for (const checkbox of checkboxes) {
      expect(checkbox.disabled).toBe(false);
      expect(checkbox.parentNode!.tag).toBe('label');
      expect(checkbox.parentNode!.children[1]!.textContent.length).toBeGreaterThan(0);
      expect(checkbox.parentNode!.children[1]!.textContent).not.toMatch(/^Include /);
    }
    button(t('exportNone')).click();
    expect(checkboxes.every(checkbox => !checkbox.checked)).toBe(true);
    expect(button(t('exportDownload')).disabled).toBe(true);
    expect(active().querySelectorAll('.export-error')[0]!.hidden).toBe(false);
    button(t('exportAll')).click();
    expect(checkboxes.every(checkbox => checkbox.checked)).toBe(true);
    expect(button(t('exportDownload')).disabled).toBe(false);
    button(t('exportDefaults')).click();
    expect(checkboxes.filter(checkbox => checkbox.checked)).toHaveLength(defaultExportColumns().length);
    const checkbox = checkboxes.find(checkbox => !checkbox.checked)!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(active().querySelectorAll('output')[0]!.textContent).toBe(t('exportSelection', {
      selected: defaultExportColumns().length + 1, total: exportColumns.length,
    }));
    button(t('cancel')).click();
    button(t('exportPdf')).click();
    expect(active().querySelectorAll('input').filter(input => input.checked)).toHaveLength(defaultPdfColumns().length);
    button(t('exportNone')).click(); expect(button(t('exportDownload')).disabled).toBe(true);
    button(t('cancel')).click(); button(t('exportExcel')).click();
    expect(active().querySelectorAll('input').filter(input => input.checked)).toHaveLength(defaultExportColumns().length + 1);
  });

  it('expires zero-column feedback without enabling Download or closing the dialog on rerender', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { panel, button, active } = setup(); button(t('exportExcel')).click(); button(t('exportNone')).click();
    const dialog = active(); const feedback = dialog.querySelector('.export-error')!;
    vi.setSystemTime(20000); panel.syncAvailability();
    vi.setSystemTime(31001); document.dispatchEvent(new Event('visibilitychange'));
    expect(feedback.hidden).toBe(true); expect(dialog.open).toBe(true); expect(button(t('exportDownload')).disabled).toBe(true);
    panel.syncAvailability(); expect(feedback.hidden).toBe(true); panel.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('freezes the selected draft and columns before awaiting the download while allowing later edits', async () => {
    const { root, actions, state, button, active } = setup();
    const pending = deferred();
    actions.excel.mockImplementationOnce(async () => { await pending.promise; return new Blob(['xlsx']); });
    button(t('exportExcel')).click();
    expect(actions.excel).not.toHaveBeenCalled();
    active().querySelectorAll('input')[0]!.value = '../Selected.xlsx.xlsx';
    button(t('exportDownload')).click();
    expect(actions.excel).toHaveBeenCalledOnce();
    const [snapshot, columns] = actions.excel.mock.calls[0]!;
    expect(snapshot.routine.name).toBe('<Private routine>');
    expect(snapshot.routine.locked).toBe(true);
    expect(snapshot.unsaved).toBe(true);
    expect(Object.isFrozen(snapshot.routine)).toBe(true);
    expect(columns).toEqual(defaultExportColumns());
    state.routine.name = 'Different draft';
    button(t('exportAll')).click();
    expect(snapshot.routine.name).toBe('<Private routine>');
    expect(columns).toEqual(defaultExportColumns());
    expect(button(t('exportDownload')).disabled).toBe(true);
    expect(button(t('exportAll')).disabled).toBe(true);
    pending.resolve();
    await vi.waitFor(() => expect(actions.download).toHaveBeenCalledOnce());
    expect(actions.download.mock.calls[0]![1]).toBe('Selected.xlsx');
    expect(document.activeElement).toBe(button(t('exportExcel')));
    button(t('exportExcel')).click(); expect(active().querySelectorAll('input')[0]!.value).toBe('Different-draft.xlsx');
    expect(snapshot.routine.name).toBe('<Private routine>');
  });

  it('surfaces missing-font errors, restores actions and never claims a successful download', async () => {
    const { actions, button, active } = setup();
    actions.pdf.mockRejectedValueOnce(new Error(t('exportFontMissing')));
    button(t('exportPdf')).click();
    button(t('exportDownload')).click();
    await vi.waitFor(() => expect(button(t('exportDownload')).disabled).toBe(false));
    expect(actions.download).not.toHaveBeenCalled();
    expect(button(t('exportExcel')).disabled).toBe(false);
    const feedback = active().querySelectorAll('.export-feedback')[0]!;
    expect(feedback.attributes.get('role')).toBe('alert');
    expect(feedback.textContent).toBe(t('exportFontMissing'));
  });

  it.each(['Escape', 'Cancel'])('traps focus and returns it on %s, suppressing late downloads', async close => {
    const { button, active, actions } = setup();
    const pending = deferred();
    actions.pdf.mockImplementationOnce(async () => { await pending.promise; return new Blob(['pdf']); });
    const command = button(t('exportPdf')); command.click();
    const dialog = active();
    const filename = dialog.querySelectorAll('input')[0]!;
    expect(document.activeElement).toBe(filename);
    key(dialog, 'Tab', true); expect(document.activeElement).toBe(button(t('exportDownload')));
    key(dialog, 'Tab'); expect(document.activeElement).toBe(filename);
    button(t('exportDownload')).click();
    if (close === 'Escape') key(dialog, 'Escape'); else button(t('cancel')).click();
    expect(dialog.open).toBe(false); expect(document.activeElement).toBe(command);
    pending.resolve(); await pending.promise; await Promise.resolve();
    expect(actions.download).not.toHaveBeenCalled();
  });

  it.each(['excel', 'pdf'] as const)('disposal cancels pending %s without download or detached focus restoration', async format => {
    const { panel, root, actions, button, active } = setup();
    const pending = deferred();
    actions[format].mockImplementationOnce(async () => { await pending.promise; return new Blob(['private']); });
    button(t(format === 'excel' ? 'exportExcel' : 'exportPdf')).click();
    const dialog = active();
    button(t('exportDownload')).click();
    const focus = document.activeElement;
    root.remove(); panel.dispose(); panel.dispose();
    expect(dialog.open).toBe(false); expect(document.activeElement).toBe(focus);
    pending.resolve(); await pending.promise; await Promise.resolve(); await Promise.resolve();
    expect(actions.download).not.toHaveBeenCalled();
    expect(button(t('exportPdf')).disabled).toBe(true);
    button(t('exportPdf')).dispatchEvent(new Event('click'));
    expect(dialog.open).toBe(false);
  });

  it('respects editor busy state without disabling personal column selection', () => {
    const { state, panel, button } = setup();
    state.busy = true;
    panel.syncAvailability();
    expect(button(t('exportExcel')).disabled).toBe(true);
    expect(button(t('exportPdf')).disabled).toBe(true);
    expect(button(t('exportAll')).disabled).toBe(false);
  });
});

describe('class mode lifecycle', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const setup = () => {
    const owner = stubDocument();
    const root = new TestElement('div');
    const exit = new TestElement('button');
    const start = new TestElement('button');
    const changed = vi.fn();
    const mode = createClassMode(root as unknown as HTMLElement, exit as unknown as HTMLButtonElement,
      () => start.focus(), changed);
    return { owner, root, exit, start, changed, mode };
  };

  it('uses viewport mode without the fullscreen API, focuses Exit, and restores focus on Escape', () => {
    const { owner, root, exit, start, changed, mode } = setup();
    mode.enter();
    expect(root.classList.contains('class-mode')).toBe(true);
    expect(owner.documentElement.classList.contains('class-mode-open')).toBe(true);
    expect(exit.hidden).toBe(false);
    expect(owner.activeElement).toBe(exit);
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    owner.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(root.classList.contains('class-mode')).toBe(false);
    expect(exit.hidden).toBe(true);
    expect(owner.activeElement).toBe(start);
    expect(changed.mock.calls.map(call => call[0])).toEqual([true, false]);
    mode.dispose();
  });

  it.each(['reject', 'throw'] as const)('keeps viewport mode when fullscreen requests %s', async failure => {
    const { root, exit, mode } = setup();
    const request = vi.fn(() => {
      if (failure === 'throw') throw new Error('Unsupported fullscreen');
      return Promise.reject(new Error('Fullscreen denied'));
    });
    Object.assign(root, { requestFullscreen: request });
    mode.enter();
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    expect(root.classList.contains('class-mode')).toBe(true);
    exit.click();
    expect(root.classList.contains('class-mode')).toBe(false);
    mode.dispose();
  });

  it('requests fullscreen only on entry and handles native exit without restarting it', async () => {
    const { owner, root, start, mode } = setup();
    const request = vi.fn(async () => {
      owner.fullscreenElement = root;
      owner.dispatchEvent(new Event('fullscreenchange'));
    });
    Object.assign(root, { requestFullscreen: request });
    mode.enter();
    mode.enter();
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    owner.fullscreenElement = null;
    owner.dispatchEvent(new Event('fullscreenchange'));
    expect(root.classList.contains('class-mode')).toBe(false);
    expect(owner.activeElement).toBe(start);
    expect(request).toHaveBeenCalledOnce();
    mode.dispose();
  });

  it.each(['exit', 'dispose'] as const)('releases a late native fullscreen entry after %s', async action => {
    const { owner, root, changed, mode } = setup();
    const pending = deferred();
    const exitFullscreen = vi.fn(async () => { owner.fullscreenElement = null; });
    Object.assign(owner, { exitFullscreen });
    Object.assign(root, { requestFullscreen: vi.fn(() => pending.promise) });
    mode.enter();
    mode[action]();
    owner.fullscreenElement = root;
    pending.resolve();
    await pending.promise;
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(root.classList.contains('class-mode')).toBe(false);
    expect(changed.mock.calls.map(call => call[0])).toEqual([true, false]);
    mode.dispose();
  });

  it('removes document and exit handlers on disposal', () => {
    const { owner, root, exit, changed, mode } = setup();
    const removed = vi.spyOn(owner, 'removeEventListener');
    mode.enter();
    mode.dispose();
    changed.mockClear();
    owner.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    owner.dispatchEvent(new Event('fullscreenchange'));
    exit.click();
    mode.enter();
    expect(changed).not.toHaveBeenCalled();
    expect(root.classList.contains('class-mode')).toBe(false);
    expect(owner.documentElement.classList.contains('class-mode-open')).toBe(false);
    expect(removed.mock.calls.map(call => call[0])).toEqual(['fullscreenchange', 'keydown']);
  });
});

describe('transport cancellation', () => {
  it('cancels pending preparation before it loads or commits a snapshot', async () => {
    const readiness = deferred();
    const load = vi.fn();
    const pause = vi.fn();
    const operation = createTransportOperation(vi.fn(), vi.fn());
    const preparing = operation.run(async current => {
      await readiness.promise;
      if (current()) load();
    });
    expect(operation.pending).toBe(true);
    operation.cancel(pause);
    expect(pause).toHaveBeenCalledOnce();
    expect(operation.pending).toBe(false);
    readiness.resolve();
    await preparing;
    expect(load).not.toHaveBeenCalled();
  });

  it('blocks overlapping async commands but lets Stop cancel and a new command start', async () => {
    const oldCommand = deferred();
    const newCommand = deferred();
    const failed = vi.fn();
    const operation = createTransportOperation(vi.fn(), failed);
    const first = operation.run(() => oldCommand.promise);
    const overlap = vi.fn();
    await operation.run(overlap);
    expect(overlap).not.toHaveBeenCalled();
    const stop = vi.fn();
    operation.cancel(stop);
    expect(stop).toHaveBeenCalledOnce();
    const second = operation.run(() => newCommand.promise);
    oldCommand.reject(new Error('canceled'));
    await first;
    expect(failed).not.toHaveBeenCalled();
    expect(operation.pending).toBe(true);
    newCommand.resolve();
    await second;
    expect(operation.pending).toBe(false);
  });

  it('reports current failures and releases the pending state', async () => {
    const failed = vi.fn();
    const operation = createTransportOperation(vi.fn(), failed);
    const failure = new Error('audio_unavailable');
    await operation.run(async () => { throw failure; });
    expect(failed).toHaveBeenCalledWith(failure);
    expect(operation.pending).toBe(false);
  });
});

describe('offline shell status', () => {
  it('waits for ready and reports a waiting update without activating it', async () => {
    const ready = deferred();
    const registration = Object.assign(new EventTarget(), { installing: null, waiting: null as unknown, active: null });
    const worker = {
      register: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
      ready: ready.promise.then(() => registration as unknown as ServiceWorkerRegistration),
    };
    const status = vi.fn();
    const updateWaiting = vi.fn();
    const watching = watchOfflineShell(worker, status, updateWaiting);
    await vi.waitFor(() => expect(updateWaiting).toHaveBeenCalledWith(false));
    expect(worker.register).toHaveBeenCalledWith('/sw.js');
    expect(status).toHaveBeenCalledExactlyOnceWith('pending');
    const postMessage = vi.fn();
    registration.waiting = { postMessage };
    registration.dispatchEvent(new Event('updatefound'));
    expect(updateWaiting).toHaveBeenLastCalledWith(true);
    ready.resolve(); await watching;
    expect(status).toHaveBeenLastCalledWith('ready');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('reports registration failure instead of implying offline readiness', async () => {
    const worker = { register: vi.fn().mockRejectedValue(new Error('registration denied')),
      ready: new Promise<ServiceWorkerRegistration>(() => {}) };
    const status = vi.fn();
    await watchOfflineShell(worker, status, vi.fn());
    expect(status.mock.calls.map(call => call[0])).toEqual(['pending', 'failed']);
  });

  it('reports initial installation failure while ready is still pending', async () => {
    const installing = Object.assign(new EventTarget(), { state: 'installing' });
    const registration = Object.assign(new EventTarget(), { installing, waiting: null, active: null });
    const worker = { register: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
      ready: new Promise<ServiceWorkerRegistration>(() => {}) };
    const status = vi.fn();
    const updateWaiting = vi.fn();
    void watchOfflineShell(worker, status, updateWaiting);
    await vi.waitFor(() => expect(updateWaiting).toHaveBeenCalled());
    installing.state = 'redundant';
    installing.dispatchEvent(new Event('statechange'));
    expect(status).toHaveBeenLastCalledWith('failed');
  });
});

describe('pending filler import recovery', () => {
  it('queues a requested refresh until the owning editor lifecycle becomes available', async () => {
    vi.resetModules(); vi.resetAllMocks(); nodes.length = 0; stubDocument();
    const { createFillerLibrary } = await import('../frontend/src/filler-library');
    const { createCloudLibrary } = await import('../frontend/src/cloud-library');
    const recording: FillerRecording = { id: 'stored-filler', name: 'UserFiller', duration: 1,
      asset: { id: 'stored-asset', bytes: 128, sha256: 'b'.repeat(64), contentType: 'audio/wav' } };
    mocks.listFillerRecordings.mockResolvedValue([recording]);
    let busy = true;
    const panel = createFillerLibrary({ hosted: false, cloud: createCloudLibrary(),
      preview: mocks.preview as unknown as AudioPreview, busy: () => busy, isCurrent: () => true, changed: () => {} });
    await panel.refresh();
    expect(mocks.listFillerRecordings).not.toHaveBeenCalled();
    busy = false;
    panel.sync();
    await vi.waitFor(() => expect(panel.choices()).toEqual([recording]));
    expect(mocks.listFillerRecordings).toHaveBeenCalledOnce();
    panel.dispose();
    vi.unstubAllGlobals();
  });

  it.each(['500', '503', 'network', '400', 'cancel'] as const)('reuses only recoverable %s imports and never reuses cancelled or archived metadata', async failure => {
    vi.resetModules(); vi.resetAllMocks(); nodes.length = 0; stubDocument();
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { createFillerLibrary } = await import('../frontend/src/filler-library');
    const { createCloudLibrary } = await import('../frontend/src/cloud-library');
    const { cloudClient, CloudRequestError } = await import('../frontend/src/cloud-client');
    cloudClient.admitSession({ user: { id: 'editor', username: 'editor', role: 'editor', authVersion: 1 },
      csrfToken: 'fixture', expiresAt: Date.now() + 60_000 });
    const blob = new Blob([new Uint8Array(128)], { type: 'audio/wav' });
    const first: FillerRecording = { id: 'first-import', name: 'Loop', duration: 8,
      asset: { id: 'local-asset', bytes: 128, sha256: 'a'.repeat(64), contentType: 'audio/wav' } };
    const second = { ...first, id: 'second-import' };
    const authoritative = { ...first, id: 'cloud-recording' };
    mocks.addFillerRecording.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    mocks.getFillerRecordingBlob.mockResolvedValue(blob);
    mocks.removeFillerRecording.mockResolvedValue(undefined);
    const cloud = createCloudLibrary();
    let finish!: (recording: FillerRecording) => void;
    const waiting = new Promise<FillerRecording>(accept => { finish = accept; });
    const upload = vi.spyOn(cloud, 'addFiller').mockResolvedValue(authoritative);
    if (failure === 'cancel') upload.mockReturnValueOnce(waiting);
    else upload.mockRejectedValueOnce(failure === 'network' ? new CloudRequestError('network_unavailable')
      : new CloudRequestError('cloud_http_error', Number(failure), failure === '400' ? 'invalid_media' : 'storage_unavailable'));
    const panel = createFillerLibrary({ hosted: true, cloud, preview: mocks.preview as unknown as AudioPreview,
      isCurrent: () => true, changed: () => {} });
    const picker = nodes.find(node => node.tag === 'input' && node.type === 'file')!;
    picker.files = [new File([blob], 'Loop.wav', { type: blob.type })];
    picker.dispatchEvent(new Event('change'));
    const add = nodes.find(node => node.tag === 'button' && node.title === t('uploadFiller'))!;
    add.click();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    if (failure === 'cancel') {
      nodes.find(node => node.tag === 'button' && node.title === t('cancelFillerOperation'))!.click();
      finish(authoritative);
    }
    await vi.waitFor(() => expect(add.disabled).toBe(false));
    const recoverable = !['400', 'cancel'].includes(failure);
    expect(mocks.removeFillerRecording).toHaveBeenCalledTimes(recoverable ? 0 : 1);
    if (!recoverable) expect(mocks.removeFillerRecording).toHaveBeenCalledWith(first.id);
    add.click();
    await vi.waitFor(() => expect(panel.choices()).toEqual([authoritative]));
    expect(mocks.addFillerRecording).toHaveBeenCalledTimes(recoverable ? 1 : 2);
    expect(upload.mock.calls[1]![0]).toEqual(recoverable ? first : second);
    expect(mocks.removeFillerRecording).toHaveBeenLastCalledWith(recoverable ? first.id : second.id);
    const cleanupCount = mocks.removeFillerRecording.mock.calls.length;
    panel.leave(); panel.dispose();
    expect(mocks.removeFillerRecording).toHaveBeenCalledTimes(cleanupCount);
    vi.unstubAllGlobals();
  });
});

describe('real IndexedDB filler cancellation', () => {
  it('archives only the pending import after Cancel, leave, lost context or dispose while retaining both audio blobs', async () => {
    const { createServer } = await import('../frontend/node_modules/vite/dist/node/index.js');
    const { chromium } = await import('@playwright/test');
    const { resolve } = await import('node:path');
    const server = await createServer({ configFile: resolve('frontend/vite.config.ts'), root: resolve('frontend'),
      server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'filler-cancellation-regression', configureServer(instance) {
        instance.middlewares.use('/filler-cancellation', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><title>Filler cancellation</title><script type="module">
            import * as offline from '/src/offline.ts';
            import { createFillerLibrary } from '/src/filler-library.ts';
            import { createCloudLibrary } from '/src/cloud-library.ts';
            import { createAudioPreview } from '/src/audio-preview.ts';
            globalThis.fillerTest = { ...offline, createFillerLibrary, createCloudLibrary, createAudioPreview };
          </script>`);
        });
      } }] });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      for (const interruption of ['cancel', 'leave', 'context', 'dispose']) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${server.resolvedUrls!.local[0]}filler-cancellation`);
        await page.waitForFunction(() => 'fillerTest' in globalThis);
        const oldId = await page.evaluate(async ({ interruption, addLabel, cancelLabel }) => {
          const api = (globalThis as unknown as { fillerTest: typeof import('../frontend/src/offline')
            & typeof import('../frontend/src/filler-library') & typeof import('../frontend/src/cloud-library')
            & typeof import('../frontend/src/audio-preview') }).fillerTest;
          const blob = api.generateDemoWav(1, 100, 'soft');
          const file = new File([blob], 'Loop.wav', { type: 'audio/wav' });
          const existing = await api.addFillerRecording(file, 'Existing');
          let current = true;
          const panel = api.createFillerLibrary({ hosted: false, cloud: api.createCloudLibrary(),
            preview: api.createAudioPreview(), isCurrent: () => current, changed: () => {} });
          document.body.append(panel.element);
          await panel.refresh();
          let release!: () => void;
          let entered!: () => void;
          const held = new Promise<void>(accept => { release = accept; });
          const decoding = new Promise<void>(accept => { entered = accept; });
          const decode = OfflineAudioContext.prototype.decodeAudioData;
          OfflineAudioContext.prototype.decodeAudioData = function (bytes: ArrayBuffer) {
            return decode.call(this, bytes).then(async result => { entered(); await held; return result; });
          };
          const cleanup: string[] = [];
          const remove = IDBObjectStore.prototype.delete;
          IDBObjectStore.prototype.delete = function (key) {
            if (this.name === 'fillerRecordings') cleanup.push(String(key));
            return remove.call(this, key);
          };
          Object.assign(window, { fillerCleanup: cleanup });
          const picker = panel.element.querySelector<HTMLInputElement>('input[type="file"]')!;
          const transfer = new DataTransfer(); transfer.items.add(file); picker.files = transfer.files;
          picker.dispatchEvent(new Event('change'));
          panel.element.querySelector<HTMLButtonElement>(`button[aria-label="${addLabel}"]`)!.click();
          await decoding;
          if (interruption === 'cancel') panel.element.querySelector<HTMLButtonElement>(`button[aria-label="${cancelLabel}"]`)!.click();
          if (interruption === 'leave') { current = false; panel.leave(); }
          if (interruption === 'context') current = false;
          if (interruption === 'dispose') panel.dispose();
          release();
          return existing.id;
        }, { interruption, addLabel: t('addFiller'), cancelLabel: t('cancelFillerOperation') });
        await expect.poll(() => page.evaluate(() => (window as unknown as { fillerCleanup: string[] }).fillerCleanup.length)).toBe(1);
        const result = await page.evaluate(async () => {
          const api = (globalThis as unknown as { fillerTest: typeof import('../frontend/src/offline') }).fillerTest;
          const cleanup = (window as unknown as { fillerCleanup: string[] }).fillerCleanup;
          const catalog = await api.listFillerRecordings();
          const retained = await api.getTrackBlob(`filler-${cleanup[0]}`);
          return { ids: catalog.map(recording => recording.id), cleanup,
            retained: retained?.size, existing: (await api.getFillerRecordingBlob(catalog[0]!))?.size };
        });
        expect(result.ids).toEqual([oldId]);
        expect(result.cleanup).toHaveLength(1);
        expect(result.cleanup).not.toContain(oldId);
        expect(result.retained).toBeGreaterThan(44);
        expect(result.existing).toBe(result.retained);
        await context.close();
      }
    } finally { await browser.close(); await server.close(); }
  }, 60_000);
});

describe('inline class sequence', () => {
  beforeEach(() => {
    vi.resetAllMocks(); nodes.length = 0; stubDocument(); vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('confirm', vi.fn(() => true));
    mocks.listMusicPlaylists.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());
  function harness(initial: ClassSetup | null = null) {
    const routine = newRoutine(); routine.id = 'routine-a';
    const state = { saved: true, busy: false, selection: initial ? { setup: initial, source: 'local' as const } : null };
    const selected = vi.fn(value => { state.selection = value; });
    const component = createClassComposition({ hosted: false, routine: () => routine, routineSaved: () => state.saved,
      source: () => 'local', selection: () => state.selection, busy: () => state.busy, recordings: () => [],
      select: selected, managePlaylists: vi.fn(), message: vi.fn(), changed: vi.fn() });
    component.sync();
    const controls = component.controls as unknown as TestElement;
    const toggle = (label: string, value: boolean) => {
      const input = controls.querySelectorAll('label').find(node => node.textContent === label)!.children[0]!;
      input.checked = value; input.dispatchEvent(new Event('change'));
    };
    const button = (label: string) => controls.querySelectorAll('button').find(node => node.title === label)!;
    return { component, routine, state, selected, controls, toggle, button };
  }

  it('adopts owned phase snapshots with unique entry IDs and retains disabled choices in one routine', async () => {
    const fixture = harness();
    const arrival: MusicPlaylist = { schemaVersion: 1, id: 'arrival', name: 'Arrival', revision: 2, published: false, locked: false,
      tracks: [{ id: 'song', title: 'Song', duration: 30, firstBeat: 0, cues: [], bodyArea: '' }] };
    const departure = { ...arrival, id: 'departure', name: 'Departure' };
    mocks.listMusicPlaylists.mockResolvedValue([arrival, departure]);
    mocks.getMusicPlaylist.mockImplementation(async id => structuredClone(id === arrival.id ? arrival : departure));
    mocks.getTrackBlob.mockResolvedValue(new Blob([new Uint8Array(128)], { type: 'audio/wav' }));
    fixture.toggle(t('enableWalkIn'), true);
    await vi.waitFor(() => expect(fixture.controls.querySelectorAll('input').every(node => !node.disabled)).toBe(true));
    expect(fixture.component.pending()).toBe(true);
    fixture.toggle(t('enableWalkOut'), true); fixture.toggle(t('enableAfter'), true); fixture.toggle(t('enableBefore'), true);
    const before = fixture.component.beforeTracks as unknown as TestElement;
    const after = fixture.component.afterTracks as unknown as TestElement;
    expect(before.children.map(node => node.dataset.classPhase)).toEqual(['walkIn', 'before']);
    expect(after.children.map(node => node.dataset.classPhase)).toEqual(['after', 'walkOut']);
    for (const [root, index] of [[before, '0'], [after, '1']] as const) {
      const select = root.querySelectorAll('label').find(node => node.textContent === t('selectMusicPlaylist'))!.children[0]!;
      select.value = index; select.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(fixture.component.working()).toBe(false));
    }
    fixture.toggle(t('enableWalkIn'), false); expect(before.children.map(node => node.dataset.classPhase)).toEqual(['before']);
    fixture.toggle(t('enableWalkIn'), true);
    expect(fixture.routine.sequence?.walkIn?.name).toBe('Arrival');
    fixture.toggle(t('enableAfter'), false);
    expect(fixture.routine.sequence).toMatchObject({ walkIn: { source: { id: 'arrival', revision: 2 } }, walkOut: { source: { id: 'departure', revision: 2 } }, before: { mode: 'hold' } });
    expect(fixture.routine.sequence!.walkIn!.tracks[0]!.id).not.toBe(fixture.routine.sequence!.walkOut!.tracks[0]!.id);
    expect(fixture.routine.sequence!.walkIn!.tracks[0]!.id).not.toBe('song');
    expect(fixture.routine.sequence!.after).toBeUndefined(); expect(fixture.component.pending()).toBe(false);
    expect(mocks.saveClassSetup).not.toHaveBeenCalled(); expect(fixture.selected).not.toHaveBeenCalled();
    fixture.component.dispose();
  });

  it.each(['locked', 'published'] as const)('keeps %s routine phase controls read-only even on forced changes', flag => {
    const value: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Class', revision: 4, locked: false, published: false,
      routine: { id: 'routine-a', revision: 1, published: false }, crossfade: 2, [flag]: true };
    const fixture = harness(value);
    fixture.routine[flag] = true; fixture.component.sync();
    fixture.toggle(t('enableBefore'), true);
    expect(fixture.component.beforeTracks.children.length).toBe(0);
    expect(fixture.component.hasUnsaved()).toBe(false);
    expect(fixture.controls.querySelector('.phase-toggles')!.querySelectorAll('input').every(input => input.disabled)).toBe(true);
    expect(fixture.controls.querySelectorAll('fieldset').every(fieldset => fieldset.disabled)).toBe(true);
    expect(mocks.saveClassSetup).not.toHaveBeenCalled(); fixture.component.dispose();
  });

  it('does not block an already saved class while fetching playlist display names', async () => {
    const pending = deferred(); mocks.listMusicPlaylists.mockReturnValue(pending.promise.then(() => []));
    const value: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Class', revision: 4, locked: false, published: false,
      routine: { id: 'routine-a', revision: 1, published: false }, walkIn: { id: 'arrival', revision: 1, published: false }, crossfade: 2 };
    const fixture = harness(value);
    fixture.routine.sequence = { crossfade: 2, walkIn: { name: 'Arrival', tracks: [{ id: 'entry', title: 'Song', duration: 30, firstBeat: 0, bodyArea: '', cues: [] }] } };
    fixture.component.sync();
    const refresh = (fixture.component.beforeTracks as unknown as TestElement).querySelectorAll('button').find(button => button.title === t('refreshPlaylists'))!;
    refresh.click(); expect(fixture.component.working()).toBe(true);
    expect(fixture.component.pending()).toBe(false);
    pending.resolve(); await vi.waitFor(() => expect(fixture.component.working()).toBe(false));
    fixture.component.dispose();
  });

  it('preserves the routine when playlist adoption fails and keeps an unselected phase incomplete', async () => {
    const fixture = harness(); fixture.state.saved = false;
    fixture.toggle(t('enableBefore'), true);
    expect(fixture.routine.sequence?.before?.mode).toBe('hold'); expect(fixture.component.pending()).toBe(false);
    mocks.listMusicPlaylists.mockResolvedValue([{ schemaVersion: 1, id: 'unavailable', name: 'Missing', revision: 1, locked: false, published: false, tracks: [] }]);
    mocks.getMusicPlaylist.mockResolvedValue(null);
    fixture.toggle(t('enableWalkIn'), true);
    await vi.waitFor(() => expect(fixture.component.working()).toBe(false));
    const choice = (fixture.component.beforeTracks as unknown as TestElement).querySelector('select')!;
    choice.value = '0'; choice.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(fixture.component.working()).toBe(false));
    expect(fixture.routine.sequence?.before?.mode).toBe('hold'); expect(fixture.routine.sequence?.walkIn).toBeUndefined();
    expect(fixture.component.hasUnsaved()).toBe(true); expect(fixture.selected).not.toHaveBeenCalled();
    fixture.component.dispose();
  });
});

describe('dedicated playlist workspace', () => {
  let saved: Map<string, PlaylistWorkingCopy>;
  let local: Map<string, MusicPlaylist>;
  let selection: ActivePlaylistSelection | null;
  const sessions: ReturnType<typeof createPlaylistEditor>[] = [];
  const mix = (id: string, name = id): MusicPlaylist => ({ schemaVersion: 2, id, name, revision: 1, locked: false, published: false, tracks: [] });
  const song = (id: string): Track => ({ id, title: id, duration: 30, firstBeat: 0, bodyArea: '', cues: [], bpm: 100, gain: 1.4 });
  beforeEach(() => {
    vi.resetAllMocks(); nodes.length = 0; stubDocument(); vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', { onLine: false }); vi.stubGlobal('confirm', vi.fn(() => true));
    saved = new Map(); local = new Map(); selection = null;
    mocks.preview.getState.mockReturnValue({ kind: 'idle', trackId: null, playing: false, loading: false, elapsed: 0, duration: 0, error: null });
    mocks.preview.subscribe.mockReturnValue(() => {});
    mocks.listMusicPlaylists.mockImplementation(async () => structuredClone([...local.values()]));
    mocks.getMusicPlaylist.mockImplementation(async id => structuredClone(local.get(id) ?? null));
    mocks.listPlaylistWorkingCopies.mockImplementation(async () => structuredClone([...saved.values()]));
    mocks.getPlaylistWorkingCopy.mockImplementation(async id => structuredClone(saved.get(id) ?? null));
    mocks.listCachedMusicPlaylists.mockResolvedValue([]); mocks.listMusicPlaylistPublications.mockResolvedValue([]);
    mocks.listDraftRecoveries.mockResolvedValue([]); mocks.saveDraftRecovery.mockResolvedValue(undefined); mocks.removeDraftRecovery.mockResolvedValue(undefined);
    mocks.getActivePlaylistSelection.mockImplementation(async () => selection);
    mocks.setActivePlaylistSelection.mockImplementation(async value => { selection = structuredClone(value); });
    mocks.clearActivePlaylistSelection.mockImplementation(async () => { selection = null; });
    mocks.getTrackBlob.mockResolvedValue(new Blob([new Uint8Array(128)], { type: 'audio/wav' }));
    mocks.playlistSnapshot.mockImplementation(async (playlist, media) => structuredClone({ playlist, media }));
    mocks.savePlaylistWorkingCopy.mockImplementation(async (envelope: CloudMusicPlaylist, options) => {
      const previous = saved.get(envelope.playlist.id);
      if (options.expectedLocalVersion !== (previous?.localVersion ?? null)) throw new Error('playlist_conflict');
      const record = { envelope: structuredClone(envelope), localVersion: (previous?.localVersion ?? 0) + 1,
        cloudBaseRevision: options.cloudBaseRevision, pendingCloud: options.cloud, savedAt: 123456 };
      saved.set(envelope.playlist.id, record); local.set(envelope.playlist.id, structuredClone(envelope.playlist)); return structuredClone(record);
    });
  });
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function harness(hosted = false) {
    let externalBusy = false;
    const routine = newRoutine(); const message = vi.fn(); const working = vi.fn((value: boolean) => { externalBusy = value; });
    const session = createPlaylistEditor({ hosted, preview: mocks.preview as unknown as AudioPreview,
      busy: () => externalBusy, working, visible: () => true, known: () => [{ routine, media: {} }], returnToRoutine: vi.fn(), message });
    sessions.push(session);
    const root = session.element as unknown as TestElement;
    (document.documentElement as unknown as TestElement).append(root);
    await session.initialize();
    const button = (label: string, within = root) => within.querySelectorAll('button').find(node => node.title === label)!;
    const input = () => root.querySelectorAll('label').find(node => node.textContent === t('playlistName'))!.children[0]!;
    const changeName = (value: string) => { input().value = value; input().dispatchEvent(new Event('input')); };
    const settled = () => vi.waitFor(() => expect(session.working()).toBe(false));
    const modal = () => root.querySelectorAll('dialog').find(node => node.open && !node.classList.contains('playlist-chooser'))!;
    return { session, root, button, input, changeName, settled, modal, routine, message, working, block: (value: boolean) => { externalBusy = value; session.sync(); } };
  }
  it('saves locally with independent history and truthful metadata, and Close only clears playlist selection', async () => {
    const fixture = await harness(); const routine = structuredClone(fixture.routine);
    fixture.button(t('newPlaylist')).click(); fixture.changeName('<Arrival>');
    fixture.button(t('saveChanges')).click(); await fixture.settled();
    expect(mocks.savePlaylistWorkingCopy).toHaveBeenCalledWith(expect.anything(), { expectedLocalVersion: null, cloud: false, cloudBaseRevision: null });
    expect(mocks.playlistSync).not.toHaveBeenCalled(); expect(selection?.source).toBe('local');
    fixture.button(t('undoEdit')).click(); expect(fixture.input().value).toBe(t('newPlaylist'));
    fixture.button(t('redoEdit')).click(); expect(fixture.input().value).toBe('<Arrival>');
    fixture.button(t('closePlaylist')).click(); fixture.button(t('cancel'), fixture.modal()).click();
    expect(fixture.input().value).toBe('<Arrival>'); expect(document.activeElement).toBe(fixture.button(t('closePlaylist')));
    fixture.button(t('closePlaylist')).click(); fixture.button(t('discard'), fixture.modal()).click(); await fixture.settled();
    expect(mocks.clearActivePlaylistSelection).toHaveBeenCalledOnce(); expect(saved.size).toBe(1);
    expect(mocks.clearActiveRoutine).not.toHaveBeenCalled(); expect(mocks.player.unload).not.toHaveBeenCalled(); expect(fixture.routine).toEqual(routine);
  });
  it('preserves numbered songs, hidden BPM and legacy gain through undoable level and order edits', async () => {
    const value = mix('arrival'); value.tracks = [song('one'), song('two')]; local.set(value.id, value);
    const fixture = await harness(); fixture.button(t('openRoutine', { name: value.name })).click(); await fixture.settled();
    expect(fixture.root.querySelectorAll('.playlist-track-number').map(node => node.textContent)).toEqual(['1', '2']);
    expect(fixture.root.querySelectorAll('input').some(node => node.type === 'number')).toBe(false);
    const slider = () => fixture.root.querySelectorAll('input').find(node => node.type === 'range')!;
    expect(fixture.root.querySelectorAll('output')[0]!.textContent).toBe('140%');
    slider().value = '125'; slider().dispatchEvent(new Event('input')); fixture.button(t('undoEdit')).click();
    expect(fixture.root.querySelectorAll('output')[0]!.textContent).toBe('140%');
    fixture.button(t('moveDown')).click(); fixture.button(t('saveChanges')).click(); await fixture.settled();
    expect(saved.get(value.id)!.envelope.playlist.tracks.map(track => [track.id, track.bpm, track.gain])).toEqual([['two', 100, 1.4], ['one', 100, 1.4]]);
    expect(mocks.player.load).not.toHaveBeenCalled(); expect(mocks.preview.playTrack).not.toHaveBeenCalled();
  });
  it('serially imports cue-free entries, undoes the batch, and rejects excess files before decoding', async () => {
    const fixture = await harness(); fixture.button(t('newPlaylist')).click();
    const file = fixture.root.querySelectorAll('input').find(node => node.type === 'file')!;
    const first = deferred(); mocks.storeTrack.mockImplementationOnce(async () => { await first.promise; return { ...song('one'), cues: [{ id: 'cue' }], after: { mode: 'none' } }; })
      .mockResolvedValueOnce(song('two'));
    file.files = [new File(['a'], 'a.wav'), new File(['b'], 'b.wav')]; file.dispatchEvent(new Event('change'));
    expect(mocks.storeTrack).toHaveBeenCalledTimes(1); first.resolve(); await fixture.settled();
    expect(mocks.storeTrack).toHaveBeenCalledTimes(2); expect(fixture.root.querySelectorAll('.playlist-entry')).toHaveLength(2);
    fixture.button(t('undoEdit')).click(); expect(fixture.root.querySelectorAll('.playlist-entry')).toHaveLength(0);
    fixture.button(t('redoEdit')).click(); fixture.button(t('saveChanges')).click(); await fixture.settled();
    const entries = [...saved.values()][0]!.envelope.playlist.tracks;
    expect(entries.every(track => track.cues.length === 0 && track.after === undefined)).toBe(true);
    file.files = Array.from({ length: 99 }, () => new File(['x'], 'x.wav')); file.dispatchEvent(new Event('change'));
    expect(mocks.storeTrack).toHaveBeenCalledTimes(2); expect(fixture.message).toHaveBeenCalledWith(t('tooManyTracks'), true);
    expect(mocks.preview.playTrack).not.toHaveBeenCalled(); expect(mocks.player.play).not.toHaveBeenCalled();
  });
  it('stages Open before accepting Discard and preserves the current draft after failed Open or Cancel', async () => {
    const other = mix('other'); local.set(other.id, other);
    const fixture = await harness(); fixture.button(t('newPlaylist')).click(); fixture.changeName('Unsaved');
    fixture.button(t('openDifferentPlaylist')).click(); fixture.button(t('openRoutine', { name: other.name })).click();
    fixture.button(t('cancel'), fixture.modal()).click(); expect(fixture.input().value).toBe('Unsaved');
    fixture.button(t('openRoutine', { name: other.name })).click(); mocks.getMusicPlaylist.mockResolvedValueOnce(null);
    fixture.button(t('discard'), fixture.modal()).click(); await fixture.settled();
    expect(fixture.input().value).toBe('Unsaved'); expect(fixture.session.hasUnsaved()).toBe(true); expect(mocks.setActivePlaylistSelection).not.toHaveBeenCalled();
    fixture.button(t('cancel'), fixture.modal()).click();
    fixture.button(t('openRoutine', { name: other.name })).click(); fixture.button(t('discard'), fixture.modal()).click(); await fixture.settled();
    expect(fixture.input().value).toBe('other'); expect(selection?.id).toBe(other.id);
  });
  it('blocks saves during another editor transfer and preserves a dirty draft when a saved Cloud copy is acknowledged', async () => {
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('editor');
    vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => {});
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'online', user: null, expiresAt: null });
    const value = mix('queued'); const record: PlaylistWorkingCopy = { envelope: { playlist: value, media: {} }, localVersion: 1, cloudBaseRevision: null, pendingCloud: true, savedAt: 123456 };
    saved.set(value.id, record); selection = { id: value.id, source: 'household', published: false };
    const fixture = await harness(true); vi.stubGlobal('navigator', { onLine: true }); fixture.changeName('Not saved to Cloud'); fixture.block(true);
    expect(fixture.button(t('saveChanges')).disabled).toBe(true); fixture.button(t('saveChanges')).dispatchEvent(new Event('click'));
    expect(mocks.playlistSnapshot).not.toHaveBeenCalled(); fixture.block(false);
    mocks.playlistSync.mockImplementation(async () => ({ ...structuredClone(record), cloudBaseRevision: 1, pendingCloud: false }));
    await fixture.session.syncPending();
    expect(mocks.playlistSync).toHaveBeenCalledWith(record, expect.objectContaining({ signal: expect.any(AbortSignal) })); expect(fixture.input().value).toBe('Not saved to Cloud');
    expect(fixture.session.hasUnsaved()).toBe(true); expect(fixture.button(t('cloudPublish')).disabled).toBe(true);
    expect(mocks.player.load).not.toHaveBeenCalled();
  });
  it('keeps a null Cloud base across repeated local saves and displays pending work beside newer unsaved edits', async () => {
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('editor'); vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => {});
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'offline', user: null, expiresAt: null });
    const fixture = await harness(true); fixture.button(t('newPlaylist')).click();
    for (const title of ['First', 'Second']) {
      fixture.changeName(title); fixture.button(t('saveChanges')).click(); await fixture.settled();
    }
    expect(mocks.savePlaylistWorkingCopy.mock.calls.map(call => call[1])).toEqual([
      { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null },
      { expectedLocalVersion: 1, cloud: true, cloudBaseRevision: null },
    ]);
    fixture.changeName('Unsaved third');
    expect(fixture.root.querySelector('.playlist-save-status')!.textContent).toContain(t('unsaved'));
    expect(fixture.root.querySelector('.playlist-save-status')!.textContent).toContain(t('savedPending'));
    expect([...saved.values()][0]!.envelope.playlist.name).toBe('Second'); expect(mocks.playlistSync).not.toHaveBeenCalled();
  });
  it('keeps locked rows read-only even for dispatched mutations', async () => {
    const value = { ...mix('locked'), locked: true, tracks: [song('one')] }; local.set(value.id, value);
    const fixture = await harness(); fixture.button(t('openRoutine', { name: value.name })).click(); await fixture.settled();
    fixture.changeName('forged'); fixture.button(t('removePlaylistEntry')).dispatchEvent(new Event('click'));
    fixture.button(t('saveChanges')).dispatchEvent(new Event('click'));
    expect(fixture.root.querySelectorAll('.playlist-entry')).toHaveLength(1); expect(mocks.savePlaylistWorkingCopy).not.toHaveBeenCalled();
    expect(fixture.button(t('undoEdit')).disabled).toBe(true); expect(mocks.deleteMusicPlaylist).not.toHaveBeenCalled();
  });
  it('duplicates to a separately named ID and fresh entry IDs without deleting audio or changing the source', async () => {
    const value = mix('original'); value.tracks = [song('one')]; local.set(value.id, structuredClone(value));
    const fixture = await harness(); fixture.button(t('openRoutine', { name: value.name })).click(); await fixture.settled();
    fixture.button(t('duplicatePlaylist')).click(); const dialog = fixture.modal(); dialog.querySelector('input')!.value = 'Independent';
    fixture.button(t('duplicatePlaylist'), dialog).click(); await fixture.settled();
    expect(fixture.input().value).toBe('Independent'); fixture.button(t('saveChanges')).click(); await fixture.settled();
    const duplicate = [...saved.values()][0]!.envelope.playlist;
    expect(duplicate.id).not.toBe(value.id); expect(duplicate.tracks[0]!.id).not.toBe(value.tracks[0]!.id);
    expect(duplicate.tracks[0]).toMatchObject({ title: 'one', bpm: 100, gain: 1.4, cues: [] });
    expect(local.get(value.id)).toEqual(value); expect(mocks.cacheCloudTrack).toHaveBeenCalledOnce();
    expect(mocks.deleteMusicPlaylist).not.toHaveBeenCalled(); expect(mocks.player.load).not.toHaveBeenCalled();
  });
  it('lists playlist recovery separately and leaves a routine recovery untouched', async () => {
    const playlist = mix('recovered');
    const records: DraftRecovery[] = [
      { id: 'playlist-recovery', kind: 'playlist', source: 'local', value: playlist, baseRevision: 1, media: {}, updatedAt: 1000 },
      { id: 'routine-recovery', kind: 'routine', source: 'local', value: newRoutine(), baseRevision: 1, media: {}, updatedAt: 1000 },
    ];
    mocks.listDraftRecoveries.mockResolvedValue(records);
    const fixture = await harness(); const recovery = fixture.root.querySelector('.recovery-library')!;
    recovery.open = true; recovery.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(recovery.querySelectorAll('.routine-library-row')).toHaveLength(1));
    fixture.button(t('restoreCopy'), recovery).click(); await fixture.settled();
    expect(fixture.input().value).toBe(t('recoveryCopy', { name: playlist.name }));
    expect(mocks.removeDraftRecovery).not.toHaveBeenCalledWith('routine-recovery', expect.anything());
    expect(mocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
  });
  it('restores exact cached publications for players without enabling authoring or replacing editable copies', async () => {
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('player');
    vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => {});
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'offline', user: null, expiresAt: null });
    const publication = { playlist: { ...mix('published'), published: true, revision: 3, tracks: [song('one')] }, media: {} };
    mocks.listCachedMusicPlaylists.mockResolvedValue([publication]); mocks.getCachedMusicPlaylist.mockResolvedValue(publication);
    selection = { id: publication.playlist.id, source: 'household', published: true, revision: 3 };
    const fixture = await harness(true);
    expect(mocks.getCachedMusicPlaylist).toHaveBeenCalledWith('published', 3, true);
    expect(fixture.button(t('newPlaylist')).hidden).toBe(true); expect(fixture.button(t('saveChanges')).hidden).toBe(true);
    fixture.button(t('removePlaylistEntry')).dispatchEvent(new Event('click')); fixture.button(t('saveChanges')).dispatchEvent(new Event('click'));
    expect(fixture.root.querySelectorAll('.playlist-entry')).toHaveLength(1); expect(mocks.savePlaylistWorkingCopy).not.toHaveBeenCalled();
    expect(mocks.reconcilePlaylistWorkingCopy).not.toHaveBeenCalled(); expect(mocks.playlistSync).not.toHaveBeenCalled();
  });
  it('ignores a late saved-copy acknowledgment after disposal and aborts its transfer', async () => {
    vi.spyOn(cloudState, 'getCloudRole').mockReturnValue('editor'); vi.spyOn(cloudState, 'captureCloudIdentity').mockReturnValue(() => {});
    vi.spyOn(cloudState, 'getCloudContext').mockReturnValue({ access: 'online', user: null, expiresAt: null });
    const value = mix('pending'); const record: PlaylistWorkingCopy = { envelope: { playlist: value, media: {} }, localVersion: 1, cloudBaseRevision: null, pendingCloud: true, savedAt: 1000 };
    saved.set(value.id, record); selection = { id: value.id, source: 'household', published: false };
    const fixture = await harness(true); const gate = deferred(); vi.stubGlobal('navigator', { onLine: true });
    mocks.playlistSync.mockImplementation(async () => { await gate.promise; return { ...record, cloudBaseRevision: 1, pendingCloud: false }; });
    const pending = fixture.session.syncPending(); await vi.waitFor(() => expect(mocks.playlistSync).toHaveBeenCalledOnce());
    const signal = mocks.playlistSync.mock.calls[0]![1].signal as AbortSignal;
    fixture.session.dispose(); expect(signal.aborted).toBe(true); gate.resolve(); await pending;
    expect(mocks.setActivePlaylistSelection).not.toHaveBeenCalled(); expect(fixture.message).not.toHaveBeenCalled();
  });
});

describe('class panel saved references and local actions', () => {
  beforeEach(() => {
    vi.resetAllMocks(); nodes.length = 0; stubDocument(); vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('window', new EventTarget());
    mocks.listMusicPlaylists.mockResolvedValue([]); mocks.listClassSetups.mockResolvedValue([]); mocks.listRoutines.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());
  const panelHarness = async (routine = newRoutine()) => {
    const selected = vi.fn(); const message = vi.fn();
    const panel = createClassPanel({ hosted: false, draft: () => routine, busy: () => false, recordings: () => [], selected, message });
    const root = panel.element as unknown as TestElement;
    const button = (title: string) => root.querySelectorAll('button').find(node => node.title === title)!;
    root.open = true; root.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(button(t('newPlaylist')).disabled).toBe(false));
    const restore = (value: ClassSetup) => panel.restoreRecovery({ id: 'recovery-class', kind: 'class', source: 'local', value,
      baseRevision: value.revision, media: {}, updatedAt: 1 });
    return { panel, root, button, selected, message, restore };
  };

  it('retains legacy panel numbered songs, duration and undoable levels while preserving hidden BPM metadata', async () => {
    const track: Track = { id: 'unknown', title: 'Unknown', duration: 30, firstBeat: 0, bodyArea: '', cues: [] };
    const playlist: MusicPlaylist = { schemaVersion: 2, id: 'playlist', name: 'Settings mix', revision: 5, locked: false, published: false,
      tracks: [track, { ...track, id: 'known', title: 'Known', bpm: 100 }] };
    mocks.listMusicPlaylists.mockResolvedValue([playlist]);
    const routine = newRoutine(); const original = structuredClone(routine); const harness = await panelHarness(routine);
    harness.button(t('openRoutine', { name: playlist.name })).click();
    const inputs = () => harness.root.querySelectorAll('input').filter(node => node.type === 'range');
    await vi.waitFor(() => expect(inputs()).toHaveLength(2));
    expect(harness.root.querySelectorAll('.playlist-track-number').map(node => node.textContent)).toEqual(['1', '2']);
    expect(harness.root.querySelectorAll('.playlist-track-duration').map(node => node.textContent)).toEqual(['0:30', '0:30']);
    expect(harness.root.querySelectorAll('label').some(node => node.textContent === t('bpm'))).toBe(false);
    expect(harness.button(t('existingAudio')).disabled).toBe(false);
    const input = inputs()[0]!; input.value = '75'; input.dispatchEvent(new Event('input'));
    expect(harness.button(t('undoEdit')).disabled).toBe(false);
    harness.button(t('undoEdit')).click(); expect(inputs().map(input => input.value)).toEqual(['100', '100']);
    harness.button(t('redoEdit')).click(); expect(inputs().map(input => input.value)).toEqual(['75', '100']);
    mocks.saveMusicPlaylist.mockImplementation(async value => ({ ...structuredClone(value), revision: 6 }));
    harness.button(t('librarySave', { name: playlist.name, destination: t('localDestination') })).click();
    await vi.waitFor(() => expect(mocks.saveMusicPlaylist).toHaveBeenCalledOnce());
    expect(mocks.saveMusicPlaylist.mock.calls[0]![0].tracks.map((entry: Track) => entry.bpm)).toEqual([undefined, 100]);
    expect(mocks.saveMusicPlaylist.mock.calls[0]![0].tracks[0]!.gain).toBe(0.75);
    expect(routine).toEqual(original); expect(playlist.tracks[0]!.bpm).toBeUndefined(); expect(playlist.tracks[1]!.bpm).toBe(100);
    harness.panel.dispose();
  });

  it('refuses an unsaved routine without creating a partial class or enabling selection', async () => {
    const harness = await panelHarness();
    await harness.restore({ schemaVersion: 1, id: 'legacy', name: 'Legacy', revision: 1, published: false, locked: false,
      routine: { id: 'unavailable', revision: 1, published: false }, crossfade: 0 });
    expect(harness.button(t('useClass')).disabled).toBe(true);
    const reference = harness.root.querySelectorAll('label').find(node => node.textContent === t('routine'))!.children[0]!;
    expect(reference.children.filter(option => option.value)).toHaveLength(0);
    expect(harness.root.querySelectorAll('.reference-revision').some(node => node.textContent === t('saveRoutineFirst'))).toBe(true);
    harness.button(t('librarySave', { name: t('recoveryCopy', { name: 'Legacy' }), destination: t('localDestination') })).click();
    await vi.waitFor(() => expect(harness.message).toHaveBeenCalledWith(t('saveRoutineFirst'), true));
    expect(mocks.saveClassSetup).not.toHaveBeenCalled(); expect(harness.selected).not.toHaveBeenCalled();
    harness.panel.dispose();
  });

  it('requires an explicit known revision for a recovered historical reference without typed revision bypasses', async () => {
    const routine = newRoutine(); routine.id = 'routine-a'; routine.name = 'Current'; routine.revision = 5;
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Class', revision: 2, locked: false, published: false,
      routine: { id: routine.id, revision: 2, published: true }, crossfade: 1 };
    mocks.listRoutines.mockResolvedValue([routine]); mocks.getRoutine.mockResolvedValue({ ...routine, published: true });
    mocks.listClassSetups.mockResolvedValue([setup]); mocks.getClassSetup.mockResolvedValue(setup);
    const harness = await panelHarness(routine);
    await harness.restore(setup);
    const reference = harness.root.querySelectorAll('label').find(node => node.textContent === t('routine'))!.children[0]!;
    expect(reference.children.filter(option => option.value).map(option => JSON.parse(option.value))).toEqual([
      { id: routine.id, revision: 5, published: false }, { id: routine.id, revision: 5, published: true },
    ]);
    expect(reference.value).toBe(''); expect(harness.button(t('useClass')).disabled).toBe(true);
    const name = t('recoveryCopy', { name: setup.name });
    harness.button(t('librarySave', { name, destination: t('localDestination') })).click();
    await vi.waitFor(() => expect(harness.message).toHaveBeenCalledWith(t('saveRoutineFirst'), true));
    expect(mocks.saveClassSetup).not.toHaveBeenCalled();
    const currentReference = harness.root.querySelectorAll('label').find(node => node.textContent === t('routine'))!.children[0]!;
    currentReference.value = JSON.stringify({ id: routine.id, revision: 5, published: false }); currentReference.dispatchEvent(new Event('change'));
    mocks.saveClassSetup.mockImplementation(async value => ({ ...value, revision: 1 }));
    harness.button(t('librarySave', { name, destination: t('localDestination') })).click();
    await vi.waitFor(() => expect(harness.button(t('useClass')).disabled).toBe(false));
    expect(harness.root.querySelectorAll('label').some(node => node.textContent === t('referenceRevision') || node.textContent === t('referencePublished'))).toBe(false);
    harness.button(t('useClass')).click();
    expect(harness.selected).toHaveBeenLastCalledWith({ setup: expect.objectContaining({ name, revision: 1, routine: { id: routine.id, revision: 5, published: false } }), source: 'local' });
    expect(harness.selected.mock.lastCall![0].setup.id).not.toBe(setup.id);
    expect(routine.revision).toBe(5); expect(mocks.saveRoutine).not.toHaveBeenCalled();
    harness.panel.dispose();
  });

  it.each(['playlist', 'class'] as const)('deletes a saved %s using its head revision, preserving the routine', async kind => {
    const routine = newRoutine(); const snapshot = structuredClone(routine);
    const playlist: MusicPlaylist = { schemaVersion: 1, id: 'playlist-a', name: 'Playlist', revision: 4, locked: false, published: false, tracks: [] };
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Class', revision: 3, locked: false, published: false,
      routine: { id: routine.id, revision: 1, published: false }, crossfade: 1 };
    mocks.listMusicPlaylists.mockResolvedValue([playlist]); mocks.getMusicPlaylist.mockResolvedValue(playlist);
    mocks.listClassSetups.mockResolvedValue([setup]); mocks.getClassSetup.mockResolvedValue(setup);
    mocks.listRoutines.mockResolvedValue([routine]);
    const harness = await panelHarness(routine); let value = kind === 'class' ? setup : playlist;
    if (kind === 'class') {
      await harness.restore(setup); mocks.saveClassSetup.mockImplementation(async value => ({ ...value, revision: 3 }));
      harness.button(t('librarySave', { name: t('recoveryCopy', { name: setup.name }), destination: t('localDestination') })).click();
      await vi.waitFor(() => expect(harness.button(t('useClass')).disabled).toBe(false));
      value = await mocks.saveClassSetup.mock.results[0]!.value;
      expect(value.id).not.toBe(setup.id);
    } else harness.button(t('openRoutine', { name: value.name })).click();
    await vi.waitFor(() => expect(harness.button(t('libraryDelete', { name: value.name }))?.disabled).toBe(false));
    harness.button(t('libraryDelete', { name: value.name })).click();
    await vi.waitFor(() => expect(kind === 'class' ? mocks.deleteClassSetup : mocks.deleteMusicPlaylist).toHaveBeenCalledExactlyOnceWith(value.id, value.revision));
    expect(routine).toEqual(snapshot); expect(mocks.saveRoutine).not.toHaveBeenCalled();
    harness.panel.dispose();
  });
});

describe('UI persistence and transport wiring', () => {
  let records: Map<string, Routine>;
  let source: Routine;
  let playback: PlayerState;
  let emit: (state: PlayerState) => void;
  const button = (label: string) => nodes.find(node => node.className === 'edit-panel')?.querySelectorAll('button')
    .find(node => node.title === label) ?? nodes.find(node => node.tag === 'button' && node.title === label)!;
  const selection = () => nodes.find(node => node.tag === 'select' && node.attributes.get('aria-label') === t('savedRoutines'))!;
  const currentDraft = () => mocks.renderEditor.mock.lastCall![1] as Routine;
  const editName = (name: string) => {
    currentDraft().name = name;
    (mocks.renderEditor.mock.lastCall![2] as () => void)();
  };
  const settled = async () => {
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
  };
  const open = async () => { await import('../frontend/src/main'); await settled(); };
  const choose = (id: string) => { selection().value = id; selection().dispatchEvent(new Event('change')); };
  const duplicateRoutine = async () => {
    const previous = currentDraft().id; button(t('duplicate')).click();
    const dialog = nodes.filter(node => node.tag === 'dialog' && node.open).at(-1)!;
    dialog.querySelectorAll('button').find(node => node.title === t('apply'))!.click();
    await vi.waitFor(() => expect(currentDraft().id).not.toBe(previous)); await settled();
  };
  const seekControl = () => nodes.find(node => node.className === 'practice-seek')!;
  const handles = () => nodes.find(node => node.className === 'cue-handles')!;
  const marker = (id = 'move') => handles().children.find(node => node.dataset.cueId === id)!;
  const prepareCues = async (locked = false) => {
    source.locked = locked;
    source.tracks[0]!.cues = [
      { id: 'later', note: 'Later', anchor: { kind: 'timestamp', seconds: 25 } },
      { id: 'move', note: '<Move> & stretch', beep: true, anchor: { kind: 'timestamp', seconds: 10 } },
      { id: 'equal', note: 'Equal', beep: false, anchor: { kind: 'interval', seconds: 20 } },
    ];
    source.tracks.push({ ...structuredClone(source.tracks[0]!), id: 'track-b', title: 'Track B' });
    records.set(source.id, structuredClone(source));
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    if (!locked) button(t('editCueTimes')).click();
  };

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    nodes.length = 0;
    stubDocument();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('confirm', vi.fn(() => true));
    source = newRoutine(); source.name = 'Routine A'; source.revision = 4;
    source.tracks.push({ id: 'track-a', title: 'Track A', duration: 30, bpm: 120,
      firstBeat: 0, bodyArea: '', cues: [] });
    records = new Map([[source.id, structuredClone(source)]]);
    mocks.getRoutine.mockImplementation(async (id?: string) => structuredClone(records.get(id ?? source.id) ?? null));
    mocks.listRoutines.mockImplementation(async () => structuredClone([...records.values()]));
    mocks.listRoutineWorkingCopies.mockResolvedValue([]);
    mocks.getRoutineWorkingCopy.mockResolvedValue(null);
    mocks.listRoutinePublications.mockResolvedValue([]);
    mocks.listCloudRoutines.mockResolvedValue([]);
    const copies = new Map<string, RoutineWorkingCopy>();
    mocks.getRoutineWorkingCopy.mockImplementation(async id => structuredClone(copies.get(id) ?? null));
    mocks.listRoutineWorkingCopies.mockImplementation(async () => structuredClone([...copies.values()]));
    mocks.saveRoutineWorkingCopy.mockImplementation(async (envelope: CloudRoutine, options) => {
      const previous = copies.get(envelope.routine.id);
      if (options.expectedLocalVersion !== (previous?.localVersion ?? null)) throw new Error('routine_conflict');
      const savedAt = Date.now();
      const copy = { envelope: structuredClone(envelope), localVersion: (previous?.localVersion ?? 0) + 1,
        cloudBaseRevision: options.cloudBaseRevision, pendingCloud: options.cloud, savedAt };
      copy.envelope.routine.savedAt = savedAt; copies.set(envelope.routine.id, copy); return structuredClone(copy);
    });
    mocks.deleteRoutineWorkingCopy.mockImplementation(async (id, localVersion) => {
      if (copies.get(id)?.localVersion !== localVersion) throw new Error('routine_conflict'); copies.delete(id);
    });
    mocks.listClassSetups.mockResolvedValue([]);
    mocks.listMusicPlaylists.mockResolvedValue([]);
    mocks.getTrackBlob.mockResolvedValue(new Blob([new Uint8Array(128)], { type: 'audio/wav' }));
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
    mocks.listFillerRecordings.mockResolvedValue([]);
    mocks.removeFillerRecording.mockResolvedValue(undefined);
    mocks.getFillerRecordingBlob.mockResolvedValue(undefined);
    mocks.preview.playFiller.mockResolvedValue(undefined);
    mocks.setActiveRoutine.mockResolvedValue(undefined);
    mocks.saveRoutine.mockImplementation(async (routine: Routine, _expected: number | null, action: string) => {
      const saved = structuredClone(routine);
      saved.revision = (records.get(saved.id)?.revision ?? 0) + 1;
      if (action === 'lock') saved.locked = true;
      if (action === 'unlock') saved.locked = false;
      records.set(saved.id, structuredClone(saved));
      return saved;
    });
    mocks.createAudioPreview.mockReturnValue(mocks.preview);
    mocks.exportExcel.mockResolvedValue(new Blob(['xlsx']));
    mocks.exportPdf.mockResolvedValue(new Blob(['pdf']));
    mocks.renderEditor.mockImplementation((host: TestElement) => {
      const content = new TestElement('fieldset');
      content.dataset.editorContent = '';
      const preview = new TestElement('fieldset');
      preview.dataset.previewControls = '';
      host.replaceChildren(content, preview);
      return mocks.editorSession;
    });
    playback = { status: 'idle', trackIndex: 0, elapsed: 0, duration: 30, classElapsed: 0,
      currentCue: '', nextCue: '', nextCueIn: null, fillerRemaining: null, holding: false,
      ducked: false, beepsMuted: false, error: null };
    mocks.player.subscribe.mockImplementation(listener => { emit = listener; listener(playback); return vi.fn(); });
    mocks.getReadiness.mockResolvedValue({ ready: true, missing: [] });
    mocks.player.load.mockResolvedValue(undefined);
    mocks.player.play.mockImplementation(async () => { playback.status = 'playing'; emit(playback); });
    mocks.player.seek.mockImplementation(async (seconds: number) => { playback.elapsed = seconds; emit(playback); });
    mocks.player.pause.mockImplementation(() => { playback.status = 'paused'; emit(playback); });
    mocks.player.stop.mockImplementation(() => { playback.status = 'idle'; emit(playback); });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('unified app: automatically prepares the active routine silently on startup', async () => {
    await open();
    await vi.waitFor(() => expect(mocks.player.load).toHaveBeenCalledTimes(1));
    expect(mocks.player.play).not.toHaveBeenCalled();
    expect(button(t('newRoutine')).hidden).toBe(true);
    expect(button(t('retryPreparation')).hidden).toBe(true);
  });

  it('unified app: keeps explicit Retry after preparation fails and silently retries current content', async () => {
    mocks.player.load.mockRejectedValueOnce(new Error('missing_audio'));
    await open(); await settled();
    const retry = button(t('retryPreparation')); expect(retry.hidden).toBe(false);
    expect(mocks.player.play).not.toHaveBeenCalled();
    retry.click(); await vi.waitFor(() => expect(mocks.player.load).toHaveBeenCalledTimes(2)); await settled();
    expect(retry.hidden).toBe(true);
    expect(mocks.player.play).not.toHaveBeenCalled();
  });

  it('unified app: uses checkbox menus in one toolbar and recovery immediately after metadata', async () => {
    await open(); await settled();
    const panel = nodes.find(node => node.className === 'edit-panel')!;
    const identity = panel.querySelector('.draft-identity')!;
    const identityGroup = identity.parentNode!;
    expect(identityGroup.children[identityGroup.children.indexOf(identity) + 1]!.className).toBe('recovery-library');
    const library = nodes.find(node => node.className === 'routine-library')!;
    expect(library.hidden).toBe(true); button(t('openDifferent')).click(); expect(library.hidden).toBe(false);
    const toolbar = library.querySelector('.library-toolbar')!; expect(toolbar).not.toBeNull();
    const menus = toolbar.children.filter(node => node.tag === 'details'); expect(menus).toHaveLength(2);
    for (const menu of menus) {
      expect(menu.children[0]!.tag).toBe('summary'); expect(menu.children[1]!.attributes.get('role')).toBe('group');
      expect(menu.querySelectorAll('input').every(input => input.type === 'checkbox')).toBe(true);
      menu.open = true; key(menu, 'Escape'); expect(menu.open).toBe(false);
    }
    expect(panel.children.some(node => node.className === 'cloud-panel')).toBe(false);
    expect(library.querySelectorAll('h2')).toHaveLength(0);
  });

  it('unified app: restores adopted phase gain through the one routine Undo and Redo pair', async () => {
    source.sequence = { crossfade: 2, walkIn: { name: 'Arrival', tracks: [{ ...source.tracks[0]!, id: 'arrival', gain: 1.4 }] } };
    records.set(source.id, structuredClone(source)); await open(); await settled();
    const slider = () => nodes.filter(node => node.className === 'before-routine-phases').at(-1)!.querySelector('.gain-control')!.querySelector('input')!;
    slider().value = '115'; slider().dispatchEvent(new Event('input'));
    expect(currentDraft().sequence!.walkIn!.tracks[0]!.gain).toBe(1.15);
    button(t('undoEdit')).click(); expect(currentDraft().sequence!.walkIn!.tracks[0]!.gain).toBe(1.4);
    button(t('redoEdit')).click(); expect(currentDraft().sequence!.walkIn!.tracks[0]!.gain).toBe(1.15);
    expect(source.sequence.walkIn!.tracks[0]!.gain).toBe(1.4);
  });

  it('unified app: saves the whole working routine once locally and keeps Undo functional', async () => {
    mocks.saveRoutineWorkingCopy.mockImplementation(async (envelope, options) => {
      const value = { envelope: structuredClone(envelope), localVersion: 1, cloudBaseRevision: options.cloudBaseRevision, pendingCloud: options.cloud, savedAt: 1234 };
      value.envelope.routine.savedAt = 1234; return value;
    });
    await open();
    await vi.waitFor(() => expect(button(t('save')).disabled).toBe(false));
    editName('Unified edited');
    button(t('save')).click();
    await vi.waitFor(() => expect(mocks.saveRoutineWorkingCopy).toHaveBeenCalledTimes(1));
    await settled();
    expect(mocks.saveRoutineWorkingCopy.mock.calls[0]![1]).toEqual({ expectedLocalVersion: null, cloud: false, cloudBaseRevision: null });
    expect(mocks.saveRoutine).not.toHaveBeenCalled(); expect(mocks.saveClassSetup).not.toHaveBeenCalled();
    button(t('undoEdit')).click(); expect(currentDraft().name).toBe('Routine A'); expect(currentDraft().savedAt).toBe(1234);
    button(t('redoEdit')).click(); expect(currentDraft().name).toBe('Unified edited');
  });

  it('unified app: close Cancel retains the editor and Discard unloads without deleting data', async () => {
    await open(); await vi.waitFor(() => expect(button(t('closeRoutine')).disabled).toBe(false));
    editName('Unsaved close'); button(t('closeRoutine')).click();
    const dialog = nodes.filter(node => node.tag === 'dialog' && node.open).at(-1)!;
    dialog.querySelectorAll('button').find(node => node.title === t('cancel'))!.click();
    expect(currentDraft().name).toBe('Unsaved close'); expect(mocks.player.unload).not.toHaveBeenCalled();
    button(t('closeRoutine')).click();
    const closing = nodes.filter(node => node.tag === 'dialog' && node.open).at(-1)!;
    closing.querySelectorAll('button').find(node => node.title === t('discard'))!.click();
    await vi.waitFor(() => expect(mocks.player.unload).toHaveBeenCalledTimes(1));
    expect(mocks.clearActiveRoutine).toHaveBeenCalledTimes(1); expect(mocks.deleteRoutine).not.toHaveBeenCalled();
    expect(button(t('newRoutine')).hidden).toBe(false);
  });

  it('unified app: phase toggles are distinct steps in the single header history', async () => {
    await open(); await vi.waitFor(() => expect(button(t('save')).disabled).toBe(false));
    for (const phase of ['enableBefore', 'enableAfter'] as const) {
      const checkbox = nodes.find(node => node.tag === 'label' && node.textContent === t(phase))!.children[0]!;
      checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    }
    expect(currentDraft().sequence?.before).toBeDefined(); expect(currentDraft().sequence?.after).toBeDefined();
    button(t('undoEdit')).click(); expect(currentDraft().sequence?.before).toBeDefined(); expect(currentDraft().sequence?.after).toBeUndefined();
    button(t('redoEdit')).click(); expect(currentDraft().sequence?.after).toBeDefined();
    const heading = nodes.find(node => node.className === 'routine-title')!.parentNode!.parentNode!;
    expect(heading.querySelectorAll('.draft-protection')).toHaveLength(0);
    expect(nodes.find(node => node.classList.contains('editor-actions'))!.querySelectorAll('.draft-protection')).toHaveLength(1);
    expect(mocks.saveClassSetup).not.toHaveBeenCalled();
  });

  it('unified app: real editor name, cue and phase interactions share one history after Save', async () => {
    const { renderEditor } = await vi.importActual<typeof import('../frontend/src/editor')>('../frontend/src/editor');
    mocks.renderEditor.mockImplementation(renderEditor);
    const previewState: PreviewState = { kind: 'track', trackId: 'track-a', elapsed: 3, duration: 30, playing: false, loading: false, error: null };
    mocks.createAudioPreview.mockReturnValue({ ...mocks.preview, playTrack: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(),
      getState: () => previewState, subscribe: (listener: (state: PreviewState) => void) => { listener(previewState); return () => {}; } });
    await open(); button(t('edit')).click(); await settled();
    const host = () => mocks.renderEditor.mock.lastCall![0] as unknown as TestElement;
    const input = (label: string) => host().querySelectorAll('label').find(node => node.textContent === label)!.children[0]!;
    const nameLabel = host().querySelectorAll('label').find(node => node.textContent === t('routineName'))!;
    expect(nameLabel.querySelectorAll('button')).toHaveLength(0);
    expect(nameLabel.parentNode!.querySelectorAll('button')).toHaveLength(1);
    input(t('routineName')).value = 'Real editor history'; input(t('routineName')).dispatchEvent(new Event('input'));
    const addCue = host().querySelectorAll('button').find(node => node.title === t('addCue'))!;
    expect(addCue.disabled).toBe(false); addCue.click();
    expect(currentDraft().tracks[0]!.cues).toHaveLength(1);
    const checkbox = nodes.find(node => node.tag === 'label' && node.textContent === t('enableBefore'))!.children[0]!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    button(t('save')).click(); await vi.waitFor(() => expect(mocks.saveRoutineWorkingCopy).toHaveBeenCalledOnce()); await settled();
    const savedAt = currentDraft().savedAt; const revision = currentDraft().revision;
    button(t('undoEdit')).click(); expect(currentDraft().sequence?.before).toBeUndefined();
    expect(currentDraft().tracks[0]!.cues).toHaveLength(1);
    button(t('undoEdit')).click(); expect(currentDraft().tracks[0]!.cues).toHaveLength(0);
    button(t('undoEdit')).click(); expect(currentDraft().name).toBe('Routine A');
    expect(currentDraft().revision).toBe(revision); expect(currentDraft().savedAt).toBe(savedAt);
    for (let step = 0; step < 3; step++) button(t('redoEdit')).click();
    expect(currentDraft().name).toBe('Real editor history'); expect(currentDraft().tracks[0]!.cues).toHaveLength(1);
    expect(currentDraft().sequence?.before).toBeDefined(); expect(mocks.saveClassSetup).not.toHaveBeenCalled();
    const heading = nodes.find(node => node.className === 'routine-title')!.parentNode!.parentNode!;
    expect(heading.querySelectorAll('.draft-protection')).toHaveLength(0);
    expect(nodes.find(node => node.classList.contains('editor-actions'))!.querySelectorAll('.draft-protection')).toHaveLength(1);
  });

  it('unified app: local row Open awaits active identity before replacing the editor', async () => {
    const other = { ...structuredClone(source), id: 'other-local', name: 'Other local' };
    const copy: RoutineWorkingCopy = { envelope: { routine: other, media: {} }, localVersion: 7, cloudBaseRevision: null, pendingCloud: false, savedAt: 1 };
    mocks.listRoutineWorkingCopies.mockResolvedValue([copy]); mocks.getRoutineWorkingCopy.mockResolvedValue(copy);
    await open(); button(t('openDifferent')).click();
    const gate = deferred(); mocks.setActiveRoutine.mockReturnValueOnce(gate.promise);
    nodes.find(node => node.className === 'routine-library-rows')!.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: other.name }))!.click();
    await vi.waitFor(() => expect(mocks.setActiveRoutine).toHaveBeenCalledWith(other.id));
    expect(currentDraft().id).toBe(source.id);
    gate.resolve(); await settled(); expect(currentDraft().id).toBe(other.id);
  });

  it('unified app: explicit working-copy Delete uses local CAS without requiring a legacy saved head or deleting media', async () => {
    records.clear();
    const copy: RoutineWorkingCopy = { envelope: { routine: structuredClone(source), media: {} }, localVersion: 11, cloudBaseRevision: null, pendingCloud: false, savedAt: 1 };
    mocks.getRoutine.mockResolvedValue(source); mocks.listRoutineWorkingCopies.mockResolvedValue([copy]);
    mocks.getRoutineWorkingCopy.mockResolvedValue(copy); mocks.deleteRoutineWorkingCopy.mockResolvedValue(undefined);
    await open(); expect(button(t('localDelete')).disabled).toBe(false); button(t('localDelete')).click();
    await vi.waitFor(() => expect(mocks.deleteRoutineWorkingCopy).toHaveBeenCalledExactlyOnceWith(source.id, 11));
    expect(mocks.deleteRoutine).not.toHaveBeenCalled(); expect(mocks.cacheCloudTrack).not.toHaveBeenCalled();
    expect(mocks.player.unload).not.toHaveBeenCalled(); await vi.waitFor(() => expect(button(t('newRoutine')).hidden).toBe(false));
  });

  it('unified app: cold local chooser enumerates a publication older than its current draft head', async () => {
    const publication = { ...structuredClone(source), name: 'Old publication', revision: 2, published: true };
    mocks.listRoutinePublications.mockResolvedValue([publication]);
    mocks.getRoutine.mockImplementation(async (_id, revision, published) => structuredClone(published && revision === 2 ? publication : source));
    await open(); button(t('openDifferent')).click();
    const gate = deferred(); mocks.setActiveRoutineSelection.mockReturnValueOnce(gate.promise);
    nodes.find(node => node.className === 'routine-library-rows')!.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: publication.name }))!.click();
    await vi.waitFor(() => expect(mocks.setActiveRoutineSelection).toHaveBeenCalledExactlyOnceWith({ id: source.id, revision: 2, published: true }));
    expect(currentDraft()).toEqual(source); gate.resolve(); await settled();
    expect(currentDraft()).toEqual(publication); expect(button(t('save')).disabled).toBe(true);
    expect(mocks.getRoutine).toHaveBeenCalledWith(source.id, 2, true);
    expect(mocks.setActiveRoutine).not.toHaveBeenCalled();
    button(t('openDifferent')).click();
    expect(nodes.find(node => node.className === 'routine-library-rows')!.querySelectorAll('button')
      .some(node => node.title === t('openRoutine', { name: source.name }))).toBe(true);
    nodes.find(node => node.className === 'routine-library-rows')!.querySelectorAll('button')
      .find(node => node.title === t('openRoutine', { name: source.name }))!.click();
    await vi.waitFor(() => expect(mocks.setActiveRoutine).toHaveBeenCalledExactlyOnceWith(source.id)); await settled();
    expect(currentDraft()).toEqual(source);
  });

  it('unified app: failed publication selection keeps the current draft and prepared audio', async () => {
    const publication = { ...structuredClone(source), name: 'Old publication', revision: 2, published: true };
    mocks.listRoutinePublications.mockResolvedValue([publication]);
    mocks.getRoutine.mockImplementation(async (_id, _revision, published) => structuredClone(published ? publication : source));
    mocks.setActiveRoutineSelection.mockRejectedValue(new Error('routine_conflict'));
    await open(); await vi.waitFor(() => expect(mocks.player.load).toHaveBeenCalledOnce());
    button(t('openDifferent')).click();
    nodes.find(node => node.className === 'routine-library-rows')!.querySelectorAll('button')
      .find(node => node.title === t('openRoutine', { name: publication.name }))!.click();
    await vi.waitFor(() => expect(mocks.setActiveRoutineSelection).toHaveBeenCalledOnce()); await settled();
    expect(currentDraft()).toEqual(source); expect(mocks.player.load).toHaveBeenCalledOnce();
    expect(mocks.clearActiveRoutine).not.toHaveBeenCalled();
  });

  it('unified app: startup restores the exact publication ahead of a newer pending working draft and Save cannot replace it', async () => {
    const publication = { ...structuredClone(source), name: 'Exact publication', revision: 2, published: true };
    const copy: RoutineWorkingCopy = { envelope: { routine: { ...structuredClone(source), name: 'Newer work' }, media: {} },
      localVersion: 11, cloudBaseRevision: null, pendingCloud: true, savedAt: 1234 };
    mocks.getActiveRoutineSelection.mockResolvedValue({ id: source.id, revision: 2, published: true });
    mocks.getRoutine.mockImplementation(async (_id, revision, published) => structuredClone(revision === 2 && published ? publication : source));
    mocks.listRoutineWorkingCopies.mockResolvedValue([copy]); mocks.getRoutineWorkingCopy.mockResolvedValue(copy);
    await open(); await vi.waitFor(() => expect(mocks.player.load).toHaveBeenCalledExactlyOnceWith(publication));
    expect(currentDraft()).toEqual(publication); expect(mocks.getRoutine).toHaveBeenCalledWith(source.id, 2, true);
    button(t('save')).dispatchEvent(new Event('click')); await settled();
    expect(mocks.saveRoutineWorkingCopy).not.toHaveBeenCalled(); expect(mocks.setActiveRoutine).not.toHaveBeenCalled();
    expect(mocks.setActiveRoutineSelection).not.toHaveBeenCalled(); expect(currentDraft()).toEqual(publication);
  });

  it('unified app: held Save freezes history until acknowledgment then Undo retains the saved revision and timestamp', async () => {
    const gate = deferred();
    const original = mocks.saveRoutineWorkingCopy.getMockImplementation()!;
    mocks.saveRoutineWorkingCopy.mockImplementation(async (...args) => { await gate.promise; return original(...args); });
    await open(); await vi.waitFor(() => expect(button(t('save')).disabled).toBe(false));
    editName('Held history'); button(t('save')).click();
    await vi.waitFor(() => expect(mocks.saveRoutineWorkingCopy).toHaveBeenCalledOnce());
    expect(button(t('undoEdit')).disabled).toBe(true);
    button(t('undoEdit')).dispatchEvent(new Event('click')); expect(currentDraft().name).toBe('Held history');
    gate.resolve(); await settled();
    const { revision, savedAt } = currentDraft(); expect(savedAt).toBeTypeOf('number');
    button(t('undoEdit')).click(); expect(currentDraft().name).toBe(source.name);
    expect(currentDraft()).toMatchObject({ revision, savedAt });
    button(t('redoEdit')).click(); expect(currentDraft().name).toBe('Held history');
    expect(mocks.saveClassSetup).not.toHaveBeenCalled(); expect(mocks.player.play).not.toHaveBeenCalled();
  });

  it.each(['clean', 'changed', 'pending'])('unified app: Delete removes the %s working copy and legacy head in one atomic call', async state => {
    const routine = structuredClone(source); routine.savedAt = 1234;
    if (state !== 'clean') routine.name = 'Changed working copy';
    const copy: RoutineWorkingCopy = { envelope: { routine, media: {} }, localVersion: 11,
      cloudBaseRevision: null, pendingCloud: state === 'pending', savedAt: 1234 };
    mocks.listRoutineWorkingCopies.mockResolvedValue([copy]); mocks.getRoutineWorkingCopy.mockResolvedValue(copy);
    await open(); button(t('localDelete')).click();
    await vi.waitFor(() => expect(button(t('newRoutine')).hidden).toBe(false));
    expect(mocks.deleteRoutineAndWorkingCopy).toHaveBeenCalledExactlyOnceWith(source.id, source.revision, 11);
    expect(mocks.deleteRoutine).not.toHaveBeenCalled(); expect(mocks.deleteRoutineWorkingCopy).not.toHaveBeenCalled();
    expect(mocks.cacheCloudTrack).not.toHaveBeenCalled(); expect(mocks.player.unload).not.toHaveBeenCalled();
  });

  it('unified app: atomic Delete conflict retains the working copy and active selection', async () => {
    const copy: RoutineWorkingCopy = { envelope: { routine: structuredClone(source), media: {} }, localVersion: 11,
      cloudBaseRevision: null, pendingCloud: true, savedAt: 1234 };
    mocks.listRoutineWorkingCopies.mockResolvedValue([copy]); mocks.getRoutineWorkingCopy.mockResolvedValue(copy);
    mocks.deleteRoutineAndWorkingCopy.mockRejectedValue(new Error('routine_conflict'));
    await open(); button(t('localDelete')).click();
    await vi.waitFor(() => expect(mocks.deleteRoutineAndWorkingCopy).toHaveBeenCalledOnce()); await settled();
    expect(currentDraft().id).toBe(source.id); expect(button(t('newRoutine')).hidden).toBe(true);
    expect(mocks.clearActiveRoutine).not.toHaveBeenCalled(); expect(mocks.deleteRoutine).not.toHaveBeenCalled();
    expect(mocks.deleteRoutineWorkingCopy).not.toHaveBeenCalled();
  });

  const selectSavedOptionalClass = async (unready?: 'routine' | 'walkIn' | 'walkOut') => {
    const playlists: Record<'walkIn' | 'walkOut', MusicPlaylist> = {
      walkIn: { schemaVersion: 1, id: 'empty-walk-in', name: 'Optional walk-in', revision: 2, locked: false, published: false, tracks: [] },
      walkOut: { schemaVersion: 1, id: 'empty-walk-out', name: 'Optional walk-out', revision: 3, locked: false, published: false, tracks: [] },
    };
    if (unready && unready !== 'routine') {
      playlists[unready].tracks.push({ ...structuredClone(source.tracks[0]!), id: `missing-${unready}`, cues: [] });
    }
    const reference = (value: Routine | MusicPlaylist) => ({ id: value.id, revision: value.revision, published: value.published });
    const setup: ClassSetup = { schemaVersion: 1, id: 'saved-optional-class', name: 'Saved optional class', revision: 4,
      locked: false, published: false, routine: reference(source), walkIn: reference(playlists.walkIn), walkOut: reference(playlists.walkOut), crossfade: 0 };
    const resolved: PreparedClass = { setup, routine: { ...structuredClone(source), ...(unready === 'routine' ? { tracks: [] } : {}) },
      audio: { ...playlists, crossfade: 0 } };
    mocks.listMusicPlaylists.mockResolvedValue(Object.values(playlists));
    mocks.getMusicPlaylist.mockImplementation(async (id: string) => structuredClone(Object.values(playlists).find(playlist => playlist.id === id) ?? null));
    mocks.listClassSetups.mockResolvedValue([setup]); mocks.getClassSetup.mockResolvedValue(setup);
    mocks.getReadiness.mockImplementation(async (routine: Routine) => {
      const missing = routine.tracks.filter(track => track.id.startsWith('missing-')).map(track => track.id);
      return { ready: routine.tracks.length > 0 && missing.length === 0, missing };
    });
    mocks.getPreparedClass.mockResolvedValue(structuredClone(resolved));
    await open();
    expect(mocks.player.load).toHaveBeenCalledWith(source);
    mocks.player.load.mockClear(); mocks.getReadiness.mockClear();
    button(t('openDifferent')).click();
    const rows = nodes.find(node => node.className === 'routine-library-rows')!;
    rows.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: setup.name }))!.click();
    await settled();
    return { resolved };
  };

  it('prepares saved empty optional playlists with a nonempty routine ReadySilent until explicit Play', async () => {
    const { resolved } = await selectSavedOptionalClass();
    await vi.waitFor(() => expect(currentDraft().id).not.toBe(resolved.routine.id));
    const draftBefore = structuredClone(currentDraft());
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    expect(mocks.getPreparedClass).toHaveBeenCalledExactlyOnceWith(resolved.setup.id, resolved.setup.revision, 'local', false);
    expect(mocks.getReadiness).toHaveBeenCalledWith(resolved.routine);
    expect(currentDraft().id).not.toBe(resolved.routine.id);
    expect(currentDraft().sequence).toEqual({ crossfade: 0 });
    expect(mocks.player.load).toHaveBeenCalledExactlyOnceWith(currentDraft(), { crossfade: 0 });
    expect(mocks.player.play).not.toHaveBeenCalled();
    expect(playback.elapsed).toBe(0); expect(playback.classElapsed).toBe(0);
    button(t('startClass')).click();
    expect(mocks.player.play).not.toHaveBeenCalled();
    expect(currentDraft()).toEqual(draftBefore);
    expect(mocks.saveRoutine).not.toHaveBeenCalled();
    expect(mocks.saveClassSetup).not.toHaveBeenCalled();
    expect(mocks.saveMusicPlaylist).not.toHaveBeenCalled();
    button(t('play')).click();
    await vi.waitFor(() => expect(mocks.player.play).toHaveBeenCalledOnce());
  });

  it.each(['routine', 'walkIn', 'walkOut'] as const)('rejects saved optional class preparation when %s is empty or missing required audio', async unready => {
    const { resolved } = await selectSavedOptionalClass(unready);
    const draftBefore = structuredClone(currentDraft());
    button(t('teach')).click();
    const notice = nodes.find(node => node.classList.contains('notice'))!;
    await vi.waitFor(() => expect(notice.children[0]!.textContent).toBe(t('classCacheUnavailable')));
    expect(notice.children[0]!.attributes.get('role')).toBe('alert');
    expect(mocks.getReadiness).toHaveBeenCalledWith(unready === 'routine' ? resolved.routine
      : expect.objectContaining({ tracks: resolved.audio[unready]!.tracks }));
    expect(mocks.player.load).not.toHaveBeenCalled(); expect(mocks.player.play).not.toHaveBeenCalled();
    expect(currentDraft()).toEqual(source);
    expect(currentDraft()).toEqual(draftBefore);
  });

  it('uses recorded filler only for a newly created empty draft', async () => {
    records.clear();
    await open();
    expect(currentDraft().filler.sound).toBe('lofi');
    expect(currentDraft().tracks).toHaveLength(0);
  });

  it('loads stored filler choices on cold Edit entry without visiting Settings or mutating the draft', async () => {
    const recording: FillerRecording = { id: 'stored-filler', name: 'UserFiller', duration: 2,
      asset: { id: 'stored-asset', bytes: 128, sha256: 'b'.repeat(64), contentType: 'audio/wav' } };
    mocks.listFillerRecordings.mockResolvedValue([recording]);
    await open();
    const snapshot = structuredClone(currentDraft());
    expect(mocks.listFillerRecordings).not.toHaveBeenCalled();
    button(t('edit')).click();
    await vi.waitFor(() => expect(mocks.editorSession.refreshFillers).toHaveBeenCalled());
    expect(mocks.listFillerRecordings).toHaveBeenCalledOnce();
    expect(currentDraft()).toEqual(snapshot);
    expect(mocks.player.load).toHaveBeenCalledExactlyOnceWith(source);
  });

  it('expires a short-file filler error on tab return without importing or clearing the chosen file', async () => {
    await open(); button(t('settings')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    vi.useFakeTimers(); vi.setSystemTime(1000);
    try {
      const library = nodes.find(node => node.classList.contains('filler-library'))!;
      const input = library.querySelectorAll('input').find(node => node.type === 'file')!;
      input.files = [new File([], 'empty.wav', { type: 'audio/wav' })]; input.dispatchEvent(new Event('change'));
      button(t('addFiller')).click(); const feedback = library.querySelector('.filler-library-feedback')!;
      expect(feedback.textContent).toBe(t('audioByteLimit')); expect(mocks.addFillerRecording).not.toHaveBeenCalled();
      vi.setSystemTime(31001); document.dispatchEvent(new Event('visibilitychange'));
      expect(feedback.hidden).toBe(true); expect(input.files).toHaveLength(1);
      button(t('addFiller')).click(); expect(feedback.hidden).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('lists every built-in filler BPM in Settings before selecting a recording', async () => {
    await open(); button(t('settings')).click();
    const library = nodes.find(node => node.classList.contains('filler-library'))!;
    const items = library.querySelectorAll('.filler-builtins')[0]!.children;
    expect(items).toHaveLength(4);
    for (const [index, sound] of (['lofi', 'soft', 'bright', 'drums'] as const).entries()) {
      expect(items[index]!.textContent).toBe(`${t(sound)}: ${sound === 'lofi' ? 120 : 100} BPM`);
    }
  });

  it('persists custom filler confidence only on Apply and manual BPM by immutable hash', async () => {
    const recording: FillerRecording = { id: 'local-filler', name: 'Device loop', duration: 8,
      asset: { id: 'local-asset', bytes: 128, sha256: 'a'.repeat(64), contentType: 'audio/wav' } };
    mocks.listFillerRecordings.mockResolvedValue([recording]);
    mocks.getFillerRecordingBlob.mockResolvedValue(new Blob([new Uint8Array(128)]));
    mocks.detectBpm.mockResolvedValue({ bpm: 120, firstBeat: 0, confidence: 0.6 });
    await open(); const before = structuredClone(currentDraft()); button(t('settings')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const library = nodes.find(node => node.classList.contains('filler-library'))!;
    const select = library.querySelectorAll('select')[0]!;
    select.value = recording.id; select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    button(t('fillerAnalyzeBpm')).click();
    await vi.waitFor(() => expect(button(t('fillerApplyBpm')).disabled).toBe(false));
    const key = `fitness-filler-analysis:${recording.asset.sha256}`;
    expect(localStorage.getItem(key)).toBeNull();
    expect(library.querySelectorAll('p').some(node => node.textContent.includes('Confidence: 60%'))).toBe(true);
    button(t('fillerApplyBpm')).click();
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ bpm: 120, confidence: 0.6,
      analyzer: 'detectTrackBpm', sha256: recording.asset.sha256 }));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const input = library.querySelectorAll('label').find(node => node.textContent === t('fillerBpmMetadata'))!.children[0]!;
    input.value = '60'; input.dispatchEvent(new Event('input'));
    expect(JSON.parse(localStorage.getItem(key)!).bpm).toBe(120);
    button(t('fillerApplyBpm')).click();
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ bpm: 60, analyzer: 'manual', sha256: recording.asset.sha256 }));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    input.value = '221'; input.dispatchEvent(new Event('input')); expect(button(t('fillerApplyBpm')).disabled).toBe(true);
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(input.value).toBe('60'));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    mocks.detectBpm.mockRejectedValueOnce(new Error('invalid_estimate'));
    button(t('fillerAnalyzeBpm')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    expect(library.querySelectorAll('p').some(node => node.textContent === t('detectingBpm'))).toBe(false);
    expect(button(t('fillerApplyBpm')).disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem(key)!).bpm).toBe(60);
    expect(currentDraft()).toEqual(before); expect(mocks.saveRoutine).not.toHaveBeenCalled();
  });

  it('analyzes a selected filler with the existing reserved asset key and displays read-only dB and LUFS', async () => {
    const recording: FillerRecording = { id: 'local-filler', name: 'Device loop', duration: 8,
      asset: { id: 'local-asset', bytes: 128, sha256: 'a'.repeat(64), contentType: 'audio/wav' } };
    mocks.listFillerRecordings.mockResolvedValue([recording]);
    mocks.getFillerRecordingBlob.mockResolvedValue(new Blob([new Uint8Array(128)]));
    mocks.analyzeLoudness.mockResolvedValue({ integratedLufs: -8, peakDbfs: 2, targetLufs: -8, recommendedGain: 1, limited: false, clippingRisk: true });
    await open(); const before = structuredClone(currentDraft());
    button(t('settings')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const library = nodes.find(node => node.classList.contains('filler-library'))!;
    const selected = library.querySelectorAll('select')[0]!; selected.value = recording.id; selected.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    button(t('analyzeFillerLevel')).click();
    await vi.waitFor(() => expect(library.querySelector('.filler-level-result')!.textContent).toContain('target: -8 LUFS'));
    expect(library.querySelector('.clipping-warning')!.hidden).toBe(false);
    expect(library.querySelector('.clipping-warning')!.textContent).toBe(t('clippingWarning'));
    expect(library.querySelector('.filler-level-result')!.textContent).toMatch(/^Recommended: .* dB/);
    expect(mocks.analyzeLoudness).toHaveBeenCalledExactlyOnceWith('filler-local-asset');
    expect(currentDraft()).toEqual(before); expect(mocks.saveRoutine).not.toHaveBeenCalled();
    expect(mocks.addFillerRecording).not.toHaveBeenCalled(); expect(mocks.player.load).toHaveBeenCalledExactlyOnceWith(source);
  });

  it('adds device-global fillers in Settings and archives metadata without changing the draft or prepared player', async () => {
    await open();
    const snapshot = structuredClone(currentDraft());
    const recording: FillerRecording = { id: 'local-filler', name: 'Device loop', duration: 8,
      asset: { id: 'local-asset', bytes: 128, sha256: 'a'.repeat(64), contentType: 'audio/wav' } };
    button(t('settings')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const panel = nodes.find(node => node.classList.contains('filler-library'))!;
    const picker = panel.querySelectorAll('label').find(node => node.textContent === t('fillerFile'))!.children[0]!;
    picker.files = [new File([new Uint8Array(128)], 'Device_loop.wav', { type: 'audio/wav' })];
    picker.dispatchEvent(new Event('change'));
    const importing = deferred();
    mocks.addFillerRecording.mockImplementationOnce(async () => { await importing.promise; return recording; });
    button(t('addFiller')).click();
    const feedback = panel.querySelectorAll('.filler-library-feedback')[0]!;
    expect(feedback.textContent).toBe(t('preparingAudio', { name: picker.files[0]!.name }));
    expect(feedback.attributes.get('role')).toBe('status');
    expect(button(t('addFiller')).disabled).toBe(true);
    expect(panel.querySelectorAll('progress')[0]!.hidden).toBe(true);
    expect(panel.querySelectorAll('option').some(option => option.value === recording.id)).toBe(false);
    expect(currentDraft()).toEqual(snapshot);
    importing.resolve();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    expect(feedback.textContent).toBe(t('fillerAdded'));
    expect(mocks.addFillerRecording).toHaveBeenCalledWith(picker.files[0], 'Device loop');
    expect(mocks.editorSession.refreshFillers).toHaveBeenCalled();
    const preview = panel.querySelectorAll('button').find(node => node.title === t('previewFiller'))!;
    preview.click();
    expect(mocks.preview.playFiller).toHaveBeenCalledWith({ mode: 'timed', seconds: 8, bpm: 100, sound: 'recording', recording, gain: 1 });
    const stops = mocks.preview.stop.mock.calls.length;
    button(t('removeFiller')).click();
    await vi.waitFor(() => expect(mocks.removeFillerRecording).toHaveBeenCalledWith(recording.id));
    expect(mocks.preview.stop).toHaveBeenCalledTimes(stops);
    expect(currentDraft()).toEqual(snapshot);
    expect(mocks.player.load).toHaveBeenCalledExactlyOnceWith(source);
    expect(mocks.player.stop).not.toHaveBeenCalled();
    expect(mocks.player.dispose).not.toHaveBeenCalled();
  });

  it('reports missing standalone recording bytes without fetching or replacing a playing class', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    button(t('play')).click();
    await vi.waitFor(() => expect(mocks.player.play).toHaveBeenCalledOnce());
    currentDraft().filler = { ...currentDraft().filler, mode: 'timed', sound: 'recording', recording: {
      id: 'missing-filler', name: 'Missing', duration: 8,
      asset: { id: 'missing-asset', bytes: 128, sha256: 'a'.repeat(64), contentType: 'audio/wav' },
    } };
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
    expect(mocks.getFillerRecordingBlob).toHaveBeenCalledWith(currentDraft().filler.recording);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.player.load).toHaveBeenCalledOnce();
    expect(mocks.player.stop).not.toHaveBeenCalled();
    expect(mocks.player.pause).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(nodes.some(node => node.className.includes('notice-error') && !node.hidden)).toBe(true));
  });

  it('does not replace stored or demo synthetic filler selections', async () => {
    source.filler.sound = 'bright';
    records.set(source.id, structuredClone(source));
    await open();
    expect(currentDraft().filler.sound).toBe('bright');
    const demo = newRoutine();
    demo.filler.sound = 'drums';
    mocks.createDemoRoutine.mockResolvedValueOnce(demo);
    button(t('demo')).click();
    await vi.waitFor(() => expect(currentDraft().id).toBe(demo.id));
    expect(currentDraft().filler.sound).toBe('drums');
  });

  it('exports the displayed editor draft without pausing preview or changing a playing prepared snapshot', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('play')).disabled).toBe(false));
    button(t('play')).click();
    await vi.waitFor(() => expect(playback.status).toBe('playing'));
    button(t('edit')).click();
    editName('Unsaved export draft');
    mocks.player.pause.mockClear();
    mocks.player.stop.mockClear();
    mocks.preview.stop.mockClear();
    button(t('exportExcel')).click();
    button(t('exportDownload')).click();
    await vi.waitFor(() => expect(mocks.downloadExport).toHaveBeenCalledOnce());
    const snapshot = mocks.exportExcel.mock.calls[0]![0] as ExportSnapshot;
    expect(snapshot.routine.name).toBe('Unsaved export draft');
    expect(snapshot.unsaved).toBe(true);
    expect(mocks.player.load).toHaveBeenCalledOnce();
    expect((mocks.player.load.mock.calls[0]![0] as Routine).name).toBe(source.name);
    expect(mocks.player.pause).not.toHaveBeenCalled();
    expect(mocks.player.stop).not.toHaveBeenCalled();
    expect(mocks.preview.stop).not.toHaveBeenCalled();
    expect(playback.status).toBe('playing');
  });

  it('keeps the progressbar and a separate labeled seek slider, including transport on a locked song', async () => {
    await prepareCues(true);
    const slider = seekControl();
    expect(nodes.find(node => node.className === 'progress')!.attributes.get('role')).toBe('progressbar');
    expect(slider.attributes.get('role')).toBe('slider');
    expect(slider.attributes.get('aria-label')).toBe(t('seekSong'));
    expect(slider.tabIndex).toBe(0);
    expect(marker().disabled).toBe(true);
    pointer(slider, 'pointerdown', 250);
    pointer(slider, 'click', 250);
    await vi.waitFor(() => expect(slider.attributes.get('aria-disabled')).toBe('false'));
    expect(mocks.player.seek).toHaveBeenLastCalledWith(15);
    key(slider, 'ArrowRight');
    await vi.waitFor(() => expect(slider.attributes.get('aria-disabled')).toBe('false'));
    expect(mocks.player.seek).toHaveBeenLastCalledWith(16);
    key(marker(), 'ArrowRight');
    pointer(marker(), 'pointerdown', 150);
    pointer(marker(), 'pointerup', 250);
    expect(mocks.player.updateCues).not.toHaveBeenCalled();
    expect(playback.status).toBe('idle');
    expect(mocks.player.play).not.toHaveBeenCalled();
  });

  it('blocks seeking when not prepared, pending, in filler or Class mode, checking current state on each event', async () => {
    mocks.getReadiness.mockResolvedValue({ ready: false, missing: ['track-a'] });
    await open();
    const slider = seekControl();
    pointer(slider, 'click', 250);
    key(slider, 'ArrowRight');
    expect(mocks.player.seek).not.toHaveBeenCalled();
    mocks.getReadiness.mockResolvedValue({ ready: true, missing: [] });
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    const seeking = deferred();
    mocks.player.seek.mockImplementationOnce(() => seeking.promise);
    key(slider, 'ArrowRight');
    key(slider, 'ArrowRight');
    pointer(slider, 'click', 250);
    expect(mocks.player.seek).toHaveBeenCalledOnce();
    seeking.resolve();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    for (const filler of [
      { status: 'filler' as const, fillerRemaining: 8, duration: 15 },
      { status: 'paused' as const, fillerRemaining: 8, duration: 15 },
      { status: 'paused' as const, fillerRemaining: null, duration: 0, holding: true },
    ]) {
      emit({ ...playback, ...filler });
      expect(slider.tabIndex).toBe(-1);
      pointer(slider, 'click', 250);
      key(slider, 'End');
    }
    emit(playback);
    button(t('startClass')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    expect(slider.hidden).toBe(true);
    expect(handles().hidden).toBe(true);
    pointer(slider, 'click', 250);
    key(slider, 'Home');
    expect(mocks.player.seek).toHaveBeenCalledOnce();
  });

  it('previews dragging without mutations or frame-by-frame node replacement, then commits sorted detached cues once', async () => {
    await prepareCues();
    const handle = marker();
    const before = structuredClone(currentDraft());
    const loadCount = mocks.player.load.mock.calls.length;
    pointer(handle, 'pointerdown', 150);
    expect(handle.hasPointerCapture(7)).toBe(true);
    pointer(handle, 'pointermove', 250);
    emit({ ...playback, elapsed: 1 });
    emit({ ...playback, elapsed: 2 });
    expect(marker()).toBe(handle);
    expect(handle.hasPointerCapture(7)).toBe(true);
    expect(handle.attributes.get('aria-label')).toBe(t('adjustCue', { note: '<Move> & stretch', time: '20' }));
    expect(currentDraft()).toEqual(before);
    expect(mocks.player.updateCues).not.toHaveBeenCalled();
    pointer(handle, 'pointerup', 250);
    expect(handle.hasPointerCapture(7)).toBe(false);
    const expected = [
      { ...before.tracks[0]!.cues[1]!, anchor: { kind: 'timestamp', seconds: 20 } },
      before.tracks[0]!.cues[2]!, before.tracks[0]!.cues[0]!,
    ];
    expect(currentDraft().tracks[0]!.cues).toEqual(expected);
    expect(mocks.player.updateCues).toHaveBeenCalledExactlyOnceWith(0, expected);
    const passed = mocks.player.updateCues.mock.calls[0]![1] as Cue[];
    expect(passed).not.toBe(currentDraft().tracks[0]!.cues);
    expect(passed[0]).not.toBe(currentDraft().tracks[0]!.cues[0]);
    expect(document.activeElement).toBe(marker());
    expect(nodes.find(node => node.className === 'draft-status')!.textContent).toContain(t('unsaved'));
    expect(nodes.find(node => node.className === 'snapshot-status')!.textContent).toBe(t('prepared'));
    const rows = nodes.find(node => node.className === 'cue-table-wrap')!.querySelectorAll('tr').filter(row => row.dataset.seconds);
    expect(rows.map(row => row.dataset.seconds)).toEqual(['20', '20', '25']);
    expect(mocks.player.load).toHaveBeenCalledTimes(loadCount);
    expect(mocks.player.play).not.toHaveBeenCalled();
    expect(mocks.player.pause).not.toHaveBeenCalled();
    pointer(seekControl(), 'click', 250);
    expect(mocks.player.seek).not.toHaveBeenCalled();
    button(t('editCueTimes')).click();
    pointer(seekControl(), 'pointerdown', 250);
    pointer(seekControl(), 'click', 250);
    expect(mocks.player.seek).toHaveBeenCalledWith(15);
  });

  it.each(['pointercancel', 'Escape', 'lostcapture', 'pause', 'stop', 'trackChange', 'tab', 'lock', 'content', 'trackId', 'duplicate', 'pending', 'class', 'blur', 'hidden'] as const)(
    'cancels a drag without cue changes after %s', async reason => {
      await prepareCues();
      const handle = marker();
      const originalCues = structuredClone(currentDraft().tracks[0]!.cues);
      pointer(handle, 'pointerdown', 150);
      pointer(handle, 'pointermove', 250);
      const pending = deferred();
      switch (reason) {
        case 'pointercancel': pointer(handle, 'pointercancel', 250); break;
        case 'Escape': key(document, 'Escape'); break;
        case 'lostcapture': handle.releasePointerCapture(7); break;
        case 'pause': emit({ ...playback, status: 'paused' }); break;
        case 'stop': button(t('stop')).click(); break;
        case 'trackChange': emit({ ...playback, trackIndex: 1 }); break;
        case 'tab': button(t('settings')).click(); break;
        case 'lock': currentDraft().locked = true; break;
        case 'content': currentDraft().name = 'Changed without a render'; break;
        case 'trackId': currentDraft().tracks[0]!.id = 'replacement'; break;
        case 'duplicate': button(t('duplicate')).click(); break;
        case 'pending':
          mocks.player.next.mockImplementationOnce(() => pending.promise);
          button(t('next')).click();
          break;
        case 'class': button(t('startClass')).click(); break;
        case 'blur': {
          const listener = vi.mocked(window.addEventListener).mock.calls.find(call => call[0] === 'blur')![1] as () => void;
          listener();
          break;
        }
        case 'hidden':
          Object.assign(document, { hidden: true });
          document.dispatchEvent(new Event('visibilitychange'));
          break;
      }
      pointer(handle, 'pointerup', 250);
      expect(mocks.player.updateCues).not.toHaveBeenCalled();
      expect(mocks.player.seek).not.toHaveBeenCalled();
      expect(handle.hasPointerCapture(7)).toBe(false);
      expect(currentDraft().tracks[0]!.cues).toEqual(originalCues);
      pending.resolve();
      await pending.promise;
    },
  );

  it('ignores a secondary pointer and click-only marker release, and keeps a canceled marker at its original position', async () => {
    await prepareCues();
    const handle = marker();
    const position = handle.style.insetInlineStart;
    pointer(handle, 'pointerdown', 150);
    pointer(handle, 'pointermove', 250, 8);
    pointer(handle, 'pointerup', 250, 8);
    expect(handle.style.insetInlineStart).toBe(position);
    expect(handle.hasPointerCapture(7)).toBe(true);
    pointer(handle, 'pointerup', 150);
    expect(mocks.player.updateCues).not.toHaveBeenCalled();
    pointer(handle, 'pointerdown', 150);
    pointer(handle, 'pointermove', 250);
    expect(handle.style.insetInlineStart).not.toBe(position);
    key(document, 'Escape');
    expect(handle.style.insetInlineStart).toBe(position);
    expect(mocks.player.updateCues).not.toHaveBeenCalled();
  });

  it('adjusts cues with keyboard arrows, preserves note/ID/beep, and refuses stale or Class-mode marker events', async () => {
    await prepareCues();
    const oldHandle = marker();
    oldHandle.focus();
    key(oldHandle, 'ArrowRight');
    expect(currentDraft().tracks[0]!.cues.find(cue => cue.id === 'move')).toEqual({
      id: 'move', note: '<Move> & stretch', beep: true, anchor: { kind: 'timestamp', seconds: 11 },
    });
    key(oldHandle, 'ArrowRight');
    expect(mocks.player.updateCues).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(marker());
    key(marker(), 'ArrowLeft', true);
    expect(currentDraft().tracks[0]!.cues.find(cue => cue.id === 'move')!.anchor).toEqual({ kind: 'timestamp', seconds: 1 });
    const prepared = mocks.player.load.mock.calls[0]![0] as Routine;
    expect(prepared.tracks[0]!.cues).toEqual(currentDraft().tracks[0]!.cues);
    button(t('startClass')).click();
    key(marker(), 'ArrowRight');
    pointer(marker(), 'pointerdown', 150);
    pointer(marker(), 'pointerup', 250);
    expect(mocks.player.updateCues).toHaveBeenCalledTimes(2);
    expect(mocks.player.load).toHaveBeenCalledOnce();
  });

  it('retains draft and marker timing when the runtime rejects a cue update', async () => {
    await prepareCues();
    const original = structuredClone(currentDraft());
    const handle = marker();
    const position = handle.style.insetInlineStart;
    mocks.player.updateCues.mockImplementationOnce(() => { throw new Error('routine_locked'); });
    pointer(handle, 'pointerdown', 150);
    pointer(handle, 'pointermove', 250);
    pointer(handle, 'pointerup', 250);
    expect(currentDraft()).toEqual(original);
    expect(handle.style.insetInlineStart).toBe(position);
    expect(nodes.find(node => node.className.includes('notice-error'))!.hidden).toBe(false);
  });

  it('shares one preview controller and cancels a pending preparation before preview starts', async () => {
    await open();
    expect(mocks.createAudioPreview).toHaveBeenCalledOnce();
    expect(mocks.renderEditor.mock.lastCall![3]).toEqual(expect.objectContaining({
      preview: mocks.preview, detectBpm: mocks.detectBpm,
    }));
    const readiness = deferred();
    editName('Needs fresh preparation'); button(t('edit')).click();
    mocks.getReadiness.mockImplementation(async () => { await readiness.promise; return { ready: true, missing: [] }; });
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(true));
    (mocks.createAudioPreview.mock.calls[0]![0] as () => void)();
    expect(mocks.player.pause).toHaveBeenCalledOnce();
    readiness.resolve();
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
    expect(mocks.player.load).toHaveBeenCalledOnce();
  });

  it('keeps preview containers enabled for locked content and invalidates old editor sessions', async () => {
    source.locked = true;
    records.set(source.id, structuredClone(source));
    await open();
    const host = mocks.renderEditor.mock.lastCall![0] as TestElement;
    expect(host.children.find(node => 'editorContent' in node.dataset)!.disabled).toBe(true);
    expect(host.children.find(node => 'previewControls' in node.dataset)!.disabled).toBe(false);
    button(t('edit')).click();
    const isCurrent = mocks.renderEditor.mock.lastCall![3].isCurrent as () => boolean;
    expect(isCurrent()).toBe(true);
    mocks.preview.stop.mockClear();
    mocks.editorSession.cancelJobs.mockClear();
    button(t('settings')).click();
    expect(isCurrent()).toBe(false);
    expect(mocks.preview.stop).toHaveBeenCalledOnce();
    expect(mocks.editorSession.cancelJobs).toHaveBeenCalledOnce();
    button(t('edit')).click();
    mocks.editorSession.dispose.mockClear();
    await duplicateRoutine();
    expect(isCurrent()).toBe(false);
    expect(mocks.editorSession.dispose).toHaveBeenCalledOnce();
    expect(mocks.createAudioPreview).toHaveBeenCalledOnce();
  });

  it('keeps the editor session and audition intact for nonstructural edits', async () => {
    await open();
    button(t('edit')).click();
    const routine = currentDraft();
    const changed = mocks.renderEditor.mock.lastCall![2] as (structural: boolean) => void;
    mocks.renderEditor.mockClear();
    mocks.preview.stop.mockClear();
    mocks.editorSession.dispose.mockClear();
    mocks.editorSession.cancelJobs.mockClear();
    routine.tracks[0]!.cues.push({ id: 'precise-cue', anchor: { kind: 'timestamp', seconds: 3.14159 }, note: 'New move' });
    changed(false);
    routine.tracks[0]!.cues[0]!.note = 'Edited move';
    changed(false);
    expect(mocks.renderEditor).not.toHaveBeenCalled();
    expect(mocks.preview.stop).not.toHaveBeenCalled();
    expect(mocks.editorSession.dispose).not.toHaveBeenCalled();
    expect(mocks.editorSession.cancelJobs).not.toHaveBeenCalled();
    expect(routine.tracks[0]!.cues[0]).toEqual({ id: 'precise-cue', anchor: { kind: 'timestamp', seconds: 3.14159 }, note: 'Edited move' });
  });

  it('creates an empty independent New draft and preserves dirty work on Cancel', async () => {
    await open();
    const original = structuredClone(currentDraft());
    editName('Unsaved original');
    expect(button(t('newRoutine')).hidden).toBe(true);
    button(t('newRoutine')).click();
    expect(currentDraft().id).toBe(original.id);
    expect(currentDraft().name).toBe('Unsaved original');
    button(t('closeRoutine')).click();
    nodes.filter(node => node.tag === 'dialog' && node.open).at(-1)!.querySelectorAll('button').find(node => node.title === t('cancel'))!.click();
    expect(currentDraft().name).toBe('Unsaved original');
    button(t('closeRoutine')).click();
    nodes.filter(node => node.tag === 'dialog' && node.open).at(-1)!.querySelectorAll('button').find(node => node.title === t('discard'))!.click();
    await vi.waitFor(() => expect(button(t('newRoutine')).hidden).toBe(false));
    button(t('newRoutine')).click();
    expect(currentDraft().id).not.toBe(original.id);
    expect(currentDraft().tracks).toEqual([]);
    expect(currentDraft().locked).toBe(false);
    expect(currentDraft().published).toBe(false);
    expect(mocks.saveRoutine).not.toHaveBeenCalled();
    expect(mocks.player.load).toHaveBeenCalledOnce(); expect(mocks.player.unload).toHaveBeenCalledOnce();
  });

  it('reuses a matching ready revision without loading or starting it again', async () => {
    await open(); button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    const checks = mocks.getReadiness.mock.calls.length;
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
    expect(mocks.player.load).toHaveBeenCalledOnce();
    expect(mocks.player.play).not.toHaveBeenCalled();
    expect(mocks.getReadiness).toHaveBeenCalledTimes(checks);
  });

  it('stops preview for teaching Prepare, Play, and Next', async () => {
    await open();
    button(t('edit')).click();
    mocks.preview.stop.mockClear();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('play')).disabled).toBe(false));
    expect(mocks.preview.stop).toHaveBeenCalled();
    mocks.preview.stop.mockClear();
    button(t('play')).click();
    await vi.waitFor(() => expect(button(t('next')).disabled).toBe(false));
    expect(mocks.preview.stop).toHaveBeenCalledOnce();
    mocks.preview.stop.mockClear();
    button(t('next')).click();
    expect(mocks.preview.stop).toHaveBeenCalledOnce();
  });

  it('enters class silently and starts playback only with an explicit Play', async () => {
    await open();
    const start = button(t('startClass'));
    expect(mocks.player.play).not.toHaveBeenCalled();
    button(t('teach')).click();
    await vi.waitFor(() => expect(start.disabled).toBe(false));
    const shell = nodes.find(node => node.className === 'app-shell')!;
    const request = vi.fn().mockRejectedValue(new Error('Fullscreen unavailable'));
    Object.assign(shell, { requestFullscreen: request });
    const chrome = ['app-header', 'tabs', 'routine-heading', 'snapshot-status', 'playlist', 'cue-sheet']
      .map(name => nodes.find(node => node.className === name)!);
    mocks.preview.stop.mockClear();
    mocks.editorSession.cancelJobs.mockClear();
    start.click();
    expect(request).not.toHaveBeenCalled();
    button(t('fullscreen')).click();
    expect(request).toHaveBeenCalledOnce();
    expect(mocks.player.play).not.toHaveBeenCalled();
    expect(mocks.preview.stop).toHaveBeenCalledOnce();
    expect(mocks.editorSession.cancelJobs).toHaveBeenCalledOnce();
    button(t('play')).click();
    await vi.waitFor(() => expect(button(t('next')).disabled).toBe(false));
    expect(mocks.player.play).toHaveBeenCalledOnce();
    expect(chrome.every(node => node.hidden)).toBe(true);
    expect(shell.classList.contains('class-mode')).toBe(true);
    expect(document.activeElement).toBe(button(t('exitClass')));
    expect(button(t('pause')).disabled).toBe(false);
    expect(button(t('stop')).disabled).toBe(false);
    expect(button(t('duck')).disabled).toBe(false);
    expect(button(t('muteBeeps')).disabled).toBe(false);
    expect(nodes.find(node => node.className === 'edit-panel')!.hidden).toBe(true);
    expect(nodes.find(node => node.className === 'settings-panel')!.hidden).toBe(true);
    emit({ ...playback, error: 'audio_interrupted' });
    const error = nodes.find(node => node.className === 'playback-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(t('audioInterrupted'));
    expect(error.attributes.get('role')).toBe('alert');
    button(t('dismiss')).click();
    expect(error.hidden).toBe(false);
    button(t('exitClass')).click();
    expect(shell.classList.contains('class-mode')).toBe(false);
    expect(chrome.every(node => !node.hidden)).toBe(true);
    expect(document.activeElement).toBe(start);
    expect(mocks.player.stop).not.toHaveBeenCalled();
    expect(mocks.player.pause).not.toHaveBeenCalled();
    expect(mocks.player.load).toHaveBeenCalledOnce();
    expect(playback.status).toBe('playing');
  });

  it('leaves ordinary Play as rehearsal and does not replay an already running class on entry', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    const shell = nodes.find(node => node.className === 'app-shell')!;
    const request = vi.fn().mockResolvedValue(undefined);
    Object.assign(shell, { requestFullscreen: request });
    button(t('play')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    expect(request).not.toHaveBeenCalled();
    button(t('startClass')).click();
    expect(request).not.toHaveBeenCalled();
    expect(mocks.player.play).toHaveBeenCalledOnce();
  });

  it('blocks repeated Start while playback is pending but leaves Pause and Stop available', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    const pending = deferred();
    mocks.player.play.mockImplementationOnce(() => pending.promise);
    button(t('startClass')).click();
    expect(mocks.player.play).not.toHaveBeenCalled();
    button(t('play')).click();
    button(t('startClass')).click();
    expect(mocks.player.play).toHaveBeenCalledOnce();
    expect(button(t('pause')).disabled).toBe(false);
    expect(button(t('stop')).disabled).toBe(false);
    button(t('exitClass')).click();
    expect(document.activeElement).toBe(button(t('teach')));
    button(t('stop')).click();
    pending.resolve();
    await pending.promise;
    expect(mocks.player.stop).toHaveBeenCalledOnce();
  });

  it('selects overlapping cues explicitly, disables seeking while editing, and nudges one tenth without reloading', async () => {
    await prepareCues();
    const selected = nodes.find(node => node.attributes.get('aria-label') === t('selectedCue') && node.tag === 'select')!;
    selected.value = 'move'; selected.dispatchEvent(new Event('change'));
    expect(seekControl().attributes.get('aria-disabled')).toBe('true');
    pointer(seekControl(), 'click', 250);
    expect(mocks.player.seek).not.toHaveBeenCalled();
    button(t('laterCue')).click();
    expect(currentDraft().tracks[0]!.cues.find(cue => cue.id === 'move')!.anchor).toEqual({ kind: 'timestamp', seconds: 10.1 });
    expect(mocks.player.updateCues).toHaveBeenCalledOnce();
    expect(mocks.player.load).toHaveBeenCalledOnce();
    expect(mocks.player.play).not.toHaveBeenCalled();
  });

  it('does not resume on repeated Class Mode entry after pausing', async () => {
    await open(); button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    button(t('play')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    button(t('pause')).click();
    button(t('startClass')).click(); button(t('exitClass')).click(); button(t('startClass')).click();
    expect(mocks.player.play).toHaveBeenCalledOnce();
    expect(mocks.player.load).toHaveBeenCalledOnce();
  });

  it('shows runtime phases and refuses paused announcement advance even on forced events', async () => {
    await open(); button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    emit({ ...playback, status: 'paused', phase: 'before', nextPhase: 'routine', canAdvance: true, phaseTrackTitle: 'Voice bed' });
    expect(nodes.find(node => node.className === 'playlist-items')!.querySelectorAll('li').some(row => row.attributes.has('aria-current'))).toBe(false);
    expect(handles().children).toHaveLength(0);
    const advance = button(t('advancePhase', { phase: t('phaseRoutine') }));
    expect(advance.disabled).toBe(true);
    advance.dispatchEvent(new Event('click'));
    expect(mocks.player.advance).not.toHaveBeenCalled();
    expect(button(t('hold')).hidden).toBe(true);
    expect(nodes.find(node => node.className === 'move-note')!.textContent).toBe(t('phaseBefore'));
    emit({ ...playback, status: 'filler', phase: 'before', nextPhase: 'routine', canAdvance: true });
    advance.click();
    await vi.waitFor(() => expect(mocks.player.advance).toHaveBeenCalledOnce());
  });

  it('renders cross-song and filler cue attribution as text, hiding missing or same-song attribution', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    const attribution = nodes.find(node => node.className === 'next-cue-track')!;
    const countdown = nodes.find(node => node.className === 'next-cue-time mono')!;
    const title = '<img src=x onerror=alert(1)> & Song B';
    emit({ ...playback, currentCue: 'Current move', nextCue: 'Upcoming move', nextCueTrackTitle: title });
    expect(attribution.hidden).toBe(false);
    expect(attribution.textContent).toBe(t('nextCueTrack', { track: title }));
    expect(attribution.children).toHaveLength(0);
    emit({ ...playback, nextCue: 'Upcoming move', nextCueIn: 1.1, nextCueTrackTitle: title });
    expect(countdown.textContent).toBe(t('nextIn', { time: '0:02' }));
    expect(countdown.attributes.has('aria-live')).toBe(false);
    emit({ ...playback, status: 'filler', fillerRemaining: 8, currentCue: 'Recover and reset',
      nextCue: 'First move in Song B', nextCueTrackTitle: title });
    expect(attribution.hidden).toBe(false);
    expect(nodes.find(node => node.className === 'move-note')!.textContent).toBe('Recover and reset');
    expect(nodes.find(node => node.className === 'next-note')!.textContent).toBe('First move in Song B');
    expect(nodes.find(node => node.className === 'playing-title')!.textContent).toBe(t('filler'));
    emit({ ...playback, status: 'filler', holding: true, duration: 0, nextCueIn: null,
      nextCue: 'First move in Song B', nextCueTrackTitle: title });
    expect(countdown.textContent).toBe(t('nextWaiting'));
    expect(countdown.hidden).toBe(false);
    expect(attribution.hidden).toBe(false);
    emit({ ...playback, nextCue: '', nextCueIn: null });
    expect(countdown.hidden).toBe(true);
    for (const nextCueTrackTitle of [null, undefined]) {
      emit({ ...playback, nextCue: 'Same-song cue', nextCueTrackTitle });
      expect(attribution.hidden).toBe(true);
      expect(attribution.textContent).toBe('');
    }
  });

  it('marks a prepared snapshot stale when only its single warning changes', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    currentDraft().beepOnceRemaining = 45;
    (mocks.renderEditor.mock.lastCall![2] as () => void)();
    expect(nodes.find(node => node.className === 'snapshot-status')!.textContent).toBe(t('snapshotChanged'));
    expect(currentDraft().beepRemaining).toBe(10);
    expect(mocks.player.load).toHaveBeenCalledOnce();
  });

  it('leaves class mode and pauses on a cached pagehide without disposing the player', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    button(t('startClass')).click();
    const listeners = vi.mocked(window.addEventListener).mock.calls.filter(call => call[0] === 'pagehide').map(call => call[1] as (event: PageTransitionEvent) => void);
    for (const listener of listeners) listener({ persisted: true } as PageTransitionEvent);
    expect(nodes.some(node => node.classList.contains('class-mode'))).toBe(false);
    expect(mocks.player.pause).toHaveBeenCalledOnce();
    expect(mocks.preview.stop).toHaveBeenCalled();
    expect(mocks.player.dispose).not.toHaveBeenCalled();
  });

  it('cancels jobs and releases preview resources on page teardown', async () => {
    await open();
    const listeners = vi.mocked(window.addEventListener).mock.calls.filter(call => call[0] === 'pagehide').map(call => call[1] as (event: PageTransitionEvent) => void);
    mocks.editorSession.dispose.mockClear();
    for (const listener of listeners) listener({ persisted: false } as PageTransitionEvent);
    expect(mocks.editorSession.cancelJobs).toHaveBeenCalled();
    expect(mocks.editorSession.dispose).toHaveBeenCalledOnce();
    expect(mocks.preview.dispose).toHaveBeenCalledOnce();
    expect(mocks.player.dispose).toHaveBeenCalledOnce();
  });

  it('explicitly accepts Opus, MP3, and M4A alongside native audio formats', async () => {
    await open();
    const input = nodes.find(node => node.className === 'visually-hidden') as unknown as HTMLInputElement;
    expect(input.accept.split(',')).toEqual(expect.arrayContaining(['audio/*', '.opus', '.mp3', '.m4a']));
  });

  it('publishes locally with CAS, reopens the fresh draft and keeps prepared playback unchanged', async () => {
    mocks.publishRoutine.mockImplementation(async (id: string, expected: number) => {
      const head = { ...structuredClone(records.get(id)!), revision: expected + 1, published: false };
      records.set(id, head); return { ...head, published: true };
    });
    await open(); button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('play')).disabled).toBe(false));
    const prepared = structuredClone(mocks.player.load.mock.calls[0]![0]);
    button(t('localPublish')).click(); await settled();
    expect(mocks.publishRoutine).toHaveBeenCalledExactlyOnceWith(source.id, 4);
    expect(currentDraft()).toMatchObject({ id: source.id, revision: 5, published: false });
    expect(mocks.player.load).toHaveBeenCalledOnce();
    expect(mocks.player.load.mock.calls[0]![0]).toEqual(prepared);
  });

  it('deletes locally with confirmation and CAS without deleting prepared audio', async () => {
    await open(); button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('play')).disabled).toBe(false));
    vi.mocked(confirm).mockReturnValueOnce(false);
    button(t('localDelete')).click(); await settled();
    expect(mocks.deleteRoutine).not.toHaveBeenCalled();
    button(t('localDelete')).click(); await settled();
    expect(mocks.deleteRoutine).toHaveBeenCalledExactlyOnceWith(source.id, 4);
    expect(currentDraft().id).not.toBe(source.id);
    expect(currentDraft().tracks).toHaveLength(0);
    expect(mocks.player.load).toHaveBeenCalledOnce();
    expect(mocks.player.stop).not.toHaveBeenCalled();
  });

  it('exposes selected Delete routine beside Close and keeps cancellation nonmutating', async () => {
    await open(); await settled();
    const footer = nodes.find(node => node.className === 'editor-footer')!;
    const remove = footer.querySelectorAll('button').find(node => node.title === t('deleteRoutine'))!;
    expect(remove.hidden).toBe(false); expect(remove.disabled).toBe(false);
    vi.mocked(confirm).mockReturnValueOnce(false); remove.click(); await settled();
    expect(mocks.deleteRoutine).not.toHaveBeenCalled(); expect(currentDraft()).toEqual(source);
    remove.click(); await settled(); expect(mocks.deleteRoutine).toHaveBeenCalledExactlyOnceWith(source.id, 4);
  });

  it('deletes the exact other chooser ID despite duplicate names without changing current draft or Teach', async () => {
    const other = { ...structuredClone(source), id: 'other-same-name', revision: 7 }; records.set(other.id, other);
    await open(); await settled(); const prepared = structuredClone(mocks.player.load.mock.calls);
    button(t('openDifferent')).click();
    const rows = nodes.find(node => node.className === 'routine-library-rows')!;
    const matching = rows.querySelectorAll('.routine-library-row').filter(row => row.querySelector('.library-row-name')?.textContent === source.name);
    expect(matching).toHaveLength(2);
    const target = matching.find(row => !row.querySelector('.current-routine'))!;
    const remove = target.querySelectorAll('button').find(node => node.title === t('deleteRoutine'))!;
    mocks.preview.stop.mockClear(); vi.mocked(confirm).mockReturnValueOnce(false); remove.click(); await settled();
    expect(mocks.deleteRoutine).not.toHaveBeenCalled();
    remove.click(); await settled();
    expect(mocks.deleteRoutine).toHaveBeenCalledExactlyOnceWith(other.id, 7);
    expect(currentDraft()).toEqual(source); expect(mocks.player.load.mock.calls).toEqual(prepared);
    expect(mocks.player.stop).not.toHaveBeenCalled(); expect(mocks.preview.stop).not.toHaveBeenCalled();
    expect(mocks.clearActiveRoutine).not.toHaveBeenCalled();
  });

  it('omits chooser deletion for locked or published routines and rejects a changed target head', async () => {
    const locked = { ...structuredClone(source), id: 'locked-other', locked: true };
    const publication = { ...structuredClone(source), id: 'published-other', published: true };
    records.set(locked.id, locked); mocks.listRoutinePublications.mockResolvedValue([publication]);
    const other = { ...structuredClone(source), id: 'changing-other' }; records.set(other.id, other);
    await open(); await settled(); button(t('openDifferent')).click();
    const rows = nodes.find(node => node.className === 'routine-library-rows')!.querySelectorAll('.routine-library-row');
    expect(rows.filter(row => row.querySelectorAll('button').some(node => node.title === t('deleteRoutine')))).toHaveLength(2);
    const target = rows.find(row => !row.querySelector('.current-routine') && row.querySelectorAll('button').some(node => node.title === t('deleteRoutine')))!;
    records.set(other.id, { ...other, revision: other.revision + 1 });
    target.querySelectorAll('button').find(node => node.title === t('deleteRoutine'))!.click(); await settled();
    expect(mocks.deleteRoutine).not.toHaveBeenCalled(); expect(currentDraft()).toEqual(source);
  });

  it.each(['routine_locked', 'routine_conflict'])('surfaces local delete %s and retains the selected routine', async code => {
    await open(); mocks.deleteRoutine.mockRejectedValueOnce(new Error(code));
    button(t('localDelete')).click(); await settled();
    expect(currentDraft()).toEqual(source);
    expect(nodes.some(node => node.className.includes('notice-error') && !node.hidden)).toBe(true);
  });

  it('uses persisted revisions and keeps both A and saved duplicate B selectable', async () => {
    await open();
    editName('Routine A edited');
    button(t('save')).click(); await settled();
    expect(mocks.saveRoutineWorkingCopy).toHaveBeenLastCalledWith(expect.objectContaining({ routine: expect.objectContaining({ revision: 4 }) }),
      { expectedLocalVersion: null, cloud: false, cloudBaseRevision: null });
    expect(currentDraft().revision).toBe(4);
    await duplicateRoutine();
    const duplicateId = currentDraft().id;
    button(t('save')).click(); await settled();
    expect(mocks.saveRoutineWorkingCopy).toHaveBeenLastCalledWith(expect.objectContaining({ routine: expect.objectContaining({ id: duplicateId, revision: 1 }) }),
      { expectedLocalVersion: null, cloud: false, cloudBaseRevision: null });
    expect((await mocks.listRoutineWorkingCopies()).map(copy => copy.envelope.routine.id)).toEqual([source.id, duplicateId]);
    choose(source.id); await settled();
    expect(currentDraft().name).toBe('Routine A edited');
    expect(mocks.setActiveRoutine).toHaveBeenLastCalledWith(source.id);
    expect(records.size).toBe(1); expect(mocks.saveRoutine).not.toHaveBeenCalled();
  });

  it('confirms switching a dirty duplicate without discarding it on Cancel', async () => {
    await open();
    await duplicateRoutine();
    const draftId = currentDraft().id;
    vi.mocked(confirm).mockReturnValueOnce(false);
    choose(source.id); await settled();
    expect(currentDraft().id).toBe(draftId);
    expect(selection().value).toBe('');
    expect(mocks.setActiveRoutine).not.toHaveBeenCalled();
    choose(source.id); await settled();
    expect(currentDraft().id).toBe(source.id);
  });

  it('confirms explicit lock/unlock actions and preserves content without assigning revisions', async () => {
    await open(); editName('Save these edits');
    vi.mocked(confirm).mockReturnValueOnce(false);
    button(t('lock')).click(); await settled();
    expect(mocks.saveRoutine).not.toHaveBeenCalled();
    button(t('lock')).click(); await settled();
    expect(mocks.saveRoutine).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Save these edits', revision: 4, locked: false }), 4, 'lock');
    expect(currentDraft().locked).toBe(true);
    expect(button(t('save')).disabled).toBe(true);
    button(t('unlock')).click(); await settled();
    expect(mocks.saveRoutine).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Save these edits', revision: 5, locked: true }), 5, 'unlock');
    expect(currentDraft()).toEqual({ ...source, name: 'Save these edits', revision: 6 });
  });

  it('keeps stale content and its expected revision after a conflict without retrying', async () => {
    await open(); editName('Keep this stale draft');
    mocks.saveRoutineWorkingCopy.mockRejectedValue(new Error('routine_conflict'));
    button(t('save')).click(); await settled();
    expect(mocks.saveRoutineWorkingCopy).toHaveBeenCalledOnce();
    expect(currentDraft().name).toBe('Keep this stale draft');
    expect(currentDraft().revision).toBe(4);
    expect(nodes.some(node => node.textContent === t('routineConflict'))).toBe(true);
    expect(mocks.setActiveRoutine).not.toHaveBeenCalled();
    records.set(source.id, { ...source, name: 'Saved elsewhere', revision: 7 });
    choose(source.id); await settled();
    expect(confirm).toHaveBeenCalledWith(t('confirmSwitch', { name: 'Keep this stale draft' }));
    expect(currentDraft().name).toBe('Saved elsewhere');
    expect(currentDraft().revision).toBe(7);
    expect(mocks.saveRoutineWorkingCopy).toHaveBeenCalledOnce(); expect(mocks.saveRoutine).not.toHaveBeenCalled();
  });

  it('keeps Pause and Stop available during storage work without changing the playback snapshot', async () => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('play')).disabled).toBe(false));
    button(t('play')).click();
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
    const loaded = mocks.player.load.mock.calls[0]![0] as Routine;
    editName('Draft changed while playing');
    const saving = deferred();
    const store = mocks.saveRoutineWorkingCopy.getMockImplementation()!;
    mocks.saveRoutineWorkingCopy.mockImplementation(async (...args) => { await saving.promise; return store(...args); });
    button(t('save')).click();
    expect(button(t('save')).disabled).toBe(true);
    expect(button(t('pause')).disabled).toBe(false);
    expect(button(t('stop')).disabled).toBe(false);
    button(t('pause')).click();
    expect(mocks.player.pause).toHaveBeenCalledOnce();
    button(t('stop')).click();
    expect(mocks.player.stop).toHaveBeenCalledOnce();
    expect(loaded.name).toBe('Routine A');
    expect(mocks.player.load).toHaveBeenCalledOnce();
    saving.resolve(); await settled();
  });

  it.each(['pause', 'stop'] as const)('lets %s cancel preparation before any load begins', async command => {
    const readiness = deferred();
    mocks.getReadiness.mockImplementation(async () => { await readiness.promise; return { ready: true, missing: [] }; });
    await import('../frontend/src/main');
    await vi.waitFor(() => expect(mocks.getReadiness).toHaveBeenCalled());
    expect(button(t(command)).disabled).toBe(false);
    button(t(command)).click();
    expect(mocks.player[command]).toHaveBeenCalledOnce();
    readiness.resolve();
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
    expect(mocks.player.load).not.toHaveBeenCalled();
  });

  it.each(['wav', 'opus'])('shows pending %s preparation until storage completes and keeps Stop separate from import', async extension => {
    await open();
    button(t('teach')).click();
    await vi.waitFor(() => expect(button(t('play')).disabled).toBe(false));
    button(t('play')).click();
    await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
    const importing = deferred();
    const filename = `<Synthetic & audio>.${extension}`;
    mocks.storeTrack.mockImplementation(async () => { await importing.promise; return { ...source.tracks[0], id: 'track-b', title: filename }; });
    const input = nodes.find(node => node.className === 'visually-hidden')!;
    const file = new File([new Uint8Array(128)], filename, { type: extension === 'opus' ? 'audio/ogg' : 'audio/wav' });
    Object.assign(input, { files: [file] });
    input.dispatchEvent(new Event('change'));
    const notice = nodes.find(node => node.classList.contains('notice'))!;
    expect(notice.hidden).toBe(false);
    expect(notice.children[0]!.textContent).toBe(t('preparingAudio', { name: filename }));
    expect(notice.children[0]!.attributes.get('role')).toBe('status');
    expect(notice.children[0]!.children).toHaveLength(0);
    expect(currentDraft().tracks).toHaveLength(1);
    expect(button(t('save')).disabled).toBe(true);
    expect(button(t('pause')).disabled).toBe(false);
    expect(button(t('stop')).disabled).toBe(false);
    button(t('stop')).click();
    expect(mocks.player.stop).toHaveBeenCalledOnce();
    expect(notice.children[0]!.textContent).toBe(t('preparingAudio', { name: filename }));
    importing.resolve(); await settled();
    expect(currentDraft().tracks).toHaveLength(2);
    expect(currentDraft().tracks[1]!.title).toBe(filename);
    expect(file.name).toBe(filename);
    expect(mocks.storeTrack).toHaveBeenCalledExactlyOnceWith(file);
    expect(notice.children[0]!.textContent).toBe(t('importedToast', { count: 1 }));
  });

  it.each([
    ['conversion_failed', 'audioConversionFailed'], ['conversion_worker_failed', 'audioConversionFailed'],
    ['conversion_unavailable', 'audioConversionUnavailable'], ['conversion_timeout', 'audioConversionTimeout'],
    ['conversion_invalid_output', 'audioConversionInvalid'], ['conversion_protected_audio', 'audioConversionUnsupported'],
    ['audio_byte_limit', 'audioByteLimit'],
  ] as const)('replaces preparation with the localized %s error without appending a track', async (code, message) => {
    await open();
    const before = structuredClone(currentDraft());
    const importing = deferred();
    mocks.storeTrack.mockReturnValueOnce(importing.promise);
    const filename = '<Failed & audio>.opus';
    const input = nodes.find(node => node.className === 'visually-hidden')!;
    Object.assign(input, { files: [new File([new Uint8Array(128)], filename, { type: 'audio/ogg' })] });
    input.dispatchEvent(new Event('change'));
    const notice = nodes.find(node => node.classList.contains('notice'))!;
    expect(notice.children[0]!.textContent).toBe(t('preparingAudio', { name: filename }));
    importing.reject(new Error(code));
    await settled();
    expect(currentDraft()).toEqual(before);
    expect(notice.children[0]!.attributes.get('role')).toBe('alert');
    expect(notice.children[0]!.textContent).toBe([
      t('importedToast', { count: 0 }), t('importFailure', { name: filename, error: t(message) }),
    ].join('\n'));
    expect(button(t('import')).disabled).toBe(false);
  });

  for (const method of ['load', 'play', 'next'] as const) {
    it.each(['pause', 'stop'] as const)(`lets %s cancel a pending player.${method} call`, async command => {
      await open();
      if (method !== 'load') {
        button(t('teach')).click();
        await vi.waitFor(() => expect(button(t('play')).disabled).toBe(false));
      }
      if (method === 'next') {
        button(t('play')).click();
        await vi.waitFor(() => expect(button(t('next')).disabled).toBe(false));
      }
      const pending = deferred();
      mocks.player[method].mockImplementationOnce(() => pending.promise);
      const before = mocks.player[method].mock.calls.length;
      if (method === 'load') { editName('New preparation'); button(t('edit')).click(); }
      button(t(method === 'load' ? 'teach' : method)).click();
      await vi.waitFor(() => expect(mocks.player[method]).toHaveBeenCalledTimes(before + 1));
      expect(button(t('pause')).disabled).toBe(false);
      expect(button(t('stop')).disabled).toBe(false);
      expect(button(t('next')).disabled).toBe(true);
      button(t(command)).click();
      expect(mocks.player[command]).toHaveBeenCalledOnce();
      pending.resolve();
      await vi.waitFor(() => expect(button(t('duplicate')).disabled).toBe(false));
      expect(mocks.player.play).toHaveBeenCalledTimes(method === 'load' ? 0 : 1);
      if (method === 'load') expect(button(t('play')).disabled).toBe(true);
    });
  }
});