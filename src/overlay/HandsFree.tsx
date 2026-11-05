import { useEffect, useState } from 'react';
import { listen } from '../bridge';
import { KEY_NAMES } from '../lib/keyNames';
import { ask } from '../lib/request';
import { useSettings, type Events } from '../store';
import { leave } from '../ui/motion';
import { PREVIEW } from './preview';
import './hands-free.css';

// A locked session listens for up to ten minutes, and the app sends it as it reaches that.
const LIMIT = 10 * 60;

// Locked listening after a double tap of the dictate key: it listens for dictate-hands-free itself. One line,
// as the meeting pill: the time, then Cancel and Finish, each with its key on it (Escape cancels, a tap of
// the dictate key sends). The limit shows only in the last minute, as the time left.
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
  const left = LIMIT - seconds, ending = left <= 60;
  const key = KEY_NAMES[settings.shortcuts.dictate];
  return <div ref={leave} className="glass hands-free" data-glass data-hit role="group" aria-label="Hands-free">
    <i className="live" aria-hidden="true" />
    <span className="hands-free-line"><b>Hands-free</b><time data-ending={ending || undefined}>{ending ? `${clock(left)} left` : clock(seconds)}</time></span>
    <button type="button" className="btn quiet" title="Cancel (esc)" aria-keyshortcuts="Escape" onClick={() => ask('cancel')}>Cancel<kbd aria-hidden="true">esc</kbd></button>
    <button type="button" className="btn primary" title={`Finish (${key})`} onClick={() => ask('send')}>Finish<kbd aria-hidden="true">{key}</kbd></button>
  </div>;
}
