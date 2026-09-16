import { newRoutine, type AudioAsset, type Routine } from '../../shared/routine';
import { validateClassSetup, validateMusicPlaylist, type ClassAudio, type ClassSetup,
  type CloudMusicPlaylist, type MusicPlaylist, type RevisionReference } from '../../shared/class-plan';
import type { CloudRoutine } from '../../shared/cloud-contract';
import { cloudClient, CloudRequestError, type CloudClient } from './cloud-client';
import { canonicalAudioType, cloudHash, createCloudLibrary, parseCloudRoutine, type CloudTransfer } from './cloud-library';
import * as offline from './offline';

export interface ClassSelection { setup: ClassSetup; source: 'local' | 'household' }
export interface ResolvedClass { setup: ClassSetup; routine: Routine; audio: ClassAudio; envelope?: CloudRoutine }
export type LibraryAction = 'save' | 'lock' | 'unlock' | 'publish' | 'duplicate' | 'delete';

function exact(value: RevisionReference, reference: RevisionReference): void {
  if (value.id !== reference.id || value.revision !== reference.revision || value.published !== reference.published) {
    throw new Error('cloud_invalid_response');
  }
}

export function parseCloudPlaylist(value: unknown): CloudMusicPlaylist {
  try {
    const candidate = value as CloudMusicPlaylist;
    if (Object.keys(candidate).sort().join(',') !== 'media,playlist' || validateMusicPlaylist(candidate.playlist).length) throw new Error();
    const parsed = parseCloudRoutine({ routine: { ...newRoutine(), ...candidate.playlist }, media: candidate.media });
    return { playlist: structuredClone(candidate.playlist), media: parsed.media };
  } catch { throw new Error('cloud_invalid_response'); }
}

export function parseClassSetup(value: unknown): ClassSetup {
  try {
    const setup = value as ClassSetup;
    if (validateClassSetup(setup).length || Object.keys(setup).some(key => !['schemaVersion', 'id', 'name', 'revision',
      'locked', 'published', 'routine', 'walkIn', 'walkOut', 'before', 'after', 'crossfade'].includes(key))) throw new Error();
    return structuredClone(setup);
  } catch { throw new Error('cloud_invalid_response'); }
}

export function createClassLibrary(client: CloudClient = cloudClient, media = createCloudLibrary({ client })) {
  const guard = (transfer: CloudTransfer, write = false) => {
    const identity = client.captureIdentity();
    if (write && !['owner', 'editor'].includes(client.getRole() ?? '')) throw new CloudRequestError('forbidden', 403);
    return () => { identity(); if (transfer.signal?.aborted) throw new CloudRequestError('cancelled'); };
  };
  const path = (kind: 'classes' | 'playlists', id: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) throw new Error('cloud_invalid_response');
    return `/api/${kind}/${encodeURIComponent(id)}`;
  };
  const query = (published: boolean, revision?: number) => {
    if (client.getRole() === 'player' && !published) throw new CloudRequestError('forbidden', 403);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('cloud_invalid_response');
    const params = new URLSearchParams();
    if (published) params.set('published', 'true');
    if (revision !== undefined) params.set('revision', String(revision));
    return params.size ? `?${params}` : '';
  };
  const listPlaylists = async (published: boolean, transfer: CloudTransfer = {}): Promise<MusicPlaylist[]> => {
    const assert = guard(transfer);
    const result = await client.request<{ playlists: MusicPlaylist[] }>(`/api/playlists${query(published)}`, { signal: transfer.signal });
    assert();
    if (!Array.isArray(result.playlists) || result.playlists.length > 512 || result.playlists.some(value =>
      validateMusicPlaylist(value).length || (published && !value.published))) throw new Error('cloud_invalid_response');
    return structuredClone(result.playlists);
  };
  const listClasses = async (published: boolean, transfer: CloudTransfer = {}): Promise<ClassSetup[]> => {
    const assert = guard(transfer);
    const result = await client.request<{ classes: ClassSetup[] }>(`/api/classes${query(published)}`, { signal: transfer.signal });
    assert();
    if (!Array.isArray(result.classes) || result.classes.length > 512) throw new Error('cloud_invalid_response');
    const values = result.classes.map(parseClassSetup);
    if (published && values.some(value => !value.published)) throw new Error('cloud_invalid_response');
    return values;
  };
  const readPlaylist = async (reference: RevisionReference, transfer: CloudTransfer = {}) => {
    const assert = guard(transfer);
    const value = parseCloudPlaylist(await client.request(path('playlists', reference.id) + query(reference.published, reference.revision), { signal: transfer.signal }));
    assert(); exact(value.playlist, reference);
    return value;
  };
  const savePlaylist = async (playlist: MusicPlaylist, previous: CloudMusicPlaylist | null,
    action: LibraryAction = 'save', transfer: CloudTransfer = {}, reusableMedia: Record<string, AudioAsset> = {}): Promise<CloudMusicPlaylist> => {
    const assert = guard(transfer, true);
    assert();
    if (validateMusicPlaylist(playlist).length) throw new Error('invalid_routine');
    if (action !== 'duplicate' && (playlist.published || previous?.playlist.published)) throw new Error('cloud_head_required');
    if (action !== 'duplicate' && action !== 'unlock' && playlist.locked) throw new CloudRequestError('cloud_http_error', 423);
    if (!previous && action !== 'save') throw new Error('cloud_save_first');
    if (previous) exact(playlist, previous.playlist);
    const snapshot = structuredClone(playlist);
    const assets: Record<string, AudioAsset> = {};
    if (action === 'save' || action === 'lock') {
      for (const track of snapshot.tracks) {
        const blob = await offline.getTrackBlob(track.id);
        assert();
        if (!blob) throw new Error('missing_audio');
        const known = previous?.media[track.id] ?? reusableMedia[track.id];
        const reusable = known && blob.size === known.bytes && canonicalAudioType(blob.type) === known.contentType
          && await cloudHash(blob) === known.sha256;
        assert();
        if (reusable) assets[track.id] = known;
        else {
          const asset = await media.uploadAsset(blob, transfer);
          assert();
          if (known) {
            track.id = crypto.randomUUID();
            await offline.cacheCloudTrack(track.id, blob, asset.sha256);
            assert();
          }
          assets[track.id] = asset;
        }
      }
    }
    const endpoint = previous ? path('playlists', snapshot.id) + (action === 'save' || action === 'delete' ? '' : `/${action}`)
      + (action === 'duplicate' ? query(playlist.published, playlist.revision) : '') : '/api/playlists';
    const result = parseCloudPlaylist(await client.request(endpoint, { method: action === 'delete' ? 'DELETE' : previous && action === 'save' ? 'PUT' : 'POST',
      signal: transfer.signal, headers: { 'Content-Type': 'application/json', ...(previous && action !== 'duplicate' ? { 'If-Match': `"${previous.playlist.revision}"` } : {}) },
      ...(['save', 'lock'].includes(action) ? { body: JSON.stringify({ playlist: snapshot, media: assets }) } : {}) }));
    assert();
    if (action !== 'duplicate' && (result.playlist.id !== snapshot.id || result.playlist.revision !== (previous ? previous.playlist.revision + 1 : 1))) throw new Error('cloud_invalid_response');
    return result;
  };
  const saveClass = async (setup: ClassSetup, expectedRevision: number | null,
    action: LibraryAction = 'save', transfer: CloudTransfer = {}): Promise<ClassSetup> => {
    const assert = guard(transfer, true);
    assert();
    const snapshot = parseClassSetup(setup);
    if (action !== 'duplicate' && snapshot.published) throw new Error('cloud_head_required');
    if (snapshot.locked && !['unlock', 'duplicate'].includes(action)) throw new CloudRequestError('cloud_http_error', 423);
    if (expectedRevision === null && action !== 'save') throw new Error('cloud_save_first');
    if (expectedRevision !== null && snapshot.revision !== expectedRevision) throw new Error('cloud_head_required');
    if (action === 'save' || action === 'lock') {
      if (snapshot.before) snapshot.before = await media.prepareFiller(snapshot.before, transfer);
      assert();
      if (snapshot.after) snapshot.after = await media.prepareFiller(snapshot.after, transfer);
      assert();
    }
    const endpoint = expectedRevision === null ? '/api/classes' : path('classes', setup.id)
      + (action === 'save' || action === 'delete' ? '' : `/${action}`) + (action === 'duplicate' ? query(setup.published, setup.revision) : '');
    const response = await client.request<{ setup: ClassSetup }>(endpoint, {
      method: action === 'delete' ? 'DELETE' : expectedRevision !== null && action === 'save' ? 'PUT' : 'POST', signal: transfer.signal,
      headers: { 'Content-Type': 'application/json', ...(expectedRevision !== null && action !== 'duplicate' ? { 'If-Match': `"${expectedRevision}"` } : {}) },
      ...(['save', 'lock'].includes(action) ? { body: JSON.stringify({ setup: snapshot }) } : {}),
    });
    assert();
    const result = parseClassSetup(response.setup);
    if (action !== 'duplicate' && (result.id !== setup.id || result.revision !== (expectedRevision === null ? 1 : expectedRevision + 1))) throw new Error('cloud_invalid_response');
    return result;
  };
  const prepare = async (selection: ClassSelection, transfer: CloudTransfer = {}): Promise<ResolvedClass> => {
    const setup = parseClassSetup(selection.setup);
    if (selection.source === 'local' || client.getContext().access !== 'online' || globalThis.navigator?.onLine === false) {
      const assert = selection.source === 'household' ? guard(transfer) : () => {
        if (transfer.signal?.aborted) throw new CloudRequestError('cancelled');
      };
      if (selection.source === 'household') query(setup.published, setup.revision);
      assert();
      const cached = await offline.getPreparedClass(setup.id, setup.revision,
        selection.source === 'household' ? 'cloud' : 'local', setup.published);
      assert();
      if (!cached) throw new Error('class_cache_unavailable');
      exact(cached.setup, setup); exact(cached.routine, setup.routine);
      for (const key of ['routine', 'walkIn', 'walkOut', 'before', 'after', 'crossfade'] as const) {
        if (JSON.stringify(cached.setup[key]) !== JSON.stringify(setup[key])) throw new Error('cloud_invalid_response');
      }
      const snapshots = [cached.routine, ...[cached.audio.walkIn, cached.audio.walkOut].flatMap(playlist => playlist?.tracks.length
        ? [{ ...newRoutine(), tracks: playlist.tracks, filler: { ...newRoutine().filler, mode: 'none' as const } }] : [])];
      for (const snapshot of snapshots) {
        const ready = await offline.getReadiness(snapshot); assert();
        if (!ready.ready) throw new Error('class_cache_unavailable');
      }
      for (const filler of [cached.audio.before, cached.audio.after]) {
        if (filler?.recording && !await offline.getFillerRecordingBlob(filler.recording)) throw new Error('class_cache_unavailable');
        assert();
      }
      return structuredClone(cached);
    }
    const assert = guard(transfer);
    const response = await client.request<{ setup: unknown; routine: unknown; walkIn?: unknown; walkOut?: unknown }>(
      path('classes', setup.id) + '/prepare' + query(setup.published, setup.revision), { signal: transfer.signal });
    assert();
    const resolved = parseClassSetup(response.setup);
    exact(resolved, setup);
    exact(resolved.routine, setup.routine);
    const routine = parseCloudRoutine(response.routine);
    exact(routine.routine, setup.routine);
    const playlists: Partial<Record<'walkIn' | 'walkOut', CloudMusicPlaylist>> = {};
    for (const key of ['walkIn', 'walkOut'] as const) {
      const reference = setup[key];
      if (!!reference !== !!response[key] || !!reference !== !!resolved[key]) throw new Error('cloud_invalid_response');
      if (reference) {
        exact(resolved[key]!, reference);
        const playlist = parseCloudPlaylist(response[key]);
        exact(playlist.playlist, reference); playlists[key] = playlist;
      }
    }
    const authority = setup.published ? { classId: setup.id, revision: setup.revision } : undefined;
    const envelope = await media.download(routine, transfer, setup.routine.published, authority ?? null);
    assert();
    const audio: ClassAudio = { crossfade: resolved.crossfade, before: resolved.before, after: resolved.after };
    for (const key of ['walkIn', 'walkOut'] as const) {
      const playlist = playlists[key];
      if (!playlist) continue;
      await media.downloadTracks(playlist.playlist.tracks, playlist.media, transfer, authority);
      assert();
      await offline.cacheMusicPlaylist(playlist);
      assert(); audio[key] = playlist.playlist;
    }
    for (const filler of [resolved.before, resolved.after]) {
      if (filler?.recording) await media.ensureFiller(filler.recording, transfer, authority);
      assert();
    }
    await offline.cacheClassSetup(resolved);
    assert();
    return { setup: resolved, routine: envelope.routine, envelope, audio };
  };
  return { listPlaylists, listClasses, readPlaylist, savePlaylist, saveClass, prepare };
}