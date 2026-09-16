import { newRoutine, validateRoutine, type AudioAsset, type Filler, type Routine, type Track } from './routine';

export interface MusicPlaylist {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  locked: boolean;
  published: boolean;
  tracks: Track[];
}

export interface RevisionReference {
  id: string;
  revision: number;
  published: boolean;
}

export interface ClassSetup {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  locked: boolean;
  published: boolean;
  routine: RevisionReference;
  walkIn?: RevisionReference;
  walkOut?: RevisionReference;
  before?: Filler;
  after?: Filler;
  crossfade: number;
}

export interface CloudMusicPlaylist {
  playlist: MusicPlaylist;
  media: Record<string, AudioAsset>;
}

export interface ClassAudio {
  walkIn?: MusicPlaylist;
  walkOut?: MusicPlaylist;
  before?: Filler;
  after?: Filler;
  crossfade: number;
}

export interface PreparedClass {
  setup: ClassSetup;
  routine: Routine;
  audio: ClassAudio;
}

export type ClassPhase = 'walk-in' | 'before' | 'routine' | 'after' | 'walk-out' | 'finished';

export function newMusicPlaylist(): MusicPlaylist {
  return { schemaVersion: 1, id: crypto.randomUUID(), name: 'New playlist', revision: 1,
    locked: false, published: false, tracks: [] };
}

export function validateMusicPlaylist(playlist: MusicPlaylist): string[] {
  if (!playlist || typeof playlist !== 'object' || Array.isArray(playlist)) return ['Invalid playlist'];
  const errors = validateRoutine({ schemaVersion: playlist.schemaVersion, id: playlist.id, name: playlist.name,
    revision: playlist.revision, locked: playlist.locked, published: playlist.published, tracks: playlist.tracks,
    filler: { mode: 'none', seconds: 0, bpm: 100, sound: 'soft' }, crossfade: 0, beepEvery: 0, beepRemaining: 0 });
  if (Object.keys(playlist).some(key => !['schemaVersion', 'id', 'name', 'revision', 'locked', 'published', 'tracks'].includes(key))) errors.push('Invalid playlist fields');
  if (Array.isArray(playlist.tracks) && playlist.tracks.some(track => !track || !Array.isArray(track.cues) || track.cues.length !== 0 || track.after !== undefined)) errors.push('Playlist entries cannot contain choreography');
  return errors;
}

export function validateClassSetup(setup: ClassSetup): string[] {
  const errors: string[] = [];
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return ['Invalid class setup'];
  const validReference = (reference: RevisionReference | undefined) => !!reference && typeof reference.id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(reference.id)
    && Number.isSafeInteger(reference.revision) && reference.revision >= 1 && typeof reference.published === 'boolean';
  if (setup.schemaVersion !== 1 || typeof setup.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(setup.id)
    || typeof setup.name !== 'string' || !setup.name.trim() || setup.name.length > 160
    || !Number.isSafeInteger(setup.revision) || setup.revision < 1
    || typeof setup.locked !== 'boolean' || typeof setup.published !== 'boolean') errors.push('Invalid class setup');
  if (!validReference(setup.routine) || (setup.walkIn !== undefined && !validReference(setup.walkIn))
    || (setup.walkOut !== undefined && !validReference(setup.walkOut))) errors.push('Invalid class reference');
  if (!Number.isFinite(setup.crossfade) || setup.crossfade < 0 || setup.crossfade > 12) errors.push('Invalid class fade');
  for (const filler of [setup.before, setup.after]) {
    if (filler !== undefined && (!filler || typeof filler !== 'object' || filler.mode !== 'hold' || validateRoutine({ ...newRoutine(), filler }).length)) errors.push('Invalid announcement filler');
  }
  if (setup.published && [setup.routine, setup.walkIn, setup.walkOut].some(reference => reference && !reference.published)) {
    errors.push('Published setups require published references');
  }
  return errors;
}