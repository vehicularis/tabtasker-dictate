import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Menu, MenuKeys } from '../editor/Menu';
import { Icon, type IconName } from './Icon';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; icon?: IconName; small?: boolean };
/// Primary is the accent; secondary a fill; quiet text only; danger for what cannot be undone.
export function Button({ variant = 'secondary', icon, small, className, children, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`ui-button ${variant}${small ? ' small' : ''}${children ? '' : ' only-icon'} ${className ?? ''}`} {...rest}>
    {icon && <Icon name={icon} size={small ? 15 : 16} />}{children}
  </button>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="ui-toggle" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="knob" />
  </button>;
}

export type Option<T extends string> = { value: T; label: string };

/// The chosen segment's plate is one layer under every segment, cut to the chosen one, so a new choice slides it
/// across (ui.css) instead of lighting another.
function fitPlate(group: HTMLElement | null) {
  const plate = group?.querySelector<HTMLElement>(':scope > .ui-segmented-plate'), on = group?.querySelector<HTMLElement>(':scope > [aria-checked="true"]');
  if (!group || !plate) return;
  plate.hidden = !on;
  if (on) plate.style.clipPath = `inset(${on.offsetTop}px ${group.clientWidth - on.offsetLeft - on.offsetWidth}px ${group.clientHeight - on.offsetTop - on.offsetHeight}px ${on.offsetLeft}px round 10px)`;
}

/// A few choices side by side. Arrow keys move the choice, like a radio group.
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly Option<T>[]; onChange: (value: T) => void; label: string }) {
  const group = useRef<HTMLDivElement>(null);
  // Every render, as the choice or a label may have changed. The first cut is from no clip at all, which does not
  // slide, so the plate starts in place.
  useLayoutEffect(() => fitPlate(group.current));
  useEffect(() => {
    const el = group.current;
    if (!el) return;
    const watch = new ResizeObserver(() => fitPlate(el));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const move = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = options.findIndex(option => option.value === value);
    const next = options[(at + step + options.length) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return <div ref={group} className="ui-segmented" role="radiogroup" aria-label={label} onKeyDown={move}>
    <span className="ui-segmented-plate" aria-hidden="true" />
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1}
      onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

/// A menu of choices, as Business's Select: the choice on a field, and under it the inverted tray (Menu) with
/// the chosen row ticked. A click, Return, Space or an arrow opens it on the chosen row; arrows walk, Return
/// picks, Escape or Tab puts it away, and typing jumps to a row by its name (the same letter again, the next).
export function Select<T extends string>({ value, options, onChange, label, className = '' }: { value: T; options: readonly Option<T>[]; onChange: (value: T) => void; label: string; className?: string }) {
  const field = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), typed = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); field.current?.focus(); };
  useLayoutEffect(() => {
    const box = list.current, row = box?.querySelector<HTMLElement>('[aria-selected="true"]') ?? box?.querySelector<HTMLElement>('[role="option"]');
    if (!open || !box || !row) return;
    box.scrollTop = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2;
    row.focus({ preventScroll: true });
  }, [open]);
  const jump = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { event.preventDefault(); close(); return; }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const t = typed.current, now = performance.now();
    t.text = now - t.at > 700 ? event.key : t.text + event.key;
    t.at = now;
    if (t.text === ' ') return; // Space on its own picks the row
    event.preventDefault();
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')], from = rows.indexOf(document.activeElement as HTMLElement);
    const same = [...t.text].every(key => key === t.text[0]), find = (same ? t.text[0] : t.text).toLocaleLowerCase();
    const order = same ? [...rows.slice(from + 1), ...rows.slice(0, from + 1)] : rows;
    order.find(row => row.textContent!.toLocaleLowerCase().startsWith(find))?.focus();
  };
  return <>
    <button ref={field} type="button" className={`ui-select ${className}`} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => open ? close() : setOpen(true)}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <span>{options.find(option => option.value === value)?.label}</span>
      <Icon name="chevronDown" size={14} />
    </button>
    {open && field.current && <Menu role="listbox" anchor={field.current} label={label} onClose={close} minWidth={field.current.offsetWidth}>
      <div ref={list} className="ui-select-list" onKeyDown={jump}>
        {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className="ed-menu-item"
          onClick={() => { close(); if (option.value !== value) onChange(option.value); }}>
          {option.label}{option.value === value && <Icon name="check" size={16} />}
        </button>)}
      </div>
      <MenuKeys />
    </Menu>}
  </>;
}

/// Text that is saved when you press Return or leave the field, not on every key.
export function TextField({ value, onCommit, label, placeholder, monospace, wide, disabled }: {
  value: string; onCommit: (value: string) => void; label: string; placeholder?: string; monospace?: boolean; wide?: boolean; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return <input className={`ui-field${monospace ? ' mono' : ''}${wide ? ' wide' : ''}`} value={draft} aria-label={label} placeholder={placeholder} disabled={disabled} spellCheck={false}
    onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') setDraft(value); }} />;
}

export function Slider({ value, min, max, step = 1, onChange, label, format }: {
  value: number; min: number; max: number; step?: number; onChange: (value: number) => void; label: string; format?: (value: number) => string;
}) {
  const id = useId();
  return <span className="ui-slider">
    <input id={id} type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={event => onChange(Number(event.target.value))}
      style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties} />
    {format && <output htmlFor={id}>{format(value)}</output>}
  </span>;
}

/// A short list of words as removable chips, with a field to add one.
export function ChipList({ items, onChange, label, placeholder, empty }: { items: string[]; onChange: (items: string[]) => void; label: string; placeholder: string; empty?: ReactNode }) {
  const [word, setWord] = useState('');
  const add = () => {
    const clean = word.trim();
    if (clean && !items.some(item => item.toLowerCase() === clean.toLowerCase())) onChange([clean, ...items]);
    setWord('');
  };
  return <div className="ui-chips">
    <span className="add">
      <input className="ui-field wide" value={word} aria-label={label} placeholder={placeholder} spellCheck={false} onChange={event => setWord(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      <Button icon="plus" small disabled={!word.trim()} onClick={add}>Add</Button>
    </span>
    {items.length ? <ul aria-label={label}>
      {items.map(item => <li key={item}>{item}<button type="button" aria-label={`Remove ${item}`} onClick={() => onChange(items.filter(other => other !== item))}><Icon name="close" size={12} /></button></li>)}
    </ul> : empty}
  </div>;
}
