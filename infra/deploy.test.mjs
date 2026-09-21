import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { combineReports, publicEmulatorConnection, target, uploadApprovedArtifact, validateApiArtifact, validateArtifact } from './deploy.mjs';
import { stageApi } from './stage.mjs';

const config = Buffer.from(JSON.stringify({ routes: [
  { route: '/.auth/login/aad', statusCode: 404 },
  { route: '/.auth/login/github', statusCode: 404 },
  { route: '/*', allowedRoles: ['anonymous'] }
] }));
const artifact = () => new Map([
  ['index.html', Buffer.from('<html></html>')],
  ['.vite/manifest.json', Buffer.from('{}')],
  ['sw.js', Buffer.from('self.REHEARSAL_HOSTED = true;')],
  ['staticwebapp.config.json', config]
]);

test('template leaves existing site untouched and adds only private Hot LRS Blob storage', () => {
  const template = JSON.parse(readFileSync(new URL('./template.json', import.meta.url)));
  assert.deepEqual(template.resources.map(resource => resource.type), [
    'Microsoft.Storage/storageAccounts',
    'Microsoft.Storage/storageAccounts/blobServices',
    'Microsoft.Storage/storageAccounts/blobServices/containers',
    'Microsoft.Storage/storageAccounts/managementPolicies', 'Microsoft.Consumption/budgets'
  ]);
  assert.deepEqual(template.parameters.location.allowedValues, ['westus2']);
  assert.deepEqual(template.parameters.staticSiteName.allowedValues, ['fitness-instructor-music-pilot2']);
  const [storage, blobs, container, lifecycle] = template.resources;
  assert.equal(storage.sku.name, 'Standard_LRS');
  assert.equal(storage.properties.accessTier, 'Hot');
  assert.equal(storage.properties.allowBlobPublicAccess, false);
  assert.equal(storage.properties.supportsHttpsTrafficOnly, true);
  assert.equal(storage.properties.minimumTlsVersion, 'TLS1_2');
  assert.equal(container.properties.publicAccess, 'None');
  assert.equal(blobs.properties.isVersioningEnabled, false);
  assert.equal(blobs.properties.deleteRetentionPolicy.enabled, false);
  assert.equal(blobs.properties.containerDeleteRetentionPolicy.enabled, false);
  const rules = lifecycle.properties.policy.rules;
  assert.equal(rules.length, 2);
  for (const [index, prefix] of ['sessions', 'uploads'].entries()) {
    assert.deepEqual(rules[index].definition.filters, {
      blobTypes: ['blockBlob'], prefixMatch: [`[format('{0}/${prefix}/', parameters('containerName'))]`]
    });
    assert.deepEqual(rules[index].definition.actions, {
      baseBlob: { delete: { daysAfterModificationGreaterThan: index === 0 ? 2 : 7 } }
    });
  }
});

test('resource-group budget alerts at 15/24/30 with role recipients and no automated spend action', () => {
  const template = JSON.parse(readFileSync(new URL('./template.json', import.meta.url)));
  const budget = template.resources.at(-1);
  assert.equal(budget.type, 'Microsoft.Consumption/budgets');
  assert.equal(budget.scope, undefined);
  assert.equal(budget.properties.amount, 30);
  assert.equal(budget.properties.timeGrain, 'Monthly');
  assert.equal(template.parameters.enableBudget.defaultValue, true);
  assert.deepEqual(template.parameters.budgetContactRoles.defaultValue, ['Owner']);
  assert.deepEqual(Object.values(budget.properties.notifications).map(notification => notification.threshold * 30 / 100), [15, 24, 30]);
  for (const notification of Object.values(budget.properties.notifications)) {
    assert.equal(notification.thresholdType, 'Actual');
    assert.equal(notification.operator, 'GreaterThanOrEqualTo');
    assert.equal(notification.contactRoles, "[parameters('budgetContactRoles')]");
    assert.equal(notification.contactEmails, undefined);
    assert.equal(notification.contactGroups, undefined);
  }
  assert(!JSON.stringify(template.outputs).includes('listKeys'));
});

test('artifact check is deterministic and notices content changes', () => {
  const files = artifact();
  const first = validateArtifact(files, config, []);
  assert.deepEqual(validateArtifact(new Map([...files].reverse()), config, []), first);
  files.set('index.html', Buffer.from('changed'));
  assert.notEqual(validateArtifact(files, config, []).artifactSHA256, first.artifactSHA256);
});

test('missing, stale or unprotected auth configuration fails closed', () => {
  const files = artifact();
  files.delete('staticwebapp.config.json');
  assert.throws(() => validateArtifact(files, config, []), /Missing built/);
  assert.throws(() => validateArtifact(artifact(), Buffer.from('{}'), []), /differs/);
  const unsafe = Buffer.from(JSON.stringify({ routes: [{ route: '/*', allowedRoles: ['authenticated'] }] }));
  files.set('staticwebapp.config.json', unsafe);
  assert.throws(() => validateArtifact(files, unsafe, []));
});

test('private media, configuration and source maps are rejected', () => {
  for (const name of ['assets/song.mp3', 'assets/song.wav', 'local-media/song.json', '.env', 'settings.local.json', 'assets/index.js.map']) {
    const files = artifact();
    files.set(name, Buffer.from('fixture'));
    assert.throws(() => validateArtifact(files, config, []));
  }
});

const settings = {
  subscription: '00000000-0000-0000-0000-000000000000', resourceGroup: target.resourceGroup, appName: target.appName,
  apiResourceGroup: target.apiResourceGroup, apiAppName: target.apiAppName,
  cliPath: '/tools/cli.js', workingDirectory: '/tools', environment: {
    PATH: '/bin', SWA_CLI_DEBUG: 'silly', AZURE_CLIENT_SECRET: 'not-forwarded', SWA_EXPECTED_HOSTNAME: 'fixture-pilot.1.azurestaticapps.net'
  }
};
const account = { id: settings.subscription, name: 'Visual Studio Enterprise Subscription', state: 'Enabled' };
const site = { id: `/subscriptions/${settings.subscription}/resourceGroups/${settings.resourceGroup}/providers/Microsoft.Web/staticSites/${settings.appName}`,
  name: settings.appName, sku: { name: 'Free' }, location: 'West US 2', provider: 'Custom', defaultHostname: settings.environment.SWA_EXPECTED_HOSTNAME };
const apiApp = { id: `/subscriptions/${settings.subscription}/resourceGroups/${settings.apiResourceGroup}/providers/Microsoft.Web/sites/${settings.apiAppName}`,
  name: settings.apiAppName, kind: 'functionapp,linux', state: 'Running', defaultHostName: `${settings.apiAppName}.azurewebsites.net` };

test('production upload uses a scoped token only in child env and bypasses keychain', async () => {
  const calls = [];
  const mockRun = async (command, args, options) => {
    calls.push({ command, args });
    assert(!args.includes('test-only-token'));
    if (command === 'az') {
      assert(args.includes(settings.subscription));
      if (args[0] === 'account') return { stdout: JSON.stringify(account) };
      if (args[0] === 'staticwebapp' && args[1] === 'show') return { stdout: JSON.stringify(site) };
      if (args[0] === 'functionapp' && args[1] === 'show') return { stdout: JSON.stringify(apiApp) };
      if (args[0] === 'staticwebapp' && args[1] === 'secrets') return { stdout: JSON.stringify({ properties: { apiKey: 'test-only-token' } }) };
      if (args[0] === 'functionapp' && args[1] === 'config') { assert(args.includes('WEBSITE_RUN_FROM_PACKAGE')); return { stdout: '' }; }
      assert(args[0] === 'functionapp' && args[1] === 'deployment');
      return { stdout: '' };
    }
    if (command === 'zip' || command === 'rm') return { stdout: '' };
    assert.equal(options.env.SWA_CLI_DEPLOYMENT_TOKEN, 'test-only-token');
    assert.equal(options.env.SWA_CLI_DEBUG, 'log');
    assert.equal(options.env.AZURE_CLIENT_SECRET, undefined);
    assert.equal(options.env.SWA_EXPECTED_HOSTNAME, undefined);
    assert.equal(options.env.SWA_CLI_LOGIN_USE_KEYCHAIN, 'false');
    assert(args.includes('production'));
    assert(args.includes('--no-use-keychain'));
    assert(!args.includes('--api-location'));
    assert(!args.includes('--api-language'));
    assert(!args.includes('--api-version'));
    assert(!args.includes('--deployment-token'));
    return { stdout: `Project deployed to https://${site.defaultHostname}` };
  };
  const result = await uploadApprovedArtifact(settings, mockRun);
  assert.deepEqual(result, { hostname: `https://${site.defaultHostname}`, apiHostname: `https://${apiApp.defaultHostName}` });
  assert.equal(calls.length, 9);
});

for (const stream of ['stdout', 'stderr']) {
  test(`exact success receipt on ${stream} is accepted without exposing raw output`, async context => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method => context.mock.method(console, method, () => {}));
    let childEnv;
    const result = await uploadApprovedArtifact(settings, async (command, args, options) => {
      if (command === 'az') {
        if (args[0] === 'account') return { stdout: JSON.stringify(account) };
        if (args[0] === 'staticwebapp' && args[1] === 'show') return { stdout: JSON.stringify(site) };
        if (args[0] === 'functionapp' && args[1] === 'show') return { stdout: JSON.stringify(apiApp) };
        if (args[0] === 'staticwebapp' && args[1] === 'secrets') return { stdout: JSON.stringify({ properties: { apiKey: 'test-only-token' } }) };
        return { stdout: '' };
      }
      if (command === 'zip' || command === 'rm') return { stdout: '' };
      childEnv = options.env;
      return {
        stdout: 'raw stdout test-only-token', stderr: 'raw stderr test-only-token',
        [stream]: `raw ${stream} test-only-token\n\u001b[32m\u2714 Project deployed to \u001b[4mhttps://${site.defaultHostname}\u001b[24m \u{1f680}\u001b[39m\r\n`
      };
    });
    assert.deepEqual(result, { hostname: `https://${site.defaultHostname}`, apiHostname: `https://${apiApp.defaultHostName}` });
    assert.equal(childEnv.SWA_CLI_DEPLOYMENT_TOKEN, undefined);
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
  });

  test(`wrong hosts and non-receipts on ${stream} fail closed`, async () => {
    for (const output of [
      '',
      `Expected URL: https://${site.defaultHostname}`,
      `Error: Project deployed to https://${site.defaultHostname}`,
      'Project deployed to https://other.1.azurestaticapps.net',
      `Project deployed to https://prefix-${site.defaultHostname}`,
      `Project deployed to https://${site.defaultHostname.replaceAll('.', 'x')}`,
      ...['.evil.invalid', '@evil.invalid', ':443', '/evil.invalid', '?other=host', '#fragment'].map(suffix =>
        `Project deployed to https://${site.defaultHostname}${suffix}`)
    ]) {
      await assert.rejects(uploadApprovedArtifact(settings, async (command, args) => {
        if (command === 'az') {
          if (args[0] === 'account') return { stdout: JSON.stringify(account) };
          if (args[0] === 'staticwebapp' && args[1] === 'show') return { stdout: JSON.stringify(site) };
          if (args[0] === 'functionapp' && args[1] === 'show') return { stdout: JSON.stringify(apiApp) };
          return { stdout: JSON.stringify({ properties: { apiKey: 'test-only-token' } }) };
        }
        return { [stream]: `${output}\nraw ${stream} test-only-token` };
      }), error => error.message.includes('hostname verification') && error.message.includes('withheld') &&
        !error.message.includes('test-only-token') && !error.message.includes('raw') && error.cause === undefined);
    }
  });
}

test('missing or invalid expected hostname prevents any Azure command', async () => {
  for (const hostname of [undefined, '', '<approved-production-hostname>', 'https://fixture-pilot.1.azurestaticapps.net',
    'fixture-pilot.1.azurestaticapps.net/path', 'fixture-pilot.1.azurestaticapps.net.evil.invalid']) {
    let calls = 0;
    await assert.rejects(uploadApprovedArtifact({ ...settings,
      environment: { ...settings.environment, SWA_EXPECTED_HOSTNAME: hostname }
    }, async () => { calls += 1; throw new Error('Unexpected Azure command'); }), /Deployment stopped/);
    assert.equal(calls, 0);
  }
});

test('matching expected hostname cannot bypass account or ARM identity verification', async () => {
  for (const [accountChange, siteChange] of [
    [{ id: '11111111-1111-1111-1111-111111111111' }, {}],
    [{ name: 'different-offer' }, {}],
    [{ state: 'Disabled' }, {}],
    [{}, { id: `${site.id}-other` }],
    [{}, { name: 'other-site' }],
    [{}, { location: 'eastus' }],
    [{}, { provider: 'GitHub' }],
    [{}, { repositoryUrl: 'https://example.invalid/repository' }]
  ]) {
    let calls = 0;
    await assert.rejects(uploadApprovedArtifact(settings, async (command, args) => {
      calls += 1;
      assert.equal(command, 'az');
      assert(!args.includes('secrets'));
      return { stdout: JSON.stringify(args[0] === 'account' ? { ...account, ...accountChange } : { ...site, ...siteChange }) };
    }), /Deployment stopped/);
    assert.equal(calls, Object.keys(accountChange).length ? 1 : 2);
  }
});

test('mismatched Function App identity, kind, state or hostname stops before token retrieval', async () => {
  for (const apiAppChange of [
    { id: `${apiApp.id}-other` }, { name: 'other-app' }, { kind: 'functionapp' },
    { state: 'Stopped' }, { defaultHostName: 'other.azurewebsites.net' }
  ]) {
    let calls = 0;
    await assert.rejects(uploadApprovedArtifact(settings, async (command, args) => {
      calls += 1;
      assert.equal(command, 'az');
      assert(!args.includes('secrets'));
      if (args[0] === 'account') return { stdout: JSON.stringify(account) };
      if (args[0] === 'staticwebapp') return { stdout: JSON.stringify(site) };
      return { stdout: JSON.stringify({ ...apiApp, ...apiAppChange }) };
    }), /Deployment stopped/);
    assert.equal(calls, 3);
  }
});

test('wrong SKU prevents token retrieval', async () => {
  let calls = 0;
  await assert.rejects(uploadApprovedArtifact(settings, async () => {
    calls += 1;
    if (calls === 1) return { stdout: JSON.stringify(account) };
    return { stdout: JSON.stringify({ ...site, sku: { name: 'Standard' } }) };
  }), /Deployment stopped/);
  assert.equal(calls, 2);
});

test('a different hostname stops before token retrieval', async () => {
  let calls = 0;
  await assert.rejects(uploadApprovedArtifact(settings, async () => {
    calls += 1;
    return { stdout: JSON.stringify(calls === 1 ? account : { ...site, defaultHostname: 'other.1.azurestaticapps.net' }) };
  }), /Deployment stopped/);
  assert.equal(calls, 2);
});

test('nonzero child exit fails despite success receipts and never exposes raw output', async context => {
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method => context.mock.method(console, method, () => {}));
  let calls = 0;
  let childEnv;
  await assert.rejects(uploadApprovedArtifact(settings, async (command, args, options) => {
    calls += 1;
    if (calls === 1) return { stdout: JSON.stringify(account) };
    if (calls === 2) return { stdout: JSON.stringify(site) };
    if (calls === 3) return { stdout: JSON.stringify(apiApp) };
    if (calls === 4) return { stdout: JSON.stringify({ properties: { apiKey: 'test-only-token' } }) };
    childEnv = options.env;
    throw Object.assign(new Error('raw process error test-only-token'), {
      code: 1,
      stdout: `Project deployed to https://${site.defaultHostname}\nraw stdout test-only-token`,
      stderr: `\u2714 Project deployed to https://${site.defaultHostname} \u{1f680}\nraw stderr test-only-token`
    });
  }), error => !error.message.includes('test-only-token') && !error.message.includes('raw') &&
    error.message.includes('withheld') && error.cause === undefined);
  assert.equal(childEnv.SWA_CLI_DEPLOYMENT_TOKEN, undefined);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test('local-mode offline worker cannot be deployed', () => {
  const files = artifact();
  files.set('sw.js', Buffer.from('self.REHEARSAL_HOSTED = false;'));
  assert.throws(() => validateArtifact(files, config, []), /local-mode build/);
});

test('runtime, route forwarding and absence of platform auth are mandatory', () => {
  for (const change of [
    value => { value.routes.splice(0, 1); },
    value => { value.routes[0].statusCode = 302; },
    value => { value.platform = { apiRuntime: 'node:22' }; },
    value => { value.routes.push({ route: '/api/*', allowedRoles: ['anonymous'] }); },
    value => { value.auth = {}; },
    value => { value.responseOverrides = { 401: { redirect: '/signin.html' } }; },
    value => { value.routes[0].rewrite = '/index.html'; }
  ]) {
    const value = JSON.parse(config);
    change(value);
    const bytes = Buffer.from(JSON.stringify(value));
    const files = artifact();
    files.set('staticwebapp.config.json', bytes);
    assert.throws(() => validateArtifact(files, bytes, []));
  }
});

test('combined approval binds both artifacts with distinct labels', () => {
  const frontend = { artifactSHA256: 'a'.repeat(64) };
  const api = { artifactSHA256: 'b'.repeat(64) };
  const first = combineReports(frontend, api).artifactSHA256;
  assert.equal(combineReports(frontend, api).artifactSHA256, first);
  assert.notEqual(combineReports(api, frontend).artifactSHA256, first);
  assert.notEqual(combineReports(frontend, frontend).artifactSHA256, first);
});

test('credential-shaped static content is rejected', () => {
  const files = artifact();
  files.set('assets/leak.js', Buffer.from(`AccountKey=${'A'.repeat(86)}==`));
  assert.throws(() => validateArtifact(files, config, []), /Credential-shaped/);
});

function apiFixture() {
  const dependency = { version: '4.16.2', integrity: 'sha512-test-fixture', resolved: 'https://registry.npmjs.org/@azure/functions/-/functions-4.16.2.tgz' };
  const manifest = { main: 'dist/functions.cjs', engines: { node: '>=22.12.0 <23' }, dependencies: { '@azure/functions': '4.16.2' } };
  const lock = { lockfileVersion: 3, packages: { 'node_modules/@azure/functions': dependency } };
  const json = value => Buffer.from(JSON.stringify(value));
  return new Map([
    ['package.json', json(manifest)], ['package-lock.json', json(lock)],
    ['host.json', json({ version: '2.0', functionTimeout: '00:00:45', logging: { logLevel: { default: 'None' } } })],
    ['dist/functions.cjs', Buffer.from('require("@azure/functions");')],
    ['node_modules/.package-lock.json', json(lock)],
    ['node_modules/@azure/functions/package.json', json({ version: '4.16.2' })],
    ['node_modules/@azure/functions/index.js', Buffer.from('module.exports = {};')]
  ]);
}

test('API stage permits only matching build inputs and locked production packages', () => {
  const files = apiFixture();
  assert.equal(validateApiArtifact(files, files).fileCount, 7);
  for (const name of ['local.settings.json', '.env', 'dist/functions.cjs.map', 'testing/report.json', 'song.mp3', 'node_modules/unlocked/index.js']) {
    const changed = new Map(files);
    changed.set(name, Buffer.from('{}'));
    assert.throws(() => validateApiArtifact(changed, files));
  }
  const changed = new Map(files);
  changed.set('dist/functions.cjs', Buffer.from('stale'));
  assert.throws(() => validateApiArtifact(changed, files), /differs/);
  const installed = JSON.parse(files.get('node_modules/.package-lock.json'));
  installed.packages['node_modules/@azure/functions'].dev = true;
  changed.set('dist/functions.cjs', files.get('dist/functions.cjs'));
  changed.set('node_modules/.package-lock.json', Buffer.from(JSON.stringify(installed)));
  assert.throws(() => validateApiArtifact(changed, files), /Nonproduction/);
});

test('staging builds separately, installs production-only, never copies environment or tests', async () => {
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'fim-stage-test-'));
  const npmCli = resolve(projectRoot, 'fixture-npm-cli.js');
  const files = apiFixture();
  try {
    mkdirSync(resolve(projectRoot, 'api/dist'), { recursive: true });
    for (const [name, bytes] of files) {
      if (!name.startsWith('node_modules/')) writeFileSync(resolve(projectRoot, 'api', name), bytes);
    }
    writeFileSync(resolve(projectRoot, 'api/.env'), 'test-only-do-not-copy');
    const calls = [];
    const run = async (command, args, options) => {
      calls.push(args);
      assert.equal(command, process.execPath);
      assert.equal(args[0], npmCli);
      assert.equal(options.env.FIM_ACCOUNTS_JSON, undefined);
      if (args.includes('--omit=dev')) {
        assert(args.includes('--ignore-scripts'));
        assert(args.includes('--bin-links=false'));
        const staging = args[args.indexOf('--prefix') + 1];
        mkdirSync(resolve(staging, 'node_modules/@azure/functions'), { recursive: true });
        for (const [name, bytes] of files) if (name.startsWith('node_modules/')) writeFileSync(resolve(staging, name), bytes);
      }
      return { stdout: '' };
    };
    for (const invalidCli of [null, '', 'relative/npm-cli.js']) {
      await assert.rejects(stageApi({ projectRoot, npmCli: invalidCli }, run), /Export NPM_CLI/);
      assert.equal(existsSync(resolve(projectRoot, 'local-media')), false);
      assert.equal(calls.length, 0);
    }
    await stageApi({ projectRoot, npmCli }, run);
    assert.equal(calls.length, 3);
    assert(calls[0].includes('ci'));
    assert(calls[1].includes('build'));
    assert.equal(existsSync(resolve(projectRoot, 'local-media/deployment/api/.env')), false);
    assert.equal(existsSync(resolve(projectRoot, 'frontend')), false);
    await assert.rejects(stageApi({ projectRoot, npmCli }, run), /stage exists/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('only the exact published SDK emulator constant is exempt in the private server bundle', () => {
  const files = apiFixture();
  files.set('dist/functions.cjs', Buffer.from(publicEmulatorConnection));
  assert.doesNotThrow(() => validateApiArtifact(files, files));
  files.set('dist/functions.cjs', Buffer.from(publicEmulatorConnection.replace('devstoreaccount1', 'realaccount')));
  assert.throws(() => validateApiArtifact(files, files), /Credential-shaped/);
  files.set('dist/functions.cjs', Buffer.from(`${publicEmulatorConnection} AccountKey=${'A'.repeat(86)}==`));
  assert.throws(() => validateApiArtifact(files, files), /Credential-shaped/);
  const frontend = artifact();
  frontend.set('assets/leak.js', Buffer.from(publicEmulatorConnection));
  assert.throws(() => validateArtifact(frontend, config, []), /Credential-shaped/);
});

test('the locked storage-blob and storage-common dependencies share the published emulator constant', () => {
  for (const packageName of ['storage-blob', 'storage-common']) {
    const files = apiFixture();
    const packagePath = `node_modules/@azure/${packageName}`;
    const lock = JSON.parse(files.get('package-lock.json'));
    lock.packages[packagePath] = { ...lock.packages['node_modules/@azure/functions'] };
    const bytes = Buffer.from(JSON.stringify(lock));
    files.set('package-lock.json', bytes);
    files.set('node_modules/.package-lock.json', bytes);
    files.set(`${packagePath}/package.json`, Buffer.from('{"version":"4.16.2"}'));
    files.set(`${packagePath}/dist/constants.js`, Buffer.from(publicEmulatorConnection));
    assert.doesNotThrow(() => validateApiArtifact(files, files));
    files.set(`${packagePath}/dist/constants.js`, Buffer.from(publicEmulatorConnection.replace('devstoreaccount1', 'changed')));
    assert.throws(() => validateApiArtifact(files, files), /Credential-shaped/);
  }
});

test('offline staging rebuilds changed API bytes without installs or reusing the old bundle', async () => {
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'fim-stage-offline-'));
  const files = apiFixture();
  const manifest = JSON.parse(files.get('package.json'));
  manifest.devDependencies = { esbuild: '0.25.12' };
  files.set('package.json', Buffer.from(JSON.stringify(manifest)));
  const lock = JSON.parse(files.get('package-lock.json'));
  lock.packages['node_modules/esbuild'] = { version: '0.25.12', dev: true };
  files.set('package-lock.json', Buffer.from(JSON.stringify(lock)));
  const destination = resolve(projectRoot, 'local-media/deployment/api');
  try {
    for (const prefix of [resolve(projectRoot, 'api'), destination]) {
      for (const [name, bytes] of files) {
        mkdirSync(resolve(prefix, name, '..'), { recursive: true });
        writeFileSync(resolve(prefix, name), bytes);
      }
    }
    mkdirSync(resolve(projectRoot, 'api/node_modules/esbuild'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'api/node_modules/esbuild/package.json'), '{"version":"0.25.12"}');
    const calls = [];
    const fresh = Buffer.from('require("@azure/functions"); exports.schemaVersion = 2;');
    const options = { projectRoot, npmCli: resolve(projectRoot, 'npm-cli.js'), offline: true, replace: true };
    const run = async (_command, args) => {
      calls.push(args);
      assert(args.includes('build') && !args.includes('ci'));
      writeFileSync(resolve(projectRoot, 'api/dist/functions.cjs'), fresh);
      return { stdout: '' };
    };
    const oldHash = validateApiArtifact(files, files).artifactSHA256;
    const report = await stageApi(options, run);
    assert.equal(calls.length, 1);
    assert.notEqual(report.artifactSHA256, oldHash);
    assert.deepEqual(readFileSync(resolve(destination, 'dist/functions.cjs')), fresh);
    const mismatched = JSON.parse(files.get('package-lock.json'));
    mismatched.packages['node_modules/@azure/functions'].version = '99.0.0';
    writeFileSync(resolve(projectRoot, 'api/package-lock.json'), JSON.stringify(mismatched));
    await assert.rejects(stageApi(options, run), /differs/);
    assert.equal(calls.length, 1);
    assert.deepEqual(readFileSync(resolve(destination, 'dist/functions.cjs')), fresh);
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});