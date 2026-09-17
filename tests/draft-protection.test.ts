import { describe, expect, it, vi } from 'vitest';
import { createDraftProtection, createEditHistory } from '../frontend/src/draft-protection';
import { newRoutine } from '../shared/routine';
import { newMusicPlaylist } from '../shared/class-plan';

const persistence = vi.hoisted(() => ({ saveDraftRecovery: vi.fn(async () => {}), removeDraftRecovery: vi.fn(async () => {}), listDraftRecoveries: vi.fn(async () => []) }));
vi.mock('../frontend/src/offline', () => persistence);
vi.mock('../frontend/src/ui', () => {
  const node = () => ({ textContent: '', disabled: false, children: [] as unknown[], append(...children: unknown[]) { this.children.push(...children); }, setAttribute() {} });
  return { element: node, iconButton: (_label: string, _icon: unknown, action: () => void) => ({ ...node(), click() { if (!this.disabled) action(); } }) };
});

describe('local edit history', () => {
  it('restores media and incomplete phase choices with the visible buttons across a local-to-cloud save', () => {
    vi.stubGlobal('document', new EventTarget()); vi.stubGlobal('window', new EventTarget());
    let routine = newRoutine();
    let media = {};
    let editorState = { walkIn: false };
    let source: 'local' | 'household' = 'local';
    const controller = createDraftProtection({ editable: () => true, apply(value, attachments) {
      routine = value as typeof routine; media = attachments.media;
      editorState = attachments.editorState as typeof editorState; observe(true);
    } });
    const observe = (dirty: boolean) => controller.observe({ kind: 'routine', source, value: routine, baseRevision: routine.revision, media }, dirty, false, editorState);
    const [undo, redo] = Array.from(controller.element.children) as HTMLButtonElement[];
    try {
      observe(false);
      editorState = { walkIn: true }; media = { retained: { id: 'immutable' } }; observe(true);
      source = 'household'; routine.revision = 7; routine.savedAt = 1234; observe(false);
      undo.click(); expect(editorState.walkIn).toBe(false); expect(media).toEqual({});
      expect(routine.revision).toBe(7); expect(routine.savedAt).toBe(1234);
      redo.click(); expect(editorState.walkIn).toBe(true); expect(media).toEqual({ retained: { id: 'immutable' } });
      expect(routine.savedAt).toBe(1234);
    } finally { controller.dispose(); vi.unstubAllGlobals(); }
  });

  it('enables real undo and redo actions after the first edit and a busy save cycle', () => {
    vi.stubGlobal('document', new EventTarget()); vi.stubGlobal('window', new EventTarget());
    let busy = false;
    let routine = newRoutine();
    const original = routine.name;
    const controller = createDraftProtection({ editable: () => !busy, apply(value) {
      routine = value as typeof routine;
      observe(true);
    } });
    const observe = (dirty: boolean) => controller.observe({ kind: 'routine', source: 'local', value: routine, baseRevision: routine.revision, media: {} }, dirty);
    const [undo, redo] = Array.from(controller.element.children) as HTMLButtonElement[];
    try {
      observe(false);
      expect(undo.disabled).toBe(true); expect(redo.disabled).toBe(true);
      routine.name = 'Edited routine'; observe(true);
      expect(undo.disabled).toBe(false);
      busy = true; controller.sync(); expect(undo.disabled).toBe(true);
      routine.revision = 2; observe(false);
      busy = false; controller.sync(); expect(undo.disabled).toBe(false);
      undo.click(); expect(routine.name).toBe(original); expect(routine.revision).toBe(2);
      expect(redo.disabled).toBe(false);
      redo.click(); expect(routine.name).toBe('Edited routine'); expect(routine.revision).toBe(2);
    } finally { controller.dispose(); vi.unstubAllGlobals(); }
  });

  it('does not mark newer typing protected when an older recovery write finishes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', new EventTarget()); vi.stubGlobal('window', new EventTarget());
    let finish!: () => void;
    persistence.saveDraftRecovery.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const controller = createDraftProtection({ editable: () => true, apply: () => {} });
    try {
      const value = { kind: 'routine' as const, source: 'local' as const, value: newRoutine(), baseRevision: null, media: {} };
      controller.observe(value, true);
      await Promise.resolve();
      controller.observe({ ...value, value: { ...value.value, name: 'Newer edit' } }, true, true);
      finish(); await vi.advanceTimersByTimeAsync(0);
      const status = controller.element.children[2];
      expect(status.textContent).toBe('Saving recovery copy...');
      await vi.advanceTimersByTimeAsync(400);
      expect(status.textContent).toBe('Recovery up to date on this device');
    } finally { controller.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it('groups typing and restores content without rewinding a saved revision', () => {
    const history = createEditHistory();
    const routine = newRoutine(); const original = routine.name;
    history.reset(routine);
    routine.name = 'First'; history.observe(routine, true, 1000);
    routine.name = 'Second'; history.observe(routine, true, 1100);
    routine.revision = 8; history.observe(routine);
    const undone = history.move(routine, 'undo')!;
    expect(undone.name).toBe(original); expect(undone.revision).toBe(8);
    expect(history.move(undone, 'redo')?.name).toBe('Second');
  });
  it('retains media through import undo and invalidates redo on a new edit', () => {
    const history = createEditHistory(); const playlist = newMusicPlaylist(); history.reset(playlist);
    playlist.tracks.push({ id: 'entry', title: 'Audio', duration: 10, bpm: 100, firstBeat: 0, bodyArea: '', cues: [] });
    history.observe(playlist);
    const undone = history.move(playlist, 'undo')!;
    expect('tracks' in undone && undone.tracks).toEqual([]);
    expect(playlist.tracks[0].id).toBe('entry');
    history.observe({ ...undone, name: 'Different' }); expect(history.canRedo).toBe(false);
  });
  it('blocks locked and published edits and resets when the entity changes', () => {
    const history = createEditHistory(); const routine = newRoutine(); history.reset(routine);
    history.observe({ ...routine, name: 'Edited' });
    expect(history.move({ ...routine, locked: true }, 'undo')).toBeNull();
    expect(history.move({ ...routine, published: true }, 'undo')).toBeNull();
    history.observe(newRoutine()); expect(history.canUndo).toBe(false);
  });
  it('bounds retained history to fifty content edits', () => {
    const history = createEditHistory(); let value = newRoutine(); history.reset(value);
    for (let index = 0; index < 60; index++) { value = { ...value, name: String(index) }; history.observe(value); }
    let count = 0;
    while (history.canUndo) { value = history.move(value, 'undo') as typeof value; count++; }
    expect(count).toBe(50);
  });
});