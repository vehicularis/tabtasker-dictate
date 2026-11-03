import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Editor } from '../../editor/Editor';
import { KEY_NAMES } from '../../onboarding/Keyboard';
import { Dock } from '../../overlay/Dock';
import { MeetingGlyph, NoteGlyph, SettingsGlyph, StickyGlyph } from '../../overlay/glyphs';
import { Logo } from '../../overlay/icons';
import { Sheet } from '../../sticky/Sheet';
import { PILL_BUTTONS, type Settings } from '../../store';
import { Icon, Kbd, PageHeader, Section, Tile, TileGroup } from '../../ui';
import { ColumnGroup, ColumnHead } from '../Column';
import '../../overlay/overlay.css';
import '../../sticky/sticky.css';

// How the app works, on one page, the way TabTasker Business's guides explain a screen: the real parts (the
// overlay's own dots and orb, the real sticky sheet, the window from the shell's own parts with the real
// editor), each figure in a well with a number in its margin for every part, a straight line and a bracket
// on the part, and the list under it; then every shortcut as it is set right now.
type Side = 'left' | 'right' | 'top' | 'bottom';
type Callout = { target: string; side: Side; at?: number; title: string; text: string };
type Box = { x: number; y: number; w: number; h: number };
type Placed = { badge: { x: number; y: number }; bracket: string; line: string };

const SCREEN: Callout[] = [
  { target: '.help-typed', side: 'left', title: 'Hold your key and talk', text: 'Talk, then let go. Your words go in where the cursor is, in any app. Say “send” to press Return.' },
  { target: '.orb', side: 'bottom', title: 'The orb', text: 'While you hold the key, the dots become the orb and write out what you say. Your words go in when you let go.' },
  { target: '.sticky-bar', side: 'right', title: 'Stickies', text: 'Small notes that stay on top. Make one from the window, the menu, a shortcut, or by saying “sticky: call Thomas”.' },
];
// Every button the pill can hold, in its order (PILL_BUTTONS); Appearance picks which ones it shows.
const DOTS: Callout[] = [
  { target: '.pill button:nth-child(1)', side: 'top', title: 'Speak a note', text: 'Click and talk for as long as you like. When you stop, it is saved and opens in the window.' },
  { target: '.pill button:nth-child(2)', side: 'top', title: 'Write a note', text: 'A new note in the window, to type into.' },
  { target: '.pill button:nth-child(3)', side: 'top', title: 'A sticky', text: 'A new sticky on the screen.' },
  { target: '.pill button:nth-child(4)', side: 'top', title: 'A meeting', text: 'Records the room and, on a call, the other side, and tells the voices apart. A connected model writes the summary.' },
  { target: '.pill button:nth-child(5)', side: 'top', title: 'Your notes', text: 'Opens the window with your notes, meetings and stickies.' },
  { target: '.pill button:nth-child(6)', side: 'top', title: 'Settings', text: 'Everything else. Right-click the dots for the menu, or drag them to another edge of the screen. Pick the buttons under Settings › Appearance.' },
  { target: '.label > span', side: 'bottom', title: 'Your key', text: 'Which key to hold. Turn this hint off under Appearance.' },
];
const WINDOW: Callout[] = [
  { target: '.tabs .tab', side: 'top', at: .3, title: 'Tabs', text: 'Notes, meetings and stickies open as tabs. ⌘ T for a new one, ⌘ W to close it.' },
  { target: '.rail', side: 'left', at: .25, title: 'The rail', text: 'Your notes, meetings and stickies, with the settings at its foot.' },
  { target: '.column', side: 'left', at: .55, title: 'The list', text: 'What is in the place you picked, newest first, with search at the top.' },
  { target: '.editor-page', side: 'right', at: .3, title: 'The editor', text: 'Type or talk into it. It saves as you go, to a Markdown file in your notes folder.' },
];
const NOTE = 'Call the venue about Thursday and ask for the bigger room. Then send Maria the new floor plan before lunch.\n\n- [ ] Call them\n- [x] Send the plan\n';
const STICKY = 'Call Thomas about the **venue** before 3';
const noop = () => {};

export function HelpView({ settings }: { settings: Settings }) {
  const keys = settings.shortcuts;
  const key = KEY_NAMES[keys.dictate];
  const command = { control: '⌃', option: '⌥', command: '⌘', shift: '⇧', off: '' }[keys.command];
  const chords: [string, string][] = [
    [`Hold ${key}`, 'Type with your voice where the cursor is'],
    ...(keys.handsFree ? [[`Tap ${key} twice`, 'Hands-free: keep listening until you tap again'] as [string, string]] : []),
    ...(command ? [[`${key} + ${command}`, 'Give a spoken command, or rewrite the selected text'] as [string, string]] : []),
    [keys.note?.label ?? 'Not set', 'Speak a note, or stop it'],
    [keys.writeNote?.label ?? 'Not set', 'A new note in the window, to type into'],
    [keys.meeting?.label ?? 'Not set', 'Start or stop a meeting'],
    [keys.sticky?.label ?? 'Not set', 'A new sticky'],
    [keys.pasteLast?.label ?? 'Not set', 'Paste the last transcript again'],
    ['⌘ T · ⌘ W', 'A new tab · close the tab'],
    ['⌘ [ · ⌘ ]', 'Back · forward, in the tab'],
    ['⌘ ,', 'Settings'],
  ];
  return <>
    <PageHeader icon="help" title="How TabTasker Dictate works">Talk instead of typing, in any app. Your speech becomes text on this Mac and stays here.</PageHeader>
    <Figure title="On your screen" width={760} height={380} callouts={SCREEN}>
      <div className="help-desk">
        <div className="help-menubar"><Logo size={13} /><time>Mon 2 Nov 09:41</time></div>
        <div className="help-field" style={{ left: 48, top: 70, width: 380 }}>
          <span className="help-field-label">Message to Maria</span>
          <p className="help-typed"><i className="help-caret" /></p>
        </div>
        <div className="help-stick" style={{ left: 520, top: 64 }}>
          <Sheet hue="amber" folded={false} pinned text={STICKY} picking={false} onPicking={noop} actions={{ recolour: noop, fold: noop, pin: noop, note: noop, close: noop }}>
            <Editor compact markdown={STICKY} label="A sticky" onChange={noop} />
          </Sheet>
        </div>
        <Dots mode="listening" typing words="Thursday works. Can we take the bigger room?" at={{ left: 48, top: 0, width: 380, height: 380 }} />
      </div>
    </Figure>
    <Figure title="The dots, when you point at them" width={480} height={120} callouts={DOTS}>
      <div className="help-desk"><Dots mode="hover" hint at={{ left: 0, top: 0, width: 330, height: 120 }} /></div>
    </Figure>
    <Figure title="The window" width={1040} height={620} callouts={WINDOW}><MiniWindow /></Figure>
    <Section title="Shortcuts" note="Change them in Settings › Shortcuts.">
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

const TICK = 3, GAP = 4, SPLIT = 8; // a bracket's ticks, its gap from the part, and the least room between two side by side

/// Where each number and its bracket go, in the well's pixels, as Business's GuideFigure places them: a number
/// in the margin on its callout's side, level with its part (at its `at`) and pushed along that margin where
/// it would overlap the one before; a straight line from it to the nearest point of the part's bracket.
/// `screen` is where the scaled screen sits in the well.
function place(parts: (Box | null)[], callouts: Callout[], { width, screen, gutter, top, size }: { width: number; screen: Box; gutter: number; top: number; size: number }): (Placed | null)[] {
  const sides = callouts.map(c => c.side);
  const across = (i: number) => sides[i] === 'top' || sides[i] === 'bottom';
  // Parts end to end on one edge (two buttons in a row) would join into one long bracket: pull their facing ends apart.
  for (const [i, a] of parts.entries()) for (const [j, b] of parts.entries()) {
    if (!a || !b || sides[j] !== sides[i]) continue;
    const [start, length] = across(i) ? (['x', 'w'] as const) : (['y', 'h'] as const);
    const gap = b[start] - (a[start] + a[length]);
    const side = sides[i];
    const edge = side === 'top' ? a.y - b.y : side === 'bottom' ? a.y + a.h - b.y - b.h : side === 'left' ? a.x - b.x : a.x + a.w - b.x - b.w;
    if (Math.abs(edge) >= 1 || gap < 0 || gap >= SPLIT) continue;
    const pull = Math.min((SPLIT - gap) / 2, a[length] / 4, b[length] / 4);
    a[length] -= pull; b[start] += pull; b[length] -= pull;
  }
  const along = parts.map((p, i) => p ? (across(i) ? p.x + p.w * (callouts[i].at ?? .5) : p.y + p.h * (callouts[i].at ?? .5)) : 0);
  const at = [...along];
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    let previous = -Infinity;
    for (const i of parts.map((_, i) => i).filter(i => parts[i] && sides[i] === side).sort((a, b) => along[a] - along[b])) {
      at[i] = Math.max(along[i], previous + size + GAP);
      previous = at[i];
    }
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return parts.map((p, i) => {
    if (!p) return null;
    const c = at[i];
    if (sides[i] === 'top' || sides[i] === 'bottom') {
      const down = sides[i] === 'bottom';
      const by = down ? p.y + p.h + GAP : p.y - GAP, tick = down ? -TICK : TICK;
      const badgeY = down ? screen.y + screen.h + top / 2 : top / 2;
      return { badge: { x: c, y: badgeY }, bracket: `M${p.x} ${by + tick}V${by}H${p.x + p.w}V${by + tick}`, line: `M${c} ${badgeY + (down ? -size / 2 : size / 2)}L${clamp(c, p.x, p.x + p.w)} ${by}` };
    }
    const left = sides[i] === 'left';
    const bx = left ? p.x - GAP : p.x + p.w + GAP, inward = left ? TICK : -TICK;
    const badge = { x: left ? gutter / 2 : width - gutter / 2, y: c };
    return { badge, bracket: `M${bx + inward} ${p.y}H${bx}V${p.y + p.h}H${bx + inward}`, line: `M${badge.x + (left ? size / 2 : -size / 2)} ${c}L${bx} ${clamp(c, p.y, p.y + p.h)}` };
  });
}

/// One annotated screen: `children` drawn at `width` × `height` and scaled to the column, numbers in the margin.
/// The parts are measured where they land (after the fonts, the editors and the pill's entrance have settled),
/// so the brackets stay on them at any width.
function Figure({ title, width: W, height: H, callouts, children }: { title: string; width: number; height: number; callouts: Callout[]; children: ReactNode }) {
  const well = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [boxes, setBoxes] = useState<(Box | null)[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const small = width > 0 && width < 560;
  const gutter = small ? 20 : 30, top = small ? 24 : 34, size = small ? 16 : 22;
  const foot = callouts.some(c => c.side === 'bottom') ? top : gutter / 2;
  const scale = width ? (width - 2 * gutter) / W : 0;
  const screen = { x: gutter, y: top, w: W * scale, h: H * scale };
  useEffect(() => {
    const el = well.current;
    if (!el) return;
    const watcher = new ResizeObserver(([entry]) => setWidth(entry.borderBoxSize[0].inlineSize));
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = well.current;
    if (!el || !scale) return;
    const measure = () => {
      const origin = el.getBoundingClientRect(), right = screen.x + screen.w, bottom = screen.y + screen.h;
      setBoxes(callouts.map(c => {
        const rects = [...el.querySelectorAll(`.help-stage ${c.target}`)].map(part => part.getBoundingClientRect()).filter(r => r.width && r.height);
        if (!rects.length) return null;
        // Cut to the screen: a list that runs on past the window's foot is bracketed only as far as it shows.
        const x = Math.max(screen.x, Math.min(...rects.map(r => r.left)) - origin.left), y = Math.max(screen.y, Math.min(...rects.map(r => r.top)) - origin.top);
        return { x, y, w: Math.min(right, Math.max(...rects.map(r => r.right)) - origin.left) - x, h: Math.min(bottom, Math.max(...rects.map(r => r.bottom)) - origin.top) - y };
      }));
    };
    measure();
    void document.fonts.ready.then(measure);
    const later = [setTimeout(measure, 400), setTimeout(measure, 1200)];
    return () => later.forEach(clearTimeout);
  }, [scale]); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = scale ? place(boxes.map(b => b && { ...b }), callouts, { width, screen, gutter, top, size }) : [];
  const dim = (i: number) => active !== null && active !== i || undefined;
  const hover = (i: number) => ({ onMouseEnter: () => setActive(i), onMouseLeave: () => setActive(null) });
  return <figure className="help-figure">
    <div ref={well} className="help-well" data-small={small || undefined} style={{ padding: `${top}px ${gutter}px ${foot}px` }}>
      <div className="help-screen" style={{ aspectRatio: `${W} / ${H}` }}>
        {scale > 0 && <div className="help-stage" inert aria-hidden="true" style={{ width: W, height: H, transform: `scale(${scale})` }}>{children}</div>}
      </div>
      <svg className="help-marks" aria-hidden="true">
        {placed.map((p, i) => p && <g key={i} data-active={active === i || undefined} data-dim={dim(i)}><path d={p.bracket} /><path d={p.line} /></g>)}
      </svg>
      {placed.map((p, i) => p && <b key={i} className="help-marker" aria-hidden="true" data-dim={dim(i)} style={{ left: p.badge.x, top: p.badge.y }} {...hover(i)}>{i + 1}</b>)}
    </div>
    <figcaption>
      <p className="help-figure-title">{title}</p>
      <ol className="help-callouts">
        {callouts.map((c, i) => <li key={c.target} {...hover(i)}><b className="help-marker">{i + 1}</b><span><strong>{c.title}.</strong> {c.text}</span></li>)}
      </ol>
    </figcaption>
  </figure>;
}

/// The window: the shell's own parts and the real editor, with the traffic lights drawn in (the Mac draws the real ones).
function MiniWindow() {
  return <div className="help-mini">
    <div className="window">
      <header className="titlebar">
        <span className="help-lights"><i /><i /><i /></span>
        <span className="bar-tools"><span className="bar-tool" aria-pressed="true"><Icon name="sidebar" size={16} /></span><span className="bar-tool" style={{ opacity: .4 }}><Icon name="chevronLeft" size={16} /></span><span className="bar-tool" style={{ opacity: .4 }}><Icon name="chevronRight" size={16} /></span></span>
        <div className="tabs">
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
            <li><span className="rail-item" aria-current="page"><NoteGlyph size={24} /></span></li>
            <li><span className="rail-item"><MeetingGlyph size={24} /></span></li>
            <li><span className="rail-item"><StickyGlyph size={24} /></span></li>
          </ul>
          <ul className="rail-group rail-foot"><li><span className="rail-item"><SettingsGlyph size={24} /></span></li></ul>
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

/// The real dots, in a layer of their own: the pill they open into (with the hint), or the orb while you talk (`typing`: its cursor).
function Dots({ mode, hint = false, typing = false, words = '', at }: { mode: 'hover' | 'listening'; hint?: boolean; typing?: boolean; words?: string; at: CSSProperties }) {
  const dots = useRef<HTMLButtonElement>(null);
  const level = useRef({ current: 0.4 }).current;
  useEffect(() => {
    if (mode !== 'listening') return;
    const timer = setInterval(() => { level.current = 0.2 + Math.random() * 0.6; }, 110);
    return () => clearInterval(timer);
  }, [mode, level]);
  return <div className="layer" data-edge="bottom" data-mode={mode} aria-hidden="true" style={at}>
    <div className="dock">
      <Dock mode={mode} menu={null} dots={dots} label="TabTasker Dictate" hint={hint} hintShown={hint} quiet={false} level={level} typing={typing} words={words} recording={false}
        buttons={PILL_BUTTONS} onHover={noop} onMenu={noop} onGrab={noop} onDots={noop} onNote={noop} onWrite={noop} onSticky={noop} onMeeting={noop} onOpen={noop} onSettings={noop} onOrb={noop} />
    </div>
  </div>;
}
