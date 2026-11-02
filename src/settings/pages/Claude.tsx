import { useState, type FormEvent } from 'react';
import { invoke } from '../../bridge';
import { folderPath, tilde, useStatus, type ClaudeModel, type CommandKey, type DictateKey, type PageProps, type Settings } from '../../store';
import { Button, Icon, PageHeader, Section, Segmented, TextField, Tile, TileGroup, Toggle } from '../../ui';

const MODELS: { value: ClaudeModel; label: string }[] = [
  { value: 'claude-haiku-5-5', label: 'Haiku' }, { value: 'claude-sonnet-5-5', label: 'Sonnet' }, { value: 'claude-opus-5-5', label: 'Opus' },
];
const ABOUT: Record<ClaudeModel, string> = {
  'claude-haiku-5-5': 'Haiku 5.5: the fastest, best while you type.',
  'claude-sonnet-5-5': 'Sonnet 5.5: more careful, a moment slower.',
  'claude-opus-5-5': 'Opus 5.5: the most capable, for long notes and meetings.',
};
const NAME: Record<ClaudeModel, string> = { 'claude-haiku-5-5': 'Haiku', 'claude-sonnet-5-5': 'Sonnet', 'claude-opus-5-5': 'Opus' };
const DICTATE: Record<DictateKey, string> = { fn: 'fn', rightCommand: 'right ⌘', rightOption: 'right ⌥', rightControl: 'right ⌃', rightShift: 'right ⇧' };
const COMMAND: Record<Exclude<CommandKey, 'off'>, string> = { control: '⌃', option: '⌥', command: '⌘', shift: '⇧' };

const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function Claude({ settings, update }: PageProps) {
  const claude = settings.claude;
  const [status] = useStatus();
  const [problem, setProblem] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const path = (key: 'claudeCode' | 'projectFolder') => (typed: string) => {
    const value = folderPath(typed, status?.home);
    if (value === undefined) { setProblem(key === 'claudeCode' ? 'Use a full path, like ~/.local/bin/claude.' : 'Use a full path, like ~/Code/project.'); return; }
    setProblem(null);
    void update({ claude: { [key]: value } });
  };
  const find = () => {
    setFinding(true); setProblem(null);
    void invoke<string | null>('claude_code_find').then(found => {
      if (!found) setProblem('Claude Code isn’t installed on this Mac. Install it, then choose Find again.');
    }, error => setProblem(message(error, 'Couldn’t look for Claude Code.'))).finally(() => setFinding(false));
  };
  const keys = settings.shortcuts;
  const commandsHow = keys.command === 'off'
    ? 'The command key is off in Shortcuts, so commands can’t be given.'
    : `Hold ${DICTATE[keys.dictate]} with ${COMMAND[keys.command]} and say what to do. With text selected, Claude rewrites it; otherwise it answers or writes at the cursor.`;

  return <>
    <PageHeader icon="claude" title="Claude">Polish, commands, titles and summaries, with your own Anthropic key.</PageHeader>
    <Connection connected={claude.enabled} model={claude.model} />
    <Section title="Model" note={claude.enabled ? undefined : 'These take effect once Claude is connected.'}>
      <TileGroup>
        <Tile title="Model" detail={ABOUT[claude.model]}>
          <Segmented label="Model" value={claude.model} options={MODELS} onChange={model => void update({ claude: { model } })} />
        </Tile>
        <Tile title="Commands" detail={commandsHow}>
          <Toggle label="Commands" checked={claude.commands} onChange={commands => void update({ claude: { commands } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Seen settings={settings} />
    <Section title="Claude Code" note={problem ?? 'Send to Claude Code, on a saved note, opens Terminal in your project and starts Claude Code with the note as its first message.'}>
      <TileGroup>
        <Tile title="Claude Code" detail={claude.claudeCode ? 'Found on this Mac.' : 'Not found yet. It is looked for each time the app opens.'}>
          <TextField label="Claude Code path" monospace value={tilde(claude.claudeCode ?? '', status?.home)} placeholder="~/.local/bin/claude" onCommit={path('claudeCode')} />
          <Button disabled={finding} onClick={find}>{finding ? 'Finding…' : 'Find'}</Button>
        </Tile>
        <Tile title="Project folder" detail={claude.projectFolder ? 'Where Claude Code starts.' : 'Empty: you choose a folder each time.'}>
          <TextField label="Project folder" monospace value={tilde(claude.projectFolder ?? '', status?.home)} placeholder="~/Code/project" onCommit={path('projectFolder')} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}

/// The key: pasted once, tested, then shown only as saved, with Test and Remove.
function Connection({ connected, model }: { connected: boolean; model: ClaudeModel }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'connect' | 'test' | null>(null);
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy('connect'); setNote(null);
    void invoke('claude_save_key', { key }).then(() => { setKey(''); setNote({ text: 'Connected. Your key is saved in your Keychain.' }); },
      error => setNote({ text: message(error, 'Couldn’t connect.'), error: true })).finally(() => setBusy(null));
  };
  const test = () => {
    setBusy('test'); setNote(null);
    void invoke<number>('claude_test').then(ms => setNote({ text: `Working. ${NAME[model]} answered in ${seconds(ms)}.` }),
      error => setNote({ text: message(error, 'The test didn’t go through.'), error: true })).finally(() => setBusy(null));
  };
  const remove = () => {
    setRemoving(false); setNote(null);
    void invoke('claude_remove_key').catch(error => setNote({ text: message(error, 'Couldn’t remove the key.'), error: true }));
  };
  const said = note && <span role={note.error ? 'alert' : 'status'} style={note.error ? { color: 'var(--danger)' } : undefined}>{note.text}</span>;

  if (!connected) return <Section title="Connection" note={said ?? 'Claude sees text only, never your voice. Nothing is sent until you connect.'}>
    <TileGroup>
      <Tile title="Anthropic API key" detail="Paste a key from the Anthropic Console. It is tested with a tiny request, then saved in your Keychain." stack>
        <form className="pair" onSubmit={connect}>
          <input className="ui-field mono" type="password" value={key} aria-label="Anthropic API key" placeholder="sk-ant-…" autoComplete="off" spellCheck={false}
            disabled={!!busy} onChange={event => setKey(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!key.trim() || !!busy}>{busy ? 'Testing…' : 'Connect'}</Button>
        </form>
      </Tile>
      <Tile title="No key yet?" detail="Create one in the Anthropic Console. Usage is billed to your Anthropic account.">
        <Button variant="quiet" icon="external" onClick={() => void invoke('claude_open_console').catch(() => {})}>Get a key</Button>
      </Tile>
    </TileGroup>
  </Section>;

  return <Section title="Connection" note={said ?? 'Your key stays in your Keychain. It is never shown here again.'}>
    <TileGroup>
      <Tile title={removing ? 'Remove the key?' : 'Anthropic API key'} detail={removing ? 'Claude turns off until you paste a key again.' : 'Saved in your Keychain.'}>
        {removing
          ? <><Button variant="quiet" onClick={() => setRemoving(false)}>Cancel</Button><Button variant="danger" onClick={remove}>Remove</Button></>
          : <><span className="state" data-on><Icon name="check" size={14} />Saved</span>
            <Button disabled={!!busy} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
            <Button variant="danger" disabled={!!busy} onClick={() => { setRemoving(true); setNote(null); }}>Remove…</Button></>}
      </Tile>
    </TileGroup>
  </Section>;
}

/// What goes to Anthropic, feature by feature, as the settings stand now.
function Seen({ settings }: { settings: Settings }) {
  const { claude, apps, notes, meetings } = settings;
  const polished = apps.styles.filter(app => app.polish && app.style !== 'raw').length;
  const rows: { title: string; detail: string; on: boolean; state: string; route?: string; place?: string }[] = [
    { title: 'Polish', detail: 'What you dictate, in apps where polish is on, to tidy it.', on: polished > 0, state: polished ? `In ${polished} ${polished === 1 ? 'app' : 'apps'}` : 'Off', route: 'apps', place: 'App styles' },
    { title: 'Commands', detail: 'What you say with the command key, and the text you selected.', on: claude.commands, state: claude.commands ? 'On' : 'Off' },
    { title: 'Notes', detail: 'A saved note’s words, for its title and action items.', on: notes.claudeTitle || notes.claudeActions, state: notes.claudeTitle || notes.claudeActions ? 'On' : 'Off', route: 'notes', place: 'Notes' },
    { title: 'Meetings', detail: 'The transcript, for a summary, decisions and action items.', on: meetings.summarize, state: meetings.summarize ? 'On' : 'Off', route: 'meetings', place: 'Meetings' },
  ];
  return <Section title="What Claude sees" note="Only text, sent straight to Anthropic over an encrypted connection with your key. Your voice never leaves this Mac.">
    <TileGroup>
      {rows.map(row => <Tile key={row.title} title={row.title} detail={row.detail} dim={!claude.enabled}>
        {row.route && <Button variant="quiet" small onClick={() => { location.hash = row.route!; }} aria-label={`Open ${row.place}`}>{row.place}</Button>}
        <span className="state" data-on={(claude.enabled && row.on) || undefined}>{claude.enabled ? row.state : 'Not sent'}</span>
      </Tile>)}
    </TileGroup>
  </Section>;
}
