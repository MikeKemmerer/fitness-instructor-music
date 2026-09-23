import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_CHUNK_BYTES, CLOUD_TIMEOUT_MS, CloudRequestError, createCloudClient } from '../frontend/src/cloud-client';
import { canonicalAudioType, cloudHash, createCloudLibrary, MAX_CLOUD_MEDIA_BYTES, parseCloudRoutine } from '../frontend/src/cloud-library';
import { canEditCloudDraft, cloudErrorMessage, confirmCloudNavigation, recalledCloudSelection, rememberCloudSelection,
  classSelectionStorageKey, recalledClassSelection, rememberClassSelection } from '../frontend/src/cloud-ui';
import { hostedCloudSelectionKey, hostedIdentityMarker, hostedUserKey } from '../frontend/src/hosted-session';
import { t } from '../frontend/src/i18n';
import { newRoutine, reorderTrack, type FillerRecording, type Routine } from '../shared/routine';
import type { CloudAsset, CloudRoutine, CloudSession, FillerAnalysis, LibraryMetadata } from '../shared/cloud-contract';
import type { PlayerState } from '../shared/player-contract';
import { createClassLibrary, parseCloudPlaylist } from '../frontend/src/class-library';
import type { ClassSetup, CloudMusicPlaylist } from '../shared/class-plan';
import type { RoutineWorkingCopy } from '../frontend/src/offline';
import { sameSavedContent } from '../frontend/src/routine-save';

const appMocks = vi.hoisted(() => ({
  getRoutineWorkingCopy: vi.fn(), listRoutineWorkingCopies: vi.fn(async (): Promise<RoutineWorkingCopy[]> => []), saveRoutineWorkingCopy: vi.fn(), acknowledgeRoutineWorkingCopy: vi.fn(), clearActiveRoutine: vi.fn(),
  recordRoutineSyncAttempt: vi.fn(), reconcileRoutineWorkingCopy: vi.fn<(envelope: CloudRoutine) => Promise<RoutineWorkingCopy | null>>(async () => null), deleteRoutineWorkingCopy: vi.fn(),
  listCloudRoutines: vi.fn(async (): Promise<Routine[]> => []), listRoutinePublications: vi.fn(async (): Promise<Routine[]> => []),
  saveDraftRecovery: vi.fn(), removeDraftRecovery: vi.fn(), listDraftRecoveries: vi.fn(async () => []),
  getRoutine: vi.fn(), listRoutines: vi.fn(), getCloudRoutine: vi.fn(), getTrackBlob: vi.fn(),
  cacheCloudRoutine: vi.fn(), cacheCloudTrack: vi.fn(), saveRoutine: vi.fn(), setActiveRoutine: vi.fn(),
  getActiveRoutineSelection: vi.fn(async () => null), setActiveRoutineSelection: vi.fn(), listCachedClassSetups: vi.fn(async (): Promise<ClassSetup[]> => []),
  storeTrack: vi.fn(), createDemoRoutine: vi.fn(), getReadiness: vi.fn(), filler: vi.fn(),
  listFillerRecordings: vi.fn(), addFillerRecording: vi.fn(), removeFillerRecording: vi.fn(),
  cacheFillerRecording: vi.fn(), getFillerRecordingBlob: vi.fn(),
  listMusicPlaylists: vi.fn(), getMusicPlaylist: vi.fn(), saveMusicPlaylist: vi.fn(), cacheMusicPlaylist: vi.fn(),
  listPlaylistWorkingCopies: vi.fn(async () => []), listMusicPlaylistPublications: vi.fn(async () => []), listCachedMusicPlaylists: vi.fn(async () => []),
  listClassSetups: vi.fn(), getClassSetup: vi.fn(), saveClassSetup: vi.fn(), cacheClassSetup: vi.fn(),
  getCachedClassSetup: vi.fn(), getCachedMusicPlaylist: vi.fn(), getPreparedClass: vi.fn(),
  deleteRoutine: vi.fn(), deleteRoutineAndWorkingCopy: vi.fn(), publishRoutine: vi.fn(), deleteMusicPlaylist: vi.fn(), deleteClassSetup: vi.fn(),
  editor: { routine: null as Routine | null, changed: null as ((structural?: boolean) => void) | null, canEdit: null as (() => boolean) | null },
  preview: { stop: vi.fn(), dispose: vi.fn(), playFiller: vi.fn(), playTrack: vi.fn(), pause: vi.fn(),
    getState: vi.fn(() => ({ kind: 'idle', trackId: null, playing: false, loading: false, elapsed: 0, duration: 0, error: null })),
    subscribe: vi.fn(() => () => {}) },
  exportDispose: vi.fn(),
  player: { unload: vi.fn(), load: vi.fn(), play: vi.fn(), pause: vi.fn(), stop: vi.fn(), next: vi.fn(), seek: vi.fn(), updateCues: vi.fn(), advance: vi.fn(),
    hold: vi.fn(), continue: vi.fn(), setVolume: vi.fn(), setDucked: vi.fn(),
    setBeepsMuted: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() },
}));

vi.mock('../frontend/src/offline', () => appMocks);
vi.mock('../frontend/src/player', () => ({ createPlayer: () => appMocks.player }));
vi.mock('../frontend/src/audio-preview', () => ({ createAudioPreview: () => appMocks.preview }));
vi.mock('../frontend/src/bpm', () => ({ detectTrackBpm: vi.fn() }));
vi.mock('../frontend/src/loudness', () => ({ analyzeTrackLoudness: vi.fn() }));
vi.mock('../frontend/src/filler-audio', async original => ({ ...await original<typeof import('../frontend/src/filler-audio')>(), getFillerBuffer: appMocks.filler }));
vi.mock('../frontend/src/editor', async original => ({
  ...await original<typeof import('../frontend/src/editor')>(),
  renderEditor: (host: AppNode, routine: Routine, changed: (structural?: boolean) => void, context: { canEdit: () => boolean; trackActions?: AppNode }) => {
    appMocks.editor.routine = routine;
    appMocks.editor.changed = changed;
    appMocks.editor.canEdit = context.canEdit;
    host.replaceChildren(...(context.trackActions ? [context.trackActions] : []));
    return { syncAvailability: vi.fn(), cancelJobs: vi.fn(), refreshFillers: vi.fn(), dispose: vi.fn() };
  },
}));
vi.mock('../frontend/src/export-panel', () => ({ createExportPanel: () => ({ element: new AppNode('section'), syncAvailability: vi.fn(), dispose: appMocks.exportDispose }) }));
vi.mock('../frontend/src/theme', async original => ({
  ...await original<typeof import('../frontend/src/theme')>(), applyTheme: vi.fn(),
  readPreferences: () => ({ mode: 'light', accent: 'teal', highContrast: false, progressHeight: 64 }),
}));
vi.mock('../frontend/src/ui', async original => ({
  ...await original<typeof import('../frontend/src/ui')>(),
  element: (tag: string, className?: string, text?: string) => new AppNode(tag, className, text),
  field: (label: string, control: AppNode) => { const node = new AppNode('label', '', label); node.append(control); return node; },
  iconButton: (label: string, _icon: unknown, action: () => void) => {
    const node = new AppNode('button'); node.title = label; node.addEventListener('click', action); return node;
  },
  setButtonIcon: vi.fn(),
  createClassMode: () => ({ enter: vi.fn(), exit: vi.fn(), dispose: vi.fn() }),
}));

function session(role: CloudSession['user']['role'] = 'editor', id = 'instructor'): CloudSession {
  return { user: { id, username: id, role, authVersion: 1 }, expiresAt: Date.now() + 3_600_000, csrfToken: 'memory-only-csrf' };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function binary(blob: Blob): Response {
  return new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } });
}

function pending<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(accept => { resolve = accept; });
  return { promise, resolve };
}

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

async function fixture(bytes = 128, published = false): Promise<{ blob: Blob; asset: CloudAsset; envelope: CloudRoutine }> {
  const blob = new Blob([new Uint8Array(bytes).fill(7)], { type: 'audio/wav' });
  const asset: CloudAsset = { id: 'asset-a', bytes, sha256: await cloudHash(blob), contentType: 'audio/wav' };
  const routine = newRoutine();
  routine.id = 'routine-a';
  routine.name = '<Private class>';
  routine.published = published;
  routine.filler.mode = 'none';
  routine.tracks = [{ id: 'entry-a', title: '<Song>', duration: 30, bpm: 120, firstBeat: 0, bodyArea: '',
    cues: [{ id: 'cue-a', note: '<Move>', anchor: { kind: 'timestamp', seconds: 1 } }] }];
  return { blob, asset, envelope: { routine, media: { 'entry-a': asset } } satisfies CloudRoutine };
}

function libraryHarness(role: CloudSession['user']['role'] = 'editor') {
  const fetcher = vi.fn<typeof fetch>();
  const client = createCloudClient({ fetch: fetcher });
  client.admitSession(session(role));
  const getTrackBlob = vi.fn<(id: string) => Promise<Blob | undefined>>().mockResolvedValue(undefined);
  const cacheTrack = vi.fn<(id: string, blob: Blob, hash: string) => Promise<void>>().mockResolvedValue();
  const cacheRoutine = vi.fn<(routine: Routine) => Promise<void>>().mockResolvedValue();
  const getFillerBlob = vi.fn<(recording: FillerRecording) => Promise<Blob | undefined>>().mockResolvedValue(undefined);
  const cacheFiller = vi.fn<(recording: FillerRecording, blob: Blob) => Promise<void>>().mockResolvedValue();
  return { fetcher, client, getTrackBlob, cacheTrack, cacheRoutine, getFillerBlob, cacheFiller,
    library: createCloudLibrary({ client, getTrackBlob, cacheTrack, cacheRoutine, getFillerBlob, cacheFiller }) };
}

async function uploadHarness(bytes = 128) {
  const data = await fixture(bytes);
  const harness = libraryHarness();
  harness.getTrackBlob.mockResolvedValue(data.blob);
  const chunkCount = Math.ceil(bytes / CLOUD_CHUNK_BYTES);
  const start = vi.fn(async () => json({ id: 'upload-a', assetId: data.asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
    chunkCount, expiresAt: Date.now() + 86_400_000 }, 201));
  const chunk = vi.fn(async (path: string, options: RequestInit) => json({
    index: Number(path.split('/').at(-1)), sha256: await cloudHash(options.body as Blob),
  }));
  const complete = vi.fn(async () => json(data.asset));
  const abort = vi.fn(async () => json({ aborted: true }));
  const refresh = vi.fn(async () => json(session()));
  harness.fetcher.mockImplementation(async (input, options) => {
    const path = String(input);
    if (path === '/api/auth/session') return refresh();
    if (path === '/api/media/uploads') return start();
    if (path.includes('/chunks/')) return chunk(path, options!);
    if (path.endsWith('/complete')) return complete();
    if (path.endsWith('/abort')) return abort();
    if (path === '/api/routines' && options?.method === 'POST') return json(JSON.parse(String(options.body)), 201);
    throw new Error('unexpected_test_route');
  });
  const copying = (copiedChunks: number) => json({ pending: true, done: false,
    phase: copiedChunks === chunkCount ? 'publishing' : 'copying', copiedChunks, chunkCount }, 202);
  const save = (transfer = {}) => harness.library.save(data.envelope.routine, null, 'save', transfer);
  return { ...data, ...harness, start, chunk, complete, abort, refresh, copying, save, chunkCount };
}

afterEach(() => {
  if (typeof window !== 'undefined') window.dispatchEvent?.(new Event('pagehide'));
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('uploaded audio manager adapters', () => {
  it('reads bounded metadata without fetching audio and preserves unknown intake', async () => {
    const { asset } = await fixture(); const harness = libraryHarness();
    const metadata = { revision: 0, title: '<Title>', artist: '' };
    harness.fetcher.mockImplementation(async () => json({ items: [{ id: asset.id, kind: 'song', asset, metadata }], cursor: 'next' }));
    const result = await harness.library.managedPage('song');
    expect(result.items[0]!.metadata).toEqual(metadata); expect(result.items[0]!.metadata.duration).toBeUndefined();
    expect(harness.getTrackBlob).not.toHaveBeenCalled(); expect(harness.cacheTrack).not.toHaveBeenCalled();
    await harness.library.managedPage('song', result.cursor);
    expect(harness.fetcher.mock.calls.map(call => String(call[0]))).toEqual(['/api/library/songs', '/api/library/songs?cursor=next']);
    expect(harness.fetcher.mock.calls.every(call => call[1]?.cache === 'no-store')).toBe(true);
  });

  it('writes only editable metadata with quoted independent revision and exact intake once', async () => {
    const harness = libraryHarness(); const value = { title: 'House practice', artist: '', bpm: 124 };
    const intakeMetadata = { revision: 1, title: '', artist: '', filename: 'source.wav', duration: 30 };
    harness.fetcher.mockImplementation(async input => json(String(input).endsWith('/metadata')
      ? { metadata: { ...intakeMetadata, ...value, revision: 2 } } : { metadata: intakeMetadata }));
    expect(await harness.library.recordLibraryIntake('song', 'asset-a', 'source.wav', 30)).toEqual(intakeMetadata);
    await harness.library.putLibraryMetadata('song', 'asset-a', intakeMetadata.revision, value);
    const intake = harness.fetcher.mock.calls[0]![1]!; const edit = harness.fetcher.mock.calls[1]![1]!;
    expect(new Headers(intake.headers).get('If-Match')).toBe('"0"'); expect(JSON.parse(String(intake.body))).toEqual({ filename: 'source.wav', duration: 30 });
    expect(new Headers(edit.headers).get('If-Match')).toBe('"1"'); expect(JSON.parse(String(edit.body))).toEqual(value);
    for (const filename of ['../source.wav', 'source:mix.wav', '.', '..', 'source\u0001.wav', 'source\u007f.wav']) {
      await expect(harness.library.recordLibraryIntake('filler', 'asset-a', filename, 30)).rejects.toThrow('invalid_audio');
    }
    await expect(harness.library.putLibraryMetadata('song', 'asset-a', 1, { title: '', artist: '', bpm: 221 })).rejects.toThrow();
    expect(harness.fetcher).toHaveBeenCalledTimes(2);
  });

  it('makes one delete request per explicit continuation and preserves reference conflicts', async () => {
    const harness = libraryHarness();
    harness.fetcher.mockResolvedValueOnce(json({ pending: true }, 202)).mockResolvedValueOnce(json({ deleted: true, bytesRetained: true }))
      .mockResolvedValueOnce(json({ error: 'media_in_use' }, 409));
    expect(await harness.library.deleteLibraryItem('song', 'asset-a', 2)).toEqual({ pending: true });
    expect(harness.fetcher).toHaveBeenCalledOnce();
    expect(await harness.library.deleteLibraryItem('song', 'asset-a', 2)).toEqual({ deleted: true, bytesRetained: true });
    const options = harness.fetcher.mock.calls[0]![1]!;
    expect(options.method).toBe('DELETE'); expect(options.body).toBeUndefined(); expect(new Headers(options.headers).get('If-Match')).toBe('"2"');
    await expect(harness.library.deleteLibraryItem('song', 'asset-a', 2)).rejects.toMatchObject({ status: 409, serverCode: 'media_in_use' });
    expect(harness.fetcher).toHaveBeenCalledTimes(3);
  });

  it('denies player management and rejects responses crossing an identity change', async () => {
    const denied = libraryHarness('player'); await expect(denied.library.managedPage('song')).rejects.toThrow();
    await expect(denied.library.deleteLibraryItem('filler', 'recording-a', 0)).rejects.toThrow(); expect(denied.fetcher).not.toHaveBeenCalled();
    const harness = libraryHarness(); const response = pending<Response>(); harness.fetcher.mockReturnValue(response.promise);
    const reading = harness.library.managedPage('song'); harness.client.admitSession(session('editor', 'other'));
    response.resolve(json({ items: [] })); await expect(reading).rejects.toThrow();
  });
});

describe('unified catalog client', () => {
  it('fetches one metadata page with unknown values intact and no audio access', async () => {
    const { asset } = await fixture(); const harness = libraryHarness();
    harness.fetcher.mockImplementation(async () => json({ items: [{ asset, title: 'Unknown tempo' }], cursor: 'next-page' }));
    const page = await harness.library.audioPage();
    expect(page.items[0]).toEqual({ asset, title: 'Unknown tempo' });
    expect(harness.fetcher).toHaveBeenCalledTimes(1);
    expect(String(harness.fetcher.mock.calls[0]![0])).toBe('/api/media/library');
    expect(harness.getTrackBlob).not.toHaveBeenCalled(); expect(harness.cacheTrack).not.toHaveBeenCalled();
    await harness.library.audioPage(page.cursor);
    expect(String(harness.fetcher.mock.calls[1]![0])).toBe('/api/media/library?cursor=next-page');
  });
  it('blocks player catalog browsing before issuing a request', async () => {
    const harness = libraryHarness('player');
    await expect(harness.library.audioPage()).rejects.toThrow(); expect(harness.fetcher).not.toHaveBeenCalled();
  });
  it('validates the entire phase media union instead of just the main set', async () => {
    const { envelope, asset } = await fixture();
    envelope.routine.sequence = { crossfade: 1, walkIn: { name: 'Arrival', tracks: [{ ...envelope.routine.tracks[0]!, id: 'arrival', cues: [], bpm: undefined }] } };
    expect(() => parseCloudRoutine(envelope)).toThrow('cloud_invalid_response');
    envelope.media.arrival = asset;
    expect(parseCloudRoutine(envelope).routine.sequence?.walkIn?.tracks[0]?.bpm).toBeUndefined();
  });
  it('saves reused main and arrival bytes without initiating an upload', async () => {
    const { envelope, asset, blob } = await fixture(); const harness = libraryHarness();
    envelope.routine.sequence = { crossfade: 1, walkIn: { name: 'Arrival', tracks: [{ ...envelope.routine.tracks[0]!, id: 'arrival', cues: [] }] } };
    envelope.media.arrival = asset; harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async (input, options) => {
      if (String(input) === '/api/media/asset-a') return json({ asset });
      expect(String(input)).toBe('/api/routines/routine-a'); expect(options?.method).toBe('PUT');
      const body = JSON.parse(String(options!.body));
      return json({ ...body, routine: { ...body.routine, revision: 2 } });
    });
    const saved = await harness.library.save(envelope.routine, envelope);
    expect(Object.keys(saved.media)).toEqual(['arrival', 'entry-a']);
    expect(harness.fetcher.mock.calls.some(([input]) => String(input).includes('/uploads'))).toBe(false);
  });

  it.each(['different-entry', 'catalog-same-entry', 'head-same-entry'] as const)('fails missing remote %s assets without resurrecting them', async provenance => {
    const { envelope, asset, blob } = await fixture(); const harness = libraryHarness();
    if (provenance !== 'different-entry') {
      envelope.routine.tracks[0]!.id = asset.id; envelope.media = { [asset.id]: asset };
    }
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async input => {
      if (String(input) === '/api/media/library') return json({ items: [{ asset, title: 'Known remote' }] });
      if (String(input) === '/api/routines/routine-a') return json(envelope);
      return json({ error: 'asset_not_found' }, 404);
    });
    if (provenance === 'catalog-same-entry') await harness.library.audioPage();
    if (provenance === 'head-same-entry') await harness.library.readHead(envelope.routine.id);
    await expect(harness.library.stage(envelope.routine, envelope.media)).rejects.toMatchObject({ status: 404 });
    expect(harness.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(harness.cacheTrack).not.toHaveBeenCalled(); expect(harness.cacheRoutine).not.toHaveBeenCalled();
  });

  it('uploads a fresh local own-ID placeholder once when it has no remote provenance', async () => {
    const harness = await uploadHarness();
    const local = { ...harness.asset, id: 'entry-a' };
    const handler = harness.fetcher.getMockImplementation()!;
    harness.fetcher.mockImplementation((input, init) => String(input) === '/api/media/entry-a'
      ? Promise.resolve(json({ error: 'asset_not_found' }, 404)) : handler(input, init));
    const saved = await harness.library.save(harness.envelope.routine, null, 'save', {}, { 'entry-a': local });
    expect(saved.media['entry-a']).toEqual(harness.asset); expect(harness.start).toHaveBeenCalledOnce();
  });
});

describe('independent class and playlist client', () => {
  it.each(['offline', 'signin-required', 'browser-offline'] as const)('prepares an exact cached class with no API calls while %s', async access => {
    const { envelope } = await fixture(128, true);
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Cached', revision: 3, locked: false, published: true,
      routine: { id: 'routine-a', revision: 1, published: true }, crossfade: 1 };
    const harness = libraryHarness('player');
    if (access === 'browser-offline') vi.stubGlobal('navigator', { onLine: false });
    else harness.client.admitLocal(session('player').user, access, () => {});
    appMocks.getPreparedClass.mockResolvedValue({ setup, routine: envelope.routine, audio: { crossfade: 1 } });
    appMocks.getReadiness.mockResolvedValue({ ready: true, missing: [] });
    const library = createClassLibrary(harness.client, harness.library);
    expect((await library.legacy({ setup, source: 'household' })).routine).toEqual(envelope.routine);
    expect(appMocks.getPreparedClass).toHaveBeenLastCalledWith('class-a', 3, 'cloud', true);
    appMocks.getReadiness.mockResolvedValueOnce({ ready: false, missing: ['entry-a'] });
    await expect(library.prepare({ setup, source: 'household' })).rejects.toThrow('class_cache_unavailable');
    appMocks.getPreparedClass.mockResolvedValueOnce(null);
    await expect(library.prepare({ setup, source: 'household' })).rejects.toThrow('class_cache_unavailable');
    expect(harness.fetcher).not.toHaveBeenCalled();
  });

  it('remembers only a nonsecret exact reference and rejects different owners, versions, reset markers and player drafts', () => {
    const store = storage(); const owner = session().user;
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Private title', revision: 3, locked: false, published: false,
      routine: { id: 'routine-a', revision: 1, published: false }, crossfade: 1 };
    const select = () => rememberClassSelection(store, owner, { setup, source: 'household' });
    select();
    expect(recalledClassSelection(store, owner)).toEqual({ source: 'household', id: 'class-a', revision: 3, published: false });
    expect(store.getItem(classSelectionStorageKey)).not.toContain('Private title');
    expect(recalledClassSelection(store, { ...owner, id: 'other' })).toBeNull();
    select(); expect(recalledClassSelection(store, { ...owner, authVersion: 2 })).toBeNull();
    select(); store.setItem('fitness-hosted-reset', 'logout:test'); expect(recalledClassSelection(store, owner)).toBeNull();
    store.removeItem('fitness-hosted-reset');
    rememberClassSelection(store, session('player').user, { setup, source: 'household' });
    expect(recalledClassSelection(store, session('player').user)).toBeNull();
    select(); rememberClassSelection(store, owner, null); expect(store.getItem(classSelectionStorageKey)).toBeNull();
  });

  it.each(['owner', 'editor'] as const)('prepares a cold author draft as %s with ordinary asset reads', async role => {
    const { envelope, asset, blob } = await fixture(128, true);
    const recording = { id: 'announcement', name: 'Announcement', duration: 8, asset };
    const playlist: CloudMusicPlaylist = { playlist: { schemaVersion: 1, id: 'playlist-a', name: 'Walk in', revision: 2,
      locked: false, published: false, tracks: [{ ...envelope.routine.tracks[0]!, id: 'walk-entry', cues: [] }] }, media: { 'walk-entry': asset } };
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Draft class', revision: 3, locked: false, published: false,
      routine: { id: envelope.routine.id, revision: 1, published: true }, walkIn: { id: 'playlist-a', revision: 2, published: false },
      before: { ...envelope.routine.filler, mode: 'hold', sound: 'recording', recording }, crossfade: 1 };
    const harness = libraryHarness(role);
    harness.fetcher.mockImplementation(async input => {
      const path = String(input);
      if (path === '/api/classes/class-a/prepare?revision=3') return json({ setup, routine: envelope, walkIn: playlist });
      expect(path).not.toContain('?');
      return path.includes('/chunks/') ? binary(blob) : json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 });
    });
    const resolved = await createClassLibrary(harness.client, harness.library).legacy({ setup, source: 'household' });
    expect(resolved.audio.walkIn).toEqual(playlist.playlist);
    expect(harness.cacheTrack).toHaveBeenCalledTimes(2);
    expect(harness.cacheFiller).toHaveBeenCalledOnce();
  });

  it.each([undefined, 1])('pins routine media to the returned published revision when opening revision %s', async revision => {
    const { envelope, asset, blob } = await fixture(128, true);
    const harness = libraryHarness('player');
    harness.fetcher.mockImplementation(async input => {
      const path = String(input);
      if (path.startsWith('/api/routines/')) return json(envelope);
      expect(path).toContain('?routineId=routine-a&revision=1');
      return path.includes('/chunks/') ? binary(blob) : json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 });
    });
    await expect(harness.library.open('routine-a', true, {}, revision)).resolves.toEqual(envelope);
    expect(harness.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('duplicates the selected class and playlist revision (published=%s) without changing sources', async published => {
    const { envelope } = await fixture(128, published);
    const playlist: CloudMusicPlaylist = { playlist: { schemaVersion: 1, id: 'playlist-a', name: 'Selected', revision: 2,
      locked: false, published, tracks: envelope.routine.tracks.map(track => ({ ...track, cues: [] })) }, media: envelope.media };
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Selected class', revision: 3, locked: false, published,
      routine: { id: 'routine-a', revision: 1, published }, crossfade: 1 };
    const original = structuredClone({ playlist, setup });
    const harness = libraryHarness();
    harness.fetcher.mockImplementation(async (input, init) => {
      const path = String(input);
      expect(path).toContain(`/duplicate?${published ? 'published=true&' : ''}revision=${path.includes('playlists') ? 2 : 3}`);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has('If-Match')).toBe(false);
      return path.includes('playlists') ? json({ ...playlist, playlist: { ...playlist.playlist, id: 'playlist-copy', revision: 1, published: false } })
        : json({ setup: { ...setup, id: 'class-copy', revision: 1, published: false } });
    });
    const library = createClassLibrary(harness.client, harness.library);
    expect((await library.savePlaylist(playlist.playlist, playlist, 'duplicate')).playlist.id).toBe('playlist-copy');
    expect((await library.saveClass(setup, setup.revision, 'duplicate')).id).toBe('class-copy');
    expect({ playlist, setup }).toEqual(original);
  });

  it('pins a published class revision and authorizes every music chunk with classId and revision', async () => {
    const { envelope, asset, blob } = await fixture(128, true);
    const playlist: CloudMusicPlaylist = { playlist: { schemaVersion: 1, id: 'playlist-a', name: 'Walk in', revision: 2,
      locked: false, published: true, tracks: [{ ...envelope.routine.tracks[0]!, id: 'walk-entry', cues: [] }] }, media: { 'walk-entry': asset } };
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Pinned class', revision: 3, locked: false, published: true,
      routine: { id: envelope.routine.id, revision: 1, published: true }, walkIn: { id: 'playlist-a', revision: 2, published: true }, crossfade: 1 };
    const harness = libraryHarness('player');
    appMocks.cacheMusicPlaylist.mockResolvedValue(undefined); appMocks.cacheClassSetup.mockResolvedValue(undefined);
    harness.fetcher.mockImplementation(async input => {
      const path = String(input);
      if (path === '/api/classes/class-a/prepare?published=true&revision=3') return json({ setup, routine: envelope, walkIn: playlist });
      expect(path).toContain('?classId=class-a&revision=3');
      return path.includes('/chunks/') ? binary(blob) : json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 });
    });
    const resolved = await createClassLibrary(harness.client, harness.library).prepare({ setup, source: 'household' });
    expect(resolved.audio.walkIn).toEqual(playlist.playlist);
    expect(resolved.routine).toEqual(envelope.routine);
    expect(appMocks.cacheMusicPlaylist).toHaveBeenCalledWith(playlist);
    expect(harness.cacheTrack.mock.calls.map(call => call[0])).toEqual(['entry-a', 'walk-entry']);
    expect(harness.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('rejects a substituted playlist revision before requesting or caching media', async () => {
    const { envelope } = await fixture(128, true);
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Pinned class', revision: 3, locked: false, published: true,
      routine: { id: 'routine-a', revision: 1, published: true }, walkIn: { id: 'playlist-a', revision: 2, published: true }, crossfade: 1 };
    const playlist = { playlist: { schemaVersion: 1, id: 'playlist-a', name: 'Wrong revision', revision: 9, locked: false,
      published: true, tracks: [] }, media: {} };
    const harness = libraryHarness('player'); harness.fetcher.mockResolvedValue(json({ setup, routine: envelope, walkIn: playlist }));
    await expect(createClassLibrary(harness.client, harness.library).prepare({ setup, source: 'household' })).rejects.toThrow('cloud_invalid_response');
    expect(harness.fetcher).toHaveBeenCalledOnce(); expect(harness.cacheTrack).not.toHaveBeenCalled();
  });

  it('omits an empty legacy optional playlist while preserving its exact class reference', async () => {
    const { envelope } = await fixture(128, true);
    const setup: ClassSetup = { schemaVersion: 1, id: 'class-a', name: 'Empty arrival', revision: 3, locked: false, published: true,
      routine: { id: 'routine-a', revision: 1, published: true }, walkIn: { id: 'empty', revision: 2, published: true }, crossfade: 1 };
    const harness = libraryHarness('player'); harness.client.admitLocal(session('player').user, 'offline', () => {});
    appMocks.getPreparedClass.mockResolvedValue({ setup, routine: envelope.routine, audio: { crossfade: 1,
      walkIn: { schemaVersion: 1, id: 'empty', name: 'Empty', revision: 2, locked: false, published: true, tracks: [] } } });
    appMocks.getReadiness.mockResolvedValue({ ready: true, missing: [] });
    const resolved = await createClassLibrary(harness.client, harness.library).legacy({ setup, source: 'household' });
    expect(resolved.audio.walkIn).toBeUndefined(); expect(resolved.setup.walkIn).toEqual(setup.walkIn);
    expect((await createClassLibrary(harness.client, harness.library).prepare({ setup, source: 'household' })).audio.walkIn).toBeUndefined();
    expect(harness.fetcher).not.toHaveBeenCalled();
  });

  it('saves a playlist with the exact quoted revision and reuses verified immutable media', async () => {
    const { envelope, blob } = await fixture();
    const previous: CloudMusicPlaylist = { playlist: { schemaVersion: 1, id: 'playlist-a', name: 'Playlist', revision: 2,
      locked: false, published: false, tracks: envelope.routine.tracks.map(track => ({ ...track, cues: [] })) }, media: envelope.media };
    const harness = libraryHarness(); appMocks.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async (input, init) => {
      expect(input).toBe('/api/playlists/playlist-a'); expect(init?.method).toBe('PUT');
      expect(new Headers(init?.headers).get('If-Match')).toBe('"2"');
      const next = JSON.parse(String(init?.body)) as CloudMusicPlaylist;
      expect(next.media).toEqual(previous.media); next.playlist.revision++; return json(next);
    });
    expect((await createClassLibrary(harness.client, harness.library).savePlaylist(previous.playlist, previous)).playlist.revision).toBe(3);
    expect(harness.fetcher).toHaveBeenCalledOnce();
    const invalid = structuredClone(previous); invalid.playlist.tracks[0]!.after = { mode: 'none' };
    expect(() => parseCloudPlaylist(invalid)).toThrow('cloud_invalid_response');
  });
});

describe('shared filler cloud client', () => {
  it('reconciles a lost recording response without allocating another filler or reuploading bytes', async () => {
    const harness = await uploadHarness();
    const local = { id: 'local-recording', name: 'Dance loop', duration: 8, asset: harness.asset };
    const committed = { ...local, id: 'committed-recording' };
    const handler = harness.fetcher.getMockImplementation()!;
    harness.fetcher.mockImplementation(async (input, init) => {
      if (input === '/api/fillers' && init?.method === 'POST') return json({ error: 'storage_unavailable' }, 503);
      if (input === '/api/fillers') return json({ fillers: [committed] });
      return handler(input, init);
    });
    await expect(harness.library.addFiller(local, harness.blob)).rejects.toThrow();
    expect(await harness.library.addFiller(local, harness.blob)).toEqual(committed);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.fetcher.mock.calls.filter(([path, init]) => path === '/api/fillers' && init?.method === 'POST')).toHaveLength(1);
  });

  it('fails closed after ambiguous recording creation when reconciliation cannot prove its identity', async () => {
    const harness = await uploadHarness();
    const local = { id: 'local-recording', name: 'Dance loop', duration: 8, asset: harness.asset };
    const handler = harness.fetcher.getMockImplementation()!;
    harness.fetcher.mockImplementation(async (input, init) => {
      if (input === '/api/fillers' && init?.method === 'POST') return json({ error: 'storage_unavailable' }, 503);
      if (input === '/api/fillers') return json({ fillers: [] });
      return handler(input, init);
    });
    await expect(harness.library.addFiller(local, harness.blob)).rejects.toThrow();
    await expect(harness.library.addFiller(local, harness.blob)).rejects.toThrow('cloud_head_required');
    expect(harness.fetcher.mock.calls.filter(([path, init]) => path === '/api/fillers' && init?.method === 'POST')).toHaveLength(1);
  });

  it('prepares every gap recording, including a retained final rule, before caching the routine', async () => {
    const { envelope, asset, blob } = await fixture();
    const recording = { id: 'gap-a', name: 'Retained gap', duration: 8, asset };
    envelope.routine.tracks[0]!.after = { mode: 'custom', filler: { ...envelope.routine.filler, mode: 'hold', sound: 'recording', recording } };
    const harness = libraryHarness(); harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockResolvedValueOnce(json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 })).mockResolvedValueOnce(binary(blob));
    await harness.library.download(envelope);
    expect(harness.cacheFiller).toHaveBeenCalledWith(recording, expect.any(Blob));
    expect(harness.cacheFiller.mock.invocationCallOrder[0]).toBeLessThan(harness.cacheRoutine.mock.invocationCallOrder[0]!);
  });
  it.each(['owner', 'editor'] as const)('lists and archives as %s without changing routine snapshots or cached audio', async role => {
    const { envelope, asset } = await fixture();
    const recording = { id: 'filler-a', name: '<Private recording>', duration: 8, asset };
    envelope.routine.filler = { ...envelope.routine.filler, sound: 'recording', recording };
    const before = structuredClone(envelope);
    const harness = libraryHarness(role);
    harness.fetcher.mockResolvedValueOnce(json({ fillers: [recording] })).mockResolvedValueOnce(json({ archived: true }));
    expect(await harness.library.listFillers()).toEqual([recording]);
    await expect(harness.library.removeFiller(recording.id)).resolves.toBeUndefined();
    expect(harness.fetcher.mock.calls[1]).toEqual(['/api/fillers/filler-a', expect.objectContaining({ method: 'DELETE' })]);
    expect(harness.cacheFiller).not.toHaveBeenCalled();
    expect(harness.cacheRoutine).not.toHaveBeenCalled();
    expect(envelope).toEqual(before);
  });

  it('rejects all player catalog operations before network or local reads', async () => {
    const { asset, blob } = await fixture();
    const harness = libraryHarness('player');
    const recording = { id: 'filler-a', name: 'Private', duration: 8, asset };
    for (const action of [() => harness.library.listFillers(), () => harness.library.removeFiller(recording.id),
      () => harness.library.addFiller(recording, blob), () => harness.library.uploadAsset(blob)]) {
      await expect(action()).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(harness.fetcher).not.toHaveBeenCalled();
    expect(harness.getFillerBlob).not.toHaveBeenCalled();
  });

  it.each(['owner', 'editor', 'player'] as const)('hash-caches filler before routine for %s without catalog GET and reuses offline bytes', async role => {
    const { envelope, asset, blob } = await fixture(128, role === 'player');
    const recording = { id: 'archived-filler', name: 'Retained', duration: 8, asset: { ...asset, id: 'filler-asset' } };
    envelope.routine.filler = { ...envelope.routine.filler, sound: 'recording', recording };
    const harness = libraryHarness(role);
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockResolvedValueOnce(json({ asset: recording.asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 }))
      .mockResolvedValueOnce(binary(blob));
    await harness.library.download(envelope, {}, role === 'player');
    const suffix = role === 'player' ? '?routineId=routine-a&revision=1' : '';
    expect(harness.fetcher.mock.calls.map(([path]) => path)).toEqual([
      `/api/media/filler-asset${suffix}`, `/api/media/filler-asset/chunks/0${suffix}`,
    ]);
    expect(harness.cacheFiller).toHaveBeenCalledWith(recording, expect.any(Blob));
    expect(harness.cacheFiller.mock.invocationCallOrder[0]).toBeLessThan(harness.cacheRoutine.mock.invocationCallOrder[0]!);
    harness.getFillerBlob.mockResolvedValue(blob);
    harness.fetcher.mockClear();
    harness.client.admitLocal(session(role).user, 'offline', () => {});
    await harness.library.download(envelope, {}, role === 'player');
    expect(harness.fetcher).not.toHaveBeenCalled();
  });

  it.each(['corrupt', 'cancel', 'identity'] as const)('never caches a routine after a %s filler download', async failure => {
    const { envelope, asset, blob } = await fixture();
    const recording = { id: 'filler-a', name: 'Retained', duration: 8, asset };
    envelope.routine.filler = { ...envelope.routine.filler, sound: 'recording', recording };
    const harness = libraryHarness();
    const controller = new AbortController();
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockResolvedValueOnce(json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 }))
      .mockImplementationOnce(async () => {
        if (failure === 'cancel') controller.abort();
        if (failure === 'identity') harness.client.admitSession(session('editor', 'different'));
        return binary(failure === 'corrupt' ? new Blob([new Uint8Array(blob.size)]) : blob);
      });
    await expect(harness.library.download(envelope, { signal: controller.signal })).rejects.toThrow();
    expect(harness.cacheFiller).not.toHaveBeenCalled();
    expect(harness.cacheRoutine).not.toHaveBeenCalled();
  });

  it('uploads one asset, POSTs authoritative recording metadata before routine save, and leaves the local descriptor unchanged', async () => {
    const harness = await uploadHarness();
    const local = { id: 'local-filler', name: '<Custom>', duration: 8, asset: { ...harness.asset, id: 'local-asset' } };
    const authoritative = { ...local, id: 'cloud-filler', asset: harness.asset };
    harness.envelope.routine.filler = { ...harness.envelope.routine.filler, sound: 'recording', recording: local };
    harness.getFillerBlob.mockResolvedValue(harness.blob);
    const handler = harness.fetcher.getMockImplementation()!;
    harness.fetcher.mockImplementation(async (input, init) => {
      if (input === '/api/fillers' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: local.name, duration: local.duration, asset: harness.asset });
        return json(authoritative, 201);
      }
      if (input === '/api/fillers/local-filler') return json({ error: 'not_found' }, 404);
      return handler(input, init);
    });
    const result = await harness.save();
    expect(result.routine.filler.recording).toEqual(authoritative);
    expect(harness.envelope.routine.filler.recording).toEqual(local);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.cacheFiller).toHaveBeenCalledWith(authoritative, harness.blob);
    const writes = harness.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path);
    expect(writes.indexOf('/api/fillers')).toBeLessThan(writes.indexOf('/api/routines'));
  });

  it('resolves an archived exact ID on a fresh client without reallocating filler or its asset', async () => {
    const harness = await uploadHarness();
    const recording = { id: 'archived-filler', name: 'Retained', duration: 8, asset: harness.asset };
    harness.envelope.routine.filler = { ...harness.envelope.routine.filler, sound: 'recording', recording };
    harness.envelope.routine.tracks = [];
    harness.getFillerBlob.mockResolvedValue(harness.blob);
    const handler = harness.fetcher.getMockImplementation()!;
    harness.fetcher.mockImplementation(async (input, init) => input === '/api/fillers/archived-filler'
      ? json(recording) : handler(input, init));
    const result = await harness.save();
    expect(result.routine.filler.recording).toEqual(recording);
    expect(harness.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/fillers/archived-filler', '/api/routines']);
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.cacheFiller).not.toHaveBeenCalled();
  });

  it.each(['401', '403', '500', 'network', 'malformed', 'extra', 'asset-extra', 'id', 'name', 'duration',
    'asset-id', 'hash', 'bytes', 'type', '201'] as const)('fails closed resolving an unknown filler: %s', async failure => {
    const harness = await uploadHarness();
    const recording = { id: 'local-uuid', name: 'Retained', duration: 8, asset: { ...harness.asset } };
    harness.envelope.routine.filler = { ...harness.envelope.routine.filler, sound: 'recording', recording };
    harness.getFillerBlob.mockResolvedValue(harness.blob);
    const resolved = structuredClone(recording);
    if (failure === 'id') resolved.id = 'different';
    if (failure === 'name') resolved.name = 'Different';
    if (failure === 'duration') resolved.duration++;
    if (failure === 'asset-id') resolved.asset.id = 'different';
    if (failure === 'hash') resolved.asset.sha256 = 'a'.repeat(64);
    if (failure === 'bytes') resolved.asset.bytes++;
    if (failure === 'type') resolved.asset.contentType = 'audio/mpeg';
    harness.fetcher.mockImplementation(async () => {
      if (failure === 'network') throw new TypeError('offline');
      if (['401', '403', '500'].includes(failure)) return json({ error: 'denied' }, Number(failure));
      return json(failure === 'malformed' ? {} : failure === 'extra' ? { ...resolved, archived: true }
        : failure === 'asset-extra' ? { ...resolved, asset: { ...resolved.asset, extra: true } } : resolved,
      failure === '201' ? 201 : 200);
    });
    await expect(harness.save()).rejects.toThrow();
    expect(harness.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/fillers/local-uuid']);
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.getFillerBlob).not.toHaveBeenCalled();
    expect(harness.cacheFiller).not.toHaveBeenCalled();
  });

  it('preserves an exact archived descriptor from the current server envelope without listing or re-uploading', async () => {
    const { envelope, asset, blob } = await fixture();
    envelope.routine.filler = { ...envelope.routine.filler, sound: 'recording',
      recording: { id: 'archived-filler', name: 'Retained', duration: 8, asset } };
    const harness = libraryHarness();
    harness.getFillerBlob.mockResolvedValue(blob);
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async path => path === `/api/media/${asset.id}` ? json({ asset })
      : json({ ...envelope, routine: { ...envelope.routine, revision: 2 } }));
    const result = await harness.library.save(envelope.routine, envelope);
    expect(result.routine.filler.recording).toEqual(envelope.routine.filler.recording);
    expect(harness.fetcher.mock.calls.map(([path]) => path)).toEqual([`/api/media/${asset.id}`, '/api/routines/routine-a']);
  });
});

describe('bounded cloud binary requests', () => {
  it('reads exactly 2 MiB with same-origin credentials and no CSRF on downloads', async () => {
    const harness = libraryHarness();
    const blob = new Blob([new Uint8Array(CLOUD_CHUNK_BYTES)]);
    harness.fetcher.mockResolvedValue(binary(blob));
    expect((await harness.client.requestBlob('/api/media/asset-a/chunks/0')).size).toBe(CLOUD_CHUNK_BYTES);
    const options = harness.fetcher.mock.calls[0]![1]!;
    expect(options).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error' });
    expect(new Headers(options.headers).has('X-CSRF-Token')).toBe(false);
  });

  it.each([true, false])('rejects oversized binary with advertised length=%s and cancels its stream', async advertised => {
    const harness = libraryHarness();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(CLOUD_CHUNK_BYTES));
      controller.enqueue(new Uint8Array(1));
    }, cancel });
    harness.fetcher.mockResolvedValue(new Response(body, { headers: advertised ? { 'Content-Length': String(CLOUD_CHUNK_BYTES + 1) } : {} }));
    await expect(harness.client.requestBlob('/api/media/asset-a/chunks/0')).rejects.toMatchObject({ code: 'response_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects truncated chunks and identity changes during stream reads', async () => {
    const harness = libraryHarness();
    harness.fetcher.mockResolvedValue(new Response(new Uint8Array(2), { headers: { 'Content-Length': '3' } }));
    await expect(harness.client.requestBlob('/api/media/a/chunks/0')).rejects.toMatchObject({ code: 'cloud_http_error' });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    harness.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(value) { controller = value; } })));
    const request = harness.client.requestBlob('/api/media/a/chunks/0');
    const check = expect(request).rejects.toMatchObject({ code: 'session_changed' });
    await vi.waitFor(() => expect(harness.fetcher).toHaveBeenCalledTimes(2));
    harness.client.admitSession(session('editor', 'other'));
    controller.enqueue(new Uint8Array(1));
    controller.close();
    await check;
  });

  it('allows backend completion beyond ten seconds but bounds a stalled body at forty seconds', async () => {
    vi.useFakeTimers();
    const harness = libraryHarness();
    const response = pending<Response>();
    harness.fetcher.mockReturnValue(response.promise);
    const request = harness.client.request('/api/media/uploads/upload-a/complete', { method: 'POST' });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(harness.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    response.resolve(json({ complete: true }));
    await expect(request).resolves.toEqual({ complete: true });
    harness.fetcher.mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const check = expect(harness.client.requestBlob('/api/media/a/chunks/0')).rejects.toMatchObject({ code: 'network_unavailable' });
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUT_MS);
    await check;
    expect(harness.fetcher.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
  });

  it('clamps caller timeouts at 45 seconds and keeps cancellation from expiring the session', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise(() => {}));
    const client = createCloudClient({ fetch: fetcher, timeoutMs: 90_000 });
    client.admitSession(session());
    const check = expect(client.request('/api/routines')).rejects.toMatchObject({ code: 'network_unavailable' });
    await vi.advanceTimersByTimeAsync(45_000);
    await check;
    client.admitSession(session());
    const controller = new AbortController();
    const cancelled = expect(client.requestBlob('/api/media/a/chunks/0', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await cancelled;
    expect(client.getContext().access).toBe('online');
  });
});

describe('cloud transfers and revision commands', () => {
  it.each([true, false])('replaced bytes get an independent entry without mutating the source, commit=%s', async succeeds => {
    const harness = await uploadHarness();
    const previous = structuredClone(harness.envelope);
    previous.media['entry-a'] = { ...previous.media['entry-a']!, id: 'old-asset', sha256: 'a'.repeat(64) };
    const source = structuredClone(previous.routine);
    const request = harness.fetcher.getMockImplementation()!;
    let submitted!: CloudRoutine;
    harness.fetcher.mockImplementation(async (input, options) => {
      if (String(input) !== '/api/routines/routine-a') return request(input, options);
      submitted = JSON.parse(String(options?.body)) as CloudRoutine;
      const entryId = submitted.routine.tracks[0]!.id;
      expect(entryId).not.toBe('entry-a');
      expect(Object.keys(submitted.media)).toEqual([entryId]);
      expect(submitted.media[entryId]).toEqual(harness.asset);
      expect(submitted.routine.tracks[0]!.cues).toEqual(source.tracks[0]!.cues);
      expect(source).toEqual(previous.routine);
      expect(new Headers(options?.headers).get('If-Match')).toBe('"1"');
      return succeeds ? json({ ...submitted, routine: { ...submitted.routine, revision: 2 } })
        : json({ error: 'routine_conflict' }, 412);
    });
    const saving = harness.library.save(source, previous);
    if (succeeds) expect((await saving).routine.tracks[0]!.id).toBe(submitted.routine.tracks[0]!.id);
    else await expect(saving).rejects.toMatchObject({ status: 412 });
    expect(source).toEqual(previous.routine);
    expect(previous.media['entry-a']!.id).toBe('old-asset');
  });

  it.each([
    { pending: true, done: false, phase: 'copying', copiedChunks: 0, chunkCount: 2 },
    { pending: true, done: true, phase: 'copying', copiedChunks: 0, chunkCount: 1 },
    { pending: true, done: false, phase: 'unknown', copiedChunks: 0, chunkCount: 1 },
    { pending: true, done: false, phase: 'copying', copiedChunks: '0', chunkCount: 1 },
    { pending: true, done: false, phase: 'copying', copiedChunks: 0, chunkCount: 1, id: 'asset-a' },
  ])('rejects malformed completion shape %# before saving', async body => {
    const { envelope, blob, asset } = await fixture();
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockResolvedValueOnce(json({ id: 'upload-a', assetId: asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
      chunkCount: 1, expiresAt: Date.now() + 60_000 })).mockResolvedValueOnce(json({ index: 0, sha256: asset.sha256 }))
      .mockResolvedValueOnce(json(body, 202));
    await expect(harness.library.save(envelope.routine, null)).rejects.toThrow('cloud_invalid_response');
    expect(harness.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['cancel', 'identity', 'elapsed'] as const)('fences each completion call after %s', async failure => {
    const { envelope, blob, asset } = await fixture();
    const harness = libraryHarness();
    const controller = new AbortController();
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async input => {
      const path = String(input);
      if (path === '/api/media/uploads') return json({ id: 'upload-a', assetId: asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
        chunkCount: 1, expiresAt: Date.now() + 60_000 });
      if (path.includes('/chunks/')) return json({ index: 0, sha256: asset.sha256 });
      if (path.endsWith('/abort')) return json({ aborted: true });
      if (failure === 'cancel') controller.abort();
      if (failure === 'identity') harness.client.admitSession(session('editor', 'other'));
      if (failure === 'elapsed') time = 300_001;
      return json({ pending: true, done: false, phase: 'copying', copiedChunks: 0, chunkCount: 1 }, 202);
    });
    await expect(harness.library.save(envelope.routine, null, 'save', { signal: controller.signal })).rejects.toThrow(
      failure === 'cancel' ? 'cancelled' : failure === 'identity' ? 'session_changed' : 'cloud_http_error');
    expect(harness.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/complete'))).toHaveLength(1);
    expect(harness.fetcher.mock.calls.some(([path]) => path === '/api/routines')).toBe(false);
    expect(harness.fetcher.mock.calls.some(([path]) => String(path).endsWith('/abort'))).toBe(failure === 'cancel');
  });

  it.each([
    { name: 'zero then publication then asset', cursors: [0, 1], phases: ['copying', 'publishing'], succeeds: true, calls: 3 },
    { name: 'three unchanged publication replies then asset', cursors: [1, 1, 1, 1], phases: ['publishing'], succeeds: true, calls: 5 },
    { name: 'bounded repeated publication', cursors: [1, 1, 1, 1, 1], phases: ['publishing'], succeeds: false, calls: 5 },
    { name: 'repeated copying then asset', cursors: [0, 0], phases: ['copying'], succeeds: true, calls: 3 },
    { name: 'negative cursor', cursors: [-1], phases: ['copying'], succeeds: false, calls: 1 },
    { name: 'fractional cursor', cursors: [0.5], phases: ['copying'], succeeds: false, calls: 1 },
    { name: 'oversized cursor', cursors: [2], phases: ['copying'], succeeds: false, calls: 1 },
    { name: 'early publication', cursors: [0], phases: ['publishing'], succeeds: false, calls: 1 },
    { name: 'regression', cursors: [1, 0], phases: ['publishing', 'copying'], succeeds: false, calls: 2 },
  ])('completion protocol: $name', async ({ cursors, phases, succeeds, calls }) => {
    const { envelope, blob, asset } = await fixture();
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    let completes = 0;
    harness.fetcher.mockImplementation(async (input, options) => {
      const path = String(input);
      if (path === '/api/media/uploads') return json({ id: 'upload-a', assetId: asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
        chunkCount: 1, expiresAt: Date.now() + 60_000 });
      if (path.includes('/chunks/')) return json({ index: 0, sha256: asset.sha256 });
      if (path.endsWith('/complete')) {
        const index = completes++;
        return index < cursors.length ? json({ pending: true, done: false, phase: phases[index] ?? phases[0],
          copiedChunks: cursors[index], chunkCount: 1 }, 202) : json(asset);
      }
      return json(JSON.parse(String(options!.body)), 201);
    });
    if (succeeds) await expect(harness.library.save(envelope.routine, null)).resolves.toEqual(envelope);
    else {
      await expect(harness.library.save(envelope.routine, null)).rejects.toThrow(
        calls === 5 ? 'cloud_http_error' : 'cloud_invalid_response');
      expect(harness.fetcher.mock.calls.some(([path]) => path === '/api/routines')).toBe(false);
    }
    expect(completes).toBe(calls);
  });

  it('finishes partial batches copying only one chunk per call', async () => {
    const harness = await uploadHarness(10 * CLOUD_CHUNK_BYTES);
    let cursor = 0;
    harness.complete.mockImplementation(async () => cursor <= harness.chunkCount
      ? harness.copying(cursor++) : json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.complete).toHaveBeenCalledTimes(12);
    expect(harness.chunk).toHaveBeenCalledTimes(10);
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it.each([
    [500, 'internal_error'], [503, 'storage_unavailable'], [503, 'finalization_timeout'], [502, 'gateway_error'],
    [504, 'gateway_timeout'], [409, 'upload_conflict'],
  ] as const)('retries completion %s %s after finite backoff without refreshing online auth', async (status, code) => {
    const harness = await uploadHarness();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    harness.complete.mockResolvedValueOnce(harness.copying(1)).mockResolvedValueOnce(json({ error: code }, status));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.complete).toHaveBeenCalledTimes(3);
    expect(timers.mock.calls.some(([, delay]) => delay === 250)).toBe(true);
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
  });

  it.each([500, 503, 502, 504, 409, 'network'] as const)('bounds transient %s retries at two and later Saves the same sealed ID', async status => {
    const harness = await uploadHarness();
    const code = status === 409 ? 'upload_conflict' : 'storage_unavailable';
    harness.complete.mockImplementation(async () => {
      if (status === 'network') throw new TypeError('connection lost');
      return json({ error: code }, status);
    });
    const error = await harness.save().catch(value => value);
    expect(error).toMatchObject(status === 'network' ? { code: 'network_unavailable' }
      : { code: 'cloud_http_error', status: status === 409 ? 409 : status === 500 ? 500 : 503, serverCode: code });
    if (status !== 500) expect(cloudErrorMessage(error)).toBe(t(status === 'network' ? 'cloudNetworkFailed'
      : status === 409 ? 'cloudUploadConflict' : 'cloudUnavailable'));
    expect(harness.complete).toHaveBeenCalledTimes(3);
    expect(harness.refresh).toHaveBeenCalledTimes(status === 'network' ? 2 : 0);
    harness.complete.mockImplementation(async () => json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
    expect(harness.complete).toHaveBeenCalledTimes(4);
    expect(harness.refresh).toHaveBeenCalledTimes(status === 'network' ? 3 : 0);
    expect(harness.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/complete'))
      .every(([path]) => path === '/api/media/uploads/upload-a/complete')).toBe(true);
  });

  it('refreshes same-identity session after a network failure and uses the new in-memory CSRF', async () => {
    const harness = await uploadHarness();
    harness.complete.mockRejectedValueOnce(new TypeError('connection lost'));
    harness.refresh.mockImplementation(async () => json({ ...session(), csrfToken: 'renewed-memory-token' }));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.refresh).toHaveBeenCalledOnce();
    const calls = harness.fetcher.mock.calls;
    expect(calls.map(([path]) => String(path))).toEqual([
      '/api/media/uploads', '/api/media/uploads/upload-a/chunks/0', '/api/media/uploads/upload-a/complete',
      '/api/auth/session', '/api/media/uploads/upload-a/complete', '/api/routines',
    ]);
    expect(new Headers(calls[4]![1]!.headers).get('X-CSRF-Token')).toBe('renewed-memory-token');
    expect(harness.client.getContext().access).toBe('online');
  });

  it.each(['identity', 'version', 'role', '401', '403'] as const)('never retries a completion after refresh changes %s', async change => {
    const harness = await uploadHarness();
    harness.complete.mockRejectedValueOnce(new TypeError('connection lost'));
    const next = session();
    if (change === 'identity') next.user.id = 'other';
    if (change === 'version') next.user.authVersion++;
    if (change === 'role') next.user.role = 'owner';
    harness.refresh.mockImplementation(async () => ['401', '403'].includes(change)
      ? json({ error: change === '401' ? 'signin_required' : 'forbidden' }, Number(change)) : json(next));
    await expect(harness.save()).rejects.toMatchObject({ code: change === '401' ? 'signin_required'
      : change === '403' ? 'forbidden' : 'session_changed' });
    expect(harness.complete).toHaveBeenCalledOnce();
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.fetcher.mock.calls.some(([path]) => path === '/api/routines')).toBe(false);
  });

  it('counts failed session recovery against the same two-retry allowance', async () => {
    const harness = await uploadHarness();
    harness.complete.mockRejectedValueOnce(new TypeError('connection lost'));
    harness.refresh.mockImplementation(async () => json({ error: 'storage_unavailable' }, 503));
    await expect(harness.save()).rejects.toMatchObject({ status: 503, serverCode: 'storage_unavailable' });
    expect(harness.complete).toHaveBeenCalledOnce();
    expect(harness.refresh).toHaveBeenCalledTimes(2);
    harness.refresh.mockImplementation(async () => json(session()));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
  });

  it.each([
    [400, 'invalid_media'], [422, 'hash_mismatch'], [401, 'signin_required'],
    [403, 'forbidden'], [403, 'origin_required'], [423, 'routine_locked'], [409, 'upload_closed'], [429, 'rate_limited'],
  ] as const)('does not retry completion %s %s', async (status, code) => {
    const harness = await uploadHarness();
    harness.complete.mockImplementation(async () => json({ error: code }, status));
    await expect(harness.save()).rejects.toMatchObject({ status, serverCode: code });
    expect(harness.complete).toHaveBeenCalledOnce();
    expect(harness.refresh).not.toHaveBeenCalled();
    harness.client.admitSession(session());
    if (status === 401 || status === 403) {
      harness.complete.mockImplementation(async () => json(harness.asset));
      await expect(harness.save()).resolves.toEqual(harness.envelope);
    } else {
      await expect(harness.save()).rejects.toMatchObject({ status, serverCode: code });
      expect(harness.complete).toHaveBeenCalledOnce();
    }
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
  });

  it('surfaces recoverable no-progress after four unchanged cursors and resumes on explicit Save', async () => {
    const harness = await uploadHarness();
    harness.complete.mockImplementation(async () => harness.copying(0));
    const error = await harness.save().catch(value => value);
    expect(error).toMatchObject({ code: 'cloud_http_error', status: 503, serverCode: 'finalization_timeout' });
    expect(cloudErrorMessage(error)).toBe(t('cloudUnavailable'));
    expect(harness.complete).toHaveBeenCalledTimes(5);
    harness.complete.mockImplementation(async () => json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
  });

  it('retains publishing phase across Saves and permanently rejects a regressed cursor', async () => {
    const harness = await uploadHarness();
    harness.complete.mockImplementation(async () => harness.copying(1));
    await expect(harness.save()).rejects.toMatchObject({ serverCode: 'finalization_timeout' });
    harness.complete.mockImplementation(async () => harness.copying(0));
    await expect(harness.save()).rejects.toThrow('cloud_invalid_response');
    await expect(harness.save()).rejects.toThrow('cloud_invalid_response');
    expect(harness.complete).toHaveBeenCalledTimes(6);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
  });

  it('bounds completion calls at chunkCount plus eight despite intermittent progress', async () => {
    const harness = await uploadHarness(4 * CLOUD_CHUNK_BYTES);
    let calls = 0;
    harness.complete.mockImplementation(async () => harness.copying(Math.floor(calls++ / 3)));
    await expect(harness.save()).rejects.toMatchObject({ status: 503, serverCode: 'finalization_timeout' });
    expect(harness.complete).toHaveBeenCalledTimes(12);
    expect(harness.complete.mock.calls.length).toBeLessThanOrEqual(80);
    harness.complete.mockImplementation(async () => json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.chunk).toHaveBeenCalledTimes(4);
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it.each([500, 503])('resumes only acknowledged verified chunks before sealing after %s', async status => {
    const harness = await uploadHarness(CLOUD_CHUNK_BYTES + 128);
    const putChunk = harness.chunk.getMockImplementation()!;
    harness.chunk.mockImplementation(async (path, options) => path.endsWith('/1')
      ? json({ error: 'storage_unavailable' }, status) : putChunk(path, options));
    await expect(harness.save()).rejects.toMatchObject({ status });
    expect(harness.complete).not.toHaveBeenCalled();
    harness.chunk.mockImplementation(putChunk);
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.chunk.mock.calls.map(([path]) => path.split('/').at(-1))).toEqual(['0', '1', '1', '1', '1']);
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it('resets the consecutive no-progress allowance when another chunk is acknowledged', async () => {
    const harness = await uploadHarness(2 * CLOUD_CHUNK_BYTES);
    const cursors = [0, 0, 0, 0, 1, 1, 1, 1];
    harness.complete.mockImplementation(async () => cursors.length ? harness.copying(cursors.shift()!) : json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.complete).toHaveBeenCalledTimes(9);
  });

  it('aborts a slow in-flight completion at five minutes and retains its ID for explicit recovery', async () => {
    const harness = await uploadHarness(10 * CLOUD_CHUNK_BYTES);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let cursor = 0;
    harness.complete.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(harness.copying(cursor++)), 35_000);
    }));
    const saving = harness.save().catch(error => error);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(300_000);
    const error = await saving;
    expect(error).toMatchObject({ code: 'cloud_http_error', status: 503, serverCode: 'finalization_timeout' });
    expect(cloudErrorMessage(error)).toBe(t('cloudUnavailable'));
    expect(harness.complete).toHaveBeenCalledTimes(9);
    const requests = harness.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/complete'));
    expect(requests.at(-1)![1]!.signal!.aborted).toBe(true);
    expect(harness.refresh).not.toHaveBeenCalled();
    harness.complete.mockImplementation(async () => json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledTimes(10);
  });

  it.each(['cancel', 'deadline'] as const)('fences a late session refresh after %s without another completion request', async reason => {
    const harness = await uploadHarness();
    const controller = new AbortController();
    const refreshed = pending<Response>();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    harness.complete.mockRejectedValueOnce(new TypeError('connection lost'));
    harness.refresh.mockReturnValueOnce(refreshed.promise);
    const saving = harness.save({ signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledOnce());
    if (reason === 'cancel') controller.abort();
    else (timers.mock.calls.find(([, delay]) => delay === 300_000)![0] as () => void)();
    expect(await saving).toMatchObject(reason === 'cancel' ? { code: 'cancelled' }
      : { code: 'cloud_http_error', status: 503, serverCode: 'finalization_timeout' });
    refreshed.resolve(json(session()));
    await vi.waitFor(() => expect(harness.client.getContext().access).toBe('online'));
    expect(harness.complete).toHaveBeenCalledOnce();
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.fetcher.mock.calls.some(([path]) => path === '/api/routines')).toBe(false);
  });

  it('reuses a completed asset after a failed routine write without any upload requests', async () => {
    const harness = await uploadHarness();
    const server = harness.fetcher.getMockImplementation()!;
    harness.fetcher.mockImplementation(async (input, options) => input === '/api/routines'
      ? json({ error: 'storage_unavailable' }, 503) : server(input, options));
    await expect(harness.save()).rejects.toMatchObject({ status: 503 });
    harness.fetcher.mockImplementation(server);
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).toHaveBeenCalledOnce();
    expect(harness.complete).toHaveBeenCalledOnce();
  });

  it.each(['success', 'sealed', 'unknown'] as const)('handles cancelled completion with %s abort without unsafe chunk reuse', async result => {
    const harness = await uploadHarness();
    const controller = new AbortController();
    harness.complete.mockImplementationOnce(async () => { controller.abort(); return harness.copying(0); });
    if (result !== 'success') harness.abort.mockImplementation(async () => json({ error: result === 'sealed'
      ? 'upload_closed' : 'storage_unavailable' }, result === 'sealed' ? 409 : 503));
    await expect(harness.save({ signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.complete).toHaveBeenCalledOnce();
    if (result === 'unknown') {
      await expect(harness.save()).rejects.toMatchObject({ code: 'cancelled' });
      expect(harness.complete).toHaveBeenCalledOnce();
    } else await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledTimes(result === 'success' ? 2 : 1);
    expect(harness.chunk).toHaveBeenCalledTimes(result === 'success' ? 2 : 1);
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it('cancels transient backoff without an automatic retry or session refresh', async () => {
    const harness = await uploadHarness();
    const controller = new AbortController();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    harness.complete.mockResolvedValueOnce(json({ error: 'storage_unavailable' }, 503));
    const check = expect(harness.save({ signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => delay === 250)).toBe(true));
    controller.abort();
    await check;
    expect(harness.complete).toHaveBeenCalledOnce();
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it('expires remembered staging state at the server deadline and allocates only on a later explicit Save', async () => {
    const harness = await uploadHarness();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    harness.start.mockImplementationOnce(async () => json({ id: 'upload-expiring', assetId: harness.asset.id,
      chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1, expiresAt: now + 1_000 }));
    harness.complete.mockImplementation(async () => harness.copying(0));
    await expect(harness.save()).rejects.toMatchObject({ serverCode: 'finalization_timeout' });
    vi.mocked(Date.now).mockReturnValue(now + 1_001);
    harness.complete.mockImplementation(async () => json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledTimes(2);
    expect(harness.chunk).toHaveBeenCalledTimes(2);
    expect(harness.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/complete')).at(-1)![0])
      .toBe('/api/media/uploads/upload-a/complete');
  });

  it('never reuses another identity\'s retained upload', async () => {
    const harness = await uploadHarness();
    harness.complete.mockImplementation(async () => harness.copying(0));
    await expect(harness.save()).rejects.toMatchObject({ serverCode: 'finalization_timeout' });
    harness.client.admitSession(session('editor', 'other'));
    harness.start.mockImplementation(async () => json({ id: 'upload-other', assetId: harness.asset.id,
      chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1, expiresAt: Date.now() + 86_400_000 }));
    harness.complete.mockImplementation(async () => json(harness.asset));
    await expect(harness.save()).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledTimes(2);
    expect(harness.fetcher.mock.calls.filter(([path]) => String(path).endsWith('/complete')).at(-1)![0])
      .toBe('/api/media/uploads/upload-other/complete');
  });

  it.each([500, 503, 'network'] as const)('does not allocate again after ambiguous %s initiation with no returned ID', async status => {
    const harness = await uploadHarness();
    harness.start.mockImplementation(async () => {
      if (status === 'network') throw new TypeError('lost initiation acknowledgement');
      return json({ error: 'storage_unavailable' }, status);
    });
    const expected = { code: status === 'network' ? 'network_unavailable' : 'cloud_http_error' };
    await expect(harness.save()).rejects.toMatchObject(expected);
    harness.client.admitSession(session());
    await expect(harness.save()).rejects.toMatchObject(expected);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.chunk).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it('does not allocate a second ID for overlapping explicit Saves of the same bytes', async () => {
    const harness = await uploadHarness();
    const started = pending<Response>();
    harness.start.mockReturnValueOnce(started.promise);
    const saving = harness.save();
    await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
    await expect(harness.save()).rejects.toMatchObject({ status: 409, serverCode: 'upload_conflict' });
    started.resolve(json({ id: 'upload-a', assetId: harness.asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
      chunkCount: 1, expiresAt: Date.now() + 86_400_000 }));
    await expect(saving).resolves.toEqual(harness.envelope);
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it.each([202, 201])('never treats an asset returned with HTTP %s as completed', async status => {
    const { envelope, blob, asset } = await fixture();
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockResolvedValueOnce(json({ id: 'upload-a', assetId: asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
      chunkCount: 1, expiresAt: Date.now() + 60_000 })).mockResolvedValueOnce(json({ index: 0, sha256: asset.sha256 }))
      .mockResolvedValueOnce(json(asset, status));
    await expect(harness.library.save(envelope.routine, null)).rejects.toThrow('cloud_invalid_response');
    expect(harness.fetcher).toHaveBeenCalledTimes(3);
  });

  it('shares an explicitly uploaded publication between two sessions of the same account without reuploading on the second device', async () => {
    const { envelope, blob, asset } = await fixture();
    const first = libraryHarness();
    const second = libraryHarness();
    first.getTrackBlob.mockResolvedValue(blob);
    let saved: CloudRoutine | null = null;
    let publication: CloudRoutine | null = null;
    const server: typeof fetch = async (input, options) => {
      const path = String(input);
      if (path === '/api/media/uploads') return json({ id: 'upload-a', assetId: asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
        chunkCount: 1, expiresAt: Date.now() + 60_000 });
      if (path === '/api/media/uploads/upload-a/chunks/0') return json({ index: 0, sha256: await cloudHash(options!.body as Blob) });
      if (path.endsWith('/complete')) return json(asset);
      if (path === '/api/routines' && options?.method === 'POST') {
        saved = JSON.parse(String(options.body)) as CloudRoutine;
        return json(saved, 201);
      }
      if (path.endsWith('/publish')) {
        expect(saved).not.toBeNull();
        publication = structuredClone(saved!);
        publication.routine.revision++;
        publication.routine.published = true;
        return json(publication);
      }
      if (path === '/api/routines/routine-a?published=true') return json(publication);
      if (path === '/api/media/asset-a?routineId=routine-a&revision=2') return json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 });
      if (path === '/api/media/asset-a/chunks/0?routineId=routine-a&revision=2') return binary(blob);
      throw new Error('unexpected_test_route');
    };
    first.fetcher.mockImplementation(server);
    second.fetcher.mockImplementation(server);
    const created = await first.library.save(envelope.routine, null);
    const published = await first.library.command(created, 'publish');
    const received = await second.library.open(created.routine.id, true);
    expect(received).toEqual(published);
    expect(received.routine.tracks[0]!.id).toBe(envelope.routine.tracks[0]!.id);
    expect(second.cacheTrack).toHaveBeenCalledWith('entry-a', expect.any(Blob), asset.sha256);
    expect(second.cacheRoutine).toHaveBeenCalledWith(published.routine);
    expect(second.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(second.fetcher.mock.calls.some(([input]) => String(input).includes('/uploads'))).toBe(false);
  });

  it('rejects publication save, lock, unlock and delete even if a caller labels the envelope a draft', async () => {
    const { envelope } = await fixture(128, true);
    const harness = libraryHarness();
    await expect(harness.library.save(envelope.routine, envelope)).rejects.toThrow('cloud_head_required');
    for (const action of ['lock', 'unlock', 'publish', 'delete'] as const) {
      await expect(harness.library.command(envelope, action, false)).rejects.toThrow('cloud_head_required');
    }
    expect(harness.fetcher).not.toHaveBeenCalled();
    expect(harness.getTrackBlob).not.toHaveBeenCalled();
  });

  it('uploads in sequential bounded chunks, verifies chunk/full hashes, canonicalizes MIME and preserves entry/cue IDs', async () => {
    const { envelope, blob, asset } = await fixture(CLOUD_CHUNK_BYTES + 128);
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(new Blob([blob], { type: 'audio/x-wav' }));
    const indexes: number[] = [];
    harness.fetcher.mockImplementation(async (input, options) => {
      const path = String(input);
      if (path === '/api/media/uploads') {
        expect(JSON.parse(String(options!.body))).toEqual({ bytes: blob.size, sha256: asset.sha256, contentType: 'audio/wav' });
        return json({ id: 'upload-a', assetId: asset.id, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 2, expiresAt: Date.now() + 60_000 }, 201);
      }
      if (path.includes('/chunks/')) {
        const chunk = options!.body as Blob;
        const index = Number(path.split('/').at(-1));
        indexes.push(index);
        expect(chunk.size).toBe(index === 0 ? CLOUD_CHUNK_BYTES : 128);
        expect(new Headers(options!.headers).get('Content-Type')).toBe('application/octet-stream');
        return json({ index, sha256: await cloudHash(chunk) });
      }
      if (path.endsWith('/complete')) return json(asset);
      const saved = JSON.parse(String(options!.body)) as CloudRoutine;
      expect(new Headers(options!.headers).get('X-CSRF-Token')).toBe('memory-only-csrf');
      return json(saved, 201);
    });
    const progress = vi.fn();
    expect(await harness.library.save(envelope.routine, null, 'save', { progress })).toEqual(envelope);
    expect(indexes).toEqual([0, 1]);
    expect(progress).toHaveBeenLastCalledWith(1, 1);
    expect(harness.cacheRoutine).not.toHaveBeenCalled();
    expect(harness.fetcher).toHaveBeenCalledTimes(5);
  });

  it('verifies local hashes without reuploading unchanged descriptors, including two entries sharing an asset', async () => {
    const { envelope, blob } = await fixture();
    envelope.routine.tracks.push({ ...structuredClone(envelope.routine.tracks[0]!), id: 'entry-b' });
    envelope.media['entry-b'] = envelope.media['entry-a']!;
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    const next = structuredClone(envelope);
    next.routine.revision++;
    harness.fetcher.mockImplementation(async path => path === '/api/media/asset-a' ? json({ asset: envelope.media['entry-a'] }) : json(next));
    const edited = structuredClone(envelope.routine);
    edited.name = 'Edited';
    await harness.library.save(edited, envelope);
    expect(harness.getTrackBlob.mock.calls).toEqual([['entry-a'], ['entry-b']]);
    expect(harness.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/media/asset-a', '/api/media/asset-a', '/api/routines/routine-a']);
    const options = harness.fetcher.mock.calls[2]![1]!;
    expect(options.method).toBe('PUT');
    expect(new Headers(options.headers).get('If-Match')).toBe('"1"');
    expect(JSON.parse(String(options.body)).media).toEqual(envelope.media);
  });

  it('saves reordered whole entries with normal CAS and unchanged media while the old publication stays unchanged', async () => {
    const { envelope, blob } = await fixture();
    envelope.routine.tracks[0]!.gain = 0.75;
    envelope.routine.tracks.push({ ...structuredClone(envelope.routine.tracks[0]!), id: 'entry-b', gain: 1.25,
      cues: [{ id: 'cue-b', note: '<Other move>', beep: true, anchor: { kind: 'interval', seconds: 4.125 } }] });
    envelope.media['entry-b'] = envelope.media['entry-a']!;
    const publication = structuredClone(envelope);
    publication.routine.published = true;
    const publishedBytes = JSON.stringify(publication);
    const previous = structuredClone(envelope);
    const draft = structuredClone(envelope.routine);
    const entries = [...draft.tracks];
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async (input, options) => {
      if (input === '/api/media/asset-a') return json({ asset: envelope.media['entry-a'] });
      if (String(input) === '/api/routines/routine-a?published=true') return json(publication);
      expect(input).toBe('/api/routines/routine-a');
      expect(options?.method).toBe('PUT');
      expect(new Headers(options?.headers).get('If-Match')).toBe('"1"');
      const submitted = JSON.parse(String(options?.body)) as CloudRoutine;
      expect(submitted.routine.id).toBe(envelope.routine.id);
      expect(submitted.routine.tracks).toEqual([entries[1], entries[0]]);
      expect(submitted.media).toEqual(envelope.media);
      submitted.routine.revision++;
      return json(submitted);
    });
    expect(reorderTrack(draft, 'entry-a', 1)).toBe(true);
    const saved = await harness.library.save(draft, envelope);
    expect(saved.routine.tracks.map(track => track.id)).toEqual(['entry-b', 'entry-a']);
    expect(draft.tracks[1]).toBe(entries[0]); expect(draft.tracks[1]!.cues).toBe(entries[0]!.cues);
    expect(harness.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
    expect(harness.getTrackBlob.mock.calls).toEqual([['entry-b'], ['entry-a']]);
    expect(envelope).toEqual(previous);
    expect(await harness.library.open('routine-a', true)).toEqual(publication);
    expect(JSON.stringify(publication)).toBe(publishedBytes);
  });

  it.each([400, 412, 423])('keeps a rejected save draft intact and never retries status %s', async status => {
    const { envelope, blob } = await fixture();
    const original = structuredClone(envelope);
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async path => path === '/api/media/asset-a' ? json({ asset: envelope.media['entry-a'] })
      : json({ error: status === 412 ? 'revision_conflict' : status === 423 ? 'routine_locked' : 'invalid_routine_state' }, status));
    await expect(harness.library.save(envelope.routine, envelope)).rejects.toMatchObject({ status });
    expect(harness.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/media/asset-a', '/api/routines/routine-a']);
    expect(harness.fetcher.mock.calls[1]![1]!.method).toBe('PUT');
    expect(harness.cacheRoutine).not.toHaveBeenCalled();
    expect(envelope).toEqual(original);
    expect(harness.client.getContext().access).toBe('online');
  });

  it('uses the same quoted revision for save-and-lock, unlock, publish and delete', async () => {
    const { envelope, blob } = await fixture();
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async (input, options) => {
      if (input === '/api/media/asset-a') return json({ asset: envelope.media['entry-a'] });
      expect(new Headers(options!.headers).get('If-Match')).toBe('"1"');
      const result = structuredClone(envelope);
      result.routine.revision = 2;
      result.routine.published = String(input).endsWith('/publish');
      return json(result);
    });
    await harness.library.save(envelope.routine, envelope, 'lock');
    for (const action of ['unlock', 'publish', 'delete'] as const) await harness.library.command(envelope, action);
    expect(harness.fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/media/asset-a', '/api/routines/routine-a/lock', '/api/routines/routine-a/unlock', '/api/routines/routine-a/publish', '/api/routines/routine-a',
    ]);
    expect(harness.fetcher.mock.calls[1]![1]!.body).toBeDefined();
    expect(harness.fetcher.mock.calls.slice(2).every(([, options]) => options!.body === undefined)).toBe(true);
  });

  it('blocks locked content mutations and uses the cloud duplicate endpoint without uploading', async () => {
    const { envelope } = await fixture();
    const harness = libraryHarness();
    envelope.routine.locked = true;
    await expect(harness.library.save(envelope.routine, envelope)).rejects.toMatchObject({ status: 423 });
    await expect(harness.library.command(envelope, 'publish')).rejects.toMatchObject({ status: 423 });
    await expect(harness.library.command(envelope, 'delete')).rejects.toMatchObject({ status: 423 });
    expect(harness.fetcher).not.toHaveBeenCalled();
    const duplicate = structuredClone(envelope);
    duplicate.routine.id = 'new-routine';
    duplicate.routine.locked = false;
    duplicate.routine.tracks[0]!.id = 'new-entry';
    duplicate.routine.tracks[0]!.cues[0]!.id = 'new-cue';
    duplicate.media = { 'new-entry': envelope.media['entry-a']! };
    harness.fetcher.mockResolvedValue(json(duplicate, 201));
    expect(await harness.library.command(envelope, 'duplicate', true)).toEqual(duplicate);
    expect(String(harness.fetcher.mock.calls[0]![0])).toBe('/api/routines/routine-a/duplicate?published=true');
    expect(new Headers(harness.fetcher.mock.calls[0]![1]!.headers).has('If-Match')).toBe(false);
    expect(harness.getTrackBlob).not.toHaveBeenCalled();
  });

  it('downloads all chunks for published players and caches verified tracks before the routine', async () => {
    const { envelope, asset, blob } = await fixture(CLOUD_CHUNK_BYTES + 128, true);
    const harness = libraryHarness('player');
    harness.fetcher.mockImplementation(async input => {
      const path = String(input);
      if (path.startsWith('/api/routines/')) return json(envelope);
      expect(path).toContain('?routineId=routine-a');
      if (!path.includes('/chunks/')) return json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 2 });
      const index = Number(path.split('/chunks/')[1]!.split('?')[0]);
      return binary(blob.slice(index * CLOUD_CHUNK_BYTES, (index + 1) * CLOUD_CHUNK_BYTES));
    });
    expect(await harness.library.open('routine-a', true)).toEqual(envelope);
    expect(harness.cacheTrack).toHaveBeenCalledWith('entry-a', expect.any(Blob), asset.sha256);
    expect(await cloudHash(harness.cacheTrack.mock.calls[0]![1])).toBe(asset.sha256);
    expect(harness.cacheTrack.mock.invocationCallOrder[0]).toBeLessThan(harness.cacheRoutine.mock.invocationCallOrder[0]!);
    expect(harness.fetcher).toHaveBeenCalledTimes(4);
  });

  it('skips correct cached bytes and downloads incorrect bytes without deleting the existing entry', async () => {
    const { envelope, asset, blob } = await fixture();
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    await harness.library.download(envelope);
    expect(harness.fetcher).not.toHaveBeenCalled();
    expect(harness.cacheTrack).not.toHaveBeenCalled();
    harness.getTrackBlob.mockResolvedValue(new Blob([new Uint8Array(blob.size)], { type: blob.type }));
    harness.fetcher.mockResolvedValueOnce(json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 })).mockResolvedValueOnce(binary(blob));
    harness.cacheTrack.mockRejectedValueOnce(new Error('track_conflict'));
    await expect(harness.library.download(envelope)).rejects.toThrow('track_conflict');
    expect(harness.cacheRoutine).toHaveBeenCalledOnce();
  });

  it('does not cache damaged or incomplete media', async () => {
    const { envelope, asset, blob } = await fixture();
    const harness = libraryHarness();
    harness.fetcher.mockResolvedValueOnce(json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 }))
      .mockResolvedValueOnce(binary(new Blob([new Uint8Array(blob.size)])));
    await expect(harness.library.download(envelope)).rejects.toThrow('track_integrity_failed');
    expect(harness.cacheTrack).not.toHaveBeenCalled();
    expect(harness.cacheRoutine).not.toHaveBeenCalled();
  });

  it('fences uploads after an identity change during local blob reads', async () => {
    const { envelope, blob } = await fixture();
    const harness = libraryHarness();
    const read = pending<Blob>();
    harness.getTrackBlob.mockReturnValue(read.promise);
    const check = expect(harness.library.save(envelope.routine, null)).rejects.toMatchObject({ code: 'session_changed' });
    harness.client.admitSession(session('editor', 'different'));
    read.resolve(blob);
    await check;
    expect(harness.fetcher).not.toHaveBeenCalled();
  });

  it('cancels a chunk upload explicitly, aborts its staging ID, and never completes or saves it', async () => {
    const { envelope, blob, asset } = await fixture();
    const harness = libraryHarness();
    harness.getTrackBlob.mockResolvedValue(blob);
    const controller = new AbortController();
    harness.fetcher.mockImplementation(async input => {
      const path = String(input);
      if (path === '/api/media/uploads') return json({ id: 'upload-a', assetId: asset.id, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1, expiresAt: Date.now() + 60_000 });
      if (path.endsWith('/abort')) return json({ aborted: true });
      controller.abort();
      return new Promise<Response>(() => {});
    });
    await expect(harness.library.save(envelope.routine, null, 'save', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(harness.fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/media/uploads', '/api/media/uploads/upload-a/chunks/0', '/api/media/uploads/upload-a/abort',
    ]);
    expect(harness.client.getContext().access).toBe('online');
  });

  it('rejects sizes over 128 MiB before reading the binary', async () => {
    const { envelope } = await fixture();
    const harness = libraryHarness();
    const oversized = new Blob([], { type: 'audio/wav' });
    Object.defineProperty(oversized, 'size', { value: MAX_CLOUD_MEDIA_BYTES + 1 });
    const read = vi.spyOn(oversized, 'arrayBuffer');
    harness.getTrackBlob.mockResolvedValue(oversized);
    await expect(harness.library.save(envelope.routine, null)).rejects.toThrow('cloud_media_size');
    expect(read).not.toHaveBeenCalled();
    expect(harness.fetcher).not.toHaveBeenCalled();
  });

  it.each(['owner', 'editor', 'player'] as const)('enforces %s access without local-mutation fallbacks', async role => {
    const harness = libraryHarness(role);
    const { envelope } = await fixture();
    harness.fetcher.mockImplementation(async () => json({ routines: [] }));
    await harness.library.list(true);
    if (role === 'player') {
      await expect(harness.library.list(false)).rejects.toMatchObject({ status: 403 });
      await expect(harness.library.open('routine-a', false)).rejects.toMatchObject({ status: 403 });
      await expect(harness.library.save(envelope.routine, null)).rejects.toMatchObject({ status: 403 });
      await expect(harness.library.command(envelope, 'duplicate')).rejects.toMatchObject({ status: 403 });
      expect(harness.fetcher).toHaveBeenCalledOnce();
    } else await harness.library.list(false);
  });
});

describe('parallel cloud downloads', () => {
  async function deferredDownload(bytes = CLOUD_CHUNK_BYTES * 2 + 71) {
    const data = await fixture(bytes);
    const contents = new Uint8Array(bytes);
    for (let offset = 0; offset < bytes; offset += CLOUD_CHUNK_BYTES) {
      contents.fill(offset / CLOUD_CHUNK_BYTES + 1, offset, Math.min(bytes, offset + CLOUD_CHUNK_BYTES));
    }
    const blob = new Blob([contents], { type: data.blob.type });
    const asset = { ...data.asset, sha256: await cloudHash(blob) };
    const envelope = { ...data.envelope, media: { 'entry-a': asset } };
    const harness = libraryHarness();
    const requests: Array<{ path: string; index: number; signal: AbortSignal; response: ReturnType<typeof pending<Response>> }> = [];
    let active = 0;
    let maximum = 0;
    harness.fetcher.mockImplementation(async (input, options) => {
      const path = String(input);
      const route = new URL(path, 'https://cloud.invalid').pathname.split('/');
      if (!path.includes('/chunks/')) return json({ asset: { ...asset, id: route[3] },
        chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: Math.ceil(bytes / CLOUD_CHUNK_BYTES) });
      const signal = options!.signal!;
      const response = pending<Response>();
      requests.push({ path, index: Number(route[5]), signal, response });
      active++;
      maximum = Math.max(maximum, active);
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
      try { return await Promise.race([response.promise, cancelled]); }
      finally { active--; signal.removeEventListener('abort', cancel); }
    });
    const finish = (request: typeof requests[number]) => request.response.resolve(binary(
      blob.slice(request.index * CLOUD_CHUNK_BYTES, (request.index + 1) * CLOUD_CHUNK_BYTES)));
    return { ...harness, blob, asset, envelope, requests, finish, active: () => active, maximum: () => maximum };
  }

  it('keeps exactly two chunks outstanding and verifies ordered bytes and full SHA after out-of-order completion', async () => {
    const harness = await deferredDownload();
    const controller = new AbortController();
    const progress = vi.fn();
    const downloading = harness.library.download(harness.envelope, { signal: controller.signal, progress });
    const settled = Promise.allSettled([downloading]);
    try {
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      expect(harness.active()).toBe(2);
      expect(harness.requests.map(request => request.index)).toEqual([0, 1]);
      expect(progress).not.toHaveBeenCalled();
      harness.finish(harness.requests[1]!);
      await vi.waitFor(() => expect(harness.requests).toHaveLength(3));
      expect(harness.active()).toBe(2);
      harness.finish(harness.requests[2]!);
      await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(2));
      expect(harness.cacheTrack).not.toHaveBeenCalled();
      expect(harness.cacheRoutine).not.toHaveBeenCalled();
      harness.finish(harness.requests[0]!);
      await downloading;
      expect(harness.maximum()).toBe(2);
      expect(progress.mock.calls).toEqual([
        [CLOUD_CHUNK_BYTES, harness.asset.bytes],
        [CLOUD_CHUNK_BYTES + 71, harness.asset.bytes],
        [harness.asset.bytes, harness.asset.bytes],
      ]);
      const cached = harness.cacheTrack.mock.calls[0]![1];
      expect(cached.type).toBe(harness.asset.contentType);
      expect(Buffer.from(await cached.arrayBuffer()).equals(Buffer.from(await harness.blob.arrayBuffer()))).toBe(true);
      expect(await cloudHash(cached)).toBe(harness.asset.sha256);
      expect(harness.cacheTrack).toHaveBeenCalledWith('entry-a', expect.any(Blob), harness.asset.sha256);
      expect(harness.cacheTrack.mock.invocationCallOrder[0]).toBeLessThan(harness.cacheRoutine.mock.invocationCallOrder[0]!);
    } finally { controller.abort(); await settled; }
  });

  it.each(['same library', 'separate libraries', 'separate clients'] as const)(
    'shares two chunk slots between music and filler downloads using %s', async scope => {
      const harness = await deferredDownload();
      const other = scope === 'separate clients' ? libraryHarness() : harness;
      if (other !== harness) other.fetcher.mockImplementation(harness.fetcher);
      const library = scope === 'same library' ? harness.library : createCloudLibrary(other);
      const recording = { id: 'recording-b', name: 'Synthetic filler', duration: 8, asset: { ...harness.asset, id: 'asset-b' } };
      const controller = new AbortController();
      const operations = [harness.library.downloadTracks(harness.envelope.routine.tracks, harness.envelope.media, { signal: controller.signal }),
        library.ensureFiller(recording, { signal: controller.signal })];
      const settled = Promise.allSettled(operations);
      try {
        await vi.waitFor(() => expect(harness.fetcher.mock.calls.filter(([path]) => !String(path).includes('/chunks/'))).toHaveLength(2));
        expect(harness.requests).toHaveLength(2);
        expect(harness.active()).toBe(2);
        for (let index = 0; index < 6; index++) {
          await vi.waitFor(() => expect(harness.requests.length).toBeGreaterThan(index));
          expect(harness.active()).toBeLessThanOrEqual(2);
          harness.finish(harness.requests[index]!);
        }
        await Promise.all(operations);
        expect(harness.maximum()).toBe(2);
        expect(harness.requests).toHaveLength(6);
        expect(harness.cacheTrack).toHaveBeenCalledOnce();
        expect(other.cacheFiller).toHaveBeenCalledOnce();
        expect(await cloudHash(other.cacheFiller.mock.calls[0]![1])).toBe(recording.asset.sha256);
      } finally { controller.abort(); await settled; }
    });

  it('holds both chunk slots until response bodies finish streaming', async () => {
    const harness = await deferredDownload(CLOUD_CHUNK_BYTES + 71);
    const controller = new AbortController();
    const progress = vi.fn();
    const downloading = harness.library.download(harness.envelope, { signal: controller.signal, progress });
    const settled = Promise.allSettled([downloading]);
    const other = createCloudLibrary(harness);
    const recording = { id: 'recording-b', name: 'Queued filler', duration: 8, asset: { ...harness.asset, id: 'asset-b' } };
    let fillerResult: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
      for (const request of harness.requests) {
        request.response.resolve(new Response(new ReadableStream<Uint8Array>({ start(body) { bodies.push(body); } }),
          { headers: { 'Content-Type': 'application/octet-stream' } }));
      }
      await vi.waitFor(() => expect(harness.active()).toBe(0));
      const filling = other.ensureFiller(recording, { signal: controller.signal });
      fillerResult = filling.catch(error => error);
      await vi.waitFor(() => expect(harness.fetcher.mock.calls.filter(([path]) => !String(path).includes('/chunks/'))).toHaveLength(2));
      expect(harness.requests).toHaveLength(2);
      expect(progress).not.toHaveBeenCalled();
      for (let index = 0; index < bodies.length; index++) {
        bodies[index]!.enqueue(new Uint8Array(await harness.blob.slice(index * CLOUD_CHUNK_BYTES, (index + 1) * CLOUD_CHUNK_BYTES).arrayBuffer()));
        bodies[index]!.close();
      }
      await vi.waitFor(() => expect(harness.requests).toHaveLength(4));
      harness.finish(harness.requests[2]!);
      harness.finish(harness.requests[3]!);
      await Promise.all([downloading, filling]);
      expect(harness.cacheTrack).toHaveBeenCalledOnce();
      expect(harness.cacheFiller).toHaveBeenCalledOnce();
    } finally { controller.abort(); await Promise.all([settled, fillerResult]); }
  });

  it('reports cumulative actual bytes across downloaded and cached playlist entries', async () => {
    const harness = await deferredDownload();
    const cachedTrack = { ...harness.envelope.routine.tracks[0]!, id: 'cached-entry' };
    harness.getTrackBlob.mockImplementation(async id => id === cachedTrack.id ? harness.blob : undefined);
    const controller = new AbortController();
    const progress = vi.fn();
    const downloading = harness.library.downloadTracks([...harness.envelope.routine.tracks, cachedTrack],
      { ...harness.envelope.media, [cachedTrack.id]: harness.asset }, { signal: controller.signal, progress });
    const settled = Promise.allSettled([downloading]);
    try {
      // The already-cached entry resolves before any network request is even dispatched (cache
      // hits are checked up front, in order, so parallel network slots are only spent on misses).
      await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      harness.finish(harness.requests[1]!);
      await vi.waitFor(() => expect(harness.requests).toHaveLength(3));
      harness.finish(harness.requests[2]!);
      await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(3));
      harness.finish(harness.requests[0]!);
      await downloading;
      expect(progress.mock.calls).toEqual([
        [harness.asset.bytes, harness.asset.bytes * 2], [harness.asset.bytes + CLOUD_CHUNK_BYTES, harness.asset.bytes * 2],
        [harness.asset.bytes + CLOUD_CHUNK_BYTES + 71, harness.asset.bytes * 2], [harness.asset.bytes * 2, harness.asset.bytes * 2],
      ]);
      expect(harness.requests).toHaveLength(3);
      expect(harness.cacheTrack).toHaveBeenCalledOnce();
    } finally { controller.abort(); await settled; }
  });

  it('cancels the sibling and drains workers on a first-chunk length failure without fetching remaining chunks', async () => {
    const harness = await deferredDownload();
    const controller = new AbortController();
    const progress = vi.fn();
    const downloading = harness.library.download(harness.envelope, { signal: controller.signal, progress });
    const settled = Promise.allSettled([downloading]);
    try {
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      harness.requests[0]!.response.resolve(binary(harness.blob.slice(0, CLOUD_CHUNK_BYTES - 1)));
      await expect(downloading).rejects.toThrow('track_integrity_failed');
      expect(harness.requests[1]!.signal.aborted).toBe(true);
      expect(harness.active()).toBe(0);
      expect(harness.requests.map(request => request.index)).toEqual([0, 1]);
      expect(progress).not.toHaveBeenCalled();
      expect(harness.cacheTrack).not.toHaveBeenCalled();
      expect(harness.cacheRoutine).not.toHaveBeenCalled();
      expect(harness.client.getContext().access).toBe('online');
    } finally { controller.abort(); await settled; }
  });

  it('rejects full-length corrupted chunks at the whole-asset SHA check without caching', async () => {
    const harness = await deferredDownload(CLOUD_CHUNK_BYTES + 71);
    const controller = new AbortController();
    const downloading = harness.library.download(harness.envelope, { signal: controller.signal });
    const settled = Promise.allSettled([downloading]);
    try {
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      harness.requests[1]!.response.resolve(binary(new Blob([new Uint8Array(71)])));
      harness.finish(harness.requests[0]!);
      await expect(downloading).rejects.toThrow('track_integrity_failed');
      expect(harness.cacheTrack).not.toHaveBeenCalled();
      expect(harness.cacheRoutine).not.toHaveBeenCalled();
      expect(harness.active()).toBe(0);
    } finally { controller.abort(); await settled; }
  });

  it.each(['abort', 'identity', '401'] as const)('fences active parallel responses after %s without cache or selection writes', async interruption => {
    const harness = await deferredDownload();
    const controller = new AbortController();
    const progress = vi.fn();
    const downloading = harness.library.download(harness.envelope, { signal: controller.signal, progress });
    const settled = Promise.allSettled([downloading]);
    const selectionWrites = appMocks.setActiveRoutine.mock.calls.length;
    try {
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      if (interruption === 'abort') controller.abort();
      else if (interruption === 'identity') {
        harness.client.admitSession(session('editor', 'another-instructor'));
        harness.finish(harness.requests[0]!);
      } else harness.requests[0]!.response.resolve(json({ error: 'session_expired' }, 401));
      await expect(downloading).rejects.toMatchObject({ code: interruption === 'abort' ? 'cancelled'
        : interruption === 'identity' ? 'session_changed' : 'signin_required' });
      expect(harness.requests[1]!.signal.aborted).toBe(true);
      harness.finish(harness.requests[1]!);
      await settled;
      expect(harness.requests).toHaveLength(2);
      expect(harness.active()).toBe(0);
      expect(progress).not.toHaveBeenCalled();
      expect(harness.cacheTrack).not.toHaveBeenCalled();
      expect(harness.cacheFiller).not.toHaveBeenCalled();
      expect(harness.cacheRoutine).not.toHaveBeenCalled();
      expect(appMocks.setActiveRoutine).toHaveBeenCalledTimes(selectionWrites);
      expect(harness.client.getContext().access).toBe(interruption === '401' ? 'signin-required' : 'online');
    } finally { controller.abort(); await settled; }
  });

  it.each(['abort', 'identity', 'logout', 'expiry', '401'] as const)(
    'never dispatches queued chunk requests after %s and releases their slots', async interruption => {
      const harness = await deferredDownload();
      const blocker = new AbortController();
      const blocking = harness.library.download(harness.envelope, { signal: blocker.signal });
      const blocked = Promise.allSettled([blocking]);
      const queued = libraryHarness();
      let now = Date.now();
      queued.fetcher.mockImplementation(async (input, options) => String(input) === '/api/routines'
        ? json({ error: 'session_expired' }, 401) : harness.fetcher(input, options));
      const client = createCloudClient({ fetch: queued.fetcher, now: () => now });
      client.admitSession(session());
      const library = createCloudLibrary({ ...queued, client });
      const controller = new AbortController();
      const recovery = new AbortController();
      const progress = vi.fn();
      const recording = { id: 'recording-b', name: 'Queued filler', duration: 8, asset: { ...harness.asset, id: 'asset-b' } };
      let queuedResult: Promise<unknown> | undefined;
      let recovered: Promise<unknown> | undefined;
      const selectionWrites = appMocks.setActiveRoutine.mock.calls.length;
      try {
        await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
        const downloading = library.ensureFiller(recording, { signal: controller.signal, progress });
        queuedResult = downloading.catch(error => error);
        await vi.waitFor(() => expect(queued.fetcher).toHaveBeenCalledOnce());
        expect(harness.requests).toHaveLength(2);
        if (interruption === 'abort') {
          controller.abort();
          expect(await queuedResult).toMatchObject({ code: 'cancelled' });
          expect(harness.active()).toBe(2);
        } else if (interruption === 'identity') client.admitSession(session('editor', 'another-instructor'));
        else if (interruption === 'logout') client.invalidate();
        else if (interruption === 'expiry') now += 3_600_001;
        else await expect(client.request('/api/routines')).rejects.toMatchObject({ status: 401 });
        blocker.abort();
        await blocked;
        expect(await queuedResult).toMatchObject({ code: interruption === 'abort' ? 'cancelled'
          : ['identity', 'logout'].includes(interruption) ? 'session_changed' : 'signin_required' });
        expect(harness.requests).toHaveLength(2);
        expect(harness.active()).toBe(0);
        expect(queued.fetcher.mock.calls.some(([path]) => String(path).includes('/chunks/'))).toBe(false);
        expect(progress).not.toHaveBeenCalled();
        expect(queued.cacheTrack).not.toHaveBeenCalled();
        expect(queued.cacheFiller).not.toHaveBeenCalled();
        expect(queued.cacheRoutine).not.toHaveBeenCalled();
        expect(appMocks.setActiveRoutine).toHaveBeenCalledTimes(selectionWrites);
        const retry = harness.library.download(harness.envelope, { signal: recovery.signal });
        recovered = retry.catch(error => error);
        await vi.waitFor(() => expect(harness.requests).toHaveLength(4));
        expect(harness.active()).toBe(2);
        for (let index = 2; index < 5; index++) {
          await vi.waitFor(() => expect(harness.requests.length).toBeGreaterThan(index));
          harness.finish(harness.requests[index]!);
        }
        await retry;
        expect(harness.cacheTrack).toHaveBeenCalledOnce();
        expect(harness.cacheRoutine).toHaveBeenCalledOnce();
        expect(harness.maximum()).toBe(2);
        expect(harness.active()).toBe(0);
      } finally { controller.abort(); blocker.abort(); recovery.abort(); await Promise.all([blocked, queuedResult, recovered]); }
    });

  it('avoids every media request when all music and filler bytes are already hash-verified in cache', async () => {
    const harness = await deferredDownload();
    const recording = { id: 'recording-b', name: 'Cached filler', duration: 8, asset: { ...harness.asset, id: 'asset-b' } };
    harness.envelope.routine.filler = { ...harness.envelope.routine.filler, mode: 'hold', sound: 'recording', recording };
    harness.getTrackBlob.mockResolvedValue(harness.blob);
    harness.getFillerBlob.mockResolvedValue(harness.blob);
    const progress = vi.fn();
    await harness.library.download(harness.envelope, { progress });
    expect(harness.fetcher).not.toHaveBeenCalled();
    expect(harness.cacheTrack).not.toHaveBeenCalled();
    expect(harness.cacheFiller).not.toHaveBeenCalled();
    expect(harness.cacheRoutine).toHaveBeenCalledOnce();
    expect(progress.mock.calls).toEqual([[harness.asset.bytes, harness.asset.bytes * 2], [harness.asset.bytes * 2, harness.asset.bytes * 2]]);
  });
});

describe('explicit household replacement', () => {
  it('opens revisions A then B in actual Chromium immutable cache without changing publication A', async () => {
    const { createServer } = await import('../frontend/node_modules/vite/dist/node/index.js');
    const { chromium } = await import('@playwright/test');
    const { resolve } = await import('node:path');
    const server = await createServer({ configFile: resolve('frontend/vite.config.ts'), root: resolve('frontend'),
      server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'cloud-cache-regression', configureServer(instance) {
        instance.middlewares.use('/cache-regression', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><title>Cache regression</title><script type="module">
            import * as offline from '/src/offline.ts';
            import * as library from '/src/cloud-library.ts';
            import * as client from '/src/cloud-client.ts';
            globalThis.cacheTest = { ...offline, ...library, ...client };
          </script>`);
        });
      } }] });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${server.resolvedUrls!.local[0]}cache-regression`);
      await page.waitForFunction(() => 'cacheTest' in globalThis);
      const data = await fixture();
      const result = await page.evaluate(async envelope => {
        const api = (globalThis as unknown as { cacheTest: typeof import('../frontend/src/offline')
          & typeof import('../frontend/src/cloud-library') & typeof import('../frontend/src/cloud-client') }).cacheTest;
        const oldBytes = api.generateDemoWav(2, 100, 'soft');
        const newBytes = api.generateDemoWav(2, 120, 'drums');
        const oldAsset = { id: 'asset-a', sha256: await api.cloudHash(oldBytes), bytes: oldBytes.size, contentType: 'audio/wav' };
        const newAsset = { id: 'asset-b', sha256: await api.cloudHash(newBytes), bytes: newBytes.size, contentType: 'audio/wav' };
        envelope.routine.tracks[0]!.duration = 2;
        envelope.media['entry-a'] = oldAsset;
        const source = structuredClone(envelope.routine);
        const publication = structuredClone(envelope); publication.routine.published = true;
        const original = JSON.stringify(source);
        let saved = envelope;
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
          headers: { 'Content-Type': 'application/json' } });
        const client = api.createCloudClient({ fetch: async (input, options) => {
          const path = String(input);
          if (path === '/api/media/uploads') return json({ id: 'upload-b', assetId: 'asset-b',
            chunkBytes: api.CLOUD_CHUNK_BYTES, chunkCount: 1, expiresAt: Date.now() + 60_000 }, 201);
          if (path === '/api/media/uploads/upload-b/chunks/0') return json({ index: 0, sha256: newAsset.sha256 });
          if (path === '/api/media/uploads/upload-b/complete') return json(newAsset);
          if (path.startsWith('/api/routines/')) {
            if (options?.method === 'PUT') {
              saved = JSON.parse(String(options.body)) as CloudRoutine;
              const entryId = saved.routine.tracks[0]!.id;
              if (entryId === 'entry-a' || Object.keys(saved.media).join() !== entryId
                || saved.media[entryId]!.sha256 !== newAsset.sha256) throw new Error('incorrect_saved_entry_mapping');
              saved.routine.revision = 2;
            }
            return json(path.includes('published=true') ? publication : saved);
          }
          const asset = path.includes('asset-b') ? newAsset : oldAsset;
          const blob = path.includes('asset-b') ? newBytes : oldBytes;
          if (path.includes('/chunks/')) return new Response(blob, { headers: { 'Content-Length': String(blob.size) } });
          return json({ asset, chunkBytes: api.CLOUD_CHUNK_BYTES, chunkCount: 1 });
        } });
        client.admitSession({ user: { id: 'editor', username: 'editor', role: 'editor', authVersion: 1 },
          csrfToken: 'fixture', expiresAt: Date.now() + 60_000 });
        const reader = api.createCloudLibrary({ client });
        await reader.open(source.id, true);
        const writer = api.createCloudLibrary({ client, getTrackBlob: async () => newBytes });
        const updated = await writer.save(source, envelope);
        await reader.open(source.id, false);
        const reopened = await reader.open(source.id, true);
        const newId = updated.routine.tracks[0]!.id;
        return { newId, oldHash: await api.cloudHash((await api.getTrackBlob('entry-a'))!),
          newHash: await api.cloudHash((await api.getTrackBlob(newId))!), expectedOld: oldAsset.sha256,
          expectedNew: newAsset.sha256, sourceUnchanged: JSON.stringify(source) === original,
          publicationUnchanged: JSON.stringify(reopened) === JSON.stringify(publication) };
      }, data.envelope);
      expect(result.newId).not.toBe('entry-a'); expect(result.oldHash).toBe(result.expectedOld);
      expect(result.newHash).toBe(result.expectedNew); expect(result.newHash).not.toBe(result.oldHash);
      expect(result.sourceUnchanged).toBe(true); expect(result.publicationUnchanged).toBe(true);
    } finally { await browser.close(); await server.close(); }
  }, 60_000);

  it.each([true, false])('fetches the current head and confirms its name/revision before a conditional save, same ID=%s', async sameId => {
    const { envelope, blob } = await fixture();
    envelope.routine.revision = 7;
    const source = structuredClone(envelope.routine);
    source.id = sameId ? envelope.routine.id : 'local-only'; source.revision = 2; source.name = 'Unsaved local changes';
    source.filler.gain = 0.65; source.tracks[0]!.gain = 1.25;
    const before = structuredClone(source);
    const harness = libraryHarness(); harness.getTrackBlob.mockResolvedValue(blob);
    harness.fetcher.mockImplementation(async (path, options) => {
      if (path === '/api/media/asset-a') return json({ asset: envelope.media['entry-a'] });
      expect(path).toBe('/api/routines/routine-a');
      if (options?.method !== 'PUT') return json(envelope);
      expect(new Headers(options.headers).get('If-Match')).toBe('"7"');
      const body = JSON.parse(String(options.body)) as CloudRoutine;
      expect(body.routine).toEqual({ ...before, id: envelope.routine.id, revision: 7 });
      expect(body.media).toEqual(envelope.media);
      return json({ ...body, routine: { ...body.routine, revision: 8 } });
    });
    const confirm = vi.fn((head: CloudRoutine, draft: Routine) => {
      expect(head.routine).toEqual(envelope.routine); expect(draft).toEqual(before); return true;
    });
    const result = await harness.library.replace(source, envelope.routine.id, confirm);
    expect(result?.routine).toEqual({ ...before, id: envelope.routine.id, revision: 8 });
    expect(source).toEqual(before); expect(envelope.routine.revision).toBe(7);
    expect(confirm).toHaveBeenCalledOnce(); expect(harness.fetcher).toHaveBeenCalledTimes(3);
    expect(harness.cacheRoutine).not.toHaveBeenCalled(); expect(harness.cacheTrack).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'locked', 'conflict', 'unavailable'] as const)('keeps caller content and identity after %s without forced retries', async reason => {
    const { envelope, blob } = await fixture();
    const source = structuredClone(envelope.routine); source.name = 'Keep this local work';
    const before = structuredClone(source);
    const harness = libraryHarness(); harness.getTrackBlob.mockResolvedValue(blob);
    if (reason === 'locked') envelope.routine.locked = true;
    harness.fetcher.mockImplementation(async (path, options) => {
      if (reason === 'unavailable') return json({ error: 'storage_unavailable' }, 503);
      if (path === '/api/media/asset-a') return json({ asset: envelope.media['entry-a'] });
      if (options?.method === 'PUT') return json({ error: 'routine_conflict' }, 412);
      return json(envelope);
    });
    const confirm = vi.fn(() => reason !== 'cancel');
    const operation = harness.library.replace(source, envelope.routine.id, confirm);
    if (reason === 'cancel') await expect(operation).resolves.toBeNull();
    else await expect(operation).rejects.toMatchObject({ status: reason === 'locked' ? 423 : reason === 'conflict' ? 412 : 503 });
    expect(source).toEqual(before); expect(harness.cacheRoutine).not.toHaveBeenCalled();
    expect(harness.fetcher).toHaveBeenCalledTimes(reason === 'conflict' ? 3 : 1);
    expect(confirm).toHaveBeenCalledTimes(['cancel', 'conflict'].includes(reason) ? 1 : 0);
  });

  it('uploads new bytes for a reused entry ID instead of retaining its old asset', async () => {
    const harness = await uploadHarness();
    const head = structuredClone(harness.envelope);
    head.media['entry-a'] = { ...harness.asset, id: 'old-asset', sha256: '0'.repeat(64) };
    const existing = harness.fetcher.getMockImplementation()!;
    harness.fetcher.mockImplementation(async (path, options) => {
      if (path === '/api/routines/routine-a' && options?.method !== 'PUT') return json(head);
      if (options?.method === 'PUT' && path === '/api/routines/routine-a') {
        const body = JSON.parse(String(options.body)) as CloudRoutine;
        const entryId = body.routine.tracks[0]!.id;
        expect(entryId).not.toBe('entry-a');
        expect(Object.keys(body.media)).toEqual([entryId]);
        expect(body.media[entryId]).toEqual(harness.asset);
        return json({ ...body, routine: { ...body.routine, revision: 2 } });
      }
      return existing(path, options);
    });
    const result = await harness.library.replace(harness.envelope.routine, 'routine-a', () => true);
    const savedId = result!.routine.tracks[0]!.id;
    expect(savedId).not.toBe('entry-a'); expect(result!.media[savedId]).toEqual(harness.asset);
    expect(harness.start).toHaveBeenCalledOnce(); expect(harness.envelope.routine.tracks[0]!.id).toBe('entry-a');
    expect(head.media['entry-a']!.id).toBe('old-asset');
  });

  it('does not let player roles fetch replacement heads or confirm writes', async () => {
    const harness = libraryHarness('player'); const { envelope } = await fixture(); const confirm = vi.fn(() => true);
    await expect(harness.library.replace(envelope.routine, 'routine-a', confirm)).rejects.toMatchObject({ status: 403 });
    await expect(harness.library.readHead('routine-a')).rejects.toMatchObject({ status: 403 });
    expect(confirm).not.toHaveBeenCalled(); expect(harness.fetcher).not.toHaveBeenCalled();
  });
});

describe('cloud UI policy and active selection', () => {
  it.each(['audio/x-wav', 'audio/wave', 'audio/vnd.wave'])('normalizes prepared WAV alias %s', type => {
    expect(canonicalAudioType(type)).toBe('audio/wav');
  });

  it('validates complete envelopes and rejects missing or extra entry descriptors', async () => {
    const { envelope } = await fixture();
    expect(parseCloudRoutine(envelope)).toEqual(envelope);
    expect(() => parseCloudRoutine({ ...envelope, media: {} })).toThrow('cloud_invalid_response');
    expect(() => parseCloudRoutine({ ...envelope, media: { ...envelope.media, extra: envelope.media['entry-a'] } })).toThrow('cloud_invalid_response');
  });

  it('binds a nonsecret pointer to exact identity and publication/revision, purging mismatched owners', () => {
    const store = storage();
    const owner = session().user;
    const selected = { id: 'routine-a', revision: 7, published: true };
    rememberCloudSelection(store, owner, selected);
    expect(recalledCloudSelection(store, owner)).toEqual({ ...selected, cached: true });
    expect(store.getItem(hostedCloudSelectionKey)).not.toMatch(/csrf|password|media|token/);
    expect(recalledCloudSelection(store, { ...owner, authVersion: 2 })).toBeNull();
    expect(store.getItem(hostedCloudSelectionKey)).toBeNull();
    rememberCloudSelection(store, session('player').user, { ...selected, published: false });
    expect(recalledCloudSelection(store, session('player').user)).toBeNull();
  });

  it('allows expired-session editor drafts but disallows cached, published and player mutation paths', () => {
    const selected = { id: 'routine-a', revision: 1, published: false };
    const context = { user: session().user, access: 'signin-required' as const, expiresAt: null };
    expect(canEditCloudDraft(context, selected)).toBe(true);
    expect(canEditCloudDraft(context, { ...selected, published: true })).toBe(false);
    expect(canEditCloudDraft(context, { ...selected, cached: true })).toBe(false);
    expect(canEditCloudDraft({ ...context, user: session('player').user }, null)).toBe(false);
  });

  it('distinguishes 400 state/asset errors, 412 revisions and 423 locks without displaying raw server text', () => {
    expect(cloudErrorMessage(new CloudRequestError('cloud_http_error', 400, 'invalid_routine_state'))).toBe(t('cloudHeadRequired'));
    expect(cloudErrorMessage(new CloudRequestError('cloud_http_error', 400, 'invalid_asset'))).toBe(t('cloudIntegrity'));
    expect(cloudErrorMessage(new CloudRequestError('cloud_http_error', 412, 'revision_conflict'))).toBe(t('cloudConflict'));
    expect(cloudErrorMessage(new CloudRequestError('cloud_http_error', 423, 'routine_locked'))).toBe(t('cloudLocked'));
    expect(cloudErrorMessage(new CloudRequestError('cloud_http_error', 400, '<private-detail>'))).toBe(t('cloudValidation'));
  });

  it('stops and navigates only after the user confirms sign-in', () => {
    const order: string[] = [];
    const stop = () => { order.push('stop'); };
    const navigate = () => { order.push('navigate'); };
    expect(confirmCloudNavigation(() => false, stop, navigate)).toBe(false);
    expect(order).toEqual([]);
    expect(confirmCloudNavigation(() => true, stop, navigate)).toBe(true);
    expect(order).toEqual(['stop', 'navigate']);
  });
});

const appNodes: AppNode[] = [];
class AppNode extends EventTarget {
  tag: string;
  className: string;
  textContent: string;
  children: AppNode[] = [];
  disabled = false;
  hidden = false;
  checked = false;
  title = '';
  value = '';
  files: File[] = [];
  open = false;
  type = '';
  tabIndex = 0;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  style = { setProperty: vi.fn(), width: '' };
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (...names: string[]) => { names.forEach(name => this.classList.toggle(name, true)); },
    remove: (...names: string[]) => { names.forEach(name => this.classList.toggle(name, false)); },
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      const enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
      return enabled;
    },
  };
  constructor(tag: string, className = '', textContent = '') {
    super(); this.tag = tag; this.className = className; this.textContent = textContent; appNodes.push(this);
  }
  get ownerDocument() { return document; }
  get firstChild() { return this.children[0] ?? null; }
  append(...children: AppNode[]) { for (const child of children) { child.remove(); this.children.push(child); } }
  after(...children: AppNode[]) {
    const parent = appNodes.find(node => node.children.includes(this));
    if (!parent) return;
    const next = parent.children[parent.children.indexOf(this) + 1] ?? null;
    for (const child of children) parent.insertBefore(child, next);
  }
  insertBefore(child: AppNode, next: AppNode | null) {
    if (child === next) return child;
    child.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child); return child;
  }
  replaceChildren(...children: AppNode[]) { this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll(selector: string): AppNode[] {
    return this.children.flatMap(child => [...(child.tag === selector || (selector.startsWith('.') && child.classList.contains(selector.slice(1))) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click', { cancelable: true })); }
  focus() {}
  select() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { for (const node of appNodes) node.children = node.children.filter(child => child !== this); }
}

async function bootCloudApp(options: { role?: CloudSession['user']['role']; local?: boolean; cached?: boolean;
  access?: 'offline' | 'signin-required'; earlyEdit?: boolean; unready?: boolean; cachedClasses?: ClassSetup[]; cachedRoutines?: Routine[];
  pendingWorkingCopy?: boolean; readinessDeferred?: ReturnType<typeof pending<{ ready: boolean; missing: string[] }>>;
  syncDeferred?: ReturnType<typeof pending<void>> } = {}) {
  vi.resetModules();
  vi.clearAllMocks();
  appNodes.length = 0;
  vi.stubEnv('VITE_HOSTED_PILOT', 'true');
  vi.stubEnv('PROD', false);
  const role = options.role ?? 'editor';
  const data = await fixture(128, role === 'player');
  const account = session(role);
  const store = storage();
  store.setItem(hostedUserKey, hostedIdentityMarker(account.user));
  if (options.cached) rememberCloudSelection(store, account.user, { id: data.envelope.routine.id, revision: 1, published: data.envelope.routine.published });
  const root = new AppNode('div');
  const owner = Object.assign(new EventTarget(), { documentElement: new AppNode('html'), body: root,
    createElement: (tag: string) => new AppNode(tag), querySelector: () => root });
  const navigate = vi.fn();
  const platform = Object.assign(new EventTarget(), { localStorage: store, location: { assign: navigate } });
  vi.stubGlobal('document', owner);
  vi.stubGlobal('window', platform);
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('HTMLElement', AppNode);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('OfflineAudioContext', class {});
  const blobs = new Map<string, Blob>([['entry-a', data.blob]]);
  const cached = new Map<string, Routine>();
  const working = new Map<string, RoutineWorkingCopy>();
  if (options.pendingWorkingCopy) working.set(data.envelope.routine.id, {
    envelope: structuredClone(data.envelope), localVersion: 1, cloudBaseRevision: data.envelope.routine.revision,
    pendingCloud: true, savedAt: Date.now(),
  });
  appMocks.listClassSetups.mockResolvedValue([]); appMocks.listMusicPlaylists.mockResolvedValue([]);
  appMocks.listCachedClassSetups.mockResolvedValue(options.cachedClasses ?? []); appMocks.getActiveRoutineSelection.mockResolvedValue(null);
  appMocks.listRoutinePublications.mockResolvedValue([]);
  appMocks.listCloudRoutines.mockImplementation(async () => structuredClone(options.cachedRoutines ?? [...cached.values()]));
  appMocks.getRoutineWorkingCopy.mockImplementation(async id => structuredClone(working.get(id) ?? null));
  appMocks.listRoutineWorkingCopies.mockImplementation(async () => structuredClone([...working.values()]));
  appMocks.saveRoutineWorkingCopy.mockImplementation(async (envelope: CloudRoutine, options) => {
    const previous = working.get(envelope.routine.id);
    if (options.expectedLocalVersion !== (previous?.localVersion ?? null)) throw new Error('routine_conflict');
    const copy = { envelope: structuredClone(envelope), localVersion: (previous?.localVersion ?? 0) + 1,
      cloudBaseRevision: options.cloudBaseRevision, pendingCloud: options.cloud, savedAt: Date.now(),
      ...(previous?.cloudAttempt ? { cloudAttempt: previous.cloudAttempt } : {}) };
    working.set(envelope.routine.id, copy); return structuredClone(copy);
  });
  appMocks.recordRoutineSyncAttempt.mockImplementation(async (id, localVersion, envelope, baseRevision) => {
    const current = working.get(id);
    if (!current || current.localVersion !== localVersion || current.cloudBaseRevision !== baseRevision) throw new Error('routine_conflict');
    current.cloudAttempt = { envelope: structuredClone(envelope), localVersion, baseRevision };
  });
  appMocks.acknowledgeRoutineWorkingCopy.mockImplementation(async (id, localVersion, envelope) => {
    const current = working.get(id);
    if (!current?.cloudAttempt || current.cloudAttempt.localVersion !== localVersion || !sameSavedContent(envelope, current.cloudAttempt.envelope)) throw new Error('routine_conflict');
    current.cloudBaseRevision = envelope.routine.revision;
    if (current.localVersion === localVersion) { current.envelope = structuredClone(envelope); current.pendingCloud = false; }
    else current.envelope.routine.revision = envelope.routine.revision;
    delete current.cloudAttempt;
    cached.set(id, structuredClone(envelope.routine));
  });
  appMocks.reconcileRoutineWorkingCopy.mockImplementation(async envelope => {
    const current = working.get(envelope.routine.id);
    if (!current) return null;
    if (current.pendingCloud || current.cloudAttempt) throw new Error('routine_conflict');
    if (envelope.routine.revision < current.envelope.routine.revision) throw new Error('routine_conflict');
    current.envelope = structuredClone(envelope); current.cloudBaseRevision = envelope.routine.revision;
    return structuredClone(current);
  });
  appMocks.deleteRoutineWorkingCopy.mockImplementation(async (id, localVersion) => {
    if (working.get(id)?.localVersion !== localVersion) throw new Error('routine_conflict');
    working.delete(id);
  });
  if (options.cached) cached.set(data.envelope.routine.id, structuredClone(data.envelope.routine));
  appMocks.getRoutine.mockResolvedValue(options.local ? structuredClone(data.envelope.routine) : null);
  const localStartup = pending<Routine | null>();
  if (options.earlyEdit) appMocks.getRoutine.mockReturnValueOnce(localStartup.promise);
  appMocks.listRoutines.mockResolvedValue(options.local ? [structuredClone(data.envelope.routine)] : []);
  appMocks.listFillerRecordings.mockResolvedValue([]);
  appMocks.getFillerRecordingBlob.mockResolvedValue(undefined);
  appMocks.cacheFillerRecording.mockResolvedValue(undefined);
  appMocks.removeFillerRecording.mockResolvedValue(undefined);
  appMocks.preview.playFiller.mockResolvedValue(undefined);
  appMocks.getCloudRoutine.mockImplementation(async (id: string, revision?: number, published?: boolean) =>
    options.cachedRoutines?.find(value => value.id === id && value.revision === revision && value.published === published) ?? cached.get(id) ?? null);
  appMocks.getTrackBlob.mockImplementation(async (id: string) => blobs.get(id));
  appMocks.cacheCloudTrack.mockImplementation(async (id: string, blob: Blob) => { blobs.set(id, blob); });
  appMocks.cacheCloudRoutine.mockImplementation(async (routine: Routine) => { cached.set(routine.id, structuredClone(routine)); });
  appMocks.getReadiness.mockResolvedValue(options.unready ? { ready: false, missing: ['entry-a'] } : { ready: true, missing: [] });
  if (options.readinessDeferred) appMocks.getReadiness.mockReturnValueOnce(options.readinessDeferred.promise);
  appMocks.filler.mockResolvedValue({});
  let state: PlayerState = { status: 'idle', trackIndex: 0, elapsed: 0, duration: 30, classElapsed: 0, currentCue: '', nextCue: '',
    nextCueIn: null, fillerRemaining: null, holding: false, ducked: false, beepsMuted: false, error: null, flashSignal: 0 };
  let emit: (state: PlayerState) => void = () => {};
  appMocks.player.subscribe.mockImplementation((listener: (value: PlayerState) => void) => { emit = listener; listener(state); return () => {}; });
  appMocks.player.load.mockImplementation(async () => { state = { ...state, status: 'idle' }; emit(state); });
  appMocks.player.play.mockImplementation(async () => { state = { ...state, status: 'playing' }; emit(state); });
  appMocks.player.pause.mockImplementation(() => { state = { ...state, status: 'paused' }; emit(state); });
  const server = { envelope: data.envelope, authStatus: 200, writeStatus: 200, fillers: [] as FillerRecording[], classes: [] as ClassSetup[],
    analyses: new Map<string, FillerAnalysis>(), metadata: new Map<string, LibraryMetadata>() };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === '/api/auth/session') return server.authStatus === 200 ? json(account) : json({ error: 'signin_required' }, server.authStatus);
    if (path === '/api/library/songs') return json({ items: [] });
    if (path === '/api/library/fillers') return json({ items: server.fillers.map(recording => ({ id: recording.id, kind: 'filler',
      asset: recording.asset, recording, metadata: server.metadata.get(recording.id) ?? { revision: 0, title: '', artist: '' } })) });
    if (/^\/api\/library\/fillers\/[^/]+\/intake$/.test(path)) {
      const id = path.split('/')[4]!; const facts = JSON.parse(String(init?.body));
      const metadata = { revision: 1, title: '', artist: '', ...facts };
      server.metadata.set(id, metadata); return json({ metadata });
    }
    if (/^\/api\/library\/fillers\/[^/]+\/metadata$/.test(path)) {
      const id = path.split('/')[4]!; const previous = server.metadata.get(id) ?? { revision: 0, title: '', artist: '' };
      if (init?.method === 'PUT') server.metadata.set(id, { ...previous, ...JSON.parse(String(init.body)), revision: previous.revision + 1 });
      return json({ metadata: server.metadata.get(id) ?? previous });
    }
    if (/^\/api\/library\/fillers\/[^/]+\/usage$/.test(path)) return json({ references: [], complete: true });
    if (path === '/api/fillers' && init?.method === 'POST') {
      if (server.writeStatus !== 200) return json({ error: 'storage_unavailable' }, server.writeStatus);
      const recording = { ...JSON.parse(String(init.body)), id: 'household-filler' } as FillerRecording;
      server.fillers.push(recording);
      return json(recording, 201);
    }
    if (path === '/api/fillers') return json({ fillers: server.fillers });
    if (/^\/api\/fillers\/[^/]+\/analysis$/.test(path)) {
      const id = path.split('/')[3]!;
      if (init?.method === 'PUT') {
        const analysis = JSON.parse(String(init.body)) as FillerAnalysis;
        if (server.fillers.find(recording => recording.id === id)?.asset.sha256 !== analysis.sha256) return json({ error: 'invalid_analysis' }, 400);
        server.analyses.set(id, analysis);
      }
      return json({ analysis: server.analyses.get(id) ?? null });
    }
    if (path.startsWith('/api/fillers/') && init?.method === 'DELETE') {
      server.fillers = server.fillers.filter(recording => recording.id !== path.split('/').at(-1));
      return json({ archived: true });
    }
    if (path === '/api/media/uploads') return json({ id: 'upload-a', assetId: data.asset.id, chunkBytes: CLOUD_CHUNK_BYTES,
      chunkCount: 1, expiresAt: Date.now() + 60_000 });
    if (path.includes('/chunks/') && init?.method === 'PUT') return json({ index: 0, sha256: await cloudHash(init.body as Blob) });
    if (path.endsWith('/complete')) return json(data.asset);
    if (path === '/api/routines' && init?.method === 'POST') return json({ error: 'routine_exists' }, 409);
    if (path === '/api/routines' || path === '/api/routines?published=true') return json({ routines: [{ ...server.envelope.routine, published: path.includes('?') }] });
    if (path === '/api/classes' || path === '/api/classes?published=true') return json({ classes: server.classes.filter(value => value.published === path.includes('?')) });
    if (path === '/api/playlists' || path === '/api/playlists?published=true') return json({ playlists: [] });
    if (init?.method && init.method !== 'GET') {
      if (server.writeStatus !== 200) return json({ error: 'revision_conflict' }, server.writeStatus);
      const next = init.body ? JSON.parse(String(init.body)) as CloudRoutine : structuredClone(server.envelope);
      next.routine.revision++;
      next.routine.locked = path.endsWith('/lock');
      next.routine.published = path.endsWith('/publish');
      server.envelope = structuredClone(next);
      server.envelope.routine.published = false;
      if (path === '/api/routines/routine-a' && init.method === 'PUT') await options.syncDeferred?.promise;
      return json(next);
    }
    if (path.startsWith('/api/routines/')) return json(server.envelope);
    if (path.includes('/chunks/')) return binary(data.blob);
    return json({ asset: data.asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 });
  });
  vi.stubGlobal('fetch', fetcher);
  const { cloudClient } = await import('../frontend/src/cloud-client');
  if (options.access) cloudClient.admitLocal(account.user, options.access, () => {});
  else cloudClient.admitSession(account);
  await import('../frontend/src/main');
  if (options.earlyEdit) { button(t('edit')).click(); localStartup.resolve(null); }
  await new Promise<void>(resolve => setImmediate(resolve));
  if (!options.readinessDeferred && !options.syncDeferred) {
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
  }
  return { server, fetcher, data, store, navigate, cached, platform, working };
}

function button(title: string): AppNode {
  const routine = appNodes.find(item => item.className === 'edit-panel');
  const node = routine?.querySelectorAll('button').find(item => item.title === title && !item.hidden)
    ?? routine?.querySelectorAll('button').find(item => item.title === title)
    ?? appNodes.find(item => item.tag === 'button' && item.title === title && !item.hidden)
    ?? appNodes.find(item => item.tag === 'button' && item.title === title);
  if (!node) throw new Error(`Missing button: ${title}`);
  return node;
}

async function cloudClick(title: string): Promise<void> {
  const target = button(title);
  await vi.waitFor(() => expect(target.disabled).toBe(false));
  target.click();
  await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
  await new Promise<void>(resolve => setImmediate(resolve));
  await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
}

async function enterTeach(): Promise<void> {
  button(t('teach')).click();
  await new Promise<void>(resolve => setImmediate(resolve));
  await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
}

async function openCloudRoutine(): Promise<void> {
  button(t('edit')).click();
  await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
  await cloudClick(t('cloudRefresh'));
  const selector = appNodes.find(node => node.tag === 'select' && node.children.some(child => child.value === 'routine-a'))!;
  selector.value = 'routine-a';
  selector.dispatchEvent(new Event('change'));
  await cloudClick(t('cloudOpen'));
}

async function openManagedFillers(): Promise<AppNode> {
  button(t('settings')).click();
  await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
  const manager = appNodes.find(node => node.classList.contains('media-library'))!;
  manager.open = true; manager.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(button(t('refreshAudio')).disabled).toBe(false));
  manager.querySelectorAll('button').find(node => node.textContent === t('managedFillers'))!.click();
  await vi.waitFor(() => expect(button(t('refreshAudio')).disabled).toBe(false));
  return manager;
}

describe('main hosted orchestration with synthetic DOM and player', () => {
  it('deletes another cloud chooser row by exact ID with head proof while preserving a same-name local draft', async () => {
    const app = await bootCloudApp({ local: true });
    const draft = structuredClone(appMocks.editor.routine); const loadCount = appMocks.player.load.mock.calls.length;
    const other = structuredClone(app.data.envelope); other.routine.id = 'other-routine'; other.routine.revision = 5;
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation(async (input, init) => {
      if (input === '/api/routines') return json({ routines: [other.routine] });
      if (input === '/api/routines/other-routine') return json({ ...other, routine: { ...other.routine, revision: init?.method === 'DELETE' ? 6 : 5 } });
      return handler(input, init);
    });
    appMocks.getRoutine.mockImplementation(async id => id === other.routine.id ? null : app.data.envelope.routine);
    await cloudClick(t('cloudRefresh')); button(t('openDifferent')).click();
    const chooser = appNodes.find(node => node.classList.contains('routine-chooser'))!;
    const target = chooser.querySelectorAll('.routine-library-row').find(row => row.querySelectorAll('button').some(node => node.dataset.cloudRoutineDelete === 'true'))!;
    const remove = target.querySelectorAll('button').find(node => node.title === t('deleteRoutine'))!;
    vi.mocked(confirm).mockReturnValueOnce(false); remove.click();
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    expect(app.fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    remove.click(); await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    const deletes = app.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deletes).toHaveLength(1); expect(deletes[0]![0]).toBe('/api/routines/other-routine');
    expect(new Headers(deletes[0]![1]?.headers).get('If-Match')).toBe('"5"');
    expect(appMocks.editor.routine).toEqual(draft); expect(appMocks.player.load).toHaveBeenCalledTimes(loadCount);
    expect(appMocks.clearActiveRoutine).not.toHaveBeenCalled(); expect(appMocks.player.stop).not.toHaveBeenCalled();
  });

  it.each(['player', 'offline', 'signin-required'] as const)('does not expose an actionable cloud chooser delete for %s', async access => {
    const app = await bootCloudApp(access === 'player' ? { role: 'player' } : { local: true, access, cachedRoutines: [(await fixture()).envelope.routine] });
    if (access === 'player') button(t('edit')).click(); else button(t('openDifferent')).click();
    const rows = appNodes.find(node => node.className === 'routine-library-rows')!;
    const deletes = rows.querySelectorAll('button').filter(node => node.dataset.cloudRoutineDelete === 'true');
    expect(deletes.every(node => node.disabled)).toBe(true);
    for (const node of deletes) node.click();
    expect(app.fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('opens a single modal chooser and closes it without changing the draft or prepared audio', async () => {
    await bootCloudApp(); await openCloudRoutine(); await enterTeach();
    const routine = structuredClone(appMocks.editor.routine);
    const loads = appMocks.player.load.mock.calls.length;
    const library = appNodes.find(node => node.className === 'routine-library')!;
    const dialog = appNodes.find(node => node.classList.contains('routine-chooser'))!;
    button(t('openDifferent')).click();
    expect(dialog.open).toBe(true); expect(dialog.children).toContain(library);
    expect(appNodes.filter(node => node.children.includes(library))).toEqual([dialog]);
    expect(document.documentElement.classList.contains('routine-chooser-open')).toBe(true);
    const search = appNodes.find(node => node.attributes.get('aria-label') === t('searchRoutines'))!;
    search.value = 'No such routine'; search.dispatchEvent(new Event('input'));
    expect(library.querySelector('.chooser-empty')?.textContent).toBe(t('noRoutineMatches'));
    expect(appMocks.editor.routine).toEqual(routine);
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false); expect(library.hidden).toBe(true);
    expect(document.documentElement.classList.contains('routine-chooser-open')).toBe(false);
    expect(appMocks.player.load).toHaveBeenCalledTimes(loads);
    expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
  });

  it('keeps one Save and groups metadata and secondary commands without header import actions', async () => {
    await bootCloudApp(); await openCloudRoutine();
    const header = appNodes.find(node => node.className === 'editor-heading')!;
    const toolbar = appNodes.find(node => node.classList.contains('editor-actions'))!;
    const identity = header.querySelector('.draft-identity')!;
    expect(identity.children.map(node => node.textContent)).toContain('ID routine-a');
    expect(header.querySelector('.recovery-library')).not.toBeNull();
    expect(toolbar.children).toContain(button(t('saveChanges')));
    expect(toolbar.children).not.toContain(button(t('import')));
    expect(toolbar.children).not.toContain(button(t('existingAudio')));
    const more = toolbar.querySelector('.command-menu-items')!;
    expect(more.children).toContain(button(t('cloudPublish')));
    expect(more.children).not.toContain(button(t('cloudReplace')));
    expect(button(t('localPublish')).hidden).toBe(true);
    expect(button(t('localDelete')).hidden).toBe(true);
    expect(button(t('cloudDelete')).hidden).toBe(false);
  });

  it('shows only local deletion for a new draft and blocks a disabled Add track trigger', async () => {
    await bootCloudApp(); button(t('newRoutine')).click();
    expect(button(t('cloudDelete')).hidden).toBe(true);
    expect(button(t('cloudPublish')).hidden).toBe(true);
    expect(button(t('localDelete')).hidden).toBe(false);
    const trigger = appNodes.find(node => node.className === 'edit-panel')!.querySelectorAll('summary')
      .find(node => node.attributes.get('aria-label') === t('addTrack'))!;
    appMocks.editor.routine!.locked = true; appMocks.editor.changed!();
    expect(trigger.attributes.get('aria-disabled')).toBe('true');
    const event = new Event('click', { cancelable: true }); trigger.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels a dirty modal routine switch without saving or replacing the current draft', async () => {
    const app = await bootCloudApp(); await openCloudRoutine();
    appMocks.editor.routine!.name = 'Unsaved choreography'; appMocks.editor.changed!();
    const before = structuredClone(appMocks.editor.routine);
    app.server.envelope.routine.name = 'Newer Cloud head'; app.server.envelope.routine.revision++;
    await cloudClick(t('cloudRefresh')); button(t('openDifferent')).click();
    const chooser = appNodes.find(node => node.classList.contains('routine-chooser'))!;
    chooser.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: 'Newer Cloud head' }))!.click();
    const confirmation = appNodes.find(node => node.tag === 'dialog' && node.open && node.attributes.get('aria-label') === t('switchRoutine'))!;
    expect(confirmation).toBeDefined(); confirmation.querySelectorAll('button').find(node => node.title === t('cancel'))!.click();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(chooser.open).toBe(true); expect(appMocks.editor.routine).toEqual(before);
    expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
    button(t('closeChooser')).click();
  });

  it('keeps the chooser and current routine when opening another Cloud revision fails', async () => {
    const app = await bootCloudApp(); await openCloudRoutine();
    const before = structuredClone(appMocks.editor.routine);
    const remembered = app.store.getItem(hostedCloudSelectionKey);
    app.server.envelope.routine.name = 'Unavailable head'; app.server.envelope.routine.revision++;
    await cloudClick(t('cloudRefresh'));
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((input, init) => String(input).startsWith('/api/routines/routine-a')
      ? Promise.resolve(json({ error: 'routine_not_found' }, 404)) : handler(input, init));
    button(t('openDifferent')).click();
    const chooser = appNodes.find(node => node.classList.contains('routine-chooser'))!;
    chooser.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: 'Unavailable head' }))!.click();
    await vi.waitFor(() => expect(chooser.querySelector('.chooser-feedback')!.textContent).toBe(t('cloudNotFound')));
    expect(chooser.open).toBe(true); expect(appMocks.editor.routine).toEqual(before);
    expect(app.store.getItem(hostedCloudSelectionKey)).toBe(remembered);
    button(t('closeChooser')).click();
  });

  it.each(['save', 'discard'] as const)('preserves dirty routine content after %s when the target fails to open', async decision => {
    const app = await bootCloudApp(); await openCloudRoutine();
    appMocks.editor.routine!.name = 'Keep this choreography'; appMocks.editor.changed!();
    const before = structuredClone(appMocks.editor.routine!);
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((input, init) => {
      if (String(input) === '/api/routines' && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(json({ routines: [{ ...app.server.envelope.routine, id: 'unavailable', name: 'Unavailable target' }] }));
      }
      if (String(input).startsWith('/api/routines/unavailable')) return Promise.resolve(json({ error: 'routine_not_found' }, 404));
      return handler(input, init);
    });
    await cloudClick(t('cloudRefresh')); button(t('openDifferent')).click();
    const chooser = appNodes.find(node => node.classList.contains('routine-chooser'))!;
    chooser.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: 'Unavailable target' }))!.click();
    const confirmation = appNodes.find(node => node.tag === 'dialog' && node.open && node.attributes.get('aria-label') === t('switchRoutine'))!;
    confirmation.querySelectorAll('button').find(node => node.title === t(decision === 'save' ? 'saveChanges' : 'discard'))!.click();
    await vi.waitFor(() => expect(chooser.querySelector('.chooser-feedback')!.textContent).toBe(t('cloudNotFound')));
    expect(chooser.open).toBe(true);
    expect(appMocks.editor.routine!.id).toBe(before.id);
    expect(appMocks.editor.routine!.name).toBe(before.name);
    expect(appMocks.editor.routine!.tracks).toEqual(before.tracks);
    if (decision === 'save') expect(app.working.get(before.id)?.envelope.routine.name).toBe(before.name);
    else expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
    button(t('closeChooser')).click();
  });

  const pickExistingAudio = async (app: Awaited<ReturnType<typeof bootCloudApp>>) => {
    const asset = { ...app.data.asset, id: 'catalog-track' };
    const availability = { status: 200 };
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((input, init) => {
      if (String(input) === '/api/library/songs') return Promise.resolve(json({ items: [{ id: asset.id, kind: 'song', asset,
        metadata: { revision: 0, title: 'Catalog song', artist: '', duration: 30 } }] }));
      if (String(input) === '/api/media/catalog-track') return Promise.resolve(availability.status === 404
        ? json({ error: 'asset_not_found' }, 404) : json({ asset, chunkBytes: CLOUD_CHUNK_BYTES, chunkCount: 1 }));
      return handler(input, init);
    });
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      const node = new AppNode(tag);
      if (tag === 'audio') {
        const audio = Object.assign(node, { duration: 30, load: vi.fn(), onloadedmetadata: null as (() => void) | null });
        Object.defineProperty(audio, 'src', { set: () => queueMicrotask(() => audio.onloadedmetadata?.()) });
      }
      return node as unknown as HTMLElement;
    });
    button(t('existingAudio')).click();
    await vi.waitFor(() => expect(appNodes.find(node => node.className === 'audio-library-rows')?.querySelectorAll('input')).toHaveLength(1));
    const checkbox = appNodes.find(node => node.className === 'audio-library-rows')!.querySelectorAll('input')[0]!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    button(t('addSelectedAudio')).click();
    await vi.waitFor(() => expect(appMocks.editor.routine!.tracks).toHaveLength(2));
    expect(appMocks.editor.routine!.tracks[1]!.id).not.toBe(asset.id);
    return { asset, availability };
  };

  it.each(['save', 'lock'] as const)('review picker %s reuses the remote asset with zero upload POSTs and no hidden class', async action => {
    const app = await bootCloudApp(); await openCloudRoutine();
    const { asset } = await pickExistingAudio(app);
    await cloudClick(t(action === 'lock' ? 'lock' : 'cloudSave'));
    const entry = appMocks.editor.routine!.tracks[1]!;
    expect(app.server.envelope.media[entry.id]).toEqual(asset);
    expect(app.server.envelope.routine.locked).toBe(action === 'lock');
    expect(app.working.get('routine-a')!.pendingCloud).toBe(false);
    expect(appMocks.saveRoutineWorkingCopy).toHaveBeenCalledOnce();
    expect(app.fetcher.mock.calls.some(([input]) => String(input).includes('/uploads'))).toBe(false);
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([input]) => String(input))).toEqual(['/api/routines/routine-a']);
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([input]) => String(input)))
      .toEqual(action === 'lock' ? ['/api/routines/routine-a/lock'] : []);
    expect(appMocks.saveClassSetup).not.toHaveBeenCalled(); expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it.each(['save', 'lock'] as const)('review picker %s fails on a missing remote asset without upload or locking', async action => {
    const app = await bootCloudApp(); await openCloudRoutine();
    const { availability } = await pickExistingAudio(app); availability.status = 404;
    await cloudClick(t(action === 'lock' ? 'lock' : 'cloudSave'));
    expect(app.working.get('routine-a')).toMatchObject({ pendingCloud: true, envelope: { routine: { locked: false } } });
    expect(appMocks.editor.routine!.tracks).toHaveLength(2); expect(appMocks.editor.routine!.locked).toBe(false);
    expect(app.fetcher.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toEqual([]);
    expect(app.fetcher.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(appMocks.saveClassSetup).not.toHaveBeenCalled(); expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'] as const)('review Save and lock leaves a failed synchronization %s locally saved and unlocked', async failure => {
    const app = await bootCloudApp(); await openCloudRoutine();
    await pickExistingAudio(app);
    if (failure === 'write') app.server.writeStatus = 503;
    else {
      const handler = app.fetcher.getMockImplementation()!;
      app.fetcher.mockImplementation((input, init) => String(input) === '/api/routines/routine-a' && init?.method === 'GET'
        ? Promise.resolve(json({ error: 'storage_unavailable' }, 503)) : handler(input, init));
    }
    await cloudClick(t('lock'));
    expect(app.working.get('routine-a')).toMatchObject({ pendingCloud: true, envelope: { routine: { locked: false } } });
    expect(appMocks.editor.routine!.locked).toBe(false); expect(app.server.envelope.routine.locked).toBe(false);
    expect(app.fetcher.mock.calls.some(([input]) => String(input).endsWith('/lock') || String(input).includes('/uploads'))).toBe(false);
    expect(appMocks.saveClassSetup).not.toHaveBeenCalled();
  });

  it('review Save and lock preserves matching prepared playback without loading or playing again', async () => {
    const app = await bootCloudApp(); await openCloudRoutine(); await enterTeach();
    button(t('play')).click(); await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    await cloudClick(t('lock'));
    expect(appMocks.editor.routine!.locked).toBe(true); expect(app.server.envelope.routine.locked).toBe(true);
    expect(appMocks.player.load).toHaveBeenCalledOnce(); expect(appMocks.player.play).toHaveBeenCalledOnce();
    expect(appMocks.player.stop).not.toHaveBeenCalled(); expect(appMocks.player.pause).not.toHaveBeenCalled();
  });

  it.each(['owner', 'editor', 'player'] as const)('review cold offline %s chooser enumerates unremembered cached classes with published role scope', async role => {
    const setup: ClassSetup = { schemaVersion: 1, id: 'unremembered-class', name: 'Cached publication', revision: 3, locked: false, published: true,
      routine: { id: 'routine-a', revision: 1, published: true }, crossfade: 1,
      before: { mode: 'hold', seconds: 17, bpm: 100, sound: 'soft' } };
    const cachedDraft = { ...structuredClone(setup), id: 'cached-draft', name: 'Cached draft', published: false };
    const app = await bootCloudApp({ role, access: 'offline', cachedClasses: [setup, cachedDraft] });
    const rows = appNodes.find(node => node.className === 'routine-library-rows')!;
    const titles = rows.querySelectorAll('button').map(node => node.title);
    expect(titles).toContain(t('openRoutine', { name: setup.name }));
    expect(titles.includes(t('openRoutine', { name: cachedDraft.name }))).toBe(role !== 'player');
    expect(app.store.getItem(classSelectionStorageKey)).toBeNull();
    const routine = { ...structuredClone(app.data.envelope.routine), published: true };
    appMocks.getPreparedClass.mockResolvedValue({ setup, routine, audio: { crossfade: 1, before: setup.before } });
    rows.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: setup.name }))!.click();
    await vi.waitFor(() => expect(appMocks.player.load).toHaveBeenCalledOnce()); await enterTeach();
    expect(appMocks.getPreparedClass).toHaveBeenCalledWith(setup.id, 3, 'cloud', true);
    expect(app.fetcher).not.toHaveBeenCalled(); expect(appMocks.player.play).not.toHaveBeenCalled();
    if (role === 'player') {
      expect(appMocks.editor.routine).toEqual(routine); expect(appMocks.editor.canEdit!()).toBe(false);
      expect(appMocks.player.load).toHaveBeenCalledWith(routine, { crossfade: 1, before: setup.before });
    } else {
      expect(appMocks.editor.routine!.id).not.toBe(routine.id);
      expect(appMocks.editor.routine!.sequence?.before).toEqual(setup.before);
    }
    expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled(); expect(appMocks.saveClassSetup).not.toHaveBeenCalled();
  });

  it('applies detected confidence and manual filler BPM through the hash-bound Cloud API without saving the routine', async () => {
    const app = await bootCloudApp({ local: true });
    const recording: FillerRecording = { id: 'analysis-filler', name: 'Synthetic loop', duration: 8, asset: app.data.asset };
    app.server.fillers = [recording]; appMocks.getFillerRecordingBlob.mockResolvedValue(app.data.blob);
    const { detectTrackBpm } = await import('../frontend/src/bpm');
    vi.mocked(detectTrackBpm).mockResolvedValue({ bpm: 120, firstBeat: 0, confidence: 0.6 });
    const original = structuredClone(appMocks.editor.routine);
    button(t('settings')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const panel = appNodes.find(node => node.classList.contains('filler-library'))!;
    const select = panel.querySelectorAll('select')[0]!; select.value = recording.id; select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    button(t('fillerAnalyzeBpm')).click();
    await vi.waitFor(() => expect(button(t('fillerApplyBpm')).disabled).toBe(false));
    expect(panel.querySelectorAll('p').some(node => node.textContent.includes('Confidence: 60%'))).toBe(true);
    expect(app.server.analyses.size).toBe(0);
    button(t('fillerApplyBpm')).click();
    await vi.waitFor(() => expect(app.server.analyses.get(recording.id)).toEqual({ bpm: 120, confidence: 0.6,
      analyzer: 'detectTrackBpm', sha256: recording.asset.sha256 }));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const bpm = panel.querySelectorAll('label').find(node => node.textContent === t('fillerBpmMetadata'))!.children[0]!;
    bpm.value = '60'; bpm.dispatchEvent(new Event('input'));
    expect(app.server.analyses.get(recording.id)!.bpm).toBe(120);
    button(t('fillerApplyBpm')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    expect(app.server.analyses.get(recording.id)).toEqual({ bpm: 60, analyzer: 'manual', sha256: recording.asset.sha256 });
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    expect(bpm.value).toBe('60');
    const puts = app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts.every(([path, init]) => path === `/api/fillers/${recording.id}/analysis`
      && new Headers(init?.headers).has('X-CSRF-Token') && JSON.parse(String(init?.body)).sha256 === recording.asset.sha256)).toBe(true);
    expect(app.store.getItem(`fitness-filler-analysis:${recording.asset.sha256}`)).toBeNull();
    expect(appMocks.editor.routine).toEqual(original); expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
    app.server.analyses.set(recording.id, { bpm: 90, analyzer: 'manual', sha256: 'b'.repeat(64) });
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    expect(bpm.value).toBe(''); expect(button(t('fillerApplyBpm')).disabled).toBe(true);
    expect(panel.querySelector('.filler-library-feedback')!.textContent).not.toBe(t('fillerBpmSaved'));
  });

  it('review Refresh retries a saved local revision after revalidation and reconciles a lost create without another POST', async () => {
    const app = await bootCloudApp({ local: true });
    const envelope = structuredClone(app.data.envelope); envelope.routine.revision = 9;
    app.working.set(envelope.routine.id, { envelope, localVersion: 3, cloudBaseRevision: null, pendingCloud: true, savedAt: 1 });
    let created: CloudRoutine | null = null;
    const lostResponse = pending<void>();
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation(async (input, init) => {
      if (String(input) === '/api/routines/routine-a' && init?.method === 'GET') {
        return created ? json(created) : json({ error: 'routine_not_found' }, 404);
      }
      if (String(input) === '/api/routines' && init?.method === 'POST') {
        created = JSON.parse(String(init.body)) as CloudRoutine;
        expect(created.routine.revision).toBe(1);
        await lostResponse.promise;
        throw new TypeError('Lost create response');
      }
      return handler(input, init);
    });
    button(t('cloudRefresh')).click();
    await vi.waitFor(() => expect(app.working.get(envelope.routine.id)?.cloudAttempt?.envelope.routine.revision).toBe(1));
    expect(button(t('cloudRefresh')).disabled).toBe(true);
    lostResponse.resolve();
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    await vi.waitFor(() => expect(appNodes.find(node => node.classList.contains('notice'))?.classList.contains('notice-error')).toBe(true));
    expect(app.working.get(envelope.routine.id)).toMatchObject({ pendingCloud: true, cloudBaseRevision: null, localVersion: 3 });
    const reads = app.fetcher.mock.calls.length;
    await cloudClick(t('cloudRefresh'));
    await vi.waitFor(() => expect(app.working.get(envelope.routine.id)?.pendingCloud).toBe(false));
    expect(app.working.get(envelope.routine.id)).toMatchObject({ localVersion: 3, cloudBaseRevision: 1, envelope: { routine: { id: envelope.routine.id, revision: 1 } } });
    expect(app.fetcher.mock.calls.filter(([path, init]) => path === '/api/routines' && init?.method === 'POST')).toHaveLength(1);
    expect(app.fetcher.mock.calls.slice(reads).every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it('review Close awaits both source pointers and Refresh never restores a closed working copy', async () => {
    const app = await bootCloudApp(); await openCloudRoutine(); await cloudClick(t('cloudSave'));
    const before = structuredClone(app.working.get('routine-a'));
    const closing = pending<void>(); appMocks.clearActiveRoutine.mockReturnValueOnce(closing.promise);
    app.store.setItem(classSelectionStorageKey, 'synthetic-reference');
    button(t('closeRoutine')).click();
    const dialog = appNodes.filter(node => node.tag === 'dialog' && node.open).at(-1)!;
    dialog.querySelectorAll('button').find(node => node.title === t('discard'))!.click();
    expect(appMocks.clearActiveRoutine).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true); expect(app.store.getItem(hostedCloudSelectionKey)).not.toBeNull();
    expect(appMocks.player.unload).not.toHaveBeenCalled();
    closing.resolve();
    await vi.waitFor(() => expect(dialog.open).toBe(false));
    expect(app.store.getItem(hostedCloudSelectionKey)).toBeNull(); expect(app.store.getItem(classSelectionStorageKey)).toBeNull();
    expect(button(t('newRoutine')).hidden).toBe(false);
    expect(appNodes.find(node => node.className === 'routine-library')!.hidden).toBe(false);
    await cloudClick(t('cloudRefresh'));
    expect(button(t('newRoutine')).hidden).toBe(false); expect(app.store.getItem(hostedCloudSelectionKey)).toBeNull();
    expect(app.working.get('routine-a')).toEqual(before); expect(appMocks.deleteRoutineWorkingCopy).not.toHaveBeenCalled();
    expect(appMocks.player.unload).toHaveBeenCalledOnce(); expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it('review pending Open Draft preserves local content and never rebases an unrelated remote head', async () => {
    const app = await bootCloudApp(); await openCloudRoutine(); await cloudClick(t('cloudSave'));
    app.server.writeStatus = 412; appMocks.editor.routine!.name = 'Pending local choreography'; appMocks.editor.changed!();
    await cloudClick(t('cloudSave'));
    const before = structuredClone(app.working.get('routine-a')!);
    app.server.envelope.routine.revision += 2; app.server.envelope.routine.name = 'Unrelated remote';
    const writes = app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
    button(t('cloudOpenDraft')).dispatchEvent(new Event('click')); await enterTeach();
    expect(app.working.get('routine-a')).toEqual(before);
    expect(appMocks.editor.routine!.name).toBe('Pending local choreography');
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(writes);
  });

  it('cold cached chooser keeps a newer draft and older publication independently selectable without reconciliation', async () => {
    const { envelope } = await fixture();
    const publication = { ...structuredClone(envelope.routine), name: 'Older publication', revision: 3, published: true };
    const newer = { ...structuredClone(envelope.routine), name: 'Newer draft', revision: 8 };
    const app = await bootCloudApp({ access: 'offline', cachedRoutines: [newer, publication] });
    vi.stubGlobal('navigator', { onLine: false });
    const rows = appNodes.find(node => node.className === 'routine-library-rows')!;
    expect(rows.children).toHaveLength(2);
    expect(rows.querySelectorAll('.library-row-name').map(node => node.textContent)).toEqual(['Newer draft', 'Older publication']);
    rows.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: publication.name }))!.click();
    await vi.waitFor(() => expect(appMocks.editor.routine).toEqual(publication));
    expect(appMocks.getCloudRoutine).toHaveBeenLastCalledWith(publication.id, 3, true);
    expect(appMocks.editor.canEdit!()).toBe(false); expect(appMocks.reconcileRoutineWorkingCopy).not.toHaveBeenCalled();
    expect(app.working.size).toBe(0); expect(app.fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(app.store.getItem(hostedCloudSelectionKey)!)).toMatchObject({ id: publication.id, revision: 3, published: true });
    expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it('review clean Cloud read refreshes local CAS content and does not let a mirror hide the newer Cloud row', async () => {
    const app = await bootCloudApp(); await openCloudRoutine(); await cloudClick(t('cloudSave'));
    const localVersion = app.working.get('routine-a')!.localVersion;
    app.server.envelope.routine.name = 'Authoritative newer head'; app.server.envelope.routine.revision++;
    await cloudClick(t('cloudRefresh')); button(t('openDifferent')).click();
    const rows = appNodes.find(node => node.className === 'routine-library-rows')!;
    const row = rows.children.find(node => node.querySelector('.library-row-name')?.textContent === 'Authoritative newer head')!;
    expect(row).toBeDefined(); row.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: 'Authoritative newer head' }))!.click();
    await vi.waitFor(() => expect(appMocks.editor.routine!.name).toBe('Authoritative newer head'));
    expect(app.working.get('routine-a')).toMatchObject({ localVersion, cloudBaseRevision: app.server.envelope.routine.revision });
    await cloudClick(t('cloudSave'));
    expect(appMocks.saveRoutineWorkingCopy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ expectedLocalVersion: localVersion }));
  });

  it('review player legacy row remains a full read-only published class on cold and offline cached opens', async () => {
    const app = await bootCloudApp({ role: 'player' });
    const setup: ClassSetup = { schemaVersion: 1, id: 'legacy-published', name: 'Published class', revision: 3, locked: false, published: true,
      routine: { id: 'routine-a', revision: 1, published: true }, crossfade: 1,
      before: { mode: 'hold', seconds: 17, bpm: 100, sound: 'soft' }, after: { mode: 'hold', seconds: 19, bpm: 120, sound: 'drums' } };
    app.server.classes = [setup];
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((path, init) => path === '/api/classes/legacy-published/prepare?published=true&revision=3'
      ? Promise.resolve(json({ setup, routine: app.server.envelope })) : handler(path, init));
    await cloudClick(t('cloudRefresh'));
    const open = () => appNodes.find(node => node.className === 'routine-library-rows')!.querySelectorAll('button')
      .find(node => node.title === t('openRoutine', { name: setup.name }))!.click();
    open(); await vi.waitFor(() => expect(appMocks.player.load).toHaveBeenCalled()); await enterTeach();
    expect(appMocks.player.load).toHaveBeenLastCalledWith(app.server.envelope.routine, { crossfade: 1, before: setup.before, after: setup.after });
    expect(appMocks.editor.routine!.id).toBe('routine-a'); expect(appMocks.editor.routine!.published).toBe(true);
    expect(appMocks.editor.canEdit!()).toBe(false); expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
    expect(appMocks.player.play).not.toHaveBeenCalled();
    appMocks.getPreparedClass.mockResolvedValue({ setup, routine: app.server.envelope.routine, audio: { crossfade: 1, before: setup.before, after: setup.after } });
    (await import('../frontend/src/cloud-client')).cloudClient.admitLocal(session('player').user, 'offline', () => {});
    const requests = app.fetcher.mock.calls.length; button(t('openDifferent')).click(); open(); await enterTeach();
    expect(app.fetcher).toHaveBeenCalledTimes(requests);
    expect(appMocks.getPreparedClass).toHaveBeenCalledWith(setup.id, 3, 'cloud', true);
    expect(appMocks.editor.canEdit!()).toBe(false); expect(appMocks.player.play).not.toHaveBeenCalled();
  });
  it.each(['owner', 'editor', 'player'] as const)('loads household routines at startup using the admitted %s session without another sign-in', async role => {
    const app = await bootCloudApp({ role });
    const path = role === 'player' ? '/api/routines?published=true' : '/api/routines';
    expect(app.fetcher.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
    expect(app.fetcher.mock.calls.some(([url]) => url === '/api/auth/session')).toBe(false);
    const selector = appNodes.find(node => node.tag === 'select' && node.attributes.get('aria-label') === t('cloudRoutines'))!;
    expect(selector.children.some(option => option.value === 'routine-a')).toBe(true);
    const signin = appNodes.find(node => node.tag === 'a' && node.textContent === t('cloudSignIn'))!;
    expect(signin.hidden).toBe(true);
    signin.dispatchEvent(new Event('click', { cancelable: true }));
    expect(app.navigate).not.toHaveBeenCalled();
    expect(appMocks.player.load).not.toHaveBeenCalled();
    expect(appMocks.cacheCloudTrack).not.toHaveBeenCalled();
    button(t('edit')).click();
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    expect(app.fetcher.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
    const checkbox = (label: string) => appNodes.find(node => node.tag === 'label' && node.textContent === label)!.children[0]!;
    expect(checkbox(t('householdFilter')).disabled).toBe(false);
    expect(checkbox(t(role === 'player' ? 'cloudPublications' : 'draft')).disabled).toBe(false);
  });

  it('shows reauthentication only after expiry, not while offline or forbidden, without stopping prepared audio', async () => {
    const app = await bootCloudApp({ local: true });
    await enterTeach(); button(t('play')).click();
    const signin = appNodes.find(node => node.tag === 'a' && node.textContent === t('cloudSignIn'))!;
    const { cloudClient } = await import('../frontend/src/cloud-client');
    cloudClient.admitLocal(session().user, 'offline', () => {});
    expect(signin.hidden).toBe(true);
    app.server.authStatus = 403;
    await cloudClick(t('cloudRefresh'));
    expect(signin.hidden).toBe(true);
    app.server.authStatus = 401;
    await cloudClick(t('cloudRefresh'));
    expect(signin.hidden).toBe(false);
    expect(app.navigate).not.toHaveBeenCalled();
    expect(appMocks.player.stop).not.toHaveBeenCalled();
    expect(appMocks.player.pause).not.toHaveBeenCalled();
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
  });

  it('loads the household list even when Routines is opened before local startup finishes', async () => {
    const app = await bootCloudApp({ earlyEdit: true });
    expect(app.fetcher.mock.calls.filter(([path]) => path === '/api/routines')).toHaveLength(1);
    expect(appNodes.find(node => node.className === 'edit-panel')!.hidden).toBe(false);
    expect(appNodes.filter(node => node.tag === 'select').some(node => node.children.some(option => option.value === 'routine-a'))).toBe(true);
  });

  it.each(['local', 'cached'] as const)('review hosted startup retains automatic preparation through Cloud refresh for %s selection', async source => {
    const app = await bootCloudApp({ local: source === 'local', cached: source === 'cached' });
    await vi.waitFor(() => expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(app.data.envelope.routine));
    for (const tab of ['edit', 'settings'] as const) { button(t(tab)).click(); await enterTeach(); }
    expect(appMocks.player.load.mock.settledResults.filter(result => result.type === 'fulfilled')).toHaveLength(1);
    expect(appMocks.player.play).not.toHaveBeenCalled();
    expect(appMocks.player.unload).not.toHaveBeenCalled();
    expect(button(t('startClass')).disabled).toBe(false);
    expect(app.fetcher.mock.calls.filter(([path]) => path === '/api/routines')).toHaveLength(1);
  });

  it('prepares startup pending working copy exactly once after sync acknowledgment during held readiness', async () => {
    const readinessDeferred = pending<{ ready: boolean; missing: string[] }>();
    const syncDeferred = pending<void>();
    const app = await bootCloudApp({ cached: true, pendingWorkingCopy: true, readinessDeferred, syncDeferred });
    await vi.waitFor(() => expect(appMocks.recordRoutineSyncAttempt).toHaveBeenCalledOnce());
    expect(appMocks.player.load).not.toHaveBeenCalled();
    syncDeferred.resolve();
    await vi.waitFor(() => expect(appMocks.editor.routine!.revision).toBe(app.data.envelope.routine.revision + 1));
    expect(app.working.get('routine-a')!.pendingCloud).toBe(false);
    readinessDeferred.resolve({ ready: true, missing: [] });
    await vi.waitFor(() => {
      expect(appMocks.player.load.mock.settledResults.filter(result => result.type === 'fulfilled')).toHaveLength(1);
      expect(button(t('startClass')).disabled).toBe(false);
      expect(button(t('play')).disabled).toBe(false);
      expect(appNodes.find(node => node.classList.contains('readiness'))!.querySelectorAll('p')
        .find(node => node.attributes.get('role') === 'status')!.textContent).toBe(t('verifiedLocal'));
    });
    expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(app.server.envelope.routine);
    expect(appMocks.player.play).not.toHaveBeenCalled();
    expect(appMocks.player.unload).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('serializes pending sync after preparation then prepares the newer saved generation', async () => {
    const readinessDeferred = pending<{ ready: boolean; missing: string[] }>();
    const syncDeferred = pending<void>();
    const app = await bootCloudApp({ cached: true, access: 'offline', pendingWorkingCopy: true, readinessDeferred, syncDeferred });
    await vi.waitFor(() => expect(appMocks.getReadiness).toHaveBeenCalledOnce());
    const { cloudClient } = await import('../frontend/src/cloud-client');
    cloudClient.admitSession(session());
    expect(appMocks.recordRoutineSyncAttempt).not.toHaveBeenCalled();
    readinessDeferred.resolve({ ready: true, missing: [] });
    await vi.waitFor(() => expect(appMocks.recordRoutineSyncAttempt).toHaveBeenCalledOnce());
    const newer = app.working.get('routine-a')!;
    newer.localVersion++;
    newer.envelope.routine.name = 'Newer saved class';
    syncDeferred.resolve();
    await vi.waitFor(() => expect(appMocks.editor.routine!.name).toBe('Newer saved class'));
    await vi.waitFor(() => {
      expect(appMocks.player.load.mock.settledResults.filter(result => result.type === 'fulfilled')).toHaveLength(2);
      expect(button(t('startClass')).disabled).toBe(false);
    });
    expect(appMocks.getReadiness).toHaveBeenCalledTimes(2);
    expect(appMocks.player.load).toHaveBeenLastCalledWith(app.working.get('routine-a')!.envelope.routine);
    expect(app.working.get('routine-a')).toMatchObject({ localVersion: 2, pendingCloud: false });
    expect(appMocks.acknowledgeRoutineWorkingCopy).toHaveBeenCalledTimes(2);
    expect(button(t('retryPreparation')).hidden).toBe(true);
    expect(appMocks.player.play).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps playing audio and unsaved edits through a sync acknowledgment (dirty=%s)', async dirty => {
    const syncDeferred = pending<void>();
    const app = await bootCloudApp({ cached: true, access: 'offline', pendingWorkingCopy: true, syncDeferred });
    await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play.mock.settledResults[0]?.type).toBe('fulfilled'));
    const { cloudClient } = await import('../frontend/src/cloud-client');
    cloudClient.admitSession(session());
    await vi.waitFor(() => expect(appMocks.recordRoutineSyncAttempt).toHaveBeenCalledOnce());
    if (dirty) { appMocks.editor.routine!.name = 'Unsaved choreography'; appMocks.editor.changed!(); }
    syncDeferred.resolve();
    await vi.waitFor(() => expect(app.working.get('routine-a')!.pendingCloud).toBe(false));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(appMocks.editor.routine!.name).toBe(dirty ? 'Unsaved choreography' : app.data.envelope.routine.name);
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.player.play).toHaveBeenCalledOnce();
    expect(appMocks.player.pause).not.toHaveBeenCalled();
    expect(appMocks.player.stop).not.toHaveBeenCalled();
    expect(appMocks.player.unload).not.toHaveBeenCalled();
    expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(['close', 'reopen'] as const)('blocks %s during shared sync and preserves the acknowledged generation afterward', async action => {
    const syncDeferred = pending<void>();
    const app = await bootCloudApp({ cached: true, pendingWorkingCopy: true, syncDeferred });
    await vi.waitFor(() => expect(appMocks.recordRoutineSyncAttempt).toHaveBeenCalledOnce());
    expect(button(t('cloudRefresh')).disabled).toBe(true);
    expect(button(t('closeRoutine')).disabled).toBe(true);
    const newer = app.working.get('routine-a')!;
    newer.localVersion++;
    newer.envelope.routine.name = 'Separately saved generation';
    syncDeferred.resolve();
    await vi.waitFor(() => expect(app.working.get('routine-a')!.pendingCloud).toBe(false));
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    await enterTeach();
    const original = structuredClone(appMocks.editor.routine!);
    expect(original.name).toBe('Separately saved generation');
    if (action === 'close') {
      button(t('closeRoutine')).click();
      const dialog = appNodes.filter(node => node.tag === 'dialog' && node.open).at(-1)!;
      dialog.querySelectorAll('button').find(node => node.title === t('discard'))!.click();
      await vi.waitFor(() => expect(dialog.open).toBe(false));
    } else await cloudClick(t('cloudOpenDraft'));
    await new Promise<void>(resolve => setImmediate(resolve));
    if (action === 'close') {
      expect(button(t('newRoutine')).hidden).toBe(false);
      expect(button(t('startClass')).disabled).toBe(true);
      expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(original);
    } else {
      await vi.waitFor(() => expect(button(t('startClass')).disabled).toBe(false));
      expect(appMocks.editor.routine).toEqual(original);
      expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(original);
    }
    expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it('keeps invalid unsaved input after sync without scheduling preparation retries', async () => {
    const syncDeferred = pending<void>();
    const app = await bootCloudApp({ cached: true, pendingWorkingCopy: true, syncDeferred });
    await vi.waitFor(() => expect(appMocks.recordRoutineSyncAttempt).toHaveBeenCalledOnce());
    appMocks.editor.routine!.crossfade = -1;
    appMocks.editor.changed!();
    syncDeferred.resolve();
    await vi.waitFor(() => expect(app.working.get('routine-a')!.pendingCloud).toBe(false));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(appMocks.editor.routine!.crossfade).toBe(-1);
    expect(appMocks.getReadiness).not.toHaveBeenCalled();
    expect(appMocks.player.load).not.toHaveBeenCalled();
    expect(appMocks.saveRoutineWorkingCopy).not.toHaveBeenCalled();
    expect(button(t('startClass')).disabled).toBe(true);
  });

  it('keeps a missing-media preparation failure actionable without automatically retrying', async () => {
    const syncDeferred = pending<void>();
    const app = await bootCloudApp({ cached: true, pendingWorkingCopy: true, syncDeferred, unready: true });
    syncDeferred.resolve();
    await vi.waitFor(() => expect(app.working.get('routine-a')!.pendingCloud).toBe(false));
    await vi.waitFor(() => expect(button(t('retryPreparation')).hidden).toBe(false));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(appMocks.getReadiness).toHaveBeenCalledTimes(3);
    expect(appMocks.player.load).not.toHaveBeenCalled();
    expect(button(t('startClass')).disabled).toBe(true);
    expect(button(t('retryPreparation')).disabled).toBe(false);
    expect(appNodes.find(node => node.classList.contains('notice'))?.classList.contains('notice-error')).toBe(true);
  });

  it.each(['offline', 'signin-required'] as const)('keeps cached %s startup network-free and prepares silently without starting playback', async access => {
    const app = await bootCloudApp({ role: 'player', cached: true, access });
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(appMocks.editor.routine!.id).toBe('routine-a');
    expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(app.data.envelope.routine);
    expect(appMocks.player.play).not.toHaveBeenCalled();
    expect(appNodes.find(node => node.tag === 'a' && node.textContent === t('cloudSignIn'))!.hidden).toBe(access !== 'signin-required');
  });

  it.each(['owner', 'editor'] as const)('manages uploaded fillers as %s only in Settings, with explicit upload and retained class audio', async role => {
    const app = await bootCloudApp({ role, local: true });
    expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(app.data.envelope.routine);
    appMocks.player.load.mockClear();
    const local: FillerRecording = { id: 'local-recording', name: 'My loop', duration: 8,
      asset: { ...app.data.asset, id: 'local-recording-asset' } };
    appMocks.editor.routine!.filler = { ...appMocks.editor.routine!.filler, sound: 'recording', recording: structuredClone(local) };
    appMocks.getFillerRecordingBlob.mockResolvedValue(app.data.blob);
    await enterTeach();
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    const snapshot = structuredClone(appMocks.editor.routine!);
    const manager = await openManagedFillers();
    const panel = appNodes.find(node => node.classList.contains('filler-library'))!;
    const settings = appNodes.find(node => node.className === 'settings-panel')!;
    expect(settings.children).toContain(manager); expect(manager.children).toContain(panel);
    expect(appNodes.find(node => node.className === 'edit-panel')!.children).not.toContain(panel);
    expect(panel.hidden).toBe(false);
    const picker = manager.querySelectorAll('input').find(node => node.attributes.get('aria-label') === t('audioChooseFiles'))!;
    picker.files = [new File([app.data.blob], 'My_loop.wav', { type: 'audio/wav' })];
    picker.dispatchEvent(new Event('change'));
    const importing = pending<FillerRecording>();
    const reading = pending<Blob>();
    appMocks.addFillerRecording.mockReturnValueOnce(importing.promise);
    appMocks.getFillerRecordingBlob.mockReturnValueOnce(reading.promise);
    expect(appMocks.addFillerRecording).not.toHaveBeenCalled();
    button(t('uploadFillers')).click();
    const feedback = manager.querySelector('.media-status')!;
    expect(feedback.textContent).toBe(t('audioBatchProgress', { current: 1, total: 1, name: picker.files[0]!.name }));
    expect(manager.querySelectorAll('progress')[0]!.hidden).toBe(true);
    expect(app.server.fillers).toHaveLength(0);
    expect(app.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(appMocks.editor.routine).toEqual(snapshot);
    importing.resolve(local);
    await vi.waitFor(() => expect(appMocks.getFillerRecordingBlob).toHaveBeenCalled());
    expect(app.server.fillers).toHaveLength(0);
    reading.resolve(app.data.blob);
    await vi.waitFor(() => expect(feedback.textContent).toBe(t('audioBatchDone')));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    expect(appMocks.addFillerRecording).toHaveBeenCalledWith(expect.any(File), 'My_loop', expect.any(AbortSignal));
    expect(appMocks.removeFillerRecording).not.toHaveBeenCalled();
    const authoritative = app.server.fillers[0]!;
    expect(authoritative.id).toBe('household-filler');
    expect(appMocks.cacheFillerRecording).toHaveBeenCalledWith(authoritative, app.data.blob);
    const writes = app.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path);
    expect(writes).toContain('/api/fillers');
    expect(writes).not.toContain('/api/routines');
    const remove = manager.querySelectorAll('button').find(node => node.title === t('deleteAudio'))!;
    const previewStops = appMocks.preview.stop.mock.calls.length;
    remove.click();
    await vi.waitFor(() => expect(button(t('refreshAudio')).disabled).toBe(false));
    const dialog = manager.querySelector('dialog')!;
    expect(dialog.querySelectorAll('button').find(node => node.title === t('deleteAudio'))!.disabled).toBe(true);
    dialog.querySelectorAll('button').find(node => node.title === t('cancel'))!.click();
    expect(app.server.fillers).toHaveLength(1);
    expect(app.fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(appMocks.editor.routine).toEqual(snapshot);
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.player.stop).not.toHaveBeenCalled();
    expect(appMocks.player.pause).not.toHaveBeenCalled();
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
    expect(appMocks.preview.stop).toHaveBeenCalledTimes(previewStops);
  });

  it('does not claim household success or remove local metadata when the recording POST fails', async () => {
    const app = await bootCloudApp();
    appMocks.editor.routine!.filler.gain = 0.5;
    const draft = structuredClone(appMocks.editor.routine);
    const panel = await openManagedFillers();
    const picker = panel.querySelectorAll('input').find(node => node.attributes.get('aria-label') === t('audioChooseFiles'))!;
    picker.files = [new File([app.data.blob], 'Loop.wav', { type: 'audio/wav' })];
    picker.dispatchEvent(new Event('change'));
    appMocks.addFillerRecording.mockResolvedValue({ id: 'local-filler', name: 'Loop', duration: 8, asset: app.data.asset });
    appMocks.getFillerRecordingBlob.mockResolvedValue(app.data.blob);
    app.server.writeStatus = 503;
    button(t('uploadFillers')).click();
    await vi.waitFor(() => expect(app.fetcher.mock.calls.some(([path, init]) => path === '/api/fillers' && init?.method === 'POST')).toBe(true));
    await vi.waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('false'));
    expect(appMocks.removeFillerRecording).not.toHaveBeenCalled();
    expect(appMocks.cacheFillerRecording).not.toHaveBeenCalled();
    expect(panel.querySelector('.media-status')!.textContent).not.toBe(t('audioBatchDone'));
    expect(app.server.fillers).toEqual([]);
    expect(appMocks.editor.routine).toEqual(draft);
  });

  it.each([401, 403])('prepares a cold cached Settings audition on one gesture, plays on the next, and leaves class playback alone on %s', async status => {
    const app = await bootCloudApp({ local: true });
    await enterTeach();
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    const recording = { id: 'filler-a', name: '<Cached loop>', duration: 8, asset: app.data.asset };
    app.server.fillers = [recording];
    appMocks.getFillerRecordingBlob.mockResolvedValue(app.data.blob);
    button(t('settings')).click();
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const panel = appNodes.find(node => node.classList.contains('filler-library'))!;
    const selector = panel.querySelectorAll('select')[0]!;
    selector.value = recording.id; selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    const play = panel.querySelectorAll('button').find(node => node.title === t('previewFiller'))!;
    const requests = app.fetcher.mock.calls.length;
    play.click();
    await vi.waitFor(() => expect(panel.querySelector('.filler-library-feedback')!.textContent).toBe(t('fillerPreviewReady')));
    expect(appMocks.preview.playFiller).not.toHaveBeenCalled();
    expect(app.fetcher).toHaveBeenCalledTimes(requests);
    play.click();
    expect(appMocks.preview.playFiller).toHaveBeenCalledWith({ mode: 'timed', seconds: 8, bpm: 100, sound: 'recording', recording, gain: 1 });
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((input, init) => input === '/api/fillers'
      ? Promise.resolve(json({ error: status === 401 ? 'signin_required' : 'forbidden' }, status)) : handler(input, init));
    button(t('refreshFillers')).click();
    await vi.waitFor(() => expect(panel.querySelector('.filler-library-status')!.textContent).toBe(t(status === 401 ? 'cloudSigninRequired' : 'cloudForbidden')));
    await vi.waitFor(() => expect(button(t('refreshFillers')).disabled).toBe(false));
    expect(appMocks.player.stop).not.toHaveBeenCalled();
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(app.navigate).not.toHaveBeenCalled();
    expect(selector.value).toBe(recording.id);
    play.click();
    expect(appMocks.preview.playFiller).toHaveBeenCalledTimes(2);
  });

  it('hides filler management from players and performs no catalog GET on Settings or Edit', async () => {
    const app = await bootCloudApp({ role: 'player' });
    button(t('settings')).click();
    button(t('edit')).click();
    expect(appNodes.find(node => node.classList.contains('filler-library'))!.hidden).toBe(true);
    expect(button(t('uploadFiller')).disabled).toBe(true);
    expect(app.fetcher.mock.calls.some(([path]) => String(path).startsWith('/api/fillers'))).toBe(false);
    expect(appMocks.listFillerRecordings).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'leave', 'identity'] as const)('fences a late manager filler import after %s without uploading or deleting private media', async interruption => {
    const app = await bootCloudApp();
    appMocks.editor.routine!.filler.gain = 0.5;
    const draft = structuredClone(appMocks.editor.routine);
    const panel = await openManagedFillers();
    const picker = panel.querySelectorAll('input').find(node => node.attributes.get('aria-label') === t('audioChooseFiles'))!;
    picker.files = [new File([app.data.blob], 'Loop.wav', { type: 'audio/wav' })];
    picker.dispatchEvent(new Event('change'));
    const importing = pending<FillerRecording>();
    appMocks.addFillerRecording.mockReturnValue(importing.promise);
    button(t('uploadFillers')).click();
    await vi.waitFor(() => expect(appMocks.addFillerRecording).toHaveBeenCalledOnce());
    const feedback = panel.querySelector('.media-status')!;
    expect(feedback.textContent).toBe(t('audioBatchProgress', { current: 1, total: 1, name: picker.files[0]!.name }));
    expect(panel.querySelectorAll('progress')[0]!.hidden).toBe(true);
    expect(appMocks.editor.routine).toEqual(draft);
    if (interruption === 'cancel') {
      panel.querySelectorAll('button').find(node => node.title === t('cancel'))!.click();
      expect(feedback.textContent).toBe(t('audioBatchCancelled'));
    }
    else if (interruption === 'leave') button(t('teach')).click();
    else (await import('../frontend/src/cloud-client')).cloudClient.admitSession(session('editor', 'other'));
    importing.resolve({ id: 'local-filler', name: 'Loop', duration: 8, asset: app.data.asset });
    await new Promise<void>(resolve => setImmediate(resolve));
    if (interruption === 'leave') button(t('settings')).click();
    await vi.waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('false'));
    expect(app.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(appMocks.removeFillerRecording).not.toHaveBeenCalled();
    expect(appMocks.cacheFillerRecording).not.toHaveBeenCalled();
    expect(panel.querySelectorAll('option').some(option => option.value === 'local-filler')).toBe(false);
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
    expect(appMocks.editor.routine).toEqual(draft);
  });

  it.each(['online', 'offline', 'signin-required'] as const)('prepares and plays a cached custom filler with %s access and zero requests', async access => {
    const app = await bootCloudApp({ local: true });
    appMocks.editor.routine!.filler = { ...appMocks.editor.routine!.filler, mode: 'timed', sound: 'recording', gain: 0.5,
      recording: { id: 'cached-filler', name: 'UserFiller', duration: 8, asset: app.data.asset } };
    const draft = structuredClone(appMocks.editor.routine);
    const { cloudClient, getCloudContext } = await import('../frontend/src/cloud-client');
    if (access !== 'online') cloudClient.admitLocal(getCloudContext().user!, access, () => {});
    appMocks.getFillerRecordingBlob.mockResolvedValue(app.data.blob);
    const requests = app.fetcher.mock.calls.length;
    await enterTeach();
    expect(appMocks.player.load).toHaveBeenCalledWith(draft);
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    expect(app.fetcher).toHaveBeenCalledTimes(requests);
    expect(appMocks.editor.routine).toEqual(draft);
  });

  it.each(['owner', 'editor', 'player'] as const)('downloads a cold selected recording before all readiness checks and loading for %s', async role => {
    const app = await bootCloudApp({ role, local: role !== 'player', cached: role === 'player' });
    expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(app.data.envelope.routine);
    appMocks.player.load.mockClear();
    const startupRequests = app.fetcher.mock.calls.length;
    const recording = { id: 'known-filler', name: 'Loop', duration: 8, asset: app.data.asset };
    appMocks.editor.routine!.filler = { ...appMocks.editor.routine!.filler, mode: 'timed', sound: 'recording', recording };
    let cached = false;
    appMocks.cacheFillerRecording.mockImplementation(async () => { cached = true; });
    appMocks.getReadiness.mockImplementation(async () => ({ ready: cached, missing: cached ? [] : ['filler-asset-a'] }));
    await enterTeach();
    const suffix = role === 'player' ? '?routineId=routine-a&revision=1' : '';
    expect(app.fetcher.mock.calls.slice(startupRequests).map(([path]) => path)).toEqual([`/api/media/asset-a${suffix}`, `/api/media/asset-a/chunks/0${suffix}`]);
    expect(appMocks.cacheFillerRecording).toHaveBeenCalledWith(recording, expect.any(Blob));
    expect(appMocks.cacheFillerRecording.mock.invocationCallOrder[0]).toBeLessThan(appMocks.getReadiness.mock.invocationCallOrder.at(-1)!);
    expect(appMocks.getReadiness.mock.invocationCallOrder.at(-1)).toBeLessThan(appMocks.player.load.mock.invocationCallOrder[0]!);
    expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(appMocks.editor.routine);
  });

  it.each(['401', '403', 'network', 'readiness'] as const)('keeps the previous prepared playing class on a cold filler %s failure', async failure => {
    const app = await bootCloudApp({ local: true });
    await enterTeach();
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    appMocks.editor.routine!.filler = { ...appMocks.editor.routine!.filler, mode: 'timed', sound: 'recording',
      recording: { id: 'known-filler', name: 'Loop', duration: 8, asset: app.data.asset } };
    if (failure === 'readiness') appMocks.getReadiness.mockResolvedValue({ ready: false, missing: ['entry-a'] });
    else app.fetcher.mockImplementation(async () => {
      if (failure === 'network') throw new TypeError('offline');
      return json({ error: 'denied' }, Number(failure));
    });
    await enterTeach();
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.player.pause).not.toHaveBeenCalled();
    expect(appMocks.player.stop).not.toHaveBeenCalled();
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
    expect(button(t('startClass')).disabled).toBe(true);
    expect(button(t('pause')).disabled).toBe(false); expect(button(t('stop')).disabled).toBe(false);
  });

  it.each(['stop', 'pause', 'draft', 'identity', 'new-prepare'] as const)('fences a late cold filler response after %s', async interruption => {
    const app = await bootCloudApp({ local: true });
    expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(app.data.envelope.routine);
    appMocks.player.load.mockClear();
    const startupRequests = app.fetcher.mock.calls.length;
    appMocks.editor.routine!.filler = { ...appMocks.editor.routine!.filler, mode: 'timed', sound: 'recording',
      recording: { id: 'known-filler', name: 'Loop', duration: 8, asset: app.data.asset } };
    const download = pending<Response>();
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((path, init) => String(path).includes('/chunks/') ? download.promise : handler(path, init));
    button(t('teach')).click();
    await vi.waitFor(() => expect(app.fetcher).toHaveBeenCalledTimes(startupRequests + 2));
    if (interruption === 'identity') (await import('../frontend/src/cloud-client')).cloudClient.admitSession(session('editor', 'other'));
    else if (interruption === 'draft') appMocks.editor.routine!.name = 'Changed draft';
    else button(t(interruption === 'pause' ? 'pause' : 'stop')).click();
    if (interruption === 'new-prepare') {
      appMocks.editor.routine!.filler = { mode: 'none', seconds: 8, bpm: 100, sound: 'soft' };
      await enterTeach();
    }
    download.resolve(binary(app.data.blob));
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    expect(appMocks.cacheFillerRecording).not.toHaveBeenCalled();
    expect(appMocks.player.load).toHaveBeenCalledTimes(interruption === 'new-prepare' ? 1 : 0);
    if (interruption === 'new-prepare') expect(appMocks.player.load.mock.calls[0]![0].filler.mode).toBe('none');
    if (['stop', 'pause', 'new-prepare'].includes(interruption)) expect(app.fetcher.mock.calls[startupRequests + 1]![1]!.signal!.aborted).toBe(true);
  });

  it('keeps explicit refresh and 401 from disposing, stopping or reloading a prepared playing snapshot', async () => {
    const app = await bootCloudApp();
    await openCloudRoutine();
    await enterTeach();
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    app.server.authStatus = 401;
    await cloudClick(t('cloudRefresh'));
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.player.stop).not.toHaveBeenCalled();
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
    expect(app.navigate).not.toHaveBeenCalled();
    app.server.authStatus = 200;
    app.server.envelope.routine.name = 'Remote revision';
    app.server.envelope.routine.revision++;
    await cloudClick(t('cloudRefresh'));
    expect(appMocks.editor.routine!.name).toBe('<Private class>');
    vi.mocked(confirm).mockImplementation(message => message !== t('confirmPrepare'));
    await cloudClick(t('cloudOpen'));
    expect(appMocks.editor.routine!.name).toBe('Remote revision');
    expect(appMocks.player.load).toHaveBeenCalledOnce();
  });

  it('saves an editor reorder through one confirmed household PUT without changing the prepared playing track', async () => {
    const app = await bootCloudApp();
    app.server.envelope.routine.tracks[0]!.gain = 0.75;
    app.server.envelope.routine.tracks.push({ ...structuredClone(app.server.envelope.routine.tracks[0]!), id: 'entry-b',
      title: '<Second song>', gain: 1.25, cues: [{ id: 'cue-b', note: '<Move B>', anchor: { kind: 'count', count: 9 } }] });
    app.server.envelope.media['entry-b'] = app.data.asset;
    appMocks.getTrackBlob.mockResolvedValue(app.data.blob);
    await openCloudRoutine();
    await enterTeach();
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    const prepared = appMocks.player.load.mock.calls[0]![0] as Routine;
    const original = structuredClone(prepared);
    Object.freeze(prepared.tracks); Object.freeze(prepared);
    const draft = appMocks.editor.routine!;
    const previewStops = appMocks.preview.stop.mock.calls.length;
    expect(reorderTrack(draft, 'entry-a', 1)).toBe(true);
    appMocks.editor.changed!(true);
    expect(appMocks.preview.stop).toHaveBeenCalledTimes(previewStops);
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    await cloudClick(t('cloudSave'));
    expect(appMocks.saveRoutineWorkingCopy).toHaveBeenCalledWith(expect.objectContaining({ routine: draft }),
      { expectedLocalVersion: null, cloud: true, cloudBaseRevision: 1 });
    const writes = app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('/api/routines/routine-a');
    expect(new Headers(writes[0]![1]!.headers).get('If-Match')).toBe('"1"');
    const submitted = JSON.parse(String(writes[0]![1]!.body)) as CloudRoutine;
    expect(submitted.routine.tracks.map(track => track.id)).toEqual(['entry-b', 'entry-a']);
    expect(submitted.media).toEqual({ 'entry-a': app.data.asset, 'entry-b': app.data.asset });
    expect(app.server.envelope.routine.tracks).toEqual(submitted.routine.tracks);
    expect(appMocks.saveRoutine).not.toHaveBeenCalled();
    expect(prepared).toEqual(original); expect(prepared.tracks[0]!.id).toBe('entry-a');
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    for (const command of [appMocks.player.stop, appMocks.player.dispose, appMocks.player.pause, appMocks.player.seek,
      appMocks.player.updateCues]) expect(command).not.toHaveBeenCalled();
  });

  it('review paused Practice cue Save uses authoritative preflight and manifests without POST, chunks, reload or replay', async () => {
    const app = await bootCloudApp(); await openCloudRoutine(); await enterTeach();
    button(t('play')).click(); await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    button(t('pause')).click(); expect(button(t('resume')).disabled).toBe(false);
    button(t('editCueTimes')).click(); button(t('laterCue')).click();
    expect(appMocks.editor.routine!.tracks[0]!.cues[0]!.anchor).toEqual({ kind: 'timestamp', seconds: 1.1 });
    const requests = app.fetcher.mock.calls.length;
    await cloudClick(t('cloudSave'));
    expect(app.fetcher.mock.calls.slice(requests).map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
      ['/api/routines/routine-a', 'GET'], ['/api/media/asset-a', 'GET'], ['/api/routines/routine-a', 'PUT'],
    ]);
    expect(app.working.get('routine-a')?.pendingCloud).toBe(false);
    expect(app.server.envelope.routine.tracks[0]!.cues[0]!.anchor).toEqual({ kind: 'timestamp', seconds: 1.1 });
    await enterTeach();
    expect(button(t('resume')).disabled).toBe(false);
    expect(appMocks.player.load).toHaveBeenCalledOnce(); expect(appMocks.player.play).toHaveBeenCalledOnce();
    expect(appMocks.player.pause).toHaveBeenCalledOnce(); expect(appMocks.player.stop).not.toHaveBeenCalled();
    expect(appMocks.player.seek).not.toHaveBeenCalled(); expect(appMocks.player.updateCues).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 412, 423])('keeps live cue timing and playback after a rejected household cue Save (%s)', async status => {
    const app = await bootCloudApp(); await openCloudRoutine(); await enterTeach();
    button(t('play')).click();
    await vi.waitFor(() => expect(appMocks.player.play).toHaveBeenCalledOnce());
    button(t('editCueTimes')).click();
    button(t('laterCue')).click();
    const edited = structuredClone(appMocks.editor.routine!);
    expect(edited.tracks[0]!.cues[0]!.anchor).toEqual({ kind: 'timestamp', seconds: 1.1 });
    expect(appMocks.player.updateCues).toHaveBeenCalledOnce();
    app.server.writeStatus = status;
    await cloudClick(t('cloudSave'));
    expect(appMocks.editor.routine).toEqual(edited);
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.player.play).toHaveBeenCalledOnce();
    for (const command of [appMocks.player.pause, appMocks.player.stop, appMocks.player.dispose, appMocks.saveRoutine]) expect(command).not.toHaveBeenCalled();
  });

  it('keeps the unsaved draft when the user cancels an explicit cloud reopen', async () => {
    const app = await bootCloudApp();
    await openCloudRoutine();
    appMocks.editor.routine!.name = 'Unsaved edit';
    appMocks.editor.changed!();
    vi.mocked(confirm).mockReturnValue(false);
    const requests = app.fetcher.mock.calls.length;
    await cloudClick(t('cloudOpen'));
    expect(app.fetcher).toHaveBeenCalledTimes(requests);
    expect(appMocks.editor.routine!.name).toBe('Unsaved edit');
    expect(appMocks.player.load).toHaveBeenCalledOnce(); expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it('routes lock/unlock/publish through cloud commands and leaves publication read-only', async () => {
    const app = await bootCloudApp();
    await openCloudRoutine();
    await cloudClick(t('cloudSave'));
    let localVersion = app.working.get('routine-a')!.localVersion;
    await cloudClick(t('lock'));
    expect(app.working.get('routine-a')!.localVersion).toBe(localVersion + 1);
    localVersion++;
    expect(appMocks.editor.routine!.locked).toBe(true);
    expect(appMocks.saveRoutine).not.toHaveBeenCalled();
    expect(button(t('cloudPublish')).disabled).toBe(true);
    await cloudClick(t('unlock'));
    await cloudClick(t('cloudPublish'));
    expect(appMocks.editor.routine!.published).toBe(true);
    expect(appMocks.editor.canEdit!()).toBe(false);
    expect(appMocks.saveRoutine).not.toHaveBeenCalled();
    expect(appMocks.player.play).not.toHaveBeenCalled();
    expect(app.working.get('routine-a')!.localVersion).toBe(localVersion);
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([input]) => String(input))).toEqual([
      '/api/routines/routine-a/lock', '/api/routines/routine-a/unlock', '/api/routines/routine-a/publish',
    ]);
    const publication = structuredClone(appMocks.editor.routine!);
    await cloudClick(t('cloudOpenDraft'));
    expect(appMocks.editor.routine!.published).toBe(false); expect(appMocks.editor.canEdit!()).toBe(true);
    appMocks.editor.routine!.name = 'Next publication'; appMocks.editor.changed!();
    await cloudClick(t('cloudSave'));
    expect(appMocks.editor.routine!.id).toBe(publication.id);
    expect(appMocks.saveRoutineWorkingCopy).toHaveBeenLastCalledWith(expect.objectContaining({ routine: expect.objectContaining({ name: 'Next publication' }) }),
      { expectedLocalVersion: localVersion, cloud: true, cloudBaseRevision: publication.revision });
    expect(app.working.get('routine-a')!.pendingCloud).toBe(false);
    expect(publication.name).toBe('<Private class>');
    await cloudClick(t('cloudPublish')); expect(appMocks.editor.routine!.name).toBe('Next publication');
  });

  it.each([false, true])('opens an older publication without reconciling the newer draft and returns to local work (pending=%s)', async pendingCloud => {
    const app = await bootCloudApp(); await openCloudRoutine(); await cloudClick(t('cloudSave'));
    await cloudClick(t('cloudPublish'));
    const publication = { routine: structuredClone(appMocks.editor.routine!), media: structuredClone(app.server.envelope.media) };
    const handler = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((input, init) => {
      if (String(input) === '/api/routines/routine-a?published=true') return Promise.resolve(json(publication));
      if (String(input) === '/api/routines?published=true') return Promise.resolve(json({ routines: [publication.routine] }));
      return handler(input, init);
    });
    await cloudClick(t('cloudOpenDraft'));
    appMocks.editor.routine!.name = 'Newer saved choreography'; appMocks.editor.changed!();
    await cloudClick(t('cloudSave'));
    if (pendingCloud) {
      app.server.writeStatus = 412;
      appMocks.editor.routine!.name = 'Pending choreography'; appMocks.editor.changed!();
      await cloudClick(t('cloudSave'));
    }
    const before = structuredClone(app.working.get('routine-a')!);
    expect(before.pendingCloud).toBe(pendingCloud);
    expect(before.envelope.routine.revision).toBeGreaterThan(publication.routine.revision);
    await cloudClick(t('cloudRefresh')); button(t('openDifferent')).click();
    const rows = appNodes.find(node => node.className === 'routine-library-rows')!;
    const cloudRows = rows.children.filter(row => row.querySelector('.muted')?.textContent.startsWith(t('householdFilter')));
    expect(cloudRows).toHaveLength(2);
    expect(cloudRows.map(row => row.querySelector('.muted')!.textContent)).toEqual(expect.arrayContaining([
      `${t('householdFilter')} / ${t('draft')}`, `${t('householdFilter')} / ${t('exportPublished')}`,
    ]));
    const reconciles = appMocks.reconcileRoutineWorkingCopy.mock.calls.length;
    const mutations = app.fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET').length;
    const version = appNodes.find(node => node.tag === 'select' && node.attributes.get('aria-label') === t('cloudVersion'))!;
    expect(version.value).toBe('draft');
    const opening = app.fetcher.mock.calls.length;
    const publishedRow = cloudRows.find(row => row.querySelector('.muted')!.textContent.endsWith(t('exportPublished')))!;
    publishedRow.querySelectorAll('button').find(node => node.title === t('openRoutine', { name: publication.routine.name }))!.click();
    await vi.waitFor(() => expect(appMocks.editor.routine!.published).toBe(true));
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    expect(appMocks.editor.routine).toEqual(publication.routine);
    expect(version.value).toBe('draft');
    expect(app.fetcher.mock.calls.slice(opening).filter(([path]) => String(path).startsWith('/api/routines/'))
      .map(([path, init]) => [path, init?.method])).toEqual([['/api/routines/routine-a?published=true', 'GET']]);
    expect(appMocks.editor.canEdit!()).toBe(false);
    expect(appMocks.reconcileRoutineWorkingCopy).toHaveBeenCalledTimes(reconciles);
    expect(app.working.get('routine-a')).toEqual(before);
    expect(JSON.parse(app.store.getItem(hostedCloudSelectionKey)!)).toMatchObject({
      id: 'routine-a', revision: publication.routine.revision, published: true,
    });
    const reads = app.fetcher.mock.calls.length;
    await cloudClick(t('cloudOpenDraft'));
    expect(appMocks.editor.routine).toEqual(before.envelope.routine);
    expect(appMocks.editor.canEdit!()).toBe(true);
    expect(app.working.get('routine-a')).toEqual(before);
    if (pendingCloud) expect(app.fetcher).toHaveBeenCalledTimes(reads);
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET')).toHaveLength(mutations);
    expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it('keeps an actionable CAS rejection without reloading, retrying or falling back to local save', async () => {
    const app = await bootCloudApp();
    await openCloudRoutine();
    appMocks.editor.routine!.name = 'Stale draft';
    appMocks.editor.changed!();
    app.server.writeStatus = 412;
    await cloudClick(t('cloudSave'));
    expect(app.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(appMocks.editor.routine!.name).toBe('Stale draft');
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.saveRoutine).not.toHaveBeenCalled();
    expect(appNodes.some(node => node.textContent.includes(t('cloudConflict')))).toBe(true);
    expect(app.working.get('routine-a')).toMatchObject({ pendingCloud: true, envelope: { routine: { name: 'Stale draft' } } });
  });

  it('never uploads existing local songs on startup, refresh or cancelled explicit upload', async () => {
    const app = await bootCloudApp({ local: true });
    expect(app.fetcher.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/api/routines', 'GET'], ['/api/routines?published=true', 'GET'], ['/api/classes', 'GET'], ['/api/classes?published=true', 'GET'],
    ]);
    await cloudClick(t('cloudRefresh'));
    vi.mocked(confirm).mockReturnValue(false);
    await cloudClick(t('shareRoutine'));
    expect(app.fetcher.mock.calls.some(([input]) => String(input).includes('/uploads'))).toBe(false);
    expect(appMocks.storeTrack).not.toHaveBeenCalled();
  });

  it('saves a new editor-owned working draft locally while offline without losing pending Cloud intent', async () => {
    const app = await bootCloudApp({ access: 'offline' });
    button(t('newRoutine')).click();
    expect(appMocks.editor.canEdit!()).toBe(true);
    appMocks.editor.routine!.name = 'New local class';
    appMocks.editor.changed!();
    const draft = structuredClone(appMocks.editor.routine!);
    await cloudClick(t('cloudSave'));
    expect(appMocks.saveRoutineWorkingCopy).toHaveBeenCalledExactlyOnceWith({ routine: draft, media: {} },
      { expectedLocalVersion: null, cloud: true, cloudBaseRevision: null });
    expect(app.working.get(draft.id)).toMatchObject({ pendingCloud: true, localVersion: 1, envelope: { routine: draft } });
    expect(appMocks.saveRoutine).not.toHaveBeenCalled();
    expect(appMocks.editor.routine).toEqual(draft);
    expect(app.store.getItem(hostedCloudSelectionKey)).toBeNull();
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(appMocks.cacheCloudRoutine).not.toHaveBeenCalled();
    expect(appMocks.player.load).not.toHaveBeenCalled();
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
  });

  it('keeps player accounts published-only and blocks hidden local import/save/demo mutation paths', async () => {
    const app = await bootCloudApp({ role: 'player', local: true });
    expect(appMocks.getRoutine).not.toHaveBeenCalled();
    expect(appMocks.listRoutines).not.toHaveBeenCalled();
    expect(button(t('edit')).hidden).toBe(false);
    button(t('edit')).click();
    expect(appNodes.find(node => node.classList.contains('edit-panel'))!.hidden).toBe(false);
    expect(appNodes.find(node => node.classList.contains('teach-panel'))!.querySelectorAll('.cloud-panel')).toHaveLength(0);
    for (const label of ['cloudSave', 'demo', 'lock', 'duplicate', 'cloudReplace', 'cloudOpenDraft'] as const) expect(button(t(label)).hidden).toBe(true);
    button(t('cloudSave')).dispatchEvent(new Event('click'));
    button(t('demo')).dispatchEvent(new Event('click'));
    const chooser = appNodes.find(node => node.tag === 'input' && node.attributes.get('aria-label') === t('import'))!;
    chooser.files = [new File(['test'], 'fixture.wav', { type: 'audio/wav' })];
    chooser.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    expect(appMocks.saveRoutine).not.toHaveBeenCalled();
    expect(appMocks.storeTrack).not.toHaveBeenCalled();
    expect(appMocks.createDemoRoutine).not.toHaveBeenCalled();
    await openCloudRoutine();
    expect(appMocks.editor.canEdit!()).toBe(false);
    expect(app.fetcher.mock.calls.filter(([input]) => String(input).startsWith('/api/routines')).every(([input]) => String(input).includes('published=true'))).toBe(true);
  });

  it('recovers a same-ID create collision only through explicit target confirmation and keeps local edits on Cancel/412', async () => {
    const app = await bootCloudApp({ local: true });
    expect(appMocks.player.load).toHaveBeenCalledExactlyOnceWith(app.data.envelope.routine);
    appMocks.player.load.mockClear();
    button(t('edit')).click();
    await vi.waitFor(() => expect(button(t('cloudRefresh')).disabled).toBe(false));
    appMocks.editor.routine!.name = 'Unsaved local source'; appMocks.editor.changed!();
    const source = structuredClone(appMocks.editor.routine!);
    await cloudClick(t('shareRoutine'));
    expect(appNodes.some(node => node.textContent === t('cloudUploadConflict'))).toBe(true);
    await cloudClick(t('cloudRefresh'));
    const selector = appNodes.find(node => node.tag === 'select' && node.attributes.get('aria-label') === t('cloudRoutines'))!;
    selector.value = 'routine-a'; selector.dispatchEvent(new Event('change'));
    vi.mocked(confirm).mockReturnValue(false); await cloudClick(t('cloudReplace'));
    expect(confirm).toHaveBeenLastCalledWith(t('cloudConfirmReplace', { name: app.data.envelope.routine.name,
      id: 'routine-a', revision: 1, source: source.name, status: t('exportUnsaved') }));
    expect(appMocks.editor.routine).toEqual(source); expect(app.store.getItem(hostedCloudSelectionKey)).toBeNull();
    vi.mocked(confirm).mockReturnValue(true); app.server.writeStatus = 412;
    await cloudClick(t('cloudReplace'));
    expect(appMocks.editor.routine).toEqual(source); expect(app.store.getItem(hostedCloudSelectionKey)).toBeNull();
    app.server.writeStatus = 200; await cloudClick(t('cloudReplace'));
    expect(appMocks.editor.routine).toEqual({ ...source, revision: 2 });
    expect(JSON.parse(app.store.getItem(hostedCloudSelectionKey)!)).toMatchObject({ id: 'routine-a', revision: 2, published: false });
    expect(app.server.envelope.media).toEqual(app.data.envelope.media);
    expect(appMocks.saveRoutine).not.toHaveBeenCalled(); expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.player.play).not.toHaveBeenCalled();
  });

  it('restores an exact cached publication without fetching and prepares after expiry only when readiness passes', async () => {
    const app = await bootCloudApp({ role: 'player', cached: true, access: 'signin-required', unready: true });
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(appMocks.editor.routine!.id).toBe('routine-a');
    expect(appMocks.editor.canEdit!()).toBe(false);
    app.server.authStatus = 401;
    const { cloudClient } = await import('../frontend/src/cloud-client');
    cloudClient.admitLocal(session('player').user, 'signin-required', () => {});
    appMocks.getReadiness.mockResolvedValueOnce({ ready: false, missing: ['entry-a'] });
    await enterTeach();
    expect(appMocks.player.load).not.toHaveBeenCalled();
    appMocks.getReadiness.mockResolvedValue({ ready: true, missing: [] });
    await enterTeach();
    expect(appMocks.player.load).toHaveBeenCalledOnce();
    expect(appMocks.getReadiness.mock.invocationCallOrder.at(-1)).toBeLessThan(appMocks.player.load.mock.invocationCallOrder[0]!);
    expect(app.navigate).not.toHaveBeenCalled();
  });

  it('waits for recorded-filler readiness before touching the prepared player', async () => {
    const app = await bootCloudApp();
    app.server.envelope.routine.filler = { mode: 'timed', seconds: 10, bpm: 100, sound: 'lofi' };
    const filler = pending<unknown>();
    appMocks.filler.mockReturnValueOnce(filler.promise);
    button(t('edit')).click();
    const selector = appNodes.find(node => node.tag === 'select' && node.attributes.get('aria-label') === t('cloudRoutines'))!;
    selector.value = 'routine-a'; selector.dispatchEvent(new Event('change')); button(t('cloudOpen')).click();
    await vi.waitFor(() => expect(appMocks.filler).toHaveBeenCalledOnce());
    expect(appMocks.player.load).not.toHaveBeenCalled();
    filler.resolve({});
    await vi.waitFor(() => expect(appMocks.player.load).toHaveBeenCalledOnce());
  });

  it('does not dispose or navigate when sign-in confirmation is cancelled', async () => {
    const app = await bootCloudApp({ access: 'signin-required' });
    const link = appNodes.find(node => node.tag === 'a' && node.textContent === t('cloudSignIn'))!;
    vi.mocked(confirm).mockReturnValue(false);
    link.click();
    expect(appMocks.player.dispose).not.toHaveBeenCalled();
    expect(app.navigate).not.toHaveBeenCalled();
    vi.mocked(confirm).mockReturnValue(true);
    link.click();
    expect(appMocks.player.dispose).toHaveBeenCalledOnce();
    expect(appMocks.exportDispose).toHaveBeenCalledOnce();
    expect(app.navigate).toHaveBeenCalledWith('/signin.html');
  });
});