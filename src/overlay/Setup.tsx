import { useState, type CSSProperties, type ReactNode } from 'react';
import { invoke } from '../bridge';
import { KEY_NAMES } from '../onboarding/Keyboard';
import { setupDone, useSettings, type DictateKey, type Status } from '../store';
import { Globe, Logo, NoteIcon, X } from './icons';
import { leave } from '../ui/motion';

const GLOBE = { inputSource: 'changes the input source', emoji: 'opens emoji', dictation: 'starts Dictation' };

// ---------- the setup steps, as a card by the dots ----------

export function Setup({ status, fnDown, fnTested, onClose }: { status: Status | null; fnDown: boolean; fnTested: boolean; onClose: () => void }) {
  const [asked, setAsked] = useState(false);
  const settings = useSettings();
  const chosen = settings?.shortcuts.dictate ?? 'fn';
  const name = KEY_NAMES[chosen];
  const ask = (kind: string) => { if (kind === 'accessibility') setAsked(true); void invoke('request', { kind }).catch(() => {}); };
  const full = () => { onClose(); void invoke('open_app', { route: 'setup' }).catch(() => {}); };
  const notes = status?.notes.replace(/^\/Users\/[^/]+/, '~') ?? '~/Documents/TabTasker Dictate';
  const ready = setupDone(status);
  const sheet = (title: string, body: ReactNode) => <article ref={leave} className="glass card setup" data-glass data-hit aria-label="Setup">
    <header className="head"><Logo size={28} /><strong>{title}</strong><button type="button" className="close" aria-label="Close" onClick={onClose}><X /></button></header>
    <Ways notes={notes} name={name} />
    {body}
  </article>;
  if (ready) return sheet('You’re all set',<footer className="actions"><span className="ask" /><button type="button" className="btn primary" onClick={onClose}>Done</button></footer>);

  const mic = status?.microphone === 'allowed' ? 'done' : 'active';
  const keys = mic !== 'done' ? 'todo' : !status?.accessibility ? 'active' : fnTested ? 'done' : 'test';
  // Not a gate: a hold that gets through still passes the test.
  const globe = keys === 'test' && chosen === 'fn' && status?.globeKey ? GLOBE[status.globeKey] : undefined;
  const model = keys !== 'done' ? 'todo' : status?.enabled && status.modelReady ? 'done' : status?.modelPreparing ? 'busy' : 'active';
  const stalled = model === 'active' && !!status?.enabled; // on, but the last download or load failed
  const percent = Number(/(\d+(?:\.\d+)?)%/.exec(status?.modelMessage ?? '')?.[1] ?? 0);
  return sheet('Set up Dictate', <>
    <Keyboard chosen={chosen} down={fnDown} />
    <ol className="steps">
      <Step index={1} status={mic} name="Microphone" line={`Dictate only listens while you hold ${name} or record a note.`}
        action={mic === 'active' && <button type="button" className="btn primary" onClick={() => ask('microphone')}>{status?.microphone === 'denied' ? 'Open System Settings' : 'Allow'}</button>} />
      <Step index={2} status={keys} name={chosen === 'fn' ? 'fn key' : 'Your key'}
        line={globe ? <>Your <Globe /> key {globe}, which gets in the way of <kbd>fn</kbd>. In System Settings, set “Press <Globe /> key to” to Do Nothing, then hold fn here.</>
          : keys === 'test' ? chosen === 'fn'
            ? <>Now hold <kbd>fn</kbd> to test it. If emoji open instead, set “Press <Globe /> key to” to Do Nothing in <button type="button" className="link" onClick={() => ask('keyboard')}>Keyboard settings</button>.</>
            : <>Now hold <kbd>{name}</kbd> to test it.</>
          : asked ? 'If macOS asks, choose Open System Settings and turn on TabTasker Dictate. If it’s already on, remove it with − and add it back with +.'
          : `Dictate needs Accessibility to notice ${name} and type into other apps.`}
        action={(keys === 'active' || globe) && <button type="button" className="btn primary" onClick={() => ask(globe ? 'keyboard' : 'accessibility')}>Open System Settings</button>} />
      <Step index={3} status={model} name="Speech model"
        line={model === 'busy' ? <>{status?.modelMessage || 'Preparing…'}<span className="bar"><i style={{ width: `${percent}%` }} /></span></>
          : stalled ? status?.modelMessage || 'The download stopped.' : 'It downloads once and stays on your Mac.'}
        action={model === 'active' && <button type="button" className="btn primary" onClick={() => void invoke('set_enabled', { enabled: true }).catch(() => {})}>{stalled ? 'Try again' : 'Download'}</button>} />
    </ol>
    <footer className="actions"><span className="ask" /><button type="button" className="btn" onClick={full}>Open full setup</button></footer>
  </>);
}

function Step({ index, status, name, line, action }: { index: number; status: string; name: string; line: ReactNode; action: ReactNode }) {
  return <li data-status={status}><i className="num">{status === 'done' ? '✓' : index}</i><div><b>{name}</b><span>{line}</span></div>{action || null}</li>;
}

// The two ways in: what each does on the left, its key or button lined up on the right.
function Ways({ notes, name }: { notes: string; name: string }) {
  return <ul className="ways">
    <li><span className="what">Type where your cursor is</span><span className="chord"><kbd>{name}</kbd></span></li>
    <li><span className="what">Speak a note<small>Notes are saved in {notes}.</small></span><span className="chord"><kbd className="glyph"><NoteIcon /></kbd></span></li>
  </ul>;
}

// The right-hand corner is the left one mirrored, so its fade runs the other way.
const RIGHT: CSSProperties = { alignItems: 'flex-end', WebkitMaskImage: 'linear-gradient(270deg, #000 50%, transparent 92%)', maskImage: 'linear-gradient(270deg, #000 50%, transparent 92%)' };

const ARROWS: CSSProperties = { display: 'flex', alignItems: 'flex-end', gap: 6 };
const HALF: CSSProperties = { width: 32, height: 19, fontSize: 8 };

// The corner of a Mac keyboard with your key; it is also the tester. `.fn` marks the key under test.
function Keyboard({ chosen, down }: { chosen: DictateKey; down: boolean }) {
  if (chosen === 'fn') return <div className="keys" data-down={down || undefined} aria-hidden="true">
    <div className="krow"><i className="k wide">shift</i><i className="k">Z</i><i className="k">X</i><i className="k">C</i><i className="k">V</i></div>
    <div className="krow">
      <i className="k fn"><b>fn</b><Globe /></i>
      <i className="k"><b>⌃</b><span>control</span></i><i className="k"><b>⌥</b><span>option</span></i><i className="k wide"><b>⌘</b><span>command</span></i>
    </div>
  </div>;
  const k = (key: DictateKey, wide?: boolean) => `k${wide ? ' wide' : ''}${key === chosen ? ' fn' : ''}`;
  return <div className="keys" data-down={down || undefined} aria-hidden="true" style={RIGHT}>
    {/* The top row is dimmed, unless right ⇧ in it is the key. */}
    <div className="krow" style={chosen === 'rightShift' ? { opacity: 1 } : undefined}>
      <i className="k">M</i><i className="k">,</i><i className="k">.</i><i className="k">/</i><i className={k('rightShift', true)}><b>⇧</b><span>shift</span></i>
    </div>
    <div className="krow">
      <i className="k" style={{ width: 96 }} /><i className={k('rightCommand', true)}><b>⌘</b><span>command</span></i>
      <i className={k('rightOption')}><b>⌥</b><span>option</span></i>
      {/* Apple's keyboards have the arrow keys here; right ⌃ only when it is the key, as on an external one. */}
      {chosen === 'rightControl' ? <i className={k('rightControl')}><b>⌃</b><span>control</span></i> : <span style={ARROWS}>
        <i className="k" style={HALF}>◀</i><span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><i className="k" style={HALF}>▲</i><i className="k" style={HALF}>▼</i></span><i className="k" style={HALF}>▶</i>
      </span>}
    </div>
  </div>;
}
