import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { newRoutine, validateRoutine, type AudioAsset, type FillerRecording } from '../shared/routine';
import type { CloudRoutine } from '../shared/cloud-contract';
import { hostedInvalidationEvent, hostedResetKey, hostedUserKey } from '../frontend/src/hosted-session';
import { AAC_IMPORT } from '../shared/audio-import';
import { newMusicPlaylist, type ClassSetup, type CloudMusicPlaylist, type MusicPlaylist } from '../shared/class-plan';
import { listDraftRecoveries, removeDraftRecovery, saveDraftRecovery } from '../frontend/src/offline';
import { createPlaylistSave } from '../frontend/src/playlist-save';
import type { createClassLibrary } from '../frontend/src/class-library';
import { CloudRequestError } from '../frontend/src/cloud-client';

const conversion = vi.hoisted(() => vi.fn<(file: File, options?: { signal?: AbortSignal }) => Promise<{ blob: Blob; duration: number }>>());
vi.mock('../frontend/src/audio-conversion', () => ({ convertToM4a: conversion }));

const storage = vi.hoisted(() => ({
  version: 0, queue: Promise.resolve(), opens: 0, transactions: 0, aborts: 0,
  created: [] as string[],
  modes: [] as string[],
  onOpen: undefined as (() => void | Promise<void>) | undefined,
  onTransaction: undefined as (() => void) | undefined,
  onRequest: undefined as ((store: string, method: string) => void | Promise<void>) | undefined,
}));
const stores = vi.hoisted(() => ({
  playlistWorkingCopies: new Map<string, unknown>(),
  routineWorkingCopies: new Map<string, unknown>(), cloudRoutineEnvelopes: new Map<string, unknown>(),
  draftRecovery: new Map<string, unknown>(),
  tracks: new Map<string, unknown>(), routines: new Map<string, unknown>(), meta: new Map<string, unknown>(),
  cloudRoutines: new Map<string, unknown>(),
  fillerRecordings: new Map<string, unknown>(),
  routineHistory: new Map<string, unknown>(), cloudRoutineHistory: new Map<string, unknown>(),
  musicPlaylists: new Map<string, unknown>(), musicPlaylistHistory: new Map<string, unknown>(),
  cloudMusicPlaylists: new Map<string, unknown>(), classSetups: new Map<string, unknown>(),
  classSetupHistory: new Map<string, unknown>(), cloudClassSetups: new Map<string, unknown>(),
}));
vi.mock('../frontend/node_modules/idb/build/index.js', () => ({
  openDB: async (_name: string, version: number | undefined, options: { upgrade: (...args: unknown[]) => void }) => {
    storage.opens++;
    const objectStore = (store: keyof typeof stores) => ({
      get: async (key: string) => structuredClone(stores[store].get(key)),
      getAll: async () => structuredClone([...stores[store].values()]),
      put: async (value: unknown, key: string) => stores[store].set(key, structuredClone(value)),
      delete: async (key: string) => stores[store].delete(key),
    });
    const connection = {
      objectStoreNames: Object.assign(Object.keys(stores), { contains: (name: string) => Object.hasOwn(stores, name) }),
      get: (store: keyof typeof stores, key: string) => objectStore(store).get(key),
      getAll: (store: keyof typeof stores) => objectStore(store).getAll(),
      put: (store: keyof typeof stores, value: unknown, key: string) => objectStore(store).put(value, key),
      close: vi.fn(),
      createObjectStore: vi.fn((name: string) => { storage.created.push(name); }),
      transaction: (names: (keyof typeof stores)[], mode = 'readonly') => {
        storage.transactions++;
        storage.modes.push(mode);
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
        const openCursor = (store: keyof typeof stores) => {
          let keys: string[] | undefined;
          let position = 0;
          const next = (method: string): Promise<unknown> => request(store, method, entries => {
            keys ??= [...entries.keys()].sort();
            const key = keys[position++];
            return key === undefined ? null : { key, primaryKey: key, value: structuredClone(entries.get(key)),
              continue: () => next('continue') };
          });
          return next('openCursor');
        };
        const transaction = {
          objectStore: (store: keyof typeof stores) => ({
            get: (key: string) => request(store, 'get', entries => structuredClone(entries.get(key))),
            count: () => request(store, 'count', entries => entries.size),
            openCursor: () => openCursor(store),
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
    if (version !== undefined && storage.version < version) {
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
  acknowledgeRoutineWorkingCopy, clearActiveRoutine, getRoutineWorkingCopy, listRoutineWorkingCopies, saveRoutineWorkingCopy,
  recordRoutineSyncAttempt, reconcileRoutineWorkingCopy, deleteRoutineWorkingCopy, listCloudRoutines, listRoutinePublications,
  getActiveRoutineSelection, setActiveRoutineSelection, deleteRoutineAndWorkingCopy, listCachedClassSetups,
  cacheMusicPlaylist, cacheClassSetup, getCachedMusicPlaylist, getCachedClassSetup, getPreparedClass, getReadinessClass,
  getPlaylistWorkingCopy, listPlaylistWorkingCopies, savePlaylistWorkingCopy, recordPlaylistSyncAttempt,
  acknowledgePlaylistWorkingCopy, reconcilePlaylistWorkingCopy, deletePlaylistWorkingCopy, deletePlaylistAndWorkingCopy,
  getActivePlaylistSelection, setActivePlaylistSelection, clearActivePlaylistSelection,
  listMusicPlaylistPublications, listCachedMusicPlaylists, type PlaylistWorkingCopy,
  inspectLocalAudioReferences,
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
  storage.created = [];
  storage.modes = [];
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

describe('local audio reference inspection', () => {
  const asset: AudioAsset = { id: 'uploaded', sha256: 'a'.repeat(64), bytes: 64, contentType: 'audio/wav' };
  const other: AudioAsset = { ...asset, id: 'other', sha256: 'b'.repeat(64) };
  const track = (id = 'entry') => ({ id, title: 'Synthetic entry', duration: 2, firstBeat: 0, cues: [], bodyArea: '' });
  const routine = (id = 'routine') => ({ ...newRoutine(), id, name: id, tracks: [track()] });
  const envelope = (descriptor = asset): CloudRoutine => ({ routine: routine(), media: { entry: descriptor } });
  const playlist = (id = 'playlist'): MusicPlaylist => ({ ...newMusicPlaylist(), id, name: id, tracks: [track()] });
  const playlistEnvelope = (descriptor = asset): CloudMusicPlaylist => ({ playlist: playlist(), media: { entry: descriptor } });
  const setup = (id = 'class'): ClassSetup => ({ schemaVersion: 1, id, name: id, revision: 1, locked: false,
    published: false, routine: { id: 'routine', revision: 1, published: false }, crossfade: 0 });
  const recording = (id = 'recording', descriptor = asset): FillerRecording => ({ id, name: id, duration: 2, asset: descriptor });
  let requests: string[];

  beforeEach(() => {
    storage.version = 8;
    requests = [];
    storage.onRequest = (store, method) => {
      requests.push(`${store}:${method}`);
      if (['put', 'delete', 'clear', 'getAll'].includes(method)) throw new Error('inspection_must_be_readonly_and_bounded');
    };
  });

  afterEach(() => {
    expect(storage.modes.every(mode => mode === 'readonly')).toBe(true);
    expect(storage.created).toEqual([]);
    expect(requests.some(request => /:(put|delete|clear|getAll)$/.test(request))).toBe(false);
  });

  it('proves an empty database and an unreferenced newly uploaded cache entry unused without reading audio', async () => {
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: true });
    stores.tracks.set(asset.id, { blob: new Blob(['unused upload']), bytes: 13 });
    const bytes = vi.spyOn(Blob.prototype, 'arrayBuffer');
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: true });
    expect(bytes).not.toHaveBeenCalled();
    expect(requests.filter(request => request.endsWith(':count'))).toHaveLength(32);
    expect(requests).not.toContain('tracks:openCursor');
  });

  it.each(['routines', 'routineHistory', 'cloudRoutines', 'cloudRoutineHistory'] as const)(
    'blocks retained %s even when hidden by a deletion marker and preserves all records', async store => {
      const value = routine();
      value.published = true;
      stores[store].set('retained', value);
      stores.meta.set(JSON.stringify(['deleted', 'routine', value.id]), '9');
      stores.tracks.set('entry', { blob: new Blob([new Uint8Array(64)]), bytes: 64, duration: 2, sha256: asset.sha256 });
      const before = structuredClone(stores);
      const bytes = vi.spyOn(Blob.prototype, 'arrayBuffer');
      expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [
        { kind: 'routine', id: 'routine', name: 'routine', revision: 1 },
      ], complete: true });
      expect(stores).toEqual(before);
      expect(bytes).not.toHaveBeenCalled();
    });

  it.each(['musicPlaylists', 'musicPlaylistHistory'] as const)('blocks legacy %s by stored hash or entry ID', async store => {
    stores[store].set('retained', { ...playlist(), tracks: [track(asset.id)] });
    stores.tracks.set(asset.id, { blob: new Blob([new Uint8Array(64)]), bytes: 64, duration: 2, sha256: other.sha256 });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [
      { kind: 'playlist', id: 'playlist', name: 'playlist', revision: 1 },
    ], complete: true });
  });

  it.each(['routine', 'playlist'] as const)('scans the newest %s working copy B and outstanding attempt A independently', async kind => {
    for (const target of ['current', 'attempt'] as const) {
      const make = kind === 'routine' ? envelope : playlistEnvelope;
      const current = make(target === 'current' ? asset : other);
      const attempt = make(target === 'attempt' ? asset : other);
      const store = kind === 'routine' ? stores.routineWorkingCopies : stores.playlistWorkingCopies;
      store.set(kind, { envelope: current, localVersion: 2, cloudBaseRevision: null, pendingCloud: true, savedAt: 1,
        cloudAttempt: { envelope: attempt, localVersion: 1, baseRevision: null } });
      const before = structuredClone(stores);
      expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [
        { kind, id: kind, name: kind, revision: 1 },
      ], complete: true });
      expect(stores).toEqual(before);
    }
  });

  it.each(['cloudRoutineEnvelopes', 'cloudMusicPlaylists'] as const)('finds an older immutable %s envelope without cached audio', async store => {
    stores[store].set('old', store === 'cloudRoutineEnvelopes' ? envelope() : playlistEnvelope());
    const newer = store === 'cloudRoutineEnvelopes' ? envelope(other) : playlistEnvelope(other);
    if ('routine' in newer) newer.routine.revision = 2;
    else newer.playlist.revision = 2;
    stores[store].set('head', newer);
    expect(await inspectLocalAudioReferences(asset)).toMatchObject({ complete: true, references: [{ revision: 1 }] });
  });

  it('resolves raw Cloud history through the same exact envelope, not an unrelated revision', async () => {
    stores.cloudRoutineHistory.set('old', routine());
    stores.cloudRoutineEnvelopes.set('old', envelope(other));
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: true });
    stores.cloudRoutineEnvelopes.set('old', { ...envelope(other), routine: { ...routine(), revision: 2 } });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
  });

  it.each(['working', 'recovery'] as const)('cannot use edited %s media to prove an older Cloud revision unused', async source => {
    stores.cloudRoutineHistory.set('old', routine());
    if (source === 'working') stores.routineWorkingCopies.set('routine', { envelope: envelope(other),
      localVersion: 2, cloudBaseRevision: 1, pendingCloud: true, savedAt: 1 });
    else stores.draftRecovery.set('writer', { id: 'writer', kind: 'routine', source: 'household', value: routine(),
      baseRevision: 1, media: { entry: other }, updatedAt: 1 });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
  });

  it.each(['routine', 'playlist'] as const)('scans unsaved %s recovery media', async kind => {
    stores.draftRecovery.set('writer', { id: 'writer', kind, source: 'local', value: kind === 'routine' ? routine() : playlist(),
      baseRevision: 1, media: { entry: asset }, updatedAt: 1 });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [{ kind, id: kind, name: kind, revision: 1 }], complete: true });
  });

  it.each(['classSetups', 'classSetupHistory', 'cloudClassSetups', 'draftRecovery'] as const)(
    'resolves exact routine and walk-out references for %s and blocks both the class and music', async store => {
      const value = { ...setup(), walkOut: { id: 'playlist', revision: 1, published: false } };
      const cloud = store === 'cloudClassSetups';
      stores[cloud ? 'cloudRoutineHistory' : 'routineHistory'].set('old', { ...routine(), tracks: [] });
      if (cloud) stores.cloudMusicPlaylists.set('old', playlistEnvelope());
      else {
        stores.musicPlaylistHistory.set('old', playlist());
        stores.tracks.set('entry', { blob: new Blob([new Uint8Array(64)]), bytes: 64, sha256: asset.sha256, duration: 2 });
      }
      stores[store].set('old', store === 'draftRecovery' ? { id: 'writer', kind: 'class', source: 'local', value,
        baseRevision: 1, media: {}, updatedAt: 1 } : value);
      const result = await inspectLocalAudioReferences(asset);
      expect(result.complete).toBe(true);
      expect(result.references).toEqual(expect.arrayContaining([
        { kind: 'playlist', id: 'playlist', name: 'playlist', revision: 1 },
        { kind: 'class', id: 'class', name: 'class', revision: 1 },
      ]));
    });

  it.each(['missing', 'revision', 'publication', 'source', 'working-only'] as const)(
    'cannot prove unused when an exact class reference is %s', async defect => {
      stores.classSetups.set('class', setup());
      const value = { ...routine(), tracks: [] };
      if (defect === 'revision') value.revision = 2;
      if (defect === 'publication') value.published = true;
      if (defect === 'working-only') stores.routineWorkingCopies.set('routine', { envelope: { routine: value, media: {} },
        pendingCloud: false, cloudBaseRevision: null });
      else if (defect !== 'missing') stores[defect === 'source' ? 'cloudRoutines' : 'routines'].set('routine', value);
      expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    });

  it('skips only the exact candidate filler descriptor and retains archived or equal-byte alternatives', async () => {
    stores.fillerRecordings.set('candidate', recording('candidate'));
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [{ kind: 'filler', id: 'candidate', name: 'candidate' }], complete: true });
    expect(await inspectLocalAudioReferences(asset, 'candidate')).toEqual({ references: [], complete: true });
    stores.fillerRecordings.set('archived', { ...recording('archived', { ...asset, id: 'equal-bytes' }), archived: true });
    expect(await inspectLocalAudioReferences(asset, 'candidate')).toEqual({ references: [{ kind: 'filler', id: 'archived', name: 'archived' }], complete: true });
    stores.routines.set('routine', { ...routine(), tracks: [], filler: { mode: 'none', seconds: 0, bpm: 100,
      sound: 'recording', recording: recording('candidate') } });
    expect((await inspectLocalAudioReferences(asset, 'candidate')).references).toContainEqual(
      { kind: 'routine', id: 'routine', name: 'routine', revision: 1 });
  });

  it('scans v2 walk-in/out and before/after/per-song filler snapshots, including disabled saved sound', async () => {
    const filler = { mode: 'hold' as const, seconds: 0, bpm: 100, sound: 'recording' as const, recording: recording() };
    for (const location of ['walkIn', 'walkOut', 'before', 'after', 'perSong'] as const) {
      const value: CloudRoutine = { routine: { ...routine(), tracks: [], sequence: { crossfade: 0 } }, media: {} };
      if (location === 'walkIn' || location === 'walkOut') {
        value.routine.sequence![location] = { name: location, tracks: [track()] };
        value.media.entry = asset;
      } else if (location === 'perSong') {
        value.routine.tracks = [{ ...track(), after: { mode: 'custom', filler } }];
        value.media.entry = other;
      } else value.routine.sequence![location] = filler;
      stores.cloudRoutineEnvelopes.set('routine', value);
      expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [
        { kind: 'routine', id: 'routine', name: 'routine', revision: 1 },
      ], complete: true });
    }
  });

  it('hashes only small size-matching legacy bytes serially outside the transaction without backfilling hashes', async () => {
    const blob = new Blob([new Uint8Array(64)], { type: 'audio/wav' });
    const candidate = { ...asset, sha256: await sha256(blob) };
    stores.routines.set('routine', { ...routine(), tracks: [track('first'), track('second'), track('different-size')] });
    for (const id of ['first', 'second']) stores.tracks.set(id, { blob, bytes: 64, duration: 2 });
    stores.tracks.set('different-size', { blob: new Blob([new Uint8Array(65)]), bytes: 65, duration: 2 });
    const before = structuredClone(stores);
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let active = 0;
    const hash = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
      expect(++active).toBe(1);
      let closed = false;
      void storage.queue.then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(true);
      const result = await original(algorithm, bytes);
      active--;
      return result;
    });
    expect(await inspectLocalAudioReferences(candidate)).toEqual({ references: [
      { kind: 'routine', id: 'routine', name: 'routine', revision: 1 },
    ], complete: true });
    expect(hash).toHaveBeenCalledTimes(2);
    expect(stores).toEqual(before);
  });

  it.each(['missing', 'invalid-hash', 'unavailable-crypto', 'failed-hash', 'oversized'] as const)(
    'fails closed for unresolved legacy metadata: %s', async defect => {
      const bytes = defect === 'oversized' ? 8 * 1024 * 1024 + 1 : 64;
      const candidate = { ...asset, bytes };
      stores.routines.set('routine', routine());
      if (defect !== 'missing') stores.tracks.set('entry', { blob: new Blob([new Uint8Array(bytes)]), bytes, duration: 2,
        ...(defect === 'invalid-hash' ? { sha256: 'invalid' } : {}) });
      if (defect === 'unavailable-crypto') vi.stubGlobal('crypto', undefined);
      if (defect === 'failed-hash') vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('hash_failed'));
      expect(await inspectLocalAudioReferences(candidate)).toEqual({ references: [], complete: false });
    });

  it('can prove nonmatching known hashes or different legacy byte sizes unused', async () => {
    stores.routines.set('routine', { ...routine(), tracks: [track('known'), track('legacy')] });
    stores.tracks.set('known', { blob: new Blob([new Uint8Array(64)]), bytes: 64, sha256: other.sha256 });
    stores.tracks.set('legacy', { blob: new Blob([new Uint8Array(65)]), bytes: 65 });
    const bytes = vi.spyOn(Blob.prototype, 'arrayBuffer');
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: true });
    expect(bytes).not.toHaveBeenCalled();
  });

  it('counts before reading values and refuses more than 10000 total records', async () => {
    for (let index = 0; index < 10001; index++) stores.routineHistory.set(String(index), null);
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    expect(requests.every(request => request.endsWith(':count'))).toBe(true);
    expect(stores.routineHistory.size).toBe(10001);
  });

  it('bounds returned references at 256 without claiming completeness or removing history', async () => {
    for (let index = 0; index < 257; index++) stores.fillerRecordings.set(`recording-${index}`, recording(`recording-${index}`));
    const result = await inspectLocalAudioReferences(asset);
    expect(result.complete).toBe(false);
    expect(result.references).toHaveLength(256);
    expect(stores.fillerRecordings.size).toBe(257);
  });

  it('bounds a single control record before traversing its references', async () => {
    stores.routineHistory.set('oversized', { ...routine(), name: 'x'.repeat(512 * 1024) });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    expect(requests).not.toContain('tracks:get');
    expect(stores.routineHistory.size).toBe(1);
  });

  it('stops cursor traversal at the aggregate metadata budget without loading the remaining history', async () => {
    const value = { ...routine(), tracks: [{ ...track(), cues: Array.from({ length: 600 }, (_, index) => ({
      id: `cue-${index}`, anchor: { kind: 'timestamp', seconds: 1 }, note: 'x'.repeat(500),
    })) }] };
    for (let index = 0; index < 32; index++) stores.routineHistory.set(`revision-${index}`, { ...value, revision: index + 1 });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    expect(requests.filter(request => request === 'routineHistory:continue').length).toBeLessThan(31);
    expect(requests).not.toContain('tracks:get');
    expect(stores.routineHistory.size).toBe(32);
  });

  it('bounds the number of legacy hashes and reports the remaining matching-size bytes unresolved', async () => {
    const blob = new Blob([new Uint8Array(64)]);
    const tracks = Array.from({ length: 17 }, (_, index) => track(`entry-${index}`));
    stores.routines.set('routine', { ...routine(), tracks });
    for (const entry of tracks) stores.tracks.set(entry.id, { blob, bytes: blob.size, duration: 2 });
    const hash = vi.spyOn(crypto.subtle, 'digest');
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    expect(hash).toHaveBeenCalledTimes(16);
    expect([...stores.tracks.values()].every(value => !Object.hasOwn(value as object, 'sha256'))).toBe(true);
  });

  it('keeps a stable readonly snapshot when another writer changes a cached hash during inspection', async () => {
    stores.routines.set('routine', routine());
    const stored = { blob: new Blob([new Uint8Array(64)]), bytes: 64, duration: 2, sha256: asset.sha256 };
    stores.tracks.set('entry', stored);
    const observe = storage.onRequest;
    storage.onRequest = async (store, method) => {
      await observe?.(store, method);
      if (method === 'count') stores.tracks.set('entry', { ...stored, sha256: other.sha256 });
    };
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [
      { kind: 'routine', id: 'routine', name: 'routine', revision: 1 },
    ], complete: true });
    expect(stores.tracks.get('entry')).toMatchObject({ sha256: other.sha256 });
  });

  it('does not exempt duplicate candidate descriptors at a different retained key or changed descriptor identity', async () => {
    stores.fillerRecordings.set('duplicate', recording('candidate'));
    expect(await inspectLocalAudioReferences(asset, 'candidate')).toEqual({ references: [
      { kind: 'filler', id: 'candidate', name: 'candidate' },
    ], complete: true });
    stores.fillerRecordings.clear();
    stores.fillerRecordings.set('candidate', recording('candidate', other));
    expect(await inspectLocalAudioReferences(asset, 'candidate')).toEqual({ references: [
      { kind: 'filler', id: 'candidate', name: 'candidate' },
    ], complete: true });
  });

  it('treats unknown retained routine fields as incomplete even when known tracks are unrelated', async () => {
    stores.routines.set('routine', { ...routine(), tracks: [], futureAudio: asset });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    stores.routines.set('routine', { ...routine(), tracks: [{ ...track(), after: { mode: 'none', filler: recording() } }] });
    stores.tracks.set('entry', { blob: new Blob([new Uint8Array(64)]), bytes: 64, sha256: other.sha256 });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
  });

  it('returns incomplete on corrupt history or a read failure without mutating any store', async () => {
    stores.routineHistory.set('corrupt', { id: 'routine' });
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    storage.onRequest = () => { throw new Error('read_failed'); };
    expect(await inspectLocalAudioReferences(asset)).toEqual({ references: [], complete: false });
    expect(stores.routineHistory.get('corrupt')).toEqual({ id: 'routine' });
  });

  it.each(['entry', 'snapshot', 'hash'] as const)('fences owner/reset invalidation at %s', async phase => {
    vi.stubEnv('VITE_HOSTED_PILOT', 'true');
    const markers = new Map([[hostedUserKey, 'owner-A']]);
    const events = new EventTarget();
    Object.assign(events, { localStorage: { getItem: (key: string) => markers.get(key) ?? null } });
    vi.stubGlobal('window', events);
    vi.resetModules();
    const offline = await import('../frontend/src/offline');
    if (phase === 'entry') markers.set(hostedResetKey, 'reset');
    if (phase === 'snapshot') storage.onRequest = () => { markers.set(hostedUserKey, 'owner-B'); };
    if (phase === 'hash') {
      stores.routines.set('routine', routine());
      stores.tracks.set('entry', { blob: new Blob([new Uint8Array(64)]), bytes: 64, duration: 2 });
      const original = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
        markers.set(hostedResetKey, 'reset');
        return original(algorithm, bytes);
      });
    }
    await expect(offline.inspectLocalAudioReferences(asset)).rejects.toThrow('hosted_session_invalidated');
    if (phase === 'entry') expect(storage.opens).toBe(0);
  });
});

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

describe('private draft recovery', () => {
  const record = () => ({ id: 'tab-a:routine', kind: 'routine' as const, source: 'local' as const,
    value: newRoutine(), baseRevision: null, media: {}, updatedAt: 1 });

  it('migrates to v6 and retains detached working copies without saving a routine', async () => {
    storage.version = 5;
    const value = record(); await saveDraftRecovery(value);
    value.value.name = 'Changed caller';
    const records = await listDraftRecoveries();
    expect(records[0].value.name).not.toBe('Changed caller');
    expect(storage.version).toBe(8); expect(stores.routines.size).toBe(0);
    expect(stores.tracks.size).toBe(0);
    await removeDraftRecovery(records[0].id, records[0].updatedAt);
    expect(await listDraftRecoveries()).toEqual([]);
  });
  it('does not discard another tab update or evict unsaved drafts at capacity', async () => {
    const value = record(); await saveDraftRecovery(value);
    await saveDraftRecovery({ ...value, updatedAt: 2 });
    await expect(removeDraftRecovery(value.id, 1)).rejects.toThrow('routine_conflict');
    for (let index = 1; index < 64; index++) await saveDraftRecovery({ ...value, id: `tab-${index}` });
    await expect(saveDraftRecovery({ ...value, id: 'overflow' })).rejects.toThrow('recovery_limit');
    expect((await listDraftRecoveries()).length).toBe(64);
    await saveDraftRecovery({ ...value, updatedAt: 3 });
  });
  it('refuses oversized copies and locked or published working snapshots', async () => {
    const value = record();
    await expect(saveDraftRecovery({ ...value, value: { ...value.value, name: 'x'.repeat(256 * 1024) } })).rejects.toThrow('recovery_limit');
    await expect(saveDraftRecovery({ ...value, value: { ...value.value, locked: true } })).rejects.toThrow('recovery_limit');
    await expect(saveDraftRecovery({ ...value, value: { ...value.value, published: true } })).rejects.toThrow('recovery_limit');
    expect(await listDraftRecoveries()).toEqual([]);
  });
});

describe('playlist save coordinator', () => {
  const options = { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null };
  const fixture = () => {
    const envelope: CloudMusicPlaylist = { playlist: { ...newMusicPlaylist(), tracks: [
      { id: 'entry', title: 'Synthetic song', duration: 2, firstBeat: 0, bodyArea: '', cues: [] },
    ] }, media: { entry: { id: 'entry', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' } } };
    let head: CloudMusicPlaylist | null = null;
    const readPlaylistHead = vi.fn(async () => {
      if (!head) throw new CloudRequestError('cloud_http_error', 404);
      return structuredClone(head);
    });
    const stagePlaylist = vi.fn(async (playlist: MusicPlaylist, media: CloudMusicPlaylist['media']) => structuredClone({ playlist, media }));
    const commitPlaylist = vi.fn(async (value: CloudMusicPlaylist, base: number | null) => {
      if ((head?.playlist.revision ?? null) !== base) throw new Error('playlist_conflict');
      const queued = await getPlaylistWorkingCopy(value.playlist.id);
      expect(queued?.cloudAttempt?.envelope).toEqual(value);
      head = { ...structuredClone(value), playlist: { ...structuredClone(value.playlist), revision: (base ?? 0) + 1 } };
      return structuredClone(head);
    });
    const library = { readPlaylistHead, stagePlaylist, commitPlaylist };
    const saver = createPlaylistSave(library as unknown as ReturnType<typeof createClassLibrary>);
    return { envelope, saver, library, setHead(value: CloudMusicPlaylist) { head = structuredClone(value); } };
  };

  it('creates Cloud revision one after multiple local revisions without changing routine selection', async () => {
    const { envelope, saver, library } = fixture();
    stores.meta.set('active', 'routine-unchanged');
    const first = await savePlaylistWorkingCopy(envelope, { ...options, cloud: false });
    const second = await savePlaylistWorkingCopy({ ...first.envelope, playlist: { ...first.envelope.playlist, name: 'Second edit' } },
      { ...options, cloud: false, expectedLocalVersion: first.localVersion });
    const queued = await savePlaylistWorkingCopy(second.envelope, { ...options, expectedLocalVersion: second.localVersion });
    expect(queued.envelope.playlist.revision).toBe(2);
    const result = await saver.sync(queued);
    expect(result).toMatchObject({ localVersion: 3, cloudBaseRevision: 1, pendingCloud: false,
      envelope: { playlist: { name: 'Second edit', revision: 1 } } });
    expect(library.commitPlaylist).toHaveBeenCalledOnce();
    expect(library.commitPlaylist.mock.calls[0]![1]).toBeNull();
    expect(stores.meta.get('active')).toBe('routine-unchanged');
    expect((await getMusicPlaylist(envelope.playlist.id))?.revision).toBe(2);
  });

  it('reconciles a lost A acknowledgment and commits newer saved B exactly once', async () => {
    const { envelope, saver, library } = fixture();
    const first = await savePlaylistWorkingCopy(envelope, options);
    const commit = library.commitPlaylist.getMockImplementation()!;
    library.commitPlaylist.mockImplementationOnce(async (value, base) => {
      await commit(value, base);
      await savePlaylistWorkingCopy({ ...value, playlist: { ...value.playlist, name: 'Newer B' } },
        { ...options, expectedLocalVersion: first.localVersion });
      throw new CloudRequestError('network_unavailable');
    });
    await expect(saver.sync(first)).rejects.toThrow('network_unavailable');
    const pending = (await getPlaylistWorkingCopy(envelope.playlist.id))!;
    expect(pending.cloudAttempt?.envelope.playlist.name).toBe(envelope.playlist.name);
    expect(pending.envelope.playlist.name).toBe('Newer B');
    const result = await saver.sync(pending);
    expect(result).toMatchObject({ localVersion: 2, savedAt: pending.savedAt, cloudBaseRevision: 2, pendingCloud: false,
      envelope: { playlist: { name: 'Newer B' } } });
    expect(result?.cloudAttempt).toBeUndefined();
    expect(library.commitPlaylist.mock.calls.map(call => call[1])).toEqual([null, 1]);
  });

  it.each(['conflict', 'locked'] as const)('preserves pending content when the remote head is %s', async reason => {
    const { envelope, saver, library, setHead } = fixture();
    const queued = await savePlaylistWorkingCopy(envelope, { ...options, cloudBaseRevision: 1 });
    setHead({ ...envelope, playlist: { ...envelope.playlist, revision: reason === 'conflict' ? 2 : 1, locked: reason === 'locked' } });
    await expect(saver.sync(queued)).rejects.toThrow();
    expect(library.stagePlaylist).not.toHaveBeenCalled();
    expect(library.commitPlaylist).not.toHaveBeenCalled();
    expect(await getPlaylistWorkingCopy(envelope.playlist.id)).toEqual(queued);
  });
});

describe('playlist working copies', () => {
  const options = { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null };
  const envelope = (): CloudMusicPlaylist => ({ playlist: { ...newMusicPlaylist(), tracks: [
    { id: 'entry', title: 'Synthetic song', duration: 2, firstBeat: 0, bodyArea: '', cues: [], gain: 1.5 },
  ] }, media: { entry: { id: 'entry', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' } } });
  const response = (value: CloudMusicPlaylist, revision: number): CloudMusicPlaylist => ({
    ...structuredClone(value), playlist: { ...structuredClone(value.playlist), revision },
  });
  const cleanCloud = async () => {
    const saved = await savePlaylistWorkingCopy(envelope(), options);
    await recordPlaylistSyncAttempt(saved.envelope.playlist.id, 1, saved.envelope, null);
    await acknowledgePlaylistWorkingCopy(saved.envelope.playlist.id, 1, saved.envelope);
    return (await getPlaylistWorkingCopy(saved.envelope.playlist.id))!;
  };

  it('adds only the v8 store while retaining every v7 store and exact legacy revision', async () => {
    storage.version = 7;
    const legacy = { ...newMusicPlaylist(), schemaVersion: 1 as const, revision: 9 };
    stores.musicPlaylists.set(legacy.id, legacy);
    stores.routines.set('routine', newRoutine());
    stores.meta.set('active', 'routine');
    stores.tracks.set('private', { blob: new Blob(['synthetic']), bytes: 9 });
    const before = structuredClone(stores);
    expect(await listPlaylistWorkingCopies()).toEqual([]);
    expect(storage.created).toEqual(['playlistWorkingCopies']);
    expect(storage.version).toBe(8);
    expect(stores).toEqual(before);
    expect(await getMusicPlaylist(legacy.id, 9)).toEqual(legacy);
  });

  it.each([1, 2] as const)('retains schema %s, unknown BPM, legacy gain and imported descriptor IDs', async schemaVersion => {
    const value = envelope();
    value.playlist.schemaVersion = schemaVersion;
    value.playlist.revision = 12;
    const saved = await savePlaylistWorkingCopy(value, { ...options, cloudBaseRevision: 12 });
    expect(saved).toMatchObject({ localVersion: 1, cloudBaseRevision: 12, pendingCloud: true });
    expect(saved.envelope).toEqual(value);
    expect(saved.savedAt).toBeGreaterThan(0);
    expect(saved.envelope.playlist).not.toHaveProperty('savedAt');
    expect(saved.envelope.playlist.tracks[0]).not.toHaveProperty('bpm');
    saved.envelope.playlist.name = 'Caller mutation';
    expect((await getPlaylistWorkingCopy(value.playlist.id))?.envelope).toEqual(value);
    expect(await getMusicPlaylist(value.playlist.id)).toBeNull();
    expect(await listMusicPlaylists()).toEqual([]);
  });

  it('serializes CAS and keeps the winning local version independent of the Cloud base', async () => {
    const value = response(envelope(), 14);
    const results = await Promise.allSettled([savePlaylistWorkingCopy(value, { ...options, cloudBaseRevision: 14 }),
      savePlaylistWorkingCopy(value, { ...options, cloudBaseRevision: 14 })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: new Error('playlist_conflict') }]);
    const second = await savePlaylistWorkingCopy(value, { ...options, expectedLocalVersion: 1, cloudBaseRevision: 14 });
    expect(second).toMatchObject({ localVersion: 2, cloudBaseRevision: 14, envelope: { playlist: { revision: 14 } } });
    await expect(savePlaylistWorkingCopy(value, { ...options, expectedLocalVersion: 1, cloudBaseRevision: 14 })).rejects.toThrow('playlist_conflict');
    expect(await listPlaylistWorkingCopies()).toEqual([second]);
  });

  it('preserves pending work and independent routine/publication selection through close and reload', async () => {
    const routine = await saveRoutine(newRoutine(), null);
    await setActiveRoutineSelection({ id: routine.id, revision: 1, published: false });
    const routineSelection = stores.meta.get('activeRoutineSelection');
    const saved = await savePlaylistWorkingCopy(envelope(), options);
    await savePlaylistWorkingCopy(saved.envelope, { ...options, cloud: false, expectedLocalVersion: 1 });
    await setActivePlaylistSelection({ id: saved.envelope.playlist.id, source: 'household', published: true, revision: 7 });
    vi.resetModules();
    const reopened = await import('../frontend/src/offline');
    expect(await reopened.getActivePlaylistSelection()).toEqual({ id: saved.envelope.playlist.id, source: 'household', published: true, revision: 7 });
    await reopened.clearActivePlaylistSelection();
    expect(await reopened.getActivePlaylistSelection()).toBeNull();
    expect((await reopened.getPlaylistWorkingCopy(saved.envelope.playlist.id))?.pendingCloud).toBe(true);
    expect(stores.meta.get('active')).toBe(routine.id);
    expect(stores.meta.get('activeRoutineSelection')).toBe(routineSelection);
    await reopened.setActivePlaylistSelection({ id: saved.envelope.playlist.id, source: 'household', published: false });
    await reopened.clearActiveRoutine();
    expect(await reopened.getActivePlaylistSelection()).not.toBeNull();
  });

  it.each([undefined, null, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a published selection without an exact positive safe revision %s', async revision => {
      await expect(setActivePlaylistSelection({ id: 'playlist', source: 'local', published: true, revision: revision as number }))
        .rejects.toThrow('playlist_conflict');
      expect(storage.opens).toBe(0);
    },
  );

  it('projects local saves into exact history for class adoption without treating local revisions as Cloud revisions', async () => {
    const first = await savePlaylistWorkingCopy(envelope(), { ...options, cloud: false });
    const id = first.envelope.playlist.id;
    const routine = await saveRoutine(newRoutine(), null);
    const setup = await saveClassSetup({ schemaVersion: 1, id: 'adopted', name: 'Adopted', revision: 1,
      locked: false, published: false, routine: { id: routine.id, revision: 1, published: false },
      walkIn: { id, revision: 1, published: false }, crossfade: 0 }, null);
    const second = await savePlaylistWorkingCopy({ ...first.envelope, playlist: { ...first.envelope.playlist, name: 'Second' } },
      { ...options, cloud: false, expectedLocalVersion: 1 });
    expect(second).toMatchObject({ localVersion: 2, cloudBaseRevision: null, envelope: { playlist: { revision: 2 } } });
    expect(await getMusicPlaylist(id, 1)).toEqual(first.envelope.playlist);
    expect(await listMusicPlaylists()).toEqual([second.envelope.playlist]);
    expect((await getPreparedClass(setup.id))?.audio.walkIn).toEqual(first.envelope.playlist);
    const queued = await savePlaylistWorkingCopy(second.envelope, { ...options, expectedLocalVersion: 2 });
    expect(await getActivePlaylistSelection()).toEqual({ id, source: 'household', published: false });
    const submitted = response(queued.envelope, 1);
    await expect(recordPlaylistSyncAttempt(id, 3, queued.envelope, null)).rejects.toThrow('playlist_conflict');
    await recordPlaylistSyncAttempt(id, 3, submitted, null);
    await acknowledgePlaylistWorkingCopy(id, 3, submitted);
    expect(await getPlaylistWorkingCopy(id)).toMatchObject({ localVersion: 3, cloudBaseRevision: 1, pendingCloud: false });
    expect(await getMusicPlaylist(id)).toEqual(second.envelope.playlist);
    expect((await getPreparedClass(setup.id))?.audio.walkIn).toEqual(first.envelope.playlist);
    expect(await getCachedMusicPlaylist(id, 1, false)).toEqual(submitted);
  });

  it('rebases newer B after the exact lost-response A without discarding B or changing its save timestamp', async () => {
    const first = await savePlaylistWorkingCopy(envelope(), options);
    const id = first.envelope.playlist.id;
    await recordPlaylistSyncAttempt(id, 1, first.envelope, null);
    const newer = structuredClone(first.envelope);
    newer.playlist.name = 'Newer B';
    newer.media.entry = { ...newer.media.entry!, id: 'new-asset', sha256: 'b'.repeat(64) };
    const second = await savePlaylistWorkingCopy(newer, { ...options, cloud: false, expectedLocalVersion: 1 });
    vi.resetModules();
    const reopened = await import('../frontend/src/offline');
    expect((await reopened.getPlaylistWorkingCopy(id))?.cloudAttempt).toEqual({ envelope: first.envelope, localVersion: 1, baseRevision: null });
    await reopened.acknowledgePlaylistWorkingCopy(id, 1, first.envelope);
    const rebased = (await reopened.getPlaylistWorkingCopy(id))!;
    expect(rebased).toEqual({ ...second, cloudAttempt: undefined, envelope: newer, cloudBaseRevision: 1, pendingCloud: true });
    expect(await getCachedMusicPlaylist(id, 1, false)).toEqual(first.envelope);
    await reopened.recordPlaylistSyncAttempt(id, 2, rebased.envelope, 1);
    await reopened.acknowledgePlaylistWorkingCopy(id, 2, response(rebased.envelope, 2));
    expect(await reopened.getPlaylistWorkingCopy(id)).toMatchObject({ localVersion: 2, savedAt: second.savedAt, pendingCloud: false, cloudBaseRevision: 2 });
  });

  it('allows only one exact outstanding attempt and rejects unrelated or published acknowledgments', async () => {
    const first = await savePlaylistWorkingCopy(envelope(), options);
    const id = first.envelope.playlist.id;
    await expect(recordPlaylistSyncAttempt(id, 2, first.envelope, null)).rejects.toThrow('playlist_conflict');
    await expect(recordPlaylistSyncAttempt(id, 1, first.envelope, 1)).rejects.toThrow('playlist_conflict');
    await recordPlaylistSyncAttempt(id, 1, first.envelope, null);
    await recordPlaylistSyncAttempt(id, 1, structuredClone(first.envelope), null);
    const newer = await savePlaylistWorkingCopy({ ...first.envelope, playlist: { ...first.envelope.playlist, name: 'B' } },
      { ...options, expectedLocalVersion: 1 });
    await expect(recordPlaylistSyncAttempt(id, 2, newer.envelope, null)).rejects.toThrow('playlist_conflict');
    for (const invalid of [newer.envelope, response(first.envelope, 2),
      { ...first.envelope, playlist: { ...first.envelope.playlist, published: true } },
      { ...first.envelope, playlist: { ...first.envelope.playlist, locked: true } }]) {
      await expect(acknowledgePlaylistWorkingCopy(id, 1, invalid)).rejects.toThrow('playlist_conflict');
    }
    expect(await getPlaylistWorkingCopy(id)).toEqual(newer);
    expect(await listCachedMusicPlaylists()).toEqual([]);
  });

  it('rolls acknowledgment back atomically if the immutable cache write fails', async () => {
    const saved = await savePlaylistWorkingCopy(envelope(), options);
    const id = saved.envelope.playlist.id;
    await recordPlaylistSyncAttempt(id, 1, saved.envelope, null);
    const before = await getPlaylistWorkingCopy(id);
    storage.onRequest = (store, method) => { if (store === 'cloudMusicPlaylists' && method === 'put') throw new Error('QuotaExceededError'); };
    await expect(acknowledgePlaylistWorkingCopy(id, 1, saved.envelope)).rejects.toThrow('QuotaExceededError');
    storage.onRequest = undefined;
    expect(await getPlaylistWorkingCopy(id)).toEqual(before);
    expect(stores.cloudMusicPlaylists.size).toBe(0);
  });

  it('rolls local projection, history, working state and selection back on a failed commit', async () => {
    const first = await savePlaylistWorkingCopy(envelope(), { ...options, cloud: false });
    const before = structuredClone(stores);
    storage.onRequest = (store, method) => { if (store === 'meta' && method === 'put') throw new Error('QuotaExceededError'); };
    await expect(savePlaylistWorkingCopy(first.envelope, { ...options, cloud: false, expectedLocalVersion: 1 })).rejects.toThrow('QuotaExceededError');
    storage.onRequest = undefined;
    expect(stores).toEqual(before);
  });

  it('keeps repeated identical authoritative reads timestamp-stable and reconciles a newer unlock over an old lock', async () => {
    const clean = await cleanCloud();
    const id = clean.envelope.playlist.id;
    const put = vi.fn();
    storage.onRequest = (store, method) => { if (store === 'playlistWorkingCopies' && method === 'put') put(); };
    vi.spyOn(Date, 'now').mockReturnValue(clean.savedAt + 5000);
    expect(await reconcilePlaylistWorkingCopy(clean.envelope)).toEqual(clean);
    expect(await reconcilePlaylistWorkingCopy(structuredClone(clean.envelope))).toEqual(clean);
    expect(put).not.toHaveBeenCalled();
    const locked = response(clean.envelope, 2);
    locked.playlist.locked = true;
    await reconcilePlaylistWorkingCopy(locked);
    await expect(savePlaylistWorkingCopy(response(clean.envelope, 2), { ...options, expectedLocalVersion: 1, cloudBaseRevision: 2 }))
      .rejects.toThrow('playlist_locked');
    const unlocked = response(clean.envelope, 3);
    const refreshed = (await reconcilePlaylistWorkingCopy(unlocked))!;
    expect(refreshed).toMatchObject({ localVersion: 1, cloudBaseRevision: 3, savedAt: clean.savedAt });
    await expect(reconcilePlaylistWorkingCopy(locked)).rejects.toThrow('playlist_conflict');
    await expect(reconcilePlaylistWorkingCopy({ ...unlocked, playlist: { ...unlocked.playlist, name: 'Forged same head' } }))
      .rejects.toThrow('playlist_conflict');
    const saved = await savePlaylistWorkingCopy(refreshed.envelope, { ...options, expectedLocalVersion: 1, cloudBaseRevision: 3 });
    expect(saved.localVersion).toBe(2);
    await expect(reconcilePlaylistWorkingCopy(response(unlocked, 4))).rejects.toThrow('playlist_conflict');
    expect((await getPlaylistWorkingCopy(id))?.pendingCloud).toBe(true);
  });

  it('does not let a stale cached lock override an explicitly based newer unlocked working head', async () => {
    const value = response(envelope(), 4);
    await cacheMusicPlaylist({ ...response(value, 2), playlist: { ...value.playlist, revision: 2, locked: true } });
    const saved = await savePlaylistWorkingCopy(value, { ...options, cloudBaseRevision: 4 });
    expect(saved.cloudBaseRevision).toBe(4);
    await cacheMusicPlaylist({ ...response(value, 5), playlist: { ...value.playlist, revision: 5, locked: true } });
    await expect(savePlaylistWorkingCopy(value, { ...options, cloudBaseRevision: 4, expectedLocalVersion: 1 })).rejects.toThrow('playlist_locked');
  });

  it('keeps old local heads independent of a Cloud lock/unlock with the same identity', async () => {
    const value = envelope();
    const local = await saveMusicPlaylist(value.playlist, null, 'lock');
    const clean = await savePlaylistWorkingCopy(response(value, 8), { ...options, cloud: false, cloudBaseRevision: 8 });
    expect(clean.pendingCloud).toBe(false);
    const locked = response(clean.envelope, 9);
    locked.playlist.locked = true;
    await reconcilePlaylistWorkingCopy(locked);
    const unlocked = (await reconcilePlaylistWorkingCopy(response(clean.envelope, 10)))!;
    await savePlaylistWorkingCopy(unlocked.envelope, { ...options, cloudBaseRevision: 10, expectedLocalVersion: 1 });
    expect(await getMusicPlaylist(value.playlist.id)).toEqual(local);
  });

  it('keeps publications separate from the editable copy and lists latest draft/publication heads independently', async () => {
    const clean = await cleanCloud();
    const publication = response(clean.envelope, 2);
    publication.playlist.published = true;
    await cacheMusicPlaylist(publication);
    const draft = response(clean.envelope, 3);
    await reconcilePlaylistWorkingCopy(draft);
    await cacheMusicPlaylist({ ...response(publication, 1), playlist: { ...publication.playlist, revision: 1 } });
    await expect(reconcilePlaylistWorkingCopy(publication)).rejects.toThrow('playlist_published');
    expect((await getPlaylistWorkingCopy(draft.playlist.id))?.envelope).toEqual(draft);
    expect(await getCachedMusicPlaylist(draft.playlist.id, 2, true)).toEqual(publication);
    expect(await listCachedMusicPlaylists()).toEqual(expect.arrayContaining([draft, publication]));
    expect(await listCachedMusicPlaylists()).toHaveLength(2);
  });

  it('supports legacy local lock/unlock and publication without leaving a stale working lock or CAS', async () => {
    const first = await savePlaylistWorkingCopy(envelope(), { ...options, cloud: false });
    const locked = await saveMusicPlaylist(first.envelope.playlist, 1, 'lock');
    expect(await getPlaylistWorkingCopy(locked.id)).toMatchObject({ localVersion: 2, envelope: { playlist: { locked: true, revision: 2 } } });
    await expect(savePlaylistWorkingCopy(first.envelope, { ...options, cloud: false, expectedLocalVersion: 1 })).rejects.toThrow('playlist_conflict');
    const unlocked = await saveMusicPlaylist(locked, 2, 'unlock');
    const working = (await getPlaylistWorkingCopy(locked.id))!;
    expect(working.envelope.playlist).toEqual(unlocked);
    expect(await reconcilePlaylistWorkingCopy(working.envelope)).toEqual(working);
    expect(working.cloudBaseRevision).toBeNull();
    expect(stores.cloudMusicPlaylists.size).toBe(0);
    const saved = await savePlaylistWorkingCopy(working.envelope, { ...options, cloud: false, expectedLocalVersion: 3 });
    const publication = await saveMusicPlaylist(saved.envelope.playlist, 4, 'publish');
    expect(await listMusicPlaylistPublications()).toEqual([publication]);
    expect(await getMusicPlaylist(locked.id, 5)).toEqual(publication);
    expect((await getPlaylistWorkingCopy(locked.id))?.envelope.playlist.published).toBe(false);
  });

  it.each(['locked', 'published'] as const)('rejects %s working saves without touching storage', async state => {
    const value = envelope();
    value.playlist[state] = true;
    await expect(savePlaylistWorkingCopy(value, options)).rejects.toThrow(`playlist_${state}`);
    expect(storage.opens).toBe(0);
  });

  it('fails closed on missing/extra media, conflicting asset identities, credentials and future schemas', async () => {
    const value = envelope();
    const invalid: CloudMusicPlaylist[] = [
      { ...value, media: {} }, { ...value, media: { ...value.media, extra: value.media.entry! } },
      { ...value, playlist: { ...value.playlist, schemaVersion: 3 } as unknown as MusicPlaylist },
      { ...value, playlist: { ...value.playlist, revision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...value, csrfToken: 'synthetic' } as CloudMusicPlaylist,
      { ...value, playlist: { ...value.playlist, savedAt: 123 } as MusicPlaylist },
      { ...value, playlist: { ...value.playlist, tracks: [{ ...value.playlist.tracks[0]!, credentials: 'synthetic' }] } } as unknown as CloudMusicPlaylist,
      { ...value, playlist: { ...value.playlist, tracks: [...value.playlist.tracks, { ...value.playlist.tracks[0]!, id: 'second' }] },
        media: { ...value.media, second: { ...value.media.entry!, sha256: 'b'.repeat(64) } } },
    ];
    for (const candidate of invalid) await expect(savePlaylistWorkingCopy(candidate, options)).rejects.toThrow('invalid_cloud_playlist');
    expect(stores.playlistWorkingCopies.size).toBe(0);
    const first = await savePlaylistWorkingCopy(value, options);
    await expect(savePlaylistWorkingCopy({ ...value, playlist: { ...value.playlist, schemaVersion: 1 } },
      { ...options, expectedLocalVersion: 1 })).rejects.toThrow('playlist_conflict');
    stores.playlistWorkingCopies.set(value.playlist.id, { ...first, futureField: true });
    await expect(getPlaylistWorkingCopy(value.playlist.id)).rejects.toThrow('invalid_playlist_working_copy');
    await expect(listPlaylistWorkingCopies()).rejects.toThrow('invalid_playlist_working_copy');
  });

  it('bounds record count without evicting saved or pending work', async () => {
    for (let index = 0; index < 64; index++) await savePlaylistWorkingCopy({ playlist: newMusicPlaylist(), media: {} }, options);
    await expect(savePlaylistWorkingCopy(envelope(), options)).rejects.toThrow('playlist_working_copy_limit');
    expect(await listPlaylistWorkingCopies()).toHaveLength(64);
  });

  it('bounds aggregate storage including attempted envelopes without evicting any record', async () => {
    const value = envelope();
    value.playlist.tracks = Array.from({ length: 100 }, (_, index) => ({ ...value.playlist.tracks[0]!,
      id: `track-${String(index).padStart(3, '0')}-${'x'.repeat(150)}`, title: 't'.repeat(300), bodyArea: 'a'.repeat(160) }));
    value.media = Object.fromEntries(value.playlist.tracks.map(track => [track.id, { ...value.media.entry!, id: track.id }]));
    const limit = 4 * 1024 * 1024;
    let total = 0;
    for (let index = 0; index < 64; index++) {
      const candidate = { ...structuredClone(value), playlist: { ...structuredClone(value.playlist), id: `large-${String(index).padStart(2, '0')}` } };
      const record: PlaylistWorkingCopy = { envelope: candidate, localVersion: 1, cloudBaseRevision: null,
        pendingCloud: true, savedAt: Date.now(), cloudAttempt: { envelope: candidate, localVersion: 1, baseRevision: null } };
      let size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      expect(size).toBeLessThanOrEqual(256 * 1024);
      if (total + size > limit) {
        delete record.cloudAttempt;
        size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      }
      if (total + size > limit) break;
      stores.playlistWorkingCopies.set(candidate.playlist.id, structuredClone(record));
      total += size;
    }
    expect(stores.playlistWorkingCopies.size).toBeLessThan(64);
    expect([...stores.playlistWorkingCopies.values()].some(value => (value as PlaylistWorkingCopy).cloudAttempt)).toBe(true);
    const before = structuredClone(stores.playlistWorkingCopies);
    const extra = { ...structuredClone(value), playlist: { ...structuredClone(value.playlist), id: 'overflow' } };
    const extraSize = new TextEncoder().encode(JSON.stringify({ envelope: extra, localVersion: 1, cloudBaseRevision: null,
      pendingCloud: true, savedAt: Date.now() })).byteLength;
    expect(total).toBeLessThanOrEqual(limit);
    expect(total + extraSize).toBeGreaterThan(limit);
    await expect(savePlaylistWorkingCopy(extra, options)).rejects.toThrow('playlist_working_copy_limit');
    expect(stores.playlistWorkingCopies).toEqual(before);
  });

  it.each([undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid CAS/base values %s before storage opens', async revision => {
    const value = envelope();
    await expect(savePlaylistWorkingCopy(value, { ...options, expectedLocalVersion: revision as number })).rejects.toThrow('playlist_conflict');
    await expect(savePlaylistWorkingCopy(value, { ...options, cloudBaseRevision: revision as number })).rejects.toThrow('playlist_conflict');
    await expect(deletePlaylistWorkingCopy(value.playlist.id, revision as number)).rejects.toThrow('playlist_conflict');
    expect(storage.opens).toBe(0);
  });

  it('rejects unknown newer Cloud heads instead of rebasing pending work or recording a stale attempt', async () => {
    const value = envelope();
    const first = await savePlaylistWorkingCopy(value, { ...options, cloudBaseRevision: 1 });
    const remote = response(value, 2);
    remote.playlist.name = 'Different remote edit';
    await cacheMusicPlaylist(remote);
    await expect(savePlaylistWorkingCopy(response(value, 2), { ...options, expectedLocalVersion: 1, cloudBaseRevision: 2 }))
      .rejects.toThrow('playlist_conflict');
    await expect(recordPlaylistSyncAttempt(value.playlist.id, 1, first.envelope, 1)).rejects.toThrow('playlist_conflict');
    await expect(reconcilePlaylistWorkingCopy(remote)).rejects.toThrow('playlist_conflict');
    expect(await getPlaylistWorkingCopy(value.playlist.id)).toEqual(first);
  });

  it('requires matching immutable media even when playlist metadata matches a same-revision cache entry', async () => {
    const value = envelope();
    await cacheMusicPlaylist(value);
    const changed = structuredClone(value);
    changed.media.entry!.sha256 = 'b'.repeat(64);
    await expect(cacheMusicPlaylist(changed)).rejects.toThrow('playlist_conflict');
    expect(await getCachedMusicPlaylist(value.playlist.id, 1, false)).toEqual(value);
  });

  it('tombstones deletion, preserves media and routine selection, and fences late saves and acknowledgments', async () => {
    const saved = await savePlaylistWorkingCopy(envelope(), options);
    const id = saved.envelope.playlist.id;
    await recordPlaylistSyncAttempt(id, 1, saved.envelope, null);
    stores.tracks.set('entry', { blob: new Blob(['synthetic']), bytes: 9 });
    stores.meta.set('active', id);
    const routineMarker = JSON.stringify({ id, revision: 1, published: false });
    stores.meta.set('activeRoutineSelection', routineMarker);
    await expect(deletePlaylistWorkingCopy(id, 2)).rejects.toThrow('playlist_conflict');
    await deletePlaylistWorkingCopy(id, 1);
    expect(await getPlaylistWorkingCopy(id)).toBeNull();
    expect(await getActivePlaylistSelection()).toBeNull();
    expect(stores.tracks.has('entry')).toBe(true);
    expect(stores.meta.get('active')).toBe(id);
    expect(stores.meta.get('activeRoutineSelection')).toBe(routineMarker);
    await expect(savePlaylistWorkingCopy(saved.envelope, options)).rejects.toThrow('playlist_conflict');
    await expect(saveMusicPlaylist(saved.envelope.playlist, null)).rejects.toThrow('playlist_conflict');
    await expect(acknowledgePlaylistWorkingCopy(id, 1, saved.envelope)).rejects.toThrow('playlist_conflict');
    await expect(recordPlaylistSyncAttempt(id, 1, saved.envelope, null)).rejects.toThrow('playlist_conflict');
    expect(await reconcilePlaylistWorkingCopy(saved.envelope)).toBeNull();
  });

  it('serializes two confirmed deletes and hides cached latest heads while keeping exact revisions', async () => {
    const clean = await cleanCloud();
    const id = clean.envelope.playlist.id;
    const results = await Promise.allSettled([deletePlaylistWorkingCopy(id, 1), deletePlaylistWorkingCopy(id, 1)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: new Error('playlist_conflict') }]);
    expect(await getCachedMusicPlaylist(id)).toBeNull();
    expect(await listCachedMusicPlaylists()).toEqual([]);
    expect(await getCachedMusicPlaylist(id, 1, false)).toEqual(clean.envelope);
  });

  it('atomically deletes a matching local head and working copy while retaining adopted history', async () => {
    const saved = await savePlaylistWorkingCopy(envelope(), { ...options, cloud: false });
    const id = saved.envelope.playlist.id;
    await deletePlaylistWorkingCopy(id, 1);
    expect(await getMusicPlaylist(id)).toBeNull();
    expect(await listMusicPlaylists()).toEqual([]);
    expect(await getMusicPlaylist(id, 1)).toEqual(saved.envelope.playlist);
  });

  it('requires both CAS values to delete a Cloud-backed copy alongside a different legacy local head', async () => {
    const value = envelope();
    const local = await saveMusicPlaylist(value.playlist, null);
    const saved = await savePlaylistWorkingCopy(response(value, 8), { ...options, cloudBaseRevision: 8 });
    await expect(deletePlaylistWorkingCopy(local.id, 1)).rejects.toThrow('playlist_conflict');
    await expect(deleteMusicPlaylist(local.id, 1)).rejects.toThrow('playlist_conflict');
    await expect(deletePlaylistAndWorkingCopy(local.id, 2, 1)).rejects.toThrow('playlist_conflict');
    await deletePlaylistAndWorkingCopy(local.id, 1, saved.localVersion);
    expect(await getMusicPlaylist(local.id)).toBeNull();
    expect(await getPlaylistWorkingCopy(local.id)).toBeNull();
    expect(await getMusicPlaylist(local.id, 1)).toEqual(local);
  });

  it('retains both current and outstanding-attempt entry and asset IDs during media removal', async () => {
    const first = envelope();
    first.media.entry!.id = 'original-asset';
    const saved = await savePlaylistWorkingCopy(first, options);
    await recordPlaylistSyncAttempt(first.playlist.id, 1, first, null);
    const newer: CloudMusicPlaylist = { playlist: { ...first.playlist, tracks: [{ ...first.playlist.tracks[0]!, id: 'new-entry' }] },
      media: { 'new-entry': { ...first.media.entry!, id: 'new-asset', sha256: 'b'.repeat(64) } } };
    await savePlaylistWorkingCopy(newer, { ...options, expectedLocalVersion: saved.localVersion });
    for (const id of ['entry', 'original-asset', 'new-entry', 'new-asset']) {
      stores.tracks.set(id, { blob: new Blob(['synthetic']), bytes: 9 });
      await expect(removeTrack(id)).rejects.toThrow('track_referenced');
      expect(stores.tracks.has(id)).toBe(true);
    }
    stores.tracks.set('unused', { blob: new Blob(['synthetic']), bytes: 9 });
    await removeTrack('unused');
    expect(stores.tracks.has('unused')).toBe(false);
  });

  describe('account fencing', () => {
    let offline: typeof import('../frontend/src/offline');
    let markers: Map<string, string>;
    let events: EventTarget;
    beforeEach(async () => {
      vi.stubEnv('VITE_HOSTED_PILOT', 'true');
      markers = new Map([[hostedUserKey, 'owner-A']]);
      events = new EventTarget();
      Object.assign(events, { localStorage: { getItem: (key: string) => markers.get(key) ?? null } });
      vi.stubGlobal('window', events);
      vi.resetModules();
      offline = await import('../frontend/src/offline');
    });

    it.each(['account', 'reset', 'event'])('aborts a staged local projection on %s invalidation', async reason => {
      const value = envelope();
      storage.onRequest = (store, method) => {
        if (store !== 'playlistWorkingCopies' || method !== 'put') return;
        if (reason === 'account') markers.set(hostedUserKey, 'owner-B');
        else if (reason === 'reset') markers.set(hostedResetKey, 'reset');
        else events.dispatchEvent(new Event(hostedInvalidationEvent));
      };
      await expect(offline.savePlaylistWorkingCopy(value, { ...options, cloud: false })).rejects.toThrow('hosted_session_invalidated');
      expect(stores.playlistWorkingCopies.size).toBe(0);
      expect(stores.musicPlaylists.size).toBe(0);
      expect(stores.musicPlaylistHistory.size).toBe(0);
      expect(stores.meta.size).toBe(0);
    });

    it('fences an in-flight ack, later reads and selection writes after explicit logout', async () => {
      const first = await offline.savePlaylistWorkingCopy(envelope(), options);
      const id = first.envelope.playlist.id;
      await offline.recordPlaylistSyncAttempt(id, 1, first.envelope, null);
      const before = structuredClone(stores);
      storage.onRequest = (store, method) => {
        if (store === 'cloudMusicPlaylists' && method === 'put') events.dispatchEvent(new Event(hostedInvalidationEvent));
      };
      await expect(offline.acknowledgePlaylistWorkingCopy(id, 1, first.envelope)).rejects.toThrow('hosted_session_invalidated');
      storage.onRequest = undefined;
      expect(stores).toEqual(before);
      for (const operation of [() => offline.getPlaylistWorkingCopy(id), () => offline.listPlaylistWorkingCopies(),
        () => offline.getActivePlaylistSelection(), () => offline.clearActivePlaylistSelection(),
        () => offline.listCachedMusicPlaylists(), () => offline.listMusicPlaylistPublications(),
        () => offline.savePlaylistWorkingCopy(first.envelope, options),
        () => offline.setActivePlaylistSelection({ id, source: 'household', published: false }),
        () => offline.recordPlaylistSyncAttempt(id, 1, first.envelope, null),
        () => offline.reconcilePlaylistWorkingCopy(first.envelope),
        () => offline.deletePlaylistAndWorkingCopy(id, null, 1),
        () => offline.deletePlaylistWorkingCopy(id, 1)]) await expect(operation()).rejects.toThrow('hosted_session_invalidated');
    });

    it('rejects a late read after account ownership changes', async () => {
      const first = await offline.savePlaylistWorkingCopy(envelope(), options);
      storage.onRequest = (store, method) => {
        if (store === 'playlistWorkingCopies' && method === 'getAll') markers.set(hostedUserKey, 'owner-B');
      };
      await expect(offline.listPlaylistWorkingCopies()).rejects.toThrow('hosted_session_invalidated');
      expect(stores.playlistWorkingCopies.get(first.envelope.playlist.id)).toEqual(first);
    });

    it('keeps pending playlists on ordinary expiry and includes them in the whole-database purge boundary', async () => {
      const first = await offline.savePlaylistWorkingCopy(envelope(), options);
      const { cloudAccessAfterFailure } = await import('../shared/cloud-contract');
      expect(cloudAccessAfterFailure(401)).toBe('signin-required');
      expect(await offline.getPlaylistWorkingCopy(first.envelope.playlist.id)).toEqual(first);
      const { deleteHostedDatabase } = await import('../frontend/src/hosted-session');
      events.dispatchEvent(new Event(hostedInvalidationEvent));
      const deleteDatabase = vi.fn(() => {
        const request = { onsuccess: undefined as (() => void) | undefined };
        queueMicrotask(() => { for (const store of Object.values(stores)) store.clear(); request.onsuccess?.(); });
        return request as unknown as IDBOpenDBRequest;
      });
      await deleteHostedDatabase({ deleteDatabase });
      expect(deleteDatabase).toHaveBeenCalledWith('fitness-rehearsal');
      expect(stores.playlistWorkingCopies.size).toBe(0);
      expect(stores.meta.has('activePlaylistSelection')).toBe(false);
      markers.set(hostedUserKey, 'owner-B');
      vi.resetModules();
      const nextAccount = await import('../frontend/src/offline');
      expect(await nextAccount.listPlaylistWorkingCopies()).toEqual([]);
      expect(await nextAccount.getActivePlaylistSelection()).toBeNull();
    });
  });
});

describe('unified durable working copies', () => {
  const options = { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null };
  const envelope = () => ({ routine: newRoutine(), media: {} });

  it('commits a detached pending snapshot with an independent local counter and timestamp', async () => {
    const value = envelope();
    value.routine.revision = 12;
    const first = await saveRoutineWorkingCopy(value, { ...options, cloudBaseRevision: 12 });
    expect(first).toMatchObject({ localVersion: 1, cloudBaseRevision: 12, pendingCloud: true });
    expect(first.savedAt).toBeGreaterThan(0);
    expect(first.envelope.routine.savedAt).toBe(first.savedAt);
    expect(value.routine.savedAt).toBeUndefined();
    first.envelope.routine.name = 'Changed';
    const second = await saveRoutineWorkingCopy(first.envelope, { ...options, expectedLocalVersion: 1, cloudBaseRevision: 12 });
    expect(second.localVersion).toBe(2);
    expect(second.envelope.routine.revision).toBe(12);
    second.envelope.routine.name = 'Not committed';
    expect((await getRoutineWorkingCopy(value.routine.id))?.envelope.routine.name).toBe('Changed');
    expect(await getRoutine()).toEqual((await getRoutineWorkingCopy(value.routine.id))?.envelope.routine);
  });

  it('uses one transaction to reject a stale concurrent save without replacing the winner', async () => {
    const value = envelope();
    const results = await Promise.allSettled([saveRoutineWorkingCopy(value, options), saveRoutineWorkingCopy(value, options)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await getRoutineWorkingCopy(value.routine.id))?.localVersion).toBe(1);
    expect(await listRoutineWorkingCopies()).toHaveLength(1);
  });

  it('preserves pending work through local saves, close and a module reload', async () => {
    const saved = await saveRoutineWorkingCopy(envelope(), options);
    await saveRoutineWorkingCopy(saved.envelope, { ...options, expectedLocalVersion: 1, cloud: false });
    stores.meta.set('unrelated', 'retain');
    await clearActiveRoutine();
    expect(await getRoutine()).toBeNull();
    expect(stores.meta.get('unrelated')).toBe('retain');
    vi.resetModules();
    const reopened = await import('../frontend/src/offline');
    expect((await reopened.getRoutineWorkingCopy(saved.envelope.routine.id))?.pendingCloud).toBe(true);
    expect(await reopened.listRoutineWorkingCopies()).toHaveLength(1);
    await reopened.setActiveRoutine(saved.envelope.routine.id);
    expect(await reopened.getRoutine()).not.toBeNull();
  });

  it('acknowledges only the sent local generation and retains the full authoritative envelope', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const response = structuredClone(first.envelope);
    response.routine.revision = 1;
    response.routine.savedAt = 123;
    await acknowledgeRoutineWorkingCopy(response.routine.id, first.localVersion, response);
    const acknowledged = await getRoutineWorkingCopy(response.routine.id);
    expect(acknowledged).toEqual({ ...first, envelope: response, cloudBaseRevision: 1, pendingCloud: false });
    expect(await getCloudRoutine(response.routine.id)).toEqual(response.routine);
    expect([...stores.cloudRoutineEnvelopes.values()]).toEqual([response]);
  });

  it('retains newer content, descriptors and pending state after a delayed response', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), { ...options, cloudBaseRevision: 1 });
    await recordRoutineSyncAttempt(first.envelope.routine.id, first.localVersion, first.envelope, 1);
    const newer = structuredClone(first.envelope);
    newer.routine.name = 'Newer local edit';
    const saved = await saveRoutineWorkingCopy(newer, { ...options, expectedLocalVersion: 1, cloudBaseRevision: 1 });
    const response = structuredClone(first.envelope);
    response.routine.revision = 2;
    await acknowledgeRoutineWorkingCopy(response.routine.id, 1, response);
    const rebased = await getRoutineWorkingCopy(response.routine.id);
    expect(rebased).toEqual({ ...saved, cloudAttempt: undefined, cloudBaseRevision: 2,
      envelope: { ...newer, routine: { ...saved.envelope.routine, revision: 2 } } });
    expect(await getCloudRoutine(response.routine.id)).toEqual(response.routine);
    await recordRoutineSyncAttempt(response.routine.id, 2, rebased!.envelope, 2);
    await acknowledgeRoutineWorkingCopy(response.routine.id, 2, { ...rebased!.envelope,
      routine: { ...rebased!.envelope.routine, revision: 3 } });
    expect(await getRoutineWorkingCopy(response.routine.id)).toMatchObject({ localVersion: 2, cloudBaseRevision: 3,
      pendingCloud: false, envelope: { routine: { name: 'Newer local edit', revision: 3 } } });
  });

  it('allows an explicit local-version CAS rebase only after storing the authoritative response', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), { ...options, cloudBaseRevision: 1 });
    await recordRoutineSyncAttempt(first.envelope.routine.id, 1, first.envelope, 1);
    const response = structuredClone(first.envelope);
    response.routine.revision = 2;
    await expect(saveRoutineWorkingCopy(response, { ...options, expectedLocalVersion: 1, cloudBaseRevision: 2 }))
      .rejects.toThrow('routine_conflict');
    const newer = await saveRoutineWorkingCopy({ ...first.envelope, routine: { ...first.envelope.routine, name: 'New edit' } },
      { ...options, expectedLocalVersion: 1, cloudBaseRevision: 1 });
    await acknowledgeRoutineWorkingCopy(response.routine.id, 1, response);
    const rebased = await saveRoutineWorkingCopy({ ...newer.envelope, routine: { ...newer.envelope.routine, revision: 2 } },
      { expectedLocalVersion: 2, cloud: true, cloudBaseRevision: 2 });
    expect(rebased).toMatchObject({ localVersion: 3, cloudBaseRevision: 2, pendingCloud: true });
    expect(rebased.envelope.routine.name).toBe('New edit');
  });

  it('rejects undeclared envelope and nested runtime credentials', async () => {
    const value = envelope();
    await expect(saveRoutineWorkingCopy({ ...value, csrfToken: 'synthetic' } as typeof value, options)).rejects.toThrow('invalid_cloud_routine');
    Object.assign(value.routine, { credentials: 'synthetic' });
    await expect(saveRoutineWorkingCopy(value, options)).rejects.toThrow('invalid_cloud_routine');
    expect(stores.routineWorkingCopies.size).toBe(0);
  });

  it('atomically retains pending work if acknowledgment mirror storage fails', async () => {
    const saved = await saveRoutineWorkingCopy(envelope(), options);
    const response = structuredClone(saved.envelope);
    response.routine.revision = 1;
    storage.onRequest = (store, method) => {
      if (store === 'cloudRoutineHistory' && method === 'put') throw new Error('QuotaExceededError');
    };
    await expect(acknowledgeRoutineWorkingCopy(response.routine.id, 1, response)).rejects.toThrow('QuotaExceededError');
    storage.onRequest = undefined;
    expect(await getRoutineWorkingCopy(response.routine.id)).toEqual(saved);
    expect(stores.cloudRoutineEnvelopes.size).toBe(0);
    expect(stores.cloudRoutines.size).toBe(0);
  });

  it('aborts the whole save when a storage request fails, retaining the prior pending copy and active selection', async () => {
    const saved = await saveRoutineWorkingCopy(envelope(), options);
    storage.onRequest = (store, method) => { if (store === 'meta' && method === 'put') throw new Error('QuotaExceededError'); };
    await expect(saveRoutineWorkingCopy(saved.envelope, { ...options, expectedLocalVersion: 1 })).rejects.toThrow('QuotaExceededError');
    storage.onRequest = undefined;
    expect(await getRoutineWorkingCopy(saved.envelope.routine.id)).toEqual(saved);
    expect(stores.meta.get('active')).toBe(saved.envelope.routine.id);
  });

  it.each(['locked', 'published'] as const)('rejects %s snapshots without storing them', async field => {
    const value = envelope();
    value.routine[field] = true;
    await expect(saveRoutineWorkingCopy(value, options)).rejects.toThrow(`routine_${field}`);
    expect(stores.routineWorkingCopies.size).toBe(0);
  });

  it('does not bypass an existing local lock or downgrade a v2 head', async () => {
    const value = envelope();
    const locked = await saveRoutine(value.routine, null, 'lock');
    await expect(saveRoutineWorkingCopy(value, options)).rejects.toThrow('routine_locked');
    await saveRoutine(locked, locked.revision, 'unlock');
    value.routine.schemaVersion = 1;
    await expect(saveRoutineWorkingCopy(value, options)).rejects.toThrow('routine_conflict');
  });

  it('rejects missing phase media and keeps the complete v2 sequence in storage and recovery', async () => {
    const value = envelope();
    const track = { id: 'arrival', title: 'Arrival', duration: 2, firstBeat: 0, cues: [], bodyArea: '' };
    value.routine.sequence = { crossfade: 1, walkIn: { name: 'Walk in', tracks: [track] } };
    await expect(saveRoutineWorkingCopy(value, options)).rejects.toThrow('invalid_media');
    const asset = { id: 'asset', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' };
    const saved = await saveRoutineWorkingCopy({ ...value, media: { arrival: asset } }, options);
    expect(saved.envelope.routine.sequence).toEqual(value.routine.sequence);
    await expect(removeTrack('arrival')).rejects.toThrow('track_referenced');
    await saveDraftRecovery({ id: 'recovery', kind: 'routine', source: 'household', value: value.routine,
      media: { arrival: asset }, baseRevision: null, updatedAt: 1 });
    expect((await listDraftRecoveries())[0]!.value).toEqual(value.routine);
  });

  it('migrates v6 without changing any prior record', async () => {
    storage.version = 6;
    const routine = newRoutine();
    stores.routines.set(routine.id, routine);
    stores.draftRecovery.set('old', { id: 'old', value: routine });
    stores.tracks.set('audio', { bytes: 44 });
    const previous = [structuredClone(stores.routines), structuredClone(stores.draftRecovery), structuredClone(stores.tracks)];
    await saveRoutineWorkingCopy(envelope(), options);
    expect(storage.version).toBe(8);
    expect([stores.routines, stores.draftRecovery, stores.tracks]).toEqual(previous);
  });

  it('refuses excess records without evicting saved or pending work', async () => {
    for (let index = 0; index < 64; index++) await saveRoutineWorkingCopy(envelope(), options);
    await expect(saveRoutineWorkingCopy(envelope(), options)).rejects.toThrow('routine_working_copy_limit');
    expect(await listRoutineWorkingCopies()).toHaveLength(64);
  });
});

describe('unified working-copy review repairs', () => {
  const options = { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null };
  const envelope = (): CloudRoutine => {
    const asset = { id: 'song-asset', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' };
    const track = { id: 'song', title: 'Song', duration: 2, firstBeat: 0, cues: [], bodyArea: '' };
    const routine = newRoutine();
    routine.tracks = [track];
    routine.sequence = { crossfade: 1, walkIn: { name: 'Arrival', tracks: [{ ...track, id: 'arrival' }] } };
    routine.filler = { mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording: {
      id: 'recording', name: 'Loop', duration: 2, asset: { ...asset, id: 'filler-asset', sha256: 'b'.repeat(64) },
    } };
    return { routine, media: { song: asset, arrival: asset } };
  };

  it('retains the exact lost-ack submission through B save, caller mutations and reload', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    const submitted = structuredClone(first.envelope);
    submitted.routine.savedAt = 123;
    await recordRoutineSyncAttempt(id, 1, submitted, null);
    const expected = structuredClone(submitted);
    submitted.routine.name = 'Caller mutation';
    const newer = structuredClone(first.envelope);
    newer.routine.name = 'B';
    newer.media.song = { ...newer.media.song!, id: 'new-song', sha256: 'c'.repeat(64) };
    await saveRoutineWorkingCopy(newer, { ...options, expectedLocalVersion: 1, cloud: false });
    vi.resetModules();
    const reopened = await import('../frontend/src/offline');
    const pending = await reopened.getRoutineWorkingCopy(id);
    expect(pending?.cloudAttempt).toEqual({ envelope: expected, localVersion: 1, baseRevision: null });
    await reopened.acknowledgeRoutineWorkingCopy(id, 1, { ...expected, routine: { ...expected.routine, revision: 1, savedAt: 456 } });
    const rebased = await reopened.getRoutineWorkingCopy(id);
    expect(rebased).toMatchObject({ localVersion: 2, pendingCloud: true, cloudBaseRevision: 1,
      envelope: { media: newer.media, routine: { name: 'B', revision: 1 } } });
    expect(rebased?.cloudAttempt).toBeUndefined();
    expect(rebased?.savedAt).toBe(pending?.savedAt);
    expect(rebased?.envelope.routine.savedAt).toBe(pending?.envelope.routine.savedAt);
    await reopened.recordRoutineSyncAttempt(id, 2, rebased!.envelope, 1);
    await reopened.acknowledgeRoutineWorkingCopy(id, 2, { ...rebased!.envelope, routine: { ...rebased!.envelope.routine, revision: 2 } });
    expect(await reopened.getRoutineWorkingCopy(id)).toMatchObject({ pendingCloud: false, cloudBaseRevision: 2 });
  });

  it('requires attempt CAS, exact content and base, and cannot replace an outstanding A with B', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await expect(recordRoutineSyncAttempt(id, 2, first.envelope, null)).rejects.toThrow('routine_conflict');
    await expect(recordRoutineSyncAttempt(id, 1, first.envelope, 1)).rejects.toThrow('routine_conflict');
    await expect(recordRoutineSyncAttempt(id, 1, { ...first.envelope, routine: { ...first.envelope.routine, name: 'Forged' } }, null))
      .rejects.toThrow('routine_conflict');
    await recordRoutineSyncAttempt(id, 1, first.envelope, null);
    await recordRoutineSyncAttempt(id, 1, structuredClone(first.envelope), null);
    await expect(recordRoutineSyncAttempt(id, 1, { ...first.envelope, routine: { ...first.envelope.routine, savedAt: 1 } }, null))
      .rejects.toThrow('routine_conflict');
    const newer = await saveRoutineWorkingCopy(first.envelope, { ...options, expectedLocalVersion: 1 });
    await expect(recordRoutineSyncAttempt(id, 2, newer.envelope, null)).rejects.toThrow('routine_conflict');
    expect((await getRoutineWorkingCopy(id))?.cloudAttempt).toEqual({ envelope: first.envelope, localVersion: 1, baseRevision: null });
  });

  it.each(['name', 'media', 'phase', 'filler', 'revision', 'id', 'localVersion', 'extra-media'] as const)(
    'rejects a forged %s acknowledgment without caching or losing its attempt', async field => {
      const first = await saveRoutineWorkingCopy(envelope(), options);
      const id = first.envelope.routine.id;
      await recordRoutineSyncAttempt(id, 1, first.envelope, null);
      const before = await getRoutineWorkingCopy(id);
      const response = structuredClone(first.envelope);
      if (field === 'name') response.routine.name = 'Unrelated';
      if (field === 'media') response.media.song = { ...response.media.song!, id: 'other' };
      if (field === 'phase') response.routine.sequence!.walkIn!.name = 'Other phase';
      if (field === 'filler') response.routine.filler.recording!.asset.sha256 = 'c'.repeat(64);
      if (field === 'revision') response.routine.revision = 9;
      if (field === 'id') response.routine.id = 'other';
      if (field === 'extra-media') response.media.extra = response.media.song!;
      await expect(acknowledgeRoutineWorkingCopy(id, field === 'localVersion' ? 2 : 1, response)).rejects.toThrow();
      expect(await getRoutineWorkingCopy(id)).toEqual(before);
      expect(stores.cloudRoutineEnvelopes.size + stores.cloudRoutines.size + stores.cloudRoutineHistory.size).toBe(0);
    });

  it('compares canonical content without treating key order or server metadata as edits', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await recordRoutineSyncAttempt(id, 1, first.envelope, null);
    const response = structuredClone(first.envelope);
    response.routine = Object.fromEntries(Object.entries(response.routine).reverse()) as typeof response.routine;
    response.media = Object.fromEntries(Object.entries(response.media).reverse());
    response.routine.savedAt = 123;
    response.routine.locked = true;
    response.routine.published = true;
    await acknowledgeRoutineWorkingCopy(id, 1, response);
    expect(await getRoutineWorkingCopy(id)).toEqual({ ...first, envelope: response, cloudBaseRevision: 1, pendingCloud: false });
  });

  it('rejects conflicting song and filler descriptors for one immutable asset ID', async () => {
    const value = envelope();
    value.routine.filler.recording!.asset.id = value.media.song!.id;
    await expect(saveRoutineWorkingCopy(value, options)).rejects.toThrow('invalid_media');
    expect(stores.routineWorkingCopies.size).toBe(0);
  });

  it('does not infer an older submission without an attempt or accept mismatched legacy content', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await expect(acknowledgeRoutineWorkingCopy(id, 1, { ...first.envelope, routine: { ...first.envelope.routine, name: 'Other' } }))
      .rejects.toThrow('routine_conflict');
    const newer = await saveRoutineWorkingCopy(first.envelope, { ...options, expectedLocalVersion: 1 });
    await expect(acknowledgeRoutineWorkingCopy(id, 1, first.envelope)).rejects.toThrow('routine_conflict');
    expect(await getRoutineWorkingCopy(id)).toEqual(newer);
  });

  it('does not rebase B to an unrelated cached head or bypass the outstanding attempt', async () => {
    const first = await saveRoutineWorkingCopy({ routine: newRoutine(), media: {} }, { ...options, cloudBaseRevision: 1 });
    const id = first.envelope.routine.id;
    await recordRoutineSyncAttempt(id, 1, first.envelope, 1);
    await saveRoutineWorkingCopy({ ...first.envelope, routine: { ...first.envelope.routine, name: 'B' } },
      { ...options, expectedLocalVersion: 1, cloudBaseRevision: 1 });
    const pending = await getRoutineWorkingCopy(id);
    const other = { ...first.envelope, routine: { ...first.envelope.routine, name: 'Other writer', revision: 2 } };
    await cacheCloudRoutine(other.routine);
    await expect(acknowledgeRoutineWorkingCopy(id, 1, other)).rejects.toThrow('routine_conflict');
    await expect(acknowledgeRoutineWorkingCopy(id, 1, { ...first.envelope, routine: { ...first.envelope.routine, revision: 2 } }))
      .rejects.toThrow('routine_conflict');
    await expect(saveRoutineWorkingCopy({ ...pending!.envelope, routine: { ...pending!.envelope.routine, revision: 2 } },
      { ...options, expectedLocalVersion: 2, cloudBaseRevision: 2 })).rejects.toThrow('routine_conflict');
    expect(await getRoutineWorkingCopy(id)).toEqual(pending);
    expect(await getCloudRoutine(id)).toEqual(other.routine);
  });

  it('rolls back an attempt or acknowledgment completely on a failed working-copy write', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    storage.onRequest = (store, method) => { if (store === 'routineWorkingCopies' && method === 'put') throw new Error('QuotaExceededError'); };
    await expect(recordRoutineSyncAttempt(id, 1, first.envelope, null)).rejects.toThrow('QuotaExceededError');
    storage.onRequest = undefined;
    expect(await getRoutineWorkingCopy(id)).toEqual(first);
    await recordRoutineSyncAttempt(id, 1, first.envelope, null);
    const pending = await getRoutineWorkingCopy(id);
    storage.onRequest = (store, method) => { if (store === 'routineWorkingCopies' && method === 'put') throw new Error('QuotaExceededError'); };
    await expect(acknowledgeRoutineWorkingCopy(id, 1, first.envelope)).rejects.toThrow('QuotaExceededError');
    storage.onRequest = undefined;
    expect(await getRoutineWorkingCopy(id)).toEqual(pending);
    expect(stores.cloudRoutineEnvelopes.size + stores.cloudRoutines.size + stores.cloudRoutineHistory.size).toBe(0);
  });

  it('refreshes clean lock, unlock and publication metadata while retaining the local CAS handle', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await acknowledgeRoutineWorkingCopy(id, 1, first.envelope);
    await clearActiveRoutine();
    for (const metadata of [
      { revision: 2, locked: true, published: false, savedAt: 123 },
      { revision: 3, locked: false, published: false, savedAt: 456 },
      { revision: 4, locked: false, published: true, savedAt: 789 },
    ]) {
      const authoritative = { ...first.envelope, routine: { ...first.envelope.routine, ...metadata } };
      const refreshed = await reconcileRoutineWorkingCopy(authoritative);
      expect(refreshed).toEqual({ ...first, envelope: authoritative, cloudBaseRevision: metadata.revision,
        pendingCloud: false, savedAt: metadata.savedAt });
      expect(await getCloudRoutine(id)).toEqual(authoritative.routine);
      expect(stores.meta.get('active')).toBeUndefined();
      refreshed!.envelope.routine.name = 'Caller only';
      expect((await getRoutineWorkingCopy(id))?.envelope.routine.name).toBe(first.envelope.routine.name);
    }
  });

  it('reopening an identical acknowledged Cloud revision does not restamp the local save', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const acknowledged = { ...first.envelope, routine: { ...first.envelope.routine, savedAt: first.savedAt + 1000 } };
    await acknowledgeRoutineWorkingCopy(first.envelope.routine.id, first.localVersion, acknowledged);
    const before = await getRoutineWorkingCopy(first.envelope.routine.id);
    expect(before!.savedAt).not.toBe(acknowledged.routine.savedAt);
    expect(await reconcileRoutineWorkingCopy(acknowledged)).toEqual(before);
    expect(await getRoutineWorkingCopy(first.envelope.routine.id)).toEqual(before);
  });

  it('returns authoritative clean content, rejects stale heads and accepts the returned local handle', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await acknowledgeRoutineWorkingCopy(id, 1, first.envelope);
    const head = { ...first.envelope, routine: { ...first.envelope.routine, name: 'New authoritative content', revision: 2 } };
    const refreshed = await reconcileRoutineWorkingCopy(head);
    expect(refreshed).toMatchObject({ localVersion: 1, cloudBaseRevision: 2, pendingCloud: false, envelope: head });
    await expect(reconcileRoutineWorkingCopy(first.envelope)).rejects.toThrow('routine_conflict');
    await expect(saveRoutineWorkingCopy(first.envelope, { ...options, expectedLocalVersion: 1, cloudBaseRevision: 1 }))
      .rejects.toThrow('routine_conflict');
    const saved = await saveRoutineWorkingCopy(refreshed!.envelope,
      { ...options, expectedLocalVersion: refreshed!.localVersion, cloudBaseRevision: refreshed!.cloudBaseRevision });
    expect(saved).toMatchObject({ localVersion: 2, pendingCloud: true, cloudBaseRevision: 2 });
  });

  it('never reconciles over pending work, clears attempts implicitly or creates missing records', async () => {
    const value = envelope();
    expect(await reconcileRoutineWorkingCopy(value)).toBeNull();
    expect(stores.cloudRoutines.size).toBe(0);
    const first = await saveRoutineWorkingCopy(value, options);
    const id = value.routine.id;
    await recordRoutineSyncAttempt(id, 1, first.envelope, null);
    const before = await getRoutineWorkingCopy(id);
    await expect(reconcileRoutineWorkingCopy({ ...first.envelope, routine: { ...first.envelope.routine, revision: 2, locked: true } }))
      .rejects.toThrow('routine_conflict');
    expect(await getRoutineWorkingCopy(id)).toEqual(before);
  });

  it('deletes with CAS, frees capacity, retains media and unrelated active selection, and cannot resurrect on a late ack', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await recordRoutineSyncAttempt(id, 1, first.envelope, null);
    for (let index = 1; index < 64; index++) await saveRoutineWorkingCopy({ routine: newRoutine(), media: {} }, options);
    const selected = stores.meta.get('active');
    stores.tracks.set('retain', { blob: new Blob(['synthetic']) });
    const media = structuredClone(stores.tracks);
    await expect(deleteRoutineWorkingCopy(id, 2)).rejects.toThrow('routine_conflict');
    await expect(saveRoutineWorkingCopy(envelope(), options)).rejects.toThrow('routine_working_copy_limit');
    await deleteRoutineWorkingCopy(id, 1);
    expect(await getRoutineWorkingCopy(id)).toBeNull();
    expect(stores.meta.get('active')).toBe(selected);
    expect(stores.tracks).toEqual(media);
    await expect(acknowledgeRoutineWorkingCopy(id, 1, first.envelope)).rejects.toThrow('routine_conflict');
    expect(stores.cloudRoutines.size + stores.cloudRoutineEnvelopes.size).toBe(0);
    await saveRoutineWorkingCopy(envelope(), options);
    expect(await listRoutineWorkingCopies()).toHaveLength(64);
  });

  it('preserves a newer copy when local deletion loses CAS after simulated cloud success', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    const remoteDelete = deferred<void>();
    const completion = remoteDelete.promise.then(() => deleteRoutineWorkingCopy(id, 1));
    const newer = await saveRoutineWorkingCopy({ ...first.envelope, routine: { ...first.envelope.routine, name: 'B' } },
      { ...options, expectedLocalVersion: 1 });
    remoteDelete.resolve();
    await expect(completion).rejects.toThrow('routine_conflict');
    expect(await getRoutineWorkingCopy(id)).toEqual(newer);
    expect(stores.meta.get('active')).toBe(id);
    await deleteRoutineWorkingCopy(id, 2);
    expect(stores.meta.get('active')).toBeUndefined();
    await expect(deleteRoutineWorkingCopy(id, 2)).rejects.toThrow('routine_conflict');
  });

  it('rolls back working deletion when clearing its active pointer fails', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await recordRoutineSyncAttempt(id, 1, first.envelope, null);
    const before = await getRoutineWorkingCopy(id);
    storage.onRequest = (store, method) => { if (store === 'meta' && method === 'delete') throw new Error('QuotaExceededError'); };
    await expect(deleteRoutineWorkingCopy(id, 1)).rejects.toThrow('QuotaExceededError');
    storage.onRequest = undefined;
    expect(await getRoutineWorkingCopy(id)).toEqual(before);
    expect(stores.meta.get('active')).toBe(id);
  });

  it('rejects a tombstone race before recording or caching any acknowledgment', async () => {
    const first = await saveRoutineWorkingCopy(envelope(), options);
    const id = first.envelope.routine.id;
    await recordRoutineSyncAttempt(id, 1, first.envelope, null);
    const before = await getRoutineWorkingCopy(id);
    stores.meta.set(JSON.stringify(['deleted', 'routine', id]), '2');
    await expect(recordRoutineSyncAttempt(id, 1, first.envelope, null)).rejects.toThrow('routine_conflict');
    await expect(acknowledgeRoutineWorkingCopy(id, 1, first.envelope)).rejects.toThrow('routine_conflict');
    expect(await reconcileRoutineWorkingCopy(first.envelope)).toBeNull();
    expect(await getRoutineWorkingCopy(id)).toEqual(before);
    expect(stores.cloudRoutines.size + stores.cloudRoutineEnvelopes.size).toBe(0);
    await deleteRoutineWorkingCopy(id, 1);
    expect(await getRoutineWorkingCopy(id)).toBeNull();
  });

  it('removes a matching clean local working copy in the normal delete transaction', async () => {
    const saved = await saveRoutine(newRoutine(), null);
    await saveRoutineWorkingCopy({ routine: saved, media: {} }, { ...options, cloud: false });
    await deleteRoutine(saved.id, saved.revision);
    expect(await getRoutineWorkingCopy(saved.id)).toBeNull();
    expect(await getRoutine()).toBeNull();
    expect(await getRoutine(saved.id, saved.revision)).toEqual(saved);
  });

  it.each(['pending', 'different-content', 'cloud-backed', 'attempt'] as const)(
    'refuses normal local deletion of %s working state without hiding it', async state => {
      const saved = await saveRoutine(newRoutine(), null);
      const working = await saveRoutineWorkingCopy({ routine: { ...saved, name: state === 'different-content' ? 'B' : saved.name }, media: {} },
        { ...options, cloud: state === 'pending' || state === 'attempt', cloudBaseRevision: state === 'cloud-backed' ? 1 : null });
      if (state === 'attempt') await recordRoutineSyncAttempt(saved.id, 1, working.envelope, null);
      const before = await getRoutineWorkingCopy(saved.id);
      await expect(deleteRoutine(saved.id, saved.revision)).rejects.toThrow('routine_conflict');
      expect(await getRoutineWorkingCopy(saved.id)).toEqual(before);
      expect(await getRoutine(saved.id)).toEqual(saved);
      expect(stores.meta.get('active')).toBe(saved.id);
    });

  it('lists persisted cloud heads and only the latest local publication per ID across reload', async () => {
    const demo = await createDemoRoutine();
    const saved = await saveRoutine(demo, null);
    await publishRoutine(saved.id, 1);
    const edited = await saveRoutine({ ...(await getRoutine(saved.id))!, name: 'Second publication' }, 2);
    const published = await publishRoutine(saved.id, edited.revision);
    const draft = await saveRoutine({ ...(await getRoutine(saved.id))!, name: 'Unpublished edit' }, published.revision);
    await cacheCloudRoutine(published);
    await cacheCloudRoutine(draft);
    const other = { ...newRoutine(), published: true };
    await cacheCloudRoutine(other);
    vi.resetModules();
    const reopened = await import('../frontend/src/offline');
    const publications = await reopened.listRoutinePublications();
    expect(publications).toEqual([published]);
    const heads = await reopened.listCloudRoutines();
    expect(heads).toHaveLength(3);
    expect(heads).toEqual(expect.arrayContaining([draft, published, other]));
    publications[0]!.name = 'Caller change';
    heads[0]!.name = 'Caller change';
    expect(await reopened.listRoutinePublications()).toEqual([published]);
    expect(await reopened.getCloudRoutine(draft.id)).toEqual(draft);
    await reopened.deleteRoutine(saved.id, draft.revision);
    expect(await reopened.listRoutinePublications()).toEqual([]);
    expect(await reopened.getRoutine(saved.id, published.revision, true)).toEqual(published);
    expect(await reopened.listCloudRoutines()).toHaveLength(3);
  });

  it.each(['cloudRoutines', 'cloudRoutineHistory', 'routineHistory'] as const)('rejects invalid persisted %s chooser data', async store => {
    stores[store].set('bad', { ...newRoutine(), name: null, published: true });
    await expect(store === 'routineHistory' ? listRoutinePublications() : listCloudRoutines()).rejects.toThrow('invalid_routine');
  });
});

describe('cached cloud routine chooser', () => {
  it.each(['publication-first', 'draft-first'])('lists both saved versions after caching %s', async order => {
    const publication = { ...newRoutine(), name: 'Published', revision: 2, published: true, savedAt: 2000 };
    const draft = { ...publication, name: 'Draft', revision: 3, published: false, savedAt: 3000 };
    for (const routine of order === 'publication-first' ? [publication, draft] : [draft, publication]) {
      await cacheCloudRoutine(routine);
    }
    const values = await listCloudRoutines();
    expect(values).toHaveLength(2);
    expect(values).toEqual(expect.arrayContaining([publication, draft]));
    for (const value of values) value.name = 'Caller change';
    expect(await listCloudRoutines()).toEqual(expect.arrayContaining([publication, draft]));
    expect(await getCloudRoutine(draft.id)).toEqual(draft);
    expect(await getCloudRoutine(publication.id, 2, true)).toEqual(publication);
    expect(await getCloudRoutine(draft.id, 3, false)).toEqual(draft);
    expect(await getCloudRoutine(draft.id, 3, true)).toBeNull();
    expect(await getCloudRoutine(publication.id, 2, false)).toBeNull();
  });

  it('chooses only the latest revision of each status per ID despite an older current draft', async () => {
    const routine = newRoutine();
    const olderPublication = { ...routine, revision: 2, published: true, savedAt: 2000 };
    const olderDraft = { ...routine, revision: 3, savedAt: 3000 };
    const publication = { ...routine, revision: 4, published: true, savedAt: 4000 };
    const draft = { ...publication, published: false };
    const other = { ...newRoutine(), published: true, savedAt: 5000 };
    for (const value of [olderPublication, olderDraft, draft, publication, other]) await cacheCloudRoutine(value);
    stores.cloudRoutines.set(routine.id, olderDraft);
    const values = await listCloudRoutines();
    expect(values).toHaveLength(3);
    expect(values).toEqual(expect.arrayContaining([draft, publication, other]));
    expect(await getCloudRoutine(routine.id, 2, true)).toEqual(olderPublication);
    expect(await getCloudRoutine(routine.id, 3, false)).toEqual(olderDraft);
    expect(await getCloudRoutine(routine.id, 4, true)).toEqual(publication);
    expect(await getCloudRoutine(routine.id, 4, false)).toEqual(draft);
    expect(await getCloudRoutine(routine.id)).toEqual(olderDraft);
  });

  it('includes current-only legacy cache entries without treating local or working copies as Cloud publications', async () => {
    const current = { ...newRoutine(), revision: 2, published: true, savedAt: 2000 };
    stores.cloudRoutines.set(current.id, current);
    const working = await saveRoutineWorkingCopy({ routine: newRoutine(), media: {} },
      { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null });
    const local = { ...newRoutine(), published: true };
    stores.routines.set(local.id, local);
    stores.routineHistory.set(JSON.stringify([local.id, local.revision, true]), local);
    const oldCopy = { ...working, envelope: { ...working.envelope,
      routine: { ...working.envelope.routine, published: true } } };
    stores.routineWorkingCopies.set('old-copy', oldCopy);
    const before = structuredClone(stores);
    expect(await listCloudRoutines()).toEqual([current]);
    expect(await listRoutinePublications()).toEqual([local]);
    expect(await getRoutineWorkingCopy(working.envelope.routine.id)).toEqual(working);
    expect(stores).toEqual(before);
  });
});

describe('final review exact local selection', () => {
  async function publication() {
    const saved = await saveRoutine(await createDemoRoutine(), null);
    const published = await publishRoutine(saved.id, saved.revision);
    const draft = await saveRoutine({ ...(await getRoutine(saved.id))!, name: 'Newer draft' }, published.revision);
    return { published, draft, selection: { id: published.id, revision: published.revision, published: true } };
  }

  it('persists Close/Open Published/Reload without selecting the newer draft or working copy', async () => {
    const { published, draft, selection } = await publication();
    stores.routineWorkingCopies.set(draft.id, { envelope: { routine: draft, media: {} }, localVersion: 7 });
    await clearActiveRoutine();
    expect(await getRoutine()).toBeNull();
    await setActiveRoutineSelection(selection);
    vi.resetModules();
    const reopened = await import('../frontend/src/offline');
    expect(await reopened.getActiveRoutineSelection()).toEqual(selection);
    expect(await reopened.getRoutine()).toEqual(published);
    expect(await reopened.getRoutine(draft.id)).toEqual(draft);
    await reopened.clearActiveRoutine();
    expect(await reopened.getActiveRoutineSelection()).toBeNull();
    expect(await reopened.getRoutine()).toBeNull();
    expect(stores.meta.has('activeRoutineSelection')).toBe(false);
    expect(await reopened.getRoutine(draft.id, published.revision, true)).toEqual(published);
  });

  it.each(['missing', 'wrong-id', 'wrong-revision', 'wrong-publication'] as const)(
    'does not fall back from a %s selected snapshot to draft or working content', async state => {
      const { published, draft, selection } = await publication();
      await setActiveRoutineSelection(selection);
      stores.routineWorkingCopies.set(draft.id, { envelope: { routine: draft, media: {} }, localVersion: 1 });
      stores.routineHistory.delete(JSON.stringify([published.id, published.revision]));
      const key = JSON.stringify([published.id, published.revision, true]);
      if (state === 'missing') stores.routineHistory.delete(key);
      else stores.routineHistory.set(key, { ...published,
        ...(state === 'wrong-id' ? { id: 'other' } : state === 'wrong-revision' ? { revision: 99 } : { published: false }) });
      expect(await getRoutine()).toBeNull();
      await expect(setActiveRoutineSelection(selection)).rejects.toThrow('routine_not_found');
      expect(await getActiveRoutineSelection()).toEqual(selection);
    });

  it.each(['select', 'save', 'working-save'] as const)('clears the old publication on draft %s', async action => {
    const { draft, selection } = await publication();
    await setActiveRoutineSelection(selection);
    if (action === 'select') await setActiveRoutine(draft.id);
    else if (action === 'save') await saveRoutine(draft, draft.revision);
    else await saveRoutineWorkingCopy({ routine: { ...draft, tracks: [] }, media: {} },
      { expectedLocalVersion: null, cloud: false, cloudBaseRevision: null });
    expect(await getActiveRoutineSelection()).toBeNull();
    expect(await getRoutine()).toMatchObject({ id: draft.id, published: false });
  });

  it('selects an exact saved draft without following later working edits and snapshots caller input', async () => {
    const saved = await saveRoutine(newRoutine(), null);
    const selection = { id: saved.id, revision: saved.revision, published: false };
    const pending = setActiveRoutineSelection(selection);
    selection.id = 'caller-change';
    selection.revision = 99;
    await pending;
    stores.routineWorkingCopies.set(saved.id, { envelope: { routine: { ...saved, name: 'Working edit' }, media: {} } });
    const selected = await getActiveRoutineSelection();
    expect(selected).toEqual({ id: saved.id, revision: saved.revision, published: false });
    selected!.revision = 100;
    expect(await getRoutine()).toEqual(saved);
    expect((await getActiveRoutineSelection())?.revision).toBe(saved.revision);
  });

  it('requires local publication history instead of a cloud publication or unrecorded published head', async () => {
    const { published, draft, selection } = await publication();
    await cacheCloudRoutine(published);
    stores.routineHistory.clear();
    stores.routines.set(published.id, published);
    const before = structuredClone(stores);
    await expect(setActiveRoutineSelection(selection)).rejects.toThrow('routine_not_found');
    expect(stores).toEqual(before);
    expect(await getActiveRoutineSelection()).toBeNull();
    expect(stores.meta.get('active')).toBe(draft.id);
  });

  it('rolls back the active ID when writing the exact pointer fails', async () => {
    const { selection } = await publication();
    await saveRoutine(newRoutine(), null);
    const before = structuredClone(stores);
    let writes = 0;
    storage.onRequest = (store, method) => {
      if (store === 'meta' && method === 'put' && ++writes === 2) throw new Error('QuotaExceededError');
    };
    await expect(setActiveRoutineSelection(selection)).rejects.toThrow('QuotaExceededError');
    expect(stores).toEqual(before);
  });
});

describe('final review combined local deletion', () => {
  const options = { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null };
  async function pendingCopy() {
    const saved = await saveRoutine(newRoutine(), null);
    const first = await saveRoutineWorkingCopy({ routine: { ...saved, name: 'Pending first save' }, media: {} }, options);
    await recordRoutineSyncAttempt(saved.id, 1, first.envelope, null);
    const newer = await saveRoutineWorkingCopy({ ...first.envelope, routine: { ...first.envelope.routine, name: 'New local edits' } },
      { ...options, expectedLocalVersion: 1 });
    return { saved, first, newer };
  }

  it('atomically removes pending changed work and its attempt, retains legacy history and all audio, and frees capacity', async () => {
    const { saved, first } = await pendingCopy();
    const audio = await createDemoRoutine();
    const filler = await fillerFixture();
    stores.fillerRecordings.set(filler.id, filler);
    stores.tracks.set(`filler-${filler.asset.id}`, { blob: generateDemoWav(2, 100, 'soft') });
    for (let index = 1; index < 64; index++) await saveRoutineWorkingCopy({ routine: newRoutine(), media: {} }, options);
    await expect(saveRoutineWorkingCopy({ routine: newRoutine(), media: {} }, options)).rejects.toThrow('routine_working_copy_limit');
    await setActiveRoutine(saved.id);
    const tracks = structuredClone(stores.tracks);
    const recordings = structuredClone(stores.fillerRecordings);
    const deleted = vi.fn();
    storage.onRequest = (store, method) => { if (store === 'routineWorkingCopies' && method === 'delete') deleted(); };
    const transactions = storage.transactions;
    await deleteRoutineAndWorkingCopy(saved.id, saved.revision, 2);
    expect(storage.transactions - transactions).toBe(1);
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(await getRoutineWorkingCopy(saved.id)).toBeNull();
    expect(await getRoutine()).toBeNull();
    expect(await getRoutine(saved.id)).toBeNull();
    expect(await getRoutine(saved.id, saved.revision, false)).toEqual(saved);
    expect(stores.routines.get(saved.id)).toEqual(saved);
    expect(stores.tracks).toEqual(tracks);
    expect(stores.fillerRecordings).toEqual(recordings);
    expect((await getReadiness(audio)).ready).toBe(true);
    await expect(acknowledgeRoutineWorkingCopy(saved.id, 1, first.envelope)).rejects.toThrow('routine_conflict');
    await expect(saveRoutineWorkingCopy(first.envelope, options)).rejects.toThrow('routine_conflict');
    await saveRoutineWorkingCopy({ routine: newRoutine(), media: {} }, options);
    expect(await listRoutineWorkingCopies()).toHaveLength(64);
    await expect(deleteRoutineAndWorkingCopy(saved.id, saved.revision, 2)).rejects.toThrow('routine_conflict');
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('accepts null only for an absent legacy head and preserves another exact active selection', async () => {
    const working = await saveRoutineWorkingCopy({ routine: newRoutine(), media: {} }, options);
    const other = await saveRoutine(await createDemoRoutine(), null);
    const published = await publishRoutine(other.id, other.revision);
    const selection = { id: other.id, revision: published.revision, published: true };
    await setActiveRoutineSelection(selection);
    await deleteRoutineAndWorkingCopy(working.envelope.routine.id, null, 1);
    expect(await getRoutineWorkingCopy(working.envelope.routine.id)).toBeNull();
    expect(await getActiveRoutineSelection()).toEqual(selection);
    expect(await getRoutine()).toEqual(published);
    await expect(saveRoutineWorkingCopy(working.envelope, options)).rejects.toThrow('routine_conflict');
  });

  it.each([[null, 2], [2, 2], [1, 1], [1, 3]] as const)(
    'rejects stale head/local CAS %s/%s without hiding or removing either record', async (head, local) => {
      const { saved } = await pendingCopy();
      const before = structuredClone(stores);
      await expect(deleteRoutineAndWorkingCopy(saved.id, head, local)).rejects.toThrow('routine_conflict');
      expect(stores).toEqual(before);
    });

  it.each(['head-lock', 'working-lock', 'head-publication', 'working-publication', 'cloud-backed', 'missing-copy', 'tombstone'] as const)(
    'rejects %s before deleting any confirmed local work', async state => {
      const { saved, newer } = await pendingCopy();
      if (state === 'head-lock') stores.routines.set(saved.id, { ...saved, locked: true });
      if (state === 'head-publication') stores.routines.set(saved.id, { ...saved, published: true });
      if (state === 'working-lock' || state === 'working-publication') stores.routineWorkingCopies.set(saved.id,
        { ...newer, envelope: { ...newer.envelope, routine: { ...newer.envelope.routine,
          locked: state === 'working-lock', published: state === 'working-publication' } } });
      if (state === 'cloud-backed') stores.routineWorkingCopies.set(saved.id, { ...newer, cloudBaseRevision: 1 });
      if (state === 'missing-copy') stores.routineWorkingCopies.delete(saved.id);
      if (state === 'tombstone') stores.meta.set(JSON.stringify(['deleted', 'routine', saved.id]), '2');
      const before = structuredClone(stores);
      await expect(deleteRoutineAndWorkingCopy(saved.id, saved.revision, 2)).rejects.toThrow(
        state.endsWith('-lock') ? 'routine_locked' : state.endsWith('-publication') ? 'routine_published' : 'routine_conflict');
      expect(stores).toEqual(before);
    });

  it.each(['routineWorkingCopies:delete', 'routineHistory:put', 'meta:put', 'meta:delete'])(
    'rolls back head history, tombstone, attempt and selection when %s fails', async target => {
      const { saved } = await pendingCopy();
      stores.routineHistory.clear();
      const before = structuredClone(stores);
      storage.onRequest = (store, method) => { if (`${store}:${method}` === target) throw new Error('QuotaExceededError'); };
      await expect(deleteRoutineAndWorkingCopy(saved.id, saved.revision, 2)).rejects.toThrow('QuotaExceededError');
      expect(stores).toEqual(before);
      expect(storage.aborts).toBe(1);
    });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, '1'])(
    'rejects invalid head and local CAS handles %s before opening storage', async value => {
      await expect(deleteRoutineAndWorkingCopy('missing', value as number, 1)).rejects.toThrow('routine_conflict');
      await expect(deleteRoutineAndWorkingCopy('missing', null, value as number)).rejects.toThrow('routine_conflict');
      expect(storage.opens).toBe(0);
    });

  it('lets only one concurrent confirmed delete remove the working copy', async () => {
    const { saved } = await pendingCopy();
    const deleted = vi.fn();
    storage.onRequest = (store, method) => { if (store === 'routineWorkingCopies' && method === 'delete') deleted(); };
    const outcomes = await Promise.allSettled([
      deleteRoutineAndWorkingCopy(saved.id, saved.revision, 2), deleteRoutineAndWorkingCopy(saved.id, saved.revision, 2),
    ]);
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(await getRoutineWorkingCopy(saved.id)).toBeNull();
  });

  it.each(['legacy', 'combined', 'cloud-copy'] as const)('clears a matching publication pointer in the %s delete path', async action => {
    const saved = await saveRoutine(await createDemoRoutine(), null);
    const published = await publishRoutine(saved.id, saved.revision);
    const draft = (await getRoutine(saved.id))!;
    stores.routineWorkingCopies.set(saved.id, { envelope: { routine: draft, media: {} }, localVersion: 1,
      cloudBaseRevision: null, pendingCloud: false, savedAt: draft.savedAt });
    await setActiveRoutineSelection({ id: saved.id, revision: published.revision, published: true });
    if (action === 'legacy') await deleteRoutine(saved.id, draft.revision);
    else if (action === 'combined') await deleteRoutineAndWorkingCopy(saved.id, draft.revision, 1);
    else await deleteRoutineWorkingCopy(saved.id, 1);
    expect(await getActiveRoutineSelection()).toBeNull();
    expect(await getRoutine()).toBeNull();
    expect(stores.meta.has('activeRoutineSelection')).toBe(false);
    expect(await getRoutine(saved.id, published.revision, true)).toEqual(published);
  });
});

describe('final review cached class enumeration', () => {
  it('returns detached latest draft and publication heads without network, local entries or cache mutation across reload', async () => {
    const setup: ClassSetup = { schemaVersion: 1, id: 'cached-class', name: 'Cached class', revision: 1,
      locked: false, published: false, routine: { id: 'routine', revision: 1, published: true }, crossfade: 1 };
    await cacheClassSetup(setup);
    await cacheClassSetup({ ...setup, revision: 2, published: true });
    const published = { ...setup, revision: 3, published: true };
    const draft = { ...setup, revision: 4 };
    await cacheClassSetup(published);
    await cacheClassSetup(draft);
    const onlyPublished = { ...setup, id: 'published-only', published: true };
    await cacheClassSetup(onlyPublished);
    stores.classSetups.set('local-only', { ...setup, id: 'local-only' });
    const before = structuredClone(stores);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.resetModules();
    const reopened = await import('../frontend/src/offline');
    const heads = await reopened.listCachedClassSetups();
    expect(heads).toHaveLength(3);
    expect(heads).toEqual(expect.arrayContaining([draft, published, onlyPublished]));
    heads[0].name = 'Caller edit';
    heads[0].routine.revision = 99;
    expect(await reopened.listCachedClassSetups()).toEqual(expect.arrayContaining([draft, published, onlyPublished]));
    expect(stores).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed on invalid cached class records', async () => {
    stores.cloudClassSetups.set('bad', { id: 'invalid' });
    await expect(listCachedClassSetups()).rejects.toThrow('invalid_class_setup');
  });
});

describe('unified save timestamps and unknown BPM', () => {
  it('stamps local commits without making savedAt editable lock content', async () => {
    const routine = newRoutine();
    const saved = await saveRoutine(routine, null);
    expect(saved.savedAt).toBeGreaterThan(0);
    expect(routine.savedAt).toBeUndefined();
    const locked = await saveRoutine(saved, saved.revision, 'lock');
    const unlocked = await saveRoutine({ ...locked, savedAt: 1 }, locked.revision, 'unlock');
    expect(unlocked.locked).toBe(false);
    expect(unlocked.savedAt).toBeGreaterThan(1);
  });

  it('keeps imported BPM unknown while allowing timestamp and interval cues', async () => {
    browserAudio(2);
    const track = await storeTrack(new File(['synthetic audio'], 'synthetic.wav', { type: 'audio/wav' }));
    expect(track.bpm).toBeUndefined();
    const routine = newRoutine();
    routine.tracks = [{ ...track, cues: [
      { id: 'time', anchor: { kind: 'timestamp', seconds: 0 }, note: 'Start' },
      { id: 'interval', anchor: { kind: 'interval', seconds: 1 }, note: 'Move' },
    ] }];
    expect(validateRoutine(routine)).toEqual([]);
    routine.tracks[0]!.cues.push({ id: 'count', anchor: { kind: 'count', count: 1 }, note: 'Count' });
    expect(validateRoutine(routine)).not.toEqual([]);
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
    expect(storage.version).toBe(8);
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
    const saved = await saveRoutine(routine, null);
    vi.resetModules();
    const reloaded = await import('../frontend/src/offline');
    expect(await reloaded.getRoutine()).toEqual(saved);
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
    expect(storage.version).toBe(8);
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
    expect(storage.version).toBe(8);
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
    expect(storage.version).toBe(8);
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
    expect(storage.version).toBe(8);
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
    'deleteRoutine', 'deleteMusicPlaylist', 'deleteClassSetup', 'saveDraftRecovery', 'removeDraftRecovery',
    'saveRoutineWorkingCopy', 'acknowledgeRoutineWorkingCopy', 'clearActiveRoutine', 'recordRoutineSyncAttempt',
    'reconcileRoutineWorkingCopy', 'deleteRoutineWorkingCopy', 'deleteRoutineAndWorkingCopy', 'setActiveRoutineSelection'] as const;
  const guardedOperations = [...mutations, 'publishRoutine', 'listDraftRecoveries', 'getRoutineWorkingCopy', 'listRoutineWorkingCopies',
    'listCloudRoutines', 'listRoutinePublications', 'listCachedClassSetups', 'getActiveRoutineSelection'] as const;
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
    if (name === 'saveRoutineWorkingCopy') return offline.saveRoutineWorkingCopy({ routine: newRoutine(), media: {} },
      { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null });
    if (name === 'acknowledgeRoutineWorkingCopy') return offline.acknowledgeRoutineWorkingCopy('working', 1,
      { routine: { ...newRoutine(), id: 'working' }, media: {} });
    if (name === 'clearActiveRoutine') return offline.clearActiveRoutine();
    if (name === 'getRoutineWorkingCopy') return offline.getRoutineWorkingCopy('working');
    if (name === 'listRoutineWorkingCopies') return offline.listRoutineWorkingCopies();
    if (name === 'recordRoutineSyncAttempt') return offline.recordRoutineSyncAttempt('working', 1,
      { routine: { ...newRoutine(), id: 'working' }, media: {} }, null);
    if (name === 'reconcileRoutineWorkingCopy') return offline.reconcileRoutineWorkingCopy({ routine: newRoutine(), media: {} });
    if (name === 'deleteRoutineWorkingCopy') return offline.deleteRoutineWorkingCopy('working', 1);
    if (name === 'deleteRoutineAndWorkingCopy') return offline.deleteRoutineAndWorkingCopy('working', null, 1);
    if (name === 'setActiveRoutineSelection') return offline.setActiveRoutineSelection({ id: 'routine-guard', revision: 1, published: true });
    if (name === 'getActiveRoutineSelection') return offline.getActiveRoutineSelection();
    if (name === 'listCachedClassSetups') return offline.listCachedClassSetups();
    if (name === 'listCloudRoutines') return offline.listCloudRoutines();
    if (name === 'listRoutinePublications') return offline.listRoutinePublications();
    if (name === 'saveDraftRecovery') return offline.saveDraftRecovery({ id: 'guarded-recovery', kind: 'routine', source: 'household',
      value: newRoutine(), media: {}, baseRevision: null, updatedAt: 1 });
    if (name === 'removeDraftRecovery') return offline.removeDraftRecovery('guarded-recovery');
    if (name === 'listDraftRecoveries') return offline.listDraftRecoveries();
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

  it.each(['account', 'reset'])('rejects listCloudRoutines when %s changes during its history read', async reason => {
    const publication = { ...newRoutine(), revision: 2, published: true };
    await offline.cacheCloudRoutine(publication);
    await offline.cacheCloudRoutine({ ...publication, revision: 3, published: false });
    storage.onRequest = (store, method) => {
      if (store !== 'cloudRoutineHistory' || method !== 'getAll') return;
      if (reason === 'account') markers.set(hostedUserKey, 'owner-B');
      else markers.set(hostedResetKey, 'reset-generation');
    };
    await expect(offline.listCloudRoutines()).rejects.toThrow('hosted_session_invalidated');
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

  it.each(['cache-list', 'selection-read', 'selected-routine-read'] as const)(
    'rejects final review %s after account switch during a readonly transaction', async operation => {
      const routine = await offline.saveRoutine(await offline.createDemoRoutine(), null);
      const published = await offline.publishRoutine(routine.id, routine.revision);
      await offline.setActiveRoutineSelection({ id: routine.id, revision: published.revision, published: true });
      await offline.cacheClassSetup({ schemaVersion: 1, id: 'private-class', name: 'Account A class', revision: 1,
        locked: false, published: true, routine: { id: routine.id, revision: published.revision, published: true }, crossfade: 0 });
      const before = structuredClone(stores);
      const began = deferred<void>();
      const resume = deferred<void>();
      storage.onRequest = async (store, method) => {
        if (operation === 'cache-list' ? store === 'cloudClassSetups' && method === 'getAll' : store === 'meta' && method === 'get') {
          began.resolve(); await resume.promise;
        }
      };
      const outcomes = Promise.allSettled([operation === 'cache-list' ? offline.listCachedClassSetups() :
        operation === 'selection-read' ? offline.getActiveRoutineSelection() : offline.getRoutine()]);
      await began.promise;
      markers.set(hostedUserKey, 'owner-B');
      resume.resolve();
      expect((await outcomes)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
      expect(stores).toEqual(before);
    });

  it.each(['combined-delete', 'exact-selection', 'close-selection'] as const)(
    'rolls back final review %s after staged writes and preserves next-account records', async operation => {
      const saved = await offline.saveRoutine(newRoutine(), null);
      await offline.saveRoutineWorkingCopy({ routine: saved, media: {} },
        { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null });
      const before = structuredClone(stores);
      const began = deferred<void>();
      const resume = deferred<void>();
      storage.onRequest = async (store, method) => {
        if (operation === 'combined-delete' ? store === 'routineWorkingCopies' && method === 'delete' :
          store === 'meta' && method === (operation === 'exact-selection' ? 'put' : 'delete')) {
          began.resolve(); await resume.promise;
        }
      };
      const outcomes = Promise.allSettled([operation === 'combined-delete' ? offline.deleteRoutineAndWorkingCopy(saved.id, saved.revision, 1) :
        operation === 'exact-selection' ? offline.setActiveRoutineSelection({ id: saved.id, revision: 1, published: false }) : offline.clearActiveRoutine()]);
      await began.promise;
      notify(hostedUserKey, 'owner-A', 'owner-B');
      markers.set(hostedUserKey, 'owner-B');
      const nextAccount = { ...newRoutine(), id: 'next-account' };
      stores.routines.set(nextAccount.id, nextAccount);
      before.routines.set(nextAccount.id, nextAccount);
      resume.resolve();
      expect((await outcomes)[0]).toMatchObject({ status: 'rejected', reason: new Error('hosted_session_invalidated') });
      expect(storage.aborts).toBe(1);
      expect(stores).toEqual(before);
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