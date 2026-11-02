import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { listen } from '../../bridge';
import { Globe } from '../../overlay/icons';
import { MODIFIERS as FLAGS, useStatus, type Chord, type CommandKey, type DictateKey, type PageProps, type Settings, type Status } from '../../store';
import { chordOf, Icon, Kbd, KeyRecorder, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';
import './shortcuts.css';

type Key = { value: DictateKey; name: string; glyph: string; code?: string };
// In the order the arrow keys go through them. `code` is the browser's name for the key; fn has none.
const KEYS: Key[] = [
  { value: 'fn', name: 'fn', glyph: 'fn' },
  { value: 'rightCommand', name: 'Right Command', glyph: 'right ⌘', code: 'MetaRight' },
  { value: 'rightOption', name: 'Right Option', glyph: 'right ⌥', code: 'AltRight' },
  { value: 'rightControl', name: 'Right Control', glyph: 'right ⌃', code: 'ControlRight' },
  { value: 'rightShift', name: 'Right Shift', glyph: 'right ⇧', code: 'ShiftRight' },
];
const keyOf = (value: DictateKey) => KEYS.find(key => key.value === value) ?? KEYS[0];

type Modifier = Exclude<CommandKey, 'off'>;
const MODIFIER: Record<Modifier, { glyph: string; codes: string[] }> = {
  control: { glyph: '⌃', codes: ['ControlLeft', 'ControlRight'] }, option: { glyph: '⌥', codes: ['AltLeft', 'AltRight'] },
  command: { glyph: '⌘', codes: ['MetaLeft', 'MetaRight'] }, shift: { glyph: '⇧', codes: ['ShiftLeft', 'ShiftRight'] },
};
const COMMAND_KEYS: { value: CommandKey; label: string }[] = [
  { value: 'control', label: '⌃ Control' }, { value: 'option', label: '⌥ Option' }, { value: 'command', label: '⌘ Command' }, { value: 'shift', label: '⇧ Shift' }, { value: 'off', label: 'Off' },
];

type ChordName = 'note' | 'meeting' | 'pasteLast';
const CHORDS: [ChordName, string][] = [['note', 'Start or stop a note'], ['meeting', 'Start or stop a meeting'], ['pasteLast', 'Paste last transcript']];

// Shortcuts a chord must not take: macOS's own, by the names System Settings gives them, then the ones
// nearly every app has. The app reports which of macOS's are on, with any the person added; a browser
// has only this list.
const { control: CTRL, option: OPT, shift: SHIFT, command: CMD } = FLAGS;
const MACOS: [number, number, string][] = [
  [49, CMD, 'Spotlight'], [49, CMD | OPT, 'Finder search'], [49, CTRL, 'Input sources'], [49, CTRL | OPT, 'Input sources'], [49, CTRL | CMD, 'Emoji & Symbols'],
  [48, CMD, 'Switching apps'], [48, CMD | SHIFT, 'Switching apps'], [50, CMD, 'Switching windows'],
  [20, CMD | SHIFT, 'Screenshots'], [21, CMD | SHIFT, 'Screenshots'], [23, CMD | SHIFT, 'Screenshots'], [20, CTRL | CMD | SHIFT, 'Screenshots'], [21, CTRL | CMD | SHIFT, 'Screenshots'],
  [12, CTRL | CMD, 'Lock Screen'], [12, CMD | SHIFT, 'Log Out'], [53, CMD | OPT, 'Force Quit'], [2, CMD | OPT, 'Show or hide the Dock'],
  [126, CTRL, 'Mission Control'], [125, CTRL, 'App windows'], [123, CTRL, 'Switching spaces'], [124, CTRL, 'Switching spaces'],
];
const APPS: [number, number, string][] = [
  [0, CMD, 'Select All'], [8, CMD, 'Copy'], [9, CMD, 'Paste'], [7, CMD, 'Cut'], [6, CMD, 'Undo'], [6, CMD | SHIFT, 'Redo'], [12, CMD, 'Quit'], [13, CMD, 'Close'],
  [4, CMD, 'Hide'], [4, CMD | OPT, 'Hide Others'], [46, CMD, 'Minimize'], [45, CMD, 'New'], [31, CMD, 'Open'], [35, CMD, 'Print'], [1, CMD, 'Save'],
  [17, CMD, 'New Tab'], [17, CMD | SHIFT, 'Reopen Closed Tab'], [15, CMD, 'Reload'], [37, CMD, 'Open Location'], [3, CMD, 'Find'], [5, CMD, 'Find Next'],
  [11, CMD, 'Bold'], [34, CMD, 'Italic'], [40, CMD, 'Add Link'], [43, CMD, 'Settings'], [3, CTRL | CMD, 'Full screen'],
];
type Taken = { name: string; chord: Chord; reason?: string };
const taken = ([keyCode, modifiers, name]: [number, number, string]): Taken => ({ name, chord: { keyCode, modifiers, label: name } });
function reserved(status: Status | null): Taken[] {
  const live = (status as (Status & { systemShortcuts?: [number, number][] }) | null)?.systemShortcuts;
  // One the person added in System Settings has no name here.
  const system = ([keyCode, modifiers]: [number, number]): Taken => {
    const name = MACOS.find(([k, m]) => k === keyCode && m === modifiers)?.[2];
    return name ? taken([keyCode, modifiers, name]) : { ...taken([keyCode, modifiers, 'macOS']), reason: 'macOS already uses this shortcut' };
  };
  const macos = live ? live.map(system) : MACOS.map(taken);
  return [...macos, ...APPS.map(taken)];
}

export function Shortcuts({ settings, update }: PageProps) {
  const keys = settings.shortcuts;
  const key = keyOf(keys.dictate);
  const [status] = useStatus();
  const down = useKeyDown();
  const system = reserved(status);
  const record = (name: ChordName) => async (chord: Chord | null) => (await update({ shortcuts: { [name]: chord } }))?.shortcuts[name];
  const claude = keys.command === 'off' ? null : !settings.claude.enabled ? <>Needs Claude. <a className="link" href="#claude">Connect Claude</a></>
    : !settings.claude.commands ? <>Commands are off. <a className="link" href="#claude">Claude settings</a></> : null;
  const aside = keys.dictate === 'fn' ? 'Pressed with another key, fn still does what it always did.'
    : keys.dictate === 'rightControl' ? 'Mac laptops have no right Control key, so this one needs an external keyboard.'
    : 'Typing with it still works: pressed with another key, it is a shortcut, not dictation.';
  return <>
    <PageHeader icon="keyboard" title="Shortcuts">The key you hold to talk, and shortcuts for everything else.</PageHeader>
    <Section title="Dictate">
      <TileGroup>
        <Tile stack title="Key to hold" detail={<>Hold <Kbd>{key.glyph}</Kbd> and speak: your words type where the cursor is. {aside}</>}>
          <KeyPicker value={keys.dictate} down={down} onChange={dictate => void update({ shortcuts: { dictate } })} />
        </Tile>
        <Tile title="Hands-free" detail={<>Double-tap <Kbd>{key.glyph}</Kbd> to keep listening without holding it, for up to a minute. Tap it again to send, or press Escape to cancel.</>}>
          <Toggle label="Hands-free" checked={keys.handsFree} onChange={handsFree => void update({ shortcuts: { handsFree } })} />
        </Tile>
        <Tile title="Talk to Claude" detail={keys.command === 'off' ? <>Off. Choose a key to hold with <Kbd>{key.glyph}</Kbd> to talk to Claude.</>
          : <>Hold this with <Kbd>{key.glyph}</Kbd> and say what to do with the selected text, or ask a question. {claude}</>}>
          <Select label="Talk to Claude" value={keys.command} options={COMMAND_KEYS} onChange={command => void update({ shortcuts: { command } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Anywhere on your Mac" note={status && !status.accessibility
      ? <>These need Accessibility, which is off. <a className="link" href="#general">Turn it on in General</a>.</>
      : 'Click a shortcut, then press the keys. Escape cancels; Delete clears it.'}>
      <TileGroup>
        {CHORDS.map(([name, title]) => <Tile key={name} title={title}>
          <KeyRecorder label={title} value={keys[name]} onChange={record(name)}
            taken={[...CHORDS.filter(([other]) => other !== name).map(([other, otherTitle]) => ({ name: otherTitle, chord: keys[other] })), ...system]} />
        </Tile>)}
      </TileGroup>
    </Section>
    <Section title="Try it" note="Press any of them now to see it light up. Holding the key here dictates for real.">
      <Tester settings={settings} status={status} down={down} />
    </Section>
  </>;
}

/// The dictate key, held or not, as the app hears it: dictate-fn follows the chosen key.
function useKeyDown() {
  const [down, setDown] = useState(false);
  useEffect(() => listen<{ down: boolean }>('dictate-fn', ({ down }) => setDown(down)), []);
  return down;
}

type Cap = { glyph: ReactNode; name?: ReactNode; grow?: number; key?: DictateKey };
// The bottom corner of a Mac keyboard, with the right Control of a full-size one.
const ROWS: Cap[][] = [
  [{ glyph: '⇧', name: 'shift', grow: 2.25 }, ...[...'ZXCVBNM,./'].map(letter => ({ glyph: letter })), { glyph: '⇧', name: 'shift', grow: 2.75, key: 'rightShift' }],
  [{ glyph: 'fn', name: <Globe />, grow: 1.1, key: 'fn' }, { glyph: '⌃', name: 'control', grow: 1.5 }, { glyph: '⌥', name: 'option', grow: 1.5 }, { glyph: '⌘', name: 'command', grow: 2 },
    { glyph: '', grow: 4.3 }, { glyph: '⌘', name: 'command', grow: 2, key: 'rightCommand' }, { glyph: '⌥', name: 'option', grow: 1.5, key: 'rightOption' }, { glyph: '⌃', name: 'control', grow: 1.5, key: 'rightControl' }],
];

/// The picture is the picker: the five keys that can be held are radio buttons, and arrows move between them.
function KeyPicker({ value, down, onChange }: { value: DictateKey; down: boolean; onChange: (key: DictateKey) => void }) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: ReactKeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = KEYS.findIndex(key => key.value === value);
    const next = KEYS[(at + step + KEYS.length) % KEYS.length].value;
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus();
  };
  const cap = ({ glyph, name, grow = 1, key }: Cap, i: number) => {
    const face = name ? <><span className="glyph">{glyph}</span><span className="name">{name}</span></> : glyph;
    const style = { flexGrow: grow };
    if (!key) return <span key={i} className={`cap${name ? '' : ' plain'}`} style={style}>{face}</span>;
    const chosen = key === value;
    return <button key={i} type="button" role="radio" className="cap" style={style} data-key={key} aria-checked={chosen} aria-label={keyOf(key).name}
      tabIndex={chosen ? 0 : -1} data-down={(chosen && down) || undefined} onClick={() => onChange(key)}>{face}</button>;
  };
  return <div className="key-picker">
    <div ref={group} className="keyboard" role="radiogroup" aria-label="Key to hold" onKeyDown={move}>
      {ROWS.map((row, i) => <div key={i} className="row">{row.map(cap)}</div>)}
    </div>
    <p className="key-caption"><span>{keyOf(value).name}</span><span className="state" data-on={down || undefined}>{down ? 'Held' : 'Not held'}</span></p>
  </div>;
}

/// The keys down in this window, by the browser's code for each.
function useCodes() {
  const [codes, setCodes] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const change = (event: KeyboardEvent) => setCodes(now => {
      const pressed = event.type === 'keydown';
      if (pressed === now.has(event.code)) return now;
      const next = new Set(now);
      if (pressed) next.add(event.code); else next.delete(event.code);
      return next;
    });
    const clear = () => setCodes(new Set());
    addEventListener('keydown', change); addEventListener('keyup', change); addEventListener('blur', clear);
    return () => { removeEventListener('keydown', change); removeEventListener('keyup', change); removeEventListener('blur', clear); };
  }, []);
  return codes;
}

/// Each way in, lit while it is pressed and ticked once heard. The hold and the double tap come from the
/// app's own key monitor; the command modifier and the chords from this window, since the app leaves
/// chords pressed in Settings to the page.
function Tester({ settings, status, down }: { settings: Settings; status: Status | null; down: boolean }) {
  const keys = settings.shortcuts;
  const key = keyOf(keys.dictate);
  const codes = useCodes();
  const [flash, setFlash] = useState<string | null>(null);
  const [heard, setHeard] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState('');
  const hear = (id: string, title: string) => { setHeard(now => now.has(id) ? now : new Set(now).add(id)); setSaid(`${title} works`); };
  const light = (id: string, title: string) => { setFlash(id); hear(id, title); };
  useEffect(() => { if (!flash) return; const timer = setTimeout(() => setFlash(null), 900); return () => clearTimeout(timer); }, [flash]);

  // A double tap by the app's own rule: each press under 0.25 s, the two presses within 0.35 s.
  const taps = useRef({ downAt: 0, tapAt: -1 });
  useEffect(() => {
    const now = performance.now(), t = taps.current;
    if (down) { t.downAt = now; hear('hold', 'Hold to talk'); return; }
    if (!t.downAt) return;
    if (now - t.downAt >= 250) t.tapAt = -1;
    else if (t.tapAt >= 0 && t.downAt - t.tapAt <= 350) { t.tapAt = -1; if (keys.handsFree) light('double', 'Hands-free'); }
    else t.tapAt = t.downAt;
  }, [down]);

  const modifier = keys.command === 'off' ? null : MODIFIER[keys.command];
  const commandOff = !modifier ? 'Off' : !settings.claude.enabled ? 'Needs Claude' : !settings.claude.commands ? 'Off' : undefined;
  const command = !commandOff && !!modifier && down && modifier.codes.some(code => code !== key.code && codes.has(code));
  const chordOff = status && !status.accessibility ? 'Needs Accessibility' : undefined;
  useEffect(() => { if (command) hear('command', 'Talk to Claude'); }, [command]);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const chord = chordOf(event as unknown as ReactKeyboardEvent);
      const match = chord && !event.repeat && CHORDS.find(([name]) => keys[name]?.keyCode === chord.keyCode && keys[name]?.modifiers === chord.modifiers);
      if (match && !chordOff) light(match[0], match[1]);
    };
    addEventListener('keydown', press);
    return () => removeEventListener('keydown', press);
  }, [keys, chordOff]);

  const rows: { id: string; title: string; keys: string[]; on: boolean; off?: string }[] = [
    { id: 'hold', title: 'Hold to talk', keys: [key.glyph], on: down },
    { id: 'double', title: 'Hands-free', keys: [key.glyph, key.glyph], on: flash === 'double', off: keys.handsFree ? undefined : 'Off' },
    { id: 'command', title: 'Talk to Claude', keys: modifier ? [modifier.glyph, key.glyph] : [key.glyph], on: command, off: commandOff },
    ...CHORDS.map(([name, title]) => ({ id: name, title, keys: keys[name] ? [keys[name]!.label] : [], on: flash === name, off: keys[name] ? chordOff : 'Not set' })),
  ];
  return <>
    <TileGroup label="Shortcut tester">
      {rows.map(row => <div key={row.id} className="ui-tile tester" data-on={row.on || undefined} data-off={!!row.off || undefined}>
        <div className="what"><span className="title">{row.title}</span></div>
        <div className="control">
          {row.keys.length > 0 && <span className="chips">{row.keys.map((glyph, i) => <Kbd key={i}>{glyph}</Kbd>)}</span>}
          <span className="heard">{row.off ?? (heard.has(row.id) ? <><Icon name="check" size={14} />Works</> : 'Not tried')}</span>
        </div>
      </div>)}
    </TileGroup>
    <p className="sr" aria-live="polite">{said}</p>
  </>;
}
