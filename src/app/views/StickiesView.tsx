import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke, listen } from '../../bridge';
import { STICKY_HUES, type Sticky } from '../../store';
import { StickyGlyph } from '../../overlay/glyphs';
import { firstLine } from '../../sticky/Sheet';
import { Button, Icon, PageHeader, Segmented, useFlip, type IconName } from '../../ui';
import '../../sticky/sticky.css';

const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };
/// A sticky's words as a glance: Markdown marks dropped.
const glance = (text: string) => text.replace(/^#+\s*/gm, '').replace(/^[-*]\s+(\[[ x]\]\s*)?/gm, '• ').replace(/[*_`]/g, '').trim();
/// Its paper in the shape it has on the screen, within reason.
const shape = (sticky: Sticky) => `1 / ${Math.min(1.4, Math.max(0.6, sticky.height / sticky.width)).toFixed(3)}`;

// The stickies as they are on the screen: each one its own paper, with the sticky's own bar and the tools that
// make sense from here in it. The ones on the screen float; the ones closed from their own window lie flat
// under them until shown again; the archive keeps the rest. A sticky folded to its bar on the screen is a bar here.
export function StickiesView({ onError }: { onError: (message: string) => void }) {
  const [stickies, setStickies] = useState<Sticky[] | null>(null);
  const [view, setView] = useState<'stickies' | 'archive'>('stickies');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const refresh = useCallback(() => { void invoke<Sticky[]>('sticky_list').then(setStickies, error => onError(message(error, 'Couldn’t load your stickies.'))); }, [onError]);
  useEffect(refresh, [refresh]);
  useEffect(() => { const off = listen('dictate-stickies', refresh); addEventListener('focus', refresh); return () => { off(); removeEventListener('focus', refresh); }; }, [refresh]);
  const act = (work: Promise<unknown>, failed: string) => void work.then(refresh, error => onError(message(error, failed)));
  const make = () => act(invoke('sticky_new', {}), 'Couldn’t make a sticky.');
  // A sticky closed, shown, archived, restored, deleted or new: each paper travels to where it now is.
  const shelf = useRef<HTMLDivElement>(null);
  useFlip(shelf, stickies);
  if (!stickies) return null;
  if (!stickies.length) return <div className="stickies-first">
    <StickyGlyph size={48} />
    <strong>No stickies yet</strong>
    <p>Stickies stay on top of your other windows. Make one here, or start a dictation with the word “sticky”.</p>
    <Button variant="primary" icon="plus" onClick={make}>New sticky</Button>
  </div>;
  const kept = stickies.filter(sticky => !sticky.archived), archived = stickies.filter(sticky => sticky.archived);
  const showing = archived.length ? view : 'stickies';
  // Delete all, as Business's archive has it: asked first, since a deleted sticky is gone for good; one that
  // can't be removed stays and the rest still go.
  const many = (n: number) => `${n} ${n === 1 ? 'sticky' : 'stickies'}`;
  const deleteAll = async () => {
    setClearing(false);
    let done = 0;
    for (const sticky of archived) { try { await invoke('sticky_remove', { id: sticky.id }); done++; } catch { /* left in the archive */ } }
    refresh();
    onError(done === archived.length ? `Deleted ${many(done)}.` : `Deleted ${done} of ${many(archived.length)}. The rest are still in the archive.`);
  };
  const paper = (sticky: Sticky) => {
    const show = () => act(invoke('sticky_show', { id: sticky.id }), 'Couldn’t show that sticky.');
    const toNote = () => act(invoke('sticky_to_note', { id: sticky.id, stamp: stamp() }), 'Couldn’t save it as a note.');
    const archive = (on: boolean) => act(invoke('sticky_archive', { id: sticky.id, archived: on }), on ? 'Couldn’t archive that sticky.' : 'Couldn’t restore that sticky.');
    const close = () => act(invoke('sticky_close', { id: sticky.id }), 'Couldn’t close that sticky.');
    const remove = () => { setDeleting(null); act(invoke('sticky_remove', { id: sticky.id }), 'Couldn’t delete that sticky.'); };
    const tool = (icon: IconName, title: string, run: () => void, disabled = false) =>
      <button type="button" className="sticky-tool" title={title} aria-label={title} disabled={disabled} onClick={run}><Icon name={icon} size={icon === 'close' ? 12 : 14} /></button>;
    const folded = sticky.folded && !sticky.closed && !sticky.archived;
    const words = glance(sticky.text);
    return <article key={sticky.id} className="sticky sticky-card" data-flip={sticky.id} data-closed={sticky.closed || undefined} data-folded={folded || undefined}
      style={{ '--hue': STICKY_HUES[sticky.hue], '--shape': shape(sticky) } as CSSProperties} aria-label={firstLine(sticky.text) || 'Empty sticky'}>
      <header className="sticky-bar">
        {folded && <button type="button" className="sticky-peek" title="Show on screen" onClick={show}>{firstLine(sticky.text) || 'Empty sticky'}</button>}
        {deleting === sticky.id
          ? <span className="sticky-card-ask">Delete for good?
            <button type="button" className="sticky-card-word" onClick={() => setDeleting(null)}>Keep</button>
            <button type="button" className="sticky-card-word danger" onClick={remove}>Delete</button>
          </span>
          : <span className="sticky-tools">
            {sticky.archived ? <>
              {tool('undo', 'Restore', () => archive(false))}
              {tool('trash', 'Delete', () => setDeleting(sticky.id))}
            </> : <>
              {tool('note', 'Save as a note', toNote, !sticky.text.trim())}
              {tool('archive', 'Archive', () => archive(true))}
              {sticky.closed ? tool('external', 'Show on screen', show) : tool('close', 'Close', close)}
            </>}
          </span>}
      </header>
      {!folded && <button type="button" className="sticky-face" title={sticky.archived ? undefined : 'Show on screen'} disabled={sticky.archived} onClick={show}>
        {words || <span className="sticky-empty">Empty</span>}
      </button>}
    </article>;
  };
  const group = (title: string | null, list: Sticky[]) => list.length > 0 && <section className="stickies-group" aria-label={title ?? 'Archive'}>
    {title && <h2 className="stickies-heading" data-flip={`heading:${title}`}>{title}</h2>}
    <div className="stickies-grid">{list.map(paper)}</div>
  </section>;
  return <>
    <div className="stickies-top">
      <PageHeader icon="sticky" title="Stickies" />
      {archived.length > 0 && <Segmented label="Show" value={showing} onChange={setView} options={[{ value: 'stickies', label: 'Stickies' }, { value: 'archive', label: `Archive · ${archived.length}` }]} />}
      {showing === 'archive'
        ? clearing
          ? <span className="stickies-clear"><span>Delete {many(archived.length)} for good?</span><Button variant="quiet" onClick={() => setClearing(false)}>Keep</Button><Button variant="danger" onClick={() => void deleteAll()}>Delete all</Button></span>
          : <Button variant="danger" className="quiet" icon="trash" onClick={() => setClearing(true)}>Delete all</Button>
        : <Button icon="plus" onClick={make}>New sticky</Button>}
    </div>
    <div ref={shelf} key={showing} className="stickies-view">
      {showing === 'stickies'
        ? kept.length ? <>{group('On your screen', kept.filter(sticky => !sticky.closed))}{group('Closed', kept.filter(sticky => sticky.closed))}</>
          : <p className="stickies-none" data-flip="none">All your stickies are in the archive.</p>
        : group(null, archived)}
    </div>
  </>;
}
