import { validateClassSetup, validateMusicPlaylist, type ClassAudio, type ClassPhase, type ClassSetup, type MusicPlaylist } from '../../shared/class-plan';
import { newRoutine, type Filler, type Routine } from '../../shared/routine';

export function snapshotClassAudio(value: ClassAudio): ClassAudio {
  const audio = structuredClone(value);
  try {
    if (!audio || Object.keys(audio).some(key => !['walkIn', 'walkOut', 'before', 'after', 'crossfade'].includes(key))) {
      throw new Error('invalid_class_audio');
    }
    const routine = newRoutine();
    checkedClassSetup({ schemaVersion: 1, id: 'prepared', name: 'Prepared', revision: 1,
      locked: false, published: false, routine: { id: routine.id, revision: 1, published: false },
      before: audio.before, after: audio.after, crossfade: audio.crossfade });
    for (const playlist of [audio.walkIn, audio.walkOut]) {
      if (playlist !== undefined) checkedMusicPlaylist(playlist);
    }
    if (!audio.walkIn?.tracks.length) delete audio.walkIn;
    if (!audio.walkOut?.tracks.length) delete audio.walkOut;
    return audio;
  } catch { throw new Error('invalid_class_audio'); }
}

export function classPhases(audio: ClassAudio): Exclude<ClassPhase, 'finished'>[] {
  return [audio.walkIn && 'walk-in', audio.before && 'before', 'routine', audio.after && 'after',
    audio.walkOut && 'walk-out'].filter(Boolean) as Exclude<ClassPhase, 'finished'>[];
}

export function routineFillers(routine: Routine): Filler[] {
  return [routine.filler, ...routine.tracks.flatMap(track => track.after?.mode === 'custom' ? [track.after.filler] : [])];
}

export function classFillers(routine: Routine, audio?: ClassAudio): Filler[] {
  return [...routineFillers(routine), ...[audio?.before, audio?.after].filter((filler): filler is Filler => !!filler)];
}

export function fillerKey(filler: Filler): string {
  return filler.sound === 'recording' ? JSON.stringify(filler.recording) :
    JSON.stringify([filler.sound, filler.sound === 'lofi' ? null : filler.bpm]);
}

function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid_fields');
}

function safeId(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) throw new Error('invalid_id');
}

function fillerFields(filler: Filler): void {
  fields(filler, ['mode', 'seconds', 'bpm', 'sound', 'gain', 'recording']);
  if (filler.recording !== undefined) {
    fields(filler.recording, ['id', 'name', 'duration', 'asset']);
    fields(filler.recording.asset, ['id', 'sha256', 'bytes', 'contentType']);
  }
}

export function checkedMusicPlaylist(value: MusicPlaylist): MusicPlaylist {
  try {
    const playlist = structuredClone(value);
    fields(playlist, ['schemaVersion', 'id', 'name', 'revision', 'locked', 'published', 'tracks']);
    safeId(playlist.id);
    if (!Array.isArray(playlist.tracks)) throw new Error('invalid_tracks');
    for (const track of playlist.tracks) {
      fields(track, ['id', 'title', 'duration', 'bpm', 'firstBeat', 'cues', 'bodyArea', 'gain']);
      safeId(track.id);
      if (!Array.isArray(track.cues) || track.cues.length) throw new Error('invalid_cues');
    }
    if (validateMusicPlaylist(playlist).length) throw new Error('invalid_playlist');
    return playlist;
  } catch { throw new Error('invalid_playlist'); }
}

export function checkedClassSetup(value: ClassSetup): ClassSetup {
  try {
    const setup = structuredClone(value);
    fields(setup, ['schemaVersion', 'id', 'name', 'revision', 'locked', 'published', 'routine', 'walkIn', 'walkOut', 'before', 'after', 'crossfade']);
    safeId(setup.id);
    for (const reference of [setup.routine, setup.walkIn, setup.walkOut]) {
      if (reference !== undefined) fields(reference, ['id', 'revision', 'published']);
    }
    for (const filler of [setup.before, setup.after]) if (filler !== undefined) fillerFields(filler);
    if (validateClassSetup(setup).length) throw new Error('invalid_class_setup');
    return setup;
  } catch { throw new Error('invalid_class_setup'); }
}