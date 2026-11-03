import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Editor } from '../../editor/Editor';
import { KEY_NAMES } from '../../lib/keyNames';
import { MeetingGlyph, NoteGlyph, SettingsGlyph, StickyGlyph } from '../../overlay/glyphs';
import { Logo } from '../../overlay/icons';
import { Sheet } from '../../sticky/Sheet';
import type { Settings } from '../../store';
import { Icon, Kbd, PageHeader, Section, Tile, TileGroup } from '../../ui';
import { ColumnGroup, ColumnHead } from '../Column';
import { Caret, Desk, Dots, Field } from '../demo/Demo';
import '../../sticky/sticky.css';

// How the app works, on one page, the way TabTasker Business's guides explain a screen: the real parts (the
// overlay's own dots and orb and the desk they sit on, from demo/, the real sticky sheet, the window from the
// shell's own parts with the real editor), each figure in a well with a number in its margin for every part, a straight line and a bracket
// on the part, and the list under it; then every shortcut as it is set right now.
type Side = 'left' | 'right' | 'top' | 'bottom';
type Callout = { target: string; side: Side; at?: number; title: string; text: string };
type Box = { x: number; y: number; w: number; h: number };
type Placed = { badge: { x: number; y: number }; bracket: string; line: string };

const SCREEN: Callout[] = [
  { target: '.demo-typed', side: 'left', title: 'Hold your key and talk', text: 'When you let go, what you said is typed wherever your cursor is. End with “send” to press Return as well.' },
  { target: '.orb', side: 'bottom', title: 'The orb', text: 'While you talk, the dots turn into the orb and show your words as you say them.' },
  { target: '.sticky-band', side: 'right', title: 'Stickies', text: 'Small notes that stay on top of your other windows. Say “sticky” before your words to make one by voice.' },
];
// Every button the pill can hold, in its order (PILL_BUTTONS); Appearance picks which ones it shows.
const DOTS: Callout[] = [
  { target: '.pill button:nth-child(1)', side: 'top', title: 'Speak a note', text: 'Talk for as long as you like, and it’s saved as a note when you stop.' },
  { target: '.pill button:nth-child(2)', side: 'top', title: 'Write a note', text: 'Opens a blank note to type into.' },
  { target: '.pill button:nth-child(3)', side: 'top', title: 'New sticky', text: 'Puts a blank sticky on your screen, on top of your other windows.' },
  { target: '.pill button:nth-child(4)', side: 'top', title: 'Start a meeting', text: 'Records the room or both sides of a call, and works out who said what. With AI connected, you get a summary too.' },
  { target: '.pill button:nth-child(5)', side: 'top', title: 'Your notes', text: 'Opens the window with everything you’ve saved.' },
  { target: '.pill button:nth-child(6)', side: 'top', title: 'Settings', text: 'Opens Settings, where Appearance lets you choose which of these buttons show. You can also drag the dots to another edge, or right-click them for a menu.' },
  { target: '.label > span', side: 'bottom', title: 'The hint', text: 'Shows which key to hold. You can turn it off in Settings › Appearance.' },
];
const WINDOW: Callout[] = [
  { target: '.tabs .tab', side: 'top', at: .3, title: 'Tabs', text: 'Everything opens in its own tab. Press ⌘ T for a new one and ⌘ W to close it.' },
  { target: '.rail', side: 'left', at: .25, title: 'Sidebar', text: 'Switch between notes, meetings and stickies, with Settings at the bottom.' },
  { target: '.column', side: 'left', at: .55, title: 'The list', text: 'Shows what’s in the place you picked, newest first, with search on top.' },
  { target: '.editor-page', side: 'right', at: .3, title: 'The editor', text: 'Type or talk into it. It saves as you go, as a Markdown file in your notes folder.' },
];
const NOTE = 'Call the venue about Thursday and ask for the bigger room. Then send Maria the new floor plan before lunch.\n\n- [ ] Call them\n- [x] Send the plan\n';
const STICKY = 'Call Thomas about the **venue** before 3';
const noop = () => {};

export function HelpView({ settings }: { settings: Settings }) {
  const keys = settings.shortcuts;
  const key = KEY_NAMES[keys.dictate];
  const command = { control: '⌃', option: '⌥', command: '⌘', shift: '⇧', off: '' }[keys.command];
  const chords: [string, string][] = [
    [`Hold ${key}`, 'Dictate into any app'],
    ...(keys.handsFree ? [[`Tap ${key} twice`, 'Dictate hands-free until you tap again'] as [string, string]] : []),
    ...(command ? [[`${key} + ${command}`, 'Give a command or rewrite a selection'] as [string, string]] : []),
    [keys.note?.label ?? 'Not set', 'Start or stop a spoken note'],
    [keys.writeNote?.label ?? 'Not set', 'Write a note'],
    [keys.meeting?.label ?? 'Not set', 'Start or stop a meeting'],
    [keys.sticky?.label ?? 'Not set', 'New sticky'],
    [keys.pasteLast?.label ?? 'Not set', 'Paste the last transcript again'],
    ['⌘ T · ⌘ W', 'Open or close a tab'],
    ['⌘ [ · ⌘ ]', 'Go back or forward'],
    ['⌘ ,', 'Open Settings'],
  ];
  return <>
    <PageHeader icon="help" title="How TabTasker Dictate works">Talk instead of typing, in any app.</PageHeader>
    <Figure title="On your screen" width={760} height={380} callouts={SCREEN}>
      <Desk>
        <Field label="Message to Maria" style={{ left: 48, top: 70, width: 380 }}><p className="demo-typed"><Caret /></p></Field>
        <div className="help-stick" style={{ left: 520, top: 64 }}>
          <Sheet id="help" hue="amber" folded={false} pinned text={STICKY} title="" titled={false} tilt="slight" weight="bold" actions={{ fold: noop, pin: noop, note: noop, close: noop, recolour: noop, retitle: noop, more: noop }}>
            <Editor compact markdown={STICKY} label="A sticky" onChange={noop} />
          </Sheet>
        </div>
        <Dots mode="listening" typing words="Thursday works. Can we take the bigger room?" at={{ left: 48, top: 0, width: 380, height: 380 }} />
      </Desk>
    </Figure>
    <Figure title="When you point at the dots" width={480} height={120} callouts={DOTS}>
      <Desk menubar={false}><Dots mode="hover" hint at={{ left: 0, top: 0, width: 330, height: 120 }} /></Desk>
    </Figure>
    <Figure title="The window" width={1040} height={620} callouts={WINDOW}><MiniWindow /></Figure>
    <Section title="Shortcuts" note="Change them in Settings › Shortcuts.">
      <TileGroup>
        {chords.map(([chord, what]) => <Tile key={what} title={what}><Kbd>{chord}</Kbd></Tile>)}
      </TileGroup>
    </Section>
    <Section title="Set up again">
      <TileGroup>
        <Tile title="Go through setup from the start" detail="Handy if a permission was turned off or something stopped working.">
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
              <span className="list-item" aria-current="true"><span className="t">Call the venue about Thursday</span><span className="d"><span className="when">12:48 PM</span>Call the venue about Thursday and ask for the bigger room. Then send Maria the new floor plan before lunch.</span></span>
              <span className="list-item"><span className="t">Ideas for the launch</span><span className="d"><span className="when">9:10 AM</span>A short video first, then the three screenshots, then the pricing. Ask Sam about the onboarding emails.</span></span>
            </ColumnGroup>
            <ColumnGroup title="Yesterday" count={1}>
              <span className="list-item"><span className="t">Design review</span><span className="d"><span className="when">Yesterday</span>Maria: Yes, I have the big room booked. We should start with the floor plan and then…</span></span>
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
