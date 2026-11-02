/** Loudness shape of a song's start and end, used to pick automatic ("sweet") crossfades. */
export interface FadeProfile {
  v: 1;
  /** Seconds between samples. */
  step: number;
  /** Levels in dB relative to the song's typical loudness, from the first sample onward. */
  start: number[];
  /** Levels in dB relative to the song's typical loudness, from the last sample backward. */
  end: number[];
}

export interface SweetTransition {
  /** Seconds into the outgoing song where it stops. */
  cut: number;
  /** Seconds the outgoing song fades out before `cut`. */
  fade: number;
  /** Near-silent seconds at the start of the incoming song, overlapped too. */
  lead: number;
}

const STEP = 0.1;
const WINDOW = 0.4;
const HEAD_SECONDS = 20;
const TAIL_SECONDS = 45;
const SILENT = -45;
const QUIET = -18;
const FULL = -4;
const INTRO_FULL = -6;
const MINIMUM_FADE = 0.5;
const MAXIMUM_TRIM = 30;
const MAXIMUM_LEAD = 8;

function windowLevel(channels: Float32Array[], centre: number, half: number): number {
  const length = channels[0]!.length;
  const from = Math.max(0, centre - half);
  const to = Math.min(length, centre + half);
  if (to <= from) return -120;
  let sum = 0;
  for (const samples of channels) for (let index = from; index < to; index++) sum += samples[index]! * samples[index]!;
  const power = sum / ((to - from) * channels.length);
  return power > 1e-12 ? 10 * Math.log10(power) : -120;
}

export function analyzeFadeProfile(channels: Float32Array[], sampleRate: number): FadeProfile {
  const length = channels[0]?.length ?? 0;
  if (!channels.length || !length || !(sampleRate > 0)) throw new Error('invalid_audio');
  const half = Math.round(WINDOW * sampleRate / 2);
  // Typical loudness: 75th percentile of audible windows, so quiet verses and silence don't lower it.
  const body: number[] = [];
  for (let centre = half; centre < length; centre += half * 2) {
    const level = windowLevel(channels, centre, half);
    if (level > -70) body.push(level);
  }
  body.sort((first, second) => first - second);
  const reference = body.length ? body[Math.min(body.length - 1, Math.floor(body.length * 0.75))]! : -120;
  const duration = length / sampleRate;
  const relative = (seconds: number) => {
    const level = windowLevel(channels, Math.round(seconds * sampleRate), half) - reference;
    return Math.round(Math.max(-90, Math.min(12, level)) * 10) / 10;
  };
  const start: number[] = [];
  for (let seconds = 0; seconds <= Math.min(HEAD_SECONDS, duration / 2) + 1e-9; seconds += STEP) start.push(relative(seconds));
  const end: number[] = [];
  for (let seconds = 0; seconds <= Math.min(TAIL_SECONDS, duration / 2) + 1e-9; seconds += STEP) end.push(relative(duration - seconds));
  return { v: 1, step: STEP, start, end };
}

export function validFadeProfile(value: unknown): value is FadeProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as FadeProfile;
  const levels = (list: unknown) => Array.isArray(list) && list.length > 0 && list.length <= 1000
    && list.every(level => typeof level === 'number' && Number.isFinite(level) && level >= -90 && level <= 12);
  return profile.v === 1 && profile.step > 0 && profile.step <= 1 && levels(profile.start) && levels(profile.end);
}

/** Parses a Plex loudness ramp ("dB seconds;dB seconds;..."), where seconds count from the song edge. */
function parsePlexRamp(value: unknown): [number, number][] | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) return null;
  const points = value.split(';').map(part => part.trim()).filter(Boolean).map(part => part.split(/\s+/).map(Number));
  if (!points.length || points.length > 400) return null;
  let previous = -Infinity;
  for (const point of points) {
    if (point.length !== 2 || !point.every(Number.isFinite)) return null;
    const [level, seconds] = point as [number, number];
    if (level < -120 || level > 30 || seconds < 0 || seconds > TAIL_SECONDS || seconds < previous) return null;
    previous = seconds;
  }
  return points as [number, number][];
}

function sampleRamp(points: [number, number][]): number[] {
  const last = points.at(-1)!;
  const levels: number[] = [];
  for (let index = 0; index * STEP <= last[1] + 1 + 1e-9; index++) {
    const seconds = index * STEP;
    const after = points.findIndex(([, time]) => time >= seconds);
    let level: number;
    if (after < 0) level = last[0];
    else if (after === 0) level = points[0]![0];
    else {
      const [fromLevel, fromTime] = points[after - 1]!;
      const [toLevel, toTime] = points[after]!;
      level = toTime === fromTime ? toLevel : fromLevel + (toLevel - fromLevel) * (seconds - fromTime) / (toTime - fromTime);
    }
    levels.push(Math.round(Math.max(-90, Math.min(12, level)) * 10) / 10);
  }
  return levels;
}

/** Converts Plex's start/end loudness ramps (dB relative to the song's loudness) when both are well formed. */
export function plexFadeProfile(startRamp: unknown, endRamp: unknown): FadeProfile | undefined {
  const start = parsePlexRamp(startRamp);
  const end = parsePlexRamp(endRamp);
  if (!start || !end) return undefined;
  const profile: FadeProfile = { v: 1, step: STEP, start: sampleRamp(start), end: sampleRamp(end) };
  return validFadeProfile(profile) ? profile : undefined;
}

/**
 * Picks where the outgoing song stops and how long it fades, from both songs' loudness:
 * quiet or silent endings are cut, natural fade-outs overlap the next song, abrupt endings get a short blend,
 * and the next song's leading silence plays underneath. Never cuts before the last cue or more than 30 s.
 */
export function sweetTransition(outgoing: { duration: number; profile: FadeProfile; lastCue?: number },
  incoming: { duration: number; profile: FadeProfile }, maximumFade: number): SweetTransition {
  const { duration } = outgoing;
  const tail = outgoing.profile.end;
  const step = outgoing.profile.step;
  const fromEnd = (threshold: number) => {
    const index = tail.findIndex(level => level >= threshold);
    return index < 0 ? tail.length * step : index * step;
  };
  const earliest = Math.max(duration / 2, duration - MAXIMUM_TRIM, outgoing.lastCue === undefined ? 0 : outgoing.lastCue + 0.5);
  const cut = Math.min(duration, Math.max(earliest, duration - fromEnd(QUIET)));
  const fullUntil = duration - fromEnd(FULL);
  const naturalFade = Math.max(0, cut - fullUntil);

  const head = incoming.profile.start;
  const headStep = incoming.profile.step;
  const fromStart = (threshold: number) => {
    const index = head.findIndex(level => level >= threshold);
    return index < 0 ? head.length * headStep : index * headStep;
  };
  const lead = Math.min(MAXIMUM_LEAD, fromStart(SILENT), incoming.duration / 4);
  const intro = Math.max(0, fromStart(INTRO_FULL) - lead);

  const limit = Math.max(0, Math.min(maximumFade, cut / 2, (incoming.duration - lead) / 2));
  const fade = Math.min(limit, Math.max(MINIMUM_FADE, naturalFade, Math.min(intro, maximumFade / 2)));
  return { cut, fade, lead };
}
