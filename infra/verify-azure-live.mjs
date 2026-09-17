import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectArtifacts, readArtifact } from './deploy.mjs';
import { codecArtifact, verifyCodecResponse } from './licensed-codecs.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function verifyPublicRelease({ hostname, files }, request = fetch) {
  assert.match(hostname, /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[0-9]+)?\.azurestaticapps\.net$/);
  const origin = `https://${hostname}`;
  const results = [], failures = [];
  const config = JSON.parse(files.get('staticwebapp.config.json'));
  async function check(path, status, expected, headers = {}, api = false) {
    try {
      const url = `${origin}${path}`;
      const response = await request(url, { headers, credentials: 'omit', cache: 'no-store', redirect: 'manual',
        signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, status, 'Unexpected HTTP status.');
      assert.equal(response.headers.get('location'), null, 'Unexpected redirect.');
      let bytes;
      const codec = codecArtifact(path.slice(1));
      if (codec) bytes = await verifyCodecResponse(response, codec, url);
      else {
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body ?? []) {
          length += chunk.length;
          assert(length <= (expected?.length ?? 4096), 'Oversized live response.');
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      }
      if (expected) assert.deepEqual(bytes, expected, 'Live bytes differ from the reviewed artifact.');
      if (api) {
        assert.match(response.headers.get('content-type') ?? '', /application\/json/);
        assert.match(response.headers.get('cache-control') ?? '', /no-store/);
        assert.deepEqual(JSON.parse(bytes), { error: 'signin_required' });
      }
      if (path === '/') {
        for (const [name, value] of Object.entries(config.globalHeaders)) assert.equal(response.headers.get(name), value, name);
      }
      results.push({ path, status, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (error) {
      failures.push({ path, reason: error.message.split('\n')[0] });
    }
  }
  for (const path of ['/api/auth/session', '/api/routines', '/api/playlists', '/api/classes', '/api/fillers', '/api/fillers/release-probe',
    '/api/media/library', '/api/fillers/release-probe/analysis']) await check(path, 401, undefined, {}, true);
  await check('/api/routines', 401, undefined, { 'x-ms-client-principal': Buffer.from(JSON.stringify({
    identityProvider: 'aad', userId: 'synthetic-release-probe', userRoles: ['anonymous', 'authenticated', 'owner'],
  })).toString('base64') }, true);
  for (const path of ['/.auth/login/aad', '/.auth/login/github', '/.auth/me', '/local-media/release-probe', '/staticwebapp.config.json']) {
    await check(path, 404);
  }
  for (const [path, bytes] of files) {
    if (path !== 'staticwebapp.config.json') await check(`/${path}`, 200, bytes);
  }
  await check('/', 200, files.get('index.html'));
  return { status: failures.length ? 'LIVE_WITH_VERIFICATION_FAILURES' : 'LIVE_VERIFIED',
    completedAt: new Date().toISOString(), results, failures, authenticatedAzureTest: false,
    physicalDeviceTest: false, privateDataRead: false, azureWrites: false, previewRestoration: false };
}

async function main() {
  assert.equal(process.argv.length, 2, 'This command only verifies an already uploaded release.');
  const artifact = inspectArtifacts();
  assert.equal(process.env.REVIEWED_ARTIFACT_SHA256, artifact.artifactSHA256, 'Review the current combined artifact before live verification.');
  assert.match(process.env.RELEASE_REPORT_NAME ?? '', /^[a-z0-9][a-z0-9-]+$/);
  const reports = resolve(root, 'local-media/deployment', process.env.RELEASE_REPORT_NAME);
  mkdirSync(reports, { recursive: true, mode: 0o700 });
  const receipt = { ...await verifyPublicRelease({ hostname: process.env.SWA_EXPECTED_HOSTNAME,
    files: readArtifact(resolve(root, 'frontend/dist')) }), artifactSHA256: artifact.artifactSHA256 };
  writeFileSync(resolve(reports, 'live.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`${receipt.status}: ${receipt.results.length} checks passed; ${receipt.failures.length} failed.`);
  for (const failure of receipt.failures) console.error(`${failure.path}: ${failure.reason}`);
  if (receipt.failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}