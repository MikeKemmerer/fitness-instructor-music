import type { CloudRoutine, LibraryUsagePage } from '../../../shared/cloud-contract';
import type { CloudMusicPlaylist } from '../../../shared/class-plan';
import { allRoutineTracks, type Track } from '../../../shared/routine';
import { strictRecord } from '../validation';
import type { CloudAuth } from './auth';
import { ApiError, LIMITS, safeId } from './config';
import { fillerAssetIds } from './content';
import { CloudMedia } from './media';
import { CloudClasses, CloudPlaylists, type CloudClassSetup } from './plans';
import { CloudRoutines } from './routines';
import type { BlobStore, StoredBlob } from './store';

export const REFERENCE_LIMITS = Object.freeze({ snapshots: 8, bytes: 8 * 1024 * 1024, milliseconds: 20000, steps: 32 });
interface Position {
  version: 1;
  asset: string;
  exclude: string;
  stage: number;
  marker: string;
  document: string;
  offset: number;
  documents: number;
  records: number;
  last: string;
}
export interface Description { title: string; duration: number; bpm?: number }
export interface ReferencePage extends LibraryUsagePage { description?: Description }
class ScanLimit extends Error {}

class ScanStore implements BlobStore {
  readonly deadline: number;
  snapshots = 0;
  bytes = 0;
  readonly cache = new Map<string, StoredBlob | null>();
  constructor(readonly source: BlobStore, readonly clock: () => number) { this.deadline = clock() + REFERENCE_LIMITS.milliseconds; }

  async read<Value>(action: () => Promise<Value>): Promise<Value> {
    const remaining = this.deadline - this.clock();
    if (remaining <= 0) throw new ScanLimit();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([action(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ScanLimit()), remaining);
        timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  }

  async get(key: string, maximum: number): Promise<StoredBlob | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    if (this.bytes + maximum > REFERENCE_LIMITS.bytes) throw new ScanLimit();
    if (/^(snapshots|publications)\/|^(playlists|classes)\/[^/]+\/(snapshots|publications)\//.test(key)) {
      if (this.snapshots >= REFERENCE_LIMITS.snapshots) throw new ScanLimit();
      this.snapshots++;
    }
    const value = await this.read(() => this.source.get(key, maximum));
    if (value && value.bytes.length > maximum) throw new ApiError(503, 'reference_scan_uncertain');
    this.bytes += value?.bytes.length ?? 0;
    this.cache.set(key, value);
    return value;
  }

  async list(prefix: string, limit: number, cursor?: string) { return this.read(() => this.source.list(prefix, limit, cursor)); }
  async put(): Promise<string> { throw new ApiError(503, 'reference_scan_uncertain'); }
  async delete(): Promise<void> { throw new ApiError(503, 'reference_scan_uncertain'); }
}

function position(asset: string, exclude: string, cursor?: string): Position {
  if (cursor === undefined) return { version: 1, asset, exclude, stage: 0, marker: '', document: '', offset: 0, documents: 0, records: 0, last: '' };
  try {
    if (!cursor.length || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = strictRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      ['version', 'asset', 'exclude', 'stage', 'marker', 'document', 'offset', 'documents', 'records', 'last']);
    if (value.version !== 1 || value.asset !== asset || value.exclude !== exclude
      || ![value.stage, value.offset, value.documents, value.records].every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
      || (value.stage as number) > 4 || (value.offset as number) > 256 || (value.documents as number) > LIMITS.routines
      || (value.records as number) > LIMITS.fillers || typeof value.marker !== 'string' || value.marker.length > 2048
      || /[\x00-\x1f\x7f]/.test(value.marker) || typeof value.document !== 'string' || (value.document && !safeId(value.document))
      || typeof value.last !== 'string' || (value.last && !safeId(value.last))) throw new Error();
    return value as unknown as Position;
  } catch { throw new ApiError(400, 'invalid_cursor'); }
}

export class LibraryReferences {
  constructor(readonly store: BlobStore, readonly auth: CloudAuth, readonly clock: () => number = Date.now) {}

  async scan(headers: Headers, assetId: string, exclude = '', cursor?: string,
    descriptions?: Map<string, Description | undefined>): Promise<ReferencePage> {
    const state = position(assetId, exclude, cursor);
    const bounded = new ScanStore(this.store, this.clock);
    const media = new CloudMedia(bounded, this.auth);
    const routines = new CloudRoutines(bounded, this.auth, media);
    const playlists = new CloudPlaylists(bounded, this.auth, media);
    const classes = new CloudClasses(bounded, this.auth, routines, playlists);
    const sources = [routines, playlists, classes];
    const references: LibraryUsagePage['references'] = [];
    let description: Description | undefined;
    const describe = (tracks: Track[], descriptors: CloudRoutine['media']) => {
      for (const track of tracks) {
        const id = descriptors[track.id]?.id;
        if (!id) continue;
        const value = { title: track.title, duration: track.duration, ...(track.bpm === undefined ? {} : { bpm: track.bpm }) };
        if (!description && id === assetId) description = value;
        if (descriptions?.has(id) && !descriptions.get(id)) descriptions.set(id, value);
      }
    };
    const routineUses = async (input: CloudRoutine) => {
      const body = await routines.parse(input);
      describe(allRoutineTracks(body.routine), body.media);
      return routines.assetIds(body).includes(assetId);
    };
    const playlistUses = async (input: CloudMusicPlaylist) => {
      const body = await playlists.parse(input);
      describe(body.playlist.tracks, body.media);
      return Object.values(body.media).some(asset => asset.id === assetId);
    };
    try {
      for (let step = 0; state.stage < 4 && step < REFERENCE_LIMITS.steps; step++) {
        if (this.clock() >= bounded.deadline) throw new ScanLimit();
        if (descriptions && state.stage >= 2) { state.stage = 4; break; }
        const source = sources[state.stage];
        const prefix = source?.indexPrefix ?? 'fillers/index/';
        if (!state.document) {
          const page = await bounded.list(prefix, 1, state.marker || undefined);
          if (page.keys.length > 1 || (page.cursor && (page.cursor === state.marker || page.cursor.length > 2048
            || /[\x00-\x1f\x7f]/.test(page.cursor)))) throw new Error();
          if (!page.keys.length) {
            if (page.cursor) state.marker = page.cursor;
            else { state.stage++; state.marker = ''; state.last = ''; }
            continue;
          }
          const key = page.keys[0]!;
          const id = key.slice(prefix.length);
          if (!key.startsWith(prefix) || !safeId(id) || (state.last && id <= state.last)) throw new Error();
          if (source ? ++state.documents > LIMITS.routines : ++state.records > LIMITS.fillers) throw new Error();
          state.document = id;
          state.offset = 0;
        }
        const id = state.document;
        if (source) {
          const { value: head } = await source.storedHead(id);
          const history = source.history(head);
          // Migrations may drop the oldest revisions, so require a contiguous run ending at the head rather than one
          // starting at 1. A head with no stored history is still unknown and must fail closed.
          if (!descriptions && (!head.history?.length
            || history.some((link, index) => !link.draft
              || (index > 0 && link.revision !== history[index - 1]!.revision + 1))
            || history[history.length - 1]!.revision !== head.draft.revision)) throw new Error();
          const pointers = descriptions ? [{ ...head.draft, published: false }] : history.flatMap(link => [
            ...(link.draft ? [{ key: link.draft, revision: link.revision, published: false }] : []),
            ...(link.published ? [{ key: link.published, revision: link.revision, published: true }] : []),
          ]);
          if (state.offset > pointers.length) throw new Error();
          if (state.offset < pointers.length) {
            const pointer = pointers[state.offset]!;
            const body = await source.snapshot(pointer);
            const entity = state.stage === 0 ? (body as CloudRoutine).routine : state.stage === 1
              ? (body as CloudMusicPlaylist).playlist : (body as CloudClassSetup).setup;
            if (entity.id !== id || entity.revision !== pointer.revision || entity.published !== pointer.published) throw new Error();
            let used: boolean;
            if (state.stage === 0) used = await routineUses(body as CloudRoutine);
            else if (state.stage === 1) used = await playlistUses(body as CloudMusicPlaylist);
            else {
              const parsed = await classes.parse(body, headers);
              const resolved = await classes.resolve(headers, parsed.setup);
              used = await routineUses(resolved.routine);
              if (resolved.walkIn) used = (await playlistUses(resolved.walkIn)) || used;
              if (resolved.walkOut) used = (await playlistUses(resolved.walkOut)) || used;
              used = used || fillerAssetIds([...(parsed.setup.before ? [parsed.setup.before] : []),
                ...(parsed.setup.after ? [parsed.setup.after] : [])]).includes(assetId);
            }
            if (used) references.push({ kind: source.kind, id, name: entity.name, revision: entity.revision });
            state.offset++;
            if (state.offset < pointers.length) continue;
          }
        } else {
          const { recording } = (await routines.fillers.record(id)).value;
          if (id !== exclude && !await routines.fillers.deleted(id) && recording.asset.id === assetId) {
            const actual = (await media.catalog(assetId)).asset;
            if (actual.sha256 !== recording.asset.sha256 || actual.bytes !== recording.asset.bytes
              || actual.contentType !== recording.asset.contentType) throw new Error();
            references.push({ kind: 'filler', id, name: recording.name });
          }
        }
        const page = await bounded.list(prefix, 1, state.marker || undefined);
        if (page.keys.length !== 1 || page.keys[0] !== `${prefix}${id}`
          || (page.cursor && (page.cursor === state.marker || page.cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(page.cursor)))) throw new Error();
        state.last = id;
        state.document = '';
        state.offset = 0;
        state.marker = page.cursor ?? '';
        if (!page.cursor) { state.stage++; state.last = ''; }
      }
    } catch (error) {
      if (!(error instanceof ScanLimit)) throw new ApiError(503, 'reference_scan_uncertain');
    }
    return { references, complete: state.stage === 4, ...(description ? { description } : {}),
      ...(state.stage === 4 ? {} : { cursor: Buffer.from(JSON.stringify(state)).toString('base64url') }) };
  }
}