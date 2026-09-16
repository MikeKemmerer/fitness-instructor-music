import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateArtifact } from './deploy.mjs';
import { codecArtifact, codecCacheEntries, codecManifest, validateCodecDistribution,
  validateCodecManifest, validateCodecRoutes, verifyCodecResponse } from './licensed-codecs.mjs';

const root = new URL('../', import.meta.url);
const json = value => Buffer.from(JSON.stringify(value));
const buildPath = artifact => artifact.publicPath?.slice(1) ?? `assets/${artifact.buildName}-AbCd1234.${artifact.extension}`;
const source = codecManifest.artifacts.find(artifact => artifact.role === 'source');
const wasm = codecManifest.artifacts.find(artifact => artifact.role === 'wasm');
const glue = codecManifest.artifacts.find(artifact => artifact.role === 'glue');
let publicBytes;

function fixture() {
  publicBytes ??= new Map(codecManifest.artifacts.map(artifact => [buildPath(artifact), readFileSync(new URL(artifact.path, root))]));
  const config = {
    platform: { apiRuntime: 'node:22' },
    routes: [
      { route: '/api/*', allowedRoles: ['anonymous'] },
      { route: '/.auth/login/aad', statusCode: 404 },
      { route: '/.auth/login/github', statusCode: 404 },
      { route: '/.auth/me', statusCode: 404 },
      { route: source.publicPath, allowedRoles: ['anonymous'] },
      { route: '/*', allowedRoles: ['anonymous'] },
    ],
    globalHeaders: { 'X-Content-Type-Options': 'nosniff' },
    mimeTypes: { '.wasm': 'application/wasm', '.gz': 'application/gzip' },
  };
  const manifest = { 'index.html': { file: 'assets/app-AbCd1234.js', isEntry: true,
    assets: [buildPath(glue), buildPath(wasm)] } };
  const files = new Map([
    ...publicBytes,
    ['index.html', Buffer.from('<html></html>')],
    ['assets/app-AbCd1234.js', Buffer.from('export {};')],
    ['sw.js', Buffer.from('self.REHEARSAL_HOSTED = true;')],
    ['.vite/manifest.json', json(manifest)],
    ['staticwebapp.config.json', json(config)],
  ]);
  return { files, config, manifest };
}

test('exact handoff artifacts pass the release gate and all bytes count toward Free limits', () => {
  const { files } = fixture();
  assert.equal(validateCodecManifest(structuredClone(codecManifest)), codecManifest);
  const approved = validateCodecDistribution(files, { required: true });
  assert.equal(approved.size, 6);
  assert.equal(codecManifest.artifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0), 22866987);
  const report = validateArtifact(files, files.get('staticwebapp.config.json'), [], { requireCodecs: true });
  assert.equal(report.totalBytes, [...files.values()].reduce((bytes, content) => bytes + content.length, 0));
  assert(report.totalBytes > 22866987 && report.totalBytes < 250000000);
  const local = new Map(codecManifest.artifacts.map(artifact => [artifact.path, files.get(buildPath(artifact))]));
  assert.equal(validateCodecDistribution(local, { location: 'source', required: true }).size, 6);
});

test('cache descriptors include only the five pinned offline artifacts, never the archive', () => {
  const { files } = fixture();
  const entries = codecCacheEntries(validateCodecDistribution(files));
  assert.equal(entries.length, 5);
  assert.equal(entries.reduce((bytes, entry) => bytes + entry.bytes, 0), 3345591);
  assert(!entries.some(entry => entry.path.startsWith('sources/')));
  for (const entry of entries) {
    const artifact = codecArtifact(entry.path);
    assert.deepEqual(entry, { path: buildPath(artifact), bytes: artifact.bytes,
      sha256: artifact.sha256, mimeType: artifact.mimeType });
  }
  assert.throws(() => codecCacheEntries(new Map([[buildPath(source), { ...source, cache: true }]])), /Untrusted/);
});

test('the generated five-pin worker suffix accepts the complete JSON filename', () => {
  const { files } = fixture();
  const entries = codecCacheEntries(validateCodecDistribution(files));
  files.set('sw.js', Buffer.from(`self.REHEARSAL_HOSTED = true;\nself.REHEARSAL_CODECS = ${JSON.stringify(entries)};`));
  assert.equal(validateCodecDistribution(files, { required: true }).size, 6);
  const changed = entries.map(entry => entry.path.endsWith('.json') ? { ...entry, path: `${entry.path}?old=1` } : entry);
  files.set('sw.js', Buffer.from(`self.REHEARSAL_CODECS = ${JSON.stringify(changed)};`));
  assert.throws(() => validateCodecDistribution(files, { required: true }), /Unapproved/);
});

test('the pinned public SBOM ties native inputs, runtime bytes and corresponding source together', () => {
  const { files } = fixture();
  const sbom = JSON.parse(files.get(buildPath(codecManifest.artifacts.find(artifact => artifact.role === 'sbom'))));
  assert.equal(sbom.name, codecManifest.id);
  assert.equal(sbom.license, codecManifest.license);
  assert.equal(sbom.components.find(component => component.name === 'FFmpeg').version, '5.1.4');
  assert.equal(sbom.inputs.ffmpeg.commit, '4729204c17f756e186d622060088371d10b34f7e');
  for (const feature of ['gpl', 'nonfree', 'version3', 'threads']) assert.equal(sbom.features[feature], false);
  assert.equal(sbom.source, source.publicPath);
  for (const artifact of codecManifest.artifacts.filter(artifact => artifact.role !== 'sbom')) {
    assert.deepEqual(sbom.artifacts[artifact.path], { bytes: artifact.bytes, sha256: artifact.sha256 });
  }
});

test('every modified codec or license artifact fails even when the extension is generally allowed', () => {
  for (const artifact of codecManifest.artifacts) {
    const { files } = fixture();
    const changed = Buffer.from(files.get(buildPath(artifact)));
    changed[0] ^= 1;
    files.set(buildPath(artifact), changed);
    assert.throws(() => validateArtifact(files, files.get('staticwebapp.config.json'), []), /SHA256/);
  }
});

test('missing obligations, truncated bytes and the old 32 MiB core fail closed', () => {
  for (const artifact of codecManifest.artifacts) {
    const { files } = fixture();
    files.delete(buildPath(artifact));
    assert.throws(() => validateCodecDistribution(files), /Incomplete/);
  }
  for (const replacement of [Buffer.alloc(0), Buffer.alloc(wasm.bytes - 1), Buffer.alloc(32 * 1024 * 1024)]) {
    const { files } = fixture();
    files.set(buildPath(wasm), replacement);
    assert.throws(() => validateCodecDistribution(files), /byte length/);
  }
});

test('manifest changes cannot authorize new hashes, versions, paths, roles or extra fields', () => {
  for (const mutate of [
    value => { value.id = 'ffmpeg-audio-core-v2'; },
    value => { value.schemaVersion = 2; },
    value => { value.license = 'GPL-3.0'; },
    value => { value.artifacts[0].sha256 = '0'.repeat(64); },
    value => { value.artifacts[0].bytes += 1; },
    value => { value.artifacts[0].buildName = 'arbitrary'; },
    value => { value.artifacts[0].path = 'local-media/private.js'; },
    value => { value.artifacts[0].role = 'unknown'; },
    value => { value.artifacts[2].cache = true; },
    value => { value.artifacts[2].publicPath = '/sources/other.tar.gz'; },
    value => { value.artifacts[0].deploy = false; },
    value => { value.artifacts[0].unknown = true; },
    value => { value.artifacts.pop(); },
    value => { value.artifacts.push({ ...value.artifacts[0] }); },
  ]) {
    const manifest = structuredClone(codecManifest);
    mutate(manifest);
    assert.throws(() => validateCodecManifest(manifest), /Unreviewed/);
  }
});

test('unknown codecs, source archives and renamed versions are not extension exceptions', () => {
  for (const name of ['assets/arbitrary.wasm', 'assets/arbitrary.gz', 'sources/random.tar.gz',
    'sources/private.json', 'assets/ffmpeg-core-AbCd1234.js', 'assets/ffmpeg-audio-core-v2-AbCd1234.js',
    'assets/ffmpeg-audio-core.js', 'assets/ffmpeg-audio-core-AbCd1234.js/extra',
    'assets/ffmpeg-audio-core-AbCd1234.wasm?query', 'assets/../ffmpeg-audio-core-AbCd1234.js']) {
    const { files } = fixture();
    files.set(name, Buffer.from('unapproved'));
    assert.throws(() => validateArtifact(files, files.get('staticwebapp.config.json'), []), /Unapproved/);
  }
});

test('codec-free legacy fixtures pass unless required, but a core reference requires every obligation', () => {
  const { files, config } = fixture();
  for (const artifact of codecManifest.artifacts) files.delete(buildPath(artifact));
  config.routes = config.routes.filter(route => route.route !== source.publicPath);
  files.set('staticwebapp.config.json', json(config));
  files.set('.vite/manifest.json', json({}));
  assert.equal(validateCodecDistribution(files).size, 0);
  assert.throws(() => validateCodecDistribution(files, { required: true }), /Incomplete/);
  files.set('assets/app-AbCd1234.js', Buffer.from('import("./ffmpeg-audio-core-AbCd1234.js")'));
  assert.throws(() => validateCodecDistribution(files), /Incomplete/);
});

test('a complete pinned distribution cannot hide stale GPL or unreviewed runtime references', () => {
  for (const reference of ['@ffmpeg/core', '@ffmpeg/core-mt', './ffmpeg-core.js',
    '/assets/ffmpeg-core-AbCd1234.wasm', './ffmpeg-audio-core-XyZa5678.js',
    '/assets/ffmpeg-audio-core-v2-AbCd1234.wasm', `${buildPath(wasm)}?old=1`]) {
    const { files } = fixture();
    files.set('assets/app-AbCd1234.js', Buffer.from(`fetch(${JSON.stringify(reference)})`));
    assert.throws(() => validateCodecDistribution(files, { required: true }), /Unapproved/);
  }
});

test('unreviewed archive paths and archive or WASM bytes renamed as script are rejected', () => {
  for (const name of ['assets/private.zip', 'assets/private.tar', 'assets/private.tgz', 'assets/private.bz2',
    'assets/private.xz', 'assets/private.7z', 'assets/private.rar', 'assets/private.zst',
    'assets\\private.js', '/assets/private.js', 'assets/%2e%2e/private.js']) {
    const { files } = fixture();
    files.set(name, Buffer.from('fixture'));
    assert.throws(() => validateCodecDistribution(files), /Unapproved/);
  }
  for (const signature of ['0061736d01000000', '1f8b08000000', '504b03040000', '425a68393141',
    'fd377a585a00', '377abcaf271c', '526172211a07', '28b52ffd0000']) {
    const { files } = fixture();
    files.set('assets/renamed.js', Buffer.from(signature, 'hex'));
    assert.throws(() => validateCodecDistribution(files), /Unapproved/);
  }
});

test('only exact reviewed audio names and bytes remain exceptions to the static media ban', () => {
  const content = Buffer.from('synthetic licensed-audio fixture');
  const licensed = [{ buildName: 'licensed-loop', sha256: createHash('sha256').update(content).digest('hex') }];
  const { files } = fixture();
  files.set('assets/licensed-loop-AbCd1234.wav', content);
  assert.doesNotThrow(() => validateArtifact(files, files.get('staticwebapp.config.json'), licensed));
  for (const name of ['assets/private.mp3', 'assets/private.m4a', 'assets/private.aac', 'assets/private.ogg',
    'assets/private.opus', 'assets/private.flac', 'assets/private.webm', 'assets/private.mp4',
    'assets/licensed-loop-extra-AbCd1234.wav', 'assets/licensed-loop-AbCd1234/private.wav']) {
    const changed = new Map(files);
    changed.set(name, content);
    assert.throws(() => validateArtifact(changed, changed.get('staticwebapp.config.json'), licensed));
  }
  files.set('assets/licensed-loop-AbCd1234.wav', Buffer.from('unreviewed replacement'));
  assert.throws(() => validateArtifact(files, files.get('staticwebapp.config.json'), licensed));
});

test('build manifest must reference exactly the pinned runtime assets without precaching source', () => {
  for (const mutate of [
    manifest => { manifest['index.html'].assets.pop(); },
    manifest => { manifest['index.html'].assets.push('assets/unknown.wasm'); },
    manifest => { manifest['index.html'].assets.push('https://cdn.invalid/ffmpeg-audio-core.js'); },
    manifest => { manifest['index.html'].assets.push(buildPath(source)); },
    manifest => { manifest['index.html'].assets = 'not-an-array'; },
    manifest => { manifest['index.html'].assets.push(null); },
    manifest => { manifest['index.html'] = null; },
  ]) {
    const { files, manifest } = fixture();
    mutate(manifest);
    files.set('.vite/manifest.json', json(manifest));
    assert.throws(() => validateCodecDistribution(files));
  }
  const { files } = fixture();
  files.set('assets/ffmpeg-audio-core-XyZa5678.js', files.get(buildPath(glue)));
  assert.throws(() => validateCodecDistribution(files), /Duplicate/);
});

test('Vite source metadata is not a runtime URL but deployed codec references remain pinned', () => {
  const { files, manifest } = fixture();
  for (const artifact of [glue, wasm]) {
    const sourcePath = artifact.path.replace(/^frontend\//, '');
    manifest[sourcePath] = { file: buildPath(artifact), src: sourcePath,
      name: `ffmpeg-audio-core.${artifact.extension}`, names: [`ffmpeg-audio-core.${artifact.extension}`] };
  }
  files.set('.vite/manifest.json', json(manifest));
  assert.equal(validateCodecDistribution(files, { required: true }).size, 6);
  for (const artifact of [glue, wasm]) {
    const invalid = structuredClone(manifest);
    invalid['index.html'].assets.push(`assets/ffmpeg-audio-core.${artifact.extension}`);
    files.set('.vite/manifest.json', json(invalid));
    assert.throws(() => validateCodecDistribution(files, { required: true }), /Unapproved/);
  }
  files.set('.vite/manifest.json', json(manifest));
  files.set('assets/app-AbCd1234.js', Buffer.from('fetch("/assets/ffmpeg-audio-core.js")'));
  assert.throws(() => validateCodecDistribution(files, { required: true }), /Unapproved/);
});

test('exact anonymous source route and codec MIME mappings are required without shadowing', () => {
  for (const mutate of [
    config => { config.mimeTypes['.wasm'] = 'application/octet-stream'; },
    config => { delete config.mimeTypes['.gz']; },
    config => { config.routes.splice(4, 1); },
    config => { config.routes[4].route = '/sources/*'; },
    config => { config.routes.push({ route: '/sources*', allowedRoles: ['anonymous'] }); },
    config => { config.routes.push({ route: '/downloads/*.gz', allowedRoles: ['anonymous'] }); },
    config => { config.routes.push({ route: '/sources/unreviewed.tar.gz', allowedRoles: ['anonymous'] }); },
    config => { config.routes.push({ ...config.routes[4] }); },
    config => { config.routes[4].allowedRoles = ['authenticated']; },
    config => { config.routes[4].redirect = 'https://cdn.invalid/source.tar.gz'; },
    config => { config.routes[4].rewrite = '/index.html'; },
    config => { config.routes[4].statusCode = 404; },
    config => { config.routes[4].methods = ['GET']; },
    config => { config.routes.unshift({ route: '/*', allowedRoles: ['anonymous'] }); },
    config => { config.routes[4].headers = { 'Content-Type': 'text/html' }; },
    config => { config.routes[4].headers = { 'Content-Encoding': 'gzip' }; },
    config => { config.routes[4].headers = { 'X-Content-Type-Options': '' }; },
    config => { delete config.globalHeaders; },
    config => { config.routes[4].headers = { 'Cache-Control': 'private' }; },
    config => { config.globalHeaders = { 'Cache-Control': 'no-store' }; },
  ]) {
    const { files, config } = fixture();
    mutate(config);
    assert.throws(() => validateCodecRoutes(config, validateCodecDistribution(files)));
  }
});

test('private paths and static credentials still fail with an approved codec distribution', () => {
  for (const name of ['local-media/private.json', '.env', 'settings.local.json', 'assets/private.wav', 'assets/private.mp3']) {
    const { files } = fixture();
    files.set(name, Buffer.from('private fixture'));
    assert.throws(() => validateArtifact(files, files.get('staticwebapp.config.json'), []));
  }
  const { files } = fixture();
  files.set('assets/leak.js', Buffer.from(`AccountKey=${'A'.repeat(86)}==`));
  assert.throws(() => validateArtifact(files, files.get('staticwebapp.config.json'), []), /Credential-shaped/);
});

function responseFixture(artifact, options = {}) {
  const { files } = fixture();
  const url = `https://fixture.invalid/${buildPath(artifact)}`;
  const response = new Response(options.body ?? files.get(buildPath(artifact)), {
    status: options.status ?? 200,
    headers: { 'Content-Type': artifact.mimeType, 'X-Content-Type-Options': 'nosniff', ...options.headers },
  });
  Object.defineProperty(response, 'url', { value: options.url ?? url });
  return { response, url };
}

test('anonymous live responses verify all six MIME, size and hash pins', async () => {
  for (const artifact of codecManifest.artifacts) {
    const { response, url } = responseFixture(artifact);
    assert.equal((await verifyCodecResponse(response, artifact, url)).length, artifact.bytes);
  }
});

test('live redirects, incorrect MIME, malformed lengths and modified bytes fail', async () => {
  for (const options of [
    { status: 302 }, { url: 'https://cdn.invalid/core.wasm' },
    { headers: { Location: '/login' } }, { headers: { 'Content-Type': 'text/html' } },
    { headers: { 'Content-Type': 'application/wasm-not-valid' } },
    { headers: { 'Cache-Control': 'private' } },
    { headers: { 'Cache-Control': 'no-store' } },
    { headers: { 'X-Content-Type-Options': '' } },
    { headers: { 'Content-Length': `+${wasm.bytes}` } },
    { headers: { 'Content-Length': String(wasm.bytes + 1) } },
    { headers: { 'Content-Length': 'not-a-number' } },
    { body: Buffer.alloc(wasm.bytes) }, { body: Buffer.alloc(wasm.bytes - 1) },
  ]) {
    const { response, url } = responseFixture(wasm, options);
    await assert.rejects(verifyCodecResponse(response, wasm, url));
  }
});

test('source stays a downloadable gzip file while decoded HTTP-compressed runtime bytes are hash-checked', async () => {
  const downloadable = responseFixture(source, { headers: { 'Cache-Control': 'no-store' } });
  assert.equal((await verifyCodecResponse(downloadable.response, source, downloadable.url)).length, source.bytes);
  const transformed = responseFixture(source, { headers: { 'Content-Encoding': 'gzip' } });
  await assert.rejects(verifyCodecResponse(transformed.response, source, transformed.url), /transformed/);
  const decoded = responseFixture(wasm, { headers: { 'Content-Encoding': 'br', 'Content-Length': '1234' } });
  assert.equal((await verifyCodecResponse(decoded.response, wasm, decoded.url)).length, wasm.bytes);
});

test('oversized chunked response is cancelled at the pinned byte bound', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(wasm.bytes + 1)); },
    cancel() { cancelled = true; },
  });
  const { response, url } = responseFixture(wasm, { body });
  await assert.rejects(verifyCodecResponse(response, wasm, url), /exceeds byte limit/);
  assert.equal(cancelled, true);
});