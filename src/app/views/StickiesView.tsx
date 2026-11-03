import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke, listen } from '../../bridge';
import { STICKY_HUES, type Sticky } from '../../store';
import { StickyGlyph } from '../../overlay/glyphs';
import { Button, PageHeader, Segmented, useFlip } from '../../ui';

const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };
/// A sticky's words as a glance: Markdown marks dropped, the first lines.
const glance = (text: string) => text.replace(/^#+\s*/gm, '').replace(/^[-*]\s+(\[[ x]\]\s*)?/gm, '• ').replace(/[*_`]/g, '').trim();

// The stickies, kept: the ones on the screen and the ones closed from their own window, each in its colour,
// and the archive. Bring one back, put it away, save it as a note, or delete it for good from the archive.
// New ones from here, the dots, a shortcut, or by voice ("sticky: call Thomas").
export function StickiesView({ onError }: { onError: (message: string) => void }) {
  const [stickies, setStickies] = useState<Sticky[] | null>(null);
  const [view, setView] = useState<'stickies' | 'archive'>('stickies');
  const [deleting, setDeleting] = useState<string | null>(null);
  const refresh = useCallback(() => { void invoke<Sticky[]>('sticky_list').then(setStickies, error => onError(message(error, 'Couldn’t read the stickies.'))); }, [onError]);
  useEffect(refresh, [refresh]);
  useEffect(() => { const off = listen('dictate-stickies', refresh); addEventListener('focus', refresh); return () => { off(); removeEventListener('focus', refresh); }; }, [refresh]);
  const act = (work: Promise<unknown>, failed: string) => void work.then(refresh, error => onError(message(error, failed)));
  const make = () => act(invoke('sticky_new', {}), 'Couldn’t make a sticky.');
  // A sticky closed, shown, archived, restored, deleted or new: each card travels to where it now is.
  const shelf = useRef<HTMLDivElement>(null);
  useFlip(shelf, stickies);
  if (!stickies) return null;
  if (!stickies.length) return <div className="stickies-first">
    <StickyGlyph size={48} />
    <strong>No stickies yet</strong>
    <p>Small notes that stay on top of your other windows. Make one here, from the dots, or say “sticky” and the words while you dictate.</p>
    <Button variant="primary" icon="plus" onClick={make}>New sticky</Button>
  </div>;
  const kept = stickies.filter(sticky => !sticky.archived), archived = stickies.filter(sticky => sticky.archived);
  const card = (sticky: Sticky) => {
    const show = () => act(invoke('sticky_show', { id: sticky.id }), 'Couldn’t show that sticky.');
    const toNote = () => act(invoke('sticky_to_note', { id: sticky.id, stamp: stamp() }), 'Couldn’t save it as a note.');
    const archive = (on: boolean) => act(invoke('sticky_archive', { id: sticky.id, archived: on }), on ? 'Couldn’t archive that sticky.' : 'Couldn’t restore that sticky.');
    const state = sticky.archived ? 'Archived' : sticky.closed ? 'Closed' : sticky.folded ? 'Folded' : sticky.pinned ? 'On top' : 'Behind windows';
    return <article key={sticky.id} className="sticky-card" data-flip={sticky.id} data-closed={sticky.closed || undefined} style={{ '--hue': STICKY_HUES[sticky.hue] } as CSSProperties} aria-label={glance(sticky.text).split('\n')[0] || 'Empty sticky'}>
      <header className="sticky-card-bar"><span className="sticky-card-swatch" /><span className="sticky-card-state">{state}</span></header>
      <button type="button" className="sticky-face" title={sticky.archived ? undefined : 'Show it on the screen'} disabled={sticky.archived} onClick={show}>
        <span className="sticky-words">{glance(sticky.text) || <span className="sticky-empty">Empty</span>}</span>
      </button>
      <footer>
        {sticky.archived ? deleting === sticky.id ? <>
          <span className="sticky-card-ask">Delete for good?</span>
          <button type="button" className="sticky-card-tool wide" onClick={() => setDeleting(null)}>Keep</button>
          <button type="button" className="sticky-card-tool wide danger" onClick={() => { setDeleting(null); act(invoke('sticky_remove', { id: sticky.id }), 'Couldn’t delete that sticky.'); }}>Delete</button>
        </> : <>
          <button type="button" className="sticky-card-tool wide" onClick={() => archive(false)}>Restore</button>
          <button type="button" className="sticky-card-tool wide" onClick={() => setDeleting(sticky.id)}>Delete</button>
        </> : <>
          {sticky.closed
            ? <button type="button" className="sticky-card-tool wide" onClick={show}>Show</button>
            : <button type="button" className="sticky-card-tool wide" onClick={() => act(invoke('sticky_close', { id: sticky.id }), 'Couldn’t close that sticky.')}>Close</button>}
          <button type="button" className="sticky-card-tool wide" disabled={!sticky.text.trim()} onClick={toNote}>Make a note</button>
          <button type="button" className="sticky-card-tool wide" onClick={() => archive(true)}>Archive</button>
        </>}
      </footer>
    </article>;
  };
  const group = (title: string, list: Sticky[]) => list.length > 0 && <section className="stickies-group" aria-label={title}>
    <h2 className="stickies-heading" data-flip={`heading:${title}`}>{title}<span>{list.length}</span></h2>
    <div className="stickies-grid">{list.map(card)}</div>
  </section>;
  return <>
    <div className="stickies-top">
      <PageHeader icon="sticky" title="Stickies">Small notes that stay on top of your other windows. Close one and it waits here until you show it again.</PageHeader>
      <Button variant="primary" icon="plus" onClick={make}>New sticky</Button>
    </div>
    <div className="stickies-views">
      <Segmented label="Show" value={view} onChange={setView} options={[{ value: 'stickies', label: `Stickies · ${kept.length}` }, { value: 'archive', label: `Archive · ${archived.length}` }]} />
    </div>
    <div ref={shelf} key={view} className="stickies-view">
      {view === 'stickies'
        ? kept.length ? <>{group('On the screen', kept.filter(sticky => !sticky.closed))}{group('Closed', kept.filter(sticky => sticky.closed))}</>
          : <p className="stickies-none" data-flip="none">Every sticky is in the archive.</p>
        : archived.length ? group('Archived', archived) : <p className="stickies-none" data-flip="none">Nothing archived. Archive a sticky to keep it without it showing here.</p>}
    </div>
  </>;
}
