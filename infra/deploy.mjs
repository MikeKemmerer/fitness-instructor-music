import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { codecManifest, validateCodecDistribution, validateCodecRoutes } from './licensed-codecs.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const execute = promisify(execFile);

export const target = Object.freeze({
  resourceGroup: 'rg-fitness-instructor-pilot',
  appName: 'fitness-instructor-music-pilot2',
  apiResourceGroup: 'rg-fitness-instructor-pilot',
  apiAppName: 'fitness-instructor-music-pilot2-api'
});
export const apiDirectory = resolve(root, 'local-media/deployment/api');

export function childEnvironment(environment = process.env) {
  const clean = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (environment[key]) clean[key] = environment[key];
  }
  return { ...clean, AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_LOGGING_ENABLE_LOG_FILE: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true' };
}

export async function verifyTarget(settings, run = execute) {
  assert.match(settings.subscription, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  assert.equal(settings.resourceGroup, target.resourceGroup);
  assert.equal(settings.appName, target.appName);
  const expectedHostname = (settings.environment ?? process.env).SWA_EXPECTED_HOSTNAME;
  assert.match(expectedHostname, /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[0-9]+)?\.azurestaticapps\.net$/,
    'Set SWA_EXPECTED_HOSTNAME to the independently approved production hostname, without a URL scheme or path.');
  const options = { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000, env: childEnvironment(settings.environment) };
  const account = JSON.parse((await run('az', ['account', 'show', '--subscription', settings.subscription, '--only-show-errors', '-o', 'json'], options)).stdout);
  assert.equal(account.id.toLowerCase(), settings.subscription.toLowerCase());
  assert.equal(account.name, 'Visual Studio Enterprise Subscription');
  assert.equal(account.state, 'Enabled');
  const site = JSON.parse((await run('az', ['staticwebapp', 'show', '--subscription', settings.subscription,
    '--resource-group', settings.resourceGroup, '--name', settings.appName, '--only-show-errors', '-o', 'json'], options)).stdout);
  assert.equal(site.id.toLowerCase(), `/subscriptions/${settings.subscription}/resourceGroups/${settings.resourceGroup}/providers/Microsoft.Web/staticSites/${settings.appName}`.toLowerCase());
  assert.equal(site.name, settings.appName);
  assert.equal(site.sku?.name, 'Free');
  assert.equal(site.location?.replaceAll(' ', '').toLowerCase(), 'westus2');
  assert(['Custom', 'SwaCli'].includes(site.provider), 'Unexpected deployment provider.');
  assert.equal(site.repositoryUrl || '', '');
  assert.equal(site.defaultHostname, expectedHostname);
  return site;
}

// The API is a standalone Function App (Microsoft.Web/sites), not an SWA-managed/linked backend --
// the frontend and API are on different origins by design; see auth.ts's cross-site cookie handling.
export async function verifyApiTarget(settings, run = execute) {
  assert.match(settings.subscription, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  assert.equal(settings.apiResourceGroup, target.apiResourceGroup);
  assert.equal(settings.apiAppName, target.apiAppName);
  const options = { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000, env: childEnvironment(settings.environment) };
  const app = JSON.parse((await run('az', ['functionapp', 'show', '--subscription', settings.subscription,
    '--resource-group', settings.apiResourceGroup, '--name', settings.apiAppName, '--only-show-errors', '-o', 'json'], options)).stdout);
  assert.equal(app.id.toLowerCase(), `/subscriptions/${settings.subscription}/resourceGroups/${settings.apiResourceGroup}/providers/Microsoft.Web/sites/${settings.apiAppName}`.toLowerCase());
  assert.equal(app.name, settings.apiAppName);
  assert.equal(app.kind, 'functionapp,linux');
  assert.equal(app.state, 'Running');
  assert.equal(app.defaultHostName, `${settings.apiAppName}.azurewebsites.net`);
  return app;
}

export const publicEmulatorConnection = 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

function checkContent(content, allowEmulatorConstant) {
  const text = content.toString('utf8');
  const scanned = allowEmulatorConstant ? text.replaceAll(publicEmulatorConnection, '') : text;
  assert(!/AccountKey=[A-Za-z0-9+/]{80,}={0,2}|scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(scanned), 'Credential-shaped content in artifact.');
}

function summarize(files, server = false) {
  const digest = createHash('sha256');
  let totalBytes = 0;
  for (const [name, content] of [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    assert(!name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe artifact path.');
    checkContent(content, server && (name === 'dist/functions.cjs' || /^node_modules\/@azure\/storage-(blob|common)\//.test(name)));
    totalBytes += content.length;
    digest.update(name).update('\0').update(String(content.length)).update('\0').update(content);
  }
  return { fileCount: files.size, totalBytes, artifactSHA256: digest.digest('hex') };
}

export function validateArtifact(files, sourceConfig, licensedAssets, { requireCodecs = false } = {}) {
  for (const name of ['index.html', '.vite/manifest.json', 'staticwebapp.config.json', 'sw.js']) {
    assert(files.has(name), `Missing built ${name}; lead must rebuild with VITE_HOSTED_PILOT=true.`);
  }
  const configBytes = files.get('staticwebapp.config.json');
  assert(configBytes.equals(sourceConfig), 'Built auth config differs from reviewed source.');
  const config = JSON.parse(configBytes);
  const finalRoute = config.routes?.at(-1);
  assert.equal(finalRoute?.route, '/*', 'Missing public shell catch-all.');
  assert.deepEqual(finalRoute.allowedRoles, ['anonymous']);
  assert.equal(config.auth, undefined, 'Platform authentication must not replace server sessions.');
  assert.equal(config.responseOverrides, undefined, 'API errors must not become HTML redirects.');
  assert.equal(config.navigationFallback, undefined, 'Navigation fallback needs a separate authorization review.');
  assert.equal(config.platform, undefined, 'No managed/linked Functions runtime -- the API is a standalone Function App.');
  assert(!config.routes.some(route => route.route === '/api/*'), 'Stale forwarded API route: the API is a separate origin, not SWA-managed.');
  // Azure always serves /.auth/me from the platform, so only the sign-in providers can be blocked by route.
  for (const path of ['/.auth/login/aad', '/.auth/login/github']) {
    assert.equal(config.routes.find(route => route.route === path)?.statusCode, 404, 'Missing exact platform auth block.');
  }
  for (const route of config.routes) {
    assert.equal(route.rewrite, undefined);
    assert.equal(route.redirect, undefined);
    assert.equal(route.methods, undefined);
    if (route.statusCode !== undefined) {
      assert(['/.auth/login/aad', '/.auth/login/github', '/.auth/*', '/local-media/*'].includes(route.route) && route.statusCode === 404);
    } else assert.deepEqual(route.allowedRoles, ['anonymous']);
  }
  JSON.parse(files.get('.vite/manifest.json'));
  assert(/self\.REHEARSAL_HOSTED = true;/.test(files.get('sw.js').toString('utf8')), 'Refusing a local-mode build; rebuild with VITE_HOSTED_PILOT=true.');
  const codecs = validateCodecDistribution(files, { required: requireCodecs });
  validateCodecRoutes(config, codecs);

  for (const [name, content] of files) {
    assert(!/(^|\/)(local-media|node_modules|api|\.env[^/]*)(\/|$)|\.local\.json$/i.test(name), 'Private or server path in artifact.');
    const approvedAudio = licensedAssets.some(asset =>
      /^assets\/(.+)-[a-zA-Z0-9_-]{8}\.wav$/.exec(name)?.[1] === asset.buildName &&
      createHash('sha256').update(content).digest('hex') === asset.sha256);
    assert(approvedAudio || codecs.has(name) || /\.(html|js|css|json|webmanifest|png|svg|ico|woff2?|ttf|otf)$/.test(name) ||
      name === 'licenses/NotoSans-LICENSE.txt', 'Unapproved artifact file type or audio hash.');
  }
  const report = summarize(files);
  assert(files.size <= 15000, 'Free file-count limit exceeded.');
  assert(report.totalBytes <= 250000000, 'Free environment size limit exceeded.');
  return report;
}

export function validateApiArtifact(files, sourceFiles) {
  for (const name of ['host.json', 'package.json', 'package-lock.json', 'dist/functions.cjs']) {
    assert(files.has(name), 'Incomplete prebuilt API. Run the staging helper.');
    assert(files.get(name).equals(sourceFiles.get(name)), 'API artifact differs from reviewed build inputs.');
  }
  const manifest = JSON.parse(files.get('package.json'));
  assert.equal(manifest.main, 'dist/functions.cjs');
  assert.equal(manifest.engines.node, '>=22.12.0 <23');
  assert.equal(manifest.dependencies['@azure/functions'], '4.16.2');
  const host = JSON.parse(files.get('host.json'));
  assert.equal(host.version, '2.0');
  assert.equal(host.functionTimeout, '00:00:45');
  assert.equal(host.logging.logLevel.default, 'None');
  const lock = JSON.parse(files.get('package-lock.json'));
  const installed = JSON.parse(files.get('node_modules/.package-lock.json'));
  assert.equal(lock.lockfileVersion, 3);
  const packagePaths = Object.keys(installed.packages).sort((left, right) => right.length - left.length);
  assert(packagePaths.includes('node_modules/@azure/functions'));
  for (const name of packagePaths) {
    const entry = installed.packages[name];
    assert(name.startsWith('node_modules/') && !entry.dev && !entry.link, 'Nonproduction dependency in API stage.');
    assert(!lock.packages[name]?.dev && !lock.packages[name]?.link);
    assert.equal(entry.integrity, lock.packages[name]?.integrity);
    assert.match(entry.integrity, /^sha512-/);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.equal(entry.resolved, lock.packages[name]?.resolved);
    const dependency = JSON.parse(files.get(`${name}/package.json`));
    assert.equal(dependency.version, entry.version);
    assert.equal(entry.version, lock.packages[name]?.version);
  }
  for (const name of files.keys()) {
    assert(!/(^|\/)(\.env[^/]*|local-media|testing|test-results|coverage)(\/|$)|local\.settings\.json$|\.(mp3|wav|m4a|flac|ogg|opus|mp4)$/i.test(name), 'Private or unexpected API file.');
    if (['host.json', 'package.json', 'package-lock.json', 'dist/functions.cjs', 'node_modules/.package-lock.json'].includes(name)) continue;
    assert(packagePaths.some(packagePath => name.startsWith(`${packagePath}/`)), 'API file outside the production dependency allowlist.');
  }
  const report = summarize(files, true);
  assert(report.totalBytes <= 100000000, 'API stage exceeds the conservative 100 MB release bound.');
  return report;
}

export function readArtifact(directory) {
  const files = new Map();
  function visit(current) {
    assert(!lstatSync(current).isSymbolicLink(), 'Symlink in deployment artifact.');
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Symlink in deployment artifact.');
      const filename = resolve(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else {
        assert(entry.isFile(), 'Nonregular file in deployment artifact.');
        files.set(relative(directory, filename).replaceAll('\\', '/'), readFileSync(filename));
      }
    }
  }
  visit(directory);
  return files;
}

export function inspectArtifacts() {
  validateCodecDistribution(new Map(codecManifest.artifacts.map(artifact =>
    [artifact.path, readFileSync(resolve(root, artifact.path))])), { location: 'source', required: true });
  const frontend = validateArtifact(readArtifact(resolve(root, 'frontend/dist')),
    readFileSync(resolve(root, 'frontend/public/staticwebapp.config.json')),
    JSON.parse(readFileSync(resolve(root, 'docs/licensed-media.json'), 'utf8')).assets, { requireCodecs: true });
  const sourceFiles = new Map(['host.json', 'package.json', 'package-lock.json', 'dist/functions.cjs']
    .map(name => [name, readFileSync(resolve(root, 'api', name))]));
  const api = validateApiArtifact(readArtifact(apiDirectory), sourceFiles);
  return combineReports(frontend, api);
}

export function combineReports(frontend, api) {
  return { frontend, api, artifactSHA256: createHash('sha256')
    .update(`fim-release-v1\0static\0${frontend.artifactSHA256}\0api\0${api.artifactSHA256}`).digest('hex') };
}

export async function uploadApprovedArtifact(settings, run = execute) {
  const { subscription, resourceGroup, appName, apiResourceGroup, apiAppName, cliPath, workingDirectory, environment } = settings;
  const scope = ['--subscription', subscription, '--resource-group', resourceGroup, '--name', appName];
  const apiScope = ['--subscription', subscription, '--resource-group', apiResourceGroup, '--name', apiAppName];
  const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000, env: childEnvironment(environment) };
  let token;
  let stage = 'target lookup and Free-plan verification';
  try {
    const site = await verifyTarget(settings, run);
    const apiApp = await verifyApiTarget(settings, run);
    stage = 'deployment-token retrieval';
    const secretResult = await run('az', ['staticwebapp', 'secrets', 'list', ...scope, '--only-show-errors', '-o', 'json'], options);
    token = JSON.parse(secretResult.stdout).properties?.apiKey;
    assert(typeof token === 'string' && token.length > 0);
    const childEnv = childEnvironment(environment);
    Object.assign(childEnv, {
      HOME: resolve(workingDirectory, 'swa-home'),
      CI: '1',
      SWA_CLI_DEBUG: 'log',
      SWA_CLI_LOGIN_USE_KEYCHAIN: 'false',
      SWA_CLI_DEPLOYMENT_TOKEN: token
    });
    // Frontend-only: the API is a separate origin (standalone Function App), not an SWA-managed
    // or linked backend, so there is no --api-location for the SWA CLI to upload.
    stage = 'production upload and hostname verification';
    try {
      const result = await run(process.execPath, [cliPath, 'deploy', resolve(root, 'frontend/dist'),
        '--app-location', resolve(root, 'frontend/dist'), '--swa-config-location', resolve(root, 'frontend/dist'),
        '--env', 'production', '--no-use-keychain', '--verbose', 'log'],
      { ...options, cwd: workingDirectory, env: childEnv, timeout: 15 * 60 * 1000 });
      const receipt = new RegExp(`^(?:[\\u2714\\u221a] )?Project deployed to https://${site.defaultHostname.replaceAll('.', '\\.')}(?: \\u{1f680})?$`, 'u');
      assert([result.stdout, result.stderr].some(output =>
        stripVTControlCharacters(output ?? '').split(/\r?\n/).some(line => receipt.test(line.trim()))),
      'Uploader did not report the expected success receipt.');
    } finally {
      delete childEnv.SWA_CLI_DEPLOYMENT_TOKEN;
    }
    // A prior zip-deploy can leave WEBSITE_RUN_FROM_PACKAGE set, which then blocks the next one
    // with HTTP 409; clear it defensively (harmless if it was already absent).
    stage = 'clearing a stale WEBSITE_RUN_FROM_PACKAGE setting';
    try {
      await run('az', ['functionapp', 'config', 'appsettings', 'delete', ...apiScope,
        '--setting-names', 'WEBSITE_RUN_FROM_PACKAGE', '--only-show-errors', '-o', 'none'], options);
    } catch { /* absent is fine */ }
    stage = 'zipping the staged API artifact';
    const apiZipPath = resolve(workingDirectory, 'api-deploy.zip');
    await run('zip', ['-rq', apiZipPath, '.'], { ...options, cwd: apiDirectory });
    stage = 'API upload to the standalone Function App';
    try {
      await run('az', ['functionapp', 'deployment', 'source', 'config-zip', ...apiScope,
        '--src', apiZipPath, '--only-show-errors', '-o', 'none'], { ...options, timeout: 15 * 60 * 1000 });
    } finally {
      try { await run('rm', ['-f', apiZipPath], options); } catch { /* best effort cleanup */ }
    }
    return { hostname: `https://${site.defaultHostname}`, apiHostname: `https://${apiApp.defaultHostName}` };
  } catch {
    throw new Error(`Deployment stopped during ${stage}. Check Azure login, exact target, CLI/native dependencies and connectivity. Child output is withheld to protect credentials; do not enable debug logging.`);
  } finally {
    token = undefined;
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--deploy-approved'), 'Use no arguments for local checks, or --deploy-approved after lead approval.');
  const report = inspectArtifacts();
  console.log(JSON.stringify(report, null, 2));
  if (args.length === 0) return;
  assert.equal(process.env.REVIEWED_ARTIFACT_SHA256, report.artifactSHA256, 'Missing or stale security-preflight artifact approval.');
  const [subscription, resourceGroup, appName, apiResourceGroup, apiAppName] =
    ['AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP', 'SWA_NAME', 'AZURE_API_RESOURCE_GROUP', 'API_APP_NAME'].map(key => {
      assert(process.env[key]?.trim(), `Set ${key} explicitly.`);
      return process.env[key];
    });
  const workingDirectory = resolve(root, 'local-media/tools');
  const packageDirectory = resolve(workingDirectory, 'node_modules/@azure/static-web-apps-cli');
  assert.equal(JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8')).version, '2.0.10');
  const { hostname, apiHostname } = await uploadApprovedArtifact({ subscription, resourceGroup, appName, apiResourceGroup, apiAppName,
    cliPath: resolve(packageDirectory, 'dist/cli/bin.js'), workingDirectory, environment: process.env });
  console.log(`Upload completed: ${hostname} (API: ${apiHostname}). Live authorization and device acceptance are still required.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Release check/upload stopped. Verify reviewed artifacts, exact target, approval hash and tooling. Raw errors withheld.');
    process.exitCode = 1;
  });
}