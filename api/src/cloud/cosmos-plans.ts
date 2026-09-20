import { randomUUID } from 'node:crypto';
import { validateClassSetup, type ClassSetup, type CloudMusicPlaylist, type MusicPlaylist, type RevisionReference } from '../../../shared/class-plan';
import type { CloudAsset, CloudRoutine } from '../../../shared/cloud-contract';
import type { Filler } from '../../../shared/routine';
import { ServiceError } from '../errors';
import { parseFiller, parseRoutineContent, strictRecord, text } from '../validation';
import type { ReferenceClaims } from './admission';
import { CloudAuth } from './auth';
import { ApiError, safeId } from './config';
import { boundedContent, fillerAssetIds, resolveFillers, resolveMedia } from './content';
import { CloudDocumentsCosmos } from './cosmos-documents';
import type { CosmosStoreLike } from './cosmos-store';
import { CloudFillers } from './fillers';
import { blobDocumentsAdmission } from './hybrid-admission';
import { CloudMedia } from './media';
import type { CosmosRoutines } from './cosmos-routines';
import type { BlobStore } from './store';

export interface CloudClassSetup { setup: ClassSetup }
export interface ResolvedClassSetup extends CloudClassSetup {
  routine: CloudRoutine;
  walkIn?: CloudMusicPlaylist;
  walkOut?: CloudMusicPlaylist;
}

const stateKeys = ['schemaVersion', 'id', 'name', 'revision', 'locked', 'published'];

function state(record: Record<string, unknown>) {
  const { id, revision, locked, published } = record;
  if (record.schemaVersion !== 1 || !safeId(id) || typeof revision !== 'number' || !Number.isSafeInteger(revision)
    || revision < 1 || typeof locked !== 'boolean' || typeof published !== 'boolean') throw new ApiError(400, 'invalid_input');
  return { schemaVersion: 1 as const, id, name: text(record.name), revision, locked, published };
}

function reference(input: unknown): RevisionReference {
  const { id, revision, published } = strictRecord(input, ['id', 'revision', 'published']);
  if (!safeId(id) || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
    || typeof published !== 'boolean') throw new ApiError(400, 'invalid_reference');
  return { id, revision, published };
}

function announcements(setup: ClassSetup): Filler[] {
  return [...(setup.before ? [setup.before] : []), ...(setup.after ? [setup.after] : [])];
}

// See cosmos-routines.ts for why admission/quota/fillers/media stay on Blob for now.
export class CosmosPlaylists extends CloudDocumentsCosmos<CloudMusicPlaylist, MusicPlaylist, ReferenceClaims> {
  constructor(cosmosStore: CosmosStoreLike, blobStore: BlobStore, auth: CloudAuth, readonly media: CloudMedia) {
    super(cosmosStore, auth, 'playlist', blobDocumentsAdmission(blobStore));
  }

  entity(body: CloudMusicPlaylist): MusicPlaylist { return body.playlist; }
  withEntity(body: CloudMusicPlaylist, playlist: MusicPlaylist): CloudMusicPlaylist { return { ...body, playlist }; }

  async parse(input: unknown, _headers?: Headers, claims?: ReferenceClaims): Promise<CloudMusicPlaylist> {
    const envelope = strictRecord(input, ['playlist', 'media']);
    const record = strictRecord(envelope.playlist, [...stateKeys, 'tracks']);
    if (record.schemaVersion !== 1 && record.schemaVersion !== 2) throw new ApiError(400, 'invalid_input');
    const metadata: Omit<MusicPlaylist, 'tracks'> = { ...state({ ...record, schemaVersion: 1 }), schemaVersion: record.schemaVersion };
    const { tracks } = parseRoutineContent({ schemaVersion: 1, name: metadata.name, tracks: record.tracks,
      filler: { mode: 'none', seconds: 0, bpm: 100, sound: 'soft' }, crossfade: 0, beepEvery: 0, beepRemaining: 0 });
    if (tracks.some(track => !safeId(track.id))) throw new ApiError(400, 'invalid_id');
    if (tracks.some(track => track.cues.length !== 0 || track.after !== undefined)) throw new ApiError(400, 'playlist_choreography_forbidden');
    return boundedContent({ playlist: { ...metadata, tracks }, media: await resolveMedia(envelope.media, tracks, this.media, claims) });
  }

  validatePublication(body: CloudMusicPlaylist): void {
    if (!body.playlist.tracks.length) throw new ApiError(400, 'publication_requires_tracks');
  }

  copy(body: CloudMusicPlaylist): CloudMusicPlaylist {
    const media: Record<string, CloudAsset> = Object.create(null);
    const tracks = body.playlist.tracks.map(track => {
      const id = randomUUID();
      media[id] = body.media[track.id]!;
      return { ...track, id, cues: [] };
    });
    return { playlist: { ...body.playlist, id: randomUUID(), revision: 1, locked: false, published: false, tracks }, media };
  }

  async list(headers: Headers, published: boolean): Promise<{ playlists: MusicPlaylist[] }> {
    return { playlists: await this.summaries(headers, published) };
  }

  async authorizeAsset(headers: Headers, assetId: string, id: string, revision: number): Promise<void> {
    const body = await this.get(headers, id, true, revision);
    if (!Object.values(body.media).some(asset => asset.id === assetId)) throw new ApiError(403, 'forbidden');
  }

  assetIds(body: CloudMusicPlaylist): string[] {
    return Object.values(body.media).map(asset => asset.id);
  }
}

// See cosmos-routines.ts for why admission/quota/fillers/media stay on Blob for now.
export class CosmosClasses extends CloudDocumentsCosmos<CloudClassSetup, ClassSetup, ReferenceClaims> {
  readonly fillers: CloudFillers;
  constructor(cosmosStore: CosmosStoreLike, blobStore: BlobStore, auth: CloudAuth,
    readonly routines: CosmosRoutines, readonly playlists: CosmosPlaylists) {
    super(cosmosStore, auth, 'class', blobDocumentsAdmission(blobStore));
    this.fillers = routines.fillers;
  }

  entity(body: CloudClassSetup): ClassSetup { return body.setup; }
  withEntity(body: CloudClassSetup, setup: ClassSetup): CloudClassSetup { return { ...body, setup }; }

  async parse(input: unknown, headers: Headers, claims?: ReferenceClaims): Promise<CloudClassSetup> {
    let setup: ClassSetup;
    try {
      const envelope = strictRecord(input, ['setup']);
      const optional = ['walkIn', 'walkOut', 'before', 'after'];
      if (!envelope.setup || typeof envelope.setup !== 'object') throw new ApiError(400, 'invalid_input');
      const record = strictRecord(envelope.setup, [...stateKeys, 'routine', 'crossfade',
        ...optional.filter(key => Object.hasOwn(envelope.setup!, key))]);
      if (typeof record.crossfade !== 'number') throw new ApiError(400, 'invalid_input');
      setup = { ...state(record), routine: reference(record.routine), crossfade: record.crossfade,
        ...(Object.hasOwn(record, 'walkIn') ? { walkIn: reference(record.walkIn) } : {}),
        ...(Object.hasOwn(record, 'walkOut') ? { walkOut: reference(record.walkOut) } : {}),
        ...(Object.hasOwn(record, 'before') ? { before: parseFiller(record.before) } : {}),
        ...(Object.hasOwn(record, 'after') ? { after: parseFiller(record.after) } : {}) };
      if (validateClassSetup(setup).length) throw new ApiError(400, 'invalid_class_setup');
    } catch (error) {
      if (error instanceof ApiError || error instanceof ServiceError) throw error;
      throw new ApiError(400, 'invalid_input');
    }
    const resolved = await this.resolve(headers, setup);
    if (claims) {
      await this.routines.parse(resolved.routine, headers, claims);
      if (resolved.walkIn) await this.playlists.parse(resolved.walkIn, headers, claims);
      if (resolved.walkOut) await this.playlists.parse(resolved.walkOut, headers, claims);
    }
    await resolveFillers(announcements(setup), this.fillers, claims);
    return boundedContent({ setup });
  }

  validatePublication(body: CloudClassSetup): void {
    if ([body.setup.routine, body.setup.walkIn, body.setup.walkOut].some(pin => pin && !pin.published)) {
      throw new ApiError(400, 'published_references_required');
    }
  }

  copy(body: CloudClassSetup): CloudClassSetup {
    return { setup: { ...structuredClone(body.setup), id: randomUUID(), revision: 1, locked: false, published: false } };
  }

  async list(headers: Headers, published: boolean): Promise<{ classes: ClassSetup[] }> {
    return { classes: await this.summaries(headers, published) };
  }

  async resolve(headers: Headers, setup: ClassSetup): Promise<ResolvedClassSetup> {
    await this.auth.authenticate(headers, false, !setup.published);
    if (setup.published) this.validatePublication({ setup });
    const routine = await this.routines.readVersion(setup.routine.id, setup.routine.published, setup.routine.revision, setup.routine.published);
    const playlist = (pin: RevisionReference) => this.playlists.readVersion(pin.id, pin.published, pin.revision, pin.published);
    return { setup, routine,
      ...(setup.walkIn ? { walkIn: await playlist(setup.walkIn) } : {}),
      ...(setup.walkOut ? { walkOut: await playlist(setup.walkOut) } : {}) };
  }

  async prepare(headers: Headers, id: string, published: boolean, revision?: number): Promise<ResolvedClassSetup> {
    const { setup } = await this.get(headers, id, published, revision);
    const result = await this.resolve(headers, setup);
    await this.auth.authenticate(headers, false, !published);
    return result;
  }

  async authorizeAsset(headers: Headers, assetId: string, id: string, revision: number): Promise<void> {
    const resolved = await this.prepare(headers, id, true, revision);
    const ids = [...this.routines.assetIds(resolved.routine), ...fillerAssetIds(announcements(resolved.setup)),
      ...[resolved.walkIn, resolved.walkOut].flatMap(body => body ? Object.values(body.media).map(asset => asset.id) : [])];
    if (!ids.includes(assetId)) throw new ApiError(403, 'forbidden');
  }

  // Nested routine/walkIn/walkOut references are already covered by THEIR OWN snapshot.assetIds
  // (they're independently scanned), so a class's own snapshot only needs its direct filler refs.
  assetIds(body: CloudClassSetup): string[] {
    return fillerAssetIds(announcements(body.setup));
  }
}
