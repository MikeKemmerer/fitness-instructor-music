import { allRoutineTracks, cueSeconds, transitionAfter, validateRoutine, type Cue, type Routine, type Track } from '../../shared/routine';
import type { CellObject, Feature, Sheet } from 'write-excel-file/browser';
import type { UserOptions } from 'jspdf-autotable';
import { t, validationMessage, type MessageKey } from './i18n';
import pdfFontUrl from './assets/fonts/NotoSans-Regular.ttf?url';

export interface ExportRow {
  readonly routine: Routine;
  readonly track: Track;
  readonly trackIndex: number;
  readonly cue: Cue | null;
  readonly cueOrder: number | null;
  readonly effectiveSeconds: number | null;
  readonly issues: readonly string[];
}

export interface ExportSnapshot {
  readonly routine: Routine;
  readonly unsaved: boolean;
  readonly exportedAt: string;
  readonly rows: readonly ExportRow[];
  readonly issues: readonly string[];
}

function freezeTree<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function createExportSnapshot(routine: Routine, unsaved: boolean, now = new Date()): ExportSnapshot {
  const copy = structuredClone(routine);
  const rows: ExportRow[] = [];
  const issues = validateRoutine(copy);
  const trackIds = new Set<string>();
  allRoutineTracks(copy).forEach((track, trackIndex) => {
    const trackIssues = validateRoutine({ ...copy, sequence: undefined, tracks: [{ ...track, cues: [] }] });
    if (trackIds.has(track.id)) trackIssues.push('Track entry IDs must be unique');
    trackIds.add(track.id);
    const cueIds = new Set<string>();
    const cues = track.cues.map((cue, sourceIndex) => {
      const cueIssues = validateRoutine({ ...copy, sequence: undefined, tracks: [{ ...track, cues: [cue] }] });
      if (cueIds.has(cue.id)) cueIssues.push('Cue IDs must be unique');
      cueIds.add(cue.id);
      let seconds: number | null = null;
      try {
        const computed = cueSeconds(cue, track);
        if (Number.isFinite(computed)) seconds = computed;
      } catch { seconds = null; }
      const validTime = seconds !== null && seconds >= 0 && seconds < track.duration
        && ['timestamp', 'interval', 'count'].includes(cue.anchor.kind);
      return { cue, sourceIndex, seconds, validTime, issues: [...new Set([...trackIssues, ...cueIssues])] };
    });
    cues.sort((left, right) => {
      if (left.validTime !== right.validTime) return left.validTime ? -1 : 1;
      return (left.validTime ? left.seconds! - right.seconds! : 0) || left.sourceIndex - right.sourceIndex;
    });
    if (!cues.length) rows.push({ routine: copy, track, trackIndex: trackIndex + 1,
      cue: null, cueOrder: null, effectiveSeconds: null, issues: trackIssues });
    cues.forEach((item, cueIndex) => rows.push({ routine: copy, track, trackIndex: trackIndex + 1,
      cue: item.cue, cueOrder: cueIndex + 1, effectiveSeconds: item.seconds, issues: item.issues }));
  });
  return freezeTree({ routine: copy, unsaved, exportedAt: now.toISOString(), rows, issues });
}

export type ExportValue = string | number | boolean | null;
export interface ExportColumn {
  readonly id: string;
  readonly label: MessageKey;
  readonly group: MessageKey;
  readonly type: 'string' | 'number' | 'boolean';
  readonly width: number;
  readonly default: boolean;
  readonly value: (row: ExportRow) => ExportValue | undefined;
}

export function exportTime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const milliseconds = Math.round(Math.abs(seconds) * 1000);
  const minutes = Math.floor(milliseconds / 60000);
  const remainder = String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0');
  const fraction = milliseconds % 1000 ? `.${String(milliseconds % 1000).padStart(3, '0').replace(/0+$/, '')}` : '';
  return `${seconds < 0 ? '-' : ''}${minutes}:${remainder}${fraction}`;
}

export const exportColumns: readonly ExportColumn[] = freezeTree([
  { id: 'track.phase', label: 'classSequence', group: 'exportTrackFields', type: 'string', width: 20, default: true,
    value: row => t(row.routine.sequence?.walkIn?.tracks.some(track => track.id === row.track.id) ? 'phaseWalkIn' : row.routine.sequence?.walkOut?.tracks.some(track => track.id === row.track.id) ? 'phaseWalkOut' : 'phaseRoutine') },
  { id: 'routine.sequence', label: 'classSequence', group: 'exportRoutineFields', type: 'string', width: 60, default: false, value: row => sequenceSummary(row.routine) },
  { id: 'routine.id', label: 'exportRoutineId', group: 'exportRoutineFields', type: 'string', width: 38, default: false, value: row => row.routine.id },
  { id: 'routine.name', label: 'routineName', group: 'exportRoutineFields', type: 'string', width: 30, default: false, value: row => row.routine.name },
  { id: 'routine.revision', label: 'exportRevision', group: 'exportRoutineFields', type: 'number', width: 14, default: false, value: row => row.routine.revision },
  { id: 'routine.schemaVersion', label: 'exportSchema', group: 'exportRoutineFields', type: 'number', width: 14, default: false, value: row => row.routine.schemaVersion },
  { id: 'routine.locked', label: 'exportLocked', group: 'exportRoutineFields', type: 'boolean', width: 14, default: false, value: row => row.routine.locked },
  { id: 'routine.published', label: 'exportPublishedColumn', group: 'exportRoutineFields', type: 'boolean', width: 14, default: false, value: row => row.routine.published },
  { id: 'track.index', label: 'exportTrackIndex', group: 'exportTrackFields', type: 'number', width: 12, default: true, value: row => row.trackIndex },
  { id: 'track.id', label: 'exportTrackId', group: 'exportTrackFields', type: 'string', width: 38, default: false, value: row => row.track.id },
  { id: 'track.title', label: 'title', group: 'exportTrackFields', type: 'string', width: 32, default: true, value: row => row.track.title },
  { id: 'track.duration', label: 'exportDurationSeconds', group: 'exportTrackFields', type: 'number', width: 18, default: false, value: row => row.track.duration },
  { id: 'track.durationTime', label: 'exportDurationTime', group: 'exportTrackFields', type: 'string', width: 16, default: true, value: row => exportTime(row.track.duration) },
  { id: 'track.bpm', label: 'bpm', group: 'exportTrackFields', type: 'number', width: 12, default: true, value: row => row.track.bpm },
  { id: 'track.firstBeat', label: 'firstBeat', group: 'exportTrackFields', type: 'number', width: 18, default: false, value: row => row.track.firstBeat },
  { id: 'track.bodyArea', label: 'bodyArea', group: 'exportTrackFields', type: 'string', width: 24, default: true, value: row => row.track.bodyArea },
  { id: 'track.gain', label: 'trackGain', group: 'exportTrackFields', type: 'number', width: 18, default: false, value: row => row.track.gain ?? 1 },
  { id: 'track.after.mode', label: 'exportAfter', group: 'exportTrackFields', type: 'string', width: 20, default: false, value: row => row.track.after?.mode ?? 'inherit' },
  { id: 'track.after.crossfade', label: 'exportAfterFade', group: 'exportTrackFields', type: 'number', width: 20, default: false,
    value: row => row.track.after?.mode === 'custom' ? row.track.after.crossfade : undefined },
  { id: 'track.after.filler', label: 'exportAfterFiller', group: 'exportTrackFields', type: 'string', width: 60, default: false,
    value: row => row.track.after?.mode === 'custom' ? JSON.stringify(row.track.after.filler) : undefined },
  { id: 'cue.id', label: 'exportCueId', group: 'exportCueFields', type: 'string', width: 38, default: false, value: row => row.cue?.id },
  { id: 'cue.order', label: 'exportCueOrder', group: 'exportCueFields', type: 'number', width: 14, default: false, value: row => row.cueOrder },
  { id: 'cue.anchor.kind', label: 'exportAnchorKind', group: 'exportCueFields', type: 'string', width: 16, default: true, value: row => row.cue?.anchor.kind },
  { id: 'cue.anchor.value', label: 'exportAnchorValue', group: 'exportCueFields', type: 'number', width: 20, default: true, value: row => row.cue ? row.cue.anchor.kind === 'count' ? row.cue.anchor.count : row.cue.anchor.seconds : null },
  { id: 'cue.seconds', label: 'exportCueSeconds', group: 'exportCueFields', type: 'number', width: 20, default: false, value: row => row.effectiveSeconds },
  { id: 'cue.time', label: 'exportCueTime', group: 'exportCueFields', type: 'string', width: 18, default: true, value: row => exportTime(row.effectiveSeconds) },
  { id: 'cue.note', label: 'note', group: 'exportCueFields', type: 'string', width: 60, default: true, value: row => row.cue?.note },
  { id: 'cue.beep', label: 'cueBeep', group: 'exportCueFields', type: 'boolean', width: 12, default: true, value: row => row.cue ? row.cue.beep ?? false : null },
  { id: 'filler.mode', label: 'fillerMode', group: 'exportSoundFields', type: 'string', width: 16, default: false, value: row => row.routine.filler.mode },
  { id: 'filler.seconds', label: 'exportFillerSeconds', group: 'exportSoundFields', type: 'number', width: 16, default: false, value: row => row.routine.filler.seconds },
  { id: 'filler.bpm', label: 'exportFillerBpm', group: 'exportSoundFields', type: 'number', width: 20, default: false, value: row => row.routine.filler.bpm },
  { id: 'filler.sound', label: 'fillerSound', group: 'exportSoundFields', type: 'string', width: 28, default: false, value: row => fillerSoundName(row.routine) },
  { id: 'filler.gain', label: 'fillerGain', group: 'exportSoundFields', type: 'number', width: 18, default: false, value: row => row.routine.filler.gain ?? 1 },
  { id: 'filler.recording.id', label: 'exportFillerId', group: 'exportSoundFields', type: 'string', width: 38, default: false, value: row => row.routine.filler.recording?.id },
  { id: 'filler.recording.name', label: 'exportFillerName', group: 'exportSoundFields', type: 'string', width: 30, default: false, value: row => row.routine.filler.recording?.name },
  { id: 'filler.recording.duration', label: 'exportFillerDuration', group: 'exportSoundFields', type: 'number', width: 22, default: false, value: row => row.routine.filler.recording?.duration },
  { id: 'filler.recording.asset.id', label: 'exportFillerAssetId', group: 'exportSoundFields', type: 'string', width: 38, default: false, value: row => row.routine.filler.recording?.asset.id },
  { id: 'filler.recording.asset.sha256', label: 'exportFillerHash', group: 'exportSoundFields', type: 'string', width: 66, default: false, value: row => row.routine.filler.recording?.asset.sha256 },
  { id: 'filler.recording.asset.bytes', label: 'exportFillerBytes', group: 'exportSoundFields', type: 'number', width: 20, default: false, value: row => row.routine.filler.recording?.asset.bytes },
  { id: 'filler.recording.asset.contentType', label: 'exportFillerType', group: 'exportSoundFields', type: 'string', width: 22, default: false, value: row => row.routine.filler.recording?.asset.contentType },
  { id: 'routine.crossfade', label: 'crossfade', group: 'exportSoundFields', type: 'number', width: 18, default: false, value: row => row.routine.crossfade },
  { id: 'routine.beepEvery', label: 'beepEvery', group: 'exportSoundFields', type: 'number', width: 22, default: false, value: row => row.routine.beepEvery },
  { id: 'routine.beepRemaining', label: 'beepRemaining', group: 'exportSoundFields', type: 'number', width: 24, default: false, value: row => row.routine.beepRemaining },
  { id: 'routine.beepOnceRemaining', label: 'beepOnceRemaining', group: 'exportSoundFields', type: 'number', width: 24, default: false, value: row => row.routine.beepOnceRemaining },
  { id: 'row.status', label: 'exportRowStatus', group: 'exportValidationFields', type: 'string', width: 40, default: true, value: row => row.issues.length ? row.issues.map(validationMessage).join('\n') : t('exportValid') },
]);

export function fillerSoundName(routine: Routine): string {
  const sound = routine.filler.sound;
  return sound === 'recording' ? routine.filler.recording?.name ?? t('customFillers') : t(sound);
}

function sequenceSummary(routine: Routine): string | undefined {
  if (!routine.sequence) return undefined;
  const { crossfade, before, after, walkIn, walkOut } = routine.sequence;
  return JSON.stringify({ crossfade, before, after, walkIn: walkIn ? { name: walkIn.name, source: walkIn.source } : undefined,
    walkOut: walkOut ? { name: walkOut.name, source: walkOut.source } : undefined });
}

function routineColumnValue(routine: Routine, column: ExportColumn): ExportValue | undefined {
  if (column.id === 'routine.sequence') return sequenceSummary(routine);
  if (column.id === 'filler.sound') return fillerSoundName(routine);
  if (column.id === 'filler.gain') return routine.filler.gain ?? 1;
  const [group, ...keys] = column.id.split('.');
  let value: unknown = group === 'routine' ? routine : group === 'filler' ? routine.filler : undefined;
  for (const key of keys) value = value && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
}

export function selectedExportColumns(ids: readonly string[]): readonly ExportColumn[] {
  const selected = new Set(ids);
  return exportColumns.filter(column => selected.has(column.id));
}

export function defaultExportColumns(): string[] {
  return exportColumns.filter(column => column.default).map(column => column.id);
}

export function defaultPdfColumns(): string[] {
  return exportColumns.filter(column => !['routine.id', 'track.id', 'cue.id', 'cue.order', 'cue.seconds',
    'track.duration'].includes(column.id)).map(column => column.id);
}

export function columnValue(column: ExportColumn, row: ExportRow): ExportValue {
  const value = column.value(row);
  if (value === undefined || value === null || typeof value !== column.type) return null;
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

function stringCell(value: string): CellObject { return { type: String, value, wrap: true, alignVertical: 'top' }; }

export function buildWorkbookSheets(snapshot: ExportSnapshot, selectedIds: readonly string[]): Sheet<File | Blob | ArrayBuffer>[] {
  const columns = selectedExportColumns(selectedIds);
  if (!columns.length) throw new Error(t('exportNoColumns'));
  const selected = new Set(columns.map(column => column.id));
  const invalidRows = snapshot.rows.filter(row => row.issues.length).length;
  const overview: [string, string | number][] = [
    [t('exportTimestamp'), snapshot.exportedAt],
    [t('exportStatus'), t(snapshot.unsaved ? 'exportUnsaved' : 'exportSaved')],
    [t('exportPrivacy'), t('exportPrivate')],
    [t('exportIssueCount'), invalidRows],
  ];
  if (!snapshot.rows.length) {
    for (const column of columns) {
      const [group] = column.id.split('.');
      const value = routineColumnValue(snapshot.routine, column);
      if (group !== 'routine' && group !== 'filler') continue;
      overview.push([t(column.label), typeof value === 'boolean' ? t(value ? 'exportYes' : 'exportNo')
        : typeof value === 'number' ? Number.isFinite(value) ? value : t('exportNeedsReview')
          : typeof value === 'string' ? value : '']);
    }
  }
  if (selected.has('track.duration') || selected.has('track.durationTime')) {
    const total = allRoutineTracks(snapshot.routine).reduce((seconds, track) => seconds + track.duration, 0);
    overview.push([t('exportSourceDuration'), Number.isFinite(total) && total >= 0 ? total : t('exportNeedsReview')]);
  }
  if (selected.has('filler.mode') && (snapshot.routine.tracks.every(track => !track.after) || (selected.has('track.after.mode') && selected.has('track.after.filler')))
    && snapshot.routine.tracks.some((_track, index) => transitionAfter(snapshot.routine, index).filler.mode === 'hold')) {
    overview.push([t('exportHoldDuration'), t('exportOpenEnded')]);
  }
  return [{
    sheet: t('exportSheet'), showGridLines: false, stickyRowsCount: 1,
    columns: columns.map(column => ({ width: column.width })),
    data: [columns.map(column => ({ ...stringCell(t(column.label)), fontWeight: 'bold',
      backgroundColor: '#176B68', textColor: '#FFFFFF', height: 44 })),
    ...snapshot.rows.map((row, rowIndex) => columns.map(column => {
      const value = columnValue(column, row);
      const type = column.type === 'number' ? Number : column.type === 'boolean' ? Boolean : String;
      return { value: value ?? undefined, type, wrap: true, alignVertical: 'top' as const,
        backgroundColor: row.issues.length ? '#FCE9E7' : rowIndex % 2 ? '#F0F6F5' : '#FFFFFF',
        textColor: '#243B39' };
    }))],
  }, {
    sheet: t('exportOverview'), showGridLines: false, columns: [{ width: 42 }, { width: 65 }],
    data: overview.map(([label, value]) => [
      { ...stringCell(label), fontWeight: 'bold', backgroundColor: '#F0F6F5' },
      typeof value === 'number' ? { type: Number, value } : stringCell(value),
    ]),
  }];
}

export function exportFilename(name: string, extension: 'xlsx' | 'pdf'): string {
  const title = name.trim().replace(/(?:\.(?:xlsx|pdf))+$/i, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]/g, '-').replace(/[-\s_]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '') || 'routine';
  return `${/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(title) ? `routine-${title}` : title}.${extension}`;
}

export interface PdfTrackSection {
  readonly heading: string;
  readonly details: string;
  readonly cues: readonly (readonly string[])[];
  readonly columns: readonly ExportColumn[];
}

export interface PdfPacket {
  readonly title: string;
  readonly metadata: readonly string[];
  readonly settings: readonly (readonly [string, string])[];
  readonly tracks: readonly PdfTrackSection[];
}

export function buildPdfPacket(snapshot: ExportSnapshot, selectedIds: readonly string[] = defaultPdfColumns()): PdfPacket {
  const routine = snapshot.routine;
  const columns = selectedExportColumns(selectedIds);
  if (!columns.length) throw new Error(t('exportNoColumns'));
  const selected = new Set(columns.map(column => column.id));
  const display = (value: ExportValue | undefined): string => value === null || value === undefined ? ''
    : typeof value === 'boolean' ? t(value ? 'exportYes' : 'exportNo')
      : typeof value === 'number' ? Number.isFinite(value) ? String(value) : t('exportNeedsReview') : value;
  const settings: [string, string][] = [];
  for (const column of columns) {
    const [group] = column.id.split('.');
    if (group !== 'routine' && group !== 'filler') continue;
    const value = routineColumnValue(routine, column);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === undefined) settings.push([t(column.label), display(value)]);
  }
  if (selected.has('filler.mode') && (routine.tracks.every(track => !track.after) || (selected.has('track.after.mode') && selected.has('track.after.filler')))
    && routine.tracks.some((_track, index) => transitionAfter(routine, index).filler.mode === 'hold')) settings.push([t('exportHoldDuration'), t('exportOpenEnded')]);
  const cueColumns = columns.filter(column => column.group === 'exportCueFields' || column.id === 'row.status');
  return {
    title: selected.has('routine.name') ? routine.name : t('exportPacket'),
    metadata: [t(snapshot.unsaved ? 'exportUnsaved' : 'exportSaved'), snapshot.exportedAt, t('exportPrivate')],
    settings,
    tracks: allRoutineTracks(routine).map((track, index) => ({
      heading: [selected.has('track.index') ? String(index + 1) : '', selected.has('track.title') ? track.title : ''].filter(Boolean).join('. '),
      details: columns.filter(column => column.group === 'exportTrackFields' && !['track.index', 'track.title'].includes(column.id))
        .map(column => `${t(column.label)}: ${display(columnValue(column, snapshot.rows.find(row => row.trackIndex === index + 1)!))}`).join(' / '),
      columns: cueColumns,
      cues: snapshot.rows.filter(row => row.trackIndex === index + 1 && row.cue)
        .map(row => cueColumns.map(column => {
          const value = columnValue(column, row);
          return value === null && ['cue.time', 'cue.seconds'].includes(column.id) ? t('exportNeedsReview') : display(value);
        })),
    })),
  };
}

export function worksheetFilterRange(columnCount: number, rowCount: number): string {
  if (!Number.isInteger(columnCount) || columnCount < 1 || columnCount > 16384
    || !Number.isInteger(rowCount) || rowCount < 1 || rowCount > 1048576) throw new Error(t('exportFailed'));
  let columnName = '';
  for (let remaining = columnCount; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    columnName = String.fromCharCode(65 + (remaining - 1) % 26) + columnName;
  }
  return `A1:${columnName}${rowCount}`;
}

export async function createExcelBlob(snapshot: ExportSnapshot, selectedIds: readonly string[]): Promise<Blob> {
  const sheets = buildWorkbookSheets(snapshot, selectedIds);
  const range = worksheetFilterRange(sheets[0]!.columns!.length, sheets[0]!.data.length);
  const filters: Feature<File | Blob | ArrayBuffer> = {
    files: { transform: { 'xl/worksheets/sheet{id}.xml': {
      insert: (_options, { sheetIndex }) => sheetIndex === 0 ? `<autoFilter ref="${range}"/>` : undefined,
    } } },
  };
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  return writeExcelFile(sheets, { fontFamily: 'Calibri', fontSize: 11, features: [filters] }).toBlob();
}

export const pdfFontPath = 'fonts/NotoSans-Regular.ttf';

async function loadPdfFont(): Promise<Uint8Array> {
  try {
    const response = await fetch(pdfFontUrl, {
      credentials: 'omit', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('font_unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 12 || new DataView(bytes.buffer).getUint32(0) !== 0x00010000) throw new Error('invalid_font');
    return bytes;
  } catch { throw new Error(t('exportFontMissing')); }
}

export function assertPdfCharacters(texts: readonly string[], hasGlyph: (codePoint: number) => boolean): void {
  const supported = /^[\u0020-\u007e\u00a0-\u024f\u0300-\u052f\u1e00-\u1fff\u2000-\u206f\u20a0-\u20cf\u2de0-\u2dff\ua640-\ua69f]$/u;
  for (const text of texts) {
    for (const character of text) {
      if (character === '\n' || character === '\r' || character === '\t') continue;
      if (!supported.test(character) || /\p{Cf}/u.test(character) || !hasGlyph(character.codePointAt(0)!)) {
        throw new Error(t('exportUnsupportedText'));
      }
    }
  }
}

export function buildPdfTables(packet: PdfPacket): UserOptions[] {
  const common: UserOptions = {
    margin: { top: 36, right: 36, bottom: 42, left: 36 },
    styles: { font: 'NotoSans', fontStyle: 'normal', fontSize: 9, cellPadding: 6,
      textColor: '#243B39', overflow: 'linebreak', valign: 'top' },
    headStyles: { font: 'NotoSans', fontStyle: 'normal', fillColor: '#176B68', textColor: '#FFFFFF' },
    alternateRowStyles: { fillColor: '#F0F6F5' },
    tableWidth: 540, pageBreak: 'auto', rowPageBreak: 'avoid', showHead: 'everyPage',
  };
  return [
    { ...common, theme: 'plain', body: [
      [{ content: packet.title, styles: { fontSize: 20, textColor: '#176B68' } }],
      [{ content: packet.metadata.join('\n'), styles: { fontSize: 9 } }],
    ] },
    ...(packet.settings.length ? [{ ...common, theme: 'striped' as const, head: [[{ content: t('exportRoutineFields'), colSpan: 2 }]],
      body: packet.settings.map(row => [...row]), columnStyles: { 0: { cellWidth: 230 }, 1: { cellWidth: 310 } } }] : []),
    ...packet.tracks.filter(track => track.heading || track.details || track.columns.length).flatMap(track => {
      const bands = Array.from({ length: Math.max(1, Math.ceil(track.columns.length / 6)) }, (_, index) => {
        const columns = track.columns.slice(index * 6, (index + 1) * 6);
        const time = track.columns.find(column => column.id === 'cue.time');
        if (index > 0 && time && !columns.includes(time)) columns.unshift(time);
        return columns;
      });
      return bands.map(columns => {
      const widths = columns.map(column => column.id === 'cue.note' ? 300 : column.id === 'row.status' ? 90 : 65);
      const totalWidth = widths.reduce((total, width) => total + width, 0);
      return {
      ...common, theme: 'striped' as const,
      head: [...(track.heading || track.details ? [[{ content: [track.heading, track.details].filter(Boolean).join('\n'),
        colSpan: Math.max(1, columns.length), styles: { fontSize: 10 } }]] : []),
        ...(columns.length ? [columns.map(column => t(column.label))] : [])],
      body: !columns.length ? [] : track.cues.length ? track.cues.map(row => columns.map(column => row[track.columns.indexOf(column)]!))
        : [[{ content: t('emptyCues'), colSpan: columns.length }]],
      horizontalPageBreak: false,
      columnStyles: Object.fromEntries(columns.map((_column, index) => [index, {
        cellWidth: widths[index]! / totalWidth * 540,
      }])),
    }; }); }),
  ];
}

export async function createPdfBlob(snapshot: ExportSnapshot, fontBytes?: Uint8Array, selectedIds: readonly string[] = defaultPdfColumns()): Promise<Blob> {
  const packet = buildPdfPacket(snapshot, selectedIds);
  const [{ jsPDF }, { autoTable }, bytes] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), fontBytes ? Promise.resolve(fontBytes) : loadPdfFont(),
  ]);
  const document = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter', putOnlyUsedFonts: true, compress: true });
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  document.addFileToVFS('NotoSans-Regular.ttf', btoa(binary));
  document.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
  document.setFont('NotoSans', 'normal');
  const metadata = document.getFont().metadata as { characterToGlyph?: (codePoint: number) => number };
  if (typeof metadata.characterToGlyph !== 'function') throw new Error(t('exportFontMissing'));
  const texts = [packet.title, ...packet.metadata, ...packet.settings.flat(),
    ...packet.tracks.flatMap(track => [track.heading, track.details, ...track.cues.flat(), ...track.columns.map(column => t(column.label))]),
    t('exportSettings'), t('emptyCues'), t('exportPdfTime'), t('exportPdfType'), t('exportPdfCount'),
    t('exportPdfNote'), t('exportPdfBeep'), t('exportPacket'), t('exportPage', { page: 1, total: 1 })];
  assertPdfCharacters(texts, codePoint => metadata.characterToGlyph!(codePoint) !== 0);
  document.setProperties({ title: packet.title, subject: t('exportPacket'), creator: t('appName') });
  let nextY = 36;
  for (const table of buildPdfTables(packet)) {
    if (nextY > 630) { document.addPage(); nextY = 36; }
    autoTable(document, { ...table, startY: nextY, didDrawPage: data => {
      if (data.cursor) nextY = data.cursor.y + 18;
    } });
  }
  const pages = document.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    document.setPage(page);
    document.setFont('NotoSans', 'normal');
    document.setFontSize(8);
    document.setTextColor('#49625F');
    document.text(t('exportPacket'), 36, 768);
    document.text(t('exportPage', { page, total: pages }), 576, 768, { align: 'right' });
  }
  return document.output('blob');
}

export function downloadExport(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000); }
}