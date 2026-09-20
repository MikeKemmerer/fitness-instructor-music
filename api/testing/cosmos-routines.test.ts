import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import type { CloudMusicPlaylist, RevisionReference } from '../../shared/class-plan';
import type { CloudAsset, CloudRoutine } from '../../shared/cloud-contract';
import { newRoutine } from '../../shared/routine';
import { CloudAuth, derivePassword } from '../src/cloud/auth';
import type { CloudClassSetup } from '../src/cloud/cosmos-plans';
import { type CosmosContainerName, type CosmosItem, type CosmosParameter, type CosmosStoreLike, type StoredItem, CosmosConflict } from '../src/cloud/cosmos-store';
import type { Account } from '../src/cloud/config';
import { CloudApi } from '../src/cloud/http';
import { LIMITS } from '../src/cloud/config';
import { BlobConflict, encode, type BlobStore, type StoredBlob } from '../src/cloud/store';

// Same fakes as cosmos-documents.test.ts (kept local -- these two files stay independent by design).
class FakeCosmosStore implements CosmosStoreLike {
  readonly items = new Map<string, { body: CosmosItem; etag: string }>();
  sequence = 0;
  private nextEtag(): string { return `"${++this.sequence}"`; }
  private key(name: CosmosContainerName, id: string): string { return `${name}/${id}`; }
  async read<T extends CosmosItem>(name: CosmosContainerName, id: string, _partitionKey: string): Promise<StoredItem<T> | null> {
    const record = this.items.get(this.key(name, id));
    return record ? { body: structuredClone(record.body) as T, etag: record.etag } : null;
  }
  async create<T extends CosmosItem>(name: CosmosContainerName, body: T): Promise<string> {
    const key = this.key(name, body.id);
    if (this.items.has(key)) throw new CosmosConflict();
    const etag = this.nextEtag();
    this.items.set(key, { body: structuredClone(body), etag });
    return etag;
  }
  async replace<T extends CosmosItem>(name: CosmosContainerName, id: string, _partitionKey: string, body: T, expected: string): Promise<string> {
    const key = this.key(name, id);
    const record = this.items.get(key);
    if (!record || record.etag !== expected) throw new CosmosConflict();
    const etag = this.nextEtag();
    this.items.set(key, { body: structuredClone(body), etag });
    return etag;
  }
  async put<T extends CosmosItem>(name: CosmosContainerName, body: T, expected: string | null): Promise<string> {
    return expected === null ? this.create(name, body) : this.replace(name, body.id, body.id, body, expected);
  }
  async delete(name: CosmosContainerName, id: string, _partitionKey: string, expected: string): Promise<void> {
    const key = this.key(name, id);
    const record = this.items.get(key);
    if (!record) return;
    if (record.etag !== expected) throw new CosmosConflict();
    this.items.delete(key);
  }
  async query<T>(name: CosmosContainerName, query: string, parameters: CosmosParameter[]): Promise<T[]> {
    const prefix = `${name}/`;
    const arrayMatch = query.match(/^SELECT c\.(\w+(?:, c\.\w+)*) FROM c WHERE ARRAY_CONTAINS\(c\.(\w+), (@\w+)\)$/);
    if (arrayMatch) {
      const [, fieldsRaw, arrayField, param] = arrayMatch;
      const fields = fieldsRaw!.split(',').map(field => field.trim().replace(/^c\./, ''));
      const expected = parameters.find(parameter => parameter.name === param)?.value;
      const rows: T[] = [];
      for (const [key, record] of this.items) {
        if (!key.startsWith(prefix)) continue;
        const body = record.body as unknown as Record<string, unknown>;
        const array = body[arrayField!];
        if (!Array.isArray(array) || !array.includes(expected)) continue;
        const row: Record<string, unknown> = {};
        for (const field of fields) row[field] = body[field];
        rows.push(row as T);
      }
      return rows;
    }
    const match = query.match(/^SELECT VALUE c\.(\w+) FROM c(?: WHERE c\.(\w+) = (@\w+))?$/);
    if (!match) throw new Error(`FakeCosmosStore.query: unsupported query "${query}"`);
    const [, projectField, whereField, whereParam] = match;
    const rows: T[] = [];
    for (const [key, record] of this.items) {
      if (!key.startsWith(prefix)) continue;
      const body = record.body as unknown as Record<string, unknown>;
      if (whereField && whereParam) {
        const expected = parameters.find(parameter => parameter.name === whereParam)?.value;
        if (body[whereField] !== expected) continue;
      }
      rows.push(body[projectField!] as T);
    }
    return rows;
  }
}

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

async function uploadAudio(api: CloudApi, headers: Headers, bytes = wav()): Promise<CloudAsset> {
  const upload = await api.media.initiate(headers, { bytes: bytes.length, sha256: hashBytes(bytes), contentType: 'audio/wav' });
  for (let index = 0; index < upload.chunkCount; index++) {
    await api.media.putChunk(headers, upload.id, index, bytes.subarray(index * LIMITS.chunkBytes, (index + 1) * LIMITS.chunkBytes));
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await api.media.complete(headers, upload.id);
    if (!('pending' in result)) return result;
  }
  throw new Error('fixture completion did not converge');
}

function routine(asset?: CloudAsset): CloudRoutine {
  const value = newRoutine();
  if (asset) value.tracks.push({ id: 'entry-one', title: '<literal song>', duration: 60, bpm: 120, firstBeat: 0, bodyArea: '',
    cues: [{ id: 'cue-one', note: 'note', anchor: { kind: 'timestamp', seconds: 1 }, beep: true }] });
  return { routine: value, media: asset ? { 'entry-one': asset } : {} };
}

function musicPlaylist(asset: CloudAsset): CloudMusicPlaylist {
  const source = routine(asset);
  return { playlist: { schemaVersion: 1, id: randomUUID(), name: 'Cosmos playlist', revision: 1, locked: false, published: false,
    tracks: source.routine.tracks.map(track => ({ ...track, cues: [] })) }, media: source.media };
}

function pin(value: { id: string; revision: number; published: boolean }): RevisionReference {
  return { id: value.id, revision: value.revision, published: value.published };
}

function classPlan(source: RevisionReference): CloudClassSetup {
  return { setup: { schemaVersion: 1, id: randomUUID(), name: 'Cosmos class', revision: 1, locked: false,
    published: false, routine: source, crossfade: 2 } };
}

function request(path: string, method: string, headers: Headers, input?: unknown) {
  const nextHeaders = new Headers(headers);
  const bytes = input === undefined ? null : Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  if (input !== undefined && !Buffer.isBuffer(input)) nextHeaders.set('content-type', 'application/json');
  return { url: `https://example.invalid/api/${path}`, method, headers: nextHeaders,
    body: bytes === null ? null : new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

function atRevision(headers: Headers, revision: number): Headers {
  const result = new Headers(headers);
  result.set('if-match', `"${revision}"`);
  return result;
}

let passwordHash: string;
beforeAll(async () => {
  const salt = Buffer.alloc(16, 3);
  passwordHash = `scrypt$32768$8$3$${salt.toString('hex')}$${(await derivePassword('synthetic-test-password', salt)).toString('hex')}`;
});

function fixture() {
  const accounts: Account[] = [
    { id: 'owner', username: 'owner', passwordHash, role: 'owner', enabled: true, authVersion: 1 },
    { id: 'player', username: 'player', passwordHash, role: 'player', enabled: true, authVersion: 1 },
  ];
  const env = () => ({
    FIM_ORIGIN: 'https://example.invalid',
    FIM_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${Buffer.alloc(64).toString('base64')};EndpointSuffix=core.windows.net`,
    FIM_STORAGE_CONTAINER: 'private-media', FIM_ACCOUNTS_JSON: JSON.stringify(accounts),
    FIM_DOCUMENTS_BACKEND: 'cosmos',
    FIM_COSMOS_CONNECTION_STRING: `AccountEndpoint=https://fim-cosmos-pilot.documents.azure.com:443/;AccountKey=${Buffer.alloc(64).toString('base64')};`,
    FIM_COSMOS_DATABASE: 'fim',
  });
  const blobStore = new FakeBlobStore();
  const cosmosStore = new FakeCosmosStore();
  let now = 1900000000000;
  const auth = new CloudAuth(blobStore, env, () => now);
  const api = new CloudApi(blobStore, env, () => now, cosmosStore);
  const login = async (username = 'owner') => {
    const result = await auth.login(new Headers({ origin: 'https://example.invalid' }), { username, password: 'synthetic-test-password' });
    return { result, headers: new Headers({ origin: 'https://example.invalid',
      cookie: result.setCookie.split(';')[0]!, 'x-csrf-token': result.session.csrfToken }) };
  };
  return { api, blobStore, cosmosStore, login, advance: (ms: number) => { now += ms; } };
}

describe('Cosmos-backed routines/playlists/classes through the real CloudApi HTTP layer', () => {
  it('creates a routine referencing a Blob-uploaded asset; document lives in Cosmos, asset+gate live in Blob', async () => {
    const { api, blobStore, cosmosStore, login } = fixture();
    const { headers } = await login();
    const asset = await uploadAudio(api, headers);
    const created = await api.routines.create(headers, routine(asset));
    expect(created.routine.revision).toBe(1);

    expect([...cosmosStore.items.keys()].some(key => key.startsWith('documents/routine:'))).toBe(true);
    expect([...blobStore.blobs.keys()].some(key => key.startsWith('assets/'))).toBe(true);
    expect([...blobStore.blobs.keys()].some(key => key.startsWith('library/gates/'))).toBe(true);
    // Quota stays unified on Blob (control/quota), never on Cosmos, per the hybrid-admission design.
    expect(blobStore.blobs.has('control/quota')).toBe(true);
    expect([...cosmosStore.items.keys()].some(key => key.startsWith('system/'))).toBe(false);

    const fetched = await api.routines.get(headers, created.routine.id, false);
    expect(fetched).toEqual(created);
  });

  it('runs the full lock/unlock/publish/delete lifecycle and enforces CAS on stale revisions', async () => {
    const { api, login } = fixture();
    const { headers } = await login();
    const asset = await uploadAudio(api, headers);
    const created = await api.routines.create(headers, routine(asset));
    await expect(api.routines.mutate(atRevision(headers, 99), created.routine.id, 'save')).rejects.toMatchObject({ status: 412 });
    const locked = await api.routines.mutate(atRevision(headers, 1), created.routine.id, 'lock');
    expect(locked.routine.locked).toBe(true);
    await expect(api.routines.mutate(atRevision(headers, 2), created.routine.id, 'save')).rejects.toMatchObject({ status: 423 });
    const unlocked = await api.routines.mutate(atRevision(headers, 2), created.routine.id, 'unlock');
    const published = await api.routines.mutate(atRevision(headers, 3), created.routine.id, 'publish');
    expect(published.routine.published).toBe(true);
    expect((await api.routines.get(headers, created.routine.id, true)).routine.revision).toBe(published.routine.revision);
    await api.routines.mutate(atRevision(headers, published.routine.revision), created.routine.id, 'delete');
    await expect(api.routines.get(headers, created.routine.id, false)).rejects.toMatchObject({ status: 404 });
    void unlocked;
  });

  it('creates and publishes a playlist referencing Blob media, and enforces player asset authorization', async () => {
    const { api, login } = fixture();
    const owner = await login('owner');
    const asset = await uploadAudio(api, owner.headers);
    const created = await api.playlists.create(owner.headers, musicPlaylist(asset));
    const published = await api.playlists.mutate(atRevision(owner.headers, 1), created.playlist.id, 'publish');
    expect(published.playlist.published).toBe(true);

    const player = await login('player');
    await expect(api.playlists.authorizeAsset(player.headers, asset.id, created.playlist.id, published.playlist.revision)).resolves.toBeUndefined();
    await expect(api.playlists.authorizeAsset(player.headers, 'not-a-real-asset-id', created.playlist.id, published.playlist.revision))
      .rejects.toMatchObject({ status: 403 });
  });

  it('creates a class referencing a published routine, resolves it, and rejects publishing with an unpublished reference', async () => {
    const { api, login } = fixture();
    const { headers } = await login();
    const asset = await uploadAudio(api, headers);
    const draftRoutine = await api.routines.create(headers, routine(asset));
    const publishedRoutine = await api.routines.mutate(atRevision(headers, 1), draftRoutine.routine.id, 'publish');
    const setup = await api.classes.create(headers, classPlan(pin({ id: publishedRoutine.routine.id, revision: publishedRoutine.routine.revision, published: true })));
    const resolved = await api.classes.resolve(headers, setup.setup);
    expect(resolved.routine.routine.id).toBe(publishedRoutine.routine.id);

    const draftSetup = await api.classes.create(headers, classPlan(pin({ id: draftRoutine.routine.id, revision: draftRoutine.routine.revision, published: false })));
    await expect(api.classes.mutate(atRevision(headers, 1), draftSetup.setup.id, 'publish')).rejects.toMatchObject({ status: 400, code: 'published_references_required' });
  });

  it('handles the real HTTP request/response cycle end to end (login -> create -> get -> duplicate)', async () => {
    const { api, login } = fixture();
    const { headers } = await login();
    const create = await api.handle(request('routines', 'POST', headers, routine()));
    expect(create.status).toBe(201);
    const id = JSON.parse(String(create.body)).routine.id as string;
    const get = await api.handle(request(`routines/${id}`, 'GET', headers));
    expect(get.status).toBe(200);
    const duplicate = await api.handle(request(`routines/${id}/duplicate`, 'POST', headers));
    expect(duplicate.status).toBe(201);
    expect(JSON.parse(String(duplicate.body)).routine.id).not.toBe(id);
  });

  // Closes the safety gap the hybrid design was built to work around: GC (LibraryManagement.remove)
  // must recognize assets still referenced by Cosmos-backed documents, using a single ARRAY_CONTAINS
  // query over the snapshots container's denormalized assetIds/name (see cosmos-documents.ts) instead
  // of the Blob-only resumable scanner in library-references.ts.
  it('detects an asset referenced by a Cosmos-backed routine via the fast indexed query and blocks deletion', async () => {
    const { api, blobStore, login } = fixture();
    const { headers } = await login();
    await blobStore.put('control/library-admission-v1', encode({ version: 1, exclusiveWriters: true }), null);
    const asset = await uploadAudio(api, headers);
    const created = await api.routines.create(headers, routine(asset));

    const usage = await api.managed.usage(headers, 'song', asset.id);
    expect(usage).toEqual({ references: [{ kind: 'routine', id: created.routine.id, name: created.routine.name, revision: created.routine.revision }], complete: true });

    await expect(api.managed.remove(atRevision(headers, 0), 'song', asset.id)).rejects.toMatchObject({ status: 409, code: 'media_in_use' });
  });

  it('finds no references for an unrelated asset via the fast indexed query and allows deletion (no false positives)', async () => {
    const { api, blobStore, login } = fixture();
    const { headers } = await login();
    await blobStore.put('control/library-admission-v1', encode({ version: 1, exclusiveWriters: true }), null);
    const unrelated = await uploadAudio(api, headers, wav(4096));
    const referenced = await uploadAudio(api, headers);
    await api.routines.create(headers, routine(referenced));

    const usage = await api.managed.usage(headers, 'song', unrelated.id);
    expect(usage).toEqual({ references: [], complete: true });

    await expect(api.managed.remove(atRevision(headers, 0), 'song', unrelated.id)).resolves.toEqual({ deleted: true, bytesRetained: true });
  });
});

