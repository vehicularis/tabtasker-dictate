import { KEY_NAMES } from '../../onboarding/Keyboard';
import { LibraryGlyph, MeetingGlyph, NoteGlyph, SettingsGlyph } from '../../overlay/glyphs';
import type { Settings } from '../../store';
import { Icon, Kbd, PageHeader, Section, Tile, TileGroup } from '../../ui';

// How the app works, on one page: a mock of the Mac with the dots, a sticky and the window, each part on a
// wire to a numbered note, as TabTasker Business explains itself on its public pages; then the parts in
// order, and every shortcut as it is set right now.
type Callout = { n: number; at: [number, number]; label: [number, number]; title: string; text: string };
const W = 720, H = 360;
const CALLOUTS: Callout[] = [
  { n: 1, at: [420, 318], label: [84, 300], title: 'Hold your key and talk', text: 'Your words type where the cursor is, in any app. Let go and the last words are settled. Say “send” to press Return.' },
  { n: 2, at: [393, 286], label: [84, 232], title: 'The dots', text: 'Point at them for a note, a meeting, your notes and the settings. Right-click for the menu. Drag them to another edge.' },
  { n: 3, at: [556, 318], label: [600, 252], title: 'A note, spoken', text: 'Click the note on the dots and talk for as long as you like. When you stop, it is saved and opens in the window.' },
  { n: 4, at: [595, 118], label: [600, 56], title: 'Stickies', text: 'Small notes that stay on top. Make one from the window, the menu, a shortcut, or by saying “sticky: call Thomas”.' },
  { n: 5, at: [250, 110], label: [84, 56], title: 'The window', text: 'Your notes, meetings and stickies, the one you pick open in the editor beside its list. Settings at the foot of the rail.' },
  { n: 6, at: [313, 177], label: [84, 148], title: 'Meetings and agents', text: 'A meeting records the room and, on a call, the other side, and names each person. A connected model writes the summary.' },
];

export function HelpView({ settings }: { settings: Settings }) {
  const keys = settings.shortcuts;
  const key = KEY_NAMES[keys.dictate];
  const command = { control: '⌃', option: '⌥', command: '⌘', shift: '⇧', off: '' }[keys.command];
  const chords: [string, string][] = [
    [`Hold ${key}`, 'Type with your voice where the cursor is'],
    ...(keys.handsFree ? [[`Tap ${key} twice`, 'Hands-free: keep listening until you tap again'] as [string, string]] : []),
    ...(command ? [[`${key} + ${command}`, 'Give a spoken command, or rewrite the selected text'] as [string, string]] : []),
    [keys.note?.label ?? '—', 'Start or stop a spoken note'],
    [keys.writeNote?.label ?? '—', 'A new note in the window, to type into'],
    [keys.meeting?.label ?? '—', 'Start or stop a meeting'],
    [keys.sticky?.label ?? '—', 'A new sticky'],
    [keys.pasteLast?.label ?? '—', 'Paste the last transcript again'],
    ['⌘ ,', 'Settings'],
  ];
  return <>
    <PageHeader icon="help" title="How TabTasker Dictate works">Talk instead of typing, anywhere on your Mac. Everything is transcribed here and kept here; a model, if you connect one, works under the hood.</PageHeader>
    <figure className="help-scene" style={{ aspectRatio: `${W} / ${H}` }} aria-label="A Mac with TabTasker Dictate: the window, a sticky, the dots and an app being typed into">
      <div className="help-desk">
        <div className="help-menubar"><span className="help-otter"><span /></span><i /><i /><i /></div>
        <div className="help-window" style={{ left: '22%', top: '14%', width: '48%', height: '58%' }}>
          <div className="help-strip"><i /><i /><i /></div>
          <div className="help-rail"><b /><b /><b /><hr /><b /><b /></div>
          <div className="help-list"><u /><u /><u className="on" /><u /></div>
          <div className="help-editor"><h4 /><p /><p /><p className="short" /><p /><p className="short" /></div>
        </div>
        <div className="help-app" style={{ left: '46%', top: '76%', width: '40%', height: '18%' }}><p /><p className="caret" /></div>
        <div className="help-sticky" style={{ left: '74%', top: '20%' }}><i /><p /><p className="short" /></div>
        <div className="help-pill" style={{ left: '48%', top: '74%' }}>
          <span className="help-dots"><i /><i /><i /></span>
          <span className="help-pill-buttons"><b><NoteGlyph size={16} /></b><b><MeetingGlyph size={16} /></b><b><LibraryGlyph size={16} /></b><b><SettingsGlyph size={16} /></b></span>
        </div>
        <div className="help-orb" style={{ left: '75%', top: '82%' }}><i /><i /><i /><i /></div>
      </div>
      <svg className="help-wires" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {CALLOUTS.map(c => <g key={c.n}>
          <path d={`M${c.label[0] + (c.label[0] < W / 2 ? 86 : -6)} ${c.label[1] + 10} C ${(c.label[0] + c.at[0]) / 2} ${c.label[1] + 10}, ${(c.label[0] + c.at[0]) / 2} ${c.at[1]}, ${c.at[0]} ${c.at[1]}`} />
          <circle cx={c.at[0]} cy={c.at[1]} r="3.5" />
        </g>)}
      </svg>
      {CALLOUTS.map(c => <span key={c.n} className="help-tag" style={{ left: `${c.label[0] / W * 100}%`, top: `${c.label[1] / H * 100}%` }}><b>{c.n}</b>{c.title}</span>)}
    </figure>
    <ol className="help-steps">
      {CALLOUTS.map(c => <li key={c.n}><b>{c.n}</b><div><strong>{c.title}</strong><p>{c.text}</p></div></li>)}
    </ol>
    <Section title="Shortcuts" note="Change any of them under Settings › General.">
      <TileGroup>
        {chords.map(([chord, what]) => <Tile key={what} title={what}><Kbd>{chord}</Kbd></Tile>)}
      </TileGroup>
    </Section>
    <Section title="Set up again">
      <TileGroup>
        <Tile title="Permissions, your key, the speech model" detail="One step at a time, with what the Mac says right now.">
          <button type="button" className="ui-button" onClick={() => { location.hash = 'setup'; }}><Icon name="general" size={15} />Open setup</button>
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
