import { beforeAll, describe, expect, test } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createServer } from 'node:https';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudApi } from '../api/src/cloud/http';
import { derivePassword } from '../api/src/cloud/auth';
import { BlobConflict, type BlobStore, type StoredBlob } from '../api/src/cloud/store';
import type { FillerRecording } from '../shared/routine';
import type { RoutineWorkingCopy } from '../frontend/src/offline';

const dist = process.env.HOSTED_TEST_DIST ? resolve(process.env.HOSTED_TEST_DIST)
  : fileURLToPath(new URL('../frontend/dist/', import.meta.url));
const worker = resolve(dist, 'sw.js');
const hosted = existsSync(worker) && /self\.REHEARSAL_HOSTED\s*=\s*true\b/.test(readFileSync(worker, 'utf8'));
const password = 'synthetic-browser-test-password';
async function openRoutineActions(page: Page) {
  const menu = page.locator('#panel-edit .editor-actions > .command-menu');
  if (!await menu.evaluate(node => (node as HTMLDetailsElement).open)) await menu.locator(':scope > summary').click();
}

async function openTrackSources(page: Page) {
  const menu = page.locator('#panel-edit .track-section-heading > .command-menu');
  if (!await menu.evaluate(node => (node as HTMLDetailsElement).open)) await menu.locator(':scope > summary').click();
}

let passwordHash: string;
let certificate: Buffer;
beforeAll(async () => {
  if (!hosted) return;
  const salt = Buffer.alloc(16, 9);
  passwordHash = `scrypt$32768$8$3$${salt.toString('hex')}$${(await derivePassword(password, salt)).toString('hex')}`;
  const directory = mkdtempSync(resolve(tmpdir(), 'fim-browser-tls-'));
  try {
    const key = resolve(directory, 'key.pem'), cert = resolve(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert], { stdio: ['ignore', 'pipe', 'pipe'] });
    certificate = Buffer.concat([readFileSync(key), readFileSync(cert)]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

class TestBlobStore implements BlobStore {
  readonly blobs = new Map<string, StoredBlob>();
  private sequence = 0;
  async verifyPrivate(): Promise<void> {}
  async get(key: string, maximum: number): Promise<StoredBlob | null> {
    const value = this.blobs.get(key);
    if (!value) return null;
    if (value.bytes.length > maximum) throw new Error('oversized_test_blob');
    return { bytes: Buffer.from(value.bytes), etag: value.etag };
  }
  async put(key: string, bytes: Buffer, expected: string | null): Promise<string> {
    const previous = this.blobs.get(key);
    if (expected === null ? !!previous : previous?.etag !== expected) throw new BlobConflict();
    const etag = `"${++this.sequence}"`;
    this.blobs.set(key, { bytes: Buffer.from(bytes), etag });
    return etag;
  }
  async delete(key: string, expected: string): Promise<void> {
    if (this.blobs.get(key)?.etag !== expected) throw new BlobConflict();
    this.blobs.delete(key);
  }
  async list(prefix: string, limit: number, cursor?: string) {
    const keys = [...this.blobs.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    return { keys: keys.slice(start, start + limit), cursor: keys.length > start + limit ? String(start + limit) : undefined };
  }
}

type Call = { path: string; method: string; status: number; completion?: Record<string, unknown> };
type Fixture = { browser: Browser; context: BrowserContext; page: Page; origin: string; calls: Call[]; expire: () => void };
type Route = { route: string; statusCode?: number; headers?: Record<string, string> };
const matches = (rule: string, path: string) => rule.endsWith('*') ? path.startsWith(rule.slice(0, -1)) : rule === path;
const contained = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
};

async function withHosted(run: (fixture: Fixture) => Promise<void>, blockWorkers = false) {
  const config = JSON.parse(readFileSync(resolve(dist, 'staticwebapp.config.json'), 'utf8')) as {
    routes: Route[]; globalHeaders: Record<string, string>; mimeTypes: Record<string, string>;
  };
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.otf': 'font/otf', '.txt': 'text/plain', ...config.mimeTypes };
  const root = realpathSync(dist);
  const calls: Call[] = [];
  const errors: string[] = [];
  let origin = '', offset = 0;
  const api = new CloudApi(new TestBlobStore(), () => ({ FIM_ORIGIN: origin,
    FIM_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${Buffer.alloc(64).toString('base64')};EndpointSuffix=core.windows.net`,
    FIM_STORAGE_CONTAINER: 'test-private-media', FIM_ACCOUNTS_JSON: JSON.stringify(['owner', 'editor', 'player'].map(role => ({
      id: role, username: role, passwordHash, role, enabled: true, authVersion: 1,
    }))),
  }), () => Date.now() + offset);
  const server = createServer({ key: certificate, cert: certificate }, async (request, response) => {
    for (const [name, value] of Object.entries(config.globalHeaders)) response.setHeader(name, value);
    try {
      let path = decodeURIComponent(new URL(request.url ?? '/', origin).pathname);
      if (path.includes('\\') || path.split('/').includes('..')) { response.writeHead(404).end(); return; }
      if (path.startsWith('/api/')) {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
        const method = request.method ?? 'GET';
        const result = await api.handle({ url: new URL(request.url!, origin).href, method, headers,
          body: ['GET', 'HEAD'].includes(method) ? null : Readable.toWeb(request) });
        calls.push({ path: request.url!, method, status: result.status,
          ...(path.endsWith('/complete') ? { completion: JSON.parse(String(result.body)) as Record<string, unknown> } : {}) });
        response.writeHead(result.status, result.headers).end(result.body);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
      const rule = config.routes.find(route => matches(route.route, path));
      for (const [name, value] of Object.entries(rule?.headers ?? {})) response.setHeader(name, value);
      if (rule?.statusCode) { response.writeHead(rule.statusCode).end(); return; }
      if (path === '/') path = '/index.html';
      const file = resolve(root, `.${path}`);
      if (!contained(root, file) || !contained(root, realpathSync(file)) || !statSync(file).isFile()) {
        response.writeHead(404).end(); return;
      }
      const bytes = readFileSync(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404).end(); }
  });
  let browser: Browser | undefined;
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_loopback_address');
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, timeout: 15_000, args: ['--ignore-certificate-errors'] });
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: blockWorkers ? 'block' : 'allow' });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.setDefaultTimeout(15_000);
    const page = await context.newPage();
    await run({ browser, context, page, origin, calls, expire: () => { offset += 13 * 3_600_000; } });
    expect(errors).toEqual([]);
  } finally {
    try { await browser?.close(); }
    finally { await new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }); }
  }
}

test.skipIf(!hosted).each([[1, 0], [2, 0], [1, 70000], [2, 2 * 1024 * 1024]])('imports synthetic Ogg Opus through the production bundle and CSP (%i channels, %i comment bytes)', async (channels, commentBytes) => {
  const encoded = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-f', 'ffmetadata', '-i', 'pipe:0',
    '-map', '0:a:0', '-map_metadata', '1', '-ac', String(channels),
    '-c:a', 'libopus', '-f', 'opus', 'pipe:1'], {
    input: `;FFMETADATA1\ncomment=${'A'.repeat(commentBytes)}\n`, maxBuffer: 4 * 1024 * 1024,
  });
  if (commentBytes >= 2 * 1024 * 1024) expect(encoded.length).toBeGreaterThan(commentBytes);
  await withHosted(async ({ page, context, origin, calls }) => {
    const policy = (await page.request.get('/')).headers()['content-security-policy'];
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
    await login(page);
    await ready(page);
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await page.getByRole('button', { name: 'New routine', exact: true }).click();
    const input = { name: 'synthetic.opus', mimeType: 'audio/opus', buffer: encoded };
    await openTrackSources(page);
    await browserExpect(page.locator('#panel-edit').getByRole('button', { name: 'Import audio', exact: true })).toBeVisible();
    await browserExpect(page.locator('#panel-edit').getByRole('button', { name: 'Import audio', exact: true })).toBeEnabled();
    const importAudio = page.locator('#app > input[type=file][aria-label="Import audio"]');
    await browserExpect(importAudio).toBeEnabled();
    await importAudio.setInputFiles(input);
    await browserExpect(page.locator('.notice')).toContainText('Imported 1 audio file', { timeout: 30000 });
    const converted = await audio(page, true);
    expect(converted).toHaveLength(1);
    const output = converted[0]!;
    expect(output.contentType).toBe('audio/mp4');
    expect(output.container).toBe('ftyp');
    expect(output.header).not.toBe('RIFF');
    expect(output.decoded).toMatchObject({ sampleRate: 48000, channels, audible: true });
    expect(Math.abs(output.decoded!.duration - 2)).toBeLessThanOrEqual(1024 / 48000);
    expect(output.bytes).toBeGreaterThan(1024);
    expect(output.bytes).toBeLessThan(2 * 256000 / 8 + 16384);
    expect(output.bytes).toBeLessThan(44 + 2 * 48000 * channels * 2);
    const bytes = Buffer.from(output.base64!, 'base64');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams',
      '-show_format', '-of', 'json', 'pipe:0'], { input: bytes }).toString()) as {
      streams: { codec_name: string; codec_type: string; profile: string; sample_rate: string; channels: number; duration: string }[];
      format: { duration: string };
    };
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({ codec_name: 'aac', codec_type: 'audio', profile: 'LC', sample_rate: '48000', channels });
    expect(Math.abs(Number(probe.streams[0]!.duration) - 2)).toBeLessThanOrEqual(1024 / 48000);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-f', 'f32le', 'pipe:1'], { input: bytes });
    expect(Math.abs(pcm.length / (4 * channels * 48000) - 2)).toBeLessThanOrEqual(1024 / 48000);
    expect(new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4).some(sample => Math.abs(sample) > 0.01)).toBe(true);
    if (commentBytes >= 2 * 1024 * 1024) {
      const pins = JSON.parse(readFileSync(worker, 'utf8').match(/self\.REHEARSAL_CODECS\s*=\s*(\[[^\n]+\]);/)![1]!) as
        { path: string; bytes: number; sha256: string; mimeType: string }[];
      expect(pins).toHaveLength(5);
      const cached = await page.evaluate(async pins => Promise.all(pins.map(async pin => {
        const response = await caches.match(new URL(pin.path, location.href));
        if (!response) return null;
        const bytes = await response.arrayBuffer();
        return { path: pin.path, bytes: bytes.byteLength, mimeType: response.headers.get('content-type')?.split(';')[0],
          sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('') };
      })), pins);
      expect(cached).toEqual(pins);
      const sourcePath = '/sources/ffmpeg-audio-core-v1-source.tar.gz';
      const source = await page.request.get(sourcePath);
      expect(source.status()).toBe(200);
      expect(source.headers()['content-type']).toBe('application/gzip');
      expect((await source.body()).byteLength).toBeGreaterThan(1024 * 1024);
      expect(await page.evaluate(async path => !!await caches.match(path), sourcePath)).toBe(false);
      await page.close();
      await context.setOffline(true);
      const offline = await context.newPage();
      await offline.goto(origin);
      await offline.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await offline.getByRole('tab', { name: 'Routines', exact: true }).click();
      await offline.getByRole('button', { name: 'New routine', exact: true }).click();
      await openTrackSources(offline);
      await browserExpect(offline.locator('#panel-edit').getByRole('button', { name: 'Import audio', exact: true })).toBeVisible();
      await browserExpect(offline.locator('#panel-edit').getByRole('button', { name: 'Import audio', exact: true })).toBeEnabled();
      const offlineImport = offline.locator('#app > input[type=file][aria-label="Import audio"]');
      await browserExpect(offlineImport).toBeEnabled();
      await offlineImport.setInputFiles(input);
      await browserExpect(offline.locator('.notice')).toContainText('Imported 1 audio file', { timeout: 30000 });
      const reimported = await audio(offline, true);
      expect(reimported).toHaveLength(2);
      expect(reimported.every(record => record.hash === output.hash && record.contentType === 'audio/mp4'
        && record.decoded?.audible && record.decoded.channels === channels)).toBe(true);
      expect(await offline.evaluate(async path => !!await caches.match(path), sourcePath)).toBe(false);
    }
    expect(calls.some(call => call.path.startsWith('/api/media'))).toBe(false);
  });
}, 120000);

async function login(page: Page, username = 'owner') {
  await page.goto('/signin.html');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await browserExpect(page.locator('.local-status')).toHaveText('CLOUD');
}
async function demo(page: Page) {
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByRole('button', { name: 'Load demo', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await browserExpect(page.locator('.notice [role="status"]')).toHaveText('Saved to cloud.');
}
async function automaticReady(page: Page) {
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await browserExpect(page.locator('.readiness')).toContainText('Audio verified on this device');
  await browserExpect(page.getByRole('button', { name: 'Start class', exact: true })).toBeEnabled();
}
const activeRoutinePointers = (page: Page) => page.evaluate(async () => new Promise<unknown[]>((accept, reject) => {
  const request = indexedDB.open('fitness-rehearsal'); request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result; const transaction = database.transaction('meta');
    const active = transaction.objectStore('meta').get('active');
    const exact = transaction.objectStore('meta').get('activeRoutineSelection');
    transaction.oncomplete = () => {
      database.close(); accept([active.result ?? null, exact.result ?? null,
        localStorage.getItem('fitness-cloud-active'), localStorage.getItem('fitness-class-active')]);
    };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  };
}));
async function closeRoutine(page: Page) {
  await page.getByRole('button', { name: 'Close routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Close routine', exact: true });
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await browserExpect(dialog).toHaveCount(0);
  await browserExpect(page.getByRole('button', { name: 'New routine', exact: true })).toBeVisible();
  await browserExpect.poll(() => activeRoutinePointers(page)).toEqual([null, null, null, null]);
}
async function setSlider(control: Locator, percent: number) {
  await browserExpect(control).toBeEnabled();
  await control.evaluate((node, value) => {
    (node as HTMLInputElement).value = String(value); node.dispatchEvent(new Event('input', { bubbles: true }));
  }, percent);
  await browserExpect(control).toHaveValue(String(percent));
}
const workingCopies = (page: Page) => page.evaluate(async () => new Promise<RoutineWorkingCopy[]>((accept, reject) => {
  const request = indexedDB.open('fitness-rehearsal'); request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result; const transaction = database.transaction('routineWorkingCopies');
    const records = transaction.objectStore('routineWorkingCopies').getAll();
    transaction.oncomplete = () => { database.close(); accept(records.result); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  };
}));
async function ready(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated');
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await browserExpect(page.locator('.local-status')).toHaveText('CLOUD');
}
const progress = async (page: Page) => Number(await page.getByRole('progressbar', { name: 'Track progress', exact: true }).getAttribute('aria-valuenow'));
async function play(page: Page) {
  await automaticReady(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await browserExpect.poll(() => progress(page)).toBeGreaterThan(0);
}
const records = (page: Page) => page.evaluate(async () => {
  if (!(await indexedDB.databases()).some(database => database.name === 'fitness-rehearsal')) return {};
  return new Promise<Record<string, number>>((accept, reject) => {
    const request = indexedDB.open('fitness-rehearsal');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, counts: Record<string, number> = {};
      const transaction = database.transaction(Array.from(database.objectStoreNames), 'readonly');
      for (const name of database.objectStoreNames) {
        const count = transaction.objectStore(name).count();
        count.onsuccess = () => { counts[name] = count.result; };
      }
      transaction.oncomplete = () => { database.close(); accept(counts); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
});
const audio = (page: Page, decode = false) => page.evaluate(async decode => {
  const blobs = await new Promise<Blob[]>((accept, reject) => {
    const request = indexedDB.open('fitness-rehearsal');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('tracks', 'readonly');
      const read = transaction.objectStore('tracks').getAll();
      transaction.oncomplete = () => { database.close(); accept(read.result.map(record => record.blob as Blob)); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
  return Promise.all(blobs.map(async blob => {
    const bytes = await blob.arrayBuffer();
    let decoded: { duration: number; sampleRate: number; channels: number; audible: boolean } | undefined;
    if (decode) {
      const context = new AudioContext({ sampleRate: 48000 });
      try {
        const buffer = await context.decodeAudioData(bytes.slice(0));
        decoded = { duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
          audible: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
            buffer.getChannelData(channel).some(sample => Math.abs(sample) > 0.01)).every(Boolean) };
      } finally { await context.close(); }
    }
    return { bytes: blob.size, contentType: blob.type, container: new TextDecoder().decode(bytes.slice(4, 8)),
      decoded, base64: decode ? btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join('')) : undefined,
      header: new TextDecoder().decode(bytes.slice(0, 4)),
      wave: new TextDecoder().decode(bytes.slice(8, 12)), pcm: new DataView(bytes).getUint16(20, true),
      audible: new Uint8Array(bytes, 44).some(value => value !== 0),
      hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('') };
  }));
}, decode);
async function screenshot(page: Page, name: string) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 },
    { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} ${viewport.width}`).toBe(true);
    await page.screenshot({ path: `test-results/hosted-${name}-${viewport.width}.png`, fullPage: true });
  }
}
async function upload(page: Page) {
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  if ((await page.locator('.draft-status').textContent())?.includes('Unsaved') || !(await workingCopies(page)).length) {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  await browserExpect.poll(async () => (await workingCopies(page)).every(copy => !copy.pendingCloud && copy.cloudBaseRevision !== null)).toBe(true);
}

function fillerWav(): Buffer {
  const sampleRate = 22050;
  const wav = Buffer.alloc(44 + sampleRate * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(sampleRate * 2, 40);
  for (let frame = 0; frame < sampleRate; frame++) wav.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 220 * frame / sampleRate)), 44 + frame * 2);
  return wav;
}

if (!hosted) test.skip('Requires frontend/dist built with VITE_HOSTED_PILOT=true', () => {});
describe.skipIf(!hosted)('built hosted browser with real CloudApi and test-only in-memory Blob storage', { timeout: 90_000 }, () => {
  test.each([false, true])('review older publication opens read-only and Return Draft preserves newer local work (pending=%s)', pendingCloud => withHosted(async ({ page, calls }) => {
    page.on('dialog', dialog => dialog.accept()); await login(page); await demo(page);
    const actions = page.locator('#panel-edit .editor-actions > .command-menu'); await browserExpect(actions).toBeVisible();
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Publish for playback', exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
    const published = (await (await page.request.get('/api/routines?published=true')).json()).routines[0] as { id: string; name: string; revision: number };
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Open cloud draft', exact: true }).click();
    await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Newer draft'); await upload(page);
    if (pendingCloud) {
      await page.route(`**/api/routines/${published.id}`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 412, contentType: 'application/json', body: JSON.stringify({ error: 'routine_conflict' }) }) : route.continue());
      await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Pending draft');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    }
    const before = (await workingCopies(page))[0]!;
    expect(before.pendingCloud).toBe(pendingCloud); expect(before.envelope.routine.revision).toBeGreaterThan(published.revision);
    const writes = calls.filter(call => call.method !== 'GET').length;
    await page.getByRole('button', { name: 'Open different routine', exact: true }).click();
    const rows = page.locator('.routine-library-row').filter({ has: page.locator('.muted', { hasText: 'Cloud / Published' }) });
    await browserExpect(rows).toHaveCount(1);
    await rows.getByRole('button', { name: `Open ${published.name}`, exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue(published.name);
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
    expect((await workingCopies(page))[0]).toEqual(before);
    await browserExpect(page.locator('.draft-identity')).toContainText('Published');
    await browserExpect(actions).toBeVisible();
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Open cloud draft', exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue(before.envelope.routine.name);
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toBeEnabled();
    expect((await workingCopies(page))[0]).toEqual(before);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writes);
  }));

  test('review audio picker Open and search are metadata-only; explicit preview closes silently and Add reuses one asset without upload', () => withHosted(async ({ page, browser, origin, calls }) => {
    page.on('dialog', dialog => dialog.accept()); await login(page); await demo(page);
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    try {
      await context.addInitScript(() => {
        type Voice = { context: AudioContext; start: number | null; stop: number | null };
        const voices: Voice[] = [];
        Object.assign(window, { pickerVoices: voices });
        const original = AudioContext.prototype.createBufferSource;
        AudioContext.prototype.createBufferSource = function () {
          const source = original.call(this); const voice: Voice = { context: this, start: null, stop: null }; voices.push(voice);
          const start = source.start.bind(source); const stop = source.stop.bind(source);
          source.start = (when = 0, offset = 0, duration?: number) => {
            voice.start = Math.max(when, voice.context.currentTime);
            if (duration === undefined) start(when, offset); else start(when, offset, duration);
          };
          source.stop = (when = 0) => { voice.stop = Math.max(when, voice.context.currentTime); stop(when); };
          return source;
        };
      });
      const cold = await context.newPage(); const errors: string[] = []; cold.on('pageerror', error => errors.push(error.message));
      cold.on('dialog', dialog => dialog.accept()); await login(cold);
      await cold.getByRole('tab', { name: 'Routines', exact: true }).click();
      await cold.getByRole('button', { name: 'New routine', exact: true }).click();
      const activeVoices = () => cold.evaluate(() => {
        const voices = (window as unknown as { pickerVoices: { context: AudioContext; start: number | null; stop: number | null }[] }).pickerVoices;
        return voices.filter(voice => voice.start !== null && voice.context.state === 'running' && voice.context.currentTime >= voice.start
          && (voice.stop === null || voice.context.currentTime < voice.stop)).length;
      });
      const start = calls.length;
      await openTrackSources(cold);
      await cold.getByRole('button', { name: 'From audio library', exact: true }).click();
      const picker = cold.getByRole('dialog', { name: 'From audio library', exact: true });
      await browserExpect(picker.locator('.audio-library-row')).toHaveCount(2);
      const title = await picker.locator('.audio-library-row').first().locator('span').first().textContent();
      expect(title).toBeTruthy();
      await picker.getByRole('searchbox').fill(title!);
      expect(calls.slice(start).filter(call => call.path.startsWith('/api/media/')).every(call => call.path === '/api/media/library')).toBe(true);
      expect(await activeVoices()).toBe(0); expect(await audio(cold)).toEqual([]);
      const selected = picker.locator('.audio-library-row').first(); await selected.getByRole('checkbox').check();
      const controls = selected;
      await controls.getByRole('button', { name: 'Play preview', exact: true }).click();
      await browserExpect.poll(activeVoices).toBe(1);
      await browserExpect(cold.locator('details[data-track-id]')).toHaveCount(0);
      expect(await workingCopies(cold)).toEqual([]);
      const downloads = calls.slice(start).filter(call => /^\/api\/media\/[^/]+\/chunks\//.test(call.path));
      expect(new Set(downloads.map(call => call.path.split('/')[3])).size).toBe(1);
      await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect.poll(activeVoices).toBe(0); await browserExpect(picker).toHaveCount(0);
      await browserExpect(cold.locator('details[data-track-id]')).toHaveCount(0);
      await openTrackSources(cold);
      await cold.getByRole('button', { name: 'From audio library', exact: true }).click();
      await browserExpect(picker.locator('.audio-library-row')).toHaveCount(2);
      await picker.getByRole('searchbox').fill(title!);
      await selected.getByRole('checkbox').check(); await controls.getByRole('button', { name: 'Play preview', exact: true }).click();
      await browserExpect.poll(activeVoices).toBe(1);
      const requests = calls.filter(call => call.path.startsWith('/api/media/')).length;
      await picker.getByRole('button', { name: 'Add selected audio', exact: true }).click();
      await browserExpect(picker).toHaveCount(0); await browserExpect(cold.locator('details[data-track-id]')).toHaveCount(1);
      await browserExpect.poll(activeVoices).toBe(0);
      expect(calls.filter(call => call.path.startsWith('/api/media/'))).toHaveLength(requests);
      expect(calls.slice(start).filter(call => call.method !== 'GET')).toEqual([]);
      await cold.getByRole('button', { name: 'Save', exact: true }).click();
      await browserExpect.poll(async () => (await workingCopies(cold))[0]?.pendingCloud).toBe(false);
      const copy = (await workingCopies(cold))[0]!;
      expect(copy.envelope.routine.tracks).toHaveLength(1);
      expect(copy.envelope.routine.tracks[0]!.cues).toEqual([]);
      const asset = Object.values(copy.envelope.media)[0]!;
      expect(asset.id).toBe(downloads[0]!.path.split('/')[3]);
      expect((await audio(cold)).every(record => record.hash === asset.sha256 && record.bytes === asset.bytes)).toBe(true);
      expect(calls.slice(start).filter(call => call.path.startsWith('/api/media/') && call.method !== 'GET')).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }));

  test.each(['delayed', 'lost'] as const)('review A in flight then B local survives a %s real commit acknowledgment', outcome => withHosted(async ({ page, context, calls }) => {
    page.on('dialog', dialog => dialog.accept()); await login(page); await demo(page); await ready(page);
    const initial = (await workingCopies(page))[0]!;
    let release!: () => void; const held = new Promise<void>(accept => { release = accept; });
    let committed!: () => void; const reachedServer = new Promise<void>(accept => { committed = accept; });
    let intercepted = false;
    await page.route(`**/api/routines/${initial.envelope.routine.id}`, async route => {
      if (route.request().method() !== 'PUT' || intercepted) { await route.continue(); return; }
      intercepted = true;
      const response = await route.fetch(); expect(response.status()).toBe(200); committed(); await held;
      if (outcome === 'lost') await route.abort('failed'); else await route.fulfill({ response });
    });
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Attempt A');
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await reachedServer;
    const other = await context.newPage();
    await other.route('**/api/**', route => route.abort('internetdisconnected'));
    await other.goto('/'); await other.getByRole('tab', { name: 'Routines', exact: true }).click();
    await other.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Local B');
    await other.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect.poll(async () => (await workingCopies(other))[0]?.envelope.routine.name).toBe('Local B');
    expect((await workingCopies(other))[0]!.cloudAttempt!.envelope.routine.name).toBe('Attempt A');
    release(); await page.unrouteAll({ behavior: 'wait' });
    if (outcome === 'lost') {
      await browserExpect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await other.unrouteAll();
      await page.reload();
    }
    await browserExpect.poll(async () => (await workingCopies(other))[0]?.pendingCloud).toBe(false);
    const final = (await workingCopies(other))[0]!;
    expect(final.envelope.routine.name).toBe('Local B'); expect(final.envelope.routine.id).toBe(initial.envelope.routine.id);
    expect(final.cloudBaseRevision).toBe(initial.cloudBaseRevision! + 2);
    expect(calls.filter(call => call.path === '/api/routines' && call.method === 'POST')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'PUT' && call.path === `/api/routines/${initial.envelope.routine.id}` && call.status === 200)).toHaveLength(2);
  }));

  test('review Save Lock Unlock Save Publish Open Draft retains the local CAS version', () => withHosted(async ({ page }) => {
    page.on('dialog', dialog => dialog.accept()); await login(page); await demo(page);
    const first = (await workingCopies(page))[0]!;
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
    await openRoutineActions(page);
    await browserExpect(page.getByRole('button', { name: 'Unlock routine', exact: true })).toBeEnabled();
    const locked = (await workingCopies(page))[0]!;
    expect(locked.localVersion).toBe(first.localVersion + 1);
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Unlock routine', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect((await workingCopies(page))[0]!.localVersion).toBe(locked.localVersion);
    await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('After unlock'); await upload(page);
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Publish for playback', exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Open cloud draft', exact: true }).click();
    await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('After publication'); await upload(page);
    const final = (await workingCopies(page))[0]!;
    expect(final.localVersion).toBe(locked.localVersion + 2); expect(final.pendingCloud).toBe(false);
    expect(final.envelope.routine.name).toBe('After publication');
  }));

  test('review existing local revision creates Cloud revision one and survives a lost create acknowledgment', () => withHosted(async ({ page, calls }) => {
    await login(page); await ready(page); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await page.getByRole('button', { name: 'Load demo', exact: true }).click();
    await page.route('**/api/**', route => route.abort('internetdisconnected'));
    for (const name of ['Local one', 'Local two', 'Local three']) {
      await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill(name);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    }
    await page.evaluate(async () => new Promise<void>((accept, reject) => {
      const request = indexedDB.open('fitness-rehearsal'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result; const transaction = database.transaction(['routines', 'routineWorkingCopies'], 'readwrite');
        const stored = transaction.objectStore('routineWorkingCopies').getAll();
        stored.onsuccess = () => {
          const copy = stored.result[0] as RoutineWorkingCopy; copy.envelope.routine.revision = 9;
          transaction.objectStore('routineWorkingCopies').put(copy, copy.envelope.routine.id);
          transaction.objectStore('routines').put(copy.envelope.routine, copy.envelope.routine.id);
        };
        transaction.oncomplete = () => { database.close(); accept(); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    }));
    await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    const initial = (await workingCopies(page))[0]!; expect(initial.envelope.routine.revision).toBe(9);
    await page.unrouteAll();
    let intercepted = false;
    let allowReadback = false;
    const routinePath = `/api/routines/${initial.envelope.routine.id}`;
    await page.route(`**${routinePath}`, route => intercepted && !allowReadback && route.request().method() === 'GET'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'storage_unavailable' }) }) : route.continue());
    await page.route('**/api/routines', async route => {
      if (route.request().method() !== 'POST' || intercepted) { await route.continue(); return; }
      intercepted = true;
      expect(route.request().postDataJSON().routine.revision).toBe(1);
      const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed');
    });
    await page.getByRole('button', { name: 'Open different routine', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh cloud', exact: true }).click();
    await browserExpect.poll(() => intercepted).toBe(true);
    await browserExpect.poll(async () => (await workingCopies(page))[0]?.cloudAttempt?.envelope.routine.revision).toBe(1);
    await browserExpect(page.getByRole('button', { name: 'Refresh cloud', exact: true })).toBeEnabled();
    const pending = (await workingCopies(page))[0]!;
    expect(pending.pendingCloud).toBe(true); expect(pending.cloudBaseRevision).toBeNull();
    const recoveryStart = calls.length; allowReadback = true;
    await page.getByRole('button', { name: 'Refresh cloud', exact: true }).click();
    await browserExpect.poll(async () => (await workingCopies(page))[0]?.pendingCloud).toBe(false);
    expect((await workingCopies(page))[0]).toMatchObject({ localVersion: pending.localVersion, cloudBaseRevision: 1,
      envelope: { routine: { id: initial.envelope.routine.id, revision: 1 } } });
    expect(calls.filter(call => call.path === '/api/routines' && call.method === 'POST')).toHaveLength(1);
    expect(calls.filter(call => call.path === routinePath && call.method === 'PUT')).toEqual([]);
    expect(calls.slice(recoveryStart).every(call => call.method === 'GET' && !call.path.startsWith('/api/media/'))).toBe(true);
  }));

  test('review explicit Cloud Delete finishes before working-copy CAS removal and preserves media', () => withHosted(async ({ page, calls }) => {
    page.on('dialog', dialog => dialog.accept()); await login(page); await demo(page);
    const initial = (await workingCopies(page))[0]!; const media = await audio(page);
    let release!: () => void; const gate = new Promise<void>(accept => { release = accept; });
    let arrived!: () => void; const reached = new Promise<void>(accept => { arrived = accept; });
    await page.route(`**/api/routines/${initial.envelope.routine.id}`, async route => {
      if (route.request().method() !== 'DELETE') { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(200); arrived(); await gate; await route.fulfill({ response });
    });
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Delete cloud routine', exact: true }).click(); await reached;
    expect(await workingCopies(page)).toHaveLength(1); release();
    await browserExpect.poll(() => workingCopies(page)).toEqual([]);
    expect(await audio(page)).toEqual(media);
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([`/api/routines/${initial.envelope.routine.id}`]);
    await browserExpect(page.getByRole('button', { name: 'New routine', exact: true })).toBeVisible();
  }));

  test('review cold cached chooser opens non-active local and Cloud publications across offline reload', () => withHosted(async ({ page, context, calls }) => {
    page.on('dialog', dialog => dialog.accept()); await login(page); await demo(page); await ready(page);
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Cached publication'); await upload(page);
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Publish for playback', exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
    await closeRoutine(page);
    await demo(page);
    await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Cached draft'); await upload(page);
    await closeRoutine(page);
    await page.getByRole('button', { name: 'Refresh cloud', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: 'Refresh cloud', exact: true })).toBeEnabled();
    expect(await activeRoutinePointers(page)).toEqual([null, null, null, null]);
    await context.setOffline(true); await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    const start = calls.length;
    const library = page.locator('.routine-library');
    await browserExpect(library).toBeVisible();
    expect(await activeRoutinePointers(page)).toEqual([null, null, null, null]);
    await library.locator('.filter-menu > summary').filter({ hasText: /^Location$/ }).click();
    await library.getByRole('checkbox', { name: 'Local', exact: true }).uncheck();
    await library.locator('.filter-menu > summary').filter({ hasText: /^Status$/ }).click();
    await library.getByRole('checkbox', { name: 'Draft', exact: true }).uncheck();
    await library.getByRole('button', { name: 'Open Cached publication', exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue('Cached publication');
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
    await automaticReady(page); await browserExpect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await page.getByRole('button', { name: 'Open different routine', exact: true }).click();
    await library.getByRole('checkbox', { name: 'Local', exact: true }).check();
    await library.getByRole('checkbox', { name: 'Cloud', exact: true }).uncheck();
    await library.getByRole('checkbox', { name: 'Draft', exact: true }).check();
    await library.getByRole('button', { name: 'Open Cached draft', exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue('Cached draft');
    const selectedCopy = (await workingCopies(page)).find(copy => copy.envelope.routine.name === 'Cached draft')!;
    await browserExpect.poll(async () => (await activeRoutinePointers(page))[0]).toBe(selectedCopy.envelope.routine.id);
    await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await browserExpect(page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue('Cached draft');
    expect(calls).toHaveLength(start);
  }));
  test('custom form rejects wrong credentials, authenticates with secure cookies, and fits desktop/mobile', () => withHosted(async ({ page, context }) => {
    await page.goto('/');
    await browserExpect(page).toHaveURL(/\/signin.html$/);
    expect(await records(page)).toEqual({});
    expect((await context.request.get('/api/routines', { headers: { 'x-ms-client-principal': 'spoofed' } })).status()).toBe(401);
    for (const path of ['/local-media/incoming/private.wav', '/.auth/me']) expect((await context.request.get(path)).status()).toBe(404);
    expect((await context.request.get('/sw.js')).status()).toBe(200);
    await screenshot(page, 'signin');
    await page.getByLabel('Username', { exact: true }).fill('owner');
    await page.getByLabel('Password', { exact: true }).fill('wrong-test-password');
    const denied = page.waitForResponse(response => response.url().endsWith('/api/auth/login'));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await denied).status()).toBe(401);
    await browserExpect(page.getByRole('alert')).toContainText('Unable to sign in');
    await browserExpect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    expect(await context.cookies()).toHaveLength(0);
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/auth/login'));
    await login(page);
    expect((await accepted).headers()['cache-control']).toContain('no-store');
    const cookies = await context.cookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(cookies[0]!.value);
    await screenshot(page, 'cloud');
  }));

  test('same stable ID relogin preserves local routines and all PCM audio', () => withHosted(async ({ context, page }) => {
    await login(page); await demo(page); await ready(page);
    const before = await records(page), bytes = await audio(page);
    const marker = await page.evaluate(() => localStorage.getItem('fitness-hosted-user'));
    const cookie = (await context.cookies())[0]!.value;
    await login(page);
    expect((await context.cookies())[0]!.value).not.toBe(cookie);
    expect(await page.evaluate(() => localStorage.getItem('fitness-hosted-user'))).toBe(marker);
    expect(await records(page)).toEqual(before);
    expect(await audio(page)).toEqual(bytes);
    await play(page);
  }));

  test('explicit logout purges private records, preferences, caches and a playing second tab', () => withHosted(async ({ context, page }) => {
    page.on('dialog', dialog => dialog.accept());
    await login(page); await demo(page); await ready(page);
    const other = await context.newPage(); await other.goto('/'); await play(other);
    await page.evaluate(() => localStorage.setItem('fitness-class-active', JSON.stringify({ id: 'synthetic-class-reference' })));
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Sign out', exact: true }).click();
    await browserExpect(page).toHaveURL(/\/signin.html$/);
    await browserExpect(other).toHaveURL(/\/signin.html$/);
    expect(await records(page)).toEqual({});
    expect(await context.cookies()).toHaveLength(0);
    expect(await page.evaluate(() => localStorage.getItem('fitness-class-active'))).toBeNull();
    expect(await page.evaluate(async () => ({ user: localStorage.getItem('fitness-hosted-user'),
      preferences: localStorage.getItem('barre.appearance.v1'),
      caches: (await caches.keys()).filter(name => name.startsWith('fitness-rehearsal')) }))).toEqual({ user: null, preferences: null, caches: [] });
  }));

  test('real account switch purges old records before the new account enters', () => withHosted(async ({ page }) => {
    await login(page); await demo(page); await ready(page);
    expect(await records(page)).toMatchObject({ routineWorkingCopies: 1, tracks: 2 });
    await login(page, 'editor');
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('fitness-hosted-user')))!)).toMatchObject({ id: 'editor' });
    expect(Object.values(await records(page)).every(count => count === 0)).toBe(true);
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await browserExpect(page.locator('details[data-track-id]')).toHaveCount(0);
  }));

  test('expiry and refresh 401 preserve real audio timers/cues; admitted reload restores the cached cloud routine and media offline', () => withHosted(async ({ page, context, expire, calls }) => {
    page.on('dialog', dialog => dialog.accept());
    await login(page); await demo(page); await upload(page); await ready(page);
    const bytes = await audio(page);
    expect(bytes).toHaveLength(2);
    expect(bytes.every(blob => blob.header === 'RIFF' && blob.wave === 'WAVE' && blob.pcm === 1 && blob.audible)).toBe(true);
    await play(page);
    const elapsed = await progress(page), clock = await page.locator('.class-clock').textContent();
    expire();
    const denied = page.waitForResponse(response => response.url().endsWith('/api/auth/session') && response.status() === 401);
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await page.getByRole('button', { name: 'Open different routine', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh cloud', exact: true }).click();
    await denied;
    await browserExpect(page.locator('.cloud-status')).toContainText('Cloud sign-in required');
    await browserExpect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close routine chooser', exact: true }).click();
    await page.getByRole('tab', { name: 'Teach', exact: true }).click();
    await browserExpect.poll(() => progress(page)).toBeGreaterThan(elapsed + 1);
    await browserExpect(page.locator('.class-clock')).not.toHaveText(clock!);
    await browserExpect(page.locator('.move-note')).toHaveText('Begin small pulses', { timeout: 10_000 });
    await browserExpect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await audio(page)).toEqual(bytes);
    await page.reload();
    await browserExpect(page.locator('.cloud-status')).toContainText('Cloud sign-in required');
    await browserExpect(page.locator('#panel-teach h1')).toHaveText('Two-song practice');
    expect(await audio(page)).toEqual(bytes);
    await context.setOffline(true); await page.reload();
    await browserExpect(page.locator('.cloud-status')).toContainText('Cloud offline');
    await play(page);
    await page.getByRole('button', { name: 'Next track', exact: true }).click();
    await browserExpect(page.locator('.playing-title')).toHaveText('Synthetic drum practice');
    await browserExpect.poll(() => progress(page)).toBeGreaterThan(0);
    expect(calls.filter(call => call.path.endsWith('/complete')).map(call => call.status)).toEqual([202, 200, 202, 200]);
  }));

  test('household Practice cue Save keeps the current prepared revision paused without autoplay or media downloads', () => withHosted(async ({ page, calls }) => {
    page.on('dialog', dialog => dialog.accept());
    await login(page, 'editor'); await demo(page); await upload(page);
    const beforeLogin = calls.length;
    await login(page, 'editor');
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await browserExpect(page.locator('.routine-library')).toBeHidden();
    await page.getByRole('button', { name: 'Open different routine', exact: true }).click();
    await browserExpect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeHidden();
    const cloudRows = page.locator('.routine-library-rows');
    await page.locator('.routine-library .filter-menu > summary').filter({ hasText: /^Location$/ }).click();
    await page.locator('.routine-library').getByRole('checkbox', { name: 'Local', exact: true }).uncheck();
    await browserExpect(cloudRows.getByRole('button', { name: 'Open Two-song practice', exact: true })).toBeVisible();
    const afterLogin = calls.slice(beforeLogin);
    expect(afterLogin.filter(call => call.path === '/api/auth/login' && call.method === 'POST')).toHaveLength(1);
    expect(afterLogin.filter(call => call.path === '/api/routines' && call.method === 'GET')).toHaveLength(1);
    expect(afterLogin.some(call => call.path.startsWith('/api/media/'))).toBe(false);
    await cloudRows.getByRole('button', { name: 'Open Two-song practice', exact: true }).click();
    await automaticReady(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(() => progress(page)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const seek = page.getByRole('slider', { name: 'Seek current song', exact: true });
    const position = await seek.getAttribute('aria-valuenow');
    const mediaReads = calls.filter(call => /^\/api\/media\/[^/]+\/chunks\//.test(call.path) && call.method === 'GET').length;
    const savedCopy = (await workingCopies(page))[0]!;
    await page.getByRole('button', { name: 'Edit cue times', exact: true }).click();
    const timing = page.getByRole('textbox', { name: 'Cue time (m:ss.s)', exact: true });
    const original = await timing.inputValue();
    await page.getByRole('button', { name: 'Move cue later', exact: true }).click();
    await browserExpect(timing).not.toHaveValue(original);
    const saveStart = calls.length;
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(page.locator('.notice [role=status]')).toHaveText('Saved to cloud.');
    const savedCalls = calls.slice(saveStart);
    await browserExpect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await browserExpect(seek).toHaveAttribute('aria-valuenow', position!);
    await browserExpect(page.locator('.snapshot-status')).toHaveText('Prepared on this device');
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await automaticReady(page);
    await browserExpect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await browserExpect(seek).toHaveAttribute('aria-valuenow', position!);
    expect(calls.filter(call => /^\/api\/media\/[^/]+\/chunks\//.test(call.path) && call.method === 'GET')).toHaveLength(mediaReads);
    const routinePath = `/api/routines/${savedCopy.envelope.routine.id}`;
    expect(calls.slice(beforeLogin).filter(call => call.path.startsWith('/api/routines'))).toEqual([
      { path: '/api/routines', method: 'GET', status: 200 },
      { path: '/api/routines?published=true', method: 'GET', status: 200 },
      { path: routinePath, method: 'GET', status: 200 },
      { path: routinePath, method: 'GET', status: 200 },
      { path: routinePath, method: 'PUT', status: 200 },
    ]);
    expect(savedCalls).toEqual([
      { path: routinePath, method: 'GET', status: 200 },
      ...savedCopy.envelope.routine.tracks.map(track => ({ path: `/api/media/${savedCopy.envelope.media[track.id]!.id}`, method: 'GET', status: 200 })),
      { path: routinePath, method: 'PUT', status: 200 },
    ]);
    expect(calls.slice(saveStart).filter(call => call.method === 'POST')).toEqual([]);
    expect(calls.filter(call => call.path.startsWith('/api/routines/') && call.method === 'PUT' && call.status === 200)).toHaveLength(1);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
  }));

  test('class authors prepare cold drafts and players restore exact published setups after source republish offline', () => withHosted(async ({ page, browser, origin, calls }) => {
    page.on('dialog', dialog => dialog.accept());
    await login(page, 'editor'); await demo(page); await upload(page);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    const panel = page.locator('.class-library');
    await panel.locator(':scope > summary').click();
    await panel.getByRole('button', { name: 'New music playlist', exact: true }).click();
    await panel.getByLabel('Playlist name', { exact: true }).fill('Shared lobby');
    await panel.locator('input[type=file]').setInputFiles({ name: 'Lobby.wav', mimeType: 'audio/wav', buffer: fillerWav() });
    await panel.getByRole('button', { name: 'Save Shared lobby to Cloud', exact: true }).click();
    await browserExpect(page.locator('.notice [role=status]')).toHaveText('Library draft saved.');
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    const sequence = page.getByRole('region', { name: 'Class sequence', exact: true });
    await sequence.getByRole('checkbox', { name: 'Walk-in music', exact: true }).check();
    const arrival = page.getByRole('region', { name: 'Walk-in music', exact: true });
    await browserExpect(arrival.getByRole('combobox', { name: 'Music playlist', exact: true }).locator('option')).toHaveCount(2);
    await arrival.getByRole('combobox', { name: 'Music playlist', exact: true }).selectOption({ label: 'Shared lobby / Cloud / Draft' });
    await sequence.getByRole('checkbox', { name: 'Pre-routine filler', exact: true }).check();
    await sequence.getByRole('checkbox', { name: 'Post-routine filler', exact: true }).check();
    await sequence.getByRole('checkbox', { name: 'Walk-out music', exact: true }).check();
    await page.getByRole('region', { name: 'Walk-out music', exact: true })
      .getByRole('combobox', { name: 'Music playlist', exact: true }).selectOption({ label: 'Shared lobby / Cloud / Draft' });
    await browserExpect(sequence.getByRole('checkbox', { checked: true })).toHaveCount(4);
    await browserExpect(page.getByRole('button', { name: 'Save class setup', exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Routine name', exact: true }).fill('Draft setup');
    const beforeSave = calls.length;
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(page.locator('.notice [role=status]')).toHaveText('Saved to cloud.');
    expect(calls.slice(beforeSave).filter(call => call.path.startsWith('/api/routines/') && call.method === 'PUT' && call.status === 200)).toHaveLength(1);
    expect(calls.slice(beforeSave).some(call => call.path === '/api/classes' && call.method === 'POST')).toBe(false);
    expect(calls.slice(beforeSave).some(call => call.path.startsWith('/api/media/') && call.method !== 'GET')).toBe(false);
    const saved = (await workingCopies(page))[0]!.envelope;
    expect(saved.routine.schemaVersion).toBe(2);
    expect(saved.routine.sequence).toMatchObject({ walkIn: { name: 'Shared lobby' }, walkOut: { name: 'Shared lobby' },
      before: { mode: 'hold' }, after: { mode: 'hold' } });
    expect(saved.routine.sequence!.walkIn!.tracks[0]!.id).not.toBe(saved.routine.sequence!.walkOut!.tracks[0]!.id);
    expect(Object.keys(saved.media)).toHaveLength(4);
    expect(saved.routine.savedAt).toEqual(expect.any(Number));
    const coldContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    try {
      const cold = await coldContext.newPage(); await login(cold, 'editor');
      await cold.getByRole('tab', { name: 'Routines', exact: true }).click();
      const start = calls.length;
      await cold.locator('.routine-library').getByRole('button', { name: 'Open Draft setup', exact: true }).click();
      await automaticReady(cold);
      await browserExpect(cold.locator('.playing-title')).toHaveText('Lobby.wav');
      const mediaCalls = calls.slice(start).filter(call => call.path.startsWith('/api/media/'));
      expect(mediaCalls.length).toBeGreaterThan(0);
      expect(mediaCalls.every(call => call.status === 200 && !call.path.includes('?'))).toBe(true);
      await cold.getByRole('tab', { name: 'Routines', exact: true }).click();
      await browserExpect(cold.locator('details[data-track-id]')).toHaveCount(2);
      await browserExpect(cold.getByRole('textbox', { name: 'Routine name', exact: true })).toBeEnabled();
    } finally { await coldContext.close(); }
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Publish for playback', exact: true }).click();
    await browserExpect(page.locator('.notice [role=status]')).toHaveText('Published to Cloud.');
    const routines = await (await page.request.get('/api/routines?published=true')).json();
    const routine = routines.routines.find((value: { name: string }) => value.name === 'Draft setup');
    expect(routine).toBeDefined();
    const playerContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    try {
      const device = await playerContext.newPage(); await login(device, 'player');
      await device.getByRole('tab', { name: 'Routines', exact: true }).click();
      const library = device.locator('.routine-library');
      const start = calls.length;
      await library.getByRole('button', { name: 'Open Draft setup', exact: true }).click();
      await browserExpect(library.getByRole('button', { name: /New |Save |Delete |Publish / })).toHaveCount(0);
      await browserExpect(device.getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
      const sequence = device.getByRole('region', { name: 'Class sequence', exact: true });
      await browserExpect(sequence.getByRole('checkbox', { checked: true })).toHaveCount(4);
      for (const checkbox of await sequence.getByRole('checkbox').all()) await browserExpect(checkbox).toBeDisabled();
      await automaticReady(device);
      await browserExpect(device.locator('.playing-title')).toHaveText('Lobby.wav');
      const requests = calls.slice(start);
      expect(requests).toContainEqual(expect.objectContaining({ path: `/api/routines/${routine.id}?published=true`, status: 200 }));
      const downloads = requests.filter(call => call.path.startsWith('/api/media/'));
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.every(call => call.status === 200
        && new URL(call.path, origin).searchParams.get('routineId') === routine.id
        && new URL(call.path, origin).searchParams.get('revision') === String(routine.revision))).toBe(true);
      expect(requests.every(call => call.method === 'GET')).toBe(true);
      await ready(device);
      await openRoutineActions(page);
      await page.getByRole('button', { name: 'Open cloud draft', exact: true }).click();
      await page.getByRole('textbox', { name: 'Routine name', exact: true }).fill('Later routine head');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await browserExpect(page.locator('.notice [role=status]')).toHaveText('Saved to cloud.');
      await openRoutineActions(page);
      await page.getByRole('button', { name: 'Publish for playback', exact: true }).click();
      await browserExpect(page.locator('.notice [role=status]')).toHaveText('Published to Cloud.');
      await playerContext.setOffline(true); await device.reload();
      await automaticReady(device);
      await browserExpect(device.locator('.playing-title')).toHaveText('Lobby.wav');
      await browserExpect(device.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
      const requestCount = calls.length;
      await device.getByRole('button', { name: 'Play', exact: true }).click();
      await device.getByRole('button', { name: 'Start Announcements', exact: true }).click();
      await device.getByRole('button', { name: 'Start Routine', exact: true }).click();
      await browserExpect(device.locator('#panel-teach h1')).toHaveText('Draft setup');
      await browserExpect.poll(() => progress(device)).toBeGreaterThan(0);
      await browserExpect(device.getByRole('button', { name: 'Edit cue times', exact: true })).toBeHidden();
      await browserExpect(device.getByRole('button', { name: 'Edit cue times', exact: true, includeHidden: true })).toBeDisabled();
      expect(calls).toHaveLength(requestCount);
      expect(calls.some(call => call.path.startsWith('/api/classes') && call.method !== 'GET')).toBe(false);
      await device.getByRole('button', { name: 'Stop', exact: true }).click();
    } finally { await playerContext.close(); }
  }));

  test('real PCM upload/publish/download reaches a player-only Edit selection view without author controls or private writes', () => withHosted(async ({ page, browser, origin, calls }) => {
    page.on('dialog', dialog => dialog.accept());
    await login(page); await demo(page);
    const originalAudio = await audio(page);
    await upload(page);
    const cueId = await page.locator('.cue-row').first().getAttribute('data-cue-id');
    const cue = page.locator(`.cue-row[data-cue-id="${cueId}"]`);
    await cue.getByRole('combobox', { name: 'Source', exact: true }).selectOption('timestamp');
    const timing = cue.getByLabel('Value', { exact: true });
    await browserExpect(timing).toHaveAttribute('type', 'text');
    const originalTime = await timing.inputValue();
    const originalNote = await cue.getByRole('textbox', { name: 'Move / note', exact: true }).inputValue();
    await timing.fill('1:60'); await timing.press('Tab');
    await openRoutineActions(page);
    const duplicate = page.getByRole('button', { name: 'Duplicate to new routine', exact: true });
    await browserExpect(duplicate).toBeDisabled();
    const writesBefore = calls.filter(call => call.method !== 'GET').length;
    await duplicate.dispatchEvent('click');
    await browserExpect(timing).toHaveValue('1:60');
    await browserExpect(cue.getByRole('textbox', { name: 'Move / note', exact: true })).toHaveValue(originalNote);
    await browserExpect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writesBefore);
    await timing.fill(originalTime); await timing.press('Tab');
    await page.locator('.analysis-details > summary').first().click();
    await setSlider(page.getByRole('slider', { name: 'Track level', exact: true }).first(), Number('1.25') * 100);
    await setSlider(page.getByRole('slider', { name: 'Filler level', exact: true }), Number('0.65') * 100);
    await upload(page);
    expect(calls.filter(call => call.path.startsWith('/api/routines/') && call.method === 'PUT' && call.status === 200)).toHaveLength(1);
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Publish for playback', exact: true }).click();
    await browserExpect(page.locator('.notice [role="status"]')).toHaveText('Published to Cloud.');
    const transferStart = calls.length;
    const device = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    const player = await device.newPage();
    const errors: string[] = [];
    player.on('pageerror', error => errors.push(error.message));
    await login(player, 'player');
    await browserExpect(player.getByRole('tab', { name: 'Routines', exact: true })).toBeVisible();
    await browserExpect(player.locator('#panel-teach .cloud-panel')).toHaveCount(0);
    await player.getByRole('tab', { name: 'Routines', exact: true }).click();
    for (const label of ['Save', 'Update existing cloud routine', 'Open cloud draft', 'Publish for playback', 'Delete cloud routine', 'Import audio']) {
      await browserExpect(player.getByRole('button', { name: label, exact: true })).toBeHidden();
    }
    await player.getByRole('button', { name: 'Refresh cloud', exact: true }).click();
    const routines = player.locator('.routine-library-rows');
    await browserExpect(routines.locator('.routine-library-row')).toHaveCount(1);
    await routines.getByRole('button', { name: 'Open Two-song practice', exact: true }).click();
    await browserExpect(player.locator('#panel-teach h1')).toHaveText('Two-song practice');
    await browserExpect(player.getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
    await player.locator('.analysis-details > summary').first().click();
    await browserExpect(player.getByRole('slider', { name: 'Track level', exact: true }).first()).toHaveValue('125');
    await browserExpect(player.getByRole('slider', { name: 'Track level', exact: true }).first()).toBeDisabled();
    await browserExpect(player.getByRole('slider', { name: 'Filler level', exact: true })).toHaveValue('65');
    await browserExpect(player.locator('.draft-identity')).toContainText('Published');
    await browserExpect(player.locator('.draft-identity')).toContainText('Last saved:');
    const originalOrder = await player.locator('details[data-track-id]').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.trackId));
    const originalStatus = await player.locator('.draft-status').textContent();
    const beforeReorder = calls.filter(call => call.method !== 'GET').length;
    const grip = player.locator('.track-reorder-grip').first();
    await browserExpect(grip).toBeDisabled();
    await grip.scrollIntoViewIfNeeded();
    const bounds = (await grip.boundingBox())!;
    const pointer = { pointerId: 17, pointerType: 'touch', button: 0, isPrimary: true,
      clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 };
    await grip.dispatchEvent('pointerdown', pointer);
    await grip.dispatchEvent('pointermove', { ...pointer, clientY: pointer.clientY + 40 });
    await grip.dispatchEvent('pointerup', { ...pointer, clientY: pointer.clientY + 40 });
    for (const key of ['ArrowUp', 'ArrowDown']) await grip.dispatchEvent('keydown', { key });
    for (const name of ['Move track up', 'Move track down']) {
      const button = player.getByRole('button', { name, exact: true, includeHidden: true }).first();
      await browserExpect(button).toBeDisabled(); await button.dispatchEvent('click');
    }
    await browserExpect(player.locator('.track-insertion-line')).toBeHidden();
    expect(await player.locator('details[data-track-id]').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.trackId))).toEqual(originalOrder);
    await browserExpect(player.locator('.draft-status')).toHaveText(originalStatus!);
    await browserExpect(player.locator('.draft-identity')).toContainText('Published');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(beforeReorder);
    expect(await audio(player)).toEqual(originalAudio);
    const downloads = calls.slice(transferStart).filter(call => call.path.startsWith('/api/media/'));
    expect(downloads.length).toBeGreaterThanOrEqual(4);
    expect(downloads.every(call => call.method === 'GET' && call.status === 200 && call.path.includes('routineId='))).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/complete')).map(call => call.completion?.pending ?? false)).toEqual([true, false, true, false]);
    const session = await (await device.request.get('/api/auth/session')).json();
    expect((await device.request.get('/api/routines')).status()).toBe(403);
    expect((await device.request.post('/api/routines', { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken }, data: {} })).status()).toBe(403);
    await screenshot(player, 'player');
    await ready(player); await device.setOffline(true); await player.reload();
    await play(player);
    await player.getByRole('button', { name: 'Next track', exact: true }).click();
    await browserExpect(player.locator('.playing-title')).toHaveText('Synthetic drum practice');
    await browserExpect.poll(() => progress(player)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await device.close();
  }));

  test('cold Prepare preserves playing audio on failure, then a fresh local draft reuses the archived exact ID without filler allocation', () => withHosted(async ({ page, browser, origin, calls, expire }) => {
    page.on('dialog', dialog => dialog.accept());
    await login(page);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    const library = page.getByRole('region', { name: 'Filler library', exact: true });
    await library.getByLabel('Recording audio file', { exact: true }).setInputFiles({ name: 'UserFiller.wav', mimeType: 'audio/wav', buffer: fillerWav() });
    await library.getByRole('button', { name: 'Upload recording to Cloud', exact: true }).click();
    await browserExpect(library.locator('.filler-library-feedback')).toHaveText('Recording saved to the Cloud filler library.');
    const recording = (await (await page.request.get('/api/fillers')).json()).fillers[0] as FillerRecording;
    await screenshot(page, 'filler-settings');

    const device = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const author = await device.newPage();
    author.on('dialog', dialog => dialog.accept());
    await login(author, 'editor'); await demo(author); await play(author);
    const elapsed = await progress(author);
    await author.getByRole('tab', { name: 'Routines', exact: true }).click();
    await author.getByRole('combobox', { name: 'Filler sound', exact: true }).selectOption(`recording:${recording.id}`);
    await author.getByRole('combobox', { name: 'Filler mode', exact: true }).selectOption('timed');
    await author.route(`**/api/media/${recording.asset.id}`, route => route.fulfill({ status: 500,
      contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }) }));
    await author.getByRole('tab', { name: 'Teach', exact: true }).click();
    await browserExpect(author.locator('.notice.notice-error')).toBeVisible();
    await browserExpect.poll(() => progress(author)).toBeGreaterThan(elapsed);
    await browserExpect(author.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    expect(await audio(author)).toHaveLength(2);
    await author.unroute(`**/api/media/${recording.asset.id}`);
    const coldStart = calls.length;
    await automaticReady(author);
    await browserExpect(author.locator('.readiness')).toContainText('Audio verified on this device');
    expect(calls.slice(coldStart)).toEqual([
      { path: `/api/media/${recording.asset.id}`, method: 'GET', status: 200 },
      { path: `/api/media/${recording.asset.id}/chunks/0`, method: 'GET', status: 200 },
    ]);
    expect(await audio(author)).toHaveLength(3);
    await author.getByRole('button', { name: 'Stop', exact: true }).click();
    await upload(author);

    await library.getByRole('button', { name: 'Remove recording', exact: true }).click();
    await browserExpect(library.locator('.filler-library-feedback')).toContainText('Recording removed');
    await author.reload();
    await author.getByRole('tab', { name: 'Routines', exact: true }).click();
    await browserExpect(author.getByRole('combobox', { name: 'Filler sound', exact: true }).locator('option:checked')).toHaveText('UserFiller (1 s)');
    await author.getByRole('textbox', { name: 'Routine name', exact: true }).fill('Retained recording');
    const freshSave = calls.length;
    await upload(author);
    const routines = await (await author.request.get('/api/routines')).json();
    const saved = await (await author.request.get(`/api/routines/${routines.routines[0].id}`)).json();
    expect(saved.routine.filler.recording).toEqual(recording);
    const writes = calls.slice(freshSave);
    expect(writes.some(call => call.path === '/api/fillers' && call.method === 'POST')).toBe(false);
    expect(writes.filter(call => call.path === '/api/media/uploads' && call.method === 'POST')).toHaveLength(0);
    expect(writes.some(call => call.method === 'PUT' && call.path.startsWith('/api/routines/'))).toBe(true);
    expect((await (await author.request.get('/api/fillers')).json()).fillers).toEqual([]);

    expire();
    expect((await author.request.get('/api/auth/session')).status()).toBe(401);
    await author.getByRole('tab', { name: 'Teach', exact: true }).click();
    const cachedStart = calls.length;
    await automaticReady(author);
    await browserExpect(author.locator('.readiness')).toContainText('Audio verified on this device');
    await author.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(() => progress(author)).toBeGreaterThan(0);
    expect(calls.slice(cachedStart)).toEqual([]);
    await device.close();
  }, true));

  test('UserFiller shares across authors, uses two-tap downloaded preview and remains published/playable after archive', () => withHosted(async ({ page, browser, origin, calls }) => {
    const wav = fillerWav();
    const observe = async (target: Page) => target.addInitScript(() => {
      const probe = { starts: 0, stops: 0 };
      Object.assign(window, { fillerProbe: probe });
      const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (this.loop && this.buffer?.duration === 1) probe.starts++;
        return start.apply(this, args);
      };
      AudioBufferSourceNode.prototype.stop = function (...args) {
        if (this.loop && this.buffer?.duration === 1) probe.stops++;
        return stop.apply(this, args);
      };
    });
    const probe = (target: Page) => target.evaluate(() => (window as unknown as { fillerProbe: { starts: number; stops: number } }).fillerProbe);
    const library = (target: Page) => target.getByRole('region', { name: 'Filler library', exact: true });
    await observe(page); await login(page); await demo(page);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await library(page).getByLabel('Recording audio file', { exact: true }).setInputFiles({ name: 'UserFiller.wav', mimeType: 'audio/wav', buffer: wav });
    const writesBefore = calls.filter(call => call.method === 'POST').length;
    page.once('dialog', dialog => dialog.dismiss());
    await library(page).getByRole('button', { name: 'Upload recording to Cloud', exact: true }).click();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(writesBefore);
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('UserFiller'); await dialog.accept(); });
    await library(page).getByRole('button', { name: 'Upload recording to Cloud', exact: true }).click();
    await browserExpect(library(page).locator('.filler-library-feedback')).toHaveText('Recording saved to the Cloud filler library.');
    const catalog = await (await page.request.get('/api/fillers')).json();
    const recording = catalog.fillers[0] as FillerRecording;
    expect(recording).toMatchObject({ name: 'UserFiller', duration: 1 });
    await browserExpect(library(page).locator('.filler-builtins li')).toHaveText([
      'Lo-fi instrumental (CC0): 120 BPM', 'Synthetic soft: 100 BPM', 'Synthetic bright: 100 BPM', 'Synthetic drums: 100 BPM',
    ]);
    const analysisPath = `/api/fillers/${recording.id}/analysis`;
    await library(page).getByLabel('Recording BPM', { exact: true }).fill('120');
    expect((await (await page.request.get(analysisPath)).json()).analysis).toBeNull();
    await library(page).getByRole('button', { name: 'Apply BPM metadata', exact: true }).click();
    await browserExpect(library(page).locator('.filler-library-feedback')).toHaveText('BPM metadata saved');
    expect((await (await page.request.get(analysisPath)).json()).analysis).toEqual({ bpm: 120, analyzer: 'manual', sha256: recording.asset.sha256 });
    await library(page).getByRole('button', { name: 'Preview filler', exact: true }).click();
    await browserExpect.poll(async () => (await probe(page)).starts).toBe(1);
    await library(page).getByRole('button', { name: 'Stop filler preview', exact: true }).click();
    const authorDevice = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    const author = await authorDevice.newPage();
    await observe(author); await login(author, 'editor');
    await author.getByRole('tab', { name: 'Routines', exact: true }).click();
    await author.getByRole('button', { name: 'New routine', exact: true }).click();
    await browserExpect(author.getByRole('combobox', { name: 'Filler sound', exact: true }).locator('option').filter({ hasText: /^UserFiller \(1 s\)$/ })).toHaveCount(1);
    await author.getByRole('tab', { name: 'Settings', exact: true }).click();
    await browserExpect(library(author).getByRole('button', { name: 'Refresh filler library', exact: true })).toBeEnabled();
    await library(author).getByRole('combobox', { name: 'Custom recordings', exact: true }).selectOption({ label: 'UserFiller (1 s)' });
    await browserExpect(library(author).getByLabel('Recording BPM', { exact: true })).toHaveValue('120');
    await library(author).getByLabel('Recording BPM', { exact: true }).fill('60');
    await library(author).getByRole('button', { name: 'Apply BPM metadata', exact: true }).click();
    await browserExpect(library(author).locator('.filler-library-feedback')).toHaveText('BPM metadata saved');
    expect((await (await page.request.get(analysisPath)).json()).analysis).toEqual({ bpm: 60, analyzer: 'manual', sha256: recording.asset.sha256 });
    const downloadStart = calls.length;
    await library(author).getByRole('button', { name: 'Preview filler', exact: true }).click();
    await browserExpect(library(author).locator('.filler-library-feedback')).toHaveText('Recording ready. Tap Preview filler to play.');
    expect((await probe(author)).starts).toBe(0);
    expect(calls.slice(downloadStart).filter(call => call.path.startsWith(`/api/media/${recording.asset.id}`)).every(call => call.status === 200)).toBe(true);
    expect((await audio(author))).toHaveLength(1);
    await library(author).getByRole('button', { name: 'Preview filler', exact: true }).click();
    await browserExpect.poll(async () => (await probe(author)).starts).toBe(1);
    await library(author).getByRole('button', { name: 'Stop filler preview', exact: true }).click();
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    const sound = page.getByRole('combobox', { name: 'Filler sound', exact: true });
    await sound.selectOption({ label: 'UserFiller (1 s)' });
    await setSlider(page.getByRole('slider', { name: 'Filler level', exact: true }), Number('0.5') * 100);
    await page.getByRole('combobox', { name: 'Filler mode', exact: true }).selectOption('timed');
    await page.getByRole('spinbutton', { name: 'Filler duration (seconds)', exact: true }).fill('2');
    await page.getByRole('group', { name: 'Between tracks', exact: true }).getByRole('spinbutton', { name: 'Crossfade (seconds)', exact: true }).fill('0');
    page.on('dialog', dialog => dialog.accept());
    await upload(page);
    await openRoutineActions(page);
    await page.getByRole('button', { name: 'Publish for playback', exact: true }).click();
    await browserExpect(page.locator('.notice [role="status"]')).toHaveText('Published to Cloud.');
    await play(page);
    await page.getByRole('button', { name: 'Hold', exact: true }).click();
    await page.getByRole('slider', { name: 'Seek current song', exact: true }).press('End');
    await browserExpect(page.locator('.playing-title')).toHaveText('Filler');
    const playing = await probe(page);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await browserExpect(library(page).getByRole('button', { name: 'Refresh filler library', exact: true })).toBeEnabled();
    await library(page).getByRole('combobox', { name: 'Custom recordings', exact: true }).selectOption({ label: 'UserFiller (1 s)' });
    await library(page).getByRole('button', { name: 'Remove recording', exact: true }).click();
    await browserExpect(library(page).locator('.filler-library-feedback')).toContainText('Recording removed');
    expect(await probe(page)).toEqual(playing);
    await library(author).getByRole('button', { name: 'Refresh filler library', exact: true }).click();
    await browserExpect(library(author).getByRole('combobox', { name: 'Custom recordings', exact: true }).locator('option')).toHaveCount(1);
    const clock = await page.locator('.class-clock').textContent();
    await page.route('**/api/fillers', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) }));
    await library(page).getByRole('button', { name: 'Refresh filler library', exact: true }).click();
    await browserExpect(library(page).locator('.filler-library-status')).toContainText('Cloud access denied');
    await browserExpect(page.locator('.class-clock')).not.toHaveText(clock!);
    expect(await probe(page)).toEqual(playing);
    await page.unroute('**/api/fillers');
    const device = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    const player = await device.newPage();
    await observe(player); await login(player, 'player');
    const playerStart = calls.length;
    await player.getByRole('tab', { name: 'Settings', exact: true }).click();
    await browserExpect(library(player)).toBeHidden();
    await player.getByRole('tab', { name: 'Routines', exact: true }).click();
    await player.getByRole('button', { name: 'Refresh cloud', exact: true }).click();
    const publication = (await (await page.request.get('/api/routines?published=true')).json()).routines[0] as { id: string; revision: number };
    const publicationId = publication.id;
    await player.locator('.routine-library-rows').getByRole('button', { name: 'Open Two-song practice', exact: true }).click();
    await browserExpect(player.getByRole('combobox', { name: 'Filler sound', exact: true }).locator('option:checked')).toHaveText('UserFiller (1 s)');
    await browserExpect(player.getByRole('slider', { name: 'Filler level', exact: true })).toHaveValue('50');
    const assetGets = calls.slice(playerStart).filter(call => call.path.startsWith(`/api/media/${recording.asset.id}`));
    expect(assetGets.length).toBeGreaterThanOrEqual(2);
    expect(assetGets.every(call => call.method === 'GET' && call.status === 200
      && new URL(call.path, origin).searchParams.get('routineId') === publicationId
      && new URL(call.path, origin).searchParams.get('revision') === String(publication.revision))).toBe(true);
    expect(calls.slice(playerStart)).toContainEqual(expect.objectContaining({ path: `/api/routines/${publicationId}?published=true`, method: 'GET', status: 200 }));
    expect(calls.slice(playerStart).some(call => call.path.startsWith('/api/fillers'))).toBe(false);
    await automaticReady(player);
    await player.evaluate(async id => new Promise<void>((accept, reject) => {
      const request = indexedDB.open('fitness-rehearsal');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('tracks', 'readwrite');
        transaction.objectStore('tracks').delete(`filler-${id}`);
        transaction.oncomplete = () => { database.close(); accept(); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    }), recording.asset.id);
    const prepareStart = calls.length;
    await player.reload();
    await play(player);
    const coldRequests = calls.slice(prepareStart);
    expect(coldRequests.filter(call => call.path.startsWith('/api/media/'))).toEqual([
      { path: `/api/media/${recording.asset.id}?routineId=${publicationId}&revision=${publication.revision}`, method: 'GET', status: 200 },
      { path: `/api/media/${recording.asset.id}/chunks/0?routineId=${publicationId}&revision=${publication.revision}`, method: 'GET', status: 200 },
    ]);
    expect(coldRequests.every(call => call.method === 'GET')).toBe(true);
    expect(coldRequests.some(call => call.path.startsWith('/api/fillers'))).toBe(false);
    await ready(player); await device.setOffline(true); await player.reload();
    await browserExpect(player.locator('.cloud-status')).toContainText('Cloud offline');
    const offlineRequests: string[] = [];
    player.on('requestfailed', request => offlineRequests.push(request.url()));
    await player.evaluate(() => {
      const requests: string[] = [];
      Object.assign(window, { offlineFetches: requests });
      const fetcher = window.fetch;
      window.fetch = (...args) => { requests.push(String(args[0])); return fetcher(...args); };
    });
    await play(player);
    await player.getByRole('slider', { name: 'Seek current song', exact: true }).press('End');
    await browserExpect(player.locator('.playing-title')).toHaveText('Filler');
    await browserExpect.poll(async () => (await probe(player)).starts).toBeGreaterThan(0);
    await browserExpect(player.locator('.playing-title')).toHaveText('Synthetic drum practice');
    expect(offlineRequests).toEqual([]);
    expect(await player.evaluate(() => (window as unknown as { offlineFetches: string[] }).offlineFetches)).toEqual([]);
    await device.close(); await authorDevice.close();
  }));

  test('session invalidation cancels a pending actual PDF before its delayed font response resolves', () => withHosted(async ({ page }) => {
    await login(page); await demo(page);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const waiting = new Promise<void>(resolve => { requested = resolve; });
    const downloads: string[] = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));
    await page.route('**/*.ttf', async route => {
      const response = await route.fetch(); requested();
      await held; await route.fulfill({ response });
    });
    await page.locator('.export-section > summary').click();
    await page.getByRole('button', { name: 'Export PDF packet', exact: true }).click();
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await waiting;
    await browserExpect(page.getByRole('button', { name: 'Download', exact: true })).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => window.dispatchEvent(new Event('fitness-hosted-invalidate')));
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    const delivered = page.waitForResponse(response => response.url().endsWith('.ttf'));
    release(); await (await delivered).finished();
    await page.waitForLoadState('networkidle');
    expect(downloads).toEqual([]);
    await browserExpect(page.getByRole('button', { name: 'Export PDF packet', exact: true })).toBeDisabled();
  }, true));
});