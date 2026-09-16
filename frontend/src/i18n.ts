import { enUS } from './locales/en-US';

export type MessageKey = keyof typeof enUS;
export const locale = 'en-US';
const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false });
const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });

export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  return enUS[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => String(values[name] ?? placeholder));
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60);
  return `${integer.format(minutes)}:${integer.format(total % 60).padStart(2, '0')}`;
}

export function formatNumber(value: number): string {
  return decimal.format(value);
}

export function trackCount(count: number): string {
  return t(new Intl.PluralRules(locale).select(count) === 'one' ? 'trackCountOne' : 'trackCountOther', { count });
}

const validationMessages: Record<string, MessageKey> = {
  'Unsupported schema': 'invalidSchema', 'Invalid routine name or ID': 'invalidName',
  'Invalid revision': 'invalidRevision', 'Invalid routine state': 'invalidState',
  'Crossfade must be 0-12 seconds': 'invalidCrossfade', 'Invalid beep timing': 'invalidBeeps',
  'Invalid filler': 'invalidFiller', 'Invalid filler timing': 'invalidFillerTiming', 'Too many tracks': 'tooManyTracks',
  'Invalid filler recording': 'invalidFillerRecording',
  'Track entry IDs must be unique': 'duplicateTracks', 'Invalid track text': 'invalidTrackText',
  'Track duration must be 0-1200 seconds': 'invalidDuration', 'Invalid track beat grid': 'invalidGrid',
  'Cue IDs must be unique': 'duplicateCues', 'Invalid cue note': 'invalidNote', 'Invalid cue kind': 'invalidKind',
  'Cue outside track': 'outsideTrack', 'Invalid cue position': 'invalidPosition',
};

export function validationMessage(message: string): string {
  return validationMessages[message] ? t(validationMessages[message]) : message;
}

const runtimeMessages: Record<string, MessageKey> = {
  routine_conflict: 'routineConflict', routine_not_found: 'routineNotFound',
  invalid_routine: 'invalidRoutine', routine_locked: 'lockedError', unsupported_audio: 'unsupportedAudio',
  audio_byte_limit: 'audioByteLimit', audio_duration_limit: 'audioDurationLimit', audio_memory_limit: 'audioMemoryLimit',
  audio_metadata_timeout: 'audioMetadataTimeout', audio_unavailable: 'audioUnavailable', missing_audio: 'audioMissing',
  audio_decode_timeout: 'audioDecodeTimeout', audio_decoder_busy: 'audioDecoderBusy',
  audio_duration_mismatch: 'audioMismatch', audio_interrupted: 'audioInterrupted', routine_not_ready: 'audioNotReady',
  audio_not_prepared: 'audioNotReady', user_gesture_required: 'gestureRequired', player_disposed: 'playerDisposed',
  beep_interval_too_short: 'beepTooShort',
  invalid_filler_recording: 'invalidFillerRecording', filler_integrity_failed: 'fillerIntegrityFailed',
  conversion_unavailable: 'audioConversionUnavailable', conversion_worker_failed: 'audioConversionFailed',
  conversion_failed: 'audioConversionFailed', conversion_timeout: 'audioConversionTimeout',
  conversion_aborted: 'audioConversionCancelled', conversion_invalid_audio: 'audioConversionInvalid',
  conversion_invalid_output: 'audioConversionInvalid', conversion_protected_audio: 'audioConversionUnsupported',
  conversion_video_not_allowed: 'audioConversionUnsupported', conversion_no_audio: 'audioConversionUnsupported',
  conversion_multiple_audio: 'audioConversionUnsupported', conversion_channel_limit: 'audioMemoryLimit',
  conversion_memory_limit: 'audioMemoryLimit', conversion_duration_limit: 'audioDurationLimit',
  conversion_source_limit: 'audioByteLimit', conversion_output_limit: 'audioByteLimit',
};

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return runtimeMessages[message] ? t(runtimeMessages[message]) : message || t('localFailure');
}