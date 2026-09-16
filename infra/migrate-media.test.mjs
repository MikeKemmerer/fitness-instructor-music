import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { browserDecode, buildReplacement, CHUNK_BYTES, collectBounded, conversionArguments, decodedFrames, downloadAsset, inspectUpload,
  inspectWav, native, privateDirectory, probe, requestedMode, scanReferences, validateRetention, verifyTimeline } from './migrate-media.mjs';

function fixture() {
  const entryId = randomUUID();
  const source = { id: randomUUID(), bytes: 123456, sha256: 'a'.repeat(64), contentType: 'audio/wav' };
  return {
    body: { routine: { schemaVersion: 1, id: randomUUID(), name: 'Synthetic routine', revision: 5,
      locked: false, published: false, filler: { mode: 'none', sound: 'lofi' },
      tracks: [{ id: entryId, title: 'Synthetic.wav', duration: 1.5, gain: 0.4,
        cues: [{ id: randomUUID(), note: '<plain text>', anchor: { kind: 'timestamp', seconds: 0.7 } }] }] },
    media: { [entryId]: source } },
    replacements: [{ source, asset: { id: randomUUID(), bytes: 4567, sha256: 'b'.repeat(64), contentType: 'audio/mp4' } }],
  };
}

test('fresh immutable entry and asset IDs preserve every other routine field', () => {
  const { body, replacements } = fixture();
  const original = structuredClone(body);
  const result = buildReplacement(body, replacements);
  assert.deepEqual(body, original);
  assert.equal(result.body.routine.revision, 6);
  assert.notEqual(result.mapping[0].entryId, body.routine.tracks[0].id);
  const restored = structuredClone(result.body.routine);
  restored.revision = 5;
  restored.tracks[0].id = body.routine.tracks[0].id;
  assert.deepEqual(restored, body.routine);
  assert.deepEqual(result.body.media[result.mapping[0].entryId], replacements[0].asset);
});

test('rejects stale identities, changed source, locked or published draft', () => {
  const { body, replacements } = fixture();
  assert.throws(() => buildReplacement(body, replacements, () => body.routine.tracks[0].id), /fresh_entry/);
  const bad = structuredClone(replacements);
  bad[0].source.sha256 = 'c'.repeat(64);
  assert.throws(() => buildReplacement(body, bad), /source_mismatch/);
  for (const field of ['locked', 'published']) {
    assert.throws(() => buildReplacement({ ...body, routine: { ...body.routine, [field]: true } }, replacements), /unlocked/);
  }
  bad[0].source = replacements[0].source;
  bad[0].asset.id = replacements[0].source.id;
  assert.throws(() => buildReplacement(body, bad), /descriptor_invalid/);
});

test('native conversion preserves volume/channels and requests edit-list trimming', () => {
  const args = conversionArguments('/private/source.wav', '/private/output.m4a');
  for (const flag of ['-nostdin', '-xerror', '-vn', '-sn', '-dn', '-n']) assert.ok(args.includes(flag));
  for (const [flag, value] of [['-map', '0:a:0'], ['-b:a', '256000'], ['-profile:a', 'aac_low'],
    ['-ar', '48000'], ['-map_metadata', '-1'], ['-map_chapters', '-1'], ['-use_editlist', '1']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(!args.includes('-ac') && !args.includes('-af') && !args.includes('-t'));
});

test('CLI rejects every write/apply mode before connecting', () => {
  assert.equal(requestedMode(['--prepare']), 'prepare');
  for (const args of [[], ['--apply'], ['--prepare', '--apply'], ['--delete'], ['--pause']]) {
    assert.throws(() => requestedMode(args), /no_cloud_mutations/);
  }
});

test('bounded stream rejects oversized, truncated and changed ETag responses', async () => {
  const expected = { bytes: 3, etag: '"0x123"' };
  const response = (data, etag = '0x123') => ({ readableStreamBody: Readable.from([Buffer.from(data)]), contentLength: 3, etag });
  assert.equal((await collectBounded(response('abc'), expected, 3)).toString(), 'abc');
  await assert.rejects(collectBounded(response('abcd'), expected, 3), /size_limit/);
  await assert.rejects(collectBounded(response('ab'), expected, 3), /truncated/);
  await assert.rejects(collectBounded(response('abc', '0x124'), expected, 3), /etag_changed/);
});

test('strict WAV timeline rejects wrong format, padding and oversized decoded content', () => {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(96036, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(96000, 40);
  assert.equal(inspectWav(header, 96044).frames, 48000);
  header.writeUInt16LE(3, 20);
  assert.throws(() => inspectWav(header, 96044), /lpcm/);
  assert.equal(verifyTimeline(48000, 48128, 1, 1).nativePaddingFrames, 128);
  assert.throws(() => verifyTimeline(48000, 47999, 1, 1), /native_timeline/);
  assert.throws(() => verifyTimeline(48000, 49025, 1, 1), /native_timeline/);
  assert.throws(() => verifyTimeline(48000, 48128, 1.01, 1), /edit_list/);
  assert.throws(() => verifyTimeline(48000, 48128, 1, 1.11), /browser_cache/);
});

test('staging must be complete or expired, hash-equal and complete before retirement; owner omitted', () => {
  const { replacements } = fixture();
  const catalog = { asset: replacements[0].source, chunks: ['c'.repeat(64)] };
  const value = { asset: catalog.asset, ownerId: 'synthetic-owner', expiresAt: 9999999999999,
    state: 'complete', chunks: { 0: catalog.chunks[0] }, finalization: { sha256: catalog.asset.sha256, copiedChunks: 1 } };
  assert.equal(inspectUpload(value, catalog).state, 'complete');
  assert.equal(inspectUpload(value, catalog).head.ownerId, undefined);
  assert.throws(() => inspectUpload({ ...value, state: 'open' }, catalog), /active_upload/);
  assert.throws(() => inspectUpload({ ...value, chunks: {} }, catalog), /incomplete/);
  assert.throws(() => inspectUpload({ ...value, token: 'forbidden' }, catalog), /invalid_upload/);
});

test('native mono/stereo AAC and isolated browser preserve source timing without network', { timeout: 90000 }, async () => {
  const directory = await privateDirectory(`migration-synthetic-${randomUUID()}`);
  const { chromium } = createRequire(import.meta.url)('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const channels of [1, 2]) {
      const sourcePath = resolve(directory, 'backup/wav', `${randomUUID()}.wav`);
      const outputPath = resolve(directory, 'candidate/m4a', `${randomUUID()}.m4a`);
      await native('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
        'sine=frequency=440:sample_rate=48000:duration=1.501', '-ac', String(channels), '-c:a', 'pcm_s16le', sourcePath]);
      await native('ffmpeg', conversionArguments(sourcePath, outputPath));
      const data = await readFile(outputPath);
      const expected = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      const result = await browserDecode(browser, outputPath, expected);
      const metadata = await probe(outputPath);
      assert.equal(metadata.streams[0].profile, 'LC');
      assert.equal(result.channels, channels);
      assert.equal(result.externalRequests, 0);
      verifyTimeline(72048, await decodedFrames(outputPath, channels), Number(metadata.streams[0].duration), result.duration);
    }
  } finally { await browser.close(); }
});

test('reconstruction verifies chunks and full hash with at most two concurrent reads', async () => {
  const assetId = randomUUID();
  const parts = [Buffer.alloc(CHUNK_BYTES, 1), Buffer.alloc(CHUNK_BYTES, 2), Buffer.alloc(44, 3)];
  const sha256 = data => createHash('sha256').update(data).digest('hex');
  const catalog = { asset: { id: assetId, bytes: CHUNK_BYTES * 2 + 44, sha256: sha256(Buffer.concat(parts)), contentType: 'audio/wav' },
    chunks: parts.map(sha256) };
  const rows = new Map(parts.map((data, index) => [`assets/${assetId}/chunks/${index}`, { bytes: data.length, etag: '"0x123"' }]));
  let active = 0;
  let peak = 0;
  const store = { read: async key => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolveResult => setImmediate(resolveResult));
    active -= 1;
    return parts[Number(key.split('/').at(-1))];
  } };
  const result = await downloadAsset(store, rows, catalog, undefined, 'assets');
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(result.bytes, catalog.asset.bytes);
  assert.deepEqual(result.chunks.map(chunk => chunk.offset), [0, CHUNK_BYTES, CHUNK_BYTES * 2]);
  const wrongChunk = structuredClone(catalog);
  wrongChunk.chunks[0] = '0'.repeat(64);
  await assert.rejects(downloadAsset(store, rows, wrongChunk, undefined, 'assets'), /chunk_hash_mismatch/);
  assert.equal(active, 0);
  const wrongAsset = structuredClone(catalog);
  wrongAsset.asset.sha256 = '0'.repeat(64);
  await assert.rejects(downloadAsset(store, rows, wrongAsset, undefined, 'assets'), /asset_hash_mismatch/);
});

test('retention requires explicit management-plane booleans, never SDK defaults', () => {
  assert.throws(() => validateRetention({ softDelete: false }), /unverified/);
  assert.throws(() => validateRetention({ softDelete: false, containerSoftDelete: false, versioning: null }), /unverified/);
  assert.equal(validateRetention({ softDelete: false, containerSoftDelete: false, versioning: false }).versioning, false);
  assert.equal(validateRetention({ softDelete: false, containerSoftDelete: false, versioning: true }).versioning, true);
});

test('reference scan excludes operational content, warns unknown paths and rejects outside references', async () => {
  const routineId = randomUUID();
  const samples = Array.from({ length: 10 }, fixture);
  const body = samples[0].body;
  body.routine.id = routineId;
  body.routine.tracks = samples.map(sample => sample.body.routine.tracks[0]);
  body.media = Object.assign({}, ...samples.map(sample => sample.body.media));
  const documents = new Map();
  for (let revision = 1; revision <= 5; revision++) {
    const snapshot = structuredClone(body);
    snapshot.routine.revision = revision;
    documents.set(`snapshots/${routineId}/${randomUUID()}`, Buffer.from(JSON.stringify(snapshot)));
  }
  const rows = new Map([...documents].map(([key, bytes]) => [key, { bytes: bytes.length, etag: '"0x123"' }]));
  for (const prefix of ['traffic', 'sessions', 'throttle', 'keys', 'unknown']) {
    rows.set(`${prefix}/synthetic`, { bytes: 999999999, etag: '"0x124"' });
  }
  const reads = [];
  const store = { read: async key => { reads.push(key); assert.ok(documents.has(key)); return documents.get(key); } };
  const inventory = { target: { id: routineId }, assets: samples.map(sample => sample.replacements[0].source) };
  const checks = { parseRoutineContent: () => {} };
  const scan = await scanReferences(store, rows, inventory, checks);
  assert.equal(reads.length, 5);
  assert.equal(scan.summary.references.length, 50);
  assert.equal(scan.summary.excludedContentCounts.traffic, 1);
  assert.deepEqual({ ...scan.summary.unknownPrefixes }, { unknown: 1 });
  assert.equal(scan.summary.completeAllPrefixes, false);
  const outside = structuredClone(body);
  outside.routine.id = randomUUID();
  const outsideKey = `snapshots/${outside.routine.id}/${randomUUID()}`;
  const outsideBytes = Buffer.from(JSON.stringify(outside));
  documents.set(outsideKey, outsideBytes);
  rows.set(outsideKey, { bytes: outsideBytes.length, etag: '"0x125"' });
  await assert.rejects(scanReferences(store, rows, inventory, checks), /outside_or_changed_asset_reference/);
});