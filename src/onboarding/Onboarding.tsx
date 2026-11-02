import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { closeWindow, invoke, listen } from '../bridge';
import { Claude } from '../settings/pages/Claude';
import { Meetings } from '../settings/pages/Meetings';
import { Notes } from '../settings/pages/Notes';
import { setupDone, tilde, updateSettings, useSettings, useStatus, type CommandKey, type DictateKey, type PageProps, type Patch, type Settings, type Status } from '../store';
import { Button, Icon, Kbd, ProgressBar, Segmented, Select, Toast, Toggle, type IconName } from '../ui';
import { Globe, KEY_NAMES, Keyboard } from './Keyboard';
import './onboarding.css';

// The first run, a step at a time, in the whole Settings window. Each step shows what macOS says right
// now (polled while it is open) and never dead-ends: a permission step says what to click in System
// Settings and opens it, and every step can be skipped and finished later.

type StepId = 'welcome' | 'microphone' | 'accessibility' | 'key' | 'model' | 'try' | 'extras' | 'done';
const STEPS: { id: StepId; name: string; icon: Glyph }[] = [
  { id: 'welcome', name: 'Welcome', icon: 'waveform' }, { id: 'microphone', name: 'Microphone', icon: 'mic' },
  { id: 'accessibility', name: 'Accessibility', icon: 'access' }, { id: 'key', name: 'Your key', icon: 'keyboard' },
  { id: 'model', name: 'Speech model', icon: 'download' }, { id: 'try', name: 'Try it', icon: 'sparkle' },
  { id: 'extras', name: 'Extras', icon: 'plus' }, { id: 'done', name: 'Done', icon: 'check' },
];
// A hold this long is a hold, not a tap: the same as the overlay's key test.
const HOLD_MS = 350;
// How long after a hold is let go its last words may still arrive: long enough for Whisper's final pass,
// short enough that typing by hand afterwards doesn't count.
const SETTLE_MS = 4_000;

const ask = (kind: string) => void invoke('request', { kind }).catch(() => {});
const voiceReady = (status: Status) => status.enabled && status.modelReady;

/// What still stands between this Mac and dictating, with the step that fixes it.
const missing = (status: Status) => ([
  ['microphone', 'microphone access', status.microphone !== 'allowed'],
  ['accessibility', 'Accessibility', !status.accessibility],
  ['model', 'the speech model', !voiceReady(status)],
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
const SHEETS: Record<Sheet, [string, ComponentType<PageProps>]> = { claude: ['Claude', Claude], meetings: ['Meetings', Meetings], notes: ['Notes', Notes] };

type Step = {
  status: Status; settings: Settings; update: (patch: Patch) => Promise<Settings | undefined>; dictateKey: Key;
  practiced: boolean; onPracticed: () => void; go: (id: StepId) => void; open: (sheet: Sheet) => void;
};

export function Onboarding() {
  const settings = useSettings();
  const [status] = useStatus(1000);
  const [at, setAt] = useState(0);
  const [practiced, setPracticed] = useState<DictateKey | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dictateKey = useDictateKey(settings?.shortcuts.dictate);
  const main = useRef<HTMLElement>(null);
  const hideToast = useCallback(() => setToast(null), []);
  const update = useCallback((patch: Patch) => updateSettings(patch).catch(error => { setToast(typeof error === 'string' ? error : 'Couldn’t save that change'); return undefined; }), []);

  // A new step takes the focus, so the keyboard and VoiceOver start there; a field that asked for it keeps it.
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) { moved.current = true; return; }
    if (!main.current?.contains(document.activeElement)) main.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [at]);

  // Marks which way the step has more to scroll to, for the fade at that edge.
  const loaded = !!settings && !!status;
  useEffect(() => {
    const step = main.current;
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
  const done = (id: StepId, i: number) => ready(id) && (i < at || !['welcome', 'extras', 'done'].includes(id));
  const props: Step = { status, settings, update, dictateKey, practiced: practiced === chosen, onPracticed: () => setPracticed(chosen), go, open: setSheet };
  const last = at === STEPS.length - 1;
  const finished = setupDone(status);
  const [title, Body] = BODIES[step.id];

  return <div className="onboarding">
    <div className="titlebar" data-tauri-drag-region />
    {!last && <Button variant="quiet" small className="setup-leave" onClick={() => { location.hash = 'general'; }}>Open Settings</Button>}
    <nav className="setup-progress" aria-label="Setup steps">
      <ol>
        {STEPS.map((candidate, i) => <li key={candidate.id}>
          <button type="button" aria-label={`${candidate.name}${done(candidate.id, i) ? ', done' : ''}`} aria-current={i === at ? 'step' : undefined}
            data-done={done(candidate.id, i) || undefined} onClick={() => setAt(i)} />
        </li>)}
      </ol>
    </nav>
    <main ref={main} className="setup-step" key={step.id} aria-labelledby="setup-title">
      <div className="setup-body">
        <span className="setup-icon"><Glyph name={step.icon} size={28} /></span>
        <h1 id="setup-title" tabIndex={-1}>{step.id === 'done' && !finished ? 'Almost there' : title}</h1>
        <Body {...props} />
      </div>
    </main>
    <footer className="setup-nav">
      <span>{at > 0 && <Button variant="quiet" onClick={() => setAt(at - 1)}>Back</Button>}</span>
      <span className="setup-count" aria-hidden="true">{at + 1} of {STEPS.length}</span>
      <span className="end">
        {last ? <>
          <Button onClick={() => { location.hash = 'general'; }}>Open Settings</Button>
          <Button variant="primary" onClick={closeWindow}>{finished ? 'Start dictating' : 'Close'}</Button>
        </> : ready(step.id)
          ? <Button variant="primary" onClick={() => setAt(at + 1)}>{at === 0 ? 'Get started' : 'Continue'}</Button>
          : <Button onClick={() => setAt(at + 1)}>Skip for now</Button>}
      </span>
    </footer>
    {sheet && <PageSheet sheet={sheet} settings={settings} update={update} onClose={() => setSheet(null)} />}
    {toast && <Toast message={toast} error onDone={hideToast} />}
  </div>;
}

// ---------- the steps ----------

function Welcome() {
  return <>
    <p className="lead">Hold a key and talk. Your words type into any app as you say them, or become a note saved as Markdown.</p>
    <ul className="ui-tiles setup-tiles">
      <Row icon="keyboard" title="Types anywhere" detail="Mail, Slack, your code editor: any app with a place to type." />
      <Row icon="shield" title="Stays on this Mac" detail="Whisper transcribes your voice here and it never leaves. No account, nothing to sign in to." />
      <Row icon="claude" title="Claude, if you want it" detail="Optional. Once you connect it, Claude sees text only, never your voice." />
    </ul>
  </>;
}

function Microphone({ status }: Step) {
  const mic = status.microphone;
  const [problem, setProblem] = useState<string | null>(null);
  return <>
    <p className="lead">TabTasker Dictate listens only while you hold your key or take a note.</p>
    <ul className="ui-tiles setup-tiles">
      <Row icon="mic" title="Microphone access" detail={mic === 'allowed' ? undefined : mic === 'denied' ? 'Turned off in System Settings.' : 'Not asked yet. macOS asks once: choose Allow.'}>
        {mic === 'allowed' ? <Allowed>Allowed</Allowed>
          : <Button variant="primary" onClick={() => ask('microphone')}>{mic === 'denied' ? 'Open System Settings' : 'Allow microphone'}</Button>}
      </Row>
      {mic === 'allowed' && <Row icon="waveform" title="Listen with" detail={problem ?? `In use: ${status.inputInUse}`}>
        <Select label="Microphone" value={status.input ?? ''} options={[{ value: '', label: 'Automatic' }, ...status.inputs.map(input => ({ value: input.id, label: input.name }))]}
          onChange={id => { setProblem(null); void invoke('set_input', { id: id || null }).catch(() => setProblem('Couldn’t change the microphone')); }} />
      </Row>}
    </ul>
    {mic === 'denied' && <HowTo steps={[
      <>Click <b>Open System Settings</b>.</>,
      <>In <b>Privacy &amp; Security › Microphone</b>, turn on <b>TabTasker Dictate</b>.</>,
      <>Come back here. This step updates by itself.</>,
    ]} />}
  </>;
}

function Accessibility({ status }: Step) {
  const on = status.accessibility;
  return <>
    <p className="lead">This lets TabTasker Dictate notice your key in any app and type your words where the cursor is.</p>
    <ul className="ui-tiles setup-tiles">
      <Row icon="access" title="Accessibility" detail={on ? undefined : 'Off.'}>
        {on ? <Allowed>On</Allowed> : <Button variant="primary" onClick={() => ask('accessibility')}>Open System Settings</Button>}
      </Row>
    </ul>
    {!on && <HowTo steps={[
      <>Click <b>Open System Settings</b>. If macOS asks first, choose <b>Open System Settings</b> there.</>,
      <>In <b>Privacy &amp; Security › Accessibility</b>, turn on <b>TabTasker Dictate</b>.</>,
      <>Still off here a few seconds later? Select <b>TabTasker Dictate</b>, remove it with <b>−</b>, then add it again with <b>+</b>.</>,
    ]} />}
  </>;
}

const KEY_OPTIONS: { value: DictateKey; label: string }[] = [
  { value: 'fn', label: 'fn' }, { value: 'rightCommand', label: 'Right ⌘' }, { value: 'rightOption', label: 'Right ⌥' },
  { value: 'rightControl', label: 'Right ⌃' }, { value: 'rightShift', label: 'Right ⇧' },
];
const GLOBE = { inputSource: 'changes the input source', emoji: 'opens emoji', dictation: 'starts Dictation' } as const;

function ChooseKey({ status, settings, update, dictateKey, go }: Step) {
  const chosen = settings.shortcuts.dictate;
  const name = KEY_NAMES[chosen];
  const globe = chosen === 'fn' && status.globeKey ? GLOBE[status.globeKey] : null;
  return <>
    <p className="lead">Hold it while you talk and let go when you’re done. Pick the one that is easiest to reach.</p>
    <Segmented label="Key to hold" value={chosen} options={KEY_OPTIONS} onChange={dictate => void update({ shortcuts: { dictate } })} />
    <Keyboard chosen={chosen} down={dictateKey.down} />
    <p className="setup-status" role="status" data-ok={dictateKey.tested || undefined}>
      {dictateKey.tested ? <><Icon name="check" size={16} />Works. Hold <Kbd>{name}</Kbd> whenever you want to talk.</>
        : dictateKey.down ? 'Keep holding, then let go.'
        : <>Try it now: hold <Kbd>{name}</Kbd> for a moment, then let go.</>}
    </p>
    {globe && <ul className="ui-tiles setup-tiles">
      <Row icon="globe" title={`Your globe key ${globe}`} detail={<>That gets in the way of fn. Set <b>Press <Globe size={11} /> key to</b> to <b>Do Nothing</b>.</>}>
        <Button onClick={() => ask('keyboard')}>Open Keyboard Settings</Button>
      </Row>
    </ul>}
    {chosen === 'rightControl' && <p className="setup-note">Right ⌃ is only on some external keyboards. Apple’s have the arrow keys there.</p>}
    {!status.accessibility ? <p className="setup-note">Until Accessibility is on, your key works only while this window is in front. <button type="button" className="link" onClick={() => go('accessibility')}>Turn it on</button></p>
      : settings.shortcuts.handsFree && <p className="setup-note">Double-tap it to keep listening without holding. Tap again to finish.</p>}
  </>;
}

const CODES = 'ar bg bn ca cs da de el en es fa fi fr he hi hr hu id it ja ko ms nl no pl pt ro ru sk sl sr sv th tr uk ur vi zh'.split(' ');
const names = new Intl.DisplayNames(['en'], { type: 'language' });
const LANGUAGES = CODES.map(value => ({ value, label: names.of(value) ?? value })).sort((a, b) => a.label.localeCompare(b.label));

function Model({ status, settings, update }: Step) {
  const { language, model } = settings.dictation;
  const languages = [{ value: 'auto', label: 'Detect automatically' }, ...LANGUAGES];
  if (!languages.some(option => option.value === language)) languages.push({ value: language, label: language });
  const ready = voiceReady(status);
  const preparing = status.modelPreparing;
  const stalled = status.enabled && !ready && !preparing; // on, but the last download or load failed
  const percent = Number(/(\d+(?:\.\d+)?)%/.exec(status.modelMessage)?.[1] ?? NaN);
  return <>
    <p className="lead">Whisper turns your speech into text right here on this Mac. It downloads once and then works offline.</p>
    <ul className="ui-tiles setup-tiles">
      <Row icon="globe" title="Language" detail="Pick yours to skip detection and get it right from the first word.">
        <Select label="Language" value={language} options={languages} onChange={next => void update({ dictation: { language: next } })} />
      </Row>
      <Row icon="waveform" title="Model" detail={model === 'turbo' ? 'Whisper large-v3 Turbo, about 875 MB: the most accurate.' : 'Whisper small: faster and lighter, a little less accurate.'}>
        <Segmented label="Model" value={model} options={[{ value: 'turbo', label: 'Turbo' }, { value: 'small', label: 'Small' }]} onChange={next => void update({ dictation: { model: next } })} />
      </Row>
      <Row icon={ready ? 'check' : 'download'} title={ready ? 'Ready' : preparing ? (/download/i.test(status.modelMessage) ? 'Downloading' : 'Getting it ready') : stalled ? 'The download stopped' : status.modelMessage ? 'Dictation is paused' : 'Not on this Mac yet'}
        detail={<>{ready ? 'Whisper runs on this Mac.' : status.modelMessage || 'Downloaded once, then kept on this Mac.'}
          {preparing && <ProgressBar label="Speech model download" value={Number.isNaN(percent) ? null : percent / 100} />}</>}>
        {ready ? <Allowed>Ready</Allowed> : !preparing && <Button variant="primary" onClick={() => void invoke('set_enabled', { enabled: true }).catch(() => {})}>
          {stalled ? 'Try again' : status.modelMessage ? 'Turn on' : 'Download'}
        </Button>}
      </Row>
    </ul>
  </>;
}

function TryIt({ status, settings, dictateKey, practiced, onPracticed, go }: Step) {
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
  if (needs.length) return <>
    <p className="lead">A practice box is waiting here. First, finish what it needs.</p>
    <Left needs={needs} go={go} />
  </>;
  return <>
    <p className="lead">Click in the box, hold <Kbd>{name}</Kbd> and say something. Let go, and your words appear.</p>
    <textarea ref={box} className="setup-practice" aria-label="Practice" autoFocus placeholder={`Hold ${name} and talk…`} value={text} spellCheck={false}
      onChange={event => {
        setText(event.target.value);
        if (performance.now() < counts.current.until && /\p{L}/u.test(event.target.value)) onPracticed();
      }} />
    <p className="setup-status" role="status" data-ok={practiced || undefined}>
      {practiced ? <><Icon name="check" size={16} />That’s it. It works the same in every app.</>
        : dictateKey.down ? 'Listening…' : 'Try “Remind me to call Maria at three tomorrow.”'}
    </p>
  </>;
}

function Extras({ status, settings, update, open }: Step) {
  const connected = settings.claude.enabled;
  return <>
    <p className="lead">All optional, and in Settings whenever you want them.</p>
    <ul className="ui-tiles setup-tiles">
      <Row icon="claude" title="Connect Claude" detail={connected ? 'Connected. Commands, polish and note titles are on.' : 'Commands, polish and note titles. Claude sees text only, never your voice.'}>
        {connected && <Allowed>Connected</Allowed>}
        <Button onClick={() => open('claude')}>{connected ? 'Open' : 'Connect…'}</Button>
      </Row>
      <Row icon="meeting" title="Record the others in meetings" detail="Their side of a call, from this Mac’s audio. macOS asks you to allow it the first time you record.">
        <Toggle label="Record the others in meetings" checked={settings.meetings.systemAudio} onChange={systemAudio => void update({ meetings: { systemAudio } })} />
        <Button onClick={() => open('meetings')}>Meetings…</Button>
      </Row>
      <Row icon="folder" title="Notes folder" detail={<span className="setup-path">{tilde(settings.notes.folder ?? status.notes, status.home)}</span>}>
        <Button onClick={() => open('notes')}>Change…</Button>
      </Row>
    </ul>
  </>;
}

const COMMAND_GLYPHS: Record<Exclude<CommandKey, 'off'>, string> = { control: '⌃', option: '⌥', command: '⌘', shift: '⇧' };

function Done({ status, settings, go }: Step) {
  const { shortcuts, claude, general } = settings;
  const name = KEY_NAMES[shortcuts.dictate];
  const needs = missing(status);
  const ways: [string, ReactNode][] = [['Type where your cursor is', <>hold <Kbd>{name}</Kbd></>]];
  if (shortcuts.handsFree) ways.push(['Keep listening, hands-free', <>double-tap <Kbd>{name}</Kbd></>]);
  if (claude.enabled && claude.commands && shortcuts.command !== 'off') ways.push(['Talk to Claude', <>hold <Kbd>{name}</Kbd> with <Kbd>{COMMAND_GLYPHS[shortcuts.command]}</Kbd></>]);
  ways.push(['Take a spoken note', shortcuts.note ? <Kbd>{shortcuts.note.label}</Kbd> : 'the note button on the dots']);
  ways.push(['Record a meeting', shortcuts.meeting ? <Kbd>{shortcuts.meeting.label}</Kbd> : general.menuBarIcon ? 'the menu bar icon' : 'right-click the dots']);
  if (shortcuts.pasteLast) ways.push(['Paste the last transcript', <Kbd>{shortcuts.pasteLast.label}</Kbd>]);
  ways.push(['Settings and more', 'right-click the dots']);
  return <>
    {needs.length ? <>
      <p className="lead">A few things are left before your words can type. Finish them now, or later from Settings.</p>
      <Left needs={needs} go={go} />
    </> : <p className="lead">Here are the ways in. Settings has the rest.</p>}
    <ul className="ui-tiles setup-tiles setup-ways" aria-label="Ways in">
      {ways.map(([what, how]) => <li key={what} className="ui-tile"><span className="what"><span className="title">{what}</span></span><span className="how">{how}</span></li>)}
    </ul>
  </>;
}

const BODIES: Record<StepId, [string, ComponentType<Step>]> = {
  welcome: ['Talk instead of typing', Welcome], microphone: ['Your microphone', Microphone], accessibility: ['Accessibility', Accessibility],
  key: ['Choose your key', ChooseKey], model: ['The speech model', Model], try: ['Try it', TryIt], extras: ['Extras', Extras], done: ['You’re all set', Done],
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

type Glyph = IconName | 'access' | 'download' | 'globe';
/// The design system's icons, plus the few only setup needs, drawn the same way.
function Glyph({ name, size = 18 }: { name: Glyph; size?: number }) {
  if (name === 'globe') return <Globe size={size} />;
  if (name !== 'access' && name !== 'download') return <Icon name={name} size={size} />;
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'access'
      ? <><circle cx="10" cy="10" r="7.25" /><circle cx="10" cy="6.4" r=".9" fill="currentColor" stroke="none" /><path d="M6.25 8.6h7.5M10 8.6v3M10 11.6l-2 3.4M10 11.6l2 3.4" /></>
      : <path d="M10 3.25v9.5M6.25 9l3.75 3.75L13.75 9M4 16.25h12" />}
  </svg>;
}

function Row({ icon, title, detail, children }: { icon: Glyph; title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return <li className="ui-tile">
    <span className="setup-row-icon"><Glyph name={icon} size={17} /></span>
    <span className="what"><span className="title">{title}</span>{detail && <span className="detail">{detail}</span>}</span>
    {children && <span className="control">{children}</span>}
  </li>;
}

/// What is left, as one row: Finish starts at the first of it, and Continue walks through the rest.
function Left({ needs, go }: { needs: ReturnType<typeof missing>; go: (id: StepId) => void }) {
  const labels = needs.map(([, label]) => label);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0];
  return <ul className="ui-tiles setup-tiles">
    <Row icon="minus" title="Still to do" detail={`${list[0].toUpperCase()}${list.slice(1)}.`}><Button onClick={() => go(needs[0][0])}>Finish</Button></Row>
  </ul>;
}

const Allowed = ({ children }: { children: ReactNode }) => <span className="state" data-on><Icon name="check" size={14} />{children}</span>;

const HowTo = ({ steps }: { steps: ReactNode[] }) => <ol className="setup-howto" aria-label="In System Settings">{steps.map((line, i) => <li key={i}><span>{line}</span></li>)}</ol>;
