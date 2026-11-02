import { useEffect, useState } from 'react';
import { invoke, listen } from '../bridge';
import { useSettings, type DictateKey, type Events } from '../store';
import { X } from './icons';
import { PREVIEW } from './preview';
import './hands-free.css';

const KEY: Record<DictateKey, string> = { fn: 'fn', rightCommand: 'right ⌘', rightOption: 'right ⌥', rightControl: 'right ⌃', rightShift: 'right ⇧' };
// Speech takes a minute of audio at most, and the app sends the session as it reaches that.
const LIMIT = 60;

// Locked listening after a double tap of the dictate key: it listens for dictate-hands-free itself. The
// keys are the quick way out (a tap sends, Escape cancels); the buttons are for the pointer.
export function HandsFree() {
  const settings = useSettings();
  const [since, setSince] = useState<number | null>(PREVIEW === 'hands-free' ? Date.now() - 42_000 : null);
  const [, setClock] = useState(0);
  useEffect(() => listen<Events['dictate-hands-free']>('dictate-hands-free', ({ locked }) => setSince(locked ? Date.now() : null)), []);
  useEffect(() => {
    if (since == null) return;
    const timer = setInterval(() => setClock(tick => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (since == null || !settings) return null;
  const seconds = Math.min(LIMIT, Math.max(0, Math.floor((Date.now() - since) / 1000)));
  const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const ask = (kind: 'send' | 'cancel') => void invoke('request', { kind }).catch(() => {});
  return <div className="glass hands-free" data-glass data-hit role="group" aria-label="Hands-free">
    <i className="live" aria-hidden="true" />
    <span className="what">
      <b>Hands-free <time>{clock(seconds)} of {clock(LIMIT)}</time></b>
      <small>Tap <kbd>{KEY[settings.shortcuts.dictate]}</kbd> to send, <kbd>esc</kbd> to cancel</small>
    </span>
    <button type="button" className="tool" aria-label="Cancel" title="Cancel" onClick={() => ask('cancel')}><X /></button>
    <button type="button" className="btn primary" onClick={() => ask('send')}>Send</button>
  </div>;
}
