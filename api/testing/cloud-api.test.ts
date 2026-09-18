import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import type { ContainerClient } from '@azure/storage-blob';
import { allRoutineTracks, newRoutine, type FillerRecording } from '../../shared/routine';
import type { CloudAsset, CloudAudioPage, CloudRoutine } from '../../shared/cloud-contract';
import type { CloudMusicPlaylist, RevisionReference } from '../../shared/class-plan';
import { CloudAuth, derivePassword } from '../src/cloud/auth';
import { ApiError, LIMITS, loadConfig, parsePasswordHash, type Account } from '../src/cloud/config';
import { AzureBlobStore, BlobConflict, encode, readJson, type BlobStore, type StoredBlob } from '../src/cloud/store';
import { CloudApi, boundedBody, type ApiRequest } from '../src/cloud/http';
import { CloudMedia, MEDIA_TYPES, parseAsset, validateSignature } from '../src/cloud/media';
import { CloudRoutines, revisionHeader } from '../src/cloud/routines';
import { QuotaBudget } from '../src/cloud/quota';
import { CloudFillers } from '../src/cloud/fillers';
import { HEAD_BYTES, HISTORY_LIMIT } from '../src/cloud/documents';
import type { CloudClassSetup, ResolvedClassSetup } from '../src/cloud/plans';
import { parseRoutineContent } from '../src/validation';
import { LIBRARY_SCAN_LIMIT } from '../src/cloud/library';
import { AssetAdmission, GATE_BYTES } from '../src/cloud/admission';
import { MANAGED_PAGE_KEYS, metadataRevision } from '../src/cloud/library-management';
import { LibraryReferences, REFERENCE_LIMITS } from '../src/cloud/library-references';

vi.mock('@azure/functions', () => ({ app: { http: vi.fn() } }));

describe('unified strict content', () => {
  const content = () => {
    const { id, revision, locked, published, ...value } = newRoutine();
    value.tracks = [{ id: 'main', title: 'Synthetic', duration: 60, firstBeat: 0, cues: [], bodyArea: '', gain: 1.5 }];
    value.sequence = { crossfade: 2, walkIn: { name: 'Arrival', tracks: [{ ...value.tracks[0]!, id: 'arrival' }] },
      before: { mode: 'hold', seconds: 0, bpm: 100, sound: 'soft' } };
    return value;
  };
  it('accepts detached schema two phases and unknown song BPM without changing legacy gains', () => {
    const value = content();
    expect(parseRoutineContent(value)).toEqual(value);
    expect(parseRoutineContent(value).tracks[0]).not.toHaveProperty('bpm');
    const legacy = { ...value, schemaVersion: 1 };
    delete legacy.sequence;
    expect(parseRoutineContent(legacy)).toEqual(legacy);
  });
  it.each(['', null, 0, 221, '100'])('rejects invalid supplied BPM %s', bpm => {
    const value = content();
    Object.assign(value.tracks[0]!, { bpm });
    expect(() => parseRoutineContent(value)).toThrow();
  });
  it('rejects duplicate phase IDs, phase cues, forged fields, global overflow and count cues without BPM', () => {
    const duplicate = content();
    duplicate.sequence!.walkIn!.tracks[0]!.id = 'main';
    const phaseCue = content();
    phaseCue.sequence!.walkIn!.tracks[0]!.cues = [{ id: 'cue', note: 'Cue', anchor: { kind: 'timestamp', seconds: 1 } }];
    const forged = content();
    Object.assign(forged.sequence!.before!, { analysis: { bpm: 120 } });
    const overflow = content();
    overflow.tracks = Array.from({ length: 100 }, (_, index) => ({ ...overflow.tracks[0]!, id: `main-${index}` }));
    const count = content();
    count.tracks[0]!.cues = [{ id: 'cue', note: 'Cue', anchor: { kind: 'count', count: 2 } }];
    for (const value of [duplicate, phaseCue, forged, overflow, count, { ...content(), schemaVersion: 1 }]) {
      expect(() => parseRoutineContent(value)).toThrow();
    }
  });
  it('strictly validates timestamps without guessing unknown BPM or accepting malformed sequence objects', () => {
    for (const savedAt of [-1, 1.5, null, '', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseRoutineContent({ ...content(), savedAt })).toThrow();
    }
    for (const sequence of [null, [], { crossfade: 0, walkIn: { name: 'Empty', tracks: [] } },
      { crossfade: 0, before: { mode: 'timed', seconds: 1, bpm: 100, sound: 'soft' } }]) {
      expect(() => parseRoutineContent({ ...content(), sequence })).toThrow();
    }
    const value = content();
    value.tracks[0]!.bpm = 100;
    expect(parseRoutineContent(value).tracks[0]!.bpm).toBe(100);
  });
});

class FakeBlobStore implements BlobStore {
  readonly blobs = new Map<string, StoredBlob>();
  sequence = 0;
  async verifyPrivate(): Promise<void> {}
  async get(key: string, maximum: number): Promise<StoredBlob | null> {
    const blob = this.blobs.get(key);
    if (!blob) return null;
    if (blob.bytes.length > maximum) throw new Error('oversized fixture');
    return { bytes: Buffer.from(blob.bytes), etag: blob.etag };
  }
  async put(key: string, bytes: Buffer, expected: string | null): Promise<string> {
    const old = this.blobs.get(key);
    if (expected === null ? !!old : old?.etag !== expected) throw new BlobConflict();
    const etag = `"${++this.sequence}"`;
    this.blobs.set(key, { bytes: Buffer.from(bytes), etag });
    return etag;
  }
  async delete(key: string, expected: string): Promise<void> {
    if (this.blobs.get(key)?.etag !== expected) throw new BlobConflict();
    this.blobs.delete(key);
  }
  async list(prefix: string, limit: number, cursor?: string) {
    const keys = [...this.blobs.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    return { keys: keys.slice(start, start + limit), cursor: keys.length > start + limit ? String(start + limit) : undefined };
  }
}

let passwordHash: string;
beforeAll(async () => {
  const salt = Buffer.alloc(16, 7);
  passwordHash = `scrypt$32768$8$3$${salt.toString('hex')}$${(await derivePassword('synthetic-test-password', salt)).toString('hex')}`;
});

function fixture() {
  const accounts: Account[] = [
    { id: 'owner', username: 'owner', passwordHash, role: 'owner', enabled: true, authVersion: 1 },
    { id: 'editor', username: 'editor', passwordHash, role: 'editor', enabled: true, authVersion: 1 },
    { id: 'player', username: 'player', passwordHash, role: 'player', enabled: true, authVersion: 1 },
  ];
  const env = () => ({ FIM_ORIGIN: 'https://example.invalid',
    FIM_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${Buffer.alloc(64).toString('base64')};EndpointSuffix=core.windows.net`,
    FIM_STORAGE_CONTAINER: 'private-media', FIM_ACCOUNTS_JSON: JSON.stringify(accounts) });
  const store = new FakeBlobStore();
  let now = 1900000000000;
  const auth = new CloudAuth(store, env, () => now);
  const loginHeaders = new Headers({ origin: env().FIM_ORIGIN });
  const login = async (username = 'owner') => {
    const result = await auth.login(loginHeaders, { username, password: 'synthetic-test-password' });
    return { result, headers: new Headers({ origin: env().FIM_ORIGIN,
      cookie: result.setCookie.split(';')[0]!, 'x-csrf-token': result.session.csrfToken }) };
  };
  return { store, auth, accounts, env, login, loginHeaders, advance: (ms: number) => { now += ms; } };
}

function wav(bytes = 2048): Buffer {
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(bytes, 40);
  return buffer;
}

const hashBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function adts(repetitions = 4): Buffer {
  return Buffer.concat(Array.from({ length: repetitions }, () => Buffer.from('fff1508001bffc211004608c1c', 'hex')));
}

function ebml(id: string, payload: Buffer): Buffer {
  let length = 1;
  while (payload.length >= 2 ** (7 * length) - 1) length++;
  const size = Buffer.alloc(length);
  size.writeUIntBE(payload.length, 0, length);
  size[0] = size[0]! | (1 << (8 - length));
  return Buffer.concat([Buffer.from(id, 'hex'), size, payload]);
}

function webmTrack(codec = 'A_VORBIS', options: { type?: number; channels?: number; rate?: number; extra?: Buffer; number?: number } = {}): Buffer {
  const rate = Buffer.alloc(8);
  rate.writeDoubleBE(options.rate ?? 48000);
  return ebml('ae', Buffer.concat([
    ebml('d7', Buffer.from([options.number ?? 1])), ebml('73c5', Buffer.from([1])),
    ebml('83', Buffer.from([options.type ?? 2])), ebml('86', Buffer.from(codec)),
    ebml('e1', Buffer.concat([ebml('b5', rate), ebml('9f', Buffer.from([options.channels ?? 2]))])),
    options.extra ?? Buffer.alloc(0),
  ]));
}

function webm(tracks = webmTrack(), options: { unknownSegment?: boolean; beforeTracks?: Buffer; clusterBytes?: number; docType?: string } = {}): Buffer {
  const header = ebml('1a45dfa3', Buffer.concat([
    Buffer.from('4286810142f7810142f2810442f38108', 'hex'),
    ebml('4282', Buffer.from(options.docType ?? 'webm')), Buffer.from('4287810442858102', 'hex'),
  ]));
  const segment = Buffer.concat([options.beforeTracks ?? Buffer.alloc(0), ebml('1654ae6b', tracks),
    ebml('1f43b675', Buffer.concat([Buffer.from('e78100', 'hex'),
      ebml('a3', Buffer.concat([Buffer.from('81000080', 'hex'), Buffer.alloc(options.clusterBytes ?? 16)]))]))]);
  return Buffer.concat([header, options.unknownSegment
    ? Buffer.concat([Buffer.from('1853806701ffffffffffffff', 'hex'), segment]) : ebml('18538067', segment)]);
}

function atom(kind: string, payload: Buffer = Buffer.alloc(0), extended = false): Buffer {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + payload.length);
  header.write(kind, 4, 'latin1');
  if (extended) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function mp4(...leading: Buffer[]): Buffer {
  return Buffer.concat([...leading, atom('ftyp', Buffer.from('4d3441200000000069736f6d6d703432', 'hex')), atom('mdat', Buffer.alloc(16))]);
}

function signature(bytes: Buffer, contentType: string, assetBytes = bytes.length): void {
  validateSignature(bytes, { id: 'structural-fixture', bytes: assetBytes, sha256: hashBytes(bytes), contentType });
}

async function stageAudio(media: CloudMedia, headers: Headers, bytes = wav(), contentType = 'audio/wav') {
  const upload = await media.initiate(headers, { bytes: bytes.length, sha256: hashBytes(bytes), contentType });
  for (let index = 0; index < upload.chunkCount; index++) {
    await media.putChunk(headers, upload.id, index, bytes.subarray(index * LIMITS.chunkBytes, (index + 1) * LIMITS.chunkBytes));
  }
  return upload;
}

async function uploadAudio(media: CloudMedia, headers: Headers, bytes = wav(), contentType = 'audio/wav'): Promise<CloudAsset> {
  const upload = await stageAudio(media, headers, bytes, contentType);
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await media.complete(headers, upload.id);
    if (!('pending' in result)) return result;
  }
  throw new Error('fixture completion did not converge');
}

function routine(asset?: CloudAsset): CloudRoutine {
  const routine = newRoutine();
  if (asset) routine.tracks.push({ id: 'entry-one', title: '<literal song>', duration: 60, bpm: 120, firstBeat: 0, bodyArea: '',
    cues: [{ id: 'cue-one', note: '=literal note', anchor: { kind: 'timestamp', seconds: 1 }, beep: true }] });
  return { routine, media: asset ? { 'entry-one': asset } : {} };
}

function request(path: string, method: string, headers: Headers, input?: unknown): ApiRequest {
  const nextHeaders = new Headers(headers);
  const bytes = input === undefined ? null : Buffer.isBuffer(input) ? input : encode(input);
  if (input !== undefined && !Buffer.isBuffer(input)) nextHeaders.set('content-type', 'application/json');
  return { url: `https://example.invalid/api/${path}`, method, headers: nextHeaders,
    body: bytes === null ? null : new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

function atRevision(headers: Headers, revision: number): Headers {
  const result = new Headers(headers);
  result.set('if-match', `"${revision}"`);
  return result;
}

async function activateLibrary(store: BlobStore): Promise<void> {
  await store.put('control/library-admission-v1', encode({ version: 1, exclusiveWriters: true }), null);
}

async function legacyArchive(fillers: CloudFillers, id: string): Promise<void> {
  const stored = await fillers.record(id);
  await fillers.store.put(`fillers/records/${id}`, encode({ ...stored.value, archived: true }), stored.etag);
}

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, pause: async () => { enter(); await released; } };
}

async function managementFixture(activate = true) {
  const context = fixture();
  const api = new CloudApi(context.store, context.env, context.auth.now);
  const other = new CloudApi(context.store, context.env, context.auth.now);
  const { headers } = await context.login();
  const asset = await uploadAudio(api.media, headers);
  if (activate) await activateLibrary(context.store);
  return { ...context, api, other, headers, asset };
}

function pin(value: { id: string; revision: number; published: boolean }): RevisionReference {
  return { id: value.id, revision: value.revision, published: value.published };
}

function musicPlaylist(asset: CloudAsset): CloudMusicPlaylist {
  const source = routine(asset);
  return { playlist: { schemaVersion: 1, id: randomUUID(), name: 'Synthetic arrival music', revision: 1, locked: false, published: false,
    tracks: source.routine.tracks.map(track => ({ ...track, cues: [] })) }, media: source.media };
}

function classPlan(source: RevisionReference): CloudClassSetup {
  return { setup: { schemaVersion: 1, id: randomUUID(), name: 'Synthetic teaching setup', revision: 1, locked: false,
    published: false, routine: source, crossfade: 2 } };
}

type PlanBody = CloudMusicPlaylist | CloudClassSetup;
const planState = (body: PlanBody) => 'setup' in body ? body.setup : body.playlist;

async function planFixture(role = 'owner') {
  const context = fixture();
  const api = new CloudApi(context.store, context.env, context.auth.now);
  const { headers } = await context.login(role);
  const asset = await uploadAudio(api.media, headers);
  const draft = await api.routines.create(headers, routine(asset));
  const publication = await api.routines.mutate(atRevision(headers, 1), draft.routine.id, 'publish');
  return { ...context, api, headers, asset, draft, publication };
}

async function unifiedFixture() {
  const context = fixture();
  const api = new CloudApi(context.store, context.env, context.auth.now);
  const { headers } = await context.login();
  const assets: CloudAsset[] = [];
  for (let index = 0; index < 5; index++) assets.push(await uploadAudio(api.media, headers, wav(2048 + index * 2)));
  const recording = await api.routines.fillers.create(headers, { name: 'Synthetic announcement', duration: 30, asset: assets[3]! });
  const input = routine(assets[0]!);
  const track = input.routine.tracks[0]!;
  delete track.bpm;
  track.gain = 1.5;
  track.after = { mode: 'custom', filler: { mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording }, crossfade: 3 };
  input.routine.sequence = { crossfade: 4,
    walkIn: { name: 'Arrival', tracks: [{ ...track, id: 'arrival', cues: [] }], source: { id: 'provenance-only', revision: 9, published: true } },
    walkOut: { name: 'Departure', tracks: [{ ...track, id: 'departure', cues: [] }] },
    before: { mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording, gain: 1.5 },
    after: { mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording } };
  delete input.routine.sequence.walkIn!.tracks[0]!.after;
  delete input.routine.sequence.walkOut!.tracks[0]!.after;
  input.media.arrival = assets[1]!;
  input.media.departure = assets[2]!;
  return { ...context, api, headers, assets, recording, input };
}

describe('unified routine HTTP aggregate', () => {
  it('round-trips all phases in ONE head with server stamps, atomic lock and immutable publication', async () => {
    const { api, store, auth, headers, input, advance } = await unifiedFixture();
    input.routine.savedAt = 42;
    const original = structuredClone(input);
    const assetBytes = [...store.blobs].filter(([key]) => key.startsWith('assets/'));
    const created = await api.handle(request('routines', 'POST', headers, input));
    expect(created.status).toBe(201);
    const body: CloudRoutine = JSON.parse(created.body.toString());
    expect(body).toEqual({ ...input, routine: { ...input.routine, savedAt: auth.now() } });
    expect([...store.blobs.keys()].filter(key => /^routines\/[^/]+\/head$/.test(key))).toHaveLength(1);
    expect([...store.blobs.keys()].some(key => key.startsWith('classes/'))).toBe(false);
    expect((await api.routines.list(headers, false)).routines[0]!.savedAt).toBe(auth.now());
    advance(1000);
    body.routine.savedAt = Number.MAX_SAFE_INTEGER;
    body.routine.sequence!.walkIn!.name = 'Saved arrival';
    const locked = await api.routines.mutate(atRevision(headers, 1), body.routine.id, 'lock', body);
    expect(locked.routine).toMatchObject({ savedAt: auth.now(), locked: true, revision: 2 });
    await expect(api.routines.mutate(atRevision(headers, 2), body.routine.id, 'save', locked)).rejects.toMatchObject({ status: 423 });
    const unlocked = await api.routines.mutate(atRevision(headers, 2), body.routine.id, 'unlock');
    advance(1000);
    const published = await api.routines.mutate(atRevision(headers, 3), body.routine.id, 'publish');
    expect(published.routine.savedAt).toBe(unlocked.routine.savedAt);
    expect(published.routine.sequence).toEqual(locked.routine.sequence);
    expect(await api.routines.get(headers, body.routine.id, false, 1)).toEqual({ ...original, routine: { ...original.routine, savedAt: auth.now() - 2000 } });
    expect([...store.blobs].filter(([key]) => key.startsWith('assets/'))).toEqual(assetBytes);
    expect(input).toEqual(original);
  });

  it('duplicates every entry and cue ID while retaining provenance, recording IDs, gains and asset bytes', async () => {
    const { api, store, headers, input, advance, auth } = await unifiedFixture();
    const original = await api.routines.create(headers, input);
    const mediaBytes = [...store.blobs].filter(([key]) => key.startsWith('assets/') || key.startsWith('uploads/'));
    advance(2000);
    const copy = await api.routines.duplicate(headers, original.routine.id, false);
    expect(copy.routine).toMatchObject({ revision: 1, locked: false, published: false, savedAt: auth.now() });
    expect(copy.routine.id).not.toBe(original.routine.id);
    const originals = allRoutineTracks(original.routine);
    const tracks = allRoutineTracks(copy.routine);
    const originalIds = originals.map(track => track.id);
    expect(new Set(tracks.map(track => track.id)).size).toBe(3);
    expect(Object.keys(copy.media).sort()).toEqual(tracks.map(track => track.id).sort());
    for (const [index, track] of tracks.entries()) {
      expect(originalIds).not.toContain(track.id);
      expect(track.gain).toBe(1.5);
      expect(copy.media[track.id]).toEqual(original.media[originals[index]!.id]);
      expect(track).not.toHaveProperty('bpm');
    }
    expect(copy.routine.tracks[0]!.cues[0]!.id).not.toBe(original.routine.tracks[0]!.cues[0]!.id);
    expect(copy.routine.sequence!.walkIn!.source).toEqual(original.routine.sequence!.walkIn!.source);
    expect(copy.routine.sequence!.before).toEqual(original.routine.sequence!.before);
    expect([...store.blobs].filter(([key]) => key.startsWith('assets/') || key.startsWith('uploads/'))).toEqual(mediaBytes);
  });

  it.each(['missing-media', 'extra-media', 'forged-media', 'duplicate-id', 'phase-cue', 'phase-after', 'forged-recording', 'forged-source'])('rejects %s without creating a head', async defect => {
    const { api, headers, input, store } = await unifiedFixture();
    const arrival = input.routine.sequence!.walkIn!;
    if (defect === 'missing-media') delete input.media.arrival;
    if (defect === 'extra-media') input.media.extra = input.media.arrival!;
    if (defect === 'forged-media') input.media.arrival = { ...input.media.arrival!, sha256: '0'.repeat(64) };
    if (defect === 'duplicate-id') arrival.tracks[0]!.id = input.routine.tracks[0]!.id;
    if (defect === 'phase-cue') arrival.tracks[0]!.cues = input.routine.tracks[0]!.cues;
    if (defect === 'phase-after') arrival.tracks[0]!.after = { mode: 'none' };
    if (defect === 'forged-recording') input.routine.sequence!.before!.recording!.duration++;
    if (defect === 'forged-source') Object.assign(arrival.source!, { role: 'owner' });
    const quota = store.blobs.get('control/quota');
    expect((await api.handle(request('routines', 'POST', headers, input))).status).toBe(400);
    expect(store.blobs.has(api.routines.headKey(input.routine.id))).toBe(false);
    const before = JSON.parse(quota!.bytes.toString());
    const after = (await readJson<Record<string, number>>(store, 'control/quota'))!.value;
    expect(after).toMatchObject({ routines: before.routines, fillers: before.fillers, assets: before.assets, active: before.active });
    expect(after.bytes).toBeGreaterThanOrEqual(before.bytes);
    expect([...store.blobs.keys()].some(key => key.startsWith('snapshots/'))).toBe(false);
    for (const key of store.blobs.keys()) {
      if (key.startsWith('library/gates/')) expect((await new AssetAdmission(store).read(key.slice('library/gates/'.length))).value.claims).toEqual([]);
    }
  });

  it('authorizes the exact complete published phase/filler union and preserves old publication playback', async () => {
    const { api, headers, input, assets, login } = await unifiedFixture();
    const player = await login('player');
    await api.routines.create(headers, input);
    const published = await api.routines.mutate(atRevision(headers, 1), input.routine.id, 'publish');
    const path = `routines/${input.routine.id}`;
    expect((await api.handle(request(path, 'GET', player.headers))).status).toBe(403);
    expect((await api.handle(request(path, 'PUT', atRevision(player.headers, 2), published))).status).toBe(403);
    const draft = await api.routines.get(headers, input.routine.id, false);
    delete draft.routine.sequence;
    delete draft.routine.tracks[0]!.after;
    delete draft.media.arrival;
    delete draft.media.departure;
    await api.routines.mutate(atRevision(headers, 2), input.routine.id, 'save', draft);
    await api.routines.mutate(atRevision(headers, 3), input.routine.id, 'publish');
    expect(await api.routines.get(player.headers, input.routine.id, true, 2)).toEqual(published);
    for (const [index, asset] of assets.entries()) {
      const suffix = `routineId=${input.routine.id}&revision=2`;
      expect((await api.handle(request(`media/${asset.id}?${suffix}`, 'GET', player.headers))).status).toBe(index < 4 ? 200 : 403);
      if (index > 0) expect((await api.handle(request(`media/${asset.id}?routineId=${input.routine.id}`, 'GET', player.headers))).status).toBe(403);
    }
    const bytes = await api.handle(request(`media/${assets[1]!.id}/chunks/0?routineId=${input.routine.id}&revision=2`, 'GET', player.headers));
    expect(bytes.status).toBe(200);
    expect(hashBytes(bytes.body as Buffer)).toBe(assets[1]!.sha256);
  });

  it.each(['save', 'lock'] as const)('rejects incoming v1 %s over a v2 head before quota or snapshot changes', async action => {
    const { api, store, headers, input } = await unifiedFixture();
    const body = await api.routines.create(headers, input);
    const before = new Map(store.blobs);
    body.routine.schemaVersion = 1;
    delete body.routine.sequence;
    delete body.media.arrival;
    delete body.media.departure;
    await expect(api.routines.mutate(atRevision(headers, 1), body.routine.id, action, body))
      .rejects.toMatchObject({ status: 409, code: 'routine_schema_downgrade' });
    expect(store.blobs).toEqual(before);
  });

  it('resolves competing full save/lock operations through one CAS without exposing the losing aggregate', async () => {
    const { api, store, auth, headers, input } = await unifiedFixture();
    const original = await api.routines.create(headers, input);
    const first = structuredClone(original);
    const second = structuredClone(original);
    first.routine.sequence!.walkIn!.name = 'First contender';
    second.routine.sequence!.walkIn!.name = 'Second contender';
    const peer = new CloudRoutines(store, auth, api.media);
    const results = await Promise.allSettled([
      api.routines.mutate(atRevision(headers, 1), original.routine.id, 'save', first),
      peer.mutate(atRevision(headers, 1), original.routine.id, 'lock', second),
    ]);
    const success = results.filter(result => result.status === 'fulfilled');
    expect(success).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 412 } });
    expect(await api.routines.get(headers, original.routine.id, false, 2)).toEqual(success[0]!.value);
    await expect(api.routines.get(headers, original.routine.id, false, 3)).rejects.toMatchObject({ status: 404 });
  });

  it('reads unstamped legacy snapshots/classes unchanged and stamps only a subsequent content save', async () => {
    const { api, headers, input, store, auth } = await unifiedFixture();
    input.routine.schemaVersion = 1;
    delete input.routine.sequence;
    delete input.media.arrival;
    delete input.media.departure;
    const created = await api.routines.create(headers, input);
    const head = await api.routines.head(created.routine.id);
    const stored = store.blobs.get(head.value.draft.key)!;
    const legacy = structuredClone(created);
    delete legacy.routine.savedAt;
    delete head.value.draft.savedAt;
    await store.put(head.value.draft.key, encode(legacy), stored.etag);
    await store.put(api.routines.headKey(created.routine.id), encode(head.value), head.etag);
    expect(await api.routines.get(headers, created.routine.id, false)).toEqual(legacy);
    expect((await api.routines.list(headers, false)).routines[0]).not.toHaveProperty('savedAt');
    const setup = await api.classes.create(headers, classPlan(pin(legacy.routine)));
    expect((await api.classes.prepare(headers, setup.setup.id, false)).routine).toEqual(legacy);
    legacy.routine.schemaVersion = 2;
    legacy.routine.savedAt = 1;
    const saved = await api.routines.mutate(atRevision(headers, 1), legacy.routine.id, 'save', legacy);
    expect(saved.routine).toMatchObject({ schemaVersion: 2, savedAt: auth.now() });
    expect((await api.routines.get(headers, legacy.routine.id, false, 1)).routine).not.toHaveProperty('savedAt');
  });

  it.each([1, 2] as const)('preserves schema %s playlist state with omitted BPM and legacy gain', async schemaVersion => {
    const { api, headers, assets } = await unifiedFixture();
    const body = musicPlaylist(assets[0]!);
    body.playlist.schemaVersion = schemaVersion;
    delete body.playlist.tracks[0]!.bpm;
    body.playlist.tracks[0]!.gain = 1.5;
    expect(await api.playlists.create(headers, body)).toEqual(body);
    expect((await api.playlists.mutate(atRevision(headers, 1), body.playlist.id, 'publish')).playlist)
      .toEqual({ ...body.playlist, revision: 2, published: true });
  });
});

describe('filler analysis HTTP metadata', () => {
  it('rejects non-record analysis inputs without creating metadata', async () => {
    const { api, headers, recording, store } = await unifiedFixture();
    for (const input of [null, [], 100, 'analysis']) {
      expect((await api.handle(request(`fillers/${recording.id}/analysis`, 'PUT', headers, input))).status).toBe(400);
    }
    expect(store.blobs.has(`fillers/analysis/${recording.id}`)).toBe(false);
  });

  it('uses conditional analysis writes and preserves the winner on contention', async () => {
    const { api, headers, recording, auth, store } = await unifiedFixture();
    const peer = new CloudFillers(store, auth, api.media);
    const analysis = { bpm: 100, analyzer: 'Synthetic', sha256: recording.asset.sha256 };
    const results = await Promise.allSettled([
      api.routines.fillers.putAnalysis(headers, recording.id, analysis),
      peer.putAnalysis(headers, recording.id, { ...analysis, bpm: 110 }),
    ]);
    const successes = results.filter(result => result.status === 'fulfilled');
    expect(successes).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'analysis_conflict' } });
    expect(await api.routines.fillers.getAnalysis(headers, recording.id)).toEqual(successes[0]!.value);
  });

  it('reserves quota and rechecks author identity before committing analysis', async () => {
    const { api, headers, recording, store, accounts } = await unifiedFixture();
    const path = `fillers/${recording.id}/analysis`;
    const analysis = { bpm: 100, analyzer: 'Synthetic', sha256: recording.asset.sha256 };
    const quota = (await readJson<Record<string, unknown>>(store, 'control/quota'))!;
    await store.put('control/quota', encode({ ...quota.value, bytes: LIMITS.quotaBytes - 4095 }), quota.etag);
    expect((await api.handle(request(path, 'PUT', headers, analysis))).status).toBe(507);
    expect(store.blobs.has(`fillers/analysis/${recording.id}`)).toBe(false);
    await store.put('control/quota', encode(quota.value), store.blobs.get('control/quota')!.etag);
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      const etag = await put(key, bytes, expected);
      if (key === 'control/quota') accounts[0]!.authVersion++;
      return etag;
    });
    expect((await api.handle(request(path, 'PUT', headers, analysis))).status).toBe(401);
    expect(store.blobs.has(`fillers/analysis/${recording.id}`)).toBe(false);
    expect((await readJson<{ bytes: number }>(store, 'control/quota'))!.value.bytes).toBe(Number(quota.value.bytes) + 4096);
  });

  it('returns null then separate hash-bound metadata, preserving archived recording identity and bytes', async () => {
    const { api, headers, recording, store, login } = await unifiedFixture();
    const path = `fillers/${recording.id}/analysis`;
    const original = new Map([...store.blobs].filter(([key]) => key.startsWith('assets/') || key.startsWith('fillers/')));
    const empty = await api.handle(request(path, 'GET', headers));
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.body.toString())).toEqual({ analysis: null });
    const editor = await login('editor');
    const analysis = { bpm: 112.5, confidence: 0, analyzer: 'Synthetic fixture v1', sha256: recording.asset.sha256 };
    const result = await api.handle(request(path, 'PUT', editor.headers, analysis));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString())).toEqual({ analysis });
    expect(result.headers['cache-control']).toContain('no-store');
    for (const [key, blob] of original) expect(store.blobs.get(key)).toEqual(blob);
    await legacyArchive(api.routines.fillers, recording.id);
    const archived = await api.handle(request(path, 'GET', headers));
    expect(archived.status).toBe(200);
    expect(JSON.parse(archived.body.toString())).toEqual({ analysis });
    expect(await api.routines.fillers.get(headers, recording.id)).toEqual(recording);
    const updated = await api.handle(request(path, 'PUT', headers, { bpm: 100, analyzer: 'Manual', sha256: recording.asset.sha256 }));
    expect(updated.status).toBe(200);
    expect(JSON.parse(updated.body.toString()).analysis).not.toHaveProperty('confidence');
  });

  it.each([{ bpm: '' }, { bpm: null }, { bpm: 39 }, { bpm: 221 }, { confidence: -0.1 }, { confidence: 1.1 },
    { confidence: null }, { analyzer: '' }, { analyzer: 'x'.repeat(161) }, { sha256: '0'.repeat(64) }, { duration: 30 }])('rejects malformed analysis %j without metadata writes', async change => {
    const { api, headers, recording, store } = await unifiedFixture();
    const analysis = { bpm: 100, analyzer: 'Synthetic', sha256: recording.asset.sha256, ...change };
    const quota = store.blobs.get('control/quota');
    expect((await api.handle(request(`fillers/${recording.id}/analysis`, 'PUT', headers, analysis))).status).toBe(400);
    expect(store.blobs.has(`fillers/analysis/${recording.id}`)).toBe(false);
    expect(store.blobs.get('control/quota')).toEqual(quota);
  });

  it('enforces session, author role, CSRF, origin, exact methods/query, missing recording and catalog hash', async () => {
    const { api, headers, recording, login, store } = await unifiedFixture();
    const path = `fillers/${recording.id}/analysis`;
    const analysis = { bpm: 100, analyzer: 'Synthetic', sha256: recording.asset.sha256 };
    const player = await login('player');
    for (const method of ['GET', 'PUT']) {
      expect((await api.handle(request(path, method, player.headers, method === 'PUT' ? analysis : undefined))).status).toBe(403);
      expect((await api.handle(request(path, method, new Headers({ origin: 'https://example.invalid', 'x-ms-client-principal': 'forged' }), method === 'PUT' ? analysis : undefined))).status).toBe(401);
    }
    for (const field of ['origin', 'x-csrf-token']) {
      const invalid = new Headers(headers);
      invalid.set(field, 'forged');
      expect((await api.handle(request(path, 'PUT', invalid, analysis))).status).toBe(403);
    }
    expect((await api.handle(request(`${path}?revision=1`, 'GET', headers))).status).toBe(400);
    expect((await api.handle(request(path, 'POST', headers, analysis))).status).toBe(404);
    expect((await api.handle(request('fillers/missing/analysis', 'GET', headers))).status).toBe(404);
    const key = `assets/${recording.asset.id}/catalog`;
    const catalog = (await readJson<{ asset: CloudAsset; chunks: string[] }>(store, key))!;
    catalog.value.asset.sha256 = '0'.repeat(64);
    await store.put(key, encode(catalog.value), catalog.etag);
    expect((await api.handle(request(path, 'PUT', headers, analysis))).status).toBe(503);
  });
});

describe('uploaded audio management HTTP (synthetic Blob store)', () => {
  it('lists every completed upload with truthful revision-zero metadata, including song/filler overlap', async () => {
    const { api, headers, asset, store } = await managementFixture();
    const recording = await api.routines.fillers.create(headers, { name: 'Immutable loop', duration: 20, asset });
    await stageAudio(api.media, headers, wav(4096));
    const get = vi.spyOn(store, 'get');
    const songs = await api.handle(request('library/songs', 'GET', headers));
    expect(songs.status).toBe(200);
    expect(JSON.parse(String(songs.body))).toEqual({ items: [{ id: asset.id, kind: 'song', asset,
      metadata: { revision: 0, title: '', artist: '' } }] });
    const fillers = await api.handle(request('library/fillers', 'GET', headers));
    expect(JSON.parse(String(fillers.body))).toEqual({ items: [{ id: recording.id, kind: 'filler', asset, recording,
      metadata: { revision: 0, title: recording.name, artist: '', duration: 20 } }] });
    expect(get.mock.calls.some(([key]) => key.includes('/chunks/'))).toBe(false);
    expect(songs.headers['cache-control']).toContain('private, no-store');
  });

  it('edits future presentation with metadata CAS without mutating saved or published snapshots', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    const draft = await api.routines.create(headers, routine(asset));
    await api.routines.mutate(atRevision(headers, 1), draft.routine.id, 'publish');
    const snapshots = [...store.blobs].filter(([key]) => /^(snapshots|publications)\//.test(key));
    const path = `library/songs/${asset.id}/metadata`;
    const initial = await api.handle(request(path, 'GET', headers));
    expect(initial.headers.etag).toBe('"0"');
    expect(JSON.parse(String(initial.body))).toEqual({ metadata: { revision: 0, title: '<literal song>', artist: '', duration: 60, bpm: 120 } });
    const changed = await api.handle(request(path, 'PUT', atRevision(headers, 0), { title: '<literal new title>', artist: 'Artist', bpm: 99.5 }));
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).toBe('"1"');
    expect((await other.handle(request(path, 'PUT', atRevision(headers, 0), { title: 'Stale', artist: '' }))).status).toBe(412);
    const page = await api.library.list(headers);
    expect(page.items[0]).toMatchObject({ title: '<literal new title>', bpm: 99.5, duration: 60 });
    await other.managed.put(atRevision(headers, 1), 'song', asset.id, { title: '', artist: '' });
    expect((await api.library.list(headers)).items[0]).not.toHaveProperty('bpm');
    for (const [key, value] of snapshots) expect(store.blobs.get(key)).toEqual(value);
  });

  it('accepts intake exactly once, preserves it through edits and never claims independent measurement', async () => {
    const { api, headers, asset } = await managementFixture();
    const path = `library/songs/${asset.id}`;
    const result = await api.handle(request(`${path}/intake`, 'PUT', atRevision(headers, 0), { filename: 'Original.wav', duration: 1200 }));
    expect(result.status).toBe(200);
    expect(JSON.parse(String(result.body))).toEqual({ metadata: { revision: 1, title: '', artist: '', filename: 'Original.wav', duration: 1200 } });
    expect((await api.handle(request(`${path}/intake`, 'PUT', atRevision(headers, 0), { filename: 'Other.wav', duration: 1 }))).status).toBe(412);
    await api.managed.put(atRevision(headers, 1), 'song', asset.id, { title: 'Future title', artist: 'Known', bpm: 40 });
    expect((await api.managed.metadata(headers, 'song', asset.id)).metadata).toEqual({ revision: 2, title: 'Future title', artist: 'Known', bpm: 40,
      filename: 'Original.wav', duration: 1200 });
    expect((await api.handle(request(`${path}/metadata`, 'PUT', atRevision(headers, 2), { title: '', artist: '', filename: 'forged' }))).status).toBe(400);
    expect((await api.handle(request('library/songs/missing/intake', 'PUT', atRevision(headers, 0), { filename: 'Unknown.wav', duration: 5 }))).status).toBe(404);
  });

  it.each([{ filename: '../audio.wav', duration: 1 }, { filename: 'C:\\audio.wav', duration: 1 }, { filename: '.', duration: 1 },
    { filename: 'x'.repeat(301), duration: 1 }, { filename: 'valid.wav', duration: 0 }, { filename: 'valid.wav', duration: 1201 },
    { filename: 'valid.wav', duration: '10' }, { filename: 'valid.wav', duration: null }, { filename: 'valid.wav', duration: 1, title: 'extra' }])(
    'rejects invalid intake %j before metadata persistence', async input => {
      const { api, headers, asset, store } = await managementFixture();
      expect((await api.handle(request(`library/songs/${asset.id}/intake`, 'PUT', atRevision(headers, 0), input))).status).toBe(400);
      expect(store.blobs.has(`library/metadata/song/${asset.id}`)).toBe(false);
    });

  it.each([{ title: 'x'.repeat(301), artist: '' }, { title: '', artist: 'x'.repeat(301) }, { title: '', artist: '', bpm: null },
    { title: '', artist: '', bpm: 39 }, { title: '', artist: '', bpm: 221 }, { title: '', artist: '', bpm: '100' },
    { title: '' }, { title: '', artist: '', revision: 0 }])('rejects strict metadata input %j', async input => {
    const { api, headers, asset } = await managementFixture();
    expect((await api.handle(request(`library/songs/${asset.id}/metadata`, 'PUT', atRevision(headers, 0), input))).status).toBe(400);
  });

  it('requires canonical quoted metadata revisions, accepts bounds and rejects oversized JSON', async () => {
    const { api, headers, asset } = await managementFixture();
    const path = `library/songs/${asset.id}/metadata`;
    expect((await api.handle(request(path, 'PUT', headers, { title: '', artist: '' }))).status).toBe(428);
    for (const header of ['0', '"00"', '-1', 'W/"0"', '*', '"9007199254740992"']) expect(() => metadataRevision(header)).toThrow();
    expect(metadataRevision('"0"')).toBe(0);
    expect((await api.handle(request(path, 'PUT', atRevision(headers, 0), { title: 'x'.repeat(300), artist: 'y'.repeat(300), bpm: 220 }))).status).toBe(200);
    expect((await api.handle(request(path, 'PUT', atRevision(headers, 1), { title: 'x'.repeat(5000), artist: '' }))).status).toBe(413);
    expect((await api.handle(request(`library/songs/${asset.id}`, 'DELETE', atRevision(headers, 0)))).status).toBe(412);
  });

  it('denies anonymous, spoofed and player access; retains Origin, CSRF, strict methods and queries', async () => {
    const { api, headers, asset, login } = await managementFixture();
    const player = (await login('player')).headers;
    const editor = (await login('editor')).headers;
    const path = `library/songs/${asset.id}`;
    for (const [route, method, input] of [['library/songs', 'GET', undefined], [`${path}/metadata`, 'GET', undefined],
      [`${path}/usage`, 'GET', undefined], [`${path}/metadata`, 'PUT', { title: '', artist: '' }],
      [`${path}/intake`, 'PUT', { filename: 'Synthetic.wav', duration: 10 }], [path, 'DELETE', undefined]] as const) {
      for (const denied of [new Headers({ origin: 'https://example.invalid' }),
        new Headers({ origin: 'https://example.invalid', 'x-ms-client-principal': 'owner' })]) {
        expect((await api.handle(request(route, method, denied, input))).status).toBe(401);
      }
      expect((await api.handle(request(route, method, atRevision(player, 0), input))).status).toBe(403);
    }
    expect((await api.handle(request('library/songs', 'GET', editor))).status).toBe(200);
    for (const field of ['origin', 'x-csrf-token']) {
      const denied = atRevision(headers, 0);
      denied.set(field, 'forged');
      expect((await api.handle(request(path, 'DELETE', denied))).status).toBe(403);
    }
    for (const route of ['library/songs?cursor=', 'library/songs?cursor=a&cursor=b', 'library/songs?limit=999',
      `${path}/metadata?cursor=a`, `${path}/usage?cursor=`, `${path}?force=true`]) {
      expect((await api.handle(request(route, route.includes('force') ? 'DELETE' : 'GET', atRevision(headers, 0)))).status).toBe(400);
    }
    for (const [route, method] of [['library/songs', 'POST'], [`${path}/usage`, 'PUT'], [`${path}/metadata`, 'DELETE'],
      [`${path}/intake`, 'GET'], [`${path}/metadata/extra`, 'GET'], ['library/other', 'GET'], [path, 'HEAD']]) {
      expect((await api.handle(request(route!, method!, headers))).status).toBe(404);
    }
    expect((await api.handle(request(path, 'DELETE', atRevision(headers, 0), {}))).status).toBe(400);
    expect((await api.handle(request(`${path}/metadata`, 'GET', headers, {}))).status).toBe(400);
  });

  it('keeps filler descriptors immutable, enforces filler intake bounds, and tombstones without physical deletion', async () => {
    const { api, headers, asset, store } = await managementFixture();
    const recording = await api.routines.fillers.create(headers, { name: 'Original name', duration: 25, asset });
    const original = store.blobs.get(`fillers/records/${recording.id}`);
    expect((await api.handle(request(`library/fillers/${recording.id}/intake`, 'PUT', atRevision(headers, 0), { filename: 'Loop.wav', duration: 361 }))).status).toBe(400);
    await api.managed.put(atRevision(headers, 0), 'filler', recording.id, { title: 'Future display', artist: 'Artist', bpm: 100 });
    expect(store.blobs.get(`fillers/records/${recording.id}`)).toEqual(original);
    expect((await api.managed.list(headers, 'filler')).items[0]).toMatchObject({ recording,
      metadata: { revision: 1, title: 'Future display', artist: 'Artist', bpm: 100, duration: 25 } });
    const remove = vi.spyOn(store, 'delete');
    expect(await api.managed.remove(atRevision(headers, 1), 'filler', recording.id)).toEqual({ deleted: true, bytesRetained: true });
    expect(await api.managed.list(headers, 'filler')).toEqual({ items: [] });
    expect((await api.managed.list(headers, 'song')).items[0]!.id).toBe(asset.id);
    expect(await api.routines.fillers.get(headers, recording.id)).toEqual(recording);
    const input = routine();
    input.routine.filler = { ...input.routine.filler, sound: 'recording', recording };
    await expect(api.routines.create(headers, input)).rejects.toMatchObject({ code: 'media_deleted' });
    expect(store.blobs.get(`fillers/records/${recording.id}`)).toEqual(original);
    expect(remove).not.toHaveBeenCalled();
  });

  it('logically deletes unused songs, preserves bytes, and prevents completed-upload replay and new references', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    const media = [...store.blobs].filter(([key]) => key.startsWith('assets/') || key.startsWith('uploads/'));
    const remove = vi.spyOn(store, 'delete');
    const response = await api.handle(request(`library/songs/${asset.id}`, 'DELETE', atRevision(headers, 0)));
    expect(response.status).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ deleted: true, bytesRetained: true });
    expect(await other.managed.remove(atRevision(headers, 0), 'song', asset.id)).toEqual({ deleted: true, bytesRetained: true });
    expect(await other.library.list(headers)).toEqual({ items: [] });
    expect(await other.managed.list(headers, 'song')).toEqual({ items: [] });
    await expect(other.media.complete(headers, asset.id)).rejects.toMatchObject({ code: 'media_deleted' });
    await expect(other.routines.create(headers, routine(asset))).rejects.toMatchObject({ code: 'media_deleted' });
    await expect(other.routines.fillers.create(headers, { name: 'No resurrection', duration: 2, asset })).rejects.toMatchObject({ code: 'media_deleted' });
    expect(hashBytes((await other.media.chunk(asset.id, 0)).bytes)).toBe(asset.sha256);
    for (const [key, value] of media) expect(store.blobs.get(key)).toEqual(value);
    expect(remove).not.toHaveBeenCalled();
  });

  it('requires an explicit all-writers activation barrier and never auto-enables DELETE', async () => {
    const { api, headers, asset, store } = await managementFixture(false);
    const path = `library/songs/${asset.id}`;
    expect((await api.handle(request(path, 'DELETE', atRevision(headers, 0)))).body).toBe('{"error":"library_delete_unconfigured"}');
    expect(store.blobs.has(`library/gates/${asset.id}`)).toBe(false);
    await store.put('control/library-admission-v1', encode({ version: 1, exclusiveWriters: false }), null);
    expect((await api.handle(request(path, 'DELETE', atRevision(headers, 0)))).status).toBe(503);
  });

  it('handles bounded chunks-only and empty-continuation pages without hiding unreferenced uploads', async () => {
    const { api, headers, asset, store } = await managementFixture();
    for (let index = 0; index < MANAGED_PAGE_KEYS; index++) await store.put(`assets/0000/chunks/${index}`, Buffer.alloc(1), null);
    const first = await api.managed.list(headers, 'song');
    expect(first.items).toEqual([]);
    expect(first.cursor).toBeDefined();
    expect((await api.managed.list(headers, 'song', first.cursor)).items.map(item => item.id)).toContain(asset.id);
    const list = vi.spyOn(store, 'list');
    list.mockResolvedValueOnce({ keys: [], cursor: 'empty-page' });
    expect(await api.managed.list(headers, 'song')).toMatchObject({ items: [], cursor: expect.any(String) });
    list.mockResolvedValueOnce({ keys: [`assets/${asset.id}/catalog`, `assets/${asset.id}/catalog`], cursor: undefined });
    await expect(api.managed.list(headers, 'song')).rejects.toMatchObject({ status: 503 });
    list.mockRestore();
    await store.put(`library/metadata/song/${asset.id}`, encode({ revision: 1, title: 'Corrupt' }), null);
    await expect(api.managed.list(headers, 'song', first.cursor)).rejects.toMatchObject({ status: 503 });
  });

  it('does not let the legacy archive endpoint bypass retained usage or metadata CAS', async () => {
    const { api, headers, asset } = await managementFixture();
    const recording = await api.routines.fillers.create(headers, { name: 'Retained loop', duration: 10, asset });
    const input = routine();
    input.routine.filler = { ...input.routine.filler, sound: 'recording', recording };
    await api.routines.create(headers, input);
    const path = `fillers/${recording.id}`;
    expect((await api.handle(request(path, 'DELETE', headers))).status).toBe(428);
    expect((await api.handle(request(path, 'DELETE', atRevision(headers, 0)))).body).toBe('{"error":"media_in_use"}');
    expect((await api.handle(request(path, 'GET', headers))).body).toBe(encode(recording).toString());
  });
});

describe('uploaded audio durable admission races (two instances)', () => {
  it('allows only one simultaneous metadata revision and releases the definitive CAS loser', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    const put = store.put.bind(store);
    const paused = barrier();
    let arrivals = 0;
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key === `library/metadata/song/${asset.id}`) {
        arrivals++;
        if (arrivals === 2) paused.release();
        await paused.pause();
      }
      return put(key, bytes, expected);
    });
    const results = await Promise.allSettled([
      api.managed.put(atRevision(headers, 0), 'song', asset.id, { title: 'First', artist: '' }),
      other.managed.put(atRevision(headers, 0), 'song', asset.id, { title: 'Second', artist: '' }),
    ]);
    expect(arrivals).toBe(2);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 412 } });
    expect((await new AssetAdmission(store).read(asset.id)).value.claims).toEqual([]);
  });

  it('retains an ambiguous metadata claim instead of allowing deletion during a delayed write', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      const etag = await put(key, bytes, expected);
      if (key === `library/metadata/song/${asset.id}`) throw new ApiError(503, 'lost_acknowledgment');
      return etag;
    });
    await expect(api.managed.put(atRevision(headers, 0), 'song', asset.id, { title: 'Committed', artist: '' })).rejects.toMatchObject({ status: 503 });
    spy.mockRestore();
    expect((await other.managed.metadata(headers, 'song', asset.id)).metadata.revision).toBe(1);
    await expect(other.managed.remove(atRevision(headers, 1), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_write_pending' });
  });

  it('save-first holds its claim after authoritative resolution until head commit', async () => {
    const { api, other, headers, asset } = await managementFixture();
    const paused = barrier();
    const catalog = api.media.catalog.bind(api.media);
    const spy = vi.spyOn(api.media, 'catalog').mockImplementation(async id => {
      const result = await catalog(id);
      await paused.pause();
      return result;
    });
    const saving = api.routines.create(headers, routine(asset));
    await paused.entered;
    try {
      await expect(other.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_write_pending' });
    } finally { paused.release(); }
    await saving;
    spy.mockRestore();
    await expect(other.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'media_in_use' });
  });

  it('delete-first closes admission before scanning and rejects every new writer across instances', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    const paused = barrier();
    const list = store.list.bind(store);
    let stopped = false;
    vi.spyOn(store, 'list').mockImplementation(async (prefix, limit, cursor) => {
      if (prefix === 'heads/' && !stopped) { stopped = true; await paused.pause(); }
      return list(prefix, limit, cursor);
    });
    const deleting = api.managed.remove(atRevision(headers, 0), 'song', asset.id);
    await paused.entered;
    try {
      await expect(other.routines.create(headers, routine(asset))).rejects.toMatchObject({ code: 'reference_write_pending' });
      await expect(other.playlists.create(headers, musicPlaylist(asset))).rejects.toMatchObject({ code: 'reference_write_pending' });
      await expect(other.routines.fillers.create(headers, { name: 'Pending', duration: 1, asset })).rejects.toMatchObject({ code: 'reference_write_pending' });
      await expect(other.managed.put(atRevision(headers, 0), 'song', asset.id, { title: '', artist: '' })).rejects.toMatchObject({ code: 'reference_write_pending' });
    } finally { paused.release(); }
    expect(await deleting).toEqual({ deleted: true, bytesRetained: true });
  });

  it('filler creation holds the shared asset claim through its immutable record commit', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    const paused = barrier();
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key.startsWith('fillers/records/')) await paused.pause();
      return put(key, bytes, expected);
    });
    const creating = api.routines.fillers.create(headers, { name: 'Concurrent loop', duration: 10, asset });
    await paused.entered;
    try {
      await expect(other.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_write_pending' });
    } finally { paused.release(); }
    await creating;
    await expect(other.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'media_in_use' });
  });

  it.each(['save', 'lock', 'unlock', 'publish', 'delete', 'duplicate'] as const)('holds retained routine references during %s', async action => {
    const { api, other, headers, asset, store } = await managementFixture();
    const draft = await api.routines.create(headers, routine(asset));
    const paused = barrier();
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key.startsWith('routines/') && key.endsWith('/head')) await paused.pause();
      return put(key, bytes, expected);
    });
    const writing = action === 'duplicate' ? api.routines.duplicate(headers, draft.routine.id, false)
      : api.routines.mutate(atRevision(headers, 1), draft.routine.id, action, action === 'save' || action === 'lock' ? draft : undefined);
    await paused.entered;
    try {
      await expect(other.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_write_pending' });
    } finally { paused.release(); }
    await writing;
  });

  it('claims all routine phases, fillers and retained class exact references', async () => {
    const context = await unifiedFixture();
    const { api, headers, input, assets, store } = context;
    await activateLibrary(store);
    const other = new CloudApi(store, context.env, context.auth.now);
    const draft = await api.routines.create(headers, input);
    const playlist = await api.playlists.create(headers, musicPlaylist(assets[4]!));
    const setup = classPlan(pin(draft.routine));
    setup.setup.walkIn = pin(playlist.playlist);
    const paused = barrier();
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key.startsWith('classes/') && key.endsWith('/head')) await paused.pause();
      return put(key, bytes, expected);
    });
    const writing = api.classes.create(headers, setup);
    await paused.entered;
    try {
      for (const asset of assets) await expect(other.managed.remove(atRevision(headers, 0), 'song', asset.id))
        .rejects.toMatchObject({ code: 'reference_write_pending' });
    } finally { paused.release(); }
    await writing;
  });

  it('retains ambiguous commit claims across restart and never expires them', async () => {
    const { api, other, headers, asset, store, advance, login } = await managementFixture();
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      const etag = await put(key, bytes, expected);
      if (key.startsWith('routines/') && key.endsWith('/head')) throw new ApiError(503, 'lost_acknowledgment');
      return etag;
    });
    await expect(api.routines.create(headers, routine(asset))).rejects.toMatchObject({ status: 503 });
    spy.mockRestore();
    const claim = (await new AssetAdmission(store).read(asset.id)).value.claims;
    expect(claim).toHaveLength(1);
    advance(365 * 24 * 60 * 60 * 1000);
    const fresh = (await login()).headers;
    await expect(other.managed.remove(atRevision(fresh, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_write_pending' });
    expect((await new AssetAdmission(store).read(asset.id)).value.claims).toEqual(claim);
  });

  it('persists bounded deletion checkpoints and resumes after restart without reopening admission', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    for (let index = 0; index < 10; index++) await api.routines.create(headers, routine());
    const get = vi.spyOn(store, 'get');
    const result = await api.handle(request(`library/songs/${asset.id}`, 'DELETE', atRevision(headers, 0)));
    expect(result.status).toBe(202);
    expect(result.body).toBe('{"pending":true}');
    expect(get.mock.calls.filter(([key]) => key.startsWith('snapshots/')).length).toBeLessThanOrEqual(REFERENCE_LIMITS.snapshots);
    expect((await new AssetAdmission(store).read(asset.id)).value.checking?.checkpoint).toBeDefined();
    await expect(other.routines.create(headers, routine(asset))).rejects.toMatchObject({ code: 'reference_write_pending' });
    expect(await other.managed.remove(atRevision(headers, 0), 'song', asset.id)).toEqual({ deleted: true, bytesRetained: true });
  });

  it('recovers a lost filler-tombstone acknowledgment without changing descriptor bytes or reopening the recording', async () => {
    const { api, other, headers, asset, store } = await managementFixture();
    const recording = await api.routines.fillers.create(headers, { name: 'Unused', duration: 1, asset });
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      const etag = await put(key, bytes, expected);
      if (key === `library/deleted-fillers/${recording.id}`) throw new ApiError(503, 'lost_acknowledgment');
      return etag;
    });
    await expect(api.managed.remove(atRevision(headers, 0), 'filler', recording.id)).rejects.toMatchObject({ status: 503 });
    expect((await new AssetAdmission(store).read(asset.id)).value.checking?.ready).toBe(true);
    spy.mockRestore();
    expect(await other.managed.remove(atRevision(headers, 0), 'filler', recording.id)).toEqual({ deleted: true, bytesRetained: true });
    expect((await new AssetAdmission(store).read(asset.id)).value.checking).toBeUndefined();
    expect(await other.routines.fillers.get(headers, recording.id)).toEqual(recording);
  });
});

describe('uploaded audio retained history and finite scans', () => {
  it('reports and blocks retained playlist publications and class exact references', async () => {
    const { api, headers, asset } = await managementFixture();
    const draft = await api.routines.create(headers, routine(asset));
    const published = await api.routines.mutate(atRevision(headers, 1), draft.routine.id, 'publish');
    const playlist = await api.playlists.create(headers, musicPlaylist(asset));
    const publishedPlaylist = await api.playlists.mutate(atRevision(headers, 1), playlist.playlist.id, 'publish');
    const input = classPlan(pin(published.routine));
    input.setup.walkIn = pin(publishedPlaylist.playlist);
    const setup = await api.classes.create(headers, input);
    await api.classes.mutate(atRevision(headers, 1), setup.setup.id, 'publish');
    await api.routines.mutate(atRevision(headers, 2), draft.routine.id, 'delete');
    await api.playlists.mutate(atRevision(headers, 2), playlist.playlist.id, 'delete');
    const kinds = new Set<string>();
    let cursor: string | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const page = await api.managed.usage(headers, 'song', asset.id, cursor);
      for (const reference of page.references) kinds.add(reference.kind);
      cursor = page.cursor;
      if (page.complete) break;
    }
    expect(cursor).toBeUndefined();
    expect(kinds).toEqual(new Set(['routine', 'playlist', 'class']));
    await expect(api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'media_in_use' });
  });

  it('enforces the combined document limit even when continuation is supplied', async () => {
    const { api, headers, asset } = await managementFixture();
    await api.routines.create(headers, routine());
    const cursor = Buffer.from(JSON.stringify({ version: 1, asset: asset.id, exclude: '', stage: 0,
      marker: '', document: '', offset: 0, documents: LIMITS.routines, records: 0, last: '' })).toString('base64url');
    await expect(api.managed.usage(headers, 'song', asset.id, cursor)).rejects.toMatchObject({ code: 'reference_scan_uncertain' });
  });

  it('blocks removed tracks in retained history and tombstoned heads, not just current usage', async () => {
    const { api, headers, asset } = await managementFixture();
    const draft = await api.routines.create(headers, routine(asset));
    const empty = routine();
    empty.routine.id = draft.routine.id;
    await api.routines.mutate(atRevision(headers, 1), draft.routine.id, 'save', empty);
    await api.routines.mutate(atRevision(headers, 2), draft.routine.id, 'delete');
    const usage = await api.managed.usage(headers, 'song', asset.id);
    expect(usage.references).toContainEqual({ kind: 'routine', id: draft.routine.id, name: draft.routine.name, revision: 1 });
    await expect(api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'media_in_use' });
  });

  it('fails closed on unknown legacy history, preserving the closed gate', async () => {
    const { api, headers, asset, store } = await managementFixture();
    const draft = await api.routines.create(headers, routine());
    await api.routines.mutate(atRevision(headers, 1), draft.routine.id, 'save', draft);
    const key = api.routines.headKey(draft.routine.id);
    const head = (await readJson<Record<string, unknown>>(store, key))!;
    delete head.value.history;
    await store.put(key, encode(head.value), head.etag);
    expect((await api.library.list(headers)).items.map(item => item.asset.id)).toContain(asset.id);
    expect((await api.managed.list(headers, 'song')).items.map(item => item.id)).toContain(asset.id);
    await expect(api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_scan_uncertain' });
    expect((await new AssetAdmission(store).read(asset.id)).value.checking).toBeDefined();
  });

  it('fails closed on a missing retained snapshot instead of interpreting it as unused', async () => {
    const { api, headers, asset, store } = await managementFixture();
    const draft = await api.routines.create(headers, routine());
    const { value: head } = await api.routines.storedHead(draft.routine.id);
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation((key, maximum) => key === head.draft.key ? Promise.resolve(null) : get(key, maximum));
    await expect(api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_scan_uncertain' });
    expect((await new AssetAdmission(store).read(asset.id)).value.checking).toBeDefined();
  });

  it('caps scan payload bytes before reading another maximum-sized snapshot', async () => {
    const { api, headers, asset, store } = await managementFixture();
    for (let index = 0; index < 9; index++) await api.routines.create(headers, routine());
    const get = store.get.bind(store);
    let bytesRead = 0;
    vi.spyOn(store, 'get').mockImplementation(async (key, maximum) => {
      const blob = await get(key, maximum);
      if (!blob) return blob;
      if (key.startsWith('snapshots/')) blob.bytes = Buffer.concat([blob.bytes, Buffer.alloc(LIMITS.jsonBytes - blob.bytes.length, 32)]);
      if (key.startsWith('snapshots/') || key.startsWith('routines/')) bytesRead += blob.bytes.length;
      return blob;
    });
    const page = await api.managed.references.scan(headers, asset.id);
    expect(page.complete).toBe(false);
    expect(bytesRead).toBeLessThanOrEqual(REFERENCE_LIMITS.bytes);
  });

  it('rejects oversized history and malformed admission state', async () => {
    const { api, headers, asset, store } = await managementFixture();
    const draft = await api.routines.create(headers, routine());
    const { value: head, etag } = await api.routines.storedHead(draft.routine.id);
    head.history = Array.from({ length: HISTORY_LIMIT + 1 }, (_, index) => ({ revision: index + 1, draft: head.draft.key }));
    await store.put(api.routines.headKey(draft.routine.id), encode(head), etag);
    await expect(api.managed.usage(headers, 'song', asset.id)).rejects.toMatchObject({ code: 'reference_scan_uncertain' });
    await store.put(`library/gates/${asset.id}`, encode({ version: 1, claims: [], deleted: false }), null);
    await expect(api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ status: 503 });
  });

  it('treats legacy class exact-reference corruption as uncertainty even for otherwise unused audio', async () => {
    const { api, headers, asset, store } = await managementFixture();
    const draft = await api.routines.create(headers, routine());
    const saved = await api.classes.create(headers, classPlan(pin(draft.routine)));
    const { value: head } = await api.classes.storedHead(saved.setup.id);
    const snapshot = (await readJson<CloudClassSetup>(store, head.draft.key))!;
    snapshot.value.setup.routine.revision = 99;
    await store.put(head.draft.key, encode(snapshot.value), snapshot.etag);
    await expect(api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ code: 'reference_scan_uncertain' });
  });

  it('bounds elapsed scanning work and rejects cursors for another asset', async () => {
    const { api, headers, asset, store } = await managementFixture();
    let clock = 0;
    const references = new LibraryReferences(store, api.auth, () => clock);
    const list = store.list.bind(store);
    const spy = vi.spyOn(store, 'list').mockImplementation(async (prefix, limit, cursor) => {
      const page = await list(prefix, limit, cursor);
      clock += REFERENCE_LIMITS.milliseconds + 1;
      return page;
    });
    const page = await references.scan(headers, asset.id);
    expect(page).toMatchObject({ references: [], complete: false, cursor: expect.any(String) });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await expect(references.scan(headers, 'another-asset', '', page.cursor)).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it.each(['metadata', 'delete'] as const)('rechecks current accounts after quota immediately before %s commits', async operation => {
    const { api, headers, asset, store, accounts } = await managementFixture();
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, 'put').mockImplementation(async (key, bytes, expected) => {
      const result = await put(key, bytes, expected);
      if (key === 'control/quota') accounts[0]!.authVersion++;
      return result;
    });
    await expect(operation === 'metadata'
      ? api.managed.put(atRevision(headers, 0), 'song', asset.id, { title: 'Denied', artist: '' })
      : api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ status: 401 });
    expect(store.blobs.has(`library/metadata/song/${asset.id}`)).toBe(false);
    expect((await new AssetAdmission(store).read(asset.id)).value.deleted).toBeUndefined();
    spy.mockRestore();
  });
});

describe('completed audio library HTTP discovery', () => {
  it('includes preexisting completed assets and derives current routine/playlist metadata without media reads or writes', async () => {
    const { api, headers, input, assets, store } = await unifiedFixture();
    await api.routines.create(headers, input);
    const playlist = musicPlaylist(assets[4]!);
    playlist.playlist.tracks[0]!.title = 'Playlist title';
    playlist.playlist.tracks[0]!.bpm = 100;
    await api.playlists.create(headers, playlist);
    await stageAudio(api.media, headers, wav(3000));
    const get = vi.spyOn(store, 'get');
    const put = vi.spyOn(store, 'put');
    const response = await api.handle(request('media/library', 'GET', headers));
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const page: CloudAudioPage = JSON.parse(response.body.toString());
    expect(page.items).toHaveLength(5);
    expect(page.items.find(item => item.asset.id === assets[0]!.id)).toEqual({ asset: assets[0], title: '<literal song>', duration: 60 });
    expect(page.items.find(item => item.asset.id === assets[1]!.id)).toEqual({ asset: assets[1], title: '<literal song>', duration: 60 });
    expect(page.items.find(item => item.asset.id === assets[4]!.id)).toEqual({ asset: assets[4], title: 'Playlist title', duration: 60, bpm: 100 });
    expect(page.items.find(item => item.asset.id === assets[3]!.id)).toEqual({ asset: assets[3], title: '' });
    expect(get.mock.calls.some(([key]) => key.includes('/chunks/') || key.startsWith('uploads/'))).toBe(false);
    expect(put.mock.calls.every(([key]) => key.startsWith('traffic/'))).toBe(true);
  });

  it('paginates existing catalog keys with a fixed scan bound, including empty chunks-only pages', async () => {
    const context = fixture();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const { headers } = await context.login();
    const asset = await uploadAudio(api.media, headers);
    const record = (await api.media.catalog(asset.id));
    for (let index = 0; index < LIBRARY_SCAN_LIMIT + 3; index++) {
      const id = `asset-${String(index).padStart(4, '0')}`;
      await context.store.put(`assets/${id}/catalog`, encode({ ...record, asset: { ...asset, id } }), null);
    }
    for (let index = 0; index < LIBRARY_SCAN_LIMIT; index++) {
      await context.store.put(`assets/0000/chunks/${index}`, Buffer.alloc(1), null);
    }
    const list = vi.spyOn(context.store, 'list');
    const found = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < 4; index++) {
      const response = await api.handle(request(`media/library${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', headers));
      expect(response.status).toBe(200);
      const page: CloudAudioPage = JSON.parse(response.body.toString());
      expect(page.items.length).toBeLessThanOrEqual(LIBRARY_SCAN_LIMIT);
      if (index === 0) expect(page.items).toEqual([]);
      for (const item of page.items) {
        expect(found.has(item.asset.id)).toBe(false);
        found.add(item.asset.id);
      }
      cursor = page.cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(found.size).toBe(LIBRARY_SCAN_LIMIT + 4);
    expect(list.mock.calls.filter(([prefix]) => prefix === 'assets/').every(([, limit]) => limit === LIBRARY_SCAN_LIMIT)).toBe(true);
  });

  it('denies player/spoofed browsing and cursor/query/method bypasses while preserving account throttling', async () => {
    const { api, headers, login, store, auth } = await unifiedFixture();
    const player = await login('player');
    const editor = await login('editor');
    expect((await api.handle(request('media/library', 'GET', editor.headers))).status).toBe(200);
    expect((await api.handle(request('media/library', 'GET', player.headers))).status).toBe(403);
    expect((await api.handle(request('media/library', 'GET', new Headers({ 'x-ms-client-principal': 'forged' })))).status).toBe(401);
    for (const query of ['cursor=', 'cursor=-1', 'cursor=1&cursor=2', 'limit=10000', 'routineId=anything', 'published=true', `cursor=${'x'.repeat(4097)}`]) {
      expect((await api.handle(request(`media/library?${query}`, 'GET', headers))).status).toBe(400);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) expect((await api.handle(request('media/library', method, headers))).status).toBe(404);
    const bucket = createHash('sha256').update('owner').digest()[0]! % 64;
    const key = `traffic/account-${bucket}`;
    const previous = store.blobs.get(key)!;
    await store.put(key, encode({ window: Math.floor(auth.now() / 60000), count: 240 }), previous.etag);
    expect((await api.handle(request('media/library', 'GET', headers))).status).toBe(429);
  });

  it('fails closed on oversized or repeated storage pages and bounded corrupt document discovery', async () => {
    const { api, headers, store } = await unifiedFixture();
    const list = vi.spyOn(store, 'list');
    list.mockResolvedValueOnce({ keys: Array.from({ length: LIBRARY_SCAN_LIMIT + 1 }, (_, index) => `assets/asset-${index}/catalog`), cursor: undefined });
    expect((await api.handle(request('media/library', 'GET', headers))).status).toBe(503);
    list.mockResolvedValueOnce({ keys: [], cursor: 'repeat' });
    expect((await api.handle(request('media/library', 'GET', headers))).status).toBe(503);
    list.mockRestore();
    for (let index = 0; index <= LIMITS.routines; index++) await store.put(`heads/phantom-${index}`, encode({ id: `phantom-${index}` }), null);
    expect((await api.handle(request('media/library', 'GET', headers))).status).toBe(503);
  });
});

describe('approved class workflow (persistent services, Blob fake)', () => {
  it('authorizes archived gap-only audio from the exact publication, never from a newer draft or publication', async () => {
    const context = await planFixture();
    const { api, headers, asset } = context;
    const gapAsset = await uploadAudio(api.media, headers, wav(100));
    const recording = await api.routines.fillers.create(headers, { name: 'Gap only recording', duration: 10, asset: gapAsset });
    const input = routine(asset);
    input.routine.filler.mode = 'none';
    input.routine.tracks[0]!.after = { mode: 'custom', filler: { mode: 'timed', seconds: 10, bpm: 100, sound: 'recording', recording } };
    const created = await api.routines.create(headers, input);
    const publication = await api.routines.mutate(atRevision(headers, 1), created.routine.id, 'publish');
    const setup = await api.classes.create(headers, classPlan(pin(publication.routine)));
    await api.classes.mutate(atRevision(headers, 1), setup.setup.id, 'publish');
    const draft = await api.routines.get(headers, created.routine.id, false);
    delete draft.routine.tracks[0]!.after;
    await api.routines.mutate(atRevision(headers, 2), created.routine.id, 'save', draft);
    await api.routines.mutate(atRevision(headers, 3), created.routine.id, 'publish');
    await legacyArchive(api.routines.fillers, recording.id);
    const playerHeaders = (await context.login('player')).headers;
    for (const authority of [`routineId=${created.routine.id}&revision=2`, `classId=${setup.setup.id}&revision=2`]) {
      const download = await api.handle(request(`media/${gapAsset.id}/chunks/0?${authority}`, 'GET', playerHeaders));
      expect(download.status).toBe(200);
      expect(hashBytes(download.body as Buffer)).toBe(gapAsset.sha256);
    }
    expect((await api.handle(request(`media/${gapAsset.id}?routineId=${created.routine.id}`, 'GET', playerHeaders))).status).toBe(403);
    expect((await api.handle(request(`media/${gapAsset.id}?routineId=${created.routine.id}&revision=3`, 'GET', playerHeaders))).status).toBe(404);
  });

  it('prepares exact published references after republish, archive and tombstones without exposing draft-only assets', async () => {
    const context = await planFixture();
    const { api, headers, asset, publication } = context;
    const loopAsset = await uploadAudio(api.media, headers, wav(96));
    const recording = await api.routines.fillers.create(headers, { name: 'Retained transition recording', duration: 15, asset: loopAsset });
    const nextRoutine = await api.routines.get(headers, publication.routine.id, false);
    nextRoutine.routine.filler.mode = 'none';
    nextRoutine.routine.tracks[0]!.after = { mode: 'custom', filler: { mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording, gain: 0.5 }, crossfade: 1 };
    await api.routines.mutate(atRevision(headers, 2), publication.routine.id, 'save', nextRoutine);
    const pinnedRoutine = await api.routines.mutate(atRevision(headers, 3), publication.routine.id, 'publish');
    const list = await api.playlists.create(headers, musicPlaylist(asset));
    const pinnedList = await api.playlists.mutate(atRevision(headers, 1), list.playlist.id, 'publish');
    const input = classPlan(pin(pinnedRoutine.routine));
    input.setup.walkIn = pin(pinnedList.playlist);
    input.setup.walkOut = pin(pinnedList.playlist);
    input.setup.before = { mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording };
    input.setup.after = { ...input.setup.before, gain: 0.25 };
    const saved = await api.classes.create(headers, input);
    const pinnedClass = await api.classes.mutate(atRevision(headers, 1), saved.setup.id, 'publish');
    const playerHeaders = (await context.login('player')).headers;
    const path = `classes/${saved.setup.id}/prepare?published=true&revision=2`;
    const first = await api.handle(request(path, 'GET', playerHeaders));
    expect(first).toMatchObject({ status: 200, headers: { etag: '"2"' } });
    const prepared = JSON.parse(String(first.body)) as ResolvedClassSetup;
    expect(prepared).toEqual(JSON.parse(encode({ setup: pinnedClass.setup, routine: pinnedRoutine, walkIn: pinnedList, walkOut: pinnedList }).toString()));
    const privateAsset = await uploadAudio(api.media, headers, wav(128));
    const changed = await api.routines.get(headers, pinnedRoutine.routine.id, false);
    changed.media[changed.routine.tracks[0]!.id] = privateAsset;
    changed.routine.name = 'Newer private routine';
    await api.routines.mutate(atRevision(headers, 4), changed.routine.id, 'save', changed);
    await api.routines.mutate(atRevision(headers, 5), changed.routine.id, 'publish');
    const changedPlaylist = await api.playlists.get(headers, list.playlist.id, false);
    changedPlaylist.media[changedPlaylist.playlist.tracks[0]!.id] = privateAsset;
    await api.playlists.mutate(atRevision(headers, 2), list.playlist.id, 'save', changedPlaylist);
    await api.playlists.mutate(atRevision(headers, 3), list.playlist.id, 'publish');
    const changedSetup = await api.classes.get(headers, saved.setup.id, false);
    changedSetup.setup.routine = { id: changed.routine.id, revision: 6, published: true };
    changedSetup.setup.walkIn = { id: list.playlist.id, revision: 4, published: true };
    await api.classes.mutate(atRevision(headers, 2), saved.setup.id, 'save', changedSetup);
    await api.classes.mutate(atRevision(headers, 3), saved.setup.id, 'publish');
    const remove = vi.spyOn(api.store, 'delete');
    await legacyArchive(api.routines.fillers, recording.id);
    await api.playlists.mutate(atRevision(headers, 4), list.playlist.id, 'delete');
    await api.routines.mutate(atRevision(headers, 6), changed.routine.id, 'delete');
    expect(remove).not.toHaveBeenCalled();
    const libraryLookup = vi.spyOn(api.routines.fillers, 'resolve').mockRejectedValue(new ApiError(503, 'storage_unavailable'));
    expect((await api.handle(request(path, 'GET', playerHeaders))).body).toBe(first.body);
    expect((await api.handle(request(`classes/${saved.setup.id}/prepare?published=true&revision=1`, 'GET', playerHeaders))).status).toBe(404);
    for (const retained of [asset, loopAsset]) {
      const query = `classId=${saved.setup.id}&revision=2`;
      expect((await api.handle(request(`media/${retained.id}?${query}`, 'GET', playerHeaders))).status).toBe(200);
      const chunk = await api.handle(request(`media/${retained.id}/chunks/0?${query}`, 'GET', playerHeaders));
      expect(chunk.status).toBe(200);
      expect(hashBytes(chunk.body as Buffer)).toBe(retained.sha256);
    }
    expect((await api.handle(request(`media/${privateAsset.id}?classId=${saved.setup.id}&revision=2`, 'GET', playerHeaders))).status).toBe(403);
    expect((await api.handle(request(`playlists/${list.playlist.id}?published=true&revision=2`, 'GET', playerHeaders))).status).toBe(404);
    expect((await api.handle(request(`routines/${changed.routine.id}?published=true&revision=4`, 'GET', playerHeaders))).status).toBe(404);
    expect((await api.handle(request(`classes/${saved.setup.id}/prepare?published=false&revision=3`, 'GET', playerHeaders))).status).toBe(403);
    await expect(api.classes.prepare(headers, saved.setup.id, false, 1)).resolves.toMatchObject({ routine: { routine: { revision: 4 } } });
    const publicBody = await api.classes.get(headers, saved.setup.id, true, 2);
    expect(publicBody.setup).toEqual(pinnedClass.setup);
    expect(libraryLookup).not.toHaveBeenCalled();
  });

  it('resolves pinned draft revisions for authors only and never upgrades them implicitly on publish', async () => {
    const context = await planFixture();
    const { api, headers, draft, publication, asset } = context;
    const playlist = await api.playlists.create(headers, musicPlaylist(asset));
    const input = classPlan(pin(draft.routine));
    input.setup.walkIn = pin(playlist.playlist);
    const saved = await api.classes.create(headers, input);
    const newer = await api.routines.get(headers, draft.routine.id, false);
    newer.routine.name = 'Later content';
    await api.routines.mutate(atRevision(headers, publication.routine.revision), draft.routine.id, 'save', newer);
    const prepared = await api.classes.prepare(headers, saved.setup.id, false, 1);
    expect(prepared.routine.routine).toEqual(draft.routine);
    expect(prepared.walkIn!.playlist).toEqual(playlist.playlist);
    await expect(api.classes.mutate(atRevision(headers, 1), saved.setup.id, 'publish')).rejects.toMatchObject({ status: 400 });
    const playerHeaders = (await context.login('player')).headers;
    await expect(api.classes.prepare(playerHeaders, saved.setup.id, false, 1)).rejects.toMatchObject({ status: 403 });
    expect((await api.handle(request(`media/${asset.id}?classId=${saved.setup.id}&revision=1`, 'GET', playerHeaders))).status).toBe(404);
    expect((await api.handle(request(`media/${asset.id}?playlistId=${playlist.playlist.id}&revision=1`, 'GET', playerHeaders))).status).toBe(404);
  });

  it('validates every recording in custom gaps and announcements, including dormant and archived rules', async () => {
    const { api, headers, asset, publication } = await planFixture();
    const recording = await api.routines.fillers.create(headers, { name: 'Authoritative loop', duration: 10, asset });
    await legacyArchive(api.routines.fillers, recording.id);
    for (const target of ['default', 'gap', 'before', 'after'] as const) {
      for (const field of ['name', 'duration', 'id', 'asset']) {
        const claimed = structuredClone(recording);
        if (field === 'name') claimed.name = 'Forged loop';
        if (field === 'duration') claimed.duration = 11;
        if (field === 'id') claimed.id = 'unknown-loop';
        if (field === 'asset') claimed.asset.sha256 = 'f'.repeat(64);
        const filler = { mode: 'hold' as const, seconds: 0, bpm: 100, sound: 'recording' as const, recording: claimed };
        if (target === 'default' || target === 'gap') {
          const input = routine(asset);
          if (target === 'default') input.routine.filler = filler;
          else input.routine.tracks[0]!.after = { mode: 'custom', filler };
          await expect(api.routines.create(headers, input)).rejects.toMatchObject({ status: field === 'id' ? 404 : 400 });
        } else {
          const input = classPlan(pin(publication.routine));
          input.setup[target] = filler;
          await expect(api.classes.create(headers, input)).rejects.toMatchObject({ status: field === 'id' ? 404 : 400 });
        }
      }
    }
    const input = routine(asset);
    input.routine.tracks[0]!.after = { mode: 'custom', filler: { mode: 'none', seconds: 0, bpm: 100, sound: 'recording', recording } };
    const saved = await api.routines.create(headers, input);
    await expect(api.routines.mutate(atRevision(headers, 1), saved.routine.id, 'publish')).resolves.toMatchObject({ routine: { published: true } });
    const claimed = classPlan(pin(publication.routine));
    claimed.setup.before = { mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording };
    const setup = await api.classes.create(headers, claimed);
    const tamperedRecord = structuredClone(recording);
    tamperedRecord.duration = 11;
    const key = `fillers/records/${recording.id}`;
    await api.store.put(key, encode({ recording: tamperedRecord, archived: true }), (await api.store.get(key, 4096))!.etag);
    await expect(api.classes.mutate(atRevision(headers, 1), setup.setup.id, 'publish')).rejects.toMatchObject({ status: 400 });
    await expect(api.routines.mutate(atRevision(headers, 2), saved.routine.id, 'publish')).rejects.toMatchObject({ status: 400 });
  });

  it.each(['routines', 'playlists', 'classes'] as const)('%s never exposes staged revisions after a failed head CAS', async kind => {
    const context = await planFixture();
    const { api, headers, asset, publication } = context;
    const service = kind === 'routines' ? api.routines : kind === 'playlists' ? api.playlists : api.classes;
    const input = kind === 'routines' ? routine(asset) : kind === 'playlists' ? musicPlaylist(asset) : classPlan(pin(publication.routine));
    const body = await service.create(headers, input);
    const id = 'routine' in body ? body.routine.id : planState(body).id;
    const protectedHead = context.store.blobs.get(service.headKey(id))!;
    const put = context.store.put.bind(context.store);
    const spy = vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key === service.headKey(id)) throw new BlobConflict();
      return put(key, bytes, expected);
    });
    await expect(service.mutate(atRevision(headers, 1), id, 'publish')).rejects.toMatchObject({ status: 412 });
    expect([...context.store.blobs.keys()].filter(key => key.startsWith(service.snapshotPrefix(id, true)))).toHaveLength(1);
    expect(context.store.blobs.get(service.headKey(id))).toEqual(protectedHead);
    for (const published of [true, false]) await expect(service.get(headers, id, published, 2)).rejects.toMatchObject({ status: 404, code: 'revision_not_found' });
    spy.mockRestore();
    const winner = await service.mutate(atRevision(headers, 1), id, 'save', body);
    expect(await service.get(headers, id, false, 2)).toEqual(JSON.parse(encode(winner).toString()));
    await expect(service.get(headers, id, true, 2)).rejects.toMatchObject({ status: 404 });
  });

  it.each(['save', 'lock', 'publish'] as const)('class %s races use the same head and preserve exact references', async action => {
    const { api, headers, publication, draft } = await planFixture();
    const input = classPlan(pin(publication.routine));
    const body = await api.classes.create(headers, input);
    const edited = structuredClone(body);
    edited.setup.name = 'Concurrent draft';
    edited.setup.routine = pin(draft.routine);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const tags: (string | null)[] = [];
    const put = api.store.put.bind(api.store);
    vi.spyOn(api.store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key === api.classes.headKey(body.setup.id)) {
        tags.push(expected);
        if (tags.length === 2) release();
        await barrier;
      }
      return put(key, bytes, expected);
    });
    const other = action === 'lock' ? 'save' : 'lock';
    const outcomes = await Promise.allSettled([
      api.classes.mutate(atRevision(headers, 1), body.setup.id, action, action === 'save' ? edited : undefined),
      api.classes.mutate(atRevision(headers, 1), body.setup.id, other, other === 'save' ? edited : undefined),
    ]);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toBe(tags[1]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 412 } });
    const winner = outcomes[0]!.status === 'fulfilled' ? action : other;
    const current = await api.classes.get(headers, body.setup.id, false, 2);
    expect(current.setup.locked).toBe(winner === 'lock');
    expect(current.setup.routine).toEqual(winner === 'save' ? pin(draft.routine) : pin(publication.routine));
    if (winner !== 'publish') await expect(api.classes.get(headers, body.setup.id, true, 2)).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['playlists', 'create'], ['classes', 'create'], ['playlists', 'publish'], ['classes', 'publish'],
  ] as const)('%s %s withdraws author access after staging without committing or refunding', async (kind, action) => {
    const context = await planFixture('editor');
    const { api, headers, asset, publication } = context;
    const service = kind === 'playlists' ? api.playlists : api.classes;
    const input = kind === 'playlists' ? musicPlaylist(asset) : classPlan(pin(publication.routine));
    const id = planState(input).id;
    if (action === 'publish') await service.create(headers, input);
    const oldHead = context.store.blobs.get(service.headKey(id));
    const quota = (await readJson<{ bytes: number }>(api.store, 'control/quota'))!.value.bytes;
    const put = api.store.put.bind(api.store);
    vi.spyOn(api.store, 'put').mockImplementation(async (key, bytes, expected) => {
      const tag = await put(key, bytes, expected);
      if (key.startsWith(service.snapshotPrefix(id))) context.accounts[1]!.enabled = false;
      return tag;
    });
    await expect(action === 'create' ? service.create(headers, input)
      : service.mutate(atRevision(headers, 1), id, 'publish')).rejects.toMatchObject({ status: 401 });
    expect(context.store.blobs.get(service.headKey(id))).toEqual(oldHead);
    expect((await readJson<{ bytes: number }>(api.store, 'control/quota'))!.value.bytes).toBeGreaterThan(quota);
    await expect(api.handle(request(`${kind}/${id}?published=true`, 'GET', headers))).resolves.toMatchObject({ status: 401 });
  });

  it('retains legacy current/publication pointers but returns 404 for unavailable legacy revisions', async () => {
    const { api, headers, draft, publication } = await planFixture();
    const id = draft.routine.id;
    await api.routines.mutate(atRevision(headers, 2), id, 'lock');
    await api.routines.mutate(atRevision(headers, 3), id, 'unlock');
    const current = await api.routines.head(id);
    const { history: omitted, ...legacy } = current.value;
    expect(omitted).toHaveLength(4);
    await api.store.put(api.routines.headKey(id), encode(legacy), current.etag);
    expect((await api.routines.get(headers, id, false, 4)).routine.revision).toBe(4);
    expect(await api.routines.get(headers, id, true, 2)).toEqual(JSON.parse(encode(publication).toString()));
    for (const revision of [1, 3]) await expect(api.routines.get(headers, id, false, revision)).rejects.toMatchObject({ status: 404, code: 'revision_not_found' });
    await expect(api.classes.create(headers, classPlan({ id, revision: 1, published: false }))).rejects.toMatchObject({ status: 404 });
    await api.routines.mutate(atRevision(headers, 4), id, 'publish');
    expect((await api.routines.head(id)).value.history!.map(link => link.revision)).toEqual([2, 4, 5]);
    await expect(api.routines.get(headers, id, false, 1)).rejects.toMatchObject({ status: 404 });
    expect((await api.routines.get(headers, id, true, 2)).routine.revision).toBe(2);
  });

  it('bounds committed history to 128 versions and retains old publications at the limit', async () => {
    const { api, headers, asset } = await planFixture();
    const created = await api.playlists.create(headers, musicPlaylist(asset));
    const id = created.playlist.id;
    const publication = await api.playlists.mutate(atRevision(headers, 1), id, 'publish');
    let current = await api.playlists.get(headers, id, false);
    while (current.playlist.revision < HISTORY_LIMIT) {
      current = await api.playlists.mutate(atRevision(headers, current.playlist.revision), id, 'save', current);
    }
    const stored = (await api.store.get(api.playlists.headKey(id), HEAD_BYTES))!;
    expect(JSON.parse(stored.bytes.toString()).history).toHaveLength(HISTORY_LIMIT);
    expect(stored.bytes.length).toBeLessThanOrEqual(HEAD_BYTES);
    const quota = await api.store.get('control/quota', 65536);
    await expect(api.playlists.mutate(atRevision(headers, HISTORY_LIMIT), id, 'save', current)).rejects.toMatchObject({ status: 409, code: 'revision_limit_reached' });
    expect(await api.store.get('control/quota', 65536)).toEqual(quota);
    expect(await api.store.get(api.playlists.headKey(id), HEAD_BYTES)).toEqual(stored);
    expect(await api.playlists.get(headers, id, true, 2)).toEqual(JSON.parse(encode(publication).toString()));
  });

  it('charges the existing bounded lifetime counter across entity types before allocating snapshots', async () => {
    const { api, headers, asset, publication } = await planFixture();
    const previous = (await readJson<Record<string, unknown>>(api.store, 'control/quota'))!;
    await api.store.put('control/quota', encode({ ...previous.value, routines: LIMITS.routines - 1 }), previous.etag);
    const outcomes = await Promise.allSettled([
      api.playlists.create(headers, musicPlaylist(asset)), api.classes.create(headers, classPlan(pin(publication.routine))),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { status: 507 } });
    const after = (await readJson<{ routines: number; bytes: number }>(api.store, 'control/quota'))!.value;
    expect(after.routines).toBe(LIMITS.routines);
    expect(after.bytes).toBeGreaterThan(64 * 1024 * 1024);
    await expect(api.routines.create(headers, routine())).rejects.toMatchObject({ status: 507 });
  });

  it('rejects nonprogressing, duplicate and oversized discovery pages for each collection', async () => {
    const { api } = await planFixture();
    for (const service of [api.routines, api.playlists, api.classes]) {
      for (const keys of [[], [`${service.indexPrefix}same`, `${service.indexPrefix}same`],
        Array.from({ length: 129 }, (_, index) => `${service.indexPrefix}entry-${index}`)]) {
        const spy = vi.spyOn(api.store, 'list').mockResolvedValue({ keys, cursor: 'unchanged' });
        await expect(service.discover()).rejects.toMatchObject({ status: 503 });
        spy.mockRestore();
      }
    }
  });

  it('strictly parses exact revision/read queries and refuses ambiguous media authority', async () => {
    const context = await planFixture();
    const { api, headers, asset, publication } = context;
    const playlist = await api.playlists.create(headers, musicPlaylist(asset));
    await api.playlists.mutate(atRevision(headers, 1), playlist.playlist.id, 'publish');
    const playerHeaders = (await context.login('player')).headers;
    expect((await api.handle(request(`media/${asset.id}?playlistId=${playlist.playlist.id}&revision=2`, 'GET', playerHeaders))).status).toBe(200);
    for (const suffix of ['revision=0', 'revision=-1', 'revision=01', 'revision=false', 'revision=1.0', 'revision=9007199254740992',
      'revision=2&revision=2', 'published=FALSE', 'published=', 'published=true&published=false', 'unknown=true']) {
      expect((await api.handle(request(`playlists/${playlist.playlist.id}?${suffix}`, 'GET', headers))).status).toBe(400);
    }
    for (const path of ['playlists?revision=2', 'classes?revision=2', `routines/${publication.routine.id}/publish?revision=2`]) {
      expect((await api.handle(request(path, path.includes('/publish') ? 'POST' : 'GET', atRevision(headers, 2)))).status).toBe(400);
    }
    for (const suffix of [`playlistId=${playlist.playlist.id}`, 'classId=unknown', 'revision=2', 'routineId=',
      `routineId=${publication.routine.id}&playlistId=${playlist.playlist.id}&revision=2`,
      `playlistId=${playlist.playlist.id}&classId=unknown&revision=2`, 'routineId=../remote', 'published=false']) {
      expect((await api.handle(request(`media/${asset.id}?${suffix}`, 'GET', playerHeaders))).status).toBe(400);
    }
    expect((await api.handle(request(`playlists/${playlist.playlist.id}?published=true&revision=1`, 'GET', playerHeaders))).status).toBe(404);
    expect((await api.handle(request(`playlists/${playlist.playlist.id}/prepare`, 'GET', headers))).status).toBe(404);
    expect((await api.handle(request('classes', 'PATCH', headers))).status).toBe(404);
  });

  it.each(['playlists', 'classes'] as const)('%s HTTP lifecycle returns authoritative detached state and enforces locks', async kind => {
    const context = await planFixture('editor');
    const { api, headers, asset, publication } = context;
    const input: PlanBody = kind === 'playlists' ? musicPlaylist(asset) : classPlan(pin(publication.routine));
    const id = planState(input).id;
    const path = `${kind}/${id}`;
    const created = await api.handle(request(kind, 'POST', headers, input));
    expect(created).toMatchObject({ status: 201, headers: { etag: '"1"' } });
    expect(JSON.parse(String(created.body))).toEqual(JSON.parse(encode(input).toString()));
    expect(created.headers['cache-control']).toContain('no-store');
    const protectedHead = context.store.blobs.get(`${kind}/${id}/head`);
    const read = await api.handle(request(path, 'GET', headers));
    const selected = JSON.parse(String(read.body)) as PlanBody;
    expect(read.headers.etag).toBe('"1"');
    expect(context.store.blobs.get(`${kind}/${id}/head`)).toEqual(protectedHead);
    const listed = JSON.parse(String((await api.handle(request(kind, 'GET', headers))).body));
    expect(listed[kind]).toEqual([planState(selected)]);
    expect(Object.keys(listed)).toEqual([kind]);
    planState(selected).name = 'Saved independent content';
    expect((await api.handle(request(path, 'PUT', headers, selected))).status).toBe(428);
    const saved = await api.handle(request(path, 'PUT', atRevision(headers, 1), selected));
    expect(saved).toMatchObject({ status: 200, headers: { etag: '"2"' } });
    const body = JSON.parse(String(saved.body)) as PlanBody;
    for (const field of ['locked', 'published'] as const) {
      const forged = structuredClone(body);
      planState(forged)[field] = true;
      expect((await api.handle(request(path, 'PUT', atRevision(headers, 2), forged))).status).toBe(400);
    }
    planState(body).name = 'Saved and locked together';
    const locked = await api.handle(request(`${path}/lock`, 'POST', atRevision(headers, 2), body));
    expect(locked).toMatchObject({ status: 200, headers: { etag: '"3"' } });
    const lockedBody = JSON.parse(String(locked.body)) as PlanBody;
    expect(planState(lockedBody)).toMatchObject({ locked: true, name: 'Saved and locked together', revision: 3 });
    for (const command of ['save', 'publish', 'delete']) {
      expect((await api.handle(request(command === 'publish' ? `${path}/publish` : path,
        command === 'save' ? 'PUT' : command === 'publish' ? 'POST' : 'DELETE', atRevision(headers, 3),
        command === 'save' ? lockedBody : undefined))).status).toBe(423);
    }
    const unlocked = await api.handle(request(`${path}/unlock`, 'POST', atRevision(headers, 3)));
    expect(unlocked).toMatchObject({ status: 200, headers: { etag: '"4"' } });
    expect((await api.handle(request(path, 'PUT', atRevision(headers, 2), body))).status).toBe(412);
    const published = await api.handle(request(`${path}/publish`, 'POST', atRevision(headers, 4)));
    expect(published).toMatchObject({ status: 200, headers: { etag: '"5"' } });
    expect(planState(JSON.parse(String(published.body)))).toMatchObject({ revision: 5, published: true, locked: false });
    const current = JSON.parse(String((await api.handle(request(path, 'GET', headers))).body)) as PlanBody;
    expect(planState(current)).toMatchObject({ revision: 5, published: false });
    const historical = await api.handle(request(`${path}?published=false&revision=1`, 'GET', headers));
    expect(historical.body).toBe(created.body);
    const duplicate = await api.handle(request(`${path}/duplicate?published=true&revision=5`, 'POST', headers));
    expect(duplicate.status).toBe(201);
    const copy = JSON.parse(String(duplicate.body)) as PlanBody;
    expect(planState(copy)).toMatchObject({ revision: 1, published: false, locked: false });
    expect(planState(copy).id).not.toBe(id);
    if ('playlist' in copy && 'playlist' in input) {
      expect(copy.playlist.tracks[0]!.id).not.toBe(input.playlist.tracks[0]!.id);
      expect(Object.values(copy.media)).toEqual([asset]);
    }
    if ('setup' in copy) expect(copy.setup.routine).toEqual(pin(publication.routine));
    expect((await api.handle(request(path, 'DELETE', atRevision(headers, 5)))).status).toBe(200);
    expect((await api.handle(request(`${path}?published=true&revision=5`, 'GET', headers))).status).toBe(404);
    expect((await api.handle(request(kind, 'POST', headers, input))).status).toBe(409);
  });

  it.each(['owner', 'editor', 'player'])('uses current account roles, CSRF and origin for both new collections: %s', async role => {
    const context = await planFixture();
    const { api, asset, publication } = context;
    const headers = role === 'owner' ? context.headers : (await context.login(role)).headers;
    for (const kind of ['playlists', 'classes'] as const) {
      const input = kind === 'playlists' ? musicPlaylist(asset) : classPlan(pin(publication.routine));
      const created = await api.handle(request(kind, 'POST', context.headers, input));
      expect(created.status).toBe(201);
      const path = `${kind}/${planState(input).id}`;
      expect((await api.handle(request(`${path}/publish`, 'POST', atRevision(context.headers, 1)))).status).toBe(200);
      if (role === 'player') {
        expect((await api.handle(request(kind, 'POST', headers, input))).status).toBe(403);
        expect((await api.handle(request(path, 'PUT', atRevision(headers, 2), input))).status).toBe(403);
        expect((await api.handle(request(path, 'DELETE', atRevision(headers, 2)))).status).toBe(403);
      }
      expect((await api.handle(request(`${kind}?published=true`, 'GET', headers))).status).toBe(200);
      expect((await api.handle(request(`${path}?published=true&revision=2`, 'GET', headers))).status).toBe(200);
      expect((await api.handle(request(kind, 'GET', headers))).status).toBe(role === 'player' ? 403 : 200);
      expect((await api.handle(request(`${path}?published=false&revision=1`, 'GET', headers))).status).toBe(role === 'player' ? 403 : 200);
      expect((await api.handle(request(`${path}/duplicate?published=true`, 'POST', headers))).status).toBe(role === 'player' ? 403 : 201);
      for (const command of ['lock', 'unlock', 'publish']) {
        const result = await api.handle(request(`${path}/${command}`, 'POST', atRevision(headers, 2)));
        expect(result.status).toBe(role === 'player' ? 403 : command === 'lock' ? 200 : command === 'publish' ? 423 : 412);
      }
      const badHeaders = new Headers(headers);
      badHeaders.delete('x-csrf-token');
      expect((await api.handle(request(kind, 'POST', badHeaders, input))).status).toBe(403);
      badHeaders.set('origin', 'https://other.invalid');
      expect((await api.handle(request(`${path}/duplicate`, 'POST', badHeaders))).status).toBe(403);
      expect((await api.handle(request(path, 'GET', new Headers({ 'x-ms-client-principal': 'owner' })))).status).toBe(401);
    }
  });

  it('keeps repeated playlist occurrences independent and refuses choreography and descriptor forgery', async () => {
    const { api, headers, asset } = await planFixture();
    const input = musicPlaylist(asset);
    input.playlist.tracks.push({ ...input.playlist.tracks[0]!, id: 'repeat-entry', gain: 0.4 });
    input.media['repeat-entry'] = asset;
    expect((await api.playlists.create(headers, input)).playlist.tracks).toHaveLength(2);
    for (const change of ['duplicate-id', 'cue', 'after', 'missing-media', 'extra-media', 'forged-media']) {
      const invalid = structuredClone(input);
      if (change === 'duplicate-id') invalid.playlist.tracks[1]!.id = invalid.playlist.tracks[0]!.id;
      if (change === 'cue') invalid.playlist.tracks[0]!.cues.push({ id: 'cue', note: 'Rejected', anchor: { kind: 'timestamp', seconds: 1 } });
      if (change === 'after') invalid.playlist.tracks[0]!.after = { mode: 'none' };
      if (change === 'missing-media') delete invalid.media['repeat-entry'];
      if (change === 'extra-media') invalid.media['extra-entry'] = asset;
      if (change === 'forged-media') invalid.media['repeat-entry'] = { ...asset, bytes: asset.bytes + 1 };
      await expect(api.playlists.parse(invalid)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('requires exact existing references, hold announcements and explicit publication commands', async () => {
    const { api, headers, publication, draft, asset } = await planFixture();
    const valid = classPlan(pin(publication.routine));
    for (const invalid of [
      { ...valid, role: 'owner' }, { setup: { ...valid.setup, owner: 'owner' } },
      { setup: { ...valid.setup, locked: true } }, { setup: { ...valid.setup, published: true } },
      { setup: { ...valid.setup, crossfade: '2' } }, { setup: { ...valid.setup, crossfade: 13 } },
      { setup: { ...valid.setup, before: { mode: 'timed', seconds: 10, bpm: 100, sound: 'soft' } } },
      { setup: { ...valid.setup, after: { mode: 'hold', seconds: 0, bpm: 100, sound: 'invalid' } } },
      ...[null, { id: 'missing' }, { ...valid.setup.routine, revision: '2' }, { ...valid.setup.routine, published: 'true' },
        { ...valid.setup.routine, id: '../remote' }, { ...valid.setup.routine, extra: true }].map(routine => ({ setup: { ...valid.setup, routine } })),
    ]) expect((await api.handle(request('classes', 'POST', headers, invalid))).status).toBe(400);
    const missing = classPlan({ id: 'missing', revision: 1, published: true });
    expect((await api.handle(request('classes', 'POST', headers, missing))).status).toBe(404);
    const wrongRevision = classPlan({ ...pin(publication.routine), revision: 1 });
    expect((await api.handle(request('classes', 'POST', headers, wrongRevision))).status).toBe(404);
    const draftSetup = await api.classes.create(headers, classPlan(pin(draft.routine)));
    await expect(api.classes.mutate(atRevision(headers, 1), draftSetup.setup.id, 'publish')).rejects.toMatchObject({ status: 400, code: 'published_references_required' });
    const playlist = await api.playlists.create(headers, musicPlaylist(asset));
    const mixed = classPlan(pin(publication.routine));
    mixed.setup.walkOut = pin(playlist.playlist);
    const saved = await api.classes.create(headers, mixed);
    await expect(api.classes.mutate(atRevision(headers, 1), saved.setup.id, 'publish')).rejects.toMatchObject({ status: 400 });
    const playerHeaders = (await fixture().login('player')).headers;
    await expect(api.classes.get(playerHeaders, saved.setup.id, false)).rejects.toMatchObject({ status: 401 });
  });
});

describe('shared filler library (Blob fake)', () => {
  describe('retained filler lookup', () => {
    it.each(['owner', 'editor'])('returns byte-exact active and archived metadata to %s without changing protected storage', async role => {
      const context = fixture();
      const api = new CloudApi(context.store, context.env, context.auth.now);
      const { headers } = await context.login(role);
      const asset = await uploadAudio(api.media, headers);
      const recording = await api.routines.fillers.create(headers, { name: 'Retained <literal> loop', duration: 30, asset });
      const readHeaders = new Headers({ cookie: headers.get('cookie')! });
      const path = `fillers/${recording.id}`;
      const expectedBody = encode(recording).toString();
      expect(await api.handle(request(path, 'GET', readHeaders))).toMatchObject({ status: 200, body: expectedBody });
      await legacyArchive(api.routines.fillers, recording.id);
      const key = `fillers/records/${recording.id}`;
      const protectedRecord = (await context.store.get(key, 4096))!;
      const signature = hashBytes(protectedRecord.bytes);
      expect(JSON.parse(protectedRecord.bytes.toString())).toStrictEqual({ recording, archived: true });
      const put = vi.spyOn(context.store, 'put');
      const remove = vi.spyOn(context.store, 'delete');

      const response = await api.handle(request(path, 'GET', readHeaders));
      expect(response).toMatchObject({ status: 200, body: expectedBody });
      expect(response.headers['cache-control']).toContain('private');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(await api.handle(request('fillers', 'GET', readHeaders))).toMatchObject({ status: 200, body: '{"fillers":[]}' });
      await expect(api.routines.fillers.resolve({ ...recording, name: 'Mismatched name' })).rejects.toMatchObject({ status: 400, code: 'invalid_filler' });
      expect(await api.routines.fillers.resolve(recording)).toStrictEqual(recording);
      const after = (await context.store.get(key, 4096))!;
      expect(after).toStrictEqual(protectedRecord);
      expect(hashBytes(after.bytes)).toBe(signature);
      expect(put.mock.calls.every(([storedKey]) => storedKey.startsWith('traffic/'))).toBe(true);
      expect(remove).not.toHaveBeenCalled();
    });

    it.each(['owner', 'editor'])('returns filler_not_found for a fresh unknown UUID to %s without allocating a recording', async role => {
      const context = fixture();
      const api = new CloudApi(context.store, context.env, context.auth.now);
      const { headers } = await context.login(role);
      const put = vi.spyOn(context.store, 'put');
      expect(await api.handle(request(`fillers/${randomUUID()}`, 'GET', headers))).toMatchObject({
        status: 404, body: '{"error":"filler_not_found"}',
      });
      expect(put.mock.calls.every(([key]) => key.startsWith('traffic/'))).toBe(true);
      expect([...context.store.blobs.keys()].filter(key => key.startsWith('fillers/'))).toEqual([]);
    });

    it('denies players before revealing active, archived, unknown or invalid recording IDs', async () => {
      const context = fixture();
      const api = new CloudApi(context.store, context.env, context.auth.now);
      const { headers } = await context.login();
      const asset = await uploadAudio(api.media, headers);
      const recording = await api.routines.fillers.create(headers, { name: 'Private loop', duration: 20, asset });
      const playerHeaders = (await context.login('player')).headers;
      expect(await api.handle(request(`fillers/${recording.id}`, 'GET', playerHeaders))).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
      await legacyArchive(api.routines.fillers, recording.id);
      for (const id of [recording.id, randomUUID(), 'invalid!']) {
        expect(await api.handle(request(`fillers/${id}`, 'GET', playerHeaders))).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
      }
    });

    it.each(['invalid!', 'a'.repeat(81)])('rejects an invalid recording ID with 400: %s', async id => {
      const context = fixture();
      const api = new CloudApi(context.store, context.env, context.auth.now);
      const { headers } = await context.login();
      expect(await api.handle(request(`fillers/${id}`, 'GET', headers))).toMatchObject({ status: 400, body: '{"error":"invalid_id"}' });
    });

    it('does not authorize lookup from a client principal header', async () => {
      const context = fixture();
      const api = new CloudApi(context.store, context.env, context.auth.now);
      const headers = new Headers({ origin: 'https://example.invalid', 'x-ms-client-principal': 'owner' });
      expect((await api.handle(request(`fillers/${randomUUID()}`, 'GET', headers))).status).toBe(401);
    });
  });

  it('uses the production Blob adapter for conditional recording inserts and preserves a legacy archived descriptor', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const asset = await uploadAudio(new CloudMedia(context.store, context.auth), headers);
    const writes: Array<{ key: string; conditions: { ifMatch?: string; ifNoneMatch?: string } }> = [];
    const container = {
      getBlobClient: (key: string) => ({ download: async () => {
        const stored = context.store.blobs.get(key);
        if (!stored) throw { statusCode: 404, code: 'BlobNotFound' };
        return { etag: stored.etag, contentLength: stored.bytes.length, readableStreamBody: Readable.from([stored.bytes]) };
      } }),
      getBlockBlobClient: (key: string) => ({ upload: async (bytes: Buffer, length: number, options: {
        conditions: { ifMatch?: string; ifNoneMatch?: string };
      }) => {
        expect(length).toBe(bytes.length);
        writes.push({ key, conditions: options.conditions });
        try { return { etag: await context.store.put(key, bytes, options.conditions.ifMatch ?? null) }; }
        catch (error) { if (error instanceof BlobConflict) throw { statusCode: 412 }; throw error; }
      } }),
    } as unknown as ContainerClient;
    const store = new AzureBlobStore(container);
    const auth = new CloudAuth(store, context.env, context.auth.now);
    const fillers = new CloudFillers(store, auth, new CloudMedia(store, auth));
    const recording = await fillers.create(headers, { name: 'Adapter fixture', duration: 15, asset });
    const key = `fillers/records/${recording.id}`;
    const etag = context.store.blobs.get(key)!.etag;
    expect(writes.filter(write => write.key.startsWith('fillers/'))).toEqual([
      { key: `fillers/index/${recording.id}`, conditions: { ifNoneMatch: '*' } },
      { key, conditions: { ifNoneMatch: '*' } },
    ]);
    expect(writes.some(write => write.key === `library/gates/${asset.id}`)).toBe(true);
    await expect(store.put(key, encode({ recording, archived: false }), null)).rejects.toBeInstanceOf(BlobConflict);
    await legacyArchive(fillers, recording.id);
    expect(writes.at(-1)).toEqual({ key, conditions: { ifMatch: etag } });
    expect(await fillers.resolve(recording)).toStrictEqual(recording);
    const count = writes.length;
    await fillers.get(headers, recording.id);
    expect(writes).toHaveLength(count);
  });

  it('enforces owner/editor routes, strict write Origin and CSRF without trusting principal headers', async () => {
    const context = fixture();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const ownerHeaders = (await context.login()).headers;
    const asset = await uploadAudio(api.media, ownerHeaders);
    const input = { name: 'Household loop', duration: 20, asset };
    const retained = await api.routines.fillers.create(ownerHeaders, input);
    await activateLibrary(context.store);
    for (const role of ['owner', 'editor', 'player']) {
      const headers = role === 'owner' ? ownerHeaders : (await context.login(role)).headers;
      const result = await api.handle(request('fillers', 'POST', headers, input));
      expect(result.status).toBe(role === 'player' ? 403 : 201);
      expect((await api.handle(request('fillers', 'GET', headers))).status).toBe(role === 'player' ? 403 : 200);
      if (role === 'player') {
        expect((await api.handle(request(`fillers/${retained.id}`, 'DELETE', headers))).status).toBe(403);
        continue;
      }
      const recording = JSON.parse(String(result.body)) as FillerRecording;
      for (const [method, path, body] of [['POST', 'fillers', input], ['DELETE', `fillers/${recording.id}`, undefined]] as const) {
        for (const invalid of ['no-csrf', 'bad-csrf', 'no-origin', 'bad-origin', 'cross-site']) {
          const denied = new Headers(headers);
          if (invalid === 'no-csrf') denied.delete('x-csrf-token');
          if (invalid === 'bad-csrf') denied.set('x-csrf-token', 'forged');
          if (invalid === 'no-origin') denied.delete('origin');
          if (invalid === 'bad-origin') denied.set('origin', 'https://other.invalid');
          if (invalid === 'cross-site') denied.set('sec-fetch-site', 'cross-site');
          expect((await api.handle(request(path, method, denied, body))).status).toBe(403);
        }
      }
      expect((await api.handle(request(`media/${asset.id}`, 'GET', headers))).status).toBe(200);
      expect((await api.handle(request(`fillers/${recording.id}`, 'DELETE', headers, {}))).status).toBe(400);
      expect((await api.handle(request(`fillers/${recording.id}`, 'DELETE', headers))).status).toBe(428);
      expect((await api.handle(request(`fillers/${recording.id}`, 'DELETE', atRevision(headers, 0)))).body).toBe('{"error":"media_in_use"}');
      expect(result.headers['cache-control']).toContain('no-store');
    }
    const spoofed = new Headers({ origin: 'https://example.invalid', 'x-ms-client-principal': 'owner' });
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect((await api.handle(request(method === 'DELETE' ? 'fillers/forged' : 'fillers', method, spoofed, method === 'POST' ? input : undefined))).status).toBe(401);
    }
  });

  it('rejects malformed creation and unverified or mismatched assets before reserving storage', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const asset = await uploadAudio(api.media, headers);
    const input = { name: 'Literal <name>', duration: 360, asset };
    const before = context.store.blobs.get('control/quota');
    const invalid = [null, [], {}, { ...input, id: 'client-id' }, { ...input, archived: false },
      ...[0, -1, 360.001, NaN, Infinity, -Infinity, '30', null, undefined].map(duration => ({ ...input, duration })),
      ...['', ' ', 'a'.repeat(161), null, 1].map(name => ({ ...input, name })),
      ...[{ bytes: asset.bytes + 1 }, { sha256: 'b'.repeat(64) }, { contentType: 'audio/mpeg' },
        { contentType: 'audio/x-wav' }, { bytes: 43 }, { bytes: LIMITS.assetBytes + 1 }, { bytes: 44.5 },
        { sha256: 'A'.repeat(64) }, { id: '../asset' }, { arbitrary: true }].map(change => ({ ...input, asset: { ...asset, ...change } }))];
    for (const body of invalid) await expect(api.routines.fillers.create(headers, body)).rejects.toMatchObject({ status: 400 });
    const upload = await stageAudio(api.media, headers);
    await expect(api.routines.fillers.create(headers, { ...input, asset: { ...asset, id: upload.assetId } })).rejects.toMatchObject({ status: 404 });
    expect([...context.store.blobs.keys()].filter(key => key.startsWith('fillers/'))).toEqual([]);
    expect(JSON.parse(before!.bytes.toString()).fillers).toBe(0);
    expect((await readJson<{ fillers: number }>(context.store, 'control/quota'))!.value.fillers).toBe(0);
    expect((await api.handle(request('fillers', 'POST', headers, { ...input, unexpected: true }))).status).toBe(400);
    expect((await api.routines.fillers.create(headers, input)).duration).toBe(360);
  });

  it('resolves every recording field against the retained entry at create, save and atomic lock', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const asset = await uploadAudio(api.media, headers);
    const unrelated = await uploadAudio(api.media, headers, wav(8192));
    const recording = await api.routines.fillers.create(headers, { name: 'Authoritative name', duration: 30, asset });
    const body = routine(asset);
    body.routine.filler = { ...body.routine.filler, sound: 'recording', recording };
    const draft = await api.routines.create(headers, body);
    headers.set('if-match', '"1"');
    await legacyArchive(api.routines.fillers, recording.id);
    const head = context.store.blobs.get(`routines/${draft.routine.id}/head`);
    const forgeries = [{ ...recording, name: 'Fake claimed name' }, { ...recording, duration: 31 },
      { ...recording, asset: unrelated }, { ...recording, id: 'local-unregistered-id' },
      ...[{ id: unrelated.id }, { bytes: asset.bytes + 1 }, { sha256: 'b'.repeat(64) }, { contentType: 'audio/mpeg' }]
        .map(change => ({ ...recording, asset: { ...asset, ...change } }))];
    for (const forged of forgeries) {
      const changed = structuredClone(draft);
      changed.routine.filler.recording = forged;
      for (const action of ['create', 'save', 'lock'] as const) {
        const input = structuredClone(changed);
        if (action === 'create') input.routine.id = randomUUID();
        const response = await api.handle(request(action === 'create' ? 'routines' : `routines/${draft.routine.id}${action === 'lock' ? '/lock' : ''}`,
          action === 'save' ? 'PUT' : 'POST', headers, input));
        expect(response.status).toBe(forged.id === 'local-unregistered-id' ? 404 : 400);
      }
    }
    expect(context.store.blobs.get(`routines/${draft.routine.id}/head`)).toEqual(head);
    const saved = await api.routines.mutate(headers, draft.routine.id, 'save', draft);
    expect(saved.routine.filler.recording).toStrictEqual(recording);
  });

  it('reserves lifetime count and bytes before either filler write and bounds competing additions', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const first = new CloudFillers(context.store, context.auth, media);
    const second = new CloudFillers(context.store, context.auth, media);
    const asset = await uploadAudio(media, headers);
    const input = { name: 'Quota loop', duration: 1, asset };
    const initial = (await readJson<Record<string, unknown>>(context.store, 'control/quota'))!.value;
    for (const exhausted of [{ fillers: LIMITS.fillers }, { bytes: LIMITS.quotaBytes - 8191 }, { operations: 20000 }]) {
      await context.store.put('control/quota', encode({ ...initial, ...exhausted }), context.store.blobs.get('control/quota')!.etag);
      await expect(first.create(headers, input)).rejects.toMatchObject({ status: 507 });
      expect([...context.store.blobs.keys()].filter(key => key.startsWith('fillers/'))).toEqual([]);
    }
    await context.store.put('control/quota', encode({ ...initial, fillers: LIMITS.fillers - 1 }), context.store.blobs.get('control/quota')!.etag);
    const put = context.store.put.bind(context.store);
    vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key.startsWith('fillers/')) {
        expect(expected).toBeNull();
        const quota = (await readJson<{ fillers: number; bytes: number }>(context.store, 'control/quota'))!.value;
        expect(quota.fillers).toBe(LIMITS.fillers);
        expect(quota.bytes).toBeGreaterThanOrEqual(Number(initial.bytes) + 8192 + GATE_BYTES);
      }
      return put(key, bytes, expected);
    });
    const results = await Promise.allSettled([first.create(headers, input), second.create(headers, input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 507 } });
    expect([...context.store.blobs.keys()].filter(key => key.startsWith('fillers/'))).toHaveLength(2);
  });

  it.each(['quota', 'index', 'archive'] as const)('rechecks current account after %s staging', async stage => {
    const context = fixture();
    const { headers } = await context.login('editor');
    const media = new CloudMedia(context.store, context.auth);
    const fillers = new CloudFillers(context.store, context.auth, media);
    const asset = await uploadAudio(media, headers);
    const input = { name: 'Revoked loop', duration: 1, asset };
    const recording = stage === 'archive' ? await fillers.create(headers, input) : undefined;
    if (recording) await activateLibrary(context.store);
    const put = context.store.put.bind(context.store);
    const get = context.store.get.bind(context.store);
    vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
      const etag = await put(key, bytes, expected);
      if ((stage === 'quota' && key === 'control/quota') || (stage === 'index' && key.startsWith('fillers/index/'))) context.accounts[1]!.enabled = false;
      return etag;
    });
    vi.spyOn(context.store, 'get').mockImplementation(async (key, maximum) => {
      const result = await get(key, maximum);
      if (stage === 'archive' && key.startsWith('fillers/records/')) context.accounts[1]!.enabled = false;
      return result;
    });
    await expect(recording ? fillers.archive(atRevision(headers, 0), recording.id) : fillers.create(headers, input)).rejects.toMatchObject({ status: 401 });
    const records = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('fillers/records/'));
    expect(records).toHaveLength(recording ? 1 : 0);
    if (recording) expect(JSON.parse(records[0]![1].bytes.toString())).toEqual({ recording, archived: false });
    const valid = (await context.login()).headers;
    expect((await fillers.list(valid)).fillers).toEqual(recording ? [recording] : []);
  });

  it('sorts bounded discovery pages deterministically and rejects oversized or looping indexes', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const fillers = new CloudFillers(context.store, context.auth, media);
    const asset = await uploadAudio(media, headers);
    const expected: FillerRecording[] = [];
    for (let index = 0; index < LIMITS.fillers; index++) {
      const recording = { id: `fixture-${String(index).padStart(3, '0')}`, name: index % 2 ? 'Alpha' : 'Zulu', duration: 10, asset };
      await context.store.put(`fillers/index/${recording.id}`, encode({ id: recording.id }), null);
      if (index === 1) continue;
      await context.store.put(`fillers/records/${recording.id}`, encode({ recording, archived: index === 0 }), null);
      if (index !== 0) expected.push(recording);
    }
    expected.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : first.id < second.id ? -1 : 1);
    const list = vi.spyOn(context.store, 'list');
    expect(await fillers.list(headers)).toEqual({ fillers: expected });
    expect(list).toHaveBeenCalledTimes(4);
    expect(list.mock.calls.every(([, limit]) => limit === 128)).toBe(true);
    await context.store.put('fillers/index/overflow', encode({ id: 'overflow' }), null);
    await expect(fillers.list(headers)).rejects.toMatchObject({ status: 503 });
    list.mockResolvedValue({ keys: [], cursor: 'empty-loop' });
    await expect(fillers.list(headers)).rejects.toMatchObject({ status: 503 });
    list.mockResolvedValue({ keys: ['fillers/index/fixture-001'], cursor: 'repeated' });
    await expect(fillers.list(headers)).rejects.toMatchObject({ status: 503 });
  });

  it('allows same-asset additions and both duplicates while unused-only archive remains blocked', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const asset = await uploadAudio(api.media, headers);
    const input = { name: 'Same name and bytes', duration: 15, asset };
    const recording = await api.routines.fillers.create(headers, input);
    const body = routine(asset);
    body.routine.filler = { ...body.routine.filler, sound: 'recording', recording };
    const saved = await api.routines.create(headers, body);
    headers.set('if-match', '"1"');
    await api.routines.mutate(headers, saved.routine.id, 'publish');
    await activateLibrary(context.store);
    const [first, second, added] = await Promise.all([
      api.routines.duplicate(headers, saved.routine.id, true), api.routines.duplicate(headers, saved.routine.id, false),
      api.routines.fillers.create(headers, input),
    ]);
    expect(first.routine.filler.recording).toStrictEqual(recording);
    expect(second.routine.filler.recording).toStrictEqual(recording);
    expect(first.routine.id).not.toBe(second.routine.id);
    expect(added.id).not.toBe(recording.id);
    await expect(api.routines.fillers.archive(atRevision(headers, 0), recording.id)).rejects.toMatchObject({ code: 'media_in_use' });
    await expect(new CloudFillers(context.store, context.auth, api.media).archive(atRevision(headers, 0), recording.id))
      .rejects.toMatchObject({ code: 'media_in_use' });
    expect((await api.routines.fillers.list(headers)).fillers).toEqual(expect.arrayContaining([recording, added]));
    expect(await api.routines.fillers.resolve(recording)).toStrictEqual(recording);
  });

  it.each(['none', 'timed', 'hold'] as const)('retains archived recording snapshots and published-only media access in %s mode', async mode => {
    const context = fixture();
    const { headers } = await context.login();
    const playerHeaders = (await context.login('player')).headers;
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const trackAsset = await uploadAudio(api.media, headers);
    const fillerAsset = await uploadAudio(api.media, headers, wav(4096));
    const unrelatedAsset = await uploadAudio(api.media, headers, wav(8192));
    const created = await api.handle(request('fillers', 'POST', headers, { name: 'Saved loop', duration: 30, asset: fillerAsset }));
    expect(created.status).toBe(201);
    const recording = JSON.parse(String(created.body)) as FillerRecording;
    const input = routine(trackAsset);
    input.routine.filler = { mode, sound: 'recording', seconds: 15, bpm: 100, gain: 0.5, recording };
    const saved = await api.routines.create(headers, input);
    headers.set('if-match', '"1"');
    const publication = await api.routines.mutate(headers, saved.routine.id, 'publish');
    const rawPublished = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('publications/'));
    await activateLibrary(context.store);
    expect((await api.handle(request(`fillers/${recording.id}`, 'DELETE', atRevision(headers, 0)))).body).toBe('{"error":"media_in_use"}');
    await legacyArchive(api.routines.fillers, recording.id);
    expect(JSON.parse(String((await api.handle(request('fillers', 'GET', headers))).body))).toEqual({ fillers: [] });
    const draft = await api.routines.get(headers, saved.routine.id, false);
    expect(draft.routine.filler).toStrictEqual(input.routine.filler);
    headers.set('if-match', '"2"');
    const resaved = await api.routines.mutate(headers, saved.routine.id, 'save', draft);
    headers.set('if-match', '"3"');
    const locked = await api.routines.mutate(headers, saved.routine.id, 'lock', resaved);
    const duplicate = await api.routines.duplicate(headers, saved.routine.id, false);
    expect(Object.keys(duplicate).sort()).toEqual(['media', 'routine']);
    expect(duplicate.routine).toMatchObject({ locked: false, published: false, revision: 1 });
    for (const body of [resaved, locked, duplicate]) expect(body.routine.filler).toStrictEqual(input.routine.filler);
    expect(await api.routines.get(playerHeaders, saved.routine.id, true)).toStrictEqual(JSON.parse(JSON.stringify(publication)));
    for (const suffix of ['', '/chunks/0']) {
      expect((await api.handle(request(`media/${fillerAsset.id}${suffix}?routineId=${saved.routine.id}`, 'GET', playerHeaders))).status).toBe(200);
      expect((await api.handle(request(`media/${unrelatedAsset.id}${suffix}?routineId=${saved.routine.id}`, 'GET', playerHeaders))).status).toBe(403);
      expect((await api.handle(request(`media/${fillerAsset.id}${suffix}?routineId=${duplicate.routine.id}`, 'GET', playerHeaders))).status).toBe(404);
      expect((await api.handle(request(`media/${fillerAsset.id}${suffix}`, 'GET', playerHeaders))).status).toBe(403);
    }
    expect([...context.store.blobs.entries()].filter(([key]) => key.startsWith('publications/'))).toEqual(rawPublished);
    headers.set('if-match', '"4"');
    await api.routines.mutate(headers, saved.routine.id, 'unlock');
    headers.set('if-match', '"5"');
    const republished = await api.routines.mutate(headers, saved.routine.id, 'publish');
    expect(republished.routine.filler).toStrictEqual(input.routine.filler);
    for (const [key, blob] of rawPublished) expect(context.store.blobs.get(key)).toEqual(blob);
  });

  it('logically deletes an unused recording without changing its retained descriptor or audio', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const fillers = new CloudFillers(context.store, context.auth, media);
    const asset = await uploadAudio(media, headers);
    const before = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('assets/'));
    const recording = await fillers.create(headers, { name: '<literal recording>', duration: 15, asset });
    await activateLibrary(context.store);
    headers.set('if-match', '"0"');
    expect(recording).toEqual({ id: expect.any(String), name: '<literal recording>', duration: 15, asset });
    expect(recording.id).not.toBe(asset.id);
    expect(await fillers.list(headers)).toEqual({ fillers: [recording] });
    expect(await fillers.archive(headers, recording.id)).toEqual({ archived: true });
    const retained = context.store.blobs.get(`fillers/records/${recording.id}`)!;
    expect(await fillers.archive(headers, recording.id)).toEqual({ archived: true });
    expect(context.store.blobs.get(`fillers/records/${recording.id}`)).toEqual(retained);
    expect(await fillers.list(headers)).toEqual({ fillers: [] });
    expect(await fillers.resolve(recording)).toStrictEqual(recording);
    expect([...context.store.blobs.entries()].filter(([key]) => key.startsWith('assets/'))).toEqual(before);
    expect((await readJson<{ fillers: number }>(context.store, 'control/quota'))!.value.fillers).toBe(1);
  });
});

describe('cloud configuration and Blob-backed auth (in-process Blob fake, not Azure)', () => {
  it('fails closed for duplicate, ownerless, unsafe or unbounded configuration', () => {
    const context = fixture();
    expect(loadConfig(context.env()).accounts).toHaveLength(3);
    for (const accounts of [[context.accounts[0], context.accounts[0]], [context.accounts[2]], Array(33).fill(context.accounts[0])]) {
      expect(() => loadConfig({ ...context.env(), FIM_ACCOUNTS_JSON: JSON.stringify(accounts) })).toThrow('unconfigured');
    }
    expect(() => loadConfig({ ...context.env(), FIM_ORIGIN: 'https://example.invalid/' })).toThrow('unconfigured');
    expect(() => parsePasswordHash(passwordHash.replace('32768', '1048576'))).toThrow('unconfigured');
  });

  it('creates opaque secure cookies and authenticates through an independent service', async () => {
    const context = fixture();
    const { result, headers } = await context.login();
    expect(result.setCookie).toContain('Path=/; HttpOnly; Secure; SameSite=Strict');
    expect(result.session.expiresAt).toBe(1900000000000 + 12 * 3600000);
    const independent = new CloudAuth(context.store, context.env, () => 1900000000000);
    expect((await independent.authenticate(headers, true)).account.id).toBe('owner');
    const missingCsrf = new Headers(headers);
    missingCsrf.delete('x-csrf-token');
    await expect(independent.authenticate(missingCsrf, true)).rejects.toMatchObject({ status: 403, code: 'csrf_invalid' });
    await expect(independent.authenticate(new Headers({ 'x-ms-client-principal': 'spoofed' }))).rejects.toMatchObject({ status: 401 });
  });

  it.each(['enabled', 'authVersion', 'role', 'passwordHash', 'username'] as const)('invalidates sessions on %s changes', async field => {
    const context = fixture();
    const { headers } = await context.login('editor');
    Object.assign(context.accounts[1]!, { [field]: { enabled: false, authVersion: 2, role: 'player',
      passwordHash: passwordHash.replace(/.$/, passwordHash.endsWith('0') ? '1' : '0'), username: 'renamed' }[field] });
    await expect(context.auth.authenticate(headers)).rejects.toMatchObject({ status: 401 });
  });

  it('enforces absolute expiry and explicit persistent logout', async () => {
    const context = fixture();
    const { headers } = await context.login();
    await context.auth.logout(headers);
    await expect(context.auth.authenticate(headers)).rejects.toMatchObject({ status: 401 });
    const second = await context.login('editor');
    context.advance(12 * 3600000);
    await expect(context.auth.authenticate(second.headers)).rejects.toMatchObject({ status: 401 });
  });

  it('requires the configured Origin on login and fails credentials uniformly', async () => {
    const context = fixture();
    await expect(context.auth.login(new Headers(), { username: 'owner', password: 'bad' })).rejects.toMatchObject({ status: 403 });
    for (const username of ['unknown', 'editor']) {
      await expect(context.auth.login(context.loginHeaders, { username, password: 'bad' })).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    }
    context.accounts[1]!.enabled = false;
    await expect(context.auth.login(context.loginHeaders, { username: 'editor', password: 'synthetic-test-password' }))
      .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('shares a bounded durable login throttle across service instances', async () => {
    const context = fixture();
    const independent = new CloudAuth(context.store, context.env, () => 1900000000000);
    for (let attempt = 0; attempt < 5; attempt++) await independent.throttle('owner');
    await expect(context.auth.throttle('owner')).rejects.toMatchObject({ status: 429 });
    expect([...context.store.blobs.keys()].filter(key => key.startsWith('throttle/')).length).toBeLessThanOrEqual(9);
  });

  it('requires session-bound CSRF when switching identities and revokes the old cookie', async () => {
    const context = fixture();
    const first = await context.login();
    const badHeaders = new Headers(first.headers);
    badHeaders.delete('x-csrf-token');
    await expect(context.auth.login(badHeaders, { username: 'editor', password: 'synthetic-test-password' }))
      .rejects.toMatchObject({ status: 403, code: 'csrf_invalid' });
    await context.auth.login(first.headers, { username: 'editor', password: 'synthetic-test-password' });
    await expect(context.auth.authenticate(first.headers)).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed if throttle storage fails, before invoking scrypt', async () => {
    const context = fixture();
    vi.spyOn(context.store, 'put').mockRejectedValue(new ApiError(503, 'storage_unavailable'));
    await expect(context.login()).rejects.toMatchObject({ status: 503 });
    expect([...context.store.blobs.keys()].filter(key => key.startsWith('sessions/'))).toHaveLength(0);
  });
});

describe('durable routine CAS semantics (Blob fake)', () => {
  it.each([
    ['lock', 'publish'], ['lock', 'delete'], ['save', 'publish'], ['save', 'delete'], ['publish', 'delete'],
  ] as const)('races %s against %s at the durable head without exposing the losing snapshot', async (firstAction, secondAction) => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const first = new CloudRoutines(context.store, context.auth, media);
    const second = new CloudRoutines(context.store, context.auth, media);
    const created = await first.create(headers, routine(await uploadAudio(media, headers)));
    headers.set('if-match', '"1"');
    const originalPublication = await first.mutate(headers, created.routine.id, 'publish');
    const originalBlobs = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('publications/'));
    const body = await first.get(headers, created.routine.id, false);
    const edited = structuredClone(body);
    edited.routine.name = 'Concurrent content';
    edited.routine.tracks[0]!.gain = 0.375;
    edited.routine.filler.gain = 1.5;
    headers.set('if-match', '"2"');
    const headKey = `routines/${body.routine.id}/head`;
    const put = context.store.put.bind(context.store);
    const expectedTags: (string | null)[] = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (key === headKey) {
        expectedTags.push(expected);
        if (expectedTags.length === 2) release();
        await barrier;
      }
      return put(key, bytes, expected);
    });
    const actions = [firstAction, secondAction];
    const outcomes = await Promise.allSettled([
      first.mutate(headers, body.routine.id, firstAction, firstAction === 'save' ? edited : undefined),
      second.mutate(headers, body.routine.id, secondAction),
    ]);
    expect(expectedTags).toHaveLength(2);
    expect(expectedTags[0]).toBe(expectedTags[1]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { status: 412 } });
    const winner = actions[outcomes.findIndex(outcome => outcome.status === 'fulfilled')];
    if (winner === 'delete') {
      await expect(first.get(headers, body.routine.id, false)).rejects.toMatchObject({ status: 404 });
      await expect(first.get(headers, body.routine.id, true)).rejects.toMatchObject({ status: 404 });
    } else {
      const actual = await first.get(headers, body.routine.id, false);
      expect(actual.routine.revision).toBe(3);
      expect(actual.routine.locked).toBe(winner === 'lock');
      expect(actual.routine.name).toBe(winner === 'save' ? edited.routine.name : body.routine.name);
      expect(actual.routine.tracks).toStrictEqual(winner === 'save' ? edited.routine.tracks : body.routine.tracks);
      expect(actual.routine.filler).toStrictEqual(winner === 'save' ? edited.routine.filler : body.routine.filler);
      const publication = await first.get(headers, body.routine.id, true);
      expect(publication.routine.revision).toBe(winner === 'publish' ? 3 : originalPublication.routine.revision);
    }
    for (const [key, value] of originalBlobs) expect(context.store.blobs.get(key)).toEqual(value);
  });

  it('competes save and atomic save-and-lock on the same ETag across instances', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const first = new CloudRoutines(context.store, context.auth, media);
    const second = new CloudRoutines(context.store, context.auth, media);
    const body = await first.create(headers, routine(await uploadAudio(media, headers)));
    headers.set('if-match', '"1"');
    const saved = structuredClone(body);
    saved.routine.name = 'Saved';
    saved.routine.tracks[0]!.gain = 0;
    saved.routine.filler.gain = 1.5;
    const locked = structuredClone(body);
    locked.routine.name = 'Locked content';
    locked.routine.tracks[0]!.gain = 1.5;
    locked.routine.filler.gain = 0;
    const outcomes = await Promise.allSettled([
      first.mutate(headers, body.routine.id, 'save', saved),
      second.mutate(headers, body.routine.id, 'lock', locked),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { status: 412 } });
    const actual = await first.get(headers, body.routine.id, false);
    expect(actual.routine.revision).toBe(2);
    expect(actual.routine.name).toBe(actual.routine.locked ? 'Locked content' : 'Saved');
    expect(actual.routine.tracks).toStrictEqual(actual.routine.locked ? locked.routine.tracks : saved.routine.tracks);
    expect(actual.routine.filler).toStrictEqual(actual.routine.locked ? locked.routine.filler : saved.routine.filler);
  });

  it('protects locks, publication bytes, revision progression and tombstones', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const service = new CloudRoutines(context.store, context.auth, media);
    const asset = await uploadAudio(media, headers);
    const created = await service.create(headers, routine(asset));
    const id = created.routine.id;
    await expect(service.mutate(headers, id, 'lock')).rejects.toMatchObject({ status: 428 });
    headers.set('if-match', '"1"');
    const published = await service.mutate(headers, id, 'publish');
    const oldPublications = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('publications/'));
    expect(published.routine.published).toBe(true);
    expect(published.routine.tracks[0]!.cues[0]!.beep).toBe(true);
    headers.set('if-match', '"2"');
    await service.mutate(headers, id, 'lock');
    headers.set('if-match', '"3"');
    for (const command of ['save', 'delete', 'publish'] as const) {
      await expect(service.mutate(headers, id, command, command === 'save' ? published : undefined)).rejects.toMatchObject({ status: 423 });
    }
    await service.mutate(headers, id, 'unlock');
    await expect(service.mutate(headers, id, 'save', created)).rejects.toMatchObject({ status: 412 });
    const duplicate = await service.duplicate(headers, id, true);
    expect(duplicate.routine.id).not.toBe(id);
    expect(duplicate.routine.tracks[0]!.id).not.toBe(created.routine.tracks[0]!.id);
    expect(Object.values(duplicate.media)[0]).toEqual(asset);
    headers.set('if-match', '"4"');
    await service.mutate(headers, id, 'publish');
    for (const [key, value] of oldPublications) expect(context.store.blobs.get(key)).toEqual(value);
    headers.set('if-match', '"5"');
    await service.mutate(headers, id, 'delete');
    await expect(service.get(headers, id, true)).rejects.toMatchObject({ status: 404 });
    await expect(service.create(headers, created)).rejects.toMatchObject({ status: 409 });
  });

  it('enforces players only published and verifies every immutable asset descriptor', async () => {
    const context = fixture();
    const editor = await context.login('editor');
    const player = await context.login('player');
    const media = new CloudMedia(context.store, context.auth);
    const service = new CloudRoutines(context.store, context.auth, media);
    const asset = await uploadAudio(media, editor.headers);
    const body = await service.create(editor.headers, routine(asset));
    await expect(service.get(player.headers, body.routine.id, false)).rejects.toMatchObject({ status: 403 });
    await expect(service.list(player.headers, false)).rejects.toMatchObject({ status: 403 });
    await expect(service.create(player.headers, routine())).rejects.toMatchObject({ status: 403 });
    await expect(service.authorizeAsset(player.headers, asset.id, body.routine.id)).rejects.toMatchObject({ status: 404 });
    const invalid = routine({ ...asset, bytes: asset.bytes + 1 });
    await expect(service.create(editor.headers, invalid)).rejects.toMatchObject({ status: 400 });
    editor.headers.set('if-match', '"1"');
    await service.mutate(editor.headers, body.routine.id, 'publish');
    expect((await service.get(player.headers, body.routine.id, true)).routine.published).toBe(true);
    await service.authorizeAsset(player.headers, asset.id, body.routine.id);
    await expect(service.authorizeAsset(player.headers, asset.id, null)).rejects.toMatchObject({ status: 403 });
    await expect(service.authorizeAsset(player.headers, 'other-asset', body.routine.id)).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks account state before committing after content staging', async () => {
    const context = fixture();
    const { headers } = await context.login('editor');
    const service = new CloudRoutines(context.store, context.auth, new CloudMedia(context.store, context.auth));
    const put = context.store.put.bind(context.store);
    vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
      const etag = await put(key, bytes, expected);
      if (key.startsWith('snapshots/')) context.accounts[1]!.enabled = false;
      return etag;
    });
    await expect(service.create(headers, routine())).rejects.toMatchObject({ status: 401 });
    expect([...context.store.blobs.keys()].filter(key => key.startsWith('routines/'))).toHaveLength(0);
  });

  it('rejects lock mass assignment, missing/extra media and unsafe IDs', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const service = new CloudRoutines(context.store, context.auth, new CloudMedia(context.store, context.auth));
    const locked = routine();
    locked.routine.locked = true;
    await expect(service.create(headers, locked)).rejects.toMatchObject({ status: 400 });
    const unsafe = routine();
    unsafe.routine.id = '../escape';
    await expect(service.create(headers, unsafe)).rejects.toMatchObject({ status: 400 });
    const extra = routine();
    extra.media.extra = {} as CloudAsset;
    await expect(service.create(headers, extra)).rejects.toMatchObject({ status: 400 });
    for (const value of ['1', 'W/"1"', '"0"', '*', '"9007199254740992"']) expect(() => revisionHeader(value)).toThrow();
  });
});

describe('bounded native container signatures (structural fixtures, not decode tests)', () => {
  it('accepts only seven exact canonical asset types without relaxing fields or numbers', () => {
    expect(MEDIA_TYPES).toEqual(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm']);
    for (const contentType of MEDIA_TYPES) {
      const asset = { id: 'asset-1', bytes: 128, sha256: 'a'.repeat(64), contentType };
      const parsed = parseAsset(asset);
      expect(parsed).toEqual(asset);
      expect(Object.getPrototypeOf(parsed)).toBeNull();
      expect(Reflect.ownKeys(parsed).sort()).toStrictEqual(['bytes', 'contentType', 'id', 'sha256']);
      for (const change of [{ bytes: '128' }, { bytes: 128.5 }, { bytes: NaN }, { bytes: Infinity }, { bytes: 43 },
        { bytes: LIMITS.assetBytes + 1 }, { contentType: `${contentType};codecs=opus` }, { unknown: true }, { contentType: 'Audio/AAC' }]) {
        expect(() => parseAsset({ ...asset, ...change })).toThrow();
      }
    }
  });

  it('walks multiple complete ADTS frames, including CRC headers and a bounded partial final prefix frame', () => {
    expect(() => signature(adts(), 'audio/aac')).not.toThrow();
    const crcFrame = Buffer.from('fff0508001fffc0000211004608c1c', 'hex');
    expect(() => signature(Buffer.concat(Array.from({ length: 4 }, () => crcFrame)), 'audio/aac')).not.toThrow();
    expect(() => signature(adts(6000), 'audio/aac')).not.toThrow();
    expect(() => signature(adts(4).subarray(0, 28), 'audio/aac', adts(4).length)).toThrow('unsupported_media');
    expect(() => signature(adts(1), 'audio/aac')).toThrow('unsupported_media');
  });

  it.each([
    ['sync', 0, 0], ['layer', 1, 0xf7], ['profile', 2, 0xd0], ['rate', 2, 0x7c],
    ['zero channels', 3, 0], ['surround', 3, 0xc0], ['short frame', 4, 0],
    ['oversized frame', 4, 0xff], ['multiple raw blocks', 6, 0xfd], ['second sync', 13, 0],
    ['changed configuration', 15, 0x4c],
  ] as const)('rejects malformed ADTS %s', (_name, offset, value) => {
    const bytes = adts();
    bytes[offset] = value;
    expect(() => signature(bytes, 'audio/aac')).toThrow('unsupported_media');
  });

  it('rejects truncated ADTS payloads and header-looking garbage between frames', () => {
    expect(() => signature(adts().subarray(0, -1), 'audio/aac')).toThrow('unsupported_media');
    expect(() => signature(Buffer.concat([adts(2), Buffer.alloc(1), adts(2)]), 'audio/aac')).toThrow('unsupported_media');
    expect(() => signature(Buffer.concat([Buffer.alloc(8), adts()]), 'audio/aac')).toThrow('unsupported_media');
  });

  it.each(['free', 'skip', 'wide'])('walks leading MP4 %s atoms without searching their payload', kind => {
    expect(() => signature(mp4(atom(kind, Buffer.alloc(8))), 'audio/mp4')).not.toThrow();
    expect(() => signature(mp4(atom(kind, Buffer.alloc(8), true)), 'audio/mp4')).not.toThrow();
    expect(() => signature(mp4(atom('free'), atom('skip'), atom('wide')), 'audio/mp4')).not.toThrow();
    expect(() => signature(atom(kind, mp4()), 'audio/mp4')).toThrow('unsupported_media');
  });

  it('bounds MP4 atoms to both the asset and 64 KiB, including extended sizes and missing ftyp', () => {
    expect(() => signature(mp4(), 'audio/mp4')).not.toThrow();
    expect(() => signature(mp4(atom('free', Buffer.alloc(65504))), 'audio/mp4')).not.toThrow();
    expect(() => signature(mp4(atom('free', Buffer.alloc(65505))), 'audio/mp4')).toThrow('unsupported_media');
    for (const size of [0, 4, 0xffffffff]) {
      const bytes = mp4(atom('free'));
      bytes.writeUInt32BE(size);
      expect(() => signature(bytes, 'audio/mp4')).toThrow('unsupported_media');
    }
    const oversized = mp4(atom('free', Buffer.alloc(0), true));
    oversized.writeBigUInt64BE(0xffffffffffffffffn, 8);
    expect(() => signature(oversized, 'audio/mp4')).toThrow('unsupported_media');
    expect(() => signature(atom('free', Buffer.alloc(40)), 'audio/mp4')).toThrow('unsupported_media');
    expect(() => signature(mp4().subarray(0, 20), 'audio/mp4')).toThrow('unsupported_media');
    const highBitBrand = mp4();
    highBitBrand[8] = highBitBrand[8]! | 128;
    expect(() => signature(highBitBrand, 'audio/mp4')).toThrow('unsupported_media');
  });

  it.each(['A_VORBIS', 'A_OPUS', 'A_AAC'])('accepts audio-only WebM %s metadata with known and FFmpeg unknown-size Segments', codec => {
    for (const unknownSegment of [false, true]) {
      expect(() => signature(webm(webmTrack(codec), { unknownSegment }), 'audio/webm')).not.toThrow();
      expect(() => signature(webm(webmTrack(codec), { unknownSegment, clusterBytes: 70000 }), 'audio/webm')).not.toThrow();
    }
  });

  it.each([
    ['video', () => webmTrack('V_VP9', { type: 1 })],
    ['second video track', () => Buffer.concat([webmTrack(), webmTrack('V_VP9', { type: 1, number: 2 })])],
    ['Video element on audio', () => webmTrack('A_VORBIS', { extra: ebml('e0', Buffer.alloc(0)) })],
    ['ContentEncodings', () => webmTrack('A_VORBIS', { extra: ebml('6d80', ebml('6240', ebml('5035', Buffer.alloc(0)))) })],
    ['unknown codec', () => webmTrack('A_FLAC')],
    ['zero channels', () => webmTrack('A_VORBIS', { channels: 0 })],
    ['surround', () => webmTrack('A_VORBIS', { channels: 6 })],
    ['nonfinite rate', () => webmTrack('A_VORBIS', { rate: NaN })],
    ['invalid rate', () => webmTrack('A_VORBIS', { rate: 0 })],
    ['duplicate type', () => webmTrack('A_VORBIS', { extra: ebml('83', Buffer.from([2])) })],
    ['duplicate track number', () => Buffer.concat([webmTrack(), webmTrack()])],
    ['empty Tracks', () => Buffer.alloc(0)],
    ['unknown-size TrackEntry', () => Buffer.from('aeff', 'hex')],
  ] as const)('rejects WebM %s', (_name, tracks) => {
    expect(() => signature(webm(tracks()), 'audio/webm')).toThrow('unsupported_media');
  });

  it('requires structured EBML/Segment/Tracks within the prefix, rejecting magic in payloads and oversized elements', () => {
    expect(() => signature(webm(webmTrack(), { docType: 'matroska' }), 'audio/webm')).toThrow('unsupported_media');
    const fakeTracks = ebml('ec', webmTrack());
    expect(() => signature(webm(fakeTracks), 'audio/webm')).toThrow('unsupported_media');
    expect(() => signature(webm(webmTrack(), { beforeTracks: ebml('ec', Buffer.alloc(65536)) }), 'audio/webm')).toThrow('unsupported_media');
    expect(() => signature(webm(webmTrack('A_VORBIS', { extra: ebml('63a2', Buffer.alloc(65536)) })), 'audio/webm')).toThrow('unsupported_media');
    expect(() => signature(webm(webmTrack(), { beforeTracks: ebml('1f43b675', Buffer.alloc(0)) }), 'audio/webm')).toThrow('unsupported_media');
    const badHeader = webm();
    badHeader[4] = 0xfe;
    expect(() => signature(badHeader, 'audio/webm')).toThrow('unsupported_media');
    const oversized = webm(webmTrack(), { beforeTracks: Buffer.from('ec01fffffffffffffe', 'hex') });
    expect(() => signature(oversized, 'audio/webm')).toThrow('unsupported_media');
    for (let length = 0; length < 48; length++) {
      expect(() => signature(webm().subarray(0, length), 'audio/webm')).toThrow('unsupported_media');
    }
  });
});

describe('bounded durable media and quota (Blob fake)', () => {
  it.each(['audio/aac', 'audio/webm'])(
    'preserves native %s upload bytes, filler snapshots and authenticated publisher/player chunks', async contentType => {
      const context = fixture();
      const api = new CloudApi(context.store, context.env, context.auth.now);
      const { headers } = await context.login('editor');
      const playerHeaders = (await context.login('player')).headers;
      const bytes = contentType === 'audio/aac' ? adts(Math.ceil(LIMITS.chunkBytes / 13) + 4)
        : webm(webmTrack(), { unknownSegment: true, clusterBytes: LIMITS.chunkBytes });
      const asset = await uploadAudio(api.media, headers, bytes, contentType);
      expect(asset).toStrictEqual({ id: asset.id, contentType, bytes: bytes.length, sha256: hashBytes(bytes) });
      const quota = (await readJson<{ bytes: number }>(context.store, 'control/quota'))!.value.bytes;
      expect(quota).toBe(64 * 1024 * 1024 + bytes.length * 2 + 131072);
      const song = await api.routines.create(headers, routine(asset));
      expect(song.media['entry-one']).toStrictEqual(asset);
      headers.set('if-match', '"1"');
      const publishedSong = await api.routines.mutate(headers, song.routine.id, 'publish');
      expect((await api.routines.get(playerHeaders, song.routine.id, true)).media).toStrictEqual(JSON.parse(JSON.stringify(publishedSong.media)));
      const songCopy = await api.routines.duplicate(headers, song.routine.id, true);
      expect(Object.values(songCopy.media)).toStrictEqual([asset]);
      const created = await api.handle(request('fillers', 'POST', headers, { name: 'Native structural fixture', duration: 10, asset }));
      expect(created.status).toBe(201);
      const recording = JSON.parse(String(created.body)) as FillerRecording;
      expect(recording.asset).toStrictEqual(asset);
      expect((await api.handle(request(`fillers/${recording.id}`, 'GET', headers))).body).toBe(created.body);
      const trackAsset = await uploadAudio(api.media, headers);
      const input = routine(trackAsset);
      input.routine.filler = { mode: 'timed', sound: 'recording', seconds: 15, bpm: 100, recording };
      const saved = await api.routines.create(headers, input);
      expect(saved.routine.filler.recording).toStrictEqual(recording);
      const forged = structuredClone(input);
      forged.routine.filler.recording!.asset.contentType = 'audio/mp4';
      await expect(api.routines.parse(forged)).rejects.toMatchObject({ status: 400 });
      headers.set('if-match', '"1"');
      const published = await api.routines.mutate(headers, saved.routine.id, 'publish');
      const snapshots = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('publications/'));
      await legacyArchive(api.routines.fillers, recording.id);
      expect((await api.handle(request(`fillers/${recording.id}`, 'GET', headers))).body).toBe(created.body);
      const duplicate = await api.routines.duplicate(headers, saved.routine.id, true);
      expect(duplicate.routine.filler.recording).toStrictEqual(recording);
      expect((await api.routines.get(playerHeaders, saved.routine.id, true)).routine.filler).toStrictEqual(published.routine.filler);
      const unrelated = await uploadAudio(api.media, headers, bytes, contentType);
      const spoof = new Headers({ 'x-ms-client-principal': 'owner' });
      for (const suffix of ['', '/chunks/0']) {
        const path = `media/${asset.id}${suffix}`;
        expect((await api.handle(request(path, 'GET', new Headers()))).status).toBe(401);
        expect((await api.handle(request(path, 'GET', spoof))).status).toBe(401);
        expect((await api.handle(request(path, 'GET', playerHeaders))).status).toBe(403);
        expect((await api.handle(request(`${path}?routineId=${duplicate.routine.id}`, 'GET', playerHeaders))).status).toBe(404);
        expect((await api.handle(request(`media/${unrelated.id}${suffix}?routineId=${saved.routine.id}`, 'GET', playerHeaders))).status).toBe(403);
      }
      for (const actor of [headers, playerHeaders]) {
        const query = actor === playerHeaders ? `?routineId=${saved.routine.id}` : '';
        const descriptor = await api.handle(request(`media/${asset.id}${query}`, 'GET', actor));
        expect(descriptor.status).toBe(200);
        expect(JSON.parse(String(descriptor.body))).toStrictEqual({ asset, chunkBytes: LIMITS.chunkBytes, chunkCount: 2 });
        const chunks: Buffer[] = [];
        for (let index = 0; index < 2; index++) {
          const response = await api.handle(request(`media/${asset.id}/chunks/${index}${query}`, 'GET', actor));
          const expected = bytes.subarray(index * LIMITS.chunkBytes, (index + 1) * LIMITS.chunkBytes);
          expect(response.status).toBe(200);
          expect(Buffer.isBuffer(response.body)).toBe(true);
          expect((response.body as Buffer).equals(expected)).toBe(true);
          expect(response.headers).toMatchObject({ 'content-type': 'application/octet-stream',
            'x-content-sha256': hashBytes(expected), 'content-length': String(expected.length) });
          expect(response.headers['cache-control']).toContain('no-store');
          chunks.push(response.body as Buffer);
        }
        expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
        expect(hashBytes(Buffer.concat(chunks))).toBe(asset.sha256);
      }
      for (const [key, snapshot] of snapshots) expect(context.store.blobs.get(key)).toStrictEqual(snapshot);
    },
  );

  it('acknowledges validation separately without copying or publishing unvalidated media', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const bytes = wav();
    const upload = await media.initiate(headers, { bytes: bytes.length, sha256: hashBytes(bytes), contentType: 'audio/wav' });
    await media.putChunk(headers, upload.id, 0, bytes);
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const response = await api.handle(request(`media/uploads/${upload.id}/complete`, 'POST', headers));
    expect(response.status).toBe(202);
    expect(response.headers['retry-after']).toBe('0');
    expect(JSON.parse(String(response.body))).toEqual({ pending: true, done: false, phase: 'copying', copiedChunks: 0, chunkCount: 1 });
    expect([...context.store.blobs.keys()].filter(key => key.startsWith('assets/'))).toEqual([]);
    expect((await api.handle(request(`media/${upload.id}`, 'GET', headers))).status).toBe(404);
    expect((await api.handle(request(`media/uploads/${upload.id}/complete`, 'POST', headers,
      { copiedChunks: 1, sha256: hashBytes(bytes) }))).status).toBe(413);
  });

  it('finishes a full 128 MiB WAV with four ordered reads and at most eight copies per request', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const bytes = wav(LIMITS.assetBytes - 44);
    bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(96000, 24);
    bytes.writeUInt32LE(384000, 28);
    bytes.writeUInt16LE(4, 32);
    bytes.writeUInt16LE(16, 34);
    for (let index = 0; index < 64; index++) bytes.fill(index, Math.max(44, index * LIMITS.chunkBytes), (index + 1) * LIMITS.chunkBytes);
    const media = new CloudMedia(context.store, context.auth);
    const upload = await stageAudio(media, headers, bytes);
    expect(upload.chunkCount).toBe(64);
    const before = (await readJson<{ bytes: number }>(context.store, 'control/quota'))!.value.bytes;
    let clock = 0;
    let activeReads = 0;
    let peakReads = 0;
    const stagedReads: string[] = [];
    const permanentWrites: string[] = [];
    const get = context.store.get.bind(context.store);
    const put = context.store.put.bind(context.store);
    vi.spyOn(context.store, 'get').mockImplementation(async (key, maximum) => {
      clock += 200;
      if (!key.startsWith(`uploads/${upload.id}/chunks/`)) return get(key, maximum);
      stagedReads.push(key);
      peakReads = Math.max(peakReads, ++activeReads);
      try { return await get(key, maximum); }
      finally { activeReads--; }
    });
    vi.spyOn(context.store, 'put').mockImplementation(async (key, data, expected) => {
      clock += 200;
      if (key.startsWith(`assets/${upload.id}/chunks/`)) permanentWrites.push(key);
      if (key === `assets/${upload.id}/catalog`) {
        expect(JSON.parse(context.store.blobs.get(`uploads/${upload.id}/head`)!.bytes.toString())).toMatchObject({
          state: 'complete', finalization: { sha256: hashBytes(bytes), copiedChunks: 64 },
        });
      }
      return put(key, data, expected);
    });
    const complete = async () => {
      const started = clock;
      const writes = permanentWrites.length;
      const result = await new CloudMedia(context.store, context.auth, () => clock).complete(headers, upload.id);
      expect(clock - started).toBeLessThan(20000);
      expect(permanentWrites.length - writes).toBeLessThanOrEqual(8);
      return result;
    };
    expect(await complete()).toMatchObject({ pending: true, copiedChunks: 0, chunkCount: 64 });
    expect(peakReads).toBe(4);
    expect(stagedReads).toHaveLength(64);
    expect(permanentWrites).toHaveLength(0);
    expect(context.store.blobs.has(`assets/${upload.id}/catalog`)).toBe(false);
    for (let batch = 1; batch <= 8; batch++) {
      const result = await complete();
      if (batch < 8) {
        expect(result).toMatchObject({ pending: true, copiedChunks: batch * 8 });
        expect(context.store.blobs.has(`assets/${upload.id}/catalog`)).toBe(false);
      } else expect(result).toEqual({ id: upload.id, bytes: bytes.length, sha256: hashBytes(bytes), contentType: 'audio/wav' });
    }
    expect(stagedReads).toHaveLength(128);
    expect(new Set(permanentWrites).size).toBe(64);
    const downloadedHash = createHash('sha256');
    for (let index = 0; index < 64; index++) downloadedHash.update((await media.chunk(upload.id, index)).bytes);
    expect(downloadedHash.digest('hex')).toBe(hashBytes(bytes));
    expect((await readJson<{ bytes: number; active: object }>(context.store, 'control/quota'))!.value).toMatchObject({ bytes: before, active: {} });
  }, 30000);

  it.each(['copy', 'checkpoint-before', 'checkpoint-after', 'catalog-before', 'catalog-after', 'quota'] as const)(
    'resumes durable progress after an injected %s failure without rehashing acknowledged chunks', async failure => {
      const context = fixture();
      const { headers } = await context.login();
      const media = new CloudMedia(context.store, context.auth);
      const upload = await stageAudio(media, headers, wav(2 * LIMITS.chunkBytes));
      await media.complete(headers, upload.id);
      const put = context.store.put.bind(context.store);
      let injected = false;
      vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
        const head = key === `uploads/${upload.id}/head` ? JSON.parse(bytes.toString()) : undefined;
        const target = failure === 'copy' ? key === `assets/${upload.id}/chunks/1`
          : failure.startsWith('checkpoint') ? head?.finalization?.copiedChunks === 2
          : failure.startsWith('catalog') ? key === `assets/${upload.id}/catalog` : key === 'control/quota';
        if (!injected && target) {
          injected = true;
          if (failure.endsWith('after')) await put(key, bytes, expected);
          throw new ApiError(503, 'storage_unavailable');
        }
        return put(key, bytes, expected);
      });
      await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 503 });
      expect(injected).toBe(true);
      const cursor = (await readJson<{ finalization: { copiedChunks: number } }>(context.store, `uploads/${upload.id}/head`))!.value.finalization.copiedChunks;
      expect(cursor).toBe(failure === 'copy' || failure === 'checkpoint-before' ? 1 : failure === 'checkpoint-after' ? 2 : 3);
      const get = vi.spyOn(context.store, 'get');
      const asset = await new CloudMedia(context.store, context.auth).complete(headers, upload.id);
      expect(asset).toMatchObject({ id: upload.id });
      const resumedReads = get.mock.calls.filter(([key]) => key.startsWith(`uploads/${upload.id}/chunks/`)).map(([key]) => Number(key.split('/').at(-1)));
      expect(resumedReads).toEqual(Array.from({ length: 3 - cursor }, (_, offset) => cursor + offset));
      expect((await media.catalog(upload.id)).asset).toEqual(asset);
    });

  it.each(['copying', 'publishing'] as const)('yields at a deterministic %s deadline and never persists partial cryptographic state', async phase => {
    const context = fixture();
    const { headers } = await context.login();
    let clock = 0;
    const media = new CloudMedia(context.store, context.auth, () => clock);
    const upload = await stageAudio(media, headers, phase === 'copying' ? wav(2 * LIMITS.chunkBytes) : wav());
    const get = context.store.get.bind(context.store);
    const stalled = vi.spyOn(context.store, 'get').mockImplementation(async (key, maximum) => {
      if (key === `uploads/${upload.id}/chunks/0`) clock += 20000;
      return get(key, maximum);
    });
    await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 503, code: 'finalization_timeout' });
    expect((await readJson<{ finalization?: unknown }>(context.store, `uploads/${upload.id}/head`))!.value.finalization).toBeUndefined();
    expect([...context.store.blobs.keys()].some(key => key.startsWith('assets/'))).toBe(false);
    stalled.mockRestore();
    await media.complete(headers, upload.id);
    const put = context.store.put.bind(context.store);
    vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
      const etag = await put(key, bytes, expected);
      if (key === `uploads/${upload.id}/head` && JSON.parse(bytes.toString()).finalization?.copiedChunks === 1) clock += 20000;
      return etag;
    });
    expect(await media.complete(headers, upload.id)).toMatchObject({ pending: true, done: false, phase, copiedChunks: 1 });
    expect(context.store.blobs.has(`assets/${upload.id}/catalog`)).toBe(false);
    expect(await new CloudMedia(context.store, context.auth).complete(headers, upload.id)).toMatchObject({ id: upload.id });
  });

  it('makes competing copy cursors use the same ETag and preserves identical permanent bytes', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const bytes = wav(LIMITS.chunkBytes);
    const upload = await stageAudio(media, headers, bytes);
    await media.complete(headers, upload.id);
    const put = context.store.put.bind(context.store);
    const tags: (string | null)[] = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(context.store, 'put').mockImplementation(async (key, data, expected) => {
      if (key === `uploads/${upload.id}/head` && JSON.parse(data.toString()).finalization?.copiedChunks === 1) {
        tags.push(expected);
        if (tags.length === 2) release();
        await barrier;
      }
      return put(key, data, expected);
    });
    const results = await Promise.allSettled([media.complete(headers, upload.id),
      new CloudMedia(context.store, context.auth).complete(headers, upload.id)]);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toBe(tags[1]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'upload_conflict' } });
    expect(hashBytes(Buffer.concat([(await media.chunk(upload.id, 0)).bytes, (await media.chunk(upload.id, 1)).bytes]))).toBe(hashBytes(bytes));
  });

  it.each([false, true])('fences expiry cleanup against catalog publication (completion wins: %s)', async completionWins => {
    const context = fixture();
    let { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const upload = await stageAudio(media, headers);
    await media.complete(headers, upload.id);
    const before = (await readJson<{ bytes: number }>(context.store, 'control/quota'))!.value.bytes;
    const put = context.store.put.bind(context.store);
    let injected = false;
    vi.spyOn(context.store, 'put').mockImplementation(async (key, bytes, expected) => {
      if (!injected && key === `uploads/${upload.id}/head` && JSON.parse(bytes.toString()).state === 'complete') {
        injected = true;
        if (completionWins) await put(key, bytes, expected);
        context.advance(LIMITS.uploadMs);
        headers = (await context.login()).headers;
        await media.cleanup(headers);
        if (completionWins) throw new ApiError(503, 'storage_unavailable');
      }
      return put(key, bytes, expected);
    });
    await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: completionWins ? 503 : 409 });
    expect(context.store.blobs.has(`assets/${upload.id}/catalog`)).toBe(false);
    if (completionWins) expect(await media.complete(headers, upload.id)).toMatchObject({ id: upload.id });
    else await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 409, code: 'upload_closed' });
    expect((await readJson<{ bytes: number; active: object }>(context.store, 'control/quota'))!.value).toMatchObject({ bytes: before, active: {} });
  });

  it('rejects corrupt progress, changed staging bytes and revoked editors before publication', async () => {
    const context = fixture();
    const { headers } = await context.login('editor');
    const media = new CloudMedia(context.store, context.auth);
    const bytes = wav();
    const upload = await stageAudio(media, headers, bytes);
    await media.complete(headers, upload.id);
    const key = `uploads/${upload.id}/head`;
    const sealed = context.store.blobs.get(key)!;
    for (const finalization of [{ sha256: 'a'.repeat(64), copiedChunks: 0 },
      { sha256: hashBytes(bytes), copiedChunks: -1 }, { sha256: hashBytes(bytes), copiedChunks: 0.5 },
      { sha256: hashBytes(bytes), copiedChunks: 2 }]) {
      context.store.blobs.set(key, { etag: sealed.etag, bytes: encode({ ...JSON.parse(sealed.bytes.toString()), finalization }) });
      await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 503 });
    }
    context.store.blobs.set(key, sealed);
    const chunkKey = `uploads/${upload.id}/chunks/0`;
    const chunk = context.store.blobs.get(chunkKey)!;
    context.store.blobs.delete(chunkKey);
    await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 409, code: 'upload_corrupt' });
    context.store.blobs.set(chunkKey, { ...chunk, bytes: Buffer.alloc(bytes.length) });
    await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 409, code: 'upload_corrupt' });
    context.store.blobs.set(chunkKey, chunk);
    const put = context.store.put.bind(context.store);
    vi.spyOn(context.store, 'put').mockImplementation(async (key, data, expected) => {
      const etag = await put(key, data, expected);
      if (key.startsWith('assets/')) context.accounts[1]!.enabled = false;
      return etag;
    });
    await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 401 });
    expect(context.store.blobs.has(`assets/${upload.id}/catalog`)).toBe(false);
    expect((await readJson<{ finalization: { copiedChunks: number } }>(context.store, key))!.value.finalization.copiedChunks).toBe(0);
  });

  it('uploads multiple chunks, verifies SHA-256, returns identical immutable bytes and retries completion', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const bytes = wav(LIMITS.chunkBytes + 100);
    const asset = await uploadAudio(media, headers, bytes);
    const downloaded = Buffer.concat([(await media.chunk(asset.id, 0)).bytes, (await media.chunk(asset.id, 1)).bytes]);
    expect(downloaded).toEqual(bytes);
    expect(await media.complete(headers, asset.id)).toEqual(asset);
    expect((await readJson<{ active: object }>(context.store, 'control/quota'))!.value.active).toEqual({});
    await expect(media.putChunk(headers, asset.id, 0, bytes.subarray(0, LIMITS.chunkBytes))).rejects.toMatchObject({ status: 409 });
  });

  it('rejects mismatched final hashes, signatures and conflicting chunk retries', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const bytes = wav();
    const upload = await media.initiate(headers, { bytes: bytes.length, sha256: 'a'.repeat(64), contentType: 'audio/wav' });
    await media.putChunk(headers, upload.id, 0, bytes);
    await media.putChunk(headers, upload.id, 0, bytes);
    await expect(media.putChunk(headers, upload.id, 0, Buffer.alloc(bytes.length))).rejects.toMatchObject({ status: 409 });
    await expect(media.complete(headers, upload.id)).rejects.toMatchObject({ status: 422 });
    await expect(media.catalog(upload.id)).rejects.toMatchObject({ status: 404 });
    expect([...context.store.blobs.keys()].some(key => key.startsWith('assets/'))).toBe(false);
    await expect(uploadAudio(media, headers, Buffer.alloc(100))).rejects.toMatchObject({ status: 415 });
    await expect(media.initiate(headers, { bytes: LIMITS.assetBytes + 1, sha256: 'a'.repeat(64), contentType: 'audio/wav' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('bounds quota contention, charges abandoned allocations and releases only slots in cleanup', async () => {
    const context = fixture();
    const { headers } = await context.login();
    const media = new CloudMedia(context.store, context.auth);
    const bytes = wav();
    const upload = await media.initiate(headers, { bytes: bytes.length, sha256: hashBytes(bytes), contentType: 'audio/wav' });
    const before = (await readJson<{ bytes: number }>(context.store, 'control/quota'))!.value.bytes;
    context.advance(LIMITS.uploadMs);
    const renewed = await context.login();
    expect(await media.cleanup(renewed.headers)).toEqual({ releasedSlots: 1, more: false });
    expect((await readJson<{ bytes: number }>(context.store, 'control/quota'))!.value.bytes).toBe(before);
    await expect(media.putChunk(renewed.headers, upload.id, 0, bytes)).rejects.toMatchObject({ status: 409 });
    const quota = new QuotaBudget(context.store);
    const amount = Math.floor((LIMITS.quotaBytes - before) * 0.75);
    const results = await Promise.allSettled([quota.charge(amount), new QuotaBudget(context.store).charge(amount)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 507 } });
  });

  it('validates supported signatures and rejects spoofed or excessive PCM headers', () => {
    const bytes = wav();
    const asset = { id: 'asset', bytes: bytes.length, sha256: hashBytes(bytes), contentType: 'audio/wav' };
    expect(() => validateSignature(bytes, asset)).not.toThrow();
    bytes.writeUInt16LE(100, 22);
    expect(() => validateSignature(bytes, asset)).toThrow('unsupported_media');
    expect(() => validateSignature(Buffer.alloc(64), { ...asset, contentType: 'audio/mp4' })).toThrow('unsupported_media');
  });
});

describe('actual HTTP dispatcher (Blob fake; no Azure ingress claim)', () => {
  it.each([
    [undefined, undefined], [0, undefined], [undefined, 1.5], [0.875, 0.375], [1.5, 0],
  ])('round-trips optional track/filler gains %s/%s through HTTP snapshots and copies', async (trackGain, fillerGain) => {
    const context = fixture();
    const { headers } = await context.login('editor');
    const player = await context.login('player');
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const asset = await uploadAudio(api.media, headers);
    const input = routine(asset);
    if (trackGain !== undefined) input.routine.tracks[0]!.gain = trackGain;
    if (fillerGain !== undefined) input.routine.filler.gain = fillerGain;
    const before = structuredClone(input);
    const created = await api.handle(request('routines', 'POST', headers, input));
    expect(created).toMatchObject({ status: 201, headers: { etag: '"1"' } });
    expect(JSON.parse(created.body.toString())).toStrictEqual({ ...before, routine: { ...before.routine, savedAt: context.auth.now() } });
    const path = `routines/${input.routine.id}`;
    let body: CloudRoutine = JSON.parse(created.body.toString());
    body.routine.name = 'Saved household draft';
    headers.set('if-match', created.headers.etag!);
    const saved = await api.handle(request(path, 'PUT', headers, body));
    expect(saved).toMatchObject({ status: 200, headers: { etag: '"2"' } });
    body = JSON.parse(saved.body.toString());
    headers.set('if-match', saved.headers.etag!);
    const locked = await api.handle(request(`${path}/lock`, 'POST', headers, body));
    expect(locked).toMatchObject({ status: 200, headers: { etag: '"3"' } });
    headers.set('if-match', locked.headers.etag!);
    const unlocked = await api.handle(request(`${path}/unlock`, 'POST', headers));
    expect(unlocked).toMatchObject({ status: 200, headers: { etag: '"4"' } });
    headers.set('if-match', unlocked.headers.etag!);
    const published = await api.handle(request(`${path}/publish`, 'POST', headers));
    expect(published).toMatchObject({ status: 200, headers: { etag: '"5"' } });
    const draftRead = await api.handle(request(path, 'GET', headers));
    const playbackRead = await api.handle(request(`${path}?published=true`, 'GET', player.headers));
    expect(draftRead).toMatchObject({ status: 200, headers: { etag: '"5"' } });
    expect(playbackRead).toMatchObject({ status: 200, headers: { etag: '"5"' }, body: published.body });
    expect(JSON.parse(draftRead.body.toString()).routine).toMatchObject({ published: false, locked: false, revision: 5 });
    expect(JSON.parse(published.body.toString()).routine).toMatchObject({ published: true, locked: false, revision: 5 });
    for (const response of [saved, locked, unlocked, published, draftRead, playbackRead]) {
      const snapshot: CloudRoutine = JSON.parse(response.body.toString());
      expect(snapshot.routine.tracks).toStrictEqual(before.routine.tracks);
      expect(snapshot.routine.filler).toStrictEqual(before.routine.filler);
      expect(snapshot.media).toStrictEqual(before.media);
    }
    for (const suffix of ['', '?published=true']) {
      const duplicated = await api.handle(request(`${path}/duplicate${suffix}`, 'POST', headers));
      expect(duplicated).toMatchObject({ status: 201, headers: { etag: '"1"' } });
      const copy: CloudRoutine = JSON.parse(duplicated.body.toString());
      expect(copy.routine.id).not.toBe(input.routine.id);
      expect(copy.routine).toMatchObject({ revision: 1, locked: false, published: false });
      const track = copy.routine.tracks[0]!;
      expect(track.id).not.toBe(before.routine.tracks[0]!.id);
      expect(track.cues[0]!.id).not.toBe(before.routine.tracks[0]!.cues[0]!.id);
      expect({ ...track, id: before.routine.tracks[0]!.id,
        cues: track.cues.map((cue, index) => ({ ...cue, id: before.routine.tracks[0]!.cues[index]!.id })) })
        .toStrictEqual(before.routine.tracks[0]);
      expect(copy.routine.filler).toStrictEqual(before.routine.filler);
      expect(copy.media).toStrictEqual({ [track.id]: asset });
      const copyRead = await api.handle(request(`routines/${copy.routine.id}`, 'GET', headers));
      expect(copyRead).toMatchObject({ status: 200, body: duplicated.body });
      headers.set('if-match', duplicated.headers.etag!);
      const deleted = await api.handle(request(`routines/${copy.routine.id}`, 'DELETE', headers));
      expect(deleted).toMatchObject({ status: 200, headers: { etag: '"2"' } });
      expect(JSON.parse(deleted.body.toString())).toStrictEqual({ ...copy, routine: { ...copy.routine, revision: 2 } });
    }
    expect(input).toStrictEqual(before);
  });

  it('keeps fresh UUID entries independent of shared or different audio bytes through gain edits and copies', async () => {
    const context = fixture();
    const { headers } = await context.login('editor');
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const firstBytes = wav();
    firstBytes.fill(0x21, 44);
    const secondBytes = Buffer.from(firstBytes);
    secondBytes[44] = 0x22;
    const firstAsset = await uploadAudio(api.media, headers, firstBytes);
    const secondAsset = await uploadAudio(api.media, headers, secondBytes);
    expect(firstAsset.id).not.toBe(secondAsset.id);
    expect(firstAsset.sha256).not.toBe(secondAsset.sha256);
    const selections = [
      { asset: firstAsset, gain: 0 }, { asset: firstAsset, gain: 1.5 }, { asset: secondAsset, gain: undefined },
    ];
    const input = routine(firstAsset);
    const template = input.routine.tracks[0]!;
    input.routine.tracks = selections.map(({ gain }) => ({
      ...structuredClone(template), id: randomUUID(),
      cues: template.cues.map(cue => ({ ...structuredClone(cue), id: randomUUID() })),
      ...(gain === undefined ? {} : { gain }),
    }));
    input.routine.filler.gain = 0.375;
    input.media = Object.fromEntries(input.routine.tracks.map((track, index) => [track.id, selections[index]!.asset]));
    const originalAssets = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('assets/'))
      .map(([key, value]) => ({ key, bytes: Buffer.from(value.bytes), etag: value.etag }));
    const created = await api.handle(request('routines', 'POST', headers, input));
    expect(created).toMatchObject({ status: 201, headers: { etag: '"1"' } });
    expect(JSON.parse(created.body.toString())).toStrictEqual({ ...input, routine: { ...input.routine, savedAt: context.auth.now() } });
    const path = `routines/${input.routine.id}`;
    headers.set('if-match', created.headers.etag!);
    const published = await api.handle(request(`${path}/publish`, 'POST', headers));
    expect(published).toMatchObject({ status: 200, headers: { etag: '"2"' } });
    expect(JSON.parse(published.body.toString())).toStrictEqual({ ...input,
      routine: { ...input.routine, revision: 2, published: true, savedAt: context.auth.now() } });
    const draft = await api.handle(request(path, 'GET', headers));
    expect(draft.status).toBe(200);
    const entryIds = new Set(input.routine.tracks.map(track => track.id));
    const cueIds = new Set(input.routine.tracks.flatMap(track => track.cues.map(cue => cue.id)));
    for (const suffix of ['', '?published=true']) {
      const duplicated = await api.handle(request(`${path}/duplicate${suffix}`, 'POST', headers));
      expect(duplicated).toMatchObject({ status: 201, headers: { etag: '"1"' } });
      const copy: CloudRoutine = JSON.parse(duplicated.body.toString());
      expect(copy.routine.id).not.toBe(input.routine.id);
      expect(copy.routine).toMatchObject({ revision: 1, locked: false, published: false });
      expect(copy.routine.tracks).toHaveLength(selections.length);
      expect(copy.routine.filler).toStrictEqual(input.routine.filler);
      expect(Object.keys(copy.media).sort()).toEqual(copy.routine.tracks.map(track => track.id).sort());
      for (const [index, track] of copy.routine.tracks.entries()) {
        const original = input.routine.tracks[index]!;
        expect(entryIds.has(track.id)).toBe(false);
        entryIds.add(track.id);
        for (const cue of track.cues) {
          expect(cueIds.has(cue.id)).toBe(false);
          cueIds.add(cue.id);
        }
        expect({ ...track, id: original.id,
          cues: track.cues.map((cue, cueIndex) => ({ ...cue, id: original.cues[cueIndex]!.id })) }).toStrictEqual(original);
        expect(copy.media[track.id]).toStrictEqual(selections[index]!.asset);
      }
      copy.routine.tracks[0]!.gain = 0.625;
      copy.routine.filler.gain = 0;
      headers.set('if-match', duplicated.headers.etag!);
      const saved = await api.handle(request(`routines/${copy.routine.id}`, 'PUT', headers, copy));
      expect(saved).toMatchObject({ status: 200, headers: { etag: '"2"' } });
      expect(JSON.parse(saved.body.toString())).toStrictEqual({ ...copy, routine: { ...copy.routine, revision: 2 } });
    }
    expect(await api.handle(request(path, 'GET', headers))).toMatchObject({ status: 200, body: draft.body });
    expect(await api.handle(request(`${path}?published=true`, 'GET', headers)))
      .toMatchObject({ status: 200, body: published.body });
    for (const [asset, bytes] of [[firstAsset, firstBytes], [secondAsset, secondBytes]] as const) {
      const download = await api.handle(request(`media/${asset.id}/chunks/0`, 'GET', headers));
      expect(download).toMatchObject({ status: 200, body: bytes, headers: { 'x-content-sha256': hashBytes(bytes) } });
    }
    expect([...context.store.blobs.keys()].filter(key => key.startsWith('assets/'))).toHaveLength(originalAssets.length);
    for (const { key, bytes, etag } of originalAssets) expect(context.store.blobs.get(key)).toStrictEqual({ bytes, etag });
  });

  it('updates the SAME ID draft after publish, keeps old publication bytes, and rejects locked or stale gain saves', async () => {
    const context = fixture();
    const { headers } = await context.login('owner');
    const player = await context.login('player');
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const input = routine(await uploadAudio(api.media, headers));
    input.routine.tracks[0]!.gain = 0.75;
    input.routine.filler.gain = 0.25;
    const created = await api.handle(request('routines', 'POST', headers, input));
    expect(created.status).toBe(201);
    const path = `routines/${input.routine.id}`;
    headers.set('if-match', created.headers.etag!);
    const published = await api.handle(request(`${path}/publish`, 'POST', headers));
    expect(published).toMatchObject({ status: 200, headers: { etag: '"2"' } });
    const publication: CloudRoutine = JSON.parse(published.body.toString());
    expect(publication.routine).toMatchObject({ id: input.routine.id, published: true, locked: false, revision: 2 });
    const oldPublications = [...context.store.blobs.entries()].filter(([key]) => key.startsWith('publications/'))
      .map(([key, value]) => ({ key, bytes: Buffer.from(value.bytes), etag: value.etag }));
    expect(oldPublications).toHaveLength(1);
    expect(await api.handle(request('routines', 'POST', headers, input)))
      .toMatchObject({ status: 409, body: '{"error":"routine_exists"}' });
    expect(await api.handle(request(path, 'PUT', headers, input)))
      .toMatchObject({ status: 412, body: '{"error":"revision_conflict"}' });
    headers.set('if-match', published.headers.etag!);
    expect(await api.handle(request(path, 'PUT', headers, publication)))
      .toMatchObject({ status: 400, body: '{"error":"invalid_routine_state"}' });
    const draftRead = await api.handle(request(path, 'GET', headers));
    expect(draftRead).toMatchObject({ status: 200, headers: { etag: '"2"' } });
    const draft: CloudRoutine = JSON.parse(draftRead.body.toString());
    expect(draft).toStrictEqual({ ...publication, routine: { ...publication.routine, published: false } });
    const edited = structuredClone(draft);
    edited.routine.tracks[0]!.gain = 1.5;
    edited.routine.filler.gain = 0;
    headers.set('if-match', draftRead.headers.etag!);
    const saved = await api.handle(request(path, 'PUT', headers, edited));
    expect(saved).toMatchObject({ status: 200, headers: { etag: '"3"' } });
    const expected = { ...edited, routine: { ...edited.routine, revision: 3 } };
    expect(JSON.parse(saved.body.toString())).toStrictEqual(expected);
    expect(await api.handle(request(path, 'GET', headers))).toMatchObject({ status: 200, body: saved.body });
    expect(await api.handle(request(`${path}?published=true`, 'GET', player.headers)))
      .toMatchObject({ status: 200, headers: { etag: '"2"' }, body: published.body });
    player.headers.set('if-match', saved.headers.etag!);
    for (const [route, method, body] of [
      ['routines', 'POST', input], [path, 'PUT', expected], [path, 'DELETE', undefined],
      [`${path}/lock`, 'POST', expected], [`${path}/unlock`, 'POST', undefined],
      [`${path}/publish`, 'POST', undefined], [`${path}/duplicate?published=true`, 'POST', undefined],
      [path, 'GET', undefined], ['routines', 'GET', undefined],
    ] as const) {
      expect((await api.handle(request(route, method, player.headers, body))).status).toBe(403);
    }
    headers.set('if-match', saved.headers.etag!);
    const locked = await api.handle(request(`${path}/lock`, 'POST', headers));
    expect(locked).toMatchObject({ status: 200, headers: { etag: '"4"' } });
    headers.set('if-match', locked.headers.etag!);
    for (const target of ['track', 'filler']) {
      const change: CloudRoutine = JSON.parse(locked.body.toString());
      (target === 'track' ? change.routine.tracks[0]! : change.routine.filler).gain = 1;
      for (const [route, method] of [[path, 'PUT'], [`${path}/lock`, 'POST']] as const) {
        expect(await api.handle(request(route, method, headers, change)))
          .toMatchObject({ status: 423, body: '{"error":"routine_locked"}' });
      }
    }
    expect(await api.handle(request(path, 'GET', headers))).toMatchObject({ status: 200, body: locked.body });
    const unlocked = await api.handle(request(`${path}/unlock`, 'POST', headers));
    expect(unlocked).toMatchObject({ status: 200, headers: { etag: '"5"' } });
    headers.set('if-match', saved.headers.etag!);
    expect(await api.handle(request(path, 'PUT', headers, expected)))
      .toMatchObject({ status: 412, body: '{"error":"revision_conflict"}' });
    const legacy: CloudRoutine = JSON.parse(unlocked.body.toString());
    delete legacy.routine.tracks[0]!.gain;
    delete legacy.routine.filler.gain;
    headers.set('if-match', unlocked.headers.etag!);
    const removed = await api.handle(request(path, 'PUT', headers, legacy));
    expect(removed).toMatchObject({ status: 200, headers: { etag: '"6"' } });
    expect(JSON.parse(removed.body.toString())).toStrictEqual({ ...legacy, routine: { ...legacy.routine, revision: 6 } });
    headers.set('if-match', removed.headers.etag!);
    const republished = await api.handle(request(`${path}/publish`, 'POST', headers));
    expect(republished).toMatchObject({ status: 200, headers: { etag: '"7"' } });
    expect(JSON.parse(republished.body.toString())).toStrictEqual({ ...legacy,
      routine: { ...legacy.routine, revision: 7, published: true } });
    expect(await api.handle(request(`${path}?published=true`, 'GET', player.headers)))
      .toMatchObject({ status: 200, body: republished.body });
    for (const { key, bytes, etag } of oldPublications) expect(context.store.blobs.get(key)).toStrictEqual({ bytes, etag });
  });

  it.each(['track', 'filler'])('rejects malformed %s gains at HTTP create, save and atomic lock without changing the head', async target => {
    const context = fixture();
    const { headers } = await context.login();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const input = routine(await uploadAudio(api.media, headers));
    const created = await api.handle(request('routines', 'POST', headers, input));
    expect(created.status).toBe(201);
    headers.set('if-match', created.headers.etag!);
    const path = `routines/${input.routine.id}`;
    const headKey = `${path}/head`;
    const head = await context.store.get(headKey, 4096);
    for (const gain of [null, '1', -0.01, 1.500001, false, [], {}, NaN, Infinity]) {
      const malformed = structuredClone(input);
      Object.assign(target === 'track' ? malformed.routine.tracks[0]! : malformed.routine.filler, { gain });
      for (const [route, method] of [['routines', 'POST'], [path, 'PUT'], [`${path}/lock`, 'POST']] as const) {
        expect(await api.handle(request(route, method, headers, malformed)))
          .toMatchObject({ status: 400, body: '{"error":"invalid_input"}' });
      }
    }
    const unknown = structuredClone(input);
    Object.assign(target === 'track' ? unknown.routine.tracks[0]! : unknown.routine.filler, { gain: 1, role: 'owner' });
    expect(await api.handle(request(path, 'PUT', headers, unknown)))
      .toMatchObject({ status: 400, body: '{"error":"invalid_input"}' });
    expect(await context.store.get(headKey, 4096)).toStrictEqual(head);
    expect(await api.handle(request(path, 'GET', headers))).toMatchObject({ status: 200, body: created.body });
  });

  it('publishes uploaded media and downloads authenticated binary chunks through the HTTP routes', async () => {
    const context = fixture();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const { headers } = await context.login();
    const bytes = wav();
    const initiated = await api.handle(request('media/uploads', 'POST', headers,
      { bytes: bytes.length, sha256: hashBytes(bytes), contentType: 'audio/wav' }));
    expect(initiated.status).toBe(201);
    const { id } = JSON.parse(String(initiated.body));
    const chunkHeaders = new Headers(headers);
    chunkHeaders.set('content-type', 'application/octet-stream');
    expect((await api.handle(request(`media/uploads/${id}/chunks/0`, 'PUT', chunkHeaders, bytes))).status).toBe(200);
    const pending = await api.handle(request(`media/uploads/${id}/complete`, 'POST', headers));
    expect(pending.status).toBe(202);
    expect(pending.headers['retry-after']).toBe('0');
    expect(JSON.parse(String(pending.body))).toMatchObject({ pending: true, done: false });
    const completed = await api.handle(request(`media/uploads/${id}/complete`, 'POST', headers));
    expect(completed.status).toBe(200);
    const asset: CloudAsset = JSON.parse(String(completed.body));
    const created = await api.handle(request('routines', 'POST', headers, routine(asset)));
    const body: CloudRoutine = JSON.parse(String(created.body));
    headers.set('if-match', created.headers.etag!);
    expect((await api.handle(request(`routines/${body.routine.id}/publish`, 'POST', headers))).status).toBe(200);
    const player = await context.login('player');
    expect((await api.handle(request(`media/${id}`, 'GET', player.headers))).status).toBe(403);
    const manifest = await api.handle(request(`media/${id}?routineId=${body.routine.id}`, 'GET', player.headers));
    expect(JSON.parse(String(manifest.body))).toMatchObject({ asset, chunkCount: 1, chunkBytes: LIMITS.chunkBytes });
    const download = await api.handle(request(`media/${id}/chunks/0?routineId=${body.routine.id}`, 'GET', player.headers));
    expect(download.status).toBe(200);
    expect(download.body).toEqual(bytes);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['x-content-sha256']).toBe(hashBytes(bytes));
    const list = await api.handle(request('routines?published=true', 'GET', player.headers));
    expect(JSON.parse(String(list.body)).routines).toHaveLength(1);
  });

  it('runs login/session/create/save/lock/unlock/duplicate/delete/logout with JSON and no-store responses', async () => {
    const context = fixture();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const login = await api.handle(request('auth/login', 'POST', context.loginHeaders, { username: 'owner', password: 'synthetic-test-password' }));
    expect(login.status).toBe(200);
    const session = JSON.parse(String(login.body));
    const headers = new Headers({ origin: context.env().FIM_ORIGIN, cookie: login.headers['set-cookie']!.split(';')[0]!, 'x-csrf-token': session.csrfToken });
    expect((await api.handle(request('auth/session', 'GET', headers))).status).toBe(200);
    const created = await api.handle(request('routines', 'POST', headers, routine()));
    expect(created.status).toBe(201);
    let body: CloudRoutine = JSON.parse(String(created.body));
    const id = body.routine.id;
    headers.set('if-match', created.headers.etag!);
    body.routine.name = 'Saved through HTTP';
    const saved = await api.handle(request(`routines/${id}`, 'PUT', headers, body));
    expect(saved.status).toBe(200);
    body = JSON.parse(String(saved.body));
    headers.set('if-match', saved.headers.etag!);
    const locked = await api.handle(request(`routines/${id}/lock`, 'POST', headers, body));
    expect(locked.status).toBe(200);
    headers.set('if-match', locked.headers.etag!);
    const unlocked = await api.handle(request(`routines/${id}/unlock`, 'POST', headers));
    expect(unlocked.status).toBe(200);
    expect((await api.handle(request(`routines/${id}/duplicate`, 'POST', headers))).status).toBe(201);
    headers.set('if-match', unlocked.headers.etag!);
    expect((await api.handle(request(`routines/${id}`, 'DELETE', headers))).status).toBe(200);
    expect((await api.handle(request(`routines/${id}`, 'GET', headers))).status).toBe(404);
    const logout = await api.handle(request('auth/logout', 'POST', headers));
    expect(logout.status).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect((await api.handle(request('auth/session', 'GET', headers))).status).toBe(401);
    expect(created.headers['cache-control']).toContain('no-store');
    expect(created.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('enforces byte limits without trusting Content-Length and refuses spoofed principals', async () => {
    const context = fixture();
    const api = new CloudApi(context.store, context.env, context.auth.now);
    const denied = await api.handle(request('routines', 'GET', new Headers({ 'x-ms-client-principal': 'pretend-owner' })));
    expect(denied.status).toBe(401);
    const huge = request('auth/login', 'POST', context.loginHeaders, Buffer.alloc(4097));
    huge.headers.set('content-type', 'application/json');
    expect((await api.handle(huge)).status).toBe(413);
    await expect(boundedBody(request('x', 'POST', new Headers(), Buffer.alloc(3)), 2)).rejects.toMatchObject({ status: 413 });
    const { headers } = await context.login();
    headers.delete('x-csrf-token');
    expect((await api.handle(request('routines', 'POST', headers, routine()))).status).toBe(403);
    expect((await api.handle(request('routines/%2e%2e%2fescape', 'GET', headers))).status).toBe(404);
  });

  it('returns sanitized 503 without echoing invalid configuration or storage exceptions', async () => {
    const context = fixture();
    const missing = new CloudApi(context.store, () => ({}));
    expect(await missing.handle(request('auth/session', 'GET', new Headers()))).toMatchObject({ status: 503, body: '{"error":"unconfigured"}' });
    vi.spyOn(context.store, 'get').mockRejectedValue(new Error('private-internal-fixture-detail'));
    const failed = await new CloudApi(context.store, context.env).handle(request('auth/session', 'GET', new Headers()));
    expect(failed.status).toBe(503);
    expect(String(failed.body)).not.toContain('private-internal');
  });
});

describe('Azure SDK adapter contract (fake ContainerClient)', () => {
  it.each(['request', 'operation'] as const)('terminates a stalled download body at the %s deadline', async deadlineKind => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const stream = new Readable({ read() { reading(); } });
    const container = { getBlobClient: () => ({ download: async () => ({
      etag: '"stalled"', contentLength: 4, readableStreamBody: stream,
    }) }) } as unknown as ContainerClient;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const timed = new AbortController();
      setTimeout(() => timed.abort(), milliseconds);
      return timed.signal;
    });
    try {
      const result = new AzureBlobStore(container, controller.signal).get('chunk', 4);
      const rejected = expect(result).rejects.toMatchObject({ status: 503, code: 'storage_unavailable' });
      await started;
      if (deadlineKind === 'request') controller.abort();
      else await vi.advanceTimersByTimeAsync(12000);
      await rejected;
      expect(stream.destroyed).toBe(true);
    } finally { stream.destroy(); timeout.mockRestore(); vi.useRealTimers(); }
  });

  it('registers the actual Functions v4 handler and binds login plus sanitized unconfigured responses', async () => {
    const context = fixture();
    const functions = await import('@azure/functions');
    const { handler } = await import('../src/cloud/functions');
    expect(functions.app.http).toHaveBeenCalledWith('cloud', expect.objectContaining({ route: '{*path}', authLevel: 'anonymous', handler }));
    for (const [key, value] of Object.entries(context.env())) vi.stubEnv(key, value);
    const connect = vi.spyOn(AzureBlobStore, 'connect').mockReturnValue(context.store as unknown as AzureBlobStore);
    try {
      const response = await handler(request('auth/login', 'POST', context.loginHeaders,
        { username: 'owner', password: 'synthetic-test-password' }) as unknown as import('@azure/functions').HttpRequest);
      expect(response.status).toBe(200);
      expect(JSON.parse(String(response.body)).user.id).toBe('owner');
      vi.stubEnv('FIM_ORIGIN', '');
      const unconfigured = await handler(request('auth/session', 'GET', new Headers()) as unknown as import('@azure/functions').HttpRequest);
      expect(unconfigured).toMatchObject({ status: 503, body: '{"error":"unconfigured"}' });
    } finally { connect.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('propagates a request deadline to every Azure operation', async () => {
    const deadline = AbortSignal.abort();
    const upload = vi.fn().mockImplementation(async (_bytes, _length, options) => {
      expect(options.abortSignal.aborted).toBe(true);
      throw new Error('aborted');
    });
    const container = { getBlockBlobClient: () => ({ upload }) } as unknown as ContainerClient;
    await expect(new AzureBlobStore(container, deadline).put('record', Buffer.alloc(0), null)).rejects.toMatchObject({ status: 503 });
  });

  it('sends real If-Match/If-None-Match options and bounds streamed reads', async () => {
    const upload = vi.fn().mockResolvedValue({ etag: '"next"' });
    const container = { getBlockBlobClient: () => ({ upload }), getBlobClient: () => ({
      download: async () => ({ etag: '"read"', contentLength: 3, readableStreamBody: Readable.from([Buffer.from('abc')]) }),
    }) } as unknown as ContainerClient;
    const store = new AzureBlobStore(container);
    await store.put('record', Buffer.from('a'), null);
    expect(upload.mock.calls[0]![2].conditions).toEqual({ ifNoneMatch: '*' });
    await store.put('record', Buffer.from('b'), '"old"');
    expect(upload.mock.calls[1]![2].conditions).toEqual({ ifMatch: '"old"' });
    expect((await store.get('record', 3))!.bytes.toString()).toBe('abc');
    await expect(store.get('record', 2)).rejects.toMatchObject({ status: 503 });
    upload.mockRejectedValue({ statusCode: 412 });
    await expect(store.put('record', Buffer.alloc(0), '"stale"')).rejects.toBeInstanceOf(BlobConflict);
  });

  it('rejects a public container rather than relying on HTTP auth to protect public blobs', async () => {
    const container = { getAccessPolicy: async () => ({ blobPublicAccess: 'blob' }) } as unknown as ContainerClient;
    await expect(new AzureBlobStore(container).verifyPrivate()).rejects.toMatchObject({ status: 503 });
  });
});