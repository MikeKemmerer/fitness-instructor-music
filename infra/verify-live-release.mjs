import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineReports, inspectArtifacts, readArtifact, validateApiArtifact, validateArtifact, verifyTarget } from './deploy.mjs';
import { checkWorker } from './editor-release-check.mjs';
import { codecArtifact, verifyCodecResponse } from './licensed-codecs.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
const reports = 'local-media/deployment/editor-filler-verification-20260914';
const snapshot = 'local-media/deployment/editor-filler-library-20260914';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = name => JSON.parse(readFileSync(`${reports}/${name}.json`, 'utf8'));
const writeJson = (name, value) => writeFileSync(`${reports}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const inventory = files => [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));

function requireUpload() {
  assert.match(readFileSync(`${reports}/upload.log`, 'utf8'), /Upload completed: https:\/\/[^\s]+\. Live authorization/);
  assert.equal(process.env.REVIEWED_ARTIFACT_SHA256, readJson('artifact').artifactSHA256);
}

async function freeze() {
  assert.match(readFileSync(`${reports}/completion.log`, 'utf8'), /^EXIT_CODE=0\s*$/);
  const checks = readJson('checks');
  const artifact = inspectArtifacts();
  const files = readArtifact(resolve('frontend/dist'));
  const api = readArtifact(resolve('local-media/deployment/api'));
  const worker = await checkWorker(files);
  const screenshots = [];
  for (const width of [320, 390, 768, 844, 1024, 1440]) {
    const path = `test-results/hosted-filler-settings-${width}.png`;
    const bytes = readFileSync(path);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), width);
    assert(statSync(path).mtimeMs >= readJson('hosted-vitest').startTime, `Stale screenshot: ${path}`);
    cpSync(path, `${reports}/filler-settings-${width}.png`, { force: false, errorOnExist: true });
    screenshots.push({ width, sha256: hash(bytes), generatedDuringHostedRun: true });
  }
  let site;
  try {
    site = await verifyTarget({ subscription: process.env.AZURE_SUBSCRIPTION_ID,
      resourceGroup: process.env.AZURE_RESOURCE_GROUP, appName: process.env.SWA_NAME, environment: process.env });
  } catch { throw new Error('Exact target verification failed; raw Azure output withheld.'); }
  assert.equal(site.provider, 'SwaCli');
  assert(!existsSync(snapshot), 'Refusing to overwrite an existing preserved release.');
  mkdirSync(snapshot);
  cpSync('frontend/dist', `${snapshot}/frontend`, { recursive: true, force: false, errorOnExist: true });
  cpSync('local-media/deployment/api', `${snapshot}/api`, { recursive: true, force: false, errorOnExist: true });
  const manifests = { frontend: inventory(files), api: inventory(api) };
  assert.deepEqual(inventory(readArtifact(resolve(`${snapshot}/frontend`))), manifests.frontend);
  assert.deepEqual(inventory(readArtifact(resolve(`${snapshot}/api`))), manifests.api);
  writeJson('files', manifests);
  writeJson('artifact', { ...artifact, worker, snapshot, screenshots, tests: checks.tests,
    target: { exactApprovedTarget: true, sku: site.sku.name, provider: site.provider,
      region: site.location, settingsRead: false, keysRead: false, azureWrites: false },
    nativeProvenance: 'Exact remaining Rust dependency versions and reproducibility are unverified.' });
  console.log(JSON.stringify({ ...artifact, worker, tests: checks.tests, snapshot }, null, 2));
}

async function live() {
  requireUpload();
  const artifact = readJson('artifact');
  const manifests = readJson('files');
  const files = readArtifact(resolve(`${snapshot}/frontend`));
  const api = readArtifact(resolve(`${snapshot}/api`));
  assert.deepEqual(inventory(files), manifests.frontend);
  assert.deepEqual(inventory(api), manifests.api);
  const sourceFiles = new Map(['host.json', 'package.json', 'package-lock.json', 'dist/functions.cjs']
    .map(name => [name, readFileSync(`api/${name}`)]));
  assert.equal(combineReports(validateArtifact(files, readFileSync('frontend/public/staticwebapp.config.json'),
    JSON.parse(readFileSync('docs/licensed-media.json', 'utf8')).assets), validateApiArtifact(api, sourceFiles)).artifactSHA256,
  artifact.artifactSHA256);
  const hostname = process.env.SWA_EXPECTED_HOSTNAME;
  assert.match(hostname, /^[a-z0-9-]+\.[0-9]+\.azurestaticapps\.net$/);
  const origin = `https://${hostname}`;
  const results = [];
  async function request(path, status, headers = {}) {
    const response = await fetch(`${origin}${path}`, {
      headers, credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, status, `${path} returned ${response.status}; expected ${status}.`);
    assert.equal(response.headers.get('location'), null, `${path} redirected.`);
    const codec = codecArtifact(path.slice(1));
    const bytes = codec ? await verifyCodecResponse(response, codec, `${origin}${path}`) : Buffer.from(await response.arrayBuffer());
    results.push({ path, status, bytes: bytes.length, sha256: hash(bytes) });
    return { response, bytes };
  }
  for (const [path, headers] of [
    ['/api/auth/session', {}], ['/api/fillers', {}], ['/api/fillers/random', {}],
    ['/api/fillers', { 'x-ms-client-principal': Buffer.from(JSON.stringify({
      identityProvider: 'aad', userId: 'release-synthetic-probe', userRoles: ['anonymous', 'authenticated', 'owner'],
    })).toString('base64') }],
  ]) {
    const { response, bytes } = await request(path, 401, headers);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(JSON.parse(bytes), { error: 'signin_required' });
  }
  for (const path of ['/.auth/login/aad', '/.auth/login/github', '/local-media/release-probe']) await request(path, 404);
  await request('/staticwebapp.config.json', 404);
  for (const [path, expected] of files) {
    if (path === 'staticwebapp.config.json') continue;
    const { bytes } = await request(`/${path}`, 200);
    assert.deepEqual(bytes, expected, `Live file mismatch: ${path}`);
  }
  const { response, bytes } = await request('/', 200);
  assert.deepEqual(bytes, files.get('index.html'));
  assert.match(bytes.toString('utf8'), /Fitness Music Player/);
  const config = JSON.parse(files.get('staticwebapp.config.json'));
  for (const [name, value] of Object.entries(config.globalHeaders)) assert.equal(response.headers.get(name), value, name);
  writeJson('live', { completedAt: new Date().toISOString(), artifactSHA256: artifact.artifactSHA256,
    staticFilesMatched: files.size - 1, rootMatched: true, reservedConfiguration404: true, appliedSecurityHeadersMatch: true, results,
    authenticatedAzureTest: false, realUserDataRead: false, settingsRead: false });
  console.log(`Live verification passed: ${files.size - 1} exact public static files plus root; four API 401 JSON responses; provider/private-path 404 checks; reserved config 404 with exact applied security headers.`);
}

async function restore() {
  requireUpload();
  assert(process.env.NPM_CLI?.startsWith('/'));
  for (const [name, args] of [['restored-local-build', ['run', 'build']], ['restored-local-privacy', ['run', 'check:privacy']]]) {
    const filename = `${reports}/${name}.log`;
    const descriptor = openSync(filename, 'wx');
    let result;
    try {
      result = spawnSync(process.execPath, [process.env.NPM_CLI, ...args], {
        env: { ...process.env, VITE_HOSTED_PILOT: 'false' }, stdio: ['ignore', descriptor, descriptor],
      });
    } finally { closeSync(descriptor); }
    appendFileSync(filename, `\nEXIT_CODE=${result.status ?? 1}\n`);
    assert.equal(result.status, 0, `${name} failed.`);
  }
  assert.match(readFileSync('frontend/dist/sw.js', 'utf8'), /self\.REHEARSAL_HOSTED = false;/);
  const previews = [];
  for (const port of [5290, 5208]) {
    for (const path of ['index.html', 'sw.js']) {
      const response = await fetch(`http://127.0.0.1:${port}/${path}`, { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(`frontend/dist/${path}`));
    }
    previews.push(port);
  }
  const manifests = readJson('files');
  assert.deepEqual(inventory(readArtifact(resolve(`${snapshot}/frontend`))), manifests.frontend);
  assert.deepEqual(inventory(readArtifact(resolve(`${snapshot}/api`))), manifests.api);
  writeJson('restored', { completedAt: new Date().toISOString(), localMode: true, exactPreviewPorts: previews });
  console.log('Fresh ordinary local build and privacy passed; ports 5290 and 5208 serve exact local-mode bytes.');
}

try {
  assert.equal(Number(process.versions.node.split('.')[0]), 22);
  assert.equal(process.argv.length, 3);
  const action = { '--freeze': freeze, '--live': live, '--restore-local': restore }[process.argv[2]];
  assert(action, 'Use --freeze, --live or --restore-local.');
  await action();
  console.log('EXIT_CODE=0');
} catch (error) {
  console.error(error.message);
  console.error('EXIT_CODE=1');
  process.exitCode = 1;
}