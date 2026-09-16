import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { newRoutine, validateRoutine, type FillerRecording } from '../shared/routine';
import { hostedInvalidationEvent, hostedResetKey, hostedUserKey } from '../frontend/src/hosted-session';
import { AAC_IMPORT } from '../shared/audio-import';
import { newMusicPlaylist, type ClassSetup, type MusicPlaylist } from '../shared/class-plan';

const conversion = vi.hoisted(() => vi.fn<(file: File, options?: { signal?: AbortSignal }) => Promise<{ blob: Blob; duration: number }>>());
vi.mock('../frontend/src/audio-conversion', () => ({ convertToM4a: conversion }));

const storage = vi.hoisted(() => ({
  version: 0, queue: Promise.resolve(), opens: 0, transactions: 0, aborts: 0,
  onOpen: undefined as (() => void | Promise<void>) | undefined,
  onTransaction: undefined as (() => void) | undefined,
  onRequest: undefined as ((store: string, method: string) => void | Promise<void>) | undefined,
}));
const stores = vi.hoisted(() => ({
  tracks: new Map<string, unknown>(), routines: new Map<string, unknown>(), meta: new Map<string, unknown>(),
  cloudRoutines: new Map<string, unknown>(),
  fillerRecordings: new Map<string, unknown>(),
  routineHistory: new Map<string, unknown>(), cloudRoutineHistory: new Map<string, unknown>(),
  musicPlaylists: new Map<string, unknown>(), musicPlaylistHistory: new Map<string, unknown>(),
  cloudMusicPlaylists: new Map<string, unknown>(), classSetups: new Map<string, unknown>(),
  classSetupHistory: new Map<string, unknown>(), cloudClassSetups: new Map<string, unknown>(),
}));
vi.mock('../frontend/node_modules/idb/build/index.js', () => ({
  openDB: async (_name: string, version: number, options: { upgrade: (...args: unknown[]) => void }) => {
    storage.opens++;
    const objectStore = (store: keyof typeof stores) => ({
      get: async (key: string) => structuredClone(stores[store].get(key)),
      getAll: async () => structuredClone([...stores[store].values()]),
      put: async (value: unknown, key: string) => stores[store].set(key, structuredClone(value)),
      delete: async (key: string) => stores[store].delete(key),
    });
    const connection = {
      get: (store: keyof typeof stores, key: string) => objectStore(store).get(key),
      getAll: (store: keyof typeof stores) => objectStore(store).getAll(),
      put: (store: keyof typeof stores, value: unknown, key: string) => objectStore(store).put(value, key),
      close: vi.fn(),
      createObjectStore: vi.fn(),
      transaction: (names: (keyof typeof stores)[], mode = 'readonly') => {
        storage.transactions++;
        const ready = storage.queue;
        let complete!: () => void;
        let reject!: (error: Error) => void;
        const done = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
        storage.queue = done.catch(() => undefined);
        const staged = new Map<keyof typeof stores, Map<string, unknown>>();
        let settled = false;
        let requests = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const scheduleCommit = () => {
          clearTimeout(timer);
          if (settled || requests) return;
          timer = setTimeout(() => {
            if (mode === 'readwrite') {
              for (const [name, entries] of staged) {
                stores[name].clear();
                for (const [key, value] of entries) stores[name].set(key, value);
              }
            }
            settled = true;
            complete();
          }, 0);
        };
        const started = ready.then(() => {
          for (const name of names) staged.set(name, structuredClone(stores[name]));
          scheduleCommit();
        });
        const request = async <Value>(store: keyof typeof stores, method: string,
          operation: (entries: Map<string, unknown>) => Value): Promise<Value> => {
          requests++;
          clearTimeout(timer);
          try {
            await started;
            if (settled) throw new Error('AbortError');
            const result = operation(staged.get(store)!);
            await storage.onRequest?.(store, method);
            if (settled) throw new Error('AbortError');
            return result;
          } finally { requests--; scheduleCommit(); }
        };
        const transaction = {
          objectStore: (store: keyof typeof stores) => ({
            get: (key: string) => request(store, 'get', entries => structuredClone(entries.get(key))),
            getAll: () => request(store, 'getAll', entries => structuredClone([...entries.values()])),
            put: (value: unknown, key: string) => request(store, 'put', entries => entries.set(key, structuredClone(value))),
            delete: (key: string) => request(store, 'delete', entries => entries.delete(key)),
          }),
          done,
          abort: () => {
            if (settled) return;
            storage.aborts++;
            settled = true;
            clearTimeout(timer);
            reject(new Error('AbortError'));
          },
        };
        storage.onTransaction?.();
        return transaction;
      },
    };
    if (storage.version < version) {
      options.upgrade(connection, storage.version, version, { objectStore, abort: vi.fn() });
      storage.version = version;
      await Promise.resolve();
    }
    await storage.onOpen?.();
    return connection;
  },
}));

import {
  addFillerRecording, cacheFillerRecording, getFillerRecordingBlob, listFillerRecordings, removeFillerRecording,
  cacheCloudRoutine, cacheCloudTrack, createDemoRoutine, generateDemoWav, generateLoopSamples,
  getCloudRoutine, getReadiness, getRoutine, getTrackBlob, listRoutines, MAX_DECODED_BYTES,
  MAX_TRACK_BYTES, removeTrack, saveRoutine, publishRoutine, deleteRoutine, setActiveRoutine, storeTrack,
  saveMusicPlaylist, getMusicPlaylist, listMusicPlaylists, saveClassSetup, getClassSetup, listClassSetups,
  deleteMusicPlaylist, deleteClassSetup,
  cacheMusicPlaylist, cacheClassSetup, getCachedMusicPlaylist, getCachedClassSetup, getPreparedClass, getReadinessClass,
} from '../frontend/src/offline';

beforeEach(() => {
  for (const store of Object.values(stores)) store.clear();
  stores.tracks.clear();
  stores.routines.clear();
  stores.meta.clear();
  stores.cloudRoutines.clear();
  stores.fillerRecordings.clear();
  storage.version = 0;
  storage.queue = Promise.resolve();
  storage.opens = 0;
  storage.transactions = 0;
  storage.aborts = 0;
  storage.onOpen = undefined;
  storage.onTransaction = undefined;
  storage.onRequest = undefined;
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_HOSTED_PILOT', 'false');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  conversion.mockReset().mockRejectedValue(new Error('conversion_unavailable'));
});

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

async function sha256(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

const m4aFixtures = new Map<string, Uint8Array<ArrayBuffer>>();

function mockM4aContainer(duration = (9600 - 312) / 48000, channels = 1,
  sampleRate: number = AAC_IMPORT.sampleRate, relocatable = false): Blob {
  const key = `${duration}:${channels}:${sampleRate}:${relocatable}`;
  let bytes = m4aFixtures.get(key);
  if (!bytes) {
    bytes = new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      `anullsrc=sample_rate=${sampleRate}:channel_layout=mono`, '-t', String(duration),
      '-ac', String(channels), '-c:a', AAC_IMPORT.codec, '-profile:a', AAC_IMPORT.profile,
      '-b:a', String(AAC_IMPORT.bitRate), '-map_metadata', '-1',
      '-movflags', `+frag_keyframe+empty_moov${relocatable ? '+default_base_moof+skip_trailer' : ''}`,
      '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1'],
    { maxBuffer: AAC_IMPORT.maxOutputBytes, timeout: 15000 }));
    m4aFixtures.set(key, bytes);
  }
  return new Blob([bytes], { type: AAC_IMPORT.contentType });
}

async function fillerFixture(blob = generateDemoWav(2, 100, 'soft'), id = 'custom'): Promise<FillerRecording> {
  return { id, name: 'Synthetic custom filler', duration: 2,
    asset: { id, sha256: await sha256(blob), bytes: blob.size, contentType: blob.type } };
}

function browserAudio(duration: number, decodeDuration = duration, channels = 2) {
  class MetadataAudio {
    duration = duration;
    onloadedmetadata: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()); }
    removeAttribute() {}
    load() {}
  }
  const decode = vi.fn(async (_bytes: ArrayBuffer) => ({
    duration: decodeDuration, numberOfChannels: channels, length: Math.round(decodeDuration * 44100),
  }));
  vi.stubGlobal('Audio', MetadataAudio);
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  return decode;
}

function nativeMetadataFailure(kind: 'unsupported' | 'protected' | 'timeout') {
  const began = deferred<void>();
  let probes = 0;
  vi.stubGlobal('Audio', class {
    duration = 2;
    onloadedmetadata: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onencrypted: (() => void) | null = null;
    set src(_value: string) {
      const first = ++probes === 1;
      queueMicrotask(() => {
        began.resolve();
        if (!first) this.onloadedmetadata?.();
        else if (kind === 'unsupported') this.onerror?.();
        else if (kind === 'protected') this.onencrypted?.();
      });
    }
    removeAttribute() {}
    load() {}
  });
  return began.promise;
}

describe('native decode deadline', () => {
  it('bounds a hung decode and rejects queued native and conversion imports without overlapping allocations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const began = deferred<void>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const decode = browserAudio(2);
    decode.mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const contexts = vi.fn(function () { return { decodeAudioData: decode }; });
    vi.stubGlobal('OfflineAudioContext', contexts);
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const invalidated = vi.fn();
    events.addEventListener(hostedInvalidationEvent, invalidated);
    const file = new File(['synthetic audio'], 'synthetic.wav', { type: 'audio/wav' });
    const existing = { blob: new Blob(['already prepared audio']) };
    stores.tracks.set('prepared', existing);
    const outcomes = Promise.allSettled([storeTrack(file), storeTrack(file),
      addFillerRecording(new File(['synthetic codec data'], 'synthetic.opus', { type: 'audio/opus' }))]);
    try {
      await began.promise;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(decode).toHaveBeenCalledOnce();
      expect(conversion).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcomes).toEqual([
        { status: 'rejected', reason: new Error('audio_decode_timeout') },
        { status: 'rejected', reason: new Error('audio_decoder_busy') },
        { status: 'rejected', reason: new Error('audio_decoder_busy') },
      ]);
      await expect(storeTrack(file)).rejects.toThrow('audio_decoder_busy');
      expect(contexts).toHaveBeenCalledOnce();
      expect(conversion).not.toHaveBeenCalled();
      expect(storage.opens).toBe(0);
      expect([...stores.tracks]).toEqual([['prepared', existing]]);
      expect(invalidated).not.toHaveBeenCalled();
    } finally {
      decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
      await decoded.promise;
    }
  });

  it('keeps the native allocation guard after cancellation and allows only a post-settlement fresh import', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const began = deferred<void>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const decode = browserAudio(2);
    decode.mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const file = new File(['synthetic audio'], 'synthetic.wav', { type: 'audio/wav' });
    const outcome = Promise.allSettled([storeTrack(file)]);
    await began.promise;
    events.dispatchEvent(new Event(hostedInvalidationEvent));
    const nextOutcome = Promise.allSettled([
      addFillerRecording(new File(['synthetic codec data'], 'synthetic.opus', { type: 'audio/opus' })),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toEqual([{ status: 'rejected', reason: new Error('conversion_aborted') }]);
    expect(await nextOutcome).toEqual([{ status: 'rejected', reason: new Error('audio_decoder_busy') }]);
    expect(decode).toHaveBeenCalledOnce();
    expect(conversion).not.toHaveBeenCalled();
    decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    await decoded.promise;
    expect(storage.opens).toBe(0);
    expect(stores.tracks.size).toBe(0);
    vi.useRealTimers();
    const track = await storeTrack(file);
    expect([...stores.tracks.keys()]).toEqual([track.id]);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'])('ignores a late native %s without committing and permits a fresh retry after settlement', async settle => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const began = deferred<void>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const decode = browserAudio(2);
    decode.mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const file = new File(['synthetic audio'], 'synthetic.wav', { type: 'audio/wav' });
    const outcome = Promise.allSettled([storeTrack(file)]);
    await began.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toEqual([{ status: 'rejected', reason: new Error('audio_decode_timeout') }]);
    if (settle === 'resolve') decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    else decoded.reject(new Error('late native rejection'));
    await decoded.promise.catch(() => undefined);
    expect(storage.opens).toBe(0);
    expect(stores.tracks.size).toBe(0);
    vi.useRealTimers();
    const track = await storeTrack(file);
    expect([...stores.tracks.keys()]).toEqual([track.id]);
    expect(await (await getTrackBlob(track.id))!.arrayBuffer()).toEqual(await file.arrayBuffer());
    expect(decode).toHaveBeenCalledTimes(2);
    expect(conversion).not.toHaveBeenCalled();
  });
});

describe('local package storage', () => {
  it('stores both demo blobs, returns a valid routine, and leaves the active routine alone', async () => {
    const active = await saveRoutine(newRoutine(), null);
    const routine = await createDemoRoutine();
    expect(validateRoutine(routine)).toEqual([]);
    expect(routine.tracks).toHaveLength(2);
    expect(await getRoutine()).toEqual(active);
    expect(await getReadiness(routine)).toEqual({ ready: true, missing: [] });
    expect((await getTrackBlob(routine.tracks[0].id))?.size).toBeLessThan(900000);
    await removeTrack(routine.tracks[1].id);
    expect(await getReadiness(routine)).toEqual({ ready: false, missing: [routine.tracks[1].id] });
  });

  it('generates revisions, requires explicit lock actions, and rejects stale saves after lock/unlock', async () => {
    const routine = newRoutine();
    routine.revision = 90;
    const saved = await saveRoutine(routine, null);
    expect(saved.revision).toBe(1);
    await expect(saveRoutine({ ...saved, locked: true }, 1)).rejects.toThrow('routine_locked');
    const locked = await saveRoutine({ ...saved, name: 'Save and lock' }, 1, 'lock');
    expect(locked).toMatchObject({ revision: 2, locked: true, name: 'Save and lock' });
    await expect(saveRoutine({ ...locked, locked: false }, 2)).rejects.toThrow('routine_locked');
    await expect(saveRoutine({ ...locked, name: 'Hidden edit' }, 2, 'unlock')).rejects.toThrow('routine_locked');
    await expect(saveRoutine(locked, 2)).rejects.toThrow('routine_locked');
    const unlocked = await saveRoutine(locked, 2, 'unlock');
    expect(unlocked).toMatchObject({ revision: 3, locked: false, name: 'Save and lock' });
    await expect(saveRoutine(saved, 1)).rejects.toThrow('routine_conflict');
    expect((await saveRoutine({ ...unlocked, name: 'Edited' }, 3)).revision).toBe(4);
  });

  it('persists the separate one-shot warning and includes it in the unlock content fingerprint', async () => {
    const saved = await saveRoutine({ ...newRoutine(), beepOnceRemaining: 30 }, null);
    expect(await getRoutine(saved.id)).toMatchObject({ beepOnceRemaining: 30 });
    const locked = await saveRoutine(saved, saved.revision, 'lock');
    await expect(saveRoutine({ ...locked, beepOnceRemaining: 10 }, locked.revision, 'unlock'))
      .rejects.toThrow('routine_locked');
    const unlocked = await saveRoutine(locked, locked.revision, 'unlock');
    expect(unlocked.beepOnceRemaining).toBe(30);
    const updated = await saveRoutine({ ...unlocked, beepOnceRemaining: 0 }, unlocked.revision);
    expect(await getRoutine(updated.id)).toMatchObject({ beepOnceRemaining: 0 });
  });

  it('treats missing and zero legacy warning fields as the same disabled setting when unlocking', async () => {
    const legacy = newRoutine();
    delete legacy.beepOnceRemaining;
    const locked = await saveRoutine(legacy, null, 'lock');
    expect(locked.beepOnceRemaining).toBeUndefined();
    const unlocked = await saveRoutine({ ...locked, beepOnceRemaining: 0 }, locked.revision, 'unlock');
    expect(unlocked).toMatchObject({ locked: false, beepOnceRemaining: 0 });
  });

  it('keeps originals when saving a new duplicate ID, selects by ID, and returns detached records', async () => {
    expect(await getRoutine()).toBeNull();
    const original = await saveRoutine(newRoutine(), null, 'lock');
    const duplicate = await saveRoutine({ ...original, id: crypto.randomUUID(), locked: false }, null);
    expect(await getRoutine(original.id)).toEqual(original);
    expect(await getRoutine()).toEqual(duplicate);
    await expect(saveRoutine(duplicate, null)).rejects.toThrow('routine_conflict');
    await expect(saveRoutine({ ...duplicate, id: 'missing' }, 1)).rejects.toThrow('routine_conflict');
    await expect(setActiveRoutine('missing')).rejects.toThrow('routine_not_found');
    expect(await getRoutine()).toEqual(duplicate);
    await setActiveRoutine(original.id);
    expect(await getRoutine()).toEqual(original);
    const list = await listRoutines();
    expect(list).toHaveLength(2);
    list[0].name = 'Changed after listing';
    original.name = 'Changed after save';
    const loaded = (await getRoutine())!;
    loaded.name = 'Changed after reading';
    expect((await getRoutine())?.name).toBe('My barre class');
  });

  it('allows only one same-revision writer and checks the current lock in the transaction', async () => {
    const saved = await saveRoutine(newRoutine(), null);
    const results = await Promise.allSettled([
      saveRoutine(saved, 1, 'lock'), saveRoutine({ ...saved, name: 'Stale writer' }, 1),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('routine_conflict') });
    expect(await getRoutine()).toMatchObject({ locked: true, revision: 2, name: saved.name });
  });

  it.each(['legacy-id', 'active'])('migrates the v1 active record with ID %s and preserves media', async id => {
    const legacy = { ...newRoutine(), id, locked: true, revision: 7 };
    storage.version = 1;
    stores.routines.set('active', legacy);
    stores.tracks.set('legacy-track', { blob: new Blob(['audio']) });
    expect(await getRoutine()).toEqual(legacy);
    expect(await getRoutine(id)).toEqual(legacy);
    expect(await listRoutines()).toEqual([legacy]);
    expect(storage.version).toBe(5);
    expect(stores.meta.get('active')).toBe(id);
    expect(stores.tracks.has('legacy-track')).toBe(true);
  });

  it('refuses removal of media referenced by any saved routine, including inactive unlocked ones', async () => {
    const routine = await createDemoRoutine();
    await saveRoutine(routine, null);
    await saveRoutine(newRoutine(), null);
    await expect(removeTrack(routine.tracks[0].id)).rejects.toThrow('track_referenced');
    expect((await getReadiness(routine)).ready).toBe(true);
    const unrelated = await createDemoRoutine();
    await removeTrack(unrelated.tracks[0].id);
    expect(await getTrackBlob(unrelated.tracks[0].id)).toBeUndefined();
  });

  it('reads saved routines and blobs after a module reload', async () => {
    const routine = await createDemoRoutine();
    await saveRoutine(routine, null);
    vi.resetModules();
    const reloaded = await import('../frontend/src/offline');
    expect(await reloaded.getRoutine()).toEqual(routine);
    expect(await reloaded.getReadiness(routine)).toEqual({ ready: true, missing: [] });
  });

  it('rejects same-length corruption and changed duration metadata', async () => {
    const routine = await createDemoRoutine();
    const first = routine.tracks[0];
    first.duration += 1;
    expect((await getReadiness(routine)).missing).toContain(first.id);
    first.duration -= 1;
    const record = stores.tracks.get(first.id) as { blob: Blob; bytes: number };
    record.blob = new Blob([new Uint8Array(record.bytes)]);
    expect(await getTrackBlob(first.id)).toBeUndefined();
    expect((await getReadiness(routine)).ready).toBe(false);
    expect((await getReadiness(newRoutine())).ready).toBe(false);
  });
});

describe('local routine publication and deletion', () => {
  it('publishes detached immutable history, advances the editable head and preserves audio hashes', async () => {
    const saved = await saveRoutine(await createDemoRoutine(), null);
    const audioHashes = await Promise.all(saved.tracks.map(async track => sha256((await getTrackBlob(track.id))!)));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const publication = await publishRoutine(saved.id, saved.revision);
    const original = structuredClone(publication);
    const originalHash = await sha256(new Blob([JSON.stringify(publication)]));
    expect(publication).toMatchObject({ revision: 2, published: true, locked: false });
    expect(await getRoutine(saved.id, 1)).toEqual(saved);
    const head = (await getRoutine(saved.id))!;
    expect(head).toEqual({ ...original, published: false });
    expect(await listRoutines()).toEqual([head]);
    expect(await getRoutine(saved.id, 2, false)).toEqual(head);
    expect(await getRoutine(saved.id, 1, true)).toBeNull();
    const pinned = await saveClassSetup({ schemaVersion: 1, id: 'draft-variant', name: 'Pinned draft', revision: 1,
      locked: false, published: false, routine: { id: head.id, revision: 2, published: false }, crossfade: 0 }, null);
    publication.name = 'Caller changed return';
    publication.tracks[0].cues[0].note = 'Caller changed cue';
    const updated = await saveRoutine({ ...head, name: 'Next edit', tracks: [...head.tracks].reverse() }, head.revision);
    expect(updated).toMatchObject({ revision: 3, published: false });
    expect(await getRoutine(saved.id, 2)).toEqual(original);
    expect(await getRoutine(saved.id, 2, true)).toEqual(original);
    expect(await sha256(new Blob([JSON.stringify(await getRoutine(saved.id, 2))]))).toBe(originalHash);
    expect((await getPreparedClass(pinned.id))!.routine).toEqual(head);
    expect(await Promise.all(saved.tracks.map(async track => sha256((await getTrackBlob(track.id))!)))).toEqual(audioHashes);
    expect(fetcher).not.toHaveBeenCalled();
    expect(stores.cloudRoutines.size).toBe(0);
  });

  it('preserves legacy published flags in history while saving an editable draft', async () => {
    const legacy = { ...newRoutine(), revision: 7, locked: true, published: true };
    storage.version = 4;
    stores.routines.set(legacy.id, structuredClone(legacy));
    stores.meta.set('active', legacy.id);
    const head = (await getRoutine())!;
    expect(head).toEqual({ ...legacy, published: false });
    expect(stores.routines.get(legacy.id)).toEqual(legacy);
    expect(await getRoutine(legacy.id, 7, true)).toEqual(legacy);
    expect(await getRoutine(legacy.id, 7, false)).toEqual(head);
    const unlocked = await saveRoutine(head, 7, 'unlock');
    expect(unlocked).toMatchObject({ revision: 8, locked: false, published: false });
    expect(await getRoutine(legacy.id, 7)).toEqual(legacy);
    expect(await getRoutine(legacy.id, 7, false)).toEqual(head);
    expect(storage.version).toBe(5);
  });

  it('requires explicit publication and rejects empty routines without moving the head', async () => {
    await expect(saveRoutine({ ...newRoutine(), published: true }, null)).rejects.toThrow('routine_published');
    const saved = await saveRoutine(newRoutine(), null);
    await expect(saveRoutine({ ...saved, published: true }, 1)).rejects.toThrow('routine_published');
    await expect(publishRoutine(saved.id, 1)).rejects.toThrow('invalid_routine');
    expect(await getRoutine(saved.id)).toEqual(saved);
    expect(await getRoutine(saved.id, 2)).toBeNull();
  });

  it.each(['missing-track', 'corrupt-track', 'missing-filler', 'corrupt-filler'])(
    'rejects %s during read-only publication preflight without creating history', async fault => {
      const routine = await createDemoRoutine();
      if (fault.endsWith('filler')) {
        const blob = generateDemoWav(2, 100, 'soft');
        const recording = await fillerFixture(blob);
        routine.tracks[0].after = { mode: 'custom', filler: { ...routine.filler, mode: 'hold', sound: 'recording', recording } };
        if (fault === 'corrupt-filler') stores.tracks.set('filler-custom', {
          blob: new Blob([new Uint8Array(blob.size)], { type: blob.type }), bytes: blob.size, duration: 2, sha256: recording.asset.sha256,
        });
      } else if (fault === 'missing-track') stores.tracks.delete(routine.tracks[0].id);
      else {
        const record = stores.tracks.get(routine.tracks[0].id) as { blob: Blob; bytes: number };
        record.blob = new Blob([new Uint8Array(record.bytes)]);
      }
      const saved = await saveRoutine(routine, null);
      const history = structuredClone(stores.routineHistory);
      await expect(publishRoutine(saved.id, 1)).rejects.toThrow('missing_audio');
      expect(await getRoutine(saved.id)).toEqual(saved);
      expect(stores.routineHistory).toEqual(history);
    },
  );

  it.each(['lock', 'lock-unlock', 'delete'])(
    'rechecks the same head after a %s race during publication hashing', async action => {
      const saved = await saveRoutine(await createDemoRoutine(), null);
      const began = deferred<void>();
      const resume = deferred<void>();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
        began.resolve();
        await resume.promise;
        return digest(...args);
      });
      const outcome = Promise.allSettled([publishRoutine(saved.id, 1)]);
      await began.promise;
      if (action === 'delete') await deleteRoutine(saved.id, 1);
      else {
        const locked = await saveRoutine(saved, 1, 'lock');
        if (action === 'lock-unlock') await saveRoutine(locked, 2, 'unlock');
      }
      const history = structuredClone(stores.routineHistory);
      resume.resolve();
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('routine_conflict') });
      expect(stores.routineHistory).toEqual(history);
    },
  );

  it('checks locked heads and stale delete/publish revisions across unlock', async () => {
    const saved = await saveRoutine(await createDemoRoutine(), null);
    const locked = await saveRoutine(saved, 1, 'lock');
    await expect(deleteRoutine(saved.id, 2)).rejects.toThrow('routine_locked');
    await expect(publishRoutine(saved.id, 2)).rejects.toThrow('routine_locked');
    const unlocked = await saveRoutine(locked, 2, 'unlock');
    for (const stale of [1, 2]) {
      await expect(deleteRoutine(saved.id, stale)).rejects.toThrow('routine_conflict');
      await expect(publishRoutine(saved.id, stale)).rejects.toThrow('routine_conflict');
    }
    const publication = await publishRoutine(saved.id, unlocked.revision);
    await expect(saveRoutine(unlocked, unlocked.revision, 'lock')).rejects.toThrow('routine_conflict');
    await expect(deleteRoutine(saved.id, unlocked.revision)).rejects.toThrow('routine_conflict');
    expect(await getRoutine(saved.id, publication.revision)).toEqual(publication);
  });

  it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, '1'])(
    'rejects invalid expected revision %s on every new mutation', async expected => {
      const revision = expected as number;
      await expect(publishRoutine('missing', revision)).rejects.toThrow('routine_conflict');
      await expect(deleteRoutine('missing', revision)).rejects.toThrow('routine_conflict');
      await expect(deleteMusicPlaylist('missing', revision)).rejects.toThrow('playlist_conflict');
      await expect(deleteClassSetup('missing', revision)).rejects.toThrow('class_setup_conflict');
      expect(storage.opens).toBe(0);
    },
  );

  it('hides deleted routines, retains every revision/media, clears only matching selection and reserves IDs', async () => {
    const saved = await saveRoutine(await createDemoRoutine(), null);
    const publication = await publishRoutine(saved.id, 1);
    const other = await saveRoutine(newRoutine(), null);
    await cacheCloudRoutine(publication);
    const cloud = structuredClone(stores.cloudRoutineHistory);
    await deleteRoutine(saved.id, publication.revision);
    expect(await getRoutine()).toEqual(other);
    expect(await getRoutine(saved.id)).toBeNull();
    expect(await listRoutines()).toEqual([other]);
    expect(await getRoutine(saved.id, 1)).toEqual(saved);
    expect(await getRoutine(saved.id, 2, true)).toEqual(publication);
    expect(await getRoutine(saved.id, 2, false)).toEqual({ ...publication, published: false });
    await expect(setActiveRoutine(saved.id)).rejects.toThrow('routine_not_found');
    await expect(saveRoutine({ ...saved, revision: 2 }, null)).rejects.toThrow('routine_conflict');
    await expect(saveRoutine({ ...saved, revision: 2 }, 2)).rejects.toThrow('routine_conflict');
    await expect(deleteRoutine(saved.id, 2)).rejects.toThrow('routine_not_found');
    await expect(publishRoutine(saved.id, 2)).rejects.toThrow('routine_not_found');
    await expect(removeTrack(saved.tracks[0].id)).rejects.toThrow('track_referenced');
    expect((await getReadiness(publication)).ready).toBe(true);
    expect(await getCloudRoutine(saved.id, 2, true)).toEqual(publication);
    expect(stores.cloudRoutineHistory).toEqual(cloud);
    await deleteRoutine(other.id, 1);
    expect(await getRoutine()).toBeNull();
    expect(stores.meta.has('active')).toBe(false);
    expect(await listRoutines()).toEqual([]);
    vi.resetModules();
    const reloaded = await import('../frontend/src/offline');
    expect(await reloaded.getRoutine(saved.id)).toBeNull();
    expect(await reloaded.getRoutine(saved.id, 2)).toEqual(publication);
    expect(storage.version).toBe(5);
  });
});

describe('class package storage', () => {
  const setupFor = (routine: ReturnType<typeof newRoutine>): ClassSetup => ({
    schemaVersion: 1, id: 'class-one', name: 'Class', revision: 1, locked: false, published: false,
    routine: { id: routine.id, revision: routine.revision, published: routine.published }, crossfade: 1,
  });

  it('keeps a locked published class resolvable after local playlist/routine deletion without touching cloud copies', async () => {
    const savedRoutine = await saveRoutine(await createDemoRoutine(), null);
    const routine = await publishRoutine(savedRoutine.id, 1);
    const draftPlaylist = await saveMusicPlaylist({ ...newMusicPlaylist(), tracks: routine.tracks.map(track => ({ ...track, cues: [] })) }, null);
    const playlist = await saveMusicPlaylist(draftPlaylist, 1, 'publish');
    const blob = generateDemoWav(2, 100, 'soft');
    const recording = await fillerFixture(blob);
    browserAudio(2);
    await cacheFillerRecording(recording, blob);
    const draft = await saveClassSetup({ ...setupFor(routine),
      walkIn: { id: playlist.id, revision: 2, published: true },
      before: { ...routine.filler, mode: 'hold', sound: 'recording', recording } }, null);
    const publication = await saveClassSetup(draft, 1, 'publish');
    const head = (await getClassSetup(draft.id))!;
    const locked = await saveClassSetup(head, 2, 'lock');
    const pinned = await getPreparedClass(publication.id, 2, 'local', true);
    await cacheCloudRoutine(routine);
    const media = Object.fromEntries(playlist.tracks.map(track => {
      const record = stores.tracks.get(track.id) as { blob: Blob; bytes: number; sha256: string };
      return [track.id, { id: track.id, sha256: record.sha256, bytes: record.bytes, contentType: record.blob.type }];
    }));
    await cacheMusicPlaylist({ playlist, media });
    await cacheClassSetup(publication);
    await deleteMusicPlaylist(playlist.id, 2);
    await deleteRoutine(routine.id, 2);
    expect(await listMusicPlaylists()).toEqual([]);
    expect(await getMusicPlaylist(playlist.id)).toBeNull();
    expect(await getMusicPlaylist(playlist.id, 2)).toEqual(playlist);
    expect(await getPreparedClass(publication.id, 2, 'local', true)).toEqual(pinned);
    expect((await getPreparedClass(locked.id))!.audio).toEqual(pinned!.audio);
    await expect(deleteClassSetup(locked.id, 3)).rejects.toThrow('class_setup_locked');
    const unlocked = await saveClassSetup(locked, 3, 'unlock');
    for (const stale of [2, 3]) await expect(deleteClassSetup(locked.id, stale)).rejects.toThrow('class_setup_conflict');
    await deleteClassSetup(unlocked.id, 4);
    expect(await listClassSetups()).toEqual([]);
    expect(await getClassSetup(unlocked.id)).toBeNull();
    expect(await getPreparedClass(unlocked.id)).toBeNull();
    expect(await getClassSetup(unlocked.id, 2)).toEqual(publication);
    expect(await getPreparedClass(unlocked.id, 2, 'local', true)).toEqual(pinned);
    expect(await getPreparedClass(unlocked.id, 2, 'cloud', true)).toEqual(pinned);
    expect(await getCachedMusicPlaylist(playlist.id, 2, true)).toEqual({ playlist, media });
    expect(await getCachedClassSetup(unlocked.id, 2, true)).toEqual(publication);
    await expect(saveMusicPlaylist(draftPlaylist, null)).rejects.toThrow('playlist_conflict');
    await expect(saveMusicPlaylist({ ...playlist, published: false }, 2)).rejects.toThrow('playlist_conflict');
    await expect(saveClassSetup(unlocked, null)).rejects.toThrow('class_setup_conflict');
    await expect(saveClassSetup(unlocked, 4)).rejects.toThrow('class_setup_conflict');
    await expect(removeTrack(routine.tracks[0].id)).rejects.toThrow('track_referenced');
    await expect(removeTrack('filler-custom')).rejects.toThrow('track_referenced');
    expect((await getReadinessClass(pinned!.routine, pinned!.audio)).ready).toBe(true);
  });

  it('serializes playlist/class deletes against locks and preserves unrelated catalogs', async () => {
    const routine = await saveRoutine(newRoutine(), null);
    const playlist = await saveMusicPlaylist(newMusicPlaylist(), null);
    const otherPlaylist = await saveMusicPlaylist(newMusicPlaylist(), null);
    const setup = await saveClassSetup(setupFor(routine), null);
    const otherSetup = await saveClassSetup({ ...setupFor(routine), id: 'class-other' }, null);
    const playlistRace = await Promise.allSettled([saveMusicPlaylist(playlist, 1, 'lock'), deleteMusicPlaylist(playlist.id, 1)]);
    const classRace = await Promise.allSettled([saveClassSetup(setup, 1, 'lock'), deleteClassSetup(setup.id, 1)]);
    expect(playlistRace[1]).toMatchObject({ status: 'rejected', reason: new Error('playlist_conflict') });
    expect(classRace[1]).toMatchObject({ status: 'rejected', reason: new Error('class_setup_conflict') });
    await expect(deleteMusicPlaylist(playlist.id, 2)).rejects.toThrow('playlist_locked');
    const unlocked = await saveMusicPlaylist((await getMusicPlaylist(playlist.id))!, 2, 'unlock');
    await expect(deleteMusicPlaylist(playlist.id, 1)).rejects.toThrow('playlist_conflict');
    await expect(deleteMusicPlaylist(playlist.id, 2)).rejects.toThrow('playlist_conflict');
    const race = await Promise.allSettled([deleteMusicPlaylist(playlist.id, 3), saveMusicPlaylist(unlocked, 3, 'publish')]);
    expect(race[0].status).toBe('fulfilled');
    expect(race[1]).toMatchObject({ status: 'rejected', reason: new Error('playlist_conflict') });
    expect(await listMusicPlaylists()).toEqual([otherPlaylist]);
    expect(await getClassSetup(otherSetup.id)).toEqual(otherSetup);
    expect(await getRoutine()).toEqual(routine);
    await expect(deleteMusicPlaylist('absent', 1)).rejects.toThrow('playlist_not_found');
    await expect(deleteClassSetup('absent', 1)).rejects.toThrow('class_setup_not_found');
  });

  it('keeps exact routine and playlist history with CAS, detached reads and no latest fallback', async () => {
    const routine = await saveRoutine(await createDemoRoutine(), null);
    const playlist = await saveMusicPlaylist({ ...newMusicPlaylist(), tracks: routine.tracks.map(track => ({ ...track, cues: [] })) }, null);
    const saved = await saveClassSetup({ ...setupFor(routine), walkIn: { id: playlist.id, revision: 1, published: false } }, null);
    const prepared = await getPreparedClass(saved.id);
    const updated = await saveMusicPlaylist({ ...playlist, name: 'New order', tracks: [...playlist.tracks].reverse() }, 1);
    await saveRoutine({ ...routine, name: 'New routine' }, 1);
    expect(await getRoutine(routine.id, 1)).toEqual(routine);
    expect(await getRoutine(routine.id, 99)).toBeNull();
    expect(await getMusicPlaylist(playlist.id, 1)).toEqual(playlist);
    expect(await getMusicPlaylist(playlist.id, 99)).toBeNull();
    expect(await getPreparedClass(saved.id)).toEqual(prepared);
    expect(await getClassSetup(saved.id, 99)).toBeNull();
    expect(await getMusicPlaylist(playlist.id)).toEqual(updated);
    await expect(saveMusicPlaylist(playlist, 1)).rejects.toThrow('playlist_conflict');
    prepared!.audio.walkIn!.tracks.reverse();
    expect((await getPreparedClass(saved.id))!.audio.walkIn!.tracks).toEqual(playlist.tracks);
    expect(await listMusicPlaylists()).toHaveLength(1);
    expect(await listClassSetups()).toHaveLength(1);
  });

  it('requires explicit playlist lock/unlock, serializes writers and rejects state mass assignment', async () => {
    const saved = await saveMusicPlaylist(newMusicPlaylist(), null);
    await expect(saveMusicPlaylist({ ...saved, locked: true }, 1)).rejects.toThrow('playlist_locked');
    await expect(saveMusicPlaylist({ ...saved, published: true }, 1)).rejects.toThrow('playlist_published');
    const results = await Promise.allSettled([saveMusicPlaylist(saved, 1, 'lock'), saveMusicPlaylist(saved, 1)]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('playlist_conflict') });
    const locked = (await getMusicPlaylist(saved.id))!;
    await expect(saveMusicPlaylist({ ...locked, name: 'Hidden edit' }, 2, 'unlock')).rejects.toThrow('playlist_locked');
    await expect(saveMusicPlaylist(locked, 2, 'publish')).rejects.toThrow('playlist_locked');
    const unlocked = await saveMusicPlaylist(locked, 2, 'unlock');
    const published = await saveMusicPlaylist(unlocked, 3, 'publish');
    expect(published).toMatchObject({ published: true, revision: 4 });
    const draft = (await getMusicPlaylist(saved.id))!;
    const routine = await saveRoutine(newRoutine(), null);
    const setup = await saveClassSetup({ ...setupFor(routine), walkIn: { id: draft.id, revision: 4, published: false } }, null);
    await saveMusicPlaylist({ ...draft, name: 'Next draft' }, 4);
    expect(await getMusicPlaylist(saved.id, 4)).toEqual(published);
    expect((await getPreparedClass(setup.id))!.audio.walkIn).toEqual(draft);
  });

  it('class publications require exact published refs and retain immutable announcements', async () => {
    const savedRoutine = await saveRoutine(await createDemoRoutine(), null);
    const routine = await publishRoutine(savedRoutine.id, savedRoutine.revision);
    const draftPlaylist = await saveMusicPlaylist(newMusicPlaylist(), null);
    const draft = await saveClassSetup({ ...setupFor(routine), walkIn: { id: draftPlaylist.id, revision: 1, published: false } }, null);
    await expect(saveClassSetup(draft, 1, 'publish')).rejects.toThrow('class_reference_unpublished');
    const playlist = await saveMusicPlaylist(draftPlaylist, 1, 'publish');
    const saved = await saveClassSetup({ ...draft, walkIn: { id: playlist.id, revision: playlist.revision, published: true } }, 1);
    const published = await saveClassSetup(saved, 2, 'publish');
    expect(published).toMatchObject({ revision: 3, published: true });
    expect(await getClassSetup(saved.id, 3)).toEqual(published);
    await expect(saveClassSetup({ ...(await getClassSetup(saved.id))!, routine: { ...saved.routine, revision: 99 } }, 3))
      .rejects.toThrow('class_reference_unavailable');
    expect((await getPreparedClass(saved.id, 3))!.audio.walkIn).toEqual(playlist);
  });

  it('keeps cloud envelopes separate from editable entities and rejects immutable-cache replacement', async () => {
    const playlist = { ...newMusicPlaylist(), revision: 20, published: true };
    await cacheMusicPlaylist({ playlist, media: {} });
    expect(await getMusicPlaylist(playlist.id)).toBeNull();
    expect(await listMusicPlaylists()).toEqual([]);
    expect(await getCachedMusicPlaylist(playlist.id, 20)).toEqual({ playlist, media: {} });
    expect(await getCachedMusicPlaylist(playlist.id, 19)).toBeNull();
    await expect(cacheMusicPlaylist({ playlist: { ...playlist, name: 'Overwrite' }, media: {} })).rejects.toThrow('playlist_conflict');
    const routine = { ...newRoutine(), revision: 8, published: true };
    await cacheCloudRoutine(routine);
    const setup = { ...setupFor(routine), published: true, walkOut: { id: playlist.id, revision: 20, published: true } };
    await cacheClassSetup(setup);
    expect(await getClassSetup(setup.id)).toBeNull();
    expect(await getCachedClassSetup(setup.id, 1)).toEqual(setup);
    expect((await getPreparedClass(setup.id, 1, 'cloud'))!.audio.walkOut).toEqual(playlist);
    await cacheCloudRoutine({ ...routine, revision: 9, name: 'Later' });
    expect((await getPreparedClass(setup.id, 1, 'cloud'))!.routine).toEqual(routine);
    await saveMusicPlaylist({ ...playlist, published: false }, null);
    expect((await getMusicPlaylist(playlist.id))!.revision).toBe(1);
    expect((await getCachedMusicPlaylist(playlist.id))!.playlist.revision).toBe(20);
  });

  it('pins cloud draft and publication variants of the same exact revision independently', async () => {
    const routine = { ...newRoutine(), revision: 4 };
    await cacheCloudRoutine(routine);
    await cacheCloudRoutine({ ...routine, published: true });
    expect(await getCloudRoutine(routine.id, 4, false)).toEqual(routine);
    expect(await getCloudRoutine(routine.id, 4, true)).toEqual({ ...routine, published: true });
    const playlist = { ...newMusicPlaylist(), revision: 6 };
    await cacheMusicPlaylist({ playlist, media: {} });
    await cacheMusicPlaylist({ playlist: { ...playlist, published: true }, media: {} });
    expect((await getCachedMusicPlaylist(playlist.id, 6, false))!.playlist).toEqual(playlist);
    const setup = { ...setupFor(routine), walkIn: { id: playlist.id, revision: 6, published: false } };
    await cacheClassSetup(setup);
    const publication = { ...setup, published: true, routine: { ...setup.routine, published: true }, walkIn: { ...setup.walkIn, published: true } };
    await cacheClassSetup(publication);
    expect(await getCachedClassSetup(setup.id, 1, false)).toEqual(setup);
    expect(await getCachedClassSetup(setup.id, 1, true)).toEqual(publication);
    expect((await getPreparedClass(setup.id, 1, 'cloud', false))!.routine.published).toBe(false);
    expect((await getPreparedClass(setup.id, 1, 'cloud', true))!.routine.published).toBe(true);
  });

  it.each(['archive', 'deleted', 'media', 'owner'])('rejects unsupported playlist field %s instead of persisting it', async key => {
    await expect(saveMusicPlaylist({ ...newMusicPlaylist(), [key]: true }, null)).rejects.toThrow('invalid_playlist');
    expect(await listMusicPlaylists()).toEqual([]);
  });

  it('rejects malformed announcements and strict nested descriptor fields', async () => {
    const routine = await saveRoutine(newRoutine(), null);
    const setup = setupFor(routine);
    await expect(saveClassSetup({ ...setup, before: { ...routine.filler, mode: 'timed' } }, null)).rejects.toThrow('invalid_class_setup');
    await expect(saveClassSetup({ ...setup, routine: { ...setup.routine, extra: true } } as ClassSetup, null)).rejects.toThrow('invalid_class_setup');
    await expect(saveClassSetup({ ...setup, archived: true } as ClassSetup, null)).rejects.toThrow('invalid_class_setup');
    await expect(cacheMusicPlaylist({ playlist: { ...newMusicPlaylist(), tracks: [{ id: 'bad' }] } as MusicPlaylist, media: {} }))
      .rejects.toThrow('invalid_cloud_playlist');
  });

  it('checks class playlist descriptor hashes without decoding the full playlist', async () => {
    const routine = await createDemoRoutine();
    const playlist = { ...newMusicPlaylist(), tracks: routine.tracks.map(track => ({ ...track, cues: [] })) };
    const media = Object.fromEntries(playlist.tracks.map(track => {
      const record = stores.tracks.get(track.id) as { blob: Blob; sha256: string; bytes: number };
      return [track.id, { id: track.id, sha256: record.sha256, bytes: record.bytes, contentType: record.blob.type }];
    }));
    const decode = browserAudio(2);
    await cacheMusicPlaylist({ playlist, media });
    expect((await getReadinessClass(routine, { crossfade: 0, walkIn: playlist })).ready).toBe(true);
    const record = stores.tracks.get(playlist.tracks[0].id) as { blob: Blob; sha256: string; bytes: number };
    const bytes = new Uint8Array(await record.blob.arrayBuffer());
    bytes[100] ^= 1;
    record.blob = new Blob([bytes], { type: record.blob.type });
    record.sha256 = await sha256(record.blob);
    expect((await getReadinessClass(routine, { crossfade: 0, walkIn: playlist })).missing).toContain(playlist.tracks[0].id);
    expect(decode).not.toHaveBeenCalled();
  });

  it('protects historical playlists, cloud playlists, class announcements and custom after recordings from deletion', async () => {
    const routine = await createDemoRoutine();
    const playlist = await saveMusicPlaylist({ ...newMusicPlaylist(), tracks: routine.tracks.map(track => ({ ...track, cues: [] })) }, null);
    await saveMusicPlaylist({ ...playlist, tracks: [] }, 1);
    await expect(removeTrack(routine.tracks[0].id)).rejects.toThrow('track_referenced');
    const blob = generateDemoWav(2, 100, 'soft');
    const recording = await fillerFixture(blob);
    browserAudio(2);
    await cacheFillerRecording(recording, blob);
    const filler = { ...routine.filler, sound: 'recording' as const, recording, mode: 'hold' as const };
    const saved = await saveRoutine(routine, null);
    const setup = await saveClassSetup({ ...setupFor(saved), before: filler }, null);
    await saveClassSetup({ ...setup, before: undefined }, 1);
    await expect(removeTrack('filler-custom')).rejects.toThrow('track_referenced');
    const readiness = await getReadinessClass(saved, { crossfade: 1, before: filler, walkOut: playlist });
    expect(readiness.ready).toBe(true);
    stores.tracks.delete('filler-custom');
    saved.tracks[0].after = { mode: 'custom', filler };
    expect((await getReadiness(saved)).missing).toContain('filler-custom');
    expect((await getReadinessClass(routine, { crossfade: 1, after: filler })).missing).toContain('filler-custom');
  });
});

describe('cloud package storage', () => {
  it('preserves local v2 data, exact cloud revisions and detached snapshots across reloads', async () => {
    storage.version = 2;
    const local = { ...newRoutine(), revision: 4, locked: true };
    stores.routines.set(local.id, structuredClone(local));
    stores.meta.set('active', local.id);
    const cloud = { ...local, name: 'Authoritative cloud snapshot', revision: 37 };
    const expected = structuredClone(cloud);
    const pending = cacheCloudRoutine(cloud);
    cloud.name = 'Mutated after invocation';
    await pending;
    expect(storage.version).toBe(5);
    expect(await getRoutine()).toEqual(local);
    expect(await listRoutines()).toEqual([local]);
    expect(await getCloudRoutine(local.id)).toEqual(expected);
    const loaded = (await getCloudRoutine(local.id))!;
    loaded.name = 'Detached read';
    expect(await getCloudRoutine(local.id)).toEqual(expected);
    await expect(saveRoutine({ ...local, name: 'Local bypass' }, 4)).rejects.toThrow('routine_locked');
    const updated = { ...expected, locked: false, revision: 41 };
    await cacheCloudRoutine(updated);
    vi.resetModules();
    const reloaded = await import('../frontend/src/offline');
    expect(await reloaded.getCloudRoutine(local.id)).toEqual(updated);
    expect(await reloaded.getRoutine()).toEqual(local);
    expect(await reloaded.getCloudRoutine('absent')).toBeNull();
    await expect(cacheCloudRoutine({ ...updated, revision: -1 })).rejects.toThrow('invalid_routine');
    expect(await getCloudRoutine(local.id)).toEqual(updated);
  });

  it('keeps cloud-only IDs outside local selection and CAS without reserving unrelated local IDs', async () => {
    const cloud = { ...newRoutine(), revision: 20, locked: true };
    await cacheCloudRoutine(cloud);
    expect(await getRoutine()).toBeNull();
    expect(await getRoutine(cloud.id)).toBeNull();
    expect(await listRoutines()).toEqual([]);
    await expect(setActiveRoutine(cloud.id)).rejects.toThrow('routine_not_found');
    const local = await saveRoutine({ ...newRoutine(), id: cloud.id }, null);
    expect(await getRoutine()).toEqual(local);
    expect(await getCloudRoutine(cloud.id)).toEqual(cloud);
  });

  it('uses entry IDs for repeated immutable assets, validates all tracks without class decoding, and protects references', async () => {
    const decode = browserAudio(2);
    const blob = generateDemoWav(2, 100, 'soft');
    const hash = await sha256(blob);
    const routine = newRoutine();
    routine.tracks = ['entry-one', 'entry-two'].map(id => ({
      id, title: id, duration: 2, bpm: 100, firstBeat: 0, cues: [], bodyArea: '',
    }));
    const media = Object.fromEntries(routine.tracks.map(track => [track.id, {
      id: 'immutable-asset', sha256: hash, bytes: blob.size, contentType: blob.type,
    }]));
    for (const track of routine.tracks) await cacheCloudTrack(track.id, blob, media[track.id].sha256);
    expect(await getTrackBlob('immutable-asset')).toBeUndefined();
    for (const track of routine.tracks) expect(await (await getTrackBlob(track.id))!.arrayBuffer()).toEqual(await blob.arrayBuffer());
    expect(decode).toHaveBeenCalledTimes(2);
    decode.mockClear();
    expect(await getReadiness(routine)).toEqual({ ready: true, missing: [] });
    expect(decode).not.toHaveBeenCalled();
    await cacheCloudRoutine(routine);
    await expect(removeTrack(routine.tracks[0].id)).rejects.toThrow('track_referenced');
    const record = stores.tracks.get(routine.tracks[1].id) as { blob: Blob };
    record.blob = new Blob([new Uint8Array(blob.size)], { type: blob.type });
    expect(await getReadiness(routine)).toEqual({ ready: false, missing: ['entry-two'] });
  });

  it('never overwrites an existing cloud or local ID with different bytes, even under concurrent imports', async () => {
    browserAudio(2);
    const first = generateDemoWav(2, 100, 'soft');
    const second = generateDemoWav(2, 100, 'drums');
    const firstHash = await sha256(first);
    const secondHash = await sha256(second);
    const results = await Promise.allSettled([
      cacheCloudTrack('entry', first, firstHash), cacheCloudTrack('entry', second, secondHash),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('track_conflict') });
    await cacheCloudTrack('entry', first, firstHash);
    expect(await (await getTrackBlob('entry'))!.arrayBuffer()).toEqual(await first.arrayBuffer());
    const local = await storeTrack(new File([first], 'local.wav', { type: first.type }));
    await expect(cacheCloudTrack(local.id, second, secondHash)).rejects.toThrow('track_conflict');
    expect(await (await getTrackBlob(local.id))!.arrayBuffer()).toEqual(await first.arrayBuffer());
  });

  it('requires a new entry ID for a changed cloud asset while a prepared snapshot keeps its original bytes', async () => {
    const decode = browserAudio(2);
    const first = generateDemoWav(2, 100, 'soft');
    const replacement = generateDemoWav(2, 100, 'drums');
    const firstHash = await sha256(first);
    const replacementHash = await sha256(replacement);
    const routine = newRoutine();
    routine.tracks = [{ id: 'entry', title: 'Prepared song', duration: 2, bpm: 100, firstBeat: 0, cues: [], bodyArea: '' }];
    await cacheCloudTrack('entry', first, firstHash);
    await cacheCloudRoutine(routine);
    const snapshot = (await getCloudRoutine(routine.id))!;
    await expect(cacheCloudTrack('entry', replacement, replacementHash)).rejects.toThrow('track_conflict');
    await cacheCloudTrack('replacement-entry', replacement, replacementHash);
    expect(await sha256((await getTrackBlob('entry'))!)).toBe(firstHash);
    expect(await sha256((await getTrackBlob('replacement-entry'))!)).toBe(replacementHash);
    decode.mockClear();
    expect(await getReadiness(snapshot)).toEqual({ ready: true, missing: [] });
    expect(await getCloudRoutine(routine.id)).toEqual(snapshot);
    expect(decode).not.toHaveBeenCalled();
  });

  it('compares the record again inside the write transaction to detect another tab winning the ID', async () => {
    browserAudio(2);
    const first = generateDemoWav(2, 100, 'soft');
    const second = generateDemoWav(2, 100, 'drums');
    const hash = await sha256(first);
    const winner = { blob: second, bytes: second.size, duration: 2, sha256: await sha256(second) };
    storage.onTransaction = () => { stores.tracks.set('contested', winner); };
    await expect(cacheCloudTrack('contested', first, hash)).rejects.toThrow('track_conflict');
    expect(stores.tracks.get('contested')).toEqual(winner);
  });

  it.each(['bytes', 'duration', 'missing-hash', 'changed-hash', 'corruption'])(
    'rejects an inconsistent existing %s record without overwriting it', async defect => {
      browserAudio(2);
      const blob = generateDemoWav(2, 100, 'soft');
      const hash = await sha256(blob);
      const previous = {
        blob: defect === 'corruption' ? new Blob([new Uint8Array(blob.size)], { type: blob.type }) : blob,
        bytes: defect === 'bytes' ? blob.size - 1 : blob.size,
        duration: defect === 'duration' ? NaN : 2,
        sha256: defect === 'missing-hash' ? undefined : defect === 'changed-hash' ? '0'.repeat(64) : hash,
      };
      stores.tracks.set('existing', previous);
      await expect(cacheCloudTrack('existing', blob, hash)).rejects.toThrow('track_conflict');
      expect(stores.tracks.get('existing')).toEqual(previous);
    },
  );

  it('requires a SHA-256 match before decoding or opening private storage and fails closed without crypto', async () => {
    const decode = browserAudio(2);
    const blob = generateDemoWav(2, 100, 'soft');
    const hash = await sha256(blob);
    await expect(cacheCloudTrack('', blob, hash)).rejects.toThrow('invalid_track_id');
    await expect(cacheCloudTrack('entry', blob, 'not-a-hash')).rejects.toThrow('invalid_track_hash');
    await expect(cacheCloudTrack('entry', blob, '0'.repeat(64))).rejects.toThrow('track_integrity_failed');
    vi.stubGlobal('crypto', {});
    await expect(cacheCloudTrack('entry', blob, hash)).rejects.toThrow('track_integrity_failed');
    expect(storage.opens).toBe(0);
    expect(decode).not.toHaveBeenCalled();
    expect(stores.tracks.size).toBe(0);
  });

  it('enforces byte, MIME, metadata, decode-duration, channel and decoded-memory bounds', async () => {
    const blob = generateDemoWav(2, 100, 'soft');
    const hash = await sha256(blob);
    const unsupported = new Blob(['text'], { type: 'text/html' });
    const oversized = new Blob(['audio'], { type: 'audio/wav' });
    Object.defineProperty(oversized, 'size', { value: 128 * 1024 * 1024 + 1 });
    const readOversized = vi.spyOn(oversized, 'arrayBuffer');
    await expect(cacheCloudTrack('empty', new Blob(), hash)).rejects.toThrow('audio_byte_limit');
    await expect(cacheCloudTrack('large', oversized, hash)).rejects.toThrow('audio_byte_limit');
    expect(readOversized).not.toHaveBeenCalled();
    await expect(cacheCloudTrack('text', unsupported, await sha256(unsupported))).rejects.toThrow('unsupported_audio');
    const decode = browserAudio(361);
    await expect(cacheCloudTrack('metadata', blob, hash)).rejects.toThrow('audio_duration_limit');
    expect(decode).not.toHaveBeenCalled();
    browserAudio(2, 361);
    await expect(cacheCloudTrack('duration', blob, hash)).rejects.toThrow('audio_duration_limit');
    browserAudio(2, 2, 6);
    await expect(cacheCloudTrack('channels', blob, hash)).rejects.toThrow('audio_memory_limit');
    browserAudio(2).mockResolvedValueOnce({ duration: 2, length: MAX_DECODED_BYTES / 8 + 1, numberOfChannels: 2 });
    await expect(cacheCloudTrack('memory', blob, hash)).rejects.toThrow('audio_memory_limit');
    expect(stores.tracks.size).toBe(0);
  });

  it('serializes cloud preparation with local imports and permits recovery after decode failure', async () => {
    const began = deferred<void>();
    const resume = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const decode = browserAudio(2);
    decode.mockImplementationOnce(() => { began.resolve(); return resume.promise; });
    decode.mockRejectedValueOnce(new Error('unsupported codec'));
    const blob = generateDemoWav(2, 100, 'soft');
    const hash = await sha256(blob);
    const pending = Promise.allSettled([
      storeTrack(new File([blob], 'local.wav', { type: blob.type })),
      cacheCloudTrack('failed', blob, hash), cacheCloudTrack('next', blob, hash),
    ]);
    await began.promise;
    expect(decode).toHaveBeenCalledOnce();
    resume.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    const results = await pending;
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('unsupported_audio') } });
    expect(results[2].status).toBe('fulfilled');
    expect(stores.tracks.has('failed')).toBe(false);
    expect(stores.tracks.size).toBe(2);
  });
});

describe('custom filler storage', () => {
  it.each([2, 3])('adds an empty v4 catalog without changing existing v%s data', async version => {
    storage.version = version;
    const routine = newRoutine();
    stores.routines.set(routine.id, routine);
    stores.meta.set('active', routine.id);
    const blob = generateDemoWav(2, 100, 'soft');
    stores.tracks.set('existing', { blob, bytes: blob.size, duration: 2, sha256: await sha256(blob) });
    if (version === 3) stores.cloudRoutines.set(routine.id, routine);
    expect(await listFillerRecordings()).toEqual([]);
    expect(storage.version).toBe(5);
    expect(await getRoutine()).toEqual(routine);
    expect(await (await getTrackBlob('existing'))!.arrayBuffer()).toEqual(await blob.arrayBuffer());
    if (version === 3) expect(await getCloudRoutine(routine.id)).toEqual(routine);
  });

  it('imports a detached library descriptor and only one reserved blob without changing native source bytes', async () => {
    const decode = browserAudio(2);
    const file = new File([generateDemoWav(2, 100, 'soft')], 'synthetic.wav', { type: 'audio/x-wav' });
    const recording = await addFillerRecording(file, 'My filler');
    expect(recording).toEqual({ id: expect.any(String), name: 'My filler', duration: 2,
      asset: { id: recording.id, sha256: await sha256(file), bytes: file.size, contentType: 'audio/wav' } });
    expect(decode).toHaveBeenCalledOnce();
    expect([...stores.tracks.keys()]).toEqual([`filler-${recording.asset.id}`]);
    expect(await getTrackBlob(recording.asset.id)).toBeUndefined();
    expect(await (await getFillerRecordingBlob(recording))!.arrayBuffer()).toEqual(await file.arrayBuffer());
    expect(file.type).toBe('audio/x-wav');
    const listed = await listFillerRecordings();
    expect(listed).toEqual([recording]);
    listed[0].asset.sha256 = '0'.repeat(64);
    recording.name = 'Mutated return';
    expect((await listFillerRecordings())[0]).toMatchObject({ name: 'My filler', asset: { sha256: await sha256(file) } });
  });

  it('keeps cloud cache separate from the local catalog and preserves exact bytes through an idempotent cache', async () => {
    browserAudio(2);
    const blob = generateDemoWav(2, 100, 'soft');
    const recording = await fillerFixture(blob);
    const expected = structuredClone(recording);
    const pending = cacheFillerRecording(recording, blob);
    recording.name = 'Changed after invocation';
    recording.asset.sha256 = '0'.repeat(64);
    await pending;
    await cacheFillerRecording(expected, blob);
    expect(await listFillerRecordings()).toEqual([]);
    expect([...stores.tracks.keys()]).toEqual(['filler-custom']);
    expect(await getTrackBlob('custom')).toBeUndefined();
    expect(await (await getFillerRecordingBlob(expected))!.arrayBuffer()).toEqual(await blob.arrayBuffer());
  });

  it.each(['draft', 'locked', 'published', 'cloud', 'disabled'])(
    'archives only the library entry and protects bytes referenced by a %s routine across reload', async kind => {
      browserAudio(2);
      const recording = await addFillerRecording(new File([generateDemoWav(2, 100, 'soft')], 'filler.wav', { type: 'audio/wav' }));
      const key = `filler-${recording.asset.id}`;
      const blob = (await getFillerRecordingBlob(recording))!;
      await expect(removeTrack(key)).rejects.toThrow('track_referenced');
      const routine = await createDemoRoutine();
      routine.filler = { ...routine.filler, mode: kind === 'disabled' ? 'none' : 'hold', sound: 'recording', recording, gain: 0.5 };
      if (kind === 'cloud') await cacheCloudRoutine(routine);
      else {
        const saved = await saveRoutine(routine, null, kind === 'locked' ? 'lock' : 'save');
        if (kind === 'published') await publishRoutine(saved.id, saved.revision);
      }
      const entries = stores.tracks.size;
      await removeFillerRecording(recording.id);
      await removeFillerRecording(recording.id);
      expect(await listFillerRecordings()).toEqual([]);
      expect(stores.tracks.size).toBe(entries);
      vi.resetModules();
      const reloaded = await import('../frontend/src/offline');
      const saved = kind === 'cloud' ? await reloaded.getCloudRoutine(routine.id) : await reloaded.getRoutine(routine.id);
      expect(saved?.filler).toEqual(routine.filler);
      expect(await reloaded.getReadiness(saved!)).toEqual({ ready: true, missing: [] });
      expect(await (await reloaded.getFillerRecordingBlob(recording))!.arrayBuffer()).toEqual(await blob.arrayBuffer());
      await expect(reloaded.removeTrack(key)).rejects.toThrow('track_referenced');
    },
  );

  it('requires every song and active custom filler before caching a cloud routine, without fetching or decoding readiness', async () => {
    const decode = browserAudio(2);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const blob = generateDemoWav(2, 100, 'soft');
    const recording = await fillerFixture(blob);
    const routine = newRoutine();
    routine.tracks = [{ id: 'song', title: 'Song', duration: 2, bpm: 100, firstBeat: 0, cues: [], bodyArea: '' }];
    routine.filler = { ...routine.filler, sound: 'recording', recording };
    expect(await getReadiness(routine)).toEqual({ ready: false, missing: ['song', 'filler-custom'] });
    await expect(cacheCloudRoutine(routine)).rejects.toThrow('missing_audio');
    await cacheCloudTrack('song', blob, recording.asset.sha256);
    await expect(cacheCloudRoutine(routine)).rejects.toThrow('filler-custom');
    expect(await getCloudRoutine(routine.id)).toBeNull();
    await cacheFillerRecording(recording, blob);
    decode.mockClear();
    await cacheCloudRoutine(routine);
    expect(await getReadiness(routine)).toEqual({ ready: true, missing: [] });
    expect(decode).not.toHaveBeenCalled();
    const cached = stores.tracks.get('filler-custom') as { blob: Blob };
    cached.blob = new Blob([new Uint8Array(blob.size)], { type: blob.type });
    expect(await getFillerRecordingBlob(recording)).toBeUndefined();
    expect(await getReadiness(routine)).toEqual({ ready: false, missing: ['filler-custom'] });
    expect(await getReadiness({ ...routine, filler: { ...routine.filler, mode: 'none' } })).toEqual({ ready: true, missing: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['id', 'name', 'duration', 'asset-id', 'hash', 'bytes', 'mime'])(
    'rejects a malformed %s in the full recording before private storage access', async defect => {
      const blob = generateDemoWav(2, 100, 'soft');
      const recording = await fillerFixture(blob);
      if (defect === 'id') recording.id = '../invalid';
      if (defect === 'name') recording.name = '';
      if (defect === 'duration') recording.duration = 361;
      if (defect === 'asset-id') recording.asset.id = '../invalid';
      if (defect === 'hash') recording.asset.sha256 = 'A'.repeat(64);
      if (defect === 'bytes') recording.asset.bytes = 128 * 1024 * 1024 + 1;
      if (defect === 'mime') recording.asset.contentType = 'text/html';
      await expect(cacheFillerRecording(recording, blob)).rejects.toThrow('invalid_filler_recording');
      await expect(getFillerRecordingBlob(recording)).rejects.toThrow('invalid_filler_recording');
      expect(storage.opens).toBe(0);
    },
  );

  it.each(['id', 'hash', 'bytes', 'mime', 'duration'])(
    'does not return cached bytes for a different declared %s', async field => {
      browserAudio(2);
      const blob = generateDemoWav(2, 100, 'soft');
      const recording = await fillerFixture(blob);
      await cacheFillerRecording(recording, blob);
      if (field === 'id') recording.asset.id = 'other';
      if (field === 'hash') recording.asset.sha256 = '0'.repeat(64);
      if (field === 'bytes') recording.asset.bytes++;
      if (field === 'mime') recording.asset.contentType = 'audio/mpeg';
      if (field === 'duration') recording.duration++;
      expect(await getFillerRecordingBlob(recording)).toBeUndefined();
    },
  );

  it('checks hash, MIME, bytes and declared duration before any cache or catalog write', async () => {
    const decode = browserAudio(2);
    const blob = generateDemoWav(2, 100, 'soft');
    const recording = await fillerFixture(blob);
    await expect(cacheFillerRecording(recording, new Blob([await blob.arrayBuffer()], { type: 'audio/mpeg' })))
      .rejects.toThrow('filler_integrity_failed');
    await expect(cacheFillerRecording(recording, blob.slice(1))).rejects.toThrow('filler_integrity_failed');
    await expect(cacheFillerRecording({ ...recording, asset: { ...recording.asset, sha256: '0'.repeat(64) } }, blob))
      .rejects.toThrow('track_integrity_failed');
    expect(decode).not.toHaveBeenCalled();
    await expect(cacheFillerRecording({ ...recording, duration: 3 }, blob)).rejects.toThrow('audio_duration_mismatch');
    expect(stores.tracks.size).toBe(0);
    expect(stores.fillerRecordings.size).toBe(0);
    await cacheFillerRecording({ ...recording, duration: 2.05 }, blob);
    expect(await getFillerRecordingBlob(recording)).toBeInstanceOf(Blob);
    const previous = stores.tracks.get('filler-custom') as { duration: number };
    previous.duration = 2.09;
    await expect(cacheFillerRecording({ ...recording, duration: 1.95 }, blob)).rejects.toThrow('track_conflict');
    expect(previous.duration).toBe(2.09);
  });

  it('keeps native decoder and local source bounds with no partial library entries on failure', async () => {
    const blob = generateDemoWav(2, 100, 'soft');
    const file = new File([blob], 'filler.wav', { type: 'audio/wav' });
    const oversized = new File([blob], 'large.wav', { type: 'audio/wav' });
    Object.defineProperty(oversized, 'size', { value: MAX_TRACK_BYTES + 1 });
    const read = vi.spyOn(oversized, 'arrayBuffer');
    await expect(addFillerRecording(oversized)).rejects.toThrow('audio_byte_limit');
    expect(read).not.toHaveBeenCalled();
    await expect(addFillerRecording(file, ' ')).rejects.toThrow('invalid_filler_recording');
    browserAudio(2, 361);
    await expect(addFillerRecording(file)).rejects.toThrow('audio_duration_limit');
    browserAudio(2, 2, 6);
    await expect(addFillerRecording(file)).rejects.toThrow('audio_memory_limit');
    const recording = await fillerFixture(blob);
    browserAudio(2).mockResolvedValueOnce({ duration: 2, length: MAX_DECODED_BYTES / 8 + 1, numberOfChannels: 2 });
    await expect(cacheFillerRecording(recording, blob)).rejects.toThrow('audio_memory_limit');
    browserAudio(2);
    vi.stubGlobal('crypto', {});
    await expect(cacheFillerRecording(recording, blob)).rejects.toThrow('track_integrity_failed');
    await expect(addFillerRecording(file)).rejects.toThrow('track_integrity_failed');
    expect(stores.tracks.size).toBe(0);
    expect(stores.fillerRecordings.size).toBe(0);
  });
});

describe('hosted mutation ownership', () => {
  const mutations = ['storeTrack', 'saveRoutine', 'setActiveRoutine', 'removeTrack', 'createDemoRoutine',
    'cacheCloudTrack', 'cacheCloudRoutine', 'addFillerRecording', 'removeFillerRecording', 'cacheFillerRecording',
    'saveMusicPlaylist', 'saveClassSetup', 'cacheMusicPlaylist', 'cacheClassSetup',
    'deleteRoutine', 'deleteMusicPlaylist', 'deleteClassSetup'] as const;
  const guardedOperations = [...mutations, 'publishRoutine'] as const;
  const file = () => new File(['synthetic audio'], 'synthetic.wav', { type: 'audio/wav' });
  let cloudHash: string;
  let custom: FillerRecording;
  const customFile = () => new File([generateDemoWav(2, 100, 'soft')], 'filler.wav', { type: 'audio/wav' });
  let offline: typeof import('../frontend/src/offline');
  let markers: Map<string, string>;
  let events: EventTarget;
  let sessionStorage: { getItem: ReturnType<typeof vi.fn<(key: string) => string | null>> };
  const notify = (key: string | null, oldValue: string | null = null, newValue: string | null = 'reset-generation') => {
    events.dispatchEvent(Object.assign(new Event('storage'), { key, oldValue, newValue, storageArea: sessionStorage }));
  };
  const mutate = (name: typeof guardedOperations[number]) => {
    if (name === 'storeTrack') return offline.storeTrack(file());
    if (name === 'saveRoutine') return offline.saveRoutine(newRoutine(), null);
    if (name === 'publishRoutine') return offline.publishRoutine('routine-guard', 1);
    if (name === 'deleteRoutine') return offline.deleteRoutine('routine-guard', 1);
    if (name === 'deleteMusicPlaylist') return offline.deleteMusicPlaylist('playlist-guard', 1);
    if (name === 'deleteClassSetup') return offline.deleteClassSetup('class-guard', 1);
    if (name === 'setActiveRoutine') return offline.setActiveRoutine('selected');
    if (name === 'removeTrack') return offline.removeTrack('unreferenced');
    if (name === 'cacheCloudTrack') return offline.cacheCloudTrack('cloud-entry', file(), cloudHash);
    if (name === 'cacheCloudRoutine') return offline.cacheCloudRoutine(newRoutine());
    if (name === 'addFillerRecording') return offline.addFillerRecording(customFile());
    if (name === 'removeFillerRecording') return offline.removeFillerRecording('custom');
    if (name === 'cacheFillerRecording') return offline.cacheFillerRecording(custom, customFile());
    if (name === 'saveMusicPlaylist') return offline.saveMusicPlaylist(newMusicPlaylist(), null);
    if (name === 'cacheMusicPlaylist') return offline.cacheMusicPlaylist({ playlist: newMusicPlaylist(), media: {} });
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-guard', name: 'Class', revision: 1, locked: false, published: false,
      routine: { id: 'routine-guard', revision: 1, published: false }, crossfade: 1 };
    if (name === 'saveClassSetup') return offline.saveClassSetup(setup, null);
    if (name === 'cacheClassSetup') return offline.cacheClassSetup(setup);
    return offline.createDemoRoutine();
  };

  beforeEach(async () => {
    vi.stubEnv('VITE_HOSTED_PILOT', 'true');
    markers = new Map([[hostedUserKey, 'owner-A']]);
    sessionStorage = { getItem: vi.fn((key: string) => markers.get(key) ?? null) };
    events = new EventTarget();
    Object.defineProperty(events, 'localStorage', { get: () => sessionStorage, configurable: true });
    vi.stubGlobal('window', events);
    vi.resetModules();
    offline = await import('../frontend/src/offline');
    browserAudio(2);
    cloudHash = await sha256(file());
    custom = await fillerFixture(customFile());
  });

  it('preserves hosted imports, routine CAS/locks and selection with one lightweight listener set', async () => {
    const listen = vi.spyOn(events, 'addEventListener');
    const track = await offline.storeTrack(file());
    const saved = await offline.saveRoutine({ ...newRoutine(), tracks: [track] }, null);
    const locked = await offline.saveRoutine(saved, saved.revision, 'lock');
    await expect(offline.saveRoutine(saved, saved.revision)).rejects.toThrow('routine_conflict');
    await expect(offline.removeTrack(track.id)).rejects.toThrow('track_referenced');
    const unlocked = await offline.saveRoutine(locked, locked.revision, 'unlock');
    await offline.setActiveRoutine(unlocked.id);
    expect(await offline.getRoutine()).toEqual(unlocked);
    expect(await offline.getTrackBlob(track.id)).toBeInstanceOf(Blob);
    expect(listen.mock.calls.map(([name]) => name)).toEqual(['storage', 'pagehide', hostedInvalidationEvent]);
  });

  it.each(guardedOperations)('rejects %s at invocation for missing owner, any reset, or unavailable storage', async name => {
    for (const invalid of ['missing', 'empty', 'whitespace', 'reset', 'empty-reset', 'read-failure', 'getter-failure']) {
      markers.clear();
      markers.set(hostedUserKey, 'owner-A');
      sessionStorage.getItem.mockImplementation(key => markers.get(key) ?? null);
      Object.defineProperty(events, 'localStorage', { get: () => sessionStorage, configurable: true });
      if (invalid === 'missing') markers.delete(hostedUserKey);
      if (invalid === 'empty') markers.set(hostedUserKey, '');
      if (invalid === 'whitespace') markers.set(hostedUserKey, ' ');
      if (invalid === 'reset') markers.set(hostedResetKey, 'reset-generation');
      if (invalid === 'empty-reset') markers.set(hostedResetKey, '');
      if (invalid === 'read-failure') sessionStorage.getItem.mockImplementation(() => { throw new Error('storage denied'); });
      if (invalid === 'getter-failure') Object.defineProperty(events, 'localStorage', { get: () => { throw new Error('storage denied'); }, configurable: true });
      vi.resetModules();
      offline = await import('../frontend/src/offline');
      await expect(mutate(name)).rejects.toThrow('hosted_session_invalidated');
      expect(storage.opens).toBe(0);
      expect(stores.tracks.size).toBe(0);
      expect(stores.routines.size).toBe(0);
      expect(stores.cloudRoutines.size).toBe(0);
    }
  });

  it.each(['logout', 'switch'])('does not commit a native decode after its deadline and %s into another account', async reason => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const began = deferred<void>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const decode = browserAudio(2);
    decode.mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const outcomes = Promise.allSettled([offline.storeTrack(file()), offline.addFillerRecording(customFile())]);
    await began.promise;
    if (reason === 'logout') events.dispatchEvent(new Event(hostedInvalidationEvent));
    else notify(hostedUserKey, 'owner-A', 'owner-B');
    markers.set(hostedUserKey, 'owner-B');
    const existing = { blob: new Blob(['synthetic B audio']) };
    stores.tracks.set('owner-B-track', existing);
    await vi.advanceTimersByTimeAsync(30_000);
    for (const outcome of await outcomes) expect(outcome).toEqual({
      status: 'rejected', reason: new Error('hosted_session_invalidated'),
    });
    await expect(offline.storeTrack(file())).rejects.toThrow('hosted_session_invalidated');
    decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    await decoded.promise;
    expect([...stores.tracks]).toEqual([['owner-B-track', existing]]);
    expect(stores.fillerRecordings.size).toBe(0);
    expect(storage.opens).toBe(0);
    expect(decode).toHaveBeenCalledOnce();
    expect(conversion).not.toHaveBeenCalled();
  });

  it('does not resurrect a pending or queued A import after database deletion and B admission', async () => {
    const began = deferred<void>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const decode = browserAudio(2);
    decode.mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const outcomes = Promise.allSettled([offline.storeTrack(file()),
      offline.cacheCloudTrack('cloud-entry', file(), cloudHash), offline.storeTrack(file())]);
    await began.promise;
    markers.set(hostedResetKey, 'reset-generation');
    stores.tracks.clear();
    stores.routines.clear();
    stores.meta.clear();
    markers.set(hostedUserKey, 'owner-B');
    markers.delete(hostedResetKey);
    const newOwnerBlob = new Blob(['synthetic B']);
    stores.tracks.set('owner-B-track', newOwnerBlob);
    decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    for (const outcome of await outcomes) expect(outcome).toMatchObject({
      status: 'rejected', reason: new Error('hosted_session_invalidated'),
    });
    expect(storage.opens).toBe(0);
    expect(decode).toHaveBeenCalledOnce();
    expect([...stores.tracks]).toEqual([['owner-B-track', newOwnerBlob]]);
    expect(stores.routines.size).toBe(0);
    expect(stores.meta.size).toBe(0);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(['reset', 'user', 'clear', 'pagehide', 'dispose', 'unnotified-switch'].flatMap(reason =>
    ['song', 'filler'].flatMap(kind => ['resolve', 'reject'].map(settle => [reason, kind, settle]))))(
    'aborts %s for active %s conversion that later %s and prevents queued imports from writing', async (reason, kind, settle) => {
      browserAudio(2).mockRejectedValueOnce(new Error('native codec unavailable'));
      const began = deferred<void>();
      const converted = deferred<{ blob: Blob; duration: number }>();
      conversion.mockImplementationOnce(() => { began.resolve(); return converted.promise; });
      const outcomes = Promise.allSettled([kind === 'song' ? offline.storeTrack(file()) : offline.addFillerRecording(customFile()),
        offline.addFillerRecording(customFile()), offline.storeTrack(file())]);
      await began.promise;
      const signal = conversion.mock.calls[0][1]!.signal!;
      expect(signal.aborted).toBe(false);
      if (reason === 'reset') notify(hostedResetKey);
      else if (reason === 'user') notify(hostedUserKey, 'owner-A', 'owner-B');
      else if (reason === 'clear') notify(null);
      else if (reason === 'dispose') events.dispatchEvent(new Event(hostedInvalidationEvent));
      else if (reason === 'pagehide') events.dispatchEvent(new Event('pagehide'));
      markers.set(hostedUserKey, 'owner-B');
      const nextOwnerRecord = { blob: new Blob(['synthetic next account']) };
      stores.tracks.set('next-account', nextOwnerRecord);
      if (reason !== 'unnotified-switch') expect(signal.aborted).toBe(true);
      expect(conversion).toHaveBeenCalledOnce();
      expect(storage.opens).toBe(0);
      if (settle === 'resolve') converted.resolve({ blob: mockM4aContainer(2, 2), duration: 2 });
      else converted.reject(new Error('conversion_worker_failed'));
      for (const outcome of await outcomes) expect(outcome).toMatchObject({
        status: 'rejected', reason: new Error('hosted_session_invalidated'),
      });
      expect(signal.aborted).toBe(true);
      expect(conversion).toHaveBeenCalledOnce();
      expect(storage.opens).toBe(0);
      expect([...stores.tracks]).toEqual([['next-account', nextOwnerRecord]]);
      expect(stores.fillerRecordings.size).toBe(0);
    },
  );

  it('rejects an invalid queued identity before loading a converter', async () => {
    const began = deferred<void>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    browserAudio(2).mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const outcomes = Promise.allSettled([offline.storeTrack(file()),
      offline.storeTrack(new File(['synthetic codec data'], 'synthetic.opus', { type: 'audio/opus' }))]);
    await began.promise;
    notify(hostedResetKey);
    decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    for (const outcome of await outcomes) expect(outcome).toMatchObject({
      status: 'rejected', reason: new Error('hosted_session_invalidated'),
    });
    expect(conversion).not.toHaveBeenCalled();
    expect(storage.opens).toBe(0);
  });

  it('does not abort a running conversion or invalidate local writes on ordinary cloud session expiry', async () => {
    const { cloudAccessAfterFailure } = await import('../shared/cloud-contract');
    browserAudio(2).mockRejectedValueOnce(new Error('native codec unavailable'));
    const began = deferred<void>();
    const converted = deferred<{ blob: Blob; duration: number }>();
    conversion.mockImplementationOnce(() => { began.resolve(); return converted.promise; });
    const pending = offline.storeTrack(file());
    await began.promise;
    const signal = conversion.mock.calls[0][1]!.signal!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    expect(cloudAccessAfterFailure((await fetch('/api/auth/session')).status)).toBe('signin-required');
    expect(signal.aborted).toBe(false);
    converted.resolve({ blob: mockM4aContainer(2, 2), duration: 2 });
    const track = await pending;
    expect((await offline.getTrackBlob(track.id))!.type).toBe('audio/mp4');
    expect(signal.aborted).toBe(false);
    expect((await offline.saveRoutine({ ...newRoutine(), tracks: [track] }, null)).tracks).toEqual([track]);
  });

  it.each(['reset', 'user', 'clear', 'pagehide', 'persisted-pagehide', 'dispose'])(
    'permanently invalidates pending work on %s even when owner and reset return to A', async reason => {
      const began = deferred<void>();
      const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
      browserAudio(2).mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
      const outcome = Promise.allSettled([offline.storeTrack(file())]);
      await began.promise;
      if (reason === 'reset') notify(hostedResetKey);
      else if (reason === 'user') notify(hostedUserKey, 'owner-A', 'owner-B');
      else if (reason === 'clear') notify(null);
      else if (reason === 'dispose') events.dispatchEvent(new Event(hostedInvalidationEvent));
      else events.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: reason === 'persisted-pagehide' }));
      markers.set(hostedUserKey, 'owner-A');
      markers.delete(hostedResetKey);
      decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
      for (const name of guardedOperations) await expect(mutate(name)).rejects.toThrow('hosted_session_invalidated');
      expect(storage.opens).toBe(0);
      expect(stores.tracks.size).toBe(0);
      expect(stores.routines.size).toBe(0);
    },
  );

  it.each(guardedOperations)('checks %s again after a late database open, before creating a transaction', async name => {
    storage.onOpen = () => { markers.set(hostedUserKey, 'owner-B'); };
    await expect(mutate(name)).rejects.toThrow('hosted_session_invalidated');
    expect(storage.transactions).toBe(0);
    expect(stores.tracks.size).toBe(0);
    expect(stores.routines.size).toBe(0);
    expect(stores.meta.size).toBe(0);
    expect(stores.cloudRoutines.size).toBe(0);
  });

  it.each(mutations)('aborts %s when reset starts during transaction creation', async name => {
    storage.onTransaction = () => {
      markers.set(hostedResetKey, 'reset-generation');
      notify(hostedResetKey);
    };
    await expect(mutate(name)).rejects.toThrow('hosted_session_invalidated');
    expect(storage.aborts).toBe(1);
    expect(stores.tracks.size).toBe(0);
    expect(stores.routines.size).toBe(0);
    expect(stores.meta.size).toBe(0);
    expect(stores.cloudRoutines.size).toBe(0);
  });

  it('rejects publication when its initial read is invalidated without creating any writes', async () => {
    const saved = await offline.saveRoutine(await offline.createDemoRoutine(), null);
    const before = structuredClone(stores);
    storage.onTransaction = () => {
      markers.set(hostedResetKey, 'reset-generation');
      notify(hostedResetKey);
    };
    await expect(offline.publishRoutine(saved.id, 1)).rejects.toThrow('hosted_session_invalidated');
    expect(stores).toEqual(before);
  });

  it.each(['switch', 'reset'])('retains the publication invocation account across audio hashing after %s', async reason => {
    const saved = await offline.saveRoutine(await offline.createDemoRoutine(), null);
    const before = structuredClone(stores);
    const began = deferred<void>();
    const resume = deferred<void>();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      began.resolve();
      await resume.promise;
      return digest(...args);
    });
    const outcome = Promise.allSettled([offline.publishRoutine(saved.id, 1)]);
    await began.promise;
    if (reason === 'switch') markers.set(hostedUserKey, 'owner-B');
    else notify(hostedResetKey);
    resume.resolve();
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
    expect(stores).toEqual(before);
  });

  it.each(['routineHistory', 'routines'])(
    'rolls back publication after staging %s without exposing a partial published revision', async target => {
      const saved = await offline.saveRoutine(await offline.createDemoRoutine(), null);
      const before = structuredClone(stores);
      const began = deferred<void>();
      const resume = deferred<void>();
      storage.onRequest = async (store, method) => {
        if (store === target && method === 'put') { began.resolve(); await resume.promise; }
      };
      const outcome = Promise.allSettled([offline.publishRoutine(saved.id, 1)]);
      await began.promise;
      markers.set(hostedUserKey, 'owner-B');
      resume.resolve();
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
      expect(storage.aborts).toBe(1);
      expect(stores).toEqual(before);
    },
  );

  it.each(['routine', 'playlist', 'class'] as const)(
    'rolls back a staged %s tombstone and preserves the next account records after invalidation', async kind => {
      const routine = await offline.saveRoutine(await offline.createDemoRoutine(), null);
      const playlist = await offline.saveMusicPlaylist(newMusicPlaylist(), null);
      const setup = await offline.saveClassSetup({ schemaVersion: 1, id: 'class-guard', name: 'Class', revision: 1,
        locked: false, published: false, routine: { id: routine.id, revision: 1, published: false }, crossfade: 1 }, null);
      const before = structuredClone(stores);
      const began = deferred<void>();
      const resume = deferred<void>();
      storage.onRequest = async (store, method) => {
        if (store === 'meta' && method === 'put') { began.resolve(); await resume.promise; }
      };
      const outcome = Promise.allSettled([kind === 'routine' ? offline.deleteRoutine(routine.id, 1) :
        kind === 'playlist' ? offline.deleteMusicPlaylist(playlist.id, 1) : offline.deleteClassSetup(setup.id, 1)]);
      await began.promise;
      notify(hostedUserKey, 'owner-A', 'owner-B');
      markers.set(hostedUserKey, 'owner-B');
      const nextAccount = { ...newMusicPlaylist(), id: 'next-account' };
      stores.musicPlaylists.set(nextAccount.id, nextAccount);
      before.musicPlaylists.set(nextAccount.id, nextAccount);
      resume.resolve();
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
      expect(storage.aborts).toBe(1);
      expect(stores).toEqual(before);
    },
  );

  it('retains the demo invocation owner across hashing instead of recapturing for each track', async () => {
    const began = deferred<void>();
    const hashed = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => { began.resolve(); return hashed.promise; });
    const outcome = Promise.allSettled([offline.createDemoRoutine()]);
    await began.promise;
    markers.set(hostedUserKey, 'owner-B');
    hashed.resolve(new ArrayBuffer(32));
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
    expect(storage.opens).toBe(0);
    expect(stores.tracks.size).toBe(0);
  });

  it.each(['identity', 'reset', 'read-failure', 'getter-failure'])('rolls back routine and selection writes on a late %s change', async reason => {
    const saved = await offline.saveRoutine(newRoutine(), null);
    const began = deferred<void>();
    const resume = deferred<void>();
    storage.onRequest = async (store, method) => {
      if (store === 'routines' && method === 'put') { began.resolve(); await resume.promise; }
    };
    const outcome = Promise.allSettled([offline.saveRoutine({ ...saved, name: 'Unsaved synthetic A' }, saved.revision, 'lock')]);
    await began.promise;
    if (reason === 'identity') markers.set(hostedUserKey, 'owner-B');
    if (reason === 'reset') {
      notify(hostedResetKey);
      markers.set(hostedUserKey, 'owner-A');
      markers.delete(hostedResetKey);
      expect(storage.aborts).toBe(1);
    }
    if (reason === 'read-failure') sessionStorage.getItem.mockImplementation(() => { throw new Error('storage denied'); });
    if (reason === 'getter-failure') Object.defineProperty(events, 'localStorage', {
      get: () => { throw new Error('storage denied'); }, configurable: true,
    });
    resume.resolve();
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
    expect(storage.aborts).toBe(1);
    expect(stores.routines.get(saved.id)).toEqual(saved);
    expect(stores.meta.get('active')).toBe(saved.id);
    expect(stores.routines.size).toBe(1);
  });

  it('ignores unrelated and session-storage events without invalidating a hosted owner', async () => {
    await offline.saveRoutine(newRoutine(), null);
    notify('fitness-theme');
    events.dispatchEvent(Object.assign(new Event('storage'), {
      key: hostedResetKey, oldValue: null, newValue: 'other-storage', storageArea: {},
    }));
    expect((await offline.storeTrack(file())).duration).toBe(2);
  });

  it.each(['musicPlaylistHistory', 'classSetupHistory', 'cloudMusicPlaylists', 'cloudClassSetups'] as const)(
    'rolls back all class stores when account switches during %s write', async target => {
      const routine = await offline.saveRoutine({ ...newRoutine(), id: 'routine-guard' }, null);
      const setup: ClassSetup = { schemaVersion: 1, id: 'class-guard', name: 'Class', revision: 1, locked: false, published: false,
        routine: { id: routine.id, revision: 1, published: false }, crossfade: 1 };
      const began = deferred<void>();
      const resume = deferred<void>();
      storage.onRequest = async (store, method) => {
        if (store === target && method === 'put') { began.resolve(); await resume.promise; }
      };
      const operation = target === 'musicPlaylistHistory' ? offline.saveMusicPlaylist(newMusicPlaylist(), null) :
        target === 'classSetupHistory' ? offline.saveClassSetup(setup, null) :
        target === 'cloudMusicPlaylists' ? offline.cacheMusicPlaylist({ playlist: newMusicPlaylist(), media: {} }) : offline.cacheClassSetup(setup);
      const outcome = Promise.allSettled([operation]);
      await began.promise;
      notify(hostedUserKey, 'owner-A', 'owner-B');
      markers.set(hostedUserKey, 'owner-B');
      resume.resolve();
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
      for (const store of ['musicPlaylists', 'musicPlaylistHistory', 'classSetups', 'classSetupHistory', 'cloudMusicPlaylists', 'cloudClassSetups'] as const) {
        expect(stores[store].size).toBe(0);
      }
      expect(stores.routines.get(routine.id)).toEqual(routine);
    },
  );

  it('keeps local readiness, media and cloud snapshots available across ordinary API 401 expiration', async () => {
    const { cloudAccessAfterFailure } = await import('../shared/cloud-contract');
    const track = await offline.storeTrack(file());
    const routine = { ...newRoutine(), tracks: [track], revision: 8, locked: true };
    const recording = await offline.addFillerRecording(customFile());
    routine.filler = { ...routine.filler, sound: 'recording', recording };
    await offline.cacheCloudRoutine(routine);
    const snapshot = (await offline.getCloudRoutine(routine.id))!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"signin_required"}', { status: 401 })));
    expect(cloudAccessAfterFailure((await fetch('/api/auth/session')).status)).toBe('signin-required');
    expect(await offline.getReadiness(snapshot)).toEqual({ ready: true, missing: [] });
    expect(await offline.getTrackBlob(track.id)).toBeInstanceOf(Blob);
    expect(await offline.getFillerRecordingBlob(recording)).toBeInstanceOf(Blob);
    expect(await offline.listFillerRecordings()).toEqual([recording]);
    await offline.cacheCloudTrack('another-entry', file(), cloudHash);
    await offline.cacheCloudRoutine({ ...routine, name: 'New authoritative copy', revision: 9 });
    expect(snapshot).toEqual(routine);
    expect(await offline.getCloudRoutine(routine.id)).toMatchObject({ revision: 9 });
    expect(markers.get(hostedUserKey)).toBe('owner-A');
    expect(markers.has(hostedResetKey)).toBe(false);
    expect(storage.aborts).toBe(0);
  });

  it.each(['hash', 'decode'])('invalidates pending cloud %s and queued writes across account switch and re-admission', async stage => {
    const began = deferred<void>();
    const hashed = deferred<ArrayBuffer>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const hashResult = await crypto.subtle.digest('SHA-256', await file().arrayBuffer());
    const decode = browserAudio(2);
    if (stage === 'hash') vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => { began.resolve(); return hashed.promise; });
    else decode.mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const outcomes = Promise.allSettled([
      offline.cacheCloudTrack('pending', file(), cloudHash), offline.cacheCloudTrack('queued', file(), cloudHash),
    ]);
    await began.promise;
    notify(hostedUserKey, 'owner-A', 'owner-B');
    markers.set(hostedUserKey, 'owner-A');
    hashed.resolve(hashResult);
    decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    for (const outcome of await outcomes) expect(outcome).toMatchObject({
      status: 'rejected', reason: new Error('hosted_session_invalidated'),
    });
    expect(storage.opens).toBe(0);
    expect(stores.tracks.size).toBe(0);
  });

  it('rejects late verified reads after explicit signout', async () => {
    await offline.cacheCloudTrack('entry', file(), cloudHash);
    const began = deferred<void>();
    const hashed = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => { began.resolve(); return hashed.promise; });
    const outcome = Promise.allSettled([offline.getTrackBlob('entry')]);
    await began.promise;
    events.dispatchEvent(new Event(hostedInvalidationEvent));
    hashed.resolve(new ArrayBuffer(32));
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
    await expect(offline.getCloudRoutine('routine')).rejects.toThrow('hosted_session_invalidated');
  });

  it.each(['tracks', 'cloudRoutines', 'fillerRecordings'])('rolls back a staged %s write before explicit signout purge', async target => {
    const began = deferred<void>();
    const resume = deferred<void>();
    storage.onRequest = async (store, method) => {
      if (store === target && method === 'put') { began.resolve(); await resume.promise; }
    };
    const outcome = Promise.allSettled([target === 'tracks' ?
      offline.cacheCloudTrack('entry', file(), cloudHash) : target === 'fillerRecordings' ?
        offline.addFillerRecording(customFile()) : offline.cacheCloudRoutine(newRoutine())]);
    await began.promise;
    events.dispatchEvent(new Event(hostedInvalidationEvent));
    expect(storage.aborts).toBe(1);
    stores.tracks.clear();
    stores.cloudRoutines.clear();
    stores.fillerRecordings.clear();
    markers.set(hostedUserKey, 'owner-B');
    resume.resolve();
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
    expect(stores.tracks.size).toBe(0);
    expect(stores.cloudRoutines.size).toBe(0);
    expect(stores.fillerRecordings.size).toBe(0);
  });

  it.each(['add', 'cache'])('invalidates pending and queued custom %s decodes without entering the next account library', async action => {
    const began = deferred<void>();
    const decoded = deferred<{ duration: number; length: number; numberOfChannels: number }>();
    const decode = browserAudio(2);
    decode.mockImplementationOnce(() => { began.resolve(); return decoded.promise; });
    const invoke = () => action === 'add' ? offline.addFillerRecording(customFile()) : offline.cacheFillerRecording(custom, customFile());
    const outcomes = Promise.allSettled([invoke(), invoke()]);
    await began.promise;
    notify(hostedResetKey);
    markers.set(hostedUserKey, 'owner-B');
    const nextOwner = { ...custom, id: 'next-owner', name: 'Synthetic B' };
    stores.fillerRecordings.set(nextOwner.id, nextOwner);
    decoded.resolve({ duration: 2, length: 88200, numberOfChannels: 2 });
    for (const outcome of await outcomes) expect(outcome).toMatchObject({
      status: 'rejected', reason: new Error('hosted_session_invalidated'),
    });
    expect(storage.opens).toBe(0);
    expect(decode).toHaveBeenCalledOnce();
    expect(stores.tracks.size).toBe(0);
    expect([...stores.fillerRecordings.values()]).toEqual([nextOwner]);
    await expect(offline.listFillerRecordings()).rejects.toThrow('hosted_session_invalidated');
    await expect(offline.getFillerRecordingBlob(custom)).rejects.toThrow('hosted_session_invalidated');
  });

  it('rejects a late custom blob hash read after explicit signout', async () => {
    await offline.cacheFillerRecording(custom, customFile());
    expect(await offline.getFillerRecordingBlob(custom)).toBeInstanceOf(Blob);
    const began = deferred<void>();
    const hashed = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => { began.resolve(); return hashed.promise; });
    const outcome = Promise.allSettled([offline.getFillerRecordingBlob(custom)]);
    await began.promise;
    events.dispatchEvent(new Event(hostedInvalidationEvent));
    hashed.resolve(new ArrayBuffer(32));
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
    await expect(offline.listFillerRecordings()).rejects.toThrow('hosted_session_invalidated');
  });

  it('leaves local mutations independent of hosted storage and page lifecycle', async () => {
    vi.stubEnv('VITE_HOSTED_PILOT', 'false');
    sessionStorage.getItem.mockImplementation(() => { throw new Error('storage denied'); });
    const saved = await offline.saveRoutine(newRoutine(), null);
    events.dispatchEvent(new Event('pagehide'));
    notify(hostedResetKey);
    expect((await offline.storeTrack(file())).duration).toBe(2);
    expect(await offline.getRoutine()).toEqual(saved);
    expect(sessionStorage.getItem).not.toHaveBeenCalled();
  });
});

describe('deterministic synthesis', () => {
  it('generates identical WAV samples and valid small mono PCM headers', async () => {
    const first = await generateDemoWav(1, 100, 'soft').arrayBuffer();
    const second = await generateDemoWav(1, 100, 'soft').arrayBuffer();
    expect(new Uint8Array(first)).toEqual(new Uint8Array(second));
    expect(new DataView(first).getUint32(24, true)).toBe(16000);
    expect(new DataView(first).getUint32(40, true)).toBe(32000);
  });

  it('gives each filler sound a reproducible bounded four-beat loop with silent edges', () => {
    for (const sound of ['soft', 'bright', 'drums'] as const) {
      const samples = generateLoopSamples(sound, 100);
      expect(samples).toEqual(generateLoopSamples(sound, 100));
      expect(samples.length).toBe(52920);
      expect(samples[0]).toBe(0);
      expect(Math.abs(samples.at(-1)!)).toBe(0);
      expect(Math.max(...samples.map(Math.abs))).toBeLessThan(0.5);
    }
    expect(generateLoopSamples('soft', 100)).not.toEqual(generateLoopSamples('drums', 100));
  });
});

describe('bounded file import', () => {
  const opusSources = new WeakMap<File, { duration: number; channels: number }>();

  beforeEach(() => {
    browserAudio((9600 - 312) / 48000, (9600 - 312) / 48000, 1);
    conversion.mockImplementation(async file => {
      const source = opusSources.get(file);
      if (!source) throw new Error('conversion_invalid_audio');
      if (Math.ceil(source.duration * AAC_IMPORT.sampleRate) * source.channels * 4 > MAX_DECODED_BYTES) {
        throw new Error('conversion_memory_limit');
      }
      return { blob: mockM4aContainer(source.duration, source.channels), duration: source.duration };
    });
  });

  function opusFile(options: {
    type?: string; name?: string; channels?: number; granule?: bigint; packets?: number;
    commentBytes?: number;
    headerVersion?: number; mapping?: number; gain?: number; changePages?: (pages: Uint8Array[]) => void;
  } = {}) {
    const checksumPage = (bytes: Uint8Array) => {
      const view = new DataView(bytes.buffer);
      view.setUint32(22, 0, true);
      let checksum = 0;
      for (const byte of bytes) {
        checksum ^= byte << 24;
        for (let bit = 0; bit < 8; bit++) checksum = (checksum << 1) ^ (checksum < 0 ? 0x04c11db7 : 0);
      }
      view.setUint32(22, checksum >>> 0, true);
    };
    const page = (packetList: Uint8Array[], sequence: number, flags: number, granule: bigint) => {
      const size = packetList.reduce((sum, packet) => sum + packet.length, 0);
      const bytes = new Uint8Array(27 + packetList.length + size);
      bytes.set(new TextEncoder().encode('OggS'));
      bytes[5] = flags;
      bytes[26] = packetList.length;
      const view = new DataView(bytes.buffer);
      view.setBigUint64(6, granule, true);
      view.setUint32(14, 123, true);
      view.setUint32(18, sequence, true);
      let offset = 27 + packetList.length;
      packetList.forEach((packet, index) => {
        bytes[27 + index] = packet.length;
        bytes.set(packet, offset);
        offset += packet.length;
      });
      return bytes;
    };
    const header = new Uint8Array(19);
    header.set(new TextEncoder().encode('OpusHead'));
    header[8] = options.headerVersion ?? 1;
    header[9] = options.channels ?? 1;
    header[18] = options.mapping ?? 0;
    new DataView(header.buffer).setUint16(10, 312, true);
    new DataView(header.buffer).setInt16(16, options.gain ?? 0, true);
    const tags = new Uint8Array(options.commentBytes ? 20 + options.commentBytes : 16);
    tags.set(new TextEncoder().encode('OpusTags'));
    if (options.commentBytes) {
      new DataView(tags.buffer).setUint32(12, 1, true);
      new DataView(tags.buffer).setUint32(16, options.commentBytes, true);
      tags.fill(65, 20);
    }
    const packets = options.packets ?? 10;
    const pages = [page([header], 0, 2, 0n)];
    const tagSegments: Uint8Array[] = [];
    for (let offset = 0; offset <= tags.length; offset += 255) tagSegments.push(tags.subarray(offset, offset + 255));
    for (let offset = 0; offset < tagSegments.length; offset += 255) {
      const last = offset + 255 >= tagSegments.length;
      pages.push(page(tagSegments.slice(offset, offset + 255), pages.length, offset ? 1 : 0,
        last ? 0n : 0xffffffffffffffffn));
    }
    for (let count = 0; count < packets; count += 255) {
      const size = Math.min(255, packets - count);
      const last = count + size === packets;
      pages.push(page(Array.from({ length: size }, () => new Uint8Array([0xf8, 0xff, 0xfe])),
        pages.length, last ? 4 : 0, last && options.granule !== undefined ? options.granule : BigInt((count + size) * 960)));
    }
    options.changePages?.(pages);
    pages.forEach(checksumPage);
    const file = new File(pages, options.name ?? 'synthetic.opus', { type: options.type ?? 'audio/opus' });
    opusSources.set(file, { duration: (Number(options.granule ?? BigInt(packets * 960)) - 312) / 48000,
      channels: options.channels ?? 1 });
    return file;
  }

  it.each([1, 2].flatMap(channels => [65004, 65005, 70000, 140000].map(commentBytes => [channels, commentBytes])))('validates continued OpusTags and delegates the intact %i-channel source (%i comment bytes)', async (channels, commentBytes) => {
    browserAudio((9600 - 312) / 48000, (9600 - 312) / 48000, channels);
    const file = opusFile({ channels, commentBytes });
    const original = await file.arrayBuffer();
    const imported = await storeTrack(file);
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(imported.duration).toBe((9600 - 312) / 48000);
    expect((await getTrackBlob(imported.id))!.type).toBe('audio/mp4');
    expect(await file.arrayBuffer()).toEqual(original);
  });

  it('converts custom Opus into one AAC filler blob with final-byte metadata without altering the original', async () => {
    const file = opusFile({ commentBytes: 70000 });
    const original = await file.arrayBuffer();
    const recording = await addFillerRecording(file);
    const blob = (await getFillerRecordingBlob(recording))!;
    expect(recording).toMatchObject({ name: 'synthetic.opus', duration: (9600 - 312) / 48000,
      asset: { id: recording.id, contentType: 'audio/mp4' } });
    expect(blob.type).toBe('audio/mp4');
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(recording.asset.sha256).toBe(await sha256(blob));
    expect(recording.asset.bytes).toBe(blob.size);
    expect(await file.arrayBuffer()).toEqual(original);
    expect([...stores.tracks.keys()]).toEqual([`filler-${recording.asset.id}`]);
    expect(await listFillerRecordings()).toEqual([recording]);
  });

  it('downloads converted filler bytes unchanged without invoking conversion or recreating the library entry', async () => {
    const recording = await addFillerRecording(opusFile());
    const blob = (await getFillerRecordingBlob(recording))!;
    stores.tracks.clear();
    stores.fillerRecordings.clear();
    conversion.mockClear().mockRejectedValue(new Error('conversion_unavailable'));
    await cacheFillerRecording(recording, blob);
    expect(await (await getFillerRecordingBlob(recording))!.arrayBuffer()).toEqual(await blob.arrayBuffer());
    expect(await listFillerRecordings()).toEqual([]);
    browserAudio(recording.duration).mockRejectedValueOnce(new Error('native codec unavailable'));
    stores.tracks.clear();
    await expect(cacheFillerRecording(recording, blob)).rejects.toThrow('unsupported_audio');
    expect(conversion).not.toHaveBeenCalled();
    expect(stores.tracks.size).toBe(0);
  });

  it.each([1, 2])('verifies real 48 kHz AAC as %i-channel native 44.1 kHz audio before storing the converter timeline', async channels => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const decode = browserAudio(2, 2, channels);
      decode.mockImplementation(bytes => page.evaluate(async base64 => {
        const input = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const context = new OfflineAudioContext(2, 1, 44100);
        const decoded = await context.decodeAudioData(input.buffer);
        return { duration: decoded.duration, length: decoded.length,
          numberOfChannels: decoded.numberOfChannels, sampleRate: decoded.sampleRate };
      }, Buffer.from(bytes).toString('base64')));
      const file = opusFile({ channels, packets: 101, granule: 96312n });
      const track = await storeTrack(file);
      const verified = await decode.mock.results[0].value;
      expect(verified).toMatchObject({ sampleRate: 44100, numberOfChannels: channels });
      expect(verified.length).toBe(Math.round(verified.duration * 44100));
      expect(Math.abs(verified.duration - 2)).toBeLessThan(0.05);
      expect(track.duration).toBe(2);
      expect(await (await getTrackBlob(track.id))!.arrayBuffer()).toEqual(await mockM4aContainer(2, channels).arrayBuffer());
      expect(conversion).toHaveBeenCalledOnce();
    } finally { await browser.close(); }
  }, 15000);

  it.each([1024 * 1024, 2 * 1024 * 1024])('validates %i bytes of metadata under the source cap before passing the intact file to conversion', async commentBytes => {
    browserAudio((9600 - 312) / 48000);
    const file = opusFile({ channels: 2, commentBytes });
    const originalHash = await sha256(file);
    const imported = await storeTrack(file);
    expect(imported.duration).toBe((9600 - 312) / 48000);
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(await sha256((await getTrackBlob(imported.id))!)).toBe(await sha256(mockM4aContainer(imported.duration, 2)));
    expect(await sha256(file)).toBe(originalHash);
  });

  it('roundtrips a legacy six-minute WAV above 32 MiB through cloud native decode without relaxing local imports', async () => {
    const bytes = await generateDemoWav(1080, 100, 'soft').arrayBuffer();
    const header = new DataView(bytes);
    header.setUint32(24, 48000, true);
    header.setUint32(28, 96000, true);
    const normalized = new Blob([bytes], { type: 'audio/wav' });
    const local = { id: 'legacy', title: 'Synthetic legacy audio', duration: 360, bpm: 100, firstBeat: 0, cues: [], bodyArea: '' };
    expect(normalized.type).toBe('audio/wav');
    expect(normalized.size).toBeGreaterThan(MAX_TRACK_BYTES);
    expect(normalized.size).toBeLessThan(128 * 1024 * 1024);
    const hash = await sha256(normalized);
    const decode = browserAudio(local.duration);
    await expect(storeTrack(new File([normalized], 'normalized.wav', { type: normalized.type })))
      .rejects.toThrow('audio_byte_limit');
    expect(decode).not.toHaveBeenCalled();
    await cacheCloudTrack('cloud-entry', normalized, hash);
    expect(decode).toHaveBeenCalledOnce();
    expect(decode.mock.calls[0][0].byteLength).toBe(normalized.size);
    vi.resetModules();
    const reloaded = await import('../frontend/src/offline');
    const cached = (await reloaded.getTrackBlob('cloud-entry'))!;
    expect(cached.type).toBe(normalized.type);
    expect(cached.size).toBe(normalized.size);
    expect(await sha256(cached)).toBe(hash);
    decode.mockClear();
    expect(await reloaded.getReadiness({ ...newRoutine(), tracks: [{ ...local, id: 'cloud-entry' }] }))
      .toEqual({ ready: true, missing: [] });
    expect(decode).not.toHaveBeenCalled();
    expect(conversion).not.toHaveBeenCalled();
  }, 30000);

  it('validates metadata and actual decoding before storing a file', async () => {
    browserAudio(2);
    const file = new File([generateDemoWav(2, 100, 'soft')], 'practice.wav', { type: 'audio/wav' });
    const track = await storeTrack(file);
    expect(track.duration).toBe(2);
    expect(track.title).toBe('practice.wav');
    expect((await getTrackBlob(track.id))?.size).toBe(file.size);
  });

  it.each([
    ['practice.mp3', 'audio/mpeg'], ['practice.m4a', 'audio/mp4'],
    ['practice.wav', 'audio/wav'], ['practice.flac', 'audio/flac'], ['practice.m4a', ''],
  ])('preserves native %s (%s) bytes and hash but still rejects invalid input', async (name, type) => {
    const decode = browserAudio(2);
    let source: BlobPart = 'synthetic encoded audio';
    if (name.endsWith('.wav')) source = generateDemoWav(2, 100, 'soft');
    if (name.endsWith('.m4a')) source = mockM4aContainer(2, 2);
    if (name.endsWith('.mp3')) {
      source = new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
        'anullsrc=sample_rate=44100:channel_layout=stereo', '-t', '2', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'],
      { timeout: 15000, maxBuffer: MAX_TRACK_BYTES }));
    }
    conversion.mockRejectedValueOnce(new Error('conversion_unavailable'));
    const file = new File([source], name, { type });
    const track = await storeTrack(file);
    const stored = (await getTrackBlob(track.id))!;
    expect(track.duration).toBe(2);
    expect(await stored.arrayBuffer()).toEqual(await file.arrayBuffer());
    expect(await sha256(stored)).toBe(await sha256(file));
    expect(conversion).not.toHaveBeenCalled();
    decode.mockRejectedValueOnce(new Error('not audio'));
    await expect(storeTrack(new File(['not audio'], name, { type }))).rejects.toThrow(
      name.endsWith('.m4a') ? 'invalid_audio_container' : 'conversion_unavailable');
    expect(stores.tracks.size).toBe(1);
  });

  it.each([
    ['practice.wav', 'audio/x-wav', 'audio/wav'], ['practice.wav', 'audio/wave', 'audio/wav'],
    ['practice.wav', '', 'audio/wav'], ['practice.wav', 'application/octet-stream', 'audio/wav'],
    ['practice.m4a', 'audio/x-m4a', 'audio/mp4'], ['practice.m4a', 'audio/mp4; codecs=mp4a.40.2', 'audio/mp4'],
    ['practice.m4a', '', 'audio/mp4'], ['practice.m4a', 'application/octet-stream', 'audio/mp4'],
    ['practice.mp3', 'audio/mp3', 'audio/mpeg'], ['practice.mp3', '', 'audio/mpeg'],
  ])('canonicalizes local %s (%s) to %s without changing song/filler bytes', async (name, type, canonical) => {
    const source = name.endsWith('.m4a') ? mockM4aContainer(2, 2) : name.endsWith('.wav') ? generateDemoWav(2, 100, 'soft') :
      new Blob([new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
        'anullsrc=sample_rate=44100:channel_layout=stereo', '-t', '2', '-c:a', 'libmp3lame', '-threads', '1', '-f', 'mp3', 'pipe:1'],
      { timeout: 15000, maxBuffer: MAX_TRACK_BYTES }))]);
    const file = new File([source], name, { type });
    browserAudio(2);
    conversion.mockRejectedValue(new Error('conversion_unavailable'));
    const track = await storeTrack(file);
    const recording = await addFillerRecording(file);
    const song = (await getTrackBlob(track.id))!;
    const filler = (await getFillerRecordingBlob(recording))!;
    expect(song.type).toBe(canonical);
    expect(filler.type).toBe(canonical);
    expect(recording.asset.contentType).toBe(canonical);
    expect(await song.arrayBuffer()).toEqual(await file.arrayBuffer());
    expect(await filler.arrayBuffer()).toEqual(await file.arrayBuffer());
    expect(recording.asset.sha256).toBe(await sha256(file));
    expect(conversion).not.toHaveBeenCalled();
  });

  async function leadingMp4Fixture(kind: 'free' | 'skip' | 'wide'): Promise<Uint8Array<ArrayBuffer>> {
    const padding = new Uint8Array(kind === 'free' ? 1024 : kind === 'skip' ? 16 : 8);
    const paddingView = new DataView(padding.buffer);
    paddingView.setUint32(0, kind === 'skip' ? 1 : padding.length);
    padding.set(new TextEncoder().encode(kind), 4);
    if (kind === 'skip') paddingView.setBigUint64(8, BigInt(padding.length));
    const bytes = new Uint8Array(await mockM4aContainer(2, 2, AAC_IMPORT.sampleRate, true).arrayBuffer());
    const result = new Uint8Array(padding.length + bytes.length);
    result.set(padding);
    result.set(bytes, padding.length);
    return result;
  }

  it.each(['free', 'skip', 'wide'] as const)('natively decodes leading MP4 %s with correct offsets and preserves original song/filler hashes', async kind => {
    const bytes = await leadingMp4Fixture(kind);
    const file = new File([bytes], kind === 'free' ? 'disguised.wav' : 'synthetic.m4a', {
      type: kind === 'free' ? 'audio/wav' : 'audio/mp4',
    });
    const originalHash = await sha256(file);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const decode = browserAudio(2);
      decode.mockImplementation(input => page.evaluate(async base64 => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes.buffer);
        return { duration: decoded.duration, length: decoded.length, numberOfChannels: decoded.numberOfChannels };
      }, Buffer.from(input).toString('base64')));
      const track = await storeTrack(file);
      const recording = await addFillerRecording(file);
      expect(track.duration).toBeGreaterThan(1.9);
      expect(track.duration).toBeLessThan(2.1);
      expect(recording.duration).toBe(track.duration);
      expect(recording.asset).toMatchObject({ sha256: originalHash, bytes: file.size, contentType: 'audio/mp4' });
      for (const stored of [(await getTrackBlob(track.id))!, (await getFillerRecordingBlob(recording))!]) {
        expect(stored.type).toBe('audio/mp4');
        expect(await stored.arrayBuffer()).toEqual(await file.arrayBuffer());
        expect(await sha256(stored)).toBe(originalHash);
      }
      expect(await sha256(file)).toBe(originalHash);
      expect(decode).toHaveBeenCalledTimes(2);
      expect(conversion).not.toHaveBeenCalled();
    } finally { await browser.close(); }
  }, 15000);

  it.each((['free', 'skip', 'wide'] as const).flatMap(atom =>
    ['video', 'protected'].flatMap(defect => ['song', 'filler', 'cloud'].map(kind => ({ atom, defect, kind })))))(
    'rejects leading MP4 $atom $defect disguised as WAV for $kind before any native decode', async ({ atom, defect, kind }) => {
      const bytes = Buffer.from(await leadingMp4Fixture(atom));
      if (defect === 'video') bytes.write('vide', bytes.indexOf('soun'));
      else bytes.write('enca', bytes.indexOf('mp4a'));
      const file = new File([bytes], 'disguised.wav', { type: 'audio/wav' });
      const decode = browserAudio(2);
      const operation = kind === 'song' ? storeTrack(file) : kind === 'filler' ? addFillerRecording(file) :
        cacheCloudTrack('rejected', file, await sha256(file));
      await expect(operation).rejects.toThrow(defect === 'video' ? 'audio_video_not_allowed' : 'protected_audio');
      expect(decode).not.toHaveBeenCalled();
      expect(conversion).not.toHaveBeenCalled();
      expect(storage.opens).toBe(0);
      expect(stores.tracks.size).toBe(0);
      expect(stores.fillerRecordings.size).toBe(0);
    },
  );

  it.each(['missing-ftyp', 'short-ftyp', 'misaligned-ftyp', 'duplicate-ftyp', 'truncated-atom', 'oversized-atom'])(
    'rejects leading MP4 with %s by validating top-level atom structure', async defect => {
      const bytes = Buffer.from(await leadingMp4Fixture('wide'));
      if (defect === 'missing-ftyp') bytes.write('free', 12);
      if (defect === 'short-ftyp') bytes.writeUInt32BE(12, 8);
      if (defect === 'misaligned-ftyp') bytes.writeUInt32BE(17, 8);
      if (defect === 'oversized-atom') bytes.writeUInt32BE(bytes.length + 1, 0);
      const extra = defect === 'duplicate-ftyp' ? bytes.subarray(8, 8 + bytes.readUInt32BE(8)) :
        defect === 'truncated-atom' ? new Uint8Array(4) : new Uint8Array();
      const decode = browserAudio(2);
      await expect(storeTrack(new File([bytes, extra], 'disguised.wav', { type: 'audio/wav' })))
        .rejects.toThrow('invalid_audio_container');
      expect(decode).not.toHaveBeenCalled();
      expect(conversion).not.toHaveBeenCalled();
      expect(storage.opens).toBe(0);
    },
  );

  function webmFixture(kind: 'audio' | 'video' | 'protected' | 'multichannel' | 'opus'): Blob {
    const element = (id: number, payload: Uint8Array) => {
      const identifier = Buffer.from(id.toString(16).padStart(Math.ceil(id.toString(16).length / 2) * 2, '0'), 'hex');
      if (payload.length >= 127) throw new Error('fixture too large');
      return new Uint8Array([...identifier, 128 | payload.length, ...payload]);
    };
    const join = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => [...part]));
    const rate = new Uint8Array(4);
    new DataView(rate.buffer).setFloat32(0, 48000);
    const settings = element(0xe1, join(element(0x9f, new Uint8Array([kind === 'multichannel' ? 6 : 2])), element(0xb5, rate)));
    const protection = kind === 'protected' ? element(0x6d80, element(0x6240, element(0x5035, new Uint8Array()))) : new Uint8Array();
    const track = element(0xae, join(element(0x83, new Uint8Array([kind === 'video' ? 1 : 2])),
      element(0x86, new TextEncoder().encode(kind === 'opus' ? 'A_OPUS' : 'A_VORBIS')), settings, protection));
    return new Blob([element(0x1a45dfa3, element(0x4282, new TextEncoder().encode('webm'))),
      element(0x18538067, element(0x1654ae6b, track))], { type: 'audio/webm' });
  }

  it.each(['song', 'filler', 'cloud'].flatMap(kind => ['mp4', 'webm'].flatMap(format =>
    ['video', 'protected', 'multichannel', 'malformed'].map(defect => [kind, format, defect]))))(
    'rejects %s %s %s before native preservation, conversion or cache writes', async (kind, format, defect) => {
      let blob: Blob;
      if (format === 'mp4') {
        const bytes = Buffer.from(await mockM4aContainer(2, defect === 'multichannel' ? 6 : 2).arrayBuffer());
        if (defect === 'video') bytes.write('vide', bytes.indexOf('soun'));
        if (defect === 'protected') bytes.write('enca', bytes.indexOf('mp4a'));
        if (defect === 'malformed') bytes.writeUInt32BE(bytes.length + 1, 0);
        blob = new Blob([bytes], { type: 'audio/mp4' });
      } else {
        blob = webmFixture(defect === 'malformed' ? 'audio' : defect as 'video' | 'protected' | 'multichannel');
        if (defect === 'malformed') blob = blob.slice(0, blob.size - 1, blob.type);
      }
      const file = new File([blob], `disguised.${format === 'mp4' ? 'm4a' : 'webm'}`, { type: blob.type });
      const decode = browserAudio(2);
      const operation = kind === 'song' ? storeTrack(file) : kind === 'filler' ? addFillerRecording(file) :
        cacheCloudTrack('rejected', file, await sha256(file));
      await expect(operation).rejects.toThrow(defect === 'video' ? 'audio_video_not_allowed' :
        defect === 'protected' ? 'protected_audio' : defect === 'multichannel' ? 'audio_memory_limit' : 'invalid_audio_container');
      expect(decode).not.toHaveBeenCalled();
      expect(conversion).not.toHaveBeenCalled();
      expect(storage.opens).toBe(0);
      expect(stores.tracks.size).toBe(0);
      expect(stores.fillerRecordings.size).toBe(0);
    },
  );

  it.each(['libvorbis', 'libopus'])('inspects real audio-only WebM %s before choosing preservation or AAC conversion', async codec => {
    const source = new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'anullsrc=sample_rate=48000:channel_layout=stereo', '-t', '2', '-c:a', codec, '-threads', '1', '-f', 'webm', 'pipe:1'],
    { timeout: 15000, maxBuffer: MAX_TRACK_BYTES }));
    const file = new File([source], 'synthetic.webm', { type: 'audio/webm' });
    const decode = browserAudio(2);
    conversion.mockResolvedValueOnce({ blob: mockM4aContainer(2, 2), duration: 2 });
    const track = await storeTrack(file);
    const stored = (await getTrackBlob(track.id))!;
    if (codec === 'libopus') {
      expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
      expect(stored.type).toBe('audio/mp4');
    } else {
      expect(conversion).not.toHaveBeenCalled();
      expect(stored.type).toBe('audio/webm');
      expect(await stored.arrayBuffer()).toEqual(await file.arrayBuffer());
    }
    expect(decode).toHaveBeenCalledExactlyOnceWith(await stored.arrayBuffer());
  });

  it.each(['codec', 'sample-rate', 'encoded-channels', 'decoded-channels'])('rejects converted AAC %s mismatch before caching', async defect => {
    browserAudio((9600 - 312) / 48000, (9600 - 312) / 48000, defect === 'decoded-channels' ? 2 : 1);
    let blob = mockM4aContainer((9600 - 312) / 48000, defect === 'encoded-channels' ? 2 : 1,
      defect === 'sample-rate' ? 44100 : AAC_IMPORT.sampleRate);
    if (defect === 'codec') {
      const bytes = Buffer.from(await blob.arrayBuffer());
      bytes.write('alac', bytes.indexOf('mp4a'));
      blob = new Blob([bytes], { type: 'audio/mp4' });
    }
    conversion.mockResolvedValueOnce({ blob, duration: (9600 - 312) / 48000 });
    await expect(storeTrack(opusFile())).rejects.toThrow(/invalid_converted_audio|audio_channel_mismatch/);
    expect(storage.opens).toBe(0);
    expect(stores.tracks.size).toBe(0);
  });

  it('rejects byte/MIME/duration/channel limits and never stores a rejected file', async () => {
    const decode = browserAudio(361);
    await expect(storeTrack(new File(['text'], 'script.html', { type: 'text/html' }))).rejects.toThrow('unsupported_audio');
    await expect(storeTrack({ size: MAX_TRACK_BYTES + 1 } as File)).rejects.toThrow('audio_byte_limit');
    const file = new File(['audio'], 'test.wav', { type: 'audio/wav' });
    await expect(storeTrack(file)).rejects.toThrow('audio_duration_limit');
    expect(decode).not.toHaveBeenCalled();
    browserAudio(2, 500);
    await expect(storeTrack(file)).rejects.toThrow('audio_duration_limit');
    browserAudio(2, 2, 6);
    await expect(storeTrack(file)).rejects.toThrow('audio_memory_limit');
    expect(stores.tracks.size).toBe(0);
    expect(conversion).not.toHaveBeenCalled();
  });

  it('does not trust application/ogg without an Ogg Opus header', async () => {
    const decode = browserAudio(2);
    await expect(storeTrack(new File(['not Ogg Opus'], 'practice.opus', {
      type: 'application/ogg',
    }))).rejects.toThrow('unsupported_audio');
    expect(decode).not.toHaveBeenCalled();
    expect(stores.tracks.size).toBe(0);
  });

  it.each([
    ['synthetic.opus', 'audio/opus'], ['synthetic.ogg', 'application/ogg'],
    ['synthetic.opus', 'application/octet-stream'], ['synthetic.opus', ''],
    ['synthetic.ogg', 'audio/ogg; codecs=opus'],
    ['synthetic.opus', 'audio/x-opus'], ['synthetic.opus', 'audio/x-opus+ogg'],
  ])('always converts validated Ogg Opus %s (%s) and natively verifies only the M4A result', async (name, type) => {
    const decode = browserAudio((9600 - 312) / 48000, (9600 - 312) / 48000, 1);
    const file = opusFile({ name, type });
    const original = await file.arrayBuffer();
    const track = await storeTrack(file);
    expect(track.duration).toBe((9600 - 312) / 48000);
    const blob = (await getTrackBlob(track.id))!;
    expect(blob.type).toBe('audio/mp4');
    expect(await blob.arrayBuffer()).toEqual(await mockM4aContainer().arrayBuffer());
    expect(decode).toHaveBeenCalledExactlyOnceWith(await blob.arrayBuffer());
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(await sha256(blob)).not.toBe(await sha256(file));
    expect(await file.arrayBuffer()).toEqual(original);
  });

  it('rejects Opus header duration/channel limits and corrupt pages before conversion', async () => {
    await expect(storeTrack(opusFile({ channels: 3 }))).rejects.toThrow('audio_memory_limit');
    await expect(storeTrack(opusFile({ granule: 48000n * 361n }))).rejects.toThrow('audio_duration_limit');
    await expect(storeTrack(opusFile({ granule: 900n }))).rejects.toThrow('invalid_ogg_opus');
    const bytes = new Uint8Array(await opusFile().arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    await expect(storeTrack(new File([bytes], 'broken.opus', { type: 'audio/opus' }))).rejects.toThrow('invalid_ogg_opus');
    expect(stores.tracks.size).toBe(0);
    expect(conversion).not.toHaveBeenCalled();
  });

  it('keeps cloud Opus bytes immutable and requires native playback support instead of silently normalizing', async () => {
    const file = opusFile();
    const hash = await sha256(file);
    const duration = (9600 - 312) / 48000;
    const decode = browserAudio(duration, duration, 1);
    await cacheCloudTrack('native-opus', file, hash);
    const stored = (await getTrackBlob('native-opus'))!;
    expect(stored.type).toBe(file.type);
    expect(await stored.arrayBuffer()).toEqual(await file.arrayBuffer());
    decode.mockRejectedValueOnce(new Error('codec unavailable'));
    await expect(cacheCloudTrack('unsupported-opus', file, hash)).rejects.toThrow('unsupported_audio');
    expect(stores.tracks.has('unsupported-opus')).toBe(false);
    const invalid = opusFile({ channels: 3 });
    await expect(cacheCloudTrack('invalid-opus', invalid, await sha256(invalid))).rejects.toThrow('audio_memory_limit');
    expect(decode).toHaveBeenCalledTimes(2);
    expect(conversion).not.toHaveBeenCalled();
  });

  it('rejects oversized packet-derived duration even if the final granule lies', async () => {
    await expect(storeTrack(opusFile({ packets: 18100, granule: 9600n }))).rejects.toThrow('audio_duration_limit');
    expect(conversion).not.toHaveBeenCalled();
    expect(stores.tracks.size).toBe(0);
  });

  it('roundtrips newly converted AAC through immutable cloud storage with the same type, bytes and hash', async () => {
    const track = await storeTrack(opusFile());
    const blob = (await getTrackBlob(track.id))!;
    const hash = await sha256(blob);
    const decode = browserAudio(track.duration, track.duration, 1);
    conversion.mockRejectedValue(new Error('conversion_unavailable'));
    await cacheCloudTrack('aac-cloud', blob, hash);
    expect((await getTrackBlob('aac-cloud'))!.type).toBe('audio/mp4');
    expect(await (await getTrackBlob('aac-cloud'))!.arrayBuffer()).toEqual(await blob.arrayBuffer());
    expect(stores.tracks.get('aac-cloud')).toMatchObject({ sha256: hash, bytes: blob.size, duration: track.duration });
    expect(conversion).toHaveBeenCalledOnce();
    decode.mockRejectedValueOnce(new Error('codec unavailable'));
    await expect(cacheCloudTrack('unsupported-aac', blob, hash)).rejects.toThrow('unsupported_audio');
    expect(conversion).toHaveBeenCalledOnce();
    expect(stores.tracks.has('unsupported-aac')).toBe(false);
  });

  it('does not convert immutable cloud audio after a native metadata failure', async () => {
    const blob = mockM4aContainer();
    const decode = browserAudio(2);
    nativeMetadataFailure('unsupported');
    await expect(cacheCloudTrack('unsupported-cloud', blob, await sha256(blob))).rejects.toThrow('unsupported_audio');
    expect(conversion).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(storage.opens).toBe(0);
  });

  it.each([
    { headerVersion: 2 }, { mapping: 1 }, { channels: 0 },
    { changePages: (pages: Uint8Array[]) => { pages[0][4] = 1; } },
    { changePages: (pages: Uint8Array[]) => { pages[0][26] = 0; } },
    { changePages: (pages: Uint8Array[]) => { pages[2][5] = 0; } },
    { changePages: (pages: Uint8Array[]) => { pages[2][14] ^= 1; } },
    { changePages: (pages: Uint8Array[]) => { pages[2][18] = 1; } },
    { changePages: (pages: Uint8Array[]) => { pages[2][5] |= 1; } },
    { changePages: (pages: Uint8Array[]) => { pages.push(pages[0].slice()); } },
  ])('rejects unsupported headers, missing EOS, chains and broken sequence/continuation', async options => {
    await expect(storeTrack(opusFile(options))).rejects.toThrow(/invalid_ogg_opus|audio_memory_limit/);
    expect(conversion).not.toHaveBeenCalled();
    expect(stores.tracks.size).toBe(0);
  });

  it('delegates intact multiple-page stereo Opus and stores only the verified compressed result', async () => {
    browserAudio((300 * 960 - 312) / 48000);
    const file = opusFile({ channels: 2, packets: 300 });
    const track = await storeTrack(file);
    expect(track.duration).toBe((300 * 960 - 312) / 48000);
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect((await getTrackBlob(track.id))!.type).toBe('audio/mp4');
    expect((await getTrackBlob(track.id))!.size).toBe(mockM4aContainer(track.duration, 2).size);
  });

  it('accepts a six-minute mono Opus timeline within encoder and native decoded-memory limits', async () => {
    browserAudio(360, 360, 1);
    const track = await storeTrack(opusFile({ channels: 1, packets: 18001, granule: 360n * 48000n + 312n }));
    expect(track.duration).toBe(360);
    const blob = (await getTrackBlob(track.id))!;
    expect(blob.size).toBeLessThan(AAC_IMPORT.maxOutputBytes);
    expect(blob.type).toBe('audio/mp4');
    const routine = newRoutine();
    routine.tracks.push(track);
    expect(await getReadiness(routine)).toEqual({ ready: true, missing: [] });
  }, 15000);

  it('preserves the encoder stereo memory rejection even when a 44.1 kHz native buffer would fit', async () => {
    const decode = browserAudio(360);
    expect(360 * 44100 * 2 * 4).toBeLessThan(MAX_DECODED_BYTES);
    expect(360 * AAC_IMPORT.sampleRate * 2 * 4).toBeGreaterThan(MAX_DECODED_BYTES);
    await expect(storeTrack(opusFile({ channels: 2, packets: 18001, granule: 360n * 48000n + 312n })))
      .rejects.toThrow('conversion_memory_limit');
    expect(conversion).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    expect(storage.opens).toBe(0);
  });

  it('passes original Opus pre-skip, end trimming and output gain to the encoder without rewriting headers', async () => {
    const file = opusFile({ gain: 6 * 256, granule: 9500n });
    const original = await file.arrayBuffer();
    browserAudio((9500 - 312) / 48000, (9500 - 312) / 48000, 1);
    const track = await storeTrack(file);
    expect(track.duration).toBe((9500 - 312) / 48000);
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(await conversion.mock.calls[0][0].arrayBuffer()).toEqual(original);
    const header = new DataView(original);
    expect(header.getUint16(38, true)).toBe(312);
    expect(header.getInt16(44, true)).toBe(6 * 256);
  });

  it('does not store a transient conversion failure and permits the queued next import', async () => {
    conversion.mockRejectedValueOnce(new Error('conversion_failed'));
    const outcomes = await Promise.allSettled([storeTrack(opusFile()), storeTrack(opusFile())]);
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: new Error('conversion_failed') });
    expect(outcomes[1].status).toBe('fulfilled');
    expect(conversion).toHaveBeenCalledTimes(2);
    expect(stores.tracks.size).toBe(1);
  });

  it('rejects a converted native decode drift of 30ms before storage', async () => {
    const duration = (9600 - 312) / 48000;
    browserAudio(duration, duration + 0.03);
    await expect(storeTrack(opusFile())).rejects.toThrow('audio_duration_mismatch');
    expect(stores.tracks.size).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, 361])('rejects invalid converter duration %s before storage', async duration => {
    conversion.mockResolvedValueOnce({ blob: mockM4aContainer(), duration });
    await expect(storeTrack(opusFile())).rejects.toThrow('audio_duration_limit');
    expect(stores.tracks.size).toBe(0);
  });

  it.each([
    'conversion_unavailable', 'conversion_worker_failed', 'conversion_timeout', 'conversion_invalid_audio',
    'conversion_protected_audio', 'conversion_video_not_allowed', 'conversion_no_audio', 'conversion_multiple_audio',
    'conversion_source_limit', 'conversion_output_limit', 'conversion_channel_limit', 'conversion_duration_limit',
    'conversion_memory_limit', 'conversion_invalid_output', 'conversion_failed', 'conversion_aborted',
  ])('propagates %s without retrying or persisting a partial track or filler', async code => {
    conversion.mockRejectedValue(new Error(code));
    await expect(storeTrack(opusFile())).rejects.toThrow(code);
    await expect(addFillerRecording(opusFile())).rejects.toThrow(code);
    expect(conversion).toHaveBeenCalledTimes(2);
    expect(storage.opens).toBe(0);
    expect(stores.tracks.size).toBe(0);
    expect(stores.fillerRecordings.size).toBe(0);
  });

  it.each([
    ['synthetic.mp3', 'audio/mpeg'], ['synthetic.m4a', 'audio/mp4'], ['synthetic.aac', 'audio/aac'],
    ['synthetic.wav', 'audio/wav'], ['synthetic.ogg', 'audio/ogg'], ['synthetic.flac', 'audio/flac'],
    ['synthetic.webm', 'audio/webm'], ['synthetic.aiff', 'audio/aiff'], ['synthetic.aif', 'audio/x-aiff'],
    ['synthetic.wma', 'audio/x-ms-wma'], ['synthetic.aif', ''], ['synthetic.wma', 'application/octet-stream'],
    ['synthetic.caf', 'audio/x-caf'], ['synthetic.unknown', 'audio/x-vorbis+ogg'],
    ['synthetic.unknown', 'audio/ogg; codecs=vorbis'],
  ])('converts eligible %s (%s) after native codec failure and hashes only the M4A', async (name, type) => {
    const decode = browserAudio(2);
    decode.mockRejectedValueOnce(new Error('codec unavailable'));
    const output = mockM4aContainer(2, 2);
    conversion.mockResolvedValueOnce({ blob: output, duration: 2 });
    const source = name.endsWith('.m4a') ? mockM4aContainer(2, 2, 44100) : 'synthetic unsupported codec fixture';
    const file = new File([source], name, { type });
    const originalHash = await sha256(file);
    const track = await storeTrack(file);
    const stored = (await getTrackBlob(track.id))!;
    expect(track.duration).toBe(2);
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls[1][0]).toEqual(await output.arrayBuffer());
    expect(stored.type).toBe('audio/mp4');
    expect(await stored.arrayBuffer()).toEqual(await output.arrayBuffer());
    expect(stores.tracks.get(track.id)).toMatchObject({ bytes: output.size, duration: 2, sha256: await sha256(output) });
    expect(await sha256(file)).toBe(originalHash);
  });

  it('converts a native metadata failure, then probes and decodes the output and revokes both URLs', async () => {
    const decode = browserAudio(2);
    nativeMetadataFailure('unsupported');
    const urls = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const file = new File(['synthetic audio'], 'synthetic.aiff', { type: 'audio/aiff' });
    conversion.mockResolvedValueOnce({ blob: mockM4aContainer(2, 2), duration: 2 });
    const track = await storeTrack(file);
    expect(track.duration).toBe(2);
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(decode).toHaveBeenCalledOnce();
    expect(urls).toHaveBeenCalledTimes(2);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(urls.mock.results.map(result => result.value));
  });

  it('accepts an intact application/ogg Vorbis source for bounded fallback', async () => {
    const source = new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'anullsrc=sample_rate=48000:channel_layout=stereo', '-t', '2', '-c:a', 'libvorbis', '-f', 'ogg', 'pipe:1'],
    { timeout: 15000, maxBuffer: MAX_TRACK_BYTES }));
    const file = new File([source], 'synthetic.ogg', { type: 'application/ogg' });
    const decode = browserAudio(2);
    decode.mockRejectedValueOnce(new Error('native Vorbis unavailable'));
    const output = mockM4aContainer(2, 2);
    conversion.mockResolvedValueOnce({ blob: output, duration: 2 });
    const track = await storeTrack(file);
    expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
    expect(await file.arrayBuffer()).toEqual(source.buffer);
    expect(await (await getTrackBlob(track.id))!.arrayBuffer()).toEqual(await output.arrayBuffer());
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it.each(['song', 'filler', 'cloud'])('handles %s metadata timeout without converting immutable downloads', async kind => {
    vi.useFakeTimers();
    const decode = browserAudio(2);
    const began = nativeMetadataFailure('timeout');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const file = new File(['audio'], 'synthetic.aiff', { type: 'audio/aiff' });
    conversion.mockResolvedValueOnce({ blob: mockM4aContainer(2, 2), duration: 2 });
    const converted = deferred<void>();
    decode.mockImplementation(async () => {
      vi.useRealTimers();
      converted.resolve();
      return { duration: 2, numberOfChannels: 2, length: 88200 };
    });
    const operation = kind === 'song' ? storeTrack(file) : kind === 'filler' ? addFillerRecording(file) :
      cacheCloudTrack('timeout-cloud', file, await sha256(file));
    const outcome = Promise.allSettled([operation]);
    await began;
    await vi.advanceTimersByTimeAsync(15000);
    if (kind === 'cloud') {
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('audio_metadata_timeout') });
      expect(conversion).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledOnce();
      expect(storage.opens).toBe(0);
    } else {
      await converted.promise;
      expect((await outcome)[0].status).toBe('fulfilled');
      expect(conversion).toHaveBeenCalledExactlyOnceWith(file, { signal: expect.any(AbortSignal) });
      expect(decode).toHaveBeenCalledOnce();
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(stores.tracks.size).toBe(1);
    }
  });

  it.each(['metadata', 'decode'])('rejects detected protected audio at %s without conversion', async stage => {
    const decode = browserAudio(2);
    if (stage === 'metadata') nativeMetadataFailure('protected');
    else decode.mockRejectedValueOnce(new Error('encrypted DRM audio'));
    await expect(storeTrack(new File([mockM4aContainer(2, 2)], 'synthetic.m4a', { type: 'audio/mp4' })))
      .rejects.toThrow('protected_audio');
    expect(conversion).not.toHaveBeenCalled();
    expect(storage.opens).toBe(0);
  });

  it.each([
    { duration: NaN, numberOfChannels: 2, length: 88200 },
    { duration: 0, numberOfChannels: 2, length: 88200 },
    { duration: 361, numberOfChannels: 2, length: 88200 },
    { duration: 2, numberOfChannels: 0, length: 88200 },
    { duration: 2, numberOfChannels: 3, length: 88200 },
    { duration: 2, numberOfChannels: 2, length: MAX_DECODED_BYTES / 8 + 1 },
    { duration: 2, numberOfChannels: 2, length: NaN },
  ])('does not reprocess natively decoded audio that fails hard bounds: %j', async invalid => {
    browserAudio(2).mockResolvedValueOnce(invalid);
    await expect(storeTrack(new File(['synthetic audio'], 'synthetic.wav', { type: 'audio/wav' })))
      .rejects.toThrow(/audio_duration_limit|audio_memory_limit/);
    expect(conversion).not.toHaveBeenCalled();
    expect(storage.opens).toBe(0);
  });

  it.each(['text/html', 'application/json', 'application/pdf', 'video/mp4', 'video/webm', 'audio/', 'audio/mp4/html'])(
    'never offers %s documents or video to conversion based on an audio filename', async type => {
      const decode = browserAudio(2);
      await expect(storeTrack(new File(['not audio'], 'synthetic.m4a', { type }))).rejects.toThrow('unsupported_audio');
      expect(conversion).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
      expect(storage.opens).toBe(0);
    },
  );

  it('enforces source bytes before reading even with an eligible MIME and filename', async () => {
    const file = new File(['synthetic audio'], 'synthetic.aiff', { type: 'audio/aiff' });
    Object.defineProperty(file, 'size', { value: MAX_TRACK_BYTES + 1 });
    const read = vi.spyOn(file, 'arrayBuffer');
    const slice = vi.spyOn(file, 'slice');
    await expect(storeTrack(file)).rejects.toThrow('audio_byte_limit');
    expect(read).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    expect(conversion).not.toHaveBeenCalled();
  });

  it('rejects malformed continued OpusTags before invoking conversion', async () => {
    const file = opusFile({ commentBytes: 70000, changePages: pages => {
      const body = 27 + pages[1][26];
      new DataView(pages[1].buffer).setUint32(body + 8, MAX_TRACK_BYTES + 1, true);
    } });
    await expect(storeTrack(file)).rejects.toThrow('invalid_ogg_opus');
    expect(conversion).not.toHaveBeenCalled();
  });

  it.each(['wrong-type', 'disguised-wav', 'truncated', 'missing-media', 'empty', 'oversized'])(
    'rejects %s converter output before native decoding or storage', async defect => {
      const decode = browserAudio((9600 - 312) / 48000);
      let output = mockM4aContainer();
      if (defect === 'wrong-type') output = output.slice(0, output.size, 'audio/wav');
      if (defect === 'disguised-wav') {
        const wav = generateDemoWav(1, 100, 'soft');
        output = wav.slice(0, wav.size, 'audio/mp4');
      }
      if (defect === 'truncated') output = output.slice(0, output.size - 1, 'audio/mp4');
      if (defect === 'missing-media') output = output.slice(0, 36, 'audio/mp4');
      if (defect === 'empty') output = new Blob([], { type: 'audio/mp4' });
      if (defect === 'oversized') Object.defineProperty(output, 'size', { value: AAC_IMPORT.maxOutputBytes + 1 });
      const read = vi.spyOn(output, 'arrayBuffer');
      conversion.mockResolvedValueOnce({ blob: output, duration: (9600 - 312) / 48000 });
      await expect(storeTrack(opusFile())).rejects.toThrow(/invalid_converted_audio|audio_byte_limit/);
      if (['wrong-type', 'empty', 'oversized'].includes(defect)) expect(read).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
      expect(storage.opens).toBe(0);
    },
  );

  it('rejects plausible M4A headers when native decoding finds invalid payload instead of trying conversion again', async () => {
    const decode = browserAudio((9600 - 312) / 48000);
    decode.mockRejectedValueOnce(new Error('invalid payload'));
    await expect(storeTrack(opusFile())).rejects.toThrow('unsupported_audio: native decoding failed');
    expect(conversion).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(storage.opens).toBe(0);
  });

  it.each(['converter-source', 'native-metadata', 'native-decode', 'cumulative-drift', 'fallback-source'])(
    'rejects a converted duration mismatch at %s', async stage => {
      const duration = (9600 - 312) / 48000;
      let file = opusFile();
      if (stage === 'converter-source') conversion.mockResolvedValueOnce({ blob: mockM4aContainer(duration + 0.06), duration: duration + 0.06 });
      if (stage === 'native-metadata') browserAudio(duration + 0.06);
      if (stage === 'native-decode') browserAudio(duration, duration + 0.06);
      if (stage === 'cumulative-drift') {
        conversion.mockResolvedValueOnce({ blob: mockM4aContainer(duration + 0.04), duration: duration + 0.04 });
        browserAudio(duration + 0.04, duration + 0.08);
      }
      if (stage === 'fallback-source') {
        browserAudio(2).mockRejectedValueOnce(new Error('codec unavailable'));
        conversion.mockResolvedValueOnce({ blob: mockM4aContainer(2.1, 2), duration: 2.1 });
        file = new File(['synthetic codec fixture'], 'synthetic.aiff', { type: 'audio/aiff' });
      }
      await expect(storeTrack(file)).rejects.toThrow('audio_duration_mismatch');
      expect(conversion).toHaveBeenCalledOnce();
      expect(storage.opens).toBe(0);
    },
  );

  it.each([
    { duration: 361, numberOfChannels: 2, length: 44100 },
    { duration: (9600 - 312) / 48000, numberOfChannels: 3, length: 8533 },
    { duration: (9600 - 312) / 48000, numberOfChannels: 2, length: MAX_DECODED_BYTES / 8 + 1 },
    { duration: (9600 - 312) / 48000, numberOfChannels: 2, length: NaN },
  ])('enforces converted native duration and whole-buffer memory bounds: %j', async invalid => {
    browserAudio((9600 - 312) / 48000).mockResolvedValueOnce(invalid);
    await expect(storeTrack(opusFile())).rejects.toThrow(/audio_duration_limit|audio_memory_limit/);
    expect(conversion).toHaveBeenCalledOnce();
    expect(storage.opens).toBe(0);
  });

  it('keeps the converter timeline in the filler descriptor when native priming differs within tolerance', async () => {
    const duration = (9600 - 312) / 48000 + 0.02;
    conversion.mockResolvedValueOnce({ blob: mockM4aContainer(duration), duration });
    const recording = await addFillerRecording(opusFile());
    expect(recording.duration).toBe(duration);
    expect(recording.asset).toMatchObject({ contentType: 'audio/mp4', bytes: mockM4aContainer(duration).size,
      sha256: await sha256(mockM4aContainer(duration)) });
    expect(stores.tracks.get(`filler-${recording.asset.id}`)).toMatchObject({ duration });
  });

  it('leaves existing records intact on converter cancellation and permits an explicit retry', async () => {
    const previous = new Blob(['synthetic existing bytes']);
    stores.tracks.set('untouched', previous);
    const file = opusFile();
    conversion.mockRejectedValueOnce(new Error('conversion_aborted'));
    await expect(storeTrack(file)).rejects.toThrow('conversion_aborted');
    expect([...stores.tracks]).toEqual([['untouched', previous]]);
    expect(storage.opens).toBe(0);
    const track = await storeTrack(file);
    expect((await getTrackBlob(track.id))!.type).toBe('audio/mp4');
    const retained = stores.tracks.get('untouched') as Blob;
    expect(retained.type).toBe(previous.type);
    expect(await retained.arrayBuffer()).toEqual(await previous.arrayBuffer());
  });

  it.each(['song', 'filler'].flatMap(kind => ['hash', 'commit'].map(stage => [kind, stage])))(
    'retains standalone %s cancellation through post-conversion %s and rejects previously queued imports', async (kind, stage) => {
      const events = new EventTarget();
      vi.stubGlobal('window', events);
      const began = deferred<void>();
      const resume = deferred<void>();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      if (stage === 'hash') vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
        began.resolve();
        await resume.promise;
        return digest(...args);
      });
      else storage.onRequest = async (_store, method) => {
        if (method !== 'put') return;
        began.resolve();
        await resume.promise;
      };
      const first = kind === 'song' ? storeTrack(opusFile()) : addFillerRecording(opusFile());
      const outcomes = Promise.allSettled([first, storeTrack(opusFile()), addFillerRecording(opusFile())]);
      await began.promise;
      events.dispatchEvent(new Event(hostedInvalidationEvent));
      resume.resolve();
      for (const outcome of await outcomes) expect(outcome).toMatchObject({
        status: 'rejected', reason: new Error('conversion_aborted'),
      });
      expect(conversion).toHaveBeenCalledOnce();
      expect(stores.tracks.size).toBe(0);
      expect(stores.fillerRecordings.size).toBe(0);
      if (stage === 'hash') expect(storage.opens).toBe(0);
      else expect(storage.aborts).toBe(1);
    },
  );

  it.each(['pagehide', hostedInvalidationEvent])('aborts standalone conversion on %s and removes temporary listeners', async event => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const remove = vi.spyOn(events, 'removeEventListener');
    const began = deferred<void>();
    const converted = deferred<{ blob: Blob; duration: number }>();
    conversion.mockImplementationOnce(() => { began.resolve(); return converted.promise; });
    const outcome = Promise.allSettled([storeTrack(opusFile())]);
    await began.promise;
    const signal = conversion.mock.calls[0][1]!.signal!;
    events.dispatchEvent(new Event(event));
    expect(signal.aborted).toBe(true);
    converted.resolve({ blob: mockM4aContainer(), duration: (9600 - 312) / 48000 });
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: new Error('conversion_aborted') });
    expect(remove.mock.calls.map(([name]) => name)).toEqual(['pagehide', hostedInvalidationEvent]);
    expect(storage.opens).toBe(0);
  });

  it.each(['success', 'failure'])('removes standalone conversion listeners after %s', async outcome => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const remove = vi.spyOn(events, 'removeEventListener');
    if (outcome === 'failure') conversion.mockRejectedValueOnce(new Error('conversion_failed'));
    const operation = storeTrack(opusFile());
    if (outcome === 'failure') await expect(operation).rejects.toThrow('conversion_failed');
    else await operation;
    const signal = conversion.mock.calls[0][1]!.signal!;
    expect(remove.mock.calls.map(([name]) => name)).toEqual(['pagehide', hostedInvalidationEvent]);
    events.dispatchEvent(new Event('pagehide'));
    events.dispatchEvent(new Event(hostedInvalidationEvent));
    expect(signal.aborted).toBe(false);
  });

  it('serializes conversion with native imports and filler imports without allocating a second converter', async () => {
    const began = deferred<void>();
    const converted = deferred<{ blob: Blob; duration: number }>();
    conversion.mockImplementationOnce(() => { began.resolve(); return converted.promise; });
    const duration = (9600 - 312) / 48000;
    const decode = browserAudio(duration, duration, 1);
    const outcomes = Promise.all([storeTrack(opusFile()),
      storeTrack(new File(['synthetic native audio'], 'synthetic.mp3', { type: 'audio/mpeg' })),
      addFillerRecording(opusFile())]);
    await began.promise;
    expect(conversion).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    expect(storage.opens).toBe(0);
    converted.resolve({ blob: mockM4aContainer(), duration });
    await outcomes;
    expect(conversion).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(3);
    expect(stores.tracks.size).toBe(3);
    expect(stores.fillerRecordings.size).toBe(1);
  });

  it('surfaces decode failure and allows a subsequent valid import', async () => {
    const decode = browserAudio(2);
    decode.mockRejectedValueOnce(new Error('bad file'));
    const file = new File(['audio'], 'test.wav', { type: 'audio/wav' });
    await expect(storeTrack(file)).rejects.toThrow('conversion_invalid_audio');
    expect((await storeTrack(file)).duration).toBe(2);
  });
});

describe('production-only service worker shell', () => {
  const origin = 'https://rehearsal.example/';
  const authUrl = `${origin}.auth/me`;
  const manifest = {
    'index.html': { isEntry: true, file: 'assets/app-123.js', css: ['assets/app-123.css'], assets: ['assets/font-123.woff2'] },
  };
  const source = readFileSync(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');

  const codecMetadata = JSON.parse(readFileSync(new URL('../infra/licensed-codecs.json', import.meta.url), 'utf8')) as {
    artifacts: { role: string; cache: boolean; publicPath?: string; buildName?: string; extension?: string; mimeType: string }[];
  };

  async function codecFixture() {
    return Promise.all(codecMetadata.artifacts.filter(artifact => artifact.cache).map(async artifact => {
      const path = artifact.publicPath?.slice(1) ?? `assets/${artifact.buildName}-a1B2c3D4.${artifact.extension}`;
      const blob = new Blob([`Synthetic codec fixture: ${artifact.role}`], { type: artifact.mimeType });
      return { blob, pin: { path, bytes: blob.size, sha256: await sha256(blob), mimeType: artifact.mimeType } };
    }));
  }

  function worker(manifestBody: unknown = manifest,
    selfOptions: { REHEARSAL_HOSTED?: unknown; REHEARSAL_CODECS?: unknown } = {}, appendedSource = '') {
    const cached = new Map<string, Response>();
    const namedCaches = new Map<string, Map<string, Response>>();
    const responses = new Map<string, Response>();
    const handlers = new Map<string, (event: unknown) => void>();
    const put = vi.fn(async (name: string, url: string, response: Response) => {
      namedCaches.get(name)!.set(url, response.clone());
      cached.set(url, response.clone());
    });
    const open = vi.fn(async (name: string) => {
      let entries = namedCaches.get(name);
      if (!entries) { entries = new Map(); namedCaches.set(name, entries); }
      return {
        put: (url: string, response: Response) => put(name, url, response),
        match: async (url: string) => entries.get(url)?.clone(),
      };
    });
    const fetcher = vi.fn(async (request: string | Request, _options?: RequestInit) => {
      const url = typeof request === 'string' ? request : request.url;
      if (responses.has(url)) {
        const response = responses.get(url)!;
        const clone = response.clone();
        for (const field of ['url', 'type', 'redirected'] as const) {
          Object.defineProperty(clone, field, {
            value: field === 'url' && !Object.hasOwn(response, field) ? url : response[field],
          });
        }
        return clone;
      }
      const type = url === authUrl || url.endsWith('.json') ? 'application/json' : url === origin || url.endsWith('.html') ? 'text/html' :
        url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' :
          url.endsWith('.woff2') ? 'font/woff2' : url.endsWith('.png') ? 'image/png' :
            url.endsWith('.webmanifest') ? 'application/manifest+json' : 'image/svg+xml';
      const body = url.endsWith('.json') ? JSON.stringify(manifestBody) :
        url.endsWith('.webmanifest') ? '{"name":"Rehearsal"}' : 'built asset';
      return Object.defineProperty(new Response(body, { headers: { 'Content-Type': type } }), 'url', { value: url });
    });
    const skipWaiting = vi.fn();
    const claim = vi.fn();
    const deleteCache = vi.fn(async (name: string) => namedCaches.delete(name));
    const start = () => runInNewContext(`${source}\n${appendedSource}`, {
      self: { ...selfOptions, registration: { scope: origin }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler), skipWaiting, clients: { claim } },
      URL, Response, crypto, TextEncoder, AbortController, fetch: fetcher, caches: { open, delete: deleteCache },
    });
    start();
    return {
      cached, namedCaches, responses, open, put, fetcher, skipWaiting, claim, deleteCache, restart: start,
      install: () => {
        let pending: Promise<void> | undefined;
        handlers.get('install')!({ waitUntil: (promise: Promise<void>) => { pending = promise; } });
        return pending!;
      },
      activate: () => {
        let pending: Promise<void> | undefined;
        handlers.get('activate')!({ waitUntil: (promise: Promise<void>) => { pending = promise; } });
        return pending!;
      },
      updateManifest: (value: unknown) => { manifestBody = value; },
      retire: (client: unknown = { type: 'window', id: 'signout-client', url: `${origin}signout.html` },
        data: unknown = { type: 'RETIRE_REHEARSAL' }) => {
        let pending: Promise<void> | undefined;
        const reply = vi.fn();
        handlers.get('message')!({
          data, source: client, ports: [{ postMessage: reply }],
          waitUntil: (promise: Promise<void>) => { pending = promise; },
        });
        return { pending, reply };
      },
      request: (path: string, options: { mode?: string; method?: string; headers?: HeadersInit } = {}) => {
        let pending: Promise<Response> | undefined;
        handlers.get('fetch')!({
          request: { url: new URL(path, origin).href, method: options.method ?? 'GET', mode: options.mode ?? 'cors', headers: new Headers(options.headers) },
          respondWith: (promise: Promise<Response>) => { pending = promise; },
        });
        return pending;
      },
    };
  }

  it.each(['top', 'bottom'])('reads codec pins injected at the %s and caches all five without source archives', async position => {
    const fixtures = await codecFixture();
    const pins = fixtures.map(fixture => fixture.pin);
    const shell = worker({ entry: { ...manifest['index.html'], assets: pins.filter(pin => pin.path.startsWith('assets/')).map(pin => pin.path) } },
      position === 'top' ? { REHEARSAL_CODECS: pins } : {},
      position === 'bottom' ? `self.REHEARSAL_HOSTED = true; self.REHEARSAL_CODECS = ${JSON.stringify(pins)};` : '');
    for (const { pin, blob } of fixtures) shell.responses.set(`${origin}${pin.path}`, new Response(blob));
    await shell.install();
    await shell.activate();
    expect(pins).toHaveLength(5);
    const saved = await shell.cached.get(`${origin}__rehearsal_shell_manifest__`)!.clone().json() as string[];
    for (const pin of pins) {
      expect(saved).toContain(`${origin}${pin.path}`);
      expect(shell.fetcher.mock.calls.filter(([request]) => request === `${origin}${pin.path}`)).toHaveLength(1);
    }
    expect(saved.some(url => url.includes('/sources/') || url.endsWith('.gz'))).toBe(false);
    expect(shell.fetcher.mock.calls.every(([, options]) => options?.credentials === 'omit' &&
      options.redirect === 'error' && options.cache === 'no-store')).toBe(true);
    shell.fetcher.mockReset().mockRejectedValue(new Error('offline'));
    shell.restart();
    for (const { pin, blob } of fixtures) {
      expect(await (await shell.request(`/${pin.path}`))!.text()).toBe(await blob.text());
    }
    expect(shell.request(codecMetadata.artifacts.find(artifact => artifact.role === 'source')!.publicPath!)).toBeUndefined();
    expect(shell.fetcher).not.toHaveBeenCalled();
    expect(shell.skipWaiting).not.toHaveBeenCalled();
    expect(shell.claim).not.toHaveBeenCalled();
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it.each([undefined, []])('keeps raw workers compatible with absent or empty codec pins: %j', async pins => {
    const shell = worker(manifest, { REHEARSAL_CODECS: pins });
    await shell.install();
    await shell.activate();
    shell.fetcher.mockRejectedValue(new Error('offline'));
    expect(await (await shell.request('/assets/app-123.js'))!.text()).toBe('built asset');
    expect(shell.request('/assets/ffmpeg-audio-core-a1B2c3D4.wasm')).toBeUndefined();
    expect(shell.request('/licenses/ffmpeg-audio-core-v1-NOTICES.txt')).toBeUndefined();
  });

  it('adds codec pins absent from the Vite manifest and keeps their validated snapshot immutable', async () => {
    const fixtures = await codecFixture();
    const pins = fixtures.map(({ pin }) => ({ ...pin }));
    const shell = worker(manifest, { REHEARSAL_CODECS: pins });
    for (const { pin, blob } of fixtures) shell.responses.set(`${origin}${pin.path}`, new Response(blob));
    const originalFetch = shell.fetcher.getMockImplementation()!;
    shell.fetcher.mockImplementation(async (request, options) => {
      if (request === `${origin}.vite/manifest.json`) {
        pins[0].sha256 = '0'.repeat(64);
        pins.pop();
      }
      return originalFetch(request, options);
    });
    await shell.install();
    await shell.activate();
    shell.fetcher.mockReset().mockRejectedValue(new Error('offline'));
    for (const { pin, blob } of fixtures) expect(await (await shell.request(`/${pin.path}`))!.text()).toBe(await blob.text());
    expect(shell.fetcher).not.toHaveBeenCalled();
  });

  it.each([null, {}, 'codec', false, new Array(17).fill({})])('rejects malformed codec pin collections: %j', async pins => {
    const shell = worker(manifest, {}, `self.REHEARSAL_CODECS = ${JSON.stringify(pins)};`);
    await expect(shell.install()).rejects.toThrow('invalid_codec_pins');
    expect(shell.fetcher).not.toHaveBeenCalled();
    expect(shell.open).not.toHaveBeenCalled();
  });

  it.each([
    { path: 'assets/../local-media/codec.wasm' }, { path: 'assets/./ffmpeg-audio-core-a1B2c3D4.wasm' },
    { path: 'assets//ffmpeg-audio-core-a1B2c3D4.wasm' }, { path: 'assets/%2e%2e/codec.wasm' },
    { path: '/assets/ffmpeg-audio-core-a1B2c3D4.wasm' }, { path: 'assets\\ffmpeg-audio-core-a1B2c3D4.wasm' },
    { path: 'https://external.example/codec.wasm' }, { path: '//external.example/codec.wasm' },
    { path: 'assets/ffmpeg-audio-core-a1B2c3D4.wasm?token=private' },
    { path: 'assets/ffmpeg-audio-core-a1B2c3D4.wasm\n' },
    { path: 'assets/ffmpeg-audio-core-a1B2c3D4.wasm#private' }, { path: 'assets/unlisted.wasm' },
    { path: 'api/codec.wasm' }, { path: '.auth/codec.wasm' }, { path: 'licenses/unlisted.txt' },
    { path: 'sources/ffmpeg-audio-core-v1-source.tar.gz' }, { path: 'assets/ffmpeg-audio-core-a1B2c3D4.gz' },
    { mimeType: 'application/octet-stream' }, { mimeType: 'text/html' }, { mimeType: 'application/gzip' },
    { mimeType: 'text/plain' }, { mimeType: 'application/wasm; charset=utf-8' },
    { sha256: 'f'.repeat(63) }, { sha256: 'F'.repeat(64) }, { sha256: 'z'.repeat(64) }, { sha256: 123 },
    { sha256: `${'f'.repeat(64)}\n` },
    { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }, { bytes: NaN }, { bytes: Infinity }, { bytes: '20' },
    { bytes: 4 * 1024 * 1024 }, { extra: true }, { drm: true }, { mimeType: undefined },
  ])('rejects unsafe codec pin metadata before network or cache activity: %j', async patch => {
    const fixtures = await codecFixture();
    const pins = fixtures.map(({ pin }) => pin.path.endsWith('.wasm') ? { ...pin, ...patch } : pin);
    const shell = worker(manifest, { REHEARSAL_CODECS: pins });
    await expect(shell.install()).rejects.toThrow('invalid_codec_pins');
    expect(shell.fetcher).not.toHaveBeenCalled();
    expect(shell.open).not.toHaveBeenCalled();
  });

  it.each(['duplicate', 'duplicate-role', 'missing', 'total'])('rejects %s codec pins', async defect => {
    const pins = (await codecFixture()).map(({ pin }) => pin);
    if (defect === 'duplicate') pins[1] = { ...pins[0] };
    if (defect === 'duplicate-role') pins[1] = { ...pins[0], path: 'assets/ffmpeg-audio-core-z9Y8x7W6.js' };
    if (defect === 'missing') pins.pop();
    if (defect === 'total') for (const pin of pins) pin.bytes = 2 * 1024 * 1024;
    const shell = worker(manifest, { REHEARSAL_CODECS: pins });
    await expect(shell.install()).rejects.toThrow('invalid_codec_pins');
    expect(shell.fetcher).not.toHaveBeenCalled();
    expect(shell.open).not.toHaveBeenCalled();
  });

  it.each(['glue', 'wasm', 'notices', 'license', 'sbom'])(
    'rejects same-length codec %s corruption and preserves the previous active and pending caches', async role => {
      const fixtures = await codecFixture();
      const pins = fixtures.map(({ pin }) => pin);
      const index = codecMetadata.artifacts.filter(artifact => artifact.cache).findIndex(artifact => artifact.role === role);
      const { pin, blob } = fixtures[index];
      const shell = worker({ entry: { ...manifest['index.html'], assets: pins.filter(pin => pin.path.startsWith('assets/')).map(pin => pin.path) } },
        {}, `self.REHEARSAL_CODECS = ${JSON.stringify(pins)};`);
      for (const fixture of fixtures) shell.responses.set(`${origin}${fixture.pin.path}`, new Response(fixture.blob));
      await shell.install();
      await shell.activate();
      const activeKey = `${origin}__rehearsal_active_shell__`;
      const pendingKey = `${origin}__rehearsal_pending_shell__`;
      const previous = await shell.cached.get(activeKey)!.clone().text();
      const names = [...shell.namedCaches.keys()];
      shell.restart();
      shell.put.mockClear();
      const changed = new Uint8Array(await blob.arrayBuffer());
      changed[0] ^= 1;
      shell.responses.set(`${origin}${pin.path}`, new Response(changed, { headers: { 'Content-Type': pin.mimeType } }));
      await expect(shell.install()).rejects.toThrow('invalid_codec_asset');
      expect([...shell.namedCaches.keys()]).toEqual(names);
      expect(await shell.cached.get(activeKey)!.clone().text()).toBe(previous);
      expect(await shell.cached.get(pendingKey)!.clone().text()).toBe(previous);
      expect(shell.put).not.toHaveBeenCalled();
      expect(shell.deleteCache).not.toHaveBeenCalled();
      shell.fetcher.mockRejectedValue(new Error('offline'));
      expect(await (await shell.request(`/${pin.path}`))!.text()).toBe(await blob.text());
    },
  );

  it.each([
    { contentType: 'application/octet-stream' }, { contentType: 'text/html' }, { contentType: 'application/javascript' },
    { cacheControl: 'private, max-age=3600' }, { cacheControl: 'no-store' },
    { status: 201 }, { status: 302 }, { status: 403 }, { type: 'opaque' }, { redirected: true },
    { url: 'https://external.example/codec.wasm' }, { url: `${origin}api/codec.wasm` },
    { length: '1' }, { length: 'Infinity' }, { length: '2e1' }, { noBody: true },
  ])('rejects unsafe codec responses before staging: %j', async defect => {
    const fixtures = await codecFixture();
    const shell = worker(manifest, { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
    for (const { pin, blob } of fixtures) {
      if (!pin.path.endsWith('.wasm')) { shell.responses.set(`${origin}${pin.path}`, new Response(blob)); continue; }
      const headers = new Headers({ 'Content-Type': defect.contentType ?? pin.mimeType, 'Cache-Control': defect.cacheControl ?? 'public' });
      if (defect.length !== undefined) headers.set('Content-Length', defect.length);
      const response = new Response(defect.noBody ? null : blob, { status: defect.status ?? 200, headers });
      for (const field of ['url', 'type', 'redirected'] as const) {
        if (field in defect) Object.defineProperty(response, field, { value: defect[field] });
      }
      shell.responses.set(`${origin}${pin.path}`, response);
    }
    await expect(shell.install()).rejects.toThrow(defect.length !== undefined || defect.noBody ? 'invalid_codec_asset' : 'invalid_public_shell_response');
    expect(shell.open).not.toHaveBeenCalled();
    expect(shell.put).not.toHaveBeenCalled();
    expect(shell.fetcher.mock.calls.every(([, options]) => options?.credentials === 'omit' && options.redirect === 'error')).toBe(true);
  });

  it.each(['js', 'txt', 'json'])('requires codec %s MIME even when its bytes match', async extension => {
    const fixtures = await codecFixture();
    const shell = worker(manifest, { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
    for (const { pin, blob } of fixtures) shell.responses.set(`${origin}${pin.path}`, new Response(blob, {
      headers: { 'Content-Type': pin.path.endsWith(`.${extension}`) ? 'application/wasm' : pin.mimeType },
    }));
    await expect(shell.install()).rejects.toThrow('invalid_public_shell_response');
    expect(shell.open).not.toHaveBeenCalled();
  });

  it.each(['text/javascript', 'application/javascript; charset=utf-8'])(
    'accepts the deployed codec JavaScript MIME %s while still checking integrity', async mimeType => {
      const fixtures = await codecFixture();
      const shell = worker(manifest, { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
      for (const { pin, blob } of fixtures) shell.responses.set(`${origin}${pin.path}`, new Response(blob, {
        headers: { 'Content-Type': pin.path.endsWith('.js') ? mimeType : pin.mimeType },
      }));
      await shell.install();
      expect(shell.cached.has(`${origin}${fixtures[0].pin.path}`)).toBe(true);
    },
  );

  it.each(['short', 'oversize', 'declared-oversize'])(
    'bounds codec streaming and rejects %s bodies before cache writes', async defect => {
      const fixtures = await codecFixture();
      const { pin, blob } = fixtures.find(fixture => fixture.pin.path.endsWith('.wasm'))!;
      const shell = worker(manifest, { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
      for (const fixture of fixtures) shell.responses.set(`${origin}${fixture.pin.path}`, new Response(fixture.blob));
      const cancel = vi.fn();
      const originalFetch = shell.fetcher.getMockImplementation()!;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      shell.fetcher.mockImplementation(async (request, options) => {
        if (request !== `${origin}${pin.path}`) return originalFetch(request, options);
        const headers = new Headers({ 'Content-Type': pin.mimeType });
        if (defect === 'declared-oversize') headers.set('Content-Length', String(pin.bytes));
        return new Response(new ReadableStream({
          start(controller) {
            if (defect === 'short') { controller.enqueue(bytes.slice(0, -1)); controller.close(); }
            else { controller.enqueue(bytes); controller.enqueue(new Uint8Array(1)); }
          }, cancel,
        }), { headers });
      });
      await expect(shell.install()).rejects.toThrow('invalid_codec_asset');
      if (defect !== 'short') expect(cancel).toHaveBeenCalledOnce();
      expect(shell.open).not.toHaveBeenCalled();
      expect(shell.put).not.toHaveBeenCalled();
    },
  );

  it.each(['assets/unlisted.wasm', 'assets/ffmpeg-audio-core-z9Y8x7W6.wasm',
    'assets/ffmpeg-audio-core-a1B2c3D4.wasm?token=private', 'licenses/unlisted.txt',
    'sources/ffmpeg-audio-core-v1-source.tar.gz', 'assets/archive.gz'])(
    'rejects unpinned codec or source manifest references: %s', async path => {
      const fixtures = await codecFixture();
      const shell = worker({ entry: { ...manifest['index.html'], assets: [path] } },
        { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
      await expect(shell.install()).rejects.toThrow('invalid_shell_asset');
      expect(shell.fetcher.mock.calls.map(([request]) => request)).toEqual([`${origin}.vite/manifest.json`]);
      expect(shell.open).not.toHaveBeenCalled();
    },
  );

  it('never intercepts unpinned codec/source paths or authenticated, ranged, query or mutation requests', async () => {
    const fixtures = await codecFixture();
    const shell = worker(manifest, { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
    for (const { pin, blob } of fixtures) shell.responses.set(`${origin}${pin.path}`, new Response(blob));
    await shell.install();
    await shell.activate();
    const unlisted = ['assets/unlisted.wasm', 'assets/ffmpeg-audio-core-z9Y8x7W6.wasm', 'assets/source.tar.gz',
      'licenses/unlisted.txt', 'licenses/unlisted.json', 'sources/ffmpeg-audio-core-v1-source.tar.gz',
      'api/codec.wasm', '.auth/codec.wasm', 'local-media/codec.wasm'];
    const active = await shell.cached.get(`${origin}__rehearsal_active_shell__`)!.clone().text();
    const cache = shell.namedCaches.get(active)!;
    const allowed = await cache.get(`${origin}__rehearsal_shell_manifest__`)!.clone().json() as string[];
    for (const path of unlisted) { allowed.push(`${origin}${path}`); cache.set(`${origin}${path}`, new Response('untrusted prior entry')); }
    cache.set(`${origin}__rehearsal_shell_manifest__`, new Response(JSON.stringify(allowed)));
    shell.fetcher.mockReset().mockRejectedValue(new Error('offline'));
    shell.put.mockClear();
    for (const path of unlisted) expect(shell.request(`/${path}`)).toBeUndefined();
    for (const { pin } of fixtures) {
      expect(shell.request(`/${pin.path}?token=private`)).toBeUndefined();
      expect(shell.request(`/${pin.path}#private`)).toBeUndefined();
      expect(shell.request(`https://external.example/${pin.path}`)).toBeUndefined();
      expect(shell.request(`/${pin.path}`, { method: 'POST' })).toBeUndefined();
      expect(shell.request(`/${pin.path}`, { headers: { Authorization: 'Bearer private' } })).toBeUndefined();
      expect(shell.request(`/${pin.path}`, { headers: { Range: 'bytes=0-2' } })).toBeUndefined();
    }
    expect(shell.fetcher).not.toHaveBeenCalled();
    expect(shell.put).not.toHaveBeenCalled();
  });

  it('settles and cancels a codec stream before retirement acknowledgement without removing the previous shell', async () => {
    const fixtures = await codecFixture();
    const { pin, blob } = fixtures.find(fixture => fixture.pin.path.endsWith('.wasm'))!;
    const shell = worker(manifest, { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
    for (const fixture of fixtures) shell.responses.set(`${origin}${fixture.pin.path}`, new Response(fixture.blob));
    await shell.install();
    await shell.activate();
    const names = [...shell.namedCaches.keys()];
    shell.restart();
    shell.put.mockClear();
    shell.fetcher.mockClear();
    const began = deferred<void>();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const originalFetch = shell.fetcher.getMockImplementation()!;
    shell.fetcher.mockImplementation(async (request, options) => {
      if (request !== `${origin}${pin.path}`) return originalFetch(request, options);
      return new Response(new ReadableStream({
        start(controller) { stream = controller; },
        pull() { began.resolve(); }, cancel,
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': pin.mimeType } });
    });
    const installed = Promise.allSettled([shell.install()]);
    await began.promise;
    const retirement = shell.retire();
    expect(retirement.reply).not.toHaveBeenCalled();
    expect(shell.fetcher.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    stream.enqueue(new Uint8Array(await blob.arrayBuffer()));
    expect((await installed)[0]).toMatchObject({ status: 'rejected', reason: { message: 'rehearsal_retired' } });
    await retirement.pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(retirement.reply).toHaveBeenCalledExactlyOnceWith({ retired: true });
    expect([...shell.namedCaches.keys()]).toEqual(names);
    expect(shell.deleteCache).not.toHaveBeenCalled();
    expect(shell.put).not.toHaveBeenCalled();
  });

  it.each(['body', 'allowlist'])('refuses codec activation after a license disappears from the %s', async defect => {
    const fixtures = await codecFixture();
    const shell = worker(manifest, { REHEARSAL_CODECS: fixtures.map(({ pin }) => pin) });
    for (const { pin, blob } of fixtures) shell.responses.set(`${origin}${pin.path}`, new Response(blob));
    await shell.install();
    await shell.activate();
    const activeKey = `${origin}__rehearsal_active_shell__`;
    const previous = await shell.cached.get(activeKey)!.clone().text();
    shell.restart();
    await shell.install();
    const pending = await shell.cached.get(`${origin}__rehearsal_pending_shell__`)!.clone().text();
    const cache = shell.namedCaches.get(pending)!;
    const removed = `${origin}${fixtures.find(({ pin }) => pin.path.startsWith('licenses/'))!.pin.path}`;
    if (defect === 'body') cache.delete(removed);
    else {
      const key = `${origin}__rehearsal_shell_manifest__`;
      const allowed = await cache.get(key)!.clone().json() as string[];
      cache.set(key, new Response(JSON.stringify(allowed.filter(url => url !== removed))));
    }
    await expect(shell.activate()).rejects.toThrow('incomplete_pending_shell');
    expect(await shell.cached.get(activeKey)!.clone().text()).toBe(previous);
    expect(shell.namedCaches.has(previous)).toBe(true);
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { type: 'window', id: '', url: `${origin}signout.html` },
    { type: 'window', id: ' ', url: `${origin}signout.html` },
    { type: 'worker', id: 'worker-client', url: `${origin}signout.html` },
    { type: 'window', id: 'client', url: 'https://external.example/signout.html' },
    { type: 'window', id: 'client', url: `${origin}index.html` },
    { type: 'window', id: 'client', url: `${origin}signout.html/extra` },
    { type: 'window', id: 'client', url: '/signout.html' },
    { type: 'window', id: 'client', url: '' },
  ])('ignores retirement from a missing, non-window, or non-signout client: %j', async client => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    const retirement = shell.retire(client);
    expect(retirement.pending).toBeUndefined();
    expect(retirement.reply).not.toHaveBeenCalled();
    await shell.install();
    expect(shell.fetcher.mock.calls.every(([, options]) => options?.signal?.aborted === false)).toBe(true);
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it.each([null, 'RETIRE_REHEARSAL', {}, { type: 'UNKNOWN' }])(
    'requires the explicit retirement message shape: %j', async data => {
      const shell = worker();
      const retirement = shell.retire(undefined, data);
      expect(retirement.pending).toBeUndefined();
      expect(retirement.reply).not.toHaveBeenCalled();
      await shell.install();
      expect(shell.deleteCache).not.toHaveBeenCalled();
    },
  );

  it.each(['.vite/manifest.json', 'index.html', 'assets/app-123.js'])(
    'waits for a paused %s fetch to settle before acknowledging retirement', async path => {
      const shell = worker(manifest, { REHEARSAL_HOSTED: true });
      const began = deferred<void>();
      const resume = deferred<void>();
      const originalFetch = shell.fetcher.getMockImplementation()!;
      shell.fetcher.mockImplementation(async (request, options) => {
        const response = await originalFetch(request, options);
        if (request === `${origin}${path}`) { began.resolve(); await resume.promise; }
        return response;
      });
      const installed = Promise.allSettled([shell.install()]);
      await began.promise;
      const retirement = shell.retire();
      expect(shell.fetcher.mock.calls.every(([, options]) => options?.signal?.aborted === true)).toBe(true);
      expect(retirement.reply).not.toHaveBeenCalled();
      resume.resolve();
      expect((await installed)[0]).toMatchObject({ status: 'rejected', reason: { message: 'rehearsal_retired' } });
      await retirement.pending;
      expect(retirement.reply).toHaveBeenCalledExactlyOnceWith({ retired: true });
      expect(shell.put).not.toHaveBeenCalled();
      expect(shell.namedCaches.size).toBe(0);
      await expect(shell.install()).rejects.toThrow('rehearsal_retired');
      await expect(shell.activate()).rejects.toThrow('rehearsal_retired');
      expect(shell.put).not.toHaveBeenCalled();
    },
  );

  it('aborts a pending public manifest fetch and acknowledges only after its aborted install settles', async () => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    const began = deferred<void>();
    shell.fetcher.mockImplementation((_request, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      began.resolve();
    }));
    const installed = Promise.allSettled([shell.install()]);
    await began.promise;
    const retirement = shell.retire();
    await retirement.pending;
    expect((await installed)[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(retirement.reply).toHaveBeenCalledExactlyOnceWith({ retired: true });
    expect(shell.put).not.toHaveBeenCalled();
    expect(shell.open).not.toHaveBeenCalled();
  });

  it.each(['index.html', '__rehearsal_shell_manifest__', '__rehearsal_pending_shell__', '__rehearsal_active_shell__'])(
    'waits for a pending %s write, deletes only its own staged cache, and makes no writes after acknowledgement', async key => {
      const shell = worker(manifest, { REHEARSAL_HOSTED: true });
      const unrelatedCache = 'fitness-rehearsal-shell-v1:/:previous-build:unrelated-worker';
      shell.namedCaches.set(unrelatedCache, new Map());
      if (key === '__rehearsal_active_shell__') await shell.install();
      const began = deferred<void>();
      const resume = deferred<void>();
      const order: string[] = [];
      const originalPut = shell.put.getMockImplementation()!;
      shell.put.mockImplementation(async (name, url, response) => {
        if (url === `${origin}${key}`) { began.resolve(); await resume.promise; }
        await originalPut(name, url, response);
        order.push('put');
      });
      const completed = Promise.allSettled([key === '__rehearsal_active_shell__' ? shell.activate() : shell.install()]);
      await began.promise;
      const retirement = shell.retire();
      retirement.reply.mockImplementation(() => { order.push('ack'); });
      expect(retirement.reply).not.toHaveBeenCalled();
      expect(shell.deleteCache).not.toHaveBeenCalled();
      resume.resolve();
      expect((await completed)[0]).toMatchObject({ status: 'rejected', reason: { message: 'rehearsal_retired' } });
      await retirement.pending;
      expect(retirement.reply).toHaveBeenCalledExactlyOnceWith({ retired: true });
      expect(shell.deleteCache).toHaveBeenCalledOnce();
      expect(shell.deleteCache.mock.calls[0][0]).not.toBe(unrelatedCache);
      expect([...shell.namedCaches.keys()].filter(name => name.startsWith('fitness-rehearsal-shell-v1:'))).toEqual([unrelatedCache]);
      const writes = shell.put.mock.calls.length;
      await expect(shell.install()).rejects.toThrow('rehearsal_retired');
      await expect(shell.activate()).rejects.toThrow('rehearsal_retired');
      await shell.request('/assets/app-123.js');
      expect(shell.put).toHaveBeenCalledTimes(writes);
      expect(order.at(-1)).toBe('ack');
      expect(shell.skipWaiting).not.toHaveBeenCalled();
      expect(shell.claim).not.toHaveBeenCalled();
    },
  );

  it('settles a pending cache open before acknowledgement so a late read cannot recreate purged caches', async () => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    const began = deferred<void>();
    const resume = deferred<void>();
    const originalOpen = shell.open.getMockImplementation()!;
    shell.open.mockImplementationOnce(async name => {
      began.resolve();
      await resume.promise;
      return originalOpen(name);
    });
    const request = shell.request('/assets/app-123.js');
    await began.promise;
    const retirement = shell.retire();
    expect(retirement.reply).not.toHaveBeenCalled();
    resume.resolve();
    await retirement.pending;
    await request;
    const opens = shell.open.mock.calls.length;
    const writes = shell.put.mock.calls.length;
    shell.namedCaches.clear();
    await shell.request('/assets/app-123.js');
    expect(shell.open).toHaveBeenCalledTimes(opens);
    expect(shell.put).toHaveBeenCalledTimes(writes);
    expect(shell.namedCaches.size).toBe(0);
    expect(retirement.reply).toHaveBeenCalledExactlyOnceWith({ retired: true });
  });

  it('retires a restarted active worker with no pending install, stops offline fallback, and leaves purge to signout', async () => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    await shell.install();
    await shell.activate();
    shell.restart();
    const names = [...shell.namedCaches.keys()];
    shell.put.mockClear();
    const retirement = shell.retire();
    await retirement.pending;
    expect(retirement.reply).toHaveBeenCalledExactlyOnceWith({ retired: true });
    expect([...shell.namedCaches.keys()]).toEqual(names);
    expect(shell.deleteCache).not.toHaveBeenCalled();
    shell.responses.set(origin, new Response('network only', { headers: { 'Content-Type': 'text/html' } }));
    expect(await (await shell.request('/', { mode: 'navigate' }))!.text()).toBe('network only');
    shell.fetcher.mockRejectedValue(new TypeError('offline'));
    await expect(shell.request('/', { mode: 'navigate' })).rejects.toThrow('offline');
    await expect(shell.request('/assets/app-123.js')).rejects.toThrow('offline');
    expect(shell.request('/.auth/logout')).toBeUndefined();
    expect(shell.put).not.toHaveBeenCalled();
  });

  it('retires a waiting installation without deleting the prior active shell and acknowledges repeat requests', async () => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    const activeKey = `${origin}__rehearsal_active_shell__`;
    const previous = await shell.cached.get(activeKey)!.clone().text();
    shell.restart();
    await shell.install();
    const first = shell.retire();
    const second = shell.retire();
    await Promise.all([first.pending, second.pending]);
    for (const retirement of [first, second]) expect(retirement.reply).toHaveBeenCalledExactlyOnceWith({ retired: true });
    expect(shell.namedCaches.has(previous)).toBe(true);
    expect(await shell.cached.get(activeKey)!.clone().text()).toBe(previous);
    expect(shell.deleteCache).toHaveBeenCalledOnce();
    await expect(shell.activate()).rejects.toThrow('rehearsal_retired');
  });

  it('does not acknowledge successful retirement when its staged cache cleanup fails', async () => {
    const shell = worker();
    await shell.install();
    shell.deleteCache.mockRejectedValueOnce(new Error('cache cleanup failed'));
    const retirement = shell.retire();
    await expect(retirement.pending).rejects.toThrow('cache cleanup failed');
    expect(retirement.reply).not.toHaveBeenCalled();
    await expect(shell.install()).rejects.toThrow('rehearsal_retired');
  });

  it.each([undefined, false, true, 'true', 1])('requires a public generic index regardless of the hosted flag (%s)', async flag => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: flag });
    shell.responses.set(`${origin}index.html`, new Response('generic shell', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, max-age=0' },
    }));
    await expect(shell.install()).rejects.toThrow('invalid_public_shell_response');
    expect(shell.fetcher.mock.calls.some(([request]) => request === authUrl)).toBe(false);
    expect(shell.fetcher.mock.calls.every(([, options]) => options?.credentials === 'omit')).toBe(true);
    expect(shell.namedCaches.size).toBe(0);
  });

  it.each([401, 403, 404, 500])('installs anonymously without consulting unavailable auth endpoints (%s)', async status => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    for (const path of ['.auth/me', 'api/auth/session']) {
      shell.responses.set(`${origin}${path}`, new Response('{"error":"signin_required"}', {
        status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }));
    }
    await shell.install();
    await shell.activate();
    expect(shell.fetcher.mock.calls[0][0]).toBe(`${origin}.vite/manifest.json`);
    expect(shell.fetcher.mock.calls.every(([request, options]) =>
      !String(request).includes('/api/') && !String(request).includes('/.auth/') && options?.credentials === 'omit')).toBe(true);
    expect(shell.cached.has(authUrl)).toBe(false);
    expect(shell.cached.has(`${origin}api/auth/session`)).toBe(false);
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it('rejects a public manifest network failure without opening a cache', async () => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    shell.fetcher.mockRejectedValue(new TypeError('offline'));
    await expect(shell.install()).rejects.toThrow('offline');
    expect(shell.fetcher).toHaveBeenCalledOnce();
    expect(shell.namedCaches.size).toBe(0);
  });

  it('caches a public generic shell and licensed assets without credentials even with an appended hosted flag', async () => {
    const path = 'assets/lofi-hip-hop-v1-a1B2c3D4.wav';
    const bytes = new Uint8Array(readFileSync(new URL('../frontend/src/assets/loops/lofi-hip-hop-v1.wav', import.meta.url)));
    const shell = worker({ entry: { ...manifest['index.html'], assets: ['assets/font-123.woff2', path] } },
      {}, 'self.REHEARSAL_HOSTED = true;');
    shell.responses.set(`${origin}index.html`, new Response('generic shell', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0' },
    }));
    shell.responses.set(`${origin}${path}`, new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } }));
    await shell.install();
    await shell.activate();
    expect(shell.fetcher.mock.calls[0][0]).toBe(`${origin}.vite/manifest.json`);
    for (const [, options] of shell.fetcher.mock.calls) {
      expect(options).toEqual({
        credentials: 'omit',
        redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
      });
    }
    expect(shell.cached.has(authUrl)).toBe(false);
    expect(shell.cached.has(`${origin}.vite/manifest.json`)).toBe(false);
    expect([...shell.cached.keys()].filter(url => url.endsWith('.html'))).toEqual([`${origin}index.html`]);
    shell.fetcher.mockRejectedValue(new TypeError('offline'));
    shell.restart();
    expect(await (await shell.request('/', { mode: 'navigate' }))!.text()).toBe('generic shell');
    expect(await (await shell.request('/assets/font-123.woff2'))!.text()).toBe('built asset');
    expect(Buffer.from(await (await shell.request(`/${path}`))!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(shell.skipWaiting).not.toHaveBeenCalled();
    expect(shell.claim).not.toHaveBeenCalled();
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it.each([
    ['index.html', 'text/html'],
    ['.vite/manifest.json', 'application/json'], ['assets/app-123.js', 'text/javascript'],
    ['assets/font-123.woff2', 'font/woff2'], ['manifest.webmanifest', 'application/manifest+json'],
    ['assets/lofi-hip-hop-v1.wav', 'audio/wav'],
  ])('still rejects private/no-store public responses for %s in hosted mode', async (path, contentType) => {
    for (const cacheControl of ['private, max-age=0', 'no-store']) {
      const shell = worker({ entry: { ...manifest['index.html'], assets: ['assets/font-123.woff2', 'assets/lofi-hip-hop-v1.wav'] } },
        { REHEARSAL_HOSTED: true });
      shell.responses.set(`${origin}${path}`, new Response('not cacheable', {
        headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl },
      }));
      await expect(shell.install()).rejects.toThrow('invalid_public_shell_response');
      expect(shell.fetcher).toHaveBeenCalledWith(`${origin}${path}`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
      });
      expect(shell.namedCaches.size).toBe(0);
    }
  });

  it.each([
    { cacheControl: 'private' }, { cacheControl: 'no-store' }, { cacheControl: 'private, no-store' },
    { status: 401 }, { status: 403 }, { status: 201 }, { status: 302 },
    { url: `${origin}sign-in.html` }, { url: 'https://external.example/index.html' }, { url: '' },
    { contentType: 'application/json' }, { redirected: true }, { type: 'opaque' },
  ])('rejects an unsafe hosted index %j before cache population', async options => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    const response = new Response('generic shell', {
      status: options.status ?? 200,
      headers: { 'Content-Type': options.contentType ?? 'text/html', 'Cache-Control': options.cacheControl ?? 'public, max-age=0' },
    });
    for (const field of ['url', 'type', 'redirected'] as const) {
      if (field in options) Object.defineProperty(response, field, { value: options[field] });
    }
    shell.responses.set(`${origin}index.html`, response);
    await expect(shell.install()).rejects.toThrow('invalid_public_shell_response');
    expect(shell.namedCaches.size).toBe(0);
  });

  it.each(['/', '/index.html'])('serves the prepared public navigation %s without identity revalidation or network dependency', async path => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    await shell.install();
    await shell.activate();
    shell.put.mockClear();
    shell.fetcher.mockClear();
    for (const status of [200, 401, 403, 500]) {
      shell.responses.set(new URL(path, origin).href, new Response(`platform ${status}`, {
        status, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
      }));
      const response = await shell.request(path, { mode: 'navigate' });
      expect(response!.status).toBe(200);
      expect(await response!.text()).toBe('built asset');
    }
    expect(shell.fetcher).not.toHaveBeenCalled();
    expect(shell.put).not.toHaveBeenCalled();
    expect(shell.deleteCache).not.toHaveBeenCalled();
    expect(await shell.cached.get(`${origin}index.html`)!.clone().text()).toBe('built asset');
    shell.fetcher.mockRejectedValue(new TypeError('offline'));
    shell.restart();
    expect(await (await shell.request(path, { mode: 'navigate' }))!.text()).toBe('built asset');
  });

  it.each([{ status: 302 }, { status: 307 }, { type: 'opaqueredirect' }, { redirected: true }])(
    'does not follow or cache obsolete auth redirects %j when the public shell is prepared', async options => {
      const shell = worker(manifest, { REHEARSAL_HOSTED: true });
      await shell.install();
      await shell.activate();
      shell.put.mockClear();
      shell.fetcher.mockClear();
      const response = new Response('sign-in', { status: options.status ?? 200, headers: { Location: '/.auth/login/aad' } });
      for (const field of ['type', 'redirected'] as const) {
        if (field in options) Object.defineProperty(response, field, { value: options[field] });
      }
      shell.responses.set(origin, response);
      expect(await (await shell.request('/', { mode: 'navigate' }))!.text()).toBe('built asset');
      expect(shell.fetcher).not.toHaveBeenCalled();
      expect(shell.put).not.toHaveBeenCalled();
    },
  );

  it('cannot fall back to a shell that has not been activated', async () => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    await shell.install();
    shell.fetcher.mockRejectedValue(new TypeError('offline'));
    await expect(shell.request('/', { mode: 'navigate' })).rejects.toThrow('offline');
  });

  it('never intercepts hosted auth, signout, API or metadata requests, online or offline', async () => {
    const shell = worker(manifest, { REHEARSAL_HOSTED: true });
    await shell.install();
    await shell.activate();
    shell.fetcher.mockClear();
    shell.put.mockClear();
    for (const offline of [false, true]) {
      if (offline) shell.fetcher.mockRejectedValue(new TypeError('offline'));
      for (const path of ['/.auth/me', '/.auth/login/aad', '/.auth/logout?post_logout_redirect_uri=/signout.html',
        '/auth/login', '/signout', '/signout.html', '/sign-in.html', '/api/auth/login', '/api/auth/session', '/api/auth/logout',
        '/api/routines', '/api/media/asset', '/private/song.wav', '/local-media/song.wav', '/metadata.json', '/.vite/manifest.json']) {
        for (const mode of ['cors', 'navigate']) expect(shell.request(path, { mode })).toBeUndefined();
        expect(shell.cached.has(new URL(path, origin).href)).toBe(false);
      }
    }
    expect(shell.fetcher).not.toHaveBeenCalled();
    expect(shell.put).not.toHaveBeenCalled();
  });

  it('precaches only built manifest assets and supports offline navigation after worker restart', async () => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    expect(shell.cached.size).toBe(12);
    for (const call of shell.fetcher.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/rehearsal\.example\//);
      expect(call[1]).toEqual({ credentials: 'omit', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) });
    }
    shell.fetcher.mockRejectedValue(new Error('offline'));
    shell.restart();
    expect(await (await shell.request('/', { mode: 'navigate' }))?.text()).toBe('built asset');
    expect(await (await shell.request('/assets/app-123.js'))?.text()).toBe('built asset');
    for (const path of ['/favicon.svg', '/icons.svg', '/icon-192.png', '/icon-512.png']) {
      expect(await (await shell.request(path))?.text()).toBe('built asset');
    }
    expect(await (await shell.request('/manifest.webmanifest'))?.json()).toEqual({ name: 'Rehearsal' });
    expect(shell.skipWaiting).not.toHaveBeenCalled();
    expect(shell.claim).not.toHaveBeenCalled();
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it.each(['assets/lofi-hip-hop-v1.wav', 'assets/lofi-hip-hop-v1-a1B2c3D4.wav'])(
    'caches only pinned licensed bytes for %s and serves them offline', async path => {
      const bytes = new Uint8Array(readFileSync(new URL('../frontend/src/assets/loops/lofi-hip-hop-v1.wav', import.meta.url)));
      const shell = worker({ entry: { isEntry: true, file: 'assets/app-123.js', assets: [path] } });
      shell.responses.set(`${origin}${path}`, new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } }));
      await shell.install();
      await shell.activate();
      shell.fetcher.mockRejectedValue(new Error('offline'));
      const cached = Buffer.from(await (await shell.request(`/${path}`))!.arrayBuffer());
      expect(cached.equals(Buffer.from(bytes))).toBe(true);
    });

  it.each(['assets/song.wav', 'assets/lofi-hip-hop-v2.wav', 'assets/lofi-hip-hop-v1-toolonghash.wav',
    'assets/nested/lofi-hip-hop-v1.wav', 'assets/lofi-hip-hop-v1.wav?token=private'])(
    'rejects an unlicensed or nonexact audio asset: %s', async path => {
      const shell = worker({ entry: { isEntry: true, file: 'assets/app-123.js', assets: [path] } });
      await expect(shell.install()).rejects.toThrow('invalid_shell_asset');
      expect(shell.cached.size).toBe(0);
    });

  it.each([false, true])('rejects altered licensed bytes before any shell cache is staged (hosted=%s)', async hosted => {
    const bytes = new Uint8Array(readFileSync(new URL('../frontend/src/assets/loops/lofi-hip-hop-v1.wav', import.meta.url)));
    bytes[100] ^= 1;
    const path = 'assets/lofi-hip-hop-v1-a1B2c3D4.wav';
    const shell = worker({ entry: { isEntry: true, file: 'assets/app-123.js', assets: [path] } }, { REHEARSAL_HOSTED: hosted });
    shell.responses.set(`${origin}${path}`, new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } }));
    await expect(shell.install()).rejects.toThrow('invalid_licensed_loop');
    expect(shell.cached.size).toBe(0);
  });

  it.each([false, true])('cancels an oversized chunked licensed audio response before caching (hosted=%s)', async hosted => {
    const path = 'assets/lofi-hip-hop-v1-a1B2c3D4.wav';
    const shell = worker({ entry: { isEntry: true, file: 'assets/app-123.js', assets: [path] } }, { REHEARSAL_HOSTED: hosted });
    const cancel = vi.fn();
    const originalFetch = shell.fetcher.getMockImplementation()!;
    shell.fetcher.mockImplementation(async (request, options) => {
      if (String(request).endsWith(path)) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(705645)); }, cancel,
      }), { headers: { 'Content-Type': 'audio/wav' } });
      return originalFetch(request, options);
    });
    await expect(shell.install()).rejects.toThrow('invalid_licensed_loop');
    expect(cancel).toHaveBeenCalledOnce();
    expect(shell.cached.size).toBe(0);
  });

  it('does not intercept auth, local-media, external URLs, mutations, ranges or query tokens', async () => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    for (const path of ['/api/routines', '/.auth/me', '/auth/login', '/local-media/incoming/song.mp3', 'https://external.example/app.js', '/assets/app-123.js?token=private', '/manifest.webmanifest?token=private', '/icon-192.png?token=private', '/icon-512.png#private', '/src/main.ts', '/other.webmanifest', '/other.png', '/.vite/manifest.json']) {
      expect(shell.request(path)).toBeUndefined();
    }
    for (const path of ['/assets/app-123.js', '/manifest.webmanifest', '/icon-192.png']) {
      expect(shell.request(path, { headers: { Authorization: 'Bearer private' } })).toBeUndefined();
      expect(shell.request(path, { headers: { Range: 'bytes=0-2' } })).toBeUndefined();
      expect(shell.request(path, { method: 'POST' })).toBeUndefined();
    }
  });

  it.each(['application/manifest+json', 'application/json; charset=utf-8'])(
    'accepts %s for the public web manifest', async contentType => {
      const shell = worker();
      shell.responses.set(`${origin}manifest.webmanifest`, new Response('{"name":"Rehearsal"}', {
        headers: { 'Content-Type': contentType },
      }));
      await shell.install();
      await shell.activate();
      shell.fetcher.mockRejectedValue(new Error('offline'));
      expect(await (await shell.request('/manifest.webmanifest'))?.json()).toEqual({ name: 'Rehearsal' });
    },
  );

  it.each([
    ['icon-192.png', 'text/html'],
    ['icon-512.png', 'image/svg+xml'],
    ['icon-192.png', 'text/plain; image/png'],
    ['manifest.webmanifest', 'text/html'],
    ['manifest.webmanifest', 'image/svg+xml'],
    ['manifest.webmanifest', 'application/json-invalid'],
  ])('rejects %s served as %s before staging a shell', async (path, contentType) => {
    const shell = worker();
    shell.responses.set(`${origin}${path}`, new Response('wrong type', { headers: { 'Content-Type': contentType } }));
    await expect(shell.install()).rejects.toThrow('invalid_public_shell_response');
    expect(shell.cached.size).toBe(0);
  });

  it('fails closed for unbuilt or unsafe manifests and private shell responses', async () => {
    await expect(worker({}).install()).rejects.toThrow('invalid_build_manifest');
    await expect(worker({ entry: { isEntry: true, file: 'https://external.example/app.js' } }).install()).rejects.toThrow('invalid_shell_asset');
    await expect(worker({ entry: { isEntry: true, file: 'assets/song.mp3' } }).install()).rejects.toThrow('invalid_shell_asset');
    await expect(worker({ entry: { isEntry: true, file: 'assets/../local-media/song.js' } }).install()).rejects.toThrow('private_shell_asset');
    const shell = worker();
    shell.fetcher.mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private' } }));
    await expect(shell.install()).rejects.toThrow('invalid_public_shell_response');
    expect(shell.cached.size).toBe(0);
  });

  it('does not add unlisted assets to the application cache', async () => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    const before = shell.cached.size;
    await shell.request('/assets/unlisted.js');
    expect(shell.cached.size).toBe(before);
    expect(shell.cached.has(`${origin}assets/unlisted.js`)).toBe(false);
  });

  it('keeps the active shell unchanged while a new build waits for activation', async () => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    shell.updateManifest({ 'index.html': { isEntry: true, file: 'assets/new-456.js' } });
    await shell.install();
    shell.fetcher.mockRejectedValue(new Error('offline'));
    expect(await (await shell.request('/assets/app-123.js'))?.text()).toBe('built asset');
    await expect(shell.request('/assets/new-456.js')).rejects.toThrow('offline');
    await shell.activate();
    expect(await (await shell.request('/assets/new-456.js'))?.text()).toBe('built asset');
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it.each([
    ['index.html', '/', 'text/html', 'navigate'],
    ['icon-192.png', '/icon-192.png', 'image/png', 'cors'],
    ['manifest.webmanifest', '/manifest.webmanifest', 'application/manifest+json', 'cors'],
  ])('stages changed %s with an unchanged build manifest without touching the running shell', async (path, requestPath, contentType, mode) => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    const activeKey = `${origin}__rehearsal_active_shell__`;
    const pendingKey = `${origin}__rehearsal_pending_shell__`;
    const originalCache = await shell.cached.get(activeKey)!.clone().text();
    const previous = await (await shell.request(requestPath, { mode }))!.text();
    shell.responses.set(`${origin}${path}`, new Response('updated shell asset', { headers: { 'Content-Type': contentType } }));
    await shell.install();
    expect(await shell.cached.get(pendingKey)!.clone().text()).not.toBe(originalCache);
    expect(await shell.cached.get(activeKey)!.clone().text()).toBe(originalCache);
    shell.fetcher.mockRejectedValue(new Error('offline'));
    shell.restart();
    expect(await (await shell.request(requestPath, { mode }))!.text()).toBe(previous);
    await shell.activate();
    shell.restart();
    expect(await (await shell.request(requestPath, { mode }))!.text()).toBe('updated shell asset');
    expect(shell.namedCaches.has(originalCache)).toBe(true);
    expect(shell.skipWaiting).not.toHaveBeenCalled();
    expect(shell.claim).not.toHaveBeenCalled();
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it('leaves the active and pending pointers unchanged after a partial staging write', async () => {
    const shell = worker();
    await shell.install();
    await shell.activate();
    const activeKey = `${origin}__rehearsal_active_shell__`;
    const pendingKey = `${origin}__rehearsal_pending_shell__`;
    const originalCache = await shell.cached.get(activeKey)!.clone().text();
    const write = shell.put.getMockImplementation()!;
    shell.put.mockClear();
    shell.put.mockImplementation(async (name, url, response) => {
      if (url === `${origin}assets/app-123.js`) throw new Error('quota exceeded');
      await write(name, url, response);
    });
    await expect(shell.install()).rejects.toThrow('quota exceeded');
    expect(shell.put.mock.calls.length).toBeGreaterThan(1);
    expect(shell.put.mock.calls.every(([name]) => name !== originalCache)).toBe(true);
    expect(shell.put.mock.calls.some(([, url]) => url === pendingKey)).toBe(false);
    expect(await shell.cached.get(activeKey)!.clone().text()).toBe(originalCache);
    expect(await shell.cached.get(pendingKey)!.clone().text()).toBe(originalCache);
    shell.fetcher.mockRejectedValue(new Error('offline'));
    shell.restart();
    expect(await (await shell.request('/', { mode: 'navigate' }))!.text()).toBe('built asset');
    expect(shell.deleteCache).not.toHaveBeenCalled();
  });

  it.each(['__rehearsal_shell_manifest__', 'icon-512.png', 'assets/new-456.js'])(
    'refuses activation when the pending cache has lost %s', async path => {
      const shell = worker();
      await shell.install();
      await shell.activate();
      const activeKey = `${origin}__rehearsal_active_shell__`;
      const originalCache = await shell.cached.get(activeKey)!.clone().text();
      shell.updateManifest({ 'index.html': { isEntry: true, file: 'assets/new-456.js' } });
      await shell.install();
      const pendingCache = await shell.cached.get(`${origin}__rehearsal_pending_shell__`)!.clone().text();
      shell.namedCaches.get(pendingCache)!.delete(`${origin}${path}`);
      shell.restart();
      await expect(shell.activate()).rejects.toThrow('incomplete_pending_shell');
      expect(await shell.cached.get(activeKey)!.clone().text()).toBe(originalCache);
      shell.fetcher.mockRejectedValue(new Error('offline'));
      expect(await (await shell.request('/', { mode: 'navigate' }))!.text()).toBe('built asset');
      expect(shell.deleteCache).not.toHaveBeenCalled();
    },
  );
});