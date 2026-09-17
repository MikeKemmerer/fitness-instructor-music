import { validFillerRecording, validateRoutine, type Cue, type Filler, type FillerRecording, type Routine, type RoutinePlaylist, type RoutineSequence, type Track, type TrackTransition } from '../../shared/routine';
import { ServiceError } from './errors';

export type RoutineContent = Omit<Routine, 'id' | 'revision' | 'locked' | 'published'>;

function invalid(): never {
  throw new ServiceError(400, 'invalid_input');
}

export function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result.push(descriptor.value);
  }
  return result;
}

export function text(value: unknown, maximum = 160, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) invalid();
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalid();
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

export function choice<Value extends string>(value: unknown, values: readonly Value[]): Value {
  if (typeof value !== 'string' || !values.includes(value as Value)) invalid();
  return value as Value;
}

export function expectedRevision(value: unknown): number {
  if (value === undefined || value === null) throw new ServiceError(428, 'revision_required');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function parseCue(value: unknown): Cue {
  const hasBeep = Object.prototype.hasOwnProperty.call(value, 'beep');
  const cue = strictRecord(value, hasBeep ? ['id', 'anchor', 'note', 'beep'] : ['id', 'anchor', 'note']);
  const anchor = cue.anchor;
  if (typeof anchor !== 'object' || anchor === null) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(anchor, 'kind');
  if (!descriptor || !('value' in descriptor)) invalid();
  const kind = choice(descriptor.value, ['timestamp', 'count', 'interval'] as const);
  const fields = strictRecord(anchor, kind === 'count' ? ['kind', 'count'] : ['kind', 'seconds']);
  const position = number(kind === 'count' ? fields.count : fields.seconds);
  if (kind === 'count' && (!Number.isSafeInteger(position) || position < 1)) invalid();
  return {
    id: text(cue.id), note: text(cue.note, 500),
    ...(hasBeep ? { beep: boolean(cue.beep) } : {}),
    anchor: kind === 'count' ? { kind, count: position } : { kind, seconds: position },
  };
}

function parseTrack(value: unknown): Track {
  const fields = ['id', 'title', 'duration', 'firstBeat', 'cues', 'bodyArea'];
  const hasBpm = Object.prototype.hasOwnProperty.call(value, 'bpm');
  if (hasBpm) fields.push('bpm');
  const hasGain = Object.prototype.hasOwnProperty.call(value, 'gain');
  if (hasGain) fields.push('gain');
  const hasAfter = Object.prototype.hasOwnProperty.call(value, 'after');
  if (hasAfter) fields.push('after');
  const track = strictRecord(value, fields);
  return {
    id: text(track.id), title: text(track.title, 300), duration: number(track.duration),
    ...(hasBpm ? { bpm: number(track.bpm) } : {}), firstBeat: number(track.firstBeat),
    cues: array(track.cues, 1000).map(parseCue), bodyArea: text(track.bodyArea, 160, true),
    ...(hasGain ? { gain: number(track.gain) } : {}),
    ...(hasAfter ? { after: parseTransition(track.after) } : {}),
  };
}

function parseTransition(value: unknown): TrackTransition {
  if (typeof value !== 'object' || value === null) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'mode');
  if (!descriptor || !('value' in descriptor)) invalid();
  const mode = choice(descriptor.value, ['none', 'custom'] as const);
  if (mode === 'none') {
    strictRecord(value, ['mode']);
    return { mode };
  }
  const hasCrossfade = Object.prototype.hasOwnProperty.call(value, 'crossfade');
  const fields = strictRecord(value, hasCrossfade ? ['mode', 'filler', 'crossfade'] : ['mode', 'filler']);
  return { mode, filler: parseFiller(fields.filler),
    ...(hasCrossfade ? { crossfade: number(fields.crossfade) } : {}) };
}

export function parseFillerRecording(value: unknown): FillerRecording {
  const record = strictRecord(value, ['id', 'name', 'duration', 'asset']);
  const asset = strictRecord(record.asset, ['id', 'sha256', 'bytes', 'contentType']);
  const recording = { ...record, asset: { ...asset } };
  if (!validFillerRecording(recording)) invalid();
  return recording;
}

export function parseFiller(value: unknown): Filler {
  const fields = ['mode', 'seconds', 'bpm', 'sound'];
  const hasGain = Object.prototype.hasOwnProperty.call(value, 'gain');
  if (hasGain) fields.push('gain');
  const hasRecording = Object.prototype.hasOwnProperty.call(value, 'recording');
  if (hasRecording) fields.push('recording');
  const filler = strictRecord(value, fields);
  const sound = choice(filler.sound, ['soft', 'bright', 'drums', 'lofi', 'recording'] as const);
  if (hasRecording !== (sound === 'recording')) invalid();
  return {
    mode: choice(filler.mode, ['none', 'timed', 'hold'] as const),
    seconds: number(filler.seconds), bpm: number(filler.bpm),
    sound,
    ...(hasRecording ? { recording: parseFillerRecording(filler.recording) } : {}),
    ...(hasGain ? { gain: number(filler.gain) } : {}),
  };
}

function parseRoutinePlaylist(input: unknown): RoutinePlaylist {
  const hasSource = Object.prototype.hasOwnProperty.call(input, 'source');
  const value = strictRecord(input, hasSource ? ['name', 'tracks', 'source'] : ['name', 'tracks']);
  const playlist: RoutinePlaylist = { name: text(value.name), tracks: array(value.tracks, 100).map(parseTrack) };
  if (hasSource) {
    const source = strictRecord(value.source, ['id', 'revision', 'published']);
    playlist.source = { id: text(source.id), revision: expectedRevision(source.revision), published: boolean(source.published) };
  }
  return playlist;
}

function parseSequence(input: unknown): RoutineSequence {
  const fields = ['crossfade'];
  for (const key of ['walkIn', 'before', 'after', 'walkOut']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) fields.push(key);
  }
  const value = strictRecord(input, fields);
  const sequence: RoutineSequence = { crossfade: number(value.crossfade) };
  for (const key of ['walkIn', 'walkOut'] as const) {
    if (fields.includes(key)) sequence[key] = parseRoutinePlaylist(value[key]);
  }
  for (const key of ['before', 'after'] as const) {
    if (fields.includes(key)) sequence[key] = parseFiller(value[key]);
  }
  return sequence;
}

export function parseRoutineContent(input: unknown): RoutineContent {
  try {
    const fields = ['schemaVersion', 'name', 'tracks', 'filler', 'crossfade', 'beepEvery', 'beepRemaining'];
    if (Object.prototype.hasOwnProperty.call(input, 'beepOnceRemaining')) fields.push('beepOnceRemaining');
    if (Object.prototype.hasOwnProperty.call(input, 'sequence')) fields.push('sequence');
    if (Object.prototype.hasOwnProperty.call(input, 'savedAt')) fields.push('savedAt');
    const value = strictRecord(input, fields);
    if (value.schemaVersion !== 1 && value.schemaVersion !== 2) invalid();
    const content: RoutineContent = {
      schemaVersion: value.schemaVersion, name: text(value.name), tracks: array(value.tracks, 100).map(parseTrack),
      filler: parseFiller(value.filler), crossfade: number(value.crossfade),
      beepEvery: number(value.beepEvery), beepRemaining: number(value.beepRemaining),
    };
    if (fields.includes('beepOnceRemaining')) content.beepOnceRemaining = number(value.beepOnceRemaining);
    if (fields.includes('sequence')) content.sequence = parseSequence(value.sequence);
    if (fields.includes('savedAt')) content.savedAt = number(value.savedAt);
    if (validateRoutine({ ...content, id: 'validation', revision: 1, locked: false, published: false }).length) invalid();
    return content;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    return invalid();
  }
}