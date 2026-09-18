import type { CloudAsset, CloudRoutine, CloudRoutineSummary, FillerAnalysis, LibraryMetadata, ManagedAudioItem, ManagedAudioPage, LibraryUsagePage, LibraryDeleteResult } from '../../shared/cloud-contract';
import { allRoutineFillers, allRoutineTracks, validFillerRecording, validateRoutine, type Filler, type FillerRecording, type Routine, type Track } from '../../shared/routine';
import { cloudClient, CLOUD_CHUNK_BYTES, CloudRequestError, type CloudClient } from './cloud-client';
import { cacheCloudRoutine, cacheCloudTrack, cacheFillerRecording, getFillerRecordingBlob, getTrackBlob } from './offline';

export const MAX_CLOUD_MEDIA_BYTES = 128 * 1024 * 1024;
const CLOUD_DOWNLOAD_CONCURRENCY = 2;
const downloadQueue: Array<() => void> = [];
let activeDownloads = 0;

export function isLibraryIntakeFilename(filename: unknown): filename is string {
  return typeof filename === 'string' && filename.length <= 300 && !!filename.trim()
    && !/[\\/:\x00-\x1f\x7f]/.test(filename) && filename !== '.' && filename !== '..';
}

export function validateLibraryIntakeFilename(filename: unknown): asserts filename is string {
  if (!isLibraryIntakeFilename(filename)) throw new Error('invalid_audio');
}

export function validateLibraryIntakeDuration(kind: ManagedAudioItem['kind'], duration: unknown): asserts duration is number {
  if (!Number.isFinite(duration) || (duration as number) <= 0 || (duration as number) > (kind === 'song' ? 1200 : 360)) {
    throw new Error('invalid_audio');
  }
}

export function validateLibraryIntake(kind: ManagedAudioItem['kind'], filename: unknown, duration: unknown): void {
  validateLibraryIntakeFilename(filename);
  validateLibraryIntakeDuration(kind, duration);
}

function withDownloadSlot(action: () => Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = downloadQueue.indexOf(run);
      if (index !== -1) downloadQueue.splice(index, 1);
      reject(new CloudRequestError('cancelled'));
    };
    const run = async () => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) { reject(new CloudRequestError('cancelled')); return; }
      activeDownloads++;
      try { await action(); resolve(); }
      catch (error) { reject(error); }
      finally { activeDownloads--; downloadQueue.shift()?.(); }
    };
    if (signal.aborted) { reject(new CloudRequestError('cancelled')); return; }
    signal.addEventListener('abort', cancel, { once: true });
    if (activeDownloads < CLOUD_DOWNLOAD_CONCURRENCY) void run();
    else downloadQueue.push(run);
  });
}

export interface CloudTransfer {
  signal?: AbortSignal;
  progress?: (completed: number, total: number) => void;
}
export type MediaAuthority = string | { routineId: string; revision: number } | { classId: string; revision: number } | { playlistId: string; revision: number };

export function routineFillers(routine: Routine): Filler[] {
  return allRoutineFillers(routine);
}

export function routineRecordings(routine: Routine): FillerRecording[] {
  return [...new Map(routineFillers(routine).flatMap(filler => filler.recording ? [[filler.recording.id, filler.recording] as const] : [])).values()];
}
export interface CloudLibraryDependencies {
  client?: CloudClient;
  getTrackBlob?: typeof getTrackBlob;
  cacheTrack?: typeof cacheCloudTrack;
  cacheRoutine?: typeof cacheCloudRoutine;
  getFillerBlob?: typeof getFillerRecordingBlob;
  cacheFiller?: typeof cacheFillerRecording;
}

interface UploadStart {
  id: string;
  assetId: string;
  chunkBytes: number;
  chunkCount: number;
  expiresAt: number;
}

interface UploadAttempt {
  started?: UploadStart;
  expiresAt: number;
  uploadedChunks: number;
  completing: boolean;
  copied: number;
  publishing: boolean;
  failure?: unknown;
}

function transientUploadError(error: unknown): error is CloudRequestError {
  return error instanceof CloudRequestError && (error.code === 'network_unavailable'
    || (error.code === 'cloud_http_error' && ([500, 502, 503, 504].includes(error.status ?? 0)
      || (error.status === 409 && error.serverCode === 'upload_conflict'))));
}

export function canonicalAudioType(type: string): string {
  const base = type.toLowerCase().split(';')[0]!.trim();
  const aliases: Record<string, string> = {
    'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
    'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg',
    'audio/m4a': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/x-flac': 'audio/flac',
    'audio/opus': 'audio/ogg', 'application/ogg': 'audio/ogg',
  };
  const canonical = aliases[base] ?? base;
  if (!['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm'].includes(canonical)) {
    throw new Error('cloud_unsupported_media');
  }
  return canonical;
}

export async function cloudHash(blob: Blob): Promise<string> {
  if (!blob.size || blob.size > MAX_CLOUD_MEDIA_BYTES) throw new Error('cloud_media_size');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
}

function assetDescriptor(value: unknown): CloudAsset {
  if (!value || typeof value !== 'object') throw new Error('cloud_invalid_response');
  const asset = value as CloudAsset;
  if (!safeId(asset.id) || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || typeof asset.contentType !== 'string' || !Number.isSafeInteger(asset.bytes)
    || asset.bytes < 44 || asset.bytes > MAX_CLOUD_MEDIA_BYTES || canonicalAudioType(asset.contentType) !== asset.contentType) {
    throw new Error('cloud_invalid_response');
  }
  return { id: asset.id, sha256: asset.sha256, bytes: asset.bytes, contentType: asset.contentType };
}

export function parseCloudRoutine(value: unknown): CloudRoutine {
  try {
    const envelope = value as CloudRoutine;
    if (!envelope || !safeId(envelope.routine.id) || validateRoutine(envelope.routine).length
      || !envelope.media || Array.isArray(envelope.media)
      || Object.keys(envelope.media).length !== allRoutineTracks(envelope.routine).length) throw new Error();
    const media: Record<string, CloudAsset> = {};
    for (const track of allRoutineTracks(envelope.routine)) {
      if (!safeId(track.id) || !Object.hasOwn(envelope.media, track.id)) throw new Error();
      media[track.id] = assetDescriptor(envelope.media[track.id]);
    }
    return { routine: structuredClone(envelope.routine), media };
  } catch { throw new Error('cloud_invalid_response'); }
}

function sameAsset(first: CloudAsset, second: CloudAsset): boolean {
  return first.id === second.id && first.bytes === second.bytes && first.sha256 === second.sha256
    && first.contentType === second.contentType;
}

function recordingDescriptor(value: unknown): FillerRecording {
  if (!validFillerRecording(value) || Object.keys(value).sort().join(',') !== 'asset,duration,id,name'
    || Object.keys(value.asset).sort().join(',') !== 'bytes,contentType,id,sha256') throw new Error('cloud_invalid_response');
  return structuredClone(value);
}

function sameRecording(first: FillerRecording | undefined, second: FillerRecording): boolean {
  return !!first && first.id === second.id && first.name === second.name && first.duration === second.duration
    && sameAsset(first.asset, second.asset);
}

export function createCloudLibrary(dependencies: CloudLibraryDependencies = {}) {
  const client = dependencies.client ?? cloudClient;
  const readBlob = dependencies.getTrackBlob ?? ((id: string) => getTrackBlob(id));
  const cacheTrack = dependencies.cacheTrack ?? ((id: string, blob: Blob, hash: string) => cacheCloudTrack(id, blob, hash));
  const cacheRoutine = dependencies.cacheRoutine ?? ((routine: Routine) => cacheCloudRoutine(routine));
  const readFiller = dependencies.getFillerBlob ?? ((recording: FillerRecording) => getFillerRecordingBlob(recording));
  const cacheFiller = dependencies.cacheFiller ?? ((recording: FillerRecording, blob: Blob) => cacheFillerRecording(recording, blob));
  const uploaded = new Map<string, CloudAsset>();
  const knownRemoteAssets = new Set<string>();
  const knownRecordings = new Map<string, FillerRecording>();
  const addedRecordings = new Map<string, FillerRecording>();
  const pendingRecordings = new Map<string, CloudAsset>();
  const attempts = new Map<string, UploadAttempt>();
  const activeUploads = new Set<string>();
  let uploadOwner = '';
  const operation = (transfer: CloudTransfer, write = false) => {
    const assertIdentity = client.captureIdentity();
    if (write && !['owner', 'editor'].includes(client.getRole() ?? '')) throw new CloudRequestError('forbidden', 403);
    const user = client.getUser()!;
    const owner = JSON.stringify([user.id, user.authVersion, user.role]);
    if (owner !== uploadOwner) {
      uploaded.clear(); attempts.clear(); knownRemoteAssets.clear(); knownRecordings.clear(); addedRecordings.clear(); pendingRecordings.clear(); uploadOwner = owner;
    }
    const assert = () => {
      assertIdentity();
      if (transfer.signal?.aborted) throw new CloudRequestError('cancelled');
    };
    assert();
    return assert;
  };
  const rememberRecording = (envelope: CloudRoutine) => {
    for (const asset of Object.values(envelope.media)) knownRemoteAssets.add(asset.id);
    for (const recording of routineRecordings(envelope.routine)) knownRecordings.set(recording.id, structuredClone(recording));
  };
  const listFillers = async (transfer: CloudTransfer = {}): Promise<FillerRecording[]> => {
    const assert = operation(transfer, true);
    const value = await client.request<{ fillers: unknown[] }>('/api/fillers', { signal: transfer.signal });
    assert();
    if (!Array.isArray(value.fillers) || value.fillers.length > 512) throw new Error('cloud_invalid_response');
    const recordings = value.fillers.map(recordingDescriptor);
    if (new Set(recordings.map(recording => recording.id)).size !== recordings.length) throw new Error('cloud_invalid_response');
    for (const recording of recordings) knownRecordings.set(recording.id, structuredClone(recording));
    return recordings;
  };
  const removeFiller = async (id: string, transfer: CloudTransfer = {}): Promise<void> => {
    const assert = operation(transfer, true);
    if (!safeId(id)) throw new Error('cloud_invalid_response');
    await client.request(`/api/fillers/${encodeURIComponent(id)}`, { method: 'DELETE', signal: transfer.signal });
    assert();
    for (const [key, recording] of addedRecordings) if (recording.id === id) addedRecordings.delete(key);
  };
  const route = (id: string) => {
    if (!safeId(id)) throw new Error('cloud_invalid_response');
    return `/api/routines/${encodeURIComponent(id)}`;
  };
  const readPublished = (published: boolean) => {
    if (client.getRole() === 'player' && !published) throw new CloudRequestError('forbidden', 403);
    return published ? '?published=true' : '';
  };
  const list = async (published: boolean, transfer: CloudTransfer = {}): Promise<CloudRoutineSummary[]> => {
    const assert = operation(transfer);
    const value = await client.request<{ routines: CloudRoutineSummary[] }>(`/api/routines${readPublished(published)}`, { signal: transfer.signal });
    assert();
    if (!Array.isArray(value.routines) || value.routines.length > 512 || value.routines.some(item =>
      !safeId(item.id) || typeof item.name !== 'string' || item.name.length > 160
      || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.locked !== 'boolean'
      || typeof item.published !== 'boolean' || (published && !item.published))) throw new Error('cloud_invalid_response');
    return structuredClone(value.routines);
  };
  const downloadAsset = async (asset: CloudAsset, cached: Blob | undefined, transfer: CloudTransfer,
    assert: () => void, progress: (bytes: number) => void, authority?: MediaAuthority): Promise<Blob> => {
    assert();
    if (cached?.size === asset.bytes && canonicalAudioType(cached.type) === asset.contentType
      && await cloudHash(cached) === asset.sha256) {
      assert();
      progress(asset.bytes);
      return cached;
    }
    let suffix = '';
    if (authority && typeof authority === 'object') {
      const key = 'classId' in authority ? 'classId' : 'playlistId' in authority ? 'playlistId' : 'routineId';
      const id = 'classId' in authority ? authority.classId : 'playlistId' in authority ? authority.playlistId : authority.routineId;
      if (!safeId(id) || !Number.isSafeInteger(authority.revision) || authority.revision < 1) throw new Error('cloud_invalid_response');
      suffix = `?${new URLSearchParams({ [key]: id, revision: String(authority.revision) })}`;
    } else if (client.getRole() === 'player') {
      if (!safeId(authority)) throw new CloudRequestError('forbidden', 403);
      suffix = `?routineId=${encodeURIComponent(authority)}`;
    }
    const path = `/api/media/${encodeURIComponent(asset.id)}`;
    assert();
    const manifest = await client.request<{ asset: CloudAsset; chunkBytes: number; chunkCount: number }>(path + suffix, { signal: transfer.signal });
    assert();
    if (!sameAsset(assetDescriptor(manifest.asset), asset) || manifest.chunkBytes !== CLOUD_CHUNK_BYTES
      || manifest.chunkCount !== Math.ceil(asset.bytes / CLOUD_CHUNK_BYTES)) throw new Error('cloud_invalid_response');
    const chunks = new Array<Blob>(manifest.chunkCount);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    transfer.signal?.addEventListener('abort', cancel, { once: true });
    if (transfer.signal?.aborted) cancel();
    let nextIndex = 0;
    let failure: unknown;
    let failed = false;
    const fail = (error: unknown) => {
      if (!failed) { failed = true; failure = error; }
      controller.abort();
    };
    const fetchChunks = async () => {
      try {
        while (nextIndex < manifest.chunkCount) {
          assert();
          controller.signal.throwIfAborted();
          const index = nextIndex++;
          await withDownloadSlot(async () => {
            try {
              assert();
              controller.signal.throwIfAborted();
              const chunk = await client.requestBlob(`${path}/chunks/${index}${suffix}`, { signal: controller.signal });
              assert();
              controller.signal.throwIfAborted();
              if (chunk.size !== Math.min(CLOUD_CHUNK_BYTES, asset.bytes - index * CLOUD_CHUNK_BYTES)) throw new Error('track_integrity_failed');
              chunks[index] = chunk;
              progress(chunk.size);
            } catch (error) { fail(error); }
          }, controller.signal);
        }
      } catch (error) { fail(error); }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CLOUD_DOWNLOAD_CONCURRENCY, manifest.chunkCount) }, fetchChunks));
      if (failed) throw failure;
    } finally { transfer.signal?.removeEventListener('abort', cancel); }
    const blob = new Blob(chunks, { type: asset.contentType });
    if (await cloudHash(blob) !== asset.sha256) throw new Error('track_integrity_failed');
    assert();
    return blob;
  };
  const ensureFiller = async (value: FillerRecording, transfer: CloudTransfer = {}, authority?: MediaAuthority): Promise<void> => {
    const assert = operation(transfer);
    const recording = recordingDescriptor(value);
    const cached = await readFiller(recording);
    assert();
    let completed = 0;
    const blob = await downloadAsset(recording.asset, cached, transfer, assert, bytes => {
      completed += bytes;
      transfer.progress?.(completed, recording.asset.bytes);
    }, authority);
    assert();
    if (blob !== cached) await cacheFiller(recording, blob);
    assert();
  };
  const download = async (envelope: CloudRoutine, transfer: CloudTransfer = {}, published = false, authority?: MediaAuthority | null): Promise<CloudRoutine> => {
    const assert = operation(transfer);
    readPublished(published);
    const snapshot = parseCloudRoutine(envelope);
    if (published && !snapshot.routine.published) throw new Error('cloud_invalid_response');
    const mediaAuthority = authority === null ? undefined : authority ?? (published
      ? { routineId: snapshot.routine.id, revision: snapshot.routine.revision } : undefined);
    const recordings = routineRecordings(snapshot.routine);
    const total = allRoutineTracks(snapshot.routine).reduce((sum, track) => sum + snapshot.media[track.id]!.bytes,
      recordings.reduce((sum, recording) => sum + recording.asset.bytes, 0));
    let completed = 0;
    const progress = (bytes: number) => { completed += bytes; transfer.progress?.(completed, total); };
    for (const track of allRoutineTracks(snapshot.routine)) {
      assert();
      const asset = snapshot.media[track.id]!;
      const cached = await readBlob(track.id);
      assert();
      const blob = await downloadAsset(asset, cached, transfer, assert, progress, mediaAuthority);
      assert();
      if (blob !== cached) await cacheTrack(track.id, blob, asset.sha256);
      assert();
    }
    for (const recording of recordings) {
      const cached = await readFiller(recording);
      assert();
      const blob = await downloadAsset(recording.asset, cached, transfer, assert, progress, mediaAuthority);
      assert();
      if (blob !== cached) await cacheFiller(recording, blob);
      assert();
    }
    assert();
    await cacheRoutine(snapshot.routine);
    assert();
    return snapshot;
  };
  const open = async (id: string, published: boolean, transfer: CloudTransfer = {}, revision?: number) => {
    const assert = operation(transfer);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('cloud_invalid_response');
    const query = readPublished(published) + (revision === undefined ? '' : `${published ? '&' : '?'}revision=${revision}`);
    const envelope = parseCloudRoutine(await client.request(route(id) + query, { signal: transfer.signal }));
    assert();
    if (envelope.routine.id !== id || (revision !== undefined && envelope.routine.revision !== revision)) throw new Error('cloud_invalid_response');
    rememberRecording(envelope);
    return download(envelope, transfer, published);
  };
  const readHead = async (id: string, transfer: CloudTransfer = {}): Promise<CloudRoutine> => {
    const assert = operation(transfer, true);
    const envelope = parseCloudRoutine(await client.request(route(id), { signal: transfer.signal }));
    assert();
    if (envelope.routine.id !== id || envelope.routine.published) throw new Error('cloud_head_required');
    rememberRecording(envelope);
    return envelope;
  };
  const upload = async (blob: Blob, transfer: CloudTransfer, assert: () => void,
    progress: (bytes: number) => void): Promise<CloudAsset> => {
    const assertUploadIdentity = client.captureIdentity();
    if (blob.size < 44 || blob.size > MAX_CLOUD_MEDIA_BYTES) throw new Error('cloud_media_size');
    const descriptor = { bytes: blob.size, sha256: await cloudHash(blob), contentType: canonicalAudioType(blob.type) };
    assert();
    const key = `${uploadOwner}:${descriptor.sha256}:${descriptor.contentType}`;
    const previous = uploaded.get(key);
    if (previous) { progress(blob.size); return previous; }
    if (activeUploads.has(key)) throw new CloudRequestError('cloud_http_error', 409, 'upload_conflict');
    let attempt = attempts.get(key);
    if (attempt && attempt.expiresAt <= Date.now()) { attempts.delete(key); attempt = undefined; }
    if (attempt?.failure !== undefined) throw attempt.failure;
    if (!attempt) {
      const access = client.getContext().access;
      if (access !== 'online') throw new CloudRequestError(access === 'offline' ? 'network_unavailable'
        : access === 'forbidden' ? 'forbidden' : 'signin_required');
      attempt = { expiresAt: Date.now() + 86_400_000, uploadedChunks: 0, completing: false, copied: -1, publishing: false };
      attempts.set(key, attempt);
    }
    const current = attempt;
    activeUploads.add(key);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    transfer.signal?.addEventListener('abort', cancel, { once: true });
    const began = performance.now();
    const timer = setTimeout(cancel, 300_000);
    const limited = () => new CloudRequestError('cloud_http_error', 503, 'finalization_timeout');
    const check = () => {
      assert();
      if (controller.signal.aborted || performance.now() - began >= 300_000) throw limited();
      if (current.expiresAt <= Date.now()) throw new CloudRequestError('cloud_http_error', 409, 'upload_closed');
    };
    const wait = async <Value>(work: () => Promise<Value>): Promise<Value> => {
      check();
      let interrupt!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        interrupt = () => { try { check(); } catch (error) { reject(error); } };
        controller.signal.addEventListener('abort', interrupt, { once: true });
      });
      try { return await Promise.race([work(), interrupted]); }
      finally { controller.signal.removeEventListener('abort', interrupt); }
    };
    const backoff = async (milliseconds: number) => {
      let delayed: ReturnType<typeof setTimeout> | undefined;
      try { await wait(() => new Promise<void>(resolve => { delayed = setTimeout(resolve, milliseconds); })); }
      finally { clearTimeout(delayed); }
    };
    let retries = 0;
    let calls = 0;
    const countCall = () => {
      if (calls >= Math.min(80, Math.ceil(blob.size / CLOUD_CHUNK_BYTES) + 8)) throw limited();
      calls++;
    };
    const requestUpload = async <Value>(work: () => Promise<Value>, completing = false): Promise<Value> => {
      for (;;) {
        check();
        try {
          if (client.getContext().access === 'offline') {
            countCall();
            await wait(() => client.refreshSession());
            check();
          }
          if (completing) countCall();
          const value = await work();
          check();
          return value;
        } catch (error) {
          check();
          if (!transientUploadError(error) || retries >= 2 || calls >= Math.min(80, Math.ceil(blob.size / CLOUD_CHUNK_BYTES) + 8)) {
            if (error instanceof CloudRequestError && [502, 504].includes(error.status ?? 0)) {
              throw new CloudRequestError('cloud_http_error', 503, 'storage_unavailable');
            }
            throw error;
          }
          retries++;
          await backoff(250 * 2 ** (retries - 1));
        }
      }
    };
    try {
      check();
      if (!current.started) {
        const started = await client.request<UploadStart>('/api/media/uploads', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(descriptor), signal: controller.signal,
        });
        assertUploadIdentity();
        if (!safeId(started.id) || !safeId(started.assetId) || started.chunkBytes !== CLOUD_CHUNK_BYTES
          || started.chunkCount !== Math.ceil(blob.size / CLOUD_CHUNK_BYTES) || !Number.isFinite(started.expiresAt)
          || started.expiresAt <= Date.now()) throw new Error('cloud_invalid_response');
        current.started = started;
        current.expiresAt = Math.min(current.expiresAt, started.expiresAt);
        check();
      }
      const started = current.started;
      const path = `/api/media/uploads/${encodeURIComponent(started.id)}`;
      progress(Math.min(blob.size, current.uploadedChunks * CLOUD_CHUNK_BYTES));
      for (let index = current.uploadedChunks; !current.completing && index < started.chunkCount; index++) {
        check();
        const chunk = blob.slice(index * CLOUD_CHUNK_BYTES, Math.min(blob.size, (index + 1) * CLOUD_CHUNK_BYTES));
        const hash = await cloudHash(chunk);
        const result = await requestUpload(() => client.request<{ index: number; sha256: string }>(`${path}/chunks/${index}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk, signal: controller.signal,
        }));
        if (result.index !== index || result.sha256 !== hash) throw new Error('track_integrity_failed');
        current.uploadedChunks = index + 1;
        progress(chunk.size);
      }
      let unchanged = 0;
      for (;;) {
        check();
        current.completing = true;
        const response = await requestUpload(() => client.requestJson(`${path}/complete`, { method: 'POST', signal: controller.signal }), true);
        if (response.status === 200) {
          const asset = assetDescriptor(response.body);
          if (asset.id !== started.assetId || asset.bytes !== descriptor.bytes || asset.sha256 !== descriptor.sha256
            || asset.contentType !== descriptor.contentType) throw new Error('track_integrity_failed');
          uploaded.set(key, asset);
          attempts.delete(key);
          return asset;
        }
        const pending = response.body as Record<string, unknown> | null;
        if (response.status !== 202 || !pending || typeof pending !== 'object' || Array.isArray(pending)
          || Object.keys(pending).sort().join(',') !== 'chunkCount,copiedChunks,done,pending,phase'
          || pending.pending !== true || pending.done !== false || pending.chunkCount !== started.chunkCount
          || !Number.isSafeInteger(pending.copiedChunks) || (pending.copiedChunks as number) < 0
          || (pending.copiedChunks as number) > started.chunkCount || (pending.copiedChunks as number) < current.copied
          || !['copying', 'publishing'].includes(pending.phase as string)
          || (pending.phase === 'publishing' && pending.copiedChunks !== started.chunkCount)
          || (pending.phase === 'copying' && (current.publishing || pending.copiedChunks === started.chunkCount))) {
          throw new Error('cloud_invalid_response');
        }
        unchanged = pending.copiedChunks === current.copied ? unchanged + 1 : 0;
        current.copied = pending.copiedChunks as number;
        current.publishing = pending.phase === 'publishing';
        if (unchanged > 3) throw limited();
      }
    } catch (error) {
      if (transfer.signal?.aborted) {
        current.failure = new CloudRequestError('cancelled');
        try {
          assertUploadIdentity();
          if (current.started) {
            const result = await client.request<{ aborted: boolean }>(`/api/media/uploads/${encodeURIComponent(current.started.id)}/abort`, { method: 'POST' });
            assertUploadIdentity();
            if (result.aborted === true) attempts.delete(key);
          }
        } catch (abortError) {
          if (abortError instanceof CloudRequestError && abortError.status === 409 && abortError.serverCode === 'upload_closed') {
            current.completing = true;
            delete current.failure;
          }
        }
      } else if (!current.started || (!transientUploadError(error)
        && !(error instanceof CloudRequestError && ['signin_required', 'forbidden', 'session_changed'].includes(error.code)))) {
        current.failure = error;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      transfer.signal?.removeEventListener('abort', cancel);
      activeUploads.delete(key);
    }
  };
  const uploadAsset = async (blob: Blob, transfer: CloudTransfer = {}): Promise<CloudAsset> => {
    const assert = operation(transfer, true);
    let completed = 0;
    return upload(blob, transfer, assert, bytes => {
      completed += bytes;
      transfer.progress?.(completed, blob.size);
    });
  };
  const addFiller = async (value: FillerRecording, blob: Blob, transfer: CloudTransfer = {}): Promise<FillerRecording> => {
    const assert = operation(transfer, true);
    const recording = recordingDescriptor(value);
    if (blob.size !== recording.asset.bytes || canonicalAudioType(blob.type) !== recording.asset.contentType
      || await cloudHash(blob) !== recording.asset.sha256) throw new Error('track_integrity_failed');
    assert();
    const key = JSON.stringify(recording);
    let result = addedRecordings.get(key);
    if (!result) {
      const pendingAsset = pendingRecordings.get(key);
      if (pendingAsset) {
        const recordings = await listFillers(transfer); assert();
        const matches = recordings.filter(candidate => candidate.name === recording.name && candidate.duration === recording.duration && sameAsset(candidate.asset, pendingAsset));
        if (matches.length !== 1) throw new Error('cloud_head_required');
        result = matches[0]!;
      }
      const asset = pendingAsset ?? await uploadAsset(blob, transfer);
      assert();
      if (!result) {
        pendingRecordings.set(key, asset);
        result = recordingDescriptor(await client.request('/api/fillers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: transfer.signal,
          body: JSON.stringify({ name: recording.name, duration: recording.duration, asset }),
        }));
      }
      assert();
      if (result.name !== recording.name || result.duration !== recording.duration || !sameAsset(result.asset, asset)) {
        throw new Error('cloud_invalid_response');
      }
      addedRecordings.set(key, result);
      pendingRecordings.delete(key);
      knownRecordings.set(result.id, structuredClone(result));
    }
    assert();
    await cacheFiller(result, blob);
    assert();
    return structuredClone(result);
  };
  const prepareFiller = async (filler: Filler, transfer: CloudTransfer = {}): Promise<Filler> => {
    const assert = operation(transfer, true);
    const snapshot = structuredClone(filler);
    const recording = snapshot.recording;
    if (recording) {
      let reusable = sameRecording(knownRecordings.get(recording.id), recording);
      if (!reusable) {
        try {
          const response = await client.requestJson(`/api/fillers/${encodeURIComponent(recording.id)}`, { signal: transfer.signal });
          assert();
          if (response.status !== 200) throw new Error('cloud_invalid_response');
          const resolved = recordingDescriptor(response.body);
          if (!sameRecording(resolved, recording)) throw new Error('cloud_invalid_response');
          knownRecordings.set(resolved.id, resolved);
          reusable = true;
        } catch (error) {
          assert();
          if (!(error instanceof CloudRequestError && error.code === 'cloud_http_error' && error.status === 404)) throw error;
        }
      }
      if (reusable) await ensureFiller(recording, { signal: transfer.signal });
      else {
        const blob = await readFiller(recording);
        assert();
        if (!blob) throw new Error('missing_audio');
        snapshot.recording = await addFiller(recording, blob, transfer);
      }
      assert();
    }
    return snapshot;
  };
  const downloadTracks = async (tracks: Track[], media: Record<string, CloudAsset>, transfer: CloudTransfer = {}, authority?: MediaAuthority) => {
    const assert = operation(transfer);
    const entries = tracks.map(track => ({ track, asset: assetDescriptor(media[track.id]) }));
    const total = entries.reduce((sum, entry) => sum + entry.asset.bytes, 0);
    let completed = 0;
    for (const { track, asset } of entries) {
      const cached = await readBlob(track.id);
      assert();
      const blob = await downloadAsset(asset, cached, transfer, assert, bytes => {
        completed += bytes;
        transfer.progress?.(completed, total);
      }, authority);
      assert();
      if (blob !== cached) await cacheTrack(track.id, blob, asset.sha256);
      assert();
    }
  };
  const stage = async (routine: Routine, reusableMedia: Record<string, CloudAsset> = {}, transfer: CloudTransfer = {}): Promise<CloudRoutine> => {
    const assert = operation(transfer, true);
    const snapshot = structuredClone(routine);
    if (validateRoutine(snapshot).length) throw new Error('invalid_routine');
    if (snapshot.published) throw new Error('cloud_head_required');
    if (snapshot.locked) throw new CloudRequestError('cloud_http_error', 423, 'routine_locked');
    const media: Record<string, CloudAsset> = {};
    let completed = 0;
    const fillers = routineFillers(snapshot).filter(filler => filler.recording);
    const total = allRoutineTracks(snapshot).length + fillers.length;
    for (const filler of fillers) {
      Object.assign(filler, await prepareFiller(filler, { signal: transfer.signal }));
      assert();
      transfer.progress?.(++completed, total);
    }
    for (const track of allRoutineTracks(snapshot)) {
      assert();
      const known = reusableMedia[track.id];
      const blob = await readBlob(track.id);
      assert();
      if (!blob) throw new Error('missing_audio');
      let reusable = known && blob.size === known.bytes && canonicalAudioType(blob.type) === known.contentType
        && await cloudHash(blob) === known.sha256;
      const replacedBytes = !!known && !reusable;
      assert();
      if (reusable) {
        try {
          const manifest = await client.request<{ asset: CloudAsset }>(`/api/media/${encodeURIComponent(known.id)}`, { signal: transfer.signal });
          assert(); reusable = sameAsset(assetDescriptor(manifest.asset), known);
          if (!reusable) throw new Error('track_integrity_failed');
        } catch (error) {
          assert();
          if (!(error instanceof CloudRequestError && error.status === 404)) throw error;
          if (known.id !== track.id || knownRemoteAssets.has(known.id)) throw error;
          reusable = false;
        }
      }
      if (reusable) { media[track.id] = assetDescriptor(known); knownRemoteAssets.add(known.id); }
      else {
        let bytes = 0;
        const asset = await upload(blob, transfer, assert, increment => {
          bytes += increment;
          transfer.progress?.(completed + bytes / blob.size, total);
        });
        if (replacedBytes) {
          track.id = crypto.randomUUID();
          await cacheTrack(track.id, blob, asset.sha256); assert();
        }
        media[track.id] = asset;
      }
      completed++;
      transfer.progress?.(completed, total);
    }
    assert();
    return { routine: snapshot, media };
  };
  const commit = async (envelope: CloudRoutine, baseRevision: number | null, action: 'save' | 'lock' = 'save', transfer: CloudTransfer = {}): Promise<CloudRoutine> => {
    const assert = operation(transfer, true);
    const { routine: snapshot, media } = parseCloudRoutine(envelope);
    if (baseRevision === null) snapshot.revision = 1;
    const previous = baseRevision === null ? null : { routine: { revision: baseRevision } };
    if (snapshot.locked || snapshot.published || (baseRevision !== null && snapshot.revision !== baseRevision)) throw new Error('cloud_head_required');
    if (!previous && action === 'lock') throw new Error('cloud_save_first');
    const result = parseCloudRoutine(await client.request(previous ? route(snapshot.id) + (action === 'lock' ? '/lock' : '') : '/api/routines', {
      method: previous ? action === 'lock' ? 'POST' : 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(previous ? { 'If-Match': `"${previous.routine.revision}"` } : {}) },
      body: JSON.stringify({ routine: snapshot, media }), signal: transfer.signal,
    }));
    assert();
    if (result.routine.id !== snapshot.id || result.routine.revision !== (previous ? previous.routine.revision + 1 : 1)) throw new Error('cloud_invalid_response');
    rememberRecording(result);
    return result;
  };
  const save = async (routine: Routine, previous: CloudRoutine | null, action: 'save' | 'lock' = 'save', transfer: CloudTransfer = {}, reusableMedia: Record<string, CloudAsset> = {}) => {
    operation(transfer, true)();
    if (previous && (routine.id !== previous.routine.id || routine.revision !== previous.routine.revision || previous.routine.published)) throw new Error('cloud_head_required');
    if (previous?.routine.locked) throw new CloudRequestError('cloud_http_error', 423, 'routine_locked');
    if (previous) rememberRecording(previous);
    return commit(await stage(routine, { ...previous?.media, ...reusableMedia }, transfer), previous?.routine.revision ?? null, action, transfer);
  };
  const replace = async (routine: Routine, targetId: string, confirm: (head: CloudRoutine, source: Routine) => boolean,
    transfer: CloudTransfer = {}): Promise<CloudRoutine | null> => {
    const assert = operation(transfer, true);
    const source = structuredClone(routine);
    if (source.locked || source.published || validateRoutine(source).length) throw new Error('invalid_routine');
    const head = await readHead(targetId, transfer);
    assert();
    if (head.routine.locked) throw new CloudRequestError('cloud_http_error', 423, 'routine_locked');
    if (!confirm(structuredClone(head), structuredClone(source))) return null;
    assert();
    return save({ ...source, id: head.routine.id, revision: head.routine.revision,
      locked: head.routine.locked, published: head.routine.published }, head, 'save', transfer);
  };
  const command = async (envelope: CloudRoutine, action: 'lock' | 'unlock' | 'publish' | 'delete' | 'duplicate', published = false,
    transfer: CloudTransfer = {}): Promise<CloudRoutine> => {
    const assert = operation(transfer, true);
    if ((published || envelope.routine.published) && action !== 'duplicate') throw new Error('cloud_head_required');
    if (envelope.routine.locked && !['unlock', 'duplicate'].includes(action)) throw new CloudRequestError('cloud_http_error', 423, 'routine_locked');
    const result = parseCloudRoutine(await client.request(route(envelope.routine.id)
      + (action === 'delete' ? '' : `/${action}`) + (action === 'duplicate' ? readPublished(published) : ''), {
      method: action === 'delete' ? 'DELETE' : 'POST', signal: transfer.signal,
      headers: action === 'duplicate' ? {} : { 'If-Match': `"${envelope.routine.revision}"` },
    }));
    assert();
    if (action !== 'duplicate' && (result.routine.id !== envelope.routine.id || result.routine.revision !== envelope.routine.revision + 1)) {
      throw new Error('cloud_invalid_response');
    }
    rememberRecording(result);
    return result;
  };
  const audioPage = async (cursor?: string, transfer: CloudTransfer = {}) => {
    const assert = operation(transfer, true);
    const page = await client.request<{ items: Array<{ asset: CloudAsset; title: string; duration?: number; bpm?: number }>; cursor?: string }>(
      `/api/media/library${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`, { signal: transfer.signal });
    assert();
    if (!Array.isArray(page.items) || page.items.length > 512 || (page.cursor !== undefined && (typeof page.cursor !== 'string' || page.cursor.length > 4096))) throw new Error('cloud_invalid_response');
    for (const item of page.items) {
      item.asset = assetDescriptor(item.asset);
      if (typeof item.title !== 'string' || item.title.length > 300 || (item.duration !== undefined && (!Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 1200))
        || (item.bpm !== undefined && (!Number.isFinite(item.bpm) || item.bpm < 40 || item.bpm > 220))) throw new Error('cloud_invalid_response');
    }
      for (const item of page.items) knownRemoteAssets.add(item.asset.id);
    return structuredClone(page);
  };
  const fillerAnalysis = async (recording: FillerRecording, value?: FillerAnalysis, transfer: CloudTransfer = {}): Promise<FillerAnalysis | null> => {
    const assert = operation(transfer, true);
    const response = await client.request<{ analysis: FillerAnalysis | null }>(`/api/fillers/${encodeURIComponent(recording.id)}/analysis`, {
      ...(value ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}), signal: transfer.signal,
    });
    assert();
    const analysis = response.analysis;
    if (analysis !== null && (!analysis || analysis.sha256 !== recording.asset.sha256 || !Number.isFinite(analysis.bpm) || analysis.bpm < 40 || analysis.bpm > 220
      || typeof analysis.analyzer !== 'string' || !analysis.analyzer || (analysis.confidence !== undefined && (!Number.isFinite(analysis.confidence) || analysis.confidence < 0 || analysis.confidence > 1)))) throw new Error('cloud_invalid_response');
    return structuredClone(analysis);
  };
  const libraryPath = (kind: ManagedAudioItem['kind'], id?: string) => {
    if (!['song', 'filler'].includes(kind) || (id !== undefined && !safeId(id))) throw new Error('cloud_invalid_response');
    return `/api/library/${kind === 'song' ? 'songs' : 'fillers'}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
  };
  const metadataValue = (value: LibraryMetadata): LibraryMetadata => {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.title !== 'string' || value.title.length > 300 || typeof value.artist !== 'string' || value.artist.length > 300
      || (value.bpm !== undefined && (!Number.isFinite(value.bpm) || value.bpm < 40 || value.bpm > 220))
      || (value.filename !== undefined && !isLibraryIntakeFilename(value.filename))
      || (value.duration !== undefined && (!Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 1200))) throw new Error('cloud_invalid_response');
    return structuredClone(value);
  };
  const pageCursor = (cursor?: string) => {
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 4096)) throw new Error('cloud_invalid_response');
    return cursor ? `?${new URLSearchParams({ cursor })}` : '';
  };
  const managedPage = async (kind: ManagedAudioItem['kind'], cursor?: string, transfer: CloudTransfer = {}): Promise<ManagedAudioPage> => {
    const assert = operation(transfer, true);
    const page = await client.request<ManagedAudioPage>(libraryPath(kind) + pageCursor(cursor), { signal: transfer.signal });
    assert(); pageCursor(page.cursor);
    if (!Array.isArray(page.items) || page.items.length > 512) throw new Error('cloud_invalid_response');
    const items = page.items.map(item => {
      if (!safeId(item.id) || item.kind !== kind) throw new Error('cloud_invalid_response');
      const asset = assetDescriptor(item.asset);
      const metadata = metadataValue(item.metadata);
      const recording = kind === 'filler' ? recordingDescriptor(item.recording) : undefined;
      if ((kind === 'song' && item.id !== asset.id) || (recording && (recording.id !== item.id || !sameAsset(recording.asset, asset)
        || (metadata.duration !== undefined && metadata.duration > 360)))) throw new Error('cloud_invalid_response');
      return { id: item.id, kind, asset, metadata, ...(recording ? { recording } : {}) };
    });
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('cloud_invalid_response');
    return { items, ...(page.cursor ? { cursor: page.cursor } : {}) };
  };
  const libraryMetadata = async (kind: ManagedAudioItem['kind'], id: string, transfer: CloudTransfer = {}): Promise<LibraryMetadata> => {
    const assert = operation(transfer, true);
    const result = await client.request<{ metadata: LibraryMetadata }>(`${libraryPath(kind, id)}/metadata`, { signal: transfer.signal });
    assert(); return metadataValue(result.metadata);
  };
  const putLibraryMetadata = async (kind: ManagedAudioItem['kind'], id: string, revision: number,
    value: Pick<LibraryMetadata, 'title' | 'artist' | 'bpm'>, transfer: CloudTransfer = {}): Promise<LibraryMetadata> => {
    const assert = operation(transfer, true);
    metadataValue({ ...value, revision });
    const body = { title: value.title, artist: value.artist, ...(value.bpm === undefined ? {} : { bpm: value.bpm }) };
    const result = await client.request<{ metadata: LibraryMetadata }>(`${libraryPath(kind, id)}/metadata`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': `"${revision}"` }, body: JSON.stringify(body), signal: transfer.signal,
    });
    assert();
    const metadata = metadataValue(result.metadata);
    if (metadata.revision !== revision + 1) throw new Error('cloud_invalid_response');
    return metadata;
  };
  const recordLibraryIntake = async (kind: ManagedAudioItem['kind'], id: string, filename: string, duration: number, transfer: CloudTransfer = {}): Promise<LibraryMetadata> => {
    const assert = operation(transfer, true);
    validateLibraryIntake(kind, filename, duration);
    const result = await client.request<{ metadata: LibraryMetadata }>(`${libraryPath(kind, id)}/intake`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"0"' }, body: JSON.stringify({ filename, duration }), signal: transfer.signal });
    assert();
    const metadata = metadataValue(result.metadata);
    if (metadata.revision !== 1 || metadata.filename !== filename || metadata.duration !== duration) throw new Error('cloud_invalid_response');
    return metadata;
  };
  const libraryUsage = async (kind: ManagedAudioItem['kind'], id: string, cursor?: string, transfer: CloudTransfer = {}): Promise<LibraryUsagePage> => {
    const assert = operation(transfer, true);
    const result = await client.request<LibraryUsagePage>(`${libraryPath(kind, id)}/usage${pageCursor(cursor)}`, { signal: transfer.signal });
    assert(); pageCursor(result.cursor);
    if (typeof result.complete !== 'boolean' || !Array.isArray(result.references) || result.references.length > 512
      || result.references.some(reference => !['routine', 'playlist', 'class', 'filler'].includes(reference.kind) || !safeId(reference.id)
        || typeof reference.name !== 'string' || reference.name.length > 300
        || (reference.revision !== undefined && (!Number.isSafeInteger(reference.revision) || reference.revision < 1)))) throw new Error('cloud_invalid_response');
    return structuredClone(result);
  };
  const deleteLibraryItem = async (kind: ManagedAudioItem['kind'], id: string, revision: number, transfer: CloudTransfer = {}): Promise<LibraryDeleteResult> => {
    const assert = operation(transfer, true);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('cloud_invalid_response');
    const result = await client.requestJson<LibraryDeleteResult>(libraryPath(kind, id), {
      method: 'DELETE', headers: { 'If-Match': `"${revision}"` }, signal: transfer.signal,
    });
    assert();
    if (!result.body || typeof result.body !== 'object') throw new Error('cloud_invalid_response');
    if (result.status === 200 && 'deleted' in result.body && result.body.deleted === true && result.body.bytesRetained === true) return result.body;
    if (result.status === 202 && 'pending' in result.body && result.body.pending === true) return result.body;
    throw new Error('cloud_invalid_response');
  };
  return { list, open, readHead, download, downloadTracks, stage, commit, save, replace, command, uploadAsset, audioPage, fillerAnalysis, listFillers, addFiller, removeFiller, ensureFiller, prepareFiller,
    managedPage, libraryMetadata, putLibraryMetadata, recordLibraryIntake, libraryUsage, deleteLibraryItem };
}