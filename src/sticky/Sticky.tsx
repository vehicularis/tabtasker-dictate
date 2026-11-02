import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '../bridge';
import { STICKY_HUES, type Sticky as Record, type StickyHue } from '../store';
import { Icon } from '../ui/Icon';

const id = new URLSearchParams(location.search).get('id') ?? '';
const HUES = Object.keys(STICKY_HUES) as StickyHue[];
/// The page's local "YYYY-MM-DD HH.mm", as a note's stamp is written.
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };
const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;

// One sticky, in its own small window: a colour bar to drag it by (and recolour it), its words, saved as
// they are typed, and two ways out: as a note in the notes folder, or gone. Hold the dictate key with the
// words focused to talk into it.
export function Sticky() {
  const [sticky, setSticky] = useState<Record | null>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { void invoke<Record>('sticky_get', { id }).then(found => { setSticky(found); setText(found.text); }, () => setProblem('This sticky is gone.')); }, []);
  const edit = (next: string) => {
    setText(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void invoke('sticky_update', { id, text: next }).catch(error => setProblem(message(error, 'Couldn’t keep that.'))); }, 350);
  };
  const recolour = (hue: StickyHue) => { setSticky(current => current && { ...current, hue }); void invoke('sticky_update', { id, hue }).catch(() => {}); };
  const close = () => { clearTimeout(timer.current); void invoke('sticky_remove', { id }).catch(() => {}); };
  const toNote = () => {
    clearTimeout(timer.current); setProblem(null);
    void invoke('sticky_update', { id, text }).then(() => invoke('sticky_to_note', { id, stamp: stamp() })).catch(error => setProblem(message(error, 'Couldn’t save it as a note.')));
  };
  const hue = sticky?.hue ?? 'amber';
  return <div className="sticky" style={{ '--hue': STICKY_HUES[hue] } as CSSProperties}>
    <header className="sticky-bar" data-tauri-drag-region>
      <span className="sticky-hues" role="radiogroup" aria-label="Colour">
        {HUES.map(one => <button key={one} type="button" role="radio" aria-checked={one === hue} aria-label={one} className="sticky-hue" style={{ '--hue': STICKY_HUES[one] } as CSSProperties} onClick={() => recolour(one)} />)}
      </span>
      <span className="sticky-tools">
        <button type="button" className="sticky-tool" title="Save as a note" aria-label="Save as a note" disabled={!text.trim()} onClick={toNote}><Icon name="note" size={14} /></button>
        <button type="button" className="sticky-tool" title="Close" aria-label="Close this sticky" onClick={close}><Icon name="close" size={12} /></button>
      </span>
    </header>
    <textarea className="sticky-text" aria-label="Sticky" value={text} placeholder="Type, or hold fn and talk" autoFocus spellCheck onChange={event => edit(event.target.value)} />
    {problem && <p className="sticky-problem" role="alert">{problem}</p>}
  </div>;
}
