// One-time Blob -> Cosmos data copy for Phase 1 (Cosmos DB migration). Not part of any pipeline.
// Read-only against Blob (never writes/deletes there); safe to re-run (snapshots are create-once
// and skipped if already present; documents/gates/quota/fillers are upserted with the latest Blob state).
// Usage:
//   node infra/copy-blob-to-cosmos.mjs                # dry run (default) - reports what would be copied
//   node infra/copy-blob-to-cosmos.mjs --apply        # actually writes to Cosmos
// Requires: FIM_STORAGE_CONNECTION_STRING, FIM_STORAGE_CONTAINER, FIM_COSMOS_CONNECTION_STRING, FIM_COSMOS_DATABASE
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apiRequire = createRequire(resolve(root, 'api/package.json'));
const { BlobServiceClient } = apiRequire('@azure/storage-blob');
const { CosmosClient } = apiRequire('@azure/cosmos');

const APPLY = process.argv.includes('--apply');
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

const KIND_PATHS = {
  routine: { entityKey: 'routine', indexPrefix: 'heads/', headKey: id => `routines/${id}/head`,
    snapshotPrefix: (id, published) => `${published ? 'publications' : 'snapshots'}/${id}/` },
  playlist: { entityKey: 'playlist', indexPrefix: 'playlists/index/', headKey: id => `playlists/${id}/head`,
    snapshotPrefix: (id, published) => `playlists/${id}/${published ? 'publications' : 'snapshots'}/` },
  class: { entityKey: 'setup', indexPrefix: 'classes/index/', headKey: id => `classes/${id}/head`,
    snapshotPrefix: (id, published) => `classes/${id}/${published ? 'publications' : 'snapshots'}/` },
};

function parseConnectionEnv(env, connectionVar, extraVar, extraName) {
  const connectionString = env[connectionVar] ?? '';
  const extra = env[extraVar] ?? '';
  assert(connectionString && extra, `Set ${connectionVar} and ${extraVar} to run this script.`);
  return { connectionString, [extraName]: extra };
}

function deterministicUuid(seed) {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readJsonBlob(container, key) {
  try {
    const response = await container.getBlobClient(key).download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function listPrefix(container, prefix) {
  const keys = [];
  for await (const item of container.listBlobsFlat({ prefix })) keys.push(item.name);
  return keys;
}

async function cosmosRead(database, containerName, id, partitionKey) {
  const response = await database.container(containerName).item(id, partitionKey).read().catch(error => {
    if (error.code === 404) return { resource: undefined };
    throw error;
  });
  return response.resource;
}

async function cosmosUpsert(database, containerName, body, stats) {
  if (!APPLY) { stats.wouldWrite++; return; }
  await database.container(containerName).items.upsert(body);
  stats.written++;
}

async function cosmosCreateIfAbsent(database, containerName, id, partitionKey, body, stats) {
  const existing = await cosmosRead(database, containerName, id, partitionKey);
  if (existing) { stats.skippedExisting++; return; }
  if (!APPLY) { stats.wouldWrite++; return; }
  await database.container(containerName).items.create(body);
  stats.written++;
}

async function copyDocumentKind(container, database, kind, stats, report) {
  const paths = KIND_PATHS[kind];
  const indexKeys = await listPrefix(container, paths.indexPrefix);
  const ids = indexKeys.map(key => key.slice(paths.indexPrefix.length)).filter(id => SAFE_ID.test(id));
  for (const id of ids) {
    const head = await readJsonBlob(container, paths.headKey(id));
    if (!head || !head.draft) { report.push(`MISSING HEAD  ${kind}:${id}`); continue; }

    const refs = new Map(); // oldBlobKey -> published
    const noteRef = (key, published) => { if (key) refs.set(key, published); };
    noteRef(head.draft.key, false);
    if (head.published) noteRef(head.published.key, true);
    const history = head.history ?? [{ revision: head.draft.revision, draft: head.draft.key,
      ...(head.published ? { published: head.published.key } : {}) }];
    for (const link of history) { noteRef(link.draft, false); noteRef(link.published, true); }

    const newIdOf = new Map();
    for (const oldKey of refs.keys()) newIdOf.set(oldKey, deterministicUuid(`snapshot:${kind}:${id}:${oldKey}`));

    for (const [oldKey, published] of refs) {
      const snapshotBody = await readJsonBlob(container, oldKey);
      if (!snapshotBody) { report.push(`MISSING SNAPSHOT  ${kind}:${id}  ${oldKey}`); continue; }
      const entity = snapshotBody[paths.entityKey];
      assert(entity && Number.isSafeInteger(entity.revision), `${kind}:${id}: snapshot ${oldKey} missing entity/revision`);
      const snapshotId = newIdOf.get(oldKey);
      await cosmosCreateIfAbsent(database, 'snapshots', snapshotId, id,
        { id: snapshotId, documentId: id, kind, published, revision: entity.revision, body: snapshotBody }, stats.snapshots);
    }

    const remapPointer = pointer => pointer && { ...pointer, key: newIdOf.get(pointer.key) };
    const newHead = { draft: remapPointer(head.draft), deleted: !!head.deleted,
      ...(head.published ? { published: remapPointer(head.published) } : {}),
      history: history.map(link => ({ revision: link.revision,
        ...(link.draft ? { draft: newIdOf.get(link.draft) } : {}),
        ...(link.published ? { published: newIdOf.get(link.published) } : {}) })) };
    const itemId = `${kind}:${id}`;
    await cosmosUpsert(database, 'documents', { id: itemId, documentId: id, kind, head: newHead }, stats.documents);
  }
  return ids.length;
}

async function copyAdmissionGates(container, database, stats) {
  const keys = await listPrefix(container, 'library/gates/');
  for (const key of keys) {
    const id = key.slice('library/gates/'.length);
    if (!SAFE_ID.test(id)) continue;
    const value = await readJsonBlob(container, key);
    if (!value) continue;
    await cosmosUpsert(database, 'assetStatus', { id, ...value }, stats.gates);
  }
  return keys.length;
}

async function copyQuota(container, database, stats) {
  const value = await readJsonBlob(container, 'control/quota');
  if (!value) return false;
  await cosmosUpsert(database, 'system', { id: 'quota', ...value }, stats.quota);
  return true;
}

async function copyFillers(container, database, stats, report) {
  const indexKeys = await listPrefix(container, 'fillers/index/');
  const ids = indexKeys.map(key => key.slice('fillers/index/'.length)).filter(id => SAFE_ID.test(id));
  for (const id of ids) {
    const record = await readJsonBlob(container, `fillers/records/${id}`);
    if (!record) { report.push(`MISSING FILLER RECORD  ${id}`); continue; }
    const analysis = await readJsonBlob(container, `fillers/analysis/${id}`);
    const deleted = await readJsonBlob(container, `library/deleted-fillers/${id}`);
    const item = { id, recording: record.recording, archived: !!record.archived,
      ...(deleted ? { deleted: { revision: deleted.revision } } : {}),
      ...(analysis ? { analysis } : {}) };
    await cosmosUpsert(database, 'fillers', item, stats.fillers);
  }
  return ids.length;
}

function freshStats() {
  const bucket = () => ({ written: 0, wouldWrite: 0, skippedExisting: 0 });
  return { documents: bucket(), snapshots: bucket(), gates: bucket(), quota: bucket(), fillers: bucket() };
}

export async function copyBlobToCosmos(env = process.env) {
  const blob = parseConnectionEnv(env, 'FIM_STORAGE_CONNECTION_STRING', 'FIM_STORAGE_CONTAINER', 'containerName');
  const cosmos = parseConnectionEnv(env, 'FIM_COSMOS_CONNECTION_STRING', 'FIM_COSMOS_DATABASE', 'databaseName');
  const container = BlobServiceClient.fromConnectionString(blob.connectionString).getContainerClient(blob.containerName);
  const client = new CosmosClient(cosmos.connectionString);
  const database = client.database(cosmos.databaseName);

  const stats = freshStats();
  const report = [];
  const counts = {};
  for (const kind of Object.keys(KIND_PATHS)) counts[kind] = await copyDocumentKind(container, database, kind, stats, report);
  counts.gates = await copyAdmissionGates(container, database, stats);
  counts.quota = await copyQuota(container, database, stats);
  counts.fillers = await copyFillers(container, database, stats, report);
  return { mode: APPLY ? 'apply' : 'dry-run', counts, stats, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyBlobToCosmos().then(result => {
    console.log(`Mode: ${result.mode}`);
    console.log('Discovered:', result.counts);
    console.log('Documents:', result.stats.documents);
    console.log('Snapshots:', result.stats.snapshots);
    console.log('Admission gates:', result.stats.gates);
    console.log('Quota:', result.stats.quota);
    console.log('Fillers:', result.stats.fillers);
    if (result.report.length) {
      console.log(`\n${result.report.length} issue(s):`);
      for (const line of result.report) console.log(`  ${line}`);
    }
    if (!APPLY) console.log('\nDry run only - no writes made. Re-run with --apply to write to Cosmos.');
  }).catch(error => {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  });
}
