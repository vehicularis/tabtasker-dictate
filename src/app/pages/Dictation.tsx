import { useEffect, useState } from 'react';
import { invoke, listen } from '../../bridge';
import { SOUNDS, type PageProps } from '../../store';
import { Button, PageHeader, ProgressBar, Section, Select, Slider, Tile, TileGroup, Toggle } from '../../ui';
import './speech.css';

// The languages Whisper knows best, by name; any of its codes works in settings.json.
const LANGUAGES: [string, string][] = [
  ['ar', 'Arabic'], ['az', 'Azerbaijani'], ['bg', 'Bulgarian'], ['bn', 'Bengali'], ['ca', 'Catalan'], ['cs', 'Czech'], ['da', 'Danish'], ['de', 'German'],
  ['el', 'Greek'], ['en', 'English'], ['es', 'Spanish'], ['et', 'Estonian'], ['fa', 'Persian'], ['fi', 'Finnish'], ['fr', 'French'], ['he', 'Hebrew'],
  ['hi', 'Hindi'], ['hr', 'Croatian'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['lt', 'Lithuanian'],
  ['lv', 'Latvian'], ['ms', 'Malay'], ['nl', 'Dutch'], ['no', 'Norwegian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sk', 'Slovak'], ['sl', 'Slovenian'], ['sr', 'Serbian'], ['sv', 'Swedish'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['ur', 'Urdu'],
  ['vi', 'Vietnamese'], ['zh', 'Chinese'],
];
const sorted = [...LANGUAGES].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));

type Model = 'turbo' | 'small';
/// What speech.rs says about the models: the one in use, each one's size and whether it is on this
/// Mac, and the newest download or load, under way or failed.
type Models = {
  active: Model | null; enabled: boolean;
  step: { model: Model; message: string; percent: number | null; failed: boolean } | null;
  models: { model: Model; bytes: number; downloaded: boolean }[];
};
const MODELS: Record<Model, { name: string; detail: string }> = {
  turbo: { name: 'Large-v3 Turbo', detail: 'The most accurate.' },
  small: { name: 'Small', detail: 'Faster and lighter, a little less accurate. Better at translating.' },
};
const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const SOUND_OPTIONS = SOUNDS.map(name => ({ value: name, label: name }));
const percent = (value: number) => `${Math.round(value * 100)}%`;

/// The models, kept current by dictate-model, and asked for again when the choice changes.
function useModels(choice: Model) {
  const [models, setModels] = useState<Models | null>(null);
  useEffect(() => listen<Models>('dictate-model', setModels), []);
  useEffect(() => {
    let live = true;
    void invoke<Models>('speech_models').then(next => { if (live) setModels(next); }).catch(() => {});
    return () => { live = false; };
  }, [choice]);
  return models;
}

export function Dictation({ settings, update }: PageProps) {
  const dictation = settings.dictation;
  const models = useModels(dictation.model);
  const [retrying, setRetrying] = useState(false);
  const options = [{ value: 'auto', label: 'Detect automatically' }, ...sorted];
  if (!options.some(option => option.value === dictation.language)) options.push({ value: dictation.language, label: dictation.language });
  const language = options.find(option => option.value === dictation.language)?.label;

  const step = models?.step?.model === dictation.model ? models.step : null;
  const active = models?.active ?? null;
  // The model still answering while the chosen one gets ready.
  const keeping = active && active !== dictation.model ? MODELS[active].name : null;
  const keep = () => { if (active) void update({ dictation: { model: active } }); };
  const chosen = MODELS[dictation.model];
  const retry = () => { setRetrying(true); void invoke('prepare_model').catch(() => {}).finally(() => setRetrying(false)); };
  // A cue heard at the volume being chosen, so a choice is made by ear.
  const play = (name: string) => invoke('play_sound', { name, volume: dictation.soundVolume }).catch(() => {});

  return <>
    <PageHeader icon="waveform" title="Speech">How your speech becomes text. Whisper runs on this Mac.</PageHeader>
    <Section title="Language">
      <TileGroup>
        <Tile title="Language" detail={dictation.language === 'auto' ? 'Whisper works out the language each time. Pick yours to get the first words right.' : `Whisper always hears ${language}.`}>
          <Select label="Language" value={dictation.language} options={options} onChange={language => update({ dictation: { language } })} />
        </Tile>
        <Tile title="Translate to English" detail="Speak any language, get English.">
          <Toggle label="Translate to English" checked={dictation.translateToEnglish} onChange={translateToEnglish => update({ dictation: { translateToEnglish } })} />
        </Tile>
        {dictation.translateToEnglish && dictation.model === 'turbo' && <Tile title="Small translates better" detail="Large-v3 Turbo isn’t trained to translate, so it often types what you said as you said it.">
          <Button small onClick={() => update({ dictation: { model: 'small' } })}>Use Small</Button>
        </Tile>}
      </TileGroup>
    </Section>
    <Section title="Typing">
      <TileGroup>
        <Tile title="Live typing" detail="Words appear as you speak. Off, they arrive all at once when you let go.">
          <Toggle label="Live typing" checked={dictation.liveTyping} onChange={liveTyping => update({ dictation: { liveTyping } })} />
        </Tile>
        <Tile title="Remove filler words" detail="Leaves out um, uh, er, ah and hmm. “Like” always stays.">
          <Toggle label="Remove filler words" checked={dictation.removeFillers} onChange={removeFillers => update({ dictation: { removeFillers } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Sounds" note="The Mac’s own sounds, played as listening starts and stops.">
      <TileGroup>
        <Tile title="Sounds" detail="A cue when listening starts and another when it stops.">
          <Toggle label="Sounds" checked={dictation.sounds} onChange={sounds => update({ dictation: { sounds } })} />
        </Tile>
        <Tile title="Volume" detail="For both cues." dim={!dictation.sounds}>
          <Slider label="Volume" min={0} max={1} step={0.05} value={dictation.soundVolume} format={percent}
            onChange={soundVolume => { void update({ dictation: { soundVolume } }); }} />
        </Tile>
        <Tile title="Start" detail="As listening begins." dim={!dictation.sounds}>
          <Select label="Start sound" value={dictation.startSound} options={SOUND_OPTIONS} onChange={startSound => { void update({ dictation: { startSound } }); void play(startSound); }} />
          <Button small aria-label="Play the start sound" onClick={() => play(dictation.startSound)}>Play</Button>
        </Tile>
        <Tile title="Stop" detail="As you let go." dim={!dictation.sounds}>
          <Select label="Stop sound" value={dictation.stopSound} options={SOUND_OPTIONS} onChange={stopSound => { void update({ dictation: { stopSound } }); void play(stopSound); }} />
          <Button small aria-label="Play the stop sound" onClick={() => play(dictation.stopSound)}>Play</Button>
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Speech model" note={models && !models.enabled
      ? 'Dictation is paused. The chosen model downloads when you turn it back on.'
      : 'Each model is downloaded once and kept, so switching back needs no download.'}>
      <TileGroup label="Speech model">
        {(['turbo', 'small'] as const).map(model => {
          const file = models?.models.find(one => one.model === model);
          const inUse = active === model;
          return <Tile key={model} title={MODELS[model].name} detail={`${MODELS[model].detail}${file ? ` ${megabytes(file.bytes)}.` : ''}`}>
            {dictation.model === model
              ? <span className="state" data-on={inUse || undefined}>{inUse ? 'In use' : step && !step.failed ? 'Getting ready' : 'Chosen'}</span>
              : inUse
                // Still answering while the chosen one gets ready: the card below offers to keep it.
                ? <span className="state">In use</span>
                : <Button small aria-label={`Use ${MODELS[model].name}`} onClick={() => update({ dictation: { model } })}>{file?.downloaded ? 'Use' : 'Download'}</Button>}
          </Tile>;
        })}
        {step && <Tile title={step.failed ? `${chosen.name} isn’t ready` : `Getting ${chosen.name} ready`} stack>
          <div className="speech-progress" aria-live="polite">
            {step.failed ? <>
              <span className="line" data-failed>{step.message}</span>
              <span className="why">{keeping ? `${keeping} is still in use.` : 'Dictation starts as soon as it is ready.'}</span>
              <span className="actions">
                <Button small variant="primary" disabled={retrying} onClick={retry}>Try again</Button>
                {keeping && <Button small onClick={keep}>Keep {keeping}</Button>}
              </span>
            </> : <>
              <div className="row">
                <span className="line">{step.message}</span>
                {keeping && <Button small variant="quiet" onClick={keep}>Cancel</Button>}
              </div>
              <ProgressBar label={step.message} value={step.percent == null ? null : step.percent / 100} />
              <span className="why">{keeping ? `${keeping} keeps working until ${chosen.name} is ready.` : 'Dictation starts as soon as it is ready.'}</span>
            </>}
          </div>
        </Tile>}
      </TileGroup>
    </Section>
  </>;
}
