import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { CloudAuth, derivePassword } from '../src/cloud/auth';
import { ApiError, safeId, type Account } from '../src/cloud/config';
import { BlobConflict, type BlobStore, type StoredBlob } from '../src/cloud/store';
import { CosmosConflict, type CosmosContainerName, type CosmosItem, type CosmosParameter, type CosmosStoreLike, type StoredItem } from '../src/cloud/cosmos-store';
import { CosmosQuotaBudget } from '../src/cloud/cosmos-quota';
import { CosmosAssetAdmission, cosmosAdmitted } from '../src/cloud/cosmos-admission';
import { CloudDocumentsCosmos, type DocumentState } from '../src/cloud/cosmos-documents';
import { CloudApi } from '../src/cloud/http';

// Fake in-memory Cosmos double: real CAS semantics (create fails if the id exists, replace/delete require a matching etag),
// but query() only understands the narrow `SELECT VALUE c.<field> FROM c [WHERE c.<field> = @param]` shape this codebase emits.
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
    const match = query.match(/^SELECT VALUE c\.(\w+) FROM c(?: WHERE c\.(\w+) = (@\w+))?$/);
    if (!match) throw new Error(`FakeCosmosStore.query: unsupported query "${query}"`);
    const [, projectField, whereField, whereParam] = match;
    const prefix = `${name}/`;
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

interface TestEntity extends DocumentState {}
interface TestBody { doc: TestEntity }

class TestDocuments extends CloudDocumentsCosmos<TestBody, TestEntity> {
  entity(body: TestBody): TestEntity { return body.doc; }
  withEntity(body: TestBody, doc: TestEntity): TestBody { return { doc }; }
  copy(body: TestBody): TestBody { return { doc: { id: randomUUID(), revision: 1, name: body.doc.name, locked: false, published: false } }; }
  validatePublication(body: TestBody): void { if (!body.doc.name.trim()) throw new ApiError(400, 'publication_requires_name'); }
  assetIds(): string[] { return []; }
  async parse(input: unknown): Promise<TestBody> {
    const value = input as { doc?: unknown } | undefined;
    const doc = value?.doc as TestEntity | undefined;
    if (!doc || typeof doc !== 'object') throw new ApiError(400, 'invalid_input');
    const { id, revision, name, locked, published, savedAt } = doc;
    if (!safeId(id) || !Number.isSafeInteger(revision) || revision < 1 || typeof name !== 'string' || !name.trim() ||
        typeof locked !== 'boolean' || typeof published !== 'boolean') throw new ApiError(400, 'invalid_input');
    return { doc: { id, revision, name, locked, published, ...(savedAt !== undefined ? { savedAt } : {}) } };
  }
}

let passwordHash: string;
beforeAll(async () => {
  const salt = Buffer.alloc(16, 9);
  passwordHash = `scrypt$32768$8$3$${salt.toString('hex')}$${(await derivePassword('synthetic-test-password', salt)).toString('hex')}`;
});

function fixture() {
  const accounts: Account[] = [{ id: 'owner', username: 'owner', passwordHash, role: 'owner', enabled: true, authVersion: 1 }];
  const env = () => ({ FIM_ORIGIN: 'https://example.invalid',
    FIM_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${Buffer.alloc(64).toString('base64')};EndpointSuffix=core.windows.net`,
    FIM_STORAGE_CONTAINER: 'private-media', FIM_ACCOUNTS_JSON: JSON.stringify(accounts) });
  const blobStore = new FakeBlobStore();
  const cosmos = new FakeCosmosStore();
  let now = 1900000000000;
  const auth = new CloudAuth(blobStore, env, () => now);
  const docs = new TestDocuments(cosmos, auth, 'routine');
  const login = async () => {
    const result = await auth.login(new Headers({ origin: env().FIM_ORIGIN }), { username: 'owner', password: 'synthetic-test-password' });
    return new Headers({ origin: env().FIM_ORIGIN, cookie: result.setCookie.split(';')[0]!, 'x-csrf-token': result.session.csrfToken });
  };
  return { cosmos, docs, login, advance: (ms: number) => { now += ms; } };
}

function draft(overrides: Partial<TestEntity> = {}): { doc: TestEntity } {
  return { doc: { id: randomUUID(), revision: 1, name: 'Draft', locked: false, published: false, ...overrides } };
}

describe('CloudDocumentsCosmos (create/mutate/duplicate against a fake Cosmos store)', () => {
  it('creates a document, rejects duplicate ids, and round-trips through get()', async () => {
    const { docs, login } = fixture();
    const headers = await login();
    const seed = draft();
    const created = await docs.create(headers, seed);
    expect(created.doc.id).toBe(seed.doc.id);
    expect(created.doc.revision).toBe(1);
    await expect(docs.create(headers, seed)).rejects.toMatchObject({ code: 'routine_exists' });
    const fetched = await docs.get(headers, seed.doc.id, false);
    expect(fetched).toEqual(created);
  });

  it('enforces if-match CAS on mutate and advances the revision on save', async () => {
    const { docs, login } = fixture();
    const headers = await login();
    const created = await docs.create(headers, draft());
    headers.set('if-match', '"99"');
    await expect(docs.mutate(headers, created.doc.id, 'save')).rejects.toMatchObject({ code: 'revision_conflict' });
    headers.set('if-match', '"1"');
    const saved = await docs.mutate(headers, created.doc.id, 'save', { doc: { ...created.doc, name: 'Renamed' } });
    expect(saved.doc.revision).toBe(2);
    expect(saved.doc.name).toBe('Renamed');
  });

  it('locks, blocks mutation while locked (except unlock), then unlocks', async () => {
    const { docs, login } = fixture();
    const headers = await login();
    const created = await docs.create(headers, draft());
    headers.set('if-match', '"1"');
    const locked = await docs.mutate(headers, created.doc.id, 'lock');
    expect(locked.doc.locked).toBe(true);
    headers.set('if-match', '"2"');
    await expect(docs.mutate(headers, created.doc.id, 'save')).rejects.toMatchObject({ code: 'routine_locked' });
    const unlocked = await docs.mutate(headers, created.doc.id, 'unlock');
    expect(unlocked.doc.locked).toBe(false);
  });

  it('publishes a revision, retains it as the published pointer, and rejects empty-name publication', async () => {
    const { docs, login } = fixture();
    const headers = await login();
    const created = await docs.create(headers, draft());
    headers.set('if-match', '"1"');
    const published = await docs.mutate(headers, created.doc.id, 'publish');
    expect(published.doc.published).toBe(true);
    const publishedGet = await docs.get(headers, created.doc.id, true);
    expect(publishedGet.doc.revision).toBe(published.doc.revision);
  });

  it('soft-deletes via mutate("delete") and hides the document from summaries(); discover() still lists the id', async () => {
    const { docs, login } = fixture();
    const headers = await login();
    const created = await docs.create(headers, draft());
    expect(await docs.discover()).toContain(created.doc.id);
    headers.set('if-match', '"1"');
    await docs.mutate(headers, created.doc.id, 'delete');
    await expect(docs.get(headers, created.doc.id, false)).rejects.toMatchObject({ code: 'routine_not_found' });
    expect(await docs.discover()).toContain(created.doc.id);
    expect(await docs.summaries(headers, false)).toEqual([]);
  });

  it('duplicates a document under a new id starting at revision 1', async () => {
    const { docs, login } = fixture();
    const headers = await login();
    const created = await docs.create(headers, draft({ name: 'Original' }));
    const duplicated = await docs.duplicate(headers, created.doc.id, false);
    expect(duplicated.doc.id).not.toBe(created.doc.id);
    expect(duplicated.doc.revision).toBe(1);
    expect(duplicated.doc.name).toBe('Original');
  });

  it('lists summaries for every discovered document', async () => {
    const { docs, login } = fixture();
    const headers = await login();
    const first = await docs.create(headers, draft({ name: 'First' }));
    const second = await docs.create(headers, draft({ name: 'Second' }));
    const summaries = await docs.summaries(headers, false);
    expect(summaries.map(entity => entity.id).sort()).toEqual([first.doc.id, second.doc.id].sort());
  });
});

describe('CosmosQuotaBudget (charge/finishUpload CAS retry against a fake Cosmos store)', () => {
  it('accumulates charges and enforces the byte ceiling', async () => {
    const cosmos = new FakeCosmosStore();
    const budget = new CosmosQuotaBudget(cosmos);
    await budget.charge(1024);
    await budget.charge(2048, { routine: true });
    const stored = await cosmos.read<{ id: string; bytes: number; operations: number; routines: number }>('system', 'quota', 'quota');
    expect(stored!.body.operations).toBe(2);
    expect(stored!.body.routines).toBe(1);
    await expect(budget.charge(10 * 1024 * 1024 * 1024)).rejects.toMatchObject({ code: 'storage_quota_exceeded' });
  });

  it('finishUpload clears the active entry and requires quota to already be initialized', async () => {
    const cosmos = new FakeCosmosStore();
    const budget = new CosmosQuotaBudget(cosmos);
    await expect(budget.finishUpload('missing')).rejects.toMatchObject({ code: 'storage_unavailable' });
    await budget.charge(0, { upload: { id: 'upload-1', expiresAt: 123 } });
    await budget.finishUpload('upload-1');
    const stored = await cosmos.read<{ id: string; active: Record<string, number> }>('system', 'quota', 'quota');
    expect(stored!.body.active).toEqual({});
  });
});

describe('CosmosAssetAdmission (acquire/release gate against a fake Cosmos store)', () => {
  it('acquires and releases claims, and blocks deleted assets', async () => {
    const cosmos = new FakeCosmosStore();
    const gate = new CosmosAssetAdmission(cosmos);
    const id = randomUUID();
    await gate.acquire(id, 'claim-a');
    await gate.acquire(id, 'claim-b');
    expect((await gate.read(id)).value.claims.sort()).toEqual(['claim-a', 'claim-b']);
    await gate.release(id, 'claim-a');
    expect((await gate.read(id)).value.claims).toEqual(['claim-b']);
    await gate.write(id, { version: 1, claims: [], deleted: true }, (await gate.read(id)).etag);
    await expect(gate.acquire(id, 'claim-c')).rejects.toMatchObject({ code: 'media_deleted' });
  });

  it('cosmosAdmitted releases claims on failure and retains them across a committed uncertain write', async () => {
    const cosmos = new FakeCosmosStore();
    const id = randomUUID();
    await expect(cosmosAdmitted(cosmos, async claims => {
      await claims.add(id);
      throw new ApiError(400, 'synthetic_failure');
    })).rejects.toMatchObject({ code: 'synthetic_failure' });
    const gate = new CosmosAssetAdmission(cosmos);
    expect((await gate.read(id)).value.claims).toEqual([]);

    const committed = await cosmosAdmitted(cosmos, async claims => {
      await claims.add(id);
      claims.uncertain = true;
      return 'ok';
    });
    expect(committed).toBe('ok');
    expect((await gate.read(id)).value.claims).toEqual([]);
  });
});

describe('CloudApi end-to-end with the Cosmos documents backend injected (fake Blob + fake Cosmos)', () => {
  function cosmosApiFixture() {
    const accounts: Account[] = [{ id: 'owner', username: 'owner', passwordHash, role: 'owner', enabled: true, authVersion: 1 }];
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
    const api = new CloudApi(blobStore, env, () => 1900000000000, cosmosStore);
    return { api, blobStore, cosmosStore, env };
  }

  it('creates and reads a routine through the real HTTP layer, storing it in Cosmos (not Blob)', async () => {
    const { api, blobStore, cosmosStore } = cosmosApiFixture();
    const login = await api.auth.login(new Headers({ origin: 'https://example.invalid' }), { username: 'owner', password: 'synthetic-test-password' });
    const headers = new Headers({ origin: 'https://example.invalid',
      cookie: login.setCookie.split(';')[0]!, 'x-csrf-token': login.session.csrfToken });
    const body = { routine: { schemaVersion: 2, id: randomUUID(), name: 'Cosmos-backed class', revision: 1, locked: false, published: false,
      tracks: [], filler: { mode: 'timed', seconds: 15, bpm: 100, sound: 'soft' }, crossfade: 2, beepEvery: 0, beepRemaining: 10,
      beepOnceRemaining: 0, beepVolume: 1 }, media: {} };
    const createHeaders = new Headers(headers);
    createHeaders.set('content-type', 'application/json');
    const createBytes = Buffer.from(JSON.stringify(body));
    const created = await api.handle({ method: 'POST', url: 'https://example.invalid/api/routines', headers: createHeaders,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(createBytes); controller.close(); } }) });
    expect(created.status).toBe(201);
    const routineId = JSON.parse(String(created.body)).routine.id as string;

    const fetched = await api.handle({ method: 'GET', url: `https://example.invalid/api/routines/${routineId}`, headers, body: null });
    expect(fetched.status).toBe(200);
    expect(JSON.parse(String(fetched.body)).routine.name).toBe('Cosmos-backed class');

    expect([...cosmosStore.items.keys()].some(key => key.startsWith('documents/routine:'))).toBe(true);
    expect([...cosmosStore.items.keys()].some(key => key.startsWith('snapshots/'))).toBe(true);
    expect([...blobStore.blobs.keys()].some(key => key.startsWith('routines/'))).toBe(false);
  });
});
