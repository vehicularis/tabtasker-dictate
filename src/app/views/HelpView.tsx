import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Editor } from '../../editor/Editor';
import { KEY_NAMES } from '../../onboarding/Keyboard';
import { Dock } from '../../overlay/Dock';
import { Logo } from '../../overlay/icons';
import { Sheet } from '../../sticky/Sheet';
import type { Settings } from '../../store';
import { Icon, Kbd, PageHeader, Section, Tile, TileGroup } from '../../ui';
import { ColumnGroup, ColumnHead } from '../Column';
import '../../overlay/overlay.css';
import '../../sticky/sticky.css';

// How the app works, on one page: the app itself on a Mac, at a smaller size but the real thing (the
// window from the shell's own parts with the real editor; the real sticky sheet; the real dots, pill and
// orb from the overlay), each part on a wire to a numbered note, as TabTasker Business explains itself on
// its public pages; then the parts in order, and every shortcut as it is set right now. The wires are
// measured from where the parts land, so they stay on them at any width.
type Callout = { n: number; title: string; text: string; target: string; side: 'left' | 'right'; y: number };
const W = 720, H = 440;
const CALLOUTS: Callout[] = [
  { n: 1, side: 'right', y: 272, target: '[data-help="orb"] .orb', title: 'Hold your key and talk', text: 'Your words type where the cursor is, in any app. Let go and the last words are settled. Say “send” to press Return.' },
  { n: 2, side: 'left', y: 352, target: '[data-help="pill"] .pill', title: 'The dots', text: 'Point at them for a note, a meeting, your notes and the settings. Right-click for the menu. Drag them to another edge.' },
  { n: 3, side: 'left', y: 262, target: '[data-help="pill"] .pill button:first-child', title: 'A note, spoken', text: 'Click the note on the dots and talk for as long as you like. When you stop, it is saved and opens in the window.' },
  { n: 4, side: 'right', y: 36, target: '[data-help="sticky"] .sticky-bar', title: 'Stickies', text: 'Small notes that stay on top. Make one from the window, the menu, a shortcut, or by saying “sticky: call Thomas”.' },
  { n: 5, side: 'left', y: 56, target: '[data-help="tabs"] .tab', title: 'The window', text: 'Your notes, meetings and stickies, each a tab if you like; the one you pick opens in the editor beside its list. Settings at the foot of the rail.' },
  { n: 6, side: 'left', y: 158, target: '[data-help="meetings"]', title: 'Meetings and agents', text: 'A meeting records the room and, on a call, the other side, and names each person. A connected model writes the summary.' },
];
const NOTE = 'Call the venue about Thursday and ask for the bigger room. Then send Maria the new floor plan before lunch.\n\n- [ ] Call them\n- [x] Send the plan\n';
const STICKY = 'Call Thomas about the **venue** before 3';
const noop = () => {};
type Wire = { n: number; d: string; x: number; y: number };

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
    ['⌘ T · ⌘ W', 'A new tab · close the tab'],
    ['⌘ [ · ⌘ ]', 'Back · forward, in the tab'],
    ['⌘ ,', 'Settings'],
  ];
  const scene = useRef<HTMLElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  useLayoutEffect(() => {
    const el = scene.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      if (!box.width) return;
      const sx = W / box.width, sy = H / box.height;
      setWires(CALLOUTS.flatMap(c => {
        const tag = el.querySelector<HTMLElement>(`[data-tag="${c.n}"]`), target = el.querySelector<HTMLElement>(c.target);
        if (!tag || !target) return [];
        const t = tag.getBoundingClientRect(), g = target.getBoundingClientRect();
        const x0 = ((c.side === 'left' ? t.right : t.left) - box.left) * sx, y0 = (t.top + t.height / 2 - box.top) * sy;
        const x1 = (g.left + g.width / 2 - box.left) * sx, y1 = (g.top + g.height / 2 - box.top) * sy;
        return [{ n: c.n, x: x1, y: y1, d: `M${x0} ${y0} C ${(x0 + x1) / 2} ${y0}, ${(x0 + x1) / 2} ${y1}, ${x1} ${y1}` }];
      }));
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    const later = [setTimeout(measure, 300), setTimeout(measure, 1200)]; // once the editors and fonts have settled
    return () => { watcher.disconnect(); later.forEach(clearTimeout); };
  }, []);
  return <>
    <PageHeader icon="help" title="How TabTasker Dictate works">Talk instead of typing, anywhere on your Mac. Everything is transcribed here and kept here; a model, if you connect one, works under the hood.</PageHeader>
    <figure ref={scene} className="help-scene" style={{ aspectRatio: `${W} / ${H}` }} aria-label="A Mac with TabTasker Dictate: the window, a sticky, the dots and an app being typed into">
      <div className="help-desk">
        <div className="help-menubar"><span className="help-otter"><span /></span><i /><i /><i /></div>
        <MiniWindow />
        <div className="help-stick" data-help="sticky" style={{ left: '77%', top: '15%' }}>
          <Sheet hue="amber" folded={false} pinned text={STICKY} picking={false} onPicking={noop} actions={{ recolour: noop, fold: noop, pin: noop, note: noop, close: noop }}>
            <Editor compact markdown={STICKY} label="A sticky" onChange={noop} />
          </Sheet>
        </div>
        <div className="help-app" style={{ left: '62%', top: '72%', width: '34%', height: '22%' }}><p /><p className="caret" /></div>
        <Dots mode="hover" hint at={{ left: '18%', top: '74%', width: '38%', height: '22%' }} name="pill" />
        <Dots mode="listening" at={{ left: '66%', top: '72%', width: '24%', height: '24%' }} name="orb" />
      </div>
      <svg className="help-wires" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {wires.map(w => <g key={w.n}><path d={w.d} /><circle cx={w.x} cy={w.y} r="3.5" /></g>)}
      </svg>
      {CALLOUTS.map(c => <span key={c.n} className="help-tag" data-tag={c.n} style={{ [c.side]: '1.6%', top: `${c.y / H * 100}%` }}><b>{c.n}</b>{c.title}</span>)}
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

/// The window, at less than half size: the shell's own parts and the real editor, with the traffic
/// lights drawn in (the Mac draws the real ones).
function MiniWindow() {
  return <div className="help-mini" data-help="window" aria-hidden="true" style={{ left: '16%', top: '9%' }}>
    <div className="window">
      <header className="titlebar">
        <span className="help-lights"><i /><i /><i /></span>
        <span className="bar-tools"><span className="bar-tool" aria-pressed="true"><Icon name="sidebar" size={16} /></span><span className="bar-tool" style={{ opacity: .4 }}><Icon name="chevronLeft" size={16} /></span><span className="bar-tool" style={{ opacity: .4 }}><Icon name="chevronRight" size={16} /></span></span>
        <div className="tabs" data-help="tabs">
          <div className="tab" aria-selected="true"><span className="tab-select"><Icon name="note" size={16} /><span className="tab-title">Call the venue</span></span></div>
          <div className="tab" aria-selected="false"><span className="tab-select"><Icon name="meeting" size={16} /><span className="tab-title">Design review</span></span></div>
          <span className="bar-tool"><Icon name="plus" size={16} /></span>
        </div>
        <span className="bar-end"><span className="titlebar-help"><Icon name="help" size={16} /><span>Help</span></span></span>
      </header>
      <div className="row">
        <nav className="rail">
          <span className="rail-brand"><Logo size={28} /></span>
          <ul className="rail-group">
            <li><span className="rail-item" aria-current="page"><Icon name="note" size={18} /></span></li>
            <li><span className="rail-item" data-help="meetings"><Icon name="meeting" size={18} /></span></li>
            <li><span className="rail-item"><Icon name="sticky" size={18} /></span></li>
          </ul>
          <ul className="rail-group rail-foot"><li><span className="rail-item"><Icon name="general" size={18} /></span></li></ul>
        </nav>
        <aside className="column">
          <ColumnHead title="Notes" action={<span className="ui-button quiet only-icon"><Icon name="compose" size={16} /></span>} />
          <label className="search column-search"><Icon name="search" size={15} /><input type="search" readOnly placeholder="Search notes" aria-label="Search notes" /></label>
          <div className="column-scroll">
            <ColumnGroup title="Today" count={2}>
              <span className="list-item" aria-current="true"><span className="t">Call the venue about Thursday</span><span className="x">Call the venue about Thursday and ask for the bigger room. Then send Maria the new floor plan before lunch.</span><span className="m">12:48 · 42 words</span></span>
              <span className="list-item"><span className="t">Ideas for the launch</span><span className="x">A short video first, then the three screenshots, then the pricing. Ask Sam about the onboarding emails.</span><span className="m">09:10 · 310 words</span></span>
            </ColumnGroup>
            <ColumnGroup title="Yesterday" count={1}>
              <span className="list-item"><span className="t">Design review</span><span className="x">Maria 00:00:09 Yes, I have the big room booked. We should start with the floor plan and then…</span><span className="m">14:49 · 1,240 words</span></span>
            </ColumnGroup>
          </div>
        </aside>
        <main className="content">
          <div className="editor-pane">
            <div className="editor-top"><span className="file">Note · 2026-11-02 Call the venue.md</span><span className="note-state" data-state="saved">Saved</span></div>
            <div className="editor-page">
              <input className="note-title" readOnly value="Call the venue about Thursday" aria-label="Title" />
              <Editor markdown={NOTE} label="A note" onChange={noop} />
            </div>
          </div>
        </main>
      </div>
    </div>
  </div>;
}

/// The real dots, in a layer of their own: the pill they open into (with the hint), or the orb while you talk.
function Dots({ mode, hint = false, at, name }: { mode: 'hover' | 'listening'; hint?: boolean; at: CSSProperties; name: string }) {
  const dots = useRef<HTMLButtonElement>(null);
  const level = useRef({ current: 0.4 }).current;
  useEffect(() => {
    if (mode !== 'listening') return;
    const timer = setInterval(() => { level.current = 0.2 + Math.random() * 0.6; }, 110);
    return () => clearInterval(timer);
  }, [mode, level]);
  return <div className="layer" data-edge="bottom" data-mode={mode} data-help={name} aria-hidden="true" style={at}>
    <div className="dock">
      <Dock mode={mode} menu={null} dots={dots} label="TabTasker Dictate" hint={hint} quiet={false} level={level} typing={false} words="" recording={false}
        onHover={noop} onMenu={noop} onGrab={noop} onDots={noop} onNote={noop} onMeeting={noop} onOpen={noop} onSettings={noop} onOrb={noop} />
    </div>
  </div>;
}
