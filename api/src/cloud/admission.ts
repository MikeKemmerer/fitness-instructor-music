import { randomUUID } from 'node:crypto';
import { strictRecord } from '../validation';
import { ApiError, safeId } from './config';
import { QuotaBudget } from './quota';
import { BlobConflict, encode, readJson, type BlobStore } from './store';

export const GATE_BYTES = 16384;
export interface AdmissionState {
  version: 1;
  claims: string[];
  checking?: { kind: 'song' | 'filler'; id: string; revision: number; checkpoint?: string; ready?: true };
  deleted?: true;
}

export class AssetAdmission {
  constructor(readonly store: BlobStore) {}

  key(id: string): string {
    if (!safeId(id)) throw new ApiError(400, 'invalid_id');
    return `library/gates/${id}`;
  }

  async read(id: string): Promise<{ value: AdmissionState; etag: string | null }> {
    const stored = await readJson<AdmissionState>(this.store, this.key(id), GATE_BYTES);
    if (!stored) return { value: { version: 1, claims: [] }, etag: null };
    try {
      const value = stored.value;
      strictRecord(value, ['version', 'claims', ...(value.checking === undefined ? [] : ['checking']),
        ...(value.deleted === undefined ? [] : ['deleted'])]);
      if (value.version !== 1 || !Array.isArray(value.claims) || value.claims.length > 128
        || value.claims.some(claim => typeof claim !== 'string' || !safeId(claim))
        || new Set(value.claims).size !== value.claims.length
        || (value.deleted !== undefined && value.deleted !== true)
        || ((value.checking || value.deleted) && value.claims.length) || (value.checking && value.deleted)) throw new Error();
      if (value.checking) {
        const operation = value.checking;
        strictRecord(operation, ['kind', 'id', 'revision', ...(operation.checkpoint === undefined ? [] : ['checkpoint']),
          ...(operation.ready === undefined ? [] : ['ready'])]);
        if (!['song', 'filler'].includes(operation.kind) || !safeId(operation.id)
          || !Number.isSafeInteger(operation.revision) || operation.revision < 0
          || (operation.checkpoint !== undefined && (typeof operation.checkpoint !== 'string'
            || operation.checkpoint.length > 8192)) || (operation.ready !== undefined && operation.ready !== true)) throw new Error();
      }
      return stored;
    } catch { throw new ApiError(503, 'storage_unavailable'); }
  }

  async write(id: string, value: AdmissionState, etag: string | null, beforeCommit?: () => Promise<void>): Promise<string> {
    const bytes = encode(value);
    if (bytes.length > GATE_BYTES) throw new ApiError(503, 'storage_unavailable');
    await new QuotaBudget(this.store).charge(GATE_BYTES);
    await beforeCommit?.();
    return this.store.put(this.key(id), bytes, etag);
  }

  async available(id: string): Promise<void> {
    const { value } = await this.read(id);
    if (value.deleted) throw new ApiError(409, 'media_deleted');
    if (value.checking) throw new ApiError(409, 'reference_write_pending');
  }

  async acquire(id: string, claim: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { value, etag } = await this.read(id);
      if (value.deleted) throw new ApiError(409, 'media_deleted');
      if (value.checking || value.claims.length >= 128) throw new ApiError(409, 'reference_write_pending');
      try { await this.write(id, { ...value, claims: [...value.claims, claim] }, etag); return; }
      catch (error) { if (!(error instanceof BlobConflict)) throw error; }
    }
    throw new ApiError(503, 'storage_busy');
  }

  async release(id: string, claim: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { value, etag } = await this.read(id);
      if (!value.claims.includes(claim)) return;
      try { await this.write(id, { ...value, claims: value.claims.filter(candidate => candidate !== claim) }, etag); return; }
      catch (error) { if (!(error instanceof BlobConflict)) throw error; }
    }
    throw new ApiError(503, 'storage_busy');
  }

  async requireActivation(): Promise<void> {
    try {
      const activation = await readJson(this.store, 'control/library-admission-v1', 1024);
      if (!activation) throw new Error();
      const value = strictRecord(activation.value, ['version', 'exclusiveWriters']);
      if (value.version !== 1 || value.exclusiveWriters !== true) throw new Error();
    } catch { throw new ApiError(503, 'library_delete_unconfigured'); }
  }
}

export class ReferenceClaims {
  readonly claim = randomUUID();
  readonly ids = new Set<string>();
  uncertain = false;
  constructor(readonly gate: AssetAdmission) {}

  async add(id: string): Promise<void> {
    if (this.ids.has(id)) return;
    if (this.ids.size >= 256) throw new ApiError(413, 'too_many_assets');
    await this.gate.acquire(id, this.claim);
    this.ids.add(id);
  }

  async release(): Promise<void> {
    for (const id of this.ids) await this.gate.release(id, this.claim);
  }
}

export async function admitted<Value>(store: BlobStore, action: (claims: ReferenceClaims) => Promise<Value>): Promise<Value> {
  const claims = new ReferenceClaims(new AssetAdmission(store));
  let committed = false;
  try {
    const result = await action(claims);
    committed = true;
    return result;
  } finally {
    if (committed || !claims.uncertain) await claims.release();
  }
}