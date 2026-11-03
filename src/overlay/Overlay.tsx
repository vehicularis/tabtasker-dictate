import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { invoke, listen } from '../bridge';
import { needsSetup, setupDone, updateSettings, useSettings, type Edge, type Events, type Status } from '../store';
import { applyTheme, isDark } from '../ui/theme';
import { leave } from '../ui/motion';
import { CommandCard } from './CommandCard';
import { Dock } from './Dock';
import { HandsFree } from './HandsFree';
import { Learned } from './Learned';
import { MeetingPill, useMeetingState } from './MeetingPill';
import { Menu } from './Menu';
import { PREVIEW, PREVIEW_EDGE, SAMPLE, SETUP } from './preview';
import { Setup } from './Setup';

type Phase = 'idle' | 'listening' | 'transcribing' | 'sending';
const EDGE = 'tabtasker-dictate:edge'; // where the dots sat before the edge moved into settings

const stored = <T,>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback; } catch { return fallback; } };
const store = (key: string, value: unknown) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* a convenience */ } };

export function Overlay() {
  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const dots = useRef<HTMLButtonElement>(null);
  const settings = useSettings();
  const [status, setStatus] = useState<Status | null>(PREVIEW ? { ...SAMPLE, ...SETUP[PREVIEW] } : null);
  const [phase, setPhase] = useState<Phase>(PREVIEW === 'listening' || PREVIEW === 'typing' ? 'listening' : 'idle');
  const heard = useRef<Phase>('idle');
  const [dictating, setDictating] = useState(PREVIEW === 'typing');
  const level = useRef(PREVIEW === 'listening' ? 0.05 : 0);
  const [live, setLive] = useState<string | null>(PREVIEW === 'listening' || PREVIEW === 'typing' ? 'Call the venue about Thursday and ask for the bigger room' : null);
  const [noting, setNoting] = useState(PREVIEW === 'listening');
  const noteRequested = useRef(false);
  const [since, setSince] = useState(() => PREVIEW === 'listening' ? Date.now() - 83_000 : 0); // when the note's recording began
  const [, setClock] = useState(0);
  const [saved, setSaved] = useState<string | null>(PREVIEW === 'saved' ? '/Users/you/Documents/TabTasker Dictate/2026-11-01 21.40 Call the venue about Thursday.md' : null);
  const [toast, setToast] = useState<string | null>(null);
  // The setup steps, as a card by the dots: for something only the person can do, or when asked for.
  const [setup, setSetup] = useState(!!PREVIEW && PREVIEW in SETUP);
  const [hover, setHover] = useState(PREVIEW === 'hover' || PREVIEW === 'menu' || PREVIEW === 'mics');
  const [menu, setMenu] = useState(PREVIEW === 'menu' || PREVIEW === 'mics');
  const [mics, setMics] = useState(PREVIEW === 'mics');
  const [meetings, lookMeetings] = useMeetingState();
  const [hidden, setHidden] = useState(false);
  // The edge from before settings kept it, used until it has moved over.
  const [legacyEdge, setLegacyEdge] = useState(() => PREVIEW ? null : stored<Edge | null>(EDGE, null));
  const [dropped, setDropped] = useState<Edge | null>(null); // where a drag just left the dots, while that saves
  const savedEdge = settings?.appearance.edge ?? 'bottom';
  const edge: Edge = PREVIEW_EDGE ?? dropped ?? (legacyEdge && savedEdge === 'bottom' ? legacyEdge : savedEdge);
  const [fnTested, setFnTested] = useState(PREVIEW === 'setup-download' || PREVIEW === 'setup-model');
  const [fnDown, setFnDown] = useState(PREVIEW === 'setup-hold');
  const fnDownAt = useRef(0);

  const refresh = useCallback(() => { if (!PREVIEW) void invoke<Status>('status').then(setStatus).catch(() => {}); }, []);
  useEffect(refresh, [refresh]);
  // Setup follows macOS live: permissions and the model download change while it is open.
  useEffect(() => { if (!setup) return; const timer = setInterval(refresh, 1000); return () => clearInterval(timer); }, [setup, refresh]);
  const launched = useRef(false);
  // Once, at launch: the setup steps only for something the person has to do, never for a model that is
  // still loading (the dots pulse for that), and not while Settings shows the full setup.
  useEffect(() => { if (status && !launched.current) { launched.current = true; if (needsSetup(status) && !status.firstRun) setSetup(true); } }, [status]);
  // While the model loads at launch the status is asked again every second, so the dots stop pulsing as it is ready.
  const loading = !!status && status.enabled && status.modelPreparing && !status.modelReady;
  useEffect(() => { if (!loading || setup) return; const timer = setInterval(refresh, 1000); return () => clearInterval(timer); }, [loading, setup, refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 2400); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!saved || PREVIEW) return; const timer = setTimeout(() => setSaved(null), 6000); return () => clearTimeout(timer); }, [saved]);
  useEffect(() => { // a note can run long: its bubble counts the time
    if (!noting || phase !== 'listening') return;
    const timer = setInterval(() => setClock(tick => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [noting, phase]);
  useEffect(() => { if (!menu) setMics(false); }, [menu]);

  // ---------- settings: the theme, and the edge moved over once from this page's own storage ----------
  const theme = settings?.appearance.theme;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  const migrating = useRef(false);
  useEffect(() => {
    if (!settings || !legacyEdge || migrating.current) return;
    migrating.current = true;
    // Settings that already have an edge of their own win over the old one.
    const move = legacyEdge !== settings.appearance.edge && settings.appearance.edge === 'bottom' ? updateSettings({ appearance: { edge: legacyEdge } }) : Promise.resolve();
    void move.then(() => { store(EDGE, null); setLegacyEdge(null); }).catch(() => { migrating.current = false; });
  }, [settings, legacyEdge]);
  useEffect(() => setDropped(null), [settings?.appearance.edge]);

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
      // A spoken note is done: it is saved as it is (the model names it, or its first words do) and opened
      // in the window, where it can be read and changed. Nothing to confirm.
      listen<{ text: string }>('dictate-note', note => {
        setLive(null);
        void invoke<string>('save_note', { title: '', text: note.text, stamp: stamp(new Date()), named: false })
          .then(path => { setSaved(path); return invoke('note_open', { path }); })
          .catch(error => setToast(typeof error === 'string' ? error : 'Couldn’t save the note. Check there’s space on your disk.'));
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
          // The radius as drawn: the box comes scaled (Appearance size, springs), the computed radius doesn't.
          const scale = element.offsetWidth ? element.getBoundingClientRect().width / element.offsetWidth : 1;
          return [...box(element), (parseFloat(style.borderTopLeftRadius) || 0) * scale, +style.opacity];
        });
        // Only what can take the pointer: the pill at rest is laid out but invisible and pointer-events none, and
        // as a hit it would make the window catch clicks over nothing and disagree with the page's own test.
        const hit = [...node.querySelectorAll<HTMLElement>('[data-hit]')].filter(element => element.getClientRects().length && getComputedStyle(element).pointerEvents !== 'none').map(element => box(element, Number(element.dataset.hit) || 0));
        const dark = isDark(); // the page's theme, which Appearance can pin apart from the Mac's
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
      setDropped(next);
      if (!PREVIEW) void updateSettings({ appearance: { edge: next } }).catch(() => setToast('Couldn’t move the dots there.'));
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
  const openSetup = () => { setMenu(false); refresh(); setSetup(true); };
  /// The window, at a place: your notes, a note, the settings…
  const openApp = useCallback((route?: string) => { setMenu(false); setHover(false); void invoke('open_app', route ? { route } : {}).catch(() => setToast('Couldn’t open Dictate.')); }, []);
  const openSettings = useCallback(() => openApp('settings'), [openApp]);
  // A note to type: a new file at once, open in the window with the keyboard in it (hold the key to talk into it).
  const writeNote = useCallback(() => {
    setMenu(false); setHover(false);
    void invoke<string>('note_new', { title: '', text: '', stamp: stamp(new Date()) }).then(path => invoke('note_open', { path }))
      .catch(error => setToast(typeof error === 'string' ? error : 'Couldn’t make a new note.'));
  }, []);
  const newSticky = useCallback(() => { setMenu(false); void invoke('sticky_new', {}).catch(error => setToast(typeof error === 'string' ? error : 'Couldn’t make a new sticky.')); }, []);
  // The global shortcut for a typed note, which the native side hears and hands here.
  useEffect(() => listen<{ what: string }>('dictate-open', ({ what }) => { if (what === 'writeNote') writeNote(); }), [writeNote]);
  // The Dock that hides itself, sliding out over the dots' edge: the dots step aside by its strip until it goes.
  const [dockInset, setDockInset] = useState(0);
  useEffect(() => listen<Events['dictate-dock']>('dictate-dock', dock => setDockInset(dock.shown && dock.edge === edge ? dock.strip : 0)), [edge]);
  const startMeeting = () => {
    setMenu(false);
    const action = meetings?.recording ? 'stop' : 'start';
    void invoke<boolean>('meeting', { action }).then(changed => { if (!changed && action === 'start') setToast('Couldn’t start the meeting.'); })
      .catch((error: unknown) => setToast(typeof error === 'string' ? error : 'Couldn’t start the meeting.'));
  };
  const hideForAnHour = () => { setMenu(false); setHidden(true); setTimeout(() => setHidden(false), 60 * 60 * 1000); };
  const pickMic = (id: string | null) => { setMenu(false); void invoke('set_input', { id }).then(refresh).catch(() => setToast('Couldn’t change the microphone.')); };
  const login = () => { const on = !status?.openAtLogin; void invoke<boolean>('set_open_at_login', { enabled: on }).then(refresh).catch(() => setToast('Couldn’t change whether Dictate opens at login.')); };
  // A click on the dots: stops a note being taken, finishes setup, or opens the window.
  const clickDots = () => {
    if (dragged.current) return;
    if (phase === 'listening' && noting) takeNote();
    else if (!setupDone(status)) setSetup(true);
    else openApp();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === ',' && event.metaKey) { event.preventDefault(); openSettings(); return; }
      if (event.key !== 'Escape') return;
      if (menu) setMenu(false); else if (setup) setSetup(false);
    };
    const away = (event: PointerEvent) => { if (menu && !(event.target as Element).closest('[role="menu"]')) setMenu(false); };
    addEventListener('keydown', key); addEventListener('pointerdown', away);
    return () => { removeEventListener('keydown', key); removeEventListener('pointerdown', away); };
  }, [setup, menu, openSettings]);

  // Nothing is drawn until the settings say which edge the dots are on. Hidden for an hour, the dots go but
  // an answer from Claude, a meeting or a hands-free session still shows, or its words would be lost.
  if (!settings) return <div ref={root} className="layer" data-edge={edge} />;
  if (hidden) return <div ref={root} className="layer" data-edge={edge} data-size={settings.appearance.size} style={{ '--dock-inset': `${dockInset}px` } as CSSProperties}>
    <div ref={dock} className="dock"><CommandCard /><MeetingPill /><HandsFree /></div>
  </div>;
  const mode = phase === 'listening' ? 'listening' : phase !== 'idle' ? 'thinking' : hover || menu ? 'hover' : 'idle';
  const card = setup;
  const quiet = settings.appearance.idle === 'hidden' && mode === 'idle' && !card && !saved && !toast;
  return <div ref={root} className="layer" data-edge={edge} data-mode={mode} data-size={settings.appearance.size} data-quiet={quiet || undefined} data-loading={loading || undefined}
    style={{ '--margin': `${settings.appearance.margin}px`, '--dock-inset': `${dockInset}px` } as CSSProperties}
    data-card={card || undefined} data-dragging={dragging || undefined}>
    <div ref={dock} className="dock">
      {setup && <Setup status={status} fnDown={fnDown} fnTested={fnTested} onClose={() => setSetup(false)} />}
      {noting && phase === 'listening' && !card && <p ref={leave} className="glass said" data-glass data-live role="status">
        <small>Note · {clockOf(since)}</small><span>{live ?? 'Listening…'}</span>
      </p>}
      {saved && !card && <button ref={leave} type="button" className="glass said saved" data-glass data-hit onClick={() => { void invoke('note_open', { path: saved }).catch(() => {}); setSaved(null); }}>
        <small>Saved · Open</small><span>{saved.split('/').pop()?.replace(/\.md$/, '')}</span>
      </button>}
      <CommandCard />
      <MeetingPill />
      <HandsFree />
      <Learned />
      {toast && <p ref={leave} className="glass toast" data-glass role="status">{toast}</p>}
      <Dock mode={mode} dots={dots} label="TabTasker Dictate" hint={settings.appearance.hint} quiet={quiet} level={level} typing={dictating} words={noting ? '' : live ?? ''}
        onHover={setHover} onGrab={grab} onDots={clickDots} onNote={takeNote} onWrite={writeNote} onSticky={newSticky} onMeeting={startMeeting} recording={!!meetings?.recording} onOpen={() => openApp('notes')} onSettings={openSettings} onOrb={() => { if (noting) takeNote(); }}
        onMenu={() => { if (phase === 'idle') { setMenu(true); refresh(); lookMeetings(); } }}
        menu={menu && <Menu status={status} mics={mics} meeting={!!meetings?.recording} onMics={setMics} onNote={() => { setMenu(false); takeNote(); }} onWriteNote={writeNote} onSticky={newSticky} onMeeting={startMeeting}
          onOpen={() => openApp()} onPasteLast={() => { setMenu(false); void invoke('paste_last').catch(() => {}); }} onPickMic={pickMic} onLogin={login}
          onHide={hideForAnHour} onSettings={openSettings} onSetup={openSetup} onQuit={() => { setMenu(false); void invoke('quit').catch(() => {}); }} />} />
    </div>
  </div>;
}

// ---------- helpers ----------

const clockOf = (start: number) => {
  const seconds = start ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const stamp = (now: Date) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
};
