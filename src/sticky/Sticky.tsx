import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '../bridge';
import { STICKY_HUES, type Sticky as Record, type StickyHue } from '../store';
import { Icon } from '../ui/Icon';
import { Editor } from '../editor/Editor';

const id = new URLSearchParams(location.search).get('id') ?? '';
const HUES = Object.keys(STICKY_HUES) as StickyHue[];
/// The page's local "YYYY-MM-DD HH.mm", as a note's stamp is written.
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };
const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
/// A sticky's first line, as words: for the folded bar.
const firstLine = (text: string) => text.split('\n').map(line => line.replace(/^#+\s*|^[-*]\s+(\[[ x]\]\s*)?/g, '').replace(/[*_`]/g, '').trim()).find(Boolean) ?? '';

// One sticky, in its own small window, drawn as TabTasker Business draws a sticker: paper in the hue,
// ink from the hue, a thin bar to drag it by. The bar holds one swatch (its colour; click for the others),
// then fold (the bar alone, its first words showing), pin (on top of everything, or behind other windows
// like any window), make a note, close. The words are the Text editor, compact; hold the dictate key with
// them focused to talk into them. Saved as they are typed.
export function Sticky() {
  const [sticky, setSticky] = useState<Record | null>(null);
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { void invoke<Record>('sticky_get', { id }).then(found => { setSticky(found); setText(found.text); }, () => setProblem('This sticky is gone.')); }, []);
  useEffect(() => { if (!picking) return; const away = () => setPicking(false); addEventListener('pointerdown', away, { capture: true }); return () => removeEventListener('pointerdown', away, { capture: true }); }, [picking]);
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest('.sticky-menu')) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    addEventListener('pointerdown', away, { capture: true }); addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', away, { capture: true }); removeEventListener('keydown', key); };
  }, [menu]);
  const edit = (next: string) => {
    setText(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void invoke('sticky_update', { id, text: next }).catch(error => setProblem(message(error, 'Couldn’t keep that.'))); }, 350);
  };
  const change = (patch: Partial<Record>, work: Promise<unknown>) => { setSticky(current => current && { ...current, ...patch }); void work.catch(error => setProblem(message(error, 'Couldn’t change that.'))); };
  const recolour = (hue: StickyHue) => { setPicking(false); change({ hue }, invoke('sticky_update', { id, hue })); };
  const fold = () => sticky && change({ folded: !sticky.folded }, invoke('sticky_fold', { id, folded: !sticky.folded }));
  const pin = () => sticky && change({ pinned: !sticky.pinned }, invoke('sticky_pin', { id, pinned: !sticky.pinned }));
  const close = () => { clearTimeout(timer.current); void invoke('sticky_remove', { id }).catch(() => {}); };
  const toNote = () => {
    clearTimeout(timer.current); setProblem(null);
    void invoke('sticky_update', { id, text }).then(() => invoke('sticky_to_note', { id, stamp: stamp() })).catch(error => setProblem(message(error, 'Couldn’t save it as a note.')));
  };
  const hue = sticky?.hue ?? 'amber';
  const folded = !!sticky?.folded;
  const item = (label: string, run: () => void, extra?: { disabled?: boolean; checked?: boolean }) => <button type="button" role={extra?.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={extra?.checked} disabled={extra?.disabled} onClick={() => { setMenu(null); run(); }}>{extra?.checked !== undefined && <span className="tick">{extra.checked ? '✓' : ''}</span>}{label}</button>;
  return <div className="sticky" data-folded={folded || undefined} style={{ '--hue': STICKY_HUES[hue] } as CSSProperties}
    onContextMenu={event => { event.preventDefault(); setPicking(false); setMenu({ x: Math.min(event.clientX, innerWidth - 190), y: Math.min(event.clientY, innerHeight - 10) }); }}>
    <header className="sticky-bar" data-tauri-drag-region onDoubleClick={fold}>
      <span className="sticky-swatch-wrap">
        <button type="button" className="sticky-swatch" aria-label={`Colour: ${hue}. Change it`} aria-expanded={picking} title="Colour" onPointerDown={event => event.stopPropagation()} onClick={() => setPicking(open => !open)} />
        {picking && <span className="sticky-palette" role="radiogroup" aria-label="Colour" onPointerDown={event => event.stopPropagation()}>
          {HUES.map(one => <button key={one} type="button" role="radio" aria-checked={one === hue} aria-label={one} className="sticky-hue" style={{ '--hue': STICKY_HUES[one] } as CSSProperties} onClick={() => recolour(one)} />)}
        </span>}
      </span>
      {folded && <span className="sticky-peek" data-tauri-drag-region>{firstLine(text) || 'Empty sticky'}</span>}
      <span className="sticky-tools">
        <button type="button" className="sticky-tool" title={folded ? 'Open it up' : 'Fold to its bar'} aria-label={folded ? 'Open the sticky up' : 'Fold the sticky to its bar'} onClick={fold}><Icon name={folded ? 'chevronDown' : 'chevronUp'} size={14} /></button>
        <button type="button" className="sticky-tool" data-on={sticky?.pinned || undefined} title={sticky?.pinned ? 'On top of everything. Click to let other windows cover it' : 'Behind other windows. Click to keep it on top'} aria-label={sticky?.pinned ? 'Let other windows cover it' : 'Keep on top of everything'} aria-pressed={!!sticky?.pinned} onClick={pin}><Icon name={sticky?.pinned ? 'pin' : 'pinOff'} size={14} /></button>
        <button type="button" className="sticky-tool" title="Save as a note" aria-label="Save as a note" disabled={!text.trim()} onClick={toNote}><Icon name="note" size={14} /></button>
        <button type="button" className="sticky-tool" title="Close" aria-label="Close this sticky" onClick={close}><Icon name="close" size={12} /></button>
      </span>
    </header>
    {sticky && !folded && <Editor key={sticky.id} compact markdown={sticky.text} label="Sticky" placeholder="Type, or hold fn and talk" autoFocus={!sticky.text} onChange={edit} />}
    {problem && !folded && <p className="sticky-problem" role="alert">{problem}</p>}
    {menu && <div className="sticky-menu" role="menu" aria-label="Sticky" style={{ left: menu.x, top: menu.y }}>
      <div className="sticky-menu-hues" role="group" aria-label="Colour">
        {HUES.map(one => <button key={one} type="button" role="menuitemradio" aria-checked={one === hue} aria-label={one} className="sticky-hue" style={{ '--hue': STICKY_HUES[one] } as CSSProperties} onClick={() => { setMenu(null); recolour(one); }} />)}
      </div>
      <i className="sticky-menu-rule" role="separator" />
      {item(folded ? 'Open it up' : 'Fold to its bar', () => fold())}
      {item('Keep on top of everything', () => pin(), { checked: !!sticky?.pinned })}
      <i className="sticky-menu-rule" role="separator" />
      {item('Save as a note', toNote, { disabled: !text.trim() })}
      {item('Close', close)}
    </div>}
  </div>;
}
