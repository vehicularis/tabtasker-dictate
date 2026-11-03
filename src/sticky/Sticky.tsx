import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke, listen, popupMenu, type MenuSpec } from '../bridge';
import { stamp } from '../lib/dates';
import { message } from '../lib/errors';
import { KEY_NAMES } from '../lib/keyNames';
import { leave, reduced, timing } from '../ui/motion';
import { STICKY_HUES, STICKY_SIZES, useSettings, type Events, type Sticky as Record, type StickyHue, type StickyTilt, type StickyWeight } from '../store';
import { Editor } from '../editor/Editor';
import { HUES, Sheet } from './Sheet';

const id = new URLSearchParams(location.search).get('id') ?? '';
const PREVIEW = new URLSearchParams(location.search).get('preview'); // ?preview=pill keeps the pill out, for a look in a browser
// In its own window on the Mac, the pointer is the Mac's to report (dictate.m): WebKit's hover goes stale once
// the window stops taking the mouse over the clear gutter. In a browser, hover is hover.
const NATIVE = !PREVIEW && '__TAURI__' in window;
// One sticky, in its own small window: Business's sticker (Sheet). Its band drags it; while the pointer is over it
// the pill floats above the sheet, in the window's clear gutter: the swatch (the other colours under it), fold,
// keep on top, save as a note, more and close. More, or a right-click, opens the look menu: the colours, a title
// line, bold type, the tilt, the size, fold, keep on top.
// The words are the Text editor, compact; hold the dictate key with them focused to talk into them. Saved as typed.
export function Sticky() {
  const [sticky, setSticky] = useState<Record | null>(null);
  const [text, setText] = useState('');
  const dictateKey = KEY_NAMES[useSettings()?.shortcuts.dictate ?? 'fn'];
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
  // The pill: up while the Mac says the pointer is over the sheet or the pill; held up while its colours or the
  // menu are open, or the keyboard is in it. The Mac is told the pill's width once it is laid out, to know where.
  const [hover, setHover] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => NATIVE ? listen<Events['dictate-sticky-hover']>('dictate-sticky-hover', pill => { if (pill.id === id) setHover(pill.up); }) : undefined, []);
  useEffect(() => { if (NATIVE) void invoke('sticky_hold', { id, hold: held || !!menu }).catch(() => {}); }, [held, !!menu]); // eslint-disable-line react-hooks/exhaustive-deps -- whether the menu is open, not where
  const timer = useRef<number | undefined>(undefined);
  const titleTimer = useRef<number | undefined>(undefined);
  useEffect(() => { void invoke<Record>('sticky_get', { id }).then(found => { setSticky(found); setText(found.text); }, () => setProblem('Couldn’t find this sticky. It may have been deleted.')); }, []);
  useEffect(() => {
    if (!NATIVE || !sticky) return;
    const width = document.querySelector('.sticky-pill')?.getBoundingClientRect().width;
    if (width) void invoke('sticky_watch', { id, pillWidth: width }).catch(() => {});
  }, [sticky?.id, sticky?.folded]); // eslint-disable-line react-hooks/exhaustive-deps -- laid out again on these
  // A press anywhere else closes the menu; one on ⋯ is left to ⋯, which opens and closes it.
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest('.sticky-menu, .sticky-more')) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    addEventListener('pointerdown', away, { capture: true }); addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', away, { capture: true }); removeEventListener('keydown', key); };
  }, [menu]);
  const failed = (what: string) => (error: unknown) => setProblem(message(error, what));
  const edit = (next: string) => {
    setText(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void invoke('sticky_update', { id, text: next }).catch(failed('Couldn’t save what you typed.')); }, 350);
  };
  const change = (patch: Partial<Record>, work: Promise<unknown>) => { setSticky(current => current && { ...current, ...patch }); void work.catch(failed('Couldn’t change that. Try again.')); };
  const look = (patch: Partial<Pick<Record, 'hue' | 'titled' | 'tilt' | 'weight'>>) => change(patch, invoke('sticky_update', { id, ...patch }));
  const retitle = (title: string) => {
    setSticky(current => current && { ...current, title });
    clearTimeout(titleTimer.current);
    titleTimer.current = window.setTimeout(() => { void invoke('sticky_update', { id, title }).catch(failed('Couldn’t save the title.')); }, 350);
  };
  const resize = (size: keyof typeof STICKY_SIZES) => { const [width, height] = STICKY_SIZES[size]; change({ width, height }, invoke('sticky_size', { id, width, height })); };
  // Folding, the paper rolls up into its band, then the window becomes the band; opening, the window grows and the
  // paper rolls down out of the band. The window's size is the Mac's to change at once, so the paper is clipped.
  const rolling = useRef<Animation | null>(null);
  const fold = () => {
    if (!sticky) return;
    const next = !sticky.folded, paper = document.querySelector<HTMLElement>('.sticky'), band = paper?.querySelector<HTMLElement>('.sticky-band');
    const go = () => change({ folded: next }, invoke('sticky_fold', { id, folded: next }));
    rolling.current?.cancel();
    if (!paper || !band || reduced()) { go(); return; }
    const rolled = `inset(0 0 calc(100% - ${band.offsetHeight}px) 0 round 2px)`, open = 'inset(0 0 0 0 round 2px)';
    if (next) {
      rolling.current = paper.animate({ clipPath: [open, rolled] }, { ...timing('--quick', '--ease-in'), fill: 'forwards' }); // kept: folded, it is the band
      rolling.current.finished.then(go, () => {});
    } else { go(); rolling.current = paper.animate({ clipPath: [rolled, open] }, timing()); }
  };
  const pin = () => sticky && change({ pinned: !sticky.pinned }, invoke('sticky_pin', { id, pinned: !sticky.pinned }));
  // Off the screen, kept on the Stickies page: what was just typed is saved first.
  const close = () => { clearTimeout(timer.current); void invoke('sticky_update', { id, text }).then(() => invoke('sticky_close', { id })).catch(() => {}); };
  const toNote = () => {
    clearTimeout(timer.current); setProblem(null);
    void invoke('sticky_update', { id, text }).then(() => invoke('sticky_to_note', { id, stamp: stamp() })).catch(failed('Couldn’t save it as a note.'));
  };
  const hue = sticky?.hue ?? 'amber';
  const folded = !!sticky?.folded;
  // The look menu as the Mac draws a menu, popped over the window so a small sticky never clips it; the page's own
  // menu stands in only in a browser. Built from the sticky as it is the moment it opens.
  const nativeMenu = (at: { x: number; y: number } | undefined) => {
    if (!sticky) return Promise.resolve(false);
    const sizeNow = (Object.keys(STICKY_SIZES) as (keyof typeof STICKY_SIZES)[]).find(name => STICKY_SIZES[name][0] === sticky.width && STICKY_SIZES[name][1] === sticky.height);
    const name = (word: string) => word[0].toUpperCase() + word.slice(1);
    const spec: MenuSpec = [
      { text: 'Colour', items: HUES.map(one => ({ text: name(one), checked: one === sticky.hue, action: () => look({ hue: one }) })) },
      'separator',
      { text: 'Title', checked: sticky.titled, action: () => look({ titled: !sticky.titled }) },
      { text: 'Bold', checked: sticky.weight === 'bold', action: () => look({ weight: (sticky.weight === 'bold' ? 'regular' : 'bold') as StickyWeight }) },
      { text: 'Tilt', items: ([['none', 'None'], ['slight', 'Slight'], ['random', 'Random']] as [StickyTilt, string][]).map(([value, label]) => ({ text: label, checked: sticky.tilt === value, action: () => look({ tilt: value }) })) },
      { text: 'Size', items: ([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] as [keyof typeof STICKY_SIZES, string][]).map(([value, label]) => ({ text: label, checked: sizeNow === value, action: () => resize(value) })) },
      'separator',
      { text: sticky.folded ? 'Unfold' : 'Fold up', action: () => fold() },
      { text: 'Keep on top', checked: sticky.pinned, action: () => pin() },
      'separator',
      { text: 'Save as a note', disabled: !text.trim(), action: toNote },
      { text: 'Close', action: close },
    ];
    return popupMenu(spec, at);
  };
  const openMenu = (at: { x: number; y: number }, pointer: boolean) => { void nativeMenu(pointer ? undefined : at).then(shown => { if (!shown) setMenu(open => open ? null : at); }); };
  const size = sticky ? (Object.keys(STICKY_SIZES) as (keyof typeof STICKY_SIZES)[]).find(name => STICKY_SIZES[name][0] === sticky.width && STICKY_SIZES[name][1] === sticky.height) : undefined;
  const item = (label: string, run: () => void, extra?: { disabled?: boolean; checked?: boolean }) => <button type="button" role={extra?.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={extra?.checked} disabled={extra?.disabled} onClick={() => { setMenu(null); run(); }}>{extra?.checked !== undefined && <span className="tick">{extra.checked ? '✓' : ''}</span>}{label}</button>;
  // A row of choices, one of them on: the tilt, the size.
  const choice = <T extends string>(label: string, options: [T, string][], current: T | undefined, pick: (value: T) => void) => <div className="sticky-menu-row" role="group" aria-label={label}>
    <span className="k">{label}</span>
    <span className="seg">{options.map(([value, name]) => <button key={value} type="button" role="menuitemradio" aria-checked={value === current} onClick={() => { setMenu(null); pick(value); }}>{name}</button>)}</span>
  </div>;
  return <Sheet id={id} hue={hue} folded={folded} pinned={!!sticky?.pinned} text={text} title={sticky?.title ?? ''} titled={!!sticky?.titled} tilt={sticky?.tilt ?? 'none'} weight={sticky?.weight ?? 'bold'}
    actions={{ fold: () => fold(), pin: () => pin(), note: toNote, close, recolour: (next: StickyHue) => look({ hue: next }), retitle, more: at => openMenu(at, false) }}
    data-native={NATIVE || undefined} data-hover={hover || PREVIEW === 'pill' || undefined} onHold={setHeld} onContextMenu={event => { event.preventDefault(); openMenu({ x: event.clientX, y: event.clientY }, true); }}>
    {sticky && !folded && <Editor key={sticky.id} compact markdown={sticky.text} label="Sticky" placeholder={`Type, or hold ${dictateKey} and talk`} autoFocus={!sticky.text} onChange={edit} />}
    {problem && !folded && <p className="sticky-problem" role="alert">{problem}</p>}
    {menu && <div ref={holdMenu} className="sticky-menu" role="menu" aria-label="Look and size" style={{ left: menu.x, top: menu.y }}>
      <div className="sticky-menu-hues" role="group" aria-label="Colour">
        {HUES.map(one => <button key={one} type="button" role="menuitemradio" aria-checked={one === hue} aria-label={one} title={one} className="sticky-hue" style={{ '--hue': STICKY_HUES[one] } as CSSProperties} onClick={() => { setMenu(null); look({ hue: one }); }} />)}
      </div>
      <div className="sticky-menu-row" role="group" aria-label="Type">
        <button type="button" role="menuitemcheckbox" aria-checked={!!sticky?.titled} onClick={() => { setMenu(null); look({ titled: !sticky?.titled }); }}><span className="tick">{sticky?.titled ? '✓' : ''}</span>Title</button>
        <button type="button" role="menuitemcheckbox" aria-checked={sticky?.weight === 'bold'} onClick={() => { setMenu(null); look({ weight: (sticky?.weight === 'bold' ? 'regular' : 'bold') as StickyWeight }); }}><span className="tick">{sticky?.weight === 'bold' ? '✓' : ''}</span>Bold</button>
      </div>
      {choice<StickyTilt>('Tilt', [['none', 'None'], ['slight', 'Slight'], ['random', 'Random']], sticky?.tilt, tilt => look({ tilt }))}
      {choice<keyof typeof STICKY_SIZES>('Size', [['small', 'S'], ['medium', 'M'], ['large', 'L']], size, resize)}
      <i className="sticky-menu-rule" role="separator" />
      {item(folded ? 'Unfold' : 'Fold up', () => fold())}
      {item('Keep on top', () => pin(), { checked: !!sticky?.pinned })}
    </div>}
  </Sheet>;
}
