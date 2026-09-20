import { ApiError, LIMITS } from './config';
import { CosmosConflict, type CosmosStoreLike } from './cosmos-store';

interface Quota {
  id: 'quota';
  bytes: number;
  operations: number;
  routines: number;
  fillers?: number;
  assets: number;
  active: Record<string, number>;
}

const QUOTA_ID = 'quota';

export class CosmosQuotaBudget {
  constructor(readonly store: CosmosStoreLike) {}

  async charge(bytes: number, options: { routine?: boolean; filler?: boolean; upload?: { id: string; expiresAt: number } } = {}): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await this.store.read<Quota>('system', QUOTA_ID, QUOTA_ID);
      const previous: Quota = stored?.body ?? { id: QUOTA_ID, bytes: 64 * 1024 * 1024, operations: 0, routines: 0, assets: 0, active: {} };
      const fillers = previous.fillers === undefined ? 0 : previous.fillers;
      if (![previous.bytes, previous.operations, previous.routines, previous.assets, fillers].every(value => Number.isSafeInteger(value) && value >= 0) ||
          !previous.active || typeof previous.active !== 'object') throw new ApiError(503, 'storage_unavailable');
      const next: Quota = { id: QUOTA_ID, bytes: previous.bytes + bytes, operations: previous.operations + 1,
        routines: previous.routines + (options.routine ? 1 : 0), assets: previous.assets + (options.upload ? 1 : 0),
        fillers: fillers + (options.filler ? 1 : 0), active: { ...previous.active } };
      if (options.upload) next.active[options.upload.id] = options.upload.expiresAt;
      if (next.bytes > LIMITS.quotaBytes || next.operations > 20000 || next.routines > LIMITS.routines ||
          next.fillers! > LIMITS.fillers || next.assets > LIMITS.assets || Object.keys(next.active).length > LIMITS.pendingUploads) {
        throw new ApiError(507, 'storage_quota_exceeded');
      }
      try { await this.store.put('system', next, stored?.etag ?? null); return; }
      catch (error) { if (!(error instanceof CosmosConflict)) throw error; }
    }
    throw new ApiError(503, 'storage_busy');
  }

  async finishUpload(id: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await this.store.read<Quota>('system', QUOTA_ID, QUOTA_ID);
      if (!stored) throw new ApiError(503, 'storage_unavailable');
      const active = { ...stored.body.active };
      delete active[id];
      try { await this.store.replace('system', QUOTA_ID, QUOTA_ID, { ...stored.body, active }, stored.etag); return; }
      catch (error) { if (!(error instanceof CosmosConflict)) throw error; }
    }
    throw new ApiError(503, 'storage_busy');
  }
}
