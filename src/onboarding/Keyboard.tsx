import type { DictateKey } from '../store';

/// How each dictate key reads in a sentence and on a key cap.
export const KEY_NAMES: Record<DictateKey, string> = { fn: 'fn', rightCommand: 'right ⌘', rightOption: 'right ⌥', rightControl: 'right ⌃', rightShift: 'right ⇧' };

/// The globe that shares the fn key, in the current text colour.
export const Globe = ({ size = 12 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
  <circle cx="10" cy="10" r="7.25" /><ellipse cx="10" cy="10" rx="3.1" ry="7.25" /><path d="M2.75 10h14.5" />
</svg>;

type Cap = { top?: string; bottom?: string; key?: DictateKey; size?: 'wide' | 'space' | 'arrows' };
const mod = (top: string, bottom: string, key?: DictateKey, size?: 'wide'): Cap => ({ top, bottom, key, size });
const ROWS: Cap[][] = [
  [mod('⇧', 'shift', undefined, 'wide'), ...[...'ZXCVBNM,./'].map(top => ({ top })), mod('⇧', 'shift', 'rightShift', 'wide')],
  [mod('fn', '', 'fn'), mod('⌃', 'control'), mod('⌥', 'option'), mod('⌘', 'command', undefined, 'wide'), { size: 'space' },
    mod('⌘', 'command', 'rightCommand', 'wide'), mod('⌥', 'option', 'rightOption'), { size: 'arrows' }],
];
const RIGHT_CONTROL = mod('⌃', 'control', 'rightControl');

/// The bottom of a Mac keyboard: the chosen key is ringed, and lit while it is held. Apple's keyboards
/// have the arrow keys after right ⌥; right ⌃ is drawn there only when it is the key, as on an external one.
export function Keyboard({ chosen, down }: { chosen: DictateKey; down: boolean }) {
  return <div className="keyboard" aria-hidden="true">
    {ROWS.map((row, i) => <div key={i} className="key-row">
      {row.map((cap, j) => cap.size === 'arrows' && chosen !== 'rightControl'
        ? <span key={j} className="arrows"><i className="cap">◀</i><span><i className="cap">▲</i><i className="cap">▼</i></span><i className="cap">▶</i></span>
        : <Key key={j} cap={cap.size === 'arrows' ? RIGHT_CONTROL : cap} chosen={chosen} down={down} />)}
    </div>)}
  </div>;
}

function Key({ cap, chosen, down }: { cap: Cap; chosen: DictateKey; down: boolean }) {
  return <i className="cap" data-size={cap.size} data-letter={(!cap.bottom && cap.key !== 'fn') || undefined}
    data-chosen={cap.key === chosen || undefined} data-down={(cap.key === chosen && down) || undefined}>
    {cap.top && <b>{cap.top}</b>}{cap.key === 'fn' ? <span><Globe size={10} /></span> : cap.bottom && <span>{cap.bottom}</span>}
  </i>;
}
