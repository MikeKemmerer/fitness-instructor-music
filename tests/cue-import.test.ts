import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { newRoutine, validateRoutine, type Routine, type Track } from '../shared/routine';
import {
  addCheckboxComplement, createCueTemplateBlob, CUE_TEMPLATE_VERSION, cueTemplateSheetName, FEATURE_BAG_PATH, FEATURE_BAG_XML,
  parseCueSheets, planSongImport, readCueWorkbook, type CueImportSong,
} from '../frontend/src/cue-import';
import { t } from '../frontend/src/i18n';
import { readXlsx, type XlsxCell, type XlsxSheet } from '../frontend/src/xlsx-read';

const { strFromU8, strToU8, unzipSync, zipSync } = createRequire(new URL('../frontend/package.json', import.meta.url))('fflate') as {
  strFromU8(bytes: Uint8Array): string;
  strToU8(text: string): Uint8Array;
  unzipSync(bytes: Uint8Array): Record<string, Uint8Array>;
  zipSync(files: Record<string, Uint8Array>, options?: { level?: number }): Uint8Array;
};

const sample = new Uint8Array(readFileSync(new URL('./fixtures/excel-checkbox-sample.xlsx', import.meta.url)));

function track(id: string, title: string, duration = 120): Track {
  return { id, title, duration, bpm: 120, firstBeat: 0, bodyArea: 'Legs', cues: [] };
}

function routine(): Routine {
  const value = newRoutine();
  value.name = 'Barre test';
  value.tracks = [track('entry-a', 'Warm: up / "intro"?'), track('entry-b', 'Thighs', 90)];
  value.tracks[0]!.cues = [
    { id: 'late', anchor: { kind: 'timestamp', seconds: 65.5 }, note: 'Plié pulses', beep: true },
    { id: 'early', anchor: { kind: 'timestamp', seconds: 2.25 }, note: 'Set up <first>', flash: true },
    { id: 'count', anchor: { kind: 'count', count: 5 }, note: 'Counted' },
  ];
  return value;
}

async function templateFiles(value = routine()) {
  const blob = await createCueTemplateBlob(value, new Date('2026-09-27T12:00:00Z'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, files: unzipSync(bytes) };
}

const cell = (value: string | number | boolean, format = 'General'): XlsxCell =>
  typeof value === 'string' ? { kind: 'string', value } : typeof value === 'boolean' ? { kind: 'boolean', value }
    : { kind: 'number', value, format };

function sheet(name: string, id: string, rows: (XlsxCell | undefined)[][]): XlsxSheet {
  const map = new Map<number, Map<number, XlsxCell>>([[1, new Map([[5, cell(id)]])]]);
  rows.forEach((values, index) => {
    const cells = new Map<number, XlsxCell>();
    values.forEach((value, column) => { if (value) cells.set(column, value); });
    map.set(index + 3, cells);
  });
  return { name, rows: map, maxRow: rows.length + 2 };
}

const marker = sheet('How to import', CUE_TEMPLATE_VERSION, []);

describe('cue import template', () => {
  it('names one sanitized, unique, ordered tab per routine song within Excel limits', () => {
    expect(cueTemplateSheetName(0, 'Warm: up / "intro"?')).toBe('01 Warm up "intro"');
    expect(cueTemplateSheetName(99, 'x'.repeat(60))).toHaveLength(31);
    expect(cueTemplateSheetName(2, "Rock'n' ")).toBe("03 Rock'n");
  });

  it('writes pre-filled timestamp cues, song IDs and Excel 365 checkbox parts matching a real Excel file', async () => {
    const { files } = await templateFiles();
    const reference = unzipSync(sample);
    expect(strFromU8(files[FEATURE_BAG_PATH]!)).toBe(strFromU8(reference[FEATURE_BAG_PATH]!));
    expect(FEATURE_BAG_XML).toBe(strFromU8(reference[FEATURE_BAG_PATH]!));
    const contentTypes = strFromU8(files['[Content_Types].xml']!);
    expect(contentTypes).toContain('<Override PartName="/xl/featurePropertyBag/featurePropertyBag.xml" ContentType="application/vnd.ms-excel.featurepropertybag+xml"/>');
    expect(strFromU8(files['xl/_rels/workbook.xml.rels']!)).toContain(
      'Type="http://schemas.microsoft.com/office/2022/11/relationships/FeaturePropertyBag" Target="featurePropertyBag/featurePropertyBag.xml"');
    const extension = /<extLst><ext uri="\{C7286773-470A-42A8-94C5-96B5CB345126\}"[\s\S]*?<\/extLst>/;
    expect(strFromU8(files['xl/styles.xml']!).match(extension)?.[0]).toBe(strFromU8(reference['xl/styles.xml']!).match(extension)?.[0]);
    const styles = strFromU8(files['xl/styles.xml']!);
    const xfs = [...styles.slice(styles.indexOf('<cellXfs'), styles.indexOf('</cellXfs>')).matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(match => match[0]);
    const song = strFromU8(files['xl/worksheets/sheet2.xml']!);
    const booleans = [...song.matchAll(/<c r="([BC]\d+)" s="(\d+)" t="b">/g)];
    expect(booleans.length).toBeGreaterThan(100);
    for (const [, , style] of booleans) expect(xfs[Number(style)]).toContain('xfComplement');
    const strings = [...song.matchAll(/<c r="[AD]\d+" s="(\d+)"/g)].map(match => Number(match[1]));
    for (const style of strings) expect(xfs[style]).not.toContain('xfComplement');
    const blankTimes = [...song.matchAll(/<c r="A(\d+)" s="(\d+)"\/>/g)];
    expect(blankTimes.length).toBeGreaterThan(90);
    for (const [, , style] of blankTimes) {
      const format = /numFmtId="(\d+)"/.exec(xfs[Number(style)]!)?.[1];
      expect(format === '49' || styles.includes(`<numFmt numFmtId="${format}" formatCode="@"/>`)).toBe(true);
    }
    const workbook = strFromU8(files['xl/workbook.xml']!);
    expect(workbook).toContain('name="How to import"');
    expect(workbook).toContain('name="01 Warm up &quot;intro&quot;"');
    expect(workbook).toContain('name="02 Thighs"');
  });

  it('round-trips the template back to the same timestamp cues without count cues', async () => {
    const value = routine();
    const { bytes } = await templateFiles(value);
    const sheets = readXlsx(bytes);
    expect(sheets.map(item => item.name)).toEqual(['How to import', '01 Warm up "intro"', '02 Thighs']);
    const result = readCueWorkbook(bytes, value);
    expect(result.issues).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.songs.map(song => [song.trackId, song.cues])).toEqual([
      ['entry-a', [
        { seconds: 2.25, note: 'Set up <first>', beep: false, flash: true },
        { seconds: 65.5, note: 'Plié pulses', beep: true, flash: false },
      ]],
      ['entry-b', []],
    ]);
  });

  it('reads real Excel checkbox booleans and shared strings', () => {
    const [first] = readXlsx(sample);
    expect(first!.rows.get(1)?.get(0)).toEqual({ kind: 'boolean', value: true });
    expect(first!.rows.get(2)?.get(0)).toEqual({ kind: 'boolean', value: false });
    expect(first!.rows.get(2)?.get(1)).toEqual({ kind: 'string', value: 'Unchecked' });
  });

  it('rejects non-xlsx input, oversized files and workbooks that are not cue templates', () => {
    expect(() => readXlsx(strToU8('name,time\n'))).toThrow('cue_import_not_xlsx');
    expect(() => readXlsx(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow('cue_import_too_large');
    expect(() => readXlsx(zipSync({ 'other.xml': strToU8('<a/>') }))).toThrow('cue_import_not_xlsx');
    expect(() => readCueWorkbook(sample, routine())).toThrow('cue_import_not_template');
  });

  it('refuses zip entries that inflate beyond the part limit', () => {
    const huge = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': new Uint8Array(9 * 1024 * 1024) }, { level: 9 });
    expect(huge.length).toBeLessThan(5 * 1024 * 1024);
    expect(() => readXlsx(huge)).toThrow('cue_import_too_large');
  });

  it('parses inline strings, rich text, entities and Excel time conversions', () => {
    const workbook = '<workbook><sheets><sheet name="How &amp; why" sheetId="1" r:id="rId1"/><sheet name="01 Song" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/a.xml"/><Relationship Id="rId2" Target="/xl/worksheets/b.xml"/></Relationships>';
    const styles = '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="[$-409]mm:ss.00"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="20"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const shared = '<sst><si><r><t>Plié </t></r><r><t xml:space="preserve">&amp; hold</t></r><rPh><t>ignored</t></rPh></si></sst>';
    const marker = `<worksheet><sheetData><row r="1"><c r="F1" t="inlineStr"><is><t>${CUE_TEMPLATE_VERSION}</t></is></c></row></sheetData></worksheet>`;
    const song = '<worksheet><sheetData><row r="1"><c r="F1" t="inlineStr"><is><t>entry-b</t></is></c></row>'
      + '<row r="3"><c r="A3" s="1"><v>0.0576388888888889</v></c><c r="B3" t="str"><v>x</v></c><c r="D3" t="s"><v>0</v></c></row>'
      + '<row r="4"><c r="A4" s="2"><v>0.000966435185185185</v></c><c r="C4"><v>1</v></c><c r="D4" t="inlineStr"><is><t>Lift &#x2014; hold</t></is></c></row>'
      + '<row r="5"><c r="A5" s="3"><v>45000</v></c><c r="D5" t="inlineStr"><is><t>Date</t></is></c></row>'
      + '<row r="6"><c r="A6"><v>12.346</v></c><c r="D6" t="inlineStr"><is><t>Seconds</t></is></c></row></sheetData></worksheet>';
    const bytes = zipSync({ 'xl/workbook.xml': strToU8(workbook), 'xl/_rels/workbook.xml.rels': strToU8(rels),
      'xl/styles.xml': strToU8(styles), 'xl/sharedStrings.xml': strToU8(shared),
      'xl/worksheets/a.xml': strToU8(marker), 'xl/worksheets/b.xml': strToU8(song) });
    const sheets = readXlsx(bytes);
    expect(sheets.map(item => item.name)).toEqual(['How & why', '01 Song']);
    const result = parseCueSheets(sheets, routine());
    expect(result.issues).toEqual([{ sheet: '01 Song', row: 5, message: t('cueImportBadTime') }]);
    expect(sheets[1]!.rows.get(3)?.get(3)).toEqual({ kind: 'string', value: 'Plié & hold' });
    const parsed = parseCueSheets([sheets[0]!, { ...sheets[1]!, rows: new Map([...sheets[1]!.rows].filter(([row]) => row !== 5)) }], routine());
    expect(parsed.songs[0]!.cues).toEqual([
      { seconds: 83, note: 'Plié & hold', beep: true, flash: false },
      { seconds: 83.5, note: 'Lift \u2014 hold', beep: false, flash: true },
      { seconds: 12.35, note: 'Seconds', beep: false, flash: false },
    ]);
  });

  it('reports every bad row with its tab and row number and never partially accepts a tab', () => {
    const value = routine();
    const rows = [
      [cell('0:30'), cell(true), cell(false), cell('Good')],
      [undefined, undefined, undefined, cell('No time')],
      [cell('1:5'), undefined, undefined, cell('Bad time')],
      [cell('2:00'), undefined, undefined, cell('At the end')],
      [cell('0:10'), undefined, undefined, undefined],
      [cell('0:11'), cell('maybe'), undefined, cell('Bad beep')],
      [undefined, undefined, cell(true), undefined],
      [cell('0:12'), undefined, undefined, cell('x'.repeat(501))],
      [undefined, cell(false), cell(false), undefined],
      [cell(':32'), undefined, undefined, cell('Blank minute')],
      [cell(':'), undefined, undefined, cell('Only colon')],
    ];
    const result = parseCueSheets([marker, sheet('01 Song', 'entry-a', rows), sheet('Extra', 'unknown', []),
      sheet('01 Copy', 'entry-a', [])], value);
    expect(result.issues).toEqual([
      { sheet: '01 Song', row: 4, message: t('cueImportMissingTime') },
      { sheet: '01 Song', row: 5, message: t('cueImportBadTime') },
      { sheet: '01 Song', row: 6, message: t('cueImportPastEnd', { time: '2:00' }) },
      { sheet: '01 Song', row: 7, message: t('cueImportMissingNote') },
      { sheet: '01 Song', row: 8, message: t('cueImportBadCheckbox', { column: t('cueTemplateBeep') }) },
      { sheet: '01 Song', row: 9, message: t('cueImportOrphanCheckbox') },
      { sheet: '01 Song', row: 10, message: t('cueImportLongNote') },
      { sheet: '01 Song', row: 13, message: t('cueImportBadTime') },
      { sheet: '01 Copy', message: t('cueImportDuplicateTab', { other: '01 Song' }) },
    ]);
    expect(result.ignored).toEqual(['Extra']);
    expect(result.songs[0]!.cues).toEqual([
      { seconds: 30, note: 'Good', beep: true, flash: false },
      { seconds: 32, note: 'Blank minute', beep: false, flash: false },
    ]);
    expect(() => parseCueSheets([marker, sheet('Other', 'nope', [])], value)).toThrow('cue_import_no_songs');
  });
});

describe('cue import planning', () => {
  const song = (cues: CueImportSong['cues']): CueImportSong =>
    ({ trackId: 'entry-a', trackIndex: 0, duration: 120, sheet: '01', heading: '1. Song', cues });
  let counter = 0;
  const id = () => `new-${++counter}`;

  it('replaces every cue including counted ones, sorted, and reports what is removed', () => {
    const value = routine(); counter = 0;
    const plan = planSongImport(value.tracks[0]!, song([
      { seconds: 50, note: 'B', beep: false, flash: true }, { seconds: 10, note: 'A', beep: true, flash: false },
    ]), 'replace', id);
    expect(plan.cues).toEqual([
      { id: 'new-2', anchor: { kind: 'timestamp', seconds: 10 }, note: 'A', beep: true, flash: false },
      { id: 'new-1', anchor: { kind: 'timestamp', seconds: 50 }, note: 'B', beep: false, flash: true },
    ]);
    expect(plan).toMatchObject({ removedOther: 1, removedAll: 0, duplicates: 0, overLimit: false });
    expect(planSongImport(value.tracks[0]!, song([]), 'replace', id)).toMatchObject({ cues: [], removedAll: 3 });
    value.tracks[0]!.cues = plan.cues!;
    expect(validateRoutine(value)).toEqual([]);
  });

  it('adds new rows, skips rows identical to existing cues (time to hundredths + trimmed note) and keeps existing cues', () => {
    const value = routine(); counter = 0;
    const before = structuredClone(value.tracks[0]!.cues);
    const plan = planSongImport(value.tracks[0]!, song([
      { seconds: 2.25, note: 'Set up <first>', beep: true, flash: false },
      { seconds: 2, note: 'Counted', beep: false, flash: false },
      { seconds: 30, note: 'New', beep: false, flash: false },
      { seconds: 30, note: 'New', beep: true, flash: false },
    ]), 'add', id);
    expect(plan.duplicates).toBe(3);
    expect(plan.cues!.map(cue => cue.id)).toEqual(['count', 'early', 'new-1', 'late']);
    expect(value.tracks[0]!.cues).toEqual(before);
  });

  it('skips untouched songs and flags results over the per-song cue limit', () => {
    const value = routine();
    expect(planSongImport(value.tracks[0]!, song([]), 'skip')).toEqual({ cues: null, removedOther: 0, removedAll: 0, duplicates: 0, overLimit: false });
    const many = Array.from({ length: 1001 }, (_, index) => ({ seconds: index / 10, note: `Cue ${index}`, beep: false, flash: false }));
    expect(planSongImport(value.tracks[0]!, song(many), 'replace').overLimit).toBe(true);
  });

  it('only adds the checkbox extension to the requested style indexes', () => {
    const styles = '<styleSheet><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="0" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="49"/></cellXfs></styleSheet>';
    const result = addCheckboxComplement(styles, new Set([1]));
    expect(result).toContain('<xf numFmtId="0" applyAlignment="1"><alignment horizontal="center"/><extLst>');
    expect(result.match(/xfComplement/g)).toHaveLength(1);
    expect(addCheckboxComplement(styles, new Set())).toBe(styles);
  });
});
