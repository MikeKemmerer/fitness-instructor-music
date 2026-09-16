import { ApiError, LIMITS } from './config';
import { updateJson, type BlobStore } from './store';

interface Quota {
  bytes: number;
  operations: number;
  routines: number;
  fillers?: number;
  assets: number;
  active: Record<string, number>;
}

export class QuotaBudget {
  constructor(readonly store: BlobStore) {}

  async charge(bytes: number, options: { routine?: boolean; filler?: boolean; upload?: { id: string; expiresAt: number } } = {}): Promise<void> {
    await updateJson<Quota>(this.store, 'control/quota', () => ({ bytes: 64 * 1024 * 1024, operations: 0, routines: 0, assets: 0, active: {} }), previous => {
      const fillers = previous.fillers === undefined ? 0 : previous.fillers;
      if (![previous.bytes, previous.operations, previous.routines, previous.assets, fillers].every(value => Number.isSafeInteger(value) && value >= 0) ||
          !previous.active || typeof previous.active !== 'object') throw new ApiError(503, 'storage_unavailable');
      const next: Quota = { bytes: previous.bytes + bytes, operations: previous.operations + 1,
        routines: previous.routines + (options.routine ? 1 : 0), assets: previous.assets + (options.upload ? 1 : 0),
        fillers: fillers + (options.filler ? 1 : 0),
        active: { ...previous.active } };
      if (options.upload) next.active[options.upload.id] = options.upload.expiresAt;
      if (next.bytes > LIMITS.quotaBytes || next.operations > 20000 || next.routines > LIMITS.routines ||
          next.fillers! > LIMITS.fillers ||
          next.assets > LIMITS.assets || Object.keys(next.active).length > LIMITS.pendingUploads) {
        throw new ApiError(507, 'storage_quota_exceeded');
      }
      return next;
    });
  }

  async finishUpload(id: string): Promise<void> {
    await updateJson<Quota>(this.store, 'control/quota', () => { throw new ApiError(503, 'storage_unavailable'); }, previous => {
      const active = { ...previous.active };
      delete active[id];
      return { ...previous, active };
    });
  }
}