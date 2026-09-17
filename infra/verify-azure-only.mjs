import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, combineReports, readArtifact, validateApiArtifact, validateArtifact } from './deploy.mjs';
import { requiredHostedTests, requiredLocalTests } from './report-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function verificationEnvironment(environment, ci) {
  for (const key of ['PRIVATE_AUDIO_DIR', 'MIGRATION_LIVE_API_DIRECTORY', 'REHEARSAL_HTTPS_CERT', 'REHEARSAL_HTTPS_KEY']) {
    assert(!environment[key], `Unset ${key}; verification uses synthetic fixtures only.`);
  }
  if (ci) {
    assert.equal(environment.GITHUB_ACTIONS, 'true', 'Browser verification is GitHub CI only.');
    assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted', 'Use an isolated GitHub-hosted runner.');
  }
  return { ...childEnvironment(environment), CI: 'true', VITE_HOSTED_PILOT: 'false',
    NODE_OPTIONS: `--max-old-space-size=${ci ? 2048 : 768}`, UV_THREADPOOL_SIZE: '2' };
}

export function sourceInventory(projectRoot = root) {
  const files = new Map();
  for (const directory of ['frontend/src', 'frontend/public', 'shared', 'tests', 'api/src', 'api/testing', 'infra', 'scripts', 'docs', '.github']) {
    for (const [name, bytes] of readArtifact(resolve(projectRoot, directory))) files.set(`${directory}/${name}`, bytes);
  }
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts',
    'frontend/package.json', 'frontend/package-lock.json', 'frontend/tsconfig.json', 'frontend/vite.config.ts',
    'frontend/index.html', 'api/package.json', 'api/package-lock.json', 'api/tsconfig.json', 'api/vitest.config.ts',
    'api/host.json', 'README.md', '.gitignore', '.dockerignore']) {
    files.set(name, readFileSync(resolve(projectRoot, name)));
  }
  return [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
    path, bytes: bytes.length, sha256: hash(bytes),
  }));
}

export function assertSourceCoverage(receipt, inputs) {
  assert.equal(receipt.status, 'CI_VERIFIED', 'A partial/local run is not release evidence.');
  assert.equal(receipt.node, 'v22.23.2');
  assert.equal(receipt.browserVerified, true);
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.match(receipt.runId, /^\d+$/);
  assert.deepEqual(receipt.inputs, inputs, 'Source changed since CI; run and review fresh CI.');
}

export function assertBuildMode(directory, hosted) {
  const worker = readFileSync(resolve(directory, 'sw.js'), 'utf8');
  const markers = [...worker.matchAll(/self\.REHEARSAL_HOSTED\s*=\s*(true|false)\s*;/g)];
  assert.deepEqual(markers.map(match => match[1]), [String(hosted)], 'Missing, stale or duplicate hosted build marker.');
}

export function verificationPlan({ ci, npmCli, reports }) {
  assert(isAbsolute(npmCli), 'NPM_CLI must be an absolute npm-cli.js path.');
  const report = name => resolve(reports, `${name}.json`);
  const vitest = ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', '--pool=threads', '--no-file-parallelism',
    '--allowOnly=false', '--reporter=default', '--reporter=json'];
  const gate = (name, args, env = {}) => ({ name, args, env });
  const hostedDirectory = resolve(reports, 'hosted');
  return [
    gate('root-typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']),
    gate('frontend-typecheck', ['frontend/node_modules/typescript/bin/tsc', '--noEmit', '--project', 'frontend/tsconfig.json']),
    gate('api-typecheck', ['api/node_modules/typescript/bin/tsc', '--project', 'api/tsconfig.json']),
    gate('api-build', [npmCli, '--prefix', 'api', 'run', 'build']),
    gate('api', [npmCli, '--prefix', 'api', 'test', '--', ...vitest.slice(2), `--outputFile.json=${report('api')}`]),
    gate('security', [...vitest, 'tests/security.test.ts', `--outputFile.json=${report('security')}`]),
    gate('local-build', [npmCli, '--prefix', 'frontend', 'run', 'build']),
    gate('local-privacy', [npmCli, 'run', 'check:privacy']),
    ...(ci ? [
      gate('local-vitest', [...vitest, `--outputFile.json=${report('local-vitest')}`]),
      gate('playwright', ['node_modules/@playwright/test/cli.js', 'test', '--workers=1', '--forbid-only', '--retries=0',
        '--reporter=list,json'], { E2E_PORT: '5320', PLAYWRIGHT_JSON_OUTPUT_FILE: report('playwright') }),
    ] : []),
    gate('hosted-build', [npmCli, '--prefix', 'frontend', 'run', 'build', '--', '--outDir', hostedDirectory], { VITE_HOSTED_PILOT: 'true' }),
    ...(ci ? [
      gate('hosted-vitest', [...vitest, `--outputFile.json=${report('hosted-vitest')}`], { HOSTED_TEST_DIST: hostedDirectory }),
    ] : []),
    gate('source-privacy', [npmCli, 'run', 'check:privacy']),
    gate('infra', ['--test', '--test-concurrency=1', ...readdirSync(resolve(root, 'infra'))
      .filter(name => name.endsWith('.test.mjs')).sort().map(name => `infra/${name}`)]),
    ...(ci ? [gate('stage', ['infra/stage.mjs'], { NPM_CLI: npmCli })] : []),
  ];
}

export function requiredPlaywrightTests(report) {
  assert(report.stats.expected > 0, 'No Playwright tests executed.');
  for (const key of ['unexpected', 'flaky', 'skipped']) assert.equal(report.stats[key], 0, `Playwright ${key}.`);
  assert.deepEqual(report.errors, []);
  return report.stats;
}

export function failedGateReport(name, result) {
  assert.match(name, /^[a-z][a-z0-9-]+$/);
  return { status: 'VERIFICATION_FAILED', failedGate: name,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signaled: Boolean(result.signal), timedOut: result.error?.code === 'ETIMEDOUT',
    browserVerified: false, azureWrites: false, deploymentApproved: false, previewRestoration: false };
}

export function prepareSyntheticWorkspace(projectRoot = root) {
  const directory = resolve(projectRoot, 'local-media');
  assert(!existsSync(directory), 'CI checkout must not contain local-media.');
  assert(!existsSync(resolve(projectRoot, 'test-results')), 'CI screenshot directory must start empty.');
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

export function collectScreenshots(source, destination) {
  assert(!lstatSync(source).isSymbolicLink(), 'Symlink screenshot root.');
  mkdirSync(destination, { recursive: true });
  const screenshots = [];
  let totalBytes = 0;
  for (const name of readdirSync(source).sort()) {
    if (!/^[a-zA-Z0-9_-]+\.png$/.test(name)) continue;
    const path = resolve(source, name);
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Nonregular screenshot.');
    assert(stat.size >= 33 && stat.size <= 5 * 1024 * 1024, 'Screenshot size limit.');
    totalBytes += stat.size;
    assert(totalBytes <= 32 * 1024 * 1024 && screenshots.length < 200, 'Screenshot budget exceeded.');
    const bytes = readFileSync(path);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Not a PNG.');
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assert(width > 0 && width <= 4096 && height > 0 && height <= 32768, 'Screenshot dimensions.');
    writeFileSync(resolve(destination, name), bytes, { flag: 'wx' });
    screenshots.push({ name, width, height, bytes: bytes.length, sha256: hash(bytes) });
  }
  assert(screenshots.some(item => item.width <= 430), 'Mobile screenshot coverage missing.');
  assert(screenshots.some(item => item.width >= 1024), 'Desktop screenshot coverage missing.');
  return screenshots;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--assert-source' && args.length === 2) {
    assertSourceCoverage(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), sourceInventory());
    console.log('Source matches the supplied CI receipt. Parent must independently verify its GitHub run and commit.');
    return;
  }
  assert(args.length === 1 && ['--ci', '--checks'].includes(args[0]), 'Use --ci, --checks or --assert-source RECEIPT.');
  assert.equal(process.version, 'v22.23.2', 'Use the pinned Node 22.23.2 runtime.');
  const ci = args[0] === '--ci';
  const environment = verificationEnvironment(process.env, ci);
  const name = process.env.RELEASE_REPORT_NAME ?? `checks-${Date.now()}`;
  assert.match(name, /^[a-z0-9][a-z0-9-]+$/);
  const reports = ci ? resolve(root, '.ci-reports') : resolve(root, 'local-media/deployment', name);
  assert(!existsSync(reports), 'Use a fresh report directory; no stale evidence reuse.');
  if (ci) prepareSyntheticWorkspace();
  const plan = verificationPlan({ ci, npmCli: process.env.NPM_CLI, reports });
  const inputs = sourceInventory();
  mkdirSync(reports, { recursive: true, mode: 0o700 });
  const gates = [];
  for (const gate of plan) {
    console.log(`Starting ${gate.name}`);
    const descriptor = openSync(resolve(reports, `${gate.name}.log`), 'wx', 0o600);
    let result;
    try {
      result = spawnSync(process.execPath, gate.args, { cwd: root, env: { ...environment, ...gate.env },
        stdio: ['ignore', descriptor, descriptor], timeout: 25 * 60 * 1000 });
    } finally { closeSync(descriptor); }
    if (result.status !== 0 || result.signal || result.error) {
      const failure = failedGateReport(gate.name, result);
      writeFileSync(resolve(reports, 'summary.json'), `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.error(JSON.stringify(failure));
      throw new Error('Raw child output withheld; no verification receipt or upload approval produced.');
    }
    if (gate.name === 'local-build') assertBuildMode(resolve(root, 'frontend/dist'), false);
    if (gate.name === 'hosted-build') {
      assertBuildMode(resolve(reports, 'hosted'), true);
      assertBuildMode(resolve(root, 'frontend/dist'), false);
    }
    gates.push(gate.name);
    console.log(`Passed ${gate.name}`);
  }
  const readReport = name => JSON.parse(readFileSync(resolve(reports, `${name}.json`), 'utf8'));
  const tests = {};
  for (const name of ['api', 'security']) {
    const report = readReport(name);
    assert.equal(report.success, true);
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPendingTests, 0);
    assert(report.numPassedTests > 0);
    tests[name] = { passed: report.numPassedTests, skipped: 0 };
  }
  const frontend = validateArtifact(readArtifact(resolve(reports, 'hosted')),
    readFileSync(resolve(root, 'frontend/public/staticwebapp.config.json')),
    JSON.parse(readFileSync(resolve(root, 'docs/licensed-media.json'), 'utf8')).assets, { requireCodecs: true });
  let artifact, screenshots;
  if (ci) {
    tests.local = requiredLocalTests(readReport('local-vitest'));
    tests.hosted = requiredHostedTests(readReport('hosted-vitest'));
    tests.playwright = requiredPlaywrightTests(readReport('playwright'));
    const sourceFiles = new Map(['host.json', 'package.json', 'package-lock.json', 'dist/functions.cjs']
      .map(name => [name, readFileSync(resolve(root, 'api', name))]));
    artifact = combineReports(frontend, validateApiArtifact(readArtifact(resolve(root, 'local-media/deployment/api')), sourceFiles));
    screenshots = collectScreenshots(resolve(root, 'test-results'), resolve(reports, 'screenshots'));
  }
  assert.deepEqual(sourceInventory(), inputs, 'Inputs changed during verification.');
  const summary = { status: ci ? 'CI_VERIFIED' : 'NON_BROWSER_CHECKS_ONLY', node: process.version,
    commit: ci ? process.env.GITHUB_SHA : undefined, runId: ci ? process.env.GITHUB_RUN_ID : undefined,
    browserVerified: ci, completedAt: new Date().toISOString(), inputs, gates, tests, frontend, artifact, screenshots,
    infraOptionalSkip: 'Historical migration-handler probe remains disabled; no private or live migration inputs.',
    azureWrites: false, deploymentApproved: false, previewRestoration: false };
  if (ci) assertSourceCoverage(summary, inputs);
  writeFileSync(resolve(reports, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`${summary.status}: ${reports}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Verification stopped; raw child output withheld. No release approval produced.');
    process.exitCode = 1;
  });
}