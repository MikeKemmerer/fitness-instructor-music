import { ListMusic, RefreshCw } from 'lucide';
import type { MusicPlaylist } from '../../shared/class-plan';
import { allRoutineTracks, newRoutine, type AudioAsset, type FillerRecording, type Routine, type RoutineSequence } from '../../shared/routine';
import { createClassLibrary, type ClassSelection } from './class-library';
import { captureCloudIdentity, getCloudContext, getCloudRole } from './cloud-client';
import { cloudErrorMessage } from './cloud-ui';
import { cloudHash, createCloudLibrary } from './cloud-library';
import { fillerControls } from './filler-controls';
import * as offline from './offline';
import { t } from './i18n';
import { element, field, gainSlider, iconButton, numberInput, selectInput } from './ui';

type Phase = 'walkIn' | 'before' | 'after' | 'walkOut';
const phases: Phase[] = ['walkIn', 'before', 'after', 'walkOut'];
const labels = { walkIn: 'enableWalkIn', before: 'enableBefore', after: 'enableAfter', walkOut: 'enableWalkOut' } as const;
export interface PhaseChoices {
  enabled: Record<Phase, boolean>;
  retained: Partial<Pick<RoutineSequence, Phase>>;
}

export function createClassComposition(context: {
  hosted: boolean;
  routine(): Routine;
  routineSaved?(): boolean;
  source(): ClassSelection['source'];
  selection?(): ClassSelection | null;
  select?(value: ClassSelection): void;
  busy(): boolean;
  editable?(): boolean;
  recordings(): FillerRecording[];
  adoptMedia?(media: Record<string, AudioAsset>): void;
  managePlaylists(): void;
  changed(): void;
  status?(): void;
  message(message: string, error?: boolean): void;
}) {
  const controls = element('section', 'class-composition');
  controls.setAttribute('aria-label', t('classSequence'));
  const toggles = element('div', 'phase-toggles');
  const settings = element('div', 'phase-setup');
  controls.append(element('h2', '', t('classSequence')), toggles, settings);
  const beforeTracks = element('div', 'before-routine-phases');
  const afterTracks = element('div', 'after-routine-phases');
  const mediaLibrary = createCloudLibrary();
  const library = createClassLibrary(undefined, mediaLibrary);
  let choices: PhaseChoices = { enabled: { walkIn: false, before: false, after: false, walkOut: false }, retained: {} };
  let routineId = '';
  let fingerprint = '';
  let busy = false;
  let disposed = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let playlists: Array<{ playlist: MusicPlaylist; source: 'local' | 'household' }> = [];
  let catalogLoaded = false;
  const inputs = new Map<Phase, HTMLInputElement>();
  const fields: HTMLFieldSetElement[] = [];
  const gains: ReturnType<typeof gainSlider>[] = [];
  const author = () => !context.hosted || ['owner', 'editor'].includes(getCloudRole() ?? '');
  const available = () => !disposed && !busy && !context.busy();
  const editable = () => available() && author() && !context.routine().locked && !context.routine().published && (context.editable?.() ?? true);
  const incomplete = () => phases.some(phase => choices.enabled[phase] && !context.routine().sequence?.[phase]);
  const sequence = () => { const routine = context.routine(); routine.schemaVersion = 2; return routine.sequence ??= { crossfade: 2 }; };
  const changed = () => { fingerprint = JSON.stringify(context.routine().sequence); context.changed(); syncControls(); };
  async function run(work: (signal: AbortSignal, assert: () => void) => Promise<void>) {
    if (!available()) return;
    const epoch = ++generation;
    const currentRoutine = context.routine();
    busy = true; controller = new AbortController(); const active = controller;
    syncControls(); context.status?.();
    try {
      const identity = context.hosted ? captureCloudIdentity() : () => {};
      const assert = () => { identity(); if (disposed || epoch !== generation || active.signal.aborted || context.routine() !== currentRoutine) throw new Error('cloud_cancelled'); };
      assert(); await work(active.signal, assert);
    } catch (error) { if (!disposed) context.message(cloudErrorMessage(error), true); }
    finally { if (epoch === generation) { busy = false; controller = null; render(); context.status?.(); } }
  }
  const refresh = () => run(async (signal, assert) => {
    const local = await offline.listMusicPlaylists(); assert();
    const values = local.map(playlist => ({ playlist, source: 'local' as const }));
    const cloud = context.hosted && getCloudContext().access === 'online'
      ? [...await library.listPlaylists(false, { signal }), ...await library.listPlaylists(true, { signal })] : [];
    assert(); playlists = [...values, ...cloud.map(playlist => ({ playlist, source: 'household' as const }))]; catalogLoaded = true;
  });
  for (const phase of phases) {
    const input = element('input'); input.type = 'checkbox'; inputs.set(phase, input);
    input.addEventListener('change', () => {
      if (!editable()) { syncControls(); return; }
      const value = sequence(); choices.enabled[phase] = input.checked;
      if (!input.checked) {
        if (value[phase]) Object.assign(choices.retained, { [phase]: structuredClone(value[phase]) });
        delete value[phase];
      } else if (phase === 'before' || phase === 'after') {
        value[phase] = structuredClone(choices.retained[phase] ?? { ...newRoutine().filler, mode: 'hold', sound: 'lofi' });
      } else if (choices.retained[phase]) value[phase] = structuredClone(choices.retained[phase]);
      changed(); render();
      if (input.checked && (phase === 'walkIn' || phase === 'walkOut') && !catalogLoaded) void refresh();
    });
    toggles.append(field(t(labels[phase]), input));
  }
  async function adopt(phase: 'walkIn' | 'walkOut', selected: typeof playlists[number], signal: AbortSignal, assert: () => void) {
    const reference = selected.playlist;
    const cloud = selected.source === 'household' ? await library.readPlaylist(reference, { signal }) : null;
    assert();
    const playlist = cloud?.playlist ?? await offline.getMusicPlaylist(reference.id, reference.revision);
    assert();
    if (!playlist || playlist.id !== reference.id || playlist.revision !== reference.revision || playlist.published !== reference.published || !playlist.tracks.length) throw new Error('class_cache_unavailable');
    if (allRoutineTracks(context.routine()).length - (context.routine().sequence?.[phase]?.tracks.length ?? 0) + playlist.tracks.length > 100) throw new Error('invalid_routine');
    if (cloud) await mediaLibrary.downloadTracks(playlist.tracks, cloud.media, { signal }, reference.published ? { playlistId: reference.id, revision: reference.revision } : undefined);
    assert();
    const tracks = structuredClone(playlist.tracks);
    const media: Record<string, AudioAsset> = {};
    for (const track of tracks) {
      const originalId = track.id;
      const blob = await offline.getTrackBlob(originalId); assert();
      if (!blob) throw new Error('missing_audio');
      const hash = await cloudHash(blob); assert();
      track.id = crypto.randomUUID(); track.cues = []; delete track.after;
      await offline.cacheCloudTrack(track.id, blob, hash); assert();
      if (cloud) media[track.id] = structuredClone(cloud.media[originalId]!);
    }
    if (context.routine().locked || context.routine().published) throw new Error('routine_locked');
    sequence()[phase] = { name: playlist.name, tracks, source: { id: reference.id, revision: reference.revision, published: reference.published } };
    context.adoptMedia?.(media); changed();
  }
  function render() {
    if (disposed) return;
    fields.length = 0; gains.length = 0; beforeTracks.replaceChildren(); afterTracks.replaceChildren(); settings.replaceChildren();
    const fade = element('fieldset', 'phase-identity'); fields.push(fade);
    fade.append(field(t('crossfade'), numberInput(context.routine().sequence?.crossfade ?? 2, 0, 12, value => { if (editable()) { sequence().crossfade = value; changed(); } })));
    settings.append(fade);
    for (const phase of phases) {
      if (!choices.enabled[phase]) continue;
      const section = element('section', 'editor-section class-phase-config'); section.dataset.classPhase = phase;
      section.setAttribute('aria-label', t(labels[phase])); section.append(element('h2', '', t(labels[phase])));
      const body = element('fieldset'); fields.push(body); section.append(body);
      if (phase === 'walkIn' || phase === 'walkOut') {
        const selected = context.routine().sequence?.[phase];
        const choice = selectInput('', [{ value: '', label: selected?.name ?? t('choosePhasePlaylist') },
          ...playlists.map((entry, index) => ({ value: String(index), label: `${entry.playlist.name} / ${t(entry.source === 'local' ? 'localFilter' : 'householdFilter')} / ${t(entry.playlist.published ? 'exportPublished' : 'draft')}` }))], value => {
          if (!editable() || value === '') return;
          const item = playlists[Number(value)]; if (item) void run((signal, assert) => adopt(phase, item, signal, assert));
        });
        choice.required = !selected; choice.setAttribute('aria-invalid', String(!selected));
        body.append(field(t('selectMusicPlaylist'), choice), iconButton(t('refreshPlaylists'), RefreshCw, () => { void refresh(); }),
          iconButton(t('manageMusicPlaylists'), ListMusic, () => { if (available()) context.managePlaylists(); }, true));
        if (selected) {
          const list = element('ol', 'phase-track-list');
          for (const track of selected.tracks) {
            const row = element('li'); row.append(element('span', 'phase-track-title', track.title));
            const gain = gainSlider(t('trackGain'), () => track.gain ?? 1, value => {
              if (editable() && context.routine().sequence?.[phase]?.tracks.includes(track)) { track.gain = value; changed(); }
            }, editable);
            gains.push(gain); row.append(gain.element);
            list.append(row);
          }
          body.append(list);
        }
        else body.append(element('p', 'muted', t('choosePhasePlaylist')));
      } else {
        const filler = context.routine().sequence?.[phase];
        if (filler) body.append(fillerControls(filler, context.recordings, changed, editable, true));
      }
      (phase === 'walkIn' || phase === 'before' ? beforeTracks : afterTracks).append(section);
    }
    syncControls();
  }
  function syncControls() {
    controls.hidden = !author() && !context.routine().sequence;
    for (const [phase, input] of inputs) { input.checked = choices.enabled[phase]; input.disabled = !editable(); }
    for (const fieldset of fields) fieldset.disabled = !editable();
    for (const gain of gains) gain.sync();
  }
  return { controls, beforeTracks, afterTracks,
    pending: incomplete, working: () => busy, hasUnsaved: incomplete,
    snapshot: () => structuredClone(choices),
    restore(value: unknown) { if (value && typeof value === 'object' && 'enabled' in value && 'retained' in value) choices = structuredClone(value as PhaseChoices); fingerprint = JSON.stringify(context.routine().sequence); render(); },
    sync() {
      const routine = context.routine();
      const next = JSON.stringify(routine.sequence);
      if (routine.id !== routineId || next !== fingerprint) {
        if (routine.id !== routineId) { choices.retained = {}; catalogLoaded = false; generation++; controller?.abort(); busy = false; }
        routineId = routine.id; fingerprint = next;
        for (const phase of phases) choices.enabled[phase] = !!routine.sequence?.[phase];
        render();
      } else syncControls();
    },
    discard() { return true; },
    dispose() { disposed = true; generation++; controller?.abort(); },
  };
}