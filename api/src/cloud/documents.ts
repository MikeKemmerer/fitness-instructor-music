import { randomUUID } from 'node:crypto';
import { strictRecord } from '../validation';
import { admitted, type ReferenceClaims } from './admission';
import { CloudAuth, type Authenticated } from './auth';
import { ApiError, LIMITS, safeId } from './config';
import { QuotaBudget } from './quota';
import { BlobConflict, encode, readJson, type BlobStore } from './store';

export const HISTORY_LIMIT = 128;
export const HEAD_BYTES = 64 * 1024;
export interface DocumentState { id: string; revision: number; name: string; locked: boolean; published: boolean; savedAt?: number }
export interface Pointer { key: string; revision: number; name: string; locked: boolean; savedAt?: number }
interface RevisionLink { revision: number; draft?: string; published?: string }
interface Head { draft: Pointer; published?: Pointer; deleted: boolean; history?: RevisionLink[] }
export type Mutation = 'save' | 'lock' | 'unlock' | 'publish' | 'delete';
export type DocumentKind = 'routine' | 'playlist' | 'class';

export function revisionHeader(header: string | null): number {
  if (header === null) throw new ApiError(428, 'revision_required');
  if (!/^"[1-9][0-9]{0,15}"$/.test(header)) throw new ApiError(400, 'invalid_revision');
  const revision = Number(header.slice(1, -1));
  if (!Number.isSafeInteger(revision)) throw new ApiError(400, 'invalid_revision');
  return revision;
}

export abstract class CloudDocuments<Body, Entity extends DocumentState> {
  readonly budget: QuotaBudget;
  constructor(readonly store: BlobStore, readonly auth: CloudAuth, readonly kind: DocumentKind) {
    this.budget = new QuotaBudget(store);
  }

  abstract parse(input: unknown, headers: Headers, claims?: ReferenceClaims): Promise<Body>;
  abstract entity(body: Body): Entity;
  abstract withEntity(body: Body, entity: Entity): Body;
  abstract copy(body: Body): Body;
  abstract validatePublication(body: Body): void;

  saved(body: Body): Body { return body; }
  validateReplacement(_previous: Body, _next: unknown): void {}

  get root(): string { return this.kind === 'class' ? 'classes' : `${this.kind}s`; }
  get indexPrefix(): string { return this.kind === 'routine' ? 'heads/' : `${this.root}/index/`; }
  headKey(id: string): string { return `${this.root}/${id}/head`; }
  snapshotPrefix(id: string, published = false): string {
    return this.kind === 'routine' ? `${published ? 'publications' : 'snapshots'}/${id}/`
      : `${this.root}/${id}/${published ? 'publications' : 'snapshots'}/`;
  }

  async recheck(headers: Headers, actor: Authenticated): Promise<void> {
    const fresh = await this.auth.authenticate(headers, true, true);
    if (fresh.key !== actor.key || fresh.account.id !== actor.account.id) throw new ApiError(401, 'signin_required');
  }

  validateHead(head: Head, id: string): void {
    try {
      strictRecord(head, ['draft', 'deleted', ...(Object.hasOwn(head, 'published') ? ['published'] : []),
        ...(Object.hasOwn(head, 'history') ? ['history'] : [])]);
      if (typeof head.deleted !== 'boolean') throw new Error();
      const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision >= 1;
      const validKey = (key: string, published: boolean) => typeof key === 'string'
        && key.startsWith(this.snapshotPrefix(id, published)) && safeId(key.slice(this.snapshotPrefix(id, published).length));
      const checkPointer = (pointer: Pointer, published: boolean) => {
        strictRecord(pointer, ['key', 'revision', 'name', 'locked', ...(Object.hasOwn(pointer, 'savedAt') ? ['savedAt'] : [])]);
        if (Object.hasOwn(pointer, 'savedAt') && (!Number.isSafeInteger(pointer.savedAt) || pointer.savedAt! < 0)) throw new Error();
        if (!validKey(pointer.key, published) || !validRevision(pointer.revision) || typeof pointer.locked !== 'boolean'
          || typeof pointer.name !== 'string' || !pointer.name.trim() || pointer.name.length > 160) throw new Error();
      };
      checkPointer(head.draft, false);
      if (head.published) {
        checkPointer(head.published, true);
        if (head.published.revision > head.draft.revision) throw new Error();
      }
      if (head.history !== undefined) {
        if (!Array.isArray(head.history) || !head.history.length || head.history.length > HISTORY_LIMIT) throw new Error();
        let previous = 0;
        for (const link of head.history) {
          strictRecord(link, ['revision', ...(Object.hasOwn(link, 'draft') ? ['draft'] : []),
            ...(Object.hasOwn(link, 'published') ? ['published'] : [])]);
          if (!validRevision(link.revision) || link.revision <= previous || link.revision > head.draft.revision
            || (!link.draft && !link.published) || (link.draft !== undefined && !validKey(link.draft, false))
            || (link.published !== undefined && !validKey(link.published, true))) throw new Error();
          previous = link.revision;
        }
        if (head.history.find(link => link.revision === head.draft.revision)?.draft !== head.draft.key
          || (head.published && head.history.find(link => link.revision === head.published!.revision)?.published !== head.published.key)) throw new Error();
      }
    } catch { throw new ApiError(503, 'storage_unavailable'); }
  }

  async storedHead(id: string) {
    if (!safeId(id)) throw new ApiError(400, 'invalid_id');
    const stored = await readJson<Head>(this.store, this.headKey(id), HEAD_BYTES);
    if (!stored) throw new ApiError(404, `${this.kind}_not_found`);
    this.validateHead(stored.value, id);
    return stored;
  }

  async head(id: string) {
    const stored = await this.storedHead(id);
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

  async snapshot(pointer: Pick<Pointer, 'key' | 'revision'>): Promise<Body> {
    const result = await readJson<Body>(this.store, pointer.key, LIMITS.jsonBytes);
    if (!result || this.entity(result.value).revision !== pointer.revision) throw new ApiError(503, 'storage_unavailable');
    return result.value;
  }

  async readVersion(id: string, published: boolean, revision?: number, retainPublished = false): Promise<Body> {
    if (typeof published !== 'boolean' || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))) {
      throw new ApiError(400, 'invalid_revision');
    }
    const { value: head } = await this.storedHead(id);
    if (head.deleted && !(retainPublished && published && revision !== undefined)) throw new ApiError(404, `${this.kind}_not_found`);
    let pointer: Pick<Pointer, 'key' | 'revision'> | undefined = published ? head.published : head.draft;
    if (revision !== undefined) {
      const link = this.history(head).find(entry => entry.revision === revision);
      const key = published ? link?.published : link?.draft;
      if (!key) throw new ApiError(404, 'revision_not_found');
      pointer = { key, revision };
    }
    if (!pointer) throw new ApiError(404, 'publication_not_found');
    const body = await this.snapshot(pointer);
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

  async discover(): Promise<string[]> {
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.store.list(this.indexPrefix, 128, cursor);
      if (page.keys.length > 128 || (page.cursor && !page.keys.length)) throw new ApiError(503, 'storage_unavailable');
      for (const key of page.keys) {
        if (!key.startsWith(this.indexPrefix) || !safeId(key.slice(this.indexPrefix.length)) || seen.has(key)
          || seen.size >= LIMITS.routines) throw new ApiError(503, 'storage_unavailable');
        seen.add(key);
      }
      cursor = page.cursor;
      if (cursor) {
        if (cursors.has(cursor) || seen.size >= LIMITS.routines) throw new ApiError(503, 'storage_unavailable');
        cursors.add(cursor);
      }
    } while (cursor);
    return [...seen].map(key => key.slice(this.indexPrefix.length));
  }

  pointer(key: string, body: Body): Pointer {
    const entity = this.entity(body);
    return { key, revision: entity.revision, name: entity.name, locked: entity.locked,
      ...(entity.savedAt !== undefined ? { savedAt: entity.savedAt } : {}) };
  }

  boundedHead(head: Head): Buffer {
    if (head.history!.length > HISTORY_LIMIT) throw new ApiError(409, 'revision_limit_reached');
    const bytes = encode(head);
    if (bytes.length > HEAD_BYTES) throw new ApiError(409, 'revision_limit_reached');
    return bytes;
  }

  async create(headers: Headers, input: unknown): Promise<Body> {
    const actor = await this.auth.authenticate(headers, true, true);
    return admitted(this.store, async claims => {
      const body = this.saved(await this.parse(input, headers, claims));
      const entity = this.entity(body);
      if (entity.revision !== 1 || entity.locked || entity.published) throw new ApiError(400, `invalid_${this.kind}_state`);
      const id = entity.id;
      if (await readJson(this.store, this.headKey(id), HEAD_BYTES)) throw new ApiError(409, `${this.kind}_exists`);
      const key = `${this.snapshotPrefix(id)}${randomUUID()}`;
      const head = this.boundedHead({ draft: this.pointer(key, body), deleted: false, history: [{ revision: 1, draft: key }] });
      await this.budget.charge(encode(body).length + HEAD_BYTES + 4096, { routine: true });
      claims.uncertain = true;
      await this.store.put(key, encode(body), null);
      try { await this.store.put(`${this.indexPrefix}${id}`, encode({ id }), null); }
      catch (error) { if (!(error instanceof BlobConflict)) throw error; }
      await this.recheck(headers, actor);
      try { await this.store.put(this.headKey(id), head, null); }
      catch (error) { if (error instanceof BlobConflict) throw new ApiError(412, 'revision_conflict'); throw error; }
      return body;
    });
  }

  async mutate(headers: Headers, id: string, action: Mutation, input?: unknown): Promise<Body> {
    const actor = await this.auth.authenticate(headers, true, true);
    return admitted(this.store, async claims => {
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
      const previous = await this.snapshot(oldHead.draft);
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
      const key = `${this.snapshotPrefix(id)}${randomUUID()}`;
      const publicationKey = publication ? `${this.snapshotPrefix(id, true)}${randomUUID()}` : undefined;
      history.push({ revision: expected + 1, draft: key, ...(publicationKey ? { published: publicationKey } : {}) });
      const head = this.boundedHead({ draft: this.pointer(key, body),
        published: publicationKey && publication ? this.pointer(publicationKey, publication) : oldHead.published,
        deleted: action === 'delete', history });
      await this.budget.charge(encode(body).length + (publication ? encode(publication).length : 0) + HEAD_BYTES);
      claims.uncertain = true;
      await this.store.put(key, encode(body), null);
      if (publicationKey && publication) await this.store.put(publicationKey, encode(publication), null);
      await this.recheck(headers, actor);
      try { await this.store.put(this.headKey(id), head, etag); }
      catch (error) { if (error instanceof BlobConflict) throw new ApiError(412, 'revision_conflict'); throw error; }
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