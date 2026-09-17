import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build, createServer, type ViteDevServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { resolve } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { LoudnessEstimate } from '../shared/preview-contract';
import type { LoudnessMessage, LoudnessReply } from '../frontend/src/loudness.worker';

const mocks = vi.hoisted(() => ({ get: vi.fn(), decode: vi.fn() }));
vi.mock('../frontend/src/offline', () => ({ getTrackBlob: mocks.get, MAX_DECODED_BYTES: 128 * 1024 * 1024, MAX_TRACK_SECONDS: 360 }));
vi.mock('../frontend/src/hosted-session', () => ({
  hostedInvalidationEvent: 'fitness-hosted-invalidate', hostedUserKey: 'fitness-hosted-user', hostedResetKey: 'fitness-hosted-reset',
}));

function toneWav(amplitude: number, seconds = 4, channels = 1, tailAmplitude = amplitude): ArrayBuffer {
  const rate = 44100;
  const frames = Math.round(seconds * rate);
  const bytes = new ArrayBuffer(44 + frames * channels * 4);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 4, true); view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true); text(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
  for (let frame = 0; frame < frames; frame++) {
    const level = frame < 60 * rate ? amplitude : tailAmplitude;
    for (let channel = 0; channel < channels; channel++) {
      view.setFloat32(44 + (frame * channels + channel) * 4, level * Math.sin(2 * Math.PI * 1000 * frame / rate), true);
    }
  }
  return bytes;
}

type TestApi = typeof import('../frontend/src/offline') & typeof import('../frontend/src/loudness') & { toneWav: typeof toneWav };

function nativeAudio(input: Buffer, args: string[]) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', 'pipe:0', '-map', '0:a:0', ...args],
    { input, maxBuffer: 128 * 1024 * 1024, timeout: 60000 });
  if (result.status !== 0) throw new Error('native_reference_failed');
  return result;
}

function nativeLoudness(input: Buffer) {
  const result = nativeAudio(input, ['-af', 'aresample=44100,ebur128=peak=sample', '-f', 'null', '-']);
  const summary = result.stderr.toString().split('Summary:').at(-1)!;
  const integratedLufs = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peakDbfs = Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(peakDbfs)) throw new Error('invalid_native_reference');
  return { integratedLufs, peakDbfs };
}

function mixedWav() {
  const bytes = toneWav(0, 12, 2);
  const view = new DataView(bytes);
  for (let frame = 0; frame < 12 * 44100; frame++) {
    const seconds = frame / 44100;
    const level = seconds < 3 ? 0.025 : seconds < 8 ? 0.65 : 0.3;
    for (let channel = 0; channel < 2; channel++) {
      const pulse = Math.exp(-(seconds % 0.5) * 30) * Math.sin(2 * Math.PI * 90 * seconds);
      const tone = 0.35 * Math.sin(2 * Math.PI * (channel ? 997 : 440) * seconds) +
        0.15 * Math.sin(2 * Math.PI * 4073 * seconds);
      view.setFloat32(44 + (frame * 2 + channel) * 4, level * (pulse + tone), true);
    }
  }
  return Buffer.from(bytes);
}

describe('actual Chromium full-track EBU R128 WASM', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    server = await createServer({
      configFile: resolve('frontend/vite.config.ts'), root: resolve('frontend'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [{ name: 'loudness-test-route', configureServer(instance) {
        instance.middlewares.use('/loudness-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><title>Loudness test</title><script type="module">
            import * as offline from '/src/offline.ts';
            import * as loudness from '/src/loudness.ts';
            globalThis.audioTest = { ...offline, ...loudness, toneWav: ${toneWav.toString()} };
          </script>`);
        });
      } }],
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}loudness-test`);
    await page.waitForFunction(() => 'audioTest' in globalThis);
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  async function compareStored(input: Buffer, type: string, filler = false) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/') ? route.continue() : route.abort();
    });
    try {
      const isolated = await context.newPage();
      await isolated.goto(`${server.resolvedUrls!.local[0]}loudness-test`);
      await isolated.waitForFunction(() => 'audioTest' in globalThis);
      const result = await isolated.evaluate(async ({ base64, type, filler }) => {
        const api = (globalThis as unknown as { audioTest: TestApi }).audioTest;
        const input = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const source = new File([input], 'input.audio', { type });
        const id = filler ? `filler-${(await api.addFillerRecording(source, 'Synthetic filler')).asset.id}` :
          (await api.storeTrack(source)).id;
        const blob = (await api.getTrackBlob(id))!;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(
          await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        const before = await hash(bytes);
        const measurement = await api.analyzeTrackLoudness(id);
        const after = await hash(new Uint8Array(await (await api.getTrackBlob(id))!.arrayBuffer()));
        let encoded = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { measurement, before, unchanged: before === after, type: blob.type, base64: btoa(encoded) };
      }, { base64: input.toString('base64'), type, filler });
      const stored = Buffer.from(result.base64, 'base64');
      expect(createHash('sha256').update(stored).digest('hex') === result.before).toBe(true);
      expect(result.unchanged).toBe(true);
      const reference = nativeLoudness(stored);
      const delta = result.measurement.integratedLufs - reference.integratedLufs;
      expect(Math.abs(delta)).toBeLessThan(0.2);
      const target = Math.max(-11, Math.min(-5, result.measurement.integratedLufs));
      const desired = 10 ** ((target - result.measurement.integratedLufs) / 20);
      const headroom = 10 ** ((-1 - result.measurement.peakDbfs) / 20);
      const expected = desired > 1 ? Math.max(1, Math.min(1.25, desired, headroom)) : desired < 1 ? Math.min(desired, headroom) : 1;
      expect(result.measurement.recommendedGain).toBeCloseTo(expected, 10);
      return { app: result.measurement, reference, delta, type: result.type,
        bytePreserved: input.equals(stored), storedBytes: stored.length, sameBlobHash: true };
    } finally { await context.close(); }
  }

  it.each(['native-wave', 'native-aac', 'converted-opus', 'filler-wave'])(
    'matches native FFmpeg on the identical stored nontrivial mix: %s', async kind => {
      let input = mixedWav();
      let type = 'audio/wav';
      if (kind === 'native-aac') {
        input = nativeAudio(input, ['-map_metadata', '-1', '-c:a', 'aac', '-b:a', '256k',
          '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']).stdout;
        type = 'audio/mp4';
      } else if (kind === 'converted-opus') {
        input = nativeAudio(input, ['-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '192k', '-f', 'ogg', 'pipe:1']).stdout;
        type = 'audio/ogg';
      }
      const result = await compareStored(input, type, kind === 'filler-wave');
      expect(result.type).toBe(kind.includes('aac') || kind === 'converted-opus' ? 'audio/mp4' : 'audio/wav');
      expect(result.bytePreserved).toBe(kind !== 'converted-opus');
      console.info('Same stored synthetic blob reference', kind, result);
    }, 90000);

  it.runIf(Boolean(process.env.PRIVATE_AUDIO_DIR)).each(['02', '06', '11', '12'])(
    'compares authorized private file index %s through the actual stored AAC pipeline', async index => {
      const directory = process.env.PRIVATE_AUDIO_DIR!;
      let path: string;
      let input: Buffer;
      try {
        const names = readdirSync(directory).filter(name => name.startsWith(index) && /\.opus$/i.test(name));
        if (names.length !== 1) throw new Error();
        path = resolve(directory, names[0]);
        if (statSync(path).size > 32 * 1024 * 1024) throw new Error();
        input = readFileSync(path);
      } catch { throw new Error('private_fixture_unavailable'); }
      const before = createHash('sha256').update(input).digest('hex');
      const original = nativeLoudness(input);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries',
        'stream=codec_type:stream_disposition=attached_pic', '-of', 'json', 'pipe:0'],
      { input, maxBuffer: 1024 * 1024, timeout: 60000 });
      if (probe.status !== 0) throw new Error('native_probe_failed');
      const streams = JSON.parse(probe.stdout.toString()).streams as { codec_type: string; disposition?: { attached_pic?: number } }[];
      try {
        const result = await compareStored(input, 'audio/ogg');
        expect(result.type).toBe('audio/mp4');
        console.info('Private same-blob reference', { index, original, ...result });
      } finally {
        let unchanged = false;
        try { unchanged = createHash('sha256').update(readFileSync(path)).digest('hex') === before; }
        catch { throw new Error('private_fixture_unavailable'); }
        expect(unchanged).toBe(true);
        console.info('Private original integrity', { index, original, originalHashUnchanged: unchanged,
          audioStreams: streams.filter(stream => stream.codec_type === 'audio').length,
          attachedPictures: streams.filter(stream => stream.disposition?.attached_pic === 1).length,
          movingVideoStreams: streams.filter(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1).length });
      }
    }, 180000);

  it('matches the BS.1770 1 kHz reference and a 6.0206 dB amplitude change with unchanged stored bytes', async () => {
    const values = await page.evaluate(async () => {
      const api = (globalThis as unknown as { audioTest: TestApi }).audioTest;
      const results: LoudnessEstimate[] = [];
      for (const amplitude of [0.1, 0.2]) {
        const track = await api.storeTrack(new File([api.toneWav(amplitude)], 'tone.wav', { type: 'audio/wav' }));
        const hash = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
          await (await api.getTrackBlob(track.id))!.arrayBuffer()))).join(',');
        const before = await hash();
        results.push(await api.analyzeTrackLoudness(track.id));
        if (before !== await hash()) throw new Error('source_changed');
      }
      return results;
    });
    console.info('Actual WASM tone levels', values);
    expect(Math.abs(values[0].integratedLufs - (-23.003))).toBeLessThan(0.2);
    expect(values[1].integratedLufs - values[0].integratedLufs).toBeCloseTo(20 * Math.log10(2), 3);
    expect(values[0]).toMatchObject({ recommendedGain: 1.25, limited: true, targetLufs: -11 });
    expect(values[0].peakDbfs).toBeCloseTo(-20, 2);
    expect(values[1]).toMatchObject({ recommendedGain: 1.25, limited: true, targetLufs: -11 });
  }, 30000);

  it('sums stereo channel energy without downmixing', async () => {
    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as { audioTest: TestApi }).audioTest;
      const track = await api.storeTrack(new File([api.toneWav(0.1, 4, 2)], 'stereo.wav', { type: 'audio/wav' }));
      return api.analyzeTrackLoudness(track.id);
    });
    expect(Math.abs(result.integratedLufs - (-23.003 + 10 * Math.log10(2)))).toBeLessThan(0.2);
    expect(result.peakDbfs).toBeCloseTo(-20, 2);
  }, 30000);

  it('rejects silence explicitly and measures audio after the opening minute', async () => {
    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as { audioTest: TestApi }).audioTest;
      const silent = await api.storeTrack(new File([api.toneWav(0)], 'silence.wav', { type: 'audio/wav' }));
      let error = '';
      try { await api.analyzeTrackLoudness(silent.id); } catch (failure) { error = (failure as Error).message; }
      const late = await api.storeTrack(new File([api.toneWav(0, 64, 1, 0.2)], 'late.wav', { type: 'audio/wav' }));
      return { error, late: await api.analyzeTrackLoudness(late.id) };
    });
    expect(result.error).toBe('loudness_no_signal');
    expect(Math.abs(result.late.integratedLufs - (-16.983))).toBeLessThan(0.2);
  }, 60000);

  it('applies the relative loudness gate instead of averaging a quiet section into RMS', async () => {
    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as { audioTest: TestApi }).audioTest;
      const track = await api.storeTrack(new File([api.toneWav(0.002, 64, 1, 0.2)], 'gated.wav', { type: 'audio/wav' }));
      return api.analyzeTrackLoudness(track.id);
    });
    expect(Math.abs(result.integratedLufs - (-16.983))).toBeLessThan(0.2);
  }, 60000);

  it('leaves a transient-heavy quiet track neutral and warns when there is no boost headroom', async () => {
    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as { audioTest: TestApi }).audioTest;
      const bytes = api.toneWav(0.12);
      new DataView(bytes).setFloat32(44 + 44100 * 4, 1, true);
      const track = await api.storeTrack(new File([bytes], 'transient.wav', { type: 'audio/wav' }));
      return api.analyzeTrackLoudness(track.id);
    });
    expect(result.peakDbfs).toBeCloseTo(0, 6);
    expect(result.recommendedGain).toBe(1);
    expect(result.limited).toBe(true);
    expect(result.clippingRisk).toBe(true);
    expect(result.integratedLufs + 20 * Math.log10(result.recommendedGain)).toBeLessThan(-18);
  }, 30000);

  it('rejects nonfinite PCM, incomplete frames and oversized requests in the actual worker', async () => {
    const errors = await page.evaluate(async () => {
      const errors: string[] = [];
      for (const kind of ['nan', 'infinity', 'underfed', 'oversized']) {
        const worker = new Worker(new URL('/src/loudness.worker.ts', location.href), { type: 'module' });
        const request = (message: LoudnessMessage) => new Promise<LoudnessReply>((resolve, reject) => {
          worker.onmessage = event => resolve(event.data);
          worker.onerror = () => reject(new Error('worker_failure'));
          worker.postMessage(message);
        });
        try {
          let reply = await request({ kind: 'start', frames: kind === 'oversized' ? 128 * 1024 * 1024 : 44100, channels: 1, sampleRate: 44100 });
          if (reply.kind !== 'error') {
            const samples = new Float32Array([kind === 'nan' ? NaN : kind === 'infinity' ? Infinity : 0.1]);
            reply = await request({ kind: 'samples', offset: 0, samples: [samples] });
            if (kind === 'underfed') reply = await request({ kind: 'finish' });
          }
          errors.push(reply.kind === 'error' ? reply.error : 'unexpected_success');
        } finally { worker.terminate(); }
      }
      return errors;
    });
    expect(errors).toEqual(['invalid_audio', 'invalid_audio', 'invalid_audio', 'audio_memory_limit']);
  }, 30000);

  it('bundles WASM and its license inside manifest-listed worker JS and executes it offline', async () => {
    const bundle = await build({
      configFile: false, root: resolve('frontend'), logLevel: 'silent',
      build: { write: false, manifest: true, rollupOptions: { input: resolve('frontend/src/loudness.ts'), preserveEntrySignatures: 'strict' } },
    });
    if ('on' in bundle) throw new Error('unexpected_watcher');
    const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
    const worker = output.find(item => item.fileName.includes('loudness.worker') && item.fileName.endsWith('.js'));
    expect(worker).toBeDefined();
    const source = worker!.type === 'asset' ? String(worker!.source) : worker!.code;
    expect(source).toContain('data:application/wasm;base64,');
    expect(source).toContain('Apache License');
    expect(source).toContain('ebur128 0.1.6 - MIT License');
    const noticeCopyrights = [
      ['ebur128 0.1.6 - MIT License', 'Copyright (c) 2011 Jan Kokem\u00fcller'],
      ['ebur128 0.1.6 - MIT License', 'Copyright (c) 2020 Sebastian Dr\u00f6ge <sebastian@centricular.com>'],
      ['bitflags - MIT License', 'Copyright (c) 2014 The Rust Project Developers'],
      ['smallvec - MIT License', 'Copyright (c) 2018 The Servo Project Developers'],
      ['dasp_frame and dasp_sample - MIT License', 'Copyright (c) 2016 RustAudio Developers'],
      ['wasm-bindgen - MIT License', 'Copyright (c) 2014 Alex Crichton'],
      ['console_error_panic_hook 0.1.7 - MIT License', 'Copyright (c) 2018 Nick Fitzgerald'],
      ['cfg-if - MIT License', 'Copyright (c) 2014 Alex Crichton'],
    ];
    for (const [heading] of noticeCopyrights) expect(source).toContain(heading);
    const standaloneWasm = output.filter(item => item.fileName.endsWith('.wasm'));
    expect(standaloneWasm).toHaveLength(1);
    const codecWasm = standaloneWasm[0];
    expect(codecWasm.fileName).toMatch(/^assets\/ffmpeg-audio-core-[a-zA-Z0-9_-]{8}\.wasm$/);
    if (codecWasm.type !== 'asset') throw new Error('Expected codec WASM asset');
    expect(createHash('sha256').update(codecWasm.source).digest('hex')).toBe('978adc54750b888c10b605105bfc22a99ea46ee2b255dad43ccd045e4b90fdf2');
    const manifestAsset = output.find(item => item.fileName === '.vite/manifest.json');
    if (!manifestAsset || manifestAsset.type !== 'asset') throw new Error('missing_manifest');
    const manifest = JSON.parse(String(manifestAsset.source)) as Record<string, { file: string; assets?: string[] }>;
    const shellFiles = Object.values(manifest).flatMap(entry => [entry.file, ...entry.assets ?? []]);
    expect(shellFiles).toContain(worker!.fileName);
    await page.context().setOffline(true);
    try {
      const result = await page.evaluate(async source => {
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url);
        const request = (message: LoudnessMessage) => new Promise<LoudnessReply>((resolve, reject) => {
          worker.onmessage = event => event.data.kind === 'error' ? reject(new Error(event.data.error)) : resolve(event.data);
          worker.onerror = () => reject(new Error('worker_failure'));
          worker.postMessage(message);
        });
        try {
          const ready = await request({ kind: 'start', frames: 44100, channels: 1, sampleRate: 44100 });
          for (let offset = 0; offset < 44100; offset += 32768) {
            const samples = Float32Array.from({ length: Math.min(32768, 44100 - offset) },
              (_, index) => 0.1 * Math.sin(2 * Math.PI * 1000 * (offset + index) / 44100));
            await request({ kind: 'samples', offset, samples: [samples] });
          }
          return { ...await request({ kind: 'finish' }), license: ready.kind === 'ready' ? ready.license : undefined };
        } finally { worker.terminate(); URL.revokeObjectURL(url); }
      }, source);
      const normalizeNotice = (text: string) => text.replace(/\s+/g, ' ').trim();
      const mitTerms = normalizeNotice(`Permission is hereby granted, free of charge, to any person obtaining a copy
        of this software and associated documentation files (the "Software"), to deal
        in the Software without restriction, including without limitation the rights
        to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
        copies of the Software, and to permit persons to whom the Software is
        furnished to do so, subject to the following conditions:
        The above copyright notice and this permission notice shall be included in
        all copies or substantial portions of the Software.
        THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
        OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
        THE SOFTWARE.`);
      expect(result.license).toContain('Apache License');
      expect(result.license).toContain('END OF TERMS AND CONDITIONS');
      expect(result.license).toContain(readFileSync(resolve('frontend/node_modules/ebur128-wasm/LICENSE'), 'utf8'));
      for (const url of [
        'https://raw.githubusercontent.com/sdroege/ebur128/0.1.6/LICENSE',
        'https://docs.rs/crate/bitflags/1.3.2/source/LICENSE-MIT',
        'https://docs.rs/crate/smallvec/1.10.0/source/LICENSE-MIT',
        'https://raw.githubusercontent.com/RustAudio/dasp/221b81038c528bf3fc364a8ab5cc4b2e52f7dbfc/LICENSE-MIT',
        'https://raw.githubusercontent.com/RustAudio/dasp/97c3bb9b2363c0b46ac1633858bf1054fd02a980/LICENSE-MIT',
        'https://raw.githubusercontent.com/rustwasm/wasm-bindgen/0.2.83/LICENSE-MIT',
        'https://docs.rs/crate/console_error_panic_hook/0.1.7/source/LICENSE-MIT',
        'https://docs.rs/crate/cfg-if/1.0.0/source/LICENSE-MIT',
      ]) expect(result.license).toContain(url);
      const notices = result.license!.split(/\n\n(?=[^\n]+ - MIT License\n)/);
      for (const [heading, copyright] of noticeCopyrights) {
        const notice = notices.find(section => section.includes(heading));
        expect(notice, heading).toBeDefined();
        expect(normalizeNotice(notice!), heading).toContain(copyright);
        expect(normalizeNotice(notice!), heading).toContain(mitTerms);
      }
      expect(result.kind).toBe('result');
      if (result.kind === 'result') expect(Math.abs(result.integratedLufs + 23.003)).toBeLessThan(0.2);
      console.info('Offline manifest-listed loudness worker', worker!.fileName);
    } finally { await page.context().setOffline(false); }
  }, 60000);
});

describe('bounded serial loudness suggestions', () => {
  let analyze: typeof import('../frontend/src/loudness').analyzeTrackLoudness;
  let events: EventTarget;
  let markers: Map<string, string>;
  let audio: { duration: number; length: number; numberOfChannels: number; sampleRate: number; getChannelData: (channel: number) => Float32Array };
  let workers: FakeWorker[];
  let measurement: { integratedLufs: number; peakDbfs: number };
  let metadataDuration: number;
  let holdWorker: boolean;
  class FakeWorker {
    onmessage: ((event: { data: LoudnessReply }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = vi.fn();
    messages: LoudnessMessage[] = [];
    constructor() { workers.push(this); }
    postMessage(message: LoudnessMessage, transfer: Transferable[]) {
      this.messages.push(structuredClone(message));
      structuredClone(message, { transfer });
      if (holdWorker) return;
      queueMicrotask(() => this.onmessage?.({ data: message.kind === 'finish' ? { kind: 'result', ...measurement } : { kind: 'ready' } }));
    }
  }
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('VITE_HOSTED_PILOT', 'false');
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
    });
    workers = [];
    measurement = { integratedLufs: -8, peakDbfs: -6 };
    metadataDuration = 1;
    holdWorker = false;
    markers = new Map();
    events = new EventTarget();
    Object.assign(events, { localStorage: { getItem: (key: string) => markers.get(key) ?? null } });
    vi.stubGlobal('window', events);
    const samples = Float32Array.from({ length: 44100 }, (_, index) => index / 44100);
    audio = { duration: 1, length: samples.length, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => samples };
    mocks.get.mockReset().mockResolvedValue(new Blob(['stored audio']));
    mocks.decode.mockReset().mockImplementation(async () => audio);
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = mocks.decode; });
    vi.stubGlobal('Audio', class {
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      get duration() { return metadataDuration; }
      set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()); }
      removeAttribute() {}
      load() {}
    });
    vi.stubGlobal('Worker', FakeWorker);
    ({ analyzeTrackLoudness: analyze } = await import('../frontend/src/loudness'));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it.each([
    [-8, -6, 1, false], [-24, -6, 1.25, true], [-12, -6, 10 ** (1 / 20), false],
    [-20, -0.1, 1, true], [-11, -10, 1, false], [-5, 2, 1, false],
    [-3, -6, 10 ** (-2 / 20), false],
  ])('suggests target/capped gain for LUFS=%s peak=%s', async (integratedLufs, peakDbfs, gain, limited) => {
    measurement = { integratedLufs: Number(integratedLufs), peakDbfs: Number(peakDbfs) };
    const result = await analyze('track');
    expect(result.recommendedGain).toBeCloseTo(Number(gain), 12);
    expect(result.limited).toBe(limited);
    expect(result.targetLufs).toBe(Math.max(-11, Math.min(-5, Number(integratedLufs))));
    expect(result.clippingRisk).toBe(Number(peakDbfs) + 20 * Math.log10(Number(gain)) > -1 + 1e-9);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('does not reuse measured loudness when audio bytes change under an entry ID', async () => {
    expect((await analyze('same')).recommendedGain).toBe(1);
    mocks.get.mockResolvedValue(new Blob(['different stored audio']));
    measurement = { integratedLufs: -16, peakDbfs: -8 };
    expect((await analyze('same')).recommendedGain).toBe(1.25);
    expect(mocks.decode).toHaveBeenCalledTimes(2);
  });

  it('copies exact full channel data in bounded transfers without detaching or changing decoded PCM', async () => {
    const first = audio.getChannelData(0);
    const second = first.map(value => -value);
    const before = [first.slice(), second.slice()];
    audio.numberOfChannels = 2;
    audio.getChannelData = channel => channel === 0 ? first : second;
    await analyze('stereo');
    const chunks = workers[0].messages.filter(message => message.kind === 'samples');
    expect(chunks.map(chunk => chunk.offset)).toEqual([0, 32768]);
    for (const chunk of chunks) {
      expect(chunk.samples[0].length).toBeLessThanOrEqual(32768);
      chunk.samples.forEach((samples, channel) => expect(samples).toEqual(before[channel].slice(chunk.offset, chunk.offset + samples.length)));
    }
    expect(first).toEqual(before[0]);
    expect(second).toEqual(before[1]);
  });

  it('serializes requests, verifies stored blobs before cache hits and returns detached suggestions', async () => {
    const [first, second] = await Promise.all([analyze('one'), analyze('one')]);
    expect(mocks.decode).toHaveBeenCalledOnce();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    first.recommendedGain = 0;
    expect(second.recommendedGain).toBe(1);
    expect((await analyze('one')).recommendedGain).toBe(1);
    mocks.get.mockResolvedValueOnce(undefined);
    await expect(analyze('one')).rejects.toThrow('missing_audio');
    await analyze('one');
    expect(mocks.decode).toHaveBeenCalledTimes(2);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite measurement %s', async value => {
    measurement.integratedLufs = value;
    await expect(analyze('one')).rejects.toThrow('loudness_no_signal');
    measurement = { integratedLufs: -18, peakDbfs: value };
    await expect(analyze('two')).rejects.toThrow('loudness_no_signal');
  });

  it.each([NaN, Infinity, -1, 0, 361])('rejects metadata duration %s before decoding', async duration => {
    metadataDuration = duration;
    await expect(analyze('one')).rejects.toThrow('audio_duration_limit');
    expect(mocks.decode).not.toHaveBeenCalled();
  });

  it.each([
    { duration: 361 }, { duration: NaN }, { length: 128 * 1024 * 1024 / 4 + 1 },
    { numberOfChannels: 3 }, { numberOfChannels: 0 }, { length: Infinity },
    { length: -1 }, { sampleRate: NaN }, { sampleRate: 0 }, { duration: 0.5 },
  ])('rejects malformed decoded bounds %j before spawning WASM', async invalid => {
    Object.assign(audio, invalid);
    await expect(analyze('one')).rejects.toThrow(/audio_(duration|memory)_limit|invalid_audio/);
    expect(workers).toHaveLength(0);
  });

  it('rejects unknown IDs, corrupt decoding and oversized stored bytes, then permits retry', async () => {
    await expect(analyze('')).rejects.toThrow('invalid_track_id');
    mocks.get.mockResolvedValueOnce(undefined);
    await expect(analyze('unknown')).rejects.toThrow('missing_audio');
    mocks.get.mockResolvedValueOnce({ size: 128 * 1024 * 1024 + 1 });
    await expect(analyze('big')).rejects.toThrow('audio_byte_limit');
    mocks.decode.mockRejectedValueOnce(new Error('corrupt'));
    await expect(analyze('corrupt')).rejects.toThrow('unsupported_audio');
    await expect(analyze('retry')).resolves.toMatchObject({ recommendedGain: 1 });
  });

  it('terminates a stuck worker at its deadline and recovers the serial queue', async () => {
    holdWorker = true;
    vi.useFakeTimers();
    const result = expect(analyze('slow')).rejects.toThrow('loudness_timeout');
    await vi.advanceTimersByTimeAsync(60001);
    await result;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    holdWorker = false;
    vi.useRealTimers();
    await expect(analyze('retry')).resolves.toMatchObject({ recommendedGain: 1 });
  });

  it('times out native decoding without starting overlapping decodes that cannot be cancelled', async () => {
    let finish!: (value: typeof audio) => void;
    mocks.decode.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    const result = expect(analyze('slow')).rejects.toThrow('loudness_timeout');
    await vi.advanceTimersByTimeAsync(60001);
    await result;
    await expect(analyze('next')).rejects.toThrow('loudness_decoder_busy');
    expect(mocks.decode).toHaveBeenCalledOnce();
    finish(audio);
    vi.useRealTimers();
    await expect(analyze('retry')).resolves.toMatchObject({ recommendedGain: 1 });
  });

  it('invalidates pending work, queued work and cached results on explicit sign-out', async () => {
    await analyze('cached');
    holdWorker = true;
    const first = expect(analyze('pending')).rejects.toThrow('hosted_session_invalidated');
    const second = expect(analyze('queued')).rejects.toThrow('hosted_session_invalidated');
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    events.dispatchEvent(new Event('fitness-hosted-invalidate'));
    await Promise.all([first, second]);
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    await expect(analyze('cached')).rejects.toThrow('hosted_session_invalidated');
  });

  it.each(['owner', 'reset'])('guards cached results against %s marker changes without a storage event', async kind => {
    vi.stubEnv('VITE_HOSTED_PILOT', 'true');
    markers.set('fitness-hosted-user', 'owner-one');
    await analyze('cached');
    markers.set(kind === 'owner' ? 'fitness-hosted-user' : 'fitness-hosted-reset', 'changed');
    await expect(analyze('cached')).rejects.toThrow('hosted_session_invalidated');
  });
});