import type { Chord, CommandKey, DictateKey, PageProps } from '../../store';
import { KeyRecorder, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';

const KEYS: { value: DictateKey; label: string }[] = [
  { value: 'fn', label: 'fn' }, { value: 'rightCommand', label: 'Right ⌘ Command' }, { value: 'rightOption', label: 'Right ⌥ Option' },
  { value: 'rightControl', label: 'Right ⌃ Control' }, { value: 'rightShift', label: 'Right ⇧ Shift' },
];
const MODIFIERS: { value: CommandKey; label: string }[] = [
  { value: 'control', label: '⌃ Control' }, { value: 'option', label: '⌥ Option' }, { value: 'command', label: '⌘ Command' }, { value: 'shift', label: '⇧ Shift' }, { value: 'off', label: 'Off' },
];

type ChordName = 'note' | 'meeting' | 'pasteLast';
const CHORDS: [ChordName, string][] = [['note', 'Start or stop a note'], ['meeting', 'Start or stop a meeting'], ['pasteLast', 'Paste last transcript']];

export function Shortcuts({ settings, update }: PageProps) {
  const keys = settings.shortcuts;
  const record = (name: ChordName) => async (chord: Chord | null) => (await update({ shortcuts: { [name]: chord } }))?.shortcuts[name];
  return <>
    <PageHeader icon="keyboard" title="Shortcuts">The key you hold to talk, and shortcuts for everything else.</PageHeader>
    <Section title="Dictate">
      <TileGroup>
        <Tile title="Hold to talk" detail="Hold it and speak; your words type where the cursor is.">
          <Select label="Hold to talk" value={keys.dictate} options={KEYS} onChange={dictate => update({ shortcuts: { dictate } })} />
        </Tile>
        <Tile title="Hands-free" detail="Double-tap the key to keep listening. Tap again to send, or press Escape to cancel.">
          <Toggle label="Hands-free" checked={keys.handsFree} onChange={handsFree => update({ shortcuts: { handsFree } })} />
        </Tile>
        <Tile title="Talk to Claude" detail="Hold this with the dictate key to give Claude a command.">
          <Select label="Talk to Claude" value={keys.command} options={MODIFIERS} onChange={command => update({ shortcuts: { command } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Anywhere on your Mac" note="Click a shortcut, then press the keys. Escape cancels; Delete clears it.">
      <TileGroup>
        {CHORDS.map(([name, title]) => <Tile key={name} title={title}>
          <KeyRecorder label={title} value={keys[name]} onChange={record(name)}
            taken={CHORDS.filter(([other]) => other !== name).map(([other, otherTitle]) => ({ name: otherTitle, chord: keys[other] }))} />
        </Tile>)}
      </TileGroup>
    </Section>
  </>;
}
