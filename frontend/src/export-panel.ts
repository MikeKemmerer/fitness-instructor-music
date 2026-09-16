import { CheckCheck, Download, FileText, RotateCcw, Sheet, Square, X } from 'lucide';
import type { Routine } from '../../shared/routine';
import { createExcelBlob, createExportSnapshot, createPdfBlob, defaultExportColumns, defaultPdfColumns, downloadExport,
  exportColumns, exportFilename, type ExportSnapshot } from './exports';
import { errorMessage, t } from './i18n';
import { element, field, iconButton } from './ui';

interface ExportPanelState { routine: Routine; unsaved: boolean; busy: boolean }
interface ExportActions {
  excel: (snapshot: ExportSnapshot, selected: readonly string[]) => Promise<Blob>;
  pdf: (snapshot: ExportSnapshot, selected: readonly string[]) => Promise<Blob>;
  download: (blob: Blob, filename: string) => void;
}

export function createExportPanel(readState: () => ExportPanelState, actions: ExportActions = {
  excel: createExcelBlob, pdf: (snapshot, selected) => createPdfBlob(snapshot, undefined, selected), download: downloadExport,
}) {
  const root = element('details', 'export-section');
  root.open = false;
  root.append(element('summary', '', t('exportRoutine')));
  const snapshotLabel = element('p', 'muted export-snapshot');
  const downloads = element('div', 'action-row');
  const refreshers: (() => void)[] = [];
  const cancelers: (() => void)[] = [];
  let disposed = false;
  for (const format of ['xlsx', 'pdf'] as const) {
    const label = t(format === 'xlsx' ? 'exportExcel' : 'exportPdf');
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
    const noColumns = element('p', 'export-error', t('exportNoColumns'));
    noColumns.setAttribute('role', 'status');
    const count = element('output', 'muted export-column-count');
    const groups = element('div', 'export-column-groups');
    let pending = false;
    let generation = 0;
    const close = (restoreFocus = true) => {
      generation += 1; pending = false;
      if (dialog.open) dialog.close();
      syncAvailability();
      if (restoreFocus && !disposed && command.isConnected) command.focus({ preventScroll: true });
    };
    const select = (ids: readonly string[]) => {
      selected.clear(); for (const id of ids) selected.add(id);
      for (const [id, checkbox] of choices) checkbox.checked = selected.has(id);
      sync();
    };
    const all = iconButton(t('exportAll'), CheckCheck, () => select(exportColumns.map(column => column.id)), true);
    const none = iconButton(t('exportNone'), Square, () => select([]), true);
    const reset = iconButton(t('exportDefaults'), RotateCcw, () => select(defaults()), true);
    const selectionActions = element('div', 'action-row');
    selectionActions.append(all, none, reset);
    for (const group of new Set(exportColumns.map(column => column.group))) {
      const fields = element('fieldset', 'export-column-group');
      fields.append(element('legend', '', t(group)));
      for (const column of exportColumns.filter(item => item.group === group)) {
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
      pending = true; feedback.textContent = t('exportWorking'); feedback.setAttribute('role', 'status'); sync();
      cancel.focus({ preventScroll: true });
      try {
        const snapshot = createExportSnapshot(state.routine, state.unsaved);
        const name = exportFilename(filename.value, format);
        const fields = [...selected];
        const blob = await (format === 'xlsx' ? actions.excel(snapshot, fields) : actions.pdf(snapshot, fields));
        if (disposed || generation !== operation || !dialog.open) return;
        actions.download(blob, name); close();
      } catch (error) {
        if (generation === operation) { feedback.setAttribute('role', 'alert'); feedback.textContent = errorMessage(error); }
      } finally { if (generation === operation) { pending = false; sync(); } }
    };
    const cancel = iconButton(t('cancel'), X, () => close(), true);
    const download = iconButton(t('exportDownload'), Download, () => { void run(); }, true);
    const commands = element('div', 'action-row export-dialog-actions');
    commands.append(cancel, download);
    const command = iconButton(label, format === 'xlsx' ? Sheet : FileText, () => {
      if (disposed || readState().busy) return;
      filename.value = exportFilename(readState().routine.name, format);
      feedback.textContent = ''; sync(); dialog.showModal(); filename.focus();
    }, true);
    command.setAttribute('aria-haspopup', 'dialog');
    const sync = () => {
      command.disabled = disposed || readState().busy || pending;
      download.disabled = disposed || readState().busy || pending || selected.size === 0;
      download.setAttribute('aria-busy', String(pending));
      for (const control of [filename, all, none, reset, ...choices.values()]) control.disabled = pending;
      noColumns.hidden = selected.size !== 0;
      count.textContent = t('exportSelection', { selected: selected.size, total: exportColumns.length });
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [filename, all, none, reset, ...choices.values(), cancel, download].filter(control => !control.disabled);
      const index = controls.findIndex(control => control === document.activeElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    });
    dialog.append(heading, field(t('exportFilename'), filename), selectionActions, groups, count, noColumns, feedback, commands);
    downloads.append(command); root.append(dialog); refreshers.push(sync);
    cancelers.push(() => close(false));
  }
  root.append(snapshotLabel, downloads);
  const syncAvailability = () => {
    const state = readState();
    snapshotLabel.textContent = t('exportSnapshot', { name: state.routine.name, revision: state.routine.revision,
      status: t(state.unsaved ? 'exportUnsaved' : 'exportSaved') });
    for (const refresh of refreshers) refresh();
  };
  syncAvailability();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cancel of cancelers) cancel();
  };
  return { element: root, syncAvailability, dispose };
}