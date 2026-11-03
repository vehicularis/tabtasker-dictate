import { useState, type ReactNode } from 'react';
import { Icon } from '../ui';

/// A column's head, as Business's rail column draws it: the place's name at 18 points and one action
/// flush right (the pencil over Chat; our new note, our record button).
export function ColumnHead({ title, action }: { title: string; action?: ReactNode }) {
  return <header className="column-head"><h2>{title}</h2>{action}</header>;
}

/// A group of rows under an uppercase heading that folds; folded, the heading carries the count. `flip` keys the
/// heading for a list that glides when it changes (motion.ts useFlip).
export function ColumnGroup({ title, children, count, flip }: { title: string; children: ReactNode; count?: number; flip?: string }) {
  const [open, setOpen] = useState(true);
  return <section className="column-group" data-open={open || undefined}>
    <button type="button" className="column-group-head" data-flip={flip} aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name="chevronDown" size={10} />{title}{count !== undefined && <span className="count">{count}</span>}</button>
    {open && children}
  </section>;
}
