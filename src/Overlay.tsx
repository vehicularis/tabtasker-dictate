import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke, listen } from './bridge';

type Phase = 'idle' | 'listening' | 'transcribing' | 'sending';
type Status = {
  enabled: boolean; microphone: 'allowed' | 'notDetermined' | 'denied'; accessibility: boolean;
  modelReady: boolean; modelPreparing: boolean; modelMessage: string; notes: string;
  // What "Press 🌐 key to" does instead of nothing: it competes with holding fn.
  globeKey: '' | 'inputSource' | 'emoji' | 'dictation';
  inputs: { id: string; name: string }[]; input: string | null; inputInUse: string;
};
// A spoken note under review: nothing is saved until Save.
type Draft = { title: string; text: string };
const DRAFT = 'tabtasker-dictate:note'; // kept on this Mac until saved or discarded, across a restart
const GLOBE = { inputSource: 'changes the input source', emoji: 'opens emoji', dictation: 'starts Dictation' };

export const setupDone = (status: Status | null) =>
  !!status && status.enabled && status.microphone === 'allowed' && status.accessibility && status.modelReady;

export function Overlay() {
  const root = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const heard = useRef<Phase>('idle');
  const [dictating, setDictating] = useState(false);
  const level = useRef(0);
  const [live, setLive] = useState<string | null>(null); // a note's newest words while it records
  const [noting, setNoting] = useState(false);
  const noteRequested = useRef(false);
  const [since, setSince] = useState(0); // when the note's recording began, for its clock
  const [, setClock] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(() => { try { return JSON.parse(localStorage.getItem(DRAFT) ?? 'null') as Draft | null; } catch { return null; } });
  const [reviewing, setReviewing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [hover, setHover] = useState(false);
  const [fnTested, setFnTested] = useState(false);
  const fnDownAt = useRef(0);

  const refresh = useCallback(() => { void invoke<Status>('status').then(setStatus).catch(() => {}); }, []);
  useEffect(refresh, [refresh]);
  // Setup follows macOS live: permissions and the model download change while it is open.
  useEffect(() => { if (!setup) return; const timer = setInterval(refresh, 1000); return () => clearInterval(timer); }, [setup, refresh]);
  const launched = useRef(false);
  useEffect(() => { if (status && !launched.current) { launched.current = true; if (!setupDone(status)) setSetup(true); } }, [status]); // once, at launch
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 2400); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(null), 8000); return () => clearTimeout(timer); }, [saved]);
  useEffect(() => { try { if (draft) localStorage.setItem(DRAFT, JSON.stringify(draft)); else localStorage.removeItem(DRAFT); } catch { /* in memory only */ } }, [draft]);
  useEffect(() => { // a note can run long: its bubble counts the time
    if (!noting || phase !== 'listening') return;
    const timer = setInterval(() => setClock(tick => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [noting, phase]);

  // ---------- the native voice code ----------
  useEffect(() => {
    const offs = [
      listen<{ phase: Phase; level: number; dictating: boolean }>('dictate-state', next => {
        if (next.phase === 'listening' && heard.current !== 'listening') { // a new recording, not its 30-a-second levels
          setLive(null); setSaved(null);
          if (noteRequested.current) { setNoting(true); setSince(Date.now()); }
        }
        if (next.phase === 'idle') { setNoting(false); noteRequested.current = false; }
        heard.current = next.phase;
        setPhase(next.phase);
        setDictating(next.phase !== 'idle' && next.dictating);
        level.current = next.phase === 'listening' ? next.level : 0;
      }),
      listen<{ text: string; live: boolean }>('dictate-said', said => { if (said.live) setLive(said.text); }),
      listen<{ text: string }>('dictate-note', note => {
        setDraft(current => current ? { ...current, text: `${current.text.trimEnd()} ${note.text}` } : { title: titleOf(note.text), text: note.text });
        setLive(null); setReviewing(true); setDiscarding(false);
      }),
      listen<{ message: string }>('dictate-error', ({ message }) => {
        if (message === 'microphone') setSetup(true);
        else if (message !== 'unheard') setToast(message);
      }),
      listen<{ message: string }>('dictate-notice', ({ message }) => setToast(message)),
      listen<{ down: boolean }>('dictate-fn', ({ down }) => {
        if (down) fnDownAt.current = performance.now();
        else if (fnDownAt.current && performance.now() - fnDownAt.current > 350) setFnTested(true);
      }),
      listen('dictate-setup', () => { refresh(); setSetup(true); }),
      // An overlay behind another app gets no hover from WebKit: the native side reports the pointer.
      listen<{ x: number; y: number } | null>('dictate-pointer', at => {
        const spot = root.current?.querySelector('[data-spot]');
        setHover(!!at && !!spot?.contains(document.elementFromPoint(at.x, at.y)));
      }),
    ];
    return () => offs.forEach(off => off());
  }, [refresh]);

  // ---------- tell the native window where the glass and the clickable parts are ----------
  useEffect(() => {
    let frame = 0, last = '';
    const report = () => {
      const node = root.current;
      if (node) {
        const box = (element: Element, pad = 0) => { const r = element.getBoundingClientRect(); return [r.x - pad, r.y - pad, r.width + pad * 2, r.height + pad * 2]; };
        const glass = [...node.querySelectorAll<HTMLElement>('[data-glass]')].filter(element => element.getClientRects().length).map(element => {
          const style = getComputedStyle(element);
          return [...box(element), parseFloat(style.borderTopLeftRadius) || 0, +style.opacity];
        });
        const hit = [...node.querySelectorAll<HTMLElement>('[data-hit]')].filter(element => element.getClientRects().length).map(element => box(element, Number(element.dataset.hit) || 0));
        const dark = !matchMedia('(prefers-color-scheme: light)').matches;
        const message = JSON.stringify([glass, hit, dark]);
        if (message !== last) { last = message; void invoke('layout', { glass, hit, dark }).catch(() => {}); }
      }
      frame = requestAnimationFrame(report);
    };
    report(); // at once: the window stays hidden until the first report, and a hidden window runs no frames
    return () => cancelAnimationFrame(frame);
  }, []);

  // ---------- actions ----------
  const takeNote = () => {
    if (!setupDone(status)) { setSetup(true); return; }
    if (phase === 'idle') noteRequested.current = true;
    setHover(false);
    void invoke('request', { kind: 'note' }).catch(() => { noteRequested.current = false; });
  };
  const save = async () => {
    if (!draft?.text.trim()) return;
    try {
      const path = await invoke<string>('save_note', { title: draft.title.trim(), text: draft.text, stamp: stamp(new Date()) });
      setDraft(null); setReviewing(false); setSaved(path);
    } catch (error) {
      setToast(typeof error === 'string' ? error : 'Couldn’t save the note');
    }
  };
  const discard = () => { setDraft(null); setReviewing(false); setDiscarding(false); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (setup) setSetup(false); else if (reviewing) setReviewing(false); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [setup, reviewing]);

  const mode = phase === 'listening' ? 'listening' : phase !== 'idle' ? 'thinking' : hover ? 'hover' : 'idle';
  const card = setup || (draft && reviewing);
  return <div ref={root} className="layer" data-mode={mode} data-pending={(draft && !reviewing) || undefined}>
    {setup && <Setup status={status} fnTested={fnTested} onClose={() => setSetup(false)} />}
    {!setup && draft && reviewing && <article className="glass card" data-glass data-hit aria-label="New note"
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}>
      <header className="head"><span className="name"><NoteIcon />New note</span><button type="button" className="close" aria-label="Hide note" onClick={() => setReviewing(false)}><X /></button></header>
      <input className="title" aria-label="Title" placeholder="Title" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
      <textarea className="text" aria-label="Note" value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} />
      {noting && live && <p className="more">{live}</p>}
      <footer className="actions">
        <button type="button" className="tool" aria-label="Keep talking" title="Keep talking" disabled={phase !== 'idle'} onClick={takeNote}><MicIcon /></button>
        {discarding
          ? <><span className="ask">Discard this note?</span>
            <button type="button" className="btn" onClick={() => setDiscarding(false)}>Keep</button>
            <button type="button" className="btn danger" onClick={discard}>Discard</button></>
          : <><span className="ask" />
            <button type="button" className="btn" onClick={() => setDiscarding(true)}>Discard</button>
            <button type="button" className="btn primary" disabled={!draft.text.trim()} onClick={() => void save()}>Save note</button></>}
      </footer>
    </article>}
    {noting && phase === 'listening' && !card && <p className="glass said" data-glass role="status">
      <small>Note · {clockOf(since)}</small><span>{live ?? 'Listening…'}</span>
    </p>}
    {saved && !card && <button type="button" className="glass said saved" data-glass data-hit onClick={() => { void invoke('show_notes', { file: saved }); setSaved(null); }}>
      <small>Saved · Show in Finder</small><span>{saved.split('/').pop()?.replace(/\.md$/, '')}</span>
    </button>}
    {toast && <p className="glass toast" data-glass role="status">{toast}</p>}
    <div className="spot" data-spot onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <button type="button" className="dots" data-hit="16" aria-label={draft && !reviewing ? 'Open the note' : 'TabTasker Dictate'}
        onClick={() => { if (draft && !reviewing) setReviewing(true); else if (phase === 'listening' && noting) takeNote(); else if (!setupDone(status)) setSetup(true); }}>
        <i /><i /><i />
      </button>
      <div className="glass pill" data-glass data-hit aria-hidden={mode !== 'hover'}>
        <button type="button" aria-label="Take a note" title="Take a note" tabIndex={mode === 'hover' ? 0 : -1} onClick={takeNote}><NoteIcon /></button>
        <button type="button" aria-label="Set up" title="Set up" tabIndex={mode === 'hover' ? 0 : -1} onClick={() => { refresh(); setSetup(true); }}><GearIcon /></button>
      </div>
      <Orb mode={mode} level={level} typing={dictating} onClick={() => { if (noting) takeNote(); }} />
    </div>
  </div>;
}

// ---------- setup: the microphone, Accessibility, the fn key, and the model ----------

function Setup({ status, fnTested, onClose }: { status: Status | null; fnTested: boolean; onClose: () => void }) {
  const ask = (kind: string) => void invoke('request', { kind }).catch(() => {});
  const mic = status?.microphone === 'allowed', access = !!status?.accessibility;
  const globe = status?.globeKey ? GLOBE[status.globeKey] : undefined;
  const model = !!status?.enabled && !!status.modelReady;
  return <article className="glass card setup" data-glass data-hit aria-label="Set up">
    <header className="head"><span className="name"><MicIcon />Set up TabTasker Dictate</span><button type="button" className="close" aria-label="Close" onClick={onClose}><X /></button></header>
    <p className="lead">Hold <kbd>fn</kbd> and talk to type where your cursor is. Click the note button for long notes, saved as Markdown in {status?.notes.replace(/^\/Users\/[^/]+/, '~') ?? 'Documents'}.</p>
    <ol className="steps">
      <Step done={mic} name="Microphone" line="Only on while you hold fn or take a note."
        action={!mic && <button type="button" className="btn primary" onClick={() => ask('microphone')}>{status?.microphone === 'denied' ? 'Open Settings' : 'Allow'}</button>} />
      <Step done={access} name="Accessibility" line="Lets your words type into other apps, and hears fn anywhere."
        action={!access && <button type="button" className="btn primary" onClick={() => ask('accessibility')}>Open Settings</button>} />
      <Step done={model} name="Whisper" line={status?.modelMessage || 'About 875 MB, downloaded once. Speech is transcribed on this Mac.'}
        action={!model && !status?.modelPreparing && <button type="button" className="btn primary" onClick={() => void invoke('set_enabled', { enabled: true }).catch(() => {})}>Download</button>} />
      <Step done={fnTested} name="Hold fn" line={globe ? `Your 🌐 key ${globe}: set “Press 🌐 key to” to Do Nothing.` : 'Hold fn for a moment to try it.'}
        action={globe && <button type="button" className="btn" onClick={() => ask('keyboard')}>Keyboard Settings</button>} />
    </ol>
    {setupDone(status) && <footer className="actions"><span className="ask">You’re all set.</span><button type="button" className="btn primary" onClick={onClose}>Done</button></footer>}
  </article>;
}

function Step({ done, name, line, action }: { done: boolean; name: string; line: string; action?: ReactNode }) {
  return <li className="step" data-done={done || undefined}>
    <span className="check" aria-hidden="true">{done ? '✓' : ''}</span>
    <span className="what">{name}<small>{line}</small></span>
    {action}
  </li>;
}

// ---------- the orb: level bars while a note records, a still caret while typing ----------

function Orb({ mode, level, typing, onClick }: { mode: string; level: { current: number }; typing: boolean; onClick: () => void }) {
  const bars = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (mode !== 'listening' || typing) return;
    let frame = 0, peak = 0.005, energy = 0.2;
    const draw = (now: number) => {
      peak = Math.max(level.current, peak * 0.995, 0.005);
      const target = 0.15 + 0.85 * Math.min(1, level.current / peak);
      energy += (target - energy) * (target > energy ? 0.35 : 0.1);
      bars.current?.querySelectorAll('i').forEach((bar, i) => {
        const sway = 0.5 + 0.5 * Math.sin(now / 140 + i * 1.7);
        (bar as HTMLElement).style.transform = `scaleY(${0.2 + 0.8 * energy * (0.35 + 0.65 * sway)})`;
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [mode, typing, level]);
  return <button type="button" className="orb" data-hit tabIndex={-1} aria-label={typing ? 'Typing' : 'Recording'} onClick={onClick}>
    {typing ? <span className="caret" /> : <span className="bars" ref={bars}><i /><i /><i /><i /><i /></span>}
  </button>;
}

// ---------- helpers ----------

// A note's file and heading: its first sentence, cut at a word to fit.
const titleOf = (text: string) => {
  const first = text.trim().split(/(?<=[.!?…])\s/)[0].replace(/[.!?…]+$/, '');
  if (first.length <= 60) return first || 'Voice note';
  const cut = first.slice(0, 60), space = cut.lastIndexOf(' ');
  return `${space > 20 ? cut.slice(0, space) : cut}…`;
};
const clockOf = (start: number) => {
  const seconds = start ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const stamp = (now: Date) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
};

const NoteIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M6 3.5h9l5 5v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-17a2 2 0 0 1 2-2z" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.2" />
  <path d="M15 3.5V7a1.5 1.5 0 0 0 1.5 1.5H20M7.5 12.5h7M7.5 15.5h5M7.5 18.5h3" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
  <g transform="rotate(38 20 17)"><rect x="18.4" y="7.5" width="3.2" height="10.5" rx="1.2" fill="currentColor" fillOpacity="0.85" /><path d="M18.4 18h3.2L20 21.6z" fill="#E0A33A" /></g>
</svg>;
const MicIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" aria-hidden="true">
  <rect x="9.5" y="2.5" width="9" height="14.5" rx="4.5" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
  <path d="M12 7.5h4M12 10h4M12 12.5h4" stroke="var(--ember)" strokeWidth="1.3" />
  <path d="M6.5 12.5a7.5 7.5 0 0 0 15 0M14 20v4M10.5 24.5h7" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.5" />
</svg>;
const GearIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
  <circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
</svg>;
const X = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
