import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioPreview } from '../frontend/src/audio-preview';
import { generateLoopSamples } from '../frontend/src/offline';
import { newRoutine, type Filler, type FillerRecording, type Track } from '../shared/routine';
import type { AudioPreview } from '../shared/preview-contract';

const storage = vi.hoisted(() => ({ get: vi.fn() }));
const recording = vi.hoisted(() => ({ get: vi.fn(), blob: vi.fn(), decode: vi.fn() }));
vi.mock('../frontend/src/filler-audio', async original => {
  const actual = await original<typeof import('../frontend/src/filler-audio')>();
  return { ...actual, getFillerBuffer: (...args: Parameters<typeof actual.getFillerBuffer>) =>
    args[1].sound === 'lofi' ? recording.get(...args) : actual.getFillerBuffer(...args) };
});
vi.mock('../frontend/src/offline', async original => ({
  ...await original<typeof import('../frontend/src/offline')>(), getTrackBlob: storage.get,
  getFillerRecordingBlob: recording.blob,
}));

class Source {
  buffer: AudioBuffer | null = null;
  loop = false;
  playbackRate = { value: 1, setValueAtTime: vi.fn() };
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

interface MockBuffer {
  duration: number;
  numberOfChannels: number;
  length: number;
  copyToChannel: ReturnType<typeof vi.fn>;
}

interface MockGain {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
}

class Context {
  static instances: Context[] = [];
  currentTime = 0;
  state = 'suspended';
  destination = {};
  onstatechange: (() => void) | null = null;
  sources: Source[] = [];
  buffers: MockBuffer[] = [];
  gains: MockGain[] = [];
  constructor() { Context.instances.push(this); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  decodeAudioData = vi.fn(async () => ({ duration: 20, length: 882000, numberOfChannels: 1 }));
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  createGain(): MockGain {
    const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() } };
    this.gains.push(gain);
    return gain;
  }
  createBuffer(channels: number, length: number, sampleRate: number): MockBuffer {
    const buffer = { duration: length / sampleRate, numberOfChannels: channels, length, copyToChannel: vi.fn() };
    this.buffers.push(buffer);
    return buffer;
  }
}

const track: Track = { id: 'one', title: 'One', duration: 20, bpm: 120, firstBeat: 0, bodyArea: '', cues: [] };
const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(accept => { resolve = accept; });
  return { promise, resolve };
};

describe('editor audio preview', () => {
  let preview: AudioPreview;
  const onStart = vi.fn();
  const customFiller = (gain = 1): Filler & { recording: FillerRecording } => ({ ...newRoutine().filler, sound: 'recording', gain, recording: {
    id: crypto.randomUUID(), name: 'Synthetic custom audition', duration: 16,
    asset: { id: crypto.randomUUID(), sha256: '1'.repeat(64), bytes: 64, contentType: 'audio/wav' },
  } });
  beforeEach(() => {
    recording.get.mockReset();
    recording.blob.mockReset().mockResolvedValue(new Blob([new Uint8Array(64)], { type: 'audio/wav' }));
    recording.decode.mockReset().mockResolvedValue({ duration: 16, length: 705600, numberOfChannels: 1 });
    Context.instances = [];
    onStart.mockClear();
    storage.get.mockReset().mockResolvedValue(new Blob(['synthetic']));
    vi.stubGlobal('AudioContext', Context);
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = recording.decode; });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    preview = createAudioPreview(onStart);
  });
  afterEach(() => { preview.dispose(); vi.unstubAllGlobals(); });

  it.each([undefined, 0, 0.5, 1, 1.5])('keeps track gain %s separate from fades through seek and resume', async gain => {
    await preview.playTrack({ ...track, gain });
    const audio = Context.instances[0];
    const buffer = audio.sources[0].buffer;
    const check = (index: number, expected: number) => {
      const envelope = audio.gains[index * 2];
      const level = audio.gains[index * 2 + 1];
      expect(audio.sources[index].connect).toHaveBeenCalledWith(level);
      expect(level.connect).toHaveBeenCalledWith(envelope);
      expect(level.gain.setValueAtTime).toHaveBeenCalledWith(expected, audio.currentTime);
      expect(level.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
      expect(envelope.gain.linearRampToValueAtTime.mock.calls[0][0]).toBe(1);
      expect(audio.sources[index].buffer).toBe(buffer);
    };
    check(0, gain ?? 1);
    audio.currentTime = 2;
    preview.seek(5);
    check(1, gain ?? 1);
    preview.pause();
    await preview.playTrack({ ...track, gain: 0.75 });
    check(2, 0.75);
    expect(audio.sources[2].start).toHaveBeenCalledWith(2, 5);
    expect(audio.decodeAudioData).toHaveBeenCalledOnce();
    expect(audio.gains[1].disconnect).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0, 0.5, 1, 1.5])('applies filler gain %s without changing generated samples', async gain => {
    const filler = { ...newRoutine().filler, gain };
    await preview.playFiller(filler);
    const audio = Context.instances[0];
    expect(audio.gains[1].gain.setValueAtTime).toHaveBeenCalledWith(gain ?? 1, 0);
    expect(audio.gains[0].gain.linearRampToValueAtTime.mock.calls[0][0]).toBe(1);
    expect(audio.buffers[0].copyToChannel.mock.calls[0][0]).toEqual(generateLoopSamples(filler.sound, filler.bpm));
  });

  it.each([NaN, Infinity, -0.1, 1.51])('rejects invalid source gain %s before audition', async gain => {
    await expect(preview.playTrack({ ...track, gain })).rejects.toThrow('invalid_audio_gain');
    await expect(preview.playFiller({ ...newRoutine().filler, gain })).rejects.toThrow('invalid_audio_gain');
    expect(Context.instances).toHaveLength(0);
    expect(preview.getState()).toMatchObject({ playing: false, loading: false, error: 'invalid_audio_gain' });
  });

  it('auditions the shared recorded buffer at native rate for eight seconds', async () => {
    const buffer = { duration: 16, length: 352800, numberOfChannels: 1, sampleRate: 22050 } as AudioBuffer;
    recording.get.mockResolvedValue(buffer);
    await preview.playFiller({ ...newRoutine().filler, sound: 'lofi', bpm: 40 });
    const audio = Context.instances[0];
    expect(audio.buffers).toHaveLength(0);
    expect(audio.sources[0].buffer).toBe(buffer);
    expect(audio.sources[0].playbackRate.value).toBe(1);
    expect(audio.sources[0].playbackRate.setValueAtTime).not.toHaveBeenCalled();
    expect(audio.sources[0].stop).toHaveBeenCalledWith(8);
    expect(preview.getState()).toMatchObject({ kind: 'filler', duration: 8, playing: true });
  });

  it('discards a recorded buffer fetched after audition cancellation', async () => {
    const pending = deferred<AudioBuffer>();
    recording.get.mockReturnValue(pending.promise);
    const playing = preview.playFiller({ ...newRoutine().filler, sound: 'lofi' });
    await vi.waitFor(() => expect(recording.get).toHaveBeenCalledOnce());
    preview.stop();
    pending.resolve({ duration: 16 } as AudioBuffer);
    await playing;
    expect(Context.instances[0].sources).toHaveLength(0);
    expect(preview.getState()).toMatchObject({ kind: 'idle', playing: false });
  });

  it.each([0, 0.5, 1, 1.5])('auditions private cached bytes at native rate with gain %s and an eight-second loop', async gain => {
    const filler = customFiller(gain);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await preview.playFiller(filler);
    const audio = Context.instances[0];
    const source = audio.sources[0];
    const decoded = await recording.decode.mock.results[0].value;
    expect(source.buffer).toBe(decoded);
    expect(source.loop).toBe(true);
    expect(source.playbackRate.value).toBe(1);
    expect(source.playbackRate.setValueAtTime).not.toHaveBeenCalled();
    expect(source.stop).toHaveBeenCalledWith(8);
    expect(audio.gains[1].gain.setValueAtTime).toHaveBeenCalledWith(gain, 0);
    expect(audio.gains[0].gain.linearRampToValueAtTime.mock.calls[0][0]).toBe(1);
    expect(recording.blob).toHaveBeenCalledWith(filler.recording);
    expect(recording.decode.mock.calls[0][0]).toEqual(new ArrayBuffer(64));
    expect(audio.buffers).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(recording.get).not.toHaveBeenCalled();
    expect(preview.getState()).toMatchObject({ kind: 'filler', playing: true, duration: 8 });
  });

  it('snapshots the custom descriptor and gain before an asynchronous audio resume', async () => {
    await preview.playTrack(track);
    preview.stop();
    const audio = Context.instances[0];
    const resumed = deferred<void>();
    audio.resume.mockReturnValueOnce(resumed.promise);
    const filler = customFiller(0.5);
    const expected = structuredClone(filler);
    const playing = preview.playFiller(filler);
    filler.recording.asset.id = 'edited-after-start';
    filler.recording.name = 'Edited after start';
    filler.gain = 1.5;
    resumed.resolve();
    await playing;
    expect(recording.blob).toHaveBeenCalledWith(expected.recording);
    expect(audio.gains.at(-1)?.gain.setValueAtTime).toHaveBeenCalledWith(0.5, 0);
  });

  it('discards a custom buffer decoded after audition cancellation', async () => {
    const decoded = deferred<AudioBuffer>();
    recording.decode.mockReturnValueOnce(decoded.promise);
    const playing = preview.playFiller(customFiller());
    await vi.waitFor(() => expect(recording.decode).toHaveBeenCalledOnce());
    preview.stop();
    decoded.resolve({ duration: 16, length: 705600, numberOfChannels: 1 } as AudioBuffer);
    await playing;
    expect(Context.instances[0].sources).toHaveLength(0);
    expect(preview.getState()).toMatchObject({ kind: 'idle', playing: false });
  });

  it('surfaces unavailable custom bytes and decoder duration mismatches without synthesis', async () => {
    const filler = customFiller();
    recording.blob.mockResolvedValueOnce(undefined);
    await expect(preview.playFiller(filler)).rejects.toThrow('Synthetic custom audition');
    expect(recording.decode).not.toHaveBeenCalled();
    recording.decode.mockResolvedValueOnce({ duration: 17, length: 749700, numberOfChannels: 1 });
    await expect(preview.playFiller(filler)).rejects.toThrow('audio_duration_mismatch');
    expect(Context.instances[0].sources).toHaveLength(0);
    expect(Context.instances[0].buffers).toHaveLength(0);
    expect(preview.getState()).toMatchObject({ playing: false, loading: false, error: 'audio_duration_mismatch' });
  });

  it('surfaces unavailable recorded filler without substituting a generated sound', async () => {
    recording.get.mockRejectedValue(new Error('filler_unavailable'));
    await expect(preview.playFiller({ ...newRoutine().filler, sound: 'lofi' })).rejects.toThrow('filler_unavailable');
    expect(Context.instances[0].buffers).toHaveLength(0);
    expect(preview.getState()).toMatchObject({ playing: false, loading: false, error: 'filler_unavailable' });
  });

  it('lazily resumes one context and samples a fresh cursor without UI ticks', async () => {
    expect(Context.instances).toHaveLength(0);
    await preview.playTrack(track);
    const audio = Context.instances[0];
    audio.currentTime = 3.125;
    expect(preview.getState().elapsed).toBe(3.125);
    preview.pause();
    audio.currentTime = 50;
    await preview.playTrack(track);
    expect(audio.sources[1].start).toHaveBeenCalledWith(50, 3.125);
    expect(audio.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(Context.instances).toHaveLength(1);
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('seeks the loaded track, starts other tracks at zero, and cleans natural endings', async () => {
    await preview.playTrack(track, 5);
    const audio = Context.instances[0];
    preview.seek(7);
    expect(audio.sources[0].buffer).toBeNull();
    expect(audio.sources[1].start).toHaveBeenCalledWith(0, 7);
    await preview.playTrack({ ...track, id: 'two' });
    expect(audio.sources[2].start).toHaveBeenCalledWith(0, 0);
    audio.sources[2].onended?.();
    expect(preview.getState()).toMatchObject({ playing: false, elapsed: 20, loading: false });
    expect(audio.sources[2].buffer).toBeNull();
    await preview.playTrack({ ...track, id: 'two' });
    expect(audio.sources[3].start).toHaveBeenCalledWith(0, 0);
  });

  it.each(['pause', 'stop', 'dispose'] as const)('cancels a pending load on %s', async action => {
    const pending = deferred<Blob>();
    storage.get.mockReturnValueOnce(pending.promise);
    const playing = preview.playTrack(track);
    await Promise.resolve();
    preview[action]();
    pending.resolve(new Blob(['synthetic']));
    await playing;
    expect(Context.instances[0].sources).toHaveLength(0);
    expect(preview.getState()).toMatchObject({ playing: false, loading: false });
  });

  it('serializes decodes and discards canceled results when another track wins', async () => {
    const first = preview.playTrack(track);
    const audio = Context.instances[0];
    const pending = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    audio.decodeAudioData.mockReturnValueOnce(pending.promise);
    await vi.waitFor(() => expect(audio.decodeAudioData).toHaveBeenCalledTimes(1));
    const second = preview.playTrack({ ...track, id: 'two' });
    expect(audio.decodeAudioData).toHaveBeenCalledTimes(1);
    pending.resolve({ duration: 20, length: 882000, numberOfChannels: 1 });
    await Promise.all([first, second]);
    expect(audio.sources).toHaveLength(1);
    expect(audio.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(preview.getState().trackId).toBe('two');
  });

  it('reports missing/decode errors without retaining voices and allows retry', async () => {
    storage.get.mockResolvedValueOnce(undefined);
    await expect(preview.playTrack(track)).rejects.toThrow('missing_audio');
    expect(preview.getState()).toMatchObject({ loading: false, playing: false, error: 'missing_audio' });
    Context.instances[0].decodeAudioData.mockRejectedValueOnce(new Error('decode_failed'));
    await expect(preview.playTrack(track)).rejects.toThrow('decode_failed');
    await preview.playTrack(track);
    expect(preview.getState()).toMatchObject({ playing: true, error: null });
  });

  it('invalidates a still-pending decode when gesture resume fails', async () => {
    await preview.playTrack(track);
    preview.stop();
    const audio = Context.instances[0];
    const pending = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    audio.decodeAudioData.mockReturnValueOnce(pending.promise);
    let reject!: (error: Error) => void;
    audio.resume.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    const failed = preview.playTrack(track);
    await vi.waitFor(() => expect(audio.decodeAudioData).toHaveBeenCalledTimes(2));
    reject(new Error('gesture_required'));
    await expect(failed).rejects.toThrow('gesture_required');
    pending.resolve({ duration: 20, length: 882000, numberOfChannels: 1 });
    await preview.playTrack(track);
    expect(audio.decodeAudioData).toHaveBeenCalledTimes(3);
    expect(audio.sources).toHaveLength(2);
    expect(preview.getState()).toMatchObject({ playing: true, loading: false, error: null });
  });

  it('cancels a filler audition awaiting resume and cleans resources on disposal', async () => {
    await preview.playTrack(track);
    const audio = Context.instances[0];
    const pending = deferred<void>();
    audio.resume.mockReturnValueOnce(pending.promise);
    const audition = preview.playFiller(newRoutine().filler);
    preview.dispose();
    pending.resolve();
    await audition;
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].buffer).toBeNull();
    expect(audio.close).toHaveBeenCalledOnce();
    expect(preview.getState()).toMatchObject({ kind: 'idle', loading: false, playing: false });
  });

  it('requires manual recovery after an interrupted preview context', async () => {
    await preview.playTrack(track);
    const audio = Context.instances[0];
    audio.currentTime = 2;
    audio.state = 'suspended';
    audio.onstatechange?.();
    expect(preview.getState()).toMatchObject({ playing: false, elapsed: 2, error: 'audio_interrupted' });
    audio.state = 'running';
    audio.onstatechange?.();
    expect(audio.sources).toHaveLength(1);
    await preview.playTrack(track);
    expect(audio.sources[1].start).toHaveBeenCalledWith(2, 2);
  });

  it.each(['none', 'timed', 'hold'] as const)('auditions the saved filler sound for eight seconds in %s mode', async mode => {
    const filler = { ...newRoutine().filler, mode };
    await preview.playFiller(filler);
    const audio = Context.instances[0];
    expect(audio.buffers[0].copyToChannel.mock.calls[0][0]).toEqual(generateLoopSamples(filler.sound, filler.bpm));
    expect(audio.sources[0].loop).toBe(true);
    expect(audio.sources[0].stop).toHaveBeenCalledWith(8);
    expect(preview.getState()).toMatchObject({ kind: 'filler', duration: 8, playing: true });
    audio.sources[0].onended?.();
    expect(audio.sources[0].buffer).toBeNull();
    expect(preview.getState().playing).toBe(false);
  });
});