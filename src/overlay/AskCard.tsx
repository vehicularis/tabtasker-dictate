import { useState, type FormEvent } from 'react';
import { invoke } from '../bridge';
import { useSettings } from '../store';
import { Icon } from '../ui/Icon';
import { Logo, X } from './icons';

// A question for Claude, typed: it is answered as a spoken command is, on the same card by the dots.
// Through Claude Code, Claude can read the notes, meetings and recent dictations the Agents page shares.
export function AskCard({ onClose, onError }: { onClose: () => void; onError: (message: string) => void }) {
  const settings = useSettings();
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const code = settings?.claude.via === 'claudeCode';
  const connected = !!settings?.claude.enabled;
  const ask = (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || sending) return;
    setSending(true);
    void invoke('claude_ask', { question }).then(onClose, error => { onError(typeof error === 'string' ? error : 'Couldn’t ask Claude.'); setSending(false); });
  };
  return <form className="glass card setup askcard" data-glass data-hit aria-label="Ask Claude" onSubmit={ask}>
    <header className="head"><Logo size={28} /><strong>Ask Claude</strong><button type="button" className="close" aria-label="Close" onClick={onClose}><X /></button></header>
    <label className="library-find askfield"><Icon name="claude" size={15} />
      <input type="text" placeholder={code ? 'Ask about your notes and meetings, or anything' : 'Ask anything'} aria-label="Your question" value={question} autoFocus spellCheck
        readOnly={sending} onChange={event => setQuestion(event.target.value)} />
    </label>
    <footer className="actions">
      <span className="ask">{!connected ? 'Connect Claude in Settings first.' : code ? 'Claude can look through what the Agents page shares.' : 'Through Claude Code, Claude could also read your notes.'}</span>
      <button type="submit" className="btn primary" disabled={!question.trim() || sending || !connected}>{sending ? 'Asking…' : 'Ask'}</button>
    </footer>
  </form>;
}
