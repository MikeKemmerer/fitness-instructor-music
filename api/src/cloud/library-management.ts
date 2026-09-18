import type { LibraryDeleteResult, LibraryMetadata, LibraryUsagePage, ManagedAudioItem, ManagedAudioPage } from '../../../shared/cloud-contract';
import { strictRecord, text } from '../validation';
import { admitted, AssetAdmission, type AdmissionState } from './admission';
import type { Authenticated, CloudAuth } from './auth';
import { ApiError, safeId } from './config';
import { CloudFillers } from './fillers';
import { LibraryReferences, type Description } from './library-references';
import { CloudMedia } from './media';
import { QuotaBudget } from './quota';
import { BlobConflict, encode, readJson, type BlobStore } from './store';

export type LibraryKind = 'song' | 'filler';
export const METADATA_BYTES = 4096;
export const MANAGED_PAGE_KEYS = 32;
const metadataKey = (kind: LibraryKind, id: string): string => `library/metadata/${kind}/${id}`;

export function metadataRevision(header: string | null): number {
  if (header === null) throw new ApiError(428, 'revision_required');
  if (!/^"(0|[1-9][0-9]{0,15})"$/.test(header) || !Number.isSafeInteger(Number(header.slice(1, -1)))) {
    throw new ApiError(400, 'invalid_revision');
  }
  return Number(header.slice(1, -1));
}

function editable(input: unknown): Pick<LibraryMetadata, 'title' | 'artist' | 'bpm'> {
  const value = strictRecord(input, ['title', 'artist', ...(input && Object.hasOwn(input, 'bpm') ? ['bpm'] : [])]);
  const title = text(value.title, 300, true);
  const artist = text(value.artist, 300, true);
  if (Object.hasOwn(value, 'bpm') && (typeof value.bpm !== 'number' || !Number.isFinite(value.bpm) || value.bpm < 40 || value.bpm > 220)) {
    throw new ApiError(400, 'invalid_metadata');
  }
  return { title, artist, ...(Object.hasOwn(value, 'bpm') ? { bpm: value.bpm as number } : {}) };
}

function intake(input: unknown, kind: LibraryKind): { filename: string; duration: number } {
  const value = strictRecord(input, ['filename', 'duration']);
  const filename = text(value.filename, 300);
  if (/[\\/:\x00-\x1f\x7f]/.test(filename) || filename === '.' || filename === '..'
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0
    || value.duration > (kind === 'song' ? 1200 : 360)) throw new ApiError(400, 'invalid_intake');
  return { filename, duration: value.duration };
}

export async function storedMetadata(store: BlobStore, kind: LibraryKind, id: string) {
  const stored = await readJson<LibraryMetadata>(store, metadataKey(kind, id), METADATA_BYTES);
  if (!stored) return null;
  try {
    const value = stored.value;
    strictRecord(value, ['revision', 'title', 'artist', ...['bpm', 'filename', 'duration'].filter(key => Object.hasOwn(value, key))]);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error();
    editable({ title: value.title, artist: value.artist, ...(value.bpm === undefined ? {} : { bpm: value.bpm }) });
    if (value.filename !== undefined) intake({ filename: value.filename, duration: value.duration }, kind);
    if (value.duration !== undefined && (typeof value.duration !== 'number' || !Number.isFinite(value.duration)
      || value.duration <= 0 || value.duration > (kind === 'song' ? 1200 : 360))) throw new Error();
    return stored;
  } catch { throw new ApiError(503, 'storage_unavailable'); }
}

function listMarker(kind: LibraryKind, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = strictRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['version', 'kind', 'marker']);
    if (value.version !== 1 || value.kind !== kind || typeof value.marker !== 'string' || !value.marker
      || value.marker.length > 2048 || /[\x00-\x1f\x7f]/.test(value.marker)) throw new Error();
    return value.marker;
  } catch { throw new ApiError(400, 'invalid_cursor'); }
}

export class LibraryManagement {
  readonly gate: AssetAdmission;
  readonly references: LibraryReferences;
  readonly budget: QuotaBudget;
  constructor(readonly store: BlobStore, readonly auth: CloudAuth, readonly media: CloudMedia, readonly fillers: CloudFillers) {
    this.gate = new AssetAdmission(store);
    this.references = new LibraryReferences(store, auth);
    this.budget = new QuotaBudget(store);
  }

  async recheck(headers: Headers, actor: Authenticated, writing: boolean): Promise<void> {
    const fresh = await this.auth.authenticate(headers, writing, true);
    if (fresh.key !== actor.key || fresh.account.id !== actor.account.id) throw new ApiError(401, 'signin_required');
  }

  async item(kind: LibraryKind, id: string, allowDeleted = false): Promise<ManagedAudioItem> {
    if (!safeId(id)) throw new ApiError(400, 'invalid_id');
    const recording = kind === 'filler' ? (await this.fillers.record(id)).value.recording : undefined;
    const asset = (await this.media.catalog(recording?.asset.id ?? id)).asset;
    if (recording && (recording.asset.sha256 !== asset.sha256 || recording.asset.bytes !== asset.bytes
      || recording.asset.contentType !== asset.contentType)) throw new ApiError(503, 'storage_unavailable');
    if (!allowDeleted && ((await this.gate.read(asset.id)).value.deleted || (kind === 'filler' && await this.fillers.deleted(id)))) {
      throw new ApiError(404, 'media_deleted');
    }
    const metadata = (await storedMetadata(this.store, kind, id))?.value ?? { revision: 0,
      title: recording?.name ?? '', artist: '', ...(recording ? { duration: recording.duration } : {}) };
    return { id, kind, asset, metadata, ...(recording ? { recording } : {}) };
  }

  async metadata(headers: Headers, kind: LibraryKind, id: string): Promise<{ metadata: LibraryMetadata }> {
    const actor = await this.auth.authenticate(headers, false, true);
    const item = await this.item(kind, id);
    await this.describe(headers, [item]);
    await this.recheck(headers, actor, false);
    return { metadata: item.metadata };
  }

  async describe(headers: Headers, items: ManagedAudioItem[]): Promise<void> {
    const candidates = items.filter(item => item.kind === 'song' && item.metadata.revision === 0);
    if (!candidates.length) return;
    const descriptions = new Map<string, Description | undefined>(candidates.map(item => [item.asset.id, undefined]));
    try { await this.references.scan(headers, candidates[0]!.asset.id, '', undefined, descriptions); }
    catch (error) { if (!(error instanceof ApiError) || error.code !== 'reference_scan_uncertain') throw error; }
    for (const item of candidates) {
      const description = descriptions.get(item.asset.id);
      if (description) item.metadata = { ...item.metadata, ...description };
    }
  }

  async list(headers: Headers, kind: LibraryKind, cursor?: string): Promise<ManagedAudioPage> {
    const actor = await this.auth.authenticate(headers, false, true);
    const marker = listMarker(kind, cursor);
    const prefix = kind === 'song' ? 'assets/' : 'fillers/index/';
    const page = await this.store.list(prefix, MANAGED_PAGE_KEYS, marker);
    if (page.keys.length > MANAGED_PAGE_KEYS || new Set(page.keys).size !== page.keys.length
      || (page.cursor && (page.cursor === marker || page.cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(page.cursor)))) {
      throw new ApiError(503, 'storage_unavailable');
    }
    const items: ManagedAudioItem[] = [];
    for (const key of page.keys) {
      if (kind === 'song') {
        if (!/^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/(catalog|chunks\/[0-9]+)$/.test(key)) throw new ApiError(503, 'storage_unavailable');
        if (!key.endsWith('/catalog')) continue;
      } else if (!key.startsWith(prefix) || !safeId(key.slice(prefix.length))) throw new ApiError(503, 'storage_unavailable');
      const id = kind === 'song' ? key.split('/')[1]! : key.slice(prefix.length);
      try { items.push(await this.item(kind, id)); }
      catch (error) {
        if (error instanceof ApiError && error.code === 'media_deleted') continue;
        throw new ApiError(503, 'storage_unavailable');
      }
    }
    await this.describe(headers, items);
    await this.recheck(headers, actor, false);
    return { items, ...(page.cursor ? { cursor: Buffer.from(JSON.stringify({ version: 1, kind, marker: page.cursor })).toString('base64url') } : {}) };
  }

  async put(headers: Headers, kind: LibraryKind, id: string, input: unknown, initial = false): Promise<{ metadata: LibraryMetadata }> {
    const actor = await this.auth.authenticate(headers, true, true);
    const expected = metadataRevision(headers.get('if-match'));
    if (encode(input).length > METADATA_BYTES) throw new ApiError(413, 'body_too_large');
    const change = initial ? intake(input, kind) : editable(input);
    if (initial && expected !== 0) throw new ApiError(412, 'revision_conflict');
    const candidate = await this.item(kind, id);
    return admitted(this.store, async claims => {
      await claims.add(candidate.asset.id);
      const item = await this.item(kind, id);
      const old = await storedMetadata(this.store, kind, id);
      if ((old?.value.revision ?? 0) !== expected || (initial && old)) throw new ApiError(412, 'revision_conflict');
      if (expected === Number.MAX_SAFE_INTEGER) throw new ApiError(412, 'revision_exhausted');
      if (!initial) await this.describe(headers, [item]);
      const metadata: LibraryMetadata = initial ? { ...item.metadata, ...change, revision: 1 }
        : { title: '', artist: '', ...change, revision: expected + 1,
          ...(item.metadata.filename === undefined ? {} : { filename: item.metadata.filename }),
          ...(item.metadata.duration === undefined ? {} : { duration: item.metadata.duration }) };
      const bytes = encode(metadata);
      if (bytes.length > METADATA_BYTES) throw new ApiError(413, 'body_too_large');
      await this.budget.charge(METADATA_BYTES);
      await this.recheck(headers, actor, true);
      claims.uncertain = true;
      try { await this.store.put(metadataKey(kind, id), bytes, old?.etag ?? null); }
      catch (error) {
        if (error instanceof BlobConflict) { claims.uncertain = false; throw new ApiError(412, 'revision_conflict'); }
        throw error;
      }
      return { metadata };
    });
  }

  async usage(headers: Headers, kind: LibraryKind, id: string, cursor?: string): Promise<LibraryUsagePage> {
    const actor = await this.auth.authenticate(headers, false, true);
    const item = await this.item(kind, id);
    const { references, complete, cursor: next } = await this.references.scan(headers, item.asset.id, kind === 'filler' ? id : '', cursor);
    await this.recheck(headers, actor, false);
    return { references, complete, ...(next ? { cursor: next } : {}) };
  }

  async remove(headers: Headers, kind: LibraryKind, id: string): Promise<LibraryDeleteResult> {
    const actor = await this.auth.authenticate(headers, true, true);
    const expected = metadataRevision(headers.get('if-match'));
    const item = await this.item(kind, id, true);
    if (item.metadata.revision !== expected) throw new ApiError(412, 'revision_conflict');
    await this.gate.requireActivation();
    const writeGate = async (value: AdmissionState, etag: string | null) => {
      try { return await this.gate.write(item.asset.id, value, etag, () => this.recheck(headers, actor, true)); }
      catch (error) { if (error instanceof BlobConflict) throw new ApiError(409, 'reference_write_pending'); throw error; }
    };
    let gate = await this.gate.read(item.asset.id);
    if (gate.value.deleted) {
      await this.recheck(headers, actor, true);
      return { deleted: true, bytesRetained: true };
    }
    const matches = () => gate.value.checking?.kind === kind && gate.value.checking.id === id && gate.value.checking.revision === expected;
    if (kind === 'filler' && await this.fillers.deleted(id)) {
      await this.recheck(headers, actor, true);
      if (matches()) {
        await writeGate({ version: 1, claims: [] }, gate.etag);
      }
      return { deleted: true, bytesRetained: true };
    }
    if (gate.value.claims.length || (gate.value.checking && !matches())) throw new ApiError(409, 'reference_write_pending');
    if (!gate.value.checking) {
      await this.recheck(headers, actor, true);
      const value = { ...gate.value, checking: { kind, id, revision: expected } };
      gate = { value, etag: await writeGate(value, gate.etag) };
    }
    const current = await storedMetadata(this.store, kind, id);
    if ((current?.value.revision ?? 0) !== expected) {
      await this.recheck(headers, actor, true);
      await writeGate({ version: 1, claims: [] }, gate.etag);
      throw new ApiError(412, 'revision_conflict');
    }
    const page = gate.value.checking!.ready ? { references: [], complete: true, cursor: undefined }
      : await this.references.scan(headers, item.asset.id, kind === 'filler' ? id : '', gate.value.checking!.checkpoint);
    await this.recheck(headers, actor, true);
    if (page.references.length) {
      await writeGate({ version: 1, claims: [] }, gate.etag);
      throw new ApiError(409, 'media_in_use');
    }
    if (!page.complete) {
      await writeGate({ ...gate.value,
        checking: { kind, id, revision: expected, checkpoint: page.cursor! } }, gate.etag);
      return { pending: true };
    }
    if (kind === 'song') await writeGate({ version: 1, claims: [], deleted: true }, gate.etag);
    else {
      if (!gate.value.checking!.ready) {
        const value = { ...gate.value, checking: { kind, id, revision: expected, ready: true as const } };
        gate = { value, etag: await writeGate(value, gate.etag) };
      }
      await this.budget.charge(METADATA_BYTES);
      await this.recheck(headers, actor, true);
      try { await this.store.put(`library/deleted-fillers/${id}`, encode({ deleted: true, revision: expected }), null); }
      catch (error) {
        if (!(error instanceof BlobConflict) || !await this.fillers.deleted(id)) throw error;
      }
      await writeGate({ version: 1, claims: [] }, gate.etag);
    }
    return { deleted: true, bytesRetained: true };
  }
}