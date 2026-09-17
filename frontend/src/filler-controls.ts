import type { Filler, FillerRecording } from '../../shared/routine';
import { formatNumber, t } from './i18n';
import { element, field, gainSlider, numberInput, selectInput } from './ui';
import { getFillerSoundBpm, getFillerSoundDuration } from './filler-audio';

export function fillerSoundLabel(filler: Filler): string {
  const name = filler.sound === 'recording' ? filler.recording?.name ?? t('customFillers') : t(filler.sound);
  try { return t('soundDuration', { name, seconds: formatNumber(getFillerSoundDuration(filler)) }); }
  catch { return name; }
}

export function fillerControls(filler: Filler, recordings: () => FillerRecording[], changed: () => void,
  editable: () => boolean, held = false): HTMLElement {
  const fields = element('fieldset', 'field-grid');
  fields.disabled = !editable();
  const mutate = (change: () => void) => { if (editable()) { change(); sync(); changed(); } };
  const mode = selectInput(filler.mode, (held ? ['hold'] as const : ['none', 'timed', 'hold'] as const)
    .map(value => ({ value, label: t(value) })), value => mutate(() => { filler.mode = value; }));
  const duration = numberInput(filler.seconds, 0, 600, value => { if (filler.mode === 'timed') mutate(() => { filler.seconds = value; }); });
  const bpm = numberInput(filler.bpm, 40, 220, value => mutate(() => { filler.bpm = value; }));
  const choices = [...recordings()];
  if (filler.recording && !choices.some(value => value.id === filler.recording!.id)) choices.push(filler.recording);
  const sound = selectInput<string>(filler.recording ? `recording:${filler.recording.id}` : filler.sound,
    [...(['lofi', 'soft', 'bright', 'drums'] as const).map(value => ({ value, label: fillerSoundLabel({ ...filler, sound: value, recording: undefined }) })),
      ...choices.map(recording => ({ value: `recording:${recording.id}`, label: fillerSoundLabel({ ...filler, sound: 'recording', recording }) }))], value => mutate(() => {
      const recording = choices.find(item => `recording:${item.id}` === value);
      if (recording) { filler.sound = 'recording'; filler.recording = structuredClone(recording); }
      else if (['lofi', 'soft', 'bright', 'drums'].includes(value)) {
        filler.sound = value as Filler['sound']; delete filler.recording;
      }
    }));
  const gain = gainSlider(t('fillerGain'), () => filler.gain ?? 1, value => mutate(() => { filler.gain = value; }), editable);
  const sync = () => {
    duration.readOnly = filler.mode === 'hold'; duration.disabled = filler.mode === 'none';
    duration.value = filler.mode === 'hold' ? '' : String(filler.seconds); duration.required = filler.mode === 'timed';
    bpm.disabled = ['recording', 'lofi'].includes(filler.sound) || filler.mode === 'none';
    if (['recording', 'lofi'].includes(filler.sound)) { const known = getFillerSoundBpm(filler); bpm.value = known === undefined ? '' : String(known); }
    else bpm.value = String(filler.bpm);
    sound.disabled = filler.mode === 'none';
    gain.sync();
    for (const option of Array.from(sound.options ?? [])) {
      const recording = choices.find(value => `recording:${value.id}` === option.value);
      option.textContent = fillerSoundLabel({ ...filler, sound: recording ? 'recording' : option.value as Filler['sound'], recording });
    }
  };
  fields.append(field(t('fillerMode'), mode), field(t('fillerSound'), sound), field(t('fillerDuration'), duration),
    field(t('fillerBpm'), bpm), gain.element);
  sync();
  return fields;
}