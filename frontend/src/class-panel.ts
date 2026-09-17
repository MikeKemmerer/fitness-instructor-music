import { ArrowDown, ArrowUp, Check, Copy, Download, LockKeyhole, Plus, RefreshCw, Save, Send, Trash2, UnlockKeyhole } from 'lucide';
import { newMusicPlaylist, type ClassSetup, type CloudMusicPlaylist, type MusicPlaylist, type RevisionReference } from '../../shared/class-plan';
import { newRoutine, type AudioAsset, type Filler, type FillerRecording, type Routine, type Track } from '../../shared/routine';
import { createClassLibrary, type ClassSelection, type LibraryAction } from './class-library';
import { captureCloudIdentity, getCloudContext, getCloudRole } from './cloud-client';
import type { AudioPreview } from '../../shared/preview-contract';
import { cloudErrorMessage } from './cloud-ui';
import { cloudHash, createCloudLibrary } from './cloud-library';
import * as offline from './offline';
import { fillerControls } from './filler-controls';
import { createDraftProtection } from './draft-protection';
import { createAudioLibraryPicker } from './audio-library-picker';
import { t } from './i18n';
import { element, field, gainSlider, iconButton, numberInput, selectInput, textInput } from './ui';

export interface ClassPanelContext {
  hosted: boolean;
  draft(): Routine;
  busy(): boolean;
  recordings(): FillerRecording[];
  preview?: AudioPreview;
  beforePreview?(): void;
  routineMedia?(): Record<string, AudioAsset>;
  currentSelection?(): ClassSelection | null;
  selected(value: ClassSelection | null): void;
  message(message: string, error?: boolean): void;
}

export function createClassPanel(context: ClassPanelContext) {
  const root = element('details', 'class-library');
  root.append(element('summary', '', t('musicPlaylists')));
  const content = element('div', 'class-library-content');
  root.append(content);
  const media = createCloudLibrary();
  const library = createClassLibrary(undefined, media);
  let source: 'local' | 'household' = context.hosted ? 'household' : 'local';
  let published = context.hosted && getCloudRole() === 'player';
  let playlists: MusicPlaylist[] = [];
  let classes: ClassSetup[] = [];
  let playlistReferences: MusicPlaylist[] = [];
  let routines: RevisionReference[] = [];
  let routineNames = new Map<string, string>();
  let playlist: MusicPlaylist | null = null;
  let envelope: CloudMusicPlaylist | null = null;
  let reusableMedia: Record<string, AudioAsset> = {};
  let setup: ClassSetup | null = null;
  let revision: number | null = null;
  let dirty = false;
  let busy = false;
  let disposed = false;
  let generation = 0;
  let controller: AbortController | null = null;
  const blockedButtons = new Map<HTMLButtonElement, boolean>();
  let pendingSave: HTMLButtonElement | null = null;
  let selectSetup: HTMLButtonElement | null = null;
  const author = () => !context.hosted || ['owner', 'editor'].includes(getCloudRole() ?? '');
  const available = () => !disposed && !busy && !context.busy();
  const editable = () => available() && author() && !(playlist ?? setup)?.locked && !(playlist ?? setup)?.published
    && (source === 'local' || getCloudContext().access === 'online');
  const protection = createDraftProtection({ editable, apply: (value, attachments) => {
    if ('routine' in value) setup = value;
    else if ('tracks' in value && !('filler' in value)) playlist = value;
    else return;
    reusableMedia = attachments.media; dirty = true; render();
  } });
  const protect = (grouped = false) => {
    const value = playlist ?? setup;
    if (value) protection.observe({ kind: playlist ? 'playlist' : 'class', source, value,
      baseRevision: revision, media: { ...envelope?.media, ...reusableMedia } }, dirty, grouped);
  };
  const changed = () => {
    dirty = true;
    protect(true);
    const value = playlist ?? setup;
    if (value && pendingSave) {
      const label = t('librarySave', { name: value.name, destination: t(source === 'household' ? 'householdDestination' : 'localDestination') });
      pendingSave.title = label; pendingSave.setAttribute('aria-label', label);
      const text = pendingSave.querySelector('span'); if (text) text.textContent = label;
    }
    if (selectSetup) selectSetup.disabled = true;
  };
  const picker = createAudioLibraryPicker({ library: media, hosted: context.hosted,
    preview: context.preview, beforePreview: context.beforePreview,
    available: () => editable() && !!playlist,
    identity: () => `${generation}:${JSON.stringify(playlist)}`,
    remaining: () => 100 - (playlist?.tracks.length ?? 0),
    known: () => [{ routine: { ...newRoutine(), tracks: playlist?.tracks ?? [] }, media: { ...envelope?.media, ...reusableMedia } },
      { routine: context.draft(), media: context.routineMedia?.() ?? {} }],
    added: (tracks, assets) => {
      if (!playlist || !editable()) return;
      playlist.tracks.push(...tracks); Object.assign(reusableMedia, assets); changed(); render();
    },
  });
  const discard = () => !dirty || confirm(t('confirmSwitch', { name: (playlist ?? setup)?.name ?? '' }));
  const run = async (work: (signal: AbortSignal, assert: () => void) => Promise<void>) => {
    if (!available()) return;
    busy = true;
    const epoch = ++generation;
    const active = new AbortController(); controller = active;
    let identity = () => {};
    const assert = () => { identity(); if (disposed || epoch !== generation || active.signal.aborted) throw new Error('cloud_cancelled'); };
    sync();
    try { identity = context.hosted ? captureCloudIdentity() : () => {}; assert(); await work(active.signal, assert); }
    catch (error) { if (!disposed) context.message(cloudErrorMessage(error), true); }
    finally { if (epoch === generation) { busy = false; controller = null; render(); } }
  };
  const refresh = async (signal: AbortSignal, assert: () => void) => {
    if (source === 'household') {
      if (getCloudContext().access !== 'online') {
        const selected = context.currentSelection?.();
        classes = selected?.source === 'household' ? [structuredClone(selected.setup)] : [];
        playlists = []; playlistReferences = []; routines = []; routineNames.clear();
        return;
      }
      playlists = await library.listPlaylists(published, { signal }); assert();
      classes = await library.listClasses(published, { signal }); assert();
      const values = await media.list(published, { signal }); assert();
      const otherPlaylists = author() ? await library.listPlaylists(!published, { signal }) : []; assert();
      const otherRoutines = author() ? await media.list(!published, { signal }) : []; assert();
      playlistReferences = [...playlists, ...otherPlaylists];
      routines = [...values, ...otherRoutines]; routineNames = new Map([...values, ...otherRoutines].map(value => [value.id, value.name]));
    } else {
      playlists = await offline.listMusicPlaylists(); assert();
      classes = await offline.listClassSetups(); assert();
      const values = await offline.listRoutines(); assert();
      const publicRoutines: Routine[] = [];
      const publicPlaylists: MusicPlaylist[] = [];
      const publicClasses: ClassSetup[] = [];
      for (const value of values) {
        const publication = await offline.getRoutine(value.id, value.revision, true); assert();
        if (publication?.published) publicRoutines.push(publication);
      }
      for (const value of playlists) {
        const publication = await offline.getMusicPlaylist(value.id, value.revision); assert();
        if (publication?.published) publicPlaylists.push(publication);
      }
      for (const value of classes) {
        const publication = await offline.getClassSetup(value.id, value.revision); assert();
        if (publication?.published) publicClasses.push(publication);
      }
      playlistReferences = [...playlists, ...publicPlaylists];
      routines = [...values, ...publicRoutines]; routineNames = new Map(values.map(value => [value.id, value.name]));
      if (published) { playlists = publicPlaylists; classes = publicClasses; }
    }
  };
  const identityText = (value: MusicPlaylist | ClassSetup) => t('savedRoutineOption', {
    name: value.name, revision: value.revision, lock: t(value.locked ? 'locked' : 'unlocked'),
  }) + ' / ' + t(value.published ? 'exportPublished' : 'draft');
  const referenceControl = (label: string, value: RevisionReference | undefined, choices: RevisionReference[],
    names: Map<string, string>, update: (reference: RevisionReference | undefined) => void, required = false) => {
    const row = element('div', 'reference-row');
    const options = [...choices];
    if (value && revision !== null && !options.some(item => item.id === value.id && item.revision === value.revision && item.published === value.published)) options.push(value);
    const key = (reference: RevisionReference) => JSON.stringify({ id: reference.id, revision: reference.revision, published: reference.published });
    const known = value && options.some(item => key(item) === key(value));
    const select = selectInput(known ? key(value) : '', [{ value: '', label: t(required ? 'cloudChoose' : 'none') },
      ...options.map(reference => ({ value: key(reference), label: `${names.get(reference.id) ?? reference.id} / ${t(reference.published ? 'exportPublished' : 'draft')}` }))], selected => {
      if (!editable()) return;
      const reference = options.find(item => key(item) === selected);
      update(reference ? { id: reference.id, revision: reference.revision, published: reference.published } : undefined);
      changed(); render();
    });
    select.required = required;
    if (required) select.querySelector('option')!.disabled = true;
    row.append(field(label, select));
    if (known) row.append(element('span', 'muted reference-revision', t('classSelected', {
      name: t(value.published ? 'exportPublished' : 'draft'), revision: value.revision,
    })));
    else if (required) row.append(element('span', 'muted reference-revision', t('saveRoutineFirst')));
    return row;
  };
  const save = (action: LibraryAction) => { void run(async (signal, assert) => {
    const value = playlist ?? setup;
    if (!value) return;
    if (content.querySelector('input[aria-invalid="true"]')) throw new Error('invalid_routine');
    if (!author()) throw new Error('forbidden');
    if (value.locked && !['unlock', 'duplicate'].includes(action)) throw new Error('routine_locked');
    if (value.published && action !== 'duplicate') throw new Error('cloud_head_required');
    if (action !== 'save' && revision === null) throw new Error(t('libraryDirty'));
    if (dirty && !['save', 'lock'].includes(action)) throw new Error(t('libraryDirty'));
    if (setup && revision === null && !routines.some(reference => reference.id === setup!.routine.id
      && reference.revision === setup!.routine.revision && reference.published === setup!.routine.published)) throw new Error(t('saveRoutineFirst'));
    const label = action === 'save' ? t('librarySave', { name: value.name, destination: t(source === 'household' ? 'householdDestination' : 'localDestination') })
      : t(({ publish: 'libraryPublish', lock: 'libraryLock', unlock: 'libraryUnlock', duplicate: 'libraryDuplicate', delete: 'libraryDelete' } as const)[action], { name: value.name });
    if ((source === 'household' || action !== 'save') && !confirm(t('confirmLibraryAction', { action: label }))) return;
    if (source === 'household') {
      if (playlist) { envelope = await library.savePlaylist(playlist, envelope, action, { signal }, reusableMedia); assert(); playlist = structuredClone(envelope.playlist); reusableMedia = {}; }
      else if (setup) { setup = await library.saveClass(setup, revision, action, { signal }); assert(); }
    } else {
      if (action === 'delete') {
        if (playlist) await offline.deleteMusicPlaylist(playlist.id, revision!);
        if (setup) await offline.deleteClassSetup(setup.id, revision!);
        assert();
      }
      if (action === 'duplicate') {
        if (playlist) playlist = { ...structuredClone(playlist), id: crypto.randomUUID(), revision: 1, locked: false, published: false };
        if (setup) setup = { ...structuredClone(setup), id: crypto.randomUUID(), revision: 1, locked: false, published: false };
        revision = null; dirty = true; return;
      }
      if (action !== 'delete') {
        if (playlist) { playlist = await offline.saveMusicPlaylist(playlist, revision, action); assert(); }
        if (setup) { setup = await offline.saveClassSetup(setup, revision, action); assert(); }
        if (action === 'publish') {
          if (playlist) { playlist = await offline.getMusicPlaylist(playlist.id); assert(); }
          if (setup) { setup = await offline.getClassSetup(setup.id); assert(); }
          if (!playlist && !setup) throw new Error('routine_not_found');
        }
      }
    }
    if (action === 'delete') { playlist = null; setup = null; envelope = null; revision = null; }
    else revision = (playlist ?? setup)!.revision;
    dirty = false;
    context.message(t('librarySaved'));
    await refresh(signal, assert);
  }); };
  const repeat = async (track: Track, signal: AbortSignal, assert: () => void) => {
    if (!playlist || playlist.locked || playlist.published || !author()) return;
    if (playlist.tracks.length >= 100) throw new Error('invalid_routine');
    const blob = await offline.getTrackBlob(track.id); assert();
    if (!blob) throw new Error('missing_audio');
    const entry = { ...structuredClone(track), id: crypto.randomUUID(), cues: [] };
    delete entry.after;
    await offline.cacheCloudTrack(entry.id, blob, await cloudHash(blob)); assert();
    if (signal.aborted) return;
    playlist.tracks.push(entry);
    const asset = envelope?.media[track.id] ?? reusableMedia[track.id] ?? context.routineMedia?.()[track.id];
    if (asset) reusableMedia[entry.id] = structuredClone(asset);
    dirty = true;
  };
  const render = () => {
    if (disposed) return;
    pendingSave = null; selectSetup = null; blockedButtons.clear();
    content.replaceChildren();
    const filters = element('div', 'action-row');
    const sourceInput = selectInput(source, (context.hosted ? ['local', 'household'] as const : ['local'] as const)
      .filter(value => author() || value === 'household').map(value => ({ value, label: t(value === 'local' ? 'localFilter' : 'householdFilter') })), value => {
      if (!available() || !discard()) { render(); return; }
      source = value; playlist = null; setup = null; envelope = null; dirty = false; revision = null;
      void run(refresh);
    });
    sourceInput.setAttribute('aria-label', t('source'));
    filters.append(sourceInput, iconButton(t('cloudRefresh'), RefreshCw, () => { void run(refresh); }));
    filters.append(selectInput(published ? 'published' : 'draft',
      (author() ? ['draft', 'published'] as const : ['published'] as const).map(value => ({ value, label: t(value === 'draft' ? 'cloudDrafts' : 'cloudPublications') })), value => {
        if (!available() || !discard()) { render(); return; }
        published = value === 'published'; playlist = null; setup = null; envelope = null; dirty = false; revision = null;
        void run(refresh);
      }));
    const routineOnly = iconButton(t('routineOnly'), Check, () => { if (available()) context.selected(null); }, true);
    routineOnly.dataset.offlineAvailable = 'true';
    content.append(filters);
    const list = element('div', 'library-lists');
    for (const [title, values] of [[t('classSetups'), classes], [t('musicPlaylists'), playlists]] as const) {
      if (title === t('classSetups')) continue;
      const group = element('section'); group.append(element('h3', '', title));
      for (const value of values) {
        const row = element('div', 'routine-library-row');
        const open = iconButton(t('openRoutine', { name: value.name }), Download, () => {
          if (!available() || !discard()) return;
          void run(async (signal, assert) => {
            playlist = null; setup = null; envelope = null; reusableMedia = {};
            if ('routine' in value) setup = structuredClone(value);
            else if (source === 'household') {
              envelope = await library.readPlaylist(value, { signal }); assert();
              await media.downloadTracks(envelope.playlist.tracks, envelope.media, { signal },
                value.published ? { playlistId: value.id, revision: value.revision } : undefined); assert();
              playlist = structuredClone(envelope.playlist);
            }
            else playlist = structuredClone(value);
            revision = value.revision; dirty = false;
          });
        });
        if ('routine' in value) open.dataset.offlineAvailable = 'true';
        row.append(element('span', '', identityText(value)), open);
        group.append(row);
      }
      list.append(group);
    }
    content.append(list);
    if (author()) {
      const newActions = element('div', 'action-row');
      newActions.append(iconButton(t('newPlaylist'), Plus, () => {
        if (!available() || !discard()) return;
        playlist = newMusicPlaylist(); playlist.name = t('newPlaylist'); setup = null; envelope = null; reusableMedia = {}; revision = null; dirty = true; render();
      }, true));
      content.append(newActions);
    }
    const value = playlist ?? setup;
    if (!value) { sync(); return; }
    protect();
    content.append(protection.element);
    content.append(element('p', 'draft-identity', `${identityText(value)} / ${t(dirty ? 'unsaved' : 'savedSnapshot')}`));
    const fields = element('fieldset', 'class-editor'); fields.dataset.libraryContent = '';
    fields.append(field(t(playlist ? 'playlistName' : 'setupName'), textInput(value.name, 160, name => { if (editable()) { value.name = name; changed(); } })));
    if (playlist) {
      playlist.tracks.forEach((track, index) => {
        const row = element('div', 'routine-library-row');
        row.append(element('span', '', track.title));
        row.append(gainSlider(t('trackGain'), () => track.gain ?? 1, value => { if (editable()) { track.gain = value; changed(); } }, editable).element);
        const bpm = numberInput(track.bpm ?? Number.NaN, 40, 220, value => {
          if (!editable()) return;
          const valid = !bpm.value.trim() || (Number.isFinite(value) && value >= 40 && value <= 220);
          bpm.setAttribute('aria-invalid', String(!valid));
          if (!bpm.value.trim()) { delete track.bpm; changed(); }
          else if (valid) { track.bpm = value; changed(); }
          if (pendingSave) pendingSave.disabled = !!content.querySelector('input[aria-invalid="true"]');
        });
        bpm.required = false; bpm.value = track.bpm === undefined ? '' : String(track.bpm);
        row.append(field(t('bpm'), bpm));
        for (const [direction, icon, label] of [[-1, ArrowUp, 'moveUp'], [1, ArrowDown, 'moveDown']] as const) {
          const move = iconButton(t(label), icon, () => {
            if (!editable() || !playlist) return;
            const target = index + direction;
            if (target < 0 || target >= playlist.tracks.length) return;
            playlist.tracks.splice(index, 1); playlist.tracks.splice(target, 0, track); changed(); render();
          });
          move.disabled = index + direction < 0 || index + direction >= playlist!.tracks.length; row.append(move);
        }
        row.append(iconButton(t('repeatEntry'), Copy, () => { if (editable()) void run((signal, assert) => repeat(track, signal, assert)); }),
          iconButton(t('deleteTrack'), Trash2, () => {
            if (editable() && playlist && confirm(t('confirmDelete', { name: track.title }))) { playlist.tracks.splice(index, 1); changed(); render(); }
          }));
        fields.append(row);
      });
      const songSelect = selectInput('', [{ value: '', label: t('chooseSong') }, ...context.draft().tracks.map(track => ({ value: track.id, label: track.title }))], () => {});
      fields.append(field(t('addFromRoutine'), songSelect), iconButton(t('addFromRoutine'), Plus, () => {
        const track = context.draft().tracks.find(entry => entry.id === songSelect.value);
        if (editable() && track) void run((signal, assert) => repeat(track, signal, assert));
      }));
      const file = element('input'); file.type = 'file'; file.multiple = true; file.accept = 'audio/*,.opus,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm';
      file.setAttribute('aria-label', t('import'));
      file.addEventListener('change', () => {
        const files = Array.from(file.files ?? []); file.value = '';
        if (!editable() || !files.length) return;
        void run(async (_signal, assert) => {
          for (const audio of files) {
            const track = await offline.storeTrack(audio); assert();
            if (!playlist || playlist.tracks.length >= 100) throw new Error('invalid_routine');
            playlist.tracks.push({ ...track, cues: [] }); changed();
          }
        });
      });
      fields.append(file, picker.element);
    } else if (setup) {
      const editing = setup;
      fields.append(referenceControl(t('routine'), setup.routine, routines, routineNames, reference => {
        if (reference) editing.routine = reference;
      }, true));
      for (const key of ['walkIn', 'walkOut'] as const) fields.append(referenceControl(t(key), setup[key], playlistReferences,
        new Map(playlistReferences.map(item => [item.id, item.name])), reference => { if (reference) editing[key] = reference; else delete editing[key]; }));
      for (const key of ['before', 'after'] as const) {
        const label = t(key === 'before' ? 'beforeAnnouncement' : 'afterAnnouncement');
        const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = !!setup[key];
        enabled.addEventListener('change', () => {
          if (!editable()) return;
          if (enabled.checked) editing[key] = { ...newRoutine().filler, mode: 'hold', sound: 'lofi' };
          else delete editing[key]; changed(); render();
        });
        fields.append(field(label, enabled));
        const filler: Filler | undefined = setup[key];
        if (filler) fields.append(fillerControls(filler, context.recordings, changed, editable, true));
      }
      fields.append(field(t('crossfade'), numberInput(setup.crossfade, 0, 12, fade => { if (editable()) { editing.crossfade = fade; changed(); } })));
    }
    content.append(fields);
    const actions = element('div', 'action-row');
    if (author()) {
      const saveButton = iconButton(t('librarySave', { name: value.name, destination: t(source === 'household' ? 'householdDestination' : 'localDestination') }), Save, () => save('save'), true);
      pendingSave = saveButton;
      saveButton.classList.add('primary'); saveButton.disabled = value.locked || value.published; actions.append(saveButton);
      const overflow = element('details', 'routine-overflow');
      overflow.append(element('summary', '', t('libraryActions')));
      const commands = element('div', 'action-row'); overflow.append(commands);
      for (const [action, icon, label] of [['publish', Send, 'libraryPublish'], [value.locked ? 'unlock' : 'lock', value.locked ? UnlockKeyhole : LockKeyhole, value.locked ? 'libraryUnlock' : 'libraryLock'],
        ['duplicate', Copy, 'libraryDuplicate'], ['delete', Trash2, 'libraryDelete']] as const) {
        const button = iconButton(t(label, { name: value.name }), icon, () => save(action));
        button.disabled = action !== 'duplicate' && (value.published || revision === null || (value.locked && action !== 'unlock'));
        commands.append(button);
      }
      actions.append(overflow);
    }
    if (setup) {
      const select = iconButton(t('useClass'), Check, () => {
        if (!available() || !setup || dirty || revision === null) return;
        if (!author() && !setup.published) return;
        context.selected({ setup: structuredClone(setup), source });
      }, true);
      selectSetup = select;
      select.dataset.offlineAvailable = 'true';
      select.disabled = dirty || revision === null; actions.append(select);
    }
    content.append(actions); sync();
  };
  function sync(): void {
    picker.sync();
      protection.sync();
    for (const fields of content.querySelectorAll<HTMLFieldSetElement>('fieldset[data-library-content]')) fields.disabled = !editable();
    for (const button of content.querySelectorAll<HTMLButtonElement>('button')) {
      const blocked = !available() || (source === 'household' && getCloudContext().access !== 'online' && button.dataset.offlineAvailable !== 'true');
      if (blocked) {
        if (!blockedButtons.has(button)) blockedButtons.set(button, button.disabled);
        button.disabled = true;
      } else if (blockedButtons.has(button)) {
        button.disabled = blockedButtons.get(button)!; blockedButtons.delete(button);
      }
    }
    if (selectSetup && dirty) selectSetup.disabled = true;
  }
  root.addEventListener('toggle', () => { if (root.open && available()) void run(refresh); });
  render();
  return { element: root, sync, hasUnsaved: () => dirty,
    async restoreRecovery(record: offline.DraftRecovery) {
      if (!available() || !author() || !discard()) return;
      if (context.hosted) captureCloudIdentity()();
      source = record.source; published = false;
      if (record.kind === 'class' && 'routine' in record.value) {
        setup = { ...structuredClone(record.value), id: crypto.randomUUID(), revision: 1, locked: false, published: false };
        playlist = null;
      } else if (record.kind === 'playlist' && 'tracks' in record.value && !('filler' in record.value)) {
        playlist = { ...structuredClone(record.value), id: crypto.randomUUID(), revision: 1, locked: false, published: false };
        setup = null;
      } else return;
      (playlist ?? setup)!.name = t('recoveryCopy', { name: record.value.name });
      envelope = null; reusableMedia = structuredClone(record.media); revision = null; dirty = true;
      root.open = true; render();
    },
    dispose: () => { disposed = true; picker.dispose(); protection.dispose(); generation++; controller?.abort(); } };
}