import type { CloudRoutine } from '../../shared/cloud-contract';
import { allRoutineTracks, type Routine } from '../../shared/routine';
import * as offline from './offline';
import { canonicalAudioType, cloudHash, createCloudLibrary, type CloudTransfer } from './cloud-library';
import { CloudRequestError } from './cloud-client';

export function sameSavedContent(first: CloudRoutine, second: CloudRoutine): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey)).map(([key, entry]) => [key, canonical(entry)])) : value;
  const content = (envelope: CloudRoutine) => {
    const { revision, savedAt, locked, published, ...routine } = envelope.routine;
    return JSON.stringify(canonical([routine, envelope.media]));
  };
  return content(first) === content(second);
}

export function createRoutineSave(library = createCloudLibrary()) {
  let syncing = false;
  return {
    async snapshot(routine: Routine, known: CloudRoutine['media']): Promise<CloudRoutine> {
      const value = structuredClone(routine);
      const media: CloudRoutine['media'] = {};
      for (const track of allRoutineTracks(value)) {
        if (known[track.id]) { media[track.id] = structuredClone(known[track.id]); continue; }
        const blob = await offline.getTrackBlob(track.id);
        if (!blob) throw new Error('missing_audio');
        media[track.id] = { id: track.id, bytes: blob.size, contentType: canonicalAudioType(blob.type), sha256: await cloudHash(blob) };
      }
      return { routine: value, media };
    },
    async sync(copy: offline.RoutineWorkingCopy, transfer: CloudTransfer = {}): Promise<offline.RoutineWorkingCopy | null> {
      if (syncing || !copy.pendingCloud) return null;
      syncing = true;
      try {
        let queued = structuredClone(copy);
        for (let pass = 0; pass < 3; pass++) {
          let head: CloudRoutine | null = null;
          try { head = await library.readHead(queued.envelope.routine.id, transfer); }
          catch (error) { if (!(error instanceof CloudRequestError && error.status === 404 && queued.cloudBaseRevision === null)) throw error; }
          const attempt = queued.cloudAttempt;
          if (head && attempt && !head.routine.locked && head.routine.revision === (attempt.baseRevision ?? 0) + 1 && sameSavedContent(head, attempt.envelope)) {
            await offline.acknowledgeRoutineWorkingCopy(head.routine.id, attempt.localVersion, head);
            const rebased = await offline.getRoutineWorkingCopy(head.routine.id);
            if (!rebased?.pendingCloud) return rebased;
            queued = rebased;
          }
          if (head?.routine.locked) throw new CloudRequestError('cloud_http_error', 423, 'routine_locked');
          if ((head?.routine.revision ?? null) !== queued.cloudBaseRevision) throw new CloudRequestError('cloud_http_error', 412, 'routine_conflict');
          if (queued.cloudAttempt) {
            const outstanding = queued.cloudAttempt;
            const current = await offline.getRoutineWorkingCopy(queued.envelope.routine.id);
            if (!current || current.localVersion !== queued.localVersion || current.cloudAttempt?.localVersion !== outstanding.localVersion
              || current.cloudBaseRevision !== outstanding.baseRevision || !sameSavedContent(current.cloudAttempt.envelope, outstanding.envelope)) throw new Error('routine_conflict');
            const saved = await library.commit(outstanding.envelope, outstanding.baseRevision, 'save', transfer);
            await offline.acknowledgeRoutineWorkingCopy(saved.routine.id, outstanding.localVersion, saved);
            const remaining = await offline.getRoutineWorkingCopy(saved.routine.id);
            if (!remaining?.pendingCloud) return remaining;
            queued = remaining; continue;
          }
          const staged = await library.stage(queued.envelope.routine, { ...head?.media, ...queued.envelope.media }, transfer);
          if (queued.cloudBaseRevision === null) staged.routine.revision = 1;
          if (!sameSavedContent(staged, queued.envelope)) {
            queued = await offline.saveRoutineWorkingCopy(staged, { expectedLocalVersion: queued.localVersion, cloud: true, cloudBaseRevision: queued.cloudBaseRevision });
          }
          await offline.recordRoutineSyncAttempt(staged.routine.id, queued.localVersion, staged, queued.cloudBaseRevision);
          const current = await offline.getRoutineWorkingCopy(staged.routine.id);
          if (!current || current.localVersion !== queued.localVersion) throw new Error('routine_conflict');
          const saved = await library.commit(staged, queued.cloudBaseRevision, 'save', transfer);
          await offline.acknowledgeRoutineWorkingCopy(saved.routine.id, queued.localVersion, saved);
          const remaining = await offline.getRoutineWorkingCopy(saved.routine.id);
          if (!remaining?.pendingCloud) return remaining;
          queued = remaining;
        }
        return queued;
      } finally { syncing = false; }
    },
  };
}