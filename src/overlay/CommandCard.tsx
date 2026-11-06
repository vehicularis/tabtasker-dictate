import { useEffect, useState, type KeyboardEvent } from 'react';
import { aiIcon, aiName, useSettings } from '../store';
import { invoke, listen } from '../bridge';
import { copyText } from '../lib/clipboard';
import { message } from '../lib/errors';
import type { Command } from '../api/types';
import { Icon } from '../ui/Icon';
import { X } from './icons';
import { leave } from '../ui/motion';
import { PREVIEW } from './preview';
import './command-card.css';

// `?preview=command`, `command-thinking` or `command-error`.
const SAMPLES: Record<string, Command> = {
  command: { request: 'preview', phase: 'answer', instruction: 'What time is it in Tokyo right now?', text: 'It’s 6:40 in the morning in Tokyo, Tuesday. Tokyo is 8 hours ahead of you.' },
  'command-thinking': { request: 'preview', phase: 'thinking', instruction: 'Make this sound friendlier' },
  'command-error': { request: 'preview', phase: 'error', instruction: 'Summarize this', text: 'Too many requests for this key right now. Try again in a minute.' },
};

// Claude's answer to a spoken command, near the dots: it listens for dictate-command itself. While
// Claude works it shows what was asked; an answer comes as a card with Insert, Copy and Close; a typed
// result needs nothing here.
export function CommandCard() {
  const [command, setCommand] = useState<Command | null>(PREVIEW ? SAMPLES[PREVIEW] ?? null : null);
  const [copied, setCopied] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null); // the answer stays, with what went wrong
  useEffect(() => listen('dictate-command', next => {
    if (next.phase === 'done') setCommand(current => current?.request === next.request ? null : current);
    else { setCommand(next); setCopied(false); setProblem(null); }
  }), []);
  useEffect(() => { // an error says its piece and goes
    if (command?.phase !== 'error' || PREVIEW) return;
    const timer = setTimeout(() => setCommand(null), 7000);
    return () => clearTimeout(timer);
  }, [command]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  if (!command) return null;

  const close = () => {
    // Closed while Claude works: its answer is dropped, never typed.
    if (command.phase === 'thinking') void invoke('claude_dismiss', { request: command.request }).catch(() => {});
    setCommand(null);
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };

  if (command.phase !== 'answer') {
    const error = command.phase === 'error';
    return <div ref={leave} className="glass claude-bubble" data-glass data-hit data-error={error || undefined} role={error ? 'alert' : 'status'} onKeyDown={escape}>
      <span className="dots-what">
        <small>{error ? 'That didn’t work' : <>Working on it<span className="claude-wait" aria-hidden="true"><i /><i /><i /></span></>}</small>
        <span>{error ? command.text : command.instruction}</span>
      </span>
      <button type="button" className="close" aria-label={error ? 'Close' : 'Stop waiting'} title={error ? 'Close' : 'Stop waiting'} onClick={close}><X /></button>
    </div>;
  }

  const settings = useSettings();
  const text = command.text ?? '';
  // Insert brings back the app the command was spoken in and types there, so the card waits for it.
  const insert = () => {
    if (inserting) return;
    setInserting(true); setProblem(null); setCopied(false);
    void invoke('claude_insert', { request: command.request, text }).then(() => setCommand(null),
      error => setProblem(message(error, 'Couldn’t insert the answer. Copy it instead.'))).finally(() => setInserting(false));
  };
  const copy = () => { setProblem(null); void copyText(text).then(() => setCopied(true), () => setProblem('Couldn’t copy the answer. Try again.')); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (command.typed) copy(); else insert(); } else escape(event);
  };
  return <article ref={leave} className="glass card claude-card" data-glass data-hit aria-label={`${settings ? aiName(settings.claude) : 'AI'}’s answer`} onKeyDown={keys}>
    <header className="dots-head"><span className="dots-name"><Icon name={settings ? aiIcon(settings.claude) : 'claude'} size={16} />{settings ? aiName(settings.claude) : 'AI'}</span></header>
    {command.instruction && <p className="claude-asked">{command.instruction}</p>}
    <div className="claude-answer" tabIndex={0} aria-label="Answer">{text}</div>
    <footer className="dots-actions">
      <span className="ask" role={problem ? 'alert' : 'status'} data-error={problem ? true : undefined}>{problem ?? (copied ? 'Copied' : '')}</span>
      <button type="button" className="btn" onClick={close}>Close</button>
      <button type="button" className={`btn${command.typed ? ' primary' : ''}`} onClick={copy}>Copy</button>
      {/* A typed question has no app to go back to: Copy is the way to take the answer. */}
      {!command.typed && <button type="button" className="btn primary" title="Type it into the app you asked from (⌘↩)" aria-busy={inserting} onClick={insert}>{inserting ? 'Inserting…' : 'Insert'}</button>}
    </footer>
  </article>;
}
