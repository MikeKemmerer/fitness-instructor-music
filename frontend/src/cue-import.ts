import type { CellObject, Feature, Sheet } from 'write-excel-file/browser';
import { cueSeconds, type Cue, type Routine, type Track } from '../../shared/routine';
import { parseCueTime } from './cue-time';
import { defaultExportPalette, exportTime } from './exports';
import { t } from './i18n';
import { readXlsx, type XlsxCell, type XlsxSheet } from './xlsx-read';

type TemplateSheet = Sheet<File | Blob | ArrayBuffer>;

export const CUE_TEMPLATE_VERSION = 'fim-cue-template-v1';
export const MAX_TRACK_CUES = 1000;
const FIRST_DATA_ROW = 3;
const MIN_TEMPLATE_ROWS = 100;
const SPARE_ROWS = 50;
const ID_COLUMN = 5;
const MAX_NOTE = 500;

export const FEATURE_BAG_PATH = 'xl/featurePropertyBag/featurePropertyBag.xml';
// Copied from a checkbox workbook saved by Excel 365.
export const FEATURE_BAG_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<FeaturePropertyBags xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/featurepropertybag"><bag type="Checkbox"/><bag type="XFControls"><bagId k="CellControl">0</bagId></bag><bag type="XFComplement"><bagId k="XFControls">1</bagId></bag><bag type="XFComplements" extRef="XFComplementsMapperExtRef"><a k="MappedFeaturePropertyBags"><bagId>2</bagId></a></bag></FeaturePropertyBags>';
const FEATURE_BAG_CONTENT_TYPE = '<Override PartName="/xl/featurePropertyBag/featurePropertyBag.xml" ContentType="application/vnd.ms-excel.featurepropertybag+xml"/>';
const FEATURE_BAG_RELATIONSHIP = '<Relationship Id="rIdFeaturePropertyBag" Type="http://schemas.microsoft.com/office/2022/11/relationships/FeaturePropertyBag" Target="featurePropertyBag/featurePropertyBag.xml"/>';
const CHECKBOX_EXTENSION = '<extLst><ext uri="{C7286773-470A-42A8-94C5-96B5CB345126}" xmlns:xfpb="http://schemas.microsoft.com/office/spreadsheetml/2022/featurepropertybag"><xfpb:xfComplement i="0"/></ext></extLst>';

export interface ImportedCue {
  readonly seconds: number;
  readonly note: string;
  readonly beep: boolean;
  readonly flash: boolean;
}

export interface CueImportSong {
  readonly trackId: string;
  readonly trackIndex: number;
  readonly duration: number;
  readonly sheet: string;
  readonly heading: string;
  readonly cues: readonly ImportedCue[];
}

export interface CueImportIssue {
  readonly sheet: string;
  readonly row?: number;
  readonly message: string;
}

export interface CueImportResult {
  readonly songs: readonly CueImportSong[];
  readonly issues: readonly CueImportIssue[];
  readonly ignored: readonly string[];
}

export type CueImportMode = 'replace' | 'add' | 'skip';

export interface CueImportPlan {
  readonly cues: Cue[] | null;
  readonly removedOther: number;
  readonly removedAll: number;
  readonly duplicates: number;
  readonly overLimit: boolean;
}

export interface CueImportChange {
  readonly trackId: string;
  readonly cues: Cue[];
}

export function cueTemplateSheetName(index: number, title: string): string {
  const cleaned = title.replace(/[\u0000-\u001f[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${String(index + 1).padStart(2, '0')} ${cleaned}`.slice(0, 31).replace(/[\s']+$/, '');
}

function songHeading(track: Track, index: number): string {
  return `${index + 1}. ${track.title}${track.bodyArea ? ` (${track.bodyArea})` : ''}`;
}

const textCell = (value: string | undefined, extra: Partial<CellObject> = {}): CellObject =>
  ({ type: String, value, format: '@', wrap: true, alignVertical: 'top', ...extra });
const checkboxCell = (value: boolean): CellObject =>
  ({ type: Boolean, value, align: 'center', alignVertical: 'center' });
const labelCell = (value: string): CellObject => ({ type: String, value, textColor: '#5F6B6A' });

export function buildCueTemplateSheets(routine: Routine, now = new Date()): TemplateSheet[] {
  const palette = defaultExportPalette;
  const header = (value: string): CellObject => ({ type: String, value, fontWeight: 'bold', wrap: true,
    backgroundColor: palette.headerFill, textColor: palette.headerText, alignVertical: 'center', height: 32 });
  const instructions: TemplateSheet = {
    sheet: t('cueTemplateInstructionsSheet'), showGridLines: false,
    columns: [{ width: 100 }, { width: 2 }, { width: 2 }, { width: 2 }, { width: 12 }, { width: 22 }],
    data: [
      [{ type: String, value: t('cueTemplateTitle', { name: routine.name }), fontWeight: 'bold', fontSize: 14 },
        null, null, null, labelCell(t('cueTemplateVersionLabel')), labelCell(CUE_TEMPLATE_VERSION)],
      [labelCell(t('cueTemplateExported', { time: now.toISOString() }))],
      [null],
      ...t('cueTemplateInstructions').split('\n').map(line => [{ type: String, value: line, wrap: true } as CellObject]),
    ],
  };
  const songs = routine.tracks.map((track, index): TemplateSheet => {
    const cues = track.cues.filter(cue => cue.anchor.kind === 'timestamp')
      .map(cue => ({ cue, seconds: cue.anchor.kind === 'timestamp' ? cue.anchor.seconds : 0 }))
      .sort((first, second) => first.seconds - second.seconds);
    const rows = Math.min(MAX_TRACK_CUES, Math.max(MIN_TEMPLATE_ROWS, cues.length + SPARE_ROWS));
    const data: (CellObject | null)[][] = [
      [{ type: String, value: songHeading(track, index), fontWeight: 'bold' }, null, null,
        labelCell(t('cueTemplateLength', { time: exportTime(track.duration) ?? '' })),
        labelCell(t('cueTemplateSongId')), labelCell(track.id)],
      [header(t('cueTemplateTimestamp')), header(t('cueTemplateBeep')), header(t('cueTemplateFlash')), header(t('cueTemplateNote'))],
    ];
    for (let row = 0; row < rows; row++) {
      const item = cues[row];
      data.push([
        textCell(item ? exportTime(item.seconds) ?? '' : undefined),
        checkboxCell(item?.cue.beep === true),
        checkboxCell(item?.cue.flash === true),
        textCell(item?.cue.note),
      ]);
    }
    return { sheet: cueTemplateSheetName(index, track.title), stickyRowsCount: 2,
      columns: [{ width: 20 }, { width: 13 }, { width: 13 }, { width: 70 }, { width: 22 }, { width: 40 }], data };
  });
  return [instructions, ...songs];
}

export function addCheckboxComplement(styles: string, styleIds: ReadonlySet<number>): string {
  const open = /<cellXfs\b[^>]*>/.exec(styles);
  if (!open || !styleIds.size) return styles;
  const start = open.index + open[0].length;
  const end = styles.indexOf('</cellXfs>', start);
  if (end < 0) return styles;
  let index = -1;
  const body = styles.slice(start, end).replace(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g, (match, attributes: string, inner?: string) => {
    index += 1;
    if (!styleIds.has(index) || match.includes('xfComplement')) return match;
    return `<xf${attributes.replace(/\s+$/, '')}>${inner ?? ''}${CHECKBOX_EXTENSION}</xf>`;
  });
  return styles.slice(0, start) + body + styles.slice(end);
}

export function checkboxFeature(): Feature<File | Blob | ArrayBuffer> {
  const styleIds = new Set<number>();
  return { files: {
    transform: {
      'xl/worksheets/sheet{id}.xml': {
        transformElementAttributes: (tagName, attributes) => {
          if (tagName === 'c' && attributes.t === 'b' && attributes.s !== undefined) styleIds.add(Number(attributes.s));
          return attributes;
        },
      },
      'xl/styles.xml': { transform: content => addCheckboxComplement(content, styleIds) },
      '[Content_Types].xml': { insert: () => FEATURE_BAG_CONTENT_TYPE },
      'xl/_rels/workbook.xml.rels': { insert: () => FEATURE_BAG_RELATIONSHIP },
    },
    write: { files: () => ({ [FEATURE_BAG_PATH]: FEATURE_BAG_XML }) },
  } };
}

export async function createCueTemplateBlob(routine: Routine, now = new Date()): Promise<Blob> {
  const sheets = buildCueTemplateSheets(routine, now);
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  return writeExcelFile(sheets, { fontFamily: 'Calibri', fontSize: 11, features: [checkboxFeature()] }).toBlob();
}

function cellText(cell: XlsxCell | undefined): string {
  if (!cell) return '';
  if (cell.kind === 'number') return String(cell.value);
  if (cell.kind === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  return cell.value;
}

function parseTime(cell: XlsxCell | undefined): number | null | undefined {
  if (!cell) return undefined;
  if (cell.kind === 'string') {
    const text = cell.value.trim();
    return text ? parseCueTime(text) : undefined;
  }
  if (cell.kind !== 'number') return null;
  const format = cell.format.toLowerCase().replace(/"[^"]*"|\\.|\[(?![hms]\])[^\]]*\]/g, '');
  if (/[yd]/.test(format)) return null;
  if (/[hs]/.test(format) || (format.includes('m') && format.includes(':'))) {
    // Excel reads a typed "1:23" as 1 h 23 min; a template user always means minutes:seconds.
    const seconds = format.includes('h') && !format.includes('s') ? cell.value * 1440 : cell.value * 86400;
    return seconds >= 0 ? seconds : null;
  }
  return cell.value >= 0 ? cell.value : null;
}

function parseFlag(cell: XlsxCell | undefined): boolean | null {
  if (!cell) return false;
  if (cell.kind === 'boolean') return cell.value;
  if (cell.kind === 'number') return cell.value === 1 ? true : cell.value === 0 ? false : null;
  if (cell.kind === 'error') return null;
  const value = cell.value.trim().toLowerCase();
  if (['true', 'yes', 'y', 'x', '1', '\u2713', '\u2714', '\u2611'].includes(value)) return true;
  if (['', 'false', 'no', 'n', '0', '\u2610'].includes(value)) return false;
  return null;
}

export function parseCueSheets(sheets: readonly XlsxSheet[], routine: Routine): CueImportResult {
  const at = (sheet: XlsxSheet, row: number, column: number) => sheet.rows.get(row)?.get(column);
  if (!sheets.some(sheet => cellText(at(sheet, 1, ID_COLUMN)).trim() === CUE_TEMPLATE_VERSION)) throw new Error('cue_import_not_template');
  const indexes = new Map(routine.tracks.map((track, index) => [track.id, index]));
  const claimed = new Map<string, string>();
  const songs: CueImportSong[] = [];
  const issues: CueImportIssue[] = [];
  const ignored: string[] = [];
  for (const sheet of sheets) {
    const id = cellText(at(sheet, 1, ID_COLUMN)).trim();
    if (id === CUE_TEMPLATE_VERSION) continue;
    const trackIndex = indexes.get(id);
    if (trackIndex === undefined) { ignored.push(sheet.name); continue; }
    const other = claimed.get(id);
    if (other !== undefined) { issues.push({ sheet: sheet.name, message: t('cueImportDuplicateTab', { other }) }); continue; }
    claimed.set(id, sheet.name);
    const track = routine.tracks[trackIndex]!;
    const cues: ImportedCue[] = [];
    for (let row = FIRST_DATA_ROW; row <= sheet.maxRow; row++) {
      const report = (message: string) => issues.push({ sheet: sheet.name, row, message });
      const note = cellText(at(sheet, row, 3)).trim();
      const time = parseTime(at(sheet, row, 0));
      const beep = parseFlag(at(sheet, row, 1));
      const flash = parseFlag(at(sheet, row, 2));
      const before = issues.length;
      if (beep === null) report(t('cueImportBadCheckbox', { column: t('cueTemplateBeep') }));
      if (flash === null) report(t('cueImportBadCheckbox', { column: t('cueTemplateFlash') }));
      if (time === undefined && !note) {
        if (beep || flash) report(t('cueImportOrphanCheckbox'));
        continue;
      }
      const seconds = typeof time === 'number' ? Math.round(time * 100) / 100 : time;
      if (seconds === undefined) report(t('cueImportMissingTime'));
      else if (seconds === null || !Number.isFinite(seconds)) report(t('cueImportBadTime'));
      else if (seconds >= track.duration) report(t('cueImportPastEnd', { time: exportTime(track.duration) ?? '' }));
      if (!note) report(t('cueImportMissingNote'));
      else if (note.length > MAX_NOTE) report(t('cueImportLongNote'));
      if (issues.length === before && typeof seconds === 'number') cues.push({ seconds, note, beep: beep === true, flash: flash === true });
    }
    if (cues.length > MAX_TRACK_CUES) issues.push({ sheet: sheet.name, message: t('cueImportTooManyRows') });
    songs.push({ trackId: id, trackIndex, duration: track.duration, sheet: sheet.name, heading: songHeading(track, trackIndex), cues });
  }
  if (!songs.length && !issues.length) throw new Error('cue_import_no_songs');
  songs.sort((first, second) => first.trackIndex - second.trackIndex);
  return { songs, issues, ignored };
}

export function readCueWorkbook(bytes: Uint8Array, routine: Routine): CueImportResult {
  return parseCueSheets(readXlsx(bytes), routine);
}

function effectiveSeconds(cue: Cue, track: Track): number {
  try { return cueSeconds(cue, track); } catch { return Number.POSITIVE_INFINITY; }
}

const cueKey = (seconds: number, note: string) => `${Math.round(seconds * 100)}\u0000${note.trim()}`;

export function planSongImport(track: Track, song: CueImportSong, mode: CueImportMode,
  newId: () => string = () => crypto.randomUUID()): CueImportPlan {
  if (mode === 'skip') return { cues: null, removedOther: 0, removedAll: 0, duplicates: 0, overLimit: false };
  const create = (cue: ImportedCue): Cue => ({ id: newId(), anchor: { kind: 'timestamp', seconds: cue.seconds },
    note: cue.note, beep: cue.beep, flash: cue.flash });
  const sort = (cues: Cue[]) => cues.map((cue, order) => ({ cue, order, seconds: effectiveSeconds(cue, track) }))
    .sort((first, second) => first.seconds - second.seconds || first.order - second.order).map(item => item.cue);
  if (mode === 'replace') {
    const cues = sort(song.cues.map(create));
    return { cues, removedOther: track.cues.filter(cue => cue.anchor.kind !== 'timestamp').length,
      removedAll: song.cues.length ? 0 : track.cues.length, duplicates: 0, overLimit: cues.length > MAX_TRACK_CUES };
  }
  const existing = new Set(track.cues.map(cue => cueKey(effectiveSeconds(cue, track), cue.note)));
  const added: Cue[] = [];
  for (const cue of song.cues) {
    const key = cueKey(cue.seconds, cue.note);
    if (existing.has(key)) continue;
    existing.add(key);
    added.push(create(cue));
  }
  const cues = sort([...structuredClone(track.cues), ...added]);
  return { cues, removedOther: 0, removedAll: 0, duplicates: song.cues.length - added.length, overLimit: cues.length > MAX_TRACK_CUES };
}
