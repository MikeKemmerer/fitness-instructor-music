import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, relative, dirname, basename, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { browserDecode, buildReplacement, CHUNK_BYTES, collectBounded, connectReadOnly, decodedFrames,
  downloadAsset, hashFile, inspectUpload, listAll, probe, requireFact, sameAsset,
  validateBody, verifyPrivateIgnore, verifyTimeline } from './migrate-media.mjs';
import { azureJson, classify, describeMetadata, parseMetadata, strongEtag, validators } from './inspect-media-migration.mjs';
import { createRequire } from 'node:module';
import { readArtifact } from './deploy.mjs';

export const GLOBAL_KEYS = Object.freeze(Array.from({ length: 8 }, (_, index) => `traffic/global-${index}`));
export const DRAIN_MS = 60000;
export const PLAN_SHA256 = '5604659be1d8c3ad60854ce8d997a99fa1d105b4f39cda12ac130684cfe2b8da';
export const RESTORE_SHA256 = '5e77d5c4a1545b10fef3a876e703969fca1f86d61783978ca5f24598a4b1c3a5';
export const RETRY_PRIOR_HELPER_SHA256 = 'f38c9bc4d8b02478887353e34728e4c4a99b4cd650ac5e3c4926194115ec5bea';
export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_JSON = 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const equal = (first, second) => isDeepStrictEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));

export function diagnosticFailure(error, step) {
  const steps = new Set(['acquiring', 'source-verification', 'reservation', 'before-first-candidate',
    'candidate-staging', 'candidate-verification', 'snapshot', 'head-cas', 'retirement', 'release',
    'writer-scope', 'writer-renew', 'writer-properties', 'writer-intent', 'writer-put', 'writer-readback']);
  const codes = new Set(['storage_operation_failed', 'write_scope_rejected', 'lease_identity_changed',
    'lease_ownership_unresolved', 'candidate_chunk_changed', 'prepared_file_changed', 'private_path_escape',
    'preexisting_object_or_conflict', 'operation_identity_changed', 'write_conflict',
    'write_ack_unresolved_resume_required', 'write_readback_failed', 'acknowledged_object_changed',
    'drain_incomplete_not_applied', 'journal_io_failed', 'quota_changed_under_lease']);
  const prefix = `${import.meta.url}:`;
  const line = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1).map(frame => {
    const suffix = frame.includes(prefix) ? frame.slice(frame.indexOf(prefix) + prefix.length) : '';
    const match = /^(\d+):\d+\)?$/.exec(suffix);
    return match ? Number(match[1]) : undefined;
  }).find(Number.isSafeInteger) : undefined;
  return { step: steps.has(step) ? step : 'unknown',
    code: codes.has(error?.message) ? error.message : 'unrecognized_error',
    name: ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'RestError'].includes(error?.name) ? error.name : 'unknown',
    status: [400, 401, 403, 404, 409, 412, 429, 500, 503].includes(error?.statusCode) ? error.statusCode : null,
    ...(line ? { module: 'migrate-media-apply.mjs', line } : {}) };
}

export async function checkedPath(directory, path) {
  requireFact(typeof path === 'string' && !path.includes('\\') && !path.split('/').some(part => !part || part === '..' || part === '.'),
    'private_path_escape');
  const absolute = resolve(directory, path);
  requireFact(absolute.startsWith(`${directory}/`) && await realpath(absolute) === absolute
    && !(await lstat(absolute)).isSymbolicLink(), 'private_path_escape');
  return absolute;
}

export async function verifiedFile(directory, descriptor) {
  const path = await checkedPath(directory, descriptor.path);
  const actual = await hashFile(path);
  requireFact(actual.bytes === descriptor.bytes && actual.sha256 === descriptor.sha256, 'prepared_file_changed');
  return path;
}

export function validateReplacement(plan, oldHead, oldBody, head, body) {
  requireFact(plan.expectedRevision === 5 && plan.nextRevision === 6 && plan.published === false && plan.locked === false
    && plan.headKey === `routines/${plan.routineId}/head` && plan.entryMapping.length === 10
    && oldHead.draft.revision === 5 && oldHead.deleted === false && !Object.hasOwn(oldHead, 'published')
    && oldHead.draft.locked === false && oldBody.routine.id === plan.routineId, 'target_state_changed');
  const replacements = plan.entryMapping.map(mapping => ({ source: oldBody.media[mapping.oldEntryId], asset: body.media[mapping.entryId] }));
  let index = 0;
  const rebuilt = buildReplacement(oldBody, replacements, () => plan.entryMapping[index++].entryId);
  requireFact(equal(rebuilt.body, body) && equal(rebuilt.mapping, plan.entryMapping), 'replacement_content_changed');
  requireFact(equal(head, { draft: { ...oldHead.draft, revision: 6, key: plan.snapshotKey }, deleted: false,
    history: [{ revision: 6, draft: plan.snapshotKey }] }), 'replacement_head_changed');
  describeMetadata(plan.headKey, head);
  describeMetadata(plan.snapshotKey, body);
}

export function reserveQuota(previous, additional, assetCount) {
  requireFact(Object.keys(previous).every(key => ['bytes', 'operations', 'routines', 'assets', 'fillers', 'active'].includes(key))
    && ['bytes', 'operations', 'routines', 'assets'].every(key => Number.isSafeInteger(previous[key]) && previous[key] >= 0)
    && (previous.fillers === undefined || (Number.isSafeInteger(previous.fillers) && previous.fillers >= 0))
    && previous.active && !Array.isArray(previous.active) && Object.entries(previous.active).every(([key, value]) =>
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(key) && Number.isSafeInteger(value) && value > 0)
    && Number.isSafeInteger(additional) && additional > 0 && assetCount === 10, 'quota_invalid');
  const next = { ...structuredClone(previous), bytes: previous.bytes + additional,
    operations: previous.operations + assetCount + 1, assets: previous.assets + assetCount };
  requireFact(Number.isSafeInteger(next.bytes) && next.bytes <= 5 * 1024 ** 3 && next.operations <= 20000
    && next.assets <= 4096 && next.routines <= 512 && (next.fillers ?? 0) <= 512
    && Object.keys(next.active).length <= 64, 'quota_exceeded');
  return next;
}

export function sdkAdapter(container, writesAllowed = false) {
  const signal = () => AbortSignal.timeout(20000);
  const missingBlob = error => error?.statusCode === 404
    && (error.code === 'BlobNotFound' || error.details?.errorCode === 'BlobNotFound');
  const safe = async action => {
    try { return await action(); }
    catch (error) {
      const failure = new Error('storage_operation_failed');
      if ([404, 409, 412].includes(error?.statusCode)) failure.statusCode = error.statusCode;
      failure.missing = missingBlob(error);
      throw failure;
    }
  };
  const write = action => { requireFact(writesAllowed, 'cloud_mutations_not_authorized'); return safe(action); };
  return {
    properties: key => safe(async () => {
      try {
        const result = await container.getBlobClient(key).getProperties({ abortSignal: signal() });
        return { etag: strongEtag(result.etag), bytes: result.contentLength,
          modified: result.lastModified?.getTime(), leaseState: result.leaseState };
      } catch (error) { if (missingBlob(error)) return null; throw error; }
    }),
    read: (key, row, maximum) => safe(async () => collectBounded(await container.getBlobClient(key).download(0, undefined, {
      conditions: { ifMatch: strongEtag(row.etag) }, maxRetryRequests: 0, abortSignal: signal(),
    }), row, maximum)),
    acquire: (key, id, etag) => write(() => container.getBlobClient(key).getBlobLeaseClient(id).acquireLease(-1, {
      conditions: { ifMatch: strongEtag(etag) }, abortSignal: signal(),
    })),
    renew: (key, id) => write(() => container.getBlobClient(key).getBlobLeaseClient(id).renewLease({ abortSignal: signal() })),
    release: (key, id) => write(() => container.getBlobClient(key).getBlobLeaseClient(id).releaseLease({ abortSignal: signal() })),
    put: (key, bytes, etag, id) => write(async () => {
      const result = await container.getBlockBlobClient(key).upload(bytes, bytes.length, {
        conditions: { ...(etag === null ? { ifNoneMatch: '*' } : { ifMatch: strongEtag(etag) }), ...(id ? { leaseId: id } : {}) },
        blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }, abortSignal: signal(),
      });
      return strongEtag(result.etag);
    }),
    delete: (key, etag, id) => write(() => container.getBlobClient(key).delete({
      conditions: { ifMatch: strongEtag(etag), ...(id ? { leaseId: id } : {}) }, abortSignal: signal(),
    })),
  };
}

const PRIVATE_BASE = resolve(homedir(), '.cache/fitness-instructor-music-private');
const JOURNAL_PHASES = new Set(['validated', 'paused', 'head-committed', 'verified', 'complete',
  'releasing', 'finish-release-required', 'rolled-back-verified', 'not-applied-verified',
  'not-applied-orphans-retained', 'recovery-required-paused', 'rolled-back-candidates-and-charges-retained']);
const JOURNAL_ERRORS = new Set(['private_path_escape', 'journal_permissions_required', 'journal_identity_changed',
  'reviewed_plan_hash_mismatch', 'journal_read_only', 'journal_io_failed']);
const journalError = error => new Error(JOURNAL_ERRORS.has(error?.message) ? error.message : 'journal_io_failed');

export function migrationJournalDirectory(planHash, runId = `migration-${planHash?.slice(0, 24)}`,
  directory, privateBase = PRIVATE_BASE) {
  requireFact(planHash === PLAN_SHA256, 'reviewed_plan_hash_mismatch');
  requireFact(runId === `migration-${planHash.slice(0, 24)}`
    || /^migration-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId), 'journal_identity_changed');
  for (const path of [privateBase, directory ?? resolve(privateBase, runId)]) {
    requireFact(typeof path === 'string' && isAbsolute(path) && path === resolve(path) && !path.includes('\\')
      && path !== '/mnt' && !path.startsWith('/mnt/') && path !== ROOT && !path.startsWith(`${ROOT}/`), 'private_path_escape');
  }
  const expected = resolve(privateBase, runId);
  requireFact(directory === undefined || directory === expected, 'private_path_escape');
  return expected;
}

export async function assertPrivateJournalPath(path, directory) {
  requireFact(process.platform === 'linux' && typeof process.getuid === 'function', 'journal_permissions_required');
  requireFact(isAbsolute(path) && path === resolve(path) && !path.includes('\\') && path !== '/mnt'
    && !path.startsWith('/mnt/') && path !== ROOT && !path.startsWith(`${ROOT}/`), 'private_path_escape');
  const info = await lstat(path);
  requireFact(!info.isSymbolicLink() && await realpath(path) === path
    && await realpath(dirname(path)) === dirname(path), 'private_path_escape');
  requireFact(info.uid === process.getuid() && (info.mode & 0o7777) === (directory ? 0o700 : 0o600)
    && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1), 'journal_permissions_required');
  return info;
}

function validateJournalState(state, planHash, runId) {
  requireFact(state?.schemaVersion === 1 && state.planHash === planHash && state.runId === runId
    && JOURNAL_PHASES.has(state.phase) && ['leases', 'operations', 'originals'].every(key =>
      state[key] && typeof state[key] === 'object' && !Array.isArray(state[key])), 'journal_identity_changed');
}

export async function openJournal(directory, planHash, resume = false,
  { privateBase = PRIVATE_BASE, readOnly = false, reusedReservation } = {}) {
  try {
    const runId = basename(directory);
    migrationJournalDirectory(planHash, runId, directory, privateBase);
    await assertPrivateJournalPath(privateBase, true);
    requireFact(!readOnly || resume, 'journal_read_only');
    if (!resume) await mkdir(directory, { mode: 0o700 });
    await assertPrivateJournalPath(directory, true);
    const filename = resolve(directory, 'journal.json');
    let state = { schemaVersion: 1, planHash, runId, phase: 'validated', leases: {}, operations: {}, originals: {},
      ...(reusedReservation ? { reusedReservation: structuredClone(reusedReservation) } : {}) };
    let snapshotSha256;
    if (resume) {
      const info = await assertPrivateJournalPath(filename, false);
      requireFact(info.size <= 16 * MAX_JSON, 'journal_permissions_required');
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        requireFact(opened.ino === info.ino && opened.dev === info.dev, 'journal_identity_changed');
        const bytes = await handle.readFile();
        snapshotSha256 = sha256(bytes);
        state = JSON.parse(bytes.toString('utf8'));
      } finally { await handle.close(); }
      validateJournalState(state, planHash, runId);
    }
    const persist = async value => {
      try {
        requireFact(!readOnly, 'journal_read_only');
        validateJournalState(value, planHash, runId);
        const bytes = encode(value);
        requireFact(bytes.length <= 16 * MAX_JSON, 'journal_identity_changed');
        await assertPrivateJournalPath(privateBase, true);
        await assertPrivateJournalPath(directory, true);
        try { await assertPrivateJournalPath(filename, false); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const temp = resolve(directory, `journal-${randomUUID()}.tmp`);
        const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await assertPrivateJournalPath(temp, false);
          await handle.writeFile(bytes);
          await handle.sync();
        } finally { await handle.close(); }
        await assertPrivateJournalPath(temp, false);
        await rename(temp, filename);
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
      } catch (error) { throw journalError(error); }
    };
    if (!resume) await persist(state);
    return { state, snapshotSha256: snapshotSha256 ?? sha256(encode(state)), async update(change) {
      requireFact(!readOnly, 'journal_read_only');
      const next = structuredClone(this.state);
      change(next);
      await persist(next);
      this.state = next;
    } };
  } catch (error) { throw journalError(error); }
}

export async function privateJournalReadiness(environment = {}, privateBase = PRIVATE_BASE) {
  try {
    const runId = environment.MIGRATION_RUN_ID ?? (environment.MIGRATION_JOURNAL_DIRECTORY
      ? basename(environment.MIGRATION_JOURNAL_DIRECTORY) : undefined);
    const directory = migrationJournalDirectory(PLAN_SHA256, runId, environment.MIGRATION_JOURNAL_DIRECTORY, privateBase);
    await assertPrivateJournalPath(privateBase, true);
    let exists = true;
    try { await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (exists) await openJournal(directory, PLAN_SHA256, true, { privateBase, readOnly: true });
    return { privateJournalAvailable: true, journalExists: exists, migrationRunId: basename(directory) };
  } catch (error) {
    return { privateJournalAvailable: false, blocker: journalError(error).message };
  }
}

export function migrationFailure(error, journal) {
  const phase = journal?.state?.phase;
  const codes = new Set([...JOURNAL_ERRORS, 'next_invocation_parent_approval_required', 'explicit_migration_mode_required',
    'not_applied_orphans_retained', 'recovery_required_paused', 'finish_release_required', 'storage_operation_failed', 'cloud_mutations_not_authorized']);
  return { complete: false, code: phase === 'finish-release-required' ? 'finish_release_required'
    : phase === 'recovery-required-paused' ? 'recovery_required_paused'
    : codes.has(error?.message) ? error.message : 'migration_guard_stopped',
  cloudState: journal ? JOURNAL_PHASES.has(phase) ? phase : 'unknown' : 'not_mutated',
  ...(journal?.state.runId && /^migration-(?:[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(journal.state.runId)
    ? { migrationRunId: journal.state.runId } : {}) };
}

export class ConditionalWriter {
  constructor(store, journal, barrier, allowed) {
    this.store = store; this.journal = journal; this.barrier = barrier; this.allowed = allowed;
  }

  async put(key, bytes, expected = null, label = key) {
    this.step = 'writer-scope';
    requireFact(this.allowed.has(key) && bytes.length <= CHUNK_BYTES, 'write_scope_rejected');
    this.step = 'writer-renew';
    await this.barrier.renew();
    const hash = sha256(bytes);
    let operation = this.journal.state.operations[label];
    if (operation) requireFact(operation.kind === 'put' && operation.key === key && operation.sha256 === hash
      && operation.expected === expected, 'operation_identity_changed');
    else {
      this.step = 'writer-properties';
      const existing = await this.store.properties(key);
      requireFact(expected === null ? existing === null : existing?.etag === expected, 'preexisting_object_or_conflict');
      this.step = 'writer-intent';
      await this.journal.update(state => { state.operations[label] = { kind: 'put', key, sha256: hash,
        bytes: bytes.length, expected, state: 'attempting' }; });
      operation = this.journal.state.operations[label];
    }
    this.step = 'writer-properties';
    const current = await this.store.properties(key);
    if (current && current.bytes === bytes.length && sha256(await this.store.read(key, current, CHUNK_BYTES)) === hash) {
      requireFact(!operation.etag || operation.etag === current.etag, 'acknowledged_object_changed');
      await this.journal.update(state => { Object.assign(state.operations[label], { state: 'done', etag: current.etag }); });
      this.step = undefined;
      return current.etag;
    }
    requireFact(operation.state !== 'done' && (expected === null ? !current : current?.etag === expected), 'write_conflict');
    const lease = this.journal.state.leases[key];
    const leaseId = current && lease?.state === 'held' ? lease.id : undefined;
    this.step = 'writer-put';
    try { await this.store.put(key, bytes, expected, leaseId); }
    catch { throw new Error('write_ack_unresolved_resume_required'); }
    this.step = 'writer-readback';
    const verified = await this.store.properties(key);
    requireFact(verified?.bytes === bytes.length && sha256(await this.store.read(key, verified, CHUNK_BYTES)) === hash, 'write_readback_failed');
    await this.journal.update(state => { Object.assign(state.operations[label], { state: 'done', etag: verified.etag }); });
    this.step = undefined;
    return verified.etag;
  }

  async remove(record) {
    requireFact(this.allowed.has(record.key), 'delete_scope_rejected');
    await this.barrier.renew();
    this.barrier.requireDrained();
    const label = `delete:${record.key}`;
    const prior = this.journal.state.operations[label];
    if (prior) requireFact(prior.kind === 'delete' && prior.expected === record.etag && prior.sha256 === record.sha256, 'operation_identity_changed');
    const current = await this.store.properties(record.key);
    if (!current) {
      requireFact(prior, 'unrecorded_missing_object');
    } else {
      requireFact(current.etag === record.etag && current.bytes === record.bytes
        && sha256(await this.store.read(record.key, current, CHUNK_BYTES)) === record.sha256, 'delete_content_changed');
      if (!prior) await this.journal.update(state => { state.operations[label] = { kind: 'delete', key: record.key,
        expected: record.etag, sha256: record.sha256, state: 'attempting' }; });
      try { await this.store.delete(record.key, record.etag, this.journal.state.leases[record.key]?.id); }
      catch { throw new Error('delete_ack_unresolved_resume_required'); }
      requireFact(await this.store.properties(record.key) === null, 'delete_readback_failed');
    }
    await this.journal.update(state => {
      state.operations[label].state = 'done';
      if (state.leases[record.key]) state.leases[record.key].state = 'deleted';
    });
  }
}

export async function loadPrepared(planPath, inventoryPath, { releaseOnly = false } = {}) {
  verifyPrivateIgnore();
  const directory = dirname(resolve(ROOT, planPath));
  requireFact(directory.startsWith(`${ROOT}/local-media/`) && await realpath(directory) === directory, 'private_path_escape');
  const planRaw = await readFile(await checkedPath(directory, relative(directory, resolve(ROOT, planPath))));
  requireFact(sha256(planRaw) === PLAN_SHA256, 'reviewed_plan_hash_mismatch');
  const plan = parseMetadata(planRaw);
  requireFact(plan.backup.sha256 === RESTORE_SHA256, 'restore_hash_mismatch');
  const load = async path => parseMetadata(await readFile(await checkedPath(directory, path)));
  await verifiedFile(directory, plan.backup);
  const backup = await load(plan.backup.path);
  const report = await load('prepare-report.json');
  const inventoryAbsolute = resolve(ROOT, inventoryPath);
  requireFact(inventoryAbsolute.startsWith(`${ROOT}/local-media/`) && await realpath(inventoryAbsolute) === inventoryAbsolute, 'private_path_escape');
  const inventoryRaw = await readFile(inventoryAbsolute);
  requireFact(sha256(inventoryRaw) === report.inputInventorySha256, 'inventory_hash_mismatch');
  const inventory = parseMetadata(inventoryRaw);
  requireFact(backup.complete && backup.routineId === plan.routineId && inventory.target.id === plan.routineId
    && inventory.target.headEtag === plan.expectedHeadEtag && report.complete && report.assets.length === 10
    && backup.assets.length === 10 && backup.metadata.length === 17 && backup.staging.length === 10,
  'prepared_manifest_invalid');
  const files = [plan.backup, report.plan, ...backup.metadata, ...backup.assets,
    ...backup.staging.map(item => item.backup),
    ...report.assets.flatMap(item => [{ path: item.outputPath, ...item.asset }, item.catalog]), plan.snapshot, plan.head];
  requireFact(files.length === 61, 'prepared_file_count_changed');
  for (const file of releaseOnly ? [plan.backup, report.plan, ...backup.metadata, ...backup.staging.map(item => item.backup),
    ...report.assets.map(item => item.catalog), plan.snapshot, plan.head] : files) await verifiedFile(directory, file);
  const oldHeadRecord = backup.metadata.find(item => item.key === plan.headKey);
  requireFact(oldHeadRecord?.etag === plan.expectedHeadEtag, 'head_identity_changed');
  const oldHead = await load(oldHeadRecord.path);
  const oldBody = await load(backup.metadata.find(item => item.key === oldHead.draft.key).path);
  const head = await load(plan.head.path);
  const body = await load(plan.snapshot.path);
  validateReplacement(plan, oldHead, oldBody, head, body);
  const assets = [];
  for (const mapping of plan.entryMapping) {
    const prepared = report.assets.find(item => item.asset.id === mapping.assetId);
    requireFact(prepared && prepared.complete && sameAsset(prepared.asset, body.media[mapping.entryId])
      && sameAsset(prepared.source, oldBody.media[mapping.oldEntryId]) && prepared.sourceHashUnchanged
      && prepared.volumeNormalization === false && prepared.targetBitsPerSecond === 256000
      && prepared.sampleRate === 48000 && [1, 2].includes(prepared.channels), 'prepared_asset_changed');
    const catalog = await load(prepared.catalog.path);
    requireFact(sameAsset(catalog.asset, prepared.asset), 'candidate_catalog_changed');
    describeMetadata(`assets/${mapping.assetId}/catalog`, catalog);
    const sourceRecord = backup.assets.find(item => item.id === mapping.oldAssetId);
    const oldCatalogRecord = backup.metadata.find(item => item.key === `assets/${mapping.oldAssetId}/catalog`);
    const sourceCatalog = await load(oldCatalogRecord.path);
    requireFact(sourceRecord && sameAsset(sourceCatalog.asset, prepared.source)
      && sourceRecord.sha256 === prepared.source.sha256 && sourceRecord.bytes === prepared.source.bytes,
    'backup_source_changed');
    for (const [prefix, records] of [['assets', sourceRecord.chunks], ['uploads', backup.staging.find(item => item.id === mapping.oldAssetId).chunks]]) {
      requireFact(records.length === sourceCatalog.chunks.length && records.every((item, index) =>
        item.key === `${prefix}/${mapping.oldAssetId}/chunks/${index}` && item.sha256 === sourceCatalog.chunks[index]
        && item.offset === index * CHUNK_BYTES && item.bytes === Math.min(CHUNK_BYTES, sourceRecord.bytes - item.offset)), 'retirement_chunk_map_invalid');
    }
    assets.push({ ...prepared, catalogValue: catalog, sourceCatalog, sourceRecord });
  }
  requireFact(equal(plan.retireSnapshots, backup.metadata.filter(item => item.key.startsWith('snapshots/')))
    && equal([...plan.retireAssetIds].sort(), assets.map(item => item.source.id).sort())
    && plan.quota.actualCandidatePermanentBytes === assets.reduce((sum, item) => sum + item.asset.bytes, 0)
    && plan.quota.conservativeAdditionalBytes === assets.reduce((sum, item) => sum + item.asset.bytes * 2, MAX_JSON + 10 * 131072)
    && plan.quota.refund === 0, 'retirement_or_charge_changed');
  const deletions = [...plan.retireSnapshots,
    ...backup.metadata.filter(item => item.key.startsWith('assets/')),
    ...backup.assets.flatMap(item => item.chunks),
    ...backup.staging.flatMap(item => [{ key: item.key, etag: item.etag, bytes: item.originalHeadBytes,
      sha256: item.originalHeadSha256 }, ...item.chunks])];
  requireFact(new Set(deletions.map(item => item.key)).size === deletions.length, 'duplicate_deletion_key');
  const writes = [plan.headKey, plan.snapshotKey, 'control/quota', ...assets.flatMap(item => [
    `assets/${item.asset.id}/catalog`, ...item.catalogValue.chunks.map((_, index) => `assets/${item.asset.id}/chunks/${index}`)])];
  const checks = validators();
  validateBody(describeMetadata(plan.snapshotKey, body), body, checks);
  return { directory, plan, backup, inventory, assets, oldHeadRecord, oldHead, oldBody, head, body,
    deletions, allowed: new Set([...writes, ...deletions.map(item => item.key)]), files, load, checks };
}

export async function scanState(store, bundle, journal, { releaseOnly = false, allowOldReferences = false } = {}) {
  const rows = await listAll(store);
  const documents = new Map();
  const oldIds = new Set(bundle.plan.retireAssetIds);
  const snapshots = new Set(bundle.plan.retireSnapshots.map(item => item.key));
  let bytesRead = 0;
  for (const [key, row] of rows) {
    let location;
    try { location = classify(key); }
    catch {
      requireFact(/^(assets|uploads)\/[A-Za-z0-9_-]+\/chunks\/(0|[1-9][0-9]*)$/.test(key)
        || /^uploads\/[A-Za-z0-9_-]+\/head$/.test(key)
        || /^(sessions|throttle|throttles|traffic|keys)\/[A-Za-z0-9_-]+$/.test(key)
        || key === 'control/quota', 'unknown_blob_prefix');
      continue;
    }
    requireFact(documents.size < 4096 && row.bytes <= MAX_JSON, 'metadata_limit');
    const raw = await store.read(key, row, MAX_JSON);
    bytesRead += raw.length;
    requireFact(bytesRead <= 64 * MAX_JSON, 'metadata_total_limit');
    const value = parseMetadata(raw);
    const description = describeMetadata(key, value);
    validateBody(description, value, bundle.checks);
    requireFact(releaseOnly || !description.pins.some(pin => pin.kind === 'routine' && pin.id === bundle.plan.routineId), 'target_class_pin_found');
    for (const ref of description.refs) if (!allowOldReferences && oldIds.has(ref.asset.id)) {
      requireFact(snapshots.has(key)
        && ref.role === 'song' && sameAsset(ref.asset, bundle.assets.find(item => item.source.id === ref.asset.id)?.source),
      'old_asset_reference_found');
    }
    documents.set(key, { ...description, ...row, raw, value, sha256: sha256(raw) });
  }
  for (const doc of documents.values()) if (doc.type === 'head') {
    for (const pointer of [doc.value.draft, doc.value.published].filter(Boolean)) {
      const snapshot = documents.get(pointer.key);
      requireFact(snapshot?.revision === pointer.revision && snapshot.entity.name === pointer.name
        && snapshot.entity.locked === pointer.locked, 'head_snapshot_mismatch');
    }
    for (const link of doc.value.history ?? []) for (const variant of ['draft', 'published']) if (link[variant]) {
      requireFact(documents.get(link[variant])?.revision === link.revision, 'history_snapshot_missing');
    }
  }
  const scopeIds = new Set([...oldIds, ...bundle.assets.map(item => item.asset.id)]);
  for (const key of rows.keys()) {
    const parts = key.split('/');
    if (['assets', 'uploads'].includes(parts[0]) && scopeIds.has(parts[1])) {
      requireFact(bundle.allowed.has(key), 'unexpected_target_blob');
    }
  }
  if (journal?.state.baseline) for (const [key, original] of Object.entries(journal.state.baseline)) {
    if (bundle.allowed.has(key)) continue;
    requireFact(documents.get(key)?.etag === original.etag && documents.get(key)?.sha256 === original.sha256, 'reference_metadata_changed');
  }
  if (journal?.state.baseline) for (const [key] of documents) {
    requireFact(Object.hasOwn(journal.state.baseline, key) || bundle.allowed.has(key), 'new_reference_metadata_found');
  }
  return { rows, documents };
}

export async function verifyCloudRecord(store, record) {
  const current = await store.properties(record.key);
  requireFact(current?.etag === record.etag && current.bytes === record.bytes, 'cloud_record_changed');
  const raw = await store.read(record.key, current, Math.max(record.bytes, MAX_JSON));
  requireFact(sha256(raw) === record.sha256, 'cloud_record_hash_changed');
  return raw;
}

async function verifySources(store, bundle, rows, journal) {
  for (const item of bundle.backup.metadata) {
    if (item.key !== 'control/quota' || !journal?.state.reusedReservation) await verifyCloudRecord(store, item);
  }
  for (const item of bundle.assets) {
    await downloadAsset(store, rows, item.sourceCatalog, undefined, 'assets');
    await downloadAsset(store, rows, item.sourceCatalog, undefined, 'uploads');
  }
}

export async function candidateReadbackDirectory(directory) {
  verifyPrivateIgnore();
  requireFact(typeof directory === 'string' && directory.startsWith(`${ROOT}/local-media/`)
    && directory === resolve(directory) && await realpath(directory) === directory
    && await realpath(dirname(directory)) === dirname(directory) && (await lstat(directory)).isDirectory(), 'private_path_escape');
  const workDirectory = resolve(directory, 'apply-verification');
  try { await mkdir(workDirectory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  requireFact(await realpath(workDirectory) === workDirectory && (await lstat(workDirectory)).isDirectory()
    && !(await lstat(workDirectory)).isSymbolicLink(), 'private_path_escape');
  return workDirectory;
}

export async function stageCandidates(store, bundle, writer) {
  const workDirectory = await candidateReadbackDirectory(bundle.directory);
  const { chromium } = createRequire(resolve(ROOT, 'package.json'))('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const item of bundle.assets) {
      const path = await verifiedFile(bundle.directory, { path: item.outputPath, ...item.asset });
      const handle = await open(path, 'r');
      try {
        for (const [index, hash] of item.catalogValue.chunks.entries()) {
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, item.asset.bytes - index * CHUNK_BYTES));
          requireFact((await handle.read(bytes, 0, bytes.length, index * CHUNK_BYTES)).bytesRead === bytes.length
            && sha256(bytes) === hash, 'candidate_chunk_changed');
          await writer.put(`assets/${item.asset.id}/chunks/${index}`, bytes);
        }
      } finally { await handle.close(); }
      await writer.put(`assets/${item.asset.id}/catalog`, await readFile(await verifiedFile(bundle.directory, item.catalog)));
      const rows = await listAll(store);
      requireFact(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.asset.id), 'private_path_escape');
      const retrieval = resolve(workDirectory, `${item.asset.id}.m4a`);
      try {
        await lstat(retrieval);
        await verifiedFile(workDirectory, { path: `${item.asset.id}.m4a`, ...item.asset });
        await unlink(retrieval);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await downloadAsset(store, rows, item.catalogValue, retrieval, 'assets');
      const metadata = await probe(retrieval);
      const audio = metadata.streams?.[0];
      requireFact(metadata.streams.length === 1 && audio.codec_name === 'aac' && audio.profile === 'LC'
        && audio.channels === item.channels && Number(audio.sample_rate) === 48000 && Number(audio.start_time) === 0, 'cloud_aac_invalid');
      const decoded = await browserDecode(browser, retrieval, item.asset);
      verifyTimeline(item.timeline.sourceFrames, await decodedFrames(retrieval, item.channels), Number(audio.duration), decoded.duration);
      requireFact(decoded.channels === item.channels, 'cloud_channels_changed');
      await unlink(retrieval);
    }
  } finally { await browser.close(); }
}

function forwardPutExpectation(bundle, journal, label, operation) {
  let desired;
  let preimage = null;
  if (label === bundle.plan.headKey) {
    desired = bundle.plan.head;
    preimage = bundle.oldHeadRecord;
    requireFact(preimage.etag === bundle.plan.expectedHeadEtag, 'operation_identity_changed');
  } else if (label === 'control/quota') {
    const reservation = journal.state.reservation;
    requireFact(reservation && reservation.expected === journal.state.leases[label]?.etag, 'operation_identity_changed');
    const before = Buffer.from(reservation.before, 'base64');
    const after = Buffer.from(reservation.after, 'base64');
    requireFact(before.length <= MAX_JSON && after.equals(encode(reserveQuota(parseMetadata(before),
      bundle.plan.quota.conservativeAdditionalBytes, 10))), 'operation_identity_changed');
    desired = { bytes: after.length, sha256: sha256(after) };
    preimage = { etag: reservation.expected, bytes: before.length, sha256: sha256(before) };
  } else if (label === bundle.plan.snapshotKey) desired = bundle.plan.snapshot;
  else for (const item of bundle.assets) {
    if (label === `assets/${item.asset.id}/catalog`) desired = item.catalog;
    for (const [index, hash] of item.catalogValue.chunks.entries()) {
      if (label === `assets/${item.asset.id}/chunks/${index}`) desired = {
        bytes: Math.min(CHUNK_BYTES, item.asset.bytes - index * CHUNK_BYTES), sha256: hash };
    }
  }
  requireFact(desired && bundle.allowed.has(label) && operation.kind === 'put' && operation.key === label
    && operation.expected === (preimage?.etag ?? null) && operation.sha256 === desired.sha256
    && operation.bytes === desired.bytes && desired.bytes > 0 && desired.bytes <= CHUNK_BYTES, 'operation_identity_changed');
  return preimage;
}

function rollbackPutProof(bundle, journal, label, operation) {
  const preimage = forwardPutExpectation(bundle, journal, label, operation);
  if (operation.state === 'not-applied') {
    requireFact(!operation.etag, 'operations_unresolved');
    return preimage ? { kind: 'preimage', etag: preimage.etag, bytes: preimage.bytes, sha256: preimage.sha256 }
      : { kind: 'absent', etag: null };
  }
  const restore = journal.state.operations['restore:head'];
  requireFact(operation.state === 'reverted' && label === bundle.plan.headKey && restore?.state === 'done'
    && restore.kind === 'put' && restore.key === label && restore.expected === operation.etag
    && typeof operation.etag === 'string' && typeof restore.etag === 'string'
    && restore.sha256 === bundle.oldHeadRecord.sha256 && restore.bytes === bundle.oldHeadRecord.bytes,
  'operations_unresolved');
  return { kind: 'restore', label: 'restore:head', etag: restore.etag,
    bytes: bundle.oldHeadRecord.bytes, sha256: bundle.oldHeadRecord.sha256 };
}

function verifyTerminalOperations(journal, bundle, outcome) {
  for (const [label, operation] of Object.entries(journal.state.operations)) {
    if (operation.state === 'done') continue;
    requireFact(outcome === 'rolled-back' && journal.state.rollbackStarted
      && ['not-applied', 'reverted'].includes(operation.state)
      && equal(operation.proof, rollbackPutProof(bundle, journal, label, operation)), 'operations_unresolved');
  }
}

async function reconcileForwardPuts(store, bundle, journal, barrier, fault) {
  for (const [label, operation] of Object.entries(journal.state.operations)) {
    if (operation.kind !== 'put' || label.startsWith('restore:')) continue;
    const preimage = forwardPutExpectation(bundle, journal, label, operation);
    requireFact(['attempting', 'done', 'not-applied', 'reverted'].includes(operation.state), 'operations_unresolved');
    await barrier.renew();
    const current = await store.properties(label);
    requireFact(!preimage || current?.leaseState === 'leased' && journal.state.leases[label]?.state === 'held',
      'forward_put_lease_unproven');
    requireFact(!current || current.bytes <= CHUNK_BYTES, 'forward_put_conflict');
    const raw = current && await store.read(label, current, CHUNK_BYTES);
    const matches = record => current && current.bytes === record.bytes && raw.length === record.bytes && sha256(raw) === record.sha256;
    let state;
    let proof;
    if (['attempting', 'done'].includes(operation.state) && matches(operation)) {
      requireFact(!operation.etag || operation.etag === current.etag, 'forward_put_conflict');
      state = 'done';
    } else if (label === bundle.plan.headKey && journal.state.operations['restore:head']?.state === 'done') {
      state = 'reverted';
      proof = rollbackPutProof(bundle, journal, label, { ...operation, state });
      requireFact(current?.etag === proof.etag && matches(proof), 'forward_put_conflict');
    } else {
      requireFact(['attempting', 'not-applied'].includes(operation.state) && !operation.etag
        && (preimage ? current?.etag === preimage.etag && matches(preimage) : current === null), 'forward_put_conflict');
      state = 'not-applied';
      proof = rollbackPutProof(bundle, journal, label, { ...operation, state });
    }
    if (operation.state === state) {
      requireFact(state === 'done' || equal(operation.proof, proof), 'operations_unresolved');
      continue;
    }
    await journal.update(value => { Object.assign(value.operations[label], { state,
      ...(state === 'done' ? { etag: current.etag } : { proof }) }); });
    await fault('after-forward-put-reconcile', label);
  }
}

async function recordConsistentOutcome(journal, bundle, outcome, result) {
  verifyTerminalOperations(journal, bundle, outcome);
  await journal.update(state => {
    state.consistentOutcome = outcome;
    state.consistency = { planHash: PLAN_SHA256, restoreHash: RESTORE_SHA256,
      operationsHash: sha256(encode(state.operations)), headHash: outcome === 'migrated' ? bundle.plan.head.sha256 : bundle.oldHeadRecord.sha256,
      result };
    state.phase = outcome === 'migrated' ? 'verified' : outcome === 'rolled-back' ? 'rolled-back-verified' : 'not-applied-verified';
  });
}

export async function finishRelease({ store, bundle, journal, barrier }) {
  try {
    const { consistentOutcome: outcome, consistency: proof, operations } = journal.state;
    verifyTerminalOperations(journal, bundle, outcome);
    requireFact(['migrated', 'rolled-back', 'not-applied'].includes(outcome)
      && proof?.planHash === PLAN_SHA256 && proof.restoreHash === RESTORE_SHA256
      && proof.operationsHash === sha256(encode(operations))
      && proof.headHash === (outcome === 'migrated' ? bundle.plan.head.sha256 : bundle.oldHeadRecord.sha256), 'release_consistency_unproven');
    requireFact(outcome === 'not-applied' || GLOBAL_KEYS.every(key => journal.state.leases[key]), 'release_global_barrier_missing');
    await barrier.checkRelease(Object.keys(journal.state.leases));
    const admissionOpened = GLOBAL_KEYS.some(key => ['releasing', 'released'].includes(journal.state.leases[key]?.state));
    const current = await scanState(store, bundle, admissionOpened || outcome === 'not-applied' ? undefined : journal,
      { releaseOnly: true, allowOldReferences: outcome !== 'migrated' });
    const head = current.documents.get(bundle.plan.headKey);
    requireFact(head && (admissionOpened ? head.value.draft.revision >= (outcome === 'migrated' ? 6 : 5)
      : head.sha256 === proof.headHash && head.etag === (outcome === 'migrated' ? operations[bundle.plan.headKey]?.etag
        : operations['restore:head']?.etag ?? bundle.oldHeadRecord.etag)), 'release_head_inconsistent');
    if (outcome === 'migrated') {
      for (const record of bundle.deletions) requireFact(operations[`delete:${record.key}`]?.state === 'done'
        && !current.rows.has(record.key), 'release_retirement_incomplete');
      await verifyCloudRecord(store, { key: bundle.plan.snapshotKey, ...bundle.plan.snapshot, etag: operations[bundle.plan.snapshotKey]?.etag });
      for (const item of bundle.assets) {
        const catalogKey = `assets/${item.asset.id}/catalog`;
        requireFact(current.documents.get(catalogKey)?.sha256 === operations[catalogKey]?.sha256, 'release_candidate_changed');
        for (const [index] of item.catalogValue.chunks.entries()) {
          const key = `assets/${item.asset.id}/chunks/${index}`;
          const row = current.rows.get(key);
          requireFact(row && row.etag === operations[key]?.etag && row.bytes === operations[key]?.bytes, 'release_candidate_changed');
        }
      }
    } else if (!admissionOpened) {
      for (const record of bundle.deletions) {
        const row = current.rows.get(record.key);
        requireFact(row && row.etag === (operations[`restore:${record.key}`]?.etag ?? record.etag)
          && row.bytes === record.bytes, 'release_restore_incomplete');
      }
    }
    await journal.update(state => { state.phase = 'releasing'; });
    await barrier.releaseAll();
    await journal.update(state => { state.phase = outcome === 'migrated' ? 'complete' : outcome === 'rolled-back'
      ? 'rolled-back-candidates-and-charges-retained' : 'not-applied-orphans-retained'; });
    return proof.result;
  } catch {
    await journal.update(state => { state.phase = 'finish-release-required'; });
    throw new Error('finish_release_required');
  }
}

function restoredLease(record, etag) {
  if (!record) return undefined;
  if (record.state === 'deleted') return { id: randomUUID(), etag, state: 'attempting' };
  requireFact(['held', 'attempting'].includes(record.state), 'restore_lease_state_invalid');
  return { ...record, etag };
}

export async function reconcileRestores(store, bundle, journal) {
  const records = new Map(bundle.deletions.map(record => [record.key, record]));
  for (const [label, operation] of Object.entries(journal.state.operations)) {
    if (!label.startsWith('restore:')) continue;
    const head = label === 'restore:head';
    const record = head ? bundle.oldHeadRecord : records.get(operation.key);
    const previous = journal.state.operations[head ? bundle.plan.headKey : `delete:${operation.key}`];
    requireFact(record && operation.key === record.key && (head || label === `restore:${record.key}`)
      && operation.kind === 'put' && operation.sha256 === record.sha256 && operation.bytes === record.bytes
      && record.bytes <= CHUNK_BYTES && ['attempting', 'done'].includes(operation.state)
      && (operation.state !== 'done' || typeof operation.etag === 'string')
      && previous?.key === record.key && previous.expected === record.etag
      && (head ? previous.kind === 'put' && previous.sha256 === bundle.plan.head.sha256
        && previous.etag === operation.expected : previous.kind === 'delete' && previous.sha256 === record.sha256
        && operation.expected === null), 'restore_attempt_identity_changed');
    const current = await store.properties(record.key);
    if (!current) {
      requireFact(!head && operation.state === 'attempting', 'acknowledged_restore_missing');
      continue;
    }
    requireFact(current.bytes <= CHUNK_BYTES, 'restore_content_changed');
    const raw = await store.read(record.key, current, CHUNK_BYTES);
    if (head && operation.state === 'attempting' && current.etag === operation.expected
      && current.bytes === bundle.plan.head.bytes && sha256(raw) === bundle.plan.head.sha256) continue;
    requireFact(current.bytes === record.bytes && raw.length === record.bytes && sha256(raw) === record.sha256,
      'restore_content_changed');
    requireFact(!operation.etag || operation.etag === current.etag, 'acknowledged_restore_changed');
    await journal.update(state => {
      Object.assign(state.operations[label], { state: 'done', etag: current.etag });
      if (!head) state.operations[`delete:${record.key}`].state = 'done';
      const lease = restoredLease(state.leases[record.key], current.etag);
      if (lease) state.leases[record.key] = lease;
    });
  }
}

async function verifyReusedReservation(store, bundle, journal) {
  const credit = journal.state.reusedReservation;
  requireFact(credit && credit.priorPlanHash === PLAN_SHA256 && credit.priorHelperSha256 === RETRY_PRIOR_HELPER_SHA256
    && credit.priorRunId !== journal.state.runId
    && [credit.priorJournalSha256, credit.previousReceiptSha256, credit.operationsHash].every(value => /^[a-f0-9]{64}$/.test(value))
    && !journal.state.reservation && !journal.state.operations['control/quota'], 'retry_reservation_unproven');
  migrationJournalDirectory(PLAN_SHA256, credit.priorRunId);
  const before = Buffer.from(credit.before, 'base64');
  const after = Buffer.from(credit.after, 'base64');
  requireFact(after.length <= MAX_JSON && before.length <= MAX_JSON
    && after.equals(encode(reserveQuota(parseMetadata(before), bundle.plan.quota.conservativeAdditionalBytes, 10)))
    && credit.bytes === after.length && credit.sha256 === sha256(after), 'retry_reservation_unproven');
  const current = await store.properties('control/quota');
  requireFact(current?.etag === credit.expected && current.bytes === credit.bytes, 'retry_quota_changed');
  const raw = await store.read('control/quota', current, MAX_JSON);
  requireFact(raw.equals(after), 'retry_quota_changed');
}

export async function prepareRetry(store, bundle, prior, receipt, approval) {
  const state = prior.state;
  const proof = state.consistency;
  requireFact(approval.priorHelperSha256 === RETRY_PRIOR_HELPER_SHA256
    && state.review?.helperHash === RETRY_PRIOR_HELPER_SHA256
    && receipt.helperSha256 === RETRY_PRIOR_HELPER_SHA256
    && prior.snapshotSha256 === approval.priorJournalSha256
    && sha256(approval.receiptRaw) === approval.previousReceiptSha256
    && equal(parseMetadata(approval.receiptRaw), receipt), 'retry_prior_approval_mismatch');
  requireFact(state.planHash === PLAN_SHA256 && state.phase === 'not-applied-orphans-retained'
    && state.consistentOutcome === 'not-applied' && !state.rollbackStarted && !state.reusedReservation
    && proof?.planHash === PLAN_SHA256 && proof.restoreHash === RESTORE_SHA256
    && proof.headHash === bundle.oldHeadRecord.sha256 && proof.operationsHash === sha256(encode(state.operations))
    && proof.result?.applied === false && proof.result.quotaRefund === 0,
  'retry_prior_outcome_unproven');
  const leases = Object.values(state.leases);
  requireFact(leases.length > 0 && leases.every(lease => lease.state === 'released')
    && [...GLOBAL_KEYS, 'control/quota', bundle.plan.headKey].every(key => state.leases[key]?.state === 'released'),
  'retry_prior_leases_unreleased');
  requireFact(receipt.complete === true && receipt.applied === false && receipt.consistentOutcome === 'not-applied'
    && receipt.planSha256 === PLAN_SHA256 && receipt.restoreManifestSha256 === RESTORE_SHA256
    && receipt.revision === 5 && receipt.allLeasesResolved === true && receipt.leases?.released === leases.length
    && receipt.leases.total === leases.length && receipt.leases.deleted === 0
    && receipt.candidateCatalogsVerified === 0 && receipt.candidateChunksVerified === 0
    && receipt.quotaAdditionalBytes === bundle.plan.quota.conservativeAdditionalBytes && receipt.quotaRefund === 0,
  'retry_receipt_unproven');
  const operation = state.operations['control/quota'];
  requireFact(Object.keys(state.operations).length === 1 && operation?.state === 'done' && typeof operation.etag === 'string',
    'retry_only_reservation_supported');
  forwardPutExpectation(bundle, prior, 'control/quota', operation);
  const credit = { priorRunId: state.runId, priorPlanHash: PLAN_SHA256, priorHelperSha256: RETRY_PRIOR_HELPER_SHA256,
    priorJournalSha256: prior.snapshotSha256, previousReceiptSha256: approval.previousReceiptSha256,
    operationsHash: proof.operationsHash, expected: operation.etag, originalExpected: state.reservation.expected,
    before: state.reservation.before, after: state.reservation.after, bytes: operation.bytes, sha256: operation.sha256 };
  await verifyReusedReservation(store, bundle, { state: { runId: 'new-attempt', operations: {}, reusedReservation: credit } });
  const scan = await scanState(store, bundle, prior);
  const head = scan.documents.get(bundle.plan.headKey);
  requireFact(head?.etag === bundle.plan.expectedHeadEtag && head.sha256 === bundle.oldHeadRecord.sha256, 'retry_old_head_changed');
  for (const record of bundle.deletions) requireFact(scan.rows.get(record.key)?.etag === record.etag
    && scan.rows.get(record.key)?.bytes === record.bytes, 'retry_old_object_changed');
  for (const record of bundle.backup.metadata) if (record.key !== 'control/quota') await verifyCloudRecord(store, record);
  const candidates = [bundle.plan.snapshotKey, ...bundle.assets.flatMap(item => [`assets/${item.asset.id}/catalog`,
    ...item.catalogValue.chunks.map((_, index) => `assets/${item.asset.id}/chunks/${index}`)])];
  for (const key of candidates) requireFact(!scan.rows.has(key) && await store.properties(key) === null, 'retry_candidate_collision');
  for (const key of Object.keys(state.leases)) requireFact((await store.properties(key))?.leaseState === 'available',
    'retry_current_lease_unavailable');
  return credit;
}

export async function runMigration({ store, bundle, journal, mode = 'apply', clock,
  verifyCandidates = stageCandidates, verifyOriginals = verifySources, fault = async () => {} }) {
  requireFact(['apply', 'resume', 'rollback', 'finish-release'].includes(mode), 'invalid_migration_mode');
  const barrier = new LeaseBarrier(store, journal, clock);
  if (journal.state.consistentOutcome || mode === 'finish-release') return finishRelease({ store, bundle, journal, barrier });
  if (journal.state.reusedReservation) await verifyReusedReservation(store, bundle, journal);
  if (journal.state.rollbackStarted) mode = 'rollback';
  if (mode === 'rollback') {
    await journal.update(state => { state.rollbackStarted = true; });
    await reconcileRestores(store, bundle, journal);
  }
  const writer = new ConditionalWriter(store, journal, barrier, bundle.allowed);
  const plan = bundle.plan;
  const initial = await scanState(store, bundle, journal.state.baseline ? journal : undefined);
  const actualHead = initial.documents.get(plan.headKey);
  const casOperation = journal.state.operations[plan.headKey];
  const restoreOperation = journal.state.operations['restore:head'];
  requireFact(actualHead && (actualHead.etag === plan.expectedHeadEtag && actualHead.sha256 === bundle.oldHeadRecord.sha256
    || casOperation && actualHead.sha256 === plan.head.sha256
      && (!casOperation.etag || casOperation.etag === actualHead.etag)
    || mode === 'rollback' && restoreOperation && actualHead.sha256 === bundle.oldHeadRecord.sha256
      && (!restoreOperation.etag || restoreOperation.etag === actualHead.etag)), 'target_user_edit_guard_stop');
  for (const record of bundle.deletions) {
    if (journal.state.operations[`delete:${record.key}`]) continue;
    const row = initial.rows.get(record.key);
    requireFact(row?.etag === record.etag && row.bytes === record.bytes, 'recorded_retirement_object_changed');
  }
  for (const key of GLOBAL_KEYS) {
    const row = initial.rows.get(key);
    requireFact(row, 'global_bucket_missing_stop_before_pause');
    validateBucket(parseMetadata(await store.read(key, row, MAX_JSON)));
  }
  if (!journal.state.baseline) await journal.update(state => {
    state.baseline = Object.fromEntries([...initial.documents].map(([key, doc]) => [key, { etag: doc.etag, sha256: doc.sha256 }]));
  });
  let step = 'acquiring';
  try {
    const quota = journal.state.leases['control/quota']?.etag ?? initial.rows.get('control/quota')?.etag;
    requireFact(quota, 'quota_missing');
    await barrier.acquire('control/quota', quota);
    for (const key of GLOBAL_KEYS) {
      const current = await store.properties(key);
      requireFact(current, 'global_bucket_missing_stop_before_pause');
      validateBucket(parseMetadata(await store.read(key, current, MAX_JSON)));
      await barrier.acquire(key, journal.state.leases[key]?.etag ?? current.etag);
    }
    await journal.update(state => { state.phase = 'paused'; });
    const heads = [...initial.documents.values()].filter(doc => ['head', 'filler'].includes(doc.type)
      || doc.type === 'catalog' && plan.retireAssetIds.includes(doc.id)).map(doc => ({ key: doc.key, etag: doc.etag }));
    const uploadHeads = bundle.backup.staging.map(item => ({ key: item.key,
      etag: journal.state.operations[`restore:${item.key}`]?.etag ?? item.etag }));
    requireFact(heads.length + uploadHeads.length + 9 <= 128, 'metadata_lease_limit');
    for (const { key, etag } of [...heads, ...uploadHeads]) {
      if (journal.state.operations[`delete:${key}`] && await store.properties(key) === null) {
        await journal.update(state => { if (state.leases[key]) state.leases[key].state = 'deleted'; });
        continue;
      }
      await barrier.acquire(key, journal.state.leases[key]?.etag ?? etag);
    }
    await barrier.renew();
    if (!journal.state.originalHeads) await journal.update(state => {
      state.originalHeads = Object.fromEntries(heads.map(({ key }) => {
        const doc = initial.documents.get(key);
        return [key, { etag: doc.etag, sha256: doc.sha256, bytes: doc.bytes, base64: doc.raw.toString('base64') }];
      }));
    });
    for (const item of bundle.backup.staging) if (!journal.state.originals[item.key]) {
      const record = { key: item.key, etag: item.etag, bytes: item.originalHeadBytes, sha256: item.originalHeadSha256 };
      const raw = await verifyCloudRecord(store, record);
      inspectUpload(parseMetadata(raw), bundle.assets.find(asset => asset.source.id === item.id).sourceCatalog);
      const properties = await store.properties(item.key);
      requireFact(Number.isFinite(properties.modified) && properties.modified + 7 * 86400000 - Date.now() >= 86400000,
        'staging_lifecycle_horizon_too_short');
      await journal.update(state => { state.originals[item.key] = { ...record, base64: raw.toString('base64') }; });
    }
    if (mode === 'rollback') return await rollbackMigration({ store, bundle, journal, barrier, writer, fault });
    step = 'source-verification';
    if (!casOperation) {
      await verifyOriginals(store, bundle, (await scanState(store, bundle, journal)).rows, journal);
      for (const file of bundle.files) await verifiedFile(bundle.directory, file);
    }
    step = 'reservation';
    if (!journal.state.reservation && !journal.state.reusedReservation) {
      const row = await store.properties('control/quota');
      requireFact(row?.etag === quota, 'quota_changed_under_lease');
      const raw = await store.read('control/quota', row, MAX_JSON);
      const reserved = reserveQuota(parseMetadata(raw), plan.quota.conservativeAdditionalBytes, 10);
      await journal.update(state => { state.reservation = { expected: row.etag, before: raw.toString('base64'),
        after: encode(reserved).toString('base64') }; });
    }
    if (journal.state.reusedReservation) await verifyReusedReservation(store, bundle, journal);
    else await writer.put('control/quota', Buffer.from(journal.state.reservation.after, 'base64'), journal.state.reservation.expected);
    writer.step = undefined;
    step = 'before-first-candidate';
    await fault('after-reservation');
    step = 'candidate-staging';
    await verifyCandidates(store, bundle, writer);
    writer.step = undefined;
    step = 'candidate-verification';
    await scanState(store, bundle, journal);
    barrier.requireDrained();
    await barrier.renew();
    step = 'snapshot';
    await writer.put(plan.snapshotKey, await readFile(await verifiedFile(bundle.directory, plan.snapshot)));
    await fault('before-cas');
    step = 'head-cas';
    await writer.put(plan.headKey, await readFile(await verifiedFile(bundle.directory, plan.head)), plan.expectedHeadEtag);
    await journal.update(state => { state.phase = 'head-committed'; });
    await fault('after-cas');
    await verifyCloudRecord(store, { key: plan.headKey, ...plan.head, etag: journal.state.operations[plan.headKey].etag });
    await verifyCloudRecord(store, { key: plan.snapshotKey, ...plan.snapshot, etag: journal.state.operations[plan.snapshotKey].etag });
    await scanState(store, bundle, journal);
    writer.step = undefined;
    step = 'retirement';
    for (const item of bundle.backup.staging) await writer.remove(journal.state.originals[item.key]);
    for (const item of plan.retireSnapshots) { await writer.remove(item); await fault('during-retirement'); }
    await scanState(store, bundle, journal);
    const removedHeads = new Set([...plan.retireSnapshots.map(item => item.key), ...bundle.backup.staging.map(item => item.key)]);
    for (const item of bundle.deletions.filter(item => !removedHeads.has(item.key))) await writer.remove(item);
    const final = await scanState(store, bundle, journal);
    requireFact(bundle.deletions.every(item => !final.rows.has(item.key)), 'retirement_incomplete');
    for (const item of bundle.assets) await downloadAsset(store, final.rows, item.catalogValue, undefined, 'assets');
    await recordConsistentOutcome(journal, bundle, 'migrated', { applied: true, revision: 6, published: false,
      removedPayloadBytes: bundle.backup.assets.reduce((sum, item) => sum + item.bytes * 2, 0),
      candidateBytes: plan.quota.actualCandidatePermanentBytes, quotaRefund: 0 });
    step = 'release';
    return await finishRelease({ store, bundle, journal, barrier });
  } catch (error) {
    const failure = diagnosticFailure(error, writer.step ?? step);
    await journal.update(state => { state.failure = { ...failure, beforeFirstCandidate:
      !bundle.assets.some(item => Object.values(state.operations).some(operation =>
        operation.key.startsWith(`assets/${item.asset.id}/`))) }; });
    if (journal.state.consistentOutcome) {
      await journal.update(state => { state.phase = 'finish-release-required'; });
      throw new Error('finish_release_required');
    }
    const touchedHead = journal.state.operations[plan.headKey];
    const ambiguous = Object.values(journal.state.operations).some(item => item.state !== 'done');
    const retired = Object.values(journal.state.operations).some(item => item.kind === 'delete');
    let released = false;
    if (!journal.state.rollbackStarted && !touchedHead && !ambiguous && !retired) {
      try {
        await verifyCloudRecord(store, bundle.oldHeadRecord);
        await recordConsistentOutcome(journal, bundle, 'not-applied', { applied: false, quotaRefund: 0, candidatesRetained: true });
        await finishRelease({ store, bundle, journal, barrier });
        released = true;
      } catch { }
    }
    if (!released && journal.state.consistentOutcome) throw new Error('finish_release_required');
    await journal.update(state => { state.phase = released ? 'not-applied-orphans-retained' : 'recovery-required-paused'; });
    throw new Error(released ? 'not_applied_orphans_retained' : 'recovery_required_paused');
  }
}

export async function rollbackMigration({ store, bundle, journal, barrier, writer, fault = async () => {} }) {
  requireFact(!Object.values(journal.state.leases).some(item => ['releasing', 'released'].includes(item.state)), 'rollback_requires_held_barrier');
  await reconcileForwardPuts(store, bundle, journal, barrier, fault);
  const restore = async (record, bytes) => {
    const etag = await writer.put(record.key, bytes, null, `restore:${record.key}`);
    await journal.update(state => {
      state.operations[`delete:${record.key}`].state = 'done';
      const lease = restoredLease(state.leases[record.key], etag);
      if (lease) state.leases[record.key] = lease;
    });
    if (journal.state.leases[record.key]) await barrier.acquire(record.key, etag);
    await fault('after-restore', record.key);
  };
  for (const item of bundle.assets) {
    const handle = await open(await verifiedFile(bundle.directory, item.sourceRecord), 'r');
    try {
      for (const record of [...item.sourceRecord.chunks, ...bundle.backup.staging.find(value => value.id === item.source.id).chunks]) {
        const current = await store.properties(record.key);
        if (current) {
          const restored = journal.state.operations[`restore:${record.key}`];
          await verifyCloudRecord(store, { ...record, etag: restored?.etag ?? record.etag });
          continue;
        }
        requireFact(journal.state.operations[`delete:${record.key}`], 'rollback_unrecorded_loss');
        const bytes = Buffer.alloc(record.bytes);
        requireFact((await handle.read(bytes, 0, bytes.length, record.offset)).bytesRead === record.bytes
          && sha256(bytes) === record.sha256, 'restore_chunk_hash_failed');
        await restore(record, bytes);
      }
    } finally { await handle.close(); }
  }
  for (const record of [...bundle.backup.metadata.filter(item => item.key !== bundle.plan.headKey && item.key !== 'control/quota'),
    ...Object.values(journal.state.originals)]) {
    const current = await store.properties(record.key);
    if (current) {
      const restored = journal.state.operations[`restore:${record.key}`];
      await verifyCloudRecord(store, { ...record, etag: restored?.etag ?? record.etag });
      continue;
    }
    requireFact(journal.state.operations[`delete:${record.key}`], 'rollback_unrecorded_loss');
    const bytes = record.base64 ? Buffer.from(record.base64, 'base64') : await readFile(await verifiedFile(bundle.directory, record));
    requireFact(sha256(bytes) === record.sha256, 'restore_metadata_hash_failed');
    await restore(record, bytes);
  }
  const rows = await listAll(store);
  for (const item of bundle.assets) {
    await downloadAsset(store, rows, item.sourceCatalog, undefined, 'assets');
    await downloadAsset(store, rows, item.sourceCatalog, undefined, 'uploads');
  }
  barrier.requireDrained();
  const current = await store.properties(bundle.plan.headKey);
  const restoredHead = journal.state.operations['restore:head'];
  if (restoredHead && current && sha256(await store.read(bundle.plan.headKey, current, MAX_JSON)) === bundle.oldHeadRecord.sha256) {
    await writer.put(bundle.plan.headKey, await readFile(await verifiedFile(bundle.directory, bundle.oldHeadRecord)),
      restoredHead.expected, 'restore:head');
  } else if (current?.etag !== bundle.plan.expectedHeadEtag) {
    requireFact(current?.etag === journal.state.operations[bundle.plan.headKey]?.etag
      && sha256(await store.read(bundle.plan.headKey, current, MAX_JSON)) === bundle.plan.head.sha256, 'rollback_head_conflict');
    await writer.put(bundle.plan.headKey, await readFile(await verifiedFile(bundle.directory, bundle.oldHeadRecord)), current.etag, 'restore:head');
  } else await verifyCloudRecord(store, bundle.oldHeadRecord);
  const verifiedHead = await store.properties(bundle.plan.headKey);
  requireFact(verifiedHead && sha256(await store.read(bundle.plan.headKey, verifiedHead, MAX_JSON)) === bundle.oldHeadRecord.sha256,
    'restored_head_readback_failed');
  await fault('after-restore', bundle.plan.headKey);
  await scanState(store, bundle, journal);
  await reconcileForwardPuts(store, bundle, journal, barrier, fault);
  await journal.update(state => {
    for (const operation of Object.values(state.operations)) if (operation.kind === 'delete' && operation.state === 'attempting') {
      operation.state = 'done';
      operation.rolledBack = true;
    }
  });
  await recordConsistentOutcome(journal, bundle, 'rolled-back', { applied: false, rolledBack: true, quotaRefund: 0, candidatesRetained: true });
  return finishRelease({ store, bundle, journal, barrier });
}

export function requestedApplyMode(args, environment, helperHash) {
  requireFact(args.length === 1 && ['--dry-run', '--journal-check', '--apply-approved', '--retry-prepared', '--resume', '--rollback', '--finish-release'].includes(args[0]), 'explicit_migration_mode_required');
  if (args[0] === '--dry-run') return 'dry-run';
  if (args[0] === '--journal-check') return 'journal-check';
  requireFact(environment.REVIEWED_MIGRATION_APPLY_SHA256 === helperHash
    && environment.REVIEWED_MIGRATION_PLAN_SHA256 === PLAN_SHA256
    && environment.MIGRATION_PARENT_REVIEW_APPROVED === 'true'
    && environment.MIGRATION_EXTERNAL_WRITERS_PAUSED === 'true', 'next_invocation_parent_approval_required');
  if (args[0] === '--retry-prepared') {
    requireFact(environment.REVIEWED_MIGRATION_PRIOR_HELPER_SHA256 === RETRY_PRIOR_HELPER_SHA256
      && [environment.REVIEWED_MIGRATION_PRIOR_JOURNAL_SHA256, environment.REVIEWED_MIGRATION_PRIOR_RECEIPT_SHA256]
        .every(value => /^[a-f0-9]{64}$/.test(value))
      && /^migration-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(environment.MIGRATION_RUN_ID),
    'retry_prior_approval_mismatch');
  }
  return args[0] === '--apply-approved' ? 'apply' : args[0].slice(2);
}

export async function verifyRuntimeEvidence(environment, inventory) {
  const apiPath = resolve(ROOT, environment.MIGRATION_LIVE_API_DIRECTORY ?? '');
  const receiptPath = resolve(ROOT, environment.MIGRATION_LIVE_RECEIPT ?? '');
  const publicPath = resolve(ROOT, environment.MIGRATION_LIVE_PUBLIC_DIRECTORY ?? '');
  for (const path of [apiPath, receiptPath, publicPath]) {
    requireFact(path.startsWith(`${ROOT}/local-media/`) && await realpath(path) === path, 'private_runtime_evidence_required');
  }
  const receipt = parseMetadata(await readFile(receiptPath));
  requireFact(receipt.apiUnchanged && receipt.api?.artifactSHA256 && receipt.live?.rootMatched
    && receipt.hostname === inventory.guards.site.hostname, 'live_receipt_invalid');
  const files = readArtifact(apiPath);
  const hash = createHash('sha256');
  for (const [key, bytes] of [...files].sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)) {
    hash.update(key).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  requireFact(hash.digest('hex') === receipt.api.artifactSHA256, 'live_api_artifact_changed');
  const host = JSON.parse(files.get('host.json'));
  const source = files.get('dist/functions.cjs').toString('utf8');
  requireFact(host.functionTimeout === '00:00:45'
    && /await this\.traffic\(`global-\$\{[^}]+\(8\)\}`, 64\)/.test(source)
    && source.indexOf('await this.traffic(`global-') < source.indexOf('parts.join("/") === "auth/login"')
    && /tryTimeoutInMs: 1e4/.test(source), 'live_admission_timeout_not_proven');
  const packageData = JSON.parse(files.get('node_modules/@azure/storage-blob/package.json'));
  requireFact(packageData.version === '12.28.0', 'live_sdk_version_changed');
  const retrySource = files.get('node_modules/@azure/storage-blob/dist/commonjs/policies/StorageRetryPolicy.js')?.toString('utf8');
  requireFact(retrySource?.includes('Math.floor(this.retryOptions.tryTimeoutInMs / 1000).toString()'), 'sdk_server_timeout_unproven');
  const origin = `https://${inventory.guards.site.hostname}`;
  for (const name of ['index.html', 'sw.js']) {
    const expected = await readFile(await checkedPath(publicPath, name));
    const response = await fetch(`${origin}/${name === 'index.html' ? '' : name}`, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
    requireFact(response.status === 200 && sha256(Buffer.from(await response.arrayBuffer())) === sha256(expected), 'live_public_build_changed');
  }
  return { apiArtifactSha256: receipt.api.artifactSHA256, sdk: packageData.version, functionTimeoutMs: 45000,
    storageServerTailMs: 10000, requiredDrainMs: DRAIN_MS,
    evidence: 'Preserved deployed API artifact matches prior live receipt; current public root and worker match. No remote backend hash endpoint exists. External deployments/admin writers must remain paused.' };
}

export async function verifyRetentionAndLifecycle(store, inventory, environment) {
  requireFact(['softDelete', 'containerSoftDelete', 'versioning'].every(key => store.retention[key] === false), 'retention_must_be_disabled');
  const policy = await azureJson(['storage', 'account', 'management-policy', 'show', '--subscription', inventory.guards.subscription.id,
    '--resource-group', environment.AZURE_RESOURCE_GROUP, '--account-name', inventory.guards.storage.name]);
  const rules = policy.policy?.rules;
  requireFact(Array.isArray(rules), 'lifecycle_policy_unverified');
  for (const rule of rules.filter(item => item.enabled)) {
    const prefixes = rule.definition?.filters?.prefixMatch;
    const age = rule.definition?.actions?.baseBlob?.delete?.daysAfterModificationGreaterThan;
    requireFact(Array.isArray(prefixes) && prefixes.length > 0 && prefixes.every(prefix =>
      prefix === `${inventory.guards.container.name}/uploads/` && age >= 7
      || prefix === `${inventory.guards.container.name}/sessions/` && age >= 2), 'lifecycle_rule_outside_review');
    requireFact(!rule.definition.actions.snapshot && !rule.definition.actions.version, 'lifecycle_retained_versions_rule');
  }
}

async function main() {
  let journal;
  try {
    requireFact(Number(process.versions.node.split('.')[0]) === 22, 'node22_required');
    const helperHash = sha256(await readFile(fileURLToPath(import.meta.url)));
    const mode = requestedApplyMode(process.argv.slice(2), process.env, helperHash);
    if (mode === 'journal-check') {
      verifyPrivateIgnore();
      const path = resolve(ROOT, process.env.MIGRATION_PLAN_PATH ?? '');
      requireFact(path.startsWith(`${ROOT}/local-media/`), 'private_path_escape');
      const raw = await readFile(await checkedPath(dirname(path), basename(path)));
      requireFact(sha256(raw) === PLAN_SHA256, 'reviewed_plan_hash_mismatch');
      const readiness = await privateJournalReadiness(process.env);
      console.log(JSON.stringify({ complete: readiness.privateJournalAvailable, mode, helperHash, planSha256: PLAN_SHA256,
        ...readiness, cloudMutations: 0, applyReady: false, parentReviewRequired: true }));
      if (!readiness.privateJournalAvailable) process.exitCode = 1;
      return;
    }
    const readiness = await privateJournalReadiness(process.env);
    if (mode !== 'dry-run') requireFact(readiness.privateJournalAvailable, readiness.blocker);
    const journalDirectory = readiness.privateJournalAvailable
      ? migrationJournalDirectory(PLAN_SHA256, readiness.migrationRunId, process.env.MIGRATION_JOURNAL_DIRECTORY) : undefined;
    const retry = mode === 'retry-prepared';
    let prior;
    let retryReceipt;
    let retryApproval;
    if (retry) {
      requireFact(!readiness.journalExists, 'retry_new_journal_required');
      const priorDirectory = migrationJournalDirectory(PLAN_SHA256, process.env.MIGRATION_PRIOR_RUN_ID);
      requireFact(priorDirectory !== journalDirectory, 'retry_new_journal_required');
      prior = await openJournal(priorDirectory, PLAN_SHA256, true, { readOnly: true });
      const receiptPath = resolve(ROOT, process.env.MIGRATION_PRIOR_RECEIPT_PATH ?? '');
      requireFact(receiptPath.startsWith(`${ROOT}/local-media/`), 'private_path_escape');
      const receiptRaw = await readFile(await checkedPath(dirname(receiptPath), basename(receiptPath)));
      retryReceipt = parseMetadata(receiptRaw);
      retryApproval = { receiptRaw, priorHelperSha256: process.env.REVIEWED_MIGRATION_PRIOR_HELPER_SHA256,
        priorJournalSha256: process.env.REVIEWED_MIGRATION_PRIOR_JOURNAL_SHA256,
        previousReceiptSha256: process.env.REVIEWED_MIGRATION_PRIOR_RECEIPT_SHA256 };
    }
    const recovery = ['resume', 'rollback', 'finish-release'].includes(mode);
    if (recovery) journal = await openJournal(journalDirectory, PLAN_SHA256, true);
    const releaseOnly = mode === 'finish-release' || Boolean(journal?.state.consistentOutcome);
    const bundle = await loadPrepared(process.env.MIGRATION_PLAN_PATH, process.env.MIGRATION_INVENTORY_PATH, { releaseOnly });
    const runtime = await verifyRuntimeEvidence(process.env, bundle.inventory);
    const store = await connectReadOnly(bundle.inventory, process.env, container => sdkAdapter(container, mode !== 'dry-run'));
    await verifyRetentionAndLifecycle(store, bundle.inventory, process.env);
    if (!recovery) await verifyCloudRecord(store, bundle.oldHeadRecord);
    const scan = recovery ? undefined : await scanState(store, bundle);
    if (!recovery) {
      for (const record of bundle.backup.metadata) if (!retry || record.key !== 'control/quota') await verifyCloudRecord(store, record);
      for (const record of bundle.deletions) requireFact(scan.rows.get(record.key)?.etag === record.etag
        && scan.rows.get(record.key)?.bytes === record.bytes, 'recorded_retirement_object_changed');
    }
    for (const key of scan ? GLOBAL_KEYS : []) {
      const row = scan.rows.get(key);
      requireFact(row, 'global_bucket_missing_stop_before_pause');
      validateBucket(parseMetadata(await store.read(key, row, MAX_JSON)));
    }
    const report = { schemaVersion: 1, mode, helperHash, planSha256: PLAN_SHA256, restoreSha256: RESTORE_SHA256,
      localFilesVerified: releaseOnly ? undefined : bundle.files.length, freshHeadUnchanged: !recovery, metadataDocuments: scan?.documents.size,
      globalBuckets: 8, runtime, parentReviewRequired: true, cloudMutations: 0,
      ...readiness,
      limitations: ['External admin writers/deployments must remain paused; storage root can break leases.',
        'Journal requires enforced 0700/0600 filesystem permissions; no capability enters logs.',
        'Prepared device caches are unchanged; reload routine before editing after successful migration.'] };
    const name = process.env.MIGRATION_APPLY_REPORT_NAME;
    requireFact(/^migration-[a-z0-9-]{1,80}$/.test(name), 'private_report_name_required');
    const reportDirectory = resolve(ROOT, 'local-media', name);
    if (mode === 'dry-run') {
      requireFact(await realpath(dirname(reportDirectory)) === dirname(reportDirectory), 'private_path_escape');
      await mkdir(reportDirectory, { mode: 0o700 });
      requireFact(await realpath(reportDirectory) === reportDirectory, 'private_path_escape');
      const destination = resolve(reportDirectory, 'review.json');
      const output = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await output.writeFile(encode({ ...report, applyReady: false,
          blockers: ['next_invocation_parent_review_required', ...readiness.privateJournalAvailable ? [] : [readiness.blocker]],
          reportContainsCapabilities: false, requestedReportMode: '0600', mountedFilesystemAclMustBeReviewed: true }));
        await output.sync();
      } finally { await output.close(); }
      console.log(JSON.stringify({ complete: true, mode, cloudMutations: 0, localFilesVerified: bundle.files.length,
        freshHeadUnchanged: true, ...readiness, applyReady: false, parentReviewRequired: true,
        report: relative(ROOT, destination) }));
      return;
    }
    const reusedReservation = retry ? await prepareRetry(store, bundle, prior, retryReceipt, retryApproval) : undefined;
    journal ??= await openJournal(journalDirectory, PLAN_SHA256, false, { reusedReservation });
    await journal.update(state => { state.review = report; });
    if (mode !== 'dry-run') {
      const result = await runMigration({ store, bundle, journal, mode: retry ? 'apply' : mode });
      if (!releaseOnly) {
        const response = await fetch(`https://${bundle.inventory.guards.site.hostname}/api/auth/session`, {
          redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
        });
        requireFact(response.status === 401 && (response.headers.get('cache-control') ?? '').includes('no-store')
          && typeof (await response.json()).error === 'string', 'post_release_anonymous_api_check_failed');
      }
      await journal.update(state => { state.result = result; });
    }
    console.log(JSON.stringify({ complete: true, mode, cloudMutations: mode === 'dry-run' ? 0 : undefined,
      localFilesVerified: releaseOnly ? undefined : bundle.files.length, freshHeadUnchanged: mode === 'dry-run', parentReviewRequired: mode === 'dry-run',
      phase: JOURNAL_PHASES.has(journal.state.phase) ? journal.state.phase : 'unknown', migrationRunId: readiness.migrationRunId }));
  } catch (error) {
    console.error(JSON.stringify(migrationFailure(error, journal)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('migration_guard_stopped'); process.exitCode = 1; });
}

export function validateBucket(value, now = Date.now()) {
  requireFact(value && Object.keys(value).sort().join(',') === 'count,window'
    && Number.isSafeInteger(value.window) && value.window >= 0 && value.window <= Math.floor(now / 60000)
    && Number.isSafeInteger(value.count) && value.count >= 0, 'traffic_bucket_invalid');
}

export class LeaseBarrier {
  constructor(store, journal, clock = () => performance.now()) {
    this.store = store;
    this.journal = journal;
    this.clock = clock;
    this.lastGlobalAck = undefined;
  }

  async acquire(key, etag) {
    let record = this.journal.state.leases[key];
    if (!record) {
      record = { id: randomUUID(), etag, state: 'attempting' };
      await this.journal.update(state => { state.leases[key] = record; });
    }
    requireFact(record.etag === etag && ['attempting', 'held'].includes(record.state), 'lease_identity_changed');
    if (record.state === 'held') {
      await this.store.renew(key, record.id);
    } else {
      try { await this.store.acquire(key, record.id, etag); }
      catch {
        try { await this.store.renew(key, record.id); }
        catch { throw new Error('lease_ownership_unresolved'); }
      }
      await this.journal.update(state => { state.leases[key].state = 'held'; });
    }
    if (GLOBAL_KEYS.includes(key)) this.lastGlobalAck = this.clock();
  }

  async renew() {
    for (const [key, record] of Object.entries(this.journal.state.leases)) {
      if (record.state !== 'held') continue;
      if (this.journal.state.operations?.[`delete:${key}`] && await this.store.properties(key) === null) {
        await this.journal.update(state => { state.leases[key].state = 'deleted'; });
      } else await this.store.renew(key, record.id);
    }
  }

  requireDrained() {
    requireFact(GLOBAL_KEYS.every(key => this.journal.state.leases[key]?.state === 'held')
      && Number.isFinite(this.lastGlobalAck) && this.clock() - this.lastGlobalAck >= DRAIN_MS,
    'drain_incomplete_not_applied');
  }

  async checkRelease(keys) {
    for (const key of keys) {
      const record = this.journal.state.leases[key];
      if (!record) continue;
      const current = await this.store.properties(key);
      if (record.state === 'deleted') {
        requireFact(!current && this.journal.state.operations?.[`delete:${key}`]?.state === 'done', 'lease_deleted_object_changed');
        continue;
      }
      requireFact(current && ['attempting', 'held', 'releasing', 'released'].includes(record.state), 'lease_release_state_invalid');
      if (['releasing', 'released'].includes(record.state) && current.leaseState === 'available') {
        if (record.state !== 'released') await this.journal.update(state => { state.leases[key].state = 'released'; });
        continue;
      }
      requireFact(record.state !== 'released' && current.leaseState === 'leased', 'lease_ownership_unresolved');
      try { await this.store.renew(key, record.id); }
      catch { throw new Error('lease_ownership_unresolved'); }
    }
  }

  async release(keys) {
    for (const key of keys) {
      await this.checkRelease([key]);
      const record = this.journal.state.leases[key];
      if (!record || record.state === 'released' || record.state === 'deleted') continue;
      await this.journal.update(state => { state.leases[key].state = 'releasing'; });
      await this.store.release(key, record.id);
      await this.journal.update(state => { state.leases[key].state = 'released'; });
    }
  }

  async releaseAll() {
    const keys = Object.keys(this.journal.state.leases);
    await this.checkRelease(keys);
    await this.release(keys.filter(key => !GLOBAL_KEYS.includes(key)));
    await this.release(GLOBAL_KEYS);
  }
}