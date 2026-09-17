import { describe, expect, it } from 'vitest';
import { cueSeconds, newRoutine, reorderTrack, transitionAfter, validateRoutine, validFillerRecording, type Track } from '../shared/routine';
import { newMusicPlaylist, validateClassSetup, validateMusicPlaylist, type ClassSetup, type MusicPlaylist } from '../shared/class-plan';

const track: Track = { id: 'track-1', title: 'Test', duration: 60, bpm: 120, firstBeat: 1, bodyArea: '', cues: [] };

describe('cue timing contract', () => {
  it('owns all phases in one routine and rejects duplicate entries or invalid phase content', () => {
    const routine = newRoutine();
    routine.tracks = [structuredClone(track)];
    routine.sequence = { crossfade: 3, before: { ...routine.filler, mode: 'hold' },
      walkIn: { name: 'Arrival', tracks: [{ ...structuredClone(track), id: 'arrival' }] } };
    expect(validateRoutine(routine)).toEqual([]);
    routine.sequence.walkIn!.tracks[0].id = track.id;
    expect(validateRoutine(routine)).toContain('Track entry IDs must be unique');
    routine.sequence.walkIn!.tracks[0].id = 'arrival';
    routine.sequence.walkIn!.tracks[0].cues = [{ id: 'cue', note: 'Not playlist choreography', anchor: { kind: 'timestamp', seconds: 1 } }];
    expect(validateRoutine(routine)).toContain('Invalid phase playlist');
    expect(validateRoutine({ ...routine, schemaVersion: 1 })).toContain('Unsupported sequence schema');
  });
  it('allows unknown BPM for time cues but never invents a count grid', () => {
    const routine = newRoutine();
    const unknown = { ...track, bpm: undefined };
    routine.tracks = [unknown];
    expect(validateRoutine(routine)).toEqual([]);
    unknown.cues = [{ id: 'cue', note: 'Timed', anchor: { kind: 'timestamp', seconds: 5 } }];
    expect(validateRoutine(routine)).toEqual([]);
    unknown.cues = [{ id: 'cue', note: 'Counted', anchor: { kind: 'count', count: 5 } }];
    expect(validateRoutine(routine)).toContain('Invalid cue position');
  });

  it.each([null, undefined, [], 'invalid'])('returns controlled errors for malformed roots %s', value => {
    expect(validateRoutine(value as unknown as ReturnType<typeof newRoutine>).length).toBeGreaterThan(0);
    expect(validateMusicPlaylist(value as unknown as MusicPlaylist).length).toBeGreaterThan(0);
    expect(validateClassSetup(value as unknown as ClassSetup).length).toBeGreaterThan(0);
  });
  it('rejects malformed nested values without throwing and does not invent playlist metadata', () => {
    const routine = newRoutine();
    for (const change of [{ filler: null }, { tracks: null }, { tracks: [null] }, { tracks: [{ ...track, cues: null }] },
      { tracks: [{ ...track, title: null }] }, { tracks: [{ ...track, cues: [null] }] },
      { tracks: [{ ...track, cues: [{ id: 'cue', note: null, anchor: null }] }] }]) {
      expect(validateRoutine({ ...routine, ...change } as unknown as typeof routine).length).toBeGreaterThan(0);
    }
    for (const field of ['schemaVersion', 'id', 'name', 'revision', 'locked', 'published', 'tracks']) {
      const playlist = newMusicPlaylist();
      delete (playlist as unknown as Record<string, unknown>)[field];
      expect(validateMusicPlaylist(playlist).length).toBeGreaterThan(0);
    }
    expect(validateMusicPlaylist({ ...newMusicPlaylist(), filler: routine.filler } as MusicPlaylist).length).toBeGreaterThan(0);
    expect(validateClassSetup({ schemaVersion: 1, id: 'setup', name: 'Setup', revision: 1, locked: false, published: false,
      routine: { id: routine.id, revision: 1, published: false }, before: null, crossfade: 1 } as unknown as ClassSetup)).toContain('Invalid announcement filler');
  });
  it('resolves inherited, disabled and custom filler without playing the last entry override', () => {
    const routine = newRoutine();
    routine.tracks = [structuredClone(track), { ...structuredClone(track), id: 'second' }];
    expect(transitionAfter(routine, 0).filler).toEqual(routine.filler);
    routine.tracks[0].after = { mode: 'none' };
    expect(transitionAfter(routine, 0).filler.mode).toBe('none');
    routine.tracks[0].after = { mode: 'custom', filler: { ...routine.filler, mode: 'hold' }, crossfade: 3 };
    expect(validateRoutine(routine)).toEqual([]);
    expect(transitionAfter(routine, 0).crossfade).toBe(3);
    routine.tracks.reverse();
    expect(transitionAfter(routine, 1).filler.mode).toBe('none');
    expect(routine.tracks[1].after?.mode).toBe('custom');
  });
  it('reorders whole entries by ID without changing their content or a prepared copy', () => {
    const routine = newRoutine();
    const entries = ['first', 'second', 'third'].map(id => ({ ...structuredClone(track), id, gain: 0.8 }));
    routine.tracks = [...entries];
    const prepared = structuredClone(routine);
    expect(reorderTrack(routine, 'first', 2)).toBe(true);
    expect(routine.tracks).toEqual([entries[1], entries[2], entries[0]]);
    expect(routine.tracks[2]).toBe(entries[0]);
    expect(prepared.tracks.map(entry => entry.id)).toEqual(['first', 'second', 'third']);
    expect(reorderTrack(routine, 'first', 0)).toBe(true);
    expect(routine.tracks).toEqual(entries);
  });
  it('rejects unavailable, invalid and no-op reorders', () => {
    const routine = newRoutine();
    routine.tracks = [structuredClone(track), { ...structuredClone(track), id: 'other' }];
    const before = structuredClone(routine.tracks);
    for (const destination of [-1, 2, 0.5, NaN, Infinity, 0]) {
      expect(reorderTrack(routine, track.id, destination)).toBe(false);
    }
    expect(reorderTrack(routine, 'missing', 1)).toBe(false);
    routine.locked = true;
    expect(reorderTrack(routine, track.id, 1)).toBe(false);
    routine.locked = false;
    routine.published = true;
    expect(reorderTrack(routine, track.id, 1)).toBe(false);
    expect(routine.tracks).toEqual(before);
  });
  it('requires an immutable descriptor for a custom filler and preserves built-in compatibility', () => {
    const routine = newRoutine();
    routine.filler.sound = 'recording';
    expect(validateRoutine(routine)).toContain('Invalid filler recording');
    routine.filler.recording = { id: 'filler-a', name: 'Cool down', duration: 30,
      asset: { id: 'asset-a', sha256: 'a'.repeat(64), bytes: 4096, contentType: 'audio/wav' } };
    expect(validateRoutine(routine)).toEqual([]);
    expect(validFillerRecording({ ...routine.filler.recording, duration: 361 })).toBe(false);
    expect(validFillerRecording({ ...routine.filler.recording, asset: { ...routine.filler.recording.asset, sha256: 'bad' } })).toBe(false);
    routine.filler.sound = 'lofi';
    expect(validateRoutine(routine)).toContain('Invalid filler recording');
    delete routine.filler.recording;
    expect(validateRoutine(routine)).toEqual([]);
  });
  it('preserves neutral legacy gains and accepts bounded independent audio levels', () => {
    const routine = newRoutine();
    routine.tracks = [structuredClone(track)];
    expect(validateRoutine(routine)).toEqual([]);
    expect(routine.tracks[0].gain ?? 1).toBe(1);
    expect(routine.filler.gain ?? 1).toBe(1);
    routine.tracks[0].gain = 1.5;
    routine.filler.gain = 0;
    expect(validateRoutine(routine)).toEqual([]);
  });
  it.each([-0.1, 1.51, NaN, Infinity, '1', null])('rejects invalid audio gain %s', gain => {
    const routine = newRoutine();
    routine.tracks = [{ ...track, gain: gain as number }];
    routine.filler.gain = gain as number;
    expect(validateRoutine(routine)).toContain('Invalid track gain');
    expect(validateRoutine(routine)).toContain('Invalid filler gain');
  });
  it('moves timestamp and counted cues with tempo, not elapsed intervals', () => {
    expect(cueSeconds({ id: 'a', note: 'A', anchor: { kind: 'timestamp', seconds: 20 } }, track, 2)).toBe(10);
    expect(cueSeconds({ id: 'b', note: 'B', anchor: { kind: 'count', count: 9 } }, track, 2)).toBe(2.5);
    expect(cueSeconds({ id: 'c', note: 'C', anchor: { kind: 'interval', seconds: 20 } }, track, 2)).toBe(20);
  });
  it('validates repeated songs as independent entries', () => {
    const routine = newRoutine();
    routine.tracks = [track, { ...track, id: 'track-2' }];
    expect(validateRoutine(routine)).toEqual([]);
    routine.tracks[1].id = track.id;
    expect(validateRoutine(routine)).toContain('Track entry IDs must be unique');
  });
  it('rejects nonfinite durations and out-of-range cue positions', () => {
    const routine = newRoutine();
    routine.tracks = [{ ...track, cues: [{ id: 'a', note: 'A', anchor: { kind: 'count', count: 1000 } }] }];
    expect(validateRoutine(routine)).toContain('Cue outside track');
    routine.tracks[0].duration = Infinity;
    expect(validateRoutine(routine)).toContain('Track duration must be 0-1200 seconds');
  });
});