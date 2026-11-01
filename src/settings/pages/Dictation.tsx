import type { PageProps } from '../../store';
import { PageHeader, Section, Segmented, Select, Tile, TileGroup, Toggle } from '../../ui';

// The languages Whisper knows best, by name; any of its codes works in settings.json.
const LANGUAGES: [string, string][] = [
  ['ar', 'Arabic'], ['bg', 'Bulgarian'], ['bn', 'Bengali'], ['ca', 'Catalan'], ['cs', 'Czech'], ['da', 'Danish'], ['de', 'German'], ['el', 'Greek'],
  ['en', 'English'], ['es', 'Spanish'], ['fa', 'Persian'], ['fi', 'Finnish'], ['fr', 'French'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['hr', 'Croatian'],
  ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ms', 'Malay'], ['nl', 'Dutch'], ['no', 'Norwegian'],
  ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['sk', 'Slovak'], ['sl', 'Slovenian'], ['sr', 'Serbian'], ['sv', 'Swedish'],
  ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['vi', 'Vietnamese'], ['zh', 'Chinese'],
];
const sorted = [...LANGUAGES].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));

export function Dictation({ settings, update }: PageProps) {
  const dictation = settings.dictation;
  const options = [{ value: 'auto', label: 'Detect automatically' }, ...sorted];
  if (!options.some(option => option.value === dictation.language)) options.push({ value: dictation.language, label: dictation.language });
  return <>
    <PageHeader icon="waveform" title="Dictation">How your speech becomes text. Whisper runs on this Mac.</PageHeader>
    <Section title="Language">
      <TileGroup>
        <Tile title="Language" detail="Pick yours to skip detection and get it right from the first word.">
          <Select label="Language" value={dictation.language} options={options} onChange={language => update({ dictation: { language } })} />
        </Tile>
        <Tile title="Translate to English" detail="Speak any language, type English.">
          <Toggle label="Translate to English" checked={dictation.translateToEnglish} onChange={translateToEnglish => update({ dictation: { translateToEnglish } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Typing">
      <TileGroup>
        <Tile title="Live typing" detail="Words appear as you speak. Off, they arrive all at once when you let go.">
          <Toggle label="Live typing" checked={dictation.liveTyping} onChange={liveTyping => update({ dictation: { liveTyping } })} />
        </Tile>
        <Tile title="Remove filler words" detail="Leaves out um, uh and er.">
          <Toggle label="Remove filler words" checked={dictation.removeFillers} onChange={removeFillers => update({ dictation: { removeFillers } })} />
        </Tile>
        <Tile title="Sounds" detail="A soft sound when listening starts and stops.">
          <Toggle label="Sounds" checked={dictation.sounds} onChange={sounds => update({ dictation: { sounds } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Speech model" note="Both models stay on this Mac; switching keeps the other for later.">
      <TileGroup>
        <Tile title="Model" detail={dictation.model === 'turbo' ? 'Whisper large-v3 Turbo: the most accurate.' : 'Whisper small: faster and lighter, a little less accurate.'}>
          <Segmented label="Model" value={dictation.model} options={[{ value: 'turbo', label: 'Turbo' }, { value: 'small', label: 'Small' }]} onChange={model => update({ dictation: { model } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
