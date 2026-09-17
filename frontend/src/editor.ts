import { ArrowDown, ArrowUp, Check, GripVertical, Pause, Pencil, Play, Plus, ScanLine, Square, Trash2, ChevronsRight, Minus, Hand } from 'lucide';
import { cueSeconds, reorderTrack, transitionAfter, validateRoutine, type Cue, type Filler, type FillerRecording, type Routine, type Track } from '../../shared/routine';
import type { AudioPreview, BpmEstimate, LoudnessEstimate, PreviewState } from '../../shared/preview-contract';
import { formatCueTime, parseCueTime } from './cue-time';
import { formatNumber, formatTime, t } from './i18n';
import { createTrackReorder } from './track-reorder';
import { fillerControls, fillerSoundLabel } from './filler-controls';
import { getFillerSoundBpm } from './filler-audio';
import { cueAtSeconds, element, field, gainSlider, iconButton, numberInput, selectInput, setButtonIcon, textInput, transientText } from './ui';

interface EditorContext {
  preview: AudioPreview;
  detectBpm: (trackId: string) => Promise<BpmEstimate>;
  analyzeLoudness?: (trackId: string) => Promise<LoudnessEstimate>;
  isBusy: () => boolean;
  isCurrent: () => boolean;
  canEdit?: () => boolean;
  fillerRecordings?: () => FillerRecording[];
  previewFiller?: (filler: Filler) => Promise<void>;
  beforeTracks?: HTMLElement;
  afterTracks?: HTMLElement;
}

export interface EditorSession {
  syncAvailability(): void;
  cancelJobs(): void;
  refreshFillers(): void;
  dispose(): void;
}

const maximumCues = 1000;
const invalidTiming = new WeakMap<Routine, Map<Cue, string>>();
const reorderReports = new WeakMap<HTMLElement, HTMLElement>();

export function hasInvalidCueTimes(routine: Routine): boolean {
  const invalid = invalidTiming.get(routine);
  return routine.tracks.some(track => track.cues.some(cue => invalid?.has(cue)));
}

export function duplicateDraft(routine: Routine): Routine {
  if (hasInvalidCueTimes(routine)) throw new Error(t('invalidCueTime'));
  const copy = structuredClone(routine);
  copy.id = crypto.randomUUID();
  copy.name = t('copyName', { name: routine.name.slice(0, 153) });
  copy.revision = 1;
  copy.locked = false;
  copy.published = false;
  return copy;
}

export function contentFingerprint(routine: Routine): string {
  return JSON.stringify({ name: routine.name, tracks: routine.tracks, filler: routine.filler,
    crossfade: routine.crossfade, beepEvery: routine.beepEvery, beepRemaining: routine.beepRemaining,
    beepOnceRemaining: routine.beepOnceRemaining ?? 0, sequence: routine.sequence });
}

export function renderEditor(host: HTMLElement, routine: Routine, changed: (structural?: boolean) => void,
  context: EditorContext): EditorSession {
  const existing = host.querySelectorAll<HTMLDetailsElement>('details[data-track-id]');
  const expanded = new Set(Array.from(existing).filter(details => details.open).map(details => details.dataset.trackId));
  const reorderReport = reorderReports.get(host) ?? element('p', 'visually-hidden');
  reorderReport.setAttribute('role', 'status');
  reorderReport.setAttribute('aria-live', 'polite');
  reorderReport.setAttribute('aria-atomic', 'true');
  reorderReports.set(host, reorderReport);
  for (const child of Array.from(host.children)) if (child !== reorderReport) child.remove();
  if (!host.contains(reorderReport)) host.append(reorderReport);
  const form = element('div', 'editor-fields');
  const { preview } = context;
  let disposed = false;
  let auditionGeneration = 0;
  const current = () => !disposed && context.isCurrent();
  const available = () => current() && !context.isBusy();
  const editable = () => available() && !routine.locked && !routine.published && (context.canEdit?.() ?? true);
  const invalid = invalidTiming.get(routine) ?? new Map<Cue, string>();
  invalidTiming.set(routine, invalid);
  const refreshers: ((state: PreviewState) => void)[] = [];
  const cancelers: (() => void)[] = [];
  const errorDisplays = new Map<HTMLElement, ReturnType<typeof transientText>>();
  const errors = (node: HTMLElement) => { let display = errorDisplays.get(node); if (!display) { display = transientText(node); errorDisplays.set(node, display); } return display; };
  const contentFields: HTMLFieldSetElement[] = [];
  const content = (label: string) => {
    const fields = element('fieldset', 'editor-fields');
    fields.dataset.editorContent = '';
    fields.setAttribute('aria-label', label);
    fields.disabled = !editable();
    contentFields.push(fields);
    return fields;
  };
  const auditionError = element('p', 'preview-status');
  auditionError.setAttribute('role', 'status');
  auditionError.hidden = true;
  const audition = async (action: () => Promise<void>) => {
    if (!available()) return;
    const generation = ++auditionGeneration;
    auditionError.hidden = true;
    try { await action(); }
    catch {
      if (current() && generation === auditionGeneration) {
        errors(auditionError).show(t('previewFailed'));
      }
    }
  };
  const mutate = (action: () => void, structural = false) => {
    if (!editable()) return;
    trackReorder.cancel();
    action();
    changed(structural);
  };
  const gainControl = (label: string, read: () => number, write: (gain: number) => void) => {
    const control = gainSlider(label, read, value => mutate(() => write(value)), editable);
    refreshers.push(control.sync); return control;
  };
  const nameFields = content(t('routineName'));
  const nameInput = textInput(routine.name, 160, value => mutate(() => { routine.name = value; }));
  const nameField = field(t('routineName'), nameInput); nameField.classList.add('routine-name-field');
  nameField.append(iconButton(t('routineName'), Pencil, () => { if (editable()) { nameInput.focus(); nameInput.select(); } }));
  nameFields.append(nameField);
  form.append(nameFields);
  const tracks = element('section', 'editor-section');
  tracks.append(element('h2', '', t('playlist')));
  if (!routine.tracks.length) tracks.append(element('p', 'muted', t('emptyTracks')));
  const trackList = element('div', 'track-list');
  tracks.append(trackList);
  const moveTrack = (trackId: string, destination: number) => {
    if (!editable()) return;
    trackReorder.cancel();
    const track = routine.tracks.find(entry => entry.id === trackId);
    if (!track || !reorderTrack(routine, trackId, destination)) return;
    const fingerprint = contentFingerprint(routine);
    const announcement = t('trackReordered', { name: track.title, position: destination + 1, count: routine.tracks.length });
    reorderReport.textContent = '';
    changed(true);
    queueMicrotask(() => {
      if (!host.isConnected || !context.isCurrent() || fingerprint !== contentFingerprint(routine)) return;
      const grip = Array.from(host.querySelectorAll<HTMLButtonElement>('.track-reorder-grip'))
        .find(button => button.dataset.trackId === trackId);
      grip?.focus({ preventScroll: true });
      reorderReport.textContent = announcement;
    });
  };
  const trackReorder = createTrackReorder(trackList, {
    editable, tracks: () => routine.tracks,
    fingerprint: () => `${routine.id}:${routine.revision}:${contentFingerprint(routine)}`, commit: moveTrack,
  });
  cancelers.push(trackReorder.cancel);
  refreshers.push(trackReorder.sync);
  routine.tracks.forEach((track, index) => {
    const details = element('details', 'track-editor');
    details.dataset.trackId = track.id;
    details.open = existing.length ? expanded.has(track.id) : index === 0;
    const summary = element('summary');
    const summaryTitle = element('span', 'track-title', track.title);
    const grip = iconButton(t('reorderTrack', { name: track.title }), GripVertical, () => {});
    grip.classList.add('track-reorder-grip');
    grip.dataset.trackId = track.id;
    grip.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
    grip.setAttribute('aria-pressed', 'false');
    trackReorder.bind(track, details, grip);
    summary.append(grip, element('span', 'track-number', String(index + 1).padStart(2, '0')), summaryTitle,
      element('span', 'mono muted', formatTime(track.duration)));
    details.append(summary);
    const body = element('div', 'track-editor-body');
    const trackCurrent = () => current() && routine.tracks.includes(track);
    const trackEditable = () => editable() && trackCurrent();
    const auditionControls = element('div', 'track-preview');
    auditionControls.setAttribute('role', 'group');
    auditionControls.setAttribute('aria-label', t('trackPreview', { name: track.title }));
    const play = iconButton(t('playPreview'), Play, () => {
      if (!available() || !trackCurrent()) return;
      const state = preview.getState();
      if (state.kind === 'track' && state.trackId === track.id && state.playing) preview.pause();
      else void audition(() => preview.playTrack(track));
    });
    const seek = element('input');
    seek.type = 'range';
    seek.min = '0';
    seek.max = String(track.duration);
    seek.step = '0.01';
    seek.value = '0';
    seek.setAttribute('aria-label', t('seekPreview'));
    seek.addEventListener('input', () => {
      const state = preview.getState();
      if (available() && trackCurrent() && state.kind === 'track' && state.trackId === track.id && !state.loading) {
        preview.seek(seek.valueAsNumber);
      }
    });
    const clock = element('span', 'preview-clock mono');
    const previewStatus = element('p', 'preview-status');
    previewStatus.setAttribute('role', 'status');
    let previousStatus = '';
    const previewTimeline = element('div', 'preview-timeline');
    const previewMarkers = element('div', 'preview-markers');
    previewMarkers.setAttribute('role', 'group');
    previewMarkers.setAttribute('aria-label', t('cueTiming'));
    previewTimeline.append(seek, previewMarkers);
    const syncMarkers = () => {
      const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.previewCueId;
      previewMarkers.replaceChildren();
      for (const { cue, seconds } of sortedCues(track)) {
        if (invalid.has(cue)) continue;
        const marker = iconButton(t('cuePreview', { time: formatCueTime(seconds), note: cue.note }), Play, () => {
          const state = preview.getState();
          if (available() && trackCurrent() && state.kind === 'track' && state.trackId === track.id && !state.loading) preview.seek(seconds);
        });
        marker.classList.add('preview-cue-marker');
        marker.dataset.previewCueId = cue.id;
        marker.style.insetInlineStart = `${Math.max(0, Math.min(100, seconds / track.duration * 100))}%`;
        marker.addEventListener('click', event => event.stopPropagation());
        previewMarkers.append(marker);
        if (focusedId === cue.id) marker.focus({ preventScroll: true });
      }
    };
    auditionControls.append(play, previewTimeline, clock, previewStatus);
    refreshers.push(state => {
      const active = state.kind === 'track' && state.trackId === track.id;
      const playing = active && state.playing;
      const label = t(playing ? 'pausePreview' : 'playPreview');
      if (play.title !== label) {
        play.title = label;
        play.setAttribute('aria-label', label);
        setButtonIcon(play, playing ? Pause : Play);
      }
      play.disabled = !available() || !trackCurrent() || state.loading;
      play.setAttribute('aria-busy', String(active && state.loading));
      seek.disabled = !available() || !active || state.loading;
      for (const marker of previewMarkers.querySelectorAll<HTMLButtonElement>('button')) marker.disabled = seek.disabled;
      const elapsed = active ? state.elapsed : 0;
      const duration = active ? state.duration : track.duration;
      seek.max = String(duration);
      seek.value = String(elapsed);
      const time = t('progressTime', { elapsed: formatTime(elapsed), duration: formatTime(duration) });
      seek.setAttribute('aria-valuetext', time);
      if (clock.textContent !== time) clock.textContent = time;
      const status = active ? state.error ? t('previewFailed') : state.loading ? t('previewLoading')
        : t(playing ? 'playing' : 'paused') : '';
      if (previousStatus !== status) { previousStatus = status; errors(previewStatus).show(status, !!state.error); }
    });
    const trackFields = content(track.title);
    const tools = element('div', 'track-tools');
    const up = iconButton(t('moveUp'), ArrowUp, () => {
      if (trackEditable()) moveTrack(track.id, routine.tracks.findIndex(entry => entry.id === track.id) - 1);
    });
    const down = iconButton(t('moveDown'), ArrowDown, () => {
      if (trackEditable()) moveTrack(track.id, routine.tracks.findIndex(entry => entry.id === track.id) + 1);
    });
    refreshers.push(() => {
      const position = routine.tracks.findIndex(entry => entry.id === track.id);
      up.disabled = !trackEditable() || position <= 0;
      down.disabled = !trackEditable() || position < 0 || position >= routine.tracks.length - 1;
      grip.title = t('reorderTrack', { name: track.title });
      grip.setAttribute('aria-label', grip.title);
    });
    const remove = iconButton(t('deleteTrack'), Trash2, () => {
      if (trackEditable() && confirm(t('confirmDelete', { name: track.title }))) mutate(() => {
        if (preview.getState().trackId === track.id) preview.stop();
        routine.tracks.splice(index, 1);
      }, true);
    });
    remove.classList.add('danger');
    tools.append(up, down, remove);
    const afterStatus = element('div', 'after-track-status');
    afterStatus.id = `after-track-${track.id}`;
    afterStatus.dataset.afterTrackId = track.id;
    const afterLabel = element('strong');
    const afterDescription = element('span', 'muted');
    afterStatus.append(afterLabel, afterDescription);
    const afterButton = iconButton(t('afterTrack', { name: track.title }), ChevronsRight, () => {
      if (!trackEditable()) return;
      const original = JSON.stringify(track.after);
      const dialog = element('dialog', 'library-dialog');
      dialog.setAttribute('aria-label', t('afterTrack', { name: track.title }));
      let rule = structuredClone(track.after);
      const customFiller = structuredClone(track.after?.mode === 'custom' ? track.after.filler : routine.filler);
      let fade = track.after?.mode === 'custom' ? track.after.crossfade ?? routine.crossfade : routine.crossfade;
      const currentDialog = () => trackEditable() && JSON.stringify(track.after) === original;
      const controls = element('div');
      const syncRule = () => {
        controls.replaceChildren();
        if (rule?.mode === 'custom') controls.append(fillerControls(customFiller, context.fillerRecordings ?? (() => []), () => {}, currentDialog),
          field(t('crossfade'), numberInput(fade, 0, 12, value => { if (currentDialog()) fade = value; })));
      };
      const choice = selectInput('mode' in (rule ?? {}) ? rule!.mode : 'inherit',
        (['inherit', 'none', 'custom'] as const).map(value => ({ value, label: t(value) })), value => {
          if (!currentDialog()) return;
          rule = value === 'inherit' ? undefined : value === 'none' ? { mode: 'none' } : { mode: 'custom', filler: customFiller };
          syncRule();
        });
      const close = () => { dialog.close(); dialog.remove(); afterButton.focus({ preventScroll: true }); };
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.append(element('h2', '', t('afterTrack', { name: track.title })), field(t('exportAfter'), choice), controls);
      if (index === routine.tracks.length - 1) dialog.append(element('p', 'muted', t('dormantGap')));
      const actions = element('div', 'action-row');
      actions.append(iconButton(t('cancel'), Square, close, true), iconButton(t('apply'), Check, () => {
        if (!currentDialog() || !Number.isFinite(fade) || fade < 0 || fade > 12) return;
        if (rule?.mode === 'custom' && validateRoutine({ ...routine, tracks: [], filler: customFiller, crossfade: fade }).length) {
          const invalid = controls.querySelector<HTMLInputElement>(':invalid'); invalid?.reportValidity(); return;
        }
        mutate(() => { if (!rule) delete track.after; else track.after = rule.mode === 'none' ? rule : { mode: 'custom', filler: customFiller, crossfade: fade }; });
        syncAfterStatus();
        close();
      }, true));
      dialog.append(actions); form.append(dialog); syncRule(); dialog.showModal();
      cancelers.push(() => { if (dialog.isConnected) { dialog.close(); dialog.remove(); } });
    });
    afterButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
    afterButton.append(element('span', '', t('filler')));
    afterButton.classList.toggle('icon-button', false);
    afterButton.classList.add('after-track-button');
    const syncAfterStatus = () => {
      const position = routine.tracks.indexOf(track);
      const custom = track.after?.mode === 'custom';
      const { filler, crossfade } = transitionAfter(routine, position);
      const active = custom && position >= 0 && filler.mode !== 'none' && (filler.mode === 'hold' || filler.seconds > 0);
      afterStatus.hidden = track.after === undefined || position < 0;
      afterStatus.classList.toggle('active', active);
      afterButton.classList.toggle('custom-filler-active', active);
      afterButton.disabled = !trackEditable();
      if (afterStatus.hidden) { afterButton.removeAttribute('aria-describedby'); return; }
      afterButton.setAttribute('aria-describedby', afterStatus.id);
      const label = t(active ? 'customGapActive' : custom && position === routine.tracks.length - 1 ? 'customGapInactive' : 'customGapDisabled', { name: track.title });
      if (afterLabel.textContent !== label) afterLabel.textContent = label;
      afterDescription.hidden = !active;
      if (active) {
        const description = t('customGapDetails', {
          sound: filler.sound === 'recording' ? filler.recording?.name ?? t('customFillers') : t(filler.sound),
          mode: filler.mode === 'hold' ? t('openHold') : t('exportSeconds', { seconds: formatNumber(filler.seconds) }),
          gain: formatNumber((filler.gain ?? 1) * 100), fade: formatNumber(crossfade),
        });
        if (afterDescription.textContent !== description) afterDescription.textContent = description;
      }
    };
    refreshers.push(syncAfterStatus);
    summary.append(afterButton);
    const grid = element('div', 'field-grid');
    const rows = new Map<string, { row: HTMLDivElement; note: HTMLTextAreaElement; update: () => void }>();
    const cueRows = element('div', 'cue-rows');
    let reordering = false;
    const orderRows = (commit = false) => {
      if (reordering) return;
      reordering = true;
      const ordered = sortedCues(track, true).sort((first, second) => Number(invalid.has(first.cue)) - Number(invalid.has(second.cue)));
      if (commit) track.cues = ordered.map(item => item.cue);
      const focused = document.activeElement;
      const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] as const : null;
      try {
        ordered.forEach(({ cue }, position) => {
          const row = rows.get(cue.id)!.row;
          const next = cueRows.children[position] ?? null;
          if (row === next) return;
          const movable = cueRows as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
          if (movable.moveBefore && row.parentNode === cueRows) movable.moveBefore(row, next);
          else cueRows.insertBefore(row, next);
        });
        if (focused instanceof HTMLElement && cueRows.contains(focused) && document.activeElement !== focused) {
          focused.focus({ preventScroll: true });
          if (selection && focused instanceof HTMLTextAreaElement) focused.setSelectionRange(...selection);
        }
      } finally { reordering = false; }
    };
    const commitTiming = () => {
      if (!reordering) mutate(() => orderRows(true));
    };
    const updatePreviews = () => { for (const row of rows.values()) row.update(); syncMarkers(); };
    const stopTrackPreview = () => {
      if (preview.getState().trackId === track.id) { auditionGeneration += 1; preview.stop(); }
    };
    let loudnessGeneration = 0;
    let analyzing = false;
    let loudness: LoudnessEstimate | null = null;
    let analyzedGain = track.gain;
    const loudnessStatus = element('p', 'preview-status');
    loudnessStatus.setAttribute('role', 'status');
    const clippingWarning = element('p', 'preview-status clipping-warning');
    clippingWarning.setAttribute('role', 'status');
    clippingWarning.hidden = true;
    const loudnessCurrent = () => trackEditable() && Object.is(track.gain, analyzedGain);
    const syncLoudness = () => {
      analyze.disabled = !trackEditable() || analyzing || !context.analyzeLoudness;
      analyze.setAttribute('aria-busy', String(analyzing));
      applyGain.hidden = !loudness;
      applyGain.disabled = !loudness || !loudnessCurrent() || analyzing;
    };
    const invalidateLoudness = () => {
      clippingWarning.hidden = true; clippingWarning.textContent = '';
      loudnessGeneration += 1; analyzing = false; loudness = null; errors(loudnessStatus).dismiss(); syncLoudness();
    };
    const gain = gainControl(t('trackGain'), () => track.gain ?? 1, value => {
      stopTrackPreview(); track.gain = value; invalidateLoudness();
    });
    const analyze = iconButton(t('analyzeLoudness'), ScanLine, () => { void (async () => {
      if (!trackEditable() || analyzing || !context.analyzeLoudness) return;
      invalidateLoudness();
      const generation = loudnessGeneration;
      analyzedGain = track.gain;
      analyzing = true;
      errors(loudnessStatus).show(t('analyzingLoudness'), false); syncLoudness();
      const fresh = () => generation === loudnessGeneration && loudnessCurrent();
      try {
        const estimate = await context.analyzeLoudness(track.id);
        if (!fresh()) return;
        if (![estimate.integratedLufs, estimate.peakDbfs, estimate.targetLufs, estimate.recommendedGain].every(Number.isFinite)
          || estimate.recommendedGain < 0 || estimate.recommendedGain > 1.5 || typeof estimate.limited !== 'boolean') throw new Error('invalid_estimate');
        const suggestedGain = Math.min(1.25, estimate.recommendedGain);
        loudness = { ...estimate, recommendedGain: suggestedGain, limited: estimate.limited || estimate.recommendedGain > 1.25 };
        errors(loudnessStatus).show(t('loudnessSuggestion', { lufs: formatNumber(estimate.integratedLufs),
          peak: formatNumber(estimate.peakDbfs), target: formatNumber(estimate.targetLufs),
          db: suggestedGain === 0 ? '-inf' : formatNumber(20 * Math.log10(suggestedGain)),
          percent: formatNumber(suggestedGain * 100), limit: loudness.limited ? t('gainLimited') : '' }), false);
        clippingWarning.hidden = !estimate.clippingRisk;
        clippingWarning.textContent = estimate.clippingRisk ? t('clippingWarning') : '';
      } catch { if (fresh()) errors(loudnessStatus).show(t('loudnessFailed')); }
      finally { if (generation === loudnessGeneration) { analyzing = false; syncLoudness(); } }
    })(); }, true);
    const applyGain = iconButton(t('applyGain'), Check, () => {
      if (!loudness || !loudnessCurrent() || analyzing) return;
      const value = Math.min(1.25, loudness.recommendedGain);
      mutate(() => { stopTrackPreview(); track.gain = value; gain.sync(); invalidateLoudness(); });
    }, true);
    const loudnessControls = element('div', 'loudness-analysis');
    loudnessControls.append(analyze, applyGain, loudnessStatus, clippingWarning);
    cancelers.push(invalidateLoudness);
    refreshers.push(() => {
      if (!loudnessCurrent() && (analyzing || loudness)) invalidateLoudness();
      syncLoudness();
    });
    let detectionGeneration = 0;
    let detecting = false;
    let suggestion: BpmEstimate | null = null;
    let suggestedGrid: readonly [number | undefined, number] | null = null;
    const detection = element('div', 'bpm-detection');
    const detectedValues = element('p', 'preview-status');
    detectedValues.setAttribute('role', 'status');
    const showSuggestion = () => {
      if (!suggestion) return;
      errors(detectedValues).show(t('bpmSuggestion', { bpm: formatNumber(suggestion.bpm), seconds: formatNumber(suggestion.firstBeat) }), false);
      if (Number.isFinite(suggestion.confidence)) detectedValues.append(element('span', '', t('bpmConfidence', {
        percent: formatNumber(Math.max(0, Math.min(1, suggestion.confidence!)) * 100),
      })));
    };
    const suggestionCurrent = () => suggestion !== null && suggestedGrid !== null && trackEditable()
      && Object.is(track.bpm, suggestedGrid[0]) && Object.is(track.firstBeat, suggestedGrid[1]);
    const syncDetection = () => {
      detect.disabled = !trackEditable() || detecting;
      detect.setAttribute('aria-busy', String(detecting));
      apply.disabled = !suggestionCurrent() || detecting;
      apply.hidden = suggestion === null;
      alternatives.hidden = suggestion === null;
    };
    const invalidateDetection = () => {
      detectionGeneration += 1;
      detecting = false;
      suggestion = null;
      suggestedGrid = null;
      errors(detectedValues).dismiss();
      syncDetection();
    };
    cancelers.push(invalidateDetection);
    const detect = iconButton(t('detectBpm'), ScanLine, () => { void (async () => {
      if (!trackEditable() || detecting) return;
      invalidateDetection();
      const generation = detectionGeneration;
      const originalGrid = [track.bpm, track.firstBeat] as const;
      const fresh = () => generation === detectionGeneration && trackEditable()
        && Object.is(track.bpm, originalGrid[0]) && Object.is(track.firstBeat, originalGrid[1]);
      detecting = true;
      errors(detectedValues).show(t('detectingBpm'), false);
      syncDetection();
      try {
        const estimate = await context.detectBpm(track.id);
        if (!fresh()) return;
        if (!Number.isFinite(estimate.bpm) || estimate.bpm < 40 || estimate.bpm > 220
          || !Number.isFinite(estimate.firstBeat) || estimate.firstBeat < 0 || estimate.firstBeat >= track.duration) {
          throw new Error('invalid_estimate');
        }
        suggestion = { ...estimate };
        suggestedGrid = originalGrid;
        showSuggestion();
        alternatives.replaceChildren();
        for (const value of [...new Set([estimate.bpm, ...(estimate.alternatives ?? [])])].filter(value => Number.isFinite(value) && value >= 40 && value <= 220)) {
          const option = element('option', '', formatNumber(value)); option.value = String(value); alternatives.append(option);
        }
        alternatives.value = String(estimate.bpm);
      } catch {
        if (fresh()) errors(detectedValues).show(t('bpmDetectionFailed'));
      } finally {
        if (generation === detectionGeneration) { detecting = false; syncDetection(); }
      }
    })(); }, true);
    const bpmInput = numberInput(track.bpm ?? Number.NaN, 40, 220, value => mutate(() => {
      if (bpmInput.value.trim() === '') delete track.bpm; else track.bpm = value;
      invalidateDetection(); updatePreviews();
    }));
    bpmInput.required = false; bpmInput.value = track.bpm === undefined ? '' : String(track.bpm);
    const firstBeatInput = numberInput(track.firstBeat, 0, track.duration, value => mutate(() => {
      track.firstBeat = value; invalidateDetection(); updatePreviews();
    }));
    for (const input of [bpmInput, firstBeatInput]) {
      input.addEventListener('change', commitTiming);
      input.addEventListener('blur', commitTiming);
    }
    const apply = iconButton(t('applyBpm'), Check, () => {
      if (!suggestionCurrent() || detecting) return;
      const estimate = suggestion!;
      mutate(() => {
        track.bpm = estimate.bpm;
        track.firstBeat = estimate.firstBeat;
        bpmInput.value = String(track.bpm);
        firstBeatInput.value = String(track.firstBeat);
        invalidateDetection();
        updatePreviews();
        orderRows(true);
      });
    }, true);
    const alternatives = element('select');
    alternatives.setAttribute('aria-label', t('bpmAlternative'));
    alternatives.addEventListener('change', () => {
      const value = Number(alternatives.value);
      if (suggestionCurrent() && Number.isFinite(value) && value >= 40 && value <= 220
        && [suggestion!.bpm, ...(suggestion!.alternatives ?? [])].includes(value)) {
        suggestion!.bpm = value; showSuggestion();
      }
    });
    let taps: number[] = [];
    const setBpm = (value: number) => {
      if (!Number.isFinite(value) || value < 40 || value > 220) return;
      mutate(() => { track.bpm = Math.round(value * 10) / 10; bpmInput.value = String(track.bpm); invalidateDetection(); updatePreviews(); orderRows(true); });
    };
    const tempoTools = element('div', 'action-row');
    tempoTools.append(iconButton(t('halfBpm'), Minus, () => { if (track.bpm !== undefined) setBpm(track.bpm / 2); }, true),
      iconButton(t('doubleBpm'), Plus, () => { if (track.bpm !== undefined) setBpm(track.bpm * 2); }, true),
      iconButton(t('tapTempo'), Hand, () => {
        if (!trackEditable()) return;
        const now = performance.now();
        if (now - (taps.at(-1) ?? 0) > 2000) taps = [];
        taps.push(now); taps = taps.slice(-9);
        if (taps.length >= 3) setBpm(60000 * (taps.length - 1) / (now - taps[0]!));
      }, true));
    detection.append(detect, alternatives, apply, detectedValues, tempoTools);
    refreshers.push(() => {
      if (!trackEditable() && (detecting || suggestion)) invalidateDetection();
      syncDetection();
    });
    grid.append(
      field(t('title'), textInput(track.title, 300, value => mutate(() => {
        track.title = value;
        summaryTitle.textContent = value;
        trackFields.setAttribute('aria-label', value);
        auditionControls.setAttribute('aria-label', t('trackPreview', { name: value }));
      }))),
      field(t('bodyArea'), textInput(track.bodyArea, 160, value => mutate(() => { track.bodyArea = value; }))),
      field(t('bpm'), bpmInput), field(t('firstBeat'), firstBeatInput),
    );
    const cueList = element('div', 'cue-editor');
    cueList.append(element('h3', '', t('cues')));
    const makeCueRow = (cue: Cue) => {
      const row = element('div', 'cue-row');
      row.dataset.cueId = cue.id;
      const timePreview = element('output', 'cue-preview');
      const timingFeedback = element('p', 'preview-status');
      timingFeedback.setAttribute('role', 'status');
      timingFeedback.hidden = true;
      const updatePreview = () => {
        const count = cue.anchor.kind === 'count';
        try {
          const seconds = cueSeconds(cue, track);
          const valid = !invalid.has(cue) && Number.isFinite(seconds) && seconds >= 0 && seconds < track.duration;
          errors(timePreview).refresh(count ? valid ? formatCueTime(seconds) : t('invalidPreview') : '', !valid);
        } catch { errors(timePreview).refresh(count ? t('invalidPreview') : ''); }
      };
      const value = element('input');
      value.setAttribute('aria-label', t('value'));
      const configureValue = () => {
        value.type = cue.anchor.kind === 'count' ? 'number' : 'text';
        value.inputMode = cue.anchor.kind === 'count' ? 'numeric' : 'text';
        value.step = '1'; value.min = '1'; value.max = '100000';
        value.value = invalid.get(cue) ?? (cue.anchor.kind === 'count' ? String(cue.anchor.count) : formatCueTime(cue.anchor.seconds));
        value.setAttribute('aria-invalid', String(invalid.has(cue)));
      };
      configureValue();
      value.addEventListener('input', () => mutate(() => {
        const nextValue = cue.anchor.kind === 'count' ? /^\d+$/.test(value.value) ? Number(value.value) : null : parseCueTime(value.value);
        const valid = nextValue !== null && Number.isFinite(nextValue) && (cue.anchor.kind === 'count'
          ? Number.isInteger(nextValue) && nextValue >= 1 && nextValue <= 100000 : nextValue < track.duration);
        if (!valid) invalid.set(cue, value.value);
        else {
          invalid.delete(cue);
          if (cue.anchor.kind === 'count') cue.anchor.count = nextValue;
          else cue.anchor.seconds = nextValue;
        }
        value.setAttribute('aria-invalid', String(!valid));
        errors(timingFeedback).show(valid ? '' : t('invalidCueTime'));
        updatePreview(); syncMarkers();
      }));
      value.addEventListener('change', commitTiming);
      value.addEventListener('blur', commitTiming);
      const kind = selectInput(cue.anchor.kind, (['timestamp', 'count', 'interval'] as const).map(source => ({ value: source, label: t(source) })),
        source => mutate(() => {
          if (source === 'count' && (track.bpm === undefined || !Number.isFinite(track.bpm) || track.bpm < 40 || track.bpm > 220)) { kind.value = cue.anchor.kind; return; }
          const seconds = cueSeconds(cue, track);
          const converted = source === 'count'
            ? cueAtSeconds(track, { ...cue, anchor: { kind: 'count', count: 1 } }, seconds, track.duration)
            : { ...cue, anchor: { kind: source, seconds } };
          if (invalid.has(cue) || !Number.isFinite(seconds) || seconds < 0 || seconds >= track.duration || !converted) {
            kind.value = cue.anchor.kind;
            errors(timingFeedback).show(t('invalidCueTime'));
            value.focus({ preventScroll: true });
            return;
          }
          if (converted.anchor.kind === 'count') converted.anchor.count = Math.min(100000, converted.anchor.count);
          cue.anchor = converted.anchor;
          const snapped = cueSeconds(cue, track);
          errors(timingFeedback).show(snapped === seconds ? '' : t('cueCountSnapped', { time: formatCueTime(snapped) }), false);
          configureValue();
          updatePreview();
          syncMarkers();
          orderRows(true);
        }));
      refreshers.push(() => { const option = Array.from(kind.options ?? []).find(option => option.value === 'count'); if (option) option.disabled = track.bpm === undefined || !Number.isFinite(track.bpm); });
      const note = element('textarea');
      note.rows = 2;
      note.value = cue.note;
      note.maxLength = 500;
      note.addEventListener('input', () => mutate(() => { cue.note = note.value; syncMarkers(); }));
      const beepLabel = element('label', 'switch-label cue-beep');
      const beep = element('input');
      beep.type = 'checkbox';
      beep.checked = cue.beep === true;
      beep.addEventListener('change', () => mutate(() => { cue.beep = beep.checked; }));
      beepLabel.append(beep, element('span', '', t('cueBeep')));
      const removeCue = iconButton(t('deleteCue'), Trash2, () => {
        if (!trackEditable() || !confirm(t('confirmDeleteCue', { track: track.title, cue: cue.note }))) return;
        if (!trackEditable() || !track.cues.includes(cue)) return;
        mutate(() => {
          track.cues = track.cues.filter(item => item.id !== cue.id);
          invalid.delete(cue); rows.delete(cue.id); row.remove(); syncMarkers();
          addCue.disabled = track.cues.length >= maximumCues;
          progressAdd.disabled = addCue.disabled;
          addCue.focus({ preventScroll: true });
        });
      });
      removeCue.classList.add('danger');
      refreshers.push(() => { removeCue.hidden = !(context.canEdit?.() ?? true); });
      const valueField = field(t('value'), value);
      valueField.append(timePreview);
      row.append(field(t('source'), kind), valueField, field(t('note'), note), removeCue, beepLabel, timingFeedback);
      updatePreview();
      rows.set(cue.id, { row, note, update: updatePreview });
      return row;
    };
    for (const cue of track.cues) cueRows.append(makeCueRow(cue));
    orderRows();
    const insertCue = () => {
      if (!trackEditable() || track.cues.length >= maximumCues) return;
      const state = preview.getState();
      const seconds = state.kind === 'track' && state.trackId === track.id ? state.elapsed : 0;
      if (!Number.isFinite(seconds) || seconds < 0 || seconds >= track.duration) return;
      const cue: Cue = { id: crypto.randomUUID(), anchor: { kind: 'timestamp', seconds }, note: t('newCue') };
      mutate(() => {
        track.cues.push(cue);
        cueRows.append(makeCueRow(cue));
        orderRows(true);
        addCue.disabled = track.cues.length >= maximumCues;
        progressAdd.disabled = addCue.disabled;
        syncMarkers();
      });
      rows.get(cue.id)!.note.focus({ preventScroll: true });
      rows.get(cue.id)!.note.select();
    };
    const addCue = iconButton(t('addCue'), Plus, insertCue, true);
    const progressAdd = iconButton(t('addCue'), Plus, insertCue, true);
    progressAdd.classList.add('preview-add-cue');
    auditionControls.append(progressAdd);
    syncMarkers();
    refreshers.push(() => {
      addCue.disabled = !trackEditable() || track.cues.length >= maximumCues;
      progressAdd.disabled = addCue.disabled;
      const author = context.canEdit?.() ?? true;
      tools.hidden = !author; addCue.hidden = !author; progressAdd.hidden = !author;
      detection.hidden = !author; loudnessControls.hidden = !author;
    });
    cueList.append(cueRows, addCue);
    const analysis = element('details', 'analysis-details');
    analysis.append(element('summary', '', t('analysis')), gain.element, loudnessControls, detection);
    trackFields.append(tools, grid, analysis, cueList);
    body.append(auditionControls, trackFields);
    details.append(body);
    trackList.append(details, afterStatus);
  });
  const transitions = element('section', 'editor-section');
  transitions.append(element('h2', '', t('transitions')));
  const transitionFields = content(t('transitions'));
  const stopFiller = () => {
    if (preview.getState().kind === 'filler') { auditionGeneration += 1; preview.stop(); }
  };
  const fillerFields = element('div', 'field-grid');
  const duration = numberInput(routine.filler.seconds, 0, 600, value => { if (routine.filler.mode === 'timed') mutate(() => { stopFiller(); routine.filler.seconds = value; }); });
  const bpm = numberInput(routine.filler.bpm, 40, 220, value => {
    if (!['lofi', 'recording'].includes(routine.filler.sound)) mutate(() => { stopFiller(); routine.filler.bpm = value; });
  });
  const originalTempo = element('output', 'muted', t('originalTempo'));
  const bpmField = field(t('fillerBpm'), bpm);
  bpmField.append(originalTempo);
  const sound = element('select');
  const refreshFillers = () => {
    sound.replaceChildren();
    const builtins = element('optgroup');
    builtins.label = t('builtInFillers');
    for (const value of ['lofi', 'soft', 'bright', 'drums'] as const) {
      const option = element('option', '', fillerSoundLabel({ ...routine.filler, sound: value, recording: undefined }));
      option.value = value; builtins.append(option);
    }
    sound.append(builtins);
    const recordings = context.fillerRecordings?.() ?? [];
    const custom = element('optgroup');
    custom.label = t('customFillers');
    for (const recording of recordings) {
      const option = element('option', '', fillerSoundLabel({ ...routine.filler, sound: 'recording', recording }));
      option.value = `recording:${recording.id}`; custom.append(option);
    }
    if (recordings.length) sound.append(custom);
    const selected = routine.filler.recording;
    if (routine.filler.sound === 'recording' && selected && !recordings.some(recording => recording.id === selected.id)) {
      const retained = element('optgroup');
      retained.label = t('retainedFillers');
      const option = element('option', '', fillerSoundLabel(routine.filler));
      option.value = `recording:${selected.id}`; retained.append(option); sound.append(retained);
    }
    sound.value = routine.filler.sound === 'recording' ? `recording:${selected?.id ?? ''}` : routine.filler.sound;
  };
  sound.addEventListener('change', () => mutate(() => {
    const recording = context.fillerRecordings?.().find(item => `recording:${item.id}` === sound.value);
    if (recording) {
      stopFiller(); routine.filler.sound = 'recording'; routine.filler.recording = structuredClone(recording);
    } else if (['lofi', 'soft', 'bright', 'drums'].includes(sound.value)) {
      stopFiller(); routine.filler.sound = sound.value as 'lofi' | 'soft' | 'bright' | 'drums';
      delete routine.filler.recording;
    }
    refreshFillers(); syncFiller();
  }));
  const syncFiller = () => {
    duration.readOnly = routine.filler.mode === 'hold';
    duration.disabled = routine.filler.mode === 'none';
    duration.value = routine.filler.mode === 'hold' ? '' : String(routine.filler.seconds);
    duration.required = routine.filler.mode === 'timed';
    sound.disabled = routine.filler.mode === 'none';
    bpm.disabled = sound.disabled || ['lofi', 'recording'].includes(routine.filler.sound);
    try { const known = getFillerSoundBpm(routine.filler); bpm.value = known === undefined ? '' : String(known); } catch { bpm.value = String(routine.filler.bpm); }
    originalTempo.hidden = !['lofi', 'recording'].includes(routine.filler.sound);
  };
  refreshFillers();
  fillerFields.append(
    field(t('fillerMode'), selectInput(routine.filler.mode, (['none', 'timed', 'hold'] as const).map(value => ({ value, label: t(value) })),
      value => mutate(() => { stopFiller(); routine.filler.mode = value; syncFiller(); }))),
    field(t('fillerDuration'), duration), bpmField, field(t('fillerSound'), sound),
    field(t('crossfade'), numberInput(routine.crossfade, 0, 12, value => mutate(() => { routine.crossfade = value; }))),
    gainControl(t('fillerGain'), () => routine.filler.gain ?? 1, value => { stopFiller(); routine.filler.gain = value; }).element,
  );
  syncFiller();
  transitionFields.append(fillerFields);
  const fillerPreview = element('div', 'filler-preview');
  fillerPreview.setAttribute('role', 'group');
  fillerPreview.setAttribute('aria-label', t('previewFiller'));
  const fillerAvailable = () => available() && routine.filler.mode !== 'none'
    && (['lofi', 'recording'].includes(routine.filler.sound) || (Number.isFinite(routine.filler.bpm) && routine.filler.bpm >= 40 && routine.filler.bpm <= 220));
  const playFiller = iconButton(t('previewFiller'), Play, () => {
    if (fillerAvailable()) void audition(() => (context.previewFiller ?? preview.playFiller)(structuredClone(routine.filler)));
  }, true);
  const stopFillerButton = iconButton(t('stopFillerPreview'), Square, stopFiller);
  const fillerStatus = element('p', 'preview-status');
  fillerStatus.setAttribute('role', 'status');
  let previousFillerStatus = '';
  fillerPreview.append(playFiller, stopFillerButton, fillerStatus);
  refreshers.push(state => {
    const active = state.kind === 'filler';
    playFiller.disabled = !fillerAvailable() || state.loading || (active && state.playing);
    playFiller.setAttribute('aria-busy', String(active && state.loading));
    stopFillerButton.disabled = !active || !(state.loading || state.playing);
    const status = active ? state.error ? t('previewFailed') : state.loading ? t('previewLoading')
      : state.playing ? t('playing') : '' : '';
    if (previousFillerStatus !== status) { previousFillerStatus = status; errors(fillerStatus).show(status, !!state.error); }
  });
  transitions.append(transitionFields, fillerPreview);
  const beeps = element('section', 'editor-section');
  beeps.append(element('h2', '', t('alerts')));
  const beepFields = element('div', 'field-grid');
  beepFields.append(
    field(t('beepEvery'), numberInput(routine.beepEvery, 0, 7200, value => mutate(() => { routine.beepEvery = value; }))),
    field(t('beepRemaining'), numberInput(routine.beepRemaining, 0, 1200, value => mutate(() => { routine.beepRemaining = value; }))),
    field(t('beepOnceRemaining'), numberInput(routine.beepOnceRemaining ?? 0, 0, 1200,
      value => mutate(() => { routine.beepOnceRemaining = value; }))),
  );
  const alertFields = content(t('alerts'));
  alertFields.append(beepFields);
  beeps.append(alertFields);
  if (context.beforeTracks) form.append(context.beforeTracks);
  form.append(tracks);
  if (context.afterTracks) form.append(context.afterTracks);
  form.append(transitions, beeps, auditionError);
  host.insertBefore(form, reorderReport);
  const sync = (state: PreviewState) => {
    if (disposed) return;
    for (const fields of contentFields) fields.disabled = !editable();
    for (const refresh of refreshers) refresh(state);
  };
  const unsubscribe = preview.subscribe(sync);
  const cancelJobs = () => {
    auditionGeneration += 1;
    auditionError.hidden = true;
    for (const cancel of cancelers) cancel();
  };
  return {
    syncAvailability: () => sync(preview.getState()),
    cancelJobs,
    refreshFillers,
    dispose: () => { disposed = true; cancelJobs(); for (const display of errorDisplays.values()) display.dispose(); unsubscribe(); },
  };
}

export function sortedCues(track: Track, includeInvalid = false): { cue: Cue; seconds: number }[] {
  return track.cues.map(cue => {
    try {
      const seconds = cueSeconds(cue, track);
      return { cue, seconds: Number.isFinite(seconds) && seconds >= 0 && seconds < track.duration
        ? seconds : Number.NaN };
    }
    catch { return { cue, seconds: Number.NaN }; }
  }).filter(item => includeInvalid || Number.isFinite(item.seconds))
    .sort((first, second) => {
      if (!Number.isFinite(first.seconds)) return Number.isFinite(second.seconds) ? 1 : 0;
      if (!Number.isFinite(second.seconds)) return -1;
      return first.seconds - second.seconds;
    });
}