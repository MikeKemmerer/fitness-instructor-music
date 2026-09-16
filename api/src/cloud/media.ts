import { createHash, randomUUID } from 'node:crypto';
import type { CloudAsset } from '../../../shared/cloud-contract';
import { strictRecord } from '../validation';
import { CloudAuth, type Authenticated } from './auth';
import { ApiError, LIMITS, safeId } from './config';
import { validateAdts, validateMp4, validateWebm } from './media-signatures';
import { QuotaBudget } from './quota';
import { BlobConflict, encode, readJson, type BlobStore } from './store';

export const MEDIA_TYPES = ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm'] as const;
interface Upload {
  asset: CloudAsset;
  ownerId: string;
  expiresAt: number;
  state: 'open' | 'sealed' | 'complete' | 'aborted';
  chunks: Record<string, string>;
  finalization?: { sha256: string; copiedChunks: number };
}
export interface CompletionPending {
  pending: true;
  done: false;
  phase: 'copying' | 'publishing';
  copiedChunks: number;
  chunkCount: number;
}
export interface AssetRecord { asset: CloudAsset; chunks: string[] }
const HASH_PREFETCH = 4;
const COPY_BATCH = 8;
const FINALIZE_WORK_MS = 20000;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export function parseAsset(input: unknown): CloudAsset {
  const value = strictRecord(input, ['id', 'sha256', 'bytes', 'contentType']);
  if (!safeId(value.id) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 44 || value.bytes > LIMITS.assetBytes ||
      !MEDIA_TYPES.includes(value.contentType as typeof MEDIA_TYPES[number])) throw new ApiError(400, 'invalid_asset');
  return value as unknown as CloudAsset;
}

export function validateSignature(prefix: Buffer, asset: CloudAsset): void {
  const invalid = (): never => { throw new ApiError(415, 'unsupported_media'); };
  prefix = prefix.subarray(0, Math.min(65536, asset.bytes));
  if (asset.contentType === 'audio/aac') return validateAdts(prefix, asset.bytes);
  if (asset.contentType === 'audio/webm') return validateWebm(prefix, asset.bytes);
  if (asset.contentType === 'audio/wav') {
    if (prefix.length < 44 || prefix.toString('ascii', 0, 4) !== 'RIFF' || prefix.toString('ascii', 8, 12) !== 'WAVE' ||
        prefix.readUInt32LE(4) + 8 !== asset.bytes) invalid();
    let offset = 12;
    let alignment = 0;
    let byteRate = 0;
    while (offset + 8 <= prefix.length) {
      const kind = prefix.toString('ascii', offset, offset + 4);
      const size = prefix.readUInt32LE(offset + 4);
      if (kind === 'fmt ') {
        if (alignment || size < 16 || offset + 8 + size > prefix.length) invalid();
        const format = prefix.readUInt16LE(offset + 8);
        const channels = prefix.readUInt16LE(offset + 10);
        const rate = prefix.readUInt32LE(offset + 12);
        const bits = prefix.readUInt16LE(offset + 22);
        alignment = prefix.readUInt16LE(offset + 20);
        byteRate = prefix.readUInt32LE(offset + 16);
        if ((format !== 1 && format !== 3) || ![1, 2].includes(channels) || rate < 8000 || rate > 96000 ||
            !(format === 3 ? bits === 32 : [8, 16, 24, 32].includes(bits)) ||
            alignment !== channels * bits / 8 || byteRate !== rate * alignment) invalid();
      }
      if (kind === 'data') {
        if (!alignment || !size || size % alignment || offset + 8 + size !== asset.bytes || size / byteRate > 1200) invalid();
        return;
      }
      offset += 8 + size + size % 2;
    }
    invalid();
  }
  if (asset.contentType === 'audio/mpeg') {
    let offset = 0;
    if (prefix.toString('ascii', 0, 3) === 'ID3') {
      if (prefix.length < 10 || ![2, 3, 4].includes(prefix[3]!) || prefix.subarray(6, 10).some(byte => byte > 127)) invalid();
      offset = 10 + ((prefix[6]! << 21) | (prefix[7]! << 14) | (prefix[8]! << 7) | prefix[9]!);
      if (prefix[3] === 4 && (prefix[5]! & 16)) offset += 10;
    }
    if (offset + 4 > prefix.length || prefix[offset] !== 255 || (prefix[offset + 1]! & 224) !== 224 ||
        (prefix[offset + 1]! & 24) === 8 || (prefix[offset + 1]! & 6) !== 2 ||
        [0, 15].includes(prefix[offset + 2]! >> 4) || (prefix[offset + 2]! & 12) === 12) invalid();
    return;
  }
  if (asset.contentType === 'audio/mp4') {
    return validateMp4(prefix, asset.bytes);
  }
  if (asset.contentType === 'audio/ogg') {
    if (prefix.length < 36 || prefix.toString('ascii', 0, 4) !== 'OggS' || prefix[4] !== 0 || !(prefix[5]! & 2)) invalid();
    const offset = 27 + prefix[26]!;
    if (prefix.toString('ascii', offset, offset + 8) !== 'OpusHead' &&
        !(prefix[offset] === 1 && prefix.toString('ascii', offset + 1, offset + 7) === 'vorbis')) invalid();
    return;
  }
  if (asset.contentType === 'audio/flac') {
    if (prefix.toString('ascii', 0, 4) !== 'fLaC' || (prefix[4]! & 127) !== 0 || prefix.readUIntBE(5, 3) !== 34) invalid();
    return;
  }
  invalid();
}

export class CloudMedia {
  readonly budget: QuotaBudget;
  constructor(readonly store: BlobStore, readonly auth: CloudAuth, readonly clock: () => number = Date.now) {
    this.budget = new QuotaBudget(store);
  }

  count(asset: CloudAsset): number { return Math.ceil(asset.bytes / LIMITS.chunkBytes); }
  chunkLength(asset: CloudAsset, index: number): number { return Math.min(LIMITS.chunkBytes, asset.bytes - index * LIMITS.chunkBytes); }

  async initiate(headers: Headers, input: unknown) {
    const actor = await this.auth.authenticate(headers, true, true);
    const value = strictRecord(input, ['bytes', 'sha256', 'contentType']);
    const id = randomUUID();
    const asset = parseAsset({ ...value, id });
    const expiresAt = this.auth.now() + LIMITS.uploadMs;
    await this.budget.charge(asset.bytes * 2 + 131072, { upload: { id, expiresAt } });
    await this.auth.authenticate(headers, true, true);
    await this.store.put(`uploads/${id}/head`, encode({ asset, ownerId: actor.account.id, expiresAt, state: 'open', chunks: {} } satisfies Upload), null);
    return { id, assetId: id, chunkBytes: LIMITS.chunkBytes, chunkCount: this.count(asset), expiresAt };
  }

  async upload(actor: Authenticated, id: string) {
    if (!safeId(id)) throw new ApiError(400, 'invalid_id');
    const stored = await readJson<Upload>(this.store, `uploads/${id}/head`);
    if (!stored) throw new ApiError(404, 'upload_not_found');
    if (stored.value.ownerId !== actor.account.id && actor.account.role !== 'owner') throw new ApiError(403, 'forbidden');
    return stored;
  }

  async putChunk(headers: Headers, id: string, index: number, bytes: Buffer) {
    const actor = await this.auth.authenticate(headers, true, true);
    const stored = await this.upload(actor, id);
    const upload = stored.value;
    if (upload.state !== 'open' || upload.expiresAt <= this.auth.now()) throw new ApiError(409, 'upload_closed');
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count(upload.asset) || bytes.length !== this.chunkLength(upload.asset, index)) {
      throw new ApiError(400, 'invalid_chunk');
    }
    const hash = sha256(bytes);
    await this.immutableChunk(`uploads/${id}/chunks/${index}`, bytes, hash);
    await this.auth.authenticate(headers, true, true);
    try {
      await this.store.put(`uploads/${id}/head`, encode({ ...upload, chunks: { ...upload.chunks, [index]: hash } }), stored.etag);
    } catch (error) {
      if (!(error instanceof BlobConflict)) throw error;
      const latest = await this.upload(actor, id);
      if (latest.value.state !== 'open' || latest.value.chunks[index] !== hash) throw new ApiError(409, 'upload_conflict');
    }
    return { index, sha256: hash };
  }

  async immutableChunk(key: string, bytes: Buffer, hash: string): Promise<void> {
    try { await this.store.put(key, bytes, null); }
    catch (error) {
      if (!(error instanceof BlobConflict)) throw error;
      const existing = await this.store.get(key, LIMITS.chunkBytes);
      if (!existing || existing.bytes.length !== bytes.length || sha256(existing.bytes) !== hash) throw new ApiError(409, 'chunk_conflict');
    }
  }

  pending(upload: Upload): CompletionPending {
    return { pending: true, done: false, phase: upload.state === 'complete' ? 'publishing' : 'copying',
      copiedChunks: upload.finalization?.copiedChunks ?? 0, chunkCount: this.count(upload.asset) };
  }

  checkedCursor(upload: Upload): number {
    const progress = upload.finalization;
    if (!progress || progress.sha256 !== upload.asset.sha256 || !Number.isSafeInteger(progress.copiedChunks) ||
        progress.copiedChunks < 0 || progress.copiedChunks > this.count(upload.asset) ||
        (upload.state === 'complete' && progress.copiedChunks !== this.count(upload.asset))) {
      throw new ApiError(503, 'storage_unavailable');
    }
    return progress.copiedChunks;
  }

  async stagedChunk(id: string, upload: Upload, index: number): Promise<Buffer> {
    const chunk = await this.store.get(`uploads/${id}/chunks/${index}`, LIMITS.chunkBytes);
    if (!chunk || chunk.bytes.length !== this.chunkLength(upload.asset, index) || sha256(chunk.bytes) !== upload.chunks[index]) {
      throw new ApiError(409, 'upload_corrupt');
    }
    return chunk.bytes;
  }

  async checkpoint(id: string, upload: Upload, etag: string): Promise<{ value: Upload; etag: string }> {
    try { return { value: upload, etag: await this.store.put(`uploads/${id}/head`, encode(upload), etag) }; }
    catch (error) { if (error instanceof BlobConflict) throw new ApiError(409, 'upload_conflict'); throw error; }
  }

  async publishCompleted(headers: Headers, id: string, upload: Upload): Promise<CloudAsset> {
    if (upload.state !== 'complete') throw new ApiError(503, 'storage_unavailable');
    if (upload.finalization) {
      this.checkedCursor(upload);
      await this.auth.authenticate(headers, true, true);
      const record: AssetRecord = { asset: upload.asset,
        chunks: Array.from({ length: this.count(upload.asset) }, (_, index) => upload.chunks[index]!) };
      try { await this.store.put(`assets/${id}/catalog`, encode(record), null); }
      catch (error) {
        if (!(error instanceof BlobConflict)) throw error;
        const existing = await this.catalog(id);
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new ApiError(503, 'storage_unavailable');
      }
    } else {
      const existing = await this.catalog(id);
      if (JSON.stringify(existing.asset) !== JSON.stringify(upload.asset)) throw new ApiError(503, 'storage_unavailable');
    }
    await this.budget.finishUpload(id);
    return upload.asset;
  }

  async complete(headers: Headers, id: string): Promise<CloudAsset | CompletionPending> {
    const deadline = this.clock() + FINALIZE_WORK_MS;
    const actor = await this.auth.authenticate(headers, true, true);
    let stored = await this.upload(actor, id);
    let upload = stored.value;
    if (upload.state === 'aborted' || (upload.state !== 'complete' && upload.expiresAt <= this.auth.now())) {
      throw new ApiError(409, 'upload_closed');
    }
    const count = this.count(upload.asset);
    if (Object.keys(upload.chunks).length !== count ||
        Array.from({ length: count }, (_, index) => upload.chunks[index]).some(hash => !hash || !/^[a-f0-9]{64}$/.test(hash))) {
      throw new ApiError(409, 'upload_incomplete');
    }
    if (upload.state === 'complete') return this.publishCompleted(headers, id, upload);
    if (upload.state !== 'open' && upload.state !== 'sealed') throw new ApiError(503, 'storage_unavailable');
    if (upload.state === 'open') {
      if (upload.finalization) throw new ApiError(503, 'storage_unavailable');
      upload = { ...upload, state: 'sealed' };
      stored = await this.checkpoint(id, upload, stored.etag);
    }
    if (!upload.finalization) {
      const hash = createHash('sha256');
      for (let start = 0; start < count; start += HASH_PREFETCH) {
        if (this.clock() >= deadline) throw new ApiError(503, 'finalization_timeout');
        const batch = await Promise.allSettled(Array.from({ length: Math.min(HASH_PREFETCH, count - start) },
          (_, offset) => this.stagedChunk(id, upload, start + offset)));
        for (const [offset, result] of batch.entries()) {
          if (result.status === 'rejected') throw result.reason;
          if (start + offset === 0) validateSignature(result.value.subarray(0, 65536), upload.asset);
          hash.update(result.value);
        }
        await this.auth.authenticate(headers, true, true);
        if (this.auth.now() >= upload.expiresAt) throw new ApiError(409, 'upload_closed');
      }
      if (hash.digest('hex') !== upload.asset.sha256) throw new ApiError(422, 'media_hash_mismatch');
      if (this.clock() >= deadline) throw new ApiError(503, 'finalization_timeout');
      upload = { ...upload, finalization: { sha256: upload.asset.sha256, copiedChunks: 0 } };
      await this.checkpoint(id, upload, stored.etag);
      return this.pending(upload);
    }
    const cursor = this.checkedCursor(upload);
    if (cursor === count) throw new ApiError(503, 'storage_unavailable');
    for (let index = cursor; index < Math.min(cursor + COPY_BATCH, count); index++) {
      if (this.clock() >= deadline) return this.pending(upload);
      const bytes = await this.stagedChunk(id, upload, index);
      await this.auth.authenticate(headers, true, true);
      if (this.auth.now() >= upload.expiresAt) throw new ApiError(409, 'upload_closed');
      await this.immutableChunk(`assets/${id}/chunks/${index}`, bytes, upload.chunks[index]!);
      await this.auth.authenticate(headers, true, true);
      if (this.auth.now() >= upload.expiresAt) throw new ApiError(409, 'upload_closed');
      upload = { ...upload, state: index + 1 === count ? 'complete' : 'sealed',
        finalization: { sha256: upload.asset.sha256, copiedChunks: index + 1 } };
      stored = await this.checkpoint(id, upload, stored.etag);
    }
    if (upload.state === 'complete' && this.clock() < deadline) return this.publishCompleted(headers, id, upload);
    return this.pending(upload);
  }

  async abort(headers: Headers, id: string): Promise<{ aborted: true }> {
    const actor = await this.auth.authenticate(headers, true, true);
    const stored = await this.upload(actor, id);
    if (stored.value.state === 'complete' || stored.value.state === 'sealed') throw new ApiError(409, 'upload_closed');
    try { await this.store.put(`uploads/${id}/head`, encode({ ...stored.value, state: 'aborted' }), stored.etag); }
    catch (error) { if (error instanceof BlobConflict) throw new ApiError(409, 'upload_conflict'); throw error; }
    await this.budget.finishUpload(id);
    return { aborted: true };
  }

  async cleanup(headers: Headers): Promise<{ releasedSlots: number; more: boolean }> {
    const actor = await this.auth.authenticate(headers, true, true);
    if (actor.account.role !== 'owner') throw new ApiError(403, 'forbidden');
    const quota = await readJson<{ active: Record<string, number> }>(this.store, 'control/quota');
    const expired = Object.entries(quota?.value.active ?? {}).filter(([, expiresAt]) => expiresAt <= this.auth.now());
    let releasedSlots = 0;
    for (const [id] of expired.slice(0, 8)) {
      await this.auth.authenticate(headers, true, true);
      const stored = await readJson<Upload>(this.store, `uploads/${id}/head`);
      if (stored && stored.value.state !== 'complete') {
        try { await this.store.put(`uploads/${id}/head`, encode({ ...stored.value, state: 'aborted' }), stored.etag); }
        catch (error) { if (error instanceof BlobConflict) continue; throw error; }
      }
      await this.budget.finishUpload(id);
      releasedSlots++;
    }
    return { releasedSlots, more: expired.length > 8 };
  }

  async catalog(id: string): Promise<AssetRecord> {
    if (!safeId(id)) throw new ApiError(400, 'invalid_id');
    const record = await readJson<AssetRecord>(this.store, `assets/${id}/catalog`);
    if (!record) throw new ApiError(404, 'asset_not_found');
    const asset = parseAsset(record.value.asset);
    if (asset.id !== id || !Array.isArray(record.value.chunks) || record.value.chunks.length !== this.count(asset) ||
        record.value.chunks.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new ApiError(503, 'storage_unavailable');
    return record.value;
  }

  async chunk(id: string, index: number): Promise<{ bytes: Buffer; hash: string; asset: CloudAsset }> {
    const record = await this.catalog(id);
    if (!Number.isSafeInteger(index) || index < 0 || index >= record.chunks.length) throw new ApiError(400, 'invalid_chunk');
    const result = await this.store.get(`assets/${id}/chunks/${index}`, LIMITS.chunkBytes);
    if (!result || result.bytes.length !== this.chunkLength(record.asset, index) || sha256(result.bytes) !== record.chunks[index]) {
      throw new ApiError(503, 'storage_unavailable');
    }
    return { bytes: result.bytes, hash: record.chunks[index]!, asset: record.asset };
  }
}