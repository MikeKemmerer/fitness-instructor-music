import { CheckCheck, Download, FileText, RotateCcw, Share2, Sheet, Square, X } from 'lucide';
import type { Routine } from '../../shared/routine';
import { createExcelBlob, createExportSnapshot, createPdfBlob, defaultExportColumns, defaultPdfColumns, downloadExport,
  exportColumns, exportFilename, pdfExportColumns, type ExportSnapshot } from './exports';
import { errorMessage, t } from './i18n';
import { element, field, iconButton, setButtonIcon, transientText } from './ui';

interface ExportPanelState { routine: Routine; unsaved: boolean; busy: boolean }
interface ExportActions {
  excel: (snapshot: ExportSnapshot, selected: readonly string[]) => Promise<Blob>;
  pdf: (snapshot: ExportSnapshot, selected: readonly string[]) => Promise<Blob>;
  download: (blob: Blob, filename: string) => void;
}

export function createExportPanel(readState: () => ExportPanelState, actions: ExportActions = {
  excel: createExcelBlob, pdf: (snapshot, selected) => createPdfBlob(snapshot, undefined, selected), download: downloadExport,
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
        const blob = await (format === 'xlsx' ? actions.excel(snapshot, fields) : actions.pdf(snapshot, fields));
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
}