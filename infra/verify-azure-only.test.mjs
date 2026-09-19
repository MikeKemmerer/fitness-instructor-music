import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertBuildMode, assertSourceCoverage, collectScreenshots, failedGateReport, failedTests, requiredPlaywrightTests,
  prepareSyntheticWorkspace, verificationEnvironment, verificationPlan } from './verify-azure-only.mjs';
import { verifyPublicRelease } from './verify-azure-live.mjs';

test('browser gates require isolated GitHub CI and private opt-ins fail closed', () => {
  assert.throws(() => verificationEnvironment({}, true), /GitHub CI only/);
  assert.throws(() => verificationEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, true));
  for (const key of ['PRIVATE_AUDIO_DIR', 'MIGRATION_LIVE_API_DIRECTORY', 'REHEARSAL_HTTPS_CERT', 'REHEARSAL_HTTPS_KEY']) {
    assert.throws(() => verificationEnvironment({ [key]: '/private' }, false));
  }
  const environment = verificationEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    FIM_ACCOUNTS_JSON: 'private', AZURE_CLIENT_SECRET: 'private', HOSTED_TEST_DIST: '/stale', VITE_HOSTED_PILOT: 'true' }, true);
  assert.equal(environment.VITE_HOSTED_PILOT, 'false');
  for (const key of ['FIM_ACCOUNTS_JSON', 'AZURE_CLIENT_SECRET', 'HOSTED_TEST_DIST']) assert.equal(environment[key], undefined);
});

test('plans serial fresh builds with hosted artifact isolation and no local browsers or installs', () => {
  const options = { npmCli: '/toolchain/npm-cli.js', reports: '/reports' };
  const local = verificationPlan({ ...options, ci: false });
  for (const name of ['local-vitest', 'hosted-vitest', 'playwright', 'stage']) assert(!local.some(gate => gate.name === name));
  assert(!local.some(gate => gate.args.includes('ci')));
  const ci = verificationPlan({ ...options, ci: true });
  assert(ci.findIndex(gate => gate.name === 'api-build') < ci.findIndex(gate => gate.name === 'stage'));
  const build = ci.find(gate => gate.name === 'hosted-build');
  assert.equal(build.env.VITE_HOSTED_PILOT, 'true');
  assert.equal(build.args.at(-1), '/reports/hosted');
  const hosted = ci.find(gate => gate.name === 'hosted-vitest');
  assert.equal(hosted.env.HOSTED_TEST_DIST, '/reports/hosted');
  assert.equal(hosted.env.VITE_HOSTED_PILOT, undefined);
  for (const name of ['api', 'security', 'local-vitest', 'hosted-vitest']) {
    const args = ci.find(gate => gate.name === name).args;
    assert(args.includes('--maxWorkers=1') && args.includes('--no-file-parallelism'));
  }
  assert(ci.every(gate => !gate.args.some(arg => /(?:^|\/)(?:deploy|verify-live-release|editor-release-check)\.mjs$/.test(arg)
    || /^(?:--(?:deploy|approve|restore)|deploy$)/.test(arg))));
});

test('source coverage rejects local, old-node and changed-source receipts', () => {
  const inputs = [{ path: 'api/src/cloud/http.ts', bytes: 10, sha256: 'a'.repeat(64) }];
  const receipt = { status: 'CI_VERIFIED', browserVerified: true, node: 'v22.23.2',
    commit: 'b'.repeat(40), runId: '123', inputs };
  assertSourceCoverage(receipt, inputs);
  for (const change of [{ status: 'NON_BROWSER_CHECKS_ONLY' }, { node: 'v22.12.0' },
    { browserVerified: false }, { inputs: [] }, { commit: '' }]) {
    assert.throws(() => assertSourceCoverage({ ...receipt, ...change }, inputs));
  }
});

test('Playwright failures, skips, flakes and empty runs cannot produce green evidence', () => {
  const report = { stats: { expected: 27, unexpected: 0, flaky: 0, skipped: 0 }, errors: [] };
  assert.equal(requiredPlaywrightTests(report).expected, 27);
  for (const key of ['unexpected', 'flaky', 'skipped']) {
    assert.throws(() => requiredPlaywrightTests({ ...report, stats: { ...report.stats, [key]: 1 } }));
  }
  assert.throws(() => requiredPlaywrightTests({ ...report, stats: { ...report.stats, expected: 0 } }));
});

test('failed gate evidence exports only status fields, never raw child output or errors', () => {
  const privateOutput = 'synthetic-private-token-and-media-name';
  const failure = failedGateReport('api', { status: 1, signal: null,
    stdout: privateOutput, stderr: privateOutput, error: new Error(privateOutput) });
  assert.deepEqual(failure, { status: 'VERIFICATION_FAILED', failedGate: 'api', exitCode: 1,
    signaled: false, timedOut: false, browserVerified: false, azureWrites: false,
    deploymentApproved: false, previewRestoration: false });
  assert(!JSON.stringify(failure).includes(privateOutput));
  const timedOut = failedGateReport('hosted-vitest', { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } });
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.signaled, true);
  assert.equal(timedOut.timedOut, true);
  assert.throws(() => assertSourceCoverage(failure, []));
});

test('fresh CI creates the synthetic codec parent and refuses existing media or screenshots', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'fim-ci-workspace-'));
  try {
    const media = prepareSyntheticWorkspace(directory);
    assert.equal(media, resolve(directory, 'local-media'));
    assert(existsSync(mkdtempSync(resolve(media, 'conversion-synthetic-'))));
    writeFileSync(resolve(media, 'preserve.txt'), 'synthetic existing state');
    assert.throws(() => prepareSyntheticWorkspace(directory), /must not contain local-media/);
    assert.equal(readFileSync(resolve(media, 'preserve.txt'), 'utf8'), 'synthetic existing state');
    const other = resolve(directory, 'other');
    mkdirSync(resolve(other, 'test-results'), { recursive: true });
    assert.throws(() => prepareSyntheticWorkspace(other), /screenshot directory must start empty/);
    assert(!existsSync(resolve(other, 'local-media')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('synthetic failure diagnostics retain assertions but redact credential-shaped values', () => {
  const diagnostics = failedTests({ testResults: [{ name: '/runner/project/tests/example.test.ts', assertionResults: [
    { status: 'passed', fullName: 'passed' },
    { status: 'failed', fullName: 'preserves newer edits', failureMessages: [
      `Expected 2 to equal 1; AccountKey=private-value; token=private-token ${'a'.repeat(80)}`,
    ] },
  ] }] });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].file, 'tests/example.test.ts');
  assert.match(diagnostics[0].messages[0], /Expected 2 to equal 1/);
  assert(!JSON.stringify(diagnostics).includes('private-value'));
  assert(!JSON.stringify(diagnostics).includes('private-token'));
  assert(!JSON.stringify(diagnostics).includes('a'.repeat(80)));
});

test('build-mode discriminator rejects duplicate or stale worker flags', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'fim-mode-test-'));
  try {
    writeFileSync(resolve(directory, 'sw.js'), 'self.REHEARSAL_HOSTED = true;');
    assertBuildMode(directory, true);
    assert.throws(() => assertBuildMode(directory, false));
    writeFileSync(resolve(directory, 'sw.js'), 'self.REHEARSAL_HOSTED = false; self.REHEARSAL_HOSTED = true;');
    assert.throws(() => assertBuildMode(directory, true));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('only bounded root PNG screenshots are exported, never traces or local-media', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'fim-screenshot-test-'));
  const source = resolve(directory, 'test-results');
  mkdirSync(source);
  const png = width => {
    const bytes = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(900, 20);
    return bytes;
  };
  try {
    writeFileSync(resolve(source, 'mobile.png'), png(390));
    writeFileSync(resolve(source, 'desktop.png'), png(1280));
    writeFileSync(resolve(source, 'trace.zip'), 'never upload');
    mkdirSync(resolve(source, 'local-media'));
    writeFileSync(resolve(source, 'local-media/private.png'), png(390));
    const destination = resolve(directory, 'safe');
    assert.deepEqual(collectScreenshots(source, destination).map(item => item.name), ['desktop.png', 'mobile.png']);
    assert.equal(readFileSync(resolve(destination, 'mobile.png')).length, 33);
    symlinkSync(resolve(source, 'mobile.png'), resolve(source, 'linked.png'));
    assert.throws(() => collectScreenshots(source, resolve(directory, 'rejected')), /Nonregular/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('live verification is read-only and records archive failures without hiding other results', async () => {
  const files = new Map([
    ['index.html', Buffer.from('synthetic shell')],
    ['staticwebapp.config.json', Buffer.from('{"globalHeaders":{"X-Content-Type-Options":"nosniff"}}')],
    ['sources/ffmpeg-audio-core-v1-source.zip', Buffer.from('synthetic archive')],
  ]);
  const requests = [];
  const receipt = await verifyPublicRelease({ hostname: 'fixture.1.azurestaticapps.net', files }, async (url, options) => {
    const path = new URL(url).pathname;
    requests.push(path);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, undefined);
    if (path.startsWith('/api/')) return new Response('{"error":"signin_required"}', {
      status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    if (path.startsWith('/sources/')) {
      const response = new Response('transformed source', {
        headers: { 'Content-Type': 'application/x-tar', 'Content-Encoding': 'gzip',
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=0, must-revalidate' },
      });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    if (path === '/' || path === '/index.html') return new Response(files.get('index.html'), {
      headers: { 'X-Content-Type-Options': 'nosniff' },
    });
    return new Response('missing', { status: 404 });
  });
  assert.equal(receipt.status, 'LIVE_WITH_VERIFICATION_FAILURES');
  assert.deepEqual(receipt.failures.map(item => item.path), ['/sources/ffmpeg-audio-core-v1-source.zip']);
  assert.match(receipt.failures[0].reason, /MIME/);
  assert.deepEqual(receipt.results.filter(item => item.path.startsWith('/api/')).map(item => [item.path, item.status]), [
    ['/api/auth/session', 401], ['/api/routines', 401], ['/api/playlists', 401], ['/api/classes', 401],
    ['/api/fillers', 401], ['/api/fillers/release-probe', 401], ['/api/media/library', 401],
    ['/api/fillers/release-probe/analysis', 401], ['/api/routines', 401],
  ]);
  assert.equal(requests.at(-1), '/');
  assert.equal(receipt.azureWrites, false);
  assert.equal(receipt.previewRestoration, false);
});