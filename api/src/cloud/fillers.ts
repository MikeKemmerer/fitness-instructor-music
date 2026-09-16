import { randomUUID } from 'node:crypto';
import type { FillerRecording } from '../../../shared/routine';
import { parseFillerRecording, strictRecord } from '../validation';
import { CloudAuth } from './auth';
import { ApiError, LIMITS, safeId } from './config';
import { CloudMedia, parseAsset } from './media';
import { QuotaBudget } from './quota';
import { BlobConflict, encode, readJson, type BlobStore } from './store';

interface FillerRecord { recording: FillerRecording; archived: boolean }
const RECORD_BYTES = 4096;
const INDEX_PREFIX = 'fillers/index/';
const recordKey = (id: string): string => `fillers/records/${id}`;

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

  async resolve(input: unknown): Promise<FillerRecording> {
    const claimed = parseFillerRecording(input);
    const { recording } = (await this.record(claimed.id)).value;
    if (claimed.id !== recording.id || claimed.name !== recording.name || claimed.duration !== recording.duration ||
        claimed.asset.id !== recording.asset.id || claimed.asset.bytes !== recording.asset.bytes ||
        claimed.asset.sha256 !== recording.asset.sha256 || claimed.asset.contentType !== recording.asset.contentType) {
      throw new ApiError(400, 'invalid_filler');
    }
    return recording;
  }

  async get(headers: Headers, id: string): Promise<FillerRecording> {
    await this.auth.authenticate(headers, false, true);
    return (await this.record(id)).value.recording;
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
        if (!stored.value.archived) fillers.push(stored.value.recording);
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
    await this.auth.authenticate(headers, true, true);
    const value = strictRecord(input, ['name', 'duration', 'asset']);
    const recording = parseFillerRecording({ ...value, id: randomUUID() });
    const claimed = parseAsset(recording.asset);
    const actual = (await this.media.catalog(claimed.id)).asset;
    if (claimed.id !== actual.id || claimed.bytes !== actual.bytes || claimed.sha256 !== actual.sha256 ||
        claimed.contentType !== actual.contentType) throw new ApiError(400, 'invalid_asset');
    recording.asset = actual;
    const bytes = encode({ recording, archived: false } satisfies FillerRecord);
    if (bytes.length > RECORD_BYTES) throw new ApiError(413, 'body_too_large');
    await this.budget.charge(RECORD_BYTES * 2, { filler: true });
    await this.auth.authenticate(headers, true, true);
    await this.store.put(`${INDEX_PREFIX}${recording.id}`, encode({ id: recording.id }), null);
    await this.auth.authenticate(headers, true, true);
    await this.store.put(recordKey(recording.id), bytes, null);
    return recording;
  }

  async archive(headers: Headers, id: string): Promise<{ archived: true }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.auth.authenticate(headers, true, true);
      const stored = await this.record(id);
      if (stored.value.archived) return { archived: true };
      await this.auth.authenticate(headers, true, true);
      try {
        await this.store.put(recordKey(id), encode({ ...stored.value, archived: true } satisfies FillerRecord), stored.etag);
        return { archived: true };
      } catch (error) { if (!(error instanceof BlobConflict)) throw error; }
    }
    throw new ApiError(503, 'storage_busy');
  }
}