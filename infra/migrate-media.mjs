import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { azureJson, classify, describeMetadata, parseMetadata, strongEtag, validators } from './inspect-media-migration.mjs';

export const CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const root = fileURLToPath(new URL('..', import.meta.url));
const maximumMetadata = 1024 * 1024;
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const operationalPrefixes = new Set(['sessions', 'throttles', 'throttle', 'traffic', 'keys']);

export function requireFact(condition, code) {
  if (!condition) throw new Error(code);
}

export function sameAsset(first, second) {
  return ['id', 'bytes', 'sha256', 'contentType'].every(key => first?.[key] === second?.[key]);
}

export function buildReplacement(body, replacements, generateId = randomUUID) {
  requireFact(body?.routine?.locked === false && body.routine.published === false, 'draft_must_be_unlocked');
  const result = structuredClone(body);
  const originalIds = new Set([...body.routine.tracks.map(track => track.id),
    ...Object.values(body.media).map(asset => asset.id)]);
  const allocated = new Set(originalIds);
  const mapping = [];
  result.media = {};
  requireFact(replacements.length === body.routine.tracks.length, 'replacement_count_mismatch');
  for (const track of result.routine.tracks) {
    const oldEntryId = track.id;
    const source = body.media[oldEntryId];
    const replacement = replacements.find(item => sameAsset(item.source, source));
    requireFact(source?.contentType === 'audio/wav' && replacement, 'replacement_source_mismatch');
    const asset = replacement.asset;
    requireFact(uuidPattern.test(asset?.id) && !allocated.has(asset.id)
      && asset.contentType === 'audio/mp4' && /^[a-f0-9]{64}$/.test(asset.sha256)
      && Number.isSafeInteger(asset.bytes) && asset.bytes >= 44 && asset.bytes <= MAX_OUTPUT_BYTES,
    'replacement_descriptor_invalid');
    allocated.add(asset.id);
    const entryId = generateId();
    requireFact(uuidPattern.test(entryId) && !allocated.has(entryId), 'fresh_entry_id_required');
    allocated.add(entryId);
    track.id = entryId;
    result.media[entryId] = structuredClone(asset);
    mapping.push({ oldEntryId, entryId, oldAssetId: source.id, assetId: asset.id });
  }
  result.routine.revision += 1;
  return { body: result, mapping };
}

export function conversionArguments(source, output) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-n',
    '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-map_metadata', '-1', '-map_chapters', '-1', '-c:a', 'aac', '-profile:a', 'aac_low',
    '-b:a', '256000', '-ar', '48000', '-threads', '1', '-movflags', '+faststart',
    '-use_editlist', '1', output];
}

export function requestedMode(args) {
  requireFact(args.length === 1 && args[0] === '--prepare', 'prepare_only_no_cloud_mutations');
  return 'prepare';
}

export async function collectBounded(response, expected, limit) {
  const stream = response.readableStreamBody;
  const parts = [];
  let size = 0;
  try {
    requireFact(stream && response.contentLength === expected.bytes && expected.bytes <= limit,
      'download_length_mismatch');
    requireFact(strongEtag(response.etag) === strongEtag(expected.etag), 'download_etag_changed');
    for await (const part of stream) {
      size += part.length;
      requireFact(size <= expected.bytes && size <= limit, 'download_size_limit');
      parts.push(part);
    }
    requireFact(size === expected.bytes, 'download_truncated');
    return Buffer.concat(parts, size);
  } finally { stream?.destroy(); }
}

export function inspectWav(prefix, bytes) {
  requireFact(bytes <= MAX_SOURCE_BYTES && prefix.length >= 44 && prefix.toString('ascii', 0, 4) === 'RIFF'
    && prefix.toString('ascii', 8, 12) === 'WAVE' && prefix.readUInt32LE(4) + 8 === bytes, 'invalid_wav');
  let channels;
  for (let offset = 12; offset + 8 <= prefix.length;) {
    const kind = prefix.toString('ascii', offset, offset + 4);
    const length = prefix.readUInt32LE(offset + 4);
    if (kind === 'fmt ') {
      requireFact(!channels && length === 16 && offset + 24 <= prefix.length, 'invalid_wav_format');
      channels = prefix.readUInt16LE(offset + 10);
      requireFact(prefix.readUInt16LE(offset + 8) === 1 && [1, 2].includes(channels)
        && prefix.readUInt32LE(offset + 12) === 48000 && prefix.readUInt16LE(offset + 22) === 16
        && prefix.readUInt16LE(offset + 20) === channels * 2
        && prefix.readUInt32LE(offset + 16) === 48000 * channels * 2, 'expected_lpcm_48k_16');
    } else if (kind === 'data') {
      requireFact(channels && length > 0 && length % (channels * 2) === 0 && offset + 8 + length === bytes,
        'invalid_wav_data');
      const frames = length / (channels * 2);
      requireFact(frames / 48000 <= 360 && frames * channels * 4 <= MAX_SOURCE_BYTES, 'decoded_audio_limit');
      return { channels, sampleRate: 48000, bits: 16, frames, duration: frames / 48000, dataOffset: offset + 8 };
    } else throw new Error('unexpected_wav_chunk');
    offset += 8 + length + length % 2;
  }
  throw new Error('wav_data_missing');
}

export function verifyTimeline(sourceFrames, decodedFrames, containerDuration, browserDuration) {
  const sourceDuration = sourceFrames / 48000;
  requireFact(Number.isSafeInteger(decodedFrames) && decodedFrames >= sourceFrames
    && decodedFrames - sourceFrames <= 1024, 'aac_native_timeline_mismatch');
  requireFact(Number.isFinite(containerDuration) && Math.abs(containerDuration - sourceDuration) <= 0.002,
    'aac_edit_list_duration_mismatch');
  requireFact(Number.isFinite(browserDuration) && Math.abs(browserDuration - sourceDuration) <= 0.1,
    'browser_cache_duration_mismatch');
  return { sourceFrames, nativeFrames: decodedFrames, nativePaddingFrames: decodedFrames - sourceFrames,
    nativePaddingSeconds: (decodedFrames - sourceFrames) / 48000, containerDuration, browserDuration,
    browserDeltaSeconds: browserDuration - sourceDuration,
    explanation: 'Edit list removes encoder priming. Native decode may retain at most one 1024-sample AAC frame at the END. Saved source duration and cue times remain unchanged.' };
}

export function inspectUpload(value, catalog, now = Date.now()) {
  const required = ['asset', 'ownerId', 'expiresAt', 'state', 'chunks'];
  requireFact(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => [...required, 'finalization'].includes(key))
    && sameAsset(value.asset, catalog.asset) && typeof value.ownerId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.ownerId)
    && Number.isSafeInteger(value.expiresAt) && ['open', 'sealed', 'complete', 'aborted'].includes(value.state)
    && value.chunks && !Array.isArray(value.chunks), 'invalid_upload_head');
  const count = catalog.chunks.length;
  requireFact(Object.keys(value.chunks).length === count
    && catalog.chunks.every((hash, index) => value.chunks[index] === hash), 'upload_incomplete_or_different');
  if (value.finalization) requireFact(Object.keys(value.finalization).length === 2
    && value.finalization.sha256 === catalog.asset.sha256
    && Number.isSafeInteger(value.finalization.copiedChunks) && value.finalization.copiedChunks >= 0
    && value.finalization.copiedChunks <= count
    && (value.state !== 'complete' || value.finalization.copiedChunks === count), 'invalid_upload_cursor');
  requireFact(value.state === 'complete' || value.expiresAt <= now, 'active_upload_blocks_retirement');
  const { ownerId, ...safeHead } = value;
  return { head: safeHead, state: value.state, expired: value.expiresAt <= now,
    ownerIdOmitted: true, restoreRequirement: 'Supply the original ownerId privately during any staging-head restore; no account data is backed up.' };
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const part of createReadStream(path, { highWaterMark: CHUNK_BYTES })) {
    bytes += part.length;
    requireFact(bytes <= MAX_SOURCE_BYTES, 'file_size_limit');
    hash.update(part);
  }
  return { bytes, sha256: hash.digest('hex') };
}

export async function privateDirectory(name) {
  requireFact(/^migration-[a-z0-9-]{1,80}$/.test(name), 'private_directory_name_required');
  const directory = resolve(root, 'local-media', name);
  for (const path of [resolve(root, 'local-media'), directory]) {
    try { requireFact(!(await lstat(path)).isSymbolicLink(), 'private_symlink_rejected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  requireFact((await realpath(resolve(root, 'local-media'))) === resolve(root, 'local-media'), 'private_path_escape');
  verifyPrivateIgnore();
  requireFact(readFileSync(resolve(root, 'frontend/vite.config.ts'), 'utf8').includes("'**/local-media/**'"), 'vite_private_deny_required');
  await mkdir(directory, { mode: 0o700 });
  for (const subdirectory of ['backup', 'backup/metadata', 'backup/wav', 'candidate', 'candidate/m4a', 'candidate/catalogs']) {
    await mkdir(resolve(directory, subdirectory), { mode: 0o700 });
  }
  return directory;
}

async function savePrivate(directory, path, bytes) {
  const destination = resolve(directory, path);
  requireFact(destination.startsWith(`${directory}/`) && !path.includes('..'), 'private_path_escape');
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  return { path, bytes: bytes.length, sha256: digest(bytes) };
}

async function saveJson(directory, path, value) {
  return savePrivate(directory, path, Buffer.from(JSON.stringify(value, null, 2)));
}

export function validateRetention(value) {
  requireFact(value && ['softDelete', 'containerSoftDelete', 'versioning'].every(key => typeof value[key] === 'boolean'),
    'retention_state_unverified');
  return { softDelete: value.softDelete, containerSoftDelete: value.containerSoftDelete, versioning: value.versioning,
    evidence: 'Azure management blob-service-properties read; no absent SDK fields inferred false' };
}

async function readRetention(inventory, environment) {
  const { AZURE_SUBSCRIPTION_ID: subscription, AZURE_RESOURCE_GROUP: group, FIM_STORAGE_ACCOUNT_NAME: storage } = environment;
  requireFact(subscription === inventory.guards.subscription.id && storage === inventory.guards.storage.name
    && inventory.guards.storage.id === `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Storage/storageAccounts/${storage}`,
  'retention_exact_target_required');
  return validateRetention(await azureJson(['storage', 'account', 'blob-service-properties', 'show', '--subscription', subscription,
    '--resource-group', group, '--account-name', storage,
    '--query', '{softDelete:deleteRetentionPolicy.enabled,containerSoftDelete:containerDeleteRetentionPolicy.enabled,versioning:isVersioningEnabled}']));
}

export async function connectReadOnly(inventory, environment, adapter) {
  const guards = inventory.guards;
  const subscription = environment.AZURE_SUBSCRIPTION_ID;
  const group = environment.AZURE_RESOURCE_GROUP;
  const storageName = environment.FIM_STORAGE_ACCOUNT_NAME;
  requireFact(subscription === guards.subscription.id && storageName === guards.storage.name
    && environment.FIM_STORAGE_CONTAINER === guards.container.name && environment.SWA_NAME === guards.site.name
    && environment.SWA_EXPECTED_HOSTNAME === guards.site.hostname && /^[A-Za-z0-9_-]{1,90}$/.test(group), 'exact_target_required');
  const base = `/subscriptions/${subscription}/resourceGroups/${group}/providers`;
  const account = await azureJson(['account', 'show', '--subscription', subscription, '--query', '{id:id,name:name,state:state}']);
  requireFact(account.id === subscription && account.state === 'Enabled'
    && account.name === 'Visual Studio Enterprise Subscription', 'subscription_guard_failed');
  const storage = await azureJson(['storage', 'account', 'show', '--subscription', subscription,
    '--resource-group', group, '--name', storageName,
    '--query', '{id:id,kind:kind,sku:sku.name,public:allowBlobPublicAccess,https:enableHttpsTrafficOnly,tls:minimumTlsVersion,endpoint:primaryEndpoints.blob}']);
  requireFact(storage.id === guards.storage.id && storage.id === `${base}/Microsoft.Storage/storageAccounts/${storageName}`
    && storage.kind === 'StorageV2' && storage.sku === 'Standard_LRS' && storage.public === false
    && storage.https === true && storage.tls === 'TLS1_2'
    && storage.endpoint === `https://${storageName}.blob.core.windows.net/`, 'storage_guard_failed');
  const site = await azureJson(['staticwebapp', 'show', '--subscription', subscription, '--resource-group', group,
    '--name', environment.SWA_NAME, '--query', '{id:id,hostname:defaultHostname,sku:sku.name}']);
  requireFact(site.id === guards.site.id && site.id === `${base}/Microsoft.Web/staticSites/${environment.SWA_NAME}`
    && site.hostname === environment.SWA_EXPECTED_HOSTNAME && site.sku === 'Free', 'site_guard_failed');
  const sdk = createRequire(resolve(root, 'api/package.json'))('@azure/storage-blob');
  let key = await azureJson(['storage', 'account', 'keys', 'list', '--subscription', subscription,
    '--resource-group', group, '--account-name', storageName, '--query', '[0].value']);
  requireFact(typeof key === 'string' && /^[A-Za-z0-9+/]{80,100}={0,2}$/.test(key), 'credential_capture_failed');
  const credential = new sdk.StorageSharedKeyCredential(storageName, key);
  key = undefined;
  const service = new sdk.BlobServiceClient(storage.endpoint, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: 20000 }, loggingOptions: { logger: () => {} },
  });
  const container = service.getContainerClient(environment.FIM_STORAGE_CONTAINER);
  const access = await container.getAccessPolicy({ abortSignal: AbortSignal.timeout(20000) });
  requireFact(!access.blobPublicAccess && access.signedIdentifiers.length === 0, 'container_not_private');
  return {
    ...(adapter ? adapter(container) : {}),
    retention: await readRetention(inventory, environment),
    list: () => container.listBlobsFlat({ abortSignal: AbortSignal.timeout(120000) }).byPage({ maxPageSize: 128 }),
    read: async (name, expected, maximum) => {
      const response = await container.getBlobClient(name).download(0, undefined, {
        conditions: { ifMatch: strongEtag(expected.etag) }, abortSignal: AbortSignal.timeout(30000),
        maxRetryRequests: 0,
      });
      return collectBounded(response, expected, maximum);
    },
    head: async (name, etag) => {
      const response = await container.getBlobClient(name).getProperties({
        conditions: { ifMatch: strongEtag(etag) }, abortSignal: AbortSignal.timeout(20000),
      });
      return { etag: strongEtag(response.etag), bytes: response.contentLength };
    },
  };
}

export async function listAll(store) {
  const rows = new Map();
  const cursors = new Set();
  const iterator = store.list();
  for (let pageIndex = 0; pageIndex < 128; pageIndex++) {
    const page = await iterator.next();
    if (page.done) return rows;
    const items = page.value.segment.blobItems;
    requireFact(items.length <= 128, 'listing_page_limit');
    for (const item of items) {
      requireFact(typeof item.name === 'string' && item.name.length <= 1024 && !rows.has(item.name)
        && !item.deleted && !item.snapshot && !item.versionId, 'listing_invalid');
      requireFact(Number.isSafeInteger(item.properties.contentLength) && item.properties.contentLength >= 0, 'blob_length_invalid');
      rows.set(item.name, { etag: strongEtag(item.properties.etag), bytes: item.properties.contentLength });
      requireFact(rows.size <= 8192, 'listing_total_limit');
    }
    const cursor = page.value.continuationToken;
    if (!cursor) return rows;
    requireFact(items.length && !cursors.has(cursor), 'listing_cursor_invalid');
    cursors.add(cursor);
  }
  throw new Error('listing_page_limit');
}

export function validateBody(description, body, checks) {
  if (description.type === 'filler') checks.parseFillerRecording(body.recording);
  if (description.type !== 'snapshot') return;
  if (description.kind === 'routine') {
    const { id, revision, locked, published, ...content } = body.routine;
    checks.parseRoutineContent(content);
  } else if (description.kind === 'playlist') requireFact(checks.validateMusicPlaylist(body.playlist).length === 0, 'invalid_playlist');
  else requireFact(checks.validateClassSetup(body.setup).length === 0, 'invalid_class');
}

export async function scanReferences(store, rows, inventory, checks) {
  const documents = new Map();
  const excluded = Object.create(null);
  const unknown = Object.create(null);
  let metadataBytes = 0;
  for (const [key, row] of rows) {
    let location;
    try { location = classify(key); }
    catch {
      const prefix = key.split('/')[0];
      if (/^(assets|uploads)\/[A-Za-z0-9_-]+\/chunks\/(0|[1-9][0-9]*)$/.test(key)
        || /^uploads\/[A-Za-z0-9_-]+\/head$/.test(key) || operationalPrefixes.has(prefix)
        || key === 'control/quota') excluded[prefix] = (excluded[prefix] ?? 0) + 1;
      else {
        const safePrefix = /^[a-z-]{1,40}$/.test(prefix) ? prefix : 'redacted';
        unknown[safePrefix] = (unknown[safePrefix] ?? 0) + 1;
      }
      continue;
    }
    requireFact(documents.size < 4096 && row.bytes <= (location.type === 'head' ? 65536 : maximumMetadata), 'metadata_limit');
    const bytes = await store.read(key, row, maximumMetadata);
    metadataBytes += bytes.length;
    requireFact(metadataBytes <= 64 * maximumMetadata, 'metadata_total_limit');
    const value = parseMetadata(bytes);
    const description = describeMetadata(key, value);
    validateBody(description, value, checks);
    documents.set(key, { ...description, value, raw: bytes, ...row, sha256: digest(bytes) });
  }
  const selected = new Set(inventory.assets.map(asset => asset.id));
  const referenceRows = [];
  for (const doc of documents.values()) {
    requireFact(!doc.pins.some(pin => pin.kind === 'routine' && pin.id === inventory.target.id), 'target_class_pin_found');
    for (const ref of doc.refs) if (selected.has(ref.asset.id)) {
      requireFact(doc.type === 'snapshot' && doc.kind === 'routine' && doc.id === inventory.target.id
        && !doc.published && ref.role === 'song' && sameAsset(ref.asset, inventory.assets.find(asset => asset.id === ref.asset.id)),
      'outside_or_changed_asset_reference');
      referenceRows.push({ key: doc.key, revision: doc.revision, assetId: ref.asset.id });
    }
    if (doc.type === 'head') {
      for (const variant of ['draft', 'published']) if (doc.head[variant]) {
        const pointer = doc.head[variant];
        const body = documents.get(pointer.key);
        requireFact(body?.revision === pointer.revision && body.entity.name === pointer.name
          && body.entity.locked === pointer.locked, 'head_snapshot_mismatch');
      }
      for (const link of doc.head.history ?? []) for (const variant of ['draft', 'published']) if (link[variant]) {
        requireFact(documents.get(link[variant])?.revision === link.revision, 'history_snapshot_missing');
      }
    }
  }
  const targetSnapshots = [...documents.values()].filter(doc => doc.type === 'snapshot' && doc.kind === 'routine' && doc.id === inventory.target.id);
  requireFact(targetSnapshots.length === 5 && targetSnapshots.every(doc => !doc.published)
    && JSON.stringify(targetSnapshots.map(doc => doc.revision).sort()) === '[1,2,3,4,5]' && referenceRows.length === 50,
  'target_history_changed');
  for (const asset of inventory.assets) requireFact(referenceRows.filter(row => row.assetId === asset.id).length === 5, 'reference_count_changed');
  return { documents, summary: { completeKnownMetadata: true, completeAllPrefixes: Object.keys(unknown).length === 0,
    listedBlobs: rows.size, metadataDocuments: documents.size, metadataBytes, references: referenceRows,
    unknownPrefixes: unknown, excludedContentCounts: excluded, atomicSnapshot: false } };
}

export async function downloadAsset(store, rows, catalog, path, prefix) {
  const hash = createHash('sha256');
  const chunks = [];
  const handle = path ? await open(path, 'wx', 0o600) : undefined;
  let position = 0;
  try {
    for (let start = 0; start < catalog.chunks.length; start += 2) {
      const batch = await Promise.allSettled(catalog.chunks.slice(start, start + 2).map(async (sha256, offset) => {
        const index = start + offset;
        const key = `${prefix}/${catalog.asset.id}/chunks/${index}`;
        const row = rows.get(key);
        const bytes = Math.min(CHUNK_BYTES, catalog.asset.bytes - index * CHUNK_BYTES);
        requireFact(row?.bytes === bytes, 'asset_chunk_missing_or_wrong_length');
        const data = await store.read(key, row, CHUNK_BYTES);
        requireFact(digest(data) === sha256, 'asset_chunk_hash_mismatch');
        return { data, key, ...row, sha256, offset: index * CHUNK_BYTES };
      }));
      for (const result of batch) {
        if (result.status === 'rejected') throw result.reason;
        const { data, ...chunk } = result.value;
        if (handle) {
          let written = 0;
          while (written < data.length) {
            const write = await handle.write(data, written, data.length - written, position + written);
            requireFact(write.bytesWritten > 0, 'backup_write_failed');
            written += write.bytesWritten;
          }
        }
        position += data.length;
        hash.update(data);
        chunks.push(chunk);
      }
    }
    requireFact(position === catalog.asset.bytes && hash.digest('hex') === catalog.asset.sha256, 'asset_hash_mismatch');
    if (handle) await handle.sync();
    return { bytes: position, sha256: catalog.asset.sha256, chunks };
  } finally { await handle?.close(); }
}

export async function native(program, args, timeout = 300000) {
  try {
    const result = await execute(program, args, { maxBuffer: 256 * 1024, timeout, encoding: 'utf8' });
    requireFact(!result.stderr.trim(), 'native_diagnostic');
    return result.stdout;
  } catch { throw new Error('native_media_validation_failed'); }
}

export async function probe(path) {
  return JSON.parse(await native('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams',
    '-show_format', '-show_chapters', '-of', 'json', path]));
}

export async function decodedFrames(path, channels) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
    '-protocol_whitelist', 'file,pipe', '-i', path, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-threads', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
  { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  const completion = new Promise((resolveResult, reject) => {
    child.on('error', () => reject(new Error('native_decode_failed')));
    child.on('close', code => resolveResult(code));
  });
  let bytes = 0;
  let diagnostics = false;
  child.stderr.on('data', () => { diagnostics = true; });
  let remainder = Buffer.alloc(0);
  try {
    for await (const part of child.stdout) {
      bytes += part.length;
      requireFact(bytes <= MAX_SOURCE_BYTES + 1024 * channels * 4, 'decoded_audio_limit');
      const data = remainder.length ? Buffer.concat([remainder, part]) : part;
      const aligned = data.length - data.length % 4;
      for (let offset = 0; offset < aligned; offset += 4) requireFact(Number.isFinite(data.readFloatLE(offset)), 'nonfinite_audio');
      remainder = Buffer.from(data.subarray(aligned));
    }
    requireFact(await completion === 0 && !diagnostics && bytes > 0 && bytes % (channels * 4) === 0,
      'native_decode_failed');
    return bytes / (channels * 4);
  } catch (error) {
    child.kill('SIGKILL');
    await completion.catch(() => {});
    throw error;
  }
}

export async function browserDecode(browser, path, expected) {
  const context = await browser.newContext({ serviceWorkers: 'block', offline: true });
  let requests = 0;
  await context.route('**/*', route => {
    if (route.request().url() === 'https://migration.invalid/' && route.request().method() === 'GET') {
      return route.fulfill({ contentType: 'text/html', body: '<input type="file">',
        headers: { 'Content-Security-Policy': "default-src 'none'; connect-src 'none'; media-src 'none'" } });
    }
    requests += 1;
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.goto('https://migration.invalid/');
    await page.locator('input').setInputFiles(path, { timeout: 30000 });
    const result = await page.evaluate(async () => {
      const file = document.querySelector('input').files[0];
      const bytes = await file.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const audio = new AudioContext({ sampleRate: 48000 });
      try {
        const decoded = await Promise.race([audio.decodeAudioData(bytes),
          new Promise((_, reject) => setTimeout(() => reject(new Error('decode_timeout')), 30000))]);
        return { duration: decoded.duration, channels: decoded.numberOfChannels, sampleRate: decoded.sampleRate,
          frames: decoded.length, sha256: hash, bytes: file.size };
      } finally { await audio.close(); }
    });
    requireFact(result.sha256 === expected.sha256 && result.bytes === expected.bytes && requests === 0,
      'browser_bytes_or_network_mismatch');
    return { ...result, externalRequests: requests };
  } finally { await context.close(); }
}

async function outputCatalog(path, asset) {
  const handle = await open(path, 'r');
  const chunks = [];
  try {
    for (let offset = 0; offset < asset.bytes; offset += CHUNK_BYTES) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, asset.bytes - offset));
      const result = await handle.read(buffer, 0, buffer.length, offset);
      requireFact(result.bytesRead === buffer.length, 'local_file_truncated');
      chunks.push(digest(buffer));
    }
  } finally { await handle.close(); }
  return { asset, chunks };
}

async function prepare(inventory, directory, store, report) {
  const checks = validators();
  const headKey = `routines/${inventory.target.id}/head`;
  const expectedHead = inventory.metadataInventory.find(doc => doc.key === headKey);
  requireFact(expectedHead?.etag === inventory.target.headEtag, 'inventory_head_mismatch');
  const initialHead = await store.read(headKey, expectedHead, 65536);
  requireFact(digest(initialHead) === expectedHead.sha256, 'head_changed_since_approval');
  const rows = await listAll(store);
  const scan = await scanReferences(store, rows, inventory, checks);
  report.scan = scan.summary;
  report.retention = store.retention;
  const documents = scan.documents;
  const head = documents.get(headKey);
  requireFact(head.etag === expectedHead.etag && head.sha256 === expectedHead.sha256 && !head.head.deleted
    && !head.head.published && !head.head.draft.locked && head.head.draft.revision === 5
    && head.head.draft.name === inventory.target.name, 'target_state_changed');
  const current = documents.get(head.head.draft.key);
  requireFact(current.entity.tracks.length === 10 && new Set(Object.values(current.value.media).map(asset => asset.id)).size === 10,
    'target_track_count_changed');
  const backup = { schemaVersion: 1, complete: false, source: 'authoritative-cloud-bytes', routineId: inventory.target.id,
    expectedHeadEtag: head.etag, metadata: [], assets: [], staging: [],
    restore: ['Verify every listed local SHA256 and byte length before restoring.',
      'Under the separately approved all-writer freeze, split each WAV at the recorded chunk offsets/lengths and verify each chunk SHA256.',
      'Restore asset chunks before catalogs; restore snapshots before the old head. Use recorded ETags for still-existing blobs and If-None-Match:* for absent blobs.',
      'Restore the head LAST with the actual post-migration head ETag; never force-overwrite concurrent changes. ETags cannot be recreated.',
      'The routine index is unchanged. Staging bytes are identical WAV slices; staging ownerId is deliberately omitted and must be supplied privately if restoring that optional head.',
      'This is a local backup, not a cloud restore execution or an atomic snapshot. No account settings, keys, cookies or password hashes are included.'],
    filesystem: 'Requested 0700 directories/0600 files. Windows/WSL mounted-filesystem ACLs remain authoritative; no encryption guarantee.' };
  for (const doc of documents.values()) {
    const target = doc.id === inventory.target.id && doc.kind === 'routine';
    const selectedCatalog = doc.type === 'catalog' && inventory.assets.some(asset => asset.id === doc.id);
    if (!target && !selectedCatalog) continue;
    const old = inventory.metadataInventory.find(row => row.key === doc.key);
    requireFact(old && old.etag === doc.etag && old.sha256 === doc.sha256 && old.bytes === doc.bytes, 'approved_metadata_changed');
    const id = doc.type === 'snapshot' ? doc.key.split('/').at(-1) : doc.id;
    const file = await savePrivate(directory, `backup/metadata/${id}.${doc.type}.json`, doc.raw);
    backup.metadata.push({ key: doc.key, etag: doc.etag, ...file });
  }
  requireFact(backup.metadata.length === 17, 'backup_metadata_count_mismatch');
  const quotaRow = rows.get('control/quota');
  requireFact(quotaRow, 'quota_missing');
  const quotaRaw = await store.read('control/quota', quotaRow, maximumMetadata);
  const quota = parseMetadata(quotaRaw);
  requireFact(['bytes', 'operations', 'routines', 'assets'].every(key => Number.isSafeInteger(quota[key]) && quota[key] >= 0)
    && quota.active && typeof quota.active === 'object' && !Array.isArray(quota.active), 'quota_invalid');
  report.quota = { bytes: quota.bytes, operations: quota.operations, routines: quota.routines, assets: quota.assets,
    fillers: quota.fillers ?? 0, activeUploads: Object.keys(quota.active).length, etag: quotaRow.etag,
    ledgerSha256: digest(quotaRaw), limitBytes: 5 * 1024 ** 3, refund: 'none; preserve conservative ledger' };
  const playwright = createRequire(resolve(root, 'package.json'))('@playwright/test');
  const browser = await playwright.chromium.launch({ headless: true });
  const replacements = [];
  try {
    for (const [index, approved] of inventory.assets.entries()) {
      const catalogDoc = documents.get(`assets/${approved.id}/catalog`);
      const catalog = catalogDoc?.value;
      requireFact(catalog && sameAsset(catalog.asset, approved) && approved.bytes <= MAX_SOURCE_BYTES, 'catalog_changed');
      const path = `backup/wav/${approved.id}.wav`;
      const file = await downloadAsset(store, rows, catalog, resolve(directory, path), 'assets');
      backup.assets.push({ id: approved.id, path, ...file });
      const uploadKey = `uploads/${approved.id}/head`;
      const uploadRow = rows.get(uploadKey);
      const stagedKeys = [...rows.keys()].filter(key => key.startsWith(`uploads/${approved.id}/`));
      if (stagedKeys.length) {
        requireFact(uploadRow && stagedKeys.length === catalog.chunks.length + 1, 'staging_layout_incomplete');
        const raw = await store.read(uploadKey, uploadRow, maximumMetadata);
        const upload = inspectUpload(parseMetadata(raw), catalog);
        const staged = await downloadAsset(store, rows, catalog, undefined, 'uploads');
        const uploadBackup = await saveJson(directory, `backup/metadata/${approved.id}.upload.json`, upload.head);
        backup.staging.push({ id: approved.id, key: uploadKey, etag: uploadRow.etag, originalHeadSha256: digest(raw),
          originalHeadBytes: raw.length, backup: uploadBackup, sourcePath: path, ...upload, head: undefined, ...staged });
      } else backup.staging.push({ id: approved.id, present: false, bytes: 0 });
      const handle = await open(resolve(directory, path), 'r');
      const prefix = Buffer.alloc(65536);
      const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
      await handle.close();
      const source = inspectWav(prefix.subarray(0, prefixRead.bytesRead), file.bytes);
      requireFact(Math.abs(source.duration - approved.durationSeconds) <= 1 / 48000, 'source_duration_changed');
      const sourceProbe = await probe(resolve(directory, path));
      requireFact(sourceProbe.streams.length === 1 && sourceProbe.streams[0].codec_name === 'pcm_s16le'
        && sourceProbe.streams[0].channels === source.channels && Number(sourceProbe.streams[0].sample_rate) === 48000
        && sourceProbe.chapters.length === 0 && await decodedFrames(resolve(directory, path), source.channels) === source.frames,
      'source_full_decode_mismatch');
      const outputId = randomUUID();
      const outputPath = `candidate/m4a/${outputId}.m4a`;
      await native('ffmpeg', conversionArguments(resolve(directory, path), resolve(directory, outputPath)));
      await chmod(resolve(directory, outputPath), 0o600);
      const output = await hashFile(resolve(directory, outputPath));
      requireFact(output.bytes >= 44 && output.bytes <= MAX_OUTPUT_BYTES, 'output_size_limit');
      const metadata = await probe(resolve(directory, outputPath));
      const stream = metadata.streams[0];
      requireFact(metadata.streams.length === 1 && stream.codec_type === 'audio' && stream.codec_name === 'aac'
        && stream.profile === 'LC' && Number(stream.sample_rate) === 48000 && stream.channels === source.channels
        && Number(stream.start_time) === 0 && metadata.chapters.length === 0, 'output_codec_mismatch');
      requireFact(Object.keys(metadata.format.tags ?? {}).every(key => ['major_brand', 'minor_version', 'compatible_brands', 'encoder'].includes(key))
        && Object.keys(stream.tags ?? {}).every(key => ['language', 'handler_name', 'vendor_id'].includes(key)), 'output_private_metadata');
      const browserResult = await browserDecode(browser, resolve(directory, outputPath), output);
      requireFact(browserResult.channels === source.channels && browserResult.sampleRate === 48000, 'browser_format_mismatch');
      const timeline = verifyTimeline(source.frames, await decodedFrames(resolve(directory, outputPath), source.channels),
        Number(stream.duration), browserResult.duration);
      requireFact(sameAsset({ id: approved.id, contentType: approved.contentType, ...await hashFile(resolve(directory, path)) }, approved),
        'source_backup_changed');
      const asset = { id: outputId, ...output, contentType: 'audio/mp4' };
      const catalogFile = await saveJson(directory, `candidate/catalogs/${outputId}.json`, await outputCatalog(resolve(directory, outputPath), asset));
      const result = { index: index + 1, source: catalog.asset, asset, sourcePath: path, outputPath, catalog: catalogFile,
        codec: 'AAC-LC', sampleRate: 48000, channels: source.channels, bitsPerSecond: Number(stream.bit_rate),
        targetBitsPerSecond: 256000, sourceDuration: source.duration, timeline, browser: browserResult,
        sourceHashUnchanged: true, volumeNormalization: false, complete: true };
      replacements.push(result);
      report.assets.push(result);
      await saveJson(directory, `candidate/${outputId}.verification.json`, result);
      console.log(JSON.stringify({ preparedAssetIndex: index + 1, total: 10, sourceBytes: file.bytes,
        outputBytes: output.bytes, duration: source.duration, nativePaddingFrames: timeline.nativePaddingFrames }));
    }
  } finally {
    await browser.close();
    await saveJson(directory, 'backup-progress.json', backup);
  }
  const freshRows = await listAll(store);
  const stableKeys = [...documents.keys(), ...backup.assets.flatMap(asset => asset.chunks.map(chunk => chunk.key)),
    ...backup.staging.flatMap(asset => asset.chunks ? [asset.key, ...asset.chunks.map(chunk => chunk.key)] : [])];
  for (const key of stableKeys) requireFact(freshRows.get(key)?.etag === rows.get(key)?.etag
    && freshRows.get(key)?.bytes === rows.get(key)?.bytes, 'cloud_changed_during_prepare');
  const freshScan = await scanReferences(store, freshRows, inventory, checks);
  requireFact(JSON.stringify(freshScan.summary.references) === JSON.stringify(scan.summary.references), 'references_changed_during_prepare');
  for (const [key, doc] of freshScan.documents) requireFact(documents.get(key)?.etag === doc.etag
    && documents.get(key)?.sha256 === doc.sha256, 'metadata_added_during_prepare');
  report.scan = { ...freshScan.summary, stableDuringObservedScan: true, atomicSnapshot: false };
  const planned = buildReplacement(current.value, replacements);
  const snapshotKey = `snapshots/${inventory.target.id}/${randomUUID()}`;
  const plannedDescription = describeMetadata(snapshotKey, planned.body);
  validateBody(plannedDescription, planned.body, checks);
  const newHead = { draft: { ...head.head.draft, key: snapshotKey, revision: 6 }, deleted: false,
    history: [{ revision: 6, draft: snapshotKey }] };
  describeMetadata(headKey, newHead);
  const newSnapshotFile = await saveJson(directory, 'candidate/snapshot.json', planned.body);
  const newHeadFile = await saveJson(directory, 'candidate/head.json', newHead);
  const permanentBytes = replacements.reduce((sum, asset) => sum + asset.asset.bytes, 0);
  const sourceBytes = backup.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const stagingBytes = backup.staging.reduce((sum, asset) => sum + asset.bytes, 0);
  const conservativeCharge = permanentBytes * 2 + replacements.length * 131072 + maximumMetadata;
  requireFact(quota.bytes + conservativeCharge <= 5 * 1024 ** 3, 'insufficient_quota_for_candidates');
  backup.complete = true;
  const manifest = await saveJson(directory, 'restore-manifest.json', backup);
  const plan = { schemaVersion: 1, mode: 'prepare-only', applyImplemented: false, cloudMutations: 0,
    routineId: inventory.target.id, expectedRevision: 5, expectedHeadEtag: head.etag, nextRevision: 6,
    published: false, locked: false, snapshotKey, headKey, snapshot: newSnapshotFile, head: newHeadFile,
    backup: manifest, entryMapping: planned.mapping, retireSnapshots: backup.metadata.filter(item => item.key.startsWith('snapshots/')),
    retireAssetIds: inventory.assets.map(asset => asset.id), quota: { conservativeAdditionalBytes: conservativeCharge,
      proposedLedgerBytes: quota.bytes + conservativeCharge, actualCandidatePermanentBytes: permanentBytes, refund: 0,
      reservation: 'Before any future writes: reread and validate the entire ledger, preserve active and all counters, CAS a separately reviewed positive reservation. Direct single-copy upload is not yet implemented.' },
    guard: { status: 'PARENT_REVIEW_REQUIRED_NOT_PAUSED',
      requirements: ['Independently reviewed enforceable ALL-writer freeze, covering legacy/new API writes, uploads/finalizers, library references and other admin tools; routine lock alone is insufficient.',
        'Obtain approval before changing any cloud setting. Drain/terminate in-flight writers and verify freeze across all instances; elapsed time alone is not proof.',
        'Under freeze recheck head ETag, all five snapshots, catalogs/chunks/staging, full namespace/reference scans and class pins; abort on unknown prefixes, changed metadata, new references or active/incomplete matching uploads.',
        'Rehash the local restore manifest, all backup files, candidate outputs and planned JSON against the independently reviewed plan hash.',
        'Reserve quota with CAS, upload only fresh immutable IDs with If-None-Match:*, download/hash/full-decode ALL new assets, then write the immutable revision-6 snapshot.',
        'Commit the head with If-Match against the exact approved revision-5 ETag. Preserve the index and all user content except entry IDs and media descriptors; no publication.',
        'Verify new head and cold preparation. Only then retire snapshots 1-5 with their ETags, rescan under the still-proven freeze, and delete exact unreferenced WAV catalogs/chunks and verified matching staging blobs with ETags.',
        'Recheck reference closure and new assets before ending freeze. On failure keep freeze, preserve backup and use a reviewed restore; never automatically resume or force-overwrite.'],
      blockers: ['cloud_writer_pause_not_reviewed_or_applied', 'cloud_apply_not_implemented',
        ...Object.keys(freshScan.summary.unknownPrefixes).map(() => 'unknown_blob_prefix'),
        ...(store.retention.versioning || store.retention.softDelete ? ['retained_versions_prevent_immediate_space_reclamation'] : [])] },
    compatibility: 'Additive history lists only revision 6; legacy head readers ignore history. New CloudDocuments resolves revision 6. Revisions 1-5 are intentionally retired, never rewritten.',
    billing: 'Reported bytes are current permanent and matching staging payloads, not a bill prediction. No application quota refund or reset is performed.' };
  const planFile = await saveJson(directory, 'migration-plan.json', plan);
  report.complete = true;
  report.applyReady = false;
  report.backup = manifest;
  report.plan = planFile;
  report.expectedHeadEtag = head.etag;
  report.totals = { sourceBytes, matchingStagingBytes: stagingBytes, candidateBytes: permanentBytes,
    permanentPayloadSavingBytes: sourceBytes - permanentBytes,
    permanentAndStagingPayloadSavingBytes: sourceBytes + stagingBytes - permanentBytes,
    sourceDurationSeconds: replacements.reduce((sum, asset) => sum + asset.sourceDuration, 0),
    metadataBackupBytes: backup.metadata.reduce((sum, item) => sum + item.bytes, 0),
    sourceFiles: backup.assets.length, snapshotFiles: 5, catalogFiles: 10 };
  const privateFiles = [manifest.path, planFile.path, ...backup.metadata.map(item => item.path),
    ...backup.assets.map(item => item.path), ...replacements.flatMap(item => [item.outputPath, item.catalog.path]),
    ...backup.staging.flatMap(item => item.backup ? [item.backup.path] : [])];
  const relativeFiles = privateFiles.map(path => relative(root, resolve(directory, path)));
  const ignored = await execute('git', ['check-ignore', '--no-index', '--', ...relativeFiles], { cwd: root });
  const ignoredPaths = new Set(ignored.stdout.trim().split(/\r?\n/));
  requireFact(relativeFiles.every(path => ignoredPaths.has(path)), 'private_file_not_ignored');
  for (const path of privateFiles) {
    const info = await stat(resolve(directory, path));
    requireFact(info.isFile(), 'backup_file_missing');
  }
  report.privacy = { gitIgnored: true, viteDenyPresent: true, cloudWrites: 0, originalUserFilesRead: 0,
    requestedFileMode: '0600', requestedDirectoryMode: '0700', filesystemAclCaveat: backup.filesystem,
    noScreenshotsTracesHarOrPrivateConsole: true };
}

async function main() {
  let directory;
  const report = { schemaVersion: 1, mode: 'prepare-only', startedAt: new Date().toISOString(),
    complete: false, applyReady: false, cloudMutations: 0, assets: [] };
  try {
    requestedMode(process.argv.slice(2));
    requireFact(/^migration-[a-z0-9-]{1,80}$/.test(process.env.MIGRATION_INVENTORY_NAME), 'inventory_name_required');
    const inventoryDirectory = resolve(root, 'local-media', process.env.MIGRATION_INVENTORY_NAME);
    const inventoryBytes = await readFile(resolve(inventoryDirectory, 'inventory.json'));
    const inventory = parseMetadata(inventoryBytes);
    const recommendation = parseMetadata(await readFile(resolve(inventoryDirectory, 'recommendation.json')));
    requireFact(inventory.complete === true && inventory.target.id === process.env.MIGRATION_ROUTINE_ID
      && inventory.target.name === process.env.MIGRATION_ROUTINE_NAME && recommendation.routine.id === inventory.target.id
      && recommendation.routine.expectedHeadEtag === inventory.target.headEtag
      && inventory.target.draftRevision === 5 && inventory.target.locked === false && inventory.target.publishedRevision === null
      && inventory.assets.length === 10 && inventory.totals.sourceBytes === 359162360, 'approval_inventory_mismatch');
    process.umask(0o077);
    directory = await privateDirectory(process.env.MIGRATION_REPORT_NAME);
    report.inputInventorySha256 = digest(inventoryBytes);
    report.recommendationCorrection = 'Fresh track-entry IDs required by immutable browser cache; original recommendation to preserve entry IDs is superseded.';
    const store = await connectReadOnly(inventory, process.env);
    await prepare(inventory, directory, store, report);
  } catch (error) {
    report.complete = false;
    report.applyReady = false;
    report.failure = { code: /^[a-z][a-z0-9_]{1,79}$/.test(error?.message) ? error.message : 'prepare_failed',
      ...(Number.isInteger(error?.statusCode) ? { status: error.statusCode } : {}) };
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  if (directory) await saveJson(directory, 'prepare-report.json', report);
  console.log(JSON.stringify({ complete: report.complete, applyReady: false, cloudMutations: 0,
    assetsPrepared: report.assets.length, totals: report.totals, failure: report.failure,
    report: directory ? `${relative(root, directory)}/prepare-report.json` : undefined }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('private_prepare_report_failed'); process.exitCode = 1; });
}

export async function reviewPrepared(reportName, inventoryName, environment = process.env, suffix = '') {
  requireFact([reportName, inventoryName].every(name => /^migration-[a-z0-9-]{1,80}$/.test(name)), 'private_directory_name_required');
  requireFact(suffix === '' || /^-[a-z0-9-]{1,20}$/.test(suffix), 'review_suffix_invalid');
  const directory = resolve(root, 'local-media', reportName);
  requireFact(await realpath(directory) === directory, 'private_path_escape');
  const load = async path => {
    const absolute = resolve(directory, path);
    requireFact(absolute.startsWith(`${directory}/`) && (await stat(absolute)).size <= maximumMetadata, 'private_json_limit');
    return parseMetadata(await readFile(absolute));
  };
  const report = await load('prepare-report.json');
  requireFact(report.complete && report.assets.length === 10 && report.cloudMutations === 0, 'prepare_not_complete');
  const scan = structuredClone(report.scan);
  for (const prefix of operationalPrefixes) if (scan.unknownPrefixes[prefix]) {
    scan.excludedContentCounts[prefix] = (scan.excludedContentCounts[prefix] ?? 0) + scan.unknownPrefixes[prefix];
    delete scan.unknownPrefixes[prefix];
  }
  scan.completeAllPrefixes = Object.keys(scan.unknownPrefixes).length === 0;
  scan.scopeCorrection = 'Known traffic rate-limit records excluded by path only; no operational record content read. Observations remain those of the original prepare scan, not a fresh cloud scan.';
  const manifest = await load(report.backup.path);
  const plan = await load(report.plan.path);
  const inventory = parseMetadata(await readFile(resolve(root, 'local-media', inventoryName, 'inventory.json')));
  const files = [report.backup, report.plan, ...manifest.metadata, ...manifest.assets,
    ...manifest.staging.flatMap(item => item.backup ? [item.backup] : []),
    ...report.assets.flatMap(item => [{ path: item.outputPath, ...item.asset }, item.catalog]), plan.snapshot, plan.head];
  for (const item of files) {
    const path = resolve(directory, item.path);
    requireFact(path.startsWith(`${directory}/`) && !item.path.includes('..') && !(await lstat(path)).isSymbolicLink(), 'private_path_escape');
    const actual = await hashFile(path);
    requireFact(actual.bytes === item.bytes && actual.sha256 === item.sha256, 'prepared_file_changed');
  }
  const paths = files.map(item => relative(root, resolve(directory, item.path)));
  const ignored = await execute('git', ['check-ignore', '--no-index', '--', ...paths], { cwd: root });
  const ignoredPaths = new Set(ignored.stdout.trim().split(/\r?\n/));
  requireFact(paths.every(path => ignoredPaths.has(path)), 'private_file_not_ignored');
  const retention = await readRetention(inventory, environment);
  const packetChecks = [];
  for (const item of report.assets) {
    const packet = JSON.parse(await native('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-select_streams', 'a:0', '-read_intervals', '%+#1', '-show_packets', '-of', 'json', resolve(directory, item.outputPath)]));
    const first = packet.packets?.[0];
    requireFact(packet.packets.length === 1 && first.pts === -1024
      && first.side_data_list?.some(side => side.side_data_type === 'Skip Samples' && side.skip_samples === 1024),
    'aac_priming_not_skipped');
    packetChecks.push({ index: item.index, firstPacketPts: first.pts, primingSamplesSkipped: 1024, audioStartsAtZero: true });
  }
  plan.retention = retention;
  plan.scan = scan;
  if (scan.completeAllPrefixes) plan.guard.blockers = plan.guard.blockers.filter(code => code !== 'unknown_blob_prefix');
  plan.guard.blockers = plan.guard.blockers.filter(code => code !== 'retained_versions_prevent_immediate_space_reclamation');
  if (retention.softDelete || retention.versioning) plan.guard.blockers.push('retained_versions_prevent_immediate_space_reclamation');
  const correctedPlan = await saveJson(directory, `migration-plan-reviewed${suffix}.json`, plan);
  const review = { schemaVersion: 1, complete: true, reviewedAt: new Date().toISOString(), applyReady: false,
    cloudMutations: 0, assetsPrepared: 10, verifiedFiles: files.length, backup: report.backup,
    plan: correctedPlan, retention, scan, packetChecks, totals: report.totals, expectedHeadEtag: report.expectedHeadEtag,
    privacy: report.privacy, staging: manifest.staging.map(item => ({ id: item.id, state: item.state ?? 'absent',
      bytes: item.bytes, expired: item.expired ?? null, ownerIdOmitted: item.ownerIdOmitted ?? null })),
    corrections: 'This review supersedes prior retention inference and the known traffic-prefix warning; adds explicit first-packet priming-skip verification. Earlier evidence is retained unchanged.',
    limitations: ['No cloud pause, upload, reference edit, deletion or quota mutation. Parent must review the all-writer freeze and implement/apply path separately.',
      'No physical iPhone/Bluetooth validation. Exact backup is local and not encrypted by this tool; mounted filesystem ACLs determine access.',
      'Original staging ownerId omitted to exclude account data; optional staging-head restore requires private ownerId input. WAVs, catalogs, routine head and all snapshots are exact-byte backups.'] };
  const receipt = await saveJson(directory, `final-review${suffix}.json`, review);
  return { ...review, receipt };
}

export function verifyPrivateIgnore() {
  const rules = readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/).map(line => line.trim());
  requireFact(rules.includes('local-media/') && rules.filter(line => line.startsWith('!'))
    .every(line => line === '!.env.example'), 'private_report_ignore_required');
  requireFact(readFileSync(resolve(root, 'frontend/vite.config.ts'), 'utf8').includes("'**/local-media/**'"), 'vite_private_deny_required');
}