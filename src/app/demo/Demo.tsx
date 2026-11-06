import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Dock } from '../../overlay/Dock';
import { Logo } from '../../overlay/icons';
import { PILL_BUTTONS } from '../../api/types';
import '../../overlay/overlay.css';
import './demo.css';

// The overlay's real parts on a picture of a screen, shared by Help's figures and setup's stage: a desktop
// with its menu bar, a text field in some other app, and the real dots (the Dock, its pill and its orb) set
// in a layer of their own, pinned where the picture puts them rather than to the screen.
const noop = () => {};

/// A desktop: the wallpaper and, unless `menubar` is false, the menu bar with Dictate's icon in it.
export function Desk({ menubar = true, children }: { menubar?: boolean; children?: ReactNode }) {
  return <div className="demo-desk">
    {menubar && <div className="demo-menubar"><Logo size={13} /><time>Mon 2 Nov 09:41</time></div>}
    {children}
  </div>;
}

/// A text field in some other app, its label over it and the words going in at its cursor (`children`).
export const Field = ({ label, style, children }: { label: string; style?: CSSProperties; children: ReactNode }) =>
  <div className="demo-field" style={style}><span className="demo-field-label">{label}</span>{children}</div>;

export const Caret = () => <i className="demo-caret" />;

type Mode = 'idle' | 'hover' | 'listening' | 'thinking';

/// The real dots: the pill they open into (with the key's hint, kept up, if `hint`), or the orb while
/// you talk (`typing`: its cursor writing `words`). `loading` is the model getting ready, `children` what comes
/// out of the dots above them (a card, a bubble), and `still` keeps the voice level from moving, for reduced motion.
export function Dots({ mode, hint = false, typing = false, words = '', loading = false, still = false, at, children }: {
  mode: Mode; hint?: boolean; typing?: boolean; words?: string; loading?: boolean; still?: boolean; at: CSSProperties; children?: ReactNode;
}) {
  const dots = useRef<HTMLButtonElement>(null);
  const level = useRef({ current: 0.4 }).current;
  useEffect(() => {
    if (mode !== 'listening' || still) return;
    const timer = setInterval(() => { level.current = 0.2 + Math.random() * 0.6; }, 110);
    return () => clearInterval(timer);
  }, [mode, level, still]);
  return <div className="layer demo-dots" data-edge="bottom" data-mode={mode} data-loading={loading || undefined} aria-hidden="true" style={at}>
    <div className="dock">
      {children}
      <Dock mode={mode} menu={null} dots={dots} label="TabTasker | Dictate" hint={hint} hintShown={hint} quiet={false} level={level} typing={typing} words={words} recording={false}
        buttons={PILL_BUTTONS} onHover={noop} onMenu={noop} onGrab={noop} onDots={noop} onNote={noop} onWrite={noop} onSticky={noop} onMeeting={noop} onOpen={noop} onSettings={noop} onOrb={noop} />
    </div>
  </div>;
}
