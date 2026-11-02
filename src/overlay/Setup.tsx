import { useState, type CSSProperties, type ReactNode } from 'react';
import { invoke } from '../bridge';
import { KEY_NAMES } from '../onboarding/Keyboard';
import { setupDone, useSettings, type DictateKey, type Status } from '../store';
import { Globe, Logo, NoteIcon, X } from './icons';

const GLOBE = { inputSource: 'changes the input source', emoji: 'opens emoji', dictation: 'starts Dictation' };

// ---------- setup: the microphone, your key, then the model, one step at a time ----------

export function Setup({ status, fnDown, fnTested, onClose }: { status: Status | null; fnDown: boolean; fnTested: boolean; onClose: () => void }) {
  const [asked, setAsked] = useState(false);
  const chosen = useSettings()?.shortcuts.dictate ?? 'fn';
  const name = KEY_NAMES[chosen];
  const ask = (kind: string) => { if (kind === 'accessibility') setAsked(true); void invoke('request', { kind }).catch(() => {}); };
  const full = () => { onClose(); void invoke('open_settings', { route: 'setup' }).catch(() => {}); };
  const notes = status?.notes.replace(/^\/Users\/[^/]+/, '~') ?? '~/Documents/TabTasker Dictate';
  const sheet = (title: string, body: ReactNode) => <article className="glass card setup" data-glass data-hit aria-label="Set up">
    <header className="head"><Logo size={28} /><strong>{title}</strong><button type="button" className="close" aria-label="Close" onClick={onClose}><X /></button></header>
    <Ways notes={notes} name={name} />
    {body}
  </article>;
  const ready = setupDone(status);
  if (ready) return sheet('You’re all set', <footer className="actions"><span className="ask" /><button type="button" className="btn primary" onClick={onClose}>Done</button></footer>);

  const mic = status?.microphone === 'allowed' ? 'done' : 'active';
  const keys = mic !== 'done' ? 'todo' : !status?.accessibility ? 'active' : fnTested ? 'done' : 'test';
  // Not a gate: a hold that gets through still passes the test.
  const globe = keys === 'test' && chosen === 'fn' && status?.globeKey ? GLOBE[status.globeKey] : undefined;
  const model = keys !== 'done' ? 'todo' : status?.enabled && status.modelReady ? 'done' : status?.modelPreparing ? 'busy' : 'active';
  const stalled = model === 'active' && !!status?.enabled; // on, but the last download or load failed
  const percent = Number(/(\d+(?:\.\d+)?)%/.exec(status?.modelMessage ?? '')?.[1] ?? 0);
  return sheet('Set up TabTasker Dictate', <>
    <Keyboard chosen={chosen} down={fnDown} />
    <ol className="steps">
      <Step index={1} status={mic} name="Microphone" line={`Only on while you hold ${name} or take a note.`}
        action={mic === 'active' && <button type="button" className="btn primary" onClick={() => ask('microphone')}>{status?.microphone === 'denied' ? 'Open Settings' : 'Allow'}</button>} />
      <Step index={2} status={keys} name={chosen === 'fn' ? 'fn key' : 'Your key'}
        line={globe ? <>Your 🌐 key {globe}, which gets in the way of <kbd>fn</kbd>. Open Settings, set “Press 🌐 key to” to Do Nothing, then hold fn here.</>
          : keys === 'test' ? chosen === 'fn'
            ? <>Now hold <kbd>fn</kbd> to test it. If emoji open instead, set “Press 🌐 key to” to Do Nothing in <button type="button" className="link" onClick={() => ask('keyboard')}>Keyboard settings</button>.</>
            : <>Now hold <kbd>{name}</kbd> to test it.</>
          : asked ? 'If macOS asks, choose Open System Settings, then turn TabTasker Dictate on. Already on? Remove it with −, then turn it on again.'
          : `Accessibility lets Dictate notice ${name} and type into any app.`}
        action={(keys === 'active' || globe) && <button type="button" className="btn primary" onClick={() => ask(globe ? 'keyboard' : 'accessibility')}>Open Settings</button>} />
      <Step index={3} status={model} name="Speech model"
        line={model === 'busy' ? <>{status?.modelMessage || 'Preparing…'}<span className="bar"><i style={{ width: `${percent}%` }} /></span></>
          : stalled ? status?.modelMessage || 'The download stopped.' : '875 MB, kept on this Mac. Your voice is transcribed here.'}
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
    <li><span className="what">Type where your cursor is<small>In any app, as you speak</small></span><span className="chord"><kbd>{name}</kbd></span></li>
    <li><span className="what">Take a spoken note<small>As long as you like, saved as Markdown in {notes}</small></span><span className="chord"><kbd className="glyph"><NoteIcon /></kbd></span></li>
  </ul>;
}

// The right-hand corner is the left one mirrored, so its fade runs the other way.
const RIGHT: CSSProperties = { alignItems: 'flex-end', WebkitMaskImage: 'linear-gradient(270deg, #000 50%, transparent 92%)', maskImage: 'linear-gradient(270deg, #000 50%, transparent 92%)' };

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
      <i className={k('rightOption')}><b>⌥</b><span>option</span></i><i className={k('rightControl')}><b>⌃</b><span>control</span></i>
    </div>
  </div>;
}
