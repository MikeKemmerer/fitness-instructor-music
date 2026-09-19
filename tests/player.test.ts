import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { resolve } from 'node:path';
import { beepOffsets, createPlayer, projectCues, transitionOverlap } from '../frontend/src/player';
import { newRoutine, type Cue, type Filler, type FillerRecording, type Track } from '../shared/routine';
import type { Player, PlayerState } from '../shared/player-contract';
import { newMusicPlaylist, type ClassAudio } from '../shared/class-plan';
import { estimateRuntimePcm, MAX_RUNTIME_PCM_BYTES, runtimePcmBytes } from '../frontend/src/native-audio';

const storage = vi.hoisted(() => ({
  ready: true, durations: [12, 10, 14], decoded: [] as number[], missing: new Set<string>(),
  requested: [] as string[],
  readinessMissing: [] as string[],
  deferred: new Map<string, Promise<Blob | undefined>>(),
}));
const recording = vi.hoisted(() => ({ get: vi.fn(), blob: vi.fn(), requested: [] as Filler[] }));
vi.mock('../frontend/src/filler-audio', async original => {
  const actual = await original<typeof import('../frontend/src/filler-audio')>();
  return { ...actual, getFillerBuffer: (...args: Parameters<typeof actual.getFillerBuffer>) => {
    recording.requested.push(args[1]);
    return args[1].sound === 'lofi' ? recording.get(...args) : actual.getFillerBuffer(...args);
  } };
});
vi.mock('../frontend/src/offline', async importOriginal => {
  const original = await importOriginal<typeof import('../frontend/src/offline')>();
  return {
    ...original,
    getReadiness: async () => ({ ready: storage.ready, missing: storage.ready ? [] : storage.readinessMissing.length ? storage.readinessMissing : ['missing'] }),
    getReadinessClass: async () => ({ ready: storage.ready, missing: storage.ready ? [] : ['missing'] }),
    getFillerRecordingBlob: recording.blob,
    getTrackBlob: async (id: string) => {
      storage.requested.push(id);
      return storage.deferred.get(id) ??
        (storage.missing.has(id) ? undefined : new Blob([new Uint8Array([storage.durations[Number(id)]])]));
    },
  };
});

const track: Track = {
  id: 'first', title: 'Synthetic', duration: 12, bpm: 120, firstBeat: 1, bodyArea: '',
  cues: [
    { id: 'start', anchor: { kind: 'timestamp', seconds: 0 }, note: 'Set up' },
    { id: 'count', anchor: { kind: 'count', count: 5 }, note: 'Pulse' },
    { id: 'fixed', anchor: { kind: 'interval', seconds: 8 }, note: 'Release' },
  ],
};

describe('audio-time projections', () => {
  it('projects timestamp, counted and fixed-seconds cues without accumulated ticks', () => {
    expect(projectCues(track, 0)).toEqual({ currentCue: 'Set up', nextCue: 'Pulse', nextCueIn: 3 });
    expect(projectCues(track, 3)).toEqual({ currentCue: 'Pulse', nextCue: 'Release', nextCueIn: 5 });
    expect(projectCues(track, 9)).toEqual({ currentCue: 'Release', nextCue: '', nextCueIn: null });
    expect(projectCues(track, 1).currentCue).toBe('Set up');
  });

  it('gives incoming cues ownership at incoming start, including zero-time cues', () => {
    const start = track.duration - transitionOverlap(2, track.duration, 10);
    expect(start).toBe(10);
    expect(projectCues(track, 10 - start).currentCue).toBe('Set up');
  });

  it('bounds both ends of each overlap to prevent triple-song decoding', () => {
    expect(transitionOverlap(12, 10, 4)).toBe(2);
    expect(transitionOverlap(0, 10, 4)).toBe(0);
    expect(transitionOverlap(2, 10, 10)).toBe(2);
  });

  it('deduplicates periodic/countdown alarms and excludes the track end', () => {
    expect(beepOffsets(10, 2, 3)).toEqual([2, 4, 6, 7, 8, 9]);
    expect(beepOffsets(10, 0, 0)).toEqual([]);
    expect(beepOffsets(1, 0.000001, 10)).toEqual([]);
  });

  it('keeps one-shot warnings independent, merges coincidences, and handles disabled/outside offsets', () => {
    expect(beepOffsets(10, 0, 0, 3)).toEqual([7]);
    expect(beepOffsets(10, 2, 3, 2)).toEqual([2, 4, 6, 7, 8, 9]);
    expect(beepOffsets(10, 0, 0, 10)).toEqual([0]);
    expect(beepOffsets(10, 0, 0, 11)).toEqual([]);
    expect(beepOffsets(10, 0, 0, 0)).toEqual([]);
    expect(beepOffsets(10, 0, 0, -1)).toEqual([]);
  });

  it('coalesces fractional periodic and one-shot timestamps despite accumulated floating-point error', () => {
    expect(beepOffsets(3, 0.3, 0, 0.9)).toEqual([0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7]);
  });
  it('includes cue alarms, merging duplicate warnings and ignoring invalid offsets', () => {
    expect(beepOffsets(12, 0, 0, 0, [0, 3, 8])).toEqual([0, 3, 8]);
    expect(beepOffsets(12, 3, 2, 4, [3, 8, 10, 10, -1, 12, NaN])).toEqual([3, 6, 8, 9, 10, 11]);
  });
});

describe('real Chromium source-gain rendering', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    server = await createServer({
      configFile: resolve('frontend/vite.config.ts'), root: resolve('frontend'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [{ name: 'gain-test-route', configureServer(instance) {
        instance.middlewares.use('/gain-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><title>Gain test</title><script type="module">
            import * as offline from '/src/offline.ts';
            import * as player from '/src/player.ts';
            import * as preview from '/src/audio-preview.ts';
            import { newRoutine } from '/@fs/${resolve('shared/routine.ts')}';
            globalThis.gainTest = { ...offline, ...player, ...preview, newRoutine };
          </script>`);
        });
      } }],
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}gain-test`);
    await page.waitForFunction(() => 'gainTest' in globalThis);
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it.each(['synthetic', 'recording'] as const)('renders unchanged legacy audition PCM and scales %s filler without mutation', async soundKind => {
    const result = await page.evaluate(async soundKind => {
      const api = (globalThis as unknown as { gainTest: typeof import('../frontend/src/offline') &
        typeof import('../frontend/src/audio-preview') & { newRoutine: typeof newRoutine } }).gainTest;
      const originalContext = globalThis.AudioContext;
      const originalFrame = globalThis.requestAnimationFrame;
      const originalCancel = globalThis.cancelAnimationFrame;
      const originalFetch = globalThis.fetch;
      const blob = api.generateDemoWav(3, 120, 'drums');
      const track = await api.storeTrack(new File([blob], 'synthetic-gain.wav', { type: 'audio/wav' }));
      const recording = soundKind === 'recording' ? await api.addFillerRecording(
        new File([blob], 'synthetic-filler.wav', { type: 'audio/wav' }),
      ) : undefined;
      if (recording) await api.removeFillerRecording(recording.id);
      globalThis.fetch = async () => { throw new Error('unexpected_network_request'); };
      const digest = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        await (await api.getTrackBlob(track.id))!.arrayBuffer()))).join(',');
      const before = await digest();
      const render = async (kind: 'legacy' | 'track' | 'filler' | 'recording-reference', gain?: number) => {
        const duration = kind === 'filler' || kind === 'recording-reference' ? 8 : 3;
        const renderer = new OfflineAudioContext(1, duration * 44100, 44100);
        Object.defineProperties(renderer, {
          state: { get: () => 'running' }, resume: { value: async () => undefined }, close: { value: async () => undefined },
        });
        globalThis.AudioContext = function () { return renderer; } as unknown as typeof AudioContext;
        globalThis.requestAnimationFrame = () => 1;
        globalThis.cancelAnimationFrame = () => undefined;
        const preview = api.createAudioPreview();
        try {
          if (kind === 'legacy' || kind === 'recording-reference') {
            const source = renderer.createBufferSource();
            source.buffer = await renderer.decodeAudioData(await blob.arrayBuffer());
            source.loop = kind === 'recording-reference';
            const envelope = renderer.createGain();
            source.connect(envelope).connect(renderer.destination);
            envelope.gain.setValueAtTime(0, 0);
            envelope.gain.linearRampToValueAtTime(1, 0.01);
            envelope.gain.setValueAtTime(1, duration - 0.01);
            envelope.gain.linearRampToValueAtTime(0, duration);
            source.start(0);
            source.stop(duration);
          } else if (kind === 'track') await preview.playTrack({ ...track, gain });
          else await preview.playFiller({ ...api.newRoutine().filler, gain,
            ...(recording ? { sound: 'recording' as const, recording } : {}) });
          return (await renderer.startRendering()).getChannelData(0).slice();
        } finally { preview.dispose(); }
      };
      const differences: number[] = [];
      const peaks: number[] = [];
      try {
        const legacy = await render('legacy');
        const trackDefault = await render('track');
        const fillerDefault = await render('filler');
        const fillerReference = recording ? await render('recording-reference') : fillerDefault;
        let recordingDifference = 0;
        for (let index = 0; index < fillerDefault.length; index++) {
          recordingDifference = Math.max(recordingDifference, Math.abs(fillerDefault[index] - fillerReference[index]));
        }
        let legacyDifference = 0;
        for (let index = 0; index < legacy.length; index++) {
          legacyDifference = Math.max(legacyDifference, Math.abs(legacy[index] - trackDefault[index]));
        }
        for (const kind of ['track', 'filler'] as const) {
          const neutral = kind === 'track' ? trackDefault : fillerDefault;
          for (const gain of [0, 0.5, 1, 1.5]) {
            const rendered = await render(kind, gain);
            let difference = 0;
            let peak = 0;
            for (let index = 0; index < rendered.length; index++) {
              difference = Math.max(difference, Math.abs(rendered[index] - neutral[index] * gain));
              peak = Math.max(peak, Math.abs(rendered[index]));
            }
            differences.push(difference);
            peaks.push(peak);
          }
        }
        return { legacyDifference, recordingDifference, differences, peaks, unchanged: before === await digest() };
      } finally {
        globalThis.AudioContext = originalContext;
        globalThis.requestAnimationFrame = originalFrame;
        globalThis.cancelAnimationFrame = originalCancel;
        globalThis.fetch = originalFetch;
      }
    }, soundKind);
    console.info('Real Chromium audition gain PCM', result);
    expect(result.legacyDifference).toBe(0);
    expect(result.recordingDifference).toBeLessThan(1e-7);
    expect(result.unchanged).toBe(true);
    expect(Math.max(...result.differences)).toBeLessThan(1e-7);
    expect(result.peaks[0]).toBe(0);
    expect(result.peaks[4]).toBe(0);
    expect(result.peaks[2]).toBeGreaterThan(0.01);
    expect(result.peaks[6]).toBeGreaterThan(0.01);
  }, 30000);

  it.each(['synthetic', 'recording'] as const)('renders independent music/%s filler crossfade gains and master/duck multiplication', async soundKind => {
    const result = await page.evaluate(async soundKind => {
      const api = (globalThis as unknown as { gainTest: typeof import('../frontend/src/offline') &
        typeof import('../frontend/src/player') & { newRoutine: typeof newRoutine } }).gainTest;
      const originalContext = globalThis.AudioContext;
      const originalFrame = globalThis.requestAnimationFrame;
      const originalCancel = globalThis.cancelAnimationFrame;
      const originalInterval = globalThis.setInterval;
      const originalClear = globalThis.clearInterval;
      const originalFetch = globalThis.fetch;
      const routine = api.newRoutine();
      routine.tracks = await Promise.all(['soft', 'drums'].map(async sound => api.storeTrack(new File([
        api.generateDemoWav(3, 120, sound as 'soft' | 'drums'),
      ], `synthetic-${sound}.wav`, { type: 'audio/wav' }))));
      routine.filler = { mode: 'timed', seconds: 1, bpm: 100, sound: 'bright' };
      const custom = soundKind === 'recording' ? await api.addFillerRecording(new File([
        api.generateDemoWav(0.25, 120, 'soft'),
      ], 'synthetic-custom-loop.wav', { type: 'audio/wav' })) : undefined;
      if (custom) routine.filler = { ...routine.filler, sound: 'recording', recording: custom };
      const originalBytes = custom ? await (await api.getFillerRecordingBlob(custom))!.arrayBuffer() : new ArrayBuffer(0);
      routine.crossfade = 0.5;
      routine.beepEvery = routine.beepRemaining = 0;
      await api.saveRoutine(routine, null, 'lock');
      globalThis.fetch = async () => { throw new Error('unexpected_network_request'); };
      const render = async (songGain?: number, fillerGain?: number, volume = 1, ducked = false) => {
        const renderer = new OfflineAudioContext(1, 6 * 44100, 44100);
        Object.defineProperties(renderer, {
          state: { get: () => 'running' }, resume: { value: async () => undefined },
          suspend: { value: async () => undefined }, close: { value: async () => undefined },
        });
        globalThis.AudioContext = function () { return renderer; } as unknown as typeof AudioContext;
        globalThis.requestAnimationFrame = () => 1;
        globalThis.cancelAnimationFrame = () => undefined;
        globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
        globalThis.clearInterval = () => undefined;
        const player = api.createPlayer();
        try {
          await player.load({ ...routine, tracks: routine.tracks.map(track => ({ ...track, gain: songGain })),
            filler: { ...routine.filler, gain: fillerGain } });
          if (custom) await api.removeFillerRecording(custom.id);
          player.setVolume(volume);
          player.setDucked(ducked);
          await player.play();
          return (await renderer.startRendering()).getChannelData(0).slice();
        } finally { player.dispose(); }
      };
      try {
        const legacy = await render();
        const neutral = await render(1, 1);
        const songs = await render(1, 0);
        const filler = await render(0, 1);
        const mixed = await render(0.5, 1.5);
        const ducked = await render(0.5, 1.5, 0.6, true);
        let neutralDifference = 0;
        let mixDifference = 0;
        let duckDifference = 0;
        let peak = 0;
        let fillerPeak = 0;
        for (let index = 0; index < neutral.length; index++) {
          neutralDifference = Math.max(neutralDifference, Math.abs(legacy[index] - neutral[index]));
          mixDifference = Math.max(mixDifference, Math.abs(mixed[index] - (songs[index] * 0.5 + filler[index] * 1.5)));
          if (index > 44100) duckDifference = Math.max(duckDifference, Math.abs(ducked[index] - mixed[index] * 0.15));
          peak = Math.max(peak, Math.abs(mixed[index]));
          fillerPeak = Math.max(fillerPeak, Math.abs(filler[index]));
        }
        const currentBytes = custom ? await (await api.getFillerRecordingBlob(custom))!.arrayBuffer() : originalBytes;
        const unchanged = currentBytes.byteLength === originalBytes.byteLength &&
          new Uint8Array(currentBytes).every((byte, index) => byte === new Uint8Array(originalBytes)[index]);
        return { neutralDifference, mixDifference, duckDifference, peak, fillerPeak, unchanged,
          ready: (await api.getReadiness(routine)).ready };
      } finally {
        globalThis.AudioContext = originalContext;
        globalThis.requestAnimationFrame = originalFrame;
        globalThis.cancelAnimationFrame = originalCancel;
        globalThis.setInterval = originalInterval;
        globalThis.clearInterval = originalClear;
        globalThis.fetch = originalFetch;
      }
    }, soundKind);
    console.info('Real Chromium player gain PCM', result);
    expect(result.neutralDifference).toBe(0);
    expect(result.mixDifference).toBeLessThan(1e-7);
    expect(result.duckDifference).toBeLessThan(1e-7);
    expect(result.peak).toBeGreaterThan(0.01);
    expect(result.fillerPeak).toBeGreaterThan(0.01);
    expect(result.unchanged).toBe(true);
    expect(result.ready).toBe(true);
  }, 30000);
});

class MockParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
}

class MockGain {
  gain = new MockParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  playbackRate = new MockParam();
  frequency = new MockParam();
  onended: (() => void) | null = null;
  started = false;
  start = vi.fn((_when?: number, _offset?: number) => { this.started = true; });
  stop = vi.fn((_when?: number) => {
    if (!this.started) throw new Error('InvalidStateError: stop before start');
  });
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockContext {
  static latest: MockContext;
  currentTime = 0;
  gainQuantum = 0;
  state = 'suspended';
  destination = {};
  onstatechange: (() => void) | null = null;
  sources: MockSource[] = [];
  oscillators: MockSource[] = [];
  gains: MockGain[] = [];
  constructor() { MockContext.latest = this; }
  resume = vi.fn(async () => { this.state = 'running'; });
  suspend = vi.fn(async () => { this.state = 'suspended'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  createGain() { this.currentTime += this.gainQuantum; const gain = new MockGain(); this.gains.push(gain); return gain; }
  createBufferSource() { const source = new MockSource(); this.sources.push(source); return source; }
  createOscillator() { const source = new MockSource(); this.oscillators.push(source); return source; }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return { numberOfChannels: channels, length, duration: length / sampleRate, copyToChannel: vi.fn() };
  }
}

describe('local Web Audio player', () => {
  let player: ReturnType<typeof createPlayer>;
  let state: PlayerState;
  let nextFrame: FrameRequestCallback | undefined;
  const routine = () => {
    const value = newRoutine();
    value.tracks = storage.durations.map((duration, index) => ({
      ...structuredClone(track), id: String(index), duration,
      cues: [{ id: 'start', anchor: { kind: 'timestamp' as const, seconds: 0 }, note: `Song ${index}` }],
    }));
    value.filler.mode = 'none';
    value.crossfade = 2;
    value.beepEvery = 2;
    value.beepRemaining = 3;
    return value;
  };
  const advance = async (seconds: number) => {
    MockContext.latest.currentTime = seconds;
    nextFrame?.(0);
    await vi.waitFor(() => expect(true).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const deferTrack = (id: string) => {
    let resolve!: (value: Blob) => void;
    let reject!: (error: Error) => void;
    storage.deferred.set(id, new Promise<Blob>((accept, fail) => { resolve = accept; reject = fail; }));
    return {
      resolve: () => resolve(new Blob([new Uint8Array([storage.durations[Number(id)]])])),
      reject: () => reject(new Error('decode_failed')),
    };
  };

  beforeEach(() => {
    storage.durations = [12, 10, 14];
    recording.get.mockReset().mockResolvedValue({ duration: 16, length: 352800, numberOfChannels: 1, sampleRate: 22050 });
    recording.blob.mockReset();
    recording.requested = [];
    storage.ready = true;
    storage.readinessMissing = [];
    storage.decoded = [];
    storage.requested = [];
    storage.missing.clear();
    storage.deferred.clear();
    nextFrame = undefined;
    vi.stubGlobal('AudioContext', MockContext);
    vi.stubGlobal('OfflineAudioContext', class {
      async decodeAudioData(bytes: ArrayBuffer) {
        const duration = new Uint8Array(bytes)[0];
        storage.decoded.push(duration);
        return { duration, length: duration * 44100, numberOfChannels: 1 };
      }
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = undefined; });
    player = createPlayer();
    player.subscribe(value => { state = value; });
  });

  afterEach(() => { player.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  const classAudio = (): ClassAudio => ({
    walkIn: { ...newMusicPlaylist(), tracks: routine().tracks.slice(0, 2).map(track => ({ ...track, cues: [] })) },
    walkOut: { ...newMusicPlaylist(), tracks: routine().tracks.slice(2).map(track => ({ ...track, cues: [] })) },
    before: { mode: 'hold', sound: 'soft', bpm: 100, seconds: 0, gain: 0.25 },
    after: { mode: 'hold', sound: 'drums', bpm: 120, seconds: 0, gain: 0.75 }, crossfade: 2,
  });

  it('unified sequence prepares silently and runs every owned phase without an external class setup', async () => {
    const contexts = vi.fn(function () { return new MockContext(); });
    vi.stubGlobal('AudioContext', contexts);
    const value = routine();
    const owned = (id: string) => ({ ...value.tracks[0], id, bpm: undefined, cues: [] });
    storage.durations.push(12, 12);
    value.sequence = { crossfade: 0, walkIn: { name: 'Arrival', tracks: [owned('3')] },
      walkOut: { name: 'Departure', tracks: [owned('4')] },
      before: { mode: 'hold', seconds: 0, bpm: 100, sound: 'soft' },
      after: { mode: 'hold', seconds: 0, bpm: 120, sound: 'drums' } };
    await player.load(value);
    expect(state).toMatchObject({ status: 'idle', phase: 'walk-in', elapsed: 0, classElapsed: 0 });
    expect(contexts).not.toHaveBeenCalled();
    expect(storage.decoded.length).toBeLessThanOrEqual(2);
    value.sequence.walkIn!.tracks[0].title = 'Unprepared edit';
    await player.play();
    expect(state.phaseTrackTitle).toBe('Synthetic');
    await player.advance();
    expect(state.phase).toBe('before');
    await advance(MockContext.latest.currentTime + 3);
    await player.advance();
    expect(state.phase).toBe('routine');
    await advance(MockContext.latest.currentTime + 3);
    await player.next();
    player.stop();
    expect(state).toMatchObject({ phase: 'routine', trackIndex: 1, elapsed: 0, status: 'idle' });
    await player.previous();
    expect(state.trackIndex).toBe(0);
    await player.play();
    await player.next();
    await advance(MockContext.latest.currentTime + 3);
    await player.next();
    await advance(MockContext.latest.currentTime + 3);
    await player.next();
    expect(state.phase).toBe('after');
    await advance(MockContext.latest.currentTime + 3);
    await player.advance();
    expect(state.phase).toBe('walk-out');
    await player.next();
    expect(state.status).toBe('finished');
  });

  it('unified explicit class audio still overrides owned phase playback', async () => {
    const value = routine();
    value.sequence = { crossfade: 0, before: { mode: 'hold', seconds: 0, bpm: 100, sound: 'soft' } };
    await player.load(value, { crossfade: 0 });
    expect(state.phase).toBe('routine');
  });

  it('unified unload releases sound, phase state and PCM while retaining a reusable player and subscription', async () => {
    await player.load(routine(), classAudio());
    await player.play();
    const context = MockContext.latest;
    expect(runtimePcmBytes()).toBeGreaterThan(0);
    player.unload();
    expect(state).toMatchObject({ status: 'idle', duration: 0, classElapsed: 0, currentCue: '', error: null });
    expect(state.phase).toBeUndefined();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.sources.every(source => source.buffer === null)).toBe(true);
    expect(runtimePcmBytes()).toBe(0);
    await expect(player.play()).rejects.toThrow('routine_not_ready');
    await player.load(routine());
    expect(state.duration).toBe(12);
    expect(MockContext.latest).not.toBe(context);
    expect(MockContext.latest.resume).not.toHaveBeenCalled();
    await player.play();
    expect(state.status).toBe('playing');
  });

  it('unified unload invalidates late preparation without reviving the closed routine', async () => {
    const pending = deferTrack('0');
    const loading = player.load(routine());
    await vi.waitFor(() => expect(storage.requested).toContain('0'));
    player.unload();
    pending.resolve();
    await loading;
    expect(storage.decoded).toEqual([]);
    expect(state).toMatchObject({ status: 'idle', duration: 0 });
    await expect(player.play()).rejects.toThrow('routine_not_ready');
    storage.deferred.clear();
    await player.load(routine());
    expect(state.duration).toBe(12);
  });

  it('unified preparation bounds the total of explicit legacy class phases to 100 entries', async () => {
    const value = routine();
    const audio = classAudio();
    audio.walkIn!.tracks = Array.from({ length: 98 }, (_, index) => ({ ...value.tracks[0], id: `arrival-${index}`, cues: [] }));
    await expect(player.load(value, audio)).rejects.toThrow('invalid_routine');
    expect(storage.decoded).toEqual([]);
  });

  it('unified preparation rejects an oversized later phase before declaring readiness', async () => {
    const value = routine();
    value.sequence = { crossfade: 0, walkOut: { name: 'Departure', tracks: [
      { ...value.tracks[0], id: 'out', duration: 361, cues: [] },
    ] } };
    await expect(player.load(value)).rejects.toThrow('audio_duration_mismatch');
    expect(storage.decoded).toEqual([]);
  });

  it('unified unknown BPM supports timed cues and rejects counts without guessing a grid', async () => {
    const value = routine();
    delete value.tracks[0].bpm;
    value.tracks[0].cues.push({ id: 'interval', anchor: { kind: 'interval', seconds: 4 }, note: 'Interval' });
    await player.load(value);
    expect(state.nextCueIn).toBe(4);
    value.tracks[0].cues.push({ id: 'count', anchor: { kind: 'count', count: 1 }, note: 'Count' });
    await expect(player.load(value)).rejects.toThrow('invalid_routine');
  });

  it('class phases load silently, freeze outside cues and snapshots, and advance with one audio context', async () => {
    const audio = classAudio();
    await player.load(routine(), audio);
    expect(state).toMatchObject({ phase: 'walk-in', status: 'idle', classElapsed: 0, currentCue: '', nextCue: '', canAdvance: false });
    audio.walkIn!.tracks[0].title = 'Changed library';
    await player.play();
    const context = MockContext.latest;
    expect(state.phaseTrackTitle).toBe('Synthetic');
    await advance(1);
    expect(context.oscillators).toHaveLength(0);
    await player.seek(8);
    player.updateCues(0, []);
    expect(state.elapsed).toBe(1);
    const outgoing = context.sources[0];
    await Promise.all([player.advance!(), player.advance!()]);
    expect(state).toMatchObject({ phase: 'before', status: 'filler', holding: true, classElapsed: 0 });
    expect(outgoing.disconnect).not.toHaveBeenCalled();
    await player.next();
    expect(state.phase).toBe('before');
    await advance(4);
    await player.advance!();
    expect(state).toMatchObject({ phase: 'routine', trackIndex: 0, currentCue: 'Song 0', classElapsed: 0 });
    expect(MockContext.latest).toBe(context);
    await advance(6);
    expect(state.classElapsed).toBe(2);
    await player.next();
    await player.next();
    player.pause();
    await player.next();
    await player.advance!();
    expect(state).toMatchObject({ phase: 'routine', status: 'paused', trackIndex: 2, canAdvance: false });
    await player.play();
    await player.next();
    expect(state).toMatchObject({ phase: 'after', status: 'filler', currentCue: '', nextCue: '' });
    const elapsed = state.classElapsed;
    await advance(9);
    expect(state.classElapsed).toBe(elapsed);
    await player.advance!();
    expect(state).toMatchObject({ phase: 'walk-out', phaseTrackIndex: 0, trackIndex: 2 });
    await advance(23);
    expect(state).toMatchObject({ phase: 'finished', status: 'finished', canAdvance: false });
    player.stop();
    expect(state).toMatchObject({ phase: 'walk-out', status: 'idle', elapsed: 0 });
    const starts = context.sources.length;
    await player.advance!();
    expect(context.sources).toHaveLength(starts);
    await player.play();
    expect(state.phase).toBe('walk-out');
  });

  it('Stop rewinds the current song silently and Previous uses the one-second boundary', async () => {
    await player.load(routine());
    await player.play();
    await player.next();
    await advance(3);
    expect(state.trackIndex).toBe(1);
    await player.previous!();
    expect(state).toMatchObject({ trackIndex: 1, elapsed: 0, status: 'playing' });
    await player.previous!();
    expect(state).toMatchObject({ trackIndex: 0, elapsed: 0, status: 'playing' });
    await player.next();
    await advance(5);
    player.stop();
    expect(state).toMatchObject({ trackIndex: 1, elapsed: 0, status: 'idle' });
    expect(MockContext.latest.state).toBe('suspended');
    await player.play();
    await advance(7);
    player.pause();
    await player.previous!();
    expect(state).toMatchObject({ trackIndex: 1, elapsed: 0, status: 'paused' });
    await player.previous!();
    expect(state).toMatchObject({ trackIndex: 0, elapsed: 0, status: 'paused' });
  });

  it('Stop and Previous retain the walk-in playlist and announcement phase', async () => {
    await player.load(routine(), classAudio());
    await player.play();
    await player.next();
    await advance(3);
    player.stop();
    expect(state).toMatchObject({ phase: 'walk-in', phaseTrackIndex: 1, elapsed: 0, status: 'idle' });
    await player.previous!();
    expect(state).toMatchObject({ phase: 'walk-in', phaseTrackIndex: 0, elapsed: 0, status: 'idle' });
    await player.play();
    await player.advance!();
    player.stop();
    expect(state).toMatchObject({ phase: 'before', elapsed: 0, status: 'idle' });
    await player.previous!();
    expect(state.phase).toBe('before');
  });

  it.each([1, 2])('class walk-in wraps a %s-song playlist with bounded current/next decoding and prestarts wrap audio', async count => {
    const audio = classAudio();
    audio.walkIn!.tracks = audio.walkIn!.tracks.slice(0, count);
    await player.load(routine(), audio);
    await player.play();
    const context = MockContext.latest;
    for (let seconds = 1; seconds < 240; seconds++) {
      await advance(seconds);
      expect(state.phase).toBe('walk-in');
      expect(state.status).toBe('playing');
      expect(state.classElapsed).toBe(0);
      const live = context.sources.filter(source => source.buffer);
      expect(live.length).toBeGreaterThanOrEqual(2);
      expect(live.length).toBeLessThanOrEqual(3);
      expect(new Set(live.map(source => source.buffer)).size).toBeLessThanOrEqual(count);
      expect(context.sources.at(-1)!.start.mock.calls[0][0]).toBeGreaterThan(seconds);
    }
    expect(new Set(storage.decoded).size).toBe(count);
    expect(context.oscillators).toHaveLength(0);
    await player.next();
    expect(state.phase).toBe('walk-in');
  });

  it('class pause freezes announcement envelopes and does not allow Advance until resume', async () => {
    const audio = classAudio();
    delete audio.walkIn;
    await player.load(routine(), audio);
    await player.play();
    await advance(3);
    player.pause();
    const paused = { ...state };
    await player.advance!();
    await advance(100);
    expect(state).toEqual(paused);
    await player.play();
    expect(state).toMatchObject({ phase: 'before', elapsed: 3 });
    await player.advance!();
    expect(state.phase).toBe('routine');
  });

  it.each(['timed', 'hold'] as const)('paused Continue preserves the %s routine filler and resume position', async mode => {
    const value = routine();
    value.filler = { ...value.filler, mode, seconds: 6 };
    await player.load(value);
    await player.play();
    await advance(11);
    player.pause();
    const paused = { ...state };
    const starts = MockContext.latest.sources.length;
    await player.continue();
    await player.continue();
    expect(state).toEqual(paused);
    expect(MockContext.latest.sources).toHaveLength(starts);
    await advance(100);
    await player.play();
    expect(state).toMatchObject({ status: 'filler', elapsed: paused.elapsed, holding: paused.holding });
    await player.continue();
    expect(state.trackIndex).toBe(1);
  });

  it.each(['stop', 'dispose'] as const)('class %s invalidates a pending phase decode', async command => {
    const audio = classAudio();
    delete audio.before;
    delete audio.after;
    audio.walkIn!.tracks = [audio.walkIn!.tracks[1]];
    await player.load(routine(), audio);
    await player.play();
    const blocked = deferTrack('0');
    const pending = player.advance!();
    await vi.waitFor(() => expect(storage.requested).toContain('0'));
    player[command]();
    const starts = MockContext.latest.sources.length;
    blocked.resolve();
    await pending;
    expect(MockContext.latest.sources).toHaveLength(starts);
    expect(state.phase).toBe('walk-in');
  });

  it.each(['after', 'walk-out', 'finished'] as const)('class natural routine completion routes to %s', async target => {
    const audio = classAudio();
    delete audio.walkIn;
    delete audio.before;
    if (target !== 'after') delete audio.after;
    if (target === 'finished') delete audio.walkOut;
    const value = routine();
    value.tracks = value.tracks.slice(0, 1);
    await player.load(value, audio);
    await player.play();
    await advance(target === 'finished' ? 12 : 10);
    expect(state.phase).toBe(target);
  });

  it.each(['before', 'after'] as const)('paused Continue and Advance preserve the %s announcement', async phase => {
    const audio: ClassAudio = { crossfade: 2, [phase]: { mode: 'hold', seconds: 0, sound: 'soft', bpm: 100 } };
    const value = routine();
    value.tracks = value.tracks.slice(0, 1);
    await player.load(value, audio);
    await player.play();
    if (phase === 'after') await advance(11);
    else await advance(1);
    player.pause();
    const paused = { ...state };
    const starts = MockContext.latest.sources.length;
    for (let repeat = 0; repeat < 3; repeat++) { await player.continue(); await player.advance!(); }
    expect(state).toEqual(paused);
    expect(MockContext.latest.sources).toHaveLength(starts);
    await advance(100);
    await player.play();
    expect(state).toMatchObject({ phase, status: 'filler', elapsed: paused.elapsed });
    await player.advance!();
    expect(state.phase).toBe(phase === 'before' ? 'routine' : 'finished');
  });

  it.each([null, {}, { crossfade: 2, walkIn: null }, { crossfade: 2, walkOut: {} },
    { crossfade: 2, before: null }, { crossfade: 2, before: {} },
    { crossfade: 2, walkIn: { ...newMusicPlaylist(), tracks: null } },
    { crossfade: 2, walkOut: { ...newMusicPlaylist(), tracks: [{}] } }])('rejects malformed ClassAudio %j safely', async audio => {
    await expect(player.load(routine(), audio as unknown as ClassAudio)).rejects.toThrow('invalid_class_audio');
    expect(state).toMatchObject({ status: 'error', error: 'invalid_class_audio' });
    expect(storage.decoded).toEqual([]);
  });

  const privateFiller = (id: string, duration = 4): Filler => ({ mode: 'hold', seconds: 0, sound: 'recording', bpm: 100,
    recording: { id, name: 'Synthetic filler', duration,
      asset: { id, bytes: 44, sha256: 'a'.repeat(64), contentType: 'audio/wav' } } });

  it.each(['soft', 'recording'] as const)('reserves current %s Hold before two later distinct custom fillers after a none gap', async sound => {
    storage.durations = [12, 10, 14, 15];
    recording.blob.mockImplementation(async (reference: FillerRecording) => new Blob([new Uint8Array([reference.duration])]));
    const value = routine();
    if (sound === 'recording') value.filler = privateFiller('current-hold', 3);
    value.tracks[0].after = { mode: 'none' };
    value.tracks[1].after = { mode: 'custom', filler: { ...privateFiller('later-one'), mode: 'timed', seconds: 3 } };
    value.tracks[2].after = { mode: 'custom', filler: { ...privateFiller('later-two', 5), mode: 'timed', seconds: 3 } };
    await player.load(value);
    await player.play();
    await advance(1);
    expect(() => player.hold()).not.toThrow();
    await advance(11);
    expect(state).toMatchObject({ status: 'filler', holding: true, trackIndex: 0, error: null });
    if (sound === 'recording') expect(MockContext.latest.sources.find(source => source.loop && source.buffer)?.buffer?.duration).toBe(3);
    player.hold();
    await player.continue();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, error: null });
  });

  it('warm-checks a later custom codec before readiness without retaining a library of decoded loops', async () => {
    const value = routine();
    value.tracks[1].after = { mode: 'custom', filler: privateFiller('invalid-later') };
    recording.blob.mockResolvedValue(new Blob([new Uint8Array([8])]));
    await expect(player.load(value)).rejects.toThrow('audio_duration_mismatch');
    await expect(player.play()).rejects.toThrow('routine_not_ready');
  });

  it('accounts every overlapping song once, bounds rapid Next and resumes progress after outgoing voices retire', async () => {
    storage.durations = [240, 241, 242, 243];
    const reservations: number[] = [];
    vi.stubGlobal('OfflineAudioContext', class {
      async decodeAudioData(bytes: ArrayBuffer) {
        reservations.push(runtimePcmBytes());
        const duration = new Uint8Array(bytes)[0];
        storage.decoded.push(duration);
        return { duration, length: duration * 44100, numberOfChannels: 2 };
      }
    });
    await player.load(routine());
    await player.play();
    await advance(239);
    await player.next();
    await advance(239.2);
    const live = MockContext.latest.sources.filter(source => source.buffer);
    const unique = new Set(live.map(source => source.buffer!));
    const audibleBytes = [...unique].reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0);
    expect(unique.size).toBe(3);
    expect(runtimePcmBytes()).toBeGreaterThanOrEqual(audibleBytes);
    expect(runtimePcmBytes()).toBeLessThan(audibleBytes + 1024 * 1024);
    const started = MockContext.latest.sources.length;
    await expect(player.next()).rejects.toThrow('audio_decoder_busy');
    expect(state).toMatchObject({ status: 'playing', trackIndex: 2 });
    expect(MockContext.latest.sources).toHaveLength(started);
    expect(live.every(source => source.buffer !== null)).toBe(true);
    expect(storage.decoded).not.toContain(243);
    await advance(242);
    await player.next();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 3, error: null });
    expect(reservations.length).toBe(4);
    expect(Math.max(...reservations, runtimePcmBytes())).toBeLessThanOrEqual(MAX_RUNTIME_PCM_BYTES);
  });

  it('reserves pending Next with both outgoing PCM buffers retained through timeout and Stop', async () => {
    storage.durations = [240, 241, 242];
    let finish!: (buffer: AudioBuffer) => void;
    const decode = vi.fn(async (bytes: ArrayBuffer) => {
      const duration = new Uint8Array(bytes)[0];
      return { duration, length: duration * 44100, numberOfChannels: 2 } as AudioBuffer;
    });
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
    await player.load(routine());
    await player.play();
    await advance(239);
    decode.mockImplementationOnce(() => new Promise<AudioBuffer>(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    const pending = player.next();
    const rejection = expect(pending).rejects.toThrow('audio_decode_timeout');
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3));
    const outgoing = MockContext.latest.sources.filter(source => source.buffer && !source.loop);
    expect(outgoing).toHaveLength(2);
    const audible = outgoing.reduce((sum, source) => sum + source.buffer!.length * source.buffer!.numberOfChannels * 4, 0);
    expect(runtimePcmBytes()).toBeGreaterThanOrEqual(audible + estimateRuntimePcm(242));
    expect(runtimePcmBytes()).toBeLessThanOrEqual(MAX_RUNTIME_PCM_BYTES);
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, error: 'audio_decode_timeout' });
    expect(outgoing.every(source => source.buffer !== null)).toBe(true);
    player.stop();
    await expect(player.load(routine())).rejects.toThrow('audio_decoder_busy');
    expect(runtimePcmBytes()).toBe(estimateRuntimePcm(242));
    const starts = MockContext.latest.sources.length;
    finish({ duration: 242, length: 242 * 44100, numberOfChannels: 2 } as AudioBuffer);
    await vi.waitFor(() => expect(runtimePcmBytes()).toBe(0));
    expect(MockContext.latest.sources).toHaveLength(starts);
    await player.load(routine());
    await player.play();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 0, error: null });
  });

  it('defers a third large PCM allocation, preserves Hold on a rejected Next, and preloads after retirement', async () => {
    storage.durations = [255, 254, 253];
    recording.blob.mockResolvedValue(new Blob([new Uint8Array([255])]));
    const reservations: number[] = [];
    vi.stubGlobal('OfflineAudioContext', class {
      async decodeAudioData(bytes: ArrayBuffer) {
        reservations.push(runtimePcmBytes());
        const duration = new Uint8Array(bytes)[0];
        storage.decoded.push(duration);
        return { duration, length: duration * 44100, numberOfChannels: 2 };
      }
    });
    const value = routine();
    value.filler = privateFiller('long-default', 255);
    await player.load(value);
    await player.play();
    await advance(1);
    const current = MockContext.latest.sources[0];
    await expect(player.next()).rejects.toThrow('audio_memory_limit');
    expect(state).toMatchObject({ status: 'playing', trackIndex: 0, error: 'audio_memory_limit' });
    expect(current.disconnect).not.toHaveBeenCalled();
    expect(storage.decoded).toEqual([255, 255]);
    expect(() => player.hold()).not.toThrow();
    await advance(253);
    expect(state).toMatchObject({ status: 'filler', holding: true });
    await advance(255);
    await player.continue();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, error: null });
    expect(storage.decoded).toContain(254);
    expect(Math.max(...reservations, runtimePcmBytes())).toBeLessThanOrEqual(MAX_RUNTIME_PCM_BYTES);
  });

  it.each([false, true])('native decode survives Stop as a guarded reservation until late settlement (timeout=%s)', async timeout => {
    vi.useFakeTimers();
    let finish!: (buffer: AudioBuffer) => void;
    const decode = vi.fn().mockReturnValueOnce(new Promise<AudioBuffer>(resolve => { finish = resolve; }))
      .mockImplementation(async (bytes: ArrayBuffer) => {
        const duration = new Uint8Array(bytes)[0];
        return { duration, length: duration * 44100, numberOfChannels: 1 };
      });
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
    const loading = player.load(routine());
    const outcome = loading.catch(error => error as Error);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(runtimePcmBytes()).toBe(estimateRuntimePcm(12));
    if (timeout) {
      await vi.advanceTimersByTimeAsync(30000);
      expect((await outcome as Error).message).toBe('audio_decode_timeout');
    }
    player.stop();
    await expect(player.load(routine())).rejects.toThrow('audio_decoder_busy');
    expect(decode).toHaveBeenCalledOnce();
    expect(runtimePcmBytes()).toBe(estimateRuntimePcm(12));
    finish({ duration: 12, length: 12 * 44100, numberOfChannels: 1 } as AudioBuffer);
    await outcome;
    await vi.waitFor(() => expect(runtimePcmBytes()).toBe(0));
    await player.load(routine());
    await player.play();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 0, error: null });
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it('per-gap custom hold uses its own gain, sound and handoff fade, including Continue', async () => {
    const value = routine();
    value.tracks[0].after = { mode: 'custom', crossfade: 1, filler: { mode: 'hold', seconds: 0, sound: 'bright', bpm: 80, gain: 0.3 } };
    await player.load(value);
    await player.play();
    await advance(11);
    expect(state).toMatchObject({ status: 'filler', holding: true, trackIndex: 0 });
    const filler = MockContext.latest.sources.find(source => source.loop)!;
    const envelope = filler.connect.mock.calls[0][0] as MockGain;
    const level = envelope.connect.mock.calls[0][0] as MockGain;
    expect(level.gain.setValueAtTime.mock.calls[0][0]).toBe(0.3);
    player.hold();
    await player.continue();
    expect(state.trackIndex).toBe(1);
    expect(filler.disconnect).not.toHaveBeenCalled();
    expect(filler.stop).toHaveBeenLastCalledWith(12);
  });

  it('class announcement handoff keeps outgoing PCM on its voice and reserves two upcoming filler slots', async () => {
    const value = routine();
    value.tracks[0].after = { mode: 'custom', filler: { mode: 'timed', sound: 'bright', bpm: 80, seconds: 3 } };
    value.tracks[1].after = { mode: 'custom', filler: { mode: 'timed', sound: 'drums', bpm: 80, seconds: 3 } };
    const audio: ClassAudio = { crossfade: 2, before: { mode: 'hold', sound: 'soft', bpm: 80, seconds: 0 } };
    await player.load(value, audio);
    expect(recording.requested.map(filler => filler.sound)).toEqual(['soft']);
    await player.play();
    await advance(3);
    await player.advance!();
    expect(recording.requested.map(filler => filler.sound)).toEqual(['soft', 'bright', 'drums']);
    await advance(6);
    expect(recording.requested.map(filler => filler.sound)).toEqual(['soft', 'bright', 'drums']);
  });

  it('uses a per-entry none override before inheriting the next gap', async () => {
    const value = routine();
    value.filler.mode = 'hold';
    value.tracks[0].after = { mode: 'none' };
    await player.load(value);
    await player.play();
    await advance(10);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1 });
    await advance(18);
    expect(state).toMatchObject({ status: 'filler', trackIndex: 1, holding: true });
  });

  it.each([undefined, 0, 0.5, 1, 1.5])('preserves stored track gain %s through seek, resume and incoming overlap', async gain => {
    const value = routine();
    value.tracks[0].gain = gain;
    value.tracks[1].gain = 0.75;
    await player.load(value);
    await player.play();
    const audio = MockContext.latest;
    const original = audio.sources[0].buffer;
    const check = (source: MockSource, expected: number) => {
      const envelope = source.connect.mock.calls[0][0] as MockGain;
      const level = envelope.connect.mock.calls[0][0] as MockGain;
      expect(level.gain.setValueAtTime.mock.calls[0][0]).toBe(expected);
      expect(level.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
      expect(level.connect).toHaveBeenCalledWith(audio.gains[0]);
    };
    check(audio.sources[0], gain ?? 1);
    await player.seek(5);
    check(audio.sources.findLast(source => source.buffer?.duration === 12)!, gain ?? 1);
    player.pause();
    value.tracks[0].gain = 1.25;
    await player.play();
    const resumed = audio.sources.findLast(source => source.buffer?.duration === 12)!;
    check(resumed, gain ?? 1);
    expect(resumed.buffer).toBe(original);
    await advance(5);
    check(audio.sources.findLast(source => source.buffer?.duration === 10)!, 0.75);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1 });
    expect(storage.decoded).toEqual([12, 10]);
  });

  it('waits for recorded filler preparation and loops its native buffer without using saved BPM', async () => {
    const value = routine();
    value.filler = { mode: 'hold', sound: 'lofi', seconds: 6, bpm: 180 };
    const buffer = { duration: 16, length: 352800, numberOfChannels: 1, sampleRate: 22050 } as AudioBuffer;
    let resolve!: (buffer: AudioBuffer) => void;
    recording.get.mockReturnValueOnce(new Promise<AudioBuffer>(accept => { resolve = accept; }));
    const loading = player.load(value);
    await vi.waitFor(() => expect(recording.get).toHaveBeenCalledOnce());
    await expect(player.play()).rejects.toThrow('routine_not_ready');
    resolve(buffer);
    await loading;
    await player.play();
    await advance(10);
    const voice = MockContext.latest.sources.find(source => source.loop)!;
    expect(voice.buffer).toBe(buffer);
    expect(voice.playbackRate.value).toBe(1);
    expect(voice.playbackRate.setValueAtTime).not.toHaveBeenCalled();
    expect(state).toMatchObject({ status: 'filler', holding: true });
    await player.continue();
    expect(state.trackIndex).toBe(1);
  });

  it.each([undefined, 0, 0.5, 1, 1.5])('retains independent filler gain %s through hold, Continue, pause and volume/duck changes', async gain => {
    const value = routine();
    value.tracks[0].gain = 0.4;
    value.tracks[1].gain = 1.5;
    value.filler = { ...value.filler, mode: 'timed', seconds: 6, gain };
    await player.load(value);
    await player.play();
    await advance(11);
    const audio = MockContext.latest;
    const filler = audio.sources.find(source => source.loop)!;
    const fillerBuffer = filler.buffer;
    const levelOf = (source: MockSource) => {
      const envelope = source.connect.mock.calls[0][0] as MockGain;
      return envelope.connect.mock.calls[0][0] as MockGain;
    };
    const check = () => {
      for (const source of audio.sources.filter(source => source.buffer)) {
        const level = levelOf(source);
        expect(level.gain.setValueAtTime).toHaveBeenCalledOnce();
        expect(level.gain.setValueAtTime.mock.calls[0][0]).toBe(
          source.loop ? gain ?? 1 : source.buffer?.duration === 12 ? 0.4 : 1.5,
        );
        expect(level.gain.cancelScheduledValues).not.toHaveBeenCalled();
        expect(level.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
        expect(level.connect).toHaveBeenCalledWith(audio.gains[0]);
      }
    };
    check();
    player.setVolume(0.6);
    player.setDucked(true);
    expect(audio.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.15, 11, 0.015);
    player.hold();
    check();
    await player.continue();
    check();
    expect(filler.buffer).toBe(fillerBuffer);
    expect(filler.disconnect).not.toHaveBeenCalled();
    player.pause();
    expect(levelOf(filler).disconnect).toHaveBeenCalledOnce();
    await player.play();
    check();
    const resumedFiller = audio.sources.findLast(source => source.loop && source.buffer)!;
    expect(resumedFiller.buffer).toBe(fillerBuffer);
    player.setDucked(false);
    expect(audio.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.6, 11, 0.015);
    check();
  });

  it.each([0, 0.5, 1.5])('uses the private local recording with gain %s through hold, removal, pause and Continue', async gain => {
    const bytes = new Uint8Array(64);
    bytes[0] = 16;
    const blob = new Blob([bytes], { type: 'audio/wav' });
    const custom: FillerRecording = { id: crypto.randomUUID(), name: 'Custom rehearsal loop', duration: 16,
      asset: { id: crypto.randomUUID(), sha256: '1'.repeat(64), bytes: blob.size, contentType: blob.type } };
    recording.blob.mockResolvedValue(blob);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const value = routine();
    value.filler = { mode: 'hold', seconds: 6, bpm: 220, sound: 'recording', recording: custom, gain };
    await player.load(value);
    const lookups = recording.blob.mock.calls.length;
    recording.blob.mockResolvedValue(undefined);
    await player.play();
    await advance(10);
    const audio = MockContext.latest;
    const source = audio.sources.find(source => source.loop)!;
    const buffer = source.buffer;
    expect(buffer).toMatchObject({ duration: 16, numberOfChannels: 1 });
    const check = (voice: MockSource) => {
      expect(voice.buffer).toBe(buffer);
      expect(voice.playbackRate.value).toBe(1);
      expect(voice.playbackRate.setValueAtTime).not.toHaveBeenCalled();
      const envelope = voice.connect.mock.calls[0][0] as MockGain;
      const level = envelope.connect.mock.calls[0][0] as MockGain;
      expect(level.gain.setValueAtTime.mock.calls[0][0]).toBe(gain);
    };
    check(source);
    player.hold();
    player.pause();
    await player.play();
    check(audio.sources.findLast(source => source.loop && source.buffer)!);
    await player.continue();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1 });
    expect(recording.blob).toHaveBeenCalledTimes(lookups);
    expect(recording.get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports the missing custom filler name/key before decoding songs and permits disabled playback without fallback', async () => {
    const value = routine();
    value.filler = { ...value.filler, mode: 'hold', sound: 'recording', recording: {
      id: 'custom', name: 'Unavailable loop', duration: 2,
      asset: { id: 'private-loop', sha256: '1'.repeat(64), bytes: 64, contentType: 'audio/wav' },
    } };
    storage.ready = false;
    storage.readinessMissing = ['filler-private-loop'];
    await expect(player.load(value)).rejects.toThrow('Unavailable loop (filler-private-loop)');
    expect(storage.decoded).toEqual([]);
    await expect(player.play()).rejects.toThrow('routine_not_ready');
    storage.ready = true;
    value.filler.mode = 'none';
    await player.load(value);
    await player.play();
    expect(recording.blob).not.toHaveBeenCalled();
    expect(() => player.hold()).toThrow('Unavailable loop (filler-private-loop)');
    expect(state.status).toBe('playing');
    expect(MockContext.latest.sources.some(source => source.loop)).toBe(false);
  });

  it.each([NaN, Infinity, -0.1, 1.51])('rejects invalid stored gain %s when preparing either source kind', async gain => {
    const value = routine();
    value.tracks[0].gain = gain;
    await expect(player.load(value)).rejects.toThrow('invalid_routine');
    delete value.tracks[0].gain;
    value.filler.gain = gain;
    await expect(player.load(value)).rejects.toThrow('invalid_routine');
    expect(storage.decoded).toEqual([]);
  });

  it.each(['filler_unavailable', 'filler_integrity_failed'])('blocks readiness for %s and supports retry', async error => {
    const value = routine();
    value.filler.sound = 'lofi';
    recording.get.mockRejectedValueOnce(new Error(error));
    await expect(player.load(value)).rejects.toThrow(error);
    expect(state).toMatchObject({ status: 'error', error });
    await expect(player.play()).rejects.toThrow('routine_not_ready');
    await player.load(value);
    await player.play();
    expect(state.status).toBe('playing');
  });

  it('sounds enabled counted cues once without changing muted or disabled cues', async () => {
    const value = routine();
    value.beepEvery = value.beepRemaining = 0;
    value.tracks[0].cues = [
      { id: 'count', anchor: { kind: 'count', count: 5 }, note: 'Pulse', beep: true },
      { id: 'silent', anchor: { kind: 'timestamp', seconds: 4 }, note: 'Silent' },
    ];
    await player.load(value);
    await player.play();
    await advance(2.9);
    expect(MockContext.latest.oscillators).toHaveLength(1);
    expect(MockContext.latest.oscillators[0].start).toHaveBeenCalledWith(3);
    await advance(3.1);
    player.pause();
    await player.play();
    await advance(4.1);
    expect(MockContext.latest.oscillators).toHaveLength(1);
  });

  it('seeks in source seconds without rebuilding queued holds or restarting at zero', async () => {
    await player.load(routine());
    await player.play();
    await advance(3);
    player.hold();
    const audio = MockContext.latest;
    const oldSources = [...audio.sources];
    await player.seek(7);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 0, elapsed: 7, classElapsed: 7, holding: true });
    expect(oldSources.every(source => source.buffer === null)).toBe(true);
    expect(audio.sources.findLast(source => source.buffer && !source.loop)?.start).toHaveBeenCalledWith(3, 7);
    expect(storage.decoded).toEqual([12, 10]);
    await advance(6);
    expect(state).toMatchObject({ status: 'filler', holding: true, trackIndex: 0 });
    const sourceCount = audio.sources.length;
    const fillerState = { ...state };
    await player.seek(2);
    expect(state).toEqual(fillerState);
    expect(audio.sources).toHaveLength(sourceCount);
  });

  it('clamps seek before incoming ownership and uses the current song source offset in a crossfade', async () => {
    await player.load(routine());
    await player.play();
    const audio = MockContext.latest;
    await player.seek(12);
    expect(state.trackIndex).toBe(0);
    expect(state.elapsed).toBeLessThan(10);
    expect(state.elapsed).toBeGreaterThan(9.9);
    await advance(0.02);
    expect(state.trackIndex).toBe(1);
    await player.seek(4);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 4, classElapsed: 14 });
    expect(audio.sources.findLast(source => source.buffer?.duration === 10)?.start).toHaveBeenCalledWith(expect.closeTo(0.02, 6), 4);
    await player.seek(-20);
    expect(state).toMatchObject({ trackIndex: 1, elapsed: 0, classElapsed: 10 });
    await player.seek(500);
    expect(state.trackIndex).toBe(1);
    expect(state.elapsed).toBeLessThan(8);
    expect(state.elapsed).toBeGreaterThan(7.9);
  });

  it('keeps a paused seek silent and resumes exactly at its source position', async () => {
    await player.load(routine());
    await player.play();
    await advance(4);
    player.pause();
    const audio = MockContext.latest;
    const sourceCount = audio.sources.length;
    await player.seek(8);
    expect(state).toMatchObject({ status: 'paused', elapsed: 8, classElapsed: 8 });
    expect(audio.sources).toHaveLength(sourceCount);
    audio.currentTime = 30;
    await player.play();
    expect(audio.sources.findLast(source => source.buffer?.duration === 12)?.start).toHaveBeenCalledWith(30, 8);
    const before = { ...state };
    await expect(player.seek(NaN)).rejects.toThrow('invalid_seek');
    expect(state).toEqual(before);
  });

  it('skips past alarms on forward seek and rearms an exact target only on a backward pass', async () => {
    const value = routine();
    value.beepEvery = value.beepRemaining = 0;
    value.tracks[0].cues = [1, 3, 5, 7].map(seconds => ({
      id: String(seconds), anchor: { kind: 'timestamp', seconds }, note: String(seconds), beep: true,
    }));
    await player.load(value);
    await player.play();
    await player.seek(5);
    const audio = MockContext.latest;
    expect(audio.oscillators).toHaveLength(1);
    expect(audio.oscillators[0].start).toHaveBeenCalledWith(0);
    await player.seek(5);
    player.pause();
    await player.play();
    expect(audio.oscillators).toHaveLength(1);
    await advance(1.9);
    expect(audio.oscillators).toHaveLength(2);
    await advance(2.1);
    await player.seek(5);
    expect(audio.oscillators).toHaveLength(3);
    expect(audio.oscillators[2].start).toHaveBeenCalledWith(2.1);
    await advance(4);
    expect(audio.oscillators).toHaveLength(4);
    expect(audio.oscillators[3].start.mock.calls[0][0]).toBeCloseTo(4.1);
  });

  it('does not let an unrelated pending decode delay seeking or a stale Next override its target', async () => {
    await player.load(routine());
    await player.play();
    const third = deferTrack('2');
    await advance(12);
    const moving = player.next();
    await player.seek(4);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 4, classElapsed: 14 });
    const sourceCount = MockContext.latest.sources.length;
    third.resolve();
    await moving;
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 4 });
    expect(MockContext.latest.sources.slice(sourceCount).every(source => source.start.mock.calls[0][0]! > 12)).toBe(true);
  });

  it.each(['pause', 'stop', 'seek', 'load', 'dispose'] as const)('invalidates a pending backward decode on %s', async command => {
    const value = routine();
    await player.load(value);
    await player.play();
    await advance(14);
    const first = deferTrack('0');
    const seeking = player.seek(0);
    expect(state).toMatchObject({ trackIndex: 1, elapsed: 0, classElapsed: 10 });
    await vi.waitFor(() => expect(storage.requested.filter(id => id === '0')).toHaveLength(2));
    if (command === 'seek') await player.seek(4);
    else if (command === 'load') {
      const replacement = routine();
      replacement.tracks = replacement.tracks.slice(1);
      const loading = player.load(replacement);
      first.resolve();
      await loading;
    } else player[command]();
    const snapshot = { ...state };
    const audio = MockContext.latest;
    const sourceCount = audio.sources.length;
    first.resolve();
    await seeking;
    await advance(audio.currentTime);
    expect(state).toEqual(snapshot);
    if (command === 'seek') {
      expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 4 });
      expect(audio.sources.slice(sourceCount).every(source => source.start.mock.calls[0][0]! > audio.currentTime)).toBe(true);
      expect(audio.sources.some(source => source.buffer?.duration === 12)).toBe(false);
    } else {
      expect(audio.sources).toHaveLength(sourceCount);
      expect(audio.sources.every(source => source.buffer === null)).toBe(true);
    }
  });

  it('restores a retired overlap at the owning song target, without starting the prior song from zero', async () => {
    await player.load(routine());
    await player.play();
    await advance(14);
    await player.seek(0);
    const audio = MockContext.latest;
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 0, classElapsed: 10 });
    expect(audio.sources.findLast(source => source.buffer?.duration === 12)?.start).toHaveBeenCalledWith(14, 10);
    expect(audio.sources.findLast(source => source.buffer?.duration === 10)?.start).toHaveBeenCalledWith(14, 0);
    await advance(15);
    expect(state).toMatchObject({ trackIndex: 1, elapsed: 1, classElapsed: 11 });
  });

  it('keeps cue edits silent while paused and updates the next move behind a queued hold', async () => {
    await player.load(routine());
    await player.play();
    await advance(3);
    player.hold();
    player.pause();
    const audio = MockContext.latest;
    const sourceCount = audio.sources.length;
    const alarmCount = audio.oscillators.length;
    player.updateCues(0, []);
    player.updateCues(1, [{ id: 'next', anchor: { kind: 'interval', seconds: 2 }, note: 'Changed next', beep: true }]);
    expect(state).toMatchObject({ status: 'paused', holding: true, currentCue: '', nextCue: 'Changed next', nextCueIn: null });
    expect(audio.sources).toHaveLength(sourceCount);
    expect(audio.oscillators).toHaveLength(alarmCount);
    await player.play();
    await advance(10);
    expect(state).toMatchObject({ status: 'filler', holding: true, nextCue: 'Changed next', nextCueIn: null });
  });

  it('sounds a slightly overdue zero-time handoff once when the audio render quantum advances', async () => {
    const value = routine();
    value.beepEvery = value.beepRemaining = 0;
    value.tracks[1].cues[0].beep = true;
    await player.load(value);
    await player.play();
    await advance(3);
    const audio = MockContext.latest;
    audio.gainQuantum = 128 / 44100;
    await player.next();
    audio.gainQuantum = 0;
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, currentCue: 'Song 1' });
    expect(audio.oscillators).toHaveLength(1);
    const when = audio.oscillators[0].start.mock.calls[0][0]!;
    expect(when).toBeGreaterThanOrEqual(3);
    expect(when).toBeLessThan(3.01);
    player.pause();
    await player.play();
    await player.seek(state.elapsed);
    expect(audio.oscillators).toHaveLength(1);
  });

  it('bounds zero-time catch-up and suppresses an outgoing boundary cue after ownership changes', async () => {
    const value = routine();
    value.beepEvery = value.beepRemaining = 0;
    value.tracks[0].cues.push({ id: 'outgoing', anchor: { kind: 'timestamp', seconds: 10 }, note: 'Old', beep: true });
    value.tracks[1].cues[0].beep = true;
    await player.load(value);
    await player.play();
    await advance(10.005);
    expect(MockContext.latest.oscillators).toHaveLength(1);
    expect(MockContext.latest.oscillators[0].start).toHaveBeenCalledWith(10.005);
    await advance(10.006);
    expect(MockContext.latest.oscillators).toHaveLength(1);
    player.stop();
    expect(state).toMatchObject({ trackIndex: 1, elapsed: 0, status: 'idle' });
    await player.previous!();
    expect(state).toMatchObject({ trackIndex: 0, elapsed: 0, status: 'idle' });
    await player.play();
    await advance(20.03);
    expect(MockContext.latest.oscillators).toHaveLength(1);
  });

  it('does not miss an exact seek-target cue when source scheduling advances the clock', async () => {
    const value = routine();
    value.beepEvery = value.beepRemaining = 0;
    value.tracks[0].cues = [{ id: 'cue', anchor: { kind: 'timestamp', seconds: 5 }, note: 'Move', beep: true }];
    await player.load(value);
    await player.play();
    const audio = MockContext.latest;
    audio.gainQuantum = 128 / 44100;
    await player.seek(5);
    audio.gainQuantum = 0;
    expect(audio.oscillators).toHaveLength(1);
    expect(audio.oscillators[0].start.mock.calls[0][0]).toBeLessThan(0.01);
    player.pause();
    await player.play();
    expect(audio.oscillators).toHaveLength(1);
  });

  it('updates detached cues in place, preserving running sources and projecting current/next immediately', async () => {
    const value = routine();
    value.beepEvery = value.beepRemaining = 0;
    await player.load(value);
    await player.play();
    await advance(2);
    const audio = MockContext.latest;
    const sources = [...audio.sources];
    const cues: Cue[] = [
      { id: 'past', anchor: { kind: 'interval', seconds: 1 }, note: 'Current', beep: true },
      { id: 'count', anchor: { kind: 'count', count: 5 }, note: 'Next', beep: true },
    ];
    player.updateCues(0, cues);
    expect(state).toMatchObject({ status: 'playing', elapsed: 2, duration: 12, currentCue: 'Current', nextCue: 'Next', nextCueIn: 1 });
    expect(value.tracks[0].cues[0].note).toBe('Song 0');
    cues[1].note = 'External mutation';
    cues[1].anchor = { kind: 'timestamp', seconds: 9 };
    cues[1].beep = false;
    expect(audio.oscillators).toHaveLength(0);
    expect(audio.sources).toEqual(sources);
    expect(sources.every(source => source.disconnect.mock.calls.length === 0)).toBe(true);
    await advance(2.9);
    expect(audio.oscillators).toHaveLength(1);
    expect(audio.oscillators[0].start).toHaveBeenCalledWith(3);
    await advance(3);
    expect(state.currentCue).toBe('Next');
    player.updateCues(1, [{ id: 'later', anchor: { kind: 'timestamp', seconds: 2 }, note: 'Incoming' }]);
    expect(state).toMatchObject({ nextCue: 'Incoming', nextCueIn: 9, nextCueTrackTitle: value.tracks[1].title });
  });

  it('replaces pending cue alarms without replaying current/past edits or disturbing sounding beeps', async () => {
    const value = routine();
    value.beepEvery = value.beepRemaining = 0;
    value.tracks[0].cues = [{ id: 'cue', anchor: { kind: 'timestamp', seconds: 3 }, note: 'Move', beep: true }];
    await player.load(value);
    await player.play();
    await advance(2.9);
    const audio = MockContext.latest;
    const canceled = audio.oscillators[0];
    player.updateCues(0, [{ ...value.tracks[0].cues[0], anchor: { kind: 'timestamp', seconds: 4 } }]);
    expect(canceled.stop).toHaveBeenLastCalledWith();
    await advance(3.9);
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators[1].start).toHaveBeenCalledWith(4);
    await advance(4);
    player.updateCues(0, [
      { id: 'past', anchor: { kind: 'timestamp', seconds: 1 }, note: 'Past', beep: true },
      { id: 'now', anchor: { kind: 'interval', seconds: 4 }, note: 'Now', beep: true },
      { id: 'off', anchor: { kind: 'timestamp', seconds: 5 }, note: 'Silent', beep: false },
    ]);
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators[1].disconnect).not.toHaveBeenCalled();
    await advance(4.9);
    expect(audio.oscillators).toHaveLength(2);
    player.pause();
    await player.play();
    expect(audio.oscillators).toHaveLength(2);
  });

  it('rejects locked snapshots and malformed cue edits atomically', async () => {
    const value = routine();
    value.locked = true;
    await player.load(value);
    value.locked = false;
    expect(() => player.updateCues(0, [])).toThrow('routine_locked');
    await player.load(value);
    const before = { ...state };
    for (const cues of [null, {}, [null], [{ id: 'bad', note: 'Bad', anchor: { kind: 'timestamp', seconds: 12 } }],
      [{ id: 'bad', note: 'Bad', anchor: { kind: 'count', count: '5' } }],
      [{ id: 'bad', note: 'Bad', anchor: { kind: 'timestamp', seconds: 1 }, beep: 'true' }]]) {
      expect(() => player.updateCues(0, cues as Cue[])).toThrow('invalid_cues');
      expect(state).toEqual(before);
    }
    for (const index of [-1, 0.5, 3, NaN]) expect(() => player.updateCues(index, [])).toThrow('invalid_track');
    expect(state).toEqual(before);
  });

  it('verifies every asset before readiness and initially decodes only current/next', async () => {
    storage.ready = false;
    await expect(player.load(routine())).rejects.toThrow('missing_audio');
    expect(storage.decoded).toEqual([]);
    expect(state.status).toBe('error');
    storage.ready = true;
    await player.load(routine());
    expect(storage.decoded).toEqual([12, 10]);
    expect(state.status).toBe('idle');
  });

  it('hands cues to incoming audio at fade start and retires outgoing PCM before decoding third', async () => {
    const value = routine();
    await player.load(value);
    value.tracks[0].cues[0].note = 'Do not mutate the loaded snapshot';
    await player.play();
    expect(state.currentCue).toBe('Song 0');
    expect(MockContext.latest.sources[1].start).toHaveBeenCalledWith(10, 0);
    await advance(10);
    expect(state.trackIndex).toBe(1);
    expect(state.elapsed).toBe(0);
    expect(state.currentCue).toBe('Song 1');
    expect(storage.decoded).toEqual([12, 10]);
    await advance(12);
    await vi.waitFor(() => expect(storage.decoded).toEqual([12, 10, 14]));
    expect(MockContext.latest.sources[0].buffer).toBeNull();
    expect(MockContext.latest.sources.filter(source => source.buffer && !source.loop)).toHaveLength(2);
  });

  it('freezes audio-time state on pause and recreates canceled sources only on manual play', async () => {
    await player.load(routine());
    await player.play();
    await advance(5);
    player.pause();
    const oldSources = [...MockContext.latest.sources];
    expect(state.status).toBe('paused');
    await advance(100);
    expect(state.elapsed).toBe(5);
    expect(state.classElapsed).toBe(5);
    expect(oldSources.every(source => source.buffer === null)).toBe(true);
    await player.play();
    await advance(101);
    expect(state.elapsed).toBe(6);
    expect(state.classElapsed).toBe(6);
    player.stop();
    expect(state.status).toBe('idle');
    expect(state.elapsed).toBe(0);
    expect(state.classElapsed).toBe(0);
  });

  it('cancels scheduled beeps on pause and suppresses outgoing alarms after cue handoff', async () => {
    await player.load(routine());
    await player.play();
    await advance(1.9);
    const beep = MockContext.latest.oscillators[0];
    expect(beep.start).toHaveBeenCalledWith(2);
    player.pause();
    expect(beep.stop).toHaveBeenLastCalledWith();
    expect(beep.disconnect).toHaveBeenCalled();
    await player.play();
    await advance(9.9);
    expect(MockContext.latest.oscillators.filter(item => item.start.mock.calls[0]?.[0] === 10)).toHaveLength(0);
  });

  it.each(['pause', 'hold'] as const)('does not repeat a fired beep at an exact %s boundary', async command => {
    await player.load(routine());
    await player.play();
    await advance(1.9);
    const audio = MockContext.latest;
    expect(audio.oscillators).toHaveLength(1);
    audio.currentTime = 2;
    player[command]();
    if (command === 'pause') await player.play();
    expect(audio.oscillators).toHaveLength(1);
    await advance(2);
    expect(audio.oscillators).toHaveLength(1);
    await advance(3.9);
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators[1].start).toHaveBeenCalledWith(4);
  });

  it('reschedules a canceled future beep after pause without counting it as fired', async () => {
    await player.load(routine());
    await player.play();
    await advance(1.9);
    player.pause();
    const audio = MockContext.latest;
    audio.currentTime = 20;
    await player.play();
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators[1].start.mock.calls[0][0]).toBeCloseTo(20.1);
    await advance(20.1);
    expect(audio.oscillators).toHaveLength(2);
  });

  it.each(['stop', 'load', 'finished'] as const)('clears fired identities for a new playback pass after %s', async reset => {
    const value = routine();
    value.tracks = value.tracks.slice(0, 1);
    await player.load(value);
    await player.play();
    await advance(2);
    const audio = MockContext.latest;
    expect(audio.oscillators).toHaveLength(1);
    if (reset === 'stop') player.stop();
    else if (reset === 'load') await player.load(value);
    else await advance(12);
    const started = audio.currentTime;
    await player.play();
    await advance(started + 2);
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators[1].start).toHaveBeenCalledWith(started + 2);
  });

  it('holds deterministic filler until Continue and then starts the next song', async () => {
    const value = routine();
    value.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
    await player.load(value);
    await player.play();
    expect(MockContext.latest.sources.find(source => source.loop)?.start).toHaveBeenCalledWith(10, 0);
    await advance(11);
    expect(state.status).toBe('filler');
    expect(state.fillerRemaining).toBe(3);
    expect(state.nextCueIn).toBe(3);
    player.hold();
    await advance(30);
    expect(state.status).toBe('filler');
    expect(state.holding).toBe(true);
    expect(state.fillerRemaining).toBeNull();
    expect(state.currentCue).toBe('');
    expect(state.classElapsed).toBe(30);
    await player.continue();
    expect(state.status).toBe('playing');
    expect(state.trackIndex).toBe(1);
    expect(state.currentCue).toBe('Song 1');
    const outgoing = MockContext.latest.sources.findLast(source => source.loop && source.buffer &&
      (source.start.mock.calls[0]?.[0] ?? Infinity) <= 30);
    expect(outgoing?.stop).toHaveBeenLastCalledWith(32);
  });

  it('inserts a hold after a song and keeps paused Next silent', async () => {
    await player.load(routine());
    await player.play();
    await advance(3);
    player.hold();
    await advance(10);
    expect(state.status).toBe('filler');
    expect(state.holding).toBe(true);
    player.pause();
    await player.next();
    expect(state.status).toBe('paused');
    expect(state.trackIndex).toBe(1);
    expect(MockContext.latest.sources.every(source => source.buffer === null)).toBe(true);
  });

  it('never automatically resumes after an audio interruption', async () => {
    await player.load(routine());
    await player.play();
    await advance(4);
    const audio = MockContext.latest;
    audio.state = 'suspended';
    audio.onstatechange?.();
    expect(state.status).toBe('paused');
    expect(state.error).toBe('audio_interrupted');
    const count = audio.sources.length;
    audio.state = 'running';
    audio.onstatechange?.();
    await advance(50);
    expect(audio.sources).toHaveLength(count);
    expect(state.elapsed).toBe(4);
    await player.play();
    expect(state.status).toBe('playing');
    expect(state.error).toBeNull();
  });

  it('requests Next resume synchronously and cancels asynchronous playback after Stop', async () => {
    await player.load(routine());
    await player.play();
    const audio = MockContext.latest;
    audio.resume.mockClear();
    const moving = player.next();
    expect(audio.resume).toHaveBeenCalledOnce();
    player.stop();
    await moving;
    expect(state.status).toBe('idle');
    expect(audio.sources.every(source => source.buffer === null)).toBe(true);
  });

  it('starts ready B without waiting for C and fades the original outgoing voice on the audio clock', async () => {
    await player.load(routine());
    await player.play();
    const third = deferTrack('2');
    const audio = MockContext.latest;
    const outgoing = audio.sources[0];
    const gain = outgoing.connect.mock.calls[0][0] as MockGain;
    await advance(3);
    await player.next();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 0, classElapsed: 3 });
    expect(outgoing.disconnect).not.toHaveBeenCalled();
    expect(outgoing.start).toHaveBeenCalledOnce();
    expect(outgoing.stop).toHaveBeenLastCalledWith(5);
    expect(gain.gain.cancelScheduledValues).toHaveBeenCalledWith(3);
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 3);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 5);
    expect(audio.sources.findLast(source => source.buffer && !source.loop)?.start).toHaveBeenCalledWith(3, 0);
    await advance(5);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, error: null });
    expect(storage.decoded).toEqual([12, 10]);
    third.resolve();
  });

  it('does not pause ready B when background C rejects, but stops at the required C boundary', async () => {
    await player.load(routine());
    await player.play();
    const third = deferTrack('2');
    await player.next();
    await advance(2);
    third.reject();
    await advance(3);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, error: null });
    await advance(8);
    expect(state).toMatchObject({ status: 'paused', trackIndex: 2, elapsed: 0, error: 'audio_not_prepared' });
  });

  it('preserves B while required C is pending and coalesces concurrent Next requests', async () => {
    await player.load(routine());
    await player.play();
    const third = deferTrack('2');
    await advance(12);
    const outgoing = MockContext.latest.sources[1];
    const moving = player.next();
    expect(player.next()).toBe(moving);
    await advance(13);
    expect(outgoing.disconnect).not.toHaveBeenCalled();
    expect(outgoing.stop).toHaveBeenLastCalledWith(20);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 3 });
    third.resolve();
    await moving;
    expect(state).toMatchObject({ status: 'playing', trackIndex: 2, elapsed: 0 });
    expect(outgoing.disconnect).not.toHaveBeenCalled();
    expect(outgoing.stop).toHaveBeenLastCalledWith(15);
    expect(MockContext.latest.sources.filter(source => source.buffer?.duration === 14)).toHaveLength(1);
  });

  it('keeps the owning song prepared when Next requests C during the A/B overlap', async () => {
    await player.load(routine());
    await player.play();
    await advance(10);
    const third = deferTrack('2');
    const moving = player.next();
    await advance(10.5);
    await advance(10.6);
    const pendingState = { ...state };
    const outgoing = MockContext.latest.sources[1];
    const disconnected = outgoing.disconnect.mock.calls.length;
    third.resolve();
    await moving;
    expect(pendingState).toMatchObject({ status: 'playing', trackIndex: 1, error: null });
    expect(disconnected).toBe(0);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 2, elapsed: 0 });
  });

  it('retains all three song buffers during an overlapping Next, then retires the outgoing pair', async () => {
    await player.load(routine());
    await player.play();
    await advance(11);
    const audio = MockContext.latest;
    const first = audio.sources[0];
    const second = audio.sources[1];
    await player.next();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 2, elapsed: 0, error: null });
    expect(first.buffer?.duration).toBe(12);
    expect(second.buffer?.duration).toBe(10);
    expect(first.stop).toHaveBeenLastCalledWith(12);
    expect(second.stop).toHaveBeenLastCalledWith(13);
    expect(storage.decoded).toEqual([12, 10, 14]);
    await advance(11.5);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 2, error: null });
    expect(first.disconnect).not.toHaveBeenCalled();
    expect(second.disconnect).not.toHaveBeenCalled();
    player.pause();
    audio.currentTime = 30;
    await player.play();
    expect(storage.decoded).toEqual([12, 10, 14]);
    expect(audio.sources.filter(source => source.buffer)).toHaveLength(3);
    await advance(31.5);
    expect(audio.sources.filter(source => source.buffer)).toHaveLength(1);
    expect(state).toMatchObject({ status: 'playing', trackIndex: 2, error: null });
  });

  it('keeps held filler running while its incoming song is pending', async () => {
    const value = routine();
    value.filler.mode = 'hold';
    await player.load(value);
    await player.play();
    const third = deferTrack('2');
    await player.next();
    await advance(12);
    const filler = MockContext.latest.sources.findLast(source => source.loop && source.buffer)!;
    const moving = player.continue();
    await advance(13);
    expect(state).toMatchObject({ status: 'filler', holding: true });
    expect(filler.disconnect).not.toHaveBeenCalled();
    expect(filler.stop).not.toHaveBeenCalled();
    third.resolve();
    await moving;
    expect(state).toMatchObject({ status: 'playing', trackIndex: 2 });
    expect(filler.stop).toHaveBeenLastCalledWith(15);
  });

  it.each(['stop', 'pause'] as const)('cancels a pending Next with %s without reviving audio', async command => {
    await player.load(routine());
    await player.play();
    const third = deferTrack('2');
    await advance(12);
    const moving = player.next();
    player[command]();
    const count = MockContext.latest.sources.length;
    third.resolve();
    await moving;
    expect(state.status).toBe(command === 'stop' ? 'idle' : 'paused');
    expect(MockContext.latest.sources).toHaveLength(count);
    expect(MockContext.latest.sources.every(source => source.buffer === null)).toBe(true);
  });

  it('prepares the next song behind a saved hold and finishes without restarting', async () => {
    const value = routine();
    value.filler.mode = 'hold';
    await player.load(value);
    expect(storage.decoded).toEqual([12, 10]);
    await player.play();
    await advance(100);
    expect(state.status).toBe('filler');
    expect(state.holding).toBe(true);
    await player.continue();
    expect(state.trackIndex).toBe(1);
    await player.next();
    expect(state.trackIndex).toBe(2);
    await advance(114);
    expect(state.status).toBe('finished');
    expect(state.classElapsed).toBe(114);
  });

  it('keeps independent music/duck/beep buses and disposes resources', async () => {
    await player.load({ ...routine(), beepVolume: 0.2 });
    await player.play();
    const beeps = MockContext.latest.gains[1].gain.setTargetAtTime;
    expect(beeps).toHaveBeenLastCalledWith(0.2, 0, 0.015);
    player.setVolume(0.6);
    player.setDucked(true);
    player.setBeepsMuted(true);
    const audio = MockContext.latest;
    expect(audio.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.15, 0, 0.015);
    expect(audio.gains[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.015);
    expect(state.ducked).toBe(true);
    expect(state.beepsMuted).toBe(true);
    const listener = vi.fn();
    const unsubscribe = player.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    player.setDucked(false);
    expect(listener).toHaveBeenCalledOnce();
    player.dispose();
    expect(audio.close).toHaveBeenCalled();
    await expect(player.play()).rejects.toThrow('player_disposed');
  });

  it('includes the first next-track cue offset in song and filler preview countdowns', async () => {
    const value = routine();
    value.tracks[1].cues[0].anchor = { kind: 'timestamp', seconds: 2 };
    await player.load(value);
    expect(state.nextCue).toBe('Song 1');
    expect(state.nextCueIn).toBe(12);
    value.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
    await player.load(value);
    expect(state.nextCueIn).toBe(16);
    await player.play();
    await advance(11);
    expect(state).toMatchObject({ status: 'filler', nextCue: 'Song 1', nextCueIn: 5, fillerRemaining: 3 });
    await advance(14);
    expect(state).toMatchObject({ status: 'playing', currentCue: '', nextCue: 'Song 1', nextCueIn: 2 });
  });

  it('searches beyond cue-less tracks and attributes the displayed move to its actual song', async () => {
    const value = routine();
    value.tracks[1].cues = [];
    value.tracks[2].title = 'Third song';
    await player.load(value);
    expect(state).toMatchObject({ nextCue: 'Song 2', nextCueIn: 18, nextCueTrackTitle: 'Third song' });
    value.filler.mode = 'hold';
    await player.load(value);
    expect(state).toMatchObject({ nextCue: 'Song 2', nextCueIn: null, nextCueTrackTitle: 'Third song' });
    await player.play();
    await advance(11);
    expect(state).toMatchObject({ status: 'filler', nextCue: 'Song 2', nextCueIn: null, nextCueTrackTitle: 'Third song' });
  });

  it('clears song attribution for a cue in the current song or no future cue', async () => {
    const value = routine();
    value.tracks[0].cues.push({ id: 'later', anchor: { kind: 'timestamp', seconds: 3 }, note: 'Later' });
    await player.load(value);
    expect(state).toMatchObject({ nextCue: 'Later', nextCueTrackTitle: null });
    value.tracks.forEach(item => { item.cues = []; });
    await player.load(value);
    expect(state).toMatchObject({ nextCue: '', nextCueIn: null, nextCueTrackTitle: null });
  });

  it('fires one coalesced warning and never replays it after pause at the exact boundary', async () => {
    const value = routine();
    value.beepEvery = 0;
    value.beepRemaining = 0;
    value.beepOnceRemaining = 5;
    await player.load(value);
    await player.play();
    await advance(6.9);
    const audio = MockContext.latest;
    expect(audio.oscillators).toHaveLength(1);
    expect(audio.oscillators[0].start).toHaveBeenCalledWith(7);
    audio.currentTime = 7;
    player.pause();
    await advance(40);
    expect(audio.oscillators).toHaveLength(1);
    await player.play();
    expect(audio.oscillators).toHaveLength(1);
  });

  it.each([false, true])('fades every audible voice on Continue during filler fade-in (hold=%s)', async hold => {
    const value = routine();
    value.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
    await player.load(value);
    await player.play();
    await advance(11);
    const audio = MockContext.latest;
    const song = audio.sources[0];
    const filler = audio.sources.find(source => source.loop)!;
    const songBuffer = song.buffer;
    const fillerBuffer = filler.buffer;
    if (hold) player.hold();
    await player.continue();
    expect(state).toMatchObject({ status: 'playing', trackIndex: 1, elapsed: 0 });
    for (const [source, buffer, finish] of [[song, songBuffer, 12], [filler, fillerBuffer, 13]] as const) {
      expect(source.buffer).toBe(buffer);
      expect(source.disconnect).not.toHaveBeenCalled();
      expect(source.start).toHaveBeenCalledOnce();
      expect(source.stop).toHaveBeenLastCalledWith(finish);
      const gain = source.connect.mock.calls[0][0] as MockGain;
      expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 11);
      expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, finish);
    }
    const incoming = audio.sources.findLast(source => source.buffer?.duration === 10)!;
    const gain = incoming.connect.mock.calls[0][0] as MockGain;
    expect(incoming.start).toHaveBeenCalledWith(11, 0);
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 11);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 13);
    await advance(12);
    expect(song.buffer).toBeNull();
    expect(filler.buffer).toBe(fillerBuffer);
    await advance(13);
    expect(filler.buffer).toBeNull();
    expect(incoming.buffer).not.toBeNull();
  });

  it('retains both voices when Hold arrives during the timed filler fade-in', async () => {
    const value = routine();
    value.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
    await player.load(value);
    await player.play();
    await advance(11);
    const audio = MockContext.latest;
    const song = audio.sources[0];
    const filler = audio.sources.find(source => source.loop)!;
    const gain = filler.connect.mock.calls[0][0] as MockGain;
    player.hold();
    expect(song.disconnect).not.toHaveBeenCalled();
    expect(filler.disconnect).not.toHaveBeenCalled();
    expect(filler.start).toHaveBeenCalledOnce();
    expect(filler.stop).not.toHaveBeenCalled();
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 11);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 12);
    await player.continue();
    expect(filler.disconnect).not.toHaveBeenCalled();
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 11);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 13);
    player.pause();
    audio.currentTime = 40;
    await player.play();
    const resumed = audio.sources.findLast(source => source.loop && source.buffer && source.start.mock.calls[0]?.[0] === 40)!;
    const resumedGain = resumed.connect.mock.calls[0][0] as MockGain;
    expect(resumedGain.gain.setValueAtTime).toHaveBeenCalledWith(0.5, 40);
    expect(resumedGain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 42);
    expect(resumed.stop).toHaveBeenLastCalledWith(42);
  });

  it('preserves the timed filler fade-out and incoming song when Hold is pressed after cue handoff', async () => {
    const value = routine();
    value.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
    await player.load(value);
    await player.play();
    await advance(15);
    const audio = MockContext.latest;
    const filler = audio.sources.find(source => source.loop)!;
    const incoming = audio.sources.find(source => source.buffer?.duration === 10)!;
    player.hold();
    expect(filler.disconnect).not.toHaveBeenCalled();
    expect(incoming.disconnect).not.toHaveBeenCalled();
    const gain = filler.connect.mock.calls[0][0] as MockGain;
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 15);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 16);
  });

  it.each([0, 0.001, 2])('ramps manual filler Continue from zero with crossfade %s', async crossfade => {
    const value = routine();
    value.crossfade = crossfade;
    value.filler.mode = 'hold';
    await player.load(value);
    await player.play();
    await advance(13);
    const audio = MockContext.latest;
    const filler = audio.sources.find(source => source.loop)!;
    await player.continue();
    expect(filler.disconnect).not.toHaveBeenCalled();
    expect(filler.start).toHaveBeenCalledOnce();
    expect(filler.stop).toHaveBeenLastCalledWith(13 + Math.max(0.01, crossfade));
    const incoming = audio.sources.findLast(source => !source.loop && source.buffer?.duration === 10)!;
    const gain = incoming.connect.mock.calls[0][0] as MockGain;
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 13);
    expect(gain.gain.linearRampToValueAtTime.mock.calls.find(([level]) => level === 1)?.[1])
      .toBeCloseTo(13 + Math.max(0.01, crossfade), 8);
  });

  it('keeps the scheduled timed filler handoff and resumes both sides at their actual fade levels', async () => {
    const value = routine();
    value.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
    await player.load(value);
    await player.play();
    const audio = MockContext.latest;
    const filler = audio.sources.find(source => source.loop)!;
    const incoming = audio.sources.find(source => source.buffer?.duration === 10)!;
    const gain = incoming.connect.mock.calls[0][0] as MockGain;
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 14);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 16);
    await advance(15);
    expect(filler.disconnect).not.toHaveBeenCalled();
    expect(incoming.start).toHaveBeenCalledOnce();
    player.pause();
    audio.currentTime = 40;
    await player.play();
    const resumedFiller = audio.sources.findLast(source => source.loop && source.buffer && source.start.mock.calls[0]?.[0] === 40)!;
    const resumedSong = audio.sources.findLast(source => source.buffer?.duration === 10)!;
    for (const source of [resumedFiller, resumedSong]) {
      const resumedGain = source.connect.mock.calls[0][0] as MockGain;
      expect(resumedGain.gain.setValueAtTime).toHaveBeenCalledWith(0.5, 40);
    }
  });

  it.each([0, 0.001])('overlaps timed filler handoff by an anticlick ramp with crossfade %s', async crossfade => {
    const value = routine();
    value.crossfade = crossfade;
    value.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
    await player.load(value);
    await player.play();
    const audio = MockContext.latest;
    const filler = audio.sources.find(source => source.loop)!;
    const incoming = audio.sources.find(source => source.buffer?.duration === 10)!;
    const outgoingGain = filler.connect.mock.calls[0][0] as MockGain;
    const incomingGain = incoming.connect.mock.calls[0][0] as MockGain;
    expect(incoming.start.mock.calls[0][0]).toBeCloseTo(17.98, 8);
    expect(outgoingGain.gain.linearRampToValueAtTime.mock.calls.at(-1)?.[1]).toBeCloseTo(17.99, 8);
    expect(incomingGain.gain.linearRampToValueAtTime.mock.calls[0][1]).toBeCloseTo(17.99, 8);
  });

  it('coalesces one-shot/countdown/periodic warnings and reschedules only canceled future alarms', async () => {
    const value = routine();
    value.beepEvery = 2;
    value.beepRemaining = 4;
    value.beepOnceRemaining = 4;
    await player.load(value);
    await player.play();
    await advance(7.9);
    const audio = MockContext.latest;
    expect(audio.oscillators).toHaveLength(1);
    expect(audio.oscillators[0].start).toHaveBeenCalledWith(8);
    player.pause();
    expect(audio.oscillators[0].disconnect).toHaveBeenCalled();
    audio.currentTime = 40;
    await player.play();
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators[1].start.mock.calls[0][0]).toBeCloseTo(40.1);
    await advance(40.1);
    player.pause();
    await player.play();
    expect(audio.oscillators).toHaveLength(2);
  });

  it('checkpoints at an unprepared handoff and never silently skips the missing song', async () => {
    await player.load(routine());
    await player.play();
    storage.missing.add('2');
    await advance(18.5);
    expect(state.status).toBe('paused');
    expect(state.error).toBe('audio_not_prepared');
    expect(state.trackIndex).toBe(2);
    expect(state.elapsed).toBe(0);
    expect(state.classElapsed).toBe(18);
    storage.missing.delete('2');
    await player.play();
    expect(state.trackIndex).toBe(2);
    expect(state.elapsed).toBe(0);
  });
});