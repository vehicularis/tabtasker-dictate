import { useState, type FormEvent } from 'react';
import { invoke } from '../../bridge';
import type { Settings } from '../../store';
import { Button, Icon, PageHeader } from '../../ui';

type Turn = { question: string; answer: string | null; error?: string };

// A question for Claude, typed, answered here. Through Claude Code, Claude can also look through the
// notes, meetings and recent dictations that Claude & AI lets it read.
export function AskView({ settings }: { settings: Settings }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const connected = settings.claude.enabled;
  const code = settings.claude.via === 'claudeCode';
  const ask = (event: FormEvent) => {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || busy) return;
    setBusy(true); setQuestion('');
    setTurns(current => [...current, { question: asked, answer: null }]);
    void invoke<string>('claude_ask', { question: asked }).then(
      answer => setTurns(current => current.map((turn, i) => i === current.length - 1 ? { ...turn, answer } : turn)),
      error => setTurns(current => current.map((turn, i) => i === current.length - 1 ? { ...turn, answer: '', error: typeof error === 'string' ? error : 'Couldn’t ask Claude.' } : turn)),
    ).finally(() => setBusy(false));
  };
  return <>
    <PageHeader icon="claude" title="Ask Claude">{code ? 'Ask about your notes and meetings, or anything else. Claude reads them on this Mac through TabTasker Dictate.' : connected ? 'Ask anything. Connected through Claude Code, Claude could also read your notes.' : 'Connect Claude or a local model under Settings › Claude & AI, then ask here.'}</PageHeader>
    <div className="ask-thread" aria-live="polite">
      {turns.map((turn, i) => <div key={i} className="ask-turn">
        <p className="ask-q">{turn.question}</p>
        {turn.answer === null ? <p className="ask-a thinking">Thinking…</p> : turn.error ? <p className="ask-a error">{turn.error}</p> : <p className="ask-a">{turn.answer}</p>}
      </div>)}
    </div>
    <form className="ask-form" onSubmit={ask}>
      <label className="search ask-field"><Icon name="claude" size={15} />
        <input type="text" placeholder={code ? 'What did I say about Thursday?' : 'Ask anything'} aria-label="Your question" value={question} autoFocus spellCheck readOnly={busy} onChange={event => setQuestion(event.target.value)} />
      </label>
      {connected
        ? <Button type="submit" variant="primary" disabled={!question.trim() || busy}>{busy ? 'Asking…' : 'Ask'}</Button>
        : <Button type="button" onClick={() => { location.hash = 'settings/ai'; }}>Connect</Button>}
    </form>
  </>;
}
