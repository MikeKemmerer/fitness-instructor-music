import { Check, CheckCheck, Download, FileDown, FileText, FileUp, RotateCcw, Share2, Sheet, Square, X } from 'lucide';
import type { Routine } from '../../shared/routine';
import { createCueTemplateBlob, planSongImport, readCueWorkbook, type CueImportChange, type CueImportMode,
  type CueImportResult } from './cue-import';
import { createExcelBlob, createExportSnapshot, createPdfBlob, defaultExportColumns, defaultPdfColumns, downloadExport,
  exportColumns, exportFilename, pdfExportColumns, type ExportSnapshot } from './exports';
import { errorMessage, t, type MessageKey } from './i18n';
import { exportPalette, readPreferences, type ExportPalette } from './theme';
import { element, field, iconButton, setButtonIcon, transientText } from './ui';
import { XLSX_MAX_BYTES } from './xlsx-read';

interface CueImportTarget { editable: boolean; apply: (changes: readonly CueImportChange[]) => void }
interface ExportPanelState { routine: Routine; unsaved: boolean; busy: boolean; cueImport?: CueImportTarget }
interface ExportActions {
  excel: (snapshot: ExportSnapshot, selected: readonly string[], palette: ExportPalette) => Promise<Blob>;
  pdf: (snapshot: ExportSnapshot, selected: readonly string[], palette: ExportPalette) => Promise<Blob>;
  download: (blob: Blob, filename: string) => void;
  cueTemplate?: (routine: Routine) => Promise<Blob>;
  readCues?: (bytes: Uint8Array, routine: Routine) => CueImportResult;
}

const cueImportErrors: Record<string, MessageKey> = {
  cue_import_not_xlsx: 'cueImportNotXlsx', cue_import_too_large: 'cueImportTooLarge',
  cue_import_not_template: 'cueImportNotTemplate', cue_import_no_songs: 'cueImportNoSongs',
};

export function createExportPanel(readState: () => ExportPanelState, actions: ExportActions = {
  excel: createExcelBlob, pdf: (snapshot, selected, palette) => createPdfBlob(snapshot, undefined, selected, palette), download: downloadExport,
}) {
  const root = element('details', 'export-section command-menu');
  root.open = false;
  const trigger = element('summary', 'button icon-button');
  trigger.title = t('share'); trigger.setAttribute('aria-label', t('share'));
  setButtonIcon(trigger, Share2);
  trigger.append(element('span', 'visually-hidden', t('share')));
  root.append(trigger);
  const snapshotLabel = element('p', 'muted export-snapshot');
  const downloads = element('div', 'command-menu-items');
  const refreshers: (() => void)[] = [];
  const cancelers: (() => void)[] = [];
  let disposed = false;
  const outside = (event: Event) => { if (event.target && !root.contains(event.target as Node)) root.open = false; };
  document.addEventListener('pointerdown', outside);
  trigger.addEventListener('click', event => { if (disposed || readState().busy) event.preventDefault(); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !(event.target as HTMLElement).closest('dialog')) {
      event.preventDefault(); root.open = false; trigger.focus({ preventScroll: true });
    }
  });
  for (const format of ['xlsx', 'pdf'] as const) {
    const label = t(format === 'xlsx' ? 'exportExcel' : 'exportPdf');
    const availableColumns = format === 'xlsx' ? exportColumns : pdfExportColumns();
    const defaults = () => format === 'xlsx' ? defaultExportColumns() : defaultPdfColumns();
    const selected = new Set(defaults());
    const choices = new Map<string, HTMLInputElement>();
    const dialog = element('dialog', 'export-dialog');
    dialog.setAttribute('aria-labelledby', `export-${format}-title`);
    const heading = element('h2', '', label);
    heading.id = `export-${format}-title`;
    const filename = element('input');
    filename.type = 'text'; filename.maxLength = 200;
    const feedback = element('p', 'export-feedback');
    feedback.setAttribute('role', 'status');
    const errors = transientText(feedback);
    const noColumns = element('p', 'export-error', t('exportNoColumns'));
    const columnErrors = transientText(noColumns);
    noColumns.setAttribute('role', 'status');
    const count = element('output', 'muted export-column-count');
    const groups = element('div', 'export-column-groups');
    const walkInBox = element('input'); walkInBox.type = 'checkbox'; walkInBox.checked = true;
    const walkOutBox = element('input'); walkOutBox.type = 'checkbox'; walkOutBox.checked = true;
    const walkChoices = element('div', 'action-row export-walk-options');
    const walkInLabel = element('label', 'export-column'); walkInLabel.append(walkInBox, element('span', '', t('exportIncludeWalkIn')));
    const walkOutLabel = element('label', 'export-column'); walkOutLabel.append(walkOutBox, element('span', '', t('exportIncludeWalkOut')));
    walkChoices.append(walkInLabel, walkOutLabel);
    let pending = false;
    let generation = 0;
    const close = (restoreFocus = true) => {
      generation += 1; pending = false;
      errors.dismiss(); columnErrors.dismiss();
      if (dialog.open) dialog.close();
      syncAvailability();
      if (restoreFocus && !disposed && command.isConnected) command.focus({ preventScroll: true });
    };
    const select = (ids: readonly string[]) => {
      selected.clear(); for (const id of ids) selected.add(id);
      for (const [id, checkbox] of choices) checkbox.checked = selected.has(id);
      sync();
    };
    const all = iconButton(t('exportAll'), CheckCheck, () => select(availableColumns.map(column => column.id)), true);
    const none = iconButton(t('exportNone'), Square, () => select([]), true);
    const reset = iconButton(t('exportDefaults'), RotateCcw, () => select(defaults()), true);
    const selectionActions = element('div', 'action-row');
    selectionActions.append(all, none, reset);
    for (const group of new Set(availableColumns.map(column => column.group))) {
      const fields = element('fieldset', 'export-column-group');
      fields.append(element('legend', '', t(group)));
      for (const column of availableColumns.filter(item => item.group === group)) {
        const checkbox = element('input');
        checkbox.type = 'checkbox'; checkbox.checked = selected.has(column.id); checkbox.name = column.id;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.add(column.id); else selected.delete(column.id);
          sync();
        });
        choices.set(column.id, checkbox);
        const choice = element('label', 'export-column');
        choice.append(checkbox, element('span', '', t(column.label)));
        fields.append(choice);
      }
      groups.append(fields);
    }
    const run = async () => {
      const state = readState();
      if (disposed || pending || state.busy || !selected.size || !dialog.open) return;
      const operation = ++generation;
      pending = true; errors.show(t('exportWorking'), false); feedback.setAttribute('role', 'status'); sync();
      cancel.focus({ preventScroll: true });
      try {
        const snapshot = createExportSnapshot(state.routine, state.unsaved, new Date(),
          { walkIn: walkInBox.checked, walkOut: walkOutBox.checked });
        const name = exportFilename(filename.value, format);
        const fields = [...selected];
        const palette = exportPalette(readPreferences());
        const blob = await (format === 'xlsx' ? actions.excel(snapshot, fields, palette) : actions.pdf(snapshot, fields, palette));
        if (disposed || generation !== operation || !dialog.open) return;
        actions.download(blob, name); close();
      } catch (error) {
        if (generation === operation) { feedback.setAttribute('role', 'alert'); errors.show(errorMessage(error)); }
      } finally { if (generation === operation) { pending = false; sync(); } }
    };
    const cancel = iconButton(t('cancel'), X, () => close(), true);
    const download = iconButton(t('exportDownload'), Download, () => { void run(); }, true);
    const commands = element('div', 'action-row export-dialog-actions');
    commands.append(cancel, download);
    const command = iconButton(label, format === 'xlsx' ? Sheet : FileText, () => {
      if (disposed || readState().busy) return;
      filename.value = exportFilename(readState().routine.name, format);
      errors.dismiss(); sync(); dialog.showModal(); filename.focus();
    }, true);
    command.setAttribute('aria-haspopup', 'dialog');
    const sync = () => {
      command.disabled = disposed || readState().busy || pending;
      download.disabled = disposed || readState().busy || pending || selected.size === 0;
      download.setAttribute('aria-busy', String(pending));
      for (const control of [filename, all, none, reset, walkInBox, walkOutBox, ...choices.values()]) control.disabled = pending;
      columnErrors.refresh(selected.size === 0 ? t('exportNoColumns') : '');
      count.textContent = t('exportSelection', { selected: selected.size, total: availableColumns.length });
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [filename, all, none, reset, walkInBox, walkOutBox, ...choices.values(), cancel, download].filter(control => !control.disabled);
      const index = controls.findIndex(control => control === document.activeElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    });
    dialog.append(heading, field(t('exportFilename'), filename), walkChoices, selectionActions, groups, count, noColumns, feedback, commands);
    downloads.append(command); root.append(dialog); refreshers.push(sync);
    cancelers.push(() => { close(false); errors.dispose(); columnErrors.dispose(); });
  }
  root.append(downloads);
  const cueImport = createCueImport();
  downloads.append(cueImport.templateCommand, cueImport.importCommand, cueImport.menuStatus);
  root.append(cueImport.fileInput, cueImport.dialog);
  refreshers.push(cueImport.sync);
  cancelers.push(cueImport.dispose);
  const syncAvailability = () => {
    const state = readState();
    trigger.setAttribute('aria-disabled', String(disposed || state.busy));
    if (disposed || state.busy) root.open = false;
    snapshotLabel.textContent = t('exportSnapshot', { name: state.routine.name, revision: state.routine.revision,
      status: t(state.unsaved ? 'exportUnsaved' : 'exportSaved') });
    for (const refresh of refreshers) refresh();
  };
  syncAvailability();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('pointerdown', outside);
    for (const cancel of cancelers) cancel();
  };
  return { element: root, syncAvailability, dispose };

  function createCueImport() {
    const menuStatus = element('p', 'export-feedback');
    menuStatus.setAttribute('role', 'alert');
    menuStatus.hidden = true;
    const menuErrors = transientText(menuStatus);
    let templatePending = false;
    const templateCommand = iconButton(t('cueTemplateDownload'), FileDown, () => { void downloadTemplate(); }, true);
    const downloadTemplate = async () => {
      const state = readState();
      if (disposed || state.busy || templatePending || !state.routine.tracks.length) return;
      templatePending = true; menuErrors.dismiss(); sync();
      try {
        const routine = structuredClone(state.routine);
        const blob = await (actions.cueTemplate ?? createCueTemplateBlob)(routine);
        if (disposed) return;
        actions.download(blob, exportFilename(t('cueTemplateFilename', { name: routine.name }), 'xlsx'));
        root.open = false;
      } catch (error) { if (!disposed) menuErrors.show(errorMessage(error)); }
      finally { templatePending = false; sync(); }
    };

    const fileInput = element('input', 'visually-hidden');
    fileInput.type = 'file';
    fileInput.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    fileInput.tabIndex = -1;
    fileInput.setAttribute('aria-hidden', 'true');
    const importAvailable = () => { const state = readState(); return !disposed && !state.busy && state.cueImport?.editable === true; };
    const importCommand = iconButton(t('cueImportOpen'), FileUp, () => {
      if (!importAvailable()) return;
      fileInput.value = ''; fileInput.click();
    }, true);
    importCommand.setAttribute('aria-haspopup', 'dialog');

    const dialog = element('dialog', 'export-dialog cue-import-dialog');
    dialog.setAttribute('aria-labelledby', 'cue-import-title');
    const heading = element('h2', '', t('cueImportTitle'));
    heading.id = 'cue-import-title';
    const feedback = element('p', 'export-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const status = transientText(feedback);
    const body = element('div', 'cue-import-body');
    let generation = 0;
    let review: { routine: Routine; result: CueImportResult; modes: Map<string, CueImportMode> } | null = null;
    const close = () => {
      generation += 1; review = null; status.dismiss(); body.replaceChildren();
      if (dialog.open) dialog.close();
      sync();
      if (!disposed && importCommand.isConnected) importCommand.focus({ preventScroll: true });
    };
    const cancel = iconButton(t('cancel'), X, () => close(), true);
    const apply = iconButton(t('cueImportApply'), Check, () => applyReview(), true);
    const commands = element('div', 'action-row export-dialog-actions');
    commands.append(cancel, apply);
    dialog.append(heading, feedback, body, commands);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });

    const fail = (error: unknown) => {
      const code = error instanceof Error ? error.message : '';
      feedback.setAttribute('role', 'alert');
      status.show(cueImportErrors[code] ? t(cueImportErrors[code]) : errorMessage(error));
    };
    const open = async (file: File) => {
      if (!importAvailable()) return;
      const operation = ++generation;
      review = null; body.replaceChildren(); apply.disabled = true;
      feedback.setAttribute('role', 'status'); status.show(t('cueImportReading'), false);
      if (!dialog.open) dialog.showModal();
      try {
        if (file.size > XLSX_MAX_BYTES) throw new Error('cue_import_too_large');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (operation !== generation || !dialog.open) return;
        const routine = readState().routine;
        const result = (actions.readCues ?? readCueWorkbook)(bytes, routine);
        status.dismiss();
        render(routine, result);
      } catch (error) { if (operation === generation) fail(error); }
    };
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) void open(file);
    });

    const render = (routine: Routine, result: CueImportResult) => {
      body.replaceChildren();
      if (result.issues.length) {
        const list = element('ul', 'cue-import-issues');
        for (const issue of result.issues) {
          list.append(element('li', '', issue.row === undefined
            ? t('cueImportSheetError', { sheet: issue.sheet, message: issue.message })
            : t('cueImportRowError', { sheet: issue.sheet, row: issue.row, message: issue.message })));
        }
        body.append(element('p', 'export-error', t('cueImportRowsTitle')), list);
      } else {
        const modes = new Map<string, CueImportMode>();
        for (const song of result.songs) {
          const track = routine.tracks.find(item => item.id === song.trackId);
          if (!track) continue;
          modes.set(song.trackId, 'replace');
          const group = element('fieldset', 'export-column-group cue-import-song');
          group.append(element('legend', '', song.heading),
            element('p', 'muted', t('cueImportSongSummary', { rows: song.cues.length, existing: track.cues.length })));
          const choice = element('select');
          choice.setAttribute('aria-label', t('cueImportMode', { song: song.heading }));
          for (const [mode, label] of [['replace', 'cueImportReplace'], ['add', 'cueImportAdd'], ['skip', 'cueImportSkip']] as const) {
            const option = element('option', '', t(label));
            option.value = mode;
            choice.append(option);
          }
          choice.value = 'replace';
          const warning = element('p', 'cue-import-warning');
          const update = () => {
            const mode = choice.value as CueImportMode;
            modes.set(song.trackId, mode);
            const plan = planSongImport(track, song, mode, () => '');
            warning.textContent = plan.overLimit ? t('cueImportOverLimit')
              : plan.removedAll ? t('cueImportReplaceClears', { count: plan.removedAll })
                : plan.removedOther ? t('cueImportReplaceWarning', { count: plan.removedOther })
                  : plan.duplicates ? t('cueImportAddDuplicates', { count: plan.duplicates }) : '';
            warning.hidden = !warning.textContent;
            syncApply();
          };
          choice.addEventListener('change', update);
          group.append(choice, warning);
          body.append(group);
          review = { routine, result, modes };
          update();
        }
      }
      if (result.ignored.length) body.append(element('p', 'muted', t('cueImportIgnoredTabs', { tabs: result.ignored.join(', ') })));
      syncApply();
      (body.querySelector('select') ?? cancel).focus({ preventScroll: true });
    };

    const plans = () => {
      const state = readState();
      if (!review || state.routine !== review.routine) return null;
      const changes: CueImportChange[] = [];
      for (const song of review.result.songs) {
        const mode = review.modes.get(song.trackId) ?? 'skip';
        const track = state.routine.tracks.find(item => item.id === song.trackId);
        if (!track || track.duration !== song.duration) return null;
        const plan = planSongImport(track, song, mode);
        if (plan.overLimit) return [];
        if (plan.cues) changes.push({ trackId: song.trackId, cues: plan.cues });
      }
      return changes;
    };
    const syncApply = () => {
      const current = review;
      apply.disabled = !current || !importAvailable() || current.result.songs.some(song => {
        const mode = current.modes.get(song.trackId) ?? 'skip';
        const track = current.routine.tracks.find(item => item.id === song.trackId);
        return mode !== 'skip' && (!track || planSongImport(track, song, mode, () => '').overLimit);
      });
    };
    const applyReview = () => {
      const state = readState();
      if (!review || !importAvailable() || !state.cueImport) return;
      const changes = plans();
      if (changes === null) { review = null; body.replaceChildren(); apply.disabled = true; fail(new Error(t('cueImportStale'))); return; }
      if (!changes.length) { feedback.setAttribute('role', 'status'); status.show(t('cueImportNothing')); return; }
      state.cueImport.apply(changes);
      close();
    };

    const sync = () => {
      const state = readState();
      templateCommand.disabled = disposed || state.busy || templatePending || !state.routine.tracks.length;
      templateCommand.setAttribute('aria-busy', String(templatePending));
      importCommand.disabled = !importAvailable();
      if (dialog.open && review) syncApply();
    };
    const dispose = () => {
      generation += 1; review = null;
      if (dialog.open) dialog.close();
      status.dispose(); menuErrors.dispose();
    };
    return { templateCommand, importCommand, menuStatus, fileInput, dialog, sync, dispose };
  }
}