import { useEffect, type ReactNode } from 'react';
import { ICON_GLYPHS } from '../overlay/glyphs';
import { Icon, type IconName } from './Icon';
import { leave } from './motion';

/// An object's icon as its glyph (overlay/glyphs.tsx), or the line icon where it has none.
const Picture = ({ icon, size, line }: { icon: IconName; size: number; line: number }) => { const Glyph = ICON_GLYPHS[icon]; return Glyph ? <Glyph size={size} /> : <Icon name={icon} size={line} />; };

export function PageHeader({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return <header className="ui-page-header">
    <h1><Picture icon={icon} size={26} line={20} />{title}</h1>
    {children && <p>{children}</p>}
  </header>;
}

/// A heading inside a page, for a part that was once a page of its own.
export function GroupHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <header className="ui-group-header"><h2>{title}</h2>{children && <p>{children}</p>}</header>;
}

/// A labelled group of tiles, with an optional line under it.
export function Section({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return <section className="ui-section">
    {title && <h2>{title}</h2>}
    {children}
    {note && <p className="ui-section-note">{note}</p>}
  </section>;
}

/// Tiles, not lines: the group's outer corners are round, the seams between tiles stay small.
export const TileGroup = ({ children, label }: { children: ReactNode; label?: string }) => <div className="ui-tiles" role="group" aria-label={label}>{children}</div>;

/// One row: what it is on the left, its control on the right. `stack` puts a wide control underneath.
export function Tile({ title, detail, children, stack, dim }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; stack?: boolean; dim?: boolean }) {
  return <div className={`ui-tile${stack ? ' stack' : ''}${dim ? ' dim' : ''}`}>
    <div className="what"><span className="title">{title}</span>{detail && <span className="detail">{detail}</span>}</div>
    {children != null && <div className="control">{children}</div>}
  </div>;
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="ui-empty">
    <span className="ui-empty-icon"><Picture icon={icon} size={44} line={26} /></span>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action}
  </div>;
}

/// `value` from 0 to 1, or null while how far is not known.
export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const percent = value == null ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return <span className="ui-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} data-unknown={value == null || undefined}>
    <i style={percent == null ? undefined : { width: `${percent}%` }} />
  </span>;
}

/// A short message at the bottom of the window that goes after a few seconds.
export function Toast({ message, onDone, error }: { message: string; onDone: () => void; error?: boolean }) {
  useEffect(() => { const timer = setTimeout(onDone, 3200); return () => clearTimeout(timer); }, [message, onDone]);
  return <p ref={leave} className="ui-toast" role={error ? 'alert' : 'status'} data-error={error || undefined}>{message}</p>;
}
