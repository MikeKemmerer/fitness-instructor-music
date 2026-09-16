import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { worker } from '../frontend/node_modules/web-audio-beat-detector/src/worker/worker';
import { detectTrackBpm } from '../frontend/src/bpm';

const detector = vi.hoisted(() => ({ guess: vi.fn(), get: vi.fn(), decode: vi.fn() }));
vi.mock('../frontend/node_modules/web-audio-beat-detector', () => ({ guess: detector.guess }));
vi.mock('../frontend/src/offline', async original => ({
  ...await original<typeof import('../frontend/src/offline')>(), getTrackBlob: detector.get,
}));

function pulses(firstBeat = 2.25, duration = 12, bpm = 120) {
  const sampleRate = 24000;
  const samples = new Float32Array(Math.floor(duration * sampleRate));
  for (let seconds = firstBeat; seconds < duration; seconds += 60 / bpm) {
    samples[Math.round(seconds * sampleRate)] = 0.8;
  }
  return { duration, length: samples.length, sampleRate, numberOfChannels: 1, getChannelData: () => samples };
}

describe('real Chromium Web Audio detector', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    server = await createServer({
      configFile: resolve('frontend/vite.config.ts'), root: resolve('frontend'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [{ name: 'audio-test-route', configureServer(instance) {
        instance.middlewares.use('/bpm-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><title>Audio test</title><script type="module">
            import * as offline from '/src/offline.ts';
            import * as bpm from '/src/bpm.ts';
            import * as filler from '/src/filler-audio.ts';
            globalThis.audioTest = { ...offline, ...bpm, ...filler };
          </script>`);
        });
      } }],
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on('pageerror', error => console.error(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}bpm-test`);
    await page.waitForFunction(() => 'audioTest' in globalThis);
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it('measures the original drum demo below the installed worker positive-peak gate', async () => {
    const peak = await page.evaluate(async () => {
      const { generateDemoWav } = (globalThis as unknown as { audioTest: typeof import('../frontend/src/offline') }).audioTest;
      const decoder = new OfflineAudioContext(2, 1, 24000);
      const audio = await decoder.decodeAudioData(await generateDemoWav(28, 120, 'drums').arrayBuffer());
      const renderer = new OfflineAudioContext(audio.numberOfChannels, audio.length, audio.sampleRate);
      const source = renderer.createBufferSource();
      const filter = renderer.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 240;
      source.buffer = audio;
      source.connect(filter).connect(renderer.destination);
      source.start();
      const filtered = await renderer.startRendering();
      let maximum = 0;
      for (const sample of filtered.getChannelData(0)) maximum = Math.max(maximum, sample);
      return maximum;
    });
    console.info('Original drum positive peak after library 240 Hz low-pass', peak);
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThanOrEqual(0.25);
  });

  it('fetches and decodes the real bundled recorded loop once without changing its native rate', async () => {
    const result = await page.evaluate(async () => {
      const { getFillerBuffer, LOFI_ASSET } = (globalThis as unknown as {
        audioTest: typeof import('../frontend/src/filler-audio');
      }).audioTest;
      const audio = new OfflineAudioContext(1, 1, 44100);
      const filler = { mode: 'hold' as const, sound: 'lofi' as const, seconds: 8, bpm: 40 };
      const first = await getFillerBuffer(audio, filler);
      const second = await getFillerBuffer(audio, { ...filler, bpm: 180 });
      let squareSum = 0;
      for (const sample of first.getChannelData(0)) squareSum += sample * sample;
      return { same: first === second, duration: first.duration, frames: first.length,
        channels: first.numberOfChannels, sampleRate: first.sampleRate, rms: Math.sqrt(squareSum / first.length), url: LOFI_ASSET.url };
    });
    console.info('Real recorded loop decode', result);
    expect(result).toMatchObject({ same: true, duration: 16, frames: 352800, channels: 1, sampleRate: 22050 });
    expect(result.rms).toBeGreaterThan(0.01);
  });

  it.each([{ sound: 'drums', bpm: 120, seconds: 28 }, { sound: 'soft', bpm: 100, seconds: 24 }])(
    'detects actual generateDemoWav $sound at $bpm BPM without metadata', async fixture => {
      const result = await page.evaluate(async fixture => {
        const { generateDemoWav, storeTrack, detectTrackBpm } = (globalThis as unknown as {
          audioTest: typeof import('../frontend/src/offline') & typeof import('../frontend/src/bpm');
        }).audioTest;
        const blob = generateDemoWav(fixture.seconds, fixture.bpm, fixture.sound as 'drums' | 'soft');
        const track = await storeTrack(new File([blob], 'unlabelled.wav', { type: 'audio/wav' }));
        return detectTrackBpm(track.id);
      }, fixture);
      console.info('Real demo estimate', fixture.sound, result);
      expect(result.bpm).toBeCloseTo(fixture.bpm, 0);
      expect(result.firstBeat).toBeGreaterThanOrEqual(0);
      expect(result.firstBeat).toBeLessThan(0.1);
    }, 30000);

  it.each(['pulses', 'late-pulses', 'silence', 'sparse'] as const)('uses real filtering for %s with no assigned track BPM', async kind => {
    const result = await page.evaluate(async kind => {
      const { generateDemoWav, storeTrack, detectTrackBpm } = (globalThis as unknown as {
        audioTest: typeof import('../frontend/src/offline') & typeof import('../frontend/src/bpm');
      }).audioTest;
      const duration = kind === 'late-pulses' ? 60 : 24;
      const firstBeat = kind === 'late-pulses' ? 19.25 : 2.25;
      const bytes = await generateDemoWav(duration, 120, 'drums').arrayBuffer();
      const view = new DataView(bytes);
      for (let index = 44; index < bytes.byteLength; index += 2) view.setInt16(index, 0, true);
      const times = kind.endsWith('pulses') ? Array.from({ length: Math.ceil((duration - firstBeat) * 2) }, (_, index) => firstBeat + index * 0.5) :
        kind === 'sparse' ? [2.25, 9.6, 20.3] : [];
      for (const time of times) view.setInt16(44 + Math.round(time * 16000) * 2, 26000, true);
      const track = await storeTrack(new File([bytes], 'unknown.wav', { type: 'audio/wav' }));
      try { return { estimate: await detectTrackBpm(track.id), error: null }; }
      catch (error) { return { estimate: null, error: (error as Error).message }; }
    }, kind);
    console.info('Real pulse estimate', kind, result);
    if (kind.endsWith('pulses')) {
      expect(result.estimate?.bpm).toBe(120);
      expect(result.estimate?.firstBeat).toBeCloseTo(kind === 'late-pulses' ? 19.25 : 2.25, 3);
    } else expect(result.error).toBe('bpm_no_beats');
  }, 30000);

  it.each([
    { bpm: 60, pulseBpm: 60, subdivision: 1, gain: 0.8, first: 3.25, duration: 32 },
    { bpm: 80, pulseBpm: 160, subdivision: 0.45, gain: 0.8, first: 3.25, duration: 32 },
    { bpm: 120, pulseBpm: 120, subdivision: 1, gain: 0.8, first: 3.25, duration: 32 },
    { bpm: 160, pulseBpm: 160, subdivision: 1, gain: 0.8, first: 3.25, duration: 32 },
    { bpm: 80, pulseBpm: 160, subdivision: 0.45, gain: 0.002, first: 3.25, duration: 32 },
    { bpm: 120, pulseBpm: 120, subdivision: 1, gain: 0.8, first: 62.25, duration: 100 },
  ])('measures native-polarity $bpm BPM gain=$gain first=$first across the track', async fixture => {
    const result = await page.evaluate(async fixture => {
      const api = (globalThis as unknown as { audioTest: typeof import('../frontend/src/offline') &
        typeof import('../frontend/src/bpm') }).audioTest;
      const bytes = await api.generateDemoWav(fixture.duration, 120, 'drums').arrayBuffer();
      const view = new DataView(bytes);
      for (let index = 44; index < bytes.byteLength; index += 2) view.setInt16(index, 0, true);
      for (let beat = 0; fixture.first + beat * 60 / fixture.pulseBpm < fixture.duration - 0.1; beat++) {
        const start = Math.round((fixture.first + beat * 60 / fixture.pulseBpm) * 16000);
        const level = fixture.gain * (beat % 2 ? fixture.subdivision : 1);
        for (let frame = 0; frame < 1600; frame++) {
          const time = frame / 16000;
          view.setInt16(44 + (start + frame) * 2,
            Math.round(32767 * level * Math.sin(2 * Math.PI * 100 * time) * Math.exp(-time * 90)), true);
        }
      }
      const track = await api.storeTrack(new File([bytes], 'synthetic.wav', { type: 'audio/wav' }));
      const saved = new Uint8Array(await (await api.getTrackBlob(track.id))!.arrayBuffer());
      const before = await crypto.subtle.digest('SHA-256', saved);
      const estimate = await api.detectTrackBpm(track.id);
      const after = await crypto.subtle.digest('SHA-256', await (await api.getTrackBlob(track.id))!.arrayBuffer());
      return { estimate, unchanged: new Uint8Array(before).every((byte, index) => byte === new Uint8Array(after)[index]) };
    }, fixture);
    console.info('Native-polarity synthetic BPM', fixture, result.estimate);
    expect(Math.abs(result.estimate.bpm / fixture.bpm - 1)).toBeLessThan(0.01);
    expect(Math.abs(result.estimate.firstBeat - fixture.first)).toBeLessThan(0.04);
    expect(result.estimate.confidence).toBeGreaterThanOrEqual(0);
    expect(result.estimate.confidence).toBeLessThanOrEqual(1);
    expect(result.estimate.alternatives).toContain(fixture.bpm);
    expect(result.unchanged).toBe(true);
  }, 45000);
});

describe('bounded BPM and first-beat estimation', () => {
  beforeEach(() => {
    detector.get.mockReset().mockResolvedValue(new Blob(['synthetic']));
    detector.decode.mockReset().mockResolvedValue(pulses());
    detector.guess.mockReset().mockResolvedValue({ bpm: 120, offset: 0.25, tempo: 120.001 });
    vi.stubGlobal('OfflineAudioContext', class {
      source!: { buffer: ReturnType<typeof pulses>; connect: (filter: unknown) => unknown; start: () => void };
      destination = {};
      decodeAudioData = detector.decode;
      createBufferSource() {
        this.source = { buffer: pulses(), connect: filter => filter, start: () => undefined };
        return this.source;
      }
      createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect: () => undefined }; }
      async startRendering() { return this.source.buffer; }
      createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
        const samples = new Float32Array(length);
        return { numberOfChannels, length, sampleRate, duration: length / sampleRate, getChannelData: () => samples };
      }
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('returns the first observed beat after leading silence, not the modulo-period phase', async () => {
    expect(await detectTrackBpm('one')).toMatchObject({ bpm: 120, firstBeat: 2.25, alternatives: [60, 120] });
    expect(detector.guess).toHaveBeenCalledWith(expect.anything(), 0, 6, { minTempo: 90, maxTempo: 180 });
  });

  it('unwraps the actual installed detector worker output for a synthetic beat train with leading silence', async () => {
    let receive!: (event: unknown) => Promise<void>;
    const postMessage = vi.fn();
    runInNewContext(worker, { self: {
      addEventListener: (_name: string, listener: typeof receive) => { receive = listener; },
      removeEventListener: vi.fn(), postMessage,
    } });
    detector.guess.mockImplementationOnce(async (audio: ReturnType<typeof pulses>) => {
      await receive({ data: { id: 1, method: 'guess', params: {
        channelData: audio.getChannelData(), sampleRate: audio.sampleRate, tempoSettings: { minTempo: 90, maxTempo: 180 },
      } } });
      const response = postMessage.mock.calls[0][0];
      expect(response.error).toBeUndefined();
      expect(response.result.bpm).toBe(120);
      expect(response.result.offset).toBeLessThanOrEqual(0.5);
      expect(response.result.tempo).toBeCloseTo(120, 1);
      return response.result;
    });
    expect((await detectTrackBpm('one')).firstBeat).toBeCloseTo(2.25, 4);
  });

  it('does not confuse an off-grid pickup with the first aligned beat', async () => {
    const audio = pulses();
    audio.getChannelData()[2400] = 0.9;
    detector.decode.mockResolvedValue(audio);
    expect((await detectTrackBpm('one')).firstBeat).toBeCloseTo(2.25, 4);
  });

  it('ranks stronger 80 BPM beats above weaker 160 BPM subdivisions, not by raw count', async () => {
    const audio = pulses(2.25, 24, 160);
    const samples = audio.getChannelData();
    for (let beat = 1; 2.25 + beat * 0.375 < audio.duration; beat += 2) {
      samples[Math.round((2.25 + beat * 0.375) * audio.sampleRate)] = 0.36;
    }
    detector.decode.mockResolvedValue(audio);
    detector.guess.mockResolvedValue({ bpm: 160, offset: 0, tempo: 160 });
    expect((await detectTrackBpm('one')).bpm).toBe(80);
  });

  it('retains equal-strength 160 BPM pulses and reports lower confidence for near-equal octave fits', async () => {
    const audio = pulses(2.25, 24, 160);
    detector.decode.mockResolvedValue(audio);
    detector.guess.mockResolvedValue({ bpm: 160, offset: 0, tempo: 160 });
    const clear = await detectTrackBpm('clear');
    expect(clear.bpm).toBe(160);
    const samples = audio.getChannelData();
    for (let beat = 1; 2.25 + beat * 0.375 < audio.duration; beat += 2) {
      samples[Math.round((2.25 + beat * 0.375) * audio.sampleRate)] = 0.8 * 0.65;
    }
    const ambiguous = await detectTrackBpm('ambiguous');
    expect(ambiguous.alternatives).toEqual(expect.arrayContaining([80, 160]));
    expect(ambiguous.confidence).toBeLessThan(0.4);
    expect(ambiguous.confidence!).toBeLessThan(clear.confidence!);
    expect(new Set(ambiguous.alternatives).size).toBe(ambiguous.alternatives!.length);
    expect(ambiguous.alternatives!.every(bpm => bpm >= 40 && bpm <= 220)).toBe(true);
  });

  it('keeps signed samples and normalizes each library window without changing source PCM', async () => {
    const audio = pulses(2.25, 24);
    const samples = audio.getChannelData();
    samples[10000] = -0.4;
    const before = samples.slice();
    detector.decode.mockResolvedValue(audio);
    await detectTrackBpm('one');
    const window = detector.guess.mock.calls[0][0].getChannelData(0) as Float32Array;
    expect(window[10000]).toBeLessThan(0);
    expect(window[Math.round(2.25 * audio.sampleRate)]).toBeCloseTo(0.9, 6);
    expect(samples).toEqual(before);
  });

  it('finds an earlier supported onset outside sampled windows, not a modulo phase', async () => {
    detector.decode.mockResolvedValue(pulses(62.25, 100));
    expect(await detectTrackBpm('late')).toMatchObject({ bpm: 120, firstBeat: 62.25 });
    expect(detector.guess).toHaveBeenCalledTimes(2);
  });

  it('uses rounded BPM for phase unwrapping, matching the installed library', async () => {
    detector.decode.mockResolvedValue(pulses(3.2, 12, 100));
    detector.guess.mockResolvedValue({ bpm: 100, offset: 0.2, tempo: 100.4 });
    expect(await detectTrackBpm('one')).toMatchObject({ bpm: 100, firstBeat: 3.2 });
  });

  it('samples sixty seconds spread across the complete track', async () => {
    detector.decode.mockResolvedValue(pulses(2.25, 100));
    await detectTrackBpm('one');
    expect(detector.guess).toHaveBeenCalledTimes(6);
    expect(detector.guess).toHaveBeenCalledWith(expect.anything(), 0, 20, expect.anything());
  });

  it('serializes complete analyses and recovers the queue after a failure', async () => {
    let resolve!: (value: { bpm: number; offset: number; tempo: number }) => void;
    detector.guess.mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
    const first = detectTrackBpm('one');
    await vi.waitFor(() => expect(detector.guess).toHaveBeenCalledTimes(1));
    const second = detectTrackBpm('two');
    await Promise.resolve();
    expect(detector.decode).toHaveBeenCalledTimes(1);
    resolve({ bpm: 120, offset: 0.25, tempo: 120 });
    await Promise.all([first, second]);
    expect(detector.decode).toHaveBeenCalledTimes(2);
    detector.guess.mockRejectedValue(new Error('no_beats'));
    await expect(detectTrackBpm('one')).rejects.toThrow('bpm_no_beats');
    detector.guess.mockResolvedValue({ bpm: 120, offset: 0.25, tempo: 120 });
    await expect(detectTrackBpm('two')).resolves.toMatchObject({ bpm: 120 });
  });

  it('rejects silence before calling the detector', async () => {
    detector.decode.mockResolvedValue(pulses(20));
    await expect(detectTrackBpm('silent')).rejects.toThrow('bpm_no_beats');
    expect(detector.guess).not.toHaveBeenCalled();
  });

  it.each([
    { bpm: NaN, offset: 0.25 }, { bpm: 0, offset: 0.25 },
    { bpm: 120, offset: Infinity }, { bpm: 120, offset: -1 }, { bpm: 120, offset: 0 },
  ])('rejects an invalid or unsupported grid: %j', async result => {
    detector.guess.mockResolvedValue(result);
    await expect(detectTrackBpm('one')).rejects.toThrow('bpm_no_beats');
  });

  it('rejects missing media, oversized decoded audio, and too few beats', async () => {
    detector.get.mockResolvedValueOnce(undefined);
    await expect(detectTrackBpm('missing')).rejects.toThrow('missing_audio');
    detector.decode.mockResolvedValueOnce({ ...pulses(), numberOfChannels: 6 });
    await expect(detectTrackBpm('large')).rejects.toThrow('audio_memory_limit');
    detector.decode.mockResolvedValueOnce(pulses(11.25));
    await expect(detectTrackBpm('short')).rejects.toThrow('bpm_no_beats');
  });

  it.each([{ duration: 361 }, { length: Infinity }, { sampleRate: 0 }, { numberOfChannels: 0 }])(
    'rejects invalid decoded bounds %j', async invalid => {
      detector.decode.mockResolvedValue({ ...pulses(), ...invalid });
      await expect(detectTrackBpm('invalid')).rejects.toThrow(/audio_(duration|memory)_limit|invalid_audio/);
      expect(detector.guess).not.toHaveBeenCalled();
    });

  it('times out uncancellable native decoding and blocks overlap until it settles', async () => {
    let finish!: (audio: ReturnType<typeof pulses>) => void;
    detector.decode.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    const pending = expect(detectTrackBpm('slow')).rejects.toThrow('bpm_timeout');
    await vi.advanceTimersByTimeAsync(60001);
    await pending;
    await expect(detectTrackBpm('next')).rejects.toThrow('bpm_analysis_busy');
    expect(detector.decode).toHaveBeenCalledOnce();
    finish(pulses());
    vi.useRealTimers();
    await expect(detectTrackBpm('retry')).resolves.toMatchObject({ bpm: 120 });
  });
});