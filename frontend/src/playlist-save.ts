import type { CloudMusicPlaylist, MusicPlaylist } from '../../shared/class-plan';
import { createClassLibrary } from './class-library';
import { canonicalAudioType, cloudHash, type CloudTransfer } from './cloud-library';
import { CloudRequestError } from './cloud-client';
import * as offline from './offline';

export function samePlaylistContent(first: CloudMusicPlaylist, second: CloudMusicPlaylist): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)])) : value;
  const content = (envelope: CloudMusicPlaylist) => {
    const { revision, locked, published, ...playlist } = envelope.playlist;
    return JSON.stringify(canonical([playlist, envelope.media]));
  };
  return content(first) === content(second);
}

export function createPlaylistSave(library = createClassLibrary()) {
  let syncing = false;
  return {
    async snapshot(playlist: MusicPlaylist, known: CloudMusicPlaylist['media']): Promise<CloudMusicPlaylist> {
      const value = structuredClone(playlist);
      const media: CloudMusicPlaylist['media'] = {};
      for (const track of value.tracks) {
        if (known[track.id]) { media[track.id] = structuredClone(known[track.id]); continue; }
        const blob = await offline.getTrackBlob(track.id);
        if (!blob) throw new Error('missing_audio');
        media[track.id] = { id: track.id, bytes: blob.size, contentType: canonicalAudioType(blob.type), sha256: await cloudHash(blob) };
      }
      return { playlist: value, media };
    },
    async sync(copy: offline.PlaylistWorkingCopy, transfer: CloudTransfer = {}): Promise<offline.PlaylistWorkingCopy | null> {
      if (syncing || !copy.pendingCloud) return null;
      syncing = true;
      try {
        let queued = structuredClone(copy);
        for (let pass = 0; pass < 3; pass++) {
          let head: CloudMusicPlaylist | null = null;
          try { head = await library.readPlaylistHead(queued.envelope.playlist.id, transfer); }
          catch (error) { if (!(error instanceof CloudRequestError && error.status === 404 && queued.cloudBaseRevision === null)) throw error; }
          const attempt = queued.cloudAttempt;
          if (head && attempt && !head.playlist.locked && head.playlist.revision === (attempt.baseRevision ?? 0) + 1
            && samePlaylistContent(head, attempt.envelope)) {
            await offline.acknowledgePlaylistWorkingCopy(head.playlist.id, attempt.localVersion, head);
            const rebased = await offline.getPlaylistWorkingCopy(head.playlist.id);
            if (!rebased?.pendingCloud) return rebased;
            queued = rebased;
          }
          if (head?.playlist.locked) throw new CloudRequestError('cloud_http_error', 423, 'playlist_locked');
          if ((head?.playlist.revision ?? null) !== queued.cloudBaseRevision) throw new Error('playlist_conflict');
          if (queued.cloudAttempt) {
            const outstanding = queued.cloudAttempt;
            const current = await offline.getPlaylistWorkingCopy(queued.envelope.playlist.id);
            if (!current || current.localVersion !== queued.localVersion || current.cloudAttempt?.localVersion !== outstanding.localVersion
              || current.cloudBaseRevision !== outstanding.baseRevision || !samePlaylistContent(current.cloudAttempt.envelope, outstanding.envelope)) throw new Error('playlist_conflict');
            const saved = await library.commitPlaylist(outstanding.envelope, outstanding.baseRevision, transfer);
            await offline.acknowledgePlaylistWorkingCopy(saved.playlist.id, outstanding.localVersion, saved);
            const remaining = await offline.getPlaylistWorkingCopy(saved.playlist.id);
            if (!remaining?.pendingCloud) return remaining;
            queued = remaining; continue;
          }
          const staged = await library.stagePlaylist(queued.envelope.playlist, { ...head?.media, ...queued.envelope.media }, transfer);
          if (queued.cloudBaseRevision === null) staged.playlist.revision = 1;
          if (!samePlaylistContent(staged, queued.envelope)) {
            queued = await offline.savePlaylistWorkingCopy(staged, {
              expectedLocalVersion: queued.localVersion, cloud: true, cloudBaseRevision: queued.cloudBaseRevision,
            });
          }
          await offline.recordPlaylistSyncAttempt(staged.playlist.id, queued.localVersion, staged, queued.cloudBaseRevision);
          const current = await offline.getPlaylistWorkingCopy(staged.playlist.id);
          if (!current || current.localVersion !== queued.localVersion) throw new Error('playlist_conflict');
          const saved = await library.commitPlaylist(staged, queued.cloudBaseRevision, transfer);
          await offline.acknowledgePlaylistWorkingCopy(saved.playlist.id, queued.localVersion, saved);
          const remaining = await offline.getPlaylistWorkingCopy(saved.playlist.id);
          if (!remaining?.pendingCloud) return remaining;
          queued = remaining;
        }
        return queued;
      } finally { syncing = false; }
    },
  };
}