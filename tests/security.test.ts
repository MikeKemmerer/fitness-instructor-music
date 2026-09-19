import { describe, expect, it } from 'vitest';
import { parseRoutineContent, type RoutineContent } from '../api/src/validation';

function content(): RoutineContent {
  return {
    schemaVersion: 1, name: 'Synthetic class',
    tracks: [{
      id: 'track-1', title: 'Synthetic song', duration: 60, bpm: 100, firstBeat: 0, bodyArea: '',
      cues: [{ id: 'cue-1', note: 'Start', anchor: { kind: 'timestamp', seconds: 0 } }],
    }],
    filler: { mode: 'timed', seconds: 15, bpm: 100, sound: 'soft' },
    crossfade: 2, beepEvery: 0, beepRemaining: 10,
  };
}

describe('strict routine content boundary', () => {
  it('preserves absent, none and custom after rules with detached filler metadata', () => {
    const raw = content();
    expect(parseRoutineContent(raw).tracks[0]).not.toHaveProperty('after');
    raw.tracks[0]!.after = { mode: 'none' };
    expect(parseRoutineContent(raw).tracks[0]!.after).toEqual({ mode: 'none' });
    for (const mode of ['none', 'timed', 'hold'] as const) {
      for (const sound of ['soft', 'bright', 'drums', 'lofi', 'recording'] as const) {
        const filler = { mode, seconds: 10, bpm: 100, sound, gain: 0.25,
          ...(sound === 'recording' ? { recording: { id: 'retained-loop', name: 'Literal loop', duration: 10,
            asset: { id: 'loop-asset', bytes: 44, sha256: 'a'.repeat(64), contentType: 'audio/wav' } } } : {}) };
        raw.tracks[0]!.after = { mode: 'custom', filler };
        const parsed = parseRoutineContent(raw);
        expect(parsed).toEqual(raw);
        expect(parsed.tracks[0]!.after).not.toHaveProperty('crossfade');
        const after = parsed.tracks[0]!.after!;
        if (after.mode !== 'custom') throw new Error('Unexpected fixture transition');
        expect(after.filler).not.toBe(filler);
        if (sound === 'recording') {
          expect(after.filler.recording).not.toBe(filler.recording);
          expect(after.filler.recording!.asset).not.toBe(filler.recording!.asset);
          after.filler.recording!.asset.sha256 = 'b'.repeat(64);
          expect(filler.recording!.asset.sha256).toBe('a'.repeat(64));
        }
        raw.tracks[0]!.after.crossfade = 0;
        expect(parseRoutineContent(raw).tracks[0]!.after).toMatchObject({ crossfade: 0 });
      }
    }
  });

  it('rejects malformed after variants, optional values and forged nested filler metadata', () => {
    const filler = content().filler;
    const recording = { id: 'recording', name: 'Loop', duration: 10,
      asset: { id: 'asset', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' } };
    const variants: unknown[] = [undefined, null, [], {}, 'none', { mode: 'inherit' }, { mode: 'none', filler },
      { mode: 'none', crossfade: 0 }, { mode: 'custom' }, { mode: 'custom', filler: null },
      { mode: 'custom', filler, extra: true }, { mode: 'custom', filler: { ...filler, unknown: true } },
      { mode: 'custom', filler: { ...filler, sound: 'recording', recording: { ...recording, duration: 361 } } },
      { mode: 'custom', filler: { ...filler, sound: 'recording', recording: { ...recording, asset: { ...recording.asset, url: 'https://example.invalid' } } } },
      ...[undefined, null, NaN, Infinity, -1, 12.01, '2'].map(crossfade => ({ mode: 'custom', filler, crossfade }))];
    for (const after of variants) {
      const raw = content();
      Object.assign(raw.tracks[0]!, { after });
      expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
    }
  });

  it('never invokes accessors or accepts inherited, symbolic or hidden after-rule fields', () => {
    let invoked = false;
    for (const target of ['after', 'filler', 'recording', 'asset'] as const) {
      for (const kind of ['prototype', 'accessor', 'hidden', 'symbol', 'unknown'] as const) {
        const raw = content();
        const recording = { id: 'recording', name: 'Loop', duration: 10,
          asset: { id: 'asset', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' } };
        const filler = { ...raw.filler, sound: 'recording' as const, recording };
        const after = { mode: 'custom' as const, filler };
        raw.tracks[0]!.after = after;
        const record = target === 'after' ? after : target === 'filler' ? filler : target === 'recording' ? recording : recording.asset;
        const key = target === 'after' || target === 'filler' ? 'mode' : 'id';
        if (kind === 'prototype') Object.setPrototypeOf(record, { inherited: true });
        else if (kind === 'accessor') Object.defineProperty(record, key, { enumerable: true, get() { invoked = true; return 'ignored'; } });
        else if (kind === 'hidden') Object.defineProperty(record, key, { enumerable: false });
        else Object.defineProperty(record, kind === 'symbol' ? Symbol('unknown') : 'unknown', { enumerable: true, value: true });
        expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400 }));
      }
    }
    expect(invoked).toBe(false);
  });

  it.each(['audio/aac', 'audio/webm'])('preserves exact native %s recording descriptors', contentType => {
    const raw = content();
    raw.filler.sound = 'recording';
    raw.filler.recording = { id: 'recording-1', name: 'Native loop', duration: 10,
      asset: { id: 'asset-1', sha256: 'a'.repeat(64), bytes: 128, contentType } };
    const parsed = parseRoutineContent(raw);
    expect(parsed).toStrictEqual(raw);
    expect(parsed.filler.recording!.asset).not.toBe(raw.filler.recording.asset);
    for (const bytes of ['128', 128.5, NaN, Infinity, 43, 128 * 1024 * 1024 + 1]) {
      const invalid = structuredClone(raw);
      Object.assign(invalid.filler.recording!.asset, { bytes });
      expect(() => parseRoutineContent(invalid)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
    }
  });

  it('rejects malformed, nonfinite and unknown nested recording fields', () => {
    const recording = { id: 'recording-1', name: 'Loop', duration: 10,
      asset: { id: 'asset-1', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' } };
    const invalid = [null, undefined, [], {},
      ...[0, -1, 360.01, NaN, Infinity, -Infinity, '10', null, undefined].map(duration => ({ ...recording, duration })),
      ...['', '../unsafe', 'a'.repeat(161), 1].map(id => ({ ...recording, id })),
      ...['', ' ', 'a'.repeat(161), null, 1].map(name => ({ ...recording, name })),
      ...[NaN, Infinity, 43, 44.1, 128 * 1024 * 1024 + 1, '44', null].map(bytes => ({ ...recording, asset: { ...recording.asset, bytes } })),
      ...[{ id: '../asset' }, { sha256: 'A'.repeat(64) }, { sha256: 'a' }, { contentType: 'audio/x-wav' },
        { contentType: 'text/html' }, { unknown: true }].map(change => ({ ...recording, asset: { ...recording.asset, ...change } }))];
    for (const value of invalid) {
      const raw = content();
      Object.assign(raw.filler, { sound: 'recording', recording: value });
      expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
    }
  });

  it('rejects recording prototypes, symbols, hidden fields and accessors without invoking them', () => {
    let invoked = false;
    for (const target of ['recording', 'asset']) {
      for (const kind of ['prototype', 'accessor', 'hidden', 'symbol', 'unknown', '__proto__', 'constructor']) {
        const raw = content();
        raw.filler.sound = 'recording';
        raw.filler.recording = { id: 'recording-1', name: 'Loop', duration: 10,
          asset: { id: 'asset-1', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' } };
        const value = target === 'recording' ? raw.filler.recording : raw.filler.recording.asset;
        if (kind === 'prototype') Object.setPrototypeOf(value, { inherited: true });
        else if (kind === 'accessor') Object.defineProperty(value, 'id', { enumerable: true, get() { invoked = true; return 'recording-1'; } });
        else if (kind === 'hidden') Object.defineProperty(value, 'id', { enumerable: false });
        else Object.defineProperty(value, kind === 'symbol' ? Symbol('id') : kind, { enumerable: true, value: 'injected' });
        expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
      }
    }
    expect(invoked).toBe(false);
  });

  it('accepts exact custom recording metadata and preserves it without aliasing', () => {
    const raw = content();
    raw.filler.sound = 'recording';
    raw.filler.recording = { id: 'recording-1', name: '<literal recording>', duration: 360,
      asset: { id: 'asset-1', sha256: 'a'.repeat(64), bytes: 44, contentType: 'audio/wav' } };
    const parsed = parseRoutineContent(raw);
    expect(parsed).toStrictEqual(raw);
    parsed.filler.recording!.asset.bytes = 128;
    parsed.filler.recording!.name = 'Changed';
    expect(raw.filler.recording.asset.bytes).toBe(44);
    expect(raw.filler.recording.name).toBe('<literal recording>');
    for (const sound of ['soft', 'bright', 'drums', 'lofi'] as const) {
      raw.filler.sound = sound;
      expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400 }));
      Object.assign(raw.filler, { recording: undefined });
      expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400 }));
    }
    delete raw.filler.recording;
    raw.filler.sound = 'recording';
    expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('returns an independent validated object', () => {
    const raw = content();
    const parsed = parseRoutineContent(raw);
    expect(parsed).toEqual(raw);
    raw.tracks[0].cues[0].note = 'Changed';
    parsed.filler.seconds = 20;
    expect(parsed.tracks[0].cues[0].note).toBe('Start');
    expect(raw.filler.seconds).toBe(15);
  });

  it.each([0, 0.375, 1, 1.5])('preserves independent optional gain %s without inserting defaults', gain => {
    for (const target of ['track', 'filler', 'both', 'neither']) {
      const raw = content();
      if (target === 'track' || target === 'both') raw.tracks[0].gain = gain;
      if (target === 'filler' || target === 'both') raw.filler.gain = 1.5 - gain;
      const parsed = parseRoutineContent(raw);
      expect(parsed).toStrictEqual(raw);
      expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(raw);
      parsed.tracks[0].gain = 0.25;
      parsed.filler.gain = 0.75;
      expect(raw.tracks[0].gain).toBe(target === 'track' || target === 'both' ? gain : undefined);
      expect(raw.filler.gain).toBe(target === 'filler' || target === 'both' ? 1.5 - gain : undefined);
    }
  });

  it.each([NaN, Infinity, -Infinity, -0.01, 1.500001, '1', null, undefined, true, 1n, Symbol('gain'), new Number(1)])(
    'rejects invalid optional gain %s', gain => {
      for (const target of ['track', 'filler']) {
        const raw = content();
        Object.assign(target === 'track' ? raw.tracks[0] : raw.filler, { gain });
        expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
      }
    },
  );

  it('rejects gain accessors, inherited gains, symbols and unknown fields without invoking accessors', () => {
    let invoked = false;
    for (const target of ['track', 'filler']) {
      for (const kind of ['accessor', 'hidden', 'prototype', 'symbol', '__proto__', 'constructor', 'unknown']) {
        const raw = content();
        const record = target === 'track' ? raw.tracks[0] : raw.filler;
        record.gain = 0.5;
        if (kind === 'accessor') Object.defineProperty(record, 'gain', { enumerable: true, get() { invoked = true; return 1; } });
        else if (kind === 'hidden') Object.defineProperty(record, 'gain', { enumerable: false });
        else if (kind === 'prototype') {
          delete record.gain;
          Object.setPrototypeOf(record, { gain: 1 });
        } else Object.defineProperty(record, kind === 'symbol' ? Symbol('gain') : kind, { value: 1, enumerable: true });
        expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
      }
    }
    const sparse = content();
    sparse.tracks[0].gain = 1;
    sparse.filler.gain = 1;
    sparse.tracks.length = 2;
    expect(() => parseRoutineContent(sparse)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
    expect(invoked).toBe(false);
  });

  it('preserves optional cue beep flags and rejects nonboolean flags', () => {
    const raw = content();
    raw.tracks[0].cues[0].beep = true;
    expect(parseRoutineContent(raw).tracks[0].cues[0].beep).toBe(true);
    raw.tracks[0].cues[0].beep = false;
    expect(parseRoutineContent(raw).tracks[0].cues[0].beep).toBe(false);
    for (const invalid of ['true', 1, null, undefined]) {
      const body = content();
      Object.assign(body.tracks[0].cues[0], { beep: invalid });
      expect(() => parseRoutineContent(body)).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });

  it.each([0, 0.5, 30, 1200])('retains single warning %s separately from countdown and periodic beeps', beepOnceRemaining => {
    const raw = { ...content(), beepEvery: 5, beepOnceRemaining };
    const parsed = parseRoutineContent(raw);
    expect(parsed).toStrictEqual(raw);
    expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(raw);
  });

  it.each([NaN, Infinity, -Infinity, -1, 1200.1, '30', null, undefined])('rejects invalid single warning %s', beepOnceRemaining => {
    expect(() => parseRoutineContent({ ...content(), beepOnceRemaining }))
      .toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
  });

  it.each([0, 0.25, 0.8, 1])('retains authored beep volume %s', beepVolume => {
    const raw = { ...content(), beepVolume };
    const parsed = parseRoutineContent(raw);
    expect(parsed).toStrictEqual(raw);
    expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(raw);
  });

  it.each([NaN, Infinity, -Infinity, -0.1, 1.1, '0.5', null, undefined])('rejects invalid beep volume %s', beepVolume => {
    expect(() => parseRoutineContent({ ...content(), beepVolume }))
      .toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
  });

  it('omits beep volume entirely when the author never set it', () => {
    const parsed = parseRoutineContent(content());
    expect(parsed).not.toHaveProperty('beepVolume');
  });

  it('rejects a single-warning accessor without invoking it', () => {
    let invoked = false;
    const raw = Object.defineProperty(content(), 'beepOnceRemaining', {
      enumerable: true, get() { invoked = true; return 30; },
    });
    expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
    expect(invoked).toBe(false);
  });

  it.each(['id', 'revision', 'locked', 'published', 'role', 'householdId', '__proto__', 'constructor', 'prototype'])('rejects body field %s', key => {
    for (const body of [content(), { ...content(), beepOnceRemaining: 30 }]) {
      const raw = { ...body, [key]: 'injected' };
      expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });

  it.each([null, undefined, [], 'routine', 7, true, {}, { tracks: null }])('rejects malformed root %j', raw => {
    expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it.each([NaN, Infinity, -Infinity, -1, 13, '2'])('rejects invalid crossfade %s', crossfade => {
    expect(() => parseRoutineContent({ ...content(), crossfade })).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('rejects inherited fields, getters, symbol fields and sparse arrays without invoking a getter', () => {
    let invoked = false;
    const inherited = Object.assign(Object.create({ role: 'owner' }), content());
    const getter = Object.defineProperty(content(), 'name', { enumerable: true, get() { invoked = true; return 'bad'; } });
    const symbol = { ...content(), [Symbol('role')]: 'owner' };
    const sparse = { ...content(), tracks: new Array(1) };
    for (const raw of [inherited, getter, symbol, sparse]) {
      expect(() => parseRoutineContent(raw)).toThrowError(expect.objectContaining({ status: 400 }));
    }
    expect(invoked).toBe(false);
  });
});


describe('nested runtime validation', () => {
  const invalidBodies: [string, () => unknown][] = [
    ['null filler', () => ({ ...content(), filler: null })],
    ['null tracks', () => ({ ...content(), tracks: null })],
    ['non-array tracks', () => ({ ...content(), tracks: {} })],
    ['null track', () => ({ ...content(), tracks: [null] })],
    ['missing track fields', () => ({ ...content(), tracks: [{ id: 'track' }] })],
    ['non-array cues', () => ({ ...content(), tracks: [{ ...content().tracks[0], cues: {} }] })],
    ['null cue', () => ({ ...content(), tracks: [{ ...content().tracks[0], cues: [null] }] })],
    ['null anchor', () => ({ ...content(), tracks: [{ ...content().tracks[0], cues: [{ ...content().tracks[0].cues[0], anchor: null }] }] })],
    ['unexpected anchor fields', () => ({ ...content(), tracks: [{ ...content().tracks[0], cues: [{ ...content().tracks[0].cues[0], anchor: { kind: 'timestamp', seconds: 0, count: 1 } }] }] })],
    ['string name', () => ({ ...content(), name: { trim: () => 'fake' } })],
    ['unsupported schema', () => ({ ...content(), schemaVersion: 3 })],
    ['string schema', () => ({ ...content(), schemaVersion: '1' })],
    ['boxed number', () => ({ ...content(), crossfade: new Number(2) })],
    ['bigint timing', () => ({ ...content(), beepEvery: 1n })],
    ['unknown filler field', () => ({ ...content(), filler: { ...content().filler, role: 'owner' } })],
    ['unknown track field', () => ({ ...content(), tracks: [{ ...content().tracks[0], locked: false }] })],
    ['unknown cue field', () => ({ ...content(), tracks: [{ ...content().tracks[0], cues: [{ ...content().tracks[0].cues[0], published: true }] }] })],
    ['unknown filler mode', () => ({ ...content(), filler: { ...content().filler, mode: 'loop' } })],
    ['unknown filler sound', () => ({ ...content(), filler: { ...content().filler, sound: 'other' } })],
    ['JSON prototype key', () => ({ ...content(), filler: JSON.parse('{"mode":"none","seconds":0,"bpm":100,"sound":"soft","__proto__":{"active":true}}') })],
  ];

  it.each(invalidBodies)('rejects %s with a domain error', (_name, makeBody) => {
    expect(() => parseRoutineContent(makeBody())).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_input' }));
  });

  const invalidChanges: [string, (body: RoutineContent) => void][] = [
    ['empty name', body => { body.name = ' '; }],
    ['long name', body => { body.name = 'a'.repeat(161); }],
    ['empty track ID', body => { body.tracks[0].id = ''; }],
    ['long track ID', body => { body.tracks[0].id = 'a'.repeat(161); }],
    ['empty title', body => { body.tracks[0].title = ' '; }],
    ['long title', body => { body.tracks[0].title = 'a'.repeat(301); }],
    ['long body area', body => { body.tracks[0].bodyArea = 'a'.repeat(161); }],
    ['empty cue ID', body => { body.tracks[0].cues[0].id = ''; }],
    ['empty cue note', body => { body.tracks[0].cues[0].note = ''; }],
    ['long cue note', body => { body.tracks[0].cues[0].note = 'a'.repeat(501); }],
    ['zero duration', body => { body.tracks[0].duration = 0; }],
    ['long duration', body => { body.tracks[0].duration = 1201; }],
    ['NaN duration', body => { body.tracks[0].duration = NaN; }],
    ['infinite BPM', body => { body.tracks[0].bpm = Infinity; }],
    ['low BPM', body => { body.tracks[0].bpm = 39; }],
    ['high BPM', body => { body.tracks[0].bpm = 221; }],
    ['beat beyond track', body => { body.tracks[0].firstBeat = 60; }],
    ['negative beat', body => { body.tracks[0].firstBeat = -1; }],
    ['NaN beat', body => { body.tracks[0].firstBeat = NaN; }],
    ['long filler', body => { body.filler.seconds = 601; }],
    ['negative filler', body => { body.filler.seconds = -1; }],
    ['NaN filler', body => { body.filler.seconds = NaN; }],
    ['low filler BPM', body => { body.filler.bpm = 39; }],
    ['high filler BPM', body => { body.filler.bpm = 221; }],
    ['negative beeps', body => { body.beepEvery = -1; }],
    ['NaN beeps', body => { body.beepEvery = NaN; }],
    ['infinite remaining', body => { body.beepRemaining = Infinity; }],
    ['unsafe remaining', body => { body.beepRemaining = Number.MAX_SAFE_INTEGER + 1; }],
    ['timestamp outside track', body => { body.tracks[0].cues[0].anchor = { kind: 'timestamp', seconds: 60 }; }],
    ['interval outside track', body => { body.tracks[0].cues[0].anchor = { kind: 'interval', seconds: 60 }; }],
    ['NaN anchor', body => { body.tracks[0].cues[0].anchor = { kind: 'timestamp', seconds: NaN }; }],
    ['zero count', body => { body.tracks[0].cues[0].anchor = { kind: 'count', count: 0 }; }],
    ['fractional count', body => { body.tracks[0].cues[0].anchor = { kind: 'count', count: 1.5 }; }],
    ['count outside track', body => { body.tracks[0].cues[0].anchor = { kind: 'count', count: 101 }; }],
    ['duplicate tracks', body => { body.tracks.push(structuredClone(body.tracks[0])); }],
    ['duplicate cues', body => { body.tracks[0].cues.push(structuredClone(body.tracks[0].cues[0])); }],
    ['too many tracks', body => { body.tracks = Array.from({ length: 101 }, (_, index) => ({ ...body.tracks[0], id: `track-${index}` })); }],
    ['too many cues', body => { body.tracks[0].cues = Array.from({ length: 1001 }, (_, index) => ({ ...body.tracks[0].cues[0], id: `cue-${index}` })); }],
  ];

  it.each(invalidChanges)('rejects %s without changing the input', (_name, change) => {
    const body = content();
    change(body);
    const before = structuredClone(body);
    expect(() => parseRoutineContent(body)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(body).toEqual(before);
  });

  it('accepts all three cue modes, repeated media with unique entry IDs, and literal user text', () => {
    const body = content();
    body.tracks[0].cues = [
      { id: 'timestamp', anchor: { kind: 'timestamp', seconds: 0 }, note: '<script>plain text</script>' },
      { id: 'count', anchor: { kind: 'count', count: 2 }, note: 'Count' },
      { id: 'interval', anchor: { kind: 'interval', seconds: 2 }, note: 'Interval' },
    ];
    body.tracks.push({ ...structuredClone(body.tracks[0]), id: 'repeat-entry' });
    expect(parseRoutineContent(body)).toEqual(body);
  });

  it('accepts valid boundary values and plain null-prototype records', () => {
    const body = content();
    body.crossfade = 12;
    body.filler.seconds = 600;
    body.filler.bpm = 220;
    body.tracks[0].duration = 1200;
    body.tracks[0].bpm = 40;
    expect(parseRoutineContent(Object.assign(Object.create(null), body))).toEqual(body);
  });

  it('rejects nested accessors and exotic arrays without executing accessors', () => {
    let invoked = false;
    const bodies = [content(), content(), content(), content(), content()];
    Object.defineProperty(bodies[0].tracks[0], 'title', { enumerable: true, get() { invoked = true; return 'bad'; } });
    Object.defineProperty(bodies[1].tracks[0].cues[0].anchor, 'kind', { enumerable: true, get() { invoked = true; return 'timestamp'; } });
    Object.defineProperty(bodies[2].tracks, '0', { enumerable: true, get() { invoked = true; return content().tracks[0]; } });
    Object.setPrototypeOf(bodies[3].tracks, { role: 'owner' });
    Object.defineProperty(bodies[4].filler, 'role', { value: 'owner', enumerable: false });
    for (const body of bodies) expect(() => parseRoutineContent(body)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(invoked).toBe(false);
  });

  it('fails closed for a revoked proxy instead of leaking a native exception', () => {
    const revocable = Proxy.revocable(content(), {});
    revocable.revoke();
    expect(() => parseRoutineContent(revocable.proxy)).toThrowError(expect.objectContaining({ status: 400 }));
  });
});
