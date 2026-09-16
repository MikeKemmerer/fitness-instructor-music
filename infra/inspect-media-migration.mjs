import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const hash = /^[a-f0-9]{64}$/;
const maximum = 1024 * 1024;
const types = new Set(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm']);
const execute = promisify(execFile);

function requireFact(condition, code = 'invalid_metadata') {
  if (!condition) throw new Error(code);
}

function record(value, required, optional = []) {
  requireFact(value && typeof value === 'object' && !Array.isArray(value));
  requireFact(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
  return value;
}

export function parseMetadata(bytes) {
  requireFact(bytes.length > 1 && bytes.length <= maximum, 'metadata_size_limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  requireFact(text.trimStart().startsWith('{'), 'metadata_not_object');
  const result = JSON.parse(text, (key, value) => {
    requireFact(!['__proto__', 'prototype', 'constructor'].includes(key), 'unsafe_metadata_key');
    requireFact(typeof value !== 'number' || Number.isFinite(value));
    return value;
  });
  requireFact(result && typeof result === 'object' && !Array.isArray(result));
  return result;
}

export function classify(key) {
  let match = /^(heads)\/([^/]+)$/.exec(key);
  if (match && identifier.test(match[2])) return { type: 'index', kind: 'routine', id: match[2] };
  match = /^(playlists|classes)\/index\/([^/]+)$/.exec(key);
  if (match && identifier.test(match[2])) return { type: 'index', kind: match[1] === 'classes' ? 'class' : 'playlist', id: match[2] };
  match = /^(routines|playlists|classes)\/([^/]+)\/head$/.exec(key);
  if (match && identifier.test(match[2])) return { type: 'head', kind: match[1] === 'classes' ? 'class' : match[1].slice(0, -1), id: match[2] };
  match = /^(snapshots|publications)\/([^/]+)\/([^/]+)$/.exec(key);
  if (match && identifier.test(match[2]) && identifier.test(match[3])) return { type: 'snapshot', kind: 'routine', id: match[2], published: match[1] === 'publications' };
  match = /^(playlists|classes)\/([^/]+)\/(snapshots|publications)\/([^/]+)$/.exec(key);
  if (match && identifier.test(match[2]) && identifier.test(match[4])) return { type: 'snapshot', kind: match[1] === 'classes' ? 'class' : 'playlist', id: match[2], published: match[3] === 'publications' };
  match = /^fillers\/(index|records)\/([^/]+)$/.exec(key);
  if (match && identifier.test(match[2])) return { type: match[1] === 'index' ? 'index' : 'filler', kind: 'filler', id: match[2] };
  match = /^assets\/([^/]+)\/catalog$/.exec(key);
  if (match && identifier.test(match[1])) return { type: 'catalog', id: match[1] };
  throw new Error('unrecognized_metadata_path');
}

function validRevision(value) { return Number.isSafeInteger(value) && value > 0; }

export function strongEtag(value) {
  requireFact(typeof value === 'string' && /^(?:0x[0-9a-f]+|"0x[0-9a-f]+")$/i.test(value), 'invalid_storage_etag');
  return value.startsWith('"') ? value : `"${value}"`;
}

function asset(value) {
  record(value, ['id', 'sha256', 'bytes', 'contentType']);
  requireFact(identifier.test(value.id) && hash.test(value.sha256) && Number.isSafeInteger(value.bytes)
    && value.bytes >= 44 && value.bytes <= 128 * maximum && types.has(value.contentType));
  return value;
}

function validatePointer(pointer, location, published) {
  record(pointer, ['key', 'revision', 'name', 'locked']);
  const path = classify(pointer.key);
  requireFact(path.type === 'snapshot' && path.kind === location.kind && path.id === location.id && path.published === published);
  requireFact(validRevision(pointer.revision) && typeof pointer.locked === 'boolean'
    && typeof pointer.name === 'string' && pointer.name.trim() && pointer.name.length <= 160);
}

function validateHead(value, location) {
  record(value, ['draft', 'deleted'], ['published', 'history']);
  requireFact(typeof value.deleted === 'boolean');
  validatePointer(value.draft, location, false);
  if (value.published) {
    validatePointer(value.published, location, true);
    requireFact(value.published.revision <= value.draft.revision);
  }
  if (Object.hasOwn(value, 'history')) {
    requireFact(Array.isArray(value.history) && value.history.length > 0 && value.history.length <= 128);
    let previous = 0;
    for (const link of value.history) {
      record(link, ['revision'], ['draft', 'published']);
      requireFact(validRevision(link.revision) && link.revision > previous && link.revision <= value.draft.revision && (link.draft || link.published));
      for (const kind of ['draft', 'published']) if (link[kind]) {
        const path = classify(link[kind]);
        requireFact(path.type === 'snapshot' && path.id === location.id && path.kind === location.kind && path.published === (kind === 'published'));
      }
      previous = link.revision;
    }
    requireFact(value.history.find(link => link.revision === value.draft.revision)?.draft === value.draft.key);
    if (value.published) requireFact(value.history.find(link => link.revision === value.published.revision)?.published === value.published.key);
  }
}

function state(entity, location) {
  requireFact(entity && entity.schemaVersion === 1 && entity.id === location.id && validRevision(entity.revision)
    && typeof entity.name === 'string' && entity.name.trim() && entity.name.length <= 160
    && typeof entity.locked === 'boolean' && entity.published === location.published);
}

function recording(value) {
  record(value, ['id', 'name', 'duration', 'asset']);
  requireFact(identifier.test(value.id) && typeof value.name === 'string' && value.name.trim()
    && Number.isFinite(value.duration) && value.duration > 0 && value.duration <= 360);
  asset(value.asset);
  return { asset: value.asset, duration: value.duration, role: 'filler', recordingId: value.id };
}

function filler(value) {
  requireFact(value && ['none', 'timed', 'hold'].includes(value.mode) && typeof value.sound === 'string');
  if (value.sound === 'recording') return [recording(value.recording)];
  requireFact(!value.recording && ['soft', 'bright', 'drums', 'lofi'].includes(value.sound));
  return [];
}

export function describeMetadata(key, value) {
  const location = classify(key);
  const result = { key, ...location, refs: [], pins: [] };
  if (location.type === 'index') {
    record(value, ['id']);
    requireFact(value.id === location.id);
  } else if (location.type === 'head') {
    validateHead(value, location);
    result.head = value;
  } else if (location.type === 'catalog') {
    record(value, ['asset', 'chunks']);
    asset(value.asset);
    requireFact(value.asset.id === location.id && Array.isArray(value.chunks)
      && value.chunks.length === Math.ceil(value.asset.bytes / (2 * maximum))
      && value.chunks.every(chunk => typeof chunk === 'string' && hash.test(chunk)));
    result.asset = value.asset;
    result.chunkCount = value.chunks.length;
  } else if (location.type === 'filler') {
    record(value, ['recording', 'archived']);
    requireFact(typeof value.archived === 'boolean' && value.recording?.id === location.id);
    result.archived = value.archived;
    result.refs.push(recording(value.recording));
  } else {
    const field = location.kind === 'class' ? 'setup' : location.kind;
    record(value, location.kind === 'class' ? ['setup'] : [field, 'media']);
    const entity = value[field];
    state(entity, location);
    result.entity = entity;
    result.revision = entity.revision;
    if (location.kind === 'class') {
      record(entity, ['schemaVersion', 'id', 'name', 'revision', 'locked', 'published', 'routine', 'crossfade'], ['walkIn', 'walkOut', 'before', 'after']);
      for (const slot of ['routine', 'walkIn', 'walkOut']) if (entity[slot]) {
        const pin = record(entity[slot], ['id', 'revision', 'published']);
        requireFact(identifier.test(pin.id) && validRevision(pin.revision) && typeof pin.published === 'boolean' && (!entity.published || pin.published));
        result.pins.push({ ...pin, kind: slot === 'routine' ? 'routine' : 'playlist', slot });
      }
      for (const slot of ['before', 'after']) if (entity[slot]) result.refs.push(...filler(entity[slot]));
    } else {
      requireFact(Array.isArray(entity.tracks) && entity.tracks.length <= 100);
      const ids = entity.tracks.map(track => track.id);
      requireFact(ids.every(id => typeof id === 'string' && identifier.test(id)) && new Set(ids).size === ids.length);
      record(value.media, ids);
      for (const track of entity.tracks) {
        requireFact(Number.isFinite(track.duration) && track.duration > 0 && track.duration <= 1200 && Array.isArray(track.cues));
        result.refs.push({ asset: asset(value.media[track.id]), duration: track.duration, role: 'song', entryId: track.id });
        if (track.after?.mode === 'custom') result.refs.push(...filler(track.after.filler));
        else requireFact(track.after === undefined || track.after?.mode === 'none');
      }
      if (location.kind === 'routine') result.refs.push(...filler(entity.filler));
    }
  }
  return result;
}

export async function azureJson(args) {
  try {
    const { stdout } = await execute('az', [...args, '--only-show-errors', '--output', 'json'], {
      encoding: 'utf8', maxBuffer: maximum, timeout: 60000,
      env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true', AZURE_CORE_LOG_LEVEL: 'critical' },
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error('azure_read_failed');
  }
}

export function validators() {
  const compiler = createRequire(resolve(root, 'package.json'))('typescript');
  const allowed = new Set(['api/src/validation.ts', 'api/src/errors.ts', 'shared/routine.ts', 'shared/class-plan.ts'].map(path => resolve(root, path)));
  const loaded = new Map();
  function load(filename) {
    requireFact(allowed.has(filename), 'validator_import_not_allowed');
    if (loaded.has(filename)) return loaded.get(filename).exports;
    const module = { exports: {} };
    loaded.set(filename, module);
    const compiled = compiler.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
      module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022,
    } });
    const localRequire = specifier => load(resolve(dirname(filename), `${specifier}.ts`));
    new Function('require', 'module', 'exports', compiled.outputText)(localRequire, module, module.exports);
    return module.exports;
  }
  return { ...load(resolve(root, 'api/src/validation.ts')), ...load(resolve(root, 'shared/class-plan.ts')) };
}

function validateContent(value, location, checks) {
  if (location.type === 'filler') checks.parseFillerRecording(value.recording);
  if (location.type !== 'snapshot') return;
  if (location.kind === 'routine') {
    const { id, revision, locked, published, ...content } = value.routine;
    checks.parseRoutineContent(content);
  } else if (location.kind === 'playlist') {
    requireFact(checks.validateMusicPlaylist(value.playlist).length === 0);
  } else {
    requireFact(checks.validateClassSetup(value.setup).length === 0);
    for (const slot of ['before', 'after']) if (value.setup[slot]) checks.parseFiller(value.setup[slot]);
  }
}

function options(environment) {
  const result = {
    subscription: environment.AZURE_SUBSCRIPTION_ID,
    resourceGroup: environment.AZURE_RESOURCE_GROUP,
    storage: environment.FIM_STORAGE_ACCOUNT_NAME,
    container: environment.FIM_STORAGE_CONTAINER,
    site: environment.SWA_NAME,
    hostname: environment.SWA_EXPECTED_HOSTNAME,
    routineName: environment.MIGRATION_ROUTINE_NAME,
    reportName: environment.MIGRATION_REPORT_NAME,
  };
  requireFact(/^[a-f0-9-]{36}$/.test(result.subscription) && /^[A-Za-z0-9_-]{1,90}$/.test(result.resourceGroup)
    && /^[a-z0-9]{3,24}$/.test(result.storage) && /^[a-z0-9-]{3,63}$/.test(result.container)
    && /^[a-z0-9-]{1,60}$/.test(result.site) && /^[a-z0-9.-]+\.azurestaticapps\.net$/.test(result.hostname)
    && typeof result.routineName === 'string' && result.routineName.trim() && result.routineName.length <= 160
    && /^migration-[a-z0-9-]{1,80}$/.test(result.reportName), 'explicit_target_required');
  requireFact(readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/).includes('local-media/'), 'private_report_ignore_required');
  return result;
}

async function connect(settings, report) {
  const account = await azureJson(['account', 'show', '--subscription', settings.subscription, '--query', '{id:id,name:name,state:state}']);
  requireFact(account.id === settings.subscription && account.name === 'Visual Studio Enterprise Subscription' && account.state === 'Enabled', 'subscription_guard_failed');
  const base = `/subscriptions/${settings.subscription}/resourceGroups/${settings.resourceGroup}/providers`;
  const storage = await azureJson(['storage', 'account', 'show', '--subscription', settings.subscription,
    '--resource-group', settings.resourceGroup, '--name', settings.storage,
    '--query', '{id:id,name:name,kind:kind,sku:sku.name,allowBlobPublicAccess:allowBlobPublicAccess,https:enableHttpsTrafficOnly,tls:minimumTlsVersion,endpoint:primaryEndpoints.blob}']);
  requireFact(storage.id === `${base}/Microsoft.Storage/storageAccounts/${settings.storage}` && storage.name === settings.storage
    && storage.kind === 'StorageV2' && storage.sku === 'Standard_LRS' && storage.allowBlobPublicAccess === false
    && storage.https === true && storage.tls === 'TLS1_2'
    && storage.endpoint === `https://${settings.storage}.blob.core.windows.net/`, 'storage_guard_failed');
  const site = await azureJson(['staticwebapp', 'show', '--subscription', settings.subscription, '--resource-group', settings.resourceGroup,
    '--name', settings.site, '--query', '{id:id,name:name,hostname:defaultHostname,sku:sku.name}']);
  requireFact(site.id === `${base}/Microsoft.Web/staticSites/${settings.site}` && site.name === settings.site
    && site.hostname === settings.hostname && site.sku === 'Free', 'site_guard_failed');
  report.guards = { subscription: account, storage, site };
  const sdk = createRequire(resolve(root, 'api/package.json'))('@azure/storage-blob');
  let key = await azureJson(['storage', 'account', 'keys', 'list', '--subscription', settings.subscription,
    '--resource-group', settings.resourceGroup, '--account-name', settings.storage, '--query', '[0].value']);
  requireFact(typeof key === 'string' && /^[A-Za-z0-9+/]{80,100}={0,2}$/.test(key), 'credential_capture_failed');
  const credential = new sdk.StorageSharedKeyCredential(settings.storage, key);
  key = undefined;
  const container = new sdk.BlobServiceClient(storage.endpoint, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: 12000 }, loggingOptions: { logger: () => {} },
  }).getContainerClient(settings.container);
  const access = await container.getAccessPolicy({ abortSignal: AbortSignal.timeout(15000) });
  requireFact(!access.blobPublicAccess && Array.isArray(access.signedIdentifiers), 'container_not_private');
  report.guards.container = { name: settings.container, publicAccess: false, storedAccessPolicyCount: access.signedIdentifiers.length };
  return container;
}

export async function inspect(settings, report) {
  const checks = await validators();
  const container = await connect(settings, report);
  const deadline = AbortSignal.timeout(10 * 60 * 1000);
  const signal = () => AbortSignal.any([deadline, AbortSignal.timeout(15000)]);
  const documents = new Map();
  const prefixes = ['heads/', 'routines/', 'snapshots/', 'publications/', 'playlists/', 'classes/', 'fillers/'];
  const inventories = new Map();
  let calls = 1;
  let totalBytes = 0;
  const count = () => { requireFact(++calls <= 4096, 'request_budget_exceeded'); report.dataRequests = calls; };

  async function listing(prefix) {
    const rows = new Map();
    const cursors = new Set();
    const iterator = container.listBlobsFlat({ prefix, abortSignal: signal() }).byPage({ maxPageSize: 128 });
    for (let pageIndex = 0; pageIndex < 64; pageIndex++) {
      count();
      const page = await iterator.next();
      if (page.done) return rows;
      const items = page.value.segment.blobItems;
      requireFact(items.length <= 128, 'listing_page_limit');
      for (const item of items) {
        requireFact(item.name.startsWith(prefix) && !rows.has(item.name) && !item.deleted && !item.snapshot && !item.versionId, 'listing_not_complete');
        const location = classify(item.name);
        requireFact(location.type !== 'catalog' && Number.isSafeInteger(item.properties.contentLength)
          && item.properties.contentLength > 1 && item.properties.contentLength <= maximum && typeof item.properties.etag === 'string', 'metadata_size_limit');
        rows.set(item.name, { etag: strongEtag(item.properties.etag), bytes: item.properties.contentLength });
        requireFact(rows.size <= 4096, 'listing_total_limit');
      }
      const cursor = page.value.continuationToken;
      if (!cursor) return rows;
      requireFact(items.length > 0 && !cursors.has(cursor), 'listing_cursor_invalid');
      cursors.add(cursor);
    }
    throw new Error('listing_page_budget_exceeded');
  }

  async function metadata(key, expected) {
    if (documents.has(key)) return documents.get(key);
    requireFact(documents.size < 4096, 'metadata_count_limit');
    const location = classify(key);
    count();
    const response = await container.getBlobClient(key).download(0, maximum + 1, {
      abortSignal: signal(), ...(expected ? { conditions: { ifMatch: expected.etag } } : {}),
    });
    const stream = response.readableStreamBody;
    const parts = [];
    let length = 0;
    try {
      requireFact(stream && response.contentLength > 1 && response.contentLength <= maximum && response.etag, 'metadata_size_limit');
      for await (const part of stream) {
        length += part.length;
        requireFact(length <= maximum, 'metadata_size_limit');
        parts.push(part);
      }
    } finally { stream?.destroy(); }
    const etag = strongEtag(response.etag);
    requireFact(length === response.contentLength && (!expected || (length === expected.bytes && etag === expected.etag)), 'metadata_changed');
    totalBytes += length;
    requireFact(totalBytes <= 64 * maximum, 'metadata_byte_budget_exceeded');
    const bytes = Buffer.concat(parts, length);
    const value = parseMetadata(bytes);
    validateContent(value, location, checks);
    const description = { ...describeMetadata(key, value), etag, bytes: length,
      metadataSha256: createHash('sha256').update(bytes).digest('hex') };
    documents.set(key, description);
    return description;
  }

  const firstIndexes = await listing('heads/');
  inventories.set('heads/', firstIndexes);
  requireFact(firstIndexes.size <= 512, 'routine_index_limit');
  for (const [key, expected] of firstIndexes) {
    const index = await metadata(key, expected);
    await metadata(`routines/${index.id}/head`);
  }
  const candidates = [...documents.values()].filter(doc => doc.type === 'head' && doc.kind === 'routine' && !doc.head.deleted);
  const matches = candidates.filter(doc => doc.head.draft.name === settings.routineName);
  report.match = { requestedName: settings.routineName, mode: 'exact-case-sensitive', activeMatches: matches.length };
  if (matches.length !== 1) {
    report.match.candidates = candidates.map(doc => ({ id: doc.id, name: doc.head.draft.name }));
    throw new Error(matches.length ? 'ambiguous_routine_name' : 'routine_name_not_found');
  }
  const target = matches[0];
  const draft = await metadata(target.head.draft.key);
  const publication = target.head.published ? await metadata(target.head.published.key) : undefined;
  report.target = { id: target.id, name: target.head.draft.name, draftRevision: target.head.draft.revision,
    locked: target.head.draft.locked, publishedRevision: target.head.published?.revision ?? null,
    headEtag: target.etag, legacyHeadWithoutHistory: !target.head.history };
  for (const prefix of prefixes.slice(1)) inventories.set(prefix, await listing(prefix));
  requireFact([...inventories.values()].reduce((sum, rows) => sum + rows.size, 0) <= 4096, 'metadata_count_limit');
  for (const rows of inventories.values()) for (const [key, expected] of rows) {
    const previous = documents.get(key);
    requireFact(!previous || (previous.etag === expected.etag && previous.bytes === expected.bytes), 'metadata_changed');
    await metadata(key, expected);
  }
  for (const kind of ['routine', 'playlist', 'class', 'filler']) {
    requireFact([...documents.values()].filter(doc => doc.type === 'index' && doc.kind === kind).length <= 512, 'index_count_limit');
  }
  const heads = new Map([...documents.values()].filter(doc => doc.type === 'head').map(doc => [`${doc.kind}/${doc.id}`, doc]));
  const linked = new Map();
  for (const head of heads.values()) {
    const indexKey = head.kind === 'routine' ? `heads/${head.id}` : `${head.kind === 'class' ? 'classes' : 'playlists'}/index/${head.id}`;
    requireFact(documents.has(indexKey), 'head_missing_index');
    const links = [...(head.head.history ?? [])];
    for (const variant of ['draft', 'published']) if (head.head[variant]) {
      const pointer = head.head[variant];
      const body = documents.get(pointer.key);
      requireFact(body?.revision === pointer.revision && body.entity.name === pointer.name && body.entity.locked === pointer.locked, 'head_snapshot_mismatch');
      links.push({ revision: pointer.revision, [variant]: pointer.key });
    }
    for (const link of links) for (const variant of ['draft', 'published']) if (link[variant]) {
      const body = documents.get(link[variant]);
      requireFact(body?.revision === link.revision, 'missing_history_snapshot');
      linked.set(body.key, head);
    }
  }
  for (const index of [...documents.values()].filter(doc => doc.type === 'index')) {
    if (index.kind === 'filler') requireFact(documents.has(`fillers/records/${index.id}`), 'filler_index_missing_record');
    else requireFact(heads.has(`${index.kind}/${index.id}`), 'index_missing_head');
  }
  for (const doc of documents.values()) {
    if (doc.type === 'snapshot') {
      const head = heads.get(`${doc.kind}/${doc.id}`);
      doc.current = head?.head.draft.key === doc.key ? 'draft' : head?.head.published?.key === doc.key ? 'published' : null;
      doc.retained = linked.has(doc.key);
      doc.deleted = head?.head.deleted ?? null;
    }
    for (const pin of doc.pins) {
      const head = heads.get(`${pin.kind}/${pin.id}`);
      const variant = pin.published ? 'published' : 'draft';
      const pointerKey = head?.head[variant]?.revision === pin.revision ? head.head[variant].key : head?.head.history?.find(link => link.revision === pin.revision)?.[variant];
      const body = documents.get(pointerKey);
      requireFact(body && body.revision === pin.revision && body.published === pin.published, 'unresolvable_class_pin');
      doc.refs.push(...body.refs.map(ref => ({ ...ref, via: { ...pin } })));
    }
  }
  const currentBodies = [draft, publication].filter(Boolean);
  const selected = new Map();
  for (const body of currentBodies) for (const ref of body.refs) if (ref.role === 'song' && ref.asset.contentType === 'audio/wav') {
    const previous = selected.get(ref.asset.id);
    requireFact(!previous || (previous.duration === ref.duration && JSON.stringify(previous.asset) === JSON.stringify(ref.asset)), 'inconsistent_asset_descriptor');
    selected.set(ref.asset.id, ref);
  }
  const equalAsset = (first, second) => ['id', 'bytes', 'sha256', 'contentType'].every(key => first[key] === second[key]);
  report.assets = [];
  for (const [id, ref] of selected) {
    const catalog = await metadata(`assets/${id}/catalog`);
    requireFact(equalAsset(catalog.asset, ref.asset), 'catalog_descriptor_mismatch');
    const references = [];
    for (const doc of documents.values()) {
      const matched = doc.refs.filter(entry => entry.asset.id === id);
      for (const entry of matched) requireFact(equalAsset(entry.asset, ref.asset), 'reference_descriptor_mismatch');
      if (matched.length) references.push({ key: doc.key, kind: doc.kind, id: doc.id, revision: doc.revision ?? null,
        published: doc.published ?? false, current: doc.current ?? null, retained: doc.retained ?? false,
        deleted: doc.deleted ?? null, archived: doc.archived ?? null, occurrences: matched.length,
        songOccurrences: matched.filter(entry => entry.role === 'song').length,
        fillerOccurrences: matched.filter(entry => entry.role === 'filler').length,
        viaPins: matched.filter(entry => entry.via).map(entry => entry.via) });
    }
    const expectedBytes = Math.ceil(ref.duration * 256000 / 8);
    report.assets.push({ ...ref.asset, durationSeconds: ref.duration,
      descriptorBitrate: ref.asset.bytes * 8 / ref.duration, sourceCodecConfidence: 'WAV descriptor only; media not downloaded or probed',
      expectedAacBytesAt256k: expectedBytes, estimatedSavingBytes: ref.asset.bytes - expectedBytes,
      catalogEtag: catalog.etag, chunkCount: catalog.chunkCount,
      draftOccurrences: draft.refs.filter(entry => entry.role === 'song' && entry.asset.id === id).length,
      publishedOccurrences: publication?.refs.filter(entry => entry.role === 'song' && entry.asset.id === id).length ?? 0, references });
  }
  for (const [prefix, previous] of inventories) {
    const fresh = await listing(prefix);
    requireFact(fresh.size === previous.size && [...previous].every(([key, row]) => fresh.get(key)?.etag === row.etag && fresh.get(key)?.bytes === row.bytes), 'metadata_changed_during_scan');
  }
  for (const doc of documents.values()) if (doc.type === 'head' || doc.type === 'catalog') {
    count();
    const current = await container.getBlobClient(doc.key).getProperties({ abortSignal: signal(), conditions: { ifMatch: doc.etag } });
    requireFact(strongEtag(current.etag) === doc.etag && current.contentLength === doc.bytes, 'metadata_changed_during_scan');
  }
  const summarize = body => body ? { revision: body.revision, trackCount: body.entity.tracks.length,
    wavEntries: body.refs.filter(ref => ref.role === 'song' && ref.asset.contentType === 'audio/wav').length,
    uniqueSongAssets: new Set(body.refs.filter(ref => ref.role === 'song').map(ref => ref.asset.id)).size,
    customFillerRefs: body.refs.filter(ref => ref.role === 'filler').map(ref => ({ assetId: ref.asset.id, contentType: ref.asset.contentType })),
    builtinFiller: body.entity.filler.sound === 'recording' ? null : body.entity.filler.sound } : null;
  report.target.draft = summarize(draft);
  report.target.published = summarize(publication);
  report.totals = { uniqueWavSongAssets: selected.size, sourceBytes: report.assets.reduce((sum, entry) => sum + entry.bytes, 0),
    expectedAacBytesAt256k: report.assets.reduce((sum, entry) => sum + entry.expectedAacBytesAt256k, 0),
    estimatedSavingBytes: report.assets.reduce((sum, entry) => sum + entry.estimatedSavingBytes, 0) };
  const referenced = [...documents.values()].filter(doc => doc.refs.some(ref => selected.has(ref.asset.id)));
  report.referenceSummary = {
    currentTargetDrafts: referenced.filter(doc => doc.kind === 'routine' && doc.id === target.id && doc.current === 'draft').length,
    currentTargetPublications: referenced.filter(doc => doc.kind === 'routine' && doc.id === target.id && doc.current === 'published').length,
    oldTargetDraftSnapshots: referenced.filter(doc => doc.kind === 'routine' && doc.id === target.id && !doc.current && !doc.published).length,
    oldTargetPublicationSnapshots: referenced.filter(doc => doc.kind === 'routine' && doc.id === target.id && !doc.current && doc.published).length,
    retainedOldTargetSnapshots: referenced.filter(doc => doc.kind === 'routine' && doc.id === target.id && !doc.current && doc.retained).length,
    currentOtherDocuments: referenced.filter(doc => !(doc.kind === 'routine' && doc.id === target.id) && doc.current).map(doc => ({ kind: doc.kind, id: doc.id, revision: doc.revision, published: doc.published, deleted: doc.deleted })),
    otherHistoricalDocuments: referenced.filter(doc => !(doc.kind === 'routine' && doc.id === target.id) && doc.type === 'snapshot' && !doc.current).length,
    fillerRecords: referenced.filter(doc => doc.type === 'filler').length,
    classPinnedSnapshots: referenced.filter(doc => doc.kind === 'class' && doc.pins.length).length,
  };
  report.metadataInventory = [...documents.values()].map(doc => ({ key: doc.key, type: doc.type, kind: doc.kind, id: doc.id,
    revision: doc.revision, published: doc.published, etag: doc.etag, bytes: doc.bytes, sha256: doc.metadataSha256,
    current: doc.current, retained: doc.retained, deleted: doc.deleted }));
  report.scan = { knownPrefixes: prefixes, metadataDocuments: documents.size, metadataBytes: totalBytes,
    countsByPrefix: Object.fromEntries([...inventories].map(([prefix, rows]) => [prefix, rows.size])),
    completeKnownMetadata: true, stableDuringObservedScan: true, atomicSnapshot: false,
    excluded: ['audio chunks', 'uploads and staging records', 'sessions', 'throttles', 'account configuration', 'unknown prefixes', 'Azure deleted blobs and service versions'],
    sourceMediaVerified: false, privateMetadataBackupCreated: false };
  report.plan = { cloudWritesPerformed: 0, mediaBytesDownloaded: 0, deletionAllowed: false,
    blockers: [ ...(target.head.draft.locked ? ['explicit_named_unlock_confirmation_required'] : []),
      ...(publication ? ['publish_new_revision_without_overwriting_existing_publication'] : []),
      ...(referenced.some(doc => doc.type === 'snapshot' && (!doc.current || doc.published)) ? ['explicit_history_retirement_decision_required'] : []),
      ...(report.referenceSummary.currentOtherDocuments.length || report.referenceSummary.fillerRecords ? ['other_references_must_be_preserved'] : []),
      'media_download_conversion_write_approval_required', 'verified_private_backup_required_before_destructive_work',
      'write_quiescence_or_reference_retirement_tombstone_required', 'rescan_and_etag_compare_required_at_commit'],
    conversion: { codec: 'AAC-LC', container: 'M4A', bitrateTarget: 256000, sampleRate: 48000,
      preserveChannels: true, volumeNormalization: false, preserveCuesOrderAndSavedGains: true, newImmutableAssetIds: true },
    customFillers: 'preserve unchanged', existingPreparedClasses: 'never mutate', quotaRefund: 'not automatic; no quota writes authorized' };
  report.complete = true;
}

async function main() {
  let settings;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), mode: 'read-only-metadata-inventory', complete: false };
  try {
    settings = options(process.env);
    await inspect(settings, report);
  } catch (error) {
    const message = typeof error?.message === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(error.message) ? error.message : 'inventory_failed';
    report.failure = { code: message, ...(Number.isInteger(error?.statusCode) ? { status: error.statusCode } : {}) };
    report.deletionAllowed = false;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  if (settings) {
    const directory = resolve(root, 'local-media', settings.reportName);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(directory, 'inventory.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ complete: report.complete, failure: report.failure, match: report.match,
    target: report.target, totals: report.totals, referenceSummary: report.referenceSummary, scan: report.scan,
    blockers: report.plan?.blockers, report: settings ? `local-media/${settings.reportName}/inventory.json` : null }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('inventory_report_failed'); process.exitCode = 1; });
}