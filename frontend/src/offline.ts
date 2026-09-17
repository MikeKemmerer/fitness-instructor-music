import { openDB, type DBSchema, type IDBPTransaction } from 'idb';
import { allRoutineFillers, allRoutineTracks, newRoutine, validFillerRecording, validateRoutine, type Filler, type FillerRecording, type Routine, type Track } from '../../shared/routine';
import type { CloudRoutine } from '../../shared/cloud-contract';
import { AAC_IMPORT } from '../../shared/audio-import';
import { hostedInvalidationEvent, hostedResetKey, hostedUserKey } from './hosted-session';
import type { ClassAudio, ClassSetup, CloudMusicPlaylist, MusicPlaylist, PreparedClass, RevisionReference } from '../../shared/class-plan';
import { checkedClassSetup, checkedMusicPlaylist, classFillers, snapshotClassAudio } from './session-runtime';

export const MAX_TRACK_BYTES = AAC_IMPORT.maxSourceBytes;
export const MAX_TRACK_SECONDS = AAC_IMPORT.maxDuration;
export const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_CLOUD_TRACK_BYTES = 128 * 1024 * 1024;

interface StoredTrack {
  blob: Blob;
  bytes: number;
  duration: number;
  sha256?: string;
}

interface RehearsalDatabase extends DBSchema {
  routineWorkingCopies: { key: string; value: RoutineWorkingCopy };
  cloudRoutineEnvelopes: { key: string; value: CloudRoutine };
  draftRecovery: { key: string; value: DraftRecovery };
  tracks: { key: string; value: StoredTrack };
  routines: { key: string; value: Routine };
  cloudRoutines: { key: string; value: Routine };
  routineHistory: { key: string; value: Routine };
  cloudRoutineHistory: { key: string; value: Routine };
  musicPlaylists: { key: string; value: MusicPlaylist };
  musicPlaylistHistory: { key: string; value: MusicPlaylist };
  cloudMusicPlaylists: { key: string; value: CloudMusicPlaylist };
  classSetups: { key: string; value: ClassSetup };
  classSetupHistory: { key: string; value: ClassSetup };
  cloudClassSetups: { key: string; value: ClassSetup };
  fillerRecordings: { key: string; value: FillerRecording };
  meta: { key: string; value: string };
}

interface MutationSession {
  assert(): void;
}

let hostedGeneration = 0;
let hostedOwner: string | undefined;
let listeningForSession = false;
const pendingMutations = new Set<() => void>();
const activeConversionControllers = new Set<AbortController>();

function invalidateSession(): void {
  if (hostedGeneration !== 0) return;
  hostedGeneration++;
  for (const controller of activeConversionControllers) controller.abort();
  for (const abort of pendingMutations) abort();
}

function captureMutationSession(): MutationSession | undefined {
  if (import.meta.env.VITE_HOSTED_PILOT !== 'true') return undefined;
  const fail = (): never => {
    invalidateSession();
    throw new Error('hosted_session_invalidated');
  };
  try {
    if (hostedGeneration !== 0) return fail();
    const storage = window.localStorage;
    if (!listeningForSession) {
      window.addEventListener('storage', (event: StorageEvent) => {
        if (event.storageArea && event.storageArea !== storage) return;
        if (event.key === null ||
          ((event.key === hostedUserKey || event.key === hostedResetKey) && event.oldValue !== event.newValue)) {
          invalidateSession();
        }
      });
      window.addEventListener('pagehide', invalidateSession);
      window.addEventListener(hostedInvalidationEvent, invalidateSession);
      listeningForSession = true;
    }
    const owner = storage.getItem(hostedUserKey);
    const reset = storage.getItem(hostedResetKey);
    const generation = hostedGeneration;
    if (!owner?.trim() || reset !== null || (hostedOwner !== undefined && hostedOwner !== owner)) return fail();
    hostedOwner = owner;
    return {
      assert() {
        try {
          if (hostedGeneration !== generation || window.localStorage !== storage || storage.getItem(hostedUserKey) !== owner ||
            storage.getItem(hostedResetKey) !== reset) fail();
        } catch { fail(); }
      },
    };
  } catch { return fail(); }
}

async function database(session = captureMutationSession()) {
  session?.assert();
  const connection = await openDB<RehearsalDatabase>('fitness-rehearsal', 7, {
    upgrade(connection, oldVersion, _newVersion, transaction) {
      try { session?.assert(); }
      catch { transaction.abort(); return; }
      if (oldVersion < 1) {
        connection.createObjectStore('tracks');
        connection.createObjectStore('routines');
      }
      if (oldVersion < 2) connection.createObjectStore('meta');
      if (oldVersion < 3) connection.createObjectStore('cloudRoutines');
      if (oldVersion < 4) connection.createObjectStore('fillerRecordings');
      if (oldVersion < 6) connection.createObjectStore('draftRecovery');
      if (oldVersion < 7) {
        connection.createObjectStore('routineWorkingCopies');
        connection.createObjectStore('cloudRoutineEnvelopes');
      }
      if (oldVersion < 5) {
        for (const name of ['routineHistory', 'cloudRoutineHistory', 'musicPlaylists', 'musicPlaylistHistory',
          'cloudMusicPlaylists', 'classSetups', 'classSetupHistory', 'cloudClassSetups'] as const) connection.createObjectStore(name);
      }
      if (oldVersion === 1) {
        const routines = transaction.objectStore('routines');
        void routines.get('active').then(previous => {
          session?.assert();
          if (!previous) return;
          void routines.delete('active');
          void routines.put(previous, previous.id);
          void transaction.objectStore('meta').put(previous.id, 'active');
        }).catch(() => transaction.abort());
      }
    },
    blocking(_current, _next, event) {
      (event.target as IDBDatabase).close();
    },
  });
  try { session?.assert(); }
  catch (error) { connection.close(); throw error; }
  return connection;
}

type StoreName = 'routineWorkingCopies' | 'cloudRoutineEnvelopes' | 'draftRecovery' | 'tracks' | 'routines' | 'cloudRoutines' | 'fillerRecordings' | 'meta' | 'routineHistory' |
  'cloudRoutineHistory' | 'musicPlaylists' | 'musicPlaylistHistory' | 'cloudMusicPlaylists' |
  'classSetups' | 'classSetupHistory' | 'cloudClassSetups';

async function mutate<Stores extends StoreName[], Result>(
  session: MutationSession | undefined, stores: Stores,
  write: (transaction: IDBPTransaction<RehearsalDatabase, Stores, 'readwrite'>) => Promise<Result>,
): Promise<Result> {
  const connection = await database(session);
  try {
    session?.assert();
    const transaction = connection.transaction(stores, 'readwrite');
    const abort = () => { try { transaction.abort(); } catch {} };
    if (session) pendingMutations.add(abort);
    void transaction.done.catch(() => undefined);
    try {
      session?.assert();
      const result = await write(transaction);
      session?.assert();
      await transaction.done;
      session?.assert();
      return result;
    } catch (error) {
      abort();
      await transaction.done.catch(() => undefined);
      session?.assert();
      throw error;
    } finally {
      pendingMutations.delete(abort);
    }
  } finally {
    connection.close();
  }
}

async function digest(blob: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const result = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface DraftRecovery {
  id: string;
  kind: 'routine' | 'playlist' | 'class';
  source: 'local' | 'household';
  value: Routine | MusicPlaylist | ClassSetup;
  baseRevision: number | null;
  media: Record<string, import('../../shared/routine').AudioAsset>;
  updatedAt: number;
}

export async function saveDraftRecovery(record: DraftRecovery): Promise<void> {
  const session = captureMutationSession();
  const snapshot = structuredClone(record);
  const size = (value: DraftRecovery) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (!snapshot.id || !['routine', 'playlist', 'class'].includes(snapshot.kind) ||
    !['local', 'household'].includes(snapshot.source) || !snapshot.value?.id ||
    snapshot.value.locked || snapshot.value.published || !Number.isFinite(snapshot.updatedAt) ||
    size(snapshot) > 256 * 1024) throw new Error('recovery_limit');
  await mutate(session, ['draftRecovery'], async transaction => {
    const store = transaction.objectStore('draftRecovery');
    const records = (await store.getAll()).filter(value => value.id !== snapshot.id);
    if (records.length >= 64 || records.reduce((total, value) => total + size(value), size(snapshot)) > 4 * 1024 * 1024) {
      throw new Error('recovery_limit');
    }
    await store.put(snapshot, snapshot.id);
  });
}

export async function listDraftRecoveries(): Promise<DraftRecovery[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const values = await connection.getAll('draftRecovery');
    session?.assert();
    return values.sort((left, right) => right.updatedAt - left.updatedAt);
  } finally { connection.close(); }
}

export async function removeDraftRecovery(id: string, updatedAt?: number): Promise<void> {
  const session = captureMutationSession();
  await mutate(session, ['draftRecovery'], async transaction => {
    const store = transaction.objectStore('draftRecovery');
    const current = await store.get(id);
    if (updatedAt !== undefined && current && current.updatedAt !== updatedAt) throw new Error('routine_conflict');
    await store.delete(id);
  });
}

function checkRoutine(routine: Routine): void {
  if (validateRoutine(routine).length) throw new Error('invalid_routine');
}

const revisionKey = (id: string, revision: number, published?: boolean) => JSON.stringify(published === undefined ? [id, revision] : [id, revision, published]);
const deletedKey = (kind: 'routine' | 'playlist' | 'class', id: string) => JSON.stringify(['deleted', kind, id]);

export interface RoutineWorkingCopy {
  envelope: CloudRoutine;
  localVersion: number;
  cloudBaseRevision: number | null;
  pendingCloud: boolean;
  savedAt: number;
  cloudAttempt?: { envelope: CloudRoutine; localVersion: number; baseRevision: number | null };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ?
    Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

function workingContent(envelope: CloudRoutine): string {
  return canonicalJson({ ...envelope, routine: { ...envelope.routine,
    revision: 0, savedAt: undefined, locked: false, published: false } });
}

async function putWorkingCopy(
  store: IDBPTransaction<RehearsalDatabase, ['routineWorkingCopies'], 'readwrite'>['store'], record: RoutineWorkingCopy,
): Promise<void> {
  const size = (value: RoutineWorkingCopy) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const records = (await store.getAll()).filter(value => value.envelope.routine.id !== record.envelope.routine.id);
  if (size(record) > 256 * 1024 || records.length >= 64 ||
    records.reduce((total, value) => total + size(value), size(record)) > 4 * 1024 * 1024) throw new Error('routine_working_copy_limit');
  await store.put(record, record.envelope.routine.id);
}

function checkedWorkingEnvelope(value: CloudRoutine): CloudRoutine {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['routine', 'media'].includes(key))) throw new Error('invalid_cloud_routine');
  const snapshot = structuredClone(value);
  checkRoutine(snapshot.routine);
  const fields = (value: object, allowed: string[]) => {
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid_cloud_routine');
  };
  fields(snapshot.routine, ['schemaVersion', 'id', 'name', 'revision', 'locked', 'published', 'tracks', 'filler',
    'crossfade', 'beepEvery', 'beepRemaining', 'beepOnceRemaining', 'sequence', 'savedAt']);
  if (snapshot.routine.sequence) {
    fields(snapshot.routine.sequence, ['crossfade', 'walkIn', 'before', 'after', 'walkOut']);
    for (const playlist of [snapshot.routine.sequence.walkIn, snapshot.routine.sequence.walkOut]) {
      if (!playlist) continue;
      fields(playlist, ['name', 'tracks', 'source']);
      if (playlist.source) fields(playlist.source, ['id', 'revision', 'published']);
    }
  }
  const assets = new Map<string, string>();
  const registerAsset = (asset: import('../../shared/routine').AudioAsset) => {
    const identity = JSON.stringify([asset.sha256, asset.bytes, asset.contentType]);
    if (assets.has(asset.id) && assets.get(asset.id) !== identity) throw new Error('invalid_media');
    assets.set(asset.id, identity);
  };
  for (const filler of allRoutineFillers(snapshot.routine)) {
    fields(filler, ['mode', 'seconds', 'bpm', 'sound', 'gain', 'recording']);
    if (filler.recording) {
      fields(filler.recording, ['id', 'name', 'duration', 'asset']);
      fields(filler.recording.asset, ['id', 'sha256', 'bytes', 'contentType']);
      registerAsset(filler.recording.asset);
    }
  }
  const tracks = allRoutineTracks(snapshot.routine);
  const media = snapshot.media;
  if (!media || typeof media !== 'object' || Array.isArray(media) || Object.keys(media).length !== tracks.length) {
    throw new Error('invalid_media');
  }
  for (const track of tracks) {
    fields(track, ['id', 'title', 'duration', 'bpm', 'firstBeat', 'cues', 'bodyArea', 'gain', 'after']);
    if (track.after) fields(track.after, track.after.mode === 'none' ? ['mode'] : ['mode', 'filler', 'crossfade']);
    for (const cue of track.cues) {
      fields(cue, ['id', 'anchor', 'note', 'beep']);
      fields(cue.anchor, cue.anchor.kind === 'count' ? ['kind', 'count'] : ['kind', 'seconds']);
    }
    const asset = Object.hasOwn(media, track.id) ? media[track.id] : undefined;
    if (!asset || Object.keys(asset).some(key => !['id', 'sha256', 'bytes', 'contentType'].includes(key)) ||
      !validFillerRecording({ id: 'descriptor', name: 'Descriptor', duration: Math.min(track.duration, 360), asset })) {
      throw new Error('invalid_media');
    }
    registerAsset(asset);
  }
  return snapshot;
}

function checkRoutineDowngrade(previous: Routine | undefined, next: Routine): void {
  if (previous?.schemaVersion === 2 && next.schemaVersion === 1) throw new Error('routine_conflict');
}

export async function getRoutineWorkingCopy(id: string): Promise<RoutineWorkingCopy | null> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const value = await connection.get('routineWorkingCopies', id);
    session?.assert();
    return value ?? null;
  } finally { connection.close(); }
}

export async function listRoutineWorkingCopies(): Promise<RoutineWorkingCopy[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const values = await connection.getAll('routineWorkingCopies');
    session?.assert();
    return values.sort((left, right) => right.savedAt - left.savedAt);
  } finally { connection.close(); }
}

export async function saveRoutineWorkingCopy(envelope: CloudRoutine, options: {
  expectedLocalVersion: number | null; cloud: boolean; cloudBaseRevision: number | null;
}): Promise<RoutineWorkingCopy> {
  const session = captureMutationSession();
  const snapshot = checkedWorkingEnvelope(envelope);
  const { expectedLocalVersion, cloud, cloudBaseRevision } = options;
  const validRevision = (value: number | null) => value === null || Number.isSafeInteger(value) && value > 0;
  if (!validRevision(expectedLocalVersion) || !validRevision(cloudBaseRevision) || typeof cloud !== 'boolean' ||
    cloudBaseRevision !== null && snapshot.routine.revision !== cloudBaseRevision) throw new Error('routine_conflict');
  if (snapshot.routine.published) throw new Error('routine_published');
  if (snapshot.routine.locked) throw new Error('routine_locked');
  return mutate(session, ['routineWorkingCopies', 'routines', 'cloudRoutines', 'meta'], async transaction => {
    const store = transaction.objectStore('routineWorkingCopies');
    const id = snapshot.routine.id;
    const previous = await store.get(id);
    if (expectedLocalVersion !== (previous?.localVersion ?? null) ||
      await transaction.objectStore('meta').get(deletedKey('routine', id))) throw new Error('routine_conflict');
    const cloudHead = await transaction.objectStore('cloudRoutines').get(id);
    for (const saved of [previous?.envelope.routine, await transaction.objectStore('routines').get(id), cloudHead]) {
      checkRoutineDowngrade(saved, snapshot.routine);
      if (saved?.locked) throw new Error('routine_locked');
    }
    if (previous && previous.cloudBaseRevision !== cloudBaseRevision &&
      (previous.cloudAttempt || cloudBaseRevision === null || cloudBaseRevision < (previous.cloudBaseRevision ?? 0) ||
        cloudHead?.revision !== cloudBaseRevision)) throw new Error('routine_conflict');
    const localVersion = (previous?.localVersion ?? 0) + 1;
    if (!Number.isSafeInteger(localVersion)) throw new Error('routine_conflict');
    const savedAt = Date.now();
    snapshot.routine.savedAt = savedAt;
    const record: RoutineWorkingCopy = { envelope: snapshot, localVersion, cloudBaseRevision,
      pendingCloud: cloud || previous?.pendingCloud === true, savedAt,
      ...(previous?.cloudAttempt ? { cloudAttempt: previous.cloudAttempt } : {}) };
    await putWorkingCopy(store, record);
    await transaction.objectStore('meta').put(id, 'active');
    await transaction.objectStore('meta').delete('activeRoutineSelection');
    return record;
  });
}

export async function recordRoutineSyncAttempt(
  id: string, localVersion: number, envelope: CloudRoutine, baseRevision: number | null,
): Promise<void> {
  const session = captureMutationSession();
  const snapshot = checkedWorkingEnvelope(envelope);
  if (snapshot.routine.id !== id || !Number.isSafeInteger(localVersion) || localVersion < 1 ||
    baseRevision !== null && (!Number.isSafeInteger(baseRevision) || baseRevision < 1 || snapshot.routine.revision !== baseRevision) ||
    snapshot.routine.locked || snapshot.routine.published) throw new Error('routine_conflict');
  await mutate(session, ['routineWorkingCopies', 'meta'], async transaction => {
    const store = transaction.objectStore('routineWorkingCopies');
    const current = await store.get(id);
    if (!current || current.localVersion !== localVersion || !current.pendingCloud || current.cloudBaseRevision !== baseRevision ||
      await transaction.objectStore('meta').get(deletedKey('routine', id)) ||
      workingContent(current.envelope) !== workingContent(snapshot)) throw new Error('routine_conflict');
    const cloudAttempt = { envelope: snapshot, localVersion, baseRevision };
    if (current.cloudAttempt && canonicalJson(current.cloudAttempt) !== canonicalJson(cloudAttempt)) throw new Error('routine_conflict');
    await putWorkingCopy(store, { ...current, cloudAttempt });
  });
}

type WorkingCloudTransaction = IDBPTransaction<RehearsalDatabase,
  ['routineWorkingCopies', 'cloudRoutineEnvelopes', 'cloudRoutines', 'cloudRoutineHistory', 'meta'], 'readwrite'>;

async function cacheWorkingEnvelope(transaction: WorkingCloudTransaction, snapshot: CloudRoutine): Promise<void> {
  const id = snapshot.routine.id;
  const key = revisionKey(id, snapshot.routine.revision, snapshot.routine.published);
  const mirrors = transaction.objectStore('cloudRoutineEnvelopes');
  const existing = await mirrors.get(key);
  if (existing && canonicalJson(existing) !== canonicalJson(snapshot)) throw new Error('routine_conflict');
  const cloud = transaction.objectStore('cloudRoutines');
  const previous = await cloud.get(id);
  checkRoutineDowngrade(previous, snapshot.routine);
  if (previous && (previous.revision > snapshot.routine.revision || previous.revision === snapshot.routine.revision &&
    workingContent({ routine: previous, media: snapshot.media }) !== workingContent(snapshot))) throw new Error('routine_conflict');
  const history = transaction.objectStore('cloudRoutineHistory');
  const historical = await history.get(key);
  if (historical && canonicalJson(historical) !== canonicalJson(snapshot.routine)) throw new Error('routine_conflict');
  if (previous && !await history.get(revisionKey(id, previous.revision, previous.published))) {
    await history.put(previous, revisionKey(id, previous.revision, previous.published));
  }
  await mirrors.put(snapshot, key);
  await history.put(snapshot.routine, key);
  await cloud.put(snapshot.routine, id);
}

export async function acknowledgeRoutineWorkingCopy(id: string, localVersion: number, envelope: CloudRoutine): Promise<void> {
  const session = captureMutationSession();
  const snapshot = checkedWorkingEnvelope(envelope);
  if (snapshot.routine.id !== id || !Number.isSafeInteger(localVersion) || localVersion < 1) throw new Error('routine_conflict');
  await mutate(session, ['routineWorkingCopies', 'cloudRoutineEnvelopes', 'cloudRoutines', 'cloudRoutineHistory', 'meta'], async transaction => {
    const store = transaction.objectStore('routineWorkingCopies');
    const current = await store.get(id);
    if (!current || !current.pendingCloud || localVersion > current.localVersion ||
      await transaction.objectStore('meta').get(deletedKey('routine', id))) throw new Error('routine_conflict');
    const attempt = current.cloudAttempt ?? { envelope: current.envelope, localVersion: current.localVersion, baseRevision: current.cloudBaseRevision };
    if (attempt.localVersion !== localVersion || attempt.baseRevision !== current.cloudBaseRevision ||
      snapshot.routine.revision !== (attempt.baseRevision ?? 0) + 1 ||
      workingContent(checkedWorkingEnvelope(attempt.envelope)) !== workingContent(snapshot)) throw new Error('routine_conflict');
    checkRoutineDowngrade(current.envelope.routine, snapshot.routine);
    await cacheWorkingEnvelope(transaction, snapshot);
    const { cloudAttempt: _attempt, ...retained } = current;
    await putWorkingCopy(store, { ...retained,
      envelope: current.localVersion === localVersion ? snapshot : { ...current.envelope,
        routine: { ...current.envelope.routine, revision: snapshot.routine.revision } },
      cloudBaseRevision: snapshot.routine.revision, pendingCloud: current.localVersion !== localVersion });
  });
}

export async function reconcileRoutineWorkingCopy(envelope: CloudRoutine): Promise<RoutineWorkingCopy | null> {
  const session = captureMutationSession();
  const snapshot = checkedWorkingEnvelope(envelope);
  return mutate(session, ['routineWorkingCopies', 'cloudRoutineEnvelopes', 'cloudRoutines', 'cloudRoutineHistory', 'meta'], async transaction => {
    const store = transaction.objectStore('routineWorkingCopies');
    const id = snapshot.routine.id;
    const current = await store.get(id);
    if (!current || await transaction.objectStore('meta').get(deletedKey('routine', id))) return null;
    if (current.pendingCloud || current.cloudAttempt || snapshot.routine.revision < (current.cloudBaseRevision ?? current.envelope.routine.revision) ||
      snapshot.routine.revision === (current.cloudBaseRevision ?? current.envelope.routine.revision) &&
      workingContent(snapshot) !== workingContent(current.envelope)) throw new Error('routine_conflict');
    checkRoutineDowngrade(current.envelope.routine, snapshot.routine);
    await cacheWorkingEnvelope(transaction, snapshot);
    const refreshed = { ...current, envelope: snapshot, cloudBaseRevision: snapshot.routine.revision,
      savedAt: snapshot.routine.savedAt ?? current.savedAt };
    await putWorkingCopy(store, refreshed);
    return refreshed;
  });
}

export async function deleteRoutineWorkingCopy(id: string, expectedLocalVersion: number): Promise<void> {
  const session = captureMutationSession();
  if (!Number.isSafeInteger(expectedLocalVersion) || expectedLocalVersion < 1) throw new Error('routine_conflict');
  await mutate(session, ['routineWorkingCopies', 'meta'], async transaction => {
    const store = transaction.objectStore('routineWorkingCopies');
    const current = await store.get(id);
    if (!current || current.localVersion !== expectedLocalVersion) throw new Error('routine_conflict');
    await store.delete(id);
    const meta = transaction.objectStore('meta');
    if (await meta.get('active') === id) {
      await meta.delete('active');
      await meta.delete('activeRoutineSelection');
    }
  });
}

export async function clearActiveRoutine(): Promise<void> {
  const session = captureMutationSession();
  await mutate(session, ['meta'], async transaction => {
    await transaction.objectStore('meta').delete('active');
    await transaction.objectStore('meta').delete('activeRoutineSelection');
  });
}

export async function saveRoutine(
  routine: Routine, expectedRevision: number | null, action: 'save' | 'lock' | 'unlock' = 'save',
): Promise<Routine> {
  const session = captureMutationSession();
  const snapshot = structuredClone(routine);
  checkRoutine(snapshot);
  return mutate(session, ['routines', 'routineHistory', 'meta'], async transaction => {
    const routines = transaction.objectStore('routines');
    const previous = await routines.get(snapshot.id);
    checkRoutineDowngrade(previous, snapshot);
    session?.assert();
    const content = (value: Routine) => JSON.stringify({
      ...value, savedAt: undefined, beepOnceRemaining: value.beepOnceRemaining ?? 0, locked: false, published: false, revision: 0,
    });
    let error: string | undefined;
    if (await transaction.objectStore('meta').get(deletedKey('routine', snapshot.id)) ||
      expectedRevision !== (previous?.revision ?? null)) error = 'routine_conflict';
    else if (!['save', 'lock', 'unlock'].includes(action)) error = 'invalid_routine_action';
    else if (snapshot.published && !previous?.published) error = 'routine_published';
    else if (action === 'unlock') {
      if (!previous?.locked || content(previous) !== content(snapshot)) error = 'routine_locked';
    } else if (previous?.locked) error = 'routine_locked';
    else if (action === 'save' && snapshot.locked) error = 'routine_locked';
    if (error) {
      await transaction.done;
      throw new Error(error);
    }
    snapshot.revision = (previous?.revision ?? 0) + 1;
    snapshot.savedAt = Date.now();
    snapshot.locked = action === 'lock';
    snapshot.published = false;
    const history = transaction.objectStore('routineHistory');
    if (previous && !await history.get(revisionKey(previous.id, previous.revision))) await history.put(previous, revisionKey(previous.id, previous.revision));
    await history.put(snapshot, revisionKey(snapshot.id, snapshot.revision));
    await history.put(snapshot, revisionKey(snapshot.id, snapshot.revision, false));
    await routines.put(snapshot, snapshot.id);
    session?.assert();
    await transaction.objectStore('meta').put(snapshot.id, 'active');
    await transaction.objectStore('meta').delete('activeRoutineSelection');
    return snapshot;
  });
}

async function readRoutine(session: MutationSession | undefined, id?: string, revision?: number, published?: boolean): Promise<Routine | null> {
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['routines', 'routineHistory', 'routineWorkingCopies', 'meta']);
    const selected = id ?? await transaction.objectStore('meta').get('active');
    const exact = id === undefined && revision === undefined ? await transaction.objectStore('meta').get('activeRoutineSelection') : undefined;
    if (exact !== undefined) {
      const selection = checkedRoutineSelection(JSON.parse(exact));
      const history = transaction.objectStore('routineHistory');
      const routine = await history.get(revisionKey(selection.id, selection.revision, selection.published)) ??
        await history.get(revisionKey(selection.id, selection.revision)) ??
        (!selection.published ? await transaction.objectStore('routines').get(selection.id) : undefined);
      const hidden = await transaction.objectStore('meta').get(deletedKey('routine', selection.id));
      await transaction.done;
      session?.assert();
      if (routine) checkRoutine(routine);
      return !hidden && selected === selection.id && routine?.id === selection.id && routine.revision === selection.revision &&
        routine.published === selection.published && (published === undefined || published === selection.published) ? routine : null;
    }
    const hidden = selected && revision === undefined && await transaction.objectStore('meta').get(deletedKey('routine', selected));
    const working = id === undefined && selected && revision === undefined && !hidden ?
      await transaction.objectStore('routineWorkingCopies').get(selected) : undefined;
    const current = working?.envelope.routine ?? (selected && !hidden ? await transaction.objectStore('routines').get(selected) : undefined);
    const routine = selected && revision !== undefined ?
      (published !== undefined ? await transaction.objectStore('routineHistory').get(revisionKey(selected, revision, published)) : undefined) ??
      await transaction.objectStore('routineHistory').get(revisionKey(selected, revision)) ??
        (current?.revision === revision ? current : undefined) : current;
    await transaction.done;
    session?.assert();
    if (routine) checkRoutine(routine);
    const value = routine && (revision === undefined || published === false) ? { ...routine, published: false } : routine;
    return value && (published === undefined || value.published === published) ? value : null;
  } finally {
    connection.close();
  }
}

export async function getRoutine(id?: string, revision?: number, published?: boolean): Promise<Routine | null> {
  return readRoutine(captureMutationSession(), id, revision, published);
}

export async function publishRoutine(id: string, expectedRevision: number): Promise<Routine> {
  const session = captureMutationSession();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('routine_conflict');
  const snapshot = await readRoutine(session, id);
  session?.assert();
  if (!snapshot) throw new Error('routine_not_found');
  if (snapshot.revision !== expectedRevision) throw new Error('routine_conflict');
  if (snapshot.locked) throw new Error('routine_locked');
  if (!snapshot.tracks.length) throw new Error('invalid_routine');
  const readiness = await routineReadiness(snapshot, session);
  session?.assert();
  if (!readiness.ready) throw new Error(`missing_audio: ${readiness.missing.join(', ')}`);
  return mutate(session, ['routines', 'routineHistory', 'meta'], async transaction => {
    const routines = transaction.objectStore('routines');
    const previous = await routines.get(id);
    if (await transaction.objectStore('meta').get(deletedKey('routine', id)) ||
      !previous || previous.revision !== expectedRevision) throw new Error('routine_conflict');
    if (previous.locked) throw new Error('routine_locked');
    snapshot.revision = previous.revision + 1;
    snapshot.published = true;
    const history = transaction.objectStore('routineHistory');
    if (!await history.get(revisionKey(id, previous.revision))) await history.put(previous, revisionKey(id, previous.revision));
    await history.put(snapshot, revisionKey(id, snapshot.revision));
    await history.put(snapshot, revisionKey(id, snapshot.revision, true));
    const draft = { ...snapshot, published: false };
    await history.put(draft, revisionKey(id, snapshot.revision, false));
    await routines.put(draft, id);
    return snapshot;
  });
}

export async function listRoutines(): Promise<Routine[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['routines', 'meta']);
    const routines = [];
    for (const routine of await transaction.objectStore('routines').getAll()) {
      if (!await transaction.objectStore('meta').get(deletedKey('routine', routine.id))) routines.push(routine);
    }
    await transaction.done;
    session?.assert();
    routines.forEach(checkRoutine);
    return routines.map(routine => ({ ...routine, published: false }));
  } finally {
    connection.close();
  }
}

export async function listCloudRoutines(): Promise<Routine[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['cloudRoutines', 'cloudRoutineHistory']);
    const routines = [...await transaction.objectStore('cloudRoutines').getAll(),
      ...await transaction.objectStore('cloudRoutineHistory').getAll()];
    await transaction.done;
    session?.assert();
    const latest = new Map<string, Routine>();
    for (const routine of routines) {
      checkRoutine(routine);
      const key = JSON.stringify([routine.id, routine.published]);
      if (routine.revision > (latest.get(key)?.revision ?? 0)) latest.set(key, routine);
    }
    return [...latest.values()];
  } finally { connection.close(); }
}

export async function listRoutinePublications(): Promise<Routine[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['routines', 'routineHistory', 'meta']);
    const latest = new Map<string, Routine>();
    for (const routine of [...await transaction.objectStore('routines').getAll(), ...await transaction.objectStore('routineHistory').getAll()]) {
      checkRoutine(routine);
      if (routine.published && !await transaction.objectStore('meta').get(deletedKey('routine', routine.id)) &&
        routine.revision > (latest.get(routine.id)?.revision ?? 0)) latest.set(routine.id, routine);
    }
    await transaction.done;
    session?.assert();
    return [...latest.values()];
  } finally { connection.close(); }
}

export async function setActiveRoutine(id: string): Promise<void> {
  const session = captureMutationSession();
  await mutate(session, ['routines', 'routineWorkingCopies', 'meta'], async transaction => {
    if (await transaction.objectStore('meta').get(deletedKey('routine', id)) ||
      !await transaction.objectStore('routines').get(id) && !await transaction.objectStore('routineWorkingCopies').get(id)) {
      await transaction.done;
      throw new Error('routine_not_found');
    }
    session?.assert();
    await transaction.objectStore('meta').put(id, 'active');
    await transaction.objectStore('meta').delete('activeRoutineSelection');
  });
}

function checkedRoutineSelection(selection: RevisionReference): RevisionReference {
  if (!selection || typeof selection.id !== 'string' || !selection.id || !Number.isSafeInteger(selection.revision) ||
    selection.revision < 1 || typeof selection.published !== 'boolean') throw new Error('routine_conflict');
  return { id: selection.id, revision: selection.revision, published: selection.published };
}

export async function setActiveRoutineSelection(selection: RevisionReference): Promise<void> {
  const session = captureMutationSession();
  const snapshot = checkedRoutineSelection(selection);
  await mutate(session, ['routines', 'routineHistory', 'meta'], async transaction => {
    const meta = transaction.objectStore('meta');
    const history = transaction.objectStore('routineHistory');
    const routine = await history.get(revisionKey(snapshot.id, snapshot.revision, snapshot.published)) ??
      await history.get(revisionKey(snapshot.id, snapshot.revision)) ??
      (!snapshot.published ? await transaction.objectStore('routines').get(snapshot.id) : undefined);
    if (await meta.get(deletedKey('routine', snapshot.id)) || !routine || routine.id !== snapshot.id ||
      routine.revision !== snapshot.revision || routine.published !== snapshot.published) throw new Error('routine_not_found');
    checkRoutine(routine);
    await meta.put(snapshot.id, 'active');
    await meta.put(JSON.stringify(snapshot), 'activeRoutineSelection');
  });
}

export async function getActiveRoutineSelection(): Promise<RevisionReference | null> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['meta']);
    const meta = transaction.objectStore('meta');
    const stored = await meta.get('activeRoutineSelection');
    const selection = stored === undefined ? null : checkedRoutineSelection(JSON.parse(stored));
    const active = await meta.get('active');
    const hidden = selection && await meta.get(deletedKey('routine', selection.id));
    await transaction.done;
    session?.assert();
    return !hidden && selection?.id === active ? selection : null;
  } finally { connection.close(); }
}

async function deleteLocalEntity(
  kind: 'routine' | 'playlist' | 'class', id: string, expectedRevision: number | null, confirmedWorking?: { localVersion: number },
): Promise<void> {
  const session = captureMutationSession();
  const prefix = kind === 'class' ? 'class_setup' : kind;
  if (!(confirmedWorking && expectedRevision === null) &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision === null || expectedRevision < 1) ||
    confirmedWorking && (!Number.isSafeInteger(confirmedWorking.localVersion) || confirmedWorking.localVersion < 1)) {
    throw new Error(`${prefix}_conflict`);
  }
  const records = kind === 'routine' ? 'routines' : kind === 'playlist' ? 'musicPlaylists' : 'classSetups';
  const historyName = kind === 'routine' ? 'routineHistory' : kind === 'playlist' ? 'musicPlaylistHistory' : 'classSetupHistory';
  await mutate(session, [records, historyName, 'routineWorkingCopies', 'meta'], async transaction => {
    const previous = await transaction.objectStore(records).get(id);
    const meta = transaction.objectStore('meta');
    if (!previous && !confirmedWorking || await meta.get(deletedKey(kind, id))) {
      throw new Error(`${prefix}_${confirmedWorking ? 'conflict' : 'not_found'}`);
    }
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error(`${prefix}_conflict`);
    if (previous?.locked) throw new Error(`${prefix}_locked`);
    if (confirmedWorking && previous?.published) throw new Error('routine_published');
    let deletedRevision = (previous?.revision ?? 0) + 1;
    if (kind === 'routine') {
      const workingStore = transaction.objectStore('routineWorkingCopies');
      const working = await workingStore.get(id);
      if (confirmedWorking) {
        if (!working || working.localVersion !== confirmedWorking.localVersion || working.cloudBaseRevision !== null) {
          throw new Error('routine_conflict');
        }
        if (working.envelope.routine.locked) throw new Error('routine_locked');
        if (working.envelope.routine.published) throw new Error('routine_published');
        deletedRevision = (previous?.revision ?? working.envelope.routine.revision) + 1;
        await workingStore.delete(id);
      } else if (working && previous) {
        if (working.pendingCloud || working.cloudAttempt || working.cloudBaseRevision !== null ||
          working.envelope.routine.revision !== previous.revision ||
          workingContent(working.envelope) !== workingContent({ routine: previous as Routine, media: working.envelope.media })) {
          throw new Error('routine_conflict');
        }
        await workingStore.delete(id);
      }
    }
    const history = transaction.objectStore(historyName);
    if (previous && !await history.get(revisionKey(id, previous.revision))) await history.put(previous, revisionKey(id, previous.revision));
    if (previous && !await history.get(revisionKey(id, previous.revision, previous.published))) {
      await history.put(previous, revisionKey(id, previous.revision, previous.published));
    }
    await meta.put(String(deletedRevision), deletedKey(kind, id));
    if (kind === 'routine' && await meta.get('active') === id) {
      await meta.delete('active');
      await meta.delete('activeRoutineSelection');
    }
  });
}

export function deleteRoutine(id: string, expectedRevision: number): Promise<void> {
  return deleteLocalEntity('routine', id, expectedRevision);
}

export function deleteRoutineAndWorkingCopy(
  id: string, expectedRoutineRevision: number | null, expectedLocalVersion: number,
): Promise<void> {
  return deleteLocalEntity('routine', id, expectedRoutineRevision, { localVersion: expectedLocalVersion });
}

export async function cacheCloudRoutine(routine: Routine): Promise<void> {
  const session = captureMutationSession();
  const snapshot = structuredClone(routine);
  checkRoutine(snapshot);
  const readiness = await getReadiness(snapshot);
  session?.assert();
  if (readiness.missing.length) throw new Error(`missing_audio: ${readiness.missing.join(', ')}`);
  await mutate(session, ['cloudRoutines', 'cloudRoutineHistory'], async transaction => {
    const history = transaction.objectStore('cloudRoutineHistory');
    const key = revisionKey(snapshot.id, snapshot.revision, snapshot.published);
    const existing = await history.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error('routine_conflict');
    const previous = await transaction.objectStore('cloudRoutines').get(snapshot.id);
    if (previous && !await history.get(revisionKey(previous.id, previous.revision, previous.published))) {
      await history.put(previous, revisionKey(previous.id, previous.revision, previous.published));
    }
    await history.put(snapshot, key);
    if (previous && previous.revision > snapshot.revision) return;
    await transaction.objectStore('cloudRoutines').put(snapshot, snapshot.id);
  });
}

export async function getCloudRoutine(id: string, revision?: number, published?: boolean): Promise<Routine | null> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const current = await connection.get('cloudRoutines', id);
    const routine = revision === undefined ? current :
      await connection.get('cloudRoutineHistory', revisionKey(id, revision, published ?? true)) ??
      (published === undefined ? await connection.get('cloudRoutineHistory', revisionKey(id, revision, false)) : undefined) ??
      await connection.get('cloudRoutineHistory', revisionKey(id, revision)) ?? (current?.revision === revision ? current : undefined);
    session?.assert();
    if (routine) checkRoutine(routine);
    return routine && (published === undefined || routine.published === published) ? routine : null;
  } finally {
    connection.close();
  }
}

type ClassAction = 'save' | 'lock' | 'unlock' | 'publish';
type VersionedClassEntity = MusicPlaylist | ClassSetup;
const classStores = ['musicPlaylists', 'musicPlaylistHistory', 'classSetups', 'classSetupHistory',
  'routines', 'routineHistory', 'cloudRoutines', 'cloudRoutineHistory', 'cloudMusicPlaylists', 'cloudClassSetups', 'meta'] as const;
type ClassTransaction = IDBPTransaction<RehearsalDatabase, Array<typeof classStores[number]>, 'readonly' | 'readwrite'>;

function entityContent(value: VersionedClassEntity): string {
  return JSON.stringify({ ...value, revision: 0, locked: false, published: false });
}

async function exactReference(transaction: ClassTransaction, kind: 'routine' | 'playlist', reference: RevisionReference, cloud = false) {
  const key = revisionKey(reference.id, reference.revision);
  let value: Routine | MusicPlaylist | undefined;
  if (kind === 'routine') {
    const history = transaction.objectStore(cloud ? 'cloudRoutineHistory' : 'routineHistory');
    value = await history.get(revisionKey(reference.id, reference.revision, reference.published)) ?? await history.get(key);
    if (!value) value = await transaction.objectStore(cloud ? 'cloudRoutines' : 'routines').get(reference.id);
    if (!cloud && value?.published && !reference.published) value = { ...value, published: false };
  } else if (cloud) {
    value = (await transaction.objectStore('cloudMusicPlaylists').get(revisionKey(reference.id, reference.revision, reference.published)))?.playlist;
  } else {
    value = await transaction.objectStore('musicPlaylistHistory').get(revisionKey(reference.id, reference.revision, reference.published)) ??
      await transaction.objectStore('musicPlaylistHistory').get(key) ??
      await transaction.objectStore('musicPlaylists').get(reference.id);
  }
  if (!value || value.revision !== reference.revision || value.published !== reference.published) throw new Error('class_reference_unavailable');
  return value;
}

async function saveClassEntity<Value extends VersionedClassEntity>(kind: 'playlist' | 'class', value: Value,
  expectedRevision: number | null, action: ClassAction): Promise<Value> {
  const session = captureMutationSession();
  const snapshot = (kind === 'playlist' ? checkedMusicPlaylist(value as MusicPlaylist) : checkedClassSetup(value as ClassSetup)) as Value;
  return mutate(session, [...classStores], async transaction => {
    const records = transaction.objectStore(kind === 'playlist' ? 'musicPlaylists' : 'classSetups');
    const history = transaction.objectStore(kind === 'playlist' ? 'musicPlaylistHistory' : 'classSetupHistory');
    const previous = await records.get(snapshot.id);
    const prefix = kind === 'playlist' ? 'playlist' : 'class_setup';
    if (await transaction.objectStore('meta').get(deletedKey(kind, snapshot.id)) ||
      expectedRevision !== (previous?.revision ?? null)) throw new Error(`${prefix}_conflict`);
    if (!['save', 'lock', 'unlock', 'publish'].includes(action)) throw new Error(`invalid_${prefix}_action`);
    if (snapshot.published !== (previous?.published ?? false)) throw new Error(`${prefix}_published`);
    if (action === 'unlock') {
      if (!previous?.locked || entityContent(previous) !== entityContent(snapshot)) throw new Error(`${prefix}_locked`);
    } else if (previous?.locked || action === 'save' && snapshot.locked) throw new Error(`${prefix}_locked`);
    if (action === 'publish' && (!previous || entityContent(previous) !== entityContent(snapshot))) throw new Error(`${prefix}_conflict`);
    if (kind === 'class') {
      const setup = snapshot as ClassSetup;
      for (const [reference, referenceKind] of [[setup.routine, 'routine'], [setup.walkIn, 'playlist'], [setup.walkOut, 'playlist']] as const) {
        if (!reference) continue;
        if (action === 'publish' && !reference.published) throw new Error('class_reference_unpublished');
        await exactReference(transaction, referenceKind, reference);
      }
    }
    snapshot.revision = (previous?.revision ?? 0) + 1;
    snapshot.locked = action === 'lock';
    snapshot.published = action === 'publish';
    if (previous && !await history.get(revisionKey(previous.id, previous.revision))) await history.put(previous, revisionKey(previous.id, previous.revision));
    await history.put(snapshot, revisionKey(snapshot.id, snapshot.revision));
    await history.put(snapshot, revisionKey(snapshot.id, snapshot.revision, snapshot.published));
    if (action === 'publish') await history.put({ ...snapshot, published: false }, revisionKey(snapshot.id, snapshot.revision, false));
    await records.put({ ...snapshot, published: false }, snapshot.id);
    return snapshot;
  });
}

export function saveMusicPlaylist(value: MusicPlaylist, expectedRevision: number | null, action: ClassAction = 'save'): Promise<MusicPlaylist> {
  return saveClassEntity('playlist', value, expectedRevision, action);
}

export function saveClassSetup(value: ClassSetup, expectedRevision: number | null, action: ClassAction = 'save'): Promise<ClassSetup> {
  return saveClassEntity('class', value, expectedRevision, action);
}

export function deleteMusicPlaylist(id: string, expectedRevision: number): Promise<void> {
  return deleteLocalEntity('playlist', id, expectedRevision);
}

export function deleteClassSetup(id: string, expectedRevision: number): Promise<void> {
  return deleteLocalEntity('class', id, expectedRevision);
}

async function readClassEntity(kind: 'playlist' | 'class', id: string, revision?: number): Promise<VersionedClassEntity | null> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction([...classStores]);
    const hidden = revision === undefined && await transaction.objectStore('meta').get(deletedKey(kind, id));
    const current = hidden ? undefined : await transaction.objectStore(kind === 'playlist' ? 'musicPlaylists' : 'classSetups').get(id);
    const value = revision === undefined ? current :
      await transaction.objectStore(kind === 'playlist' ? 'musicPlaylistHistory' : 'classSetupHistory').get(revisionKey(id, revision)) ??
        (current?.revision === revision ? current : undefined);
    await transaction.done;
    session?.assert();
    return value ? kind === 'playlist' ? checkedMusicPlaylist(value as MusicPlaylist) : checkedClassSetup(value as ClassSetup) : null;
  } finally { connection.close(); }
}

export async function getMusicPlaylist(id: string, revision?: number): Promise<MusicPlaylist | null> {
  return await readClassEntity('playlist', id, revision) as MusicPlaylist | null;
}

export async function getClassSetup(id: string, revision?: number): Promise<ClassSetup | null> {
  return await readClassEntity('class', id, revision) as ClassSetup | null;
}

export async function listMusicPlaylists(): Promise<MusicPlaylist[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['musicPlaylists', 'meta']);
    const values = [];
    for (const playlist of await transaction.objectStore('musicPlaylists').getAll()) {
      if (!await transaction.objectStore('meta').get(deletedKey('playlist', playlist.id))) values.push(playlist);
    }
    await transaction.done;
    session?.assert();
    return values.map(checkedMusicPlaylist);
  } finally { connection.close(); }
}

export async function listClassSetups(): Promise<ClassSetup[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['classSetups', 'meta']);
    const values = [];
    for (const setup of await transaction.objectStore('classSetups').getAll()) {
      if (!await transaction.objectStore('meta').get(deletedKey('class', setup.id))) values.push(setup);
    }
    await transaction.done;
    session?.assert();
    return values.map(checkedClassSetup);
  } finally { connection.close(); }
}

export async function listCachedClassSetups(): Promise<ClassSetup[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction(['cloudClassSetups']);
    const values = await transaction.objectStore('cloudClassSetups').getAll();
    await transaction.done;
    session?.assert();
    const heads = new Map<string, ClassSetup>();
    for (const value of values) {
      const setup = checkedClassSetup(value);
      const key = JSON.stringify([setup.id, setup.published]);
      if (setup.revision > (heads.get(key)?.revision ?? 0)) heads.set(key, setup);
    }
    return [...heads.values()];
  } finally { connection.close(); }
}

function checkedCloudPlaylist(value: CloudMusicPlaylist): CloudMusicPlaylist {
  try {
    if (!value || Object.keys(value).some(key => !['playlist', 'media'].includes(key))) throw new Error('invalid_playlist');
    const playlist = checkedMusicPlaylist(value.playlist);
    const media = structuredClone(value.media);
    if (!media || typeof media !== 'object' || Array.isArray(media) || Object.keys(media).length !== playlist.tracks.length) throw new Error('invalid_media');
    for (const track of playlist.tracks) {
      const asset = media[track.id];
      if (!asset || Object.keys(asset).some(key => !['id', 'sha256', 'bytes', 'contentType'].includes(key)) ||
        !validFillerRecording({ id: 'descriptor', name: 'Descriptor', duration: Math.min(track.duration, 360), asset })) throw new Error('invalid_media');
    }
    return { playlist, media };
  } catch { throw new Error('invalid_cloud_playlist'); }
}

export async function cacheMusicPlaylist(value: CloudMusicPlaylist): Promise<void> {
  const session = captureMutationSession();
  const snapshot = checkedCloudPlaylist(value);
  await mutate(session, ['cloudMusicPlaylists'], async transaction => {
    const store = transaction.objectStore('cloudMusicPlaylists');
    const key = revisionKey(snapshot.playlist.id, snapshot.playlist.revision, snapshot.playlist.published);
    const previous = await store.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) throw new Error('playlist_conflict');
    await store.put(snapshot, key);
  });
}

export async function cacheClassSetup(value: ClassSetup): Promise<void> {
  const session = captureMutationSession();
  const snapshot = checkedClassSetup(value);
  await mutate(session, ['cloudClassSetups'], async transaction => {
    const store = transaction.objectStore('cloudClassSetups');
    const key = revisionKey(snapshot.id, snapshot.revision, snapshot.published);
    const previous = await store.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) throw new Error('class_setup_conflict');
    await store.put(snapshot, key);
  });
}

export async function getCachedMusicPlaylist(id: string, revision?: number, published?: boolean): Promise<CloudMusicPlaylist | null> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const value = revision === undefined ? (await connection.getAll('cloudMusicPlaylists')).filter(item => item.playlist.id === id &&
      (published === undefined || item.playlist.published === published))
      .sort((first, second) => second.playlist.revision - first.playlist.revision)[0] :
      await connection.get('cloudMusicPlaylists', revisionKey(id, revision, published ?? true)) ??
      (published === undefined ? await connection.get('cloudMusicPlaylists', revisionKey(id, revision, false)) : undefined);
    session?.assert();
    return value ? checkedCloudPlaylist(value) : null;
  } finally { connection.close(); }
}

export async function getCachedClassSetup(id: string, revision?: number, published?: boolean): Promise<ClassSetup | null> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const value = revision === undefined ? (await connection.getAll('cloudClassSetups')).filter(item => item.id === id &&
      (published === undefined || item.published === published))
      .sort((first, second) => second.revision - first.revision)[0] :
      await connection.get('cloudClassSetups', revisionKey(id, revision, published ?? true)) ??
      (published === undefined ? await connection.get('cloudClassSetups', revisionKey(id, revision, false)) : undefined);
    session?.assert();
    return value ? checkedClassSetup(value) : null;
  } finally { connection.close(); }
}

export async function getPreparedClass(id: string, revision?: number, source: 'local' | 'cloud' = 'local', published?: boolean): Promise<PreparedClass | null> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const transaction = connection.transaction([...classStores]);
    const cloud = source === 'cloud';
    const hidden = !cloud && revision === undefined && await transaction.objectStore('meta').get(deletedKey('class', id));
    const current = cloud ? (await transaction.objectStore('cloudClassSetups').getAll()).filter(value => value.id === id &&
      (published === undefined || value.published === published))
      .sort((first, second) => second.revision - first.revision)[0] : hidden ? undefined : await transaction.objectStore('classSetups').get(id);
    const history = transaction.objectStore(cloud ? 'cloudClassSetups' : 'classSetupHistory');
    const value = revision === undefined ? current :
      await history.get(revisionKey(id, revision, published ?? true)) ??
      (published === undefined ? await history.get(revisionKey(id, revision, false)) : undefined) ??
      (!cloud ? await history.get(revisionKey(id, revision)) : undefined) ?? (current?.revision === revision ? current : undefined);
    if (!value) { await transaction.done; session?.assert(); return null; }
    if (published !== undefined && value.published !== published) { await transaction.done; session?.assert(); return null; }
    const setup = checkedClassSetup(value);
    const routine = await exactReference(transaction, 'routine', setup.routine, cloud) as Routine;
    checkRoutine(routine);
    const audio: ClassAudio = { crossfade: setup.crossfade, before: setup.before, after: setup.after };
    for (const name of ['walkIn', 'walkOut'] as const) {
      if (setup[name]) audio[name] = checkedMusicPlaylist(await exactReference(transaction, 'playlist', setup[name], cloud) as MusicPlaylist);
    }
    await transaction.done;
    session?.assert();
    return structuredClone({ setup, routine, audio });
  } finally { connection.close(); }
}

async function verifiedTrack(id: string, session = captureMutationSession()): Promise<StoredTrack | undefined> {
  const connection = await database(session);
  let record: StoredTrack | undefined;
  try {
    record = await connection.get('tracks', id);
  } finally {
    connection.close();
  }
  session?.assert();
  if (!record || !(record.blob instanceof Blob) || record.bytes !== record.blob.size ||
    record.bytes <= 0 || record.bytes > MAX_CLOUD_TRACK_BYTES || !Number.isFinite(record.duration) ||
    record.duration <= 0 || record.duration > MAX_TRACK_SECONDS) return undefined;
  const sha256 = record.sha256 ? await digest(record.blob) : undefined;
  session?.assert();
  if (record.sha256 && sha256 !== record.sha256) return undefined;
  return record;
}

export async function getTrackBlob(id: string): Promise<Blob | undefined> {
  return (await verifiedTrack(id))?.blob;
}

function fillerSnapshot(recording: FillerRecording): FillerRecording {
  if (!validFillerRecording(recording)) throw new Error('invalid_filler_recording');
  return structuredClone(recording);
}

async function verifiedFiller(
  recording: FillerRecording, session: MutationSession | undefined,
): Promise<Blob | undefined> {
  const record = await verifiedTrack(`filler-${recording.asset.id}`, session);
  session?.assert();
  if (!record || record.sha256 !== recording.asset.sha256 || record.bytes !== recording.asset.bytes ||
    record.blob.type !== recording.asset.contentType || Math.abs(record.duration - recording.duration) > 0.1) return undefined;
  return record.blob;
}

export async function getFillerRecordingBlob(recording: FillerRecording): Promise<Blob | undefined> {
  const session = captureMutationSession();
  return verifiedFiller(fillerSnapshot(recording), session);
}

export async function listFillerRecordings(): Promise<FillerRecording[]> {
  const session = captureMutationSession();
  const connection = await database(session);
  try {
    const recordings = await connection.getAll('fillerRecordings');
    session?.assert();
    return recordings.map(fillerSnapshot);
  } finally {
    connection.close();
  }
}

export async function removeFillerRecording(id: string): Promise<void> {
  const session = captureMutationSession();
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) throw new Error('invalid_filler_recording');
  await mutate(session, ['fillerRecordings'], async transaction => {
    await transaction.objectStore('fillerRecordings').delete(id);
  });
}

export async function removeTrack(id: string): Promise<void> {
  const session = captureMutationSession();
  await mutate(session, ['tracks', 'fillerRecordings', 'routineWorkingCopies', 'draftRecovery', ...classStores], async transaction => {
    const routines = await transaction.objectStore('routines').getAll();
    const cloudRoutines = await transaction.objectStore('cloudRoutines').getAll();
    const historicalRoutines = await transaction.objectStore('routineHistory').getAll();
    const historicalCloudRoutines = await transaction.objectStore('cloudRoutineHistory').getAll();
    const playlists = [...await transaction.objectStore('musicPlaylists').getAll(),
      ...await transaction.objectStore('musicPlaylistHistory').getAll(),
      ...(await transaction.objectStore('cloudMusicPlaylists').getAll()).map(value => value.playlist)];
    const setups = [...await transaction.objectStore('classSetups').getAll(),
      ...await transaction.objectStore('classSetupHistory').getAll(), ...await transaction.objectStore('cloudClassSetups').getAll()];
    const recordings = await transaction.objectStore('fillerRecordings').getAll();
    const working = (await transaction.objectStore('routineWorkingCopies').getAll()).map(value => value.envelope.routine);
    const recoveries = await transaction.objectStore('draftRecovery').getAll();
    for (const recovery of recoveries) {
      if (recovery.kind === 'routine') working.push(recovery.value as Routine);
      else if (recovery.kind === 'playlist') playlists.push(recovery.value as MusicPlaylist);
      else setups.push(recovery.value as ClassSetup);
    }
    session?.assert();
    const fillerReferences = (filler?: Filler) => filler?.sound === 'recording' && `filler-${filler.recording?.asset.id}` === id;
    if (recordings.some(recording => `filler-${recording.asset.id}` === id) ||
      [...routines, ...cloudRoutines, ...historicalRoutines, ...historicalCloudRoutines, ...working].some(routine =>
        allRoutineTracks(routine).some(track => track.id === id) || allRoutineFillers(routine).some(fillerReferences)) ||
      playlists.some(playlist => playlist.tracks.some(track => track.id === id)) ||
      setups.some(setup => fillerReferences(setup.before) || fillerReferences(setup.after))) {
      await transaction.done;
      throw new Error('track_referenced');
    }
    await transaction.objectStore('tracks').delete(id);
  });
}

async function routineReadiness(routine: Routine, session: MutationSession | undefined): Promise<{ ready: boolean; missing: string[] }> {
  const snapshot = structuredClone(routine);
  checkRoutine(snapshot);
  const missing: string[] = [];
  for (const track of allRoutineTracks(snapshot)) {
    const record = await verifiedTrack(track.id, session);
    if (!record || Math.abs(record.duration - track.duration) > 0.1) missing.push(track.id);
  }
  for (const filler of allRoutineFillers(snapshot).filter(filler => filler.mode !== 'none' && filler.sound === 'recording')) {
    const recording = fillerSnapshot(filler.recording!);
    if (!await verifiedFiller(recording, session)) missing.push(`filler-${recording.asset.id}`);
  }
  session?.assert();
  return { ready: snapshot.tracks.length > 0 && missing.length === 0, missing };
}

export async function getReadiness(routine: Routine): Promise<{ ready: boolean; missing: string[] }> {
  return routineReadiness(routine, captureMutationSession());
}

export async function getReadinessClass(routine: Routine, value: ClassAudio): Promise<{ ready: boolean; missing: string[] }> {
  const session = captureMutationSession();
  const snapshot = structuredClone(routine);
  const audio = snapshotClassAudio(value);
  const readiness = await getReadiness(snapshot);
  const missing = new Set(readiness.missing);
  for (const playlist of [audio.walkIn, audio.walkOut]) {
    if (!playlist) continue;
    const cached = await getCachedMusicPlaylist(playlist.id, playlist.revision, playlist.published);
    const descriptors = cached && JSON.stringify(cached.playlist) === JSON.stringify(playlist) ? cached.media : undefined;
    for (const track of playlist.tracks) {
      const record = await verifiedTrack(track.id, session);
      const descriptor = descriptors?.[track.id];
      if (!record || Math.abs(record.duration - track.duration) > 0.1 || descriptor &&
        (record.sha256 !== descriptor.sha256 || record.bytes !== descriptor.bytes || record.blob.type !== descriptor.contentType)) missing.add(track.id);
    }
  }
  for (const filler of classFillers(snapshot, audio).filter(filler => filler.mode !== 'none' && filler.sound === 'recording')) {
    const recording = fillerSnapshot(filler.recording!);
    if (!await verifiedFiller(recording, session)) missing.add(`filler-${recording.asset.id}`);
  }
  session?.assert();
  return { ready: readiness.ready && missing.size === 0, missing: [...missing] };
}

const oggCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
  return value >>> 0;
});

function hasSignature(bytes: Uint8Array, offset: number, signature: string): boolean {
  return [...signature].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function oggPage(bytes: Uint8Array, offset: number) {
  if (offset + 27 > bytes.length || !hasSignature(bytes, offset, 'OggS') || bytes[offset + 4] !== 0) {
    throw new Error('invalid_ogg_opus');
  }
  const segments = bytes[offset + 26];
  const body = offset + 27 + segments;
  if (!segments || body > bytes.length) throw new Error('invalid_ogg_opus');
  let end = body;
  for (let index = offset + 27; index < body; index++) end += bytes[index];
  if (end > bytes.length) throw new Error('invalid_ogg_opus');
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, end - offset);
  return { body, end, segments, flags: bytes[offset + 5], view };
}

function oggChecksum(bytes: Uint8Array, offset = 0, end = bytes.length): number {
  let checksum = 0;
  for (let index = offset; index < end; index++) {
    const byte = index >= offset + 22 && index < offset + 26 ? 0 : bytes[index];
    checksum = ((checksum << 8) ^ oggCrcTable[((checksum >>> 24) ^ byte) & 255]) >>> 0;
  }
  return checksum;
}

function validateOggOpus(bytes: Uint8Array): { channels: number; samples: number; gain: number } {
  let offset = 0;
  let sequence = 0;
  let serial = 0;
  let channels = 0;
  let preSkip = 0;
  let gain = 1;
  let packetIndex = 0;
  let packetBytes = 0;
  let packetParts: Uint8Array[] = [];
  let totalSamples = 0;
  let lastPacketSamples = 0;
  let previousGranule = 0;
  let ended = false;
  while (offset < bytes.length) {
    const page = oggPage(bytes, offset);
    if (ended || (page.flags & ~7) || page.view.getUint32(18, true) !== sequence ||
      Boolean(page.flags & 1) !== (packetBytes > 0)) throw new Error('invalid_ogg_opus');
    if (sequence === 0) {
      serial = page.view.getUint32(14, true);
      if (page.flags !== 2) throw new Error('invalid_ogg_opus');
    } else if ((page.flags & 2) || page.view.getUint32(14, true) !== serial) {
      throw new Error('invalid_ogg_opus');
    }
    if (oggChecksum(bytes, offset, page.end) !== page.view.getUint32(22, true)) throw new Error('invalid_ogg_opus');
    let bodyOffset = page.body;
    let completedAudio = false;
    for (let segment = 0; segment < page.segments; segment++) {
      const size = bytes[offset + 27 + segment];
      packetBytes += size;
      if (packetIndex === 1 && packetBytes > MAX_TRACK_BYTES) throw new Error('audio_byte_limit');
      if (packetIndex !== 1 && packetBytes > 65536) throw new Error('invalid_ogg_opus');
      packetParts.push(bytes.subarray(bodyOffset, bodyOffset + size));
      bodyOffset += size;
      if (size === 255) continue;
      const packet = new Uint8Array(packetBytes);
      let destination = 0;
      for (const part of packetParts) { packet.set(part, destination); destination += part.length; }
      if (packetIndex === 0) {
        if (sequence !== 0 || page.segments !== 1 || packet.length !== 19 ||
          !hasSignature(packet, 0, 'OpusHead') || packet[8] !== 1 || packet[18] !== 0) {
          throw new Error('invalid_ogg_opus');
        }
        channels = packet[9];
        if (channels < 1 || channels > 2) throw new Error('audio_memory_limit');
        preSkip = new DataView(packet.buffer).getUint16(10, true);
        gain = 10 ** (new DataView(packet.buffer).getInt16(16, true) / (256 * 20));
      } else if (packetIndex === 1) {
        if (!hasSignature(packet, 0, 'OpusTags') || packet.length < 16) throw new Error('invalid_ogg_opus');
        const tags = new DataView(packet.buffer);
        let cursor = 12 + tags.getUint32(8, true);
        if (cursor + 4 > packet.length) throw new Error('invalid_ogg_opus');
        const comments = tags.getUint32(cursor, true);
        cursor += 4;
        if (comments > (packet.length - cursor) / 4) throw new Error('invalid_ogg_opus');
        for (let comment = 0; comment < comments; comment++) {
          if (cursor + 4 > packet.length) throw new Error('invalid_ogg_opus');
          cursor += 4 + tags.getUint32(cursor, true);
          if (cursor > packet.length) throw new Error('invalid_ogg_opus');
        }
      } else {
        if (!packet.length) throw new Error('invalid_ogg_opus');
        const config = packet[0] >>> 3;
        const frameSamples = config >= 16 ? 120 << (config & 3) :
          config >= 12 ? 480 << (config & 1) : [480, 960, 1920, 2880][config & 3];
        const code = packet[0] & 3;
        const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 63 : 2;
        lastPacketSamples = frameSamples * frames;
        if (!frames || lastPacketSamples > 5760) throw new Error('invalid_ogg_opus');
        totalSamples += lastPacketSamples;
        if (totalSamples > MAX_TRACK_SECONDS * 48000 + preSkip + 5760) throw new Error('audio_duration_limit');
        completedAudio = true;
      }
      packetIndex++;
      packetBytes = 0;
      packetParts = [];
    }
    const granule = page.view.getBigUint64(6, true);
    ended = Boolean(page.flags & 4);
    if (completedAudio || ended) {
      if (granule > BigInt(MAX_TRACK_SECONDS * 48000 + preSkip)) throw new Error('audio_duration_limit');
      const samples = Number(granule);
      if (samples < previousGranule || samples > totalSamples ||
        (!ended && samples !== totalSamples) || (ended && samples <= totalSamples - lastPacketSamples)) {
        throw new Error('invalid_ogg_opus');
      }
      previousGranule = samples;
    } else if (granule !== (packetBytes ? 0xffffffffffffffffn : 0n)) throw new Error('invalid_ogg_opus');
    offset = page.end;
    sequence++;
  }
  const samples = previousGranule - preSkip;
  if (!ended || packetBytes || packetIndex < 3 || samples <= 0) throw new Error('invalid_ogg_opus');
  return { channels, samples, gain };
}

function probeDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    if (typeof Audio === 'undefined') throw new Error('unsupported_audio: native metadata unavailable');
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      clearTimeout(timeout);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.onencrypted = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('audio_metadata_timeout'));
    }, 15000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_TRACK_SECONDS) {
        reject(new Error('audio_duration_limit'));
      } else resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('unsupported_audio: native metadata failed'));
    };
    audio.onencrypted = () => {
      cleanup();
      reject(new Error('protected_audio'));
    };
    audio.src = url;
  });
}

const CONVERTED_DURATION_EPSILON = (1024 + 1) / AAC_IMPORT.sampleRate;
const NATIVE_DECODE_TIMEOUT_MS = 30_000;
let nativeDecodePending = false;

interface ContainerAudio {
  contentType: string;
  channels: number;
  sampleRate?: number;
  opus: boolean;
  aacLc: boolean;
}

function inspectMp4(bytes: Uint8Array): ContainerAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const boxes = (start: number, end: number) => {
    const result: { kind: string; start: number; end: number }[] = [];
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) throw new Error('invalid_audio_container');
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) throw new Error('invalid_audio_container');
        const extended = view.getBigUint64(offset + 8);
        if (extended > BigInt(end - offset)) throw new Error('invalid_audio_container');
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || size > end - offset) throw new Error('invalid_audio_container');
      const kind = text(offset + 4, 4);
      if (['pssh', 'sinf', 'senc', 'enca', 'encv'].includes(kind)) throw new Error('protected_audio');
      result.push({ kind, start: offset + header, end: offset + size });
      if (result.length > 100_000) throw new Error('invalid_audio_container');
      offset += size;
    }
    return result;
  };
  const roots = boxes(0, bytes.length);
  const types = roots.filter(box => box.kind === 'ftyp');
  const fileType = types[0];
  const movie = roots.find(box => box.kind === 'moov');
  if (types.length !== 1 || !fileType || fileType.end - fileType.start < 8 ||
    (fileType.end - fileType.start) % 4 !== 0 || !movie || !roots.some(box => box.kind === 'mdat' && box.end > box.start)) {
    throw new Error('invalid_audio_container');
  }
  const inspectProtection = (start: number, end: number, depth = 0): void => {
    if (depth > 8) throw new Error('invalid_audio_container');
    for (const box of boxes(start, end)) {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf'].includes(box.kind)) {
        inspectProtection(box.start, box.end, depth + 1);
      }
    }
  };
  inspectProtection(0, bytes.length);
  const audio: ContainerAudio[] = [];
  for (const track of boxes(movie.start, movie.end).filter(box => box.kind === 'trak')) {
    const media = boxes(track.start, track.end).find(box => box.kind === 'mdia');
    if (!media) throw new Error('invalid_audio_container');
    const children = boxes(media.start, media.end);
    const handler = children.find(box => box.kind === 'hdlr');
    if (!handler || handler.end - handler.start < 12) throw new Error('invalid_audio_container');
    const kind = text(handler.start + 8, 4);
    if (kind === 'vide') throw new Error('audio_video_not_allowed');
    if (kind !== 'soun') continue;
    const info = children.find(box => box.kind === 'minf');
    const table = info && boxes(info.start, info.end).find(box => box.kind === 'stbl');
    const description = table && boxes(table.start, table.end).find(box => box.kind === 'stsd');
    if (!description || description.end - description.start < 8 || view.getUint32(description.start + 4) !== 1) {
      throw new Error('invalid_audio_container');
    }
    const entries = boxes(description.start + 8, description.end);
    const entry = entries[0];
    if (entries.length !== 1 || entry.end - entry.start < 28) throw new Error('invalid_audio_container');
    const version = view.getUint16(entry.start + 8);
    const headerSize = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : 0;
    if (!headerSize || entry.start + headerSize > entry.end) throw new Error('invalid_audio_container');
    const extensions = boxes(entry.start + headerSize, entry.end);
    let channels = view.getUint16(entry.start + 16);
    let sampleRate = view.getUint32(entry.start + 24) >>> 16;
    let aacLc = false;
    const descriptors = extensions.find(box => box.kind === 'esds');
    const readDescriptors = (start: number, end: number, depth = 0): void => {
      if (depth > 3) throw new Error('invalid_audio_container');
      for (let offset = start; offset < end;) {
        const tag = bytes[offset++];
        let size = 0;
        let count = 0;
        let next: number;
        do {
          if (offset >= end || ++count > 4) throw new Error('invalid_audio_container');
          next = bytes[offset++];
          size = size * 128 + (next & 127);
        } while (next & 128);
        const limit = offset + size;
        if (limit > end) throw new Error('invalid_audio_container');
        if (tag === 3) {
          if (size < 3) throw new Error('invalid_audio_container');
          const flags = bytes[offset + 2];
          let child = offset + 3 + ((flags & 128) ? 2 : 0);
          if (flags & 64) child += 1 + (bytes[child] ?? end);
          if (flags & 32) child += 2;
          if (child > limit) throw new Error('invalid_audio_container');
          readDescriptors(child, limit, depth + 1);
        } else if (tag === 4) {
          if (size < 13) throw new Error('invalid_audio_container');
          readDescriptors(offset + 13, limit, depth + 1);
        } else if (tag === 5 && entry.kind === 'mp4a') {
          if (size < 2) throw new Error('invalid_audio_container');
          const config = view.getUint16(offset);
          const frequency = (config >>> 7) & 15;
          const configuration = (config >>> 3) & 15;
          if (configuration) channels = configuration === 7 ? 8 : configuration;
          aacLc = (config >>> 11) === 2;
          sampleRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][frequency] ?? 0;
        }
        offset = limit;
      }
    };
    if (descriptors) {
      if (descriptors.end - descriptors.start < 4) throw new Error('invalid_audio_container');
      readDescriptors(descriptors.start + 4, descriptors.end);
    }
    const opus = extensions.find(box => box.kind === 'dOps');
    if (opus) {
      if (opus.end - opus.start < 11) throw new Error('invalid_audio_container');
      channels = bytes[opus.start + 1];
    }
    if (channels < 1 || channels > AAC_IMPORT.maxChannels) throw new Error('audio_memory_limit');
    audio.push({ contentType: 'audio/mp4', channels, sampleRate, opus: entry.kind === 'Opus', aacLc });
  }
  if (audio.length !== 1) throw new Error('invalid_audio_container');
  return audio[0];
}

function inspectWebm(bytes: Uint8Array): ContainerAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const elements = (start: number, end: number) => {
    const result: { id: number; start: number; end: number }[] = [];
    for (let offset = start; offset < end;) {
      const integer = (identifier: boolean) => {
        if (offset >= end || !bytes[offset]) throw new Error('invalid_audio_container');
        let mask = 128;
        let length = 1;
        while (!(bytes[offset] & mask)) { mask >>>= 1; length++; }
        if (length > (identifier ? 4 : 8) || offset + length > end) throw new Error('invalid_audio_container');
        let value = identifier ? bytes[offset] : bytes[offset] & (mask - 1);
        let unknown = !identifier && value === mask - 1;
        for (let index = 1; index < length; index++) {
          value = value * 256 + bytes[offset + index];
          unknown = unknown && bytes[offset + index] === 255;
        }
        offset += length;
        if (!unknown && !Number.isSafeInteger(value)) throw new Error('invalid_audio_container');
        return unknown ? -1 : value;
      };
      const id = integer(true);
      const size = integer(false);
      if (size === -1 && id !== 0x18538067) throw new Error('invalid_audio_container');
      const limit = size === -1 ? end : offset + size;
      if (limit > end) throw new Error('invalid_audio_container');
      result.push({ id, start: offset, end: limit });
      if (result.length > 100_000) throw new Error('invalid_audio_container');
      offset = limit;
    }
    return result;
  };
  const unsigned = (start: number, end: number) => {
    if (end <= start || end - start > 4) throw new Error('invalid_audio_container');
    let value = 0;
    for (let offset = start; offset < end; offset++) value = value * 256 + bytes[offset];
    return value;
  };
  const roots = elements(0, bytes.length);
  const segment = roots.find(element => element.id === 0x18538067);
  if (roots[0]?.id !== 0x1a45dfa3 || !segment) throw new Error('invalid_audio_container');
  const tracks = elements(segment.start, segment.end).find(element => element.id === 0x1654ae6b);
  if (!tracks) throw new Error('invalid_audio_container');
  const audio: ContainerAudio[] = [];
  for (const entry of elements(tracks.start, tracks.end).filter(element => element.id === 0xae)) {
    const children = elements(entry.start, entry.end);
    const kind = children.find(element => element.id === 0x83);
    if (!kind) throw new Error('invalid_audio_container');
    const type = unsigned(kind.start, kind.end);
    if (type === 1) throw new Error('audio_video_not_allowed');
    const encodings = children.find(element => element.id === 0x6d80);
    if (encodings) {
      for (const encoding of elements(encodings.start, encodings.end)) {
        if (encoding.id !== 0x6240) throw new Error('invalid_audio_container');
        for (const detail of elements(encoding.start, encoding.end)) {
          if (detail.id === 0x5035 || (detail.id === 0x5033 && unsigned(detail.start, detail.end) === 1)) {
            throw new Error('protected_audio');
          }
        }
      }
    }
    if (type !== 2) continue;
    const codec = children.find(element => element.id === 0x86);
    const settings = children.find(element => element.id === 0xe1);
    if (!codec || !settings || codec.end - codec.start > 128) throw new Error('invalid_audio_container');
    const fields = elements(settings.start, settings.end);
    const channelField = fields.find(element => element.id === 0x9f);
    const channels = channelField ? unsigned(channelField.start, channelField.end) : 1;
    if (channels < 1 || channels > AAC_IMPORT.maxChannels) throw new Error('audio_memory_limit');
    const rate = fields.find(element => element.id === 0xb5);
    if (rate && ![4, 8].includes(rate.end - rate.start)) throw new Error('invalid_audio_container');
    const sampleRate = rate ? (rate.end - rate.start === 4 ? view.getFloat32(rate.start) : view.getFloat64(rate.start)) : undefined;
    const name = String.fromCharCode(...bytes.subarray(codec.start, codec.end));
    audio.push({ contentType: 'audio/webm', channels, sampleRate, opus: name === 'A_OPUS', aacLc: false });
  }
  if (audio.length !== 1) throw new Error('invalid_audio_container');
  return audio[0];
}

function canonicalAudioType(file: File, header: Uint8Array, container?: ContainerAudio): string {
  if (container) return container.contentType;
  if (hasSignature(header, 0, 'RIFF') && hasSignature(header, 8, 'WAVE')) return 'audio/wav';
  if (hasSignature(header, 0, 'OggS')) return 'audio/ogg';
  if (hasSignature(header, 0, 'fLaC')) return 'audio/flac';
  if (hasSignature(header, 0, 'ID3') || (header[0] === 255 && (header[1] & 0xe0) === 0xe0 && (header[1] & 6))) return 'audio/mpeg';
  const type = file.type.toLowerCase().split(';')[0].trim();
  const aliases: Record<string, string> = {
    'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/wave': 'audio/wav',
    'audio/x-wav': 'audio/wav', 'audio/x-flac': 'audio/flac', 'application/ogg': 'audio/ogg',
  };
  const extensions: Record<string, string> = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
  };
  return aliases[type] ?? ((!type || type === 'application/octet-stream') ?
    extensions[file.name.split('.').at(-1)!.toLowerCase()] ?? type : type);
}

async function decodeNative(
  file: File, session: MutationSession | undefined, expectedDuration?: number, onMetadata?: (duration: number) => void,
  expectedChannels?: number,
): Promise<number> {
  const metadataDuration = await probeDuration(file);
  session?.assert();
  onMetadata?.(metadataDuration);
  if (expectedDuration !== undefined && Math.abs(metadataDuration - expectedDuration) > CONVERTED_DURATION_EPSILON) {
    throw new Error('audio_duration_mismatch');
  }
  const bytes = await file.arrayBuffer();
  session?.assert();
  let decoded: AudioBuffer;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const context = new OfflineAudioContext(2, 1, 44100);
    const native = context.decodeAudioData(bytes);
    nativeDecodePending = true;
    const settled = native.then(value => {
      nativeDecodePending = false;
      return value;
    }, error => {
      nativeDecodePending = false;
      throw error;
    });
    decoded = await Promise.race([settled, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('audio_decode_timeout')), NATIVE_DECODE_TIMEOUT_MS);
    })]);
  } catch (error) {
    session?.assert();
    if (error instanceof Error && error.message === 'audio_decode_timeout') throw error;
    if (error instanceof Error && /drm|encrypt|protect/i.test(error.message)) throw new Error('protected_audio');
    throw new Error('unsupported_audio: native decoding failed');
  } finally {
    clearTimeout(timeout);
  }
  session?.assert();
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > MAX_TRACK_SECONDS) {
    throw new Error('audio_duration_limit');
  }
  if (!Number.isSafeInteger(decoded.length) || decoded.length <= 0 ||
    !Number.isInteger(decoded.numberOfChannels) || decoded.numberOfChannels < 1 || decoded.numberOfChannels > AAC_IMPORT.maxChannels ||
    decoded.length * decoded.numberOfChannels * 4 > MAX_DECODED_BYTES) throw new Error('audio_memory_limit');
  if (expectedDuration !== undefined && Math.abs(decoded.duration - expectedDuration) > CONVERTED_DURATION_EPSILON) {
    throw new Error('audio_duration_mismatch');
  }
  if (expectedChannels !== undefined && decoded.numberOfChannels !== expectedChannels) throw new Error('audio_channel_mismatch');
  return decoded.duration;
}

async function validateM4aBlob(blob: Blob): Promise<ContainerAudio> {
  if (!(blob instanceof Blob) || blob.type !== AAC_IMPORT.contentType) throw new Error('invalid_converted_audio');
  if (!blob.size || blob.size > AAC_IMPORT.maxOutputBytes) throw new Error('audio_byte_limit');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let offset = 0;
  let movie = false;
  let media = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error('invalid_converted_audio');
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (bytes.length - offset < 16) throw new Error('invalid_converted_audio');
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(bytes.length - offset)) throw new Error('invalid_converted_audio');
      size = Number(extendedSize);
      headerSize = 16;
    }
    if (size < headerSize || size > bytes.length - offset) throw new Error('invalid_converted_audio');
    if (offset === 0 && (!hasSignature(bytes, 4, 'ftyp') || size < headerSize + 8 ||
      !['M4A ', 'isom', 'iso2', 'iso6', 'mp41', 'mp42'].some(brand => hasSignature(bytes, headerSize, brand)))) {
      throw new Error('invalid_converted_audio');
    }
    if (hasSignature(bytes, offset + 4, 'moov') && size > headerSize) movie = true;
    if (hasSignature(bytes, offset + 4, 'mdat') && size > headerSize) media = true;
    offset += size;
  }
  if (!movie || !media) throw new Error('invalid_converted_audio');
  const container = inspectMp4(bytes);
  if (!container.aacLc || container.sampleRate !== AAC_IMPORT.sampleRate) throw new Error('invalid_converted_audio');
  return container;
}

async function convertTrack(
  file: File, session: MutationSession | undefined, expectedDuration?: number, expectedChannels?: number,
): Promise<{ blob: Blob; duration: number }> {
  session?.assert();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const lifecycle = !session && typeof window !== 'undefined' ? window : undefined;
  const assertActive = () => {
    session?.assert();
    if (controller.signal.aborted) throw new Error('conversion_aborted');
  };
  activeConversionControllers.add(controller);
  lifecycle?.addEventListener('pagehide', abort);
  lifecycle?.addEventListener(hostedInvalidationEvent, abort);
  try {
    const { convertToM4a } = await import('./audio-conversion');
    assertActive();
    const converted = await convertToM4a(file, { signal: controller.signal });
    assertActive();
    if (!Number.isFinite(converted.duration) || converted.duration <= 0 || converted.duration > MAX_TRACK_SECONDS) {
      throw new Error('audio_duration_limit');
    }
    if (expectedDuration !== undefined && Math.abs(converted.duration - expectedDuration) > CONVERTED_DURATION_EPSILON) {
      throw new Error('audio_duration_mismatch');
    }
    const container = await validateM4aBlob(converted.blob);
    if (expectedChannels !== undefined && container.channels !== expectedChannels) throw new Error('audio_channel_mismatch');
    assertActive();
    const output = new File([converted.blob], `converted${AAC_IMPORT.extension}`, { type: AAC_IMPORT.contentType });
    const decodedDuration = await decodeNative(output, session, converted.duration, undefined, container.channels);
    assertActive();
    if (expectedDuration !== undefined && Math.abs(decodedDuration - expectedDuration) > CONVERTED_DURATION_EPSILON) {
      throw new Error('audio_duration_mismatch');
    }
    return converted;
  } catch (error) {
    assertActive();
    throw error;
  } finally {
    activeConversionControllers.delete(controller);
    lifecycle?.removeEventListener('pagehide', abort);
    lifecycle?.removeEventListener(hostedInvalidationEvent, abort);
  }
}

async function prepareTrack(
  file: File, session: MutationSession | undefined, preserveBytes = false,
): Promise<StoredTrack> {
  session?.assert();
  const byteLimit = preserveBytes ? MAX_CLOUD_TRACK_BYTES : MAX_TRACK_BYTES;
  if (!file.size || file.size > byteLimit) throw new Error('audio_byte_limit');
  const type = file.type.toLowerCase().split(';')[0].trim();
  const supported = /^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
  const extension = /\.(mp3|mp4|m4a|aac|wav|ogg|opus|webm|flac|aif|aiff|wma)$/i;
  const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  session?.assert();
  const oggOpus = hasSignature(header, 0, 'OggS') && header[26] > 0 &&
    hasSignature(header, 27 + header[26], 'OpusHead');
  const declaredOpus = type === 'audio/opus' || /\.opus$/i.test(file.name) || /\bcodecs\s*=\s*"?opus\b/i.test(file.type);
  const oggAlias = type === 'application/ogg' && hasSignature(header, 0, 'OggS');
  if (!supported.test(type) && !oggAlias && !((!type || type === 'application/octet-stream') && extension.test(file.name))) {
    throw new Error('unsupported_audio');
  }
  let blob: Blob;
  let duration: number;
  let opusDuration: number | undefined;
  let channels: number | undefined;
  let container: ContainerAudio | undefined;
  const mp4 = ['audio/mp4', 'audio/x-m4a'].includes(type) || /\.(m4a|mp4)$/i.test(file.name) ||
    (header.length >= 8 && ['ftyp', 'free', 'skip', 'wide'].some(kind => hasSignature(header, 4, kind)));
  if (mp4 || hasSignature(header, 0, '\x1a\x45\xdf\xa3')) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    session?.assert();
    container = mp4 ? inspectMp4(bytes) : inspectWebm(bytes);
    channels = container.channels;
  }
  if (oggOpus || (hasSignature(header, 0, 'OggS') && declaredOpus)) {
    const validated = validateOggOpus(new Uint8Array(await file.arrayBuffer()));
    opusDuration = validated.samples / 48000;
    channels = validated.channels;
  }
  session?.assert();
  if ((oggOpus || declaredOpus || container?.opus) && !preserveBytes) {
    ({ blob, duration } = await convertTrack(file, session, opusDuration, channels));
  } else {
    let sourceDuration: number | undefined;
    try {
      duration = await decodeNative(file, session, undefined, value => { sourceDuration = value; }, channels);
      blob = file.slice(0, file.size, preserveBytes ? file.type : canonicalAudioType(file, header, container));
    } catch (error) {
      session?.assert();
      if (preserveBytes || !(error instanceof Error) ||
        (!error.message.startsWith('unsupported_audio:') && error.message !== 'audio_metadata_timeout')) throw error;
      ({ blob, duration } = await convertTrack(file, session, sourceDuration, channels));
    }
  }
  session?.assert();
  const sha256 = await digest(blob);
  session?.assert();
  return { blob, bytes: blob.size, duration, sha256 };
}

async function importTrack(file: File, session: MutationSession | undefined): Promise<Track> {
  const record = await prepareTrack(file, session);
  const track: Track = {
    id: crypto.randomUUID(), title: file.name.slice(0, 300), duration: record.duration,
    firstBeat: 0, cues: [], bodyArea: '',
  };
  await mutate(session, ['tracks'], async transaction => {
    await transaction.objectStore('tracks').put(record, track.id);
  });
  return track;
}

let importQueue: Promise<unknown> = Promise.resolve();

function enqueueImport<Result>(session: MutationSession | undefined, operation: (session: MutationSession | undefined) => Promise<Result>): Promise<Result> {
  const lifecycle = !session && typeof window !== 'undefined' ? window : undefined;
  let invalidated = false;
  const abort = () => {
    invalidated = true;
    for (const controller of activeConversionControllers) controller.abort();
    for (const cancel of pendingMutations) cancel();
  };
  const captured = session ?? (lifecycle ? {
    assert() { if (invalidated) throw new Error('conversion_aborted'); },
  } : undefined);
  lifecycle?.addEventListener('pagehide', abort);
  lifecycle?.addEventListener(hostedInvalidationEvent, abort);
  const result = importQueue.then(() => {
    captured?.assert();
    if (nativeDecodePending) throw new Error('audio_decoder_busy');
    return operation(captured);
  }).finally(() => {
    lifecycle?.removeEventListener('pagehide', abort);
    lifecycle?.removeEventListener(hostedInvalidationEvent, abort);
  });
  importQueue = result.catch(() => undefined);
  return result;
}

export async function storeTrack(file: File): Promise<Track> {
  const session = captureMutationSession();
  return enqueueImport(session, captured => importTrack(file, captured));
}

export async function addFillerRecording(file: File, name?: string): Promise<FillerRecording> {
  const session = captureMutationSession();
  const title = name ?? file.name.slice(0, 160);
  if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new Error('invalid_filler_recording');
  return enqueueImport(session, async session => {
    const record = await prepareTrack(file, session);
    if (!record.sha256) throw new Error('track_integrity_failed');
    const aliases: Record<string, string> = {
      'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/wave': 'audio/wav',
      'audio/x-wav': 'audio/wav', 'audio/x-flac': 'audio/flac',
    };
    const extensions: Record<string, string> = {
      mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    };
    const originalType = record.blob.type.toLowerCase().split(';')[0].trim();
    const contentType = aliases[originalType] ??
      ((!originalType || originalType === 'application/octet-stream') ? extensions[file.name.split('.').at(-1)!.toLowerCase()] : originalType);
    const id = crypto.randomUUID();
    const recording = fillerSnapshot({
      id, name: title, duration: record.duration,
      asset: { id, sha256: record.sha256 ?? '', bytes: record.bytes, contentType },
    });
    if (record.blob.type !== contentType) record.blob = record.blob.slice(0, record.bytes, contentType);
    await mutate(session, ['tracks', 'fillerRecordings'], async transaction => {
      const key = `filler-${id}`;
      if (await transaction.objectStore('tracks').get(key) || await transaction.objectStore('fillerRecordings').get(id)) {
        throw new Error('track_conflict');
      }
      session?.assert();
      await transaction.objectStore('tracks').put(record, key);
      await transaction.objectStore('fillerRecordings').put(recording, id);
    });
    return recording;
  });
}

export async function cacheCloudTrack(trackId: string, blob: Blob, expectedSha256: string): Promise<void> {
  return cacheTrack(trackId, blob, expectedSha256);
}

export async function cacheFillerRecording(recording: FillerRecording, blob: Blob): Promise<void> {
  const snapshot = fillerSnapshot(recording);
  if (!(blob instanceof Blob) || blob.size !== snapshot.asset.bytes || blob.type !== snapshot.asset.contentType) {
    throw new Error('filler_integrity_failed');
  }
  return cacheTrack(`filler-${snapshot.asset.id}`, blob, snapshot.asset.sha256, snapshot);
}

async function cacheTrack(
  trackId: string, blob: Blob, expectedSha256: string, recording?: FillerRecording,
): Promise<void> {
  const session = captureMutationSession();
  if (typeof trackId !== 'string' || !trackId.trim()) throw new Error('invalid_track_id');
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('invalid_track_hash');
  if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_CLOUD_TRACK_BYTES) throw new Error('audio_byte_limit');
  return enqueueImport(session, async session => {
    session?.assert();
    const sha256 = await digest(blob);
    session?.assert();
    if (sha256 !== expectedSha256) throw new Error('track_integrity_failed');
    const record = await prepareTrack(new File([blob], 'cloud-audio', { type: blob.type }), session, true);
    if (record.sha256 !== expectedSha256) throw new Error('track_integrity_failed');
    if (recording && Math.abs(record.duration - recording.duration) > 0.1) throw new Error('audio_duration_mismatch');
    const connection = await database(session);
    let previous: StoredTrack | undefined;
    try {
      previous = await connection.get('tracks', trackId);
    } finally {
      connection.close();
    }
    session?.assert();
    const previousHash = previous?.blob instanceof Blob ? await digest(previous.blob) : undefined;
    session?.assert();
    if (previous && (previousHash !== expectedSha256 || previous.sha256 !== expectedSha256 ||
      previous.bytes !== blob.size || !Number.isFinite(previous.duration) || previous.duration <= 0 ||
      (recording && (previous.blob.type !== recording.asset.contentType || Math.abs(previous.duration - recording.duration) > 0.1)) ||
      previous.duration > MAX_TRACK_SECONDS || Math.abs(previous.duration - record.duration) > 0.1)) {
      throw new Error('track_conflict');
    }
    await mutate(session, ['tracks'], async transaction => {
      const tracks = transaction.objectStore('tracks');
      const current = await tracks.get(trackId);
      session?.assert();
      if (current) {
        if (!previous || current.sha256 !== previous.sha256 || current.bytes !== previous.bytes ||
          current.duration !== previous.duration || !(current.blob instanceof Blob) ||
          current.blob.size !== previous.blob.size || current.blob.type !== previous.blob.type) {
          throw new Error('track_conflict');
        }
        return;
      }
      if (previous) throw new Error('track_conflict');
      await tracks.put(record, trackId);
    });
  });
}

export function generateLoopSamples(sound: Filler['sound'], bpm: number, sampleRate = 22050): Float32Array<ArrayBuffer> {
  if (sound === 'lofi' || sound === 'recording') throw new Error('filler_requires_recording');
  const length = Math.round(sampleRate * 240 / bpm);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const beat = index / length * 4;
    const phase = beat % 1;
    const time = phase * 60 / bpm;
    const envelope = Math.min(1, time / 0.004) * Math.exp(-time * 16);
    const kick = Math.sin(2 * Math.PI * (55 * time + 3 * (1 - Math.exp(-time * 30)))) * envelope;
    const click = Math.sin(index * 2.399963229728653) * Math.exp(-time * 80);
    const tone = Math.sin(2 * Math.PI * (sound === 'bright' ? 440 : 220) * time) * envelope;
    const edge = Math.min(1, index / 80, (length - 1 - index) / 80);
    samples[index] = edge * (0.24 * kick + 0.05 * click + (sound === 'drums' ? 0 : 0.12 * tone));
  }
  return samples;
}

export function generateDemoWav(seconds: number, bpm: number, sound: Filler['sound']): Blob {
  const sampleRate = 16000;
  const length = Math.round(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  const loop = generateLoopSamples(sound, bpm, sampleRate);
  for (let index = 0; index < length; index++) {
    const time = index / sampleRate;
    const frequency = [220, 261.625565, 329.627557, 293.664768][Math.floor(time / 4) % 4];
    const melody = sound === 'drums' ? 0 : 0.08 * Math.sin(2 * Math.PI * frequency * time);
    const edge = Math.min(1, time / 0.02, (seconds - time) / 0.04);
    view.setInt16(44 + index * 2, Math.round((loop[index % loop.length] + melody) * edge * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function createDemoRoutine(): Promise<Routine> {
  const session = captureMutationSession();
  const routine = newRoutine();
  routine.name = 'Two-song rehearsal';
  routine.filler = { mode: 'timed', seconds: 6, bpm: 100, sound: 'soft' };
  routine.crossfade = 2;
  routine.beepEvery = 8;
  routine.beepRemaining = 3;
  const definitions = [
    { title: 'Synthetic tonal warm-up', duration: 24, bpm: 100, sound: 'soft' as const },
    { title: 'Synthetic drum practice', duration: 28, bpm: 120, sound: 'drums' as const },
  ];
  for (const definition of definitions) {
    const blob = generateDemoWav(definition.duration, definition.bpm, definition.sound);
    const track: Track = {
      id: crypto.randomUUID(), title: definition.title, duration: definition.duration,
      bpm: definition.bpm, firstBeat: 0, bodyArea: 'Rehearsal',
      cues: [
        { id: crypto.randomUUID(), anchor: { kind: 'timestamp', seconds: 0 }, note: 'Prepare your position' },
        { id: crypto.randomUUID(), anchor: { kind: 'count', count: 9 }, note: 'Begin small pulses' },
        { id: crypto.randomUUID(), anchor: { kind: 'interval', seconds: 12 }, note: 'Change sides' },
        { id: crypto.randomUUID(), anchor: { kind: 'timestamp', seconds: 20 }, note: 'Release and reset' },
      ],
    };
    const sha256 = await digest(blob);
    await mutate(session, ['tracks'], async transaction => {
      await transaction.objectStore('tracks').put({ blob, bytes: blob.size, duration: track.duration, sha256 }, track.id);
    });
    routine.tracks.push(track);
  }
  return routine;
}