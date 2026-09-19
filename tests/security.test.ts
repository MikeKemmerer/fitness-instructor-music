import { describe, expect, it } from 'vitest';
import type { VerifiedPrincipal } from '../api/src/auth';
import { MembershipService } from '../api/src/memberships';
import { RoutineService } from '../api/src/routines';
import { memberKey } from '../api/src/repository';
import { parseRoutineContent, type RoutineContent } from '../api/src/validation';
import { TestOnlyInMemoryRepository } from '../api/testing/in-memory-repository';

function principal(objectId: string, scopes = ['routines.access'], tenantId = 'test-tenant'): VerifiedPrincipal {
  return Object.freeze({ tenantId, objectId, scopes: Object.freeze([...scopes]) }) as unknown as VerifiedPrincipal;
}

const owner = principal('owner');
const editor = principal('editor');
const player = principal('player');
const householdId = 'test-household';

function setup(twoOwners = false) {
  const members = [
    { tenantId: 'test-tenant', objectId: 'owner', role: 'owner' as const, active: true },
    { tenantId: 'test-tenant', objectId: 'editor', role: 'editor' as const, active: true },
    { tenantId: 'test-tenant', objectId: 'player', role: 'player' as const, active: true },
  ];
  if (twoOwners) members.push({ tenantId: 'test-tenant', objectId: 'owner-2', role: 'owner', active: true });
  const repository = new TestOnlyInMemoryRepository([{ householdId, members }]);
  const policy = { tenantId: 'test-tenant', requiredScope: 'routines.access' };
  return { repository, routines: new RoutineService(repository, policy), memberships: new MembershipService(repository, policy) };
}

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

describe('authorized routine kernel', () => {
  it('keeps an omitted warning absent through parsing and routine mutations', async () => {
    const raw = content();
    const parsed = parseRoutineContent(raw);
    expect(parsed).toStrictEqual(raw);
    expect(parsed).not.toHaveProperty('beepOnceRemaining');
    expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(raw);
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, raw);
    const saved = await routines.save(editor, householdId, draft.id, draft.revision, raw);
    const published = await routines.publish(owner, householdId, draft.id, saved.revision);
    const locked = await routines.lock(editor, householdId, draft.id, published.revision);
    const copy = await routines.duplicate(editor, householdId, draft.id);
    const publishedCopy = await routines.duplicate(editor, householdId, draft.id, published.revision);
    const unlocked = await routines.unlock(owner, householdId, draft.id, locked.revision);
    for (const routine of [draft, saved, published, locked, copy, publishedCopy, unlocked]) {
      expect(routine).not.toHaveProperty('beepOnceRemaining');
      expect(routine.tracks).toStrictEqual(raw.tracks);
      expect(routine.filler).toStrictEqual(raw.filler);
      expect(routine.tracks[0]).not.toHaveProperty('gain');
      expect(routine.filler).not.toHaveProperty('gain');
    }
  });

  it('preserves gains across domain snapshots and copies with lock, revision and playback-role guards', async () => {
    const { routines } = setup();
    const raw = content();
    raw.tracks[0].gain = 0;
    raw.filler.gain = 1.5;
    const draft = await routines.create(owner, householdId, raw);
    expect(draft.tracks).toStrictEqual(raw.tracks);
    expect(draft.filler).toStrictEqual(raw.filler);
    raw.tracks[0].gain = 0.875;
    raw.filler.gain = 0.375;
    const saved = await routines.save(editor, householdId, draft.id, draft.revision, raw);
    const published = await routines.publish(owner, householdId, draft.id, saved.revision);
    const head = await routines.getDraft(owner, householdId, draft.id);
    expect(head).toMatchObject({ id: draft.id, revision: published.revision, published: false, locked: false });
    expect(head.tracks).toStrictEqual(raw.tracks);
    expect(head.filler).toStrictEqual(raw.filler);
    expect(draft.tracks[0].gain).toBe(0);
    expect(draft.filler.gain).toBe(1.5);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(published);
    expect(await routines.listPublished(player, householdId)).toEqual([published]);
    await expect(routines.getDraft(player, householdId, draft.id)).rejects.toMatchObject({ status: 403 });
    await expect(routines.save(player, householdId, draft.id, head.revision, raw)).rejects.toMatchObject({ status: 403 });
    await expect(routines.publish(player, householdId, draft.id, head.revision)).rejects.toMatchObject({ status: 403 });
    await expect(routines.duplicate(player, householdId, draft.id, published.revision)).rejects.toMatchObject({ status: 403 });
    expect(() => { published.tracks[0].gain = 1; }).toThrow(TypeError);
    expect(() => { published.filler.gain = 1; }).toThrow(TypeError);
    const locked = await routines.lock(editor, householdId, draft.id, head.revision);
    const copies = [
      await routines.duplicate(editor, householdId, draft.id),
      await routines.duplicate(editor, householdId, draft.id, published.revision),
    ];
    for (const snapshot of [saved, published, locked, ...copies]) {
      expect(snapshot.tracks).toStrictEqual(raw.tracks);
      expect(snapshot.filler).toStrictEqual(raw.filler);
    }
    for (const copy of copies) {
      expect(copy.id).not.toBe(draft.id);
      expect(copy).toMatchObject({ revision: 1, locked: false, published: false });
    }
    for (const target of ['track', 'filler']) {
      const changed = structuredClone(raw);
      (target === 'track' ? changed.tracks[0] : changed.filler).gain = 1;
      await expect(routines.save(owner, householdId, draft.id, locked.revision, changed))
        .rejects.toMatchObject({ status: 423, code: 'routine_locked' });
    }
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(locked);
    const unlocked = await routines.unlock(owner, householdId, draft.id, locked.revision);
    const legacy = content();
    await expect(routines.save(owner, householdId, draft.id, saved.revision, legacy))
      .rejects.toMatchObject({ status: 412, code: 'revision_conflict' });
    const updated = await routines.save(owner, householdId, draft.id, unlocked.revision, legacy);
    expect(updated.id).toBe(draft.id);
    expect(updated.tracks).toStrictEqual(legacy.tracks);
    expect(updated.filler).toStrictEqual(legacy.filler);
    const nextPublication = await routines.publish(editor, householdId, draft.id, updated.revision);
    expect(nextPublication.tracks[0]).not.toHaveProperty('gain');
    expect(nextPublication.filler).not.toHaveProperty('gain');
    expect(await routines.getPublished(player, householdId, draft.id, published.revision)).toEqual(published);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(nextPublication);
  });

  it('protects single warnings with locks and retains independent published versions and copies', async () => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, { ...content(), beepOnceRemaining: 30 });
    expect(draft.beepOnceRemaining).toBe(30);
    const warning = { ...content(), beepOnceRemaining: 45 };
    const saved = await routines.save(editor, householdId, draft.id, draft.revision, warning);
    expect(saved).toMatchObject({ beepOnceRemaining: 45, beepRemaining: 10, beepEvery: 0 });
    const first = await routines.publish(owner, householdId, draft.id, saved.revision);
    const locked = await routines.lock(editor, householdId, draft.id, first.revision);
    expect(locked.beepOnceRemaining).toBe(45);
    const disabled = { ...content(), beepOnceRemaining: 0 };
    await expect(routines.save(owner, householdId, draft.id, locked.revision, disabled))
      .rejects.toMatchObject({ status: 423, code: 'routine_locked' });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(locked);
    const copy = await routines.duplicate(editor, householdId, draft.id);
    expect(copy).toMatchObject({ beepOnceRemaining: 45, locked: false, revision: 1 });
    expect(copy.id).not.toBe(draft.id);
    const unlocked = await routines.unlock(owner, householdId, draft.id, locked.revision);
    expect(unlocked.beepOnceRemaining).toBe(45);
    await expect(routines.save(editor, householdId, draft.id, saved.revision, disabled))
      .rejects.toMatchObject({ status: 412, code: 'revision_conflict' });
    const updated = await routines.save(editor, householdId, draft.id, unlocked.revision, disabled);
    const second = await routines.publish(owner, householdId, draft.id, updated.revision);
    expect(second).toMatchObject({ beepOnceRemaining: 0, beepRemaining: 10, beepEvery: 0 });
    expect(first.beepOnceRemaining).toBe(45);
    expect(await routines.getPublished(player, householdId, draft.id, first.revision)).toEqual(first);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(second);
    const publishedCopy = await routines.duplicate(editor, householdId, draft.id, first.revision);
    expect(publishedCopy).toMatchObject({ beepOnceRemaining: 45, locked: false, published: false });
    expect(() => { first.beepOnceRemaining = 10; }).toThrow(TypeError);
    expect(await routines.getDraft(editor, householdId, copy.id)).toEqual(copy);
  });

  it('guards draft reads and publishes a separately frozen snapshot', async () => {
    const { routines } = setup();
    const draft = await routines.create(editor, householdId, content());
    await expect(routines.getDraft(player, householdId, draft.id)).rejects.toMatchObject({ status: 403 });
    const published = await routines.publish(owner, householdId, draft.id, draft.revision);
    expect(published.revision).toBe(2);
    expect(Object.isFrozen(published.tracks[0].cues[0].anchor)).toBe(true);
    await routines.save(editor, householdId, draft.id, 2, { ...content(), name: 'New draft' });
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(published);
  });

  it('requires explicit unlock even for an owner and rejects a stale save after a lock cycle', async () => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    const locked = await routines.lock(editor, householdId, draft.id, 1);
    await expect(routines.save(owner, householdId, draft.id, locked.revision, content())).rejects.toMatchObject({ status: 423 });
    const unlocked = await routines.unlock(owner, householdId, draft.id, locked.revision);
    expect(unlocked.revision).toBe(3);
    await expect(routines.save(editor, householdId, draft.id, 1, content())).rejects.toMatchObject({ status: 412 });
  });

  it('preserves a last owner under simultaneous self demotions', async () => {
    const { memberships } = setup(true);
    const results = await Promise.allSettled(['owner', 'owner-2'].map(objectId => memberships.set(
      principal(objectId), householdId, 1, { tenantId: 'test-tenant', objectId, role: 'editor', active: true },
    )));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { status: 412 } });
    const remaining = await memberships.list(principal('owner-2'), householdId);
    expect(remaining.members.filter(member => member.active && member.role === 'owner')).toHaveLength(1);
    await expect(memberships.set(principal('owner-2'), householdId, remaining.revision,
      { tenantId: 'test-tenant', objectId: 'owner-2', role: 'editor', active: true })).rejects.toMatchObject({ code: 'last_owner_required' });
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

const mutations = ['save', 'publish', 'delete', 'lock', 'unlock'] as const;
type Mutation = typeof mutations[number];

function mutate(routines: RoutineService, operation: Mutation, actor: VerifiedPrincipal | null, id: string, revision: unknown, input: unknown = content()) {
  return operation === 'save'
    ? routines.save(actor, householdId, id, revision, input)
    : routines[operation](actor, householdId, id, revision);
}

describe('role and identity matrix', () => {
  it.each([owner, editor])('%j can collaborate, publish, duplicate and delete', async actor => {
    const { routines } = setup();
    const draft = await routines.create(actor, householdId, content());
    expect(await routines.getDraft(actor, householdId, draft.id)).toEqual(draft);
    expect(await routines.listDrafts(actor, householdId)).toEqual([draft]);
    const saved = await routines.save(actor, householdId, draft.id, 1, content());
    const published = await routines.publish(actor, householdId, draft.id, saved.revision);
    const locked = await routines.lock(actor, householdId, draft.id, published.revision);
    const unlocked = await routines.unlock(actor, householdId, draft.id, locked.revision);
    const copy = await routines.duplicate(actor, householdId, draft.id);
    expect(copy.id).not.toBe(draft.id);
    await routines.delete(actor, householdId, draft.id, unlocked.revision);
    await expect(routines.getDraft(actor, householdId, draft.id)).rejects.toMatchObject({ status: 404 });
  });

  it.each([owner, editor, player])('%j may read only published content through publication APIs', async actor => {
    const { routines } = setup();
    const draft = await routines.create(editor, householdId, content());
    expect(await routines.listPublished(actor, householdId)).toEqual([]);
    await expect(routines.getPublished(actor, householdId, draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(routines.getPublished(actor, householdId, draft.id, 1)).rejects.toMatchObject({ status: 404 });
    const published = await routines.publish(owner, householdId, draft.id, 1);
    expect(await routines.getPublished(actor, householdId, draft.id)).toEqual(published);
    expect(await routines.listPublished(actor, householdId)).toEqual([published]);
  });

  it.each(mutations)('player cannot %s even with a forged principal role', async operation => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    const forged = { ...player, role: 'owner', active: true } as VerifiedPrincipal;
    await expect(mutate(routines, operation, forged, draft.id, 1)).rejects.toMatchObject({ status: 403 });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(draft);
  });

  it('player cannot create, duplicate either source, read drafts or list drafts', async () => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    const published = await routines.publish(owner, householdId, draft.id, 1);
    const calls = [
      routines.create(player, householdId, content()),
      routines.getDraft(player, householdId, draft.id),
      routines.listDrafts(player, householdId),
      routines.duplicate(player, householdId, draft.id),
      routines.duplicate(player, householdId, draft.id, published.revision),
    ];
    expect(await Promise.allSettled(calls)).toEqual(calls.map(() => expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 403 }) })));
  });

  it.each([
    ['missing identity', null, 401],
    ['missing scope', principal('owner', []), 403],
    ['substring scope', principal('owner', ['routines.access.extra']), 403],
    ['wrong tenant', principal('owner', ['routines.access'], 'other-tenant'), 403],
    ['unknown member', principal('outsider'), 403],
  ] as const)('rejects %s on reads and writes', async (_name, actor, status) => {
    const { routines, memberships } = setup();
    await expect(routines.listPublished(actor, householdId)).rejects.toMatchObject({ status });
    await expect(routines.create(actor, householdId, content())).rejects.toMatchObject({ status });
    await expect(memberships.list(actor, householdId)).rejects.toMatchObject({ status });
  });

  it('does not accept body/header identity in place of a trusted adapter principal', async () => {
    const { routines } = setup();
    await expect(routines.create(null, householdId, {
      ...content(), role: 'owner', principal: owner, 'x-ms-client-principal': 'untrusted',
    })).rejects.toMatchObject({ status: 401 });
  });

  it('denies inactive membership even with a previously verified principal', async () => {
    const { routines, memberships } = setup();
    await memberships.set(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'editor', role: 'editor', active: false });
    await expect(routines.listDrafts(editor, householdId)).rejects.toMatchObject({ status: 403 });
    await expect(routines.listPublished(editor, householdId)).rejects.toMatchObject({ status: 403 });
    await expect(routines.create(editor, householdId, content())).rejects.toMatchObject({ status: 403 });
  });

  it('isolates households and cannot find another household routine by ID', async () => {
    const repository = new TestOnlyInMemoryRepository([
      { householdId, members: [{ tenantId: 'test-tenant', objectId: 'owner', role: 'owner', active: true }] },
      { householdId: 'other-household', members: [{ tenantId: 'test-tenant', objectId: 'other-owner', role: 'owner', active: true }] },
    ]);
    const routines = new RoutineService(repository, { tenantId: 'test-tenant', requiredScope: 'routines.access' });
    const draft = await routines.create(owner, householdId, content());
    await routines.publish(owner, householdId, draft.id, 1);
    await expect(routines.getPublished(principal('other-owner'), householdId, draft.id)).rejects.toMatchObject({ status: 403 });
    await expect(routines.getPublished(principal('other-owner'), 'other-household', draft.id)).rejects.toMatchObject({ status: 404 });
    expect(await routines.listPublished(principal('other-owner'), 'other-household')).toEqual([]);
  });
});

describe('same-head revision preconditions', () => {
  it.each(mutations)('%s requires an expected revision and rejects invalid revisions', async operation => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    for (const missing of [undefined, null]) {
      await expect(mutate(routines, operation, owner, draft.id, missing)).rejects.toMatchObject({ status: 428 });
    }
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', '*', {}, true]) {
      await expect(mutate(routines, operation, owner, draft.id, invalid)).rejects.toMatchObject({ status: 400 });
    }
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(draft);
  });

  it.each(mutations)('%s rejects stale revisions and unknown IDs without writing', async operation => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    await expect(mutate(routines, operation, owner, draft.id, 2)).rejects.toMatchObject({ status: 412 });
    await expect(mutate(routines, operation, owner, 'missing', 1)).rejects.toMatchObject({ status: 404 });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(draft);
  });

  it.each(['save', 'publish', 'delete'] as const)('lock blocks owner %s and stale locked writes with 423', async operation => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    const locked = await routines.lock(editor, householdId, draft.id, 1);
    await expect(mutate(routines, operation, owner, draft.id, locked.revision)).rejects.toMatchObject({ status: 423, code: 'routine_locked' });
    await expect(mutate(routines, operation, owner, draft.id, 1)).rejects.toMatchObject({ status: 423 });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(locked);
  });

  it.each([[owner, editor], [editor, owner], [editor, editor]] as const)('any owner/editor can unlock another editor or owner lock', async (locker, unlocker) => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    const locked = await routines.lock(locker, householdId, draft.id, 1);
    expect(await routines.unlock(unlocker, householdId, draft.id, locked.revision)).toMatchObject({ locked: false, revision: 3 });
  });

  it('explicit repeated lock/unlock commands still advance the head', async () => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    await routines.unlock(editor, householdId, draft.id, 1);
    await routines.lock(owner, householdId, draft.id, 2);
    expect(await routines.lock(editor, householdId, draft.id, 3)).toMatchObject({ locked: true, revision: 4 });
    await expect(routines.unlock(owner, householdId, draft.id, 3)).rejects.toMatchObject({ status: 412 });
  });

  it.each(['id', 'revision', 'locked', 'published', 'role', 'active', 'householdId', '__proto__', 'constructor'])('save rejects mass assignment of %s atomically', async key => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    await expect(routines.save(editor, householdId, draft.id, 1, { ...content(), [key]: 'injected' })).rejects.toMatchObject({ status: 400 });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(draft);
    expect(await routines.listPublished(player, householdId)).toEqual([]);
  });

  it.each(mutations)('%s does not overflow the safe revision counter', async operation => {
    const { routines, repository } = setup();
    const draft = await routines.create(owner, householdId, content());
    await repository.transact(householdId, state => { state.routines.get(draft.id)!.draft.revision = Number.MAX_SAFE_INTEGER; });
    await expect(mutate(routines, operation, owner, draft.id, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ status: 412 });
    expect((await routines.getDraft(owner, householdId, draft.id)).revision).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('publication and clone isolation', () => {
  it('does not retain mutable input, result, read, list, or nested references', async () => {
    const { routines } = setup();
    const body = content();
    const created = await routines.create(owner, householdId, body);
    const original = structuredClone(created);
    body.tracks[0].cues[0].note = 'Input mutation';
    created.tracks[0].cues[0].anchor = { kind: 'interval', seconds: 20 };
    created.filler.seconds = 500;
    const fetched = await routines.getDraft(editor, householdId, created.id);
    expect(fetched).toEqual(original);
    fetched.tracks[0].title = 'Read mutation';
    const listed = await routines.listDrafts(editor, householdId);
    listed[0].name = 'List mutation';
    expect(await routines.getDraft(owner, householdId, created.id)).toEqual(original);
    const saved = await routines.save(editor, householdId, created.id, 1, content());
    saved.tracks.length = 0;
    expect((await routines.getDraft(owner, householdId, created.id)).tracks).toHaveLength(1);
  });

  it('keeps every publication stable through saves, republishing, locks and unlocks', async () => {
    const { routines } = setup();
    const draft = await routines.create(editor, householdId, content());
    const first = await routines.publish(editor, householdId, draft.id, 1);
    const nextBody = { ...content(), name: 'Updated class' };
    await routines.save(owner, householdId, draft.id, 2, nextBody);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(first);
    const second = await routines.publish(owner, householdId, draft.id, 3);
    expect(second).toMatchObject({ revision: 4, name: 'Updated class', published: true });
    await routines.lock(owner, householdId, draft.id, 4);
    expect(await routines.getPublished(player, householdId, draft.id, 2)).toEqual(first);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(second);
    await routines.unlock(editor, householdId, draft.id, 5);
    expect(await routines.getPublished(player, householdId, draft.id, 2)).toEqual(first);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(second);
    await expect(routines.getPublished(player, householdId, draft.id, 3)).rejects.toMatchObject({ status: 404 });
    expect(() => { first.tracks[0].cues[0].note = 'Mutated'; }).toThrow(TypeError);
    expect(() => { second.filler.seconds = 50; }).toThrow(TypeError);
    const fetched = await routines.getPublished(player, householdId, draft.id, 2);
    expect(fetched).not.toBe(first);
    expect(fetched.tracks[0]).not.toBe(first.tracks[0]);
    const listed = await routines.listPublished(player, householdId);
    expect(Object.isFrozen(listed[0].tracks)).toBe(true);
  });

  it('failed publication of an empty saved draft changes no head or existing publication', async () => {
    const { routines, repository } = setup();
    const draft = await routines.create(owner, householdId, content());
    const publication = await routines.publish(owner, householdId, draft.id, 1);
    await routines.save(editor, householdId, draft.id, 2, { ...content(), tracks: [] });
    const before = await repository.transact(householdId, state => state);
    await expect(routines.publish(editor, householdId, draft.id, 3)).rejects.toMatchObject({ status: 400, code: 'publication_requires_tracks' });
    expect(await repository.transact(householdId, state => state)).toEqual(before);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(publication);
  });

  it('revalidates persisted content at publication and rolls back malformed data', async () => {
    const { routines, repository } = setup();
    const draft = await routines.create(owner, householdId, content());
    await repository.transact(householdId, state => { state.routines.get(draft.id)!.draft.tracks[0].bpm = NaN; });
    const before = await repository.transact(householdId, state => state);
    await expect(routines.publish(owner, householdId, draft.id, 1)).rejects.toMatchObject({ status: 400 });
    expect(await repository.transact(householdId, state => state)).toEqual(before);
  });

  it('refuses to replace a publication even if a corrupt repository already contains that revision', async () => {
    const { routines, repository } = setup();
    const draft = await routines.create(owner, householdId, content());
    await repository.transact(householdId, state => { state.routines.get(draft.id)!.publications.set(2, { ...draft, revision: 2, published: true }); });
    const before = await repository.transact(householdId, state => state);
    await expect(routines.publish(owner, householdId, draft.id, 1)).rejects.toMatchObject({ status: 412, code: 'publication_exists' });
    expect(await repository.transact(householdId, state => state)).toEqual(before);
  });

  it('duplicates a selected saved publication or locked draft into a new independent unlocked draft', async () => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    const published = await routines.publish(owner, householdId, draft.id, 1);
    await routines.save(owner, householdId, draft.id, 2, { ...content(), name: 'Draft only' });
    const locked = await routines.lock(owner, householdId, draft.id, 3);
    const copy = await routines.duplicate(editor, householdId, draft.id, published.revision);
    const draftCopy = await routines.duplicate(editor, householdId, draft.id);
    expect(copy).toMatchObject({ locked: false, published: false, revision: 1, name: 'Synthetic class' });
    expect(draftCopy).toMatchObject({ locked: false, published: false, revision: 1, name: 'Draft only' });
    expect(new Set([draft.id, copy.id, draftCopy.id]).size).toBe(3);
    await routines.save(editor, householdId, copy.id, 1, { ...content(), name: 'Copy only' });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(locked);
    expect(await routines.getPublished(player, householdId, draft.id)).toEqual(published);
    await expect(routines.getPublished(player, householdId, copy.id)).rejects.toMatchObject({ status: 404 });
    await expect(routines.duplicate(editor, householdId, draft.id, 3)).rejects.toMatchObject({ status: 404 });
  });

  it('deletes by guarded tombstone without exposing retained snapshots or reviving IDs', async () => {
    const { routines, repository } = setup();
    const draft = await routines.create(owner, householdId, content());
    const published = await routines.publish(owner, householdId, draft.id, 1);
    expect(await routines.delete(editor, householdId, draft.id, 2)).toEqual({ id: draft.id, revision: 3 });
    for (const operation of mutations) await expect(mutate(routines, operation, owner, draft.id, 3)).rejects.toMatchObject({ status: 404 });
    await expect(routines.getPublished(player, householdId, draft.id, 2)).rejects.toMatchObject({ status: 404 });
    await expect(routines.duplicate(editor, householdId, draft.id)).rejects.toMatchObject({ status: 404 });
    expect(await routines.listDrafts(owner, householdId)).toEqual([]);
    expect(await routines.listPublished(player, householdId)).toEqual([]);
    const tombstone = await repository.transact(householdId, state => state.routines.get(draft.id));
    expect(tombstone?.publications.get(2)).toEqual(published);
  });
});

describe('serializable race outcomes in the test repository', () => {
  it.each([
    ['lock', 'save', 423], ['save', 'lock', 412],
    ['lock', 'publish', 423], ['publish', 'lock', 412],
    ['lock', 'delete', 423], ['delete', 'lock', 404],
    ['save', 'save', 412], ['publish', 'publish', 412], ['lock', 'lock', 412],
  ] as const)('%s racing %s commits one head change', async (first, second, rejectedStatus) => {
    const { routines, repository } = setup();
    const otherService = new RoutineService(repository, { tenantId: 'test-tenant', requiredScope: 'routines.access' });
    const draft = await routines.create(owner, householdId, content());
    const results = await Promise.allSettled([
      mutate(routines, first, owner, draft.id, 1),
      mutate(otherService, second, editor, draft.id, 1),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: rejectedStatus } });
    const head = await repository.transact(householdId, state => state.routines.get(draft.id));
    expect(head?.draft.revision).toBe(2);
    expect(head?.publications.size).toBe(first === 'publish' ? 1 : 0);
    expect(head?.deleted).toBe(first === 'delete');
    expect(head?.draft.locked).toBe(first === 'lock');
  });

  it.each([true, false])('unlock/save race with unlock first = %s cannot apply the stale save', async unlockFirst => {
    const { routines } = setup();
    const draft = await routines.create(owner, householdId, content());
    await routines.lock(owner, householdId, draft.id, 1);
    const commands = unlockFirst ? ['unlock', 'save'] as const : ['save', 'unlock'] as const;
    const results = await Promise.allSettled(commands.map(operation => mutate(routines, operation, editor, draft.id, 2)));
    expect(results[unlockFirst ? 0 : 1].status).toBe('fulfilled');
    expect(results[unlockFirst ? 1 : 0]).toMatchObject({ status: 'rejected', reason: { status: unlockFirst ? 412 : 423 } });
    expect(await routines.getDraft(owner, householdId, draft.id)).toMatchObject({ revision: 3, locked: false });
  });

  it('rechecks current membership inside the same transaction after a queued revocation', async () => {
    const { routines, memberships } = setup();
    const draft = await routines.create(owner, householdId, content());
    const results = await Promise.allSettled([
      memberships.remove(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'editor' }),
      routines.save(editor, householdId, draft.id, 1, { ...content(), name: 'Must not commit' }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 403 } });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(draft);
  });
});

describe('owner-only membership administration', () => {
  it.each([editor, player, principal('visitor')])('%j cannot list, add, promote, remove, or self-promote membership', async actor => {
    const { memberships } = setup();
    await expect(memberships.list(actor, householdId)).rejects.toMatchObject({ status: 403 });
    await expect(memberships.set(actor, householdId, 1, { tenantId: 'test-tenant', objectId: actor.objectId, role: 'owner', active: true })).rejects.toMatchObject({ status: 403 });
    await expect(memberships.remove(actor, householdId, 1, { tenantId: 'test-tenant', objectId: 'owner' })).rejects.toMatchObject({ status: 403 });
  });

  it('never bootstraps a first visitor or promotes anyone by default', async () => {
    const repository = new TestOnlyInMemoryRepository([{ householdId, members: [] }]);
    const policy = { tenantId: 'test-tenant', requiredScope: 'routines.access' };
    const memberships = new MembershipService(repository, policy);
    const routines = new RoutineService(repository, policy);
    await expect(memberships.set(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'owner', role: 'owner', active: true })).rejects.toMatchObject({ status: 403 });
    await expect(routines.create(owner, householdId, content())).rejects.toMatchObject({ status: 403 });
    expect((await repository.transact(householdId, state => state.members)).size).toBe(0);
  });

  it('owner explicitly adds a second owner with immediate authority', async () => {
    const { memberships } = setup();
    const result = await memberships.set(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'second', role: 'owner', active: true });
    expect(result.revision).toBe(2);
    expect(await memberships.list(principal('second'), householdId)).toEqual(result);
    await memberships.remove(principal('second'), householdId, 2, { tenantId: 'test-tenant', objectId: 'owner' });
    await expect(memberships.list(owner, householdId)).rejects.toMatchObject({ status: 403 });
  });

  it.each(['demote', 'disable', 'remove'] as const)('cannot %s the last active owner and leaves all state unchanged', async operation => {
    const { memberships, repository } = setup();
    const before = await repository.transact(householdId, state => state);
    const command = operation === 'remove'
      ? memberships.remove(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'owner' })
      : memberships.set(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'owner', role: operation === 'demote' ? 'editor' : 'owner', active: operation !== 'disable' });
    await expect(command).rejects.toMatchObject({ status: 403, code: 'last_owner_required' });
    expect(await repository.transact(householdId, state => state)).toEqual(before);
  });

  it('does not count inactive owners toward the last-owner invariant', async () => {
    const { memberships } = setup();
    await memberships.set(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'inactive-owner', role: 'owner', active: false });
    await expect(memberships.remove(owner, householdId, 2, { tenantId: 'test-tenant', objectId: 'owner' })).rejects.toMatchObject({ code: 'last_owner_required' });
  });

  it.each(['disable', 'remove'] as const)('serializes simultaneous owner self-%s and rejects removing the survivor on retry', async operation => {
    const { memberships } = setup(true);
    const apply = (actor: VerifiedPrincipal, revision: number) => operation === 'remove'
      ? memberships.remove(actor, householdId, revision, { tenantId: 'test-tenant', objectId: actor.objectId })
      : memberships.set(actor, householdId, revision, { tenantId: 'test-tenant', objectId: actor.objectId, role: 'owner', active: false });
    const second = principal('owner-2');
    const results = await Promise.allSettled([apply(owner, 1), apply(second, 1)]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 412 } });
    const snapshot = await memberships.list(second, householdId);
    expect(snapshot.members.filter(member => member.role === 'owner' && member.active)).toHaveLength(1);
    await expect(apply(second, snapshot.revision)).rejects.toMatchObject({ code: 'last_owner_required' });
    expect(await memberships.list(second, householdId)).toEqual(snapshot);
  });

  it('rechecks owner role when two owners try to demote each other', async () => {
    const { memberships } = setup(true);
    const results = await Promise.allSettled([
      memberships.set(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'owner-2', role: 'editor', active: true }),
      memberships.set(principal('owner-2'), householdId, 1, { tenantId: 'test-tenant', objectId: 'owner', role: 'editor', active: true }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 403 } });
    expect((await memberships.list(owner, householdId)).members.filter(member => member.role === 'owner' && member.active)).toHaveLength(1);
  });

  it('requires revision preconditions and strict owner management bodies', async () => {
    const { memberships } = setup();
    const body = { tenantId: 'test-tenant', objectId: 'new-member', role: 'player', active: true };
    await expect(memberships.set(owner, householdId, undefined, body)).rejects.toMatchObject({ status: 428 });
    await expect(memberships.remove(owner, householdId, null, { tenantId: 'test-tenant', objectId: 'player' })).rejects.toMatchObject({ status: 428 });
    await expect(memberships.set(owner, householdId, 2, body)).rejects.toMatchObject({ status: 412 });
    for (const input of [null, {}, { ...body, role: 'admin' }, { ...body, active: 'true' }, { ...body, revision: 99 }, { ...body, ['__proto__']: {} }, Object.assign(Object.create({ owner: true }), body)]) {
      await expect(memberships.set(owner, householdId, 1, input)).rejects.toMatchObject({ status: 400 });
    }
    await expect(memberships.set(owner, householdId, 1, { ...body, tenantId: 'other-tenant' })).rejects.toMatchObject({ status: 403 });
    await expect(memberships.remove(owner, householdId, 1, { tenantId: 'test-tenant', objectId: 'missing' })).rejects.toMatchObject({ status: 404 });
    expect((await memberships.list(owner, householdId)).revision).toBe(1);
  });

  it('clones membership inputs and results and retains household drafts after author removal', async () => {
    const { routines, memberships } = setup();
    const draft = await routines.create(editor, householdId, content());
    const body = { tenantId: 'test-tenant', objectId: 'new-member', role: 'player', active: true };
    const added = await memberships.set(owner, householdId, 1, body);
    body.role = 'owner';
    added.members.find(member => member.objectId === 'new-member')!.role = 'owner';
    expect((await memberships.list(owner, householdId)).members.find(member => member.objectId === 'new-member')?.role).toBe('player');
    await memberships.remove(owner, householdId, 2, { tenantId: 'test-tenant', objectId: 'editor' });
    expect(await routines.getDraft(owner, householdId, draft.id)).toEqual(draft);
  });
});

describe('test-only repository isolation and rollback', () => {
  it('clones seed, results and retained callback references', async () => {
    const member = { tenantId: 'test-tenant', objectId: 'owner', role: 'owner' as const, active: true };
    const repository = new TestOnlyInMemoryRepository([{ householdId, members: [member] }]);
    member.active = false;
    const key = memberKey('test-tenant', 'owner');
    let retained: { active: boolean } | undefined;
    const fetched = await repository.transact(householdId, state => {
      retained = state.members.get(key)!;
      return state.members.get(key)!;
    });
    expect(fetched.active).toBe(true);
    fetched.active = false;
    retained!.active = false;
    expect(await repository.transact(householdId, state => state.members.get(key)?.active)).toBe(true);
  });

  it('rolls back a thrown transaction and continues processing the queue', async () => {
    const { repository } = setup();
    const before = await repository.transact(householdId, state => state);
    await expect(repository.transact(householdId, state => { state.members.clear(); throw new Error('Test failure'); })).rejects.toThrow('Test failure');
    expect(await repository.transact(householdId, state => state)).toEqual(before);
  });

  it('rejects asynchronous transaction callbacks without committing', async () => {
    const { repository } = setup();
    await expect(repository.transact(householdId, state => { state.members.clear(); return Promise.resolve(); })).rejects.toThrow('Test transactions must be synchronous');
    expect((await repository.transact(householdId, state => state.members)).size).toBe(3);
  });
});