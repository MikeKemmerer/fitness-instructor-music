import { randomUUID } from 'node:crypto';
import { strictRecord } from '../validation';
import { cosmosAdmitted, type CosmosReferenceClaims } from './cosmos-admission';
import { CosmosConflict, type CosmosStoreLike } from './cosmos-store';
import { CosmosQuotaBudget } from './cosmos-quota';
import { CloudAuth, type Authenticated } from './auth';
import { ApiError, LIMITS, safeId } from './config';
import { HEAD_BYTES, HISTORY_LIMIT, revisionHeader, type DocumentKind, type DocumentState, type Mutation, type Pointer } from './documents';

export { HEAD_BYTES, HISTORY_LIMIT, revisionHeader, type DocumentKind, type DocumentState, type Mutation, type Pointer };

// randomUUID() output; snapshot pointers reference `snapshots` container item ids (no blob paths on Cosmos).
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

interface RevisionLink { revision: number; draft?: string; published?: string }
interface Head { draft: Pointer; published?: Pointer; deleted: boolean; history?: RevisionLink[] }
interface DocumentItem { id: string; documentId: string; kind: DocumentKind; head: Head }
// assetIds/name are denormalized onto every snapshot at write time so a single ARRAY_CONTAINS
// query against this container can answer "is this asset referenced anywhere" without scanning
// document bodies one at a time (replaces the Blob backend's resumable prefix-listing scan).
interface SnapshotItem<Body> { id: string; documentId: string; kind: DocumentKind; published: boolean; revision: number; name: string; assetIds: string[]; body: Body }

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

// Pluggable so admission/quota can stay unified on one store (currently Blob) while document
// storage (head/snapshots) moves to Cosmos per kind -- avoids a split-brain admission gate
// between Cosmos-backed documents and the still-Blob-based library browse/GC/fillers.
export interface DocumentsAdmission<Claims> {
  charge(bytes: number, options?: { routine?: boolean; filler?: boolean; upload?: { id: string; expiresAt: number } }): Promise<void>;
  admitted<Value>(action: (claims: Claims) => Promise<Value>): Promise<Value>;
}

export function cosmosDocumentsAdmission(store: CosmosStoreLike): DocumentsAdmission<CosmosReferenceClaims> {
  const budget = new CosmosQuotaBudget(store);
  return { charge: (bytes, options) => budget.charge(bytes, options), admitted: action => cosmosAdmitted(store, action) };
}

export abstract class CloudDocumentsCosmos<Body, Entity extends DocumentState, Claims extends { uncertain: boolean } = CosmosReferenceClaims> {
  readonly admission: DocumentsAdmission<Claims>;
  constructor(readonly store: CosmosStoreLike, readonly auth: CloudAuth, readonly kind: DocumentKind,
    admission?: DocumentsAdmission<Claims>) {
    this.admission = admission ?? (cosmosDocumentsAdmission(store) as unknown as DocumentsAdmission<Claims>);
  }

  abstract parse(input: unknown, headers: Headers, claims?: Claims): Promise<Body>;
  abstract entity(body: Body): Entity;
  abstract withEntity(body: Body, entity: Entity): Body;
  abstract copy(body: Body): Body;
  abstract validatePublication(body: Body): void;
  /** Every asset id this document body references -- used to populate snapshot.assetIds for GC/usage queries. */
  abstract assetIds(body: Body): string[];

  saved(body: Body): Body { return body; }
  validateReplacement(_previous: Body, _next: unknown): void {}

  documentItemId(id: string): string { return `${this.kind}:${id}`; }

  async recheck(headers: Headers, actor: Authenticated): Promise<void> {
    const fresh = await this.auth.authenticate(headers, true, true);
    if (fresh.key !== actor.key || fresh.account.id !== actor.account.id) throw new ApiError(401, 'signin_required');
  }

  validateHead(head: Head): void {
    try {
      strictRecord(head, ['draft', 'deleted', ...(Object.hasOwn(head, 'published') ? ['published'] : []),
        ...(Object.hasOwn(head, 'history') ? ['history'] : [])]);
      if (typeof head.deleted !== 'boolean') throw new Error();
      const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision >= 1;
      const validKey = (key: string) => typeof key === 'string' && UUID_PATTERN.test(key);
      const checkPointer = (pointer: Pointer) => {
        strictRecord(pointer, ['key', 'revision', 'name', 'locked', ...(Object.hasOwn(pointer, 'savedAt') ? ['savedAt'] : [])]);
        if (Object.hasOwn(pointer, 'savedAt') && (!Number.isSafeInteger(pointer.savedAt) || pointer.savedAt! < 0)) throw new Error();
        if (!validKey(pointer.key) || !validRevision(pointer.revision) || typeof pointer.locked !== 'boolean'
          || typeof pointer.name !== 'string' || !pointer.name.trim() || pointer.name.length > 160) throw new Error();
      };
      checkPointer(head.draft);
      if (head.published) {
        checkPointer(head.published);
        if (head.published.revision > head.draft.revision) throw new Error();
      }
      if (head.history !== undefined) {
        if (!Array.isArray(head.history) || !head.history.length || head.history.length > HISTORY_LIMIT) throw new Error();
        let previous = 0;
        for (const link of head.history) {
          strictRecord(link, ['revision', ...(Object.hasOwn(link, 'draft') ? ['draft'] : []),
            ...(Object.hasOwn(link, 'published') ? ['published'] : [])]);
          if (!validRevision(link.revision) || link.revision <= previous || link.revision > head.draft.revision
            || (!link.draft && !link.published) || (link.draft !== undefined && !validKey(link.draft))
            || (link.published !== undefined && !validKey(link.published))) throw new Error();
          previous = link.revision;
        }
        if (head.history.find(link => link.revision === head.draft.revision)?.draft !== head.draft.key
          || (head.published && head.history.find(link => link.revision === head.published!.revision)?.published !== head.published.key)) throw new Error();
      }
    } catch { throw new ApiError(503, 'storage_unavailable'); }
  }

  async storedDocument(id: string): Promise<{ value: Head; etag: string }> {
    if (!safeId(id)) throw new ApiError(400, 'invalid_id');
    const itemId = this.documentItemId(id);
    const stored = await this.store.read<DocumentItem>('documents', itemId, itemId);
    if (!stored) throw new ApiError(404, `${this.kind}_not_found`);
    this.validateHead(stored.body.head);
    return { value: stored.body.head, etag: stored.etag };
  }

  async head(id: string): Promise<{ value: Head; etag: string }> {
    const stored = await this.storedDocument(id);
    if (stored.value.deleted) throw new ApiError(404, `${this.kind}_not_found`);
    return stored;
  }

  history(head: Head): RevisionLink[] {
    if (head.history) return head.history.map(link => ({ ...link }));
    const links: RevisionLink[] = [{ revision: head.draft.revision, draft: head.draft.key }];
    if (head.published) {
      const current = links.find(link => link.revision === head.published!.revision);
      if (current) current.published = head.published.key;
      else links.push({ revision: head.published.revision, published: head.published.key });
    }
    return links.sort((first, second) => first.revision - second.revision);
  }

  async snapshot(id: string, pointer: Pick<Pointer, 'key' | 'revision'>): Promise<Body> {
    const stored = await this.store.read<SnapshotItem<Body>>('snapshots', pointer.key, id);
    if (!stored || stored.body.revision !== pointer.revision || this.entity(stored.body.body).revision !== pointer.revision) {
      throw new ApiError(503, 'storage_unavailable');
    }
    return stored.body.body;
  }

  async readVersion(id: string, published: boolean, revision?: number, retainPublished = false): Promise<Body> {
    if (typeof published !== 'boolean' || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))) {
      throw new ApiError(400, 'invalid_revision');
    }
    const { value: head } = await this.storedDocument(id);
    if (head.deleted && !(retainPublished && published && revision !== undefined)) throw new ApiError(404, `${this.kind}_not_found`);
    let pointer: Pick<Pointer, 'key' | 'revision'> | undefined = published ? head.published : head.draft;
    if (revision !== undefined) {
      const link = this.history(head).find(entry => entry.revision === revision);
      const key = published ? link?.published : link?.draft;
      if (!key) throw new ApiError(404, 'revision_not_found');
      pointer = { key, revision };
    }
    if (!pointer) throw new ApiError(404, 'publication_not_found');
    const body = await this.snapshot(id, pointer);
    const entity = this.entity(body);
    if (entity.id !== id || entity.published !== published) throw new ApiError(503, 'storage_unavailable');
    return body;
  }

  async get(headers: Headers, id: string, published: boolean, revision?: number): Promise<Body> {
    await this.auth.authenticate(headers, false, !published);
    return this.readVersion(id, published, revision);
  }

  async summaries(headers: Headers, published: boolean): Promise<Entity[]> {
    await this.auth.authenticate(headers, false, !published);
    const entities: Entity[] = [];
    for (const id of await this.discover()) {
      try { entities.push(this.entity(await this.readVersion(id, published))); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
    }
    return entities;
  }

  /** Direct indexed query replaces the Blob backend's resumable prefix-listing scan. */
  async discover(): Promise<string[]> {
    const ids = await this.store.query<string>('documents', 'SELECT VALUE c.documentId FROM c WHERE c.kind = @kind',
      [{ name: '@kind', value: this.kind }]);
    if (ids.length > LIMITS.routines) throw new ApiError(503, 'storage_unavailable');
    return ids;
  }

  pointer(key: string, body: Body): Pointer {
    const entity = this.entity(body);
    return { key, revision: entity.revision, name: entity.name, locked: entity.locked,
      ...(entity.savedAt !== undefined ? { savedAt: entity.savedAt } : {}) };
  }

  boundedHead(head: Head): void {
    if (head.history!.length > HISTORY_LIMIT) throw new ApiError(409, 'revision_limit_reached');
    if (jsonBytes(head) > HEAD_BYTES) throw new ApiError(409, 'revision_limit_reached');
  }

  async create(headers: Headers, input: unknown): Promise<Body> {
    const actor = await this.auth.authenticate(headers, true, true);
    return this.admission.admitted(async claims => {
      const body = this.saved(await this.parse(input, headers, claims));
      const entity = this.entity(body);
      if (entity.revision !== 1 || entity.locked || entity.published) throw new ApiError(400, `invalid_${this.kind}_state`);
      const id = entity.id;
      const itemId = this.documentItemId(id);
      if (await this.store.read<DocumentItem>('documents', itemId, itemId)) throw new ApiError(409, `${this.kind}_exists`);
      const snapshotId = randomUUID();
      const head: Head = { draft: this.pointer(snapshotId, body), deleted: false, history: [{ revision: 1, draft: snapshotId }] };
      this.boundedHead(head);
      await this.admission.charge(jsonBytes(body) + HEAD_BYTES + 4096, { routine: true });
      claims.uncertain = true;
      await this.store.create<SnapshotItem<Body>>('snapshots', { id: snapshotId, documentId: id, kind: this.kind, published: false, revision: 1,
        name: this.entity(body).name, assetIds: this.assetIds(body), body });
      await this.recheck(headers, actor);
      try { await this.store.create<DocumentItem>('documents', { id: itemId, documentId: id, kind: this.kind, head }); }
      catch (error) { if (error instanceof CosmosConflict) throw new ApiError(412, 'revision_conflict'); throw error; }
      return body;
    });
  }

  async mutate(headers: Headers, id: string, action: Mutation, input?: unknown): Promise<Body> {
    const actor = await this.auth.authenticate(headers, true, true);
    return this.admission.admitted(async claims => {
      if (!['save', 'lock', 'unlock', 'publish', 'delete'].includes(action) || (input !== undefined && action !== 'save' && action !== 'lock')) {
        throw new ApiError(400, 'invalid_input');
      }
      const expected = revisionHeader(headers.get('if-match'));
      const { value: oldHead, etag } = await this.head(id);
      if (oldHead.draft.locked && action !== 'unlock' && !(action === 'lock' && input === undefined)) throw new ApiError(423, `${this.kind}_locked`);
      if (oldHead.draft.revision !== expected) throw new ApiError(412, 'revision_conflict');
      if (expected >= Number.MAX_SAFE_INTEGER) throw new ApiError(412, 'revision_exhausted');
      const history = this.history(oldHead);
      if (history.length >= HISTORY_LIMIT) throw new ApiError(409, 'revision_limit_reached');
      const previous = await this.snapshot(id, oldHead.draft);
      if (input !== undefined) this.validateReplacement(previous, input);
      let body: Body = await this.parse(input === undefined ? previous : input, headers, claims);
      const entity = this.entity(body);
      if (entity.id !== id || entity.revision !== expected || entity.locked !== oldHead.draft.locked || entity.published) {
        throw new ApiError(400, `invalid_${this.kind}_state`);
      }
      if (action === 'publish') this.validatePublication(body);
      if (input !== undefined || action === 'save') body = this.saved(body);
      body = this.withEntity(body, { ...this.entity(body), revision: expected + 1,
        locked: action === 'lock' ? true : action === 'unlock' ? false : entity.locked, published: false });
      const publication = action === 'publish' ? this.withEntity(body, { ...this.entity(body), published: true }) : undefined;
      const snapshotId = randomUUID();
      const publicationId = publication ? randomUUID() : undefined;
      history.push({ revision: expected + 1, draft: snapshotId, ...(publicationId ? { published: publicationId } : {}) });
      const head: Head = { draft: this.pointer(snapshotId, body),
        published: publicationId && publication ? this.pointer(publicationId, publication) : oldHead.published,
        deleted: action === 'delete', history };
      this.boundedHead(head);
      await this.admission.charge(jsonBytes(body) + (publication ? jsonBytes(publication) : 0) + HEAD_BYTES);
      claims.uncertain = true;
      await this.store.create<SnapshotItem<Body>>('snapshots', { id: snapshotId, documentId: id, kind: this.kind, published: false, revision: expected + 1,
        name: this.entity(body).name, assetIds: this.assetIds(body), body });
      if (publicationId && publication) {
        await this.store.create<SnapshotItem<Body>>('snapshots', { id: publicationId, documentId: id, kind: this.kind, published: true, revision: expected + 1,
          name: this.entity(publication).name, assetIds: this.assetIds(publication), body: publication });
      }
      await this.recheck(headers, actor);
      const itemId = this.documentItemId(id);
      try { await this.store.replace<DocumentItem>('documents', itemId, itemId, { id: itemId, documentId: id, kind: this.kind, head }, etag); }
      catch (error) { if (error instanceof CosmosConflict) throw new ApiError(412, 'revision_conflict'); throw error; }
      return publication ?? body;
    });
  }

  async duplicate(headers: Headers, id: string, published: boolean, revision?: number): Promise<Body> {
    const actor = await this.auth.authenticate(headers, true, true);
    const body = await this.get(headers, id, published, revision);
    await this.recheck(headers, actor);
    return this.create(headers, this.copy(body));
  }
}
