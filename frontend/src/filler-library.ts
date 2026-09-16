import { CloudUpload, Play, Plus, RefreshCw, ScanLine, Square, Trash2, X } from 'lucide';
import type { Filler, FillerRecording } from '../../shared/routine';
import type { AudioPreview, LoudnessEstimate } from '../../shared/preview-contract';
import { addFillerRecording, getFillerRecordingBlob, listFillerRecordings, removeFillerRecording } from './offline';
import { captureCloudIdentity, CloudRequestError, getCloudContext, getCloudRole, refreshCloudSession } from './cloud-client';
import { createCloudLibrary, type CloudTransfer } from './cloud-library';
import { cloudErrorMessage, cloudStatusMessage } from './cloud-ui';
import { errorMessage, formatNumber, formatTime, t } from './i18n';
import { element, field, iconButton } from './ui';

interface FillerLibraryContext {
  hosted: boolean;
  cloud: ReturnType<typeof createCloudLibrary>;
  preview: AudioPreview;
  analyzeLoudness?: (trackId: string) => Promise<LoudnessEstimate>;
  isCurrent: () => boolean;
  changed: () => void;
  message?: (message: string) => void;
}

export function createFillerLibrary(context: FillerLibraryContext) {
  const root = element('section', 'settings-section filler-library');
  root.setAttribute('aria-label', t('fillerLibrary'));
  const management = element('div', 'filler-management');
  const status = element('p', 'filler-library-status');
  status.setAttribute('role', 'status');
  const feedback = element('p', 'filler-library-feedback');
  feedback.setAttribute('role', 'status');
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
  let recordings: FillerRecording[] = [];
  let controller: AbortController | null = null;
  let disposed = false;
  let identity = '';
  let imported: { file: File; name: string; recording: FillerRecording; assertIdentity: () => void } | null = null;
  const ready = new Set<string>();
  const key = (recording: FillerRecording) => JSON.stringify(recording);
  const mutable = () => !context.hosted || ['owner', 'editor'].includes(getCloudRole() ?? '');
  const selected = () => recordings.find(recording => recording.id === selection.value);
  const available = () => !disposed && context.isCurrent() && mutable() && !controller;
  const connected = () => !context.hosted || getCloudContext().access === 'online';
  const report = (error: unknown) => { feedback.textContent = context.hosted ? cloudErrorMessage(error) : errorMessage(error); };
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
      const option = element('option', '', recording.name);
      option.value = recording.id;
      selection.append(option);
    }
    selection.value = recordings.some(recording => recording.id === current) ? current : '';
    sync();
  };
  const run = async (action: (transfer: CloudTransfer, assert: () => void, assertIdentity: () => void) => Promise<void>, auditionOnly = false) => {
    if (disposed || !context.isCurrent() || controller || (!auditionOnly && !mutable())) return;
    const current = new AbortController();
    controller = current;
    feedback.textContent = t('busy');
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
        try { assertIdentity(); report(error); context.message?.(feedback.textContent ?? ''); }
        catch { sync(); }
      }
    } finally {
      if (controller === current) controller = null;
      progress.hidden = true;
      if (!disposed) sync();
    }
  };
  const refresh = () => run(async (transfer, assert) => {
    if (context.hosted && getCloudContext().access !== 'online') await refreshCloudSession();
    assert();
    const result = context.hosted ? await context.cloud.listFillers(transfer) : await listFillerRecordings();
    assert();
    recordings = structuredClone(result);
    render();
    context.changed();
    feedback.textContent = t('fillerRefreshed');
  });
  const refreshButton = iconButton(t('refreshFillers'), RefreshCw, () => { void refresh(); });
  const add = iconButton(t(context.hosted ? 'uploadFiller' : 'addFiller'), context.hosted ? CloudUpload : Plus, () => {
    const chosen = file.files?.[0];
    if (!available() || !connected() || !chosen) return;
    if (!chosen.size || chosen.size > 32 * 1024 * 1024) { feedback.textContent = t('audioByteLimit'); return; }
    const label = (name.value.trim() || chosen.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()).slice(0, 160);
    if (context.hosted && !confirm(t('confirmUploadFiller', { name: label }))) return;
    void run(async (transfer, assert, assertIdentity) => {
      let pending = imported?.file === chosen && imported.name === label ? imported : null;
      let retain = false;
      try {
        if (!pending) {
          feedback.textContent = t('preparingAudio', { name: chosen.name });
          const recording = await addFillerRecording(chosen, label);
          pending = { file: chosen, name: label, recording, assertIdentity };
          imported = pending;
        }
        assert();
        let recording = pending.recording;
        if (context.hosted) {
          feedback.textContent = t('cloudWorking');
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
        feedback.textContent = t(context.hosted ? 'fillerUploaded' : 'fillerAdded');
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
    if (!available() || !connected() || !recording || !confirm(t('confirmRemoveFiller', { name: recording.name }))) return;
    void run(async (transfer, assert) => {
      if (context.hosted) await context.cloud.removeFiller(recording.id, transfer);
      else await removeFillerRecording(recording.id);
      assert();
      recordings = recordings.filter(item => item.id !== recording.id);
      render();
      context.changed();
      feedback.textContent = t('fillerRemoved');
    });
  });
  const audition = async (filler: Filler): Promise<void> => {
    if (disposed || !context.isCurrent() || controller) return;
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
        feedback.textContent = t('fillerPreviewReady');
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
        levelResult.textContent = t('loudnessSuggestion', { lufs: formatNumber(estimate.integratedLufs),
          peak: formatNumber(estimate.peakDbfs), target: formatNumber(estimate.targetLufs),
          db: estimate.recommendedGain === 0 ? '-inf' : formatNumber(20 * Math.log10(estimate.recommendedGain)),
          percent: formatNumber(estimate.recommendedGain * 100), limit: estimate.limited ? t('gainLimited') : '' });
        feedback.textContent = '';
      } catch (error) { levelResult.textContent = ''; throw error; }
    }, true);
  }, true);
  const cancel = iconButton(t('cancelFillerOperation'), X, () => {
    controller?.abort(); feedback.textContent = t('cloudCancelling'); sync();
  });
  const actions = element('div', 'filler-library-actions');
  actions.append(play, stop, analyze, remove);
  const heading = element('div', 'section-heading');
  heading.append(element('h2', '', t('fillerLibrary')), refreshButton, cancel);
  management.append(status, field(t('fillerRecordingName'), name), field(t('fillerFile'), file), add,
    field(t('customFillers'), selection), details, actions, levelResult, progress, feedback);
  const builtins = element('ul', 'filler-builtins');
  for (const sound of ['lofi', 'soft', 'bright', 'drums'] as const) builtins.append(element('li', '', t(sound)));
  root.append(heading, management, element('h3', '', t('builtInFillers')), builtins);
  selection.addEventListener('change', () => { feedback.textContent = ''; levelResult.textContent = ''; sync(); });
  file.addEventListener('change', () => sync());

  function sync(): void {
    if (disposed) return;
    const user = context.hosted ? getCloudContext().user : null;
    const owner = JSON.stringify(user ? [user.id, user.authVersion, user.role] : null);
    if (owner !== identity) {
      identity = owner;
      controller?.abort(); recordings = []; ready.clear(); imported = null;
      file.value = ''; name.value = ''; selection.replaceChildren(); feedback.textContent = '';
      levelResult.textContent = '';
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
    stop.disabled = !context.isCurrent();
    cancel.hidden = !controller;
    cancel.disabled = controller?.signal.aborted ?? false;
    const recording = selected();
    details.textContent = recording ? t('fillerRecordingDetails', { duration: formatTime(recording.duration), id: recording.id }) : '';
  }
  sync();
  return {
    element: root, refresh, sync, audition,
    choices: () => structuredClone(recordings),
    leave: () => { controller?.abort(); if (!controller && imported) void discardImport(imported); },
    dispose: () => {
      disposed = true; controller?.abort(); recordings = []; ready.clear();
      if (!controller && imported) void discardImport(imported);
    },
  };
}