import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { childEnvironment, readArtifact, validateApiArtifact } from './deploy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function stageApi({ projectRoot = root, npmCli = process.env.NPM_CLI, replace = false, progress = () => {}, signal } = {}, run = promisify(execFile)) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major === 22 && minor >= 12, 'Use Node 22.12+ (<23).');
  assert(typeof npmCli === 'string' && isAbsolute(npmCli), 'Export NPM_CLI as the absolute path to the reviewed npm-cli.js.');
  const parent = resolve(projectRoot, 'local-media/deployment');
  const destination = resolve(parent, 'api');
  assert(!existsSync(destination) || (replace && !lstatSync(destination).isSymbolicLink()), 'API stage exists; use --replace-stage only to replace that generated artifact.');
  for (const directory of [resolve(projectRoot, 'local-media'), parent]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assert(!lstatSync(directory).isSymbolicLink(), 'Symlink staging parent.');
  }
  const staging = mkdtempSync(resolve(parent, '.api-stage-'));
  const options = { cwd: projectRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    timeout: 10 * 60 * 1000, env: childEnvironment(), signal };
  try {
    progress('installing locked API build dependencies');
    await run(process.execPath, [npmCli, '--prefix', resolve(projectRoot, 'api'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    progress('building the API bundle');
    await run(process.execPath, [npmCli, '--prefix', resolve(projectRoot, 'api'), 'run', 'build'], options);
    progress('copying allowlisted build inputs');
    mkdirSync(resolve(staging, 'dist'));
    const sourceFiles = new Map();
    for (const name of ['host.json', 'package.json', 'package-lock.json', 'dist/functions.cjs']) {
      const content = readFileSync(resolve(projectRoot, 'api', name));
      sourceFiles.set(name, content);
      writeFileSync(resolve(staging, name), content, { flag: 'wx', mode: 0o600 });
    }
    progress('installing isolated production dependencies');
    await run(process.execPath, [npmCli, '--prefix', staging, 'ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund'], options);
    progress('validating the production artifact');
    let report;
    try {
      report = validateApiArtifact(readArtifact(staging), sourceFiles);
    } catch (error) {
      const location = /deploy\.mjs:(\d+):/.exec(error.stack ?? '')?.[1];
      progress(`artifact validation failed${location ? ` at validator line ${location}` : ''}`);
      throw new Error('API artifact validation failed.');
    }
    progress('promoting the validated artifact');
    if (existsSync(destination)) rmSync(destination, { recursive: true });
    renameSync(staging, destination);
    return report;
  } finally {
    progress('cleaning the temporary stage');
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  Promise.resolve().then(() => {
    assert(args.length === 0 || (args.length === 1 && args[0] === '--replace-stage'));
    return stageApi({ replace: args[0] === '--replace-stage', signal: controller.signal,
      progress: phase => console.log(`API stage: ${phase}.`) });
  }).then(report => console.log(JSON.stringify(report, null, 2))).catch(() => {
    console.error('API staging stopped. Check Node 22, pinned npm, lockfile, existing stage and registry access. Raw child output withheld.');
    process.exitCode = 1;
  }).finally(() => {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  });
}