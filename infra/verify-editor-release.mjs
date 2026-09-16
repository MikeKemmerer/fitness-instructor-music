import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArtifact, validateApiArtifact } from './deploy.mjs';
import { requiredHostedTests } from './report-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportName = process.env.RELEASE_REPORT_NAME ?? 'editor-filler-verification-20260914';
assert.match(reportName, /^[a-z0-9][a-z0-9-]+$/);
const reports = resolve(root, 'local-media/deployment', reportName);
process.chdir(root);

function sourceInventory() {
  const files = new Map();
  for (const directory of ['frontend/src', 'frontend/public', 'shared', 'tests', 'api/src', 'api/testing', 'infra', 'scripts', 'docs']) {
    if (existsSync(directory)) {
      for (const [name, bytes] of readArtifact(resolve(directory))) files.set(`${directory}/${name}`, bytes);
    }
  }
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts',
    'frontend/package.json', 'frontend/package-lock.json', 'frontend/tsconfig.json', 'frontend/vite.config.ts',
    'frontend/index.html', 'api/package.json', 'api/package-lock.json', 'api/tsconfig.json', 'api/vitest.config.ts', 'api/host.json']) {
    files.set(name, readFileSync(name));
  }
  return [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
    path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
}

function requireIdle() {
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)) {
    let argv;
    try {
      if (!readlinkSync(`/proc/${pid}/cwd`).startsWith(root)) continue;
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch { continue; }
    assert(!argv.some(value => /(?:vitest\.mjs|typescript\/bin\/tsc|@playwright\/test\/cli\.js|infra\/(?:stage|verify-editor-release|editor-release-check)\.mjs)$/.test(value)),
      `Verification process ${pid} is still active.`);
  }
}

function runGate(name, args, environment = {}) {
  const filename = resolve(reports, `${name}.log`);
  const descriptor = openSync(filename, 'wx');
  console.log(`Starting ${name}`);
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      env: { ...process.env, ...environment }, stdio: ['ignore', descriptor, descriptor],
      timeout: 20 * 60 * 1000,
    });
  } finally { closeSync(descriptor); }
  appendFileSync(filename, `\nSIGNAL=${result.signal ?? 'none'}\nEXIT_CODE=${result.status ?? 1}\n`);
  assert.equal(result.status, 0, `${name} failed; see its gate log.`);
  console.log(`Passed ${name}`);
}

function main() {
  assert.equal(process.argv.length, 3);
  assert(['--checks', '--resume-hosted-checks'].includes(process.argv[2]));
  const resume = process.argv[2] === '--resume-hosted-checks';
  assert.equal(Number(process.versions.node.split('.')[0]), 22);
  assert(process.env.NPM_CLI?.startsWith('/'));
  requireIdle();
  mkdirSync(reports, { recursive: true });
  const inputs = resume ? JSON.parse(readFileSync(resolve(reports, 'build-inputs.json'), 'utf8')) : sourceInventory();
  if (!resume) {
    writeFileSync(resolve(reports, 'build-inputs.json'), JSON.stringify(inputs, null, 2), { flag: 'wx' });
    cpSync('frontend/dist', resolve(reports, 'local-before-checks'), { recursive: true, force: false, errorOnExist: true });
  }
  const npm = process.env.NPM_CLI;
  const vitest = ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', '--pool=threads', '--reporter=default', '--reporter=json'];
  const jsonReport = name => `--outputFile.json=${resolve(reports, `${name}.json`)}`;
  const local = { VITE_HOSTED_PILOT: 'false' };
  const hosted = { VITE_HOSTED_PILOT: 'true' };
  if (resume) {
    for (const gate of ['root-typecheck', 'frontend-typecheck', 'api-typecheck', 'api-build', 'api', 'security',
      'license-offline', 'local-build', 'local-privacy', 'local-vitest', 'playwright', 'hosted-build', 'hosted-fixture-discriminator']) {
      assert.match(readFileSync(resolve(reports, `${gate}.log`), 'utf8'), /EXIT_CODE=0\s*$/);
    }
    assert.equal(JSON.parse(readFileSync(resolve(reports, 'hosted-vitest.json'), 'utf8')).success, false);
    assert.match(readFileSync('frontend/dist/sw.js', 'utf8'), /self\.REHEARSAL_HOSTED = true;/);
    for (const [source, destination] of [['hosted-vitest.log', 'hosted-build-flag-failure.log'],
      ['hosted-vitest.json', 'hosted-build-flag-failure.json'], ['completion.log', 'failed-environment-completion.log']]) {
      assert(!existsSync(resolve(reports, destination)));
      renameSync(resolve(reports, source), resolve(reports, destination));
    }
  } else {
    runGate('root-typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
    runGate('frontend-typecheck', ['frontend/node_modules/typescript/bin/tsc', '--noEmit', '--project', 'frontend/tsconfig.json']);
    runGate('api-typecheck', ['api/node_modules/typescript/bin/tsc', '--project', 'api/tsconfig.json']);
    runGate('api-build', [npm, '--prefix', 'api', 'run', 'build']);
    runGate('api', [npm, '--prefix', 'api', 'test', '--', '--maxWorkers=1', '--pool=threads', '--reporter=default', '--reporter=json', jsonReport('api')]);
    runGate('security', [...vitest, 'tests/security.test.ts', jsonReport('security')]);
    runGate('license-offline', [...vitest, 'tests/loudness.test.ts', 'tests/filler-audio.test.ts', 'tests/offline.test.ts', jsonReport('license-offline')]);
    runGate('local-build', [npm, 'run', 'build'], local);
    runGate('local-privacy', [npm, 'run', 'check:privacy']);
    cpSync('frontend/dist', resolve(reports, 'local-fresh'), { recursive: true, force: false, errorOnExist: true });
    runGate('playwright-class', ['node_modules/@playwright/test/cli.js', 'test', 'tests/rehearsal.spec.ts',
      '--grep', 'full class workflow', '--workers=1', '--reporter=list,json'], {
      ...local, E2E_PORT: process.env.E2E_PORT ?? '5320', PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(reports, 'playwright-class.json'),
    });
    runGate('local-vitest', [...vitest, jsonReport('local-vitest')], local);
    runGate('playwright', ['node_modules/@playwright/test/cli.js', 'test', '--workers=1', '--reporter=list,json'], {
      ...local, E2E_PORT: process.env.E2E_PORT ?? '5320', PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(reports, 'playwright.json'),
    });
    runGate('hosted-build', [npm, 'run', 'build'], hosted);
  }
  runGate('hosted-browser', [...vitest, 'tests/hosted-browser.test.ts', jsonReport('hosted-browser')], local);
  runGate('hosted-vitest', [...vitest, jsonReport('hosted-vitest')], local);
  runGate('hosted-privacy', [npm, 'run', 'check:privacy']);
  runGate('infra', ['--test', '--test-concurrency=1', ...readdirSync('infra').filter(name => name.endsWith('.test.mjs')).map(name => `infra/${name}`)]);
  if (process.env.REUSE_API_STAGE === 'true') {
    const sourceFiles = new Map(['host.json', 'package.json', 'package-lock.json', 'dist/functions.cjs']
      .map(name => [name, readFileSync(resolve('api', name))]));
    const stage = validateApiArtifact(readArtifact(resolve('local-media/deployment/api')), sourceFiles);
    writeFileSync(resolve(reports, 'stage.log'), `${JSON.stringify({ reused: true, ...stage }, null, 2)}\nEXIT_CODE=0\n`, { flag: 'wx' });
  } else {
    runGate('stage', ['infra/stage.mjs', '--replace-stage']);
  }
  runGate('artifact', ['infra/deploy.mjs']);
  requireIdle();
  assert.deepEqual(sourceInventory(), inputs, 'Build or test inputs changed during verification.');
  cpSync('frontend/dist', resolve(reports, 'candidate/frontend'), { recursive: true, force: false, errorOnExist: true });
  cpSync('local-media/deployment/api', resolve(reports, 'candidate/api'), { recursive: true, force: false, errorOnExist: true });
  const tests = {};
  for (const name of ['api', 'security', 'license-offline', 'local-vitest', 'hosted-vitest']) {
    const report = JSON.parse(readFileSync(resolve(reports, `${name}.json`), 'utf8'));
    assert.equal(report.success, true);
    assert.equal(report.numFailedTests, 0);
    tests[name] = { passed: report.numPassedTests, skipped: report.numPendingTests };
    if (name === 'hosted-vitest') {
      tests[name] = requiredHostedTests(report);
      tests.hostedBrowser = tests[name].hostedBrowser;
    }
  }
  const playwright = JSON.parse(readFileSync(resolve(reports, 'playwright.json'), 'utf8'));
  assert(playwright.stats.expected > 0);
  for (const key of ['unexpected', 'flaky', 'skipped']) assert.equal(playwright.stats[key], 0);
  assert.equal(playwright.errors.length, 0);
  tests.playwright = playwright.stats;
  writeFileSync(resolve(reports, 'checks.json'), JSON.stringify({ completedAt: new Date().toISOString(), node: process.version,
    sourceFixtureHostedFlag: false, hostedArtifactTested: true, resumedAfterBuildFlagIsolation: resume, tests }, null, 2), { flag: 'wx' });
}

try {
  main();
  appendFileSync(resolve(reports, 'completion.log'), 'EXIT_CODE=0\n');
} catch (error) {
  console.error(error.message);
  if (['--checks', '--resume-hosted-checks'].includes(process.argv[2])) {
    mkdirSync(reports, { recursive: true });
    appendFileSync(resolve(reports, 'completion.log'), `${error.message}\nEXIT_CODE=1\n`);
  }
  process.exitCode = 1;
}