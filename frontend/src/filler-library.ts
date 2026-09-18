import { Check, CloudUpload, Play, Plus, RefreshCw, ScanLine, Square, Trash2, X } from 'lucide';
import type { FillerAnalysis, ManagedAudioItem } from '../../shared/cloud-contract';
import type { Filler, FillerRecording } from '../../shared/routine';
import type { AudioPreview, LoudnessEstimate } from '../../shared/preview-contract';
import { addFillerRecording, getFillerRecordingBlob, listFillerRecordings, removeFillerRecording } from './offline';
import { captureCloudIdentity, CloudRequestError, getCloudContext, getCloudRole, refreshCloudSession } from './cloud-client';
import { createCloudLibrary, type CloudTransfer } from './cloud-library';
import { cloudErrorMessage, cloudStatusMessage } from './cloud-ui';
import { detectTrackBpm } from './bpm';
import { getFillerSoundBpm } from './filler-audio';
import { fillerSoundLabel } from './filler-controls';
import { errorMessage, formatNumber, formatTime, t } from './i18n';
import { element, field, iconButton, transientText } from './ui';

interface FillerLibraryContext {
  hosted: boolean;
  managed?: boolean;
  busy?(): boolean;
  working?(value: boolean): void;
  cloud: ReturnType<typeof createCloudLibrary>;
  preview: AudioPreview;
  analyzeLoudness?: (trackId: string) => Promise<LoudnessEstimate>;
  isCurrent: () => boolean;
  changed: () => void;
  message?: (message: string, error?: boolean) => void;
}

export function createFillerLibrary(context: FillerLibraryContext) {
  const root = element('section', 'settings-section filler-library');
  root.setAttribute('aria-label', t('fillerLibrary'));
  const management = element('div', 'filler-management');
  const status = element('p', 'filler-library-status');
  status.setAttribute('role', 'status');
  const feedback = element('p', 'filler-library-feedback');
  feedback.setAttribute('role', 'status');
  const errors = transientText(feedback);
  const bpmResult = element('p', 'preview-status');
  bpmResult.setAttribute('role', 'status');
  const bpmErrors = transientText(bpmResult);
  const bpmInput = element('input');
  bpmInput.type = 'number'; bpmInput.min = '40'; bpmInput.max = '220'; bpmInput.step = 'any';
  const validAnalysis = (analysis: FillerAnalysis | null, recording: FillerRecording): analysis is FillerAnalysis => !!analysis
    && analysis.sha256 === recording.asset.sha256 && Number.isFinite(analysis.bpm) && analysis.bpm >= 40 && analysis.bpm <= 220
    && typeof analysis.analyzer === 'string' && !!analysis.analyzer
    && (analysis.confidence === undefined || (Number.isFinite(analysis.confidence) && analysis.confidence >= 0 && analysis.confidence <= 1));
  const showAnalysis = (analysis: FillerAnalysis) => {
    bpmInput.value = String(analysis.bpm);
    bpmInput.removeAttribute('aria-invalid');
    bpmErrors.show(`${formatNumber(analysis.bpm)} BPM${analysis.confidence === undefined ? ''
      : `; ${t('bpmConfidence', { percent: formatNumber(analysis.confidence * 100) })}`}`, false);
  };
  let suggestedBpm: { recording: FillerRecording; analysis: FillerAnalysis } | null = null;
  const localAnalysisKey = (recording: FillerRecording) => `fitness-filler-analysis:${recording.asset.sha256}`;
  const progress = element('progress');
  progress.max = 100;
  progress.hidden = true;
  progress.setAttribute('aria-label', t('cloudWorking'));
  const name = element('input');
  name.type = 'text'; name.maxLength = 160;
  const file = element('input');
  file.type = 'file'; file.accept = 'audio/*,.opus,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm';
  const selection = element('select');
  selection.setAttribute('aria-label', t('customFillers'));
  const details = element('p', 'muted filler-recording-details');
  const levelResult = element('p', 'preview-status filler-level-result');
  levelResult.setAttribute('role', 'status');
  const clippingWarning = element('p', 'preview-status clipping-warning');
  clippingWarning.setAttribute('role', 'status'); clippingWarning.hidden = true;
  let recordings: FillerRecording[] = [];
  const catalogTitles = new Map<string, string>();
  let controller: AbortController | null = null;
  let disposed = false;
  let refreshRequested = false;
  let refreshQueued = false;
  let identity = '';
  let imported: { file: File; name: string; recording: FillerRecording; assertIdentity: () => void } | null = null;
  const ready = new Set<string>();
  const key = (recording: FillerRecording) => JSON.stringify(recording);
  const mutable = () => !context.hosted || ['owner', 'editor'].includes(getCloudRole() ?? '');
  const selected = () => recordings.find(recording => recording.id === selection.value);
  const available = () => !disposed && context.isCurrent() && mutable() && !controller && !context.busy?.();
  const connected = () => !context.hosted || getCloudContext().access === 'online';
  const report = (error: unknown) => { errors.show(context.hosted ? cloudErrorMessage(error) : errorMessage(error)); };
  const discardImport = async (entry: NonNullable<typeof imported>) => {
    if (imported === entry) imported = null;
    try { entry.assertIdentity(); await removeFillerRecording(entry.recording.id); }
    catch {}
  };

  const render = () => {
    const current = selection.value;
    selection.replaceChildren();
    const placeholder = element('option', '', t(recordings.length ? 'chooseFiller' : 'noCustomFillers'));
    placeholder.value = '';
    selection.append(placeholder);
    for (const recording of recordings) {
      const title = catalogTitles.get(recording.id);
      const option = element('option', '', title ? t('soundDuration', { name: title, seconds: formatNumber(recording.duration) })
        : fillerSoundLabel({ mode: 'hold', seconds: 0, bpm: 100, sound: 'recording', recording }));
      option.value = recording.id;
      selection.append(option);
    }
    selection.value = recordings.some(recording => recording.id === current) ? current : '';
    sync();
  };
  const run = async (action: (transfer: CloudTransfer, assert: () => void, assertIdentity: () => void) => Promise<void>, auditionOnly = false, metadataOnly = false) => {
    if (disposed || !context.isCurrent() || controller || context.busy?.() || (!auditionOnly && !mutable())) return;
    const current = new AbortController();
    controller = current;
    if (!metadataOnly) context.working?.(true);
    errors.show(t('busy'), false);
    let assertIdentity = () => {};
    const assert = () => {
      assertIdentity();
      if (disposed || !context.isCurrent() || current.signal.aborted || (!auditionOnly && !mutable())) throw new CloudRequestError('cancelled');
    };
    sync();
    try {
      assertIdentity = context.hosted ? captureCloudIdentity() : () => {};
      assert();
      await action({ signal: current.signal, progress: (completed, total) => {
        assert();
        progress.hidden = false;
        progress.value = total ? Math.min(100, completed / total * 100) : 0;
      } }, assert, assertIdentity);
    } catch (error) {
      if (!disposed && context.isCurrent()) {
        try { assertIdentity(); report(error); context.message?.(feedback.textContent ?? '', true); }
        catch { sync(); }
      }
    } finally {
      if (controller === current) controller = null;
      if (!metadataOnly) context.working?.(false);
      progress.hidden = true;
      if (!disposed) sync();
    }
  };
  const refresh = async () => {
    refreshRequested = true;
    if (!available()) return;
    refreshRequested = false;
    await run(async (transfer, assert) => {
      if (context.hosted && getCloudContext().access !== 'online') await refreshCloudSession();
      assert();
      const result = context.hosted ? await context.cloud.listFillers(transfer) : await listFillerRecordings();
      assert();
      recordings = structuredClone(result);
      render();
      context.changed();
      errors.show(t('fillerRefreshed'), false);
    }, false, true);
  };
  const refreshButton = iconButton(t('refreshFillers'), RefreshCw, () => { void refresh(); });
  const add = iconButton(t(context.hosted ? 'uploadFiller' : 'addFiller'), context.hosted ? CloudUpload : Plus, () => {
    const chosen = file.files?.[0];
    if (context.managed || !available() || !connected() || !chosen) return;
    if (!chosen.size || chosen.size > 32 * 1024 * 1024) { errors.show(t('audioByteLimit')); return; }
    const label = (name.value.trim() || chosen.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()).slice(0, 160);
    if (context.hosted && !confirm(t('confirmUploadFiller', { name: label }))) return;
    void run(async (transfer, assert, assertIdentity) => {
      let pending = imported?.file === chosen && imported.name === label ? imported : null;
      let retain = false;
      try {
        if (!pending) {
          errors.show(t('preparingAudio', { name: chosen.name }), false);
          const recording = await addFillerRecording(chosen, label, transfer.signal);
          pending = { file: chosen, name: label, recording, assertIdentity };
          imported = pending;
        }
        assert();
        let recording = pending.recording;
        if (context.hosted) {
          errors.show(t('cloudWorking'), false);
          const blob = await getFillerRecordingBlob(recording);
          assert();
          if (!blob) throw new Error('missing_audio');
          const authoritative = await context.cloud.addFiller(recording, blob, transfer);
          assert();
          await removeFillerRecording(recording.id);
          if (imported === pending) imported = null;
          pending = null;
          assert();
          recording = authoritative;
        }
        assert();
        recordings = [...recordings.filter(item => item.id !== recording.id), structuredClone(recording)];
        ready.add(key(recording));
        imported = null;
        pending = null;
        file.value = ''; name.value = '';
        render(); selection.value = recording.id;
        context.changed();
        errors.show(t(context.hosted ? 'fillerUploaded' : 'fillerAdded'), false);
      } catch (error) {
        retain = !disposed && context.isCurrent() && !transfer.signal?.aborted && error instanceof CloudRequestError
          && (error.code === 'network_unavailable' || (error.code === 'cloud_http_error'
            && ([500, 502, 503, 504].includes(error.status ?? 0) || (error.status === 409 && error.serverCode === 'upload_conflict'))));
        throw error;
      } finally {
        if (pending && !retain) await discardImport(pending);
      }
    });
  }, true);
  const remove = iconButton(t('removeFiller'), Trash2, () => {
    const recording = selected();
    if (context.managed || !available() || !connected() || !recording || !confirm(t('confirmRemoveFiller', { name: recording.name }))) return;
    void run(async (transfer, assert) => {
      if (context.hosted) await context.cloud.removeFiller(recording.id, transfer);
      else await removeFillerRecording(recording.id);
      assert();
      recordings = recordings.filter(item => item.id !== recording.id);
      render();
      context.changed();
      errors.show(t('fillerRemoved'), false);
    });
  });
  const audition = async (filler: Filler): Promise<void> => {
    if (disposed || !context.isCurrent() || controller || context.busy?.()) return;
    const snapshot = structuredClone(filler);
    const recording = snapshot.recording;
    if (recording && !ready.has(key(recording))) {
      await run(async (transfer, assert) => {
        const blob = await getFillerRecordingBlob(recording);
        assert();
        if (!blob) {
          if (!context.hosted || !mutable()) throw new Error('missing_audio');
          await context.cloud.ensureFiller(recording, transfer);
        }
        assert();
        ready.add(key(recording));
        errors.show(t('fillerPreviewReady'), false);
        context.message?.(feedback.textContent);
      }, true);
      return;
    }
    await context.preview.playFiller(snapshot);
  };
  const play = iconButton(t('previewFiller'), Play, () => {
    const recording = selected();
    if (!available() || !recording) return;
    void audition({ mode: 'timed', seconds: 8, bpm: 100, sound: 'recording', recording, gain: 1 }).catch(report);
  });
  const stop = iconButton(t('stopFillerPreview'), Square, () => { if (!disposed) context.preview.stop(); });
  const analyze = iconButton(t('analyzeFillerLevel'), ScanLine, () => {
    const recording = selected();
    if (!available() || !recording || !context.analyzeLoudness) return;
    clippingWarning.hidden = true; clippingWarning.textContent = '';
    levelResult.textContent = t('analyzingLoudness');
    void run(async (transfer, assert) => {
      try {
        if (!await getFillerRecordingBlob(recording)) {
          assert();
          if (!context.hosted) throw new Error('missing_audio');
          await context.cloud.ensureFiller(recording, transfer);
        }
        assert();
        const estimate = await context.analyzeLoudness!(`filler-${recording.asset.id}`);
        assert();
        if (selected()?.id !== recording.id) return;
        if (![estimate.integratedLufs, estimate.peakDbfs, estimate.targetLufs, estimate.recommendedGain].every(Number.isFinite)
          || estimate.recommendedGain < 0 || estimate.recommendedGain > 1.5) throw new Error('invalid_estimate');
        const suggestedGain = Math.min(1.25, estimate.recommendedGain);
        levelResult.textContent = t('loudnessSuggestion', { lufs: formatNumber(estimate.integratedLufs),
          peak: formatNumber(estimate.peakDbfs), target: formatNumber(estimate.targetLufs),
          db: suggestedGain === 0 ? '-inf' : formatNumber(20 * Math.log10(suggestedGain)),
          percent: formatNumber(suggestedGain * 100), limit: estimate.limited || estimate.recommendedGain > 1.25 ? t('gainLimited') : '' });
        clippingWarning.hidden = !estimate.clippingRisk;
        clippingWarning.textContent = estimate.clippingRisk ? t('clippingWarning') : '';
        errors.dismiss();
      } catch (error) { levelResult.textContent = ''; throw error; }
    }, true);
  }, true);
  const cancel = iconButton(t('cancelFillerOperation'), X, () => {
    controller?.abort(); errors.show(t('cloudCancelling'), false); sync();
  });
  const analyzeBpm = iconButton(t('fillerAnalyzeBpm'), ScanLine, () => {
    const recording = selected(); if (!available() || !recording) return;
    suggestedBpm = null; bpmErrors.show(t('detectingBpm'), false);
    void run(async (transfer, assert) => {
      try {
        if (!await getFillerRecordingBlob(recording)) {
          assert(); if (!context.hosted) throw new Error('missing_audio'); await context.cloud.ensureFiller(recording, transfer);
        }
        assert();
        const estimate = await detectTrackBpm(`filler-${recording.asset.id}`); assert();
        if (selected()?.id !== recording.id) return;
        const analysis = { bpm: estimate.bpm, sha256: recording.asset.sha256, analyzer: 'detectTrackBpm',
          ...(estimate.confidence === undefined ? {} : { confidence: estimate.confidence }) };
        if (!validAnalysis(analysis, recording)) throw new Error('invalid_estimate');
        suggestedBpm = { recording, analysis };
        showAnalysis(analysis); errors.dismiss();
      } catch (error) { bpmErrors.dismiss(); throw error; }
    });
  }, true);
  bpmInput.addEventListener('input', () => {
    const recording = selected(); if (!available() || !recording) return;
    const bpm = bpmInput.value.trim() ? Number(bpmInput.value) : Number.NaN;
    const analysis: FillerAnalysis = { bpm, analyzer: 'manual', sha256: recording.asset.sha256 };
    suggestedBpm = validAnalysis(analysis, recording) ? { recording, analysis } : null;
    bpmErrors.dismiss(); bpmInput.setAttribute('aria-invalid', String(!suggestedBpm)); sync();
  });
  const applyBpm = iconButton(t('fillerApplyBpm'), Check, () => {
    const suggestion = suggestedBpm;
    if (!available() || !suggestion || selected()?.id !== suggestion.recording.id) return;
    void run(async (transfer, assert) => {
      const saved = context.hosted ? await context.cloud.fillerAnalysis(suggestion.recording, suggestion.analysis, transfer) : suggestion.analysis;
      assert();
      if (!validAnalysis(saved, suggestion.recording)) throw new Error('invalid_estimate');
      if (!context.hosted) localStorage.setItem(localAnalysisKey(suggestion.recording), JSON.stringify(saved));
      suggestedBpm = null; showAnalysis(saved); errors.show(t('fillerBpmSaved'), false); context.changed();
    });
  }, true);
  const actions = element('div', 'filler-library-actions');
  actions.append(play, stop, analyze, analyzeBpm, applyBpm, remove);
  const heading = element('div', 'section-heading');
  heading.append(element('h2', '', t('fillerLibrary')), refreshButton, cancel);
  const nameField = field(t('fillerRecordingName'), name);
  const fileField = field(t('fillerFile'), file);
  nameField.hidden = fileField.hidden = add.hidden = remove.hidden = !!context.managed;
  management.append(status, nameField, fileField, add,
    field(t('customFillers'), selection), details, actions, levelResult, clippingWarning,
    field(t('fillerBpmMetadata'), bpmInput), bpmResult, progress, feedback);
  const builtins = element('ul', 'filler-builtins');
  for (const sound of ['lofi', 'soft', 'bright', 'drums'] as const) {
    const bpm = getFillerSoundBpm({ mode: 'hold', seconds: 0, sound, bpm: 100 });
    builtins.append(element('li', '', `${t(sound)}: ${bpm === undefined ? t('fillerBpmUnknown') : `${formatNumber(bpm)} BPM`}`));
  }
  root.append(heading, management, element('h3', '', t('builtInFillers')), builtins);
  selection.addEventListener('change', () => {
    errors.dismiss(); levelResult.textContent = ''; suggestedBpm = null; bpmErrors.dismiss(); sync();
    clippingWarning.hidden = true; clippingWarning.textContent = ''; bpmInput.value = ''; bpmInput.removeAttribute('aria-invalid');
    const recording = selected(); if (!recording || !available()) return;
    void run(async (transfer, assert) => {
      const analysis: FillerAnalysis | null = context.hosted ? await context.cloud.fillerAnalysis(recording, undefined, transfer)
        : JSON.parse(localStorage.getItem(localAnalysisKey(recording)) ?? 'null');
      assert();
      if (selected()?.id === recording.id && validAnalysis(analysis, recording)) showAnalysis(analysis);
      errors.dismiss();
    });
  });
  file.addEventListener('change', () => sync());

  function sync(): void {
    if (disposed) return;
    const user = context.hosted ? getCloudContext().user : null;
    const owner = JSON.stringify(user ? [user.id, user.authVersion, user.role] : null);
    if (owner !== identity) {
      identity = owner;
      controller?.abort(); recordings = []; ready.clear(); catalogTitles.clear(); imported = null;
      file.value = ''; name.value = ''; selection.replaceChildren(); errors.dismiss();
      levelResult.textContent = '';
      clippingWarning.hidden = true; clippingWarning.textContent = ''; suggestedBpm = null;
      bpmInput.value = ''; bpmErrors.dismiss();
      context.changed();
    }
    root.hidden = !mutable();
    status.textContent = context.hosted ? cloudStatusMessage(getCloudContext()) : t('localFillerLibrary');
    const blocked = !available();
    refreshButton.disabled = blocked;
    add.disabled = blocked || !connected() || !file.files?.length;
    name.disabled = file.disabled = blocked || !connected();
    selection.disabled = blocked || !recordings.length;
    remove.disabled = blocked || !connected() || !selected();
    play.disabled = blocked || !selected();
    analyze.disabled = blocked || !selected() || !context.analyzeLoudness;
    analyzeBpm.disabled = blocked || !selected();
    bpmInput.disabled = blocked || !selected() || !connected();
    applyBpm.hidden = !suggestedBpm; applyBpm.disabled = blocked || !suggestedBpm || !connected();
    stop.disabled = !context.isCurrent();
    cancel.hidden = !controller;
    cancel.disabled = controller?.signal.aborted ?? false;
    const recording = selected();
    details.textContent = recording ? t('fillerRecordingDetails', { duration: formatTime(recording.duration), id: recording.id }) : '';
    if (refreshRequested && available() && !refreshQueued) {
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (!disposed && refreshRequested) void refresh();
      });
    }
  }
  sync();
  return {
    element: root, refresh, sync, audition,
    catalog(items: ManagedAudioItem[]) {
      for (const item of items) if (item.kind === 'filler') catalogTitles.set(item.id, item.metadata.title);
      render();
    },
    choices: () => structuredClone(recordings),
    leave: () => { controller?.abort(); if (!controller && imported) void discardImport(imported); },
    dispose: () => {
      errors.dispose(); bpmErrors.dispose();
      disposed = true; refreshRequested = false; controller?.abort(); recordings = []; ready.clear();
      if (!controller && imported) void discardImport(imported);
    },
  };
}