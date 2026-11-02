import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { invoke } from '../../bridge';
import { folderPath, tilde, useStatus, type ClaudeModel, type ClaudeVia, type CommandKey, type DictateKey, type PageProps, type Settings } from '../../store';
import { Button, Icon, GroupHeader, Section, Segmented, TextField, Tile, TileGroup, Toggle } from '../../ui';

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
  const [refused, setRefused] = useState(0); // a refused path goes back to the saved one in the field
  const refocus = useRef(false);
  useEffect(() => {
    if (refocus.current) document.querySelector<HTMLInputElement>('input[aria-label="Claude Code path"]')?.focus();
    refocus.current = false;
  }, [refused]);
  const path = (typed: string) => {
    const value = folderPath(typed, status?.home);
    if (value === undefined) { setProblem('Use a full path, like ~/.local/bin/claude.'); return; }
    setProblem(null);
    // Claude Code's path is kept only once the app has checked a program is there.
    void invoke('claude_code_set', { path: value }).catch(error => {
      setProblem(message(error, 'Couldn’t keep that path.'));
      refocus.current = document.activeElement?.getAttribute('aria-label') === 'Claude Code path'; // Return, not a click elsewhere
      setRefused(n => n + 1);
    });
  };
  const find = () => {
    if (finding) return;
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
    <GroupHeader title="How it connects">Polish, commands, titles and summaries: through the Claude Code on this Mac, with your own Anthropic key, or with a model running on this Mac. Nothing opens; it all happens under the hood.</GroupHeader>
    <Connection claude={claude} home={status?.home} />
    <Section title="Model and effort" note={claude.enabled ? undefined : 'These take effect once a model is connected.'}>
      <TileGroup>
        <Tile title="Model" detail={ABOUT[claude.model]}>
          <Segmented label="Model" value={claude.model} options={MODELS} onChange={model => void update({ claude: { model } })} />
        </Tile>
        <Tile title="Effort" detail={claude.via === 'local' ? 'Claude’s alone: a local model answers as it is set up in Ollama.' : { low: 'Low: quickest, best for polish while you type.', medium: 'Medium: a balance for titles, summaries and commands.', high: 'High: thinks longest; for long meetings and careful rewrites.' }[claude.effort]} dim={claude.via === 'local'}>
          <Segmented label="Effort" value={claude.effort} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} onChange={effort => void update({ claude: { effort } })} />
        </Tile>
        <Tile title="Commands" detail={commandsHow}>
          <Toggle label="Commands" checked={claude.commands} onChange={commands => void update({ claude: { commands } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Seen settings={settings} />
    <Section title="Claude Code" note={problem ?? 'Where the Claude Code on this Mac is. Found on its own; set it only if it lives somewhere unusual.'}>
      <TileGroup>
        <Tile title="Claude Code" detail={claude.claudeCode ? 'Found on this Mac.' : 'Not found yet. It is looked for each time the app opens.'}>
          <TextField key={refused} label="Claude Code path" monospace value={tilde(claude.claudeCode ?? '', status?.home)} placeholder="~/.local/bin/claude" onCommit={path} />
          <Button aria-busy={finding} onClick={find}>{finding ? 'Finding…' : 'Find'}</Button>
        </Tile>
      </TileGroup>
    </Section>
  </>;
}

const VIAS: { value: ClaudeVia; label: string }[] = [{ value: 'claudeCode', label: 'Claude Code' }, { value: 'api', label: 'Anthropic key' }, { value: 'local', label: 'Local model' }];

/// Two ways in: the Claude Code on this Mac, with the account signed in there, or a key pasted once,
/// tested, then shown only as saved. Connected, the way in use shows with Test and a way out. Focus never
/// falls back to the top of the page: it stays in the field while a key is tested, and moves with each step.
function Connection({ claude, home }: { claude: Settings['claude']; home?: string }) {
  const { enabled: connected, model } = claude;
  const id = useId();
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(claude.localEndpoint);
  const [localModel, setLocalModel] = useState(claude.localModel);
  // Which way to offer first: Claude Code when it is on this Mac, since there is nothing to paste.
  const [via, setVia] = useState<ClaudeVia>(claude.claudeCode ? 'claudeCode' : 'api');
  const [busy, setBusy] = useState<'connect' | 'test' | null>(null);
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const focusNext = useRef<string | null>(null);
  const focus = (what: 'key' | 'code' | 'test' | 'remove' | 'cancel') => { focusNext.current = `${id}-${what}`; };
  useEffect(() => {
    // Kept until its target is drawn: a connect or remove shows its new state once the settings arrive.
    const target = focusNext.current && document.getElementById(focusNext.current);
    if (!target) return;
    target.focus();
    focusNext.current = null;
  });
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy('connect'); setNote(null);
    void invoke('claude_save_key', { key }).then(() => { setKey(''); setNote({ text: 'Connected. Your key is saved in your Keychain.' }); focus('test'); },
      error => { setNote({ text: message(error, 'Couldn’t connect.'), error: true }); focus('key'); }).finally(() => setBusy(null));
  };
  const connectCode = () => {
    if (busy) return;
    setBusy('connect'); setNote(null);
    void invoke('claude_connect_code').then(() => { setNote({ text: 'Connected through Claude Code, with your Claude account.' }); focus('test'); },
      error => { setNote({ text: message(error, 'Couldn’t connect through Claude Code.'), error: true }); focus('code'); }).finally(() => setBusy(null));
  };
  const disconnect = () => {
    setNote(null); focus('code');
    void invoke('claude_disconnect').catch(error => { setNote({ text: message(error, 'Couldn’t disconnect.'), error: true }); focus('remove'); });
  };
  const connectLocal = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy('connect'); setNote(null);
    void invoke('claude_connect_local', { endpoint, model: localModel }).then(() => { setNote({ text: `Connected to ${localModel} on this Mac.` }); focus('test'); },
      error => { setNote({ text: message(error, 'Couldn’t reach the local model.'), error: true }); focus('code'); }).finally(() => setBusy(null));
  };
  const test = () => {
    if (busy) return;
    setBusy('test'); setNote(null);
    void invoke<number>('claude_test').then(ms => setNote({ text: `Working. ${claude.via === 'local' ? claude.localModel : NAME[model]} answered in ${seconds(ms)}.` }),
      error => setNote({ text: message(error, 'The test didn’t go through.'), error: true })).finally(() => setBusy(null));
  };
  const confirm = () => { setRemoving(true); setNote(null); focus('cancel'); };
  const cancel = () => { setRemoving(false); focus('remove'); };
  const remove = () => {
    setRemoving(false); setNote(null); focus('key'); // the field appears with the settings, maybe before this answers
    void invoke('claude_remove_key').catch(error => { setNote({ text: message(error, 'Couldn’t remove the key.'), error: true }); focus('remove'); });
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
  const said = note && <span role={note.error ? 'alert' : 'status'} style={note.error ? { color: 'var(--danger)' } : undefined}>{note.text}</span>;

  const codeWhere = claude.claudeCode ? tilde(claude.claudeCode, home) : null;
  if (!connected) return <Section title="Connection" note={said ?? 'Claude sees text only, never your voice. Nothing is sent until you connect.'}>
    <TileGroup>
      <Tile title="Connect through" detail={via === 'claudeCode' ? 'Claude Code runs on this Mac with the Claude account you signed in to there. Nothing else to set up or pay for.' : 'Your own Anthropic key, billed to your Anthropic account.'}>
        <Segmented label="Connect through" value={via} options={VIAS} onChange={setVia} />
      </Tile>
      {via === 'claudeCode' && <Tile title="Claude Code" detail={codeWhere ? `Found at ${codeWhere}. A tiny request to the model below checks it is signed in.` : 'Not found on this Mac. Install Claude Code, run it once in Terminal and sign in, then choose Find below.'}>
        <Button id={`${id}-code`} variant="primary" disabled={!claude.claudeCode} aria-busy={busy === 'connect'} onClick={connectCode}>{busy === 'connect' ? 'Testing…' : 'Connect'}</Button>
      </Tile>}
      {via === 'api' && <Tile title="Anthropic API key" detail="Paste a key from the Anthropic Console. It is tested with a tiny request to the model below, then saved in your Keychain." stack>
        <form className="pair" onSubmit={connect}>
          <input id={`${id}-key`} className="ui-field mono" type="password" value={key} aria-label="Anthropic API key" placeholder="sk-ant-…" autoComplete="off" spellCheck={false}
            readOnly={!!busy} aria-busy={!!busy} onChange={event => setKey(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!key.trim()} aria-busy={!!busy}>{busy ? 'Testing…' : 'Connect'}</Button>
        </form>
      </Tile>}
      {via === 'local' && <Tile title="Local model" detail="A model running on this Mac through Ollama (LM Studio works too). Nothing leaves the Mac. Install Ollama, pull a model such as llama3.2, and connect." stack>
        <form className="pair" onSubmit={connectLocal}>
          <input id={`${id}-code`} className="ui-field mono" type="text" value={endpoint} aria-label="Ollama address" placeholder="http://localhost:11434" spellCheck={false} readOnly={!!busy} onChange={event => setEndpoint(event.target.value)} />
          <input className="ui-field mono" type="text" value={localModel} aria-label="Model name" placeholder="llama3.2" spellCheck={false} readOnly={!!busy} onChange={event => setLocalModel(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!endpoint.trim() || !localModel.trim()} aria-busy={!!busy}>{busy ? 'Testing…' : 'Connect'}</Button>
        </form>
      </Tile>}
      {via === 'api' && <Tile title="No key yet?" detail="Create one in the Anthropic Console. Usage is billed to your Anthropic account.">
        <Button variant="quiet" icon="external" onClick={() => void invoke('claude_open_console').catch(() => {})}>Get a key</Button>
      </Tile>}
    </TileGroup>
  </Section>;

  if (claude.via === 'claudeCode') return <Section title="Connection" note={said ?? 'Requests run through Claude Code on this Mac, with your Claude account. Your key, if you saved one, is not used.'}>
    <TileGroup>
      <Tile title="Claude Code" detail={codeWhere ? `At ${codeWhere}, signed in as you are there.` : 'Signed in as you are there.'}>
        <span className="state" data-on><Icon name="check" size={14} />Connected</span>
        <Button id={`${id}-test`} aria-busy={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        <Button id={`${id}-remove`} disabled={busy === 'test'} onClick={disconnect}>Disconnect</Button>
      </Tile>
    </TileGroup>
  </Section>;

  if (claude.via === 'local') return <Section title="Connection" note={said ?? 'Requests go to the model on this Mac and nowhere else.'}>
    <TileGroup>
      <Tile title="Local model" detail={`${claude.localModel} at ${claude.localEndpoint}.`}>
        <span className="state" data-on><Icon name="check" size={14} />Connected</span>
        <Button id={`${id}-test`} aria-busy={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        <Button id={`${id}-remove`} disabled={busy === 'test'} onClick={disconnect}>Disconnect</Button>
      </Tile>
    </TileGroup>
  </Section>;

  return <Section title="Connection" note={said ?? 'Your key stays in your Keychain. It is never shown here again.'}>
    <TileGroup>
      <Tile title={removing ? 'Remove the key?' : 'Anthropic API key'} detail={removing ? 'Claude turns off until you paste a key again.' : 'Saved in your Keychain.'}>
        {removing
          ? <><Button id={`${id}-cancel`} variant="quiet" onClick={cancel} onKeyDown={escape}>Cancel</Button><Button variant="danger" onClick={remove} onKeyDown={escape}>Remove</Button></>
          : <><span className="state" data-on><Icon name="check" size={14} />Connected</span>
            <Button id={`${id}-test`} aria-busy={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
            <Button id={`${id}-remove`} variant="danger" disabled={busy === 'test'} onClick={confirm}>Remove…</Button></>}
      </Tile>
    </TileGroup>
  </Section>;
}

/// What goes to Anthropic, feature by feature, as the settings stand now.
function Seen({ settings }: { settings: Settings }) {
  const { claude, apps, notes, meetings, shortcuts } = settings;
  const polished = apps.styles.filter(app => app.polish && app.style !== 'raw').length;
  const commands = claude.commands && shortcuts.command !== 'off';
  const rows: { title: string; detail: string; on: boolean; state: string; route?: string; place?: string }[] = [
    { title: 'Polish', detail: 'What you dictate, in apps where polish is on, to tidy it.', on: polished > 0, state: polished ? `In ${polished} ${polished === 1 ? 'app' : 'apps'}` : 'Off', route: 'settings/apps', place: 'App styles' },
    { title: 'Commands', detail: 'What you say with the command key, and the text you selected.', on: commands, state: commands ? 'On' : 'Off',
      ...(shortcuts.command === 'off' && { route: 'settings/shortcuts', place: 'Shortcuts' }) },
    { title: 'Notes', detail: 'A saved note’s words, for its title and action items.', on: notes.claudeTitle || notes.claudeActions, state: notes.claudeTitle || notes.claudeActions ? 'On' : 'Off', route: 'settings/notes', place: 'Notes' },
    { title: 'Meetings', detail: 'The transcript, for a summary, decisions and action items.', on: meetings.summarize, state: meetings.summarize ? 'On' : 'Off', route: 'settings/meetings', place: 'Meetings' },
  ];
  return <Section title="What the model sees" note={claude.via === 'local' ? 'Only text, and only to the model on this Mac.' : claude.via === 'claudeCode' ? 'Only text, sent through Claude Code with your Claude account. Your voice never leaves this Mac.' : 'Only text, sent straight to Anthropic over an encrypted connection with your key. Your voice never leaves this Mac.'}>
    <TileGroup>
      {rows.map(row => <Tile key={row.title} title={row.title} detail={row.detail} dim={!claude.enabled}>
        {row.route && <Button variant="quiet" small onClick={() => { location.hash = row.route!; }} aria-label={`Open ${row.place}`}>{row.place}</Button>}
        <span className="state" data-on={(claude.enabled && row.on) || undefined}>{claude.enabled ? row.state : 'Not sent'}</span>
      </Tile>)}
    </TileGroup>
  </Section>;
}
