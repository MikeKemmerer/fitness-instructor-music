import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { childEnvironment, verifyTarget } from './deploy.mjs';

const derive = promisify(scrypt);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hashPattern = /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}$/;

export function validateAccounts(value) {
  assert(Array.isArray(value) && value.length >= 1 && value.length <= 32, 'Invalid accounts.');
  assert(Buffer.byteLength(JSON.stringify(value)) <= 32768, 'Invalid accounts.');
  const ids = new Set();
  const usernames = new Set();
  for (const account of value) {
    assert(account && typeof account === 'object' && !Array.isArray(account), 'Invalid account.');
    assert(Object.keys(account).sort().join(',') === 'authVersion,enabled,id,passwordHash,role,username', 'Invalid account fields.');
    assert(typeof account.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(account.id), 'Invalid account ID.');
    assert(typeof account.username === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(account.username), 'Invalid username.');
    assert(typeof account.passwordHash === 'string' && hashPattern.test(account.passwordHash), 'Invalid password hash.');
    assert(['owner', 'editor', 'player'].includes(account.role), 'Invalid role.');
    assert(typeof account.enabled === 'boolean' && Number.isSafeInteger(account.authVersion) && account.authVersion > 0, 'Invalid account state.');
    assert(!ids.has(account.id) && !usernames.has(account.username), 'Duplicate accounts.');
    ids.add(account.id);
    usernames.add(account.username);
  }
  assert(value.some(account => account.role === 'owner' && account.enabled), 'An enabled owner is required.');
  return value;
}

export function validateAccountUpdate(accounts, previous) {
  validateAccounts(accounts);
  for (const account of accounts) {
    const sameUsername = previous.find(old => old.username === account.username);
    assert(!sameUsername || sameUsername.id === account.id, 'Preserve existing account IDs.');
    const old = previous.find(entry => entry.id === account.id);
    if (!old) continue;
    const changed = ['username', 'passwordHash', 'role', 'enabled'].some(key => old[key] !== account[key]);
    assert(account.authVersion >= old.authVersion + (changed ? 1 : 0), 'Advance authVersion for account changes.');
  }
  return accounts;
}

export async function hashPassword(password) {
  assert(typeof password === 'string', 'Invalid password.');
  const bytes = Buffer.from(password, 'utf8');
  try {
    assert(bytes.length >= 1 && bytes.length <= 1024, 'Password must be 1-1024 UTF-8 bytes.');
    const salt = randomBytes(16);
    const key = await derive(bytes, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 50331648 });
    try {
      return `scrypt$32768$8$3$${salt.toString('hex')}$${key.toString('hex')}`;
    } finally {
      key.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

export function readPassword(label, input = process.stdin, output = process.stdout, signal) {
  assert(input.isTTY && output.isTTY && typeof input.setRawMode === 'function', 'Passwords require a private interactive terminal.');
  assert(!signal?.aborted, 'Input cancelled.');
  return new Promise((accept, reject) => {
    const wasRaw = input.isRaw;
    let password = '';
    const finish = (error) => {
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.off('error', onEnd);
      signal?.removeEventListener('abort', onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      const result = password;
      password = '';
      if (error) reject(new Error('Password entry cancelled.'));
      else accept(result);
    };
    const onEnd = () => finish(true);
    const onKey = (text, key = {}) => {
      if ((key.ctrl && ['c', 'd'].includes(key.name)) || key.name === 'escape') return finish(true);
      if (key.name === 'return' || key.name === 'enter') return finish(false);
      if (key.name === 'backspace') password = Array.from(password).slice(0, -1).join('');
      else if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(text)) password += text;
      if (Buffer.byteLength(password) > 1024) finish(true);
    };
    output.write(label);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('error', onEnd);
    signal?.addEventListener('abort', onEnd, { once: true });
    input.resume();
  });
}

async function question(label, signal) {
  assert(process.stdin.isTTY && process.stdout.isTTY, 'Use a private terminal.');
  assert(!signal?.aborted, 'Input cancelled.');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const abort = () => readline.close();
  try {
    return await new Promise((accept, reject) => {
      readline.once('close', () => reject(new Error('Input cancelled.')));
      signal?.addEventListener('abort', abort, { once: true });
      readline.question(label, accept);
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    readline.close();
  }
}

export async function promptAccounts(previous, io = { question, password: readPassword }) {
  const accounts = previous.map(account => ({ ...account }));
  while (true) {
    const username = (await io.question('Username to add/update (blank finishes): ')).trim().toLowerCase();
    if (!username) break;
    assert(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username), 'Invalid username.');
    const old = accounts.find(account => account.username === username);
    const role = (await io.question('Role (owner/editor/player): ')).trim();
    assert(['owner', 'editor', 'player'].includes(role), 'Invalid role.');
    const enabledAnswer = (await io.question('Enabled (yes/no): ')).trim();
    assert(['yes', 'no'].includes(enabledAnswer), 'Enter yes or no.');
    let password = await io.password('Password (hidden): ');
    let confirmation = await io.password('Confirm password (hidden): ');
    let passwordHash;
    try {
      assert(password === confirmation, 'Passwords do not match.');
      passwordHash = await hashPassword(password);
    } finally {
      password = '';
      confirmation = '';
    }
    const account = { id: old?.id ?? randomUUID(), username, passwordHash, role,
      enabled: enabledAnswer === 'yes', authVersion: (old?.authVersion ?? 0) + 1 };
    if (old) accounts[accounts.indexOf(old)] = account;
    else accounts.push(account);
    assert(accounts.length <= 32, 'Account limit exceeded.');
  }
  return validateAccountUpdate(accounts, previous);
}

function assertPrivatePath(filename, directory) {
  assert(process.platform === 'linux' && process.getuid, 'Use WSL Linux private storage.');
  assert(isAbsolute(filename) && realpathSync(filename) === resolve(filename), 'Use a nonsymlink absolute private path.');
  assert(!filename.startsWith('/mnt/') && filename !== root && !filename.startsWith(`${root}/`), 'Private files must be outside the workspace and Windows mounts.');
  const info = lstatSync(filename);
  assert(info.uid === process.getuid() && (info.mode & 0o777) === (directory ? 0o700 : 0o600), 'Private path permissions must be 700/600.');
  assert(directory ? info.isDirectory() : info.isFile(), 'Unexpected private path type.');
}

export function accountsFromSource(environment) {
  assert(Boolean(environment.FIM_ACCOUNTS_JSON) !== Boolean(environment.FIM_ACCOUNTS_FILE), 'Supply exactly one secure account source.');
  let json = environment.FIM_ACCOUNTS_JSON;
  if (environment.FIM_ACCOUNTS_FILE) {
    const filename = environment.FIM_ACCOUNTS_FILE;
    assertPrivatePath(filename, false);
    assert(lstatSync(filename).size <= 32768, 'Account source too large.');
    json = readFileSync(filename, 'utf8');
  }
  assert(Buffer.byteLength(json) <= 32768, 'Account source too large.');
  return validateAccounts(JSON.parse(json));
}

export async function withPrivateBody(properties, action, privateBase = resolve(homedir(), '.cache/fitness-instructor-music-private')) {
  mkdirSync(privateBase, { recursive: true, mode: 0o700 });
  assertPrivatePath(privateBase, true);
  const directory = mkdtempSync(resolve(privateBase, 'settings-'));
  try {
    assertPrivatePath(directory, true);
    const filename = resolve(directory, 'body.json');
    writeFileSync(filename, JSON.stringify({ properties }), { mode: 0o600, flag: 'wx' });
    assertPrivatePath(filename, false);
    return await action(filename);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function applySettings(settings, { run = promisify(execFile), accountsPrompt = promptAccounts, privateBase, signal } = {}) {
  try {
    assert(['storage', 'interactive', 'source'].includes(settings.mode), 'Choose an explicit settings operation.');
    const options = { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000, signal, env: childEnvironment(settings.environment) };
    const site = await verifyTarget(settings, (command, args, options) => run(command, args, { ...options, signal }));
    const rest = async (method, path, extra = []) => run('az', ['rest', '--method', method,
      '--url', `https://management.azure.com${path}`, '--subscription', settings.subscription,
      '--only-show-errors', ...extra], options);
    const appPath = `${site.id}/config/appsettings`;
    const readSettings = async () => JSON.parse((await run('az', ['staticwebapp', 'appsettings', 'list',
      '--subscription', settings.subscription, '--resource-group', settings.resourceGroup,
      '--name', settings.appName, '--only-show-errors', '-o', 'json'], options)).stdout).properties ?? {};
    const current = await readSettings();
    assert(Object.values(current).every(value => typeof value === 'string'), 'Invalid settings response.');
    const updates = {};
    if (settings.mode === 'storage') {
      const { storageAccount, container } = settings;
      assert(/^[a-z0-9]{3,24}$/.test(storageAccount), 'Invalid storage account.');
      assert(typeof container === 'string' && container.length >= 3 && container.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(container), 'Invalid container.');
      const storagePath = `/subscriptions/${settings.subscription}/resourceGroups/${settings.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccount}`;
      const storage = JSON.parse((await rest('get', `${storagePath}?api-version=2023-05-01`, ['-o', 'json'])).stdout);
      assert.equal(storage.id.toLowerCase(), storagePath.toLowerCase());
      assert.equal(storage.kind, 'StorageV2');
      assert.equal(storage.sku.name, 'Standard_LRS');
      assert.equal(storage.location, 'westus2');
      assert.equal(storage.properties.accessTier, 'Hot');
      assert.equal(storage.properties.allowBlobPublicAccess, false);
      assert.equal(storage.properties.supportsHttpsTrafficOnly, true);
      assert.equal(storage.properties.minimumTlsVersion, 'TLS1_2');
      const blobs = JSON.parse((await rest('get', `${storagePath}/blobServices/default?api-version=2023-05-01`, ['-o', 'json'])).stdout).properties;
      assert.equal(blobs.isVersioningEnabled, false);
      assert.equal(blobs.deleteRetentionPolicy.enabled, false);
      assert.equal(blobs.containerDeleteRetentionPolicy.enabled, false);
      const privateContainer = JSON.parse((await rest('get', `${storagePath}/blobServices/default/containers/${container}?api-version=2023-05-01`, ['-o', 'json'])).stdout);
      assert.equal(privateContainer.properties.publicAccess, 'None');
      const policy = JSON.parse((await rest('get', `${storagePath}/managementPolicies/default?api-version=2023-05-01`, ['-o', 'json'])).stdout).properties.policy;
      assert.equal(policy.rules.length, 2);
      for (const [prefix, days] of [['sessions', 2], ['uploads', 7]]) {
        const rule = policy.rules.find(entry => entry.definition.filters.prefixMatch?.[0] === `${container}/${prefix}/`);
        assert(rule?.enabled && rule.type === 'Lifecycle', 'Missing lifecycle rule.');
        assert.deepEqual(rule.definition.filters, { blobTypes: ['blockBlob'], prefixMatch: [`${container}/${prefix}/`] });
        assert.deepEqual(rule.definition.actions, { baseBlob: { delete: { daysAfterModificationGreaterThan: days } } });
      }
      const keys = JSON.parse((await rest('post', `${storagePath}/listKeys?api-version=2023-05-01`, ['-o', 'json'])).stdout).keys;
      const key = keys.find(entry => entry.keyName === 'key1' && entry.permissions === 'FULL')?.value;
      assert(typeof key === 'string' && Buffer.from(key, 'base64').length === 64 && Buffer.from(key, 'base64').toString('base64') === key, 'Invalid storage key.');
      updates.FIM_STORAGE_CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=${storageAccount};AccountKey=${key};EndpointSuffix=core.windows.net`;
      updates.FIM_STORAGE_CONTAINER = container;
      updates.FIM_ORIGIN = `https://${site.defaultHostname}`;
    } else {
      const previous = current.FIM_ACCOUNTS_JSON ? validateAccounts(JSON.parse(current.FIM_ACCOUNTS_JSON)) : [];
      const accounts = settings.mode === 'interactive'
        ? await accountsPrompt(previous, {
          question: label => question(label, signal),
          password: label => readPassword(label, process.stdin, process.stdout, signal)
        })
        : accountsFromSource(settings.environment);
      updates.FIM_ACCOUNTS_JSON = JSON.stringify(validateAccountUpdate(accounts, previous));
    }
    const latest = await readSettings();
    assert.deepEqual(latest, current, 'Concurrent settings edit; retry after coordinating writers.');
    await withPrivateBody({ ...current, ...updates }, filename => rest('put', `${appPath}?api-version=2023-12-01`,
      ['--body', `@${filename}`, '-o', 'none']), privateBase);
  } catch {
    throw new Error('Settings update stopped. Check private inputs, enabled owner, stable IDs/authVersion, exact Free target, storage policy and Azure access. Raw errors and child output withheld.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modes = { '--storage-approved': 'storage', '--accounts-approved': 'interactive', '--accounts-source-approved': 'source' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  Promise.resolve().then(() => {
    assert(process.argv.length === 3 && modes[process.argv[2]], 'Choose an explicitly approved settings mode.');
    return applySettings({ mode: modes[process.argv[2]], subscription: process.env.AZURE_SUBSCRIPTION_ID,
      resourceGroup: process.env.AZURE_RESOURCE_GROUP, appName: process.env.SWA_NAME,
      storageAccount: process.env.FIM_STORAGE_ACCOUNT_NAME, container: process.env.FIM_STORAGE_CONTAINER,
      environment: process.env }, { signal: controller.signal });
  }).then(() => console.log('Server settings updated. Verify worker rollout and live authorization; values withheld.')).catch(() => {
    console.error('Settings update stopped; no credential output is available. Check approved scope, private inputs and Azure access.');
    process.exitCode = 1;
  }).finally(() => {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  });
}