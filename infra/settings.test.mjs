import assert from 'node:assert/strict';
import { scrypt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { target } from './deploy.mjs';
import { accountsFromSource, applySettings, hashPassword, promptAccounts, readPassword, validateAccounts, validateAccountUpdate, withPrivateBody } from './settings.mjs';

const owner = () => ({ id: 'fixture-owner', username: 'fixture.owner', role: 'owner', enabled: true,
  authVersion: 1, passwordHash: `scrypt$32768$8$3$${'a'.repeat(32)}$${'b'.repeat(64)}` });

test('account schema requires exact fields, unique identities and enabled owner', () => {
  assert.equal(validateAccounts([owner()]).length, 1);
  for (const value of [[], [owner(), owner()], [{ ...owner(), role: 'admin' }], [{ ...owner(), enabled: false }],
    [{ ...owner(), username: 'UPPER' }], [{ ...owner(), authVersion: 0 }], [{ ...owner(), passwordHash: 'plaintext' }],
    [{ ...owner(), extra: true }], [{ ...owner(), id: '../bad' }]]) {
    assert.throws(() => validateAccounts(value));
  }
  assert.throws(() => validateAccountUpdate([{ ...owner(), id: 'replacement' }], [owner()]));
  assert.throws(() => validateAccountUpdate([{ ...owner(), username: 'renamed' }], [owner()]));
  assert.doesNotThrow(() => validateAccountUpdate([{ ...owner(), username: 'renamed', authVersion: 2 }], [owner()]));
});

test('async scrypt uses the exact API salt, work factors, encoding and key length', async () => {
  const password = 'test-only password';
  const encoded = await hashPassword(password);
  const parts = encoded.split('$');
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '32768', '8', '3']);
  assert.match(parts[4], /^[a-f0-9]{32}$/);
  assert.match(parts[5], /^[a-f0-9]{64}$/);
  const key = await promisify(scrypt)(password, Buffer.from(parts[4], 'hex'), 32, { N: 32768, r: 8, p: 3, maxmem: 50331648 });
  assert.equal(key.toString('hex'), parts[5]);
  assert.notEqual(await hashPassword(password), encoded);
  await assert.rejects(hashPassword(''));
  await assert.rejects(hashPassword('x'.repeat(1025)));
});

test('interactive update confirms password, preserves ID and increments authVersion', async () => {
  const answers = [' Fixture.Owner ', 'owner', 'yes', ''];
  const accounts = await promptAccounts([owner()], { question: async () => answers.shift(), password: async () => 'test-only password' });
  assert.equal(accounts[0].id, owner().id);
  assert.equal(accounts[0].username, owner().username);
  assert.equal(accounts[0].authVersion, 2);
  assert.notEqual(accounts[0].passwordHash, owner().passwordHash);
  const prompts = ['new-owner', 'owner', 'yes'];
  let reads = 0;
  await assert.rejects(promptAccounts([], { question: async () => prompts.shift(), password: async () => `mismatch-${reads++}` }), /match/);
  await assert.rejects(promptAccounts([], { question: async () => '', password: async () => '' }), /accounts/);
});

test('password terminal never echoes keys and restores terminal after enter/cancel', async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {};
  input.pause = () => {};
  let outputText = '';
  const output = { isTTY: true, write: text => { outputText += text; } };
  const reading = readPassword('Password: ', input, output);
  input.emit('keypress', 'secret-fixture', {});
  input.emit('keypress', '', { name: 'return' });
  assert.equal(await reading, 'secret-fixture');
  assert.equal(outputText, 'Password: \n');
  assert.equal(input.isRaw, false);
  const cancelled = readPassword('Password: ', input, output);
  input.emit('keypress', '', { ctrl: true, name: 'c' });
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(input.isRaw, false);
  const controller = new AbortController();
  const terminated = readPassword('Password: ', input, output, controller.signal);
  controller.abort();
  await assert.rejects(terminated, /cancelled/);
  assert.equal(input.isRaw, false);
  assert.throws(() => readPassword('', { isTTY: false }, output), /private interactive/);
});

test('private REST body has restrictive permissions and is deleted on success/failure', async () => {
  const privateBase = mkdtempSync(resolve(tmpdir(), 'fim-private-test-'));
  let filename;
  try {
    for (const fail of [false, true]) {
      const operation = withPrivateBody({ secret: 'test-only' }, async path => {
        filename = path;
        assert.equal(lstatSync(path).mode & 0o777, 0o600);
        assert.equal(lstatSync(resolve(path, '..')).mode & 0o777, 0o700);
        assert.equal(JSON.parse(readFileSync(path)).properties.secret, 'test-only');
        if (fail) throw new Error('fake failure');
      }, privateBase);
      if (fail) await assert.rejects(operation);
      else await operation;
      assert.equal(existsSync(filename), false);
    }
  } finally {
    rmSync(privateBase, { recursive: true, force: true });
  }
});

const scope = { subscription: '00000000-0000-0000-0000-000000000000',
  resourceGroup: target.resourceGroup, appName: target.appName, storageAccount: 'fixturestorage', container: 'private-library',
  environment: { SWA_EXPECTED_HOSTNAME: 'fixture-pilot.1.azurestaticapps.net' } };
const siteId = `/subscriptions/${scope.subscription}/resourceGroups/${scope.resourceGroup}/providers/Microsoft.Web/staticSites/${scope.appName}`;

function azureFixture(current, inspectPut, { failPut = false, unsafeStorage = false, unsafeLifecycle = false } = {}) {
  return async (command, args, options) => {
    assert.equal(command, 'az');
    assert(args.includes(scope.subscription));
    assert.equal(options.env.FIM_ACCOUNTS_JSON, undefined);
    assert.equal(options.env.FIM_STORAGE_CONNECTION_STRING, undefined);
    assert(!args.join(' ').includes('scrypt$'));
    assert(!args.join(' ').includes('AccountKey='));
    assert(!args.includes('--setting-names'));
    const json = value => ({ stdout: JSON.stringify(value) });
    if (args[0] === 'account') return json({ id: scope.subscription, name: 'Visual Studio Enterprise Subscription', state: 'Enabled' });
    if (args[0] === 'staticwebapp' && args[1] === 'appsettings') {
      assert.deepEqual(args, ['staticwebapp', 'appsettings', 'list', '--subscription', scope.subscription,
        '--resource-group', scope.resourceGroup, '--name', scope.appName, '--only-show-errors', '-o', 'json']);
      return json({ properties: current });
    }
    if (args[0] === 'staticwebapp') return json({ id: siteId, name: scope.appName, sku: { name: 'Free' },
      location: 'westus2', provider: 'Custom', defaultHostname: scope.environment.SWA_EXPECTED_HOSTNAME });
    const url = args[args.indexOf('--url') + 1];
    const method = args[args.indexOf('--method') + 1];
    if (url.includes('/listKeys')) return json({ keys: [{ keyName: 'key1', permissions: 'FULL', value: Buffer.alloc(64, 1).toString('base64') }] });
    if (url.includes('/containers/')) return json({ properties: { publicAccess: unsafeStorage ? 'Blob' : 'None' } });
    if (url.includes('/blobServices/')) return json({ properties: { isVersioningEnabled: false,
      deleteRetentionPolicy: { enabled: false }, containerDeleteRetentionPolicy: { enabled: false } } });
    if (url.includes('/managementPolicies/')) return json({ properties: { policy: { rules: [
      ['sessions', 2], [unsafeLifecycle ? 'assets' : 'uploads', 7]
    ].map(([prefix, days]) => ({ enabled: true, type: 'Lifecycle', definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: [`${scope.container}/${prefix}/`] },
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: days } } }
    } })) } } });
    if (url.includes('/storageAccounts/')) return json({ id: url.slice('https://management.azure.com'.length).split('?')[0],
      location: 'westus2', kind: 'StorageV2', sku: { name: 'Standard_LRS' }, properties: { accessTier: 'Hot',
        allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2' } });
    assert.equal(method, 'put');
    assert.equal(args.at(-1), 'none');
    const bodyArg = args[args.indexOf('--body') + 1];
    assert(bodyArg.startsWith('@'));
    inspectPut(JSON.parse(readFileSync(bodyArg.slice(1))).properties, bodyArg.slice(1));
    if (failPut) throw new Error('unsafe raw stderr AccountKey=do-not-return');
    return { stdout: '' };
  };
}

test('settings target mismatch stops before settings reads, keys or password prompts', async () => {
  for (const mode of ['storage', 'interactive', 'source']) {
    let calls = 0;
    await assert.rejects(applySettings({ ...scope, mode,
      environment: { SWA_EXPECTED_HOSTNAME: 'other-fixture.1.azurestaticapps.net' }
    }, {
      accountsPrompt: async () => assert.fail('Unexpected password prompt'),
      run: async (command, args, options) => {
        calls += 1;
        assert(['account', 'staticwebapp'].includes(args[0]), 'Unexpected settings or secret operation');
        return azureFixture({}, () => assert.fail('Unexpected settings write'))(command, args, options);
      }
    }), /Settings update stopped/);
    assert.equal(calls, 2);
  }
});

test('storage mode preserves accounts/settings and never invents an account', async () => {
  const privateBase = mkdtempSync(resolve(tmpdir(), 'fim-settings-test-'));
  try {
    for (const current of [{ EXISTING: 'preserve-me' }, { FIM_ACCOUNTS_JSON: JSON.stringify([owner()]) }]) {
      let filename;
      let settingsReads = 0;
      const run = azureFixture(current, (properties, path) => {
        filename = path;
        for (const key of Object.keys(current)) assert.equal(properties[key], current[key]);
        assert.equal(properties.FIM_ACCOUNTS_JSON, current.FIM_ACCOUNTS_JSON);
        assert.equal(properties.FIM_ORIGIN, `https://${scope.environment.SWA_EXPECTED_HOSTNAME}`);
        assert.equal(properties.FIM_STORAGE_CONTAINER, scope.container);
        assert.equal(properties.FIM_STORAGE_CONNECTION_STRING,
          `DefaultEndpointsProtocol=https;AccountName=fixturestorage;AccountKey=${Buffer.alloc(64, 1).toString('base64')};EndpointSuffix=core.windows.net`);
      });
      await applySettings({ ...scope, mode: 'storage' }, { privateBase, run: async (command, args, options) => {
        if (args[0] === 'staticwebapp' && args[1] === 'appsettings') settingsReads += 1;
        return run(command, args, options);
      } });
      assert.equal(settingsReads, 2);
      assert.equal(existsSync(filename), false);
    }
    await assert.rejects(applySettings({ ...scope, mode: 'storage' }, { privateBase,
      run: azureFixture({}, () => assert.fail('unsafe storage must not write'), { unsafeStorage: true }) }), /Settings update stopped/);
    await assert.rejects(applySettings({ ...scope, mode: 'storage' }, { privateBase,
      run: azureFixture({}, () => assert.fail('unsafe lifecycle must not write'), { unsafeLifecycle: true }) }), /Settings update stopped/);
  } finally {
    rmSync(privateBase, { recursive: true, force: true });
  }
});

test('secure source writes only validated hashes and sanitizes write failure with cleanup', async () => {
  const privateBase = mkdtempSync(resolve(tmpdir(), 'fim-source-test-'));
  let filename;
  try {
    const environment = { ...scope.environment, FIM_ACCOUNTS_JSON: JSON.stringify([owner()]), FIM_STORAGE_CONNECTION_STRING: 'never-forward' };
    assert.equal(accountsFromSource(environment)[0].id, owner().id);
    assert.throws(() => accountsFromSource({}));
    assert.throws(() => accountsFromSource({ ...environment, FIM_ACCOUNTS_FILE: '/not-allowed' }));
    await assert.rejects(applySettings({ ...scope, mode: 'source', environment }, { privateBase,
      run: azureFixture({ EXISTING: 'preserved' }, (properties, path) => {
        filename = path;
        assert.equal(properties.EXISTING, 'preserved');
        assert.equal(properties.FIM_ACCOUNTS_JSON, environment.FIM_ACCOUNTS_JSON);
      }, { failPut: true }) }), error => !error.message.includes('AccountKey=') && error.message.includes('withheld'));
    assert.equal(existsSync(filename), false);
  } finally {
    rmSync(privateBase, { recursive: true, force: true });
  }
});

test('account source file must be private, external, regular and nonsymlink', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'fim-account-source-test-'));
  const filename = resolve(directory, 'accounts.json');
  try {
    writeFileSync(filename, JSON.stringify([owner()]), { mode: 0o600 });
    assert.deepEqual(accountsFromSource({ FIM_ACCOUNTS_FILE: filename }), [owner()]);
    chmodSync(filename, 0o644);
    assert.throws(() => accountsFromSource({ FIM_ACCOUNTS_FILE: filename }), /permissions/);
    chmodSync(filename, 0o600);
    const link = resolve(directory, 'linked.json');
    symlinkSync(filename, link);
    assert.throws(() => accountsFromSource({ FIM_ACCOUNTS_FILE: link }), /nonsymlink/);
    writeFileSync(filename, 'x'.repeat(32769));
    assert.throws(() => accountsFromSource({ FIM_ACCOUNTS_FILE: filename }), /too large/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});