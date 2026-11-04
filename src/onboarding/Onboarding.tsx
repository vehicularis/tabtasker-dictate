import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { closeWindow, invoke, listen } from '../bridge';
import { message } from '../lib/errors';
import { COMMAND_GLYPHS, GLOBE, KEY_NAMES } from '../lib/keyNames';
import { ask } from '../lib/request';
import { Caret, Desk, Dots, Field } from '../app/demo/Demo';
import { Claude } from '../app/settings/Claude';
import { Meetings } from '../app/settings/Meetings';
import { Notes } from '../app/settings/Notes';
import { aiIcon, aiName, setupDone, tilde, updateSettings, useSettings, useStatus, type DictateKey, type PageProps, type Patch, type Settings, type Status } from '../store';
import { Button, Icon, Kbd, ProgressBar, reduced, Segmented, Select, Toast, Toggle } from '../ui';
import { Logo } from '../overlay/icons';
import { Globe, Keyboard } from './Keyboard';
import '../overlay/command-card.css';
import '../overlay/meeting-pill.css';
import './onboarding.css';

// The first run, a step at a time, in the whole window. The steps down the left as a list of contents; the
// step beside it (what it's for, the one thing to do, Back and Continue); and on the right the stage, a
// picture of your screen drawn with the app's real parts (demo/), showing what the step is about. Each
// permission step shows what macOS says right now (polled while it is open) and never dead-ends: it says
// what to click in System Settings and opens it, and every step can be skipped and finished later.

type StepId = 'welcome' | 'microphone' | 'accessibility' | 'key' | 'model' | 'dots' | 'try' | 'extras' | 'done';
const STEPS: { id: StepId; name: string }[] = [
  { id: 'welcome', name: 'Welcome' }, { id: 'microphone', name: 'Microphone' }, { id: 'accessibility', name: 'Accessibility' },
  { id: 'key', name: 'Your key' }, { id: 'model', name: 'Speech' }, { id: 'dots', name: 'The pill' },
  { id: 'try', name: 'Try it' }, { id: 'extras', name: 'Extras' }, { id: 'done', name: 'Done' },
];
// A hold this long is a hold, not a tap: the same as the overlay's key test.
const HOLD_MS = 350;
// How long after a hold is let go its last words may still arrive: long enough for Whisper's final pass,
// short enough that typing by hand afterwards doesn't count.
const SETTLE_MS = 4_000;

const voiceReady = (status: Status) => status.enabled && status.modelReady;

/// What still stands between this Mac and dictating, with the step that fixes it.
const missing = (status: Status) => ([
  ['microphone', 'allow the microphone', status.microphone !== 'allowed'],
  ['accessibility', 'turn on Accessibility', !status.accessibility],
  ['model', 'download the speech model', !voiceReady(status)],
] as [StepId, string, boolean][]).filter(([, , open]) => open);

type Key = { down: boolean; tested: boolean };

/// The dictate key as the native side reports it (`dictate-fn` follows the chosen key). It counts as
/// tested once held and let go, and a newly chosen key is tested again.
function useDictateKey(chosen: DictateKey | undefined): Key {
  const [down, setDown] = useState(false);
  const [tested, setTested] = useState<DictateKey | null>(null);
  const since = useRef(0), key = useRef(chosen);
  key.current = chosen;
  useEffect(() => listen<{ down: boolean }>('dictate-fn', event => {
    setDown(event.down);
    if (event.down) { since.current = performance.now(); return; }
    if (since.current && performance.now() - since.current > HOLD_MS) setTested(key.current ?? null);
    since.current = 0;
  }), []);
  return { down, tested: !!chosen && tested === chosen };
}

type Sheet = 'claude' | 'meetings' | 'notes';
const SHEETS: Record<Sheet, [string, ComponentType<PageProps>]> = { claude: ['AI', Claude], meetings: ['Meetings', Meetings], notes: ['Notes', Notes] };

/// The frame Onboarding puts round every step: its count, Back and Continue, and the part that scrolls (for
/// the fade at the edge it scrolls on toward).
type Frame = { count: string; nav: ReactNode; scroll: RefObject<HTMLDivElement | null> };
type Step = {
  status: Status; settings: Settings; update: (patch: Patch) => Promise<Settings | undefined>; dictateKey: Key;
  practiced: boolean; onPracticed: () => void; go: (id: StepId) => void; open: (sheet: Sheet) => void; frame: Frame;
};

export function Onboarding() {
  const settings = useSettings();
  const [status] = useStatus(1000);
  const [at, setAt] = useState(0);
  const [practiced, setPracticed] = useState<DictateKey | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dictateKey = useDictateKey(settings?.shortcuts.dictate);
  const scroll = useRef<HTMLDivElement>(null);
  const hideToast = useCallback(() => setToast(null), []);
  const update = useCallback((patch: Patch) => updateSettings(patch).catch(error => { setToast(message(error, 'Couldn’t save that change. Try again.')); return undefined; }), []);

  // A new step takes the focus, so the keyboard and VoiceOver start there; a field that asked for it keeps it.
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) { moved.current = true; return; }
    const kept = [...document.querySelectorAll('.setup-step, .setup-stage')].some(part => part.contains(document.activeElement));
    if (!kept) document.getElementById('setup-title')?.focus();
  }, [at]);

  // Marks which way the step has more to scroll to, for the fade at that edge.
  const loaded = !!settings && !!status;
  useEffect(() => {
    const step = scroll.current;
    if (!step) return;
    const mark = () => {
      const more = [step.scrollTop > 1 && 'up', step.scrollTop + step.clientHeight < step.scrollHeight - 1 && 'down'].filter(Boolean).join(' ');
      if (more) step.dataset.more = more; else delete step.dataset.more;
    };
    const resized = new ResizeObserver(mark);
    resized.observe(step);
    if (step.firstElementChild) resized.observe(step.firstElementChild);
    step.addEventListener('scroll', mark, { passive: true });
    return () => { resized.disconnect(); step.removeEventListener('scroll', mark); };
  }, [at, loaded]);

  if (!settings || !status) return <div className="onboarding" />;
  const step = STEPS[at];
  const chosen = settings.shortcuts.dictate;
  const go = (id: StepId) => setAt(STEPS.findIndex(candidate => candidate.id === id));
  const ready = (id: StepId) => {
    switch (id) {
      case 'microphone': return status.microphone === 'allowed';
      case 'accessibility': return status.accessibility;
      case 'key': return dictateKey.tested;
      case 'model': return voiceReady(status);
      case 'try': return practiced === chosen;
      default: return true;
    }
  };
  // Steps with nothing to do count once passed; the others as soon as they are true, even ahead.
  const done = (id: StepId, i: number) => ready(id) && (i < at || !['welcome', 'dots', 'extras', 'done'].includes(id));
  const last = at === STEPS.length - 1;
  const finished = setupDone(status);
  const nav = <footer className="setup-nav">
    {at > 0 ? <Button variant="quiet" onClick={() => setAt(at - 1)}>Back</Button> : <span />}
    <span className="end">
      {last ? <>
        <Button onClick={() => { location.hash = 'settings'; }}>Open Settings</Button>
        <Button variant="primary" onClick={closeWindow}>{finished ? 'Start dictating' : 'Close'}</Button>
      </> : ready(step.id)
        ? <Button variant="primary" onClick={() => setAt(at + 1)}>{at === 0 ? 'Start' : 'Continue'}</Button>
        : <Button onClick={() => setAt(at + 1)}>Skip for now</Button>}
    </span>
  </footer>;
  const props: Step = { status, settings, update, dictateKey, practiced: practiced === chosen, onPracticed: () => setPracticed(chosen), go, open: setSheet,
    frame: { count: `${at + 1} of ${STEPS.length}`, nav, scroll } };
  const Body = BODIES[step.id];

  return <div className="onboarding">
    <div className="titlebar" data-tauri-drag-region />
    {!last && <Button variant="quiet" small className="setup-leave" onClick={() => { location.hash = 'settings'; }}>Open Settings</Button>}
    <nav className="setup-toc" aria-label="Setup steps">
      <ol>
        {STEPS.map((candidate, i) => {
          const tick = done(candidate.id, i);
          return <li key={candidate.id}>
            <button type="button" aria-label={`${candidate.name}${tick ? ', done' : ''}`} aria-current={i === at ? 'step' : undefined} data-done={tick || undefined} onClick={() => setAt(i)}>
              <span className="setup-tick">{tick && <Icon name="check" size={14} />}</span>{candidate.name}
            </button>
          </li>;
        })}
      </ol>
    </nav>
    <Body key={step.id} {...props} />
    {sheet && <PageSheet sheet={sheet} settings={settings} update={update} onClose={() => setSheet(null)} />}
    {toast && <Toast message={toast} error onDone={hideToast} />}
  </div>;
}

// ---------- the step and its stage ----------

/// One step: on the left its count, title, why and the one thing to do (`children`), then Back and Continue;
/// on the right the stage and a line naming what's on it. The stage is a picture, kept from the keyboard and
/// VoiceOver, unless it's `live` (the practice box, the keys you'll press).
function Split({ frame, title, why, children, stage, caption, live = false }: {
  frame: Frame; title: ReactNode; why: ReactNode; children?: ReactNode; stage: ReactNode; caption: ReactNode; live?: boolean;
}) {
  return <>
    <main className="setup-step" aria-labelledby="setup-title">
      <div ref={frame.scroll} className="setup-scroll">
        <div className="setup-body">
          <p className="setup-count">{frame.count}</p>
          <h1 id="setup-title" tabIndex={-1}>{title}</h1>
          {why}
          {children && <div className="setup-do">{children}</div>}
        </div>
      </div>
      {frame.nav}
    </main>
    <figure className="setup-stage">
      <div className="setup-screen" inert={!live} aria-hidden={!live || undefined}>{stage}</div>
      <figcaption>{caption}</figcaption>
    </figure>
  </>;
}

const Why = ({ children }: { children: ReactNode }) => <p className="setup-why">{children}</p>;

/// Where a loop of `length` ms is now, a tick at a time. Under reduced motion it stays at `still`, the frame
/// that means the most.
function useLoop(length: number, still: number, tick = 100) {
  const [t, setT] = useState(() => reduced() ? still : 0);
  useEffect(() => {
    if (reduced()) return;
    const start = performance.now();
    const timer = setInterval(() => setT((performance.now() - start) % length), tick);
    return () => clearInterval(timer);
  }, [length, tick]);
  return t;
}

/// A close-up in the middle of the stage: `children` at their own size (or `width` × `height`), scaled to fit up to
/// `max`. Never below `min`: past that it's cropped by the stage's edge like a photo, keeping its `lean` side in view.
function Zoom({ width, height, min = 0, max = 1.5, lean, children }: { width?: number; height?: number; min?: number; max?: number; lean?: 'start' | 'end'; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null), scene = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 0, x: '50%' });
  useLayoutEffect(() => {
    const outer = box.current, inner = scene.current;
    if (!outer || !inner) return;
    const place = () => {
      const scale = Math.max(min, Math.min(outer.clientWidth / inner.offsetWidth, outer.clientHeight / inner.offsetHeight, max));
      const half = inner.offsetWidth * scale / 2, room = outer.clientWidth;
      setFit({ scale, x: half * 2 <= room || !lean ? '50%' : `${lean === 'start' ? half : room - half}px` });
    };
    const watch = new ResizeObserver(place);
    watch.observe(outer); watch.observe(inner);
    return () => watch.disconnect();
  }, [min, max, lean]);
  return <div ref={box} className="setup-zoom">
    <div ref={scene} className="setup-scene" style={{ left: fit.x, width, height, transform: `translate(-50%, -50%) scale(${fit.scale})` }}>{children}</div>
  </div>;
}

// Another app's text field, high on the screen, and the dots' layer along its bottom edge.
const FIELD: CSSProperties = { left: '50%', top: '34%', width: 'min(400px, calc(100% - 48px))', transform: 'translateX(-50%)' };
const BOTTOM: CSSProperties = { left: 0, right: 0, bottom: 0, height: 160 };
const SAID = 'Thursday works. Can we take the bigger room?';
const WORDS = SAID.split(' ');

// ---------- the steps ----------

function Welcome({ settings, frame }: Step) {
  // Hold the key and the dots become the orb, which writes your words as you say them; let go, and they land
  // in the field. Then a pause, and again.
  const t = useLoop(8400, 5200);
  const mode = t >= 900 && t < 3700 ? 'listening' : t >= 3700 && t < 4200 ? 'thinking' : 'idle';
  const said = mode === 'listening' && t >= 1100 ? WORDS.slice(0, Math.floor((t - 1100) / 260) + 1).join(' ') : '';
  return <Split frame={frame} title={<span className="setup-brand"><Logo size={44} /><span>Welcome to TabTasker | Dictate</span></span>}
    why={<>
      <Why>Hold {KEY_NAMES[settings.shortcuts.dictate]} and talk. When you let go, what you said is typed wherever your cursor is.</Why>
      <Why>Everything happens on your Mac, so your voice never leaves it, and there’s no account to make.</Why>
    </>}
    stage={<Desk>
      <Field label="Message to Maria" style={FIELD}><p className="demo-typed">{t >= 4200 && t < 7800 && <span className="setup-landed">{SAID}</span>}<Caret /></p></Field>
      <Dots mode={mode} typing words={said} still={reduced()} at={BOTTOM} />
    </Desk>}
    caption="The pill at the edge of your screen turns into the orb while you talk." />;
}

function Microphone({ status, frame }: Step) {
  const mic = status.microphone;
  const [problem, setProblem] = useState<string | null>(null);
  // The orb comes while the key is held and goes when it's let go.
  const t = useLoop(5600, 2500);
  return <Split frame={frame} title="Your microphone" why={<Why>Dictate only listens while you’re holding your key or recording a note.</Why>}
    stage={<Zoom width={200} height={84} max={1.6}><Dots mode={t >= 1200 && t < 4600 ? 'listening' : 'idle'} still={reduced()} at={{ inset: 0 }} /></Zoom>}
    caption="The orb shows up while Dictate is listening and turns back into the pill when you let go.">
    {mic === 'allowed' ? <>
      <Allowed>Allowed</Allowed>
      <div className="setup-row">
        <span className="setup-row-text"><span className="setup-row-title">Listen with</span><span className="setup-row-detail">{problem ?? `Right now that’s ${status.inputInUse}.`}</span></span>
        <Select label="Microphone" value={status.input ?? ''} options={[{ value: '', label: 'Automatic' }, ...status.inputs.map(input => ({ value: input.id, label: input.name }))]}
          onChange={id => { setProblem(null); void invoke('set_input', { id: id || null }).catch(() => setProblem('Couldn’t switch to that microphone. Try again.')); }} />
      </div>
    </> : <>
      <span className="setup-action">
        <Button variant="primary" onClick={() => ask('microphone')}>{mic === 'denied' ? 'Open System Settings' : 'Allow microphone'}</Button>
        <span className="setup-hint">{mic === 'denied' ? 'It’s turned off in System Settings.' : 'When macOS asks, choose Allow.'}</span>
      </span>
      {mic === 'denied' && <HowTo steps={[
        <>Click <b>Open System Settings</b>.</>,
        <>In <b>Privacy &amp; Security › Microphone</b>, turn on <b>TabTasker | Dictate</b>.</>,
        <>Come back here, and this step updates on its own.</>,
      ]} />}
    </>}
  </Split>;
}

function Accessibility({ status, frame }: Step) {
  const on = status.accessibility;
  // The words going into the other app after you let go, a keystroke at a time, as Dictate types them.
  const t = useLoop(6400, 5000, 40);
  return <Split frame={frame} title="Accessibility" why={<Why>Dictate needs this to notice your key and type into other apps.</Why>}
    stage={<Desk>
      <Field label="Message to Maria" style={FIELD}><p className="demo-typed">{t < 6000 && SAID.slice(0, Math.max(0, Math.floor((t - 800) / 32)))}<Caret /></p></Field>
      <Dots mode={t < 700 ? 'thinking' : 'idle'} still at={BOTTOM} />
    </Desk>}
    caption="With Accessibility on, Dictate can type your words into the app you’re using.">
    {on ? <Allowed>On</Allowed> : <>
      <span className="setup-action">
        <Button variant="primary" onClick={() => ask('accessibility')}>Open System Settings</Button>
        <span className="setup-hint">It’s off right now.</span>
      </span>
      <HowTo steps={[
        <>Click <b>Open System Settings</b>. If macOS asks first, choose <b>Open System Settings</b> there too.</>,
        <>In <b>Privacy &amp; Security › Accessibility</b>, turn on <b>TabTasker | Dictate</b>.</>,
        <>If it still says off after a few seconds, select <b>TabTasker | Dictate</b>, remove it with <b>−</b> and add it back with <b>+</b>.</>,
      ]} />
    </>}
  </Split>;
}

const KEY_OPTIONS: { value: DictateKey; label: string }[] = [
  { value: 'fn', label: 'fn' }, { value: 'rightCommand', label: 'Right ⌘' }, { value: 'rightOption', label: 'Right ⌥' },
  { value: 'rightControl', label: 'Right ⌃' }, { value: 'rightShift', label: 'Right ⇧' },
];

function ChooseKey({ status, settings, update, dictateKey, go, frame }: Step) {
  const chosen = settings.shortcuts.dictate;
  const name = KEY_NAMES[chosen];
  const globe = chosen === 'fn' && status.globeKey ? GLOBE[status.globeKey] : null;
  return <Split frame={frame} title="Choose your key" why={<Why>Hold it while you talk and let go when you’re done. Pick the one that’s easiest for you to reach.</Why>}
    stage={<Zoom min={.72} max={1.25} lean={chosen === 'fn' ? 'start' : 'end'}><Keyboard chosen={chosen} down={dictateKey.down} /></Zoom>}
    caption={dictateKey.down ? 'It lights up for as long as you hold it.' : `Your key is ringed. Hold ${name} and it lights up.`}>
    <Segmented label="Key to hold" value={chosen} options={KEY_OPTIONS} onChange={dictate => void update({ shortcuts: { dictate } })} />
    <p className="setup-status" role="status" data-ok={dictateKey.tested || undefined}>
      {dictateKey.tested ? <><Icon name="check" size={16} />That works. Hold <Kbd>{name}</Kbd> whenever you want to talk.</>
        : dictateKey.down ? 'Keep holding, then let go.'
        : <>Hold <Kbd>{name}</Kbd> for a moment, then let go to try it.</>}
    </p>
    {globe && <div className="setup-callout">
      <p><b>Your globe key {globe}.</b> That gets in the way of fn, so set <b>Press <Globe size={11} /> key to</b> to <b>Do Nothing</b>.</p>
      <Button onClick={() => ask('keyboard')}>Open Keyboard Settings</Button>
    </div>}
    {/* Dictate takes over the globe key's own shortcut itself; the warning above is for when it can't. */}
    {chosen === 'fn' && !globe && <p className="setup-note">While fn is your key, Dictate turns off <Globe size={11} />’s own shortcut and puts it back when you quit.</p>}
    {chosen === 'rightControl' && <p className="setup-note">Only some external keyboards have a right ⌃, since Apple’s put the arrow keys there.</p>}
    {!status.accessibility ? <p className="setup-note">Until Accessibility is on, your key only works while this window is in front. <button type="button" className="link" onClick={() => go('accessibility')}>Turn it on</button></p>
      : settings.shortcuts.handsFree && <p className="setup-note">You can also double-tap it to keep listening without holding, then tap again to finish.</p>}
  </Split>;
}

const CODES = 'ar bg bn ca cs da de el en es fa fi fr he hi hr hu id it ja ko ms nl no pl pt ro ru sk sl sr sv th tr uk ur vi zh'.split(' ');
const names = new Intl.DisplayNames(['en'], { type: 'language' });
const LANGUAGES = CODES.map(value => ({ value, label: names.of(value) ?? value })).sort((a, b) => a.label.localeCompare(b.label));

function Model({ status, settings, update, frame }: Step) {
  const { language, model } = settings.dictation;
  const languages = [{ value: 'auto', label: 'Detect automatically' }, ...LANGUAGES];
  if (!languages.some(option => option.value === language)) languages.push({ value: language, label: language });
  const ready = voiceReady(status);
  const preparing = status.modelPreparing;
  const stalled = status.enabled && !ready && !preparing; // on, but the last download or load failed
  const percent = Number(/(\d+(?:\.\d+)?)%/.exec(status.modelMessage)?.[1] ?? NaN);
  // The overlay's own sign: while the model gets ready, the dots light up one after another (overlay.css).
  // Once it's ready, what it does: you talk, let go, and the orb's wave is your Mac writing it down.
  const loading = status.enabled && preparing && !ready;
  const t = useLoop(5200, 2600);
  const mode = !ready ? 'idle' : t >= 800 && t < 2200 ? 'listening' : t >= 2200 && t < 4000 ? 'thinking' : 'idle';
  return <Split frame={frame} title="Speech model" why={<Why>This is what turns your voice into text, right on your Mac. It downloads once and works offline after that.</Why>}
    stage={<Zoom width={200} height={84} max={1.6}><Dots mode={mode} loading={loading} still={reduced()} at={{ inset: 0 }} /></Zoom>}
    caption={loading ? 'While it gets ready, the bars on the pill light up one after another.' : ready ? 'When you let go, the orb’s wave is your Mac turning what you said into text.' : 'Once it’s downloaded, the pill is all you’ll see until you hold your key.'}>
    <div className="setup-row">
      <span className="setup-row-text"><span className="setup-row-title">Language</span><span className="setup-row-detail">Choosing yours helps it get the first few words right.</span></span>
      <Select label="Language" value={language} options={languages} onChange={next => void update({ dictation: { language: next } })} />
    </div>
    <div className="setup-row">
      <span className="setup-row-text"><span className="setup-row-title">Model</span><span className="setup-row-detail">{model === 'turbo' ? 'It’s the most accurate, at about 875 MB to download.' : 'It’s faster and lighter, but a little less accurate.'}</span></span>
      <Segmented label="Model" value={model} options={[{ value: 'turbo', label: 'Turbo' }, { value: 'small', label: 'Small' }]} onChange={next => void update({ dictation: { model: next } })} />
    </div>
    {ready ? <Allowed>Ready</Allowed> : <div className="setup-download">
      <span className="setup-row-title">{preparing ? (/download/i.test(status.modelMessage) ? 'Downloading' : 'Getting it ready') : stalled ? 'The download stopped' : status.modelMessage ? 'Dictation is paused' : 'Not downloaded yet'}</span>
      {preparing && <ProgressBar label="Speech model download" value={Number.isNaN(percent) ? null : percent / 100} />}
      {status.modelMessage && <span className="setup-row-detail">{status.modelMessage}</span>}
      {!preparing && <Button variant="primary" onClick={() => void invoke('set_enabled', { enabled: true }).catch(() => {})}>{stalled ? 'Try again' : status.modelMessage ? 'Turn on' : 'Download'}</Button>}
    </div>}
  </Split>;
}

// The pill's buttons, in its order (PILL_BUTTONS).
const PILL_ROWS: [string, string][] = [
  ['Speak a note', 'Talk for as long as you like, and it’s saved as a note when you stop.'],
  ['Write a note', 'Opens a blank note to type into.'],
  ['New sticky', 'Puts a blank sticky on your screen, on top of your other windows.'],
  ['Record a meeting', 'Records the room or both sides of a call, and works out who said what.'],
  ['Your notes', 'Opens the window with everything you’ve saved.'],
  ['Settings', 'Opens Settings, where you choose which of these buttons show.'],
];

function TheDots({ frame }: Step) {
  const [active, setActive] = useState<number | null>(null);
  return <Split frame={frame} title="The pill" why={<Why>It sits at the edge of your screen and opens into buttons when you point at it.</Why>}
    stage={<Zoom width={320} height={110} max={1.7}>
      <div className="setup-pill" data-active={active ?? undefined}>
        <Dots mode="hover" at={{ inset: 0 }} />
        <ol className="setup-marks">{PILL_ROWS.map(([title], i) => <li key={title} data-dim={(active !== null && active !== i) || undefined}><b>{i + 1}</b></li>)}</ol>
      </div>
    </Zoom>}
    caption={active === null ? 'When you point at the pill, it opens into these buttons.' : PILL_ROWS[active][1]}>
    <ol className="setup-buttons" onPointerLeave={() => setActive(null)}>
      {PILL_ROWS.map(([title, detail], i) => <li key={title} tabIndex={0} aria-description={detail} data-on={active === i || undefined}
        onPointerEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}><b className="setup-mark">{i + 1}</b>{title}</li>)}
    </ol>
    <p className="setup-note">Right-click them for everything else, or drag them to another edge.</p>
  </Split>;
}

function TryIt({ status, settings, dictateKey, practiced, onPracticed, go, frame }: Step) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  // Text counts only while a hold that began in the box lasts, and for a moment after it: a tap, a hold
  // somewhere else and typing by hand don't pass.
  const counts = useRef({ since: 0, until: 0 });
  useEffect(() => listen<{ down: boolean }>('dictate-fn', ({ down }) => {
    const now = performance.now(), { since } = counts.current;
    if (down) counts.current = document.activeElement === box.current ? { since: now, until: Infinity } : { since: 0, until: 0 };
    else counts.current = { since: 0, until: since && now - since > HOLD_MS ? now + SETTLE_MS : 0 };
  }), []);
  const name = KEY_NAMES[settings.shortcuts.dictate];
  const needs = missing(status);
  // The practice box is the other app, on the stage, and the real dictation fills it.
  const stage = <Desk>
    <Field label="Practice" style={FIELD}>
      <textarea ref={box} className="setup-practice" aria-label="Practice" autoFocus={!needs.length} disabled={!!needs.length} spellCheck={false} value={text}
        placeholder={needs.length ? 'Finish setup to practise here' : `Hold ${name} and talk…`}
        onChange={event => {
          setText(event.target.value);
          if (performance.now() < counts.current.until && /\p{L}/u.test(event.target.value)) onPracticed();
        }} />
    </Field>
  </Desk>;
  return <Split frame={frame} title="Try it" live stage={stage} caption="This box stands in for any app you type in."
    why={<Why>{needs.length ? 'Finish what’s left, then you can practise here.' : <>Click in the box, hold <Kbd>{name}</Kbd> and say something, then let go.</>}</Why>}>
    {needs.length ? <Left needs={needs} go={go} /> : <p className="setup-status" role="status" data-ok={practiced || undefined}>
      {practiced ? <><Icon name="check" size={16} />That’s it. It works the same way in every app.</>
        : dictateKey.down ? 'Listening…' : 'Try saying “Remind me to call Maria at three tomorrow.”'}
    </p>}
  </Split>;
}

const EXTRA_CAPTIONS: Record<Sheet, string> = {
  claude: 'The AI’s answers show up by the pill, ready to insert where you were typing.',
  meetings: 'A meeting records until you stop it, both sides of a call included.',
  notes: 'Every note you speak is saved as a file in this folder.',
};

function Extras({ status, settings, update, open, frame }: Step) {
  const [shown, setShown] = useState<Sheet>('claude');
  const connected = settings.claude.enabled;
  const row = (id: Sheet) => ({ onPointerEnter: () => setShown(id), onFocus: () => setShown(id), 'data-shown': shown === id || undefined });
  return <Split frame={frame} title="Extras" why={<Why>These are all optional, and you’ll find them in Settings later too.</Why>}
    stage={<Zoom width={420} height={shown === 'claude' ? 270 : 110} max={1.3}><Dots mode="idle" at={{ inset: 0 }}><Extra shown={shown} /></Dots></Zoom>}
    caption={EXTRA_CAPTIONS[shown]}>
    <ul className="setup-rows">
      <li {...row('claude')}>
        <span className="setup-row-text"><span className="setup-row-title">Connect AI</span>{!connected && <span className="setup-row-detail">Ask it questions, or let it tidy up what you say.</span>}</span>
        <span className="setup-row-control">{connected && <Allowed>Connected</Allowed>}<Button onClick={() => open('claude')}>{connected ? 'Open' : 'Connect…'}</Button></span>
      </li>
      <li {...row('meetings')}>
        <span className="setup-row-text"><span className="setup-row-title">Record the other side of calls</span>
          <span className="setup-row-detail">macOS asks the first time you record a call.</span>
          <button type="button" className="link setup-more" onClick={() => open('meetings')}>Meeting settings</button></span>
        <span className="setup-row-control"><Toggle label="Record the other side of calls" checked={settings.meetings.systemAudio} onChange={systemAudio => void update({ meetings: { systemAudio } })} /></span>
      </li>
      <li {...row('notes')}>
        <span className="setup-row-text"><span className="setup-row-title">Notes folder</span><span className="setup-row-detail setup-path">{tilde(settings.notes.folder ?? status.notes, status.home)}</span></span>
        <span className="setup-row-control"><Button onClick={() => open('notes')}>Change…</Button></span>
      </li>
    </ul>
  </Split>;
}

/// What each extra puts by the dots, drawn with the overlay's own classes: Claude's answer card, a meeting's
/// pill with its clock running, the bubble a saved note leaves.
function Extra({ shown }: { shown: Sheet }) {
  const seconds = Math.floor(useLoop(3_600_000, 0, 1000) / 1000) + 754;
  const settings = useSettings();
  if (shown === 'claude') return <article className="glass card claude-card">
    <header className="dots-head"><span className="dots-name"><Icon name={settings ? aiIcon(settings.claude) : 'claude'} size={16} />{settings ? aiName(settings.claude) : 'AI'}</span></header>
    <p className="claude-asked">How do I say “see you Thursday” in Spanish?</p>
    <div className="claude-answer">Nos vemos el jueves.</div>
    <footer className="dots-actions"><span className="ask" /><button type="button" className="btn">Close</button><button type="button" className="btn">Copy</button><button type="button" className="btn primary">Insert</button></footer>
  </article>;
  if (shown === 'meetings') return <div className="glass meeting-pill meeting-card">
    <span className="meeting-dot" />
    <span className="meeting-text"><span className="meeting-line"><b>Meeting</b><time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time></span></span>
    <button type="button" className="meeting-stop"><i /></button>
  </div>;
  return <button type="button" className="glass said saved"><small>Saved · Open</small><span>Call the venue about Thursday</span></button>;
}

/// The ways in, as they're set now: what each does and the keys for it.
function waysOf(settings: Settings): [string, ReactNode][] {
  const { shortcuts, claude, general } = settings;
  // With the dots hidden until the key is held, there is nothing to right-click.
  const menu = settings.appearance.idle === 'dots' ? 'right-click the pill' : 'open TabTasker | Dictate from Spotlight';
  const name = KEY_NAMES[shortcuts.dictate];
  const ways: [string, ReactNode][] = [['Type where your cursor is', <>hold <Kbd>{name}</Kbd></>]];
  if (shortcuts.handsFree) ways.push(['Talk without holding', <>double-tap <Kbd>{name}</Kbd></>]);
  if (claude.enabled && claude.commands && shortcuts.command !== 'off') ways.push(['Ask AI', <>hold <Kbd>{name}</Kbd> with <Kbd>{COMMAND_GLYPHS[shortcuts.command]}</Kbd></>]);
  ways.push(['Speak a note', shortcuts.note ? <Kbd>{shortcuts.note.label}</Kbd> : 'the note button on the pill']);
  ways.push(['Record a meeting', shortcuts.meeting ? <Kbd>{shortcuts.meeting.label}</Kbd> : general.menuBarIcon ? 'the menu bar icon' : menu]);
  if (shortcuts.pasteLast) ways.push(['Paste the last transcript', <Kbd>{shortcuts.pasteLast.label}</Kbd>]);
  ways.push(['Settings and more', general.menuBarIcon ? 'the menu bar icon' : menu]);
  return ways;
}

function Done({ status, settings, go, frame }: Step) {
  const needs = missing(status);
  return <Split frame={frame} title={needs.length ? 'Still to do' : 'You’re all set'} live
    why={<Why>{needs.length ? 'There are a few things left before you can dictate. Finish them now or later in Settings.' : 'Here’s what to press. Everything else is in Settings.'}</Why>}
    stage={<Zoom max={1.2}>
      <ul className="setup-keys" aria-label="What to press">
        {waysOf(settings).map(([what, how]) => <li key={what}><span>{what}</span><span className="how">{how}</span></li>)}
      </ul>
    </Zoom>}
    caption="Your keys as they’re set now. You can change them in Settings › Shortcuts.">
    {needs.length > 0 && <Left needs={needs} go={go} />}
  </Split>;
}

const BODIES: Record<StepId, ComponentType<Step>> = {
  welcome: Welcome, microphone: Microphone, accessibility: Accessibility, key: ChooseKey, model: Model, dots: TheDots, try: TryIt, extras: Extras, done: Done,
};

// ---------- pieces ----------

/// A settings page over the setup as a sheet; Done, or Escape, comes back to the same step.
function PageSheet({ sheet, settings, update, onClose }: PageProps & { sheet: Sheet; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Modal: the step behind is inert, and closing gives the focus back to the button that opened it. Done
  // takes the focus, as a sheet's default button does, rather than the scrolling page.
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLElement>('footer button')?.focus(); }, []);
  const [name, Page] = SHEETS[sheet];
  return <dialog ref={dialog} className="setup-sheet" aria-label={name} onClose={onClose}>
    <div className="setup-sheet-scroll"><div className="page"><Page settings={settings} update={update} /></div></div>
    <footer><Button variant="primary" onClick={() => dialog.current?.close()}>Done</Button></footer>
  </dialog>;
}

/// What is left, in a sentence: Finish starts at the first of it, and Continue walks through the rest.
function Left({ needs, go }: { needs: ReturnType<typeof missing>; go: (id: StepId) => void }) {
  const labels = needs.map(([, label]) => label);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0];
  return <span className="setup-action">
    <Button onClick={() => go(needs[0][0])}>Finish</Button>
    <span className="setup-hint">You still need to {list}.</span>
  </span>;
}

const Allowed = ({ children }: { children: ReactNode }) => <span className="state" data-on><Icon name="check" size={14} />{children}</span>;

const HowTo = ({ steps }: { steps: ReactNode[] }) => <ol className="setup-howto" aria-label="In System Settings">{steps.map((line, i) => <li key={i}><span>{line}</span></li>)}</ol>;
