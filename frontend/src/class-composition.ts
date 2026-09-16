import { ListMusic, RefreshCw, Save } from 'lucide';
import { type ClassSetup, type MusicPlaylist, type RevisionReference } from '../../shared/class-plan';
import { newRoutine, type FillerRecording, type Routine } from '../../shared/routine';
import { createClassLibrary, type ClassSelection } from './class-library';
import { captureCloudIdentity, getCloudContext, getCloudRole } from './cloud-client';
import { cloudErrorMessage } from './cloud-ui';
import { createDraftProtection } from './draft-protection';
import { fillerControls } from './filler-controls';
import * as offline from './offline';
import { t } from './i18n';
import { element, field, iconButton, numberInput, selectInput, textInput } from './ui';

type Phase = 'walkIn' | 'before' | 'after' | 'walkOut';
const phases: Phase[] = ['walkIn', 'before', 'after', 'walkOut'];
const labels = { walkIn: 'enableWalkIn', before: 'enableBefore', after: 'enableAfter', walkOut: 'enableWalkOut' } as const;
const reference = (value: RevisionReference): RevisionReference => ({ id: value.id, revision: value.revision, published: value.published });

export function createClassComposition(context: {
  hosted: boolean;
  routine(): Routine;
  routineSaved(): boolean;
  source(): ClassSelection['source'];
  selection(): ClassSelection | null;
  busy(): boolean;
  recordings(): FillerRecording[];
  select(value: ClassSelection): void;
  managePlaylists(): void;
  changed(): void;
  message(message: string, error?: boolean): void;
}) {
  const controls = element('section', 'class-composition');
  controls.setAttribute('aria-label', t('classSequence'));
  const toggles = element('div', 'phase-toggles');
  const settings = element('div', 'phase-setup');
  controls.append(element('h2', '', t('classSequence')), toggles, settings);
  const beforeTracks = element('div', 'before-routine-phases');
  const afterTracks = element('div', 'after-routine-phases');
  const library = createClassLibrary();
  let setup: ClassSetup | null = null;
  let source = context.source();
  let selectedKey = '';
  let dirty = false;
  let busy = false;
  let disposed = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let playlists: MusicPlaylist[] = [];
  let catalogLoaded = false;
  let catalogRequested = false;
  let revision: number | null = null;
  const enabled = { walkIn: false, before: false, after: false, walkOut: false };
  let retained: Partial<Pick<ClassSetup, Phase>> = {};
  const inputs = new Map<Phase, HTMLInputElement>();
  const fields: HTMLFieldSetElement[] = [];
  const author = () => !context.hosted || ['owner', 'editor'].includes(getCloudRole() ?? '');
  const available = () => !disposed && !busy && !context.busy();
  const editable = () => available() && author() && !setup?.locked && !setup?.published
    && ((setup ? source : context.source()) === 'local' || getCloudContext().access === 'online');
  const incomplete = () => (enabled.walkIn && !setup?.walkIn) || (enabled.walkOut && !setup?.walkOut);
  const protection = createDraftProtection({ editable, apply(value) {
    if (!('routine' in value)) return;
    setup = value; retained = {}; for (const phase of phases) enabled[phase] = !!setup[phase];
    changed(); render();
  } });
  function changed() {
    dirty = true;
    if (setup) protection.observe({ kind: 'class', source, value: setup, baseRevision: revision, media: {} }, true);
    syncControls(); context.changed();
  }
  function ensureSetup() {
    if (setup) return;
    source = context.source(); playlists = []; catalogLoaded = false; catalogRequested = false;
    const routine = context.routine();
    setup = { schemaVersion: 1, id: crypto.randomUUID(), name: t('routineClassName', { name: routine.name }).slice(0, 160),
      revision: 1, locked: false, published: false, routine: reference(routine), crossfade: 2 };
    revision = null;
    protection.observe({ kind: 'class', source, value: setup, baseRevision: null, media: {} }, false);
  }
  async function run(work: (signal: AbortSignal, assert: () => void) => Promise<void>) {
    if (!available()) return;
    const epoch = ++generation;
    busy = true; controller = new AbortController(); const active = controller;
    syncControls(); context.changed();
    try {
      const identity = context.hosted ? captureCloudIdentity() : () => {};
      const assert = () => { identity(); if (disposed || epoch !== generation || active.signal.aborted) throw new Error('cloud_cancelled'); };
      assert(); await work(active.signal, assert);
    } catch (error) { if (!disposed) context.message(cloudErrorMessage(error), true); }
    finally { if (epoch === generation) { busy = false; controller = null; render(); context.changed(); } }
  }
  const refresh = () => run(async (signal, assert) => {
    catalogRequested = true;
    const values = source === 'local' ? await offline.listMusicPlaylists() : await library.listPlaylists(false, { signal });
    assert();
    const publications = source === 'household' && author() ? await library.listPlaylists(true, { signal }) : [];
    assert(); playlists = [...values, ...publications]; catalogLoaded = true;
  });
  for (const phase of phases) {
    const input = element('input'); input.type = 'checkbox'; inputs.set(phase, input);
    input.addEventListener('change', () => {
      if (!editable()) { syncControls(); return; }
      ensureSetup(); enabled[phase] = input.checked;
      if (!input.checked) {
        if (setup![phase]) Object.assign(retained, { [phase]: structuredClone(setup![phase]) });
        delete setup![phase];
      } else if (phase === 'before' || phase === 'after') {
        setup![phase] = structuredClone(retained[phase] ?? { ...newRoutine().filler, mode: 'hold', sound: 'lofi' });
      } else if (retained[phase]) setup![phase] = structuredClone(retained[phase]);
      changed(); render();
      if (input.checked && (phase === 'walkIn' || phase === 'walkOut') && !catalogLoaded) void refresh();
    });
    toggles.append(field(t(labels[phase]), input));
  }
  const save = iconButton(t('saveClassSetup'), Save, () => {
    if (!editable() || !setup) return;
    void run(async (signal, assert) => {
      if (incomplete()) throw new Error(t('choosePhasePlaylist'));
      if (revision === null && (!context.routineSaved() || setup!.routine.id !== context.routine().id
        || setup!.routine.revision !== context.routine().revision)) throw new Error(t('saveRoutineFirst'));
      const snapshot = structuredClone(setup!);
      if (source === 'household' && !confirm(t('confirmLibraryAction', { action: t('librarySave', { name: snapshot.name, destination: t('householdDestination') }) }))) return;
      const saved = source === 'household' ? await library.saveClass(snapshot, revision, 'save', { signal })
        : await offline.saveClassSetup(snapshot, revision);
      assert(); setup = saved; revision = saved.revision; dirty = false;
      protection.observe({ kind: 'class', source, value: saved, baseRevision: revision, media: {} }, false);
      selectedKey = JSON.stringify({ setup: saved, source });
      context.select({ setup: structuredClone(saved), source });
      context.message(t('classSetupSaved'));
    });
  }, true);
  save.classList.add('primary');
  const useRoutine = iconButton(t('useCurrentRoutine'), RefreshCw, () => {
    if (!editable() || !setup || !context.routineSaved() || context.source() !== source) return;
    setup.routine = reference(context.routine()); changed(); render();
  }, true);
  function render() {
    if (disposed) return;
    fields.length = 0; beforeTracks.replaceChildren(); afterTracks.replaceChildren(); settings.replaceChildren();
    if (setup) {
      const info = element('fieldset', 'phase-identity'); fields.push(info);
      info.append(field(t('setupName'), textInput(setup.name, 160, name => { if (editable()) { setup!.name = name; changed(); } })));
      info.append(element('p', 'muted', t('phaseRoutineReference', { name: setup.routine.id === context.routine().id ? context.routine().name : setup.routine.id,
        revision: setup.routine.revision, destination: t(source === 'local' ? 'localDestination' : 'householdDestination') })), useRoutine);
      info.append(field(t('crossfade'), numberInput(setup.crossfade, 0, 12, value => { if (editable()) { setup!.crossfade = value; changed(); } })));
      settings.append(info, save, protection.element);
      for (const phase of phases) {
        if (!enabled[phase]) continue;
        const section = element('section', 'editor-section class-phase-config');
        section.dataset.classPhase = phase;
        section.setAttribute('aria-label', t(labels[phase]));
        section.append(element('h2', '', t(labels[phase])));
        const body = element('fieldset'); fields.push(body); section.append(body);
        if (phase === 'walkIn' || phase === 'walkOut') {
          const selected = setup[phase];
          const choices: RevisionReference[] = [...playlists];
          if (selected && !choices.some(value => JSON.stringify(reference(value)) === JSON.stringify(selected))) choices.push(selected);
          const choice = selectInput(selected ? JSON.stringify(selected) : '', [{ value: '', label: t('choosePhasePlaylist') },
            ...choices.map(value => ({ value: JSON.stringify(reference(value)), label: `${playlists.find(item => item.id === value.id)?.name ?? value.id} / ${value.revision} / ${t(value.published ? 'exportPublished' : 'draft')}` }))], value => {
            if (!editable()) return;
            const match = choices.find(item => JSON.stringify(reference(item)) === value);
            if (match) setup![phase] = reference(match); else delete setup![phase];
            changed(); render();
          });
          choice.required = true;
          body.append(field(t('selectMusicPlaylist'), choice), iconButton(t('refreshPlaylists'), RefreshCw, () => { void refresh(); }),
            iconButton(t('manageMusicPlaylists'), ListMusic, () => { if (available()) context.managePlaylists(); }, true));
          if (!selected) body.append(element('p', 'muted', t('choosePhasePlaylist')));
        } else if (setup[phase]) body.append(fillerControls(setup[phase], context.recordings, changed, editable, true));
        (phase === 'walkIn' || phase === 'before' ? beforeTracks : afterTracks).append(section);
      }
    }
    syncControls();
  }
  function syncControls() {
    controls.hidden = !author() && !setup;
    for (const [phase, input] of inputs) { input.checked = enabled[phase]; input.disabled = !editable(); }
    for (const fieldset of fields) fieldset.disabled = !editable();
    save.disabled = !editable() || !dirty || incomplete() || (revision === null && !context.routineSaved());
    useRoutine.disabled = !editable() || !context.routineSaved() || source !== context.source();
    protection.sync();
  }
  render();
  return { controls, beforeTracks, afterTracks,
    pending: () => dirty,
    working: () => busy,
    hasUnsaved: () => dirty,
    sync() {
      const selection = context.selection();
      const key = JSON.stringify(selection);
      if (key !== selectedKey && !dirty && !busy) {
        selectedKey = key; setup = selection ? structuredClone(selection.setup) : null;
        source = selection?.source ?? context.source(); revision = setup?.revision ?? null;
        catalogLoaded = false; catalogRequested = false; playlists = []; retained = {};
        for (const phase of phases) enabled[phase] = !!setup?.[phase];
        if (setup) protection.observe({ kind: 'class', source, value: setup, baseRevision: revision, media: {} }, false);
        render();
      } else syncControls();
      if (setup && (enabled.walkIn || enabled.walkOut) && !catalogRequested && available() && author()
        && (source === 'local' || getCloudContext().access === 'online')) void refresh();
    },
    discard() { if (busy || (dirty && !confirm(t('discardPhaseChanges')))) return false; dirty = false; selectedKey = ''; return true; },
    dispose() { disposed = true; generation++; controller?.abort(); protection.dispose(); },
  };
}