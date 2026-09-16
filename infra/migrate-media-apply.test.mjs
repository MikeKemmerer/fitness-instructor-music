import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { ConditionalWriter, DRAIN_MS, GLOBAL_KEYS, LeaseBarrier, reserveQuota, ROOT,
  PLAN_SHA256, assertPrivateJournalPath, candidateReadbackDirectory, migrationFailure, migrationJournalDirectory,
  openJournal, privateJournalReadiness, requestedApplyMode, runMigration, sdkAdapter,
  stageCandidates, validateBucket, validateReplacement, diagnosticFailure, prepareRetry,
  RETRY_PRIOR_HELPER_SHA256, RESTORE_SHA256 } from './migrate-media-apply.mjs';
import { buildReplacement } from './migrate-media.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const compiledModules = new Map();
const syntheticDirectories = new Set();
test.after(async () => { await Promise.all([...syntheticDirectories].map(path => rm(path, { recursive: true, force: true }))); });

test('private Linux journal persists capabilities at 600 and resumes read-only with exact identity', async () => {
  const privateBase = await mkdtemp(resolve(tmpdir(), 'migration-journal-test-'));
  try {
    const directory = migrationJournalDirectory(PLAN_SHA256, undefined, undefined, privateBase);
    const journal = await openJournal(directory, PLAN_SHA256, false, { privateBase });
    const capability = randomUUID();
    await journal.update(state => { state.leases['traffic/global-0'] = { id: capability, etag: '"synthetic"', state: 'attempting' }; });
    assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
    const filename = resolve(directory, 'journal.json');
    assert.equal((await lstat(filename)).mode & 0o7777, 0o600);
    const before = await readFile(filename);
    const reopened = await openJournal(directory, PLAN_SHA256, true, { privateBase, readOnly: true });
    assert.equal(reopened.state.leases['traffic/global-0'].id === capability, true);
    await assert.rejects(reopened.update(state => { state.phase = 'paused'; }), /journal_read_only/);
    assert.equal((await readFile(filename)).equals(before), true);
    await assert.rejects(openJournal(directory, '0'.repeat(64), true, { privateBase }), /reviewed_plan_hash_mismatch/);
    await writeFile(filename, JSON.stringify({ ...journal.state, planHash: '0'.repeat(64) }));
    await assert.rejects(openJournal(directory, PLAN_SHA256, true, { privateBase }), /journal_identity_changed/);
  } finally { await rm(privateBase, { recursive: true, force: true }); }
});

test('private Linux journal rejects traversal, mounts, symlinks and nonprivate modes', async () => {
  const privateBase = await mkdtemp(resolve(tmpdir(), 'migration-journal-test-'));
  try {
    const directory = migrationJournalDirectory(PLAN_SHA256, undefined, undefined, privateBase);
    for (const path of [directory + '/../escape', resolve(ROOT, 'local-media/migration-test'), '/mnt/c/migration-test']) {
      await assert.rejects(openJournal(path, PLAN_SHA256, false, { privateBase }), /private_path_escape|journal_identity_changed/);
    }
    for (const mode of [0o750, 0o755, 0o770]) {
      await chmod(privateBase, mode);
      await assert.rejects(openJournal(directory, PLAN_SHA256, false, { privateBase }), /journal_permissions_required/);
    }
    await chmod(privateBase, 0o700);
    await symlink(privateBase, directory);
    await assert.rejects(openJournal(directory, PLAN_SHA256, true, { privateBase }), /private_path_escape/);
  } finally { await rm(privateBase, { recursive: true, force: true }); }
});

test('private Linux journal readiness is capability-free and never creates or changes journal files', async () => {
  const privateBase = await mkdtemp(resolve(tmpdir(), 'migration-journal-test-'));
  try {
    const runId = `migration-${randomUUID()}`;
    const environment = { MIGRATION_RUN_ID: runId, MIGRATION_PRIVATE_BASE: '/not-trusted' };
    const directory = migrationJournalDirectory(PLAN_SHA256, runId, undefined, privateBase);
    assert.deepEqual(await privateJournalReadiness(environment, privateBase), {
      privateJournalAvailable: true, journalExists: false, migrationRunId: runId,
    });
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    const journal = await openJournal(directory, PLAN_SHA256, false, { privateBase });
    const capability = randomUUID();
    await journal.update(state => { state.leases.bucket = { id: capability, etag: 'private-etag', state: 'attempting' }; });
    const filename = resolve(directory, 'journal.json');
    const before = await readFile(filename);
    const readiness = await privateJournalReadiness(environment, privateBase);
    assert.deepEqual(readiness, { privateJournalAvailable: true, journalExists: true, migrationRunId: runId });
    assert.equal(JSON.stringify(readiness).includes(capability), false);
    assert.equal(JSON.stringify(readiness).includes(privateBase), false);
    assert.equal((await readFile(filename)).equals(before), true);
    assert.equal(migrationJournalDirectory(PLAN_SHA256), resolve(homedir(), '.cache/fitness-instructor-music-private',
      `migration-${PLAN_SHA256.slice(0, 24)}`));
    assert.equal((await privateJournalReadiness({ ...environment, MIGRATION_JOURNAL_DIRECTORY: `${directory}/../other` }, privateBase))
      .privateJournalAvailable, false);
  } finally { await rm(privateBase, { recursive: true, force: true }); }
});

test('private Linux journal rejects unsafe child and file modes, file links, invalid data and changed run IDs', async () => {
  const privateBase = await mkdtemp(resolve(tmpdir(), 'migration-journal-test-'));
  try {
    const directory = migrationJournalDirectory(PLAN_SHA256, undefined, undefined, privateBase);
    const journal = await openJournal(directory, PLAN_SHA256, false, { privateBase });
    const filename = resolve(directory, 'journal.json');
    for (const path of [directory, filename]) {
      for (const mode of path === directory ? [0o750, 0o777] : [0o640, 0o644, 0o660, 0o700]) {
        await chmod(path, mode);
        await assert.rejects(openJournal(directory, PLAN_SHA256, true, { privateBase }), /journal_permissions_required/);
      }
      await chmod(path, path === directory ? 0o700 : 0o600);
    }
    const before = await readFile(filename);
    await assert.rejects(journal.update(state => { state.runId = `migration-${randomUUID()}`; }), /journal_identity_changed/);
    assert.equal((await readFile(filename)).equals(before), true);
    await writeFile(filename, JSON.stringify({ ...journal.state, runId: `migration-${randomUUID()}` }));
    await assert.rejects(openJournal(directory, PLAN_SHA256, true, { privateBase }), /journal_identity_changed/);
    await writeFile(filename, '{"private-capability-in-invalid-json":');
    await assert.rejects(openJournal(directory, PLAN_SHA256, true, { privateBase }), { message: 'journal_io_failed' });
    await rm(filename);
    await symlink(resolve(privateBase, 'elsewhere'), filename);
    await assert.rejects(openJournal(directory, PLAN_SHA256, true, { privateBase }), /private_path_escape/);
  } finally { await rm(privateBase, { recursive: true, force: true }); }
});

test('private Linux journal refuses wrong uid, Windows runtime and symlinked trusted root', async context => {
  const privateBase = await mkdtemp(resolve(tmpdir(), 'migration-journal-test-'));
  const link = `${privateBase}-link`;
  try {
    const actualUid = process.getuid();
    context.mock.method(process, 'getuid', () => actualUid + 1);
    await assert.rejects(assertPrivateJournalPath(privateBase, true), /journal_permissions_required/);
    context.mock.restoreAll();
    context.mock.property(process, 'platform', 'win32');
    await assert.rejects(assertPrivateJournalPath(privateBase, true), /journal_permissions_required/);
    context.mock.restoreAll();
    await symlink(privateBase, link);
    const directory = migrationJournalDirectory(PLAN_SHA256, undefined, undefined, link);
    await assert.rejects(openJournal(directory, PLAN_SHA256, false, { privateBase: link }), /private_path_escape/);
  } finally {
    context.mock.restoreAll();
    await rm(link, { force: true });
    await rm(privateBase, { recursive: true, force: true });
  }
});

test('private Linux journal SDK errors and public failure output never contain capabilities or raw paths', async () => {
  const capability = randomUUID();
  const rawPath = `/home/synthetic/private/${capability}/journal.json`;
  const adapter = sdkAdapter({ getBlobClient: () => ({ getProperties: async () => { throw new Error(rawPath); } }) });
  await assert.rejects(adapter.properties('traffic/global-0'), { message: 'storage_operation_failed' });
  for (const message of [rawPath, capability, 'secret_capability_valid_identifier']) {
    const result = migrationFailure(new Error(message), { state: { phase: message, leases: { id: capability } } });
    assert.deepEqual(result, { complete: false, code: 'migration_guard_stopped', cloudState: 'unknown' });
    assert.equal(JSON.stringify(result).includes(capability), false);
  }
});

test('candidate readback is confined to ignored bundle work storage, never a private journal', async () => {
  const directory = resolve(ROOT, 'local-media', `migration-readback-synthetic-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    const work = await candidateReadbackDirectory(directory);
    assert.equal(work, resolve(directory, 'apply-verification'));
    assert.equal(await candidateReadbackDirectory(directory), work);
    await assert.rejects(candidateReadbackDirectory(tmpdir()), /private_path_escape/);
    await rm(work, { recursive: true });
    await symlink(directory, work);
    await assert.rejects(candidateReadbackDirectory(directory), /private_path_escape/);
    await assert.rejects(stageCandidates({}, { directory }, {}), /private_path_escape/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('journal-check CLI rejects an unreviewed synthetic plan locally with no Azure execution', async () => {
  const directory = resolve(ROOT, 'local-media', `migration-cli-synthetic-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    const path = resolve(directory, 'plan.json');
    await writeFile(path, '{}', { mode: 0o600, flag: 'wx' });
    assert.equal(requestedApplyMode(['--journal-check'], {}, 'hash'), 'journal-check');
    assert.throws(() => execFileSync(process.execPath, [resolve(ROOT, 'infra/migrate-media-apply.mjs'), '--journal-check'], {
      env: { PATH: '', HOME: homedir(), MIGRATION_PLAN_PATH: path }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }), error => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      assert.deepEqual(JSON.parse(error.stderr), { complete: false, code: 'reviewed_plan_hash_mismatch', cloudState: 'not_mutated' });
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

export function sourceModules(bucket = 0) {
  const compiler = require('typescript');
  const loaded = new Map();
  function load(path) {
    assert.ok(path.startsWith(`${ROOT}/api/src/`) || path.startsWith(`${ROOT}/shared/`));
    if (loaded.has(path)) return loaded.get(path).exports;
    const module = { exports: {} };
    loaded.set(path, module);
    const output = compiledModules.get(path) ?? compiler.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
      module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022,
    } }).outputText;
    compiledModules.set(path, output);
    const scopedRequire = name => {
      if (name === 'node:crypto') return { ...require(name), randomInt: () => bucket };
      return name.startsWith('.') ? load(resolve(dirname(path), `${name}.ts`)) : createRequire(path)(name);
    };
    new Function('require', 'module', 'exports', output)(scopedRequire, module, module.exports);
    return module.exports;
  }
  return load;
}

function fixture() {
  const calls = [];
  const owners = new Map();
  const journal = { state: { leases: {} }, async update(change) { change(this.state); calls.push('journal'); } };
  const store = {
    async properties(key) { return { etag: '"etag"', bytes: 0, leaseState: owners.has(key) ? 'leased' : 'available' }; },
    async acquire(key, id) {
      assert.equal(journal.state.leases[key].id, id);
      if (owners.has(key)) throw new Error('foreign');
      owners.set(key, id); calls.push(`acquire:${key}`);
    },
    async renew(key, id) { if (owners.get(key) !== id) throw new Error('not_owner'); calls.push(`renew:${key}`); },
    async release(key, id) {
      assert.equal(journal.state.leases[key].state, 'releasing');
      assert.equal(owners.get(key), id); owners.delete(key); calls.push(`release:${key}`);
    },
  };
  let now = 0;
  return { calls, owners, journal, store, barrier: new LeaseBarrier(store, journal, () => now), setTime(value) { now = value; } };
}

test('proposed capability is journaled before any acquire and lost ACK is reconciled', async () => {
  const context = fixture();
  const acquire = context.store.acquire;
  context.store.acquire = async (...args) => { await acquire(...args); throw new Error('lost_ack'); };
  await context.barrier.acquire(GLOBAL_KEYS[0], '"etag"');
  assert.equal(context.calls[0], 'journal');
  assert.equal(context.journal.state.leases[GLOBAL_KEYS[0]].state, 'held');
});

test('foreign lease is never broken or released on partial acquisition', async () => {
  const context = fixture();
  await context.barrier.acquire(GLOBAL_KEYS[0], '"etag"');
  context.owners.set(GLOBAL_KEYS[1], 'foreign');
  await assert.rejects(context.barrier.acquire(GLOBAL_KEYS[1], '"etag"'), /ownership_unresolved/);
  await context.barrier.release([GLOBAL_KEYS[0]]);
  assert.equal(context.owners.get(GLOBAL_KEYS[1]), 'foreign');
});

test('all eight acknowledgements and 60 monotonic seconds are mandatory', async () => {
  const context = fixture();
  for (const key of GLOBAL_KEYS.slice(0, 7)) await context.barrier.acquire(key, '"etag"');
  context.setTime(DRAIN_MS * 2);
  assert.throws(() => context.barrier.requireDrained(), /drain_incomplete/);
  await context.barrier.acquire(GLOBAL_KEYS[7], '"etag"');
  context.setTime(DRAIN_MS * 3 - 1);
  assert.throws(() => context.barrier.requireDrained(), /drain_incomplete/);
  context.setTime(DRAIN_MS * 3);
  context.barrier.requireDrained();
});

test('recovery starts a new monotonic drain, never trusts a persisted wall clock', async () => {
  const context = fixture();
  for (const key of GLOBAL_KEYS) await context.barrier.acquire(key, '"etag"');
  context.setTime(DRAIN_MS);
  const resumed = new LeaseBarrier(context.store, context.journal, () => DRAIN_MS);
  assert.throws(() => resumed.requireDrained(), /drain_incomplete/);
  for (const key of GLOBAL_KEYS) await resumed.acquire(key, '"etag"');
  assert.throws(() => resumed.requireDrained(), /drain_incomplete/);
});

test('release order retains all global admission leases until other leases are released', async () => {
  const context = fixture();
  for (const key of [...GLOBAL_KEYS, 'control/quota', 'routines/synthetic/head']) await context.barrier.acquire(key, '"etag"');
  await context.barrier.releaseAll();
  const keys = context.calls.filter(value => value.startsWith('release:')).map(value => value.slice(8));
  assert.deepEqual(keys.slice(-8), GLOBAL_KEYS);
  assert.equal(context.owners.size, 0);
});

test('traffic schema rejects missing buckets, bad numbers and future windows', () => {
  validateBucket({ window: 1, count: 64 }, 60000);
  for (const value of [null, {}, { window: 2, count: 0 }, { window: 1, count: -1 },
    { window: 1, count: 0.5 }, { window: 1, count: 0, extra: true }]) {
    assert.throws(() => validateBucket(value, 60000), /bucket_invalid/);
  }
});

function writerFixture() {
  const context = fixture();
  const blobs = new Map(GLOBAL_KEYS.map(key => [key, { etag: '"0x1"', data: Buffer.from('{"window":0,"count":0}') }]));
  const writes = [];
  let version = 10;
  context.journal.state.operations = {};
  const acquire = context.store.acquire;
  Object.assign(context.store, {
    async acquire(key, id, etag) {
      if (!blobs.has(key)) throw Object.assign(new Error('missing_blob'), { statusCode: 404 });
      if (blobs.get(key).etag !== etag) throw Object.assign(new Error('etag_mismatch'), { statusCode: 412 });
      return acquire(key, id, etag);
    },
    async properties(key) { const item = blobs.get(key); return item ? { etag: item.etag, bytes: item.data.length,
      leaseState: context.owners.has(key) ? 'leased' : item.leaseState ?? 'available' } : null; },
    async read(key, row) { assert.equal(blobs.get(key)?.etag, row.etag); return blobs.get(key).data; },
    async put(key, data, etag, id) {
      if ((blobs.get(key)?.etag ?? null) !== etag) throw Object.assign(new Error('etag_mismatch'), { statusCode: 412 });
      if ((id || context.owners.has(key)) && (!blobs.has(key) || context.owners.get(key) !== id)) {
        throw Object.assign(new Error('lease_mismatch'), { statusCode: 412 });
      }
      const next = `"0x${(++version).toString(16)}"`;
      blobs.set(key, { etag: next, data: Buffer.from(data) }); writes.push(key); return next;
    },
    async delete(key, etag, id) {
      if (blobs.get(key)?.etag !== etag) throw Object.assign(new Error('etag_mismatch'), { statusCode: 412 });
      if ((id || context.owners.has(key)) && context.owners.get(key) !== id) {
        throw Object.assign(new Error('lease_mismatch'), { statusCode: 412 });
      }
      blobs.delete(key); context.owners.delete(key); writes.push(`delete:${key}`);
    },
  });
  return { ...context, blobs, writes, writer: new ConditionalWriter(context.store, context.journal, context.barrier,
    new Set(['new', 'head', 'control/quota', 'old'])) };
}

test('restore creates an absent blob without its deleted lease capability', async () => {
  const context = writerFixture();
  context.journal.state.leases.old = { id: randomUUID(), etag: '"0x1"', state: 'deleted' };
  await assert.rejects(context.store.put('old', Buffer.from('backup'), null, randomUUID()), { statusCode: 412 });
  const etag = await context.writer.put('old', Buffer.from('backup'), null, 'restore:old');
  assert.equal(context.blobs.get('old').data.equals(Buffer.from('backup')), true);
  assert.equal(context.journal.state.operations['restore:old'].etag, etag);
});

test('strict fake refuses missing, broken and foreign leases on existing writes and deletes', async () => {
  const context = writerFixture();
  context.blobs.set('old', { etag: '"0x1"', data: Buffer.from('backup') });
  const id = randomUUID();
  context.owners.set('old', id);
  for (const capability of [undefined, randomUUID()]) {
    await assert.rejects(context.store.put('old', Buffer.from('changed'), '"0x1"', capability), { statusCode: 412 });
    await assert.rejects(context.store.delete('old', '"0x1"', capability), { statusCode: 412 });
  }
  context.owners.delete('old');
  context.blobs.get('old').leaseState = 'broken';
  await assert.rejects(context.store.put('old', Buffer.from('changed'), '"0x1"', id), { statusCode: 412 });
  await assert.rejects(context.store.delete('old', '"0x1"', id), { statusCode: 412 });
  assert.equal(context.writes.length, 0);
});

test('immutable collision is refused even when unrelated existing bytes are identical', async () => {
  const context = writerFixture();
  context.blobs.set('new', { etag: '"0x1"', data: Buffer.from('same') });
  await assert.rejects(context.writer.put('new', Buffer.from('same')), /preexisting_object/);
  assert.equal(context.writes.length, 0);
});

test('lost write ACK resumes by exact byte readback without another write', async () => {
  const context = writerFixture();
  const put = context.store.put;
  context.store.put = async (...args) => { await put(...args); throw new Error('secret-capability-DO-NOT-LOG'); };
  await assert.rejects(context.writer.put('new', Buffer.from('candidate')), /write_ack_unresolved_resume_required/);
  await context.writer.put('new', Buffer.from('candidate'));
  assert.equal(context.writes.length, 1);
});

test('acknowledged immutable object replaced with equal bytes still fails its ETag guard', async () => {
  const context = writerFixture();
  await context.writer.put('new', Buffer.from('candidate'));
  context.blobs.get('new').etag = '"0xff"';
  await assert.rejects(context.writer.put('new', Buffer.from('candidate')), /acknowledged_object_changed/);
});

test('quota reservation is positive, preserves active and optional counters, and uses actual API limits', () => {
  const previous = { bytes: 800000000, operations: 12, routines: 400, assets: 4000, fillers: 7,
    active: { unrelated: 1999999999999 } };
  const next = reserveQuota(previous, 125017896, 10);
  assert.equal(next.bytes, 925017896);
  assert.equal(next.operations, 23);
  assert.equal(next.assets, 4010);
  assert.equal(next.routines, previous.routines);
  assert.deepEqual(next.active, previous.active);
  assert.equal(next.fillers, previous.fillers);
  assert.equal(previous.bytes, 800000000);
  for (const changes of [{ bytes: -1 }, { operations: 19990 }, { assets: 4090 }, { bytes: 5 * 1024 ** 3 },
    { active: [] }, { arbitrary: 1 }, { active: { upload: NaN } }]) {
    assert.throws(() => reserveQuota({ ...previous, ...changes }, 125017896, 10), /quota_/);
  }
});

test('quota lost ACK cannot double-charge during resume', async () => {
  const context = writerFixture();
  const old = { bytes: 70000000, operations: 1, routines: 1, assets: 0, active: {} };
  context.blobs.set('control/quota', { etag: '"0x1"', data: Buffer.from(JSON.stringify(old)) });
  await context.barrier.acquire('control/quota', '"0x1"');
  const bytes = Buffer.from(JSON.stringify(reserveQuota(old, 125017896, 10)));
  const put = context.store.put;
  context.store.put = async (...args) => { await put(...args); throw new Error('lost'); };
  await assert.rejects(context.writer.put('control/quota', bytes, '"0x1"'), /unresolved/);
  await context.writer.put('control/quota', bytes, '"0x1"');
  assert.equal(context.writes.length, 1);
  assert.equal(JSON.parse(context.blobs.get('control/quota').data).bytes, old.bytes + 125017896);
});

test('head CAS stops on user edit and never releases barrier on its own', async () => {
  const context = writerFixture();
  context.blobs.set('head', { etag: '"0x2"', data: Buffer.from('user edit') });
  await context.barrier.acquire('head', '"0x2"');
  await assert.rejects(context.writer.put('head', Buffer.from('new head'), '"0x1"'), /conflict/);
  assert.equal(context.blobs.get('head').data.toString(), 'user edit');
  assert.equal(context.owners.size, 1);
});

test('lost delete ACK reconciles disappearance and the vanished lease during recovery', async () => {
  const context = writerFixture();
  for (const key of GLOBAL_KEYS) await context.barrier.acquire(key, '"0x1"');
  context.setTime(DRAIN_MS);
  const data = Buffer.from('old');
  context.blobs.set('old', { etag: '"0x1"', data });
  await context.barrier.acquire('old', '"0x1"');
  const record = { key: 'old', etag: '"0x1"', bytes: data.length, sha256: sha256(data) };
  const remove = context.store.delete;
  context.store.delete = async (...args) => { await remove(...args); throw new Error('lost'); };
  await assert.rejects(context.writer.remove(record), /delete_ack_unresolved/);
  await context.writer.remove(record);
  assert.equal(context.journal.state.leases.old.state, 'deleted');
  assert.equal(context.writes.length, 1);
});

test('no destruction before drain and no unrecorded missing object accepted', async () => {
  const context = writerFixture();
  const record = { key: 'old', etag: '"0x1"', bytes: 3, sha256: sha256(Buffer.from('old')) };
  await assert.rejects(context.writer.remove(record), /drain_incomplete/);
  for (const key of GLOBAL_KEYS) await context.barrier.acquire(key, '"0x1"');
  context.setTime(DRAIN_MS);
  await assert.rejects(context.writer.remove(record), /unrecorded_missing/);
});

test('put and delete reject every key outside the exact allowlist', async () => {
  const context = writerFixture();
  await assert.rejects(context.writer.put('arbitrary', Buffer.from('bytes')), /scope_rejected/);
  await assert.rejects(context.writer.remove({ key: 'arbitrary' }), /scope_rejected/);
  assert.equal(context.writes.length, 0);
});

test('every route on three workers and all eight buckets is denied before auth, body or handler', async () => {
  const routes = ['GET auth/session', 'POST auth/login', 'POST auth/logout', 'GET routines', 'POST routines',
    'GET routines/id', 'PUT routines/id', 'DELETE routines/id', 'POST routines/id/lock', 'POST routines/id/unlock',
    'POST routines/id/publish', 'POST routines/id/duplicate', 'GET media/id', 'GET media/id/chunks/0',
    'POST media/uploads', 'PUT media/uploads/id/chunks/0', 'POST media/uploads/id/complete',
    'POST media/uploads/id/abort', 'POST media/uploads/cleanup', 'GET fillers', 'POST fillers', 'DELETE fillers/id',
    'GET playlists', 'POST playlists', 'PUT playlists/id', 'GET classes', 'POST classes', 'GET classes/id/prepare',
    'HEAD anything', 'OPTIONS anything', 'PATCH anything'];
  for (let bucket = 0; bucket < 8; bucket++) {
    const load = sourceModules(bucket);
    const { CloudApi } = load(resolve(ROOT, 'api/src/cloud/http.ts'));
    const { BlobConflict } = load(resolve(ROOT, 'api/src/cloud/store.ts'));
    for (let worker = 0; worker < 3; worker++) {
      let puts = 0;
      const api = new CloudApi({
        async get(key) { assert.equal(key, GLOBAL_KEYS[bucket]); return { bytes: Buffer.from('{"window":0,"count":0}'), etag: '"0x1"' }; },
        async put(key) { assert.equal(key, GLOBAL_KEYS[bucket]); puts++; throw new BlobConflict(); },
      }, () => ({}));
      api.auth.config = () => ({});
      api.auth.authenticate = api.auth.login = api.auth.origin = () => assert.fail('handler reached');
      for (const route of routes) {
        const [method, path] = route.split(' ');
        const response = await api.handle({ method, url: `https://synthetic.invalid/api/${path}`, headers: new Headers(),
          get body() { assert.fail('body consumed'); } });
        assert.equal(response.status, 503);
        assert.equal(JSON.parse(response.body).error, 'storage_busy');
      }
      assert.equal(puts, routes.length * 4);
    }
  }
});

test('actual installed Azure SDK emits server timeout and lease/ETag conditions without a network request', async () => {
  const apiRequire = createRequire(resolve(ROOT, 'api/package.json'));
  const { BlobServiceClient } = apiRequire('@azure/storage-blob');
  const requests = [];
  const id = randomUUID();
  const client = new BlobServiceClient('https://synthetic.blob.core.windows.net', undefined, {
    retryOptions: { maxTries: 2, tryTimeoutInMs: 10000 },
    httpClient: { async sendRequest(request) {
      requests.push({ url: request.url, headers: Object.fromEntries(Object.entries(request.headers.rawHeaders())
        .map(([key, value]) => [key.toLowerCase(), value])), method: request.method });
      const headers = { toJson: () => ({ etag: '"0x1"', 'x-ms-lease-id': id }) };
      return { request, status: 201, headers, bodyAsText: '' };
    } },
  });
  const adapter = sdkAdapter(client.getContainerClient('private-library'), true);
  await adapter.acquire('traffic/global-0', id, '"0x1"');
  await adapter.put('control/quota', Buffer.from('{}'), '"0x1"', id);
  await adapter.put('restored', Buffer.from('{}'), null);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => new URL(request.url).searchParams.get('timeout') === '10'));
  assert.equal(requests[0].headers['x-ms-lease-duration'], '-1');
  assert.equal(requests[0].headers['x-ms-proposed-lease-id'], id);
  assert.equal(requests[0].headers['if-match'], '"0x1"');
  assert.equal(requests[1].headers['if-match'], '"0x1"');
  assert.equal(requests[1].headers['x-ms-lease-id'], id);
  assert.equal(requests[2].headers['if-none-match'], '*');
  assert.equal(requests[2].headers['if-match'], undefined);
  assert.equal(requests[2].headers['x-ms-lease-id'], undefined);
});

test('actual SDK empty-body HEAD BlobNotFound is absent, not an ambiguous or container 404', async () => {
  const { BlobServiceClient } = createRequire(resolve(ROOT, 'api/package.json'))('@azure/storage-blob');
  for (const code of ['BlobNotFound', 'ContainerNotFound', 'ResourceNotFound', undefined]) {
    const client = new BlobServiceClient('https://synthetic.blob.core.windows.net', undefined, {
      retryOptions: { maxTries: 1 },
      httpClient: { async sendRequest(request) {
        assert.equal(request.method, 'HEAD');
        return { request, status: 404, headers: { toJson: () => code ? { 'x-ms-error-code': code } : {} }, bodyAsText: '' };
      } },
    });
    const adapter = sdkAdapter(client.getContainerClient('private-library'), false);
    if (code === 'BlobNotFound') assert.equal(await adapter.properties('absent-candidate'), null);
    else await assert.rejects(adapter.properties('absent-candidate'), { message: 'storage_operation_failed', statusCode: 404 });
  }
});

test('read-only adapter refuses lease, write and delete before touching SDK', async () => {
  const adapter = sdkAdapter({});
  for (const invoke of [() => adapter.acquire('key', 'id', '"0x1"'), () => adapter.renew('key', 'id'),
    () => adapter.release('key', 'id'), () => adapter.put('key', Buffer.from('{}'), null), () => adapter.delete('key', '"0x1"')]) {
    assert.throws(invoke, /not_authorized/);
  }
});

test('CLI needs next-invocation parent review, exact helper and plan hashes, and external-writer pause', () => {
  assert.equal(requestedApplyMode(['--dry-run'], {}, 'hash'), 'dry-run');
  const environment = { REVIEWED_MIGRATION_APPLY_SHA256: 'hash', REVIEWED_MIGRATION_PLAN_SHA256: PLAN_SHA256,
    MIGRATION_PARENT_REVIEW_APPROVED: 'true', MIGRATION_EXTERNAL_WRITERS_PAUSED: 'true' };
  for (const key of Object.keys(environment)) {
    assert.throws(() => requestedApplyMode(['--apply-approved'], { ...environment, [key]: '' }, 'hash'), /parent_approval/);
  }
  assert.equal(requestedApplyMode(['--resume'], environment, 'hash'), 'resume');
  assert.equal(requestedApplyMode(['--rollback'], environment, 'hash'), 'rollback');
  assert.equal(requestedApplyMode(['--finish-release'], environment, 'hash'), 'finish-release');
  for (const key of Object.keys(environment)) {
    assert.throws(() => requestedApplyMode(['--finish-release'], { ...environment, [key]: '' }, 'hash'), /parent_approval/);
  }
  assert.throws(() => requestedApplyMode(['--apply-approved'], environment, 'changed'), /parent_approval/);
});

async function migrationFixture({ candidateBytes = 44 } = {}) {
  const context = writerFixture();
  const directory = await mkdtemp(resolve(tmpdir(), 'migration-apply-synthetic-'));
  syntheticDirectories.add(directory);
  const pendingFiles = [];
  const routineId = randomUUID();
  const assets = [];
  const oldBody = { routine: { schemaVersion: 1, id: routineId, name: 'Synthetic class', revision: 5,
    locked: false, published: false, filler: { mode: 'none', sound: 'lofi' }, tracks: [] }, media: {} };
  const metadata = [];
  const staging = [];
  const sourceRecords = [];
  const putInitial = async (key, value, path = `${randomUUID()}.json`) => {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const etag = '"0x1"';
    context.blobs.set(key, { data: raw, etag });
    if (/^(assets|snapshots|routines)\//.test(key)) {
      pendingFiles.push(writeFile(resolve(directory, path), raw, { mode: 0o600, flag: 'wx' }));
    }
    return { key, etag, path, bytes: raw.length, sha256: sha256(raw) };
  };
  for (let index = 0; index < 10; index++) {
    const entryId = randomUUID();
    const data = Buffer.alloc(44, index);
    const source = { id: randomUUID(), bytes: 44, sha256: sha256(data), contentType: 'audio/wav' };
    const candidate = Buffer.alloc(index === 0 ? candidateBytes : 44, index + 11);
    const asset = { id: randomUUID(), bytes: candidate.length, sha256: sha256(candidate), contentType: 'audio/mp4' };
    const sourceCatalog = { asset: source, chunks: [source.sha256] };
    const catalogValue = { asset, chunks: [asset.sha256] };
    const chunk = await putInitial(`assets/${source.id}/chunks/0`, data, `${source.id}.wav`);
    chunk.offset = 0;
    const stagedChunk = await putInitial(`uploads/${source.id}/chunks/0`, data);
    stagedChunk.offset = 0;
    const catalog = await putInitial(`assets/${source.id}/catalog`, sourceCatalog);
    metadata.push(catalog);
    const head = { asset: source, ownerId: 'synthetic-owner', expiresAt: Date.now() + 86400000,
      state: 'complete', chunks: { 0: source.sha256 } };
    const upload = await putInitial(`uploads/${source.id}/head`, head);
    staging.push({ id: source.id, key: upload.key, etag: upload.etag, originalHeadBytes: upload.bytes,
      originalHeadSha256: upload.sha256, chunks: [stagedChunk], bytes: 44 });
    const sourceRecord = { id: source.id, ...chunk, chunks: [chunk] };
    sourceRecords.push(sourceRecord);
    const catalogRaw = Buffer.from(JSON.stringify(catalogValue));
    assets.push({ source, asset, candidate, catalogValue, sourceCatalog, sourceRecord,
      catalog: { bytes: catalogRaw.length, sha256: sha256(catalogRaw) } });
    oldBody.routine.tracks.push({ id: entryId, title: 'Synthetic', duration: 1, cues: [], gain: 0.4, bpm: 120 });
    oldBody.media[entryId] = source;
  }
  const retireSnapshots = [];
  for (let revision = 1; revision <= 5; revision++) {
    const body = structuredClone(oldBody); body.routine.revision = revision;
    retireSnapshots.push(await putInitial(`snapshots/${routineId}/${randomUUID()}`, body));
  }
  metadata.push(...retireSnapshots);
  const headKey = `routines/${routineId}/head`;
  const oldHead = { draft: { key: retireSnapshots[4].key, revision: 5, name: oldBody.routine.name, locked: false }, deleted: false };
  const oldHeadRecord = await putInitial(headKey, oldHead);
  metadata.push(oldHeadRecord);
  await putInitial(`heads/${routineId}`, { id: routineId });
  for (const key of GLOBAL_KEYS) await putInitial(key, { window: 0, count: 0 });
  await putInitial('control/quota', { bytes: 67108864, operations: 0, routines: 1, assets: 10, active: {} });
  const replacement = buildReplacement(oldBody, assets);
  const snapshotKey = `snapshots/${routineId}/${randomUUID()}`;
  const head = { draft: { ...oldHead.draft, key: snapshotKey, revision: 6 }, deleted: false,
    history: [{ revision: 6, draft: snapshotKey }] };
  const local = async (path, value) => {
    const raw = Buffer.from(JSON.stringify(value));
    await writeFile(resolve(directory, path), raw, { mode: 0o600 });
    return { path, bytes: raw.length, sha256: sha256(raw) };
  };
  const plan = { routineId, headKey, snapshotKey, expectedHeadEtag: '"0x1"', expectedRevision: 5, nextRevision: 6,
    locked: false, published: false, entryMapping: replacement.mapping, retireAssetIds: assets.map(item => item.source.id),
    retireSnapshots, head: await local('head.json', head), snapshot: await local('snapshot.json', replacement.body),
    quota: { conservativeAdditionalBytes: 125017896, actualCandidatePermanentBytes: assets.reduce((sum, item) => sum + item.asset.bytes, 0) } };
  const deletions = [...metadata.filter(item => item.key !== headKey), ...sourceRecords.flatMap(item => item.chunks),
    ...staging.flatMap(item => [{ key: item.key, etag: item.etag, bytes: item.originalHeadBytes,
      sha256: item.originalHeadSha256 }, ...item.chunks])];
  const allowed = new Set([headKey, snapshotKey, 'control/quota', ...deletions.map(item => item.key),
    ...assets.flatMap(item => [`assets/${item.asset.id}/chunks/0`, `assets/${item.asset.id}/catalog`])]);
  const properties = context.store.properties;
  context.store.properties = async key => { const row = await properties(key); return row && { ...row, modified: Date.now() }; };
  context.store.list = () => ({ next: async () => ({ done: false, value: { segment: { blobItems: [...context.blobs].map(([name, item]) =>
    ({ name, properties: { etag: item.etag, contentLength: item.data.length } })) } } }) });
  context.journal.state.originals = {};
  const bundle = { directory, plan, backup: { metadata, staging, assets: sourceRecords }, assets,
    oldHead, oldHeadRecord, oldBody, head, body: replacement.body, allowed, deletions, files: [], checks: { parseRoutineContent() {} } };
  let time = 0;
  const options = { store: context.store, bundle, journal: context.journal, clock: () => time,
    verifyOriginals: async () => {}, verifyCandidates: async (store, input, writer) => {
      for (const item of input.assets) {
        await writer.put(`assets/${item.asset.id}/chunks/0`, item.candidate);
        await writer.put(`assets/${item.asset.id}/catalog`, Buffer.from(JSON.stringify(item.catalogValue)));
      }
      time += DRAIN_MS;
    } };
  await Promise.all(pendingFiles);
  return { ...context, bundle, options, setTime(value) { time = value; } };
}

test('failure diagnostic retains first candidate properties failure without private messages or capabilities', async () => {
  const context = await migrationFixture();
  const key = `assets/${context.bundle.assets[0].asset.id}/chunks/0`;
  const properties = context.store.properties;
  context.store.properties = async name => {
    if (name === key) throw Object.assign(new Error('storage_operation_failed'), { statusCode: 404 });
    return properties(name);
  };
  await assert.rejects(runMigration(context.options), /not_applied/);
  assert.equal(context.journal.state.failure.step, 'writer-properties');
  assert.equal(context.journal.state.failure.code, 'storage_operation_failed');
  assert.equal(context.journal.state.failure.status, 404);
  assert.equal(context.journal.state.failure.beforeFirstCandidate, true);
  assert.deepEqual(Object.keys(context.journal.state.operations), ['control/quota']);
  const privateValue = 'private-capability-secret';
  const error = Object.assign(new Error(privateValue), { name: privateValue, statusCode: privateValue });
  error.stack = `${privateValue}\n at /private/${privateValue}/other.mjs:12:34`;
  assert.deepEqual(diagnosticFailure(error, privateValue), {
    step: 'unknown', code: 'unrecognized_error', name: 'unknown', status: null,
  });
  assert.equal(JSON.stringify(context.journal.state.failure).includes(context.journal.state.leases['control/quota'].id), false);
});

async function retryFixture() {
  const context = await migrationFixture();
  Object.assign(context.journal.state, { planHash: PLAN_SHA256, runId: `migration-${PLAN_SHA256.slice(0, 24)}`,
    review: { helperHash: RETRY_PRIOR_HELPER_SHA256 } });
  await assert.rejects(runMigration({ ...context.options,
    fault: async step => { if (step === 'after-reservation') throw new Error('synthetic_failure'); } }), /not_applied/);
  const prior = { state: structuredClone(context.journal.state), snapshotSha256: sha256(Buffer.from(JSON.stringify(context.journal.state))) };
  const count = Object.keys(prior.state.leases).length;
  const receipt = { complete: true, applied: false, consistentOutcome: 'not-applied',
    helperSha256: RETRY_PRIOR_HELPER_SHA256, planSha256: PLAN_SHA256, restoreManifestSha256: RESTORE_SHA256,
    revision: 5, allLeasesResolved: true, leases: { total: count, released: count, deleted: 0 },
    candidateCatalogsVerified: 0, candidateChunksVerified: 0, quotaAdditionalBytes: 125017896, quotaRefund: 0 };
  const receiptRaw = Buffer.from(JSON.stringify(receipt));
  const approval = { priorHelperSha256: RETRY_PRIOR_HELPER_SHA256, priorJournalSha256: prior.snapshotSha256,
    previousReceiptSha256: sha256(receiptRaw), receiptRaw };
  return { ...context, prior, receipt, approval };
}

test('retry prepared reuses exact reservation in a new journal without quota PUT or prior journal mutation', async () => {
  const context = await retryFixture();
  const priorRaw = JSON.stringify(context.prior);
  const quotaBefore = { ...context.blobs.get('control/quota'), data: Buffer.from(context.blobs.get('control/quota').data) };
  const credit = await prepareRetry(context.store, context.bundle, context.prior, context.receipt, context.approval);
  context.journal.state = { planHash: PLAN_SHA256, runId: `migration-${randomUUID()}`, phase: 'validated',
    leases: {}, operations: {}, originals: {}, reusedReservation: credit };
  const put = context.store.put;
  context.store.put = async (key, ...args) => { assert.notEqual(key, 'control/quota'); return put(key, ...args); };
  const result = await runMigration(context.options);
  assert.equal(result.applied, true);
  assert.deepEqual(context.blobs.get('control/quota'), quotaBefore);
  assert.equal(context.journal.state.operations['control/quota'], undefined);
  assert.equal(JSON.stringify(context.prior), priorRaw);
  assert.equal(context.owners.size, 0);
});

for (const scenario of ['old-head', 'candidate', 'unreleased', 'reservation', 'quota-etag', 'quota-bytes',
  'operations-hash', 'helper-hash', 'journal-hash', 'receipt-hash', 'partial-write']) {
  test(`retry prepared rejects ${scenario} before any pause or cloud write`, async () => {
    const context = await retryFixture();
    const { prior, receipt, approval, bundle } = context;
    if (scenario === 'old-head') context.blobs.get(bundle.plan.headKey).etag = '"0xabcdef"';
    if (scenario === 'candidate') context.blobs.set(`assets/${bundle.assets[0].asset.id}/chunks/0`, {
      data: bundle.assets[0].candidate, etag: '"0xabcdef"' });
    if (scenario === 'unreleased') prior.state.leases[GLOBAL_KEYS[0]].state = 'held';
    if (scenario === 'reservation') delete prior.state.reservation;
    if (scenario === 'quota-etag') context.blobs.get('control/quota').etag = '"changed"';
    if (scenario === 'quota-bytes') context.blobs.get('control/quota').data = Buffer.from('{}');
    if (scenario === 'operations-hash') prior.state.consistency.operationsHash = '0'.repeat(64);
    if (scenario === 'helper-hash') approval.priorHelperSha256 = '0'.repeat(64);
    if (scenario === 'journal-hash') approval.priorJournalSha256 = '0'.repeat(64);
    if (scenario === 'receipt-hash') approval.previousReceiptSha256 = '0'.repeat(64);
    if (scenario === 'partial-write') {
      prior.state.operations[bundle.plan.snapshotKey] = { kind: 'put', state: 'done' };
      prior.state.consistency.operationsHash = sha256(Buffer.from(JSON.stringify(prior.state.operations)));
    }
    context.store.acquire = context.store.renew = context.store.release = context.store.put = context.store.delete = async () => {
      assert.fail('retry preflight must remain read-only');
    };
    await assert.rejects(prepareRetry(context.store, bundle, prior, receipt, approval), /retry_|operation_identity_changed/);
    assert.equal(context.owners.size, 0);
  });
}

test('retry prepared rechecks quota before acquiring and retains credit unchanged through rollback', async () => {
  const context = await retryFixture();
  const credit = await prepareRetry(context.store, context.bundle, context.prior, context.receipt, context.approval);
  context.journal.state = { planHash: PLAN_SHA256, runId: `migration-${randomUUID()}`, phase: 'validated',
    leases: {}, operations: {}, originals: {}, reusedReservation: credit };
  const quota = context.blobs.get('control/quota');
  const expected = quota.etag;
  quota.etag = '"intervening-import"';
  await assert.rejects(runMigration(context.options), /retry_quota_changed/);
  assert.equal(Object.keys(context.journal.state.leases).length, 0);
  quota.etag = expected;
  const put = context.store.put;
  context.store.put = async (key, ...args) => { assert.notEqual(key, 'control/quota'); return put(key, ...args); };
  await assert.rejects(runMigration({ ...context.options,
    fault: async step => { if (step === 'after-cas') throw new Error('synthetic_failure'); } }), /recovery_required/);
  let now = 0;
  const read = context.store.read;
  context.store.read = async (...args) => { now += 2000; return read(...args); };
  const result = await runMigration({ ...context.options, mode: 'rollback', clock: () => now });
  assert.equal(result.rolledBack, true);
  assert.equal(context.blobs.get('control/quota'), quota);
  assert.equal(context.journal.state.operations['control/quota'], undefined);
  assert.equal(context.owners.size, 0);
});

test('retry prepared CLI requires a fresh run ID and all literal prior and current approvals', () => {
  const environment = { REVIEWED_MIGRATION_APPLY_SHA256: 'current', REVIEWED_MIGRATION_PLAN_SHA256: PLAN_SHA256,
    MIGRATION_PARENT_REVIEW_APPROVED: 'true', MIGRATION_EXTERNAL_WRITERS_PAUSED: 'true',
    MIGRATION_RUN_ID: `migration-${randomUUID()}`, REVIEWED_MIGRATION_PRIOR_HELPER_SHA256: RETRY_PRIOR_HELPER_SHA256,
    REVIEWED_MIGRATION_PRIOR_JOURNAL_SHA256: '1'.repeat(64), REVIEWED_MIGRATION_PRIOR_RECEIPT_SHA256: '2'.repeat(64) };
  assert.equal(requestedApplyMode(['--retry-prepared'], environment, 'current'), 'retry-prepared');
  for (const key of Object.keys(environment)) assert.throws(() => requestedApplyMode(['--retry-prepared'], {
    ...environment, [key]: '',
  }, 'current'), /approval/);
});

test('retry prepared private journal persists reservation provenance in its very first snapshot', async () => {
  const privateBase = await mkdtemp(resolve(tmpdir(), 'migration-retry-journal-test-'));
  try {
    const directory = migrationJournalDirectory(PLAN_SHA256, `migration-${randomUUID()}`, undefined, privateBase);
    const reusedReservation = { priorRunId: 'synthetic-prior', previousReceiptSha256: '1'.repeat(64) };
    await openJournal(directory, PLAN_SHA256, false, { privateBase, reusedReservation });
    const reopened = await openJournal(directory, PLAN_SHA256, true, { privateBase, readOnly: true });
    assert.deepEqual(reopened.state.reusedReservation, reusedReservation);
    assert.equal(reopened.snapshotSha256, sha256(await readFile(resolve(directory, 'journal.json'))));
    assert.equal(Object.keys(reopened.state.operations).length, 0);
  } finally { await rm(privateBase, { recursive: true, force: true }); }
});

test('synthetic full migration creates only draft 6, retires exact old keys, preserves quota and releases globals last', async () => {
  const context = await migrationFixture();
  const result = await runMigration(context.options);
  assert.equal(result.applied, true);
  assert.equal(result.published, false);
  assert.equal(context.owners.size, 0);
  assert.deepEqual(JSON.parse(context.blobs.get(context.bundle.plan.headKey).data), context.bundle.head);
  assert.ok(context.bundle.deletions.every(record => !context.blobs.has(record.key)));
  assert.deepEqual(context.calls.filter(value => value.startsWith('release:')).slice(-8), GLOBAL_KEYS.map(key => `release:${key}`));
});

for (const failure of ['lost-quota-ack', 'after-quota', 'lost-global-ack']) test(`finish-release recovers ${failure} without data writes or media reads`, async () => {
  const context = await migrationFixture();
  const release = context.store.release;
  let failed = false;
  context.store.release = async (key, id) => {
    assert.equal(context.journal.state.consistentOutcome, 'migrated');
    if (!failed && (failure === 'lost-quota-ack' && key === 'control/quota'
      || failure === 'after-quota' && key === context.bundle.plan.headKey
      || failure === 'lost-global-ack' && key === GLOBAL_KEYS[0])) {
      failed = true;
      if (failure !== 'after-quota') await release(key, id);
      throw new Error('lost_ack');
    }
    return release(key, id);
  };
  await assert.rejects(runMigration(context.options), /finish_release_required/);
  assert.equal(context.journal.state.phase, 'finish-release-required');
  if (failure !== 'lost-global-ack') assert.equal(GLOBAL_KEYS.filter(key => context.owners.has(key)).length, 8);
  const writes = context.writes.length;
  context.store.put = context.store.delete = context.store.acquire = async () => assert.fail('release-only mutation');
  const read = context.store.read;
  context.store.read = async (key, ...args) => { assert.equal(key.includes('/chunks/'), false); return read(key, ...args); };
  const result = await runMigration({ ...context.options, mode: failure === 'after-quota' ? 'resume' : 'finish-release',
    verifyOriginals: async () => assert.fail('original media read'), verifyCandidates: async () => assert.fail('candidate media read') });
  assert.equal(result.applied, true);
  assert.equal(context.writes.length, writes);
  assert.equal(context.owners.size, 0);
  assert.ok(GLOBAL_KEYS.every(key => context.journal.state.leases[key].state === 'released'));
});

test('finish-release permits legitimate revision advancement and metadata changes after partial global release', async () => {
  const context = await migrationFixture();
  const release = context.store.release;
  let failed = false;
  context.store.release = async (key, id) => {
    await release(key, id);
    if (!failed && key === GLOBAL_KEYS[0]) { failed = true; throw new Error('lost_ack'); }
  };
  await assert.rejects(runMigration(context.options), /finish_release_required/);
  const body = structuredClone(context.bundle.body);
  body.routine.revision = 7;
  const snapshotKey = `snapshots/${context.bundle.plan.routineId}/${randomUUID()}`;
  context.blobs.set(snapshotKey, { etag: '"0xfe"', data: Buffer.from(JSON.stringify(body)) });
  const head = structuredClone(context.bundle.head);
  head.draft.revision = 7;
  head.draft.key = snapshotKey;
  head.history.push({ revision: 7, draft: snapshotKey });
  context.blobs.set(context.bundle.plan.headKey, { etag: '"0xff"', data: Buffer.from(JSON.stringify(head)) });
  context.blobs.get(`heads/${context.bundle.plan.routineId}`).etag = '"0xff"';
  context.blobs.get(GLOBAL_KEYS[0]).data = Buffer.from('{"window":1,"count":3}');
  context.blobs.get(GLOBAL_KEYS[0]).etag = '"0xff"';
  context.store.put = context.store.delete = context.store.acquire = async () => assert.fail('release-only mutation');
  const read = context.store.read;
  context.store.read = async (key, ...args) => { assert.equal(key.includes('/chunks/'), false); return read(key, ...args); };
  assert.equal((await runMigration({ ...context.options, mode: 'finish-release' })).applied, true);
  assert.equal(context.owners.size, 0);
  assert.equal(JSON.parse(context.blobs.get(context.bundle.plan.headKey).data).draft.revision, 7);
});

for (const conflict of ['foreign-releasing', 'foreign-released', 'broken-held', 'changed-proof']) {
  test(`finish-release stops ${conflict} before releasing any remaining guard`, async () => {
    const context = await migrationFixture();
    const release = context.store.release;
    const key = conflict === 'foreign-released' ? GLOBAL_KEYS[1] : GLOBAL_KEYS[0];
    let failed = false;
    context.store.release = async (bucket, id) => {
      if (!failed && bucket === key) {
        failed = true;
        if (conflict === 'foreign-releasing') await release(bucket, id);
        throw new Error('lost_ack');
      }
      return release(bucket, id);
    };
    await assert.rejects(runMigration(context.options), /finish_release_required/);
    if (conflict.startsWith('foreign')) context.owners.set(GLOBAL_KEYS[0], randomUUID());
    if (conflict === 'broken-held') {
      context.owners.delete(GLOBAL_KEYS[2]);
      context.blobs.get(GLOBAL_KEYS[2]).leaseState = 'broken';
    }
    if (conflict === 'changed-proof') context.journal.state.operations[context.bundle.plan.headKey].etag = '"changed"';
    const owners = new Map(context.owners);
    const releaseCount = context.calls.filter(call => call.startsWith('release:')).length;
    await assert.rejects(runMigration({ ...context.options, mode: 'finish-release' }), /finish_release_required/);
    assert.equal(context.calls.filter(call => call.startsWith('release:')).length, releaseCount);
    assert.equal([...owners].every(([bucket, id]) => context.owners.get(bucket) === id), true);
  });
}

test('finish-release refuses an unverified run before any lease or data mutation', async () => {
  const context = await migrationFixture();
  await assert.rejects(runMigration({ ...context.options, mode: 'finish-release' }), /finish_release_required/);
  assert.equal(context.writes.length, 0);
  assert.equal(context.owners.size, 0);
  assert.equal(context.calls.some(call => call.startsWith('release:')), false);
});

test('before-CAS failure leaves old head intact and safely releases; staging charges are retained', async () => {
  const context = await migrationFixture();
  await assert.rejects(runMigration({ ...context.options, fault: async step => { if (step === 'before-cas') throw new Error('injected'); } }), /not_applied/);
  assert.equal(context.owners.size, 0);
  assert.deepEqual(JSON.parse(context.blobs.get(context.bundle.plan.headKey).data), context.bundle.oldHead);
  assert.equal(JSON.parse(context.blobs.get('control/quota').data).bytes, 67108864 + 125017896);
});

for (const boundary of ['after-cas', 'during-retirement']) test(`${boundary} failure keeps leases; resume reconciles without duplicate quota`, async () => {
  const context = await migrationFixture();
  await assert.rejects(runMigration({ ...context.options, fault: async step => { if (step === boundary) throw new Error('injected'); } }), /recovery_required_paused/);
  assert.equal(GLOBAL_KEYS.filter(key => context.owners.has(key)).length, 8);
  const result = await runMigration({ ...context.options, mode: 'resume' });
  assert.equal(result.applied, true);
  assert.equal(context.writes.filter(key => key === 'control/quota').length, 1);
  assert.equal(context.owners.size, 0);
});

test('fresh user edit stops before the first lease or write', async () => {
  const context = await migrationFixture();
  context.blobs.get(context.bundle.plan.headKey).etag = '"0x2"';
  await assert.rejects(runMigration(context.options), /user_edit_guard/);
  assert.equal(context.writes.length, 0);
  assert.equal(context.owners.size, 0);
});

test('missing one global bucket stops before quota acquisition', async () => {
  const context = await migrationFixture();
  context.blobs.delete(GLOBAL_KEYS[7]);
  await assert.rejects(runMigration(context.options), /missing_stop_before_pause/);
  assert.equal(context.owners.size, 0);
});

test('unknown target chunk or namespace refuses the migration before pausing', async () => {
  for (const unknown of ['mystery/record', 'target-extra']) {
    const context = await migrationFixture();
    const key = unknown === 'target-extra' ? `assets/${context.bundle.assets[0].source.id}/chunks/99` : unknown;
    context.blobs.set(key, { etag: '"0x1"', data: Buffer.alloc(44) });
    await assert.rejects(runMigration(context.options), /unknown_blob_prefix|unexpected_target_blob/);
    assert.equal(context.owners.size, 0);
  }
});

test('prepared cue, gain, BPM, title, filler, order and IDs have exact replacement guards', async () => {
  const context = await migrationFixture();
  const { plan, oldHead, oldBody, head, body } = context.bundle;
  validateReplacement(plan, oldHead, oldBody, head, body);
  for (const mutate of [value => { value.routine.tracks[0].gain = 1; }, value => { value.routine.tracks[0].bpm = 90; },
    value => { value.routine.tracks[0].title = 'Changed'; }, value => { value.routine.tracks.reverse(); },
    value => { value.routine.filler.sound = 'bright'; }, value => { value.routine.tracks[0].cues = [{ id: randomUUID() }]; }]) {
    const changed = structuredClone(body); mutate(changed);
    assert.throws(() => validateReplacement(plan, oldHead, oldBody, head, changed), /replacement_content_changed/);
  }
});

test('new CloudDocuments reader resolves only draft 6; publication and retired revisions stay unavailable', async () => {
  const context = await migrationFixture();
  const load = sourceModules();
  const { CloudDocuments } = load(resolve(ROOT, 'api/src/cloud/documents.ts'));
  class Documents extends CloudDocuments {
    entity(body) { return body.routine; }
  }
  const documents = new Documents({ get: async key => {
    if (key === context.bundle.plan.headKey) return { bytes: Buffer.from(JSON.stringify(context.bundle.head)), etag: '"0x2"' };
    if (key === context.bundle.plan.snapshotKey) return { bytes: Buffer.from(JSON.stringify(context.bundle.body)), etag: '"0x2"' };
    return null;
  } }, {}, 'routine');
  assert.deepEqual(await documents.readVersion(context.bundle.plan.routineId, false, 6), context.bundle.body);
  await assert.rejects(documents.readVersion(context.bundle.plan.routineId, false, 5), /revision_not_found/);
  await assert.rejects(documents.readVersion(context.bundle.plan.routineId, true), /publication_not_found/);
});

for (const boundary of ['after-cas', 'during-retirement']) test(`rollback after ${boundary} restores old metadata before old head and retains new charges`, async () => {
  const context = await migrationFixture();
  await assert.rejects(runMigration({ ...context.options, fault: async step => { if (step === boundary) throw new Error('crash'); } }), /recovery_required/);
  let now = 0;
  const read = context.store.read;
  context.store.read = async (...args) => { now += 2000; return read(...args); };
  const result = await runMigration({ ...context.options, mode: 'rollback', clock: () => now });
  assert.equal(result.rolledBack, true);
  assert.deepEqual(JSON.parse(context.blobs.get(context.bundle.plan.headKey).data), context.bundle.oldHead);
  assert.equal(context.owners.size, 0);
  for (const record of context.bundle.deletions) assert.equal(sha256(context.blobs.get(record.key).data), record.sha256);
  assert.equal(context.writes.filter(key => key === 'control/quota').length, 1);
  assert.equal(context.writes.filter(key => key === context.bundle.plan.headKey).length, 2);
});

async function retiredRollbackFixture() {
  const context = await migrationFixture();
  const remove = context.store.delete;
  const last = context.bundle.assets.at(-1).sourceRecord.chunks[0].key;
  let failed = false;
  context.store.delete = async (...args) => {
    await remove(...args);
    if (!failed && args[0] === last) { failed = true; throw new Error('retirement_ack_lost'); }
  };
  await assert.rejects(runMigration(context.options), /recovery_required/);
  let time = 0;
  const read = context.store.read;
  context.store.read = async (...args) => { time += 2000; return read(...args); };
  context.options.clock = () => time;
  return context;
}

for (const kind of ['source', 'catalog', 'upload', 'head']) {
  for (const crash of ['lost-ack', 'after-restore']) test(`rollback ${kind} ${crash} resumes exact restores before lease collection`, async () => {
    const context = await retiredRollbackFixture();
    const key = kind === 'source' ? context.bundle.assets[0].sourceRecord.key : kind === 'catalog'
      ? `assets/${context.bundle.assets[0].source.id}/catalog` : kind === 'upload'
        ? context.bundle.backup.staging[0].key : context.bundle.plan.headKey;
    const put = context.store.put;
    let failed = false;
    context.store.put = async (...args) => {
      const result = await put(...args);
      if (!failed && args[0] === key && crash === 'lost-ack') { failed = true; throw new Error('restore_ack_lost'); }
      return result;
    };
    await assert.rejects(runMigration({ ...context.options, mode: 'rollback', fault: async (step, restoredKey) => {
      if (!failed && crash === 'after-restore' && step === 'after-restore' && restoredKey === key) {
        failed = true; throw new Error('restore_crash');
      }
    } }), /recovery_required/);
    assert.equal(failed, true);
    assert.ok(GLOBAL_KEYS.every(bucket => context.owners.has(bucket)));
    assert.equal(context.calls.some(call => call.startsWith('release:')), false);
    const etag = context.blobs.get(key).etag;
    const writes = context.writes.filter(item => item === key).length;
    const result = await runMigration({ ...context.options, mode: 'resume' });
    assert.equal(result.rolledBack, true);
    assert.equal(context.writes.filter(item => item === key).length, writes);
    assert.equal(context.blobs.get(key).etag, etag);
    assert.equal(context.owners.size, 0);
    assert.ok(GLOBAL_KEYS.every(bucket => context.journal.state.leases[bucket].state === 'released'));
    assert.equal(context.writes.filter(item => item === 'control/quota').length, 1);
    for (const record of context.bundle.deletions) assert.equal(sha256(context.blobs.get(record.key).data), record.sha256);
    assert.equal(context.blobs.get(context.bundle.plan.headKey).data.equals(Buffer.from(JSON.stringify(context.bundle.oldHead))), true);
  });
}

for (const conflict of ['changed-bytes', 'changed-length', 'changed-acknowledged-etag', 'missing-delete-intent']) {
  test(`rollback refuses ${conflict} before acquiring or overwriting restored metadata`, async () => {
    const context = await retiredRollbackFixture();
    const key = `assets/${context.bundle.assets[0].source.id}/catalog`;
    const put = context.store.put;
    let failed = false;
    context.store.put = async (...args) => {
      const etag = await put(...args);
      if (!failed && args[0] === key) { failed = true; throw new Error('lost_ack'); }
      return etag;
    };
    await assert.rejects(runMigration({ ...context.options, mode: 'rollback' }), /recovery_required/);
    const operation = context.journal.state.operations[`restore:${key}`];
    if (conflict === 'changed-bytes') context.blobs.get(key).data[0] ^= 1;
    if (conflict === 'changed-length') context.blobs.get(key).data = Buffer.concat([context.blobs.get(key).data, Buffer.from(' ')]);
    if (conflict === 'changed-acknowledged-etag') {
      operation.state = 'done'; operation.etag = context.blobs.get(key).etag;
      context.blobs.get(key).etag = '"changed"';
    }
    if (conflict === 'missing-delete-intent') delete context.journal.state.operations[`delete:${key}`];
    const calls = context.calls.filter(call => !call.startsWith('journal')).length;
    const writes = context.writes.length;
    await assert.rejects(runMigration({ ...context.options, mode: 'resume' }), /restore_/);
    assert.equal(context.calls.filter(call => !call.startsWith('journal')).length, calls);
    assert.equal(context.writes.length, writes);
    assert.ok(GLOBAL_KEYS.every(bucket => context.owners.has(bucket)));
  });
}

test('rollback with lost head CAS ACK restores conditionally and finishes interrupted release without media reads', async () => {
  const context = await migrationFixture();
  const put = context.store.put;
  let failed = false;
  context.store.put = async (...args) => {
    const etag = await put(...args);
    if (!failed && args[0] === context.bundle.plan.headKey) { failed = true; throw new Error('cas_ack_lost'); }
    return etag;
  };
  await assert.rejects(runMigration(context.options), /recovery_required/);
  let time = 0;
  const read = context.store.read;
  context.store.read = async (...args) => { time += 2000; return read(...args); };
  const release = context.store.release;
  let releaseFailed = false;
  context.store.release = async (...args) => {
    await release(...args);
    if (!releaseFailed) { releaseFailed = true; throw new Error('release_ack_lost'); }
  };
  await assert.rejects(runMigration({ ...context.options, mode: 'rollback', clock: () => time }), /finish_release_required/);
  assert.equal(context.journal.state.consistentOutcome, 'rolled-back');
  context.store.put = context.store.delete = context.store.acquire = async () => assert.fail('release-only mutation');
  context.store.read = async (key, ...args) => { assert.equal(key.includes('/chunks/'), false); return read(key, ...args); };
  assert.equal((await runMigration({ ...context.options, mode: 'resume' })).rolledBack, true);
  assert.equal(context.owners.size, 0);
});

test('rollback reconciles a quota PUT with lost ACK without rewriting or double-charging', async () => {
  const context = await migrationFixture();
  const put = context.store.put;
  context.store.put = async (...args) => {
    const etag = await put(...args);
    if (args[0] === 'control/quota') throw new Error('quota_ack_lost');
    return etag;
  };
  await assert.rejects(runMigration(context.options), /recovery_required/);
  assert.equal(context.journal.state.operations['control/quota'].state, 'attempting');
  const charged = { ...context.blobs.get('control/quota'), data: Buffer.from(context.blobs.get('control/quota').data) };
  let time = 0;
  const read = context.store.read;
  context.store.read = async (...args) => { time += 2000; return read(...args); };
  assert.equal((await runMigration({ ...context.options, mode: 'rollback', clock: () => time })).rolledBack, true);
  assert.equal(context.journal.state.operations['control/quota'].state, 'done');
  assert.deepEqual(context.blobs.get('control/quota'), charged);
  assert.equal(context.writes.filter(key => key === 'control/quota').length, 1);
  assert.equal(context.owners.size, 0);
  assert.deepEqual(context.calls.filter(value => value.startsWith('release:')).slice(-8),
    GLOBAL_KEYS.map(key => `release:${key}`));
});

async function pendingForwardFixture(target, applied) {
  const context = await migrationFixture({ candidateBytes: 1024 * 1024 });
  const quota = context.blobs.get('control/quota');
  quota.data = Buffer.from(JSON.stringify({ ...JSON.parse(quota.data), fillers: 2, active: { synthetic: 7 } }));
  const key = target === 'quota' ? 'control/quota' : target === 'head' ? context.bundle.plan.headKey
    : `assets/${context.bundle.assets[0].asset.id}/chunks/0`;
  const put = context.store.put;
  context.store.put = async (...args) => {
    if (args[0] !== key) return put(...args);
    if (applied) await put(...args);
    throw new Error('synthetic_put_interrupted');
  };
  await assert.rejects(runMigration(context.options), /recovery_required/);
  assert.equal(context.journal.state.operations[key].state, 'attempting');
  assert.equal(GLOBAL_KEYS.every(value => context.owners.has(value)), true);
  let time = 0;
  const read = context.store.read;
  context.store.read = async (...args) => { time += 2000; return read(...args); };
  context.options.clock = () => time;
  context.store.put = put;
  return { ...context, key };
}

for (const [target, applied] of [['quota', false], ['head', false], ['candidate', false], ['candidate', true]]) {
  test(`rollback pending ${target} PUT ${applied ? 'ACK lost' : 'never applied'} preserves originals and releases all eight buckets`, async () => {
    const context = await pendingForwardFixture(target, applied);
    const quota = { ...context.blobs.get('control/quota'), data: Buffer.from(context.blobs.get('control/quota').data) };
    context.store.put = context.store.delete = async () => assert.fail('rollback must not rewrite retained data');
    const result = await runMigration({ ...context.options, mode: 'rollback' });
    assert.equal(result.rolledBack, true);
    assert.equal(result.quotaRefund, 0);
    const operation = context.journal.state.operations[context.key];
    assert.equal(operation.state, applied ? 'done' : 'not-applied');
    if (applied) assert.equal(operation.etag, context.blobs.get(context.key).etag);
    else {
      assert.equal(operation.etag, undefined);
      assert.equal(operation.proof.kind, target === 'candidate' ? 'absent' : 'preimage');
      if (target !== 'candidate') {
        assert.equal(operation.proof.etag, operation.expected);
        assert.equal(operation.proof.sha256, sha256(context.blobs.get(context.key).data));
      } else assert.equal(context.blobs.has(context.key), false);
    }
    for (const record of [...context.bundle.backup.metadata, ...context.bundle.deletions]) {
      assert.equal(context.blobs.get(record.key).etag, record.etag);
      assert.equal(sha256(context.blobs.get(record.key).data), record.sha256);
    }
    assert.deepEqual(context.blobs.get('control/quota'), quota);
    assert.equal(context.writes.filter(value => value === context.key).length, applied ? 1 : 0);
    assert.equal(context.journal.state.consistency.headHash, context.bundle.oldHeadRecord.sha256);
    assert.equal(context.journal.state.consistency.operationsHash, sha256(Buffer.from(JSON.stringify(context.journal.state.operations))));
    assert.equal(context.owners.size, 0);
    assert.deepEqual(context.calls.filter(value => value.startsWith('release:')).slice(-8), GLOBAL_KEYS.map(value => `release:${value}`));
  });
}

for (const [target, applied] of [['quota', true], ['head', false], ['candidate', false], ['candidate', true]]) {
  test(`rollback pending ${target} PUT ${applied ? 'ACK lost' : 'never applied'} resumes after reconciliation persistence fault`, async () => {
    const context = await pendingForwardFixture(target, applied);
    context.store.put = context.store.delete = async () => assert.fail('forward work must not restart');
    let persisted;
    const fault = async (point, key) => {
      if (point === 'after-forward-put-reconcile' && key === context.key) {
        persisted = JSON.parse(JSON.stringify(context.journal.state));
        throw new Error('synthetic_reconciliation_persist_ack_lost');
      }
    };
    await assert.rejects(runMigration({ ...context.options, mode: 'rollback', fault }), /recovery_required/);
    assert.equal(context.journal.state.consistentOutcome, undefined);
    assert.equal(context.journal.state.rollbackStarted, true);
    assert.equal(GLOBAL_KEYS.every(key => context.owners.has(key)), true);
    assert.equal(context.calls.some(value => value.startsWith('release:')), false);
    assert.equal(migrationFailure(new Error('synthetic'), context.journal).complete, false);
    context.journal.state = persisted;
    context.options.verifyCandidates = context.options.verifyOriginals = async () => assert.fail('forward verification must not restart');
    assert.equal((await runMigration({ ...context.options, mode: 'resume' })).rolledBack, true);
    assert.equal(context.journal.state.operations[context.key].state, applied ? 'done' : 'not-applied');
    assert.equal(context.owners.size, 0);
    assert.deepEqual(context.calls.filter(value => value.startsWith('release:')).slice(-8), GLOBAL_KEYS.map(value => `release:${value}`));
  });
}

for (const [target, applied] of [['quota', false], ['quota', true], ['head', false], ['candidate', true]]) {
  test(`rollback pending ${target} PUT ${applied ? 'ACK lost' : 'never applied'} refuses unaccounted foreign ETag or content`, async () => {
    const context = await pendingForwardFixture(target, applied);
    const original = context.blobs.get(context.key);
    const data = target === 'candidate' ? Buffer.alloc(1024 * 1024, 99)
      : applied ? Buffer.from(JSON.stringify({ ...JSON.parse(original.data), bytes: JSON.parse(original.data).bytes + 1 }))
        : Buffer.from(original.data);
    context.blobs.set(context.key, { etag: '"0xdead"', data });
    const writes = context.writes.length;
    await assert.rejects(runMigration({ ...context.options, mode: 'rollback' }), /recovery_required|target_user_edit_guard_stop/);
    assert.equal(context.journal.state.operations[context.key].state, 'attempting');
    assert.equal(context.journal.state.consistentOutcome, undefined);
    assert.equal(GLOBAL_KEYS.every(key => context.owners.has(key)), true);
    assert.equal(context.calls.some(value => value.startsWith('release:')), false);
    assert.equal(context.writes.length, writes);
  });
}

test('rollback pending quota PUT requires dirty ETag to remain leased', async () => {
  const context = await pendingForwardFixture('quota', true);
  const properties = context.store.properties;
  context.store.properties = async key => {
    const row = await properties(key);
    return key === context.key ? { ...row, leaseState: 'available' } : row;
  };
  await assert.rejects(runMigration({ ...context.options, mode: 'rollback' }), /recovery_required/);
  assert.equal(context.journal.state.operations[context.key].state, 'attempting');
  assert.equal(GLOBAL_KEYS.every(key => context.owners.has(key)), true);
  assert.equal(context.calls.some(value => value.startsWith('release:')), false);
});

for (const changed of [false, true]) {
  test(`rollback pending head uses completed restore proof ${changed ? 'to reject changed original bytes' : 'to record reverted, not completed new bytes'}`, async () => {
    const context = await pendingForwardFixture('head', true);
    await assert.rejects(runMigration({ ...context.options, mode: 'rollback', fault: async (point, key) => {
      if (point === 'after-restore' && key === context.key) throw new Error('synthetic_after_restore_crash');
    } }), /recovery_required/);
    const operation = context.journal.state.operations[context.key];
    operation.state = 'attempting';
    const restore = context.journal.state.operations['restore:head'];
    assert.equal(restore.state, 'done');
    assert.equal(restore.expected, operation.etag);
    context.store.put = context.store.delete = async () => assert.fail('restored data must not be rewritten');
    if (changed) {
      const head = context.blobs.get(context.key);
      head.data = Buffer.concat([head.data, Buffer.from(' ')]);
      await assert.rejects(runMigration({ ...context.options, mode: 'resume' }), /restore_content_changed/);
      assert.equal(operation.state, 'attempting');
      assert.equal(GLOBAL_KEYS.every(key => context.owners.has(key)), true);
      assert.equal(context.calls.some(value => value.startsWith('release:')), false);
    } else {
      assert.equal((await runMigration({ ...context.options, mode: 'resume' })).rolledBack, true);
      const final = context.journal.state.operations[context.key];
      assert.equal(final.state, 'reverted');
      assert.equal(final.sha256, context.bundle.plan.head.sha256);
      assert.deepEqual(final.proof, { kind: 'restore', label: 'restore:head', etag: restore.etag,
        sha256: context.bundle.oldHeadRecord.sha256, bytes: context.bundle.oldHeadRecord.bytes });
      assert.equal(context.owners.size, 0);
    }
  });
}

test('rollback terminal preimage proof is checked again before finish-release', async () => {
  const context = await pendingForwardFixture('head', false);
  context.store.release = async () => { throw new Error('synthetic_release_not_sent'); };
  await assert.rejects(runMigration({ ...context.options, mode: 'rollback' }), /finish_release_required/);
  const operation = context.journal.state.operations[context.key];
  assert.equal(operation.state, 'not-applied');
  operation.proof.sha256 = operation.sha256;
  context.journal.state.consistency.operationsHash = sha256(Buffer.from(JSON.stringify(context.journal.state.operations)));
  context.store.checkRelease = context.store.release = async () => assert.fail('forged proof must stop before release');
  await assert.rejects(runMigration({ ...context.options, mode: 'finish-release' }), /finish_release_required/);
  assert.equal(GLOBAL_KEYS.every(key => context.owners.has(key)), true);
});

test('rollback retains charged quota and optional fields even when old quota is present in backup metadata', async () => {
  const context = await pendingForwardFixture('head', false);
  const before = Buffer.from(context.journal.state.reservation.before, 'base64');
  context.bundle.backup.metadata.push({ key: 'control/quota', etag: context.journal.state.reservation.expected,
    bytes: before.length, sha256: sha256(before) });
  const charged = { ...context.blobs.get('control/quota'), data: Buffer.from(context.blobs.get('control/quota').data) };
  context.store.put = context.store.delete = async () => assert.fail('no quota refund or orphan rewrite');
  assert.equal((await runMigration({ ...context.options, mode: 'rollback' })).rolledBack, true);
  assert.deepEqual(context.blobs.get('control/quota'), charged);
  assert.equal(JSON.parse(charged.data).fillers, 2);
  assert.deepEqual(JSON.parse(charged.data).active, { synthetic: 7 });
  assert.equal(context.owners.size, 0);
});

test('rollback rejects candidate bytes matching a tampered attempt but not the planned chunk', async () => {
  const context = await pendingForwardFixture('candidate', true);
  const candidate = context.blobs.get(context.key);
  candidate.data = Buffer.alloc(1024 * 1024, 91);
  context.journal.state.operations[context.key].sha256 = sha256(candidate.data);
  await assert.rejects(runMigration({ ...context.options, mode: 'rollback' }), /recovery_required/);
  assert.equal(context.journal.state.operations[context.key].state, 'attempting');
  assert.equal(GLOBAL_KEYS.every(key => context.owners.has(key)), true);
  assert.equal(context.calls.some(value => value.startsWith('release:')), false);
});

test('rollback resumes a preimage attempt after reconciliation fails before journal persistence', async () => {
  const context = await pendingForwardFixture('head', false);
  const update = context.journal.update.bind(context.journal);
  let failed = false;
  context.journal.update = async change => {
    const proposed = structuredClone(context.journal.state);
    change(proposed);
    if (!failed && proposed.operations[context.key].state === 'not-applied') {
      failed = true;
      throw new Error('synthetic_journal_write_not_applied');
    }
    return update(change);
  };
  await assert.rejects(runMigration({ ...context.options, mode: 'rollback' }), /recovery_required/);
  assert.equal(context.journal.state.operations[context.key].state, 'attempting');
  assert.equal(context.journal.state.rollbackStarted, true);
  assert.equal(GLOBAL_KEYS.every(key => context.owners.has(key)), true);
  context.store.put = context.store.delete = async () => assert.fail('apply must honor persisted rollback intent');
  assert.equal((await runMigration({ ...context.options, mode: 'apply' })).rolledBack, true);
  assert.equal(context.journal.state.operations[context.key].state, 'not-applied');
  assert.equal(context.owners.size, 0);
});

test('rollback resolves an attempted delete that failed before changing the original blob', async () => {
  const context = await migrationFixture();
  context.store.delete = async () => { throw new Error('delete_not_sent'); };
  await assert.rejects(runMigration(context.options), /recovery_required/);
  let time = 0;
  const read = context.store.read;
  context.store.read = async (...args) => { time += 2000; return read(...args); };
  assert.equal((await runMigration({ ...context.options, mode: 'rollback', clock: () => time })).rolledBack, true);
  assert.equal(context.owners.size, 0);
});

test('insufficient useful-work drain safely stops with old head and verified staged orphans', async () => {
  const context = await migrationFixture();
  const stage = context.options.verifyCandidates;
  await assert.rejects(runMigration({ ...context.options, verifyCandidates: async (...args) => {
    await stage(...args); context.setTime(DRAIN_MS - 1);
  } }), /not_applied_orphans_retained/);
  assert.equal(context.owners.size, 0);
  assert.equal(context.blobs.get(context.bundle.plan.headKey).etag, context.bundle.plan.expectedHeadEtag);
  assert.ok(context.bundle.assets.every(item => context.blobs.has(`assets/${item.asset.id}/catalog`)));
});

test('new outside reference under the barrier halts with no head or old-asset deletion', async () => {
  const context = await migrationFixture();
  const stage = context.options.verifyCandidates;
  await assert.rejects(runMigration({ ...context.options, verifyCandidates: async (...args) => {
    await stage(...args);
    const body = structuredClone(context.bundle.oldBody);
    body.routine.id = randomUUID();
    context.blobs.set(`snapshots/${body.routine.id}/${randomUUID()}`, { etag: '"0x1"', data: Buffer.from(JSON.stringify(body)) });
  } }), /not_applied_orphans_retained/);
  assert.equal(context.blobs.get(context.bundle.plan.headKey).etag, context.bundle.plan.expectedHeadEtag);
  assert.ok(context.bundle.deletions.every(record => context.blobs.has(record.key)));
});

test('preserved LIVE bundled handler denies all eight buckets before routing on independent workers',
  { skip: !process.env.MIGRATION_LIVE_API_DIRECTORY }, () => {
    const path = resolve(ROOT, process.env.MIGRATION_LIVE_API_DIRECTORY, 'dist/functions.cjs');
    assert.ok(path.startsWith(`${ROOT}/local-media/`));
    const source = readFileSync(path, 'utf8');
    const start = source.indexOf('var activeRequests = 0;');
    const end = source.indexOf('// src/cloud/functions.ts', start);
    assert.ok(start > 0 && end > start);
    const load = sourceModules();
    const { updateJson, BlobConflict } = load(resolve(ROOT, 'api/src/cloud/store.ts'));
    const { ApiError } = load(resolve(ROOT, 'api/src/cloud/config.ts'));
    return (async () => {
      for (let bucket = 0; bucket < 8; bucket++) for (let worker = 0; worker < 3; worker++) {
        const CloudApi = new Function('updateJson', 'BlobConflict', 'ApiError', 'ServiceError', 'failure', 'import_node_crypto8',
          `${source.slice(start, end)}; return CloudApi;`)(updateJson, BlobConflict, ApiError, class extends Error {},
          (status, code) => ({ status, code }), { randomInt: () => bucket });
        const api = Object.create(CloudApi.prototype);
        api.auth = { config() {}, now: () => 0 };
        api.store = {
          async get(key) { assert.equal(key, GLOBAL_KEYS[bucket]); return { bytes: Buffer.from('{"window":0,"count":0}'), etag: '"0x1"' }; },
          async put(key) { assert.equal(key, GLOBAL_KEYS[bucket]); throw new BlobConflict(); },
        };
        for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
          const response = await api.handle({ method, get url() { assert.fail('route reached'); } });
          assert.equal(response.status, 503);
          assert.equal(response.code, 'storage_busy');
        }
      }
    })();
  });