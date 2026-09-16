import { Copy, Redo2, RefreshCw, Trash2, Undo2 } from 'lucide';
import type { DraftRecovery } from './offline';
import { listDraftRecoveries, removeDraftRecovery, saveDraftRecovery } from './offline';
import { element, iconButton } from './ui';
import { t } from './i18n';

type Content = DraftRecovery['value'];
const content = (value: Content) => JSON.stringify({ ...value, id: '', revision: 0, locked: false, published: false });
const bytes = (values: Content[]) => new TextEncoder().encode(JSON.stringify(values)).byteLength;

export function createEditHistory() {
  let current: Content | null = null;
  let past: Content[] = [];
  let future: Content[] = [];
  let lastEdit = 0;
  return {
    reset(value: Content) { current = structuredClone(value); past = []; future = []; lastEdit = 0; },
    observe(value: Content, grouped = false, now = Date.now()) {
      if (!current || current.id !== value.id) { this.reset(value); return; }
      if (content(value) !== content(current)) {
        if (!grouped || now - lastEdit > 700 || !past.length) past.push(current);
        while (past.length > 50 || bytes(past) > 1024 * 1024) past.shift();
        future = [];
        lastEdit = grouped ? now : 0;
      }
      current = structuredClone(value);
    },
    move(value: Content, direction: 'undo' | 'redo'): Content | null {
      if (!current || current.id !== value.id || value.locked || value.published) return null;
      const from = direction === 'undo' ? past : future;
      const target = from.pop();
      if (!target) return null;
      (direction === 'undo' ? future : past).push(structuredClone(value));
      const retained = direction === 'undo' ? future : past;
      while (retained.length > 50 || bytes(retained) > 1024 * 1024) retained.shift();
      current = { ...structuredClone(target), id: value.id, revision: value.revision, locked: value.locked, published: value.published };
      lastEdit = 0;
      return structuredClone(current);
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
  };
}

export function createDraftProtection(options: {
  editable(): boolean;
  apply(value: Content): void;
}) {
  const history = createEditHistory();
  const writer = crypto.randomUUID();
  const root = element('div', 'action-row draft-protection');
  const status = element('span', 'muted'); status.setAttribute('role', 'status');
  let selected: Omit<DraftRecovery, 'id' | 'updatedAt'> | null = null;
  let key = '';
  let previousState = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: DraftRecovery | null = null;
  let queue = Promise.resolve();
  let disposed = false;
  let change = 0;
  const enqueue = (work: () => Promise<void>) => {
    const generation = change;
    queue = queue.then(work).then(() => { if (!disposed && generation === change) status.textContent = t('recoverySaved'); })
      .catch(() => { if (!disposed && generation === change) status.textContent = t('recoveryFailed'); });
  };
  const flush = () => {
    clearTimeout(timer);
    if (!pending || disposed) return;
    const record = pending; pending = null;
    enqueue(() => saveDraftRecovery(record));
  };
  const move = (direction: 'undo' | 'redo') => {
    if (!selected || !options.editable()) return;
    const value = history.move(selected.value, direction);
    if (value) options.apply(value);
    sync();
  };
  const undo = iconButton(t('undoEdit'), Undo2, () => move('undo'));
  const redo = iconButton(t('redoEdit'), Redo2, () => move('redo'));
  root.append(undo, redo, status);
  function sync() {
    undo.disabled = !options.editable() || !history.canUndo;
    redo.disabled = !options.editable() || !history.canRedo;
  }
  const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', flush);
  return {
    element: root, sync, flush,
    observe(value: Omit<DraftRecovery, 'id' | 'updatedAt'>, dirty: boolean, grouped = false) {
      if (disposed) return;
      const nextKey = `${writer}:${value.source}:${value.kind}:${value.value.id}`;
      if (key !== nextKey) { flush(); history.reset(value.value); key = nextKey; previousState = ''; }
      history.observe(value.value, grouped);
      selected = structuredClone(value);
      const state = JSON.stringify([dirty, value]);
      if (state !== previousState) {
        change++;
        previousState = state;
        clearTimeout(timer); pending = null;
        if (dirty && !value.value.locked && !value.value.published) {
          pending = { ...structuredClone(value), id: key, updatedAt: Date.now() };
          status.textContent = t('recoverySaving');
          if (grouped) timer = setTimeout(flush, 400); else flush();
        } else if (!dirty) {
          const savedKey = key;
          enqueue(() => removeDraftRecovery(savedKey));
        }
      }
      sync();
    },
    dispose() { disposed = true; clearTimeout(timer); pending = null; document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flush); },
  };
}

export function createRecoveryPanel(options: {
  allowed(): boolean;
  restore(record: DraftRecovery): Promise<void>;
  message(message: string, error?: boolean): void;
}) {
  const root = element('details', 'recovery-library');
  root.append(element('summary', '', t('recoveries')));
  const rows = element('div');
  let generation = 0;
  let disposed = false;
  async function refresh() {
    if (!options.allowed() || disposed) return;
    const request = ++generation;
    try {
      const records = await listDraftRecoveries();
      if (disposed || request !== generation || !options.allowed()) return;
      rows.replaceChildren();
      for (const record of records) {
        const row = element('div', 'routine-library-row');
        row.append(element('span', '', `${record.value.name} / ${record.source} / ${new Date(record.updatedAt).toLocaleString()}`));
        const restore = iconButton(t('restoreCopy'), Copy, () => {
          if (!options.allowed() || disposed) return;
          restore.disabled = true;
          void options.restore(structuredClone(record)).catch(() => options.message(t('recoveryFailed'), true))
            .finally(() => { restore.disabled = false; });
        }, true);
        const discard = iconButton(t('discardRecovery'), Trash2, () => {
          if (!options.allowed() || disposed || !confirm(t('confirmDelete', { name: record.value.name }))) return;
          void removeDraftRecovery(record.id, record.updatedAt).then(refresh).catch(() => options.message(t('recoveryFailed'), true));
        });
        row.append(restore, discard); rows.append(row);
      }
      if (!records.length) rows.append(element('p', 'muted', t('recoveryEmpty')));
    } catch { if (!disposed) options.message(t('recoveryFailed'), true); }
  }
  root.append(iconButton(t('refreshRecoveries'), RefreshCw, () => { void refresh(); }), rows);
  root.addEventListener('toggle', () => { if (root.open) void refresh(); });
  return { element: root, refresh, dispose() { disposed = true; generation++; } };
}