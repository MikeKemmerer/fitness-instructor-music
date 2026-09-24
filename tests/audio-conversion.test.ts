import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { AAC_IMPORT } from '../shared/audio-import';

type ConversionApi = typeof import('../frontend/src/audio-conversion');

let pythonExecutable: string | undefined;
function python(): string {
  return pythonExecutable ??= ['python3', 'python'].find(name => {
    try { execFileSync(name, ['--version']); return true; } catch { return false; }
  }) ?? 'python3';
}

function fixture(codec = 'libopus', channels = 2, duration = 10.000271, tags = 0, metadata = ''): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    `anoisesrc=color=white:amplitude=0.22:seed=431:sample_rate=48000:duration=${duration}`,
    '-f', 'ffmetadata', '-i', 'pipe:0', '-map', '0:a:0', '-map_metadata', '1', '-ac', String(channels),
    '-c:a', codec, '-b:a', '256k', '-f', codec === 'flac' ? 'flac' : 'ogg', 'pipe:1'],
  { input: `;FFMETADATA1\ncomment=SYNTHETIC_PRIVATE_TAG_${'X'.repeat(tags)}\n${metadata}`, maxBuffer: 40 * 1024 * 1024 });
}

let syntheticPicture: Buffer | undefined;
function coverArt(): Buffer {
  return syntheticPicture ??= execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'color=color=red:size=2x2', '-frames:v', '1', '-c:v', 'png', '-threads:v', '1', '-f', 'image2pipe', 'pipe:1']);
}

function opusWithArtwork(channels = 2): Buffer {
  const picture = coverArt();
  const mime = Buffer.from('image/png');
  const description = Buffer.from('SYNTHETIC_PRIVATE_ART');
  const uint32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const block = Buffer.concat([uint32(3), uint32(mime.length), mime, uint32(description.length), description,
    uint32(2), uint32(2), uint32(24), uint32(0), uint32(picture.length), picture]);
  return fixture('libopus', channels, 2, 0, `METADATA_BLOCK_PICTURE=${block.toString('base64')}\n`);
}

function nativeProbe(bytes: Buffer) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', 'pipe:0'],
    { input: bytes, maxBuffer: 1024 * 1024 }).toString());
}

function withOpusGain(source: Buffer, gain: number): Buffer {
  const bytes = Buffer.from(source);
  const header = bytes.indexOf('OpusHead');
  expect(header).toBeGreaterThan(26);
  bytes.writeInt16LE(gain * 256, header + 16);
  const segmentCount = bytes[26];
  let pageEnd = 27 + segmentCount;
  for (let segment = 0; segment < segmentCount; segment++) pageEnd += bytes[27 + segment];
  bytes.writeUInt32LE(0, 22);
  let checksum = 0;
  for (const byte of bytes.subarray(0, pageEnd)) {
    checksum ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) checksum = ((checksum << 1) ^ (checksum & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  bytes.writeUInt32LE(checksum, 22);
  return bytes;
}

describe('local AAC conversion under unchanged production CSP', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let assets: Map<string, string | Uint8Array>;
  const browserErrors: string[] = [];
  const requests: string[] = [];
  beforeAll(async () => {
    const bundle = await build({
      configFile: false, root: resolve('frontend'), logLevel: 'silent',
      build: { write: false, manifest: true, rollupOptions: {
        input: resolve('frontend/src/audio-conversion.ts'), preserveEntrySignatures: 'strict',
      } },
    });
    if ('on' in bundle) throw new Error('unexpected_watcher');
    const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
    const entry = output.find(item => item.type === 'chunk' && item.isEntry)!;
    assets = new Map(output.map(item => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
    assets.set('/test.js', `import * as conversion from '/${entry.fileName}'; globalThis.conversion = conversion;`);
    assets.set('/inspect-core.js', `
      self.onmessage = async ({ data }) => {
        const factory = (await import(data.coreURL)).default;
        const compiled = await WebAssembly.compile(await (await fetch(data.wasmURL)).arrayBuffer());
        let memory;
        const core = await factory({
          instantiateWasm(imports, receive) {
            const instance = new WebAssembly.Instance(compiled, imports);
            memory = Object.values(instance.exports).find(value => value instanceof WebAssembly.Memory);
            receive(instance);
            return instance.exports;
          }
        });
        const logs = [];
        core.setLogger(({ message }) => logs.push(message));
        core.exec('-version'); core.reset();
        const version = logs.splice(0).join('\\n');
        core.exec('-L'); core.reset();
        const license = logs.splice(0).join('\\n');
        const initial = memory.buffer.byteLength;
        memory.grow(1);
        let limited = false;
        try { memory.grow(8193 - memory.buffer.byteLength / 65536); }
        catch (error) { limited = error instanceof RangeError; }
        self.postMessage({ version, license, initial, limited, shared: !(memory.buffer instanceof ArrayBuffer) });
      };
    `);
    assets.set('/test-sw.js', `
      self.addEventListener('install', event => event.waitUntil(caches.open('conversion-test').then(cache => cache.addAll(${JSON.stringify([...assets.keys()].filter(path => path !== '/.vite/manifest.json'))})).then(() => self.skipWaiting())));
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))));
    `);
    const config = JSON.parse(readFileSync('frontend/public/staticwebapp.config.json', 'utf8'));
    server = createServer((request, response) => {
      requests.push(request.url!);
      response.setHeader('Content-Security-Policy', config.globalHeaders['Content-Security-Policy']);
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Conversion test</title><script type="module" src="/test.js"></script>');
        return;
      }
      const asset = assets.get(request.url!);
      if (!asset) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', request.url!.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      response.end(asset);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on('console', message => browserErrors.push(message.text()));
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await page.waitForFunction(() => 'conversion' in globalThis);
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  async function convert(input: Buffer) {
    return page.evaluate(async base64 => {
      const api = (globalThis as unknown as { conversion: ConversionApi }).conversion;
      const source = new File([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], 'SYNTHETIC_PRIVATE_FILENAME.audio');
      const hash = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await source.arrayBuffer()))).join(',');
      const before = await hash();
      const result = await api.convertToM4a(source);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let encoded = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
      return { base64: btoa(encoded), duration: result.duration, decodedDuration: decoded.duration,
        channels: decoded.numberOfChannels, frames: decoded.length, unchanged: before === await hash() };
    }, input.toString('base64'));
  }

  async function rejection(input: Buffer) {
    return page.evaluate(async base64 => {
      const api = (globalThis as unknown as { conversion: ConversionApi }).conversion;
      try {
        await api.convertToM4a(new File([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], 'SYNTHETIC_PRIVATE_FILENAME.audio'));
        return 'unexpected_success';
      } catch (error) { return (error as Error).message; }
    }, input.toString('base64'));
  }

  it('ships an actual LGPL-only core with an enforced 512MiB unshared memory maximum', async () => {
    const coreURL = [...assets.keys()].find(path => /ffmpeg-audio-core.*\.js$/.test(path))!;
    const wasmURL = [...assets.keys()].find(path => /ffmpeg-audio-core.*\.wasm$/.test(path))!;
    const result = await page.evaluate(async urls => {
      const worker = new Worker('/inspect-core.js', { type: 'module' });
      try {
        return await new Promise<{ version: string; license: string; initial: number; limited: boolean; shared: boolean }>((resolve, reject) => {
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = () => reject(new Error('core_inspection_failed'));
          worker.postMessage(urls);
        });
      } finally { worker.terminate(); }
    }, { coreURL, wasmURL });
    expect(result).toMatchObject({ initial: 33554432, limited: true, shared: false });
    expect(result.version).toContain('5.1.4');
    for (const flag of ['--disable-gpl', '--disable-nonfree', '--disable-version3', '--disable-pthreads', '--disable-network']) {
      expect(result.version).toContain(flag);
    }
    expect(result.version).not.toMatch(/--enable-(gpl|nonfree|version3|libopus|libx264|libx265)/);
    expect(result.license).toContain('GNU Lesser General Public');
    expect(result.license).toContain('version 2.1');
  }, 60000);

  it('encodes actual FLAC to natively decodable 48kHz AAC-LC M4A without isolation', async () => {
    const input = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:a', 'flac', '-f', 'flac', 'pipe:1']);
    const result = await page.evaluate(async base64 => {
      const api = (globalThis as unknown as { conversion: ConversionApi }).conversion;
      const source = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const converted = await api.convertToM4a(new File([source], 'private.flac'));
      const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await converted.blob.arrayBuffer());
      return { type: converted.blob.type, duration: converted.duration, decoded: decoded.duration,
        channels: decoded.numberOfChannels, rate: decoded.sampleRate, isolated: crossOriginIsolated };
    }, input.toString('base64'));
    expect(result).toMatchObject({ type: 'audio/mp4', duration: 1, channels: 1, rate: 48000, isolated: false });
    expect(Math.abs(result.decoded - 1)).toBeLessThanOrEqual(1024 / 48000);
  }, 60000);

  it.each([1, 2])('converts %i-channel Opus with 2MiB tags, bounded full-duration probes and 256k target', async channels => {
    const duration = channels === 2 ? 200.000271 : 10.000271;
    const source = fixture('libopus', channels, duration, 2 * 1024 * 1024);
    const hash = createHash('sha256').update(source).digest('hex');
    const result = await convert(source);
    const bytes = Buffer.from(result.base64, 'base64');
    const output = nativeProbe(bytes);
    expect(result.unchanged).toBe(true);
    expect(createHash('sha256').update(source).digest('hex')).toBe(hash);
    expect(result.channels).toBe(channels);
    expect(result.duration).toBeCloseTo(Math.round(duration * 48000) / 48000, 6);
    expect(Math.abs(result.decodedDuration - result.duration)).toBeLessThanOrEqual(1024 / 48000);
    expect(output.streams).toHaveLength(1);
    expect(output.streams[0]).toMatchObject({ codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels });
    expect(Number(output.streams[0].bit_rate)).toBeGreaterThan(220000);
    expect(Number(output.streams[0].bit_rate)).toBeLessThan(290000);
    expect(bytes.length).toBeLessThan(AAC_IMPORT.maxOutputBytes);
    expect(bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_TAG'))).toBe(false);
    expect(browserErrors.join('\n')).not.toMatch(/SYNTHETIC_PRIVATE|Content Security Policy|SharedArrayBuffer/);
  }, 60000);

  it('converts Vorbis independently of browser decoder support', async () => {
    const result = await convert(fixture('libvorbis', 2, 2));
    expect(result.channels).toBe(2);
    expect(result.duration).toBeCloseTo(2, 2);
    expect(result.unchanged).toBe(true);
  }, 60000);

  it.each(['mono Opus', 'stereo Opus', 'MP3'])('discards explicitly attached PNG artwork from real %s input', async format => {
    const channels = format === 'mono Opus' ? 1 : 2;
    let reference: Buffer | undefined;
    const source = format === 'MP3'
      ? (() => {
        const directory = mkdtempSync(resolve('local-media/conversion-synthetic-'));
        try {
          const path = resolve(directory, 'attached.mp3');
          execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=2:sample_rate=48000',
            '-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0', '-map', '0:a:0', '-map', '1:v:0',
            '-ac', '2', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
            '-metadata', 'comment=SYNTHETIC_PRIVATE_TAG', '-metadata:s:v', 'title=SYNTHETIC_PRIVATE_ART',
            '-id3v2_version', '3', '-f', 'mp3', path], { input: coverArt() });
          reference = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-vn',
            '-ar', '48000', '-f', 'f32le', 'pipe:1']);
          return readFileSync(path);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      })()
      : opusWithArtwork(channels);
    const input = nativeProbe(source);
    expect(input.streams).toHaveLength(2);
    expect(input.streams.filter((stream: { codec_type: string }) => stream.codec_type === 'audio')).toHaveLength(1);
    expect(input.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video')).toMatchObject({
      codec_name: 'png', disposition: { attached_pic: 1 },
    });
    const hash = createHash('sha256').update(source).digest('hex');
    reference ??= execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-vn',
      '-ar', '48000', '-f', 'f32le', 'pipe:1'], { input: source });
    const result = await convert(source);
    const bytes = Buffer.from(result.base64, 'base64');
    const output = nativeProbe(bytes);
    expect(result.unchanged).toBe(true);
    expect(createHash('sha256').update(source).digest('hex')).toBe(hash);
    expect(result.channels).toBe(channels);
    expect(Math.abs(result.duration - reference.length / (4 * channels * 48000))).toBeLessThanOrEqual(1 / 48000);
    expect(Math.abs(result.decodedDuration - result.duration)).toBeLessThanOrEqual(1024 / 48000);
    expect(output.streams).toHaveLength(1);
    expect(output.streams[0]).toMatchObject({ codec_type: 'audio', codec_name: 'aac', profile: 'LC',
      sample_rate: '48000', channels, disposition: { attached_pic: 0 } });
    expect(bytes.includes(coverArt())).toBe(false);
    expect(bytes.toString('latin1')).not.toMatch(/SYNTHETIC_PRIVATE|METADATA_BLOCK_PICTURE/);
    expect(JSON.stringify(output)).not.toMatch(/SYNTHETIC_PRIVATE|METADATA_BLOCK_PICTURE/);
  }, 60000);

  it.each([1, 5])('rejects a PNG video track with %i frames and audio when it is not flagged attached', async frames => {
    const source = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=16x16:rate=5:duration=1',
      '-f', 'lavfi', '-i', 'sine=duration=1', '-map', '1:a:0', '-map', '0:v:0', '-c:a', 'pcm_s16le',
      '-c:v', 'png', '-threads:v', '1', '-frames:v', String(frames), '-f', 'matroska', 'pipe:1']);
    const input = nativeProbe(source);
    expect(input.streams).toHaveLength(2);
    expect(input.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video')).toMatchObject({
      codec_name: 'png', disposition: { attached_pic: 0 },
    });
    expect(await rejection(source)).toBe('conversion_video_not_allowed');
  }, 60000);

  it.each([
    ['24-bit WAV', 'pcm_s24le', 'wav'], ['MP3', 'libmp3lame', 'mp3'],
    ['ADTS AAC', 'aac', 'adts'], ['ALAC M4A', 'alac', 'mp4'],
    ['WebM Opus', 'libopus', 'webm'], ['AIFF', 'pcm_s16be', 'aiff'],
  ])('converts %s with the minimal native decoder set', async (_label, codec, format) => {
    const directory = mkdtempSync(resolve('local-media/conversion-synthetic-'));
    try {
      const path = resolve(directory, 'source.audio');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
        'anoisesrc=color=white:amplitude=0.15:seed=72:sample_rate=44100:duration=2',
        '-ac', '2', '-c:a', codec, '-f', format, path]);
      const source = readFileSync(path);
      const reference = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ar', '48000', '-f', 'f32le', 'pipe:1']);
      const result = await convert(source);
      expect(result.unchanged).toBe(true);
      expect(result.channels).toBe(2);
      expect(Math.abs(result.duration - reference.length / (4 * 2 * 48000))).toBeLessThanOrEqual(1 / 48000);
      expect(nativeProbe(Buffer.from(result.base64, 'base64')).streams[0]).toMatchObject({
        codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2,
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 60000);

  it('honors Opus gain, pre-skip, last granule and AAC priming at both ends', async () => {
    const frames = 96013;
    const pcm = Buffer.alloc(frames * 4);
    let seed = 73;
    for (let frame = 0; frame < frames; frame++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const active = frame < 1800 || frame >= frames - 2200;
      pcm.writeFloatLE(active ? (seed / 0xffffffff - 0.5) * 0.4 : 0, frame * 4);
    }
    const opus = execFileSync('ffmpeg', ['-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '192k', '-f', 'ogg', 'pipe:1'], { input: pcm });
    const gained = withOpusGain(opus, -6);
    const decode = (bytes: Buffer) => {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ar', '48000', 'pipe:1'], { input: bytes });
      return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    };
    const original = decode(opus);
    const reference = decode(gained);
    expect(reference.length).toBe(frames);
    const energy = (samples: ArrayLike<number>) => Array.from(samples).reduce((sum, sample) => sum + sample * sample, 0);
    expect(Math.sqrt(energy(reference) / energy(original))).toBeCloseTo(10 ** (-6 / 20), 4);
    const result = await convert(gained);
    const windows = await page.evaluate(async ({ base64, frames }) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
      const samples = decoded.getChannelData(0);
      return [Array.from(samples.subarray(0, 4096)), Array.from(samples.subarray(frames - 4096, frames))];
    }, { base64: result.base64, frames });
    expect(result.duration).toBe(frames / 48000);
    for (const [index, offset] of [0, frames - 4096].entries()) {
      const expected = reference.subarray(offset, offset + 4096);
      let bestLag = 0; let bestScore = -Infinity;
      for (let lag = -1024; lag <= 1024; lag++) {
        let score = 0;
        for (let sample = 0; sample < expected.length; sample++) score += expected[sample] * (windows[index][sample + lag] ?? 0);
        if (score > bestScore) { bestScore = score; bestLag = lag; }
      }
      expect(Math.abs(bestLag)).toBeLessThanOrEqual(2);
      expect(Math.sqrt(energy(windows[index]) / energy(expected))).toBeGreaterThan(0.85);
      expect(Math.sqrt(energy(windows[index]) / energy(expected))).toBeLessThan(1.15);
    }
  }, 60000);

  it('rejects CENC-protected M4A explicitly', async () => {
    const directory = mkdtempSync(resolve('local-media/conversion-synthetic-'));
    try {
      const path = resolve(directory, 'protected.m4a');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac',
        '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', '000102030405060708090a0b0c0d0e0f',
        '-encryption_kid', '101112131415161718191a1b1c1d1e1f', path]);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-show_entries',
        'packet=stream_index:packet_side_data=side_data_type', '-of', 'json', path], { stdio: 'pipe' }).toString());
      expect(probe.packets.some((packet: { side_data_list?: { side_data_type: string }[] }) =>
        packet.side_data_list?.some(side => side.side_data_type === 'Encryption info'))).toBe(true);
      expect(await rejection(readFileSync(path))).toBe('conversion_protected_audio');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 60000);

  it('rejects malformed, video, multiple audio, excessive channels, duration and decoded memory', async () => {
    const video = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:duration=1',
      '-c:v', 'librav1e', '-f', 'webm', 'pipe:1']);
    const multiple = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1',
      '-map', '0:a', '-map', '0:a', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']);
    expect(await rejection(Buffer.from('not audio SYNTHETIC_PRIVATE_TAG'))).toBe('conversion_invalid_audio');
    expect(await rejection(video)).toBe('conversion_video_not_allowed');
    expect(await rejection(multiple)).toBe('conversion_multiple_audio');
    expect(await rejection(fixture('libopus', 6, 1))).toBe('conversion_channel_limit');
    expect(await rejection(fixture('libopus', 1, 361))).toBe('conversion_duration_limit');
    expect(await rejection(fixture('libopus', 2, 355))).toBe('conversion_memory_limit');
  }, 120000);

  it('aborts a real running worker and permits a subsequent conversion', async () => {
    const error = await page.evaluate(async base64 => {
      const api = (globalThis as unknown as { conversion: ConversionApi }).conversion;
      const controller = new AbortController();
      const conversion = api.convertToM4a(new File([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], 'cancel.opus'), { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      try { await conversion; return 'unexpected_success'; } catch (error) { return (error as Error).message; }
    }, fixture('libopus', 2, 30).toString('base64'));
    expect(error).toBe('conversion_aborted');
    expect((await convert(fixture('libopus', 1, 1))).duration).toBe(1);
  }, 60000);

  it('uses only explicit cached same-origin build assets for fresh workers while offline', async () => {
    const source = opusWithArtwork(1);
    const online = await convert(source);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/test-sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    });
    const before = requests.length;
    await page.context().setOffline(true);
    try {
      const offline = await convert(source);
      expect(offline.duration).toBe(2);
      expect(offline.unchanged).toBe(true);
      expect(offline.base64).toBe(online.base64);
    }
    finally { await page.context().setOffline(false); }
    expect(requests.length).toBe(before);
    const manifest = JSON.parse(String(assets.get('/.vite/manifest.json'))) as Record<string, { file: string; assets?: string[] }>;
    const listed = Object.values(manifest).flatMap(entry => [entry.file, ...entry.assets ?? []]);
    const codec = [...assets].filter(([path]) => /ffmpeg-audio-core|audio-conversion\.worker/.test(path)).map(([path, data]) => ({
      path, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex'),
      manifestListed: listed.includes(path.slice(1)),
    }));
    expect(codec.some(asset => asset.path.endsWith('.wasm') && asset.bytes > 0 && asset.bytes < 8 * 1024 * 1024)).toBe(true);
    const inventory = JSON.parse(readFileSync('frontend/public/licenses/ffmpeg-audio-core-v1-SBOM.json', 'utf8'));
    for (const extension of ['js', 'wasm']) {
      const expected = inventory.artifacts[`frontend/src/assets/codecs/ffmpeg-audio-core.${extension}`];
      expect(codec.some(asset => asset.path.endsWith(`.${extension}`) && asset.sha256 === expected.sha256 && asset.bytes === expected.bytes)).toBe(true);
    }
    expect(codec.every(asset => asset.manifestListed)).toBe(true);
    console.info('Public codec asset inventory', codec);
  }, 60000);
});

it('provides complete pinned source archives, build recipe and notices with exact artifact hashes', () => {
  const inventory = JSON.parse(readFileSync('frontend/public/licenses/ffmpeg-audio-core-v1-SBOM.json', 'utf8'));
  for (const [path, expected] of Object.entries(inventory.artifacts) as [string, { bytes: number; sha256: string }][]) {
    const bytes = readFileSync(path);
    expect(bytes.length).toBe(expected.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
  }
  const archive = `frontend/public${inventory.source}`;
  const member = (name: string, maxBuffer = 40 * 1024 * 1024) => execFileSync(python(),
    ['-c', 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', archive, name],
    { maxBuffer });
  const entries = execFileSync(python(),
    ['-c', 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', archive])
    .toString().replaceAll('\r', '').trim().split('\n');
  expect(entries).toContain('BUILD.txt');
  expect(entries).toContain('source-bundle.json');
  for (const name of ['ffmpeg', 'wrapper', 'emscripten', 'emsdk']) {
    const input = inventory.bundledInputs[name];
    const bytes = member(`downloads/${input.archive}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.sha256);
    if (name === 'wrapper' || name === 'emscripten') {
      const files = execFileSync('tar', ['-tzf', '-'], { input: bytes, maxBuffer: 2 * 1024 * 1024 }).toString();
      expect(files).not.toMatch(/\.\/(apps|test|media|site)\/|\.(ttf|woff2?|png|jpe?g|gif|svg|mp[34]|wav|webm)$/m);
    }
  }
  for (const name of ['build-audio-codec.sh', 'prepare-audio-codec.mjs', 'package-audio-codec.mjs', 'audio-codec-inputs.json']) {
    expect(member(`scripts/${name}`)).toEqual(readFileSync(`scripts/${name}`));
  }
  expect(entries.every(path => !/local-media|node_modules|\.env|\.git\//.test(path))).toBe(true);
  const notices = readFileSync(`frontend/public${inventory.notices}`, 'utf8');
  for (const required of ['GNU LESSER GENERAL PUBLIC LICENSE', 'ffmpeg.wasm MIT', 'musl libc', 'compiler-rt/LICENSE.TXT', 'FFmpeg libavcodec/opusdec.c']) {
    expect(notices).toContain(required);
  }
}, 30000);

describe('worker stream and packet admission', () => {
  const coreURL = resolve('frontend/src/assets/codecs/ffmpeg-audio-core.js');
  const audio = { codec_type: 'audio', codec_name: 'opus', channels: 2, sample_rate: '48000', duration: '1' };
  const picture = { codec_type: 'video', codec_name: 'png', duration: '999', disposition: { attached_pic: 1 } };
  const encoded = { ...audio, codec_name: 'aac', profile: 'LC', start_time: '0', disposition: { attached_pic: 0 } };
  afterEach(() => { vi.doUnmock(coreURL); vi.unstubAllGlobals(); vi.resetModules(); });

  async function workerProbe(streams: Record<string, unknown>[], options: {
    packets?: Record<string, unknown>[]; output?: Record<string, unknown>[]; overflow?: 'streams' | 'packets';
    probeError?: 'streams' | 'packets';
  } = {}) {
    const devices = new Map<number, { write(stream: unknown, buffer: Uint8Array, offset: number, length: number): number }>();
    const postMessage = vi.fn();
    let logger: (log: { message: string }) => void = () => {};
    const core = {
      FS: { writeFile: vi.fn(), readFile: () => new Uint8Array(128), stat: () => ({ size: 128 }),
        unlink: vi.fn(), mkdev: vi.fn(),
        registerDevice: (id: number, operations: { write(stream: unknown, buffer: Uint8Array, offset: number, length: number): number }) => {
          devices.set(id, operations);
        } },
      ret: 0, reset: vi.fn(), setTimeout: vi.fn(),
      setLogger: vi.fn((callback: typeof logger) => { logger = callback; }),
      ffprobe: vi.fn((...args: string[]) => {
        const packets = args.includes('-show_packets');
        const output = args.at(-1) === '/output.m4a';
        const value = packets ? { packets: options.packets ?? [{ stream_index: 0 }, { stream_index: 1 }] }
          : { streams: output ? options.output ?? [encoded] : streams, format: { format_name: output ? 'mov,mp4,m4a' : 'ogg', duration: '999' } };
        const bytes = options.overflow === (packets ? 'packets' : 'streams')
          ? new Uint8Array((packets ? 4 * 1024 * 1024 : 128 * 1024) + 1)
          : new TextEncoder().encode(JSON.stringify(value));
        devices.get(232)!.write(null, bytes, 0, bytes.length);
        if (!output && options.probeError === (packets ? 'packets' : 'streams')) {
          logger({ message: 'Invalid data while decoding SYNTHETIC_PRIVATE_TAG' });
        }
      }),
      exec: vi.fn((...args: string[]) => {
        if (args.at(-1) === '/meter.pcm') devices.get(231)!.write(null, new Uint8Array(), 0, 4 * 2 * 48000);
      }),
    };
    vi.doMock(coreURL, () => ({ default: async () => core }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0]))));
    vi.stubGlobal('postMessage', postMessage);
    vi.stubGlobal('onmessage', null);
    await import('../frontend/src/audio-conversion.worker');
    await (globalThis as unknown as { onmessage(event: { data: { blob: Blob; coreURL: string; wasmURL: string } }): Promise<void> })
      .onmessage({ data: { blob: new Blob(['synthetic']), coreURL, wasmURL: 'https://converter.invalid/core.wasm' } });
    return { reply: postMessage.mock.calls[0][0], core };
  }

  it.each([undefined, null, false, true, '1', 0, 2, -1, [], {}])('rejects a video disposition other than numeric one: %j', async attached_pic => {
    const result = await workerProbe([audio, { ...picture, disposition: { attached_pic } }]);
    expect(result.reply).toEqual({ kind: 'error', error: 'conversion_video_not_allowed' });
    expect(result.core.exec).not.toHaveBeenCalled();
    expect(result.core.ffprobe).toHaveBeenCalledTimes(1);
  });

  it('admits up to seven explicit pictures, probes all packets and maps only audio without using picture duration', async () => {
    const { duration: _duration, ...withoutDuration } = audio;
    const result = await workerProbe([withoutDuration, ...Array.from({ length: 7 }, () => picture)]);
    expect(result.reply).toMatchObject({ kind: 'complete', duration: 1 });
    const calls = result.core.ffprobe.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]).not.toContain('-show_packets');
    expect(calls[0]).not.toContain('-read_intervals');
    expect(calls[2][calls[2].indexOf('-read_intervals') + 1]).toBe('%+#1');
    expect(calls[0][calls[0].indexOf('-show_entries') + 1]).toContain(':stream_disposition=attached_pic:');
    expect(calls[1]).toContain('-show_packets');
    expect(calls[1]).not.toContain('-read_intervals');
    expect(calls[1]).not.toContain('-select_streams');
    expect(calls[0][calls[0].indexOf('-max_streams') + 1]).toBe('8');
    for (const args of result.core.exec.mock.calls) {
      expect(args[args.indexOf('-map') + 1]).toBe('0:a:0');
      expect(args).toContain('-vn');
    }
    const encode = result.core.exec.mock.calls[1];
    expect(encode[encode.indexOf('-map_metadata') + 1]).toBe('-1');
    expect(encode[encode.indexOf('-map_chapters') + 1]).toBe('-1');
  });

  it('rejects excess streams, multiple audio and unexplained probe errors even with valid pictures', async () => {
    expect((await workerProbe([audio, ...Array.from({ length: 8 }, () => picture)])).reply)
      .toEqual({ kind: 'error', error: 'conversion_invalid_audio' });
    vi.resetModules();
    expect((await workerProbe([audio, picture, audio])).reply)
      .toEqual({ kind: 'error', error: 'conversion_multiple_audio' });
    for (const probeError of ['streams', 'packets'] as const) {
      vi.resetModules();
      const result = await workerProbe([audio, picture], { probeError });
      expect(result.reply).toEqual({ kind: 'error', error: 'conversion_invalid_audio' });
      expect(result.core.ffprobe).toHaveBeenCalledTimes(2);
      expect(result.core.exec).not.toHaveBeenCalled();
    }
  });

  it.each(['audio', 'video', 'data'])('rejects encryption side data on any %s stream, including artwork', async codec_type => {
    const result = await workerProbe([audio, { ...picture, codec_type, side_data_list: [{ side_data_type: 'Encryption initialization data' }] }]);
    expect(result.reply).toEqual({ kind: 'error', error: 'conversion_protected_audio' });
    expect(result.core.exec).not.toHaveBeenCalled();
  });

  it.each(['enca', 'encv'])('rejects a protected %s stream tag before discarding artwork', async codec_tag_string => {
    const result = await workerProbe([audio, { ...picture, codec_tag_string }]);
    expect(result.reply).toEqual({ kind: 'error', error: 'conversion_protected_audio' });
  });

  it.each([0, 1])('rejects encryption on a later packet of stream %i before any decode or encode', async stream_index => {
    for (const probeError of [undefined, 'streams', 'packets'] as const) {
      vi.resetModules();
      const result = await workerProbe([audio, picture], { probeError, packets: [{ stream_index: 0 }, { stream_index: 1 },
        { stream_index, side_data_list: [{ side_data_type: 'Encryption info' }] }] });
      expect(result.reply).toEqual({ kind: 'error', error: 'conversion_protected_audio' });
      expect(result.core.exec).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, 0, 6])('detects CENC packets before rejecting untrusted channel metadata %s', async channels => {
    const streams = [{ ...audio, codec_name: 'aac', channels }];
    const encrypted = await workerProbe(streams, { packets: [
      { stream_index: 0, side_data_list: [{ side_data_type: 'Encryption info' }] },
    ] });
    expect(encrypted.reply).toEqual({ kind: 'error', error: 'conversion_protected_audio' });
    expect(encrypted.core.exec).not.toHaveBeenCalled();
    vi.resetModules();
    const unencrypted = await workerProbe(streams);
    expect(unencrypted.reply).toEqual({ kind: 'error', error: 'conversion_channel_limit' });
    expect(unencrypted.core.exec).not.toHaveBeenCalled();
  });

  it.each(['streams', 'packets'] as const)('fails closed on oversized %s JSON and cleans temporary entries', async overflow => {
    const result = await workerProbe([audio, picture], { overflow });
    expect(result.reply).toEqual({ kind: 'error', error: 'conversion_invalid_audio' });
    expect(result.core.exec).not.toHaveBeenCalled();
    expect(result.core.FS.unlink.mock.calls.map(([path]) => path)).toEqual(['/input.bin', '/output.m4a', '/probe.json', '/meter.pcm']);
  });

  it.each([
    [encoded, picture], [picture], [{ ...encoded, codec_type: 'video' }], [{ ...encoded, disposition: { attached_pic: 1 } }],
  ])('never applies the input-picture exception to encoded output %#', async (...output) => {
    const result = await workerProbe([audio, picture], { output });
    expect(result.reply).toEqual({ kind: 'error', error: 'conversion_invalid_output' });
  });
});

describe('conversion admission and worker lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('rejects oversized files before reading or starting a worker', async () => {
    const WorkerMock = vi.fn();
    const read = vi.fn();
    vi.stubGlobal('Worker', WorkerMock);
    const { convertToM4a } = await import('../frontend/src/audio-conversion');
    await expect(convertToM4a({ size: AAC_IMPORT.maxSourceBytes + 1, arrayBuffer: read } as unknown as File)).rejects.toThrow('conversion_source_limit');
    await expect(convertToM4a(new File([], 'empty'))).rejects.toThrow('conversion_invalid_audio');
    expect(read).not.toHaveBeenCalled();
    expect(WorkerMock).not.toHaveBeenCalled();
  });

  it('serializes, kills on abort, skips an aborted queued job and releases after timeout', async () => {
    vi.useFakeTimers();
    const workers: { terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('Worker', class {
      terminate = vi.fn(); postMessage = vi.fn();
      constructor() { workers.push(this); }
    });
    const { convertToM4a } = await import('../frontend/src/audio-conversion');
    const first = new AbortController(); const second = new AbortController();
    const input = new File(['source'], 'audio');
    const running = convertToM4a(input, { signal: first.signal }).catch(error => error.message);
    const queued = convertToM4a(input, { signal: second.signal }).catch(error => error.message);
    const third = convertToM4a(input).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    second.abort(); expect(await queued).toBe('conversion_aborted');
    expect(workers).toHaveLength(1);
    first.abort(); expect(await running).toBe('conversion_aborted');
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300000);
    expect(await third).toBe('conversion_timeout');
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
  });

  it('reports worker feature absence clearly without reading input', async () => {
    vi.stubGlobal('Worker', undefined);
    const { convertToM4a } = await import('../frontend/src/audio-conversion');
    await expect(convertToM4a(new File(['source'], 'audio'))).rejects.toThrow('conversion_unavailable');
  });
});