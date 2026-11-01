import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { invoke, listen } from './bridge';

type Phase = 'idle' | 'listening' | 'transcribing' | 'sending';
type Edge = 'bottom' | 'left' | 'right';
type Status = {
  enabled: boolean; microphone: 'allowed' | 'notDetermined' | 'denied'; accessibility: boolean;
  modelReady: boolean; modelPreparing: boolean; modelMessage: string; notes: string; openAtLogin?: boolean;
  // What "Press 🌐 key to" does instead of nothing: it competes with holding fn.
  globeKey: '' | 'inputSource' | 'emoji' | 'dictation';
  inputs: { id: string; name: string }[]; input: string | null; inputInUse: string;
};
// A spoken note under review: nothing is saved until Save.
type Draft = { title: string; text: string };
const DRAFT = 'tabtasker-dictate:note'; // kept on this Mac until saved or discarded, across a restart
const EDGE = 'tabtasker-dictate:edge'; // the screen edge the dots sit on
const GLOBE = { inputSource: 'changes the input source', emoji: 'opens emoji', dictation: 'starts Dictation' };

export const setupDone = (status: Status | null) =>
  !!status && status.enabled && status.microphone === 'allowed' && status.accessibility && status.modelReady;
const stored = <T,>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback; } catch { return fallback; } };
const store = (key: string, value: unknown) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* a convenience */ } };

// `?preview=…` shows one state without the app around it, for checking the design in a browser.
const PREVIEW = new URLSearchParams(location.search).get('preview');
const SAMPLE: Status = { enabled: true, microphone: 'allowed', accessibility: true, modelReady: true, modelPreparing: false, modelMessage: '', notes: '/Users/you/Documents/TabTasker Dictate', globeKey: '', openAtLogin: true,
  inputs: [{ id: 'built-in', name: 'MacBook Pro Microphone' }, { id: 'airpods', name: 'AirPods Pro' }], input: null, inputInUse: 'MacBook Pro Microphone' };
// Setup previews, one per step: setup, setup-fn, setup-test, setup-hold, setup-globe, setup-download, setup-model, setup-done.
const SETUP: Record<string, Partial<Status>> = {
  setup: { microphone: 'notDetermined', accessibility: false, enabled: false, modelReady: false },
  'setup-fn': { accessibility: false, enabled: false, modelReady: false },
  'setup-test': { enabled: false, modelReady: false },
  'setup-hold': { enabled: false, modelReady: false },
  'setup-globe': { enabled: false, modelReady: false, globeKey: 'emoji' },
  'setup-download': { enabled: false, modelReady: false },
  'setup-model': { modelReady: false, modelPreparing: true, modelMessage: 'Downloading Whisper large-v3 Turbo… 42%' },
  'setup-done': {},
};

export function Overlay() {
  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const dots = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<Status | null>(PREVIEW ? { ...SAMPLE, ...SETUP[PREVIEW] } : null);
  const [phase, setPhase] = useState<Phase>(PREVIEW === 'listening' || PREVIEW === 'typing' ? 'listening' : 'idle');
  const heard = useRef<Phase>('idle');
  const [dictating, setDictating] = useState(PREVIEW === 'typing');
  const level = useRef(PREVIEW === 'listening' ? 0.05 : 0);
  const [live, setLive] = useState<string | null>(PREVIEW === 'listening' ? 'Call the venue about Thursday and ask for the bigger room' : null);
  const [noting, setNoting] = useState(PREVIEW === 'listening');
  const noteRequested = useRef(false);
  const [since, setSince] = useState(() => PREVIEW === 'listening' ? Date.now() - 83_000 : 0); // when the note's recording began
  const [, setClock] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(() => PREVIEW === 'note' ? { title: 'Call the venue about Thursday', text: 'Call the venue about Thursday and ask for the bigger room. Then send Maria the new floor plan before lunch.' } : PREVIEW ? null : stored<Draft | null>(DRAFT, null));
  const [reviewing, setReviewing] = useState(PREVIEW === 'note');
  const [discarding, setDiscarding] = useState(false);
  const [saved, setSaved] = useState<string | null>(PREVIEW === 'saved' ? '/Users/you/Documents/TabTasker Dictate/2026-11-01 21.40 Call the venue about Thursday.md' : null);
  const [toast, setToast] = useState<string | null>(null);
  const [setup, setSetup] = useState(!!PREVIEW && PREVIEW in SETUP);
  const [hover, setHover] = useState(PREVIEW === 'hover' || PREVIEW === 'menu' || PREVIEW === 'mics');
  const [menu, setMenu] = useState(PREVIEW === 'menu' || PREVIEW === 'mics');
  const [mics, setMics] = useState(PREVIEW === 'mics');
  const [hidden, setHidden] = useState(false);
  const [edge, setEdge] = useState<Edge>(() => (new URLSearchParams(location.search).get('edge') as Edge | null) ?? stored<Edge>(EDGE, 'bottom'));
  const [fnTested, setFnTested] = useState(PREVIEW === 'setup-download' || PREVIEW === 'setup-model');
  const [fnDown, setFnDown] = useState(PREVIEW === 'setup-hold');
  const fnDownAt = useRef(0);

  const refresh = useCallback(() => { if (!PREVIEW) void invoke<Status>('status').then(setStatus).catch(() => {}); }, []);
  useEffect(refresh, [refresh]);
  // Setup follows macOS live: permissions and the model download change while it is open.
  useEffect(() => { if (!setup) return; const timer = setInterval(refresh, 1000); return () => clearInterval(timer); }, [setup, refresh]);
  const launched = useRef(false);
  useEffect(() => { if (status && !launched.current) { launched.current = true; if (!setupDone(status)) setSetup(true); } }, [status]); // once, at launch
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 2400); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!saved || PREVIEW) return; const timer = setTimeout(() => setSaved(null), 8000); return () => clearTimeout(timer); }, [saved]);
  useEffect(() => { if (!PREVIEW) store(DRAFT, draft); }, [draft]);
  useEffect(() => { // a note can run long: its bubble counts the time
    if (!noting || phase !== 'listening') return;
    const timer = setInterval(() => setClock(tick => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [noting, phase]);
  useEffect(() => { if (!menu) setMics(false); }, [menu]);

  // ---------- the native voice code ----------
  useEffect(() => {
    const offs = [
      listen<{ phase: Phase; level: number; dictating: boolean }>('dictate-state', next => {
        if (next.phase === 'listening' && heard.current !== 'listening') { // a new recording, not its 30-a-second levels
          setLive(null); setSaved(null); setMenu(false);
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
        setFnDown(down);
        if (down) fnDownAt.current = performance.now();
        else if (fnDownAt.current && performance.now() - fnDownAt.current > 350) setFnTested(true);
      }),
      listen('dictate-setup', () => { refresh(); setSetup(true); setHidden(false); }),
      listen('dictate-hide', () => setHidden(true)),
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
    if (PREVIEW) return;
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

  // ---------- drag the dots to the bottom, left or right edge ----------
  const drag = useRef<{ x: number; y: number; moving: boolean } | null>(null);
  const dragged = useRef(false);
  const [dragging, setDragging] = useState(false);
  const grab = (event: ReactPointerEvent) => { if (event.button === 0) drag.current = { x: event.clientX, y: event.clientY, moving: false }; };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = drag.current;
      if (!start || !dock.current) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!start.moving && Math.hypot(dx, dy) < 5) return; // a wobbly click is still a click
      start.moving = true;
      setDragging(true); setMenu(false);
      dock.current.style.translate = `${dx}px ${dy}px`;
    };
    const up = (event: PointerEvent) => {
      const start = drag.current;
      drag.current = null;
      if (!start?.moving || !dock.current || !dots.current) return;
      setDragging(false);
      dragged.current = true;
      setTimeout(() => { dragged.current = false; }); // the click that ends a drag fires before this
      const distances: Record<Edge, number> = { left: event.clientX, right: innerWidth - event.clientX, bottom: innerHeight - event.clientY };
      const next = (Object.keys(distances) as Edge[]).reduce((a, b) => distances[a] <= distances[b] ? a : b);
      const from = dots.current.getBoundingClientRect();
      root.current!.dataset.edge = next; // lay out at the new edge now, so the spring starts from the drop point
      dock.current.style.translate = '';
      const to = dots.current.getBoundingClientRect();
      dock.current.animate([{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: '0 0' }], { duration: 450, easing: 'cubic-bezier(.34, 1.36, .64, 1)' });
      setEdge(next); store(EDGE, next);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  }, []);

  // ---------- actions ----------
  const takeNote = () => {
    if (dragged.current) return;
    if (!setupDone(status)) { setSetup(true); return; }
    if (phase === 'idle') noteRequested.current = true;
    setHover(false); setMenu(false);
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
  const openSetup = () => { setMenu(false); refresh(); setSetup(true); };
  const hideForAnHour = () => { setMenu(false); setHidden(true); setTimeout(() => setHidden(false), 60 * 60 * 1000); };
  const pickMic = (id: string | null) => { setMenu(false); void invoke('set_input', { id }).then(refresh).catch(() => setToast('Couldn’t change the microphone')); };
  const login = () => { const on = !status?.openAtLogin; void invoke<boolean>('set_open_at_login', { enabled: on }).then(refresh).catch(() => setToast('Couldn’t change Open at Login')); };
  const clickDots = () => {
    if (dragged.current) return;
    if (draft && !reviewing) setReviewing(true);
    else if (phase === 'listening' && noting) takeNote();
    else if (!setupDone(status)) setSetup(true);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menu) setMenu(false); else if (setup) setSetup(false); else if (reviewing) setReviewing(false);
    };
    const away = (event: PointerEvent) => { if (menu && !(event.target as Element).closest('[role="menu"]')) setMenu(false); };
    addEventListener('keydown', key); addEventListener('pointerdown', away);
    return () => { removeEventListener('keydown', key); removeEventListener('pointerdown', away); };
  }, [setup, reviewing, menu]);

  if (hidden) return <div ref={root} className="layer" data-edge={edge} />;
  const mode = phase === 'listening' ? 'listening' : phase !== 'idle' ? 'thinking' : hover || menu ? 'hover' : 'idle';
  const card = setup || (draft && reviewing);
  return <div ref={root} className="layer" data-edge={edge} data-mode={mode} data-card={card || undefined} data-pending={(draft && !reviewing) || undefined} data-dragging={dragging || undefined}>
    <div ref={dock} className="dock">
      {setup && <Setup status={status} fnDown={fnDown} fnTested={fnTested} onClose={() => setSetup(false)} />}
      {!setup && draft && reviewing && <article className="glass card" data-glass data-hit aria-label="New note"
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}>
        <header className="head" onPointerDown={event => { if (!(event.target as Element).closest('button')) grab(event); }}><span className="name"><NoteIcon />New note</span><button type="button" className="close" aria-label="Hide note" onClick={() => setReviewing(false)}><X /></button></header>
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
      {saved && !card && <button type="button" className="glass said saved" data-glass data-hit onClick={() => { void invoke('show_notes', { file: saved }).catch(() => {}); setSaved(null); }}>
        <small>Saved · Show in Finder</small><span>{saved.split('/').pop()?.replace(/\.md$/, '')}</span>
      </button>}
      {toast && <p className="glass toast" data-glass role="status">{toast}</p>}
      <div className="spot" data-spot onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
        onContextMenu={event => { event.preventDefault(); if (phase === 'idle') { setMenu(true); refresh(); } }}>
        {menu && <div className="glass menu" data-glass data-hit role="menu"
          onPointerMove={event => { const row = (event.target as Element).closest('[role="menuitem"]'); if (row) setMics(row.hasAttribute('aria-haspopup')); }}>
          <button type="button" role="menuitem" onClick={() => { setMenu(false); takeNote(); }}><NoteIcon />New note</button>
          <button type="button" role="menuitem" onClick={() => { setMenu(false); void invoke('show_notes', {}).catch(() => {}); }}><FolderIcon />Show notes in Finder</button>
          <i className="rule" />
          {status && status.inputs.length > 0 && <div className="sub">
            <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={mics} onClick={() => setMics(!mics)}><MicIcon />Microphone<Caret /></button>
            {mics && <div className="glass menu submenu" data-glass data-hit role="menu" aria-label="Microphone">
              {[{ id: null, name: 'Automatic' }, ...status.inputs].map(({ id, name }) => {
                const on = (status.input ?? null) === id;
                return <button key={id ?? ''} type="button" role="menuitemradio" aria-checked={on} onClick={() => pickMic(id)}>{on ? <Check /> : <span className="icon" />}{name}</button>;
              })}
              <i className="rule" /><p className="in-use">Mic in use<span>{status.inputInUse}</span></p>
            </div>}
          </div>}
          <button type="button" role="menuitemcheckbox" aria-checked={!!status?.openAtLogin} onClick={login}>{status?.openAtLogin ? <Check /> : <span className="icon" />}Open at Login</button>
          <i className="rule" />
          <button type="button" role="menuitem" onClick={hideForAnHour}><AlarmIcon />Hide for an hour</button>
          <button type="button" role="menuitem" onClick={openSetup}><GearIcon />Set up…</button>
        </div>}
        <span className="glass capsule" data-glass aria-hidden="true" />
        <button ref={dots} type="button" className="dots" data-hit="16" aria-label={draft && !reviewing ? 'Open the note' : 'TabTasker Dictate'} onPointerDown={grab} onClick={clickDots}>
          <i /><i /><i />
        </button>
        <div className="glass pill" data-glass data-hit aria-hidden={mode !== 'hover'} onPointerDown={grab}>
          <button type="button" aria-label="Take a note" title="Take a note" tabIndex={mode === 'hover' ? 0 : -1} onClick={takeNote}><NoteIcon /></button>
          <button type="button" aria-label="Set up" title="Set up" tabIndex={mode === 'hover' ? 0 : -1} onClick={openSetup}><GearIcon /></button>
        </div>
        <Orb mode={mode} level={level} typing={dictating} onClick={() => { if (noting) takeNote(); }} />
        <span className="label" aria-hidden="true"><span className="glass"><kbd>fn</kbd> hold to type</span></span>
      </div>
    </div>
  </div>;
}

// ---------- setup: the microphone, the fn key, then the model, one step at a time ----------

function Setup({ status, fnDown, fnTested, onClose }: { status: Status | null; fnDown: boolean; fnTested: boolean; onClose: () => void }) {
  const [asked, setAsked] = useState(false);
  const ask = (kind: string) => { if (kind === 'accessibility') setAsked(true); void invoke('request', { kind }).catch(() => {}); };
  const notes = status?.notes.replace(/^\/Users\/[^/]+/, '~') ?? '~/Documents/TabTasker Dictate';
  const sheet = (title: string, body: ReactNode) => <article className="glass card setup" data-glass data-hit aria-label="Set up">
    <header className="head"><Logo size={28} /><strong>{title}</strong><button type="button" className="close" aria-label="Close" onClick={onClose}><X /></button></header>
    <Ways notes={notes} />
    {body}
  </article>;
  const ready = setupDone(status);
  if (ready) return sheet('You’re all set', <footer className="actions"><span className="ask" /><button type="button" className="btn primary" onClick={onClose}>Done</button></footer>);

  const mic = status?.microphone === 'allowed' ? 'done' : 'active';
  const keys = mic !== 'done' ? 'todo' : !status?.accessibility ? 'active' : fnTested ? 'done' : 'test';
  // Not a gate: a hold that gets through still passes the test.
  const globe = keys === 'test' && status?.globeKey ? GLOBE[status.globeKey] : undefined;
  const model = keys !== 'done' ? 'todo' : status?.enabled && status.modelReady ? 'done' : status?.modelPreparing ? 'busy' : 'active';
  const stalled = model === 'active' && !!status?.enabled; // on, but the last download or load failed
  const percent = Number(/(\d+(?:\.\d+)?)%/.exec(status?.modelMessage ?? '')?.[1] ?? 0);
  return sheet('Set up TabTasker Dictate', <>
    <Keyboard down={fnDown} />
    <ol className="steps">
      <Step index={1} status={mic} name="Microphone" line="Only on while you hold fn or take a note."
        action={mic === 'active' && <button type="button" className="btn primary" onClick={() => ask('microphone')}>{status?.microphone === 'denied' ? 'Open Settings' : 'Allow'}</button>} />
      <Step index={2} status={keys} name="fn key"
        line={globe ? <>Your 🌐 key {globe}, which gets in the way of <kbd>fn</kbd>. Open Settings, set “Press 🌐 key to” to Do Nothing, then hold fn here.</>
          : keys === 'test' ? <>Now hold <kbd>fn</kbd> to test it. If emoji open instead, set “Press 🌐 key to” to Do Nothing in <button type="button" className="link" onClick={() => ask('keyboard')}>Keyboard settings</button>.</>
          : asked ? 'If macOS asks, choose Open System Settings, then turn TabTasker Dictate on. Already on? Remove it with −, then turn it on again.'
          : 'Accessibility lets Dictate notice fn and type into any app.'}
        action={(keys === 'active' || globe) && <button type="button" className="btn primary" onClick={() => ask(globe ? 'keyboard' : 'accessibility')}>Open Settings</button>} />
      <Step index={3} status={model} name="Speech model"
        line={model === 'busy' ? <>{status?.modelMessage || 'Preparing…'}<span className="bar"><i style={{ width: `${percent}%` }} /></span></>
          : stalled ? status?.modelMessage || 'The download stopped.' : '875 MB, kept on this Mac. Your voice is transcribed here.'}
        action={model === 'active' && <button type="button" className="btn primary" onClick={() => void invoke('set_enabled', { enabled: true }).catch(() => {})}>{stalled ? 'Try again' : 'Download'}</button>} />
    </ol>
  </>);
}

function Step({ index, status, name, line, action }: { index: number; status: string; name: string; line: ReactNode; action: ReactNode }) {
  return <li data-status={status}><i className="num">{status === 'done' ? '✓' : index}</i><div><b>{name}</b><span>{line}</span></div>{action || null}</li>;
}

// The two ways in: what each does on the left, its key or button lined up on the right.
function Ways({ notes }: { notes: string }) {
  return <ul className="ways">
    <li><span className="what">Type where your cursor is<small>In any app, as you speak</small></span><span className="chord"><kbd>fn</kbd></span></li>
    <li><span className="what">Take a spoken note<small>As long as you like, saved as Markdown in {notes}</small></span><span className="chord"><kbd className="glyph"><NoteIcon /></kbd></span></li>
  </ul>;
}

// The corner of a Mac keyboard with the fn key; it is also the tester.
function Keyboard({ down }: { down: boolean }) {
  return <div className="keys" data-down={down || undefined} aria-hidden="true">
    <div className="krow"><i className="k wide">shift</i><i className="k">Z</i><i className="k">X</i><i className="k">C</i><i className="k">V</i></div>
    <div className="krow">
      <i className="k fn"><b>fn</b><Globe /></i>
      <i className="k"><b>⌃</b><span>control</span></i><i className="k"><b>⌥</b><span>option</span></i><i className="k wide"><b>⌘</b><span>command</span></i>
    </div>
  </div>;
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

// The app's objects, drawn like small enamel tiles with one light; the logo is the app icon's mark.
const Logo = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
  <rect x="1" y="1" width="26" height="26" rx="7" fill="#2a2420" />
  {[[7, 5.6], [10.4, 9.6], [17.6, 9.6], [21, 5.6]].map(([x, h]) => <rect key={x} x={x - 1} y={14 - h / 2} width="2" height={h} rx="1" fill="#E8913B" />)}
  <path d="M14 7v14M12.6 7h2.8M12.6 21h2.8" stroke="#f6efe4" strokeWidth="1.3" strokeLinecap="round" />
</svg>;
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
const FolderIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinejoin="round" aria-hidden="true">
  <path d="M3.5 8a2 2 0 0 1 2-2h5.5l2.5 2.5h9a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2z" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.2" />
  <path d="M3.5 11.5h21" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.2" />
</svg>;
const AlarmIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" aria-hidden="true">
  <circle cx="14" cy="15" r="8.5" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
  <path d="M14 10.5V15l3 2M5 6.5l3-2.5M23 6.5l-3-2.5" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.4" />
</svg>;
// The teeth are one dashed ring: eight dashes around r=10.4.
const GearIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" aria-hidden="true">
  <circle cx="14" cy="14" r="10.4" stroke="currentColor" strokeOpacity="0.55" strokeWidth="3.4" strokeDasharray="3.6 4.57" />
  <circle cx="14" cy="14" r="8.6" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
  <circle cx="14" cy="14" r="3" stroke="var(--ember)" strokeWidth="1.5" />
</svg>;
const Check = () => <svg className="icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>;
const Caret = () => <svg className="more" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg>;
const Globe = () => <svg width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16"><circle cx="128" cy="128" r="96" /><path d="M32 128h192M128 32c-28 26-40 60-40 96s12 70 40 96M128 32c28 26 40 60 40 96s-12 70-40 96" /></svg>;
const X = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
