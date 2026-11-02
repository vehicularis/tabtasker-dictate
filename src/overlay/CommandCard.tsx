import { useEffect, useState, type KeyboardEvent } from 'react';
import { invoke, listen } from '../bridge';
import { useSettings, type Events } from '../store';
import { Icon } from '../ui/Icon';
import { X } from './icons';
import { PREVIEW } from './preview';
import './CommandCard.css';

type Command = Events['dictate-command'];

// `?preview=command`, `command-thinking` or `command-error`.
const SAMPLES: Record<string, Command> = {
  command: { request: 'preview', phase: 'answer', instruction: 'What time is it in Tokyo right now?', text: 'It’s 6:40 in the morning in Tokyo, Tuesday. Tokyo is 8 hours ahead of you.' },
  'command-thinking': { request: 'preview', phase: 'thinking', instruction: 'Make this sound friendlier' },
  'command-error': { request: 'preview', phase: 'error', instruction: 'Summarize this', text: 'Too many requests for this key right now. Try again in a minute.' },
};

const failed = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); } catch {
    // An older web view: the selection way, which a click still allows.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const done = document.execCommand('copy');
    area.remove();
    if (!done) throw new Error('copy');
  }
}

// Claude's answer to a spoken command, near the dots: it listens for dictate-command itself. While
// Claude works it shows what was asked; an answer comes as a card with Insert, Copy and Close; a typed
// result needs nothing here.
export function CommandCard() {
  const [command, setCommand] = useState<Command | null>(PREVIEW ? SAMPLES[PREVIEW] ?? null : null);
  const [copied, setCopied] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null); // the answer stays, with what went wrong
  useEffect(() => listen<Command>('dictate-command', next => {
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
    return <div className="glass claude-bubble" data-glass data-hit data-error={error || undefined} role={error ? 'alert' : 'status'} onKeyDown={escape}>
      <span className="what">
        <small>{error ? 'Claude couldn’t do that' : <>Claude is working<span className="claude-wait" aria-hidden="true"><i /><i /><i /></span></>}</small>
        <span>{error ? command.text : command.instruction}</span>
      </span>
      <button type="button" className="close" aria-label={error ? 'Close' : 'Stop waiting'} title={error ? 'Close' : 'Stop waiting'} onClick={close}><X /></button>
    </div>;
  }

  const text = command.text ?? '';
  // Insert brings back the app the command was spoken in and types there, so the card waits for it.
  const insert = () => {
    if (inserting) return;
    setInserting(true); setProblem(null); setCopied(false);
    void invoke('claude_insert', { request: command.request, text }).then(() => setCommand(null),
      error => setProblem(failed(error, 'Couldn’t insert the answer.'))).finally(() => setInserting(false));
  };
  const copy = () => { setProblem(null); void copyText(text).then(() => setCopied(true), () => setProblem('Couldn’t copy the answer.')); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); insert(); } else escape(event);
  };
  return <article className="glass card claude-card" data-glass data-hit aria-label="Claude’s answer" onKeyDown={keys}>
    <header className="head"><span className="name"><Icon name="claude" size={16} />Claude</span></header>
    {command.instruction && <p className="claude-asked">{command.instruction}</p>}
    <div className="claude-answer" tabIndex={0} aria-label="Answer">{text}</div>
    <footer className="actions">
      <span className="ask" role={problem ? 'alert' : 'status'} data-error={problem ? true : undefined}>{problem ?? (copied ? 'Copied' : '')}</span>
      <button type="button" className="btn" onClick={close}>Close</button>
      <button type="button" className="btn" onClick={copy}>Copy</button>
      <button type="button" className="btn primary" title="Type it in the app you asked in (⌘↩)" aria-busy={inserting} onClick={insert}>{inserting ? 'Inserting…' : 'Insert'}</button>
    </footer>
  </article>;
}

// Below the "Saved" bubble: opens Terminal in the project with the saved note as Claude Code's first
// message. Shown once Claude Code is found on this Mac.
export function SendToClaudeCode({ path, onSent, onError }: { path: string; onSent: () => void; onError: (message: string) => void }) {
  const settings = useSettings();
  const [sending, setSending] = useState(false);
  if (!settings?.claude.claudeCode) return null;
  const send = () => {
    setSending(true);
    void invoke<boolean>('send_to_claude_code', { path }).then(sent => { if (sent) onSent(); },
      error => onError(failed(error, 'Couldn’t open Claude Code'))).finally(() => setSending(false));
  };
  return <button type="button" className="glass claude-send" data-glass data-hit disabled={sending} onClick={send}>
    <Icon name="claudeCode" size={15} />{sending ? 'Opening Claude Code…' : 'Send to Claude Code'}
  </button>;
}
