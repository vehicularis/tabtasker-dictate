import type { PointerEvent as ReactPointerEvent } from 'react';
import { MicIcon, NoteIcon, X } from './icons';

// A spoken note under review: nothing is saved until Save.
export type Draft = { title: string; text: string };

export function NoteCard({ draft, onChange, more, canTalk, discarding, onDiscarding, onSave, onDiscard, onHide, onTalk, onGrab }: {
  draft: Draft; onChange: (draft: Draft) => void; more: string | null; canTalk: boolean; discarding: boolean; onDiscarding: (asking: boolean) => void;
  onSave: () => void; onDiscard: () => void; onHide: () => void; onTalk: () => void; onGrab: (event: ReactPointerEvent) => void;
}) {
  return <article className="glass card" data-glass data-hit aria-label="New note"
    onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSave(); } }}>
    <header className="head" onPointerDown={event => { if (!(event.target as Element).closest('button')) onGrab(event); }}><span className="name"><NoteIcon />New note</span><button type="button" className="close" aria-label="Hide note" onClick={onHide}><X /></button></header>
    <input className="title" aria-label="Title" placeholder="Title" value={draft.title} onChange={event => onChange({ ...draft, title: event.target.value })} />
    <textarea className="text" aria-label="Note" value={draft.text} onChange={event => onChange({ ...draft, text: event.target.value })} />
    {more && <p className="more">{more}</p>}
    <footer className="actions">
      <button type="button" className="tool" aria-label="Keep talking" title="Keep talking" disabled={!canTalk} onClick={onTalk}><MicIcon /></button>
      {discarding
        ? <><span className="ask">Discard this note?</span>
          <button type="button" className="btn" onClick={() => onDiscarding(false)}>Keep</button>
          <button type="button" className="btn danger" onClick={onDiscard}>Discard</button></>
        : <><span className="ask" />
          <button type="button" className="btn" onClick={() => onDiscarding(true)}>Discard</button>
          <button type="button" className="btn primary" disabled={!draft.text.trim()} onClick={onSave}>Save note</button></>}
    </footer>
  </article>;
}
