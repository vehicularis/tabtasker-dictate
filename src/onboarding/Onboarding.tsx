import { useEffect, useState, type ReactNode } from 'react';
import { closeWindow, invoke, listen } from '../bridge';
import { setupDone, useStatus, type Status } from '../store';
import { Button, Icon, Kbd, ProgressBar, type IconName } from '../ui';

type Step = { id: string; icon: IconName; title: string; done: (status: Status, held: boolean) => boolean; body: (status: Status, held: boolean) => ReactNode; action?: (status: Status) => ReactNode };
const ask = (kind: string) => void invoke('request', { kind }).catch(() => {});

// The first run, a step at a time. Each step shows what macOS says right now and never dead-ends: a
// permission step says what to click and opens the right place.
const STEPS: Step[] = [
  {
    id: 'welcome', icon: 'waveform', title: 'Talk instead of typing', done: () => true,
    body: () => <>Hold a key and speak: your words type into any app, as you say them. Or take a long spoken note, saved as Markdown.
      <span className="promise"><Icon name="shield" size={16} />Your voice is transcribed on this Mac and never leaves it.</span></>,
  },
  {
    id: 'microphone', icon: 'mic', title: 'Your microphone', done: status => status.microphone === 'allowed',
    body: status => status.microphone === 'allowed' ? 'Allowed. It is only on while you hold the key or take a note.'
      : status.microphone === 'denied' ? 'macOS has it turned off. Open Settings, then turn on TabTasker Dictate under Microphone.'
      : 'TabTasker Dictate listens only while you hold the key or take a note.',
    action: status => status.microphone !== 'allowed' && <Button variant="primary" onClick={() => ask('microphone')}>{status.microphone === 'denied' ? 'Open Settings' : 'Allow microphone'}</Button>,
  },
  {
    id: 'accessibility', icon: 'keyboard', title: 'Accessibility', done: status => status.accessibility,
    body: status => status.accessibility ? 'On. TabTasker Dictate can hear your key and type into other apps.'
      : 'This lets TabTasker Dictate notice your key in any app and type your words there. In System Settings, turn on TabTasker Dictate under Accessibility. Already on? Remove it with −, then add it again.',
    action: status => !status.accessibility && <Button variant="primary" onClick={() => ask('accessibility')}>Open Settings</Button>,
  },
  {
    id: 'key', icon: 'keyboard', title: 'Try your key', done: (_, held) => held,
    body: (status, held) => held ? <>That’s it. Hold <Kbd>fn</Kbd> whenever you want to talk.</>
      : status.globeKey ? <>Your 🌐 key does something else when pressed, which gets in its way. In Keyboard settings, set “Press 🌐 key to” to Do Nothing, then hold <Kbd>fn</Kbd> here.</>
      : <>Hold <Kbd>fn</Kbd> for a moment, then let go.</>,
    action: status => !!status.globeKey && <Button onClick={() => ask('keyboard')}>Keyboard settings</Button>,
  },
  {
    id: 'model', icon: 'waveform', title: 'The speech model', done: status => status.enabled && status.modelReady,
    body: status => {
      if (status.enabled && status.modelReady) return 'Ready. Whisper runs on this Mac.';
      const percent = Number(/(\d+(?:\.\d+)?)%/.exec(status.modelMessage)?.[1] ?? NaN);
      if (status.modelPreparing) return <>{status.modelMessage || 'Preparing…'}<ProgressBar label="Download" value={Number.isNaN(percent) ? null : percent / 100} /></>;
      return status.enabled && status.modelMessage ? status.modelMessage : 'Whisper large-v3 Turbo, about 875 MB. It is downloaded once and kept on this Mac.';
    },
    action: status => !status.modelPreparing && !(status.enabled && status.modelReady) && <Button variant="primary" onClick={() => void invoke('set_enabled', { enabled: true }).catch(() => {})}>{status.enabled ? 'Try again' : 'Download'}</Button>,
  },
  {
    id: 'done', icon: 'check', title: 'You’re all set', done: () => true,
    body: () => <ul className="ways">
      <li><span>Type where your cursor is</span><Kbd>hold fn</Kbd></li>
      <li><span>Take a spoken note</span><span className="glyph"><Icon name="note" size={16} />on the dots</span></li>
      <li><span>Settings, any time</span><Kbd>⌘,</Kbd></li>
    </ul>,
  },
];

export function Onboarding() {
  const [status] = useStatus(1000);
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let down = 0;
    return listen<{ down: boolean }>('dictate-fn', ({ down: pressed }) => {
      if (pressed) down = performance.now();
      else if (down && performance.now() - down > 350) setHeld(true);
    });
  }, []);
  const step = STEPS[at];
  const ready = !!status && step.done(status, held);
  const last = at === STEPS.length - 1;
  return <div className="onboarding">
    <div className="titlebar" data-tauri-drag-region />
    <ol className="progress" aria-label="Setup steps">
      {STEPS.map((candidate, i) => <li key={candidate.id} data-state={i < at ? 'done' : i === at ? 'now' : undefined} aria-current={i === at ? 'step' : undefined}><span className="sr">{candidate.title}</span></li>)}
    </ol>
    <section className="step" key={step.id} aria-live="polite">
      <span className="step-icon"><Icon name={step.icon} size={30} /></span>
      <h1>{step.title}</h1>
      <div className="body">{status ? step.body(status, held) : ' '}</div>
      <div className="step-actions">{status && step.action?.(status)}</div>
    </section>
    <footer className="nav">
      {at > 0 && !last ? <Button variant="quiet" onClick={() => setAt(at - 1)}>Back</Button> : <span />}
      {last
        ? <span className="end"><Button onClick={() => { location.hash = 'general'; }}>Open Settings</Button><Button variant="primary" onClick={closeWindow}>Start dictating</Button></span>
        : <span className="end">
          {!ready && at > 0 && <Button variant="quiet" onClick={() => setAt(at + 1)}>Skip</Button>}
          <Button variant="primary" disabled={!ready} onClick={() => setAt(at + 1)}>Continue</Button>
        </span>}
    </footer>
    {status && setupDone(status) && at < STEPS.length - 1 && at > 0 && <p className="hint">Everything is ready. <button type="button" className="link" onClick={() => setAt(STEPS.length - 1)}>Finish</button></p>}
  </div>;
}
