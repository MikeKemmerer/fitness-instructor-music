import { randomUUID } from 'node:crypto';
import type { CloudAsset, CloudRoutine, CloudRoutineSummary } from '../../../shared/cloud-contract';
import { allRoutineTracks, type Routine } from '../../../shared/routine';
import { parseRoutineContent, strictRecord } from '../validation';
import type { ReferenceClaims } from './admission';
import { CloudAuth } from './auth';
import { ApiError, safeId } from './config';
import { boundedContent, fillerAssetIds, resolveFillers, resolveMedia, routineFillers } from './content';
import { CloudDocuments } from './documents';
import { CloudFillers } from './fillers';
import { CloudMedia } from './media';
import type { BlobStore } from './store';

export { revisionHeader } from './documents';

export class CloudRoutines extends CloudDocuments<CloudRoutine, Routine> {
  readonly fillers: CloudFillers;
  constructor(store: BlobStore, auth: CloudAuth, readonly media: CloudMedia) {
    super(store, auth, 'routine');
    this.fillers = new CloudFillers(store, auth, media);
  }

  entity(body: CloudRoutine): Routine { return body.routine; }
  withEntity(body: CloudRoutine, routine: Routine): CloudRoutine { return { ...body, routine }; }
  saved(body: CloudRoutine): CloudRoutine {
    return this.withEntity(body, { ...body.routine, savedAt: this.auth.now() });
  }
  validateReplacement(previous: CloudRoutine, next: unknown): void {
    const candidate = next && typeof next === 'object' && 'routine' in next ? next.routine : null;
    if (previous.routine.schemaVersion === 2 && candidate && typeof candidate === 'object'
      && 'schemaVersion' in candidate && candidate.schemaVersion === 1) {
      throw new ApiError(409, 'routine_schema_downgrade');
    }
  }
  validatePublication(body: CloudRoutine): void {
    if (!body.routine.tracks.length) throw new ApiError(400, 'publication_requires_tracks');
  }

  async parse(input: unknown, _headers?: Headers, claims?: ReferenceClaims): Promise<CloudRoutine> {
    const value = strictRecord(input, ['routine', 'media']);
    if (!value.routine || typeof value.routine !== 'object') throw new ApiError(400, 'invalid_input');
    const fields = ['id', 'revision', 'locked', 'published', 'schemaVersion', 'name', 'tracks', 'filler', 'crossfade', 'beepEvery', 'beepRemaining'];
    if (Object.hasOwn(value.routine, 'beepOnceRemaining')) fields.push('beepOnceRemaining');
    if (Object.hasOwn(value.routine, 'sequence')) fields.push('sequence');
    if (Object.hasOwn(value.routine, 'savedAt')) fields.push('savedAt');
    const record = strictRecord(value.routine, fields);
    const { id, revision, locked, published, ...content } = record;
    if (!safeId(id) || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 ||
        typeof locked !== 'boolean' || typeof published !== 'boolean') throw new ApiError(400, 'invalid_input');
    const routine = { ...parseRoutineContent(content), id, revision, locked, published };
    const tracks = allRoutineTracks(routine);
    if (tracks.some(track => !safeId(track.id))) throw new ApiError(400, 'invalid_id');
    await resolveFillers(routineFillers(routine), this.fillers, claims);
    return boundedContent({ routine, media: await resolveMedia(value.media, tracks, this.media, claims) });
  }

  async list(headers: Headers, published: boolean): Promise<{ routines: CloudRoutineSummary[] }> {
    await this.auth.authenticate(headers, false, !published);
    const routines: CloudRoutineSummary[] = [];
    for (const id of await this.discover()) {
      let stored;
      try { stored = await this.head(id); }
      catch (error) { if (error instanceof ApiError && error.status === 404) continue; throw error; }
      const pointer = published ? stored.value.published : stored.value.draft;
      if (pointer) routines.push({ id, name: pointer.name, revision: pointer.revision, locked: pointer.locked, published,
        ...(pointer.savedAt !== undefined ? { savedAt: pointer.savedAt } : {}) });
    }
    return { routines };
  }

  copy(body: CloudRoutine): CloudRoutine {
    const routine = structuredClone(body.routine);
    const media: Record<string, CloudAsset> = Object.create(null);
    for (const track of allRoutineTracks(routine)) {
      const entryId = randomUUID();
      media[entryId] = { ...body.media[track.id]! };
      track.id = entryId;
      track.cues = track.cues.map(cue => ({ ...cue, id: randomUUID() }));
    }
    return { routine: { ...routine, id: randomUUID(), revision: 1, locked: false, published: false }, media };
  }

  assetIds(body: CloudRoutine): string[] {
    return [...Object.values(body.media).map(asset => asset.id), ...fillerAssetIds(routineFillers(body.routine))];
  }

  async authorizeAsset(headers: Headers, assetId: string, routineId: string | null, revision?: number): Promise<void> {
    const actor = await this.auth.authenticate(headers);
    if (actor.account.role !== 'player') return;
    if (!routineId) throw new ApiError(403, 'published_routine_required');
    const body = await this.get(headers, routineId, true, revision);
    if (!this.assetIds(body).includes(assetId)) throw new ApiError(403, 'forbidden');
  }
}