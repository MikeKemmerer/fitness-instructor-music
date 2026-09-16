import type { AudioPreview, PreviewState } from '../../shared/preview-contract';
import type { Track } from '../../shared/routine';
import { getTrackBlob, MAX_DECODED_BYTES, MAX_TRACK_SECONDS } from './offline';
import { getFillerBuffer } from './filler-audio';

const idleState = (): PreviewState => ({
  kind: 'idle', trackId: null, playing: false, loading: false,
  elapsed: 0, duration: 0, error: null,
});

export function createAudioPreview(onStart?: () => void): AudioPreview {
  let state = idleState();
  let context: AudioContext | null = null;
  let buffer: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let level: GainNode | null = null;
  let sourceGain = 1;
  let anchor = 0;
  let generation = 0;
  let disposed = false;
  let frame: number | null = null;
  let queue = Promise.resolve();
  const listeners = new Set<(value: PreviewState) => void>();
  const getState = (): PreviewState => ({
    ...state,
    elapsed: state.playing && context ?
      Math.min(state.duration, state.elapsed + Math.max(0, context.currentTime - anchor)) : state.elapsed,
  });
  const emit = () => { for (const listener of listeners) listener(getState()); };

  function release(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
      source.buffer = null;
    }
    gain?.disconnect();
    level?.disconnect();
    source = null;
    gain = null;
    level = null;
  }

  function pause(): void {
    generation++;
    state = { ...getState(), playing: false, loading: false };
    release();
    if (state.kind === 'filler') buffer = null;
    emit();
  }

  function stop(): void {
    generation++;
    release();
    buffer = null;
    state = idleState();
    emit();
  }

  function audioContext(): AudioContext {
    if (context) return context;
    const Constructor = globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) throw new Error('audio_unavailable');
    context = new Constructor({ sampleRate: 44100 });
    context.onstatechange = () => {
      if (state.playing && context?.state !== 'running') {
        pause();
        state.error = 'audio_interrupted';
        emit();
      }
    };
    return context;
  }

  function start(): void {
    if (!context || !buffer || disposed) return;
    release();
    source = context.createBufferSource();
    gain = context.createGain();
    level = context.createGain();
    level.gain.setValueAtTime(sourceGain, context.currentTime);
    source.buffer = buffer;
    source.loop = state.kind === 'filler';
    source.connect(level);
    level.connect(gain);
    gain.connect(context.destination);
    anchor = context.currentTime;
    const remaining = state.duration - state.elapsed;
    const fade = Math.min(0.01, remaining / 2);
    gain.gain.setValueAtTime(0, anchor);
    gain.gain.linearRampToValueAtTime(1, anchor + fade);
    gain.gain.setValueAtTime(1, anchor + remaining - fade);
    gain.gain.linearRampToValueAtTime(0, anchor + remaining);
    const active = source;
    source.onended = () => {
      if (source !== active) return;
      state = { ...state, playing: false, elapsed: state.duration };
      release();
      if (state.kind === 'filler') buffer = null;
      emit();
    };
    source.start(anchor, state.kind === 'filler' ? state.elapsed % buffer.duration : state.elapsed);
    source.stop(anchor + remaining);
    state = { ...state, playing: true, loading: false, error: null };
    const tick = () => {
      if (!state.playing || disposed) return;
      emit();
      frame = requestAnimationFrame(tick);
    };
    tick();
  }

  async function playTrack(track: Track, startSeconds?: number): Promise<void> {
    if (disposed) return;
    const current = getState();
    const sameTrack = current.kind === 'track' && current.trackId === track.id;
    const elapsed = startSeconds ?? (sameTrack ? current.elapsed : 0);
    const token = ++generation;
    release();
    if (!sameTrack) buffer = null;
    state = {
      kind: 'track', trackId: track.id, playing: false, loading: true,
      elapsed: Number.isFinite(elapsed) ? Math.max(0, Math.min(track.duration, elapsed)) : 0,
      duration: track.duration, error: null,
    };
    emit();
    try {
      sourceGain = track.gain ?? 1;
      if (!Number.isFinite(sourceGain) || sourceGain < 0 || sourceGain > 1.5) throw new Error('invalid_audio_gain');
      onStart?.();
      const audio = audioContext();
      const resumed = audio.resume();
      const operation = queue.then(async () => {
        if (token !== generation || buffer) return;
        const blob = await getTrackBlob(track.id);
        if (token !== generation) return;
        if (!blob) throw new Error('missing_audio');
        const bytes = await blob.arrayBuffer();
        if (token !== generation) return;
        const decoded = await audio.decodeAudioData(bytes);
        if (token !== generation) return;
        if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > MAX_TRACK_SECONDS ||
          Math.abs(decoded.duration - track.duration) > 0.1) throw new Error('audio_duration_mismatch');
        if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2 ||
          decoded.length * decoded.numberOfChannels * 4 > MAX_DECODED_BYTES) throw new Error('audio_memory_limit');
        buffer = decoded;
      });
      queue = operation.catch(() => undefined);
      await Promise.all([resumed, operation]);
      if (token !== generation) return;
      if (audio.state !== 'running') throw new Error('audio_interrupted');
      if (state.elapsed >= state.duration) state.elapsed = 0;
      start();
    } catch (error) {
      if (token !== generation) return;
      generation++;
      release();
      buffer = null;
      state = { ...state, playing: false, loading: false, error: error instanceof Error ? error.message : 'audio_unavailable' };
      emit();
      throw error;
    }
  }

  return {
    playTrack,
    async playFiller(filler) {
      if (disposed) return;
      stop();
      const token = generation;
      state = { ...idleState(), kind: 'filler', loading: true, duration: 8 };
      emit();
      try {
        const snapshot = structuredClone(filler);
        sourceGain = snapshot.gain ?? 1;
        if (!Number.isFinite(sourceGain) || sourceGain < 0 || sourceGain > 1.5) throw new Error('invalid_audio_gain');
        onStart?.();
        const audio = audioContext();
        await Promise.all([audio.resume(), queue]);
        if (token !== generation) return;
        if (audio.state !== 'running') throw new Error('audio_interrupted');
        const prepared = await getFillerBuffer(audio, snapshot);
        if (token !== generation) return;
        if (audio.state !== 'running') throw new Error('audio_interrupted');
        buffer = prepared;
        start();
      } catch (error) {
        if (token !== generation) return;
        generation++;
        release();
        buffer = null;
        state = { ...state, loading: false, playing: false, error: error instanceof Error ? error.message : 'audio_unavailable' };
        emit();
        throw error;
      }
    },
    pause,
    stop,
    seek(seconds) {
      if (disposed || state.kind !== 'track' || !Number.isFinite(seconds)) return;
      const playing = state.playing;
      pause();
      state.elapsed = Math.max(0, Math.min(state.duration, seconds));
      if (playing && state.elapsed < state.duration) start();
      emit();
    },
    getState,
    subscribe(listener) {
      listeners.add(listener);
      listener(getState());
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      listeners.clear();
      if (context) {
        context.onstatechange = null;
        void context.close().catch(() => undefined);
      }
    },
  };
}