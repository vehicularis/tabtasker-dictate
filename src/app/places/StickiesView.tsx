import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { invoke, listen } from '../../bridge';
import { Menu, MenuItem, MenuLine } from '../../editor/Menu';
import { stamp } from '../../lib/dates';
import { message } from '../../lib/errors';
import { useSelection } from '../../ui/selection';
import { firstLine, glance, ordered as orderedStickies, shape } from '../../lib/stickies';
import { countMessage } from '../../lib/text';
import { STICKY_HUES } from '../../store';
import type { Sticky } from '../../api/types';
import { StickyGlyph } from '../../overlay/glyphs';
import { Button, Icon, PageHeader, Segmented, useFlip, type IconName } from '../../ui';
import '../../sticky/sticky.css';

// The stickies as they are on the screen: each one its own paper, with the sticky's own bar and the tools that
// make sense from here in it. The ones on the screen float; the ones closed from their own window lie flat
// under them until shown again; the archive keeps the rest. A sticky folded to its bar on the screen is a bar here.
export function StickiesView({ onError }: { onError: (message: string) => void }) {
  const [stickies, setStickies] = useState<Sticky[] | null>(null);
  const [view, setView] = useState<'stickies' | 'archive'>('stickies');
  const [deleting, setDeleting] = useState<string | null>(null);
  // Many at once, as the notes list has it: ⌘-click or ⇧-click picks papers (in the order they're shown), a plain
  // click still shows one, ⌘A picks every one in view, Escape or a click on the page lets go. What to do with them
  // takes the header's right side; a right-click does the same for the paper under it. Deleting asks first.
  const ordered = useMemo(() => orderedStickies(stickies ?? [], view === 'archive'), [stickies, view]);
  const sel = useSelection(useMemo(() => ordered.map(sticky => sticky.id), [ordered]));
  const [asking, setAsking] = useState<{ ids: string[]; at: HTMLElement | (() => DOMRect) } | null>(null);
  const [menu, setMenu] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const refresh = useCallback(() => { void invoke('sticky_list').then(setStickies, error => onError(message(error, 'Couldn’t load your stickies.'))); }, [onError]);
  useEffect(refresh, [refresh]);
  useEffect(() => { const off = listen('dictate-stickies', refresh); addEventListener('focus', refresh); return () => { off(); removeEventListener('focus', refresh); }; }, [refresh]);
  const act = (work: Promise<unknown>, failed: string) => void work.then(refresh, error => onError(message(error, failed)));
  const make = () => act(invoke('sticky_new', {}), 'Couldn’t make a new sticky.');
  // A sticky closed, shown, archived, restored, deleted or new: each paper travels to where it now is.
  const shelf = useRef<HTMLDivElement>(null);
  useFlip(shelf, stickies);
  if (!stickies) return null;
  // Nothing yet: the editor pane's own empty state, straight in the content as Notes and Meetings have theirs, so it
  // centres the same way (editor-pane.css); with stickies, the wide page.
  if (!stickies.length) return <div className="editor-pane"><div className="empty-pane first">
    <span className="empty-icon"><StickyGlyph size={48} /></span>
    <strong>No stickies yet</strong>
    <p>Stickies stay on top of your other windows. Make one here, or start a dictation with the word “sticky”.</p>
    <Button variant="primary" icon="plus" onClick={make}>New sticky</Button>
  </div></div>;
  const kept = stickies.filter(sticky => !sticky.archived), archived = stickies.filter(sticky => sticky.archived);
  const showing = archived.length ? view : 'stickies';
  const many = (n: number) => `${n} ${n === 1 ? 'sticky' : 'stickies'}`;
  const picked = ordered.filter(sticky => sel.ids.has(sticky.id));
  const ofIds = (ids: string[]) => ordered.filter(sticky => ids.includes(sticky.id));
  // One at a time, so one that fails stays as it was and the rest still go; the toast counts them.
  const each = async (list: Sticky[], work: (sticky: Sticky) => Promise<unknown>, said?: (what: string) => string) => {
    sel.clear(); setAsking(null); setMenu(null);
    let done = 0;
    for (const sticky of list) { try { await work(sticky); done++; } catch { /* left as it was */ } }
    refresh();
    const told = countMessage(done, list.length, said, many);
    if (told) onError(told);
  };
  const showAll = (list: Sticky[]) => void each(list.filter(sticky => sticky.closed), sticky => invoke('sticky_show', { id: sticky.id }));
  const closeAll = (list: Sticky[]) => void each(list.filter(sticky => !sticky.closed), sticky => invoke('sticky_close', { id: sticky.id }));
  const archiveAll = (list: Sticky[], on: boolean) => void each(list, sticky => invoke('sticky_archive', { id: sticky.id, archived: on }), what => `${on ? 'Archived' : 'Restored'} ${what}`);
  const deleteAll = (list: Sticky[]) => void each(list, sticky => invoke('sticky_remove', { id: sticky.id }), what => `Deleted ${what}`);
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
      data-archived={sticky.archived || undefined} data-picked={sel.ids.has(sticky.id) || undefined}
      style={{ '--hue': STICKY_HUES[sticky.hue], '--shape': shape(sticky) } as CSSProperties} aria-label={firstLine(sticky.text) || 'Empty sticky'}
      onContextMenu={event => { event.preventDefault(); setMenu({ ids: sel.ids.has(sticky.id) ? picked.map(one => one.id) : [sticky.id], x: event.clientX, y: event.clientY }); }}>
      <header className="sticky-bar">
        {folded && <button type="button" className="sticky-peek" title="Show on screen" onClick={event => { if (!sel.click(sticky.id, event)) show(); }}>{firstLine(sticky.text) || 'Empty sticky'}</button>}
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
      {!folded && <button type="button" className="sticky-face" title={sticky.archived ? undefined : 'Show on screen'} onClick={event => { if (!sel.click(sticky.id, event) && !sticky.archived) show(); }}>
        {words || <span className="sticky-empty">Empty</span>}
      </button>}
    </article>;
  };
  const group = (title: string | null, list: Sticky[]) => list.length > 0 && <section className="stickies-group" aria-label={title ?? 'Archive'}>
    {title && <h2 className="stickies-heading" data-flip={`heading:${title}`}>{title}</h2>}
    <div className="stickies-grid">{list.map(paper)}</div>
  </section>;
  return <div className="page wide">
    <div className="stickies-top">
      <PageHeader icon="sticky" title="Stickies" />
      {picked.length ? <span className="stickies-bulk" role="toolbar" aria-label="Selected stickies">
        <span className="stickies-count">{picked.length} selected</span>
        {showing === 'stickies' ? <>
          <Button variant="quiet" disabled={!picked.some(sticky => sticky.closed)} onClick={() => showAll(picked)}>Show</Button>
          <Button variant="quiet" disabled={!picked.some(sticky => !sticky.closed)} onClick={() => closeAll(picked)}>Close</Button>
          <Button variant="quiet" onClick={() => archiveAll(picked, true)}>Archive</Button>
        </> : <>
          <Button variant="quiet" onClick={() => archiveAll(picked, false)}>Restore</Button>
          <Button variant="quiet" aria-haspopup="menu" onClick={event => setAsking({ ids: picked.map(one => one.id), at: event.currentTarget })}>Delete…</Button>
        </>}
        <Button variant="quiet" icon="close" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={sel.clear} />
      </span> : <>
        {archived.length > 0 && <Segmented label="Show" value={showing} onChange={next => { sel.clear(); setView(next); }} options={[{ value: 'stickies', label: 'Stickies' }, { value: 'archive', label: `Archive · ${archived.length}` }]} />}
        {showing === 'archive' && <Button variant="quiet" icon="trash" aria-label="Empty the archive" title="Empty the archive" aria-haspopup="menu" onClick={event => setAsking({ ids: archived.map(one => one.id), at: event.currentTarget })} />}
        <Button icon="plus" onClick={make}>New sticky</Button>
      </>}
    </div>
    {asking && <Menu anchor={asking.at} label="Delete" focus onClose={() => setAsking(null)}>
      <p className="ed-menu-note">{asking.ids.length === 1 ? 'A deleted sticky' : 'Deleted stickies'} can’t be brought back.</p>
      <MenuItem danger onSelect={() => deleteAll(ofIds(asking.ids))}><Icon name="trash" size={15} />Delete {asking.ids.length > 1 && asking.ids.length === archived.length ? 'all ' : ''}{many(asking.ids.length)}</MenuItem>
    </Menu>}
    {menu && (() => {
      const list = ofIds(menu.ids), one = list.length === 1 ? list[0] : null, count = list.length > 1 ? ` ${many(list.length)}` : '';
      return <Menu anchor={() => new DOMRect(menu.x, menu.y, 0, 0)} label={one ? 'Sticky' : `${list.length} selected`} onClose={() => setMenu(null)}>
        {showing === 'stickies' ? <>
          {list.some(sticky => sticky.closed) && <MenuItem onSelect={() => showAll(list)}>Show on screen</MenuItem>}
          {list.some(sticky => !sticky.closed) && <MenuItem onSelect={() => closeAll(list)}>Close</MenuItem>}
          {one && <MenuItem disabled={!one.text.trim()} onSelect={() => { setMenu(null); act(invoke('sticky_to_note', { id: one.id, stamp: stamp() }), 'Couldn’t save it as a note.'); }}>Save as a note</MenuItem>}
          <MenuLine />
          <MenuItem onSelect={() => archiveAll(list, true)}><Icon name="archive" size={15} />Archive{count}</MenuItem>
        </> : <>
          <MenuItem onSelect={() => archiveAll(list, false)}><Icon name="undo" size={15} />Restore{count}</MenuItem>
          <MenuItem danger onSelect={() => { const at = new DOMRect(menu.x, menu.y, 0, 0); setMenu(null); setAsking({ ids: menu.ids, at: () => at }); }}><Icon name="trash" size={15} />Delete{count}…</MenuItem>
        </>}
      </Menu>;
    })()}
    <div ref={shelf} key={showing} className="stickies-view" onKeyDown={sel.keys} onClick={event => { if (!(event.target as Element).closest('.sticky-card')) sel.clear(); }}>
      {showing === 'stickies'
        ? kept.length ? <>{group('On your screen', kept.filter(sticky => !sticky.closed))}{group('Closed', kept.filter(sticky => sticky.closed))}</>
          : <p className="stickies-none" data-flip="none">All your stickies are in the archive.</p>
        : group(null, archived)}
    </div>
  </div>;
}
