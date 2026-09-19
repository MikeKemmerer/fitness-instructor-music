import { cueSeconds, DEFAULT_BEEP_VOLUME, transitionAfter, validateRoutine, type Cue, type Filler, type Routine, type Track } from '../../shared/routine';
import type { Player, PlayerState } from '../../shared/player-contract';
import { routineClassAudio, type ClassAudio, type ClassPhase } from '../../shared/class-plan';
import { getReadiness, getReadinessClass, getTrackBlob, MAX_DECODED_BYTES, MAX_TRACK_SECONDS } from './offline';
import { getFillerBuffer, LOFI_ASSET, releaseFillerCache } from './filler-audio';
import { assertRuntimeDecoderAvailable, decodeRuntimeAudio, estimateRuntimePcm, MAX_RUNTIME_PCM_BYTES, registerRuntimePcm, runtimePcmBytes } from './native-audio';
import { classFillers, classPhases, fillerKey, snapshotClassAudio } from './session-runtime';

export function transitionOverlap(requested: number, outgoing: number, incoming: number): number {
  return Math.max(0, Math.min(requested, outgoing / 2, incoming / 2));
}

export function projectCues(track: Track, elapsed: number) {
  const cues = track.cues.map(cue => ({ note: cue.note, seconds: cueSeconds(cue, track) }))
    .sort((first, second) => first.seconds - second.seconds);
  const current = cues.filter(cue => cue.seconds <= elapsed).at(-1);
  const next = cues.find(cue => cue.seconds > elapsed);
  return {
    currentCue: current?.note ?? '',
    nextCue: next?.note ?? '',
    nextCueIn: next ? next.seconds - elapsed : null,
  };
}

export function beepOffsets(duration: number, every: number, countdown: number, onceRemaining = 0, cueOffsets: readonly number[] = []): number[] {
  const offsets = new Set<number>();
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const add = (seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    const offset = Math.round(seconds * 1e6) / 1e6;
    if (offset >= 0 && offset < duration) offsets.add(offset);
  };
  if (Number.isFinite(every) && every >= 0.25) {
    for (let seconds = every; seconds < duration; seconds += every) add(seconds);
  }
  if (Number.isFinite(countdown) && countdown > 0) {
    for (let seconds = Math.min(Math.floor(countdown), Math.ceil(duration) - 1); seconds >= 1; seconds--) {
      add(duration - seconds);
    }
  }
  if (Number.isFinite(onceRemaining) && onceRemaining > 0 && onceRemaining <= duration) {
    add(duration - onceRemaining);
  }
  cueOffsets.forEach(add);
  return [...offsets].sort((first, second) => first - second);
}

interface GainPoint {
  seconds: number;
  level: number;
}

interface Segment {
  kind: 'song' | 'filler';
  trackIndex: number;
  start: number;
  duration: number;
  filler?: Filler;
  crossfade?: number;
  phase?: ClassPhase;
  phaseTrackIndex?: number;
  gainPoints?: GainPoint[];
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  level: GainNode;
}

const initialState = (): PlayerState => ({
  status: 'idle', trackIndex: 0, elapsed: 0, duration: 0, classElapsed: 0,
  currentCue: '', nextCue: '', nextCueIn: null, fillerRemaining: null,
  nextCueTrackTitle: null,
  holding: false, ducked: false, beepsMuted: false, error: null,
});

export function createPlayer(): Player & { advance(): Promise<void>; previous(): Promise<void>; unload(): void } {
  let routine: Routine | null = null;
  let classAudio: ClassAudio | undefined;
  let sourceTracks: Track[] = [];
  let routineStart: number | null = null;
  let routineEnd: number | null = null;
  let state = initialState();
  let segments: Segment[] = [];
  let context: AudioContext | null = null;
  let musicBus: GainNode | null = null;
  let beepBus: GainNode | null = null;
  let outputBus: GainNode | null = null;
  const fillerBuffers = new Map<string, AudioBuffer>();
  let ready = false;
  let disposed = false;
  let running = false;
  let seeking = false;
  let generation = 0;
  let checkpoint = 0;
  let alarmFloor = 0;
  let anchor = 0;
  let volume = 0.8;
  let frame: number | null = null;
  let scheduler: ReturnType<typeof setInterval> | null = null;
  let decodeQueue = Promise.resolve();
  let pendingWindow: Promise<void> | null = null;
  let pendingNext: Promise<void> | null = null;
  const failedPreparation = new Set<number>();
  const listeners = new Set<(state: PlayerState) => void>();
  const buffers = new Map<number, AudioBuffer>();
  const voices = new Map<Segment, Voice>();
  const unregisterPcm = registerRuntimePcm(() => [...buffers.values(), ...fillerBuffers.values(),
    ...[...voices.values()].flatMap(voice => voice.source.buffer ? [voice.source.buffer] : [])]);
  const alarms = new Map<OscillatorNode, { gain: GainNode; when: number }>();
  const scheduledAlarms = new Map<string, number>();
  const firedAlarms = new Set<string>();

  const end = (segment: Segment) => segment.start + segment.duration;
  const position = () => running && context && !seeking ? checkpoint + Math.max(0, context.currentTime - anchor) : checkpoint;
  const ownerAt = (seconds: number) => segments.findLast(segment => segment.start <= seconds) ?? segments[0];
  const phaseOf = (segment?: Segment): ClassPhase => segment?.phase ?? 'routine';
  const nextPhase = (phase: ClassPhase): ClassPhase => {
    if (!classAudio) return 'finished';
    const phases = classPhases(classAudio);
    return phases[phases.indexOf(phase as Exclude<ClassPhase, 'finished'>) + 1] ?? 'finished';
  };
  const emit = () => {
    for (const listener of listeners) listener({ ...state });
  };

  function addTrackPlan(firstIndex: number, start: number): Segment[] {
    if (!routine) return [];
    const result: Segment[] = [];
    const append = (kind: Segment['kind'], trackIndex: number, duration: number, filler?: Filler) => {
      const previous = result.at(-1);
      const crossfade = transitionAfter(routine!, previous?.trackIndex ?? trackIndex).crossfade;
      const requested = kind === 'filler' || previous?.kind === 'filler' ? Math.max(0.01, crossfade) : crossfade;
      const overlap = previous ? transitionOverlap(requested, previous.duration, duration) : 0;
      result.push({ kind, trackIndex, duration, filler, crossfade, start: previous ? end(previous) - overlap : start });
    };
    for (let index = firstIndex; index < routine.tracks.length; index++) {
      append('song', index, routine.tracks[index].duration);
      if (index === routine.tracks.length - 1) break;
      const { filler } = transitionAfter(routine, index);
      if (filler.mode !== 'none' && (filler.seconds > 0 || filler.mode === 'hold')) {
        append('filler', index, filler.mode === 'hold' ? Infinity : filler.seconds, filler);
        if (filler.mode === 'hold') break;
      }
    }
    return result;
  }

  function appendPhase(result: Segment[], phase: ClassPhase, start: number): void {
    if (!routine || phase === 'finished') return;
    const previous = result.at(-1);
    const incoming = phasePlan(phase, start);
    if (!incoming.length) return;
    const requested = Math.max(previous?.kind === 'filler' || incoming[0].kind === 'filler' ? 0.01 : 0,
      classAudio?.crossfade ?? 0);
    const overlap = previous ? transitionOverlap(requested, previous.duration, incoming[0].duration) : 0;
    for (const segment of incoming) segment.start -= overlap;
    result.push(...incoming);
  }

  function phasePlan(phase: ClassPhase, start: number, firstIndex = 0): Segment[] {
    if (!routine || phase === 'finished') return [];
    if (phase === 'routine') {
      const result = addTrackPlan(firstIndex, start);
      const last = result.at(-1);
      if (last?.kind === 'song' && last.trackIndex === routine.tracks.length - 1 && classAudio) {
        appendPhase(result, nextPhase('routine'), end(last));
      }
      return result;
    }
    if (phase === 'before' || phase === 'after') {
      return [{ kind: 'filler', trackIndex: phase === 'before' ? 0 : routine.tracks.length - 1,
        phase, filler: classAudio![phase]!, crossfade: classAudio!.crossfade, start, duration: Infinity }];
    }
    const playlist = phase === 'walk-in' ? classAudio!.walkIn! : classAudio!.walkOut!;
    const base = routine.tracks.length + (phase === 'walk-out' ? classAudio?.walkIn?.tracks.length ?? 0 : 0);
    const count = phase === 'walk-in' ? 2 : playlist.tracks.length - firstIndex;
    const result: Segment[] = [];
    for (let offset = 0; offset < count; offset++) {
      const index = (firstIndex + offset) % playlist.tracks.length;
      const duration = playlist.tracks[index].duration;
      const previous = result.at(-1);
      result.push({ kind: 'song', phase, phaseTrackIndex: index, trackIndex: base + index, duration,
        start: previous ? end(previous) - transitionOverlap(classAudio!.crossfade, previous.duration, duration) : start });
    }
    return result;
  }

  function initialPlan(): Segment[] {
    routineStart = null;
    routineEnd = null;
    return phasePlan(classAudio ? classPhases(classAudio)[0] : 'routine', 0);
  }

  function extendWalkIn(seconds: number): void {
    if (!classAudio?.walkIn || phaseOf(ownerAt(seconds)) !== 'walk-in') return;
    const last = segments.at(-1);
    if (!last || phaseOf(last) !== 'walk-in' || last.start > seconds) return;
    const index = ((last.phaseTrackIndex ?? 0) + 1) % classAudio.walkIn.tracks.length;
    const following = phasePlan('walk-in', end(last), index)[0];
    following.start -= transitionOverlap(classAudio.crossfade, last.duration, following.duration);
    segments.push(following);
    const voice = voices.get(last);
    if (voice) scheduleEnvelope(last, voice.gain, seconds);
    segments = segments.filter(segment => end(segment) > seconds);
  }

  function project(): void {
    const seconds = position();
    const current = ownerAt(seconds);
    if (!current || !routine) return;
    const phase = phaseOf(current);
    if (classAudio) {
      if (phase === 'routine' && routineStart === null) routineStart = current.start;
      if (routineStart !== null && phase !== 'routine' && phase !== 'before' && phase !== 'walk-in' && routineEnd === null) routineEnd = current.start;
      const finished = state.status === 'finished';
      state = { ...state, phase: finished ? 'finished' : phase, phaseTrackIndex: current.phaseTrackIndex ?? current.trackIndex,
        phaseTrackTitle: current.kind === 'song' ? sourceTracks[current.trackIndex].title : '',
        nextPhase: finished ? null : nextPhase(phase),
        canAdvance: running && !finished && phase !== 'routine' && phase !== 'walk-out',
      };
      if (phase !== 'routine') {
        state = { ...state, trackIndex: phase === 'walk-in' || phase === 'before' ? 0 : routine.tracks.length - 1,
          elapsed: Math.min(current.duration, Math.max(0, seconds - current.start)),
          duration: Number.isFinite(current.duration) ? current.duration : 0,
          classElapsed: routineStart === null ? 0 : Math.max(0, (routineEnd ?? seconds) - routineStart),
          currentCue: '', nextCue: '', nextCueIn: null, nextCueTrackTitle: null, fillerRemaining: null,
          holding: current.kind === 'filler', status: running ? current.kind === 'song' ? 'playing' : 'filler' : state.status };
        return;
      }
    }
    const elapsed = Math.min(current.duration, Math.max(0, seconds - current.start));
    const track = routine.tracks[current.trackIndex];
    const followingSong = segments.find(segment => segment.kind === 'song' && segment.trackIndex === current.trackIndex + 1);
    const cues = current.kind === 'song' ? projectCues(track, elapsed) : {
      currentCue: '', nextCue: '', nextCueIn: null as number | null,
    };
    let nextCueTrackTitle: string | null = null;
    if (!cues.nextCue) {
      for (let index = current.trackIndex + 1; index < routine.tracks.length; index++) {
        const followingTrack = routine.tracks[index];
        const preview = projectCues(followingTrack, 0);
        const note = preview.currentCue || preview.nextCue;
        if (!note) continue;
        const song = segments.find(segment => segment.kind === 'song' && segment.trackIndex === index);
        const offset = preview.currentCue ? 0 : preview.nextCueIn;
        cues.nextCue = note;
        cues.nextCueIn = song && offset !== null ? Math.max(0, song.start + offset - seconds) : null;
        nextCueTrackTitle = followingTrack.title;
        break;
      }
    }
    state = {
      ...state, ...cues, nextCueTrackTitle, trackIndex: current.trackIndex, elapsed,
      duration: Number.isFinite(current.duration) ? current.duration : 0,
      classElapsed: classAudio ? Math.max(0, seconds - (routineStart ?? seconds)) : seconds,
      fillerRemaining: current.kind === 'filler' && Number.isFinite(current.duration) ? Math.max(0, (followingSong?.start ?? end(current)) - seconds) : null,
      holding: segments.some(segment => segment.duration === Infinity && segment.trackIndex === current.trackIndex),
      status: running ? (current.kind === 'song' ? 'playing' : 'filler') : state.status,
    };
  }

  function releaseVoice(segment: Segment, voice: Voice): void {
    voice.source.onended = null;
    try { voice.source.stop(); } catch {}
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.level.disconnect();
    voice.source.buffer = null;
    voices.delete(segment);
  }

  function rememberFiredAlarms(): void {
    if (!context) return;
    for (const [key, when] of scheduledAlarms) {
      if (when <= context.currentTime) {
        firedAlarms.add(key);
        scheduledAlarms.delete(key);
      }
    }
  }

  function cancelAlarms(futureOnly = false): void {
    rememberFiredAlarms();
    for (const [oscillator, { gain, when }] of alarms) {
      if (futureOnly && context && when <= context.currentTime) continue;
      oscillator.onended = null;
      try { oscillator.stop(); } catch {}
      oscillator.disconnect();
      gain.disconnect();
      alarms.delete(oscillator);
    }
    scheduledAlarms.clear();
  }

  function cancelScheduled(retained = new Set<Segment>()): void {
    cancelAlarms();
    generation++;
    seeking = false;
    if (frame !== null) cancelAnimationFrame(frame);
    if (scheduler !== null) clearInterval(scheduler);
    frame = null;
    scheduler = null;
    pendingWindow = null;
    pendingNext = null;
    failedPreparation.clear();
    for (const [segment, voice] of voices) {
      if (!retained.has(segment)) releaseVoice(segment, voice);
    }
  }

  function pauseWithError(error: string | null = null, at?: number): void {
    if (disposed) return;
    project();
    checkpoint = at ?? position();
    running = false;
    cancelScheduled();
    state = { ...state, status: ready ? 'paused' : state.status, error };
    project();
    if (context?.state === 'running') void context.suspend().catch(() => undefined);
    emit();
  }

  function updateBuses(): void {
    if (!context || !musicBus || !beepBus) return;
    musicBus.gain.setTargetAtTime(volume * (state.ducked ? 0.25 : 1), context.currentTime, 0.015);
    beepBus.gain.setTargetAtTime(state.beepsMuted ? 0 : routine?.beepVolume ?? DEFAULT_BEEP_VOLUME, context.currentTime, 0.015);
  }

  function audioContext(): AudioContext {
    if (context) return context;
    const Constructor = globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) throw new Error('audio_unavailable');
    context = new Constructor({ sampleRate: 44100 });
    musicBus = context.createGain();
    beepBus = context.createGain();
    outputBus = context.createGain();
    outputBus.gain.value = 0.65;
    musicBus.connect(outputBus);
    beepBus.connect(outputBus);
    outputBus.connect(context.destination);
    context.onstatechange = () => {
      if (running && context?.state !== 'running') pauseWithError('audio_interrupted');
    };
    updateBuses();
    return context;
  }

  function windowIndices(seconds: number): number[] {
    const future = segments.filter(segment => segment.kind === 'song' && end(segment) > seconds);
    const indices = future.filter(segment => segment.start <= seconds).map(segment => segment.trackIndex);
    for (const segment of future) {
      if (indices.length >= 2) break;
      if (!indices.includes(segment.trackIndex)) indices.push(segment.trackIndex);
    }
    const current = ownerAt(seconds);
    if (current && phaseOf(current) === 'routine' && routine && current.trackIndex + 1 < routine.tracks.length &&
      !indices.includes(current.trackIndex + 1) && indices.length < 2) indices.push(current.trackIndex + 1);
    if (current && current.kind === 'filler' && classAudio && phaseOf(current) !== 'routine' && indices.length < 2) {
      const upcoming = phasePlan(nextPhase(phaseOf(current)), seconds).find(segment => segment.kind === 'song');
      if (upcoming && !indices.includes(upcoming.trackIndex)) indices.push(upcoming.trackIndex);
    }
    return indices;
  }

  function holdFiller(current: Segment): Filler {
    const after = current.trackIndex < routine!.tracks.length - 1 ? routine!.tracks[current.trackIndex].after : undefined;
    return current.filler ?? (after?.mode === 'custom' ? after.filler : routine!.filler);
  }

  function trimFillers(seconds: number, plan = segments): void {
    const keys = new Set(windowFillers(seconds, plan).map(fillerKey));
    for (const key of fillerBuffers.keys()) if (!keys.has(key)) fillerBuffers.delete(key);
    releaseFillerCache(new Set(fillerBuffers.values()));
  }

  function makeRoom(bytes: number, seconds: number): void {
    const current = ownerAt(seconds);
    const required = current && (current.kind === 'filler' || phaseOf(current) === 'routine') ? fillerKey(holdFiller(current)) : null;
    for (const key of fillerBuffers.keys()) {
      if (runtimePcmBytes() + bytes <= MAX_RUNTIME_PCM_BYTES) break;
      if (key !== required) fillerBuffers.delete(key);
      releaseFillerCache(new Set(fillerBuffers.values()));
    }
    if (runtimePcmBytes() + bytes > MAX_RUNTIME_PCM_BYTES) throw new Error('audio_memory_limit');
  }

  function prepareWindow(indices: number[], token: number, optional = false): Promise<void> {
    const snapshot = sourceTracks;
    const operation = decodeQueue.then(async () => {
      if (token !== generation || !snapshot) return;
      const seconds = position();
      trimFillers(seconds);
      const audible = new Set([...voices.keys()].filter(segment => segment.kind === 'song' && segment.start <= seconds && end(segment) > seconds)
        .map(segment => segment.trackIndex));
      for (const index of buffers.keys()) {
        if (!indices.includes(index) && !audible.has(index)) buffers.delete(index);
      }
      for (const index of indices) {
        if (token !== generation) return;
        if (buffers.has(index)) continue;
        const track = snapshot[index];
        const blob = await getTrackBlob(track.id);
        if (token !== generation) return;
        if (!blob) throw new Error('missing_audio');
        try {
          const bytes = estimateRuntimePcm(track.duration);
          if (bytes > MAX_DECODED_BYTES) throw new Error('audio_memory_limit');
          makeRoom(bytes, position());
          await decodeRuntimeAudio(() => blob.arrayBuffer(), bytes, 44100, decoded => {
            if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > MAX_TRACK_SECONDS ||
              Math.abs(decoded.duration - track.duration) > 0.1) throw new Error('audio_duration_mismatch');
            if (!Number.isSafeInteger(decoded.length) || decoded.length <= 0 || !Number.isInteger(decoded.numberOfChannels) ||
              decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2 || decoded.length * decoded.numberOfChannels * 4 > MAX_DECODED_BYTES) {
              throw new Error('audio_memory_limit');
            }
          }, decoded => { if (token === generation) buffers.set(index, decoded); });
        } catch (error) {
          if (optional && error instanceof Error && error.message === 'audio_memory_limit' &&
            !audible.has(index) && !(ownerAt(position())?.kind === 'song' && ownerAt(position())?.trackIndex === index)) continue;
          throw error;
        }
      }
    });
    decodeQueue = operation.catch(() => undefined);
    return operation;
  }

  function windowFillers(seconds: number, plan = segments): Filler[] {
    const selected = new Map<string, Filler>();
    const add = (filler: Filler) => {
      if (selected.size < 2) selected.set(fillerKey(filler), filler);
    };
    const current = plan.findLast(segment => segment.start <= seconds) ?? plan[0];
    if (current && (current.kind === 'filler' || phaseOf(current) === 'routine')) {
      const filler = holdFiller(current);
      if (filler.sound !== 'recording' || filler.mode !== 'none') add(filler);
    }
    for (const segment of plan) {
      if (segment.kind === 'filler' && end(segment) > seconds) add(segment.filler ?? routine!.filler);
    }
    return [...selected.values()];
  }

  async function prepareFillers(seconds: number, token: number, plan = segments): Promise<void> {
    const selected = windowFillers(seconds, plan);
    trimFillers(seconds, plan);
    const current = plan.findLast(segment => segment.start <= seconds) ?? plan[0];
    const required = current && (current.kind === 'filler' || phaseOf(current) === 'routine') ? fillerKey(holdFiller(current)) : null;
    for (const filler of selected) {
      if (token !== generation) return;
      const key = fillerKey(filler);
      if (fillerBuffers.has(key)) continue;
      const existing = [...voices].find(([segment]) => segment.kind === 'filler' && fillerKey(segment.filler ?? routine!.filler) === key)?.[1].source.buffer;
      if (existing) { fillerBuffers.set(key, existing); continue; }
      try {
        const bytes = filler.sound === 'recording' ? estimateRuntimePcm(filler.recording!.duration) :
          filler.sound === 'lofi' ? LOFI_ASSET.frames * LOFI_ASSET.channels * 4 : Math.round(22050 * 240 / filler.bpm) * 8;
        if (runtimePcmBytes() + bytes > MAX_RUNTIME_PCM_BYTES) throw new Error('audio_memory_limit');
        const buffer = await getFillerBuffer(audioContext(), filler);
        if (token !== generation) { releaseFillerCache(new Set(fillerBuffers.values())); return; }
        fillerBuffers.set(key, buffer);
      } catch (error) {
        if (error instanceof Error && error.message === 'audio_memory_limit' && key !== required) continue;
        throw error;
      }
    }
  }

  function gainPoints(segment: Segment): GainPoint[] {
    if (segment.gainPoints) return segment.gainPoints;
    const index = segments.indexOf(segment);
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const minimumFade = Math.min(0.01, segment.duration / 2);
    const fadeInEnd = Math.max(segment.start + minimumFade, previous ? end(previous) : segment.start);
    const points = [{ seconds: segment.start, level: 0 }, { seconds: fadeInEnd, level: 1 }];
    if (Number.isFinite(segment.duration)) {
      points.push({ seconds: Math.max(fadeInEnd, Math.min(end(segment) - minimumFade, next?.start ?? end(segment))), level: 1 });
      points.push({ seconds: end(segment), level: 0 });
    }
    return points;
  }

  function envelope(segment: Segment, seconds: number): number {
    const points = gainPoints(segment);
    let previous = points[0];
    for (const point of points.slice(1)) {
      if (point.seconds > seconds) {
        const fraction = Math.max(0, (seconds - previous.seconds) / (point.seconds - previous.seconds));
        return previous.level + (point.level - previous.level) * fraction;
      }
      previous = point;
    }
    return previous.level;
  }

  function scheduleEnvelope(segment: Segment, gain: GainNode, seconds: number): void {
    const start = Math.max(segment.start, seconds);
    const when = anchor + start - checkpoint;
    gain.gain.cancelScheduledValues(when);
    let level = envelope(segment, start);
    gain.gain.setValueAtTime(level, when);
    for (const point of gainPoints(segment)) {
      if (point.seconds <= start) continue;
      const at = anchor + point.seconds - checkpoint;
      if (point.level === level) gain.gain.setValueAtTime(point.level, at);
      else gain.gain.linearRampToValueAtTime(point.level, at);
      level = point.level;
    }
  }

  function scheduleVoice(segment: Segment, seconds: number): void {
    if (!context || !routine || !musicBus || voices.has(segment) || end(segment) <= seconds) return;
    let buffer = buffers.get(segment.trackIndex);
    if (segment.kind === 'filler') {
      buffer = fillerBuffers.get(fillerKey(segment.filler ?? routine.filler));
    }
    if (!buffer) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const level = context.createGain();
    level.gain.setValueAtTime(
      (segment.kind === 'filler' ? (segment.filler ?? routine.filler).gain : sourceTracks[segment.trackIndex].gain) ?? 1,
      context.currentTime,
    );
    source.buffer = buffer;
    source.loop = segment.kind === 'filler';
    source.connect(gain);
    gain.connect(level);
    level.connect(musicBus);
    const start = Math.max(segment.start, seconds);
    const when = anchor + start - checkpoint;
    scheduleEnvelope(segment, gain, seconds);
    const voice = { source, gain, level };
    voices.set(segment, voice);
    source.onended = () => {
      if (voices.get(segment) === voice) releaseVoice(segment, voice);
    };
    const offset = seconds > segment.start ? seconds - segment.start : 0;
    source.start(when, source.loop ? offset % buffer.duration : offset);
    if (segment.kind === 'song' || (segment.gainPoints && Number.isFinite(segment.duration))) {
      source.stop(anchor + end(segment) - checkpoint);
    }
  }

  function segmentBeepOffsets(segment: Segment): number[] {
    if (!routine || phaseOf(segment) !== 'routine') return [];
    const track = routine.tracks[segment.trackIndex];
    const cueOffsets = track.cues.filter(cue => cue.beep === true).map(cue => cueSeconds(cue, track));
    return beepOffsets(segment.duration, routine.beepEvery, routine.beepRemaining, routine.beepOnceRemaining, cueOffsets);
  }

  function scheduleBeeps(seconds: number): void {
    if (!context || !beepBus || !routine) return;
    rememberFiredAlarms();
    for (const segment of segments) {
      if (segment.kind !== 'song' || segment.start > seconds + 0.2 || end(segment) <= seconds) continue;
      const next = segments[segments.indexOf(segment) + 1];
      const ownershipEnd = next?.start ?? end(segment);
      for (const offset of segmentBeepOffsets(segment)) {
        const at = segment.start + offset;
        const key = `${segment.trackIndex}:${segment.start}:${offset}`;
        const now = Math.max(seconds, checkpoint + context.currentTime - anchor);
        const lookback = offset === 0 || at === alarmFloor ? 0.01 : 0;
        if (at < alarmFloor || at < now - lookback || at > now + 0.2 || at >= ownershipEnd ||
          now >= ownershipEnd || now >= end(segment) || scheduledAlarms.has(key) || firedAlarms.has(key)) continue;
        const when = Math.max(context.currentTime, anchor + at - checkpoint);
        if (when >= anchor + ownershipEnd - checkpoint || when >= anchor + end(segment) - checkpoint ||
          when - (anchor + at - checkpoint) > lookback) continue;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        scheduledAlarms.set(key, when);
        oscillator.frequency.value = 880;
        oscillator.connect(gain);
        gain.connect(beepBus);
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(0.3, when + 0.005);
        gain.gain.linearRampToValueAtTime(0, when + 0.08);
        oscillator.start(when);
        oscillator.stop(when + 0.085);
        alarms.set(oscillator, { gain, when });
        oscillator.onended = () => {
          alarms.delete(oscillator);
          oscillator.disconnect();
          gain.disconnect();
        };
      }
    }
  }

  function tick(prepare = true): void {
    if (!running || seeking || !routine || !context) return;
    if (context.state !== 'running') {
      pauseWithError('audio_interrupted');
      return;
    }
    const seconds = position();
    extendWalkIn(seconds);
    const last = segments.at(-1);
    if (last && seconds >= end(last)) {
      checkpoint = end(last);
      running = false;
      cancelScheduled();
      buffers.clear();
      fillerBuffers.clear();
      releaseFillerCache();
      state = { ...state, status: 'finished' };
      project();
      emit();
      return;
    }
    for (const [segment, voice] of voices) {
      if (end(segment) <= seconds) releaseVoice(segment, voice);
    }
    const indices = windowIndices(seconds);
    for (const index of buffers.keys()) {
      if (!indices.includes(index)) buffers.delete(index);
    }
    const current = ownerAt(seconds);
    if (current && !voices.get(current)?.source.buffer && (current.kind === 'song' ? !buffers.has(current.trackIndex) :
      !fillerBuffers.has(fillerKey(current.filler ?? routine.filler)))) {
      pauseWithError('audio_not_prepared', current.start);
      return;
    }
    scheduleBeeps(seconds);
    for (const segment of segments) {
      if (end(segment) <= seconds) continue;
      if (segment.kind === 'song' && indices.includes(segment.trackIndex)) scheduleVoice(segment, seconds);
      if (segment.kind === 'filler' && (segment.start <= seconds + 1 || indices.includes(segment.trackIndex))) {
        scheduleVoice(segment, seconds);
      }
    }
    const needed = indices.filter(index => !failedPreparation.has(index));
    const missingFiller = windowFillers(seconds).some(filler => !fillerBuffers.has(fillerKey(filler)));
    if (prepare && !pendingNext && !pendingWindow && (needed.some(index => !buffers.has(index)) || missingFiller)) {
      const token = generation;
      const fillerKeys = windowFillers(seconds).map(fillerKey);
      const preparation = prepareFillers(seconds, token).then(() => prepareWindow(needed, token, true));
      pendingWindow = preparation;
      void preparation.then(() => {
        if (token === generation) {
          pendingWindow = null;
          tick(windowFillers(position()).some(filler => !fillerKeys.includes(fillerKey(filler))) ||
            windowIndices(position()).some(index => !needed.includes(index)));
        }
      }).catch(error => {
        if (token === generation) {
          pendingWindow = null;
          if (error instanceof Error && ['audio_memory_limit', 'audio_decoder_busy', 'audio_decode_timeout'].includes(error.message)) {
            state = { ...state, error: error.message };
            emit();
            return;
          }
          for (const index of needed) {
            if (!buffers.has(index)) failedPreparation.add(index);
          }
        }
      });
    }
    project();
    emit();
  }

  function startTimers(): void {
    tick();
    if (!running) return;
    scheduler = setInterval(tick, 100);
    const render = () => {
      tick();
      if (running) frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
  }

  function replacePlan(plan: Segment[]): void {
    checkpoint = position();
    anchor = context?.currentTime ?? 0;
    cancelScheduled(new Set(plan.filter(segment => segment.start <= checkpoint && end(segment) > checkpoint)));
    segments = plan;
    for (const [segment, voice] of voices) scheduleEnvelope(segment, voice.gain, checkpoint);
    project();
    if (running) startTimers();
    else emit();
  }

  async function moveToNext(advancePhase = false): Promise<void> {
    if (!ready || !routine || disposed) return;
    if (advancePhase && !classAudio) return;
    const seconds = position();
    const current = ownerAt(seconds);
    if (!current) return;
    const phase = phaseOf(current);
    if (classAudio && (advancePhase && (!running || phase === 'routine' || phase === 'walk-out') ||
      !advancePhase && (phase === 'before' || phase === 'after'))) return;
    let nextIndex = current.trackIndex + 1;
    let targetPhase = phase;
    if (classAudio && phase === 'walk-in' && !advancePhase) nextIndex = ((current.phaseTrackIndex ?? 0) + 1) % classAudio.walkIn!.tracks.length;
    else if (classAudio && phase === 'walk-out') nextIndex = (current.phaseTrackIndex ?? 0) + 1;
    if (advancePhase || phase === 'routine' && nextIndex >= routine.tracks.length ||
      phase === 'walk-out' && nextIndex >= classAudio!.walkOut!.tracks.length) {
      if (classAudio && !running) return;
      targetPhase = nextPhase(phase);
      nextIndex = 0;
    }
    if (targetPhase === 'finished') {
      project();
      checkpoint = seconds;
      running = false;
      cancelScheduled();
      buffers.clear();
      state = { ...state, status: 'finished', holding: false, fillerRemaining: null };
      project();
      emit();
      return;
    }
    const wasRunning = running;
    const token = generation;
    try {
      const active = [...voices.keys()].filter(segment => segment.start <= seconds && end(segment) > seconds);
      if (wasRunning && (active.length >= 4 || active.filter(segment => envelope(segment, seconds) > 0).length >= 3)) {
        throw new Error('audio_decoder_busy');
      }
      const upcoming = phasePlan(targetPhase, seconds, nextIndex);
      const incomingIndex = upcoming.find(segment => segment.kind === 'song')?.trackIndex;
      const resume = wasRunning ? audioContext().resume() : Promise.resolve();
      const indices = incomingIndex === undefined ? [] : wasRunning && current.kind === 'song' ?
        [current.trackIndex, incomingIndex] : [incomingIndex];
      await Promise.all([resume, prepareWindow(indices, token)]);
      if (token !== generation) return;
      await prepareFillers(seconds, token, upcoming);
      if (token !== generation || disposed) return;
      if (wasRunning && context?.state !== 'running') throw new Error('audio_interrupted');
      const handoff = position();
      if (ownerAt(handoff) !== current) return;
      const voice = wasRunning ? voices.get(current) : undefined;
      const fade = targetPhase !== phase || phase !== 'routine' ? classAudio?.crossfade ?? 0 :
        current.filler ? current.crossfade ?? routine.crossfade : transitionAfter(routine, current.trackIndex).crossfade;
      const overlap = voice ? Math.min(
        Math.max(0.01, transitionOverlap(fade, current.duration, upcoming[0].duration)),
        Math.max(0, end(current) - handoff),
      ) : 0;
      const outgoing = segments.flatMap(segment => {
        const active = voices.get(segment);
        if (!wasRunning || !active || segment.start > handoff || end(segment) <= handoff || overlap <= 0 ||
          segment !== current && envelope(segment, handoff) <= 0) return [];
        return [{ segment, voice: active, level: envelope(segment, handoff), duration: Math.min(overlap, end(segment) - handoff) }];
      });
      checkpoint = handoff;
      anchor = context?.currentTime ?? 0;
      cancelScheduled(new Set(outgoing.map(item => item.segment)));
      for (const segment of upcoming) segment.start += handoff - seconds;
      for (const item of outgoing) {
        item.segment.duration = handoff - item.segment.start + item.duration;
        item.segment.gainPoints = [{ seconds: handoff, level: item.level }, { seconds: handoff + item.duration, level: 0 }];
      }
      segments = [...outgoing.map(item => item.segment), ...upcoming];
      for (const item of outgoing) {
        scheduleEnvelope(item.segment, item.voice.gain, handoff);
        item.voice.source.stop(anchor + item.duration);
      }
      state = { ...state, status: wasRunning ? 'playing' : 'paused', error: null };
      project();
      if (wasRunning) startTimers();
      else emit();
    } catch (error) {
      if (token !== generation || disposed) return;
      if (error instanceof Error && ['audio_memory_limit', 'audio_decoder_busy', 'audio_decode_timeout'].includes(error.message)) {
        state = { ...state, error: error.message };
        emit();
        throw error;
      }
      pauseWithError('audio_not_prepared');
      throw error;
    }
  }

  function requestNext(advancePhase = false): Promise<void> {
    if (pendingNext) return pendingNext;
    const operation = moveToNext(advancePhase);
    pendingNext = operation;
    const clear = () => { if (pendingNext === operation) pendingNext = null; };
    void operation.then(clear, clear);
    return operation;
  }

  function rewindTrack(previous = false): void {
    if (disposed) return;
    const seconds = position();
    const current = ownerAt(seconds);
    const phase = phaseOf(current);
    let index = current?.phaseTrackIndex ?? current?.trackIndex ?? 0;
    if (previous && current?.kind === 'song' && seconds - current.start <= 1) index = Math.max(0, index - 1);
    const earlier = segments.findLast(segment => segment.kind === 'song' && phaseOf(segment) === phase
      && (segment.phaseTrackIndex ?? segment.trackIndex) === index && segment.start <= seconds);
    running = false;
    cancelScheduled();
    checkpoint = earlier?.start ?? current?.start ?? 0;
    alarmFloor = checkpoint;
    firedAlarms.clear();
    segments = current ? phasePlan(phase, checkpoint, index) : initialPlan();
    if (phase === 'routine') routineEnd = null;
    state = { ...initialState(), ducked: state.ducked, beepsMuted: state.beepsMuted };
    if (context?.state === 'running') void context.suspend().catch(() => undefined);
    project();
    emit();
  }

  async function previous(): Promise<void> {
    if (!ready || !routine || disposed || pendingNext) return;
    const current = ownerAt(position());
    if (!current || ['before', 'after'].includes(phaseOf(current))) return;
    const wasRunning = running;
    const wasPaused = state.status === 'paused';
    rewindTrack(true);
    if (wasRunning) await play();
    else if (wasPaused) { state = { ...state, status: 'paused' }; emit(); }
  }

  async function seek(seconds: number): Promise<void> {
    if (disposed) throw new Error('player_disposed');
    if (!ready || !routine) throw new Error('routine_not_ready');
    const previous = position();
    const current = ownerAt(previous);
    if (!current || current.kind === 'filler' || phaseOf(current) !== 'routine') return;
    if (!Number.isFinite(seconds)) throw new Error('invalid_seek');
    const next = segments[segments.indexOf(current) + 1];
    const boundary = Math.min(end(current), next?.start ?? end(current));
    const target = current.start + Math.max(0, Math.min(seconds, boundary - current.start - 0.01));
    cancelScheduled();
    const token = generation;
    checkpoint = target;
    alarmFloor = current.start + Math.round((target - current.start) * 1e6) / 1e6;
    if (target < previous) firedAlarms.clear();
    seeking = true;
    state = { ...state, status: state.status === 'finished' ? 'paused' : state.status, error: null };
    project();
    emit();
    try {
      const required = segments.filter(segment => segment.kind === 'song' && segment.start <= target && end(segment) > target)
        .map(segment => segment.trackIndex);
      if (required.some(index => !buffers.has(index))) await prepareWindow(required, token);
      if (token !== generation || disposed) return;
      seeking = false;
      anchor = context?.currentTime ?? 0;
      if (running) startTimers();
      else { project(); emit(); }
    } catch (error) {
      if (token !== generation || disposed) return;
      pauseWithError(error instanceof Error ? error.message : 'audio_not_prepared', target);
      throw error;
    }
  }

  function updateCues(trackIndex: number, cues: Cue[]): void {
    if (disposed) throw new Error('player_disposed');
    if (!ready || !routine) throw new Error('routine_not_ready');
    if (phaseOf(ownerAt(position())) !== 'routine') return;
    if (routine.locked || routine.published) throw new Error('routine_locked');
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= routine.tracks.length) throw new Error('invalid_track');
    let detached: Cue[];
    try {
      if (!Array.isArray(cues)) throw new Error('invalid_cues');
      detached = structuredClone(cues);
      for (const cue of detached) {
        if (!cue || typeof cue.id !== 'string' || typeof cue.note !== 'string' || !cue.anchor ||
          (cue.anchor.kind === 'count' ? typeof cue.anchor.count !== 'number' : typeof cue.anchor.seconds !== 'number')) {
          throw new Error('invalid_cues');
        }
      }
      const tracks = routine.tracks.map((track, index) => index === trackIndex ? { ...track, cues: detached } : track);
      if (validateRoutine({ ...routine, tracks }).length) throw new Error('invalid_cues');
    } catch { throw new Error('invalid_cues'); }
    cancelAlarms(true);
    routine.tracks[trackIndex].cues = detached;
    const seconds = position();
    for (const segment of segments) {
      if (segment.kind !== 'song' || segment.trackIndex !== trackIndex) continue;
      for (const offset of segmentBeepOffsets(segment)) {
        if (segment.start + offset <= seconds) firedAlarms.add(`${trackIndex}:${segment.start}:${offset}`);
      }
    }
    if (running && !seeking) scheduleBeeps(seconds);
    project();
    emit();
  }

  async function play(): Promise<void> {
    if (disposed) throw new Error('player_disposed');
    if (running) return;
    if (!ready || !routine) throw new Error('routine_not_ready');
    if (globalThis.navigator?.userActivation && !navigator.userActivation.isActive) throw new Error('user_gesture_required');
    if (state.status === 'finished') {
      checkpoint = 0;
      alarmFloor = 0;
      segments = initialPlan();
      firedAlarms.clear();
      state = { ...state, status: 'idle' };
    }
    const token = ++generation;
    try {
      const audio = audioContext();
      const resume = audio.resume();
      await Promise.all([resume, prepareFillers(checkpoint, token)]);
      await prepareWindow(windowIndices(checkpoint), token, true);
      if (token !== generation || disposed) return;
      if (audio.state !== 'running') throw new Error('audio_interrupted');
      anchor = audio.currentTime;
      running = true;
      state = { ...state, error: null };
      startTimers();
    } catch (error) {
      if (token === generation) pauseWithError(error instanceof Error ? error.message : 'audio_unavailable');
      throw error;
    }
  }

  const onPageHide = () => { if (running) pauseWithError('audio_interrupted'); };
  const onVisibility = () => { if (globalThis.document?.visibilityState === 'hidden') onPageHide(); };
  globalThis.addEventListener?.('pagehide', onPageHide);
  globalThis.document?.addEventListener('visibilitychange', onVisibility);

  function unload(): void {
    if (disposed) return;
    running = false;
    ready = false;
    cancelScheduled();
    firedAlarms.clear();
    buffers.clear();
    fillerBuffers.clear();
    releaseFillerCache();
    routine = null;
    classAudio = undefined;
    sourceTracks = [];
    segments = [];
    routineStart = routineEnd = null;
    checkpoint = alarmFloor = anchor = 0;
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => undefined);
      context = null;
    }
    musicBus?.disconnect();
    beepBus?.disconnect();
    outputBus?.disconnect();
    musicBus = beepBus = outputBus = null;
    state = { ...initialState(), ducked: state.ducked, beepsMuted: state.beepsMuted };
    emit();
  }

  return {
    async load(value, audio) {
      if (disposed) throw new Error('player_disposed');
      running = false;
      ready = false;
      cancelScheduled();
      firedAlarms.clear();
      const token = generation;
      buffers.clear();
      fillerBuffers.clear();
      releaseFillerCache();
      checkpoint = 0;
      alarmFloor = 0;
      state = { ...initialState(), ducked: state.ducked, beepsMuted: state.beepsMuted };
      routine = structuredClone(value);
      updateBuses();
      classAudio = undefined;
      sourceTracks = [];
      segments = [];
      emit();
      try {
        assertRuntimeDecoderAvailable(true);
        if (validateRoutine(routine).length) throw new Error('invalid_routine');
        const selectedAudio = audio === undefined ? routineClassAudio(routine) : audio;
        classAudio = selectedAudio === undefined ? undefined : snapshotClassAudio(selectedAudio);
        sourceTracks = [...routine.tracks, ...classAudio?.walkIn?.tracks ?? [], ...classAudio?.walkOut?.tracks ?? []];
        if (sourceTracks.length > 100) throw new Error('invalid_routine');
        for (const track of sourceTracks) {
          if (track.duration > MAX_TRACK_SECONDS) throw new Error('audio_duration_mismatch');
          if (estimateRuntimePcm(track.duration) > MAX_DECODED_BYTES) throw new Error('audio_memory_limit');
        }
        if (routine.beepEvery > 0 && routine.beepEvery < 0.25) throw new Error('beep_interval_too_short');
        const readiness = classAudio ? await getReadinessClass(routine, classAudio) : await getReadiness(routine);
        if (token !== generation) return;
        if (!readiness.ready) {
          const recording = routine.filler.recording;
          const missing = readiness.missing.map(id => recording && id === `filler-${recording.asset.id}` ?
            `${recording.name} (${id})` : id);
          throw new Error(`missing_audio${missing.length ? `: ${missing.join(', ')}` : ''}`);
        }
        segments = initialPlan();
        const recordings = new Map(classFillers(routine, classAudio)
          .filter(filler => filler.sound === 'lofi' || filler.sound === 'recording' && filler.mode !== 'none')
          .map(filler => [fillerKey(filler), filler]));
        for (const [key, filler] of recordings) {
          fillerBuffers.clear();
          releaseFillerCache();
          const buffer = await getFillerBuffer(audioContext(), filler);
          if (token !== generation) { releaseFillerCache(new Set(fillerBuffers.values())); return; }
          fillerBuffers.set(key, buffer);
        }
        if (token !== generation) return;
        trimFillers(0);
        await prepareWindow(windowIndices(0).filter(index => segments.some(segment => segment.kind === 'song' &&
          segment.trackIndex === index && segment.start <= 0)), token);
        await prepareFillers(0, token);
        await prepareWindow(windowIndices(0), token, true);
        if (token !== generation) return;
        ready = true;
        project();
        emit();
      } catch (error) {
        if (token === generation) {
          buffers.clear();
          fillerBuffers.clear();
          state = { ...state, status: 'error', error: error instanceof Error ? error.message : 'audio_not_prepared' };
          emit();
        }
        throw error;
      }
    },
    play,
    unload,
    advance: () => requestNext(true),
    seek,
    updateCues,
    pause() { pauseWithError(); },
    stop: () => rewindTrack(),
    previous,
    next: requestNext,
    hold() {
      if (!ready || !routine || disposed || state.status === 'finished') return;
      const seconds = position();
      const current = ownerAt(seconds);
      if (!current || phaseOf(current) !== 'routine') return;
      const after = current.trackIndex < routine.tracks.length - 1 ? routine.tracks[current.trackIndex].after : undefined;
      const filler = current.filler ?? (after?.mode === 'custom' ? after.filler : routine.filler);
      const crossfade = current.crossfade ?? (after?.mode === 'custom' ? after.crossfade ?? routine.crossfade : routine.crossfade);
      if (!fillerBuffers.has(fillerKey(filler))) {
        const recording = filler.recording;
        const error = `missing_audio: ${recording?.name ?? 'filler'} (filler-${recording?.asset.id ?? 'unprepared'})`;
        state = { ...state, error };
        emit();
        throw new Error(error);
      }
      const retained = segments.slice(0, segments.indexOf(current) + 1);
      for (const segment of retained) segment.gainPoints = gainPoints(segment);
      if (current.kind === 'filler') {
        const level = envelope(current, seconds);
        const recovered = current.gainPoints?.find(point => point.seconds > seconds && point.level === 1)?.seconds ??
          seconds + Math.max(0.01, crossfade);
        current.duration = Infinity;
        current.gainPoints = [{ seconds, level }, { seconds: recovered, level: 1 }];
      } else {
        const start = Math.max(seconds, end(current) - transitionOverlap(Math.max(0.01, crossfade), current.duration, Infinity));
        current.gainPoints = current.gainPoints!.filter(point => point.seconds < start);
        current.gainPoints.push({ seconds: start, level: 1 }, { seconds: end(current), level: 0 });
        retained.push({ kind: 'filler', trackIndex: current.trackIndex, duration: Infinity, start, filler, crossfade });
      }
      replacePlan(retained);
    },
    async continue() {
      if (running && ownerAt(position())?.kind === 'filler') await requestNext();
    },
    setVolume(value) { if (Number.isFinite(value)) volume = Math.max(0, Math.min(1, value)); updateBuses(); },
    setDucked(value) { state = { ...state, ducked: value }; updateBuses(); emit(); },
    setBeepsMuted(value) { state = { ...state, beepsMuted: value }; updateBuses(); emit(); },
    subscribe(listener) {
      if (disposed) throw new Error('player_disposed');
      listeners.add(listener);
      listener({ ...state });
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      listeners.clear();
      unload();
      disposed = true;
      unregisterPcm();
      globalThis.removeEventListener?.('pagehide', onPageHide);
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}