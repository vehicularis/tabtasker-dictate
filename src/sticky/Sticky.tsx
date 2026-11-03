import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '../bridge';
import { leave, reduced, timing } from '../ui/motion';
import { STICKY_HUES, useSettings, type Sticky as Record, type StickyHue } from '../store';
import { KEY_NAMES } from '../overlay/Dock';
import { Editor } from '../editor/Editor';
import { HUES, Sheet } from './Sheet';

const id = new URLSearchParams(location.search).get('id') ?? '';
/// The page's local "YYYY-MM-DD HH.mm", as a note's stamp is written.
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };
const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
// One sticky, in its own small window, drawn as TabTasker Business draws a sticker: paper in the hue,
// ink from the hue, a thin bar to drag it by. The bar holds one swatch (its colour; click for the others),
// then fold (the bar alone, its first words showing), pin (on top of everything, or behind other windows
// like any window), make a note, close. The words are the Text editor, compact; hold the dictate key with
// them focused to talk into them. Saved as they are typed.
export function Sticky() {
  const [sticky, setSticky] = useState<Record | null>(null);
  const [text, setText] = useState('');
  const dictateKey = KEY_NAMES[useSettings()?.shortcuts.dictate ?? 'fn'];
  const [picking, setPicking] = useState(new URLSearchParams(location.search).get('preview') === 'picker'); // ?preview=picker shows the colours open, for a look in a browser
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  // The menu is placed at the click, then kept inside the window once its size is known.
  useLayoutEffect(() => {
    const box = menuBox.current;
    if (!box || !menu) return;
    const size = box.getBoundingClientRect();
    const x = Math.max(4, Math.min(menu.x, innerWidth - size.width - 4)), y = Math.max(4, Math.min(menu.y, innerHeight - size.height - 4));
    if (!box.style.transformOrigin) box.style.transformOrigin = `${menu.x - x}px ${menu.y - y}px`; // it grows from the click, wherever it had to go
    if (x !== menu.x || y !== menu.y) setMenu({ x, y });
  }, [menu]);
  const holdMenu = useCallback((el: HTMLDivElement | null) => { menuBox.current = el; return leave(el); }, []);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { void invoke<Record>('sticky_get', { id }).then(found => { setSticky(found); setText(found.text); }, () => setProblem('This sticky is gone.')); }, []);
  // A press anywhere but on the colours themselves folds the palette (the press on a colour must reach it).
  useEffect(() => {
    if (!picking) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest('.sticky-swatch-wrap')) setPicking(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setPicking(false); };
    addEventListener('pointerdown', away, { capture: true }); addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', away, { capture: true }); removeEventListener('keydown', key); };
  }, [picking]);
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
  // Folding, the paper rolls up into its bar, then the window becomes the bar; opening, the window grows and the
  // paper rolls down out of the bar. The window's size is the Mac's to change at once, so the paper is clipped.
  const rolling = useRef<Animation | null>(null);
  const fold = () => {
    if (!sticky) return;
    const next = !sticky.folded, paper = document.querySelector<HTMLElement>('.sticky'), bar = paper?.querySelector<HTMLElement>('.sticky-bar');
    const go = () => change({ folded: next }, invoke('sticky_fold', { id, folded: next }));
    rolling.current?.cancel();
    if (!paper || !bar || reduced()) { go(); return; }
    const rolled = `inset(0 0 calc(100% - ${bar.offsetHeight}px) 0 round 6px)`, open = 'inset(0 0 0 0 round 6px)';
    if (next) {
      rolling.current = paper.animate({ clipPath: [open, rolled] }, { ...timing('--quick', '--ease-in'), fill: 'forwards' }); // kept: folded, it is the bar
      rolling.current.finished.then(go, () => {});
    } else { go(); rolling.current = paper.animate({ clipPath: [rolled, open] }, timing()); }
  };
  const pin = () => sticky && change({ pinned: !sticky.pinned }, invoke('sticky_pin', { id, pinned: !sticky.pinned }));
  // Off the screen, kept on the Stickies page: what was just typed is saved first.
  const close = () => { clearTimeout(timer.current); void invoke('sticky_update', { id, text }).then(() => invoke('sticky_close', { id })).catch(() => {}); };
  const toNote = () => {
    clearTimeout(timer.current); setProblem(null);
    void invoke('sticky_update', { id, text }).then(() => invoke('sticky_to_note', { id, stamp: stamp() })).catch(error => setProblem(message(error, 'Couldn’t save it as a note.')));
  };
  const hue = sticky?.hue ?? 'amber';
  const folded = !!sticky?.folded;
  const item = (label: string, run: () => void, extra?: { disabled?: boolean; checked?: boolean }) => <button type="button" role={extra?.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={extra?.checked} disabled={extra?.disabled} onClick={() => { setMenu(null); run(); }}>{extra?.checked !== undefined && <span className="tick">{extra.checked ? '✓' : ''}</span>}{label}</button>;
  return <Sheet hue={hue} folded={folded} pinned={!!sticky?.pinned} text={text} picking={picking} onPicking={setPicking}
    actions={{ recolour, fold: () => fold(), pin: () => pin(), note: toNote, close }}
    onContextMenu={event => { event.preventDefault(); setPicking(false); setMenu({ x: event.clientX, y: event.clientY }); }}>
    {sticky && !folded && <Editor key={sticky.id} compact markdown={sticky.text} label="Sticky" placeholder={`Type, or hold ${dictateKey} and talk`} autoFocus={!sticky.text} onChange={edit} />}
    {problem && !folded && <p className="sticky-problem" role="alert">{problem}</p>}
    {menu && <div ref={holdMenu} className="sticky-menu" role="menu" aria-label="Sticky" style={{ left: menu.x, top: menu.y }}>
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
  </Sheet>;
}
