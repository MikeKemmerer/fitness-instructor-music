export type Role = 'owner' | 'editor' | 'player';
export type CueAnchor =
  | { kind: 'timestamp'; seconds: number }
  | { kind: 'count'; count: number }
  | { kind: 'interval'; seconds: number };

export interface Cue {
  id: string;
  anchor: CueAnchor;
  note: string;
  beep?: boolean;
}

export interface Track {
  id: string;
  title: string;
  duration: number;
  bpm: number;
  firstBeat: number;
  cues: Cue[];
  bodyArea: string;
  gain?: number;
  after?: TrackTransition;
}

export interface AudioAsset {
  id: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface FillerRecording {
  id: string;
  name: string;
  duration: number;
  asset: AudioAsset;
}

export interface Filler {
  mode: 'none' | 'timed' | 'hold';
  seconds: number;
  bpm: number;
  sound: 'soft' | 'bright' | 'drums' | 'lofi' | 'recording';
  gain?: number;
  recording?: FillerRecording;
}

export interface Routine {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  locked: boolean;
  published: boolean;
  tracks: Track[];
  filler: Filler;
  crossfade: number;
  beepEvery: number;
  beepRemaining: number;
  beepOnceRemaining?: number;
}

export type TrackTransition = { mode: 'none' } | { mode: 'custom'; filler: Filler; crossfade?: number };

export function transitionAfter(routine: Routine, index: number): { filler: Filler; crossfade: number } {
  const after = routine.tracks[index]?.after;
  if (index >= routine.tracks.length - 1 || after?.mode === 'none') {
    return { filler: { ...routine.filler, mode: 'none' }, crossfade: routine.crossfade };
  }
  return after?.mode === 'custom'
    ? { filler: after.filler, crossfade: after.crossfade ?? routine.crossfade }
    : { filler: routine.filler, crossfade: routine.crossfade };
}

export function cueSeconds(cue: Cue, track: Track, tempoRatio = 1): number {
  if (!Number.isFinite(tempoRatio) || tempoRatio <= 0) throw new Error('Invalid tempo ratio');
  if (cue.anchor.kind === 'interval') return cue.anchor.seconds;
  if (cue.anchor.kind === 'timestamp') return cue.anchor.seconds / tempoRatio;
  if (!(track.bpm > 0) || cue.anchor.count < 1) throw new Error('Invalid beat grid');
  return (track.firstBeat + (cue.anchor.count - 1) * 60 / track.bpm) / tempoRatio;
}

export function validateRoutine(routine: Routine): string[] {
  const errors: string[] = [];
  const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
  if (!routine || typeof routine !== 'object' || Array.isArray(routine)) return ['Invalid routine'];
  if (routine.schemaVersion !== 1) errors.push('Unsupported schema');
  if (typeof routine.id !== 'string' || !routine.id || typeof routine.name !== 'string' || !routine.name.trim() || routine.name.length > 160) errors.push('Invalid routine name or ID');
  if (!Number.isInteger(routine.revision) || routine.revision < 1) errors.push('Invalid revision');
  if (typeof routine.locked !== 'boolean' || typeof routine.published !== 'boolean') errors.push('Invalid routine state');
  if (!nonnegative(routine.crossfade) || routine.crossfade > 12) errors.push('Crossfade must be 0-12 seconds');
  if (!nonnegative(routine.beepEvery) || !nonnegative(routine.beepRemaining)) errors.push('Invalid beep timing');
  if (routine.beepOnceRemaining !== undefined && (!nonnegative(routine.beepOnceRemaining) || routine.beepOnceRemaining > 1200)) errors.push('Invalid beep timing');
  if (!routine.filler || typeof routine.filler !== 'object' || Array.isArray(routine.filler)) return [...errors, 'Invalid filler'];
  if (!['none', 'timed', 'hold'].includes(routine.filler.mode) || !['soft', 'bright', 'drums', 'lofi', 'recording'].includes(routine.filler.sound)) errors.push('Invalid filler');
  if (routine.filler.sound === 'recording') {
    if (!validFillerRecording(routine.filler.recording)) errors.push('Invalid filler recording');
  } else if (routine.filler.recording !== undefined) errors.push('Invalid filler recording');
  if (!nonnegative(routine.filler.seconds) || routine.filler.seconds > 600 || !Number.isFinite(routine.filler.bpm) || routine.filler.bpm < 40 || routine.filler.bpm > 220) errors.push('Invalid filler timing');
  if (routine.filler.gain !== undefined && (!nonnegative(routine.filler.gain) || routine.filler.gain > 1.5)) errors.push('Invalid filler gain');
  if (!Array.isArray(routine.tracks)) return [...errors, 'Invalid tracks'];
  if (routine.tracks.length > 100) errors.push('Too many tracks');
  const ids = new Set<string>();
  for (const track of routine.tracks) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) { errors.push('Invalid track'); continue; }
    if (typeof track.id !== 'string' || !track.id || ids.has(track.id)) errors.push('Track entry IDs must be unique');
    ids.add(track.id);
    if (typeof track.title !== 'string' || !track.title.trim() || track.title.length > 300 || typeof track.bodyArea !== 'string' || track.bodyArea.length > 160) errors.push('Invalid track text');
    if (track.gain !== undefined && (!nonnegative(track.gain) || track.gain > 1.5)) errors.push('Invalid track gain');
    if (track.after !== undefined) {
      const after = track.after;
      if (!after || typeof after !== 'object' || !['none', 'custom'].includes(after.mode)) errors.push('Invalid transition');
      else if (after.mode === 'custom') {
        if (!after.filler || typeof after.filler !== 'object') errors.push('Invalid transition');
        else if (validateRoutine({ ...routine, tracks: [], filler: after.filler, crossfade: after.crossfade ?? routine.crossfade }).length) errors.push('Invalid transition');
      }
    }
    if (!Number.isFinite(track.duration) || track.duration <= 0 || track.duration > 1200) errors.push('Track duration must be 0-1200 seconds');
    if (!Number.isFinite(track.bpm) || track.bpm < 40 || track.bpm > 220 || !nonnegative(track.firstBeat) || track.firstBeat >= track.duration) errors.push('Invalid track beat grid');
    const cueIds = new Set<string>();
    if (!Array.isArray(track.cues)) { errors.push('Invalid cues'); continue; }
    for (const cue of track.cues) {
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) { errors.push('Invalid cue'); continue; }
      if (typeof cue.id !== 'string' || !cue.id || cueIds.has(cue.id)) errors.push('Cue IDs must be unique');
      cueIds.add(cue.id);
      if (typeof cue.note !== 'string' || !cue.note.trim() || cue.note.length > 500) errors.push('Invalid cue note');
      if (cue.beep !== undefined && typeof cue.beep !== 'boolean') errors.push('Invalid cue beep');
      if (!cue.anchor || typeof cue.anchor !== 'object' || !['timestamp', 'count', 'interval'].includes(cue.anchor.kind)) {
        errors.push('Invalid cue kind');
        continue;
      }
      try {
        const position = cueSeconds(cue, track);
        if (!nonnegative(position) || position >= track.duration) errors.push('Cue outside track');
      } catch { errors.push('Invalid cue position'); }
    }
  }
  return errors;
}

export function validFillerRecording(value: unknown): value is FillerRecording {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recording = value as FillerRecording;
  const safeId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id);
  const asset = recording.asset;
  return safeId(recording.id) && typeof recording.name === 'string' && !!recording.name.trim() && recording.name.length <= 160
    && Number.isFinite(recording.duration) && recording.duration > 0 && recording.duration <= 360
    && !!asset && typeof asset === 'object' && !Array.isArray(asset) && safeId(asset.id)
    && typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256)
    && Number.isSafeInteger(asset.bytes) && asset.bytes >= 44 && asset.bytes <= 128 * 1024 * 1024
    && ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm'].includes(asset.contentType);
}

export function reorderTrack(routine: Routine, trackId: string, destination: number): boolean {
  if (routine.locked || routine.published || !Number.isInteger(destination)
    || destination < 0 || destination >= routine.tracks.length) return false;
  const source = routine.tracks.findIndex(track => track.id === trackId);
  if (source < 0 || source === destination) return false;
  const [track] = routine.tracks.splice(source, 1);
  routine.tracks.splice(destination, 0, track!);
  return true;
}

export function newRoutine(): Routine {
  return {
    schemaVersion: 1, id: crypto.randomUUID(), name: 'My barre class', revision: 1,
    locked: false, published: false, tracks: [],
    filler: { mode: 'timed', seconds: 15, bpm: 100, sound: 'soft' },
    crossfade: 2, beepEvery: 0, beepRemaining: 10, beepOnceRemaining: 0,
  };
}