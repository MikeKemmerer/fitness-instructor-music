import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import { inspectArtifacts, readArtifact, validateArtifact, verifyTarget } from './deploy.mjs';
import { validateCodecDistribution } from './licensed-codecs.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
const prefix = 'test-results/editor-release-';
const snapshot = 'local-media/deployment/editor-audio-polish-20260914';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function requireExit(gate) {
  assert(/EXIT_CODE=0\s*$/.test(readFileSync(`${prefix}${gate}.log`, 'utf8')), `${gate} is incomplete or failed.`);
}

function requireIdle() {
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)) {
    let argv;
    try {
      if (!readlinkSync(`/proc/${pid}/cwd`).startsWith(root)) continue;
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch { continue; }
    assert(!argv.some(value => /(?:vitest\.mjs|@playwright\/test\/cli\.js|infra\/stage\.mjs|infra\/editor-release-check\.mjs)$/.test(value)),
      `Verification process ${pid} remains active; do not duplicate it.`);
  }
}

export async function checkWorker(files) {
  const names = [...files.keys()].filter(name => /loudness\.worker.*\.js$/.test(name));
  assert.equal(names.length, 1);
  const source = files.get(names[0]).toString('utf8');
  const encoded = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/.exec(source);
  assert(encoded);
  const wasm = Buffer.from(encoded[1], 'base64');
  assert.deepEqual(wasm, readFileSync('frontend/node_modules/ebur128-wasm/ebur128_wasm_bg.wasm'));
  assert.equal(JSON.parse(readFileSync('frontend/node_modules/ebur128-wasm/package.json', 'utf8')).version, '3.0.0');
  validateCodecDistribution(files);
  const manifest = JSON.parse(files.get('.vite/manifest.json'));
  assert(Object.values(manifest).flatMap(entry => [entry.file, ...entry.assets ?? []]).includes(names[0]));
  const ast = ts.createSourceFile('worker.ts', readFileSync('frontend/src/loudness.worker.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  let native;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'nativeLicense') {
      assert(ts.isNoSubstitutionTemplateLiteral(node.initializer));
      native = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert(native);
  const license = `${readFileSync('frontend/node_modules/ebur128-wasm/LICENSE', 'utf8')}\n${native}`;
  const config = JSON.parse(files.get('staticwebapp.config.json'));
  const server = createServer((_request, response) => {
    for (const [name, value] of Object.entries(config.globalHeaders)) response.setHeader(name, value);
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Release verification</title>');
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.context().setOffline(true);
    const measured = await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url);
      const request = message => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker_timeout')), 15000);
        worker.onmessage = event => {
          clearTimeout(timer);
          event.data.kind === 'error' ? reject(new Error(event.data.error)) : resolve(event.data);
        };
        worker.onerror = () => { clearTimeout(timer); reject(new Error('worker_error')); };
        worker.postMessage(message);
      });
      try {
        const ready = await request({ kind: 'start', frames: 44100, channels: 1, sampleRate: 44100 });
        for (let offset = 0; offset < 44100; offset += 32768) {
          const samples = Float32Array.from({ length: Math.min(32768, 44100 - offset) },
            (_, index) => 0.1 * Math.sin(2 * Math.PI * 1000 * (offset + index) / 44100));
          await request({ kind: 'samples', offset, samples: [samples] });
        }
        return { ready, result: await request({ kind: 'finish' }) };
      } finally { worker.terminate(); URL.revokeObjectURL(url); }
    }, source);
    assert.equal(measured.ready.license, license);
    assert.equal(measured.result.kind, 'result');
    assert(Math.abs(measured.result.integratedLufs + 23.003) < 0.2);
    return { file: names[0], wasmBytes: wasm.length, wasmSHA256: hash(wasm), licenseSHA256: hash(license),
      exactSourceNotices: true, shippedCsp: true, offlineChromium: true, integratedLufs: measured.result.integratedLufs };
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

function runLocal(gate, args) {
  const filename = `${prefix}${gate}.log`;
  const descriptor = openSync(filename, 'wx');
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      env: { ...process.env, VITE_HOSTED_PILOT: 'false' }, stdio: ['ignore', descriptor, descriptor],
    });
  } finally { closeSync(descriptor); }
  appendFileSync(filename, `\nEXIT_CODE=${result.status ?? 1}\n`);
  assert.equal(result.status, 0, `${gate} failed.`);
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--preserve-and-restore-local']);
  assert.equal(Number(process.versions.node.split('.')[0]), 22);
  assert(process.env.NPM_CLI?.startsWith('/'));
  requireIdle();
  const gates = ['license', 'api', 'security', 'typecheck', 'api-typecheck', 'api-build', 'local-build',
    'local-privacy', 'local-vitest', 'playwright', 'hosted-build', 'hosted-vitest', 'hosted-privacy', 'infra', 'stage', 'artifact'];
  gates.forEach(requireExit);
  const tests = {};
  for (const gate of ['license', 'api', 'security', 'local-vitest', 'hosted-vitest']) {
    const report = JSON.parse(readFileSync(`${prefix}${gate}.json`, 'utf8'));
    assert.equal(report.success, true);
    assert.equal(report.numFailedTests, 0);
    tests[gate] = { passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests };
    if (gate === 'hosted-vitest') {
      assert.equal(report.numPendingTests, 0);
      tests.hostedBrowser = report.testResults.find(result => result.name.endsWith('/hosted-browser.test.ts')).assertionResults.length;
    }
  }
  const playwright = JSON.parse(readFileSync(`${prefix}playwright.json`, 'utf8'));
  assert.equal(playwright.stats.expected, 11);
  for (const key of ['unexpected', 'flaky', 'skipped']) assert.equal(playwright.stats[key], 0);
  assert.equal(playwright.errors.length, 0);
  tests.playwright = playwright.stats;
  const infraLog = readFileSync(`${prefix}infra.log`, 'utf8');
  tests.infra = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => {
    const match = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(infraLog);
    assert(match);
    return [key, Number(match[1])];
  }));
  const artifact = inspectArtifacts();
  const files = readArtifact(resolve('frontend/dist'));
  const worker = await checkWorker(files);
  let site;
  try {
    site = await verifyTarget({ subscription: process.env.AZURE_SUBSCRIPTION_ID,
      resourceGroup: process.env.AZURE_RESOURCE_GROUP, appName: process.env.SWA_NAME, environment: process.env });
    assert.equal(site.provider, 'SwaCli');
  } catch { throw new Error('Exact target verification failed; Azure output withheld. No settings or keys requested.'); }
  if (!existsSync(snapshot)) cpSync('frontend/dist', snapshot, { recursive: true, errorOnExist: true, force: false });
  const validateSnapshot = () => validateArtifact(readArtifact(resolve(snapshot)),
    readFileSync('frontend/public/staticwebapp.config.json'), JSON.parse(readFileSync('docs/licensed-media.json', 'utf8')).assets);
  assert.deepEqual(validateSnapshot(), artifact.frontend);
  const release = { ...artifact, frontendSnapshot: snapshot, apiStage: 'local-media/deployment/api', worker,
    status: 'prepared-not-approved-not-deployed', target: { exactSubscriptionArmIdHostname: true,
      sku: site.sku.name, provider: site.provider, region: site.location, repositoryLinked: Boolean(site.repositoryUrl),
      settingsRead: false, keysRead: false, azureWrites: false } };
  writeFileSync(`${prefix}artifact.json`, `${JSON.stringify(release, null, 2)}\n`, { flag: 'wx' });
  const fileManifest = entries => [...entries].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  writeFileSync(`${prefix}files.json`, `${JSON.stringify({ frontend: fileManifest(files),
    api: fileManifest(readArtifact(resolve('local-media/deployment/api'))) }, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(`${prefix}freeze.log`, 'Exact worker, CSP, notices, target and preserved frontend verified.\nEXIT_CODE=0\n', { flag: 'wx' });
  runLocal('restored-local-build', [process.env.NPM_CLI, 'run', 'build']);
  runLocal('restored-local-privacy', [process.env.NPM_CLI, 'run', 'check:privacy']);
  for (const [url, path] of [['/', 'frontend/dist/index.html'], ['/sw.js', 'frontend/dist/sw.js']]) {
    const response = await fetch(`http://127.0.0.1:5290${url}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(path));
  }
  assert(/self\.REHEARSAL_HOSTED = false;/.test(readFileSync('frontend/dist/sw.js', 'utf8')));
  assert.deepEqual(validateSnapshot(), artifact.frontend);
  writeFileSync(`${prefix}preview.log`, 'Port 5290 serves exact fresh local bytes; preserved hosted snapshot unchanged.\nEXIT_CODE=0\n', { flag: 'wx' });
  requireIdle();
  const summary = { status: 'verified-candidate-awaiting-lead-hash-approval', completedAt: new Date().toISOString(),
    node: process.version, tests, artifact: release, gates: [...gates, 'freeze', 'restored-local-build', 'restored-local-privacy', 'preview'],
    currentFrontendDist: 'Fresh local build; restore the preserved hosted snapshot before deployment and recheck the combined hash.',
    preview: 'http://localhost:5290/', verificationRunnersRemaining: 0, applicationSourceEdits: false,
    gitChanges: false, azureWrites: false, accountStorageSettingsReads: false };
  writeFileSync(`${prefix}summary.json`, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(() => appendFileSync(`${prefix}completion.log`, 'EXIT_CODE=0\n')).catch(error => {
  appendFileSync(`${prefix}completion.log`, `${error.message}\nEXIT_CODE=1\n`);
  console.error(error.message);
  process.exitCode = 1;
});