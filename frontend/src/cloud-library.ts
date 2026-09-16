import type { CloudAsset, CloudRoutine, CloudRoutineSummary } from '../../shared/cloud-contract';
import { validFillerRecording, validateRoutine, type Filler, type FillerRecording, type Routine, type Track } from '../../shared/routine';
import { cloudClient, CLOUD_CHUNK_BYTES, CloudRequestError, type CloudClient } from './cloud-client';
import { cacheCloudRoutine, cacheCloudTrack, cacheFillerRecording, getFillerRecordingBlob, getTrackBlob } from './offline';

export const MAX_CLOUD_MEDIA_BYTES = 128 * 1024 * 1024;
const CLOUD_DOWNLOAD_CONCURRENCY = 2;
const downloadQueue: Array<() => void> = [];
let activeDownloads = 0;

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
  return [routine.filler, ...routine.tracks.flatMap(track => track.after?.mode === 'custom' ? [track.after.filler] : [])];
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
      || Object.keys(envelope.media).length !== envelope.routine.tracks.length) throw new Error();
    const media: Record<string, CloudAsset> = {};
    for (const track of envelope.routine.tracks) {
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
  const knownRecordings = new Map<string, FillerRecording>();
  const addedRecordings = new Map<string, FillerRecording>();
  const attempts = new Map<string, UploadAttempt>();
  const activeUploads = new Set<string>();
  let uploadOwner = '';
  const operation = (transfer: CloudTransfer, write = false) => {
    const assertIdentity = client.captureIdentity();
    if (write && !['owner', 'editor'].includes(client.getRole() ?? '')) throw new CloudRequestError('forbidden', 403);
    const user = client.getUser()!;
    const owner = JSON.stringify([user.id, user.authVersion, user.role]);
    if (owner !== uploadOwner) {
      uploaded.clear(); attempts.clear(); knownRecordings.clear(); addedRecordings.clear(); uploadOwner = owner;
    }
    const assert = () => {
      assertIdentity();
      if (transfer.signal?.aborted) throw new CloudRequestError('cancelled');
    };
    assert();
    return assert;
  };
  const rememberRecording = (envelope: CloudRoutine) => {
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
    const total = snapshot.routine.tracks.reduce((sum, track) => sum + snapshot.media[track.id]!.bytes,
      recordings.reduce((sum, recording) => sum + recording.asset.bytes, 0));
    let completed = 0;
    const progress = (bytes: number) => { completed += bytes; transfer.progress?.(completed, total); };
    for (const track of snapshot.routine.tracks) {
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
      const asset = await uploadAsset(blob, transfer);
      assert();
      result = recordingDescriptor(await client.request('/api/fillers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: transfer.signal,
        body: JSON.stringify({ name: recording.name, duration: recording.duration, asset }),
      }));
      assert();
      if (result.name !== recording.name || result.duration !== recording.duration || !sameAsset(result.asset, asset)) {
        throw new Error('cloud_invalid_response');
      }
      addedRecordings.set(key, result);
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
  const save = async (routine: Routine, previous: CloudRoutine | null, action: 'save' | 'lock' = 'save', transfer: CloudTransfer = {}) => {
    const assert = operation(transfer, true);
    const snapshot = structuredClone(routine);
    if (validateRoutine(snapshot).length) throw new Error('invalid_routine');
    if (snapshot.published || previous?.routine.published) throw new Error('cloud_head_required');
    if (snapshot.locked || previous?.routine.locked) throw new CloudRequestError('cloud_http_error', 423, 'routine_locked');
    if (previous && (snapshot.id !== previous.routine.id || snapshot.revision !== previous.routine.revision
      || snapshot.published !== previous.routine.published)) throw new Error('cloud_head_required');
    if (!previous && action === 'lock') throw new Error('cloud_save_first');
    if (previous) rememberRecording(previous);
    const media: Record<string, CloudAsset> = {};
    let completed = 0;
    const fillers = routineFillers(snapshot).filter(filler => filler.recording);
    const total = snapshot.tracks.length + fillers.length;
    for (const filler of fillers) {
      Object.assign(filler, await prepareFiller(filler, { signal: transfer.signal }));
      assert();
      transfer.progress?.(++completed, total);
    }
    for (const track of snapshot.tracks) {
      assert();
      const known = previous && Object.hasOwn(previous.media, track.id) ? previous.media[track.id] : undefined;
      const blob = await readBlob(track.id);
      assert();
      if (!blob) throw new Error('missing_audio');
      const reusable = known && blob.size === known.bytes && canonicalAudioType(blob.type) === known.contentType
        && await cloudHash(blob) === known.sha256;
      assert();
      if (reusable) media[track.id] = assetDescriptor(known);
      else {
        let bytes = 0;
        if (known) track.id = crypto.randomUUID();
        media[track.id] = await upload(blob, transfer, assert, increment => {
          bytes += increment;
          transfer.progress?.(completed + bytes / blob.size, total);
        });
      }
      completed++;
      transfer.progress?.(completed, total);
    }
    assert();
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
  return { list, open, readHead, download, downloadTracks, save, replace, command, uploadAsset, listFillers, addFiller, removeFiller, ensureFiller, prepareFiller };
}