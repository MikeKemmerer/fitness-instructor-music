import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { newRoutine, type Cue, type Routine, type Track } from '../shared/routine';
import { assertPdfCharacters, buildPdfPacket, buildPdfTables, buildWorkbookSheets, columnValue,
  createExportSnapshot, createPdfBlob, defaultExportColumns, exportColumns, exportFilename, exportTime,
  selectedExportColumns, worksheetFilterRange } from '../frontend/src/exports';
import { t } from '../frontend/src/i18n';

function fixture(): Routine {
  const track: Track = { id: 'first-entry', title: 'Opening song', duration: 90.25, bpm: 120,
    firstBeat: 2, bodyArea: 'Legs', cues: [] };
  return { ...newRoutine(), id: 'routine-id', name: 'Morning class', revision: 7,
    tracks: [track, { ...structuredClone(track), id: 'second-entry', title: 'Closing song' }] };
}

const allIds = () => exportColumns.map(column => column.id);
const exportedAt = new Date('2026-09-13T12:34:56.000Z');

function pdfText(bytes: Buffer): string {
  const streams = [...bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(match => {
    const raw = Buffer.from(match[1]!, 'latin1');
    try { return inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); }
  });
  const mapping = new Map<string, string>();
  for (const stream of streams.filter(stream => stream.includes('beginbfchar'))) {
    for (const match of stream.matchAll(/<([a-f0-9]{4})>\s*<([a-f0-9]{4})>/gi)) mapping.set(match[1]!.toLowerCase(), String.fromCharCode(Number.parseInt(match[2]!, 16)));
  }
  return streams.filter(stream => stream.includes('BT')).map(stream => [...stream.matchAll(/<([a-f0-9]+)>\s*Tj/gi)]
    .map(match => match[1]!.match(/.{4}/g)!.map(code => mapping.get(code.toLowerCase()) ?? '').join('')).join('\n')).join('\n');
}

describe('export registry and snapshots', () => {
  it('retains only selected routine settings for a draft without tracks', () => {
    const routine = fixture();
    routine.tracks = [];
    const sheets = buildWorkbookSheets(createExportSnapshot(routine, true), ['routine.id', 'filler.seconds']);
    expect(sheets[0].data).toHaveLength(1);
    expect(sheets[1].data).toContainEqual([
      expect.objectContaining({ value: t('exportRoutineId') }), expect.objectContaining({ value: routine.id }),
    ]);
    expect(sheets[1].data).toContainEqual([
      expect.objectContaining({ value: t('exportFillerSeconds') }), expect.objectContaining({ value: routine.filler.seconds }),
    ]);
    expect(JSON.stringify(sheets)).not.toContain(routine.name);
  });

  it('creates an embedded-font multipage PDF from fourteen tracks with long notes', async () => {
    const routine = fixture();
    routine.tracks = Array.from({ length: 14 }, (_, index) => ({
      ...routine.tracks[0], id: `song-${index}`, title: `Track ${index + 1} - Pli\u00e9`,
      cues: Array.from({ length: 5 }, (_, cueIndex) => ({
        id: `cue-${cueIndex}`, note: `Move ${cueIndex + 1}: ${'Long form reminder. '.repeat(20)}`,
        anchor: { kind: 'timestamp' as const, seconds: cueIndex * 10 }, beep: true,
      })),
    }));
    const font = readFileSync(new URL('../frontend/src/assets/fonts/NotoSans-Regular.ttf', import.meta.url));
    const blob = await createPdfBlob(createExportSnapshot(routine, false), font);
    const pdf = Buffer.from(await blob.arrayBuffer()).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('/FontFile2');
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(10);
  }, 30000);
  it('covers every current scalar schema field and stable derived order without invented song metadata', () => {
    expect(allIds()).toEqual([
      'routine.id', 'routine.name', 'routine.revision', 'routine.schemaVersion', 'routine.locked', 'routine.published',
      'track.index', 'track.id', 'track.title', 'track.duration', 'track.durationTime', 'track.bpm', 'track.firstBeat', 'track.bodyArea', 'track.gain',
      'track.after.mode', 'track.after.crossfade', 'track.after.filler',
      'cue.id', 'cue.order', 'cue.anchor.kind', 'cue.anchor.value', 'cue.seconds', 'cue.time', 'cue.note', 'cue.beep',
      'filler.mode', 'filler.seconds', 'filler.bpm', 'filler.sound', 'filler.gain',
      'filler.recording.id', 'filler.recording.name', 'filler.recording.duration', 'filler.recording.asset.id',
      'filler.recording.asset.sha256', 'filler.recording.asset.bytes', 'filler.recording.asset.contentType',
      'routine.crossfade', 'routine.beepEvery',
      'routine.beepRemaining', 'routine.beepOnceRemaining', 'row.status',
    ]);
    expect(new Set(allIds()).size).toBe(exportColumns.length);
    for (const column of exportColumns) {
      expect(t(column.label).length).toBeGreaterThan(0);
      expect(column.width).toBeGreaterThan(0);
      expect(['string', 'number', 'boolean']).toContain(column.type);
    }
    expect(defaultExportColumns()).toContain('row.status');
    expect(Object.isFrozen(exportColumns)).toBe(true);
  });

  it.each([true, false])('preserves selected custom recording fields without leaking deselections, tracks=%s', tracks => {
    const routine = fixture();
    if (!tracks) routine.tracks = [];
    const recording = { id: 'retained-recording', name: '=Private filler', duration: 8,
      asset: { id: 'private-asset', bytes: 128, sha256: 'a'.repeat(64), contentType: 'audio/wav' } };
    routine.filler = { ...routine.filler, sound: 'recording', recording };
    const snapshot = createExportSnapshot(routine, true, exportedAt);
    recording.name = 'Changed later';
    expect(snapshot.routine.filler.recording!.name).toBe('=Private filler');
    const ids = ['filler.sound', ...allIds().filter(id => id.startsWith('filler.recording.'))];
    const sheets = buildWorkbookSheets(snapshot, ids);
    const packet = buildPdfPacket(snapshot, ids);
    for (const value of ['=Private filler', 'retained-recording', 'private-asset', 'audio/wav', 'a'.repeat(64)]) {
      expect(JSON.stringify(sheets)).toContain(value);
      expect(JSON.stringify(packet)).toContain(value);
      expect(JSON.stringify(buildWorkbookSheets(snapshot, ['cue.note']))).not.toContain(value);
      expect(JSON.stringify(buildPdfPacket(snapshot, ['cue.note']))).not.toContain(value);
    }
    if (tracks) expect(sheets[0]!.data[1]![0]).toMatchObject({ type: String, value: '=Private filler' });
    expect(packet.settings).toContainEqual([t('exportFillerDuration'), '8']);
    expect(packet.settings).toContainEqual([t('exportFillerBytes'), '128']);
  });

  it('exports per-gap rules only when selected and ignores a dormant final hold in duration status', () => {
    const routine = fixture(); routine.filler.mode = 'none';
    routine.tracks[0]!.after = { mode: 'none' };
    routine.tracks[1]!.after = { mode: 'custom', crossfade: 1.25, filler: { ...routine.filler, mode: 'hold', sound: 'recording',
      recording: { id: 'gap-private', name: 'Private gap', duration: 8, asset: { id: 'gap-asset', sha256: 'f'.repeat(64), bytes: 128, contentType: 'audio/wav' } } } };
    const snapshot = createExportSnapshot(routine, false);
    for (const output of [buildWorkbookSheets(snapshot, allIds()), buildPdfPacket(snapshot, allIds())]) {
      expect(JSON.stringify(output)).toContain('gap-private');
      expect(JSON.stringify(output)).not.toContain(t('exportOpenEnded'));
    }
    for (const output of [buildWorkbookSheets(snapshot, ['cue.note']), buildPdfPacket(snapshot, ['cue.note'])]) {
      expect(JSON.stringify(output)).not.toContain('gap-private');
      expect(JSON.stringify(output)).not.toContain('Private gap');
      expect(JSON.stringify(output)).not.toContain('1.25');
    }
  });

  it('makes one row per cue-less track, with genuinely blank cue cells and selectable stable IDs', () => {
    const routine = fixture();
    const snapshot = createExportSnapshot(routine, true, exportedAt);
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows.map(row => row.trackIndex)).toEqual([1, 2]);
    for (const row of snapshot.rows) {
      for (const column of exportColumns.filter(item => item.id.startsWith('cue.'))) expect(columnValue(column, row)).toBeNull();
    }
    const sheet = buildWorkbookSheets(snapshot, ['track.id', 'cue.id', 'cue.time', 'cue.beep'])[0]!;
    expect(sheet.data[1]).toEqual([
      expect.objectContaining({ type: String, value: 'first-entry' }),
      expect.objectContaining({ type: String, value: undefined }),
      expect.objectContaining({ type: String, value: undefined }),
      expect.objectContaining({ type: Boolean, value: undefined }),
    ]);
  });

  it('sorts mixed anchors by effective time with stable ties, preserving track and source-array order', () => {
    const routine = fixture();
    routine.tracks[0]!.cues = [
      { id: 'late', anchor: { kind: 'timestamp', seconds: 12 }, note: 'Later' },
      { id: 'count', anchor: { kind: 'count', count: 5 }, note: 'Count', beep: true },
      { id: 'interval', anchor: { kind: 'interval', seconds: 4 }, note: 'Interval' },
      { id: 'zero', anchor: { kind: 'timestamp', seconds: 0 }, note: 'Start' },
    ];
    routine.tracks[1]!.title = routine.tracks[0]!.title;
    const before = structuredClone(routine);
    const snapshot = createExportSnapshot(routine, false, exportedAt);
    expect(snapshot.rows.map(row => row.cue?.id ?? null)).toEqual(['zero', 'count', 'interval', 'late', null]);
    expect(snapshot.rows.map(row => row.effectiveSeconds)).toEqual([0, 4, 4, 12, null]);
    expect(snapshot.rows.map(row => row.cueOrder)).toEqual([1, 2, 3, 4, null]);
    expect(snapshot.rows.map(row => row.trackIndex)).toEqual([1, 1, 1, 1, 2]);
    expect(routine).toEqual(before);
  });

  it('retains and flags invalid timing, invalid text and duplicate entries instead of dropping rows', () => {
    const routine = fixture();
    routine.tracks[0]!.cues = [
      { id: 'nan', anchor: { kind: 'timestamp', seconds: Number.NaN }, note: 'Incomplete time' },
      { id: 'end', anchor: { kind: 'interval', seconds: 90.25 }, note: 'At end' },
      { id: 'negative', anchor: { kind: 'timestamp', seconds: -1 }, note: 'Negative' },
      { id: 'count', anchor: { kind: 'count', count: 0 }, note: 'Bad count' },
      { id: 'valid', anchor: { kind: 'timestamp', seconds: 10 }, note: 'Keep me' },
      { id: 'valid', anchor: { kind: 'timestamp', seconds: 11 }, note: '' },
      { id: 'kind', anchor: { kind: 'unexpected', seconds: 1 } as unknown as Cue['anchor'], note: 'Unknown anchor' },
    ];
    routine.tracks[1]!.id = routine.tracks[0]!.id;
    const snapshot = createExportSnapshot(routine, true);
    expect(snapshot.rows).toHaveLength(8);
    expect(snapshot.rows.map(row => row.cue?.id ?? null)).toEqual(['valid', 'valid', 'nan', 'end', 'negative', 'count', 'kind', null]);
    expect(snapshot.rows.slice(1).every(row => row.issues.length > 0)).toBe(true);
    expect(snapshot.rows[2]!.effectiveSeconds).toBeNull();
    const sheet = buildWorkbookSheets(snapshot, ['cue.note'])[0]!;
    expect(sheet.data[3]![0]).toEqual(expect.objectContaining({ value: 'Incomplete time', backgroundColor: '#FCE9E7' }));
  });

  it('deeply detaches and freezes the click-time draft, including NaN and optional legacy fields', () => {
    const routine = fixture();
    delete routine.beepOnceRemaining;
    routine.tracks[0]!.cues = [{ id: 'cue', anchor: { kind: 'timestamp', seconds: Number.NaN }, note: 'Before' }];
    const snapshot = createExportSnapshot(routine, true, exportedAt);
    routine.name = 'After';
    routine.filler.sound = 'lofi';
    routine.tracks[0]!.cues[0]!.note = 'After';
    expect(snapshot.routine.name).toBe('Morning class');
    expect(snapshot.rows[0]!.cue!.note).toBe('Before');
    expect(snapshot.unsaved).toBe(true);
    expect(snapshot.exportedAt).toBe(exportedAt.toISOString());
    expect(Object.isFrozen(snapshot.rows[0]!.cue!.anchor)).toBe(true);
    expect(() => { snapshot.routine.name = 'Mutation'; }).toThrow();
    expect(Number.isNaN((snapshot.rows[0]!.cue!.anchor as { seconds: number }).seconds)).toBe(true);
    const optional = exportColumns.find(column => column.id === 'routine.beepOnceRemaining')!;
    expect(columnValue(optional, snapshot.rows[0]!)).toBeNull();
    expect('beepOnceRemaining' in snapshot.routine).toBe(false);
  });
});

describe('Excel cell data and selection', () => {
  it.each(['=1+1', '+SUM(A1:A2)', '-2+3', '@SUM(A1)', '\t=1+1', 'https://example.test', '<script>text</script>', '\u039a\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1 / \u041f\u0440\u0438\u0432\u0435\u0442'])('keeps user text as an explicit String cell: %s', text => {
    const routine = fixture();
    routine.name = text;
    routine.tracks[0]!.title = text;
    routine.tracks[0]!.bodyArea = text;
    routine.tracks[0]!.cues = [{ id: text, anchor: { kind: 'timestamp', seconds: 1 }, note: text }];
    const sheet = buildWorkbookSheets(createExportSnapshot(routine, true),
      ['routine.name', 'track.title', 'track.bodyArea', 'cue.id', 'cue.note'])[0]!;
    for (const cell of sheet.data[1]!) {
      expect(cell).toEqual(expect.objectContaining({ type: String, value: text }));
      expect(cell).not.toHaveProperty('hyperlink');
      expect(cell).not.toHaveProperty('formula');
    }
  });

  it('preserves numeric and boolean types, differentiating no cue from a cue with beep disabled', () => {
    const routine = fixture();
    routine.locked = true;
    routine.tracks[0]!.cues = [{ id: 'cue', anchor: { kind: 'timestamp', seconds: 0 }, note: 'Start' }];
    const sheet = buildWorkbookSheets(createExportSnapshot(routine, false), ['routine.locked', 'track.duration', 'cue.seconds', 'cue.beep'])[0]!;
    expect(sheet.data[1]).toEqual([
      expect.objectContaining({ type: Boolean, value: true }), expect.objectContaining({ type: Number, value: 90.25 }),
      expect.objectContaining({ type: Number, value: 0 }), expect.objectContaining({ type: Boolean, value: false }),
    ]);
    expect(sheet.data[2]![3]).toEqual(expect.objectContaining({ type: Boolean, value: undefined }));
    expect(sheet.stickyRowsCount).toBe(1);
    expect(sheet.columns).toHaveLength(4);
    expect(sheet.data[0]!.every(cell => typeof cell === 'object' && cell !== null && 'wrap' in cell && cell.wrap === true)).toBe(true);
  });

  it('validates selected IDs, orders them by registry and refuses an empty effective selection', () => {
    expect(selectedExportColumns(['cue.note', 'track.title', 'cue.note', '__proto__']).map(column => column.id)).toEqual(['track.title', 'cue.note']);
    const snapshot = createExportSnapshot(fixture(), false);
    expect(() => buildWorkbookSheets(snapshot, [])).toThrow(t('exportNoColumns'));
    expect(() => buildWorkbookSheets(snapshot, ['artist'])).toThrow(t('exportNoColumns'));
    const sheet = buildWorkbookSheets(snapshot, ['track.id'])[0]!;
    expect(sheet.data.every(row => row.length === 1)).toBe(true);
  });

  it('does not leak excluded fields into Overview, and labels source duration and open-ended holds honestly', () => {
    const routine = fixture();
    routine.name = 'DO-NOT-LEAK-NAME';
    routine.id = 'DO-NOT-LEAK-ID';
    routine.filler.mode = 'hold';
    const snapshot = createExportSnapshot(routine, true, exportedAt);
    const minimal = buildWorkbookSheets(snapshot, ['cue.note'])[1]!;
    expect(minimal.data).toHaveLength(4);
    expect(JSON.stringify(minimal)).not.toContain(routine.name);
    expect(JSON.stringify(minimal)).not.toContain(routine.id);
    expect(JSON.stringify(minimal)).not.toContain(t('exportSourceDuration'));
    expect(JSON.stringify(minimal)).not.toContain(t('exportOpenEnded'));
    const selected = buildWorkbookSheets(snapshot, ['track.duration', 'filler.mode'])[1]!;
    expect(selected.data[4]![1]).toEqual({ type: Number, value: 180.5 });
    expect(selected.data[5]![1]).toEqual(expect.objectContaining({ value: t('exportOpenEnded') }));
  });

  it('exports sensible recorded and synthetic sound labels and keeps the numeric synthetic BPM setting', () => {
    const routine = fixture();
    routine.filler.sound = 'lofi';
    const sheet = buildWorkbookSheets(createExportSnapshot(routine, false), ['filler.bpm', 'filler.sound'])[0]!;
    expect(sheet.data[1]).toEqual([
      expect.objectContaining({ type: Number, value: 100 }), expect.objectContaining({ type: String, value: t('lofi') }),
    ]);
  });

  it('formats human times without fabricating a zero and bounds worksheet filter references', () => {
    expect(exportTime(null)).toBeNull();
    expect(exportTime(Infinity)).toBeNull();
    expect(exportTime(0)).toBe('0:00');
    expect(exportTime(90.25)).toBe('1:30.25');
    expect(exportTime(59.9999)).toBe('1:00');
    expect(worksheetFilterRange(1, 2)).toBe('A1:A2');
    expect(worksheetFilterRange(31, 110)).toBe('A1:AE110');
    expect(() => worksheetFilterRange(0, 1)).toThrow();
  });

  it.each(['../../CON\\folder:name', '\u202eunsafe\u2215slash\uff0fpath', '\ud83c\udfb5', '  ', 'A'.repeat(200)])('makes a bounded, path-safe filename: %s', name => {
    const filename = exportFilename(name, 'xlsx');
    expect(filename).toMatch(/^[A-Za-z0-9-]+\.xlsx$/);
    expect(filename.length).toBeLessThanOrEqual(85);
  });
  it('keeps exactly one chosen extension and avoids reserved filenames', () => {
    expect(exportFilename('My class.xlsx.xlsx', 'xlsx')).toBe('My-class.xlsx');
    expect(exportFilename('My class.xlsx.pdf', 'pdf')).toBe('My-class.pdf');
    expect(exportFilename('CON.pdf', 'pdf')).toBe('routine-CON.pdf');
  });
});

describe('PDF packet layout data', () => {
  it('keeps every selected field in fixed-width repeating cue sections instead of a wide horizontal table', async () => {
    const routine = fixture();
    routine.tracks = Array.from({ length: 4 }, (_, index) => ({ ...routine.tracks[0]!, id: `entry-${index}`,
      cues: [{ id: `cue-${index}`, note: `Complete note ${index}: ${'Long instruction. '.repeat(20)}`,
        anchor: { kind: 'timestamp' as const, seconds: 65.5 }, beep: true }] }));
    const packet = buildPdfPacket(createExportSnapshot(routine, false), allIds());
    const tables = buildPdfTables(packet).slice(2);
    expect(tables).toHaveLength(8);
    for (const table of tables) {
      expect(table.horizontalPageBreak).toBe(false);
      expect(table.showHead).toBe('everyPage');
      const widths = Object.values(table.columnStyles!).map(style => Number(style.cellWidth));
      expect(widths.length).toBeLessThanOrEqual(6);
      expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(540);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(60);
      expect(table.columnStyles).toEqual(tables[tables.indexOf(table) % 2]!.columnStyles);
    }
    const font = readFileSync(new URL('../frontend/src/assets/fonts/NotoSans-Regular.ttf', import.meta.url));
    const text = pdfText(Buffer.from(await (await createPdfBlob(createExportSnapshot(routine, false), font, allIds())).arrayBuffer())).replace(/\s+/g, ' ');
    for (const column of exportColumns.filter(column => !['track.index', 'track.title'].includes(column.id))) expect(text).toContain(t(column.label));
    for (let index = 0; index < 4; index++) {
      expect(text).toContain(`${index + 1}. Opening song`);
      expect(text).toContain(`Complete note ${index}:`);
      expect(text).toContain(`entry-${index}`); expect(text).toContain(`cue-${index}`);
    }
  });

  it('retains all songs and full multiline notes, repeatable headers, fixed Letter-width tables and no-cue sections', () => {
    const routine = fixture();
    const longTitle = 'Long title '.repeat(27);
    const longNote = 'Full instruction with line breaks.\n'.repeat(200);
    routine.tracks[0]!.title = longTitle;
    routine.tracks[0]!.cues = [
      { id: 'last', anchor: { kind: 'timestamp', seconds: 80 }, note: 'Last move' },
      { id: 'first', anchor: { kind: 'count', count: 5 }, note: longNote, beep: true },
    ];
    const packet = buildPdfPacket(createExportSnapshot(routine, true, exportedAt));
    expect(packet.tracks).toHaveLength(2);
    expect(packet.tracks[0]!.heading).toContain(longTitle);
    expect(packet.tracks[0]!.cues[0]![3]).toContain(longNote);
    expect(packet.tracks[0]!.cues[0]!.slice(0, 3)).toEqual(['count', '5', '0:04']);
    expect(packet.tracks[0]!.cues[0]![4]).toBe(t('exportYes'));
    expect(packet.tracks[0]!.cues[1]![3]).toBe('Last move');
    expect(packet.tracks[1]!.cues).toHaveLength(0);
    expect(packet.metadata).toContain(t('exportUnsaved'));
    expect(packet.metadata).toContain(exportedAt.toISOString());
    const tables = buildPdfTables(packet);
    expect(tables).toHaveLength(4);
    for (const table of tables) {
      expect(table.tableWidth).toBe(540);
      expect(table.styles?.overflow).toBe('linebreak');
      expect(table.rowPageBreak).toBe('avoid');
      expect(table.showHead).toBe('everyPage');
    }
    expect(tables[2]!.head).toHaveLength(2);
    expect(tables[2]!.body).toHaveLength(2);
    expect(tables[3]!.body).toEqual([[{ content: t('emptyCues'), colSpan: 6 }]]);
  });

  it('includes locks, publication and all sound settings without presenting recorded BPM as adjustable', () => {
    const routine = fixture();
    routine.locked = routine.published = true;
    routine.filler.mode = 'hold';
    routine.filler.sound = 'lofi';
    routine.beepOnceRemaining = 35;
    const packet = buildPdfPacket(createExportSnapshot(routine, false));
    expect(packet.settings).toContainEqual([t('exportLocked'), t('exportYes')]);
    expect(packet.settings).toContainEqual([t('exportPublishedColumn'), t('exportYes')]);
    expect(packet.metadata).toContain(t('exportSaved'));
    expect(packet.settings).toContainEqual([t('fillerSound'), t('lofi')]);
    expect(packet.settings).toContainEqual([t('exportFillerBpm'), '100']);
    expect(t('exportFillerBpm')).toContain('synthetic only');
    expect(packet.settings).toContainEqual([t('beepOnceRemaining'), '35']);
    expect(packet.settings).toContainEqual([t('exportHoldDuration'), t('exportOpenEnded')]);
  });

  it('keeps invalid cue notes visible with a review flag', () => {
    const routine = fixture();
    routine.tracks[0]!.cues = [{ id: 'bad', anchor: { kind: 'timestamp', seconds: Number.NaN }, note: 'Unfinished cue' }];
    const packet = buildPdfPacket(createExportSnapshot(routine, true));
    expect(packet.tracks[0]!.cues).toHaveLength(1);
    expect(packet.tracks[0]!.cues[0]![2]).toBe(t('exportNeedsReview'));
    expect(packet.tracks[0]!.cues[0]![3]).toContain('Unfinished cue');
    expect(packet.tracks[0]!.cues[0]![5]).toContain(t('outsideTrack'));
  });

  it('excludes deselected notes, body areas, names, IDs and settings from headings, tables and actual PDF text', async () => {
    const routine = fixture();
    routine.name = 'EXCLUDED-ROUTINE'; routine.id = 'EXCLUDED-ID';
    routine.tracks[0]!.title = 'Selected Song'; routine.tracks[0]!.bodyArea = 'EXCLUDED-AREA';
    routine.tracks[0]!.cues = [{ id: 'cue', anchor: { kind: 'timestamp', seconds: 12.375 }, note: 'EXCLUDED-NOTE' }];
    const snapshot = createExportSnapshot(routine, true);
    const fields = ['track.title', 'cue.time'];
    const packet = buildPdfPacket(snapshot, fields);
    expect(packet.settings).toEqual([]);
    expect(packet.tracks[0]!.details).toBe('');
    expect(packet.tracks[0]!.cues).toEqual([['0:12.375']]);
    expect(JSON.stringify(buildPdfTables(packet))).not.toContain('EXCLUDED');
    const font = readFileSync(new URL('../frontend/src/assets/fonts/NotoSans-Regular.ttf', import.meta.url));
    const blob = await createPdfBlob(snapshot, font, fields);
    const text = pdfText(Buffer.from(await blob.arrayBuffer()));
    expect(text).toContain('Selected Song'); expect(text).toContain('0:12.375');
    expect(text).not.toContain('EXCLUDED');
    expect(text).not.toContain(t('fillerSound'));
    expect(() => buildPdfPacket(snapshot, [])).toThrow(t('exportNoColumns'));
  });

  it('preserves selected gain values and does not validate excluded unsupported user characters', async () => {
    const routine = fixture(); routine.filler.gain = 0.75; routine.tracks[0]!.gain = 1.25;
    routine.name = '\u4e2d\u6587'; routine.tracks[0]!.bodyArea = '\u4e2d\u6587';
    const snapshot = createExportSnapshot(routine, false);
    const columns = ['track.gain', 'filler.gain'];
    const workbook = buildWorkbookSheets(snapshot, columns);
    expect(workbook[0]!.data[1]).toEqual([expect.objectContaining({ type: Number, value: 1.25 }), expect.objectContaining({ type: Number, value: 0.75 })]);
    const packet = buildPdfPacket(snapshot, columns);
    expect(packet.settings).toEqual([[t('fillerGain'), '0.75']]);
    expect(packet.tracks[0]!.details).toContain('1.25');
    const font = readFileSync(new URL('../frontend/src/assets/fonts/NotoSans-Regular.ttf', import.meta.url));
    await expect(createPdfBlob(snapshot, font, columns)).resolves.toBeInstanceOf(Blob);
  });

  it('permits covered Latin/Greek/Cyrillic and rejects missing glyphs or unsupported scripts before rendering', () => {
    expect(() => assertPdfCharacters(['Caf\u00e9', '\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac', '\u041f\u0440\u0438\u0432\u0435\u0442'], () => true)).not.toThrow();
    expect(() => assertPdfCharacters(['Caf\u00e9'], code => code !== 0xe9)).toThrow(t('exportUnsupportedText'));
    for (const text of ['\u4e2d\u6587', '\ud83c\udfb5', '\u0645\u0631\u062d\u0628\u0627', '\u202eevil']) {
      expect(() => assertPdfCharacters([text], () => true)).toThrow(t('exportUnsupportedText'));
    }
  });
});