import type { CloudAudioItem, CloudAudioPage, CloudRoutine } from '../../../shared/cloud-contract';
import { allRoutineTracks, type Track } from '../../../shared/routine';
import { strictRecord } from '../validation';
import { CloudAuth } from './auth';
import { ApiError, safeId } from './config';
import { CloudMedia } from './media';
import { CloudPlaylists } from './plans';
import { CloudRoutines } from './routines';
import type { BlobStore } from './store';

export const LIBRARY_SCAN_LIMIT = 128;
const CURSOR_BYTES = 4096;

function decodeCursor(cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!cursor.length || cursor.length > CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = strictRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['version', 'marker']);
    if (value.version !== 1 || typeof value.marker !== 'string' || !value.marker.length
      || value.marker.length > 2048 || /[\x00-\x1f\x7f]/.test(value.marker)) throw new Error();
    return value.marker;
  } catch { throw new ApiError(400, 'invalid_cursor'); }
}

export class CloudLibrary {
  constructor(readonly store: BlobStore, readonly auth: CloudAuth, readonly media: CloudMedia,
    readonly routines: CloudRoutines, readonly playlists: CloudPlaylists) {}

  async list(headers: Headers, cursor?: string): Promise<CloudAudioPage> {
    const actor = await this.auth.authenticate(headers, false, true);
    const marker = decodeCursor(cursor);
    const page = await this.store.list('assets/', LIBRARY_SCAN_LIMIT, marker);
    if (page.keys.length > LIBRARY_SCAN_LIMIT || new Set(page.keys).size !== page.keys.length
      || page.keys.some(key => !/^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/(catalog|chunks\/[0-9]+)$/.test(key))
      || (page.cursor && (!page.keys.length || page.cursor === marker || page.cursor.length > 2048
        || /[\x00-\x1f\x7f]/.test(page.cursor)))) throw new ApiError(503, 'storage_unavailable');
    const items = new Map<string, CloudAudioItem>();
    for (const key of page.keys) {
      if (!key.endsWith('/catalog')) continue;
      const id = key.split('/')[1]!;
      if (!safeId(id)) throw new ApiError(503, 'storage_unavailable');
      const { asset } = await this.media.catalog(id);
      items.set(id, { asset: { ...asset }, title: '' });
    }
    const describe = (tracks: Track[], media: CloudRoutine['media']) => {
      for (const track of tracks) {
        const descriptor = media[track.id];
        const item = descriptor && items.get(descriptor.id);
        if (!item || descriptor.sha256 !== item.asset.sha256 || descriptor.bytes !== item.asset.bytes
          || descriptor.contentType !== item.asset.contentType) continue;
        if (!item.title && typeof track.title === 'string' && track.title.trim() && track.title.length <= 300) item.title = track.title;
        if (item.duration === undefined && Number.isFinite(track.duration) && track.duration > 0 && track.duration <= 1200) item.duration = track.duration;
        if (item.bpm === undefined && typeof track.bpm === 'number' && Number.isFinite(track.bpm) && track.bpm >= 40 && track.bpm <= 220) item.bpm = track.bpm;
      }
    };
    if (items.size) {
      for (const id of await this.routines.discover()) {
        try {
          const body = await this.routines.readVersion(id, false);
          describe(allRoutineTracks(body.routine), body.media);
        } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
      }
      for (const id of await this.playlists.discover()) {
        try {
          const body = await this.playlists.readVersion(id, false);
          describe(body.playlist.tracks, body.media);
        } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
      }
    }
    const fresh = await this.auth.authenticate(headers, false, true);
    if (fresh.key !== actor.key || fresh.account.id !== actor.account.id) throw new ApiError(401, 'signin_required');
    return { items: [...items.values()], ...(page.cursor
      ? { cursor: Buffer.from(JSON.stringify({ version: 1, marker: page.cursor })).toString('base64url') } : {}) };
  }
}