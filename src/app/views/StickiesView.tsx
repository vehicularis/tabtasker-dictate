import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { invoke, listen } from '../../bridge';
import { STICKY_HUES, type Sticky } from '../../store';
import { Button, EmptyState, PageHeader } from '../../ui';

const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };
/// A sticky's words as a glance: Markdown marks dropped, the first lines.
const glance = (text: string) => text.replace(/^#+\s*/gm, '').replace(/^[-*]\s+(\[[ x]\]\s*)?/gm, '• ').replace(/[*_`]/g, '').trim();

// Every sticky on the screen, in its colour: bring one forward, turn it into a note, or close it. New
// ones from here, the dots' menu, a shortcut, or by voice ("sticky: call Thomas").
export function StickiesView({ onError }: { onError: (message: string) => void }) {
  const [stickies, setStickies] = useState<Sticky[] | null>(null);
  const refresh = useCallback(() => { void invoke<Sticky[]>('sticky_list').then(setStickies, error => onError(message(error, 'Couldn’t read the stickies.'))); }, [onError]);
  useEffect(refresh, [refresh]);
  useEffect(() => { const off = listen('dictate-stickies', refresh); addEventListener('focus', refresh); return () => { off(); removeEventListener('focus', refresh); }; }, [refresh]);
  const act = (work: Promise<unknown>, failed: string) => void work.then(refresh, error => onError(message(error, failed)));
  return <>
    <PageHeader icon="sticky" title="Stickies">Small notes that stay on top of everything. Type into one, or hold fn and talk; or just say “sticky: call Thomas” while dictating.</PageHeader>
    <div className="stickies-head"><Button variant="primary" icon="plus" onClick={() => act(invoke('sticky_new', {}), 'Couldn’t make a sticky.')}>New sticky</Button></div>
    {stickies && !stickies.length && <EmptyState icon="sticky" title="No stickies on the screen">Make one above, from the dots’ menu, with its shortcut, or by saying “sticky” and the words while you dictate.</EmptyState>}
    <div className="stickies-grid">
      {stickies?.map(sticky => <article key={sticky.id} className="sticky-card" style={{ '--hue': STICKY_HUES[sticky.hue] } as CSSProperties} aria-label={glance(sticky.text).split('\n')[0] || 'Empty sticky'}>
        <button type="button" className="sticky-face" title="Bring it forward" onClick={() => act(invoke('sticky_show', { id: sticky.id }), 'Couldn’t show that sticky.')}>
          {glance(sticky.text) || <span className="sticky-empty">Empty</span>}
        </button>
        <footer>
          <Button small variant="quiet" icon="note" disabled={!sticky.text.trim()} onClick={() => act(invoke('sticky_to_note', { id: sticky.id, stamp: stamp() }), 'Couldn’t save it as a note.')}>Make a note</Button>
          <Button small variant="quiet" icon="close" onClick={() => act(invoke('sticky_remove', { id: sticky.id }), 'Couldn’t close that sticky.')}>Close</Button>
        </footer>
      </article>)}
    </div>
  </>;
}
