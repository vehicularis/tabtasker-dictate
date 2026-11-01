import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
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

/// A few choices side by side. Arrow keys move the choice, like a radio group.
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly Option<T>[]; onChange: (value: T) => void; label: string }) {
  const group = useRef<HTMLDivElement>(null);
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
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1}
      onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

/// A menu of choices: the Mac's own pop-up, so it reads and works like one.
export function Select<T extends string>({ value, options, onChange, label }: { value: T; options: readonly Option<T>[]; onChange: (value: T) => void; label: string }) {
  return <span className="ui-select">
    <select value={value} aria-label={label} onChange={event => onChange(event.target.value as T)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <Icon name="chevronDown" size={14} />
  </span>;
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
