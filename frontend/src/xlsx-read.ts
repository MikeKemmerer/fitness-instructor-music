import { strFromU8, unzipSync } from 'fflate';

export type XlsxCell =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number; readonly format: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly value: string };

export interface XlsxSheet {
  readonly name: string;
  readonly rows: ReadonlyMap<number, ReadonlyMap<number, XlsxCell>>;
  readonly maxRow: number;
}

export const XLSX_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_SHEETS = 128;
const MAX_ROW = 5000;
const MAX_COLUMN = 64;

const builtInFormats: Record<number, string> = {
  14: 'm/d/yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 49: '@',
};

const invalid = (): never => { throw new Error('cue_import_not_xlsx'); };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return '\'';
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/_x([0-9a-f]{4})_/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1]!.replace(/^\w+:(?=id$)/, 'r:');
    result[name] = decode(match[2] ?? match[3] ?? '');
  }
  return result;
}

function section(xml: string, name: string): string {
  const open = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*?(/?)>`).exec(xml);
  if (!open || open[1]) return '';
  const start = open.index + open[0].length;
  const end = new RegExp(`</(?:\\w+:)?${name}>`).exec(xml.slice(start));
  return end ? xml.slice(start, start + end.index) : '';
}

function text(xml: string): string {
  const withoutPhonetic = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let result = '';
  for (const match of withoutPhonetic.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) result += decode(match[1] ?? '');
  return result;
}

function column(reference: string): number {
  let index = 0;
  for (const letter of reference) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function resolveTarget(target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export function readXlsx(bytes: Uint8Array): XlsxSheet[] {
  if (bytes.length > XLSX_MAX_BYTES) throw new Error('cue_import_too_large');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) invalid();
  let total = 0;
  let oversized = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: file => {
      const wanted = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(file.name);
      if (!wanted) return false;
      total += file.originalSize;
      if (file.originalSize > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) { oversized = true; return false; }
      return true;
    } });
  } catch { return invalid(); }
  if (oversized) throw new Error('cue_import_too_large');
  const read = (path: string) => files[path] ? strFromU8(files[path]) : '';
  const workbook = read('xl/workbook.xml');
  if (!workbook) invalid();
  const relationships = new Map<string, string>();
  for (const match of read('xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const { Id: id, Target: target } = attributes(match[1]!);
    if (id && target) relationships.set(id, resolveTarget(target));
  }
  const shared: string[] = [];
  for (const match of read('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) shared.push(text(match[1] ?? ''));
  const styles = read('xl/styles.xml');
  const customFormats = new Map<number, string>();
  for (const match of section(styles, 'numFmts').matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?>/g)) {
    const { numFmtId, formatCode } = attributes(match[1]!);
    if (numFmtId && formatCode !== undefined) customFormats.set(Number(numFmtId), formatCode);
  }
  const cellFormats: string[] = [];
  for (const match of section(styles, 'cellXfs').matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)) {
    const id = Number(attributes(match[1]!).numFmtId ?? 0);
    cellFormats.push(customFormats.get(id) ?? builtInFormats[id] ?? 'General');
  }
  const sheets: XlsxSheet[] = [];
  for (const match of section(workbook, 'sheets').matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    if (sheets.length >= MAX_SHEETS) throw new Error('cue_import_too_large');
    const { name = '', 'r:id': relationship = '' } = attributes(match[1]!);
    const path = relationships.get(relationship);
    const xml = path ? read(path) : '';
    const rows = new Map<number, Map<number, XlsxCell>>();
    let maxRow = 0;
    let rowNumber = 0;
    for (const rowMatch of section(xml, 'sheetData').matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const rowAttributes = attributes(rowMatch[1]!);
      rowNumber = rowAttributes.r ? Number(rowAttributes.r) : rowNumber + 1;
      if (!Number.isInteger(rowNumber) || rowNumber < 1) invalid();
      if (rowNumber > MAX_ROW) break;
      let col = -1;
      for (const cell of (rowMatch[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = attributes(cell[1]!);
        const reference = /^([A-Z]{1,3})\d+$/.exec(attrs.r ?? '');
        col = reference ? column(reference[1]!) : col + 1;
        if (col >= MAX_COLUMN) continue;
        const body = cell[2] ?? '';
        const value = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
        const type = attrs.t ?? 'n';
        let parsed: XlsxCell | undefined;
        if (type === 'inlineStr') parsed = { kind: 'string', value: text(section(body, 'is')) };
        else if (value === undefined) parsed = undefined;
        else if (type === 's') parsed = { kind: 'string', value: shared[Number(value)] ?? '' };
        else if (type === 'str' || type === 'd') parsed = { kind: 'string', value: decode(value) };
        else if (type === 'b') parsed = { kind: 'boolean', value: value.trim() === '1' };
        else if (type === 'e') parsed = { kind: 'error', value: decode(value) };
        else {
          const number = Number(value);
          parsed = Number.isFinite(number)
            ? { kind: 'number', value: number, format: cellFormats[Number(attrs.s ?? 0)] ?? 'General' }
            : { kind: 'error', value: decode(value) };
        }
        if (!parsed) continue;
        let cells = rows.get(rowNumber);
        if (!cells) rows.set(rowNumber, cells = new Map());
        cells.set(col, parsed);
        maxRow = Math.max(maxRow, rowNumber);
      }
    }
    sheets.push({ name, rows, maxRow });
  }
  if (!sheets.length) invalid();
  return sheets;
}
