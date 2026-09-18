import { randomUUID } from 'node:crypto';
import type { FillerAnalysis } from '../../../shared/cloud-contract';
import type { FillerRecording } from '../../../shared/routine';
import { parseFillerRecording, strictRecord } from '../validation';
import { admitted, type ReferenceClaims } from './admission';
import { CloudAuth } from './auth';
import { ApiError, LIMITS, safeId } from './config';
import { CloudMedia, parseAsset } from './media';
import { QuotaBudget } from './quota';
import { BlobConflict, encode, readJson, type BlobStore } from './store';

interface FillerRecord { recording: FillerRecording; archived: boolean }
const RECORD_BYTES = 4096;
const INDEX_PREFIX = 'fillers/index/';
const recordKey = (id: string): string => `fillers/records/${id}`;

function parseAnalysis(input: unknown, hash: string): FillerAnalysis {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_analysis');
  const value = strictRecord(input, ['bpm', 'analyzer', 'sha256',
    ...(Object.prototype.hasOwnProperty.call(input, 'confidence') ? ['confidence'] : [])]);
  if (typeof value.bpm !== 'number' || !Number.isFinite(value.bpm) || value.bpm < 40 || value.bpm > 220
    || typeof value.analyzer !== 'string' || !value.analyzer.trim() || value.analyzer.length > 160
    || value.sha256 !== hash || (Object.hasOwn(value, 'confidence') && (typeof value.confidence !== 'number'
      || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1))) throw new ApiError(400, 'invalid_analysis');
  return { bpm: value.bpm, analyzer: value.analyzer, sha256: hash,
    ...(Object.hasOwn(value, 'confidence') ? { confidence: value.confidence as number } : {}) };
}

export class CloudFillers {
  readonly budget: QuotaBudget;
  constructor(readonly store: BlobStore, readonly auth: CloudAuth, readonly media: CloudMedia) {
    this.budget = new QuotaBudget(store);
  }

  async record(id: string) {
    if (!safeId(id)) throw new ApiError(400, 'invalid_id');
    const stored = await readJson<FillerRecord>(this.store, recordKey(id), RECORD_BYTES);
    if (!stored) throw new ApiError(404, 'filler_not_found');
    try {
      const value = strictRecord(stored.value, ['recording', 'archived']);
      const recording = parseFillerRecording(value.recording);
      if (recording.id !== id || typeof value.archived !== 'boolean') throw new Error();
      return { value: { recording, archived: value.archived }, etag: stored.etag };
    } catch { throw new ApiError(503, 'storage_unavailable'); }
  }

  async resolve(input: unknown, claims?: ReferenceClaims): Promise<FillerRecording> {
    const claimed = parseFillerRecording(input);
    await claims?.add(claimed.asset.id);
    if (claims && await this.deleted(claimed.id)) throw new ApiError(409, 'media_deleted');
    const { recording } = (await this.record(claimed.id)).value;
    if (claimed.id !== recording.id || claimed.name !== recording.name || claimed.duration !== recording.duration ||
        claimed.asset.id !== recording.asset.id || claimed.asset.bytes !== recording.asset.bytes ||
        claimed.asset.sha256 !== recording.asset.sha256 || claimed.asset.contentType !== recording.asset.contentType) {
      throw new ApiError(400, 'invalid_filler');
    }
    return recording;
  }

  async deleted(id: string): Promise<boolean> {
    const stored = await readJson(this.store, `library/deleted-fillers/${id}`, RECORD_BYTES);
    if (!stored) return false;
    try {
      const value = strictRecord(stored.value, ['deleted', 'revision']);
      if (value.deleted !== true || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
        || value.revision < 0) throw new Error();
      return true;
    } catch { throw new ApiError(503, 'storage_unavailable'); }
  }

  async get(headers: Headers, id: string): Promise<FillerRecording> {
    await this.auth.authenticate(headers, false, true);
    return (await this.record(id)).value.recording;
  }

  async analysisHash(id: string): Promise<string> {
    const { recording } = (await this.record(id)).value;
    const actual = (await this.media.catalog(recording.asset.id)).asset;
    if (actual.sha256 !== recording.asset.sha256 || actual.bytes !== recording.asset.bytes
      || actual.contentType !== recording.asset.contentType) throw new ApiError(503, 'storage_unavailable');
    return actual.sha256;
  }

  async getAnalysis(headers: Headers, id: string): Promise<{ analysis: FillerAnalysis | null }> {
    await this.auth.authenticate(headers, false, true);
    const hash = await this.analysisHash(id);
    const stored = await readJson(this.store, `fillers/analysis/${id}`, RECORD_BYTES);
    let analysis: FillerAnalysis | null = null;
    if (stored) {
      try { analysis = parseAnalysis(stored.value, hash); }
      catch { throw new ApiError(503, 'storage_unavailable'); }
    }
    await this.auth.authenticate(headers, false, true);
    return { analysis };
  }

  async putAnalysis(headers: Headers, id: string, input: unknown): Promise<{ analysis: FillerAnalysis }> {
    const actor = await this.auth.authenticate(headers, true, true);
    const analysis = parseAnalysis(input, await this.analysisHash(id));
    const key = `fillers/analysis/${id}`;
    const previous = await readJson(this.store, key, RECORD_BYTES);
    await this.budget.charge(RECORD_BYTES);
    const fresh = await this.auth.authenticate(headers, true, true);
    if (fresh.key !== actor.key || fresh.account.id !== actor.account.id) throw new ApiError(401, 'signin_required');
    try { await this.store.put(key, encode(analysis), previous?.etag ?? null); }
    catch (error) { if (error instanceof BlobConflict) throw new ApiError(409, 'analysis_conflict'); throw error; }
    return { analysis };
  }

  async list(headers: Headers): Promise<{ fillers: FillerRecording[] }> {
    await this.auth.authenticate(headers, false, true);
    const fillers: FillerRecording[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.store.list(INDEX_PREFIX, 128, cursor);
      if (page.keys.length > 128 || (page.cursor && !page.keys.length)) throw new ApiError(503, 'storage_unavailable');
      for (const key of page.keys) {
        if (!key.startsWith(INDEX_PREFIX) || seen.has(key) || seen.size >= LIMITS.fillers) throw new ApiError(503, 'storage_unavailable');
        seen.add(key);
        let stored;
        try { stored = await this.record(key.slice(INDEX_PREFIX.length)); }
        catch (error) { if (error instanceof ApiError && error.code === 'filler_not_found') continue; throw error; }
        if (!stored.value.archived && !await this.deleted(stored.value.recording.id)) fillers.push(stored.value.recording);
      }
      cursor = page.cursor;
      if (cursor) {
        if (cursors.has(cursor) || seen.size >= LIMITS.fillers) throw new ApiError(503, 'storage_unavailable');
        cursors.add(cursor);
      }
    } while (cursor);
    fillers.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 :
      first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
    return { fillers };
  }

  async create(headers: Headers, input: unknown): Promise<FillerRecording> {
    const actor = await this.auth.authenticate(headers, true, true);
    return admitted(this.store, async claims => {
      const value = strictRecord(input, ['name', 'duration', 'asset']);
      const recording = parseFillerRecording({ ...value, id: randomUUID() });
      const claimed = parseAsset(recording.asset);
      await claims.add(claimed.id);
      const actual = (await this.media.catalog(claimed.id)).asset;
      if (claimed.id !== actual.id || claimed.bytes !== actual.bytes || claimed.sha256 !== actual.sha256 ||
        claimed.contentType !== actual.contentType) throw new ApiError(400, 'invalid_asset');
      recording.asset = actual;
      const bytes = encode({ recording, archived: false } satisfies FillerRecord);
      if (bytes.length > RECORD_BYTES) throw new ApiError(413, 'body_too_large');
      await this.budget.charge(RECORD_BYTES * 2, { filler: true });
      const fresh = await this.auth.authenticate(headers, true, true);
      if (fresh.key !== actor.key || fresh.account.id !== actor.account.id) throw new ApiError(401, 'signin_required');
      claims.uncertain = true;
      await this.store.put(`${INDEX_PREFIX}${recording.id}`, encode({ id: recording.id }), null);
      const current = await this.auth.authenticate(headers, true, true);
      if (current.key !== actor.key || current.account.id !== actor.account.id) throw new ApiError(401, 'signin_required');
      await this.store.put(recordKey(recording.id), bytes, null);
      return recording;
    });
  }

  async archive(headers: Headers, id: string): Promise<{ archived: true } | { pending: true }> {
    const { LibraryManagement } = await import('./library-management');
    const result = await new LibraryManagement(this.store, this.auth, this.media, this).remove(headers, 'filler', id);
    return 'pending' in result ? result : { archived: true };
  }
}