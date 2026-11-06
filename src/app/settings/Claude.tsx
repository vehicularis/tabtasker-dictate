import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { invoke } from '../../bridge';
import { message } from '../../lib/errors';
import { COMMAND_GLYPHS, KEY_NAMES } from '../../lib/keyNames';
import { folderPath, tilde, useStatus, type PageProps } from '../../store';
import type { ClaudeModel, ClaudeVia, Settings } from '../../api/types';
import { Button, Icon, GroupHeader, Section, Segmented, TextField, Tile, TileGroup, Toggle } from '../../ui';

const MODELS: { value: ClaudeModel; label: string }[] = [
  { value: 'claude-haiku-5-5', label: 'Haiku' }, { value: 'claude-sonnet-5-5', label: 'Sonnet' }, { value: 'claude-opus-5-5', label: 'Opus' },
];
const ABOUT: Record<ClaudeModel, string> = {
  'claude-haiku-5-5': 'Haiku 5.5 is the fastest, and the best fit for polish.',
  'claude-sonnet-5-5': 'Sonnet 5.5 is more careful, and a little slower.',
  'claude-opus-5-5': 'Opus 5.5 is the most capable, and worth it for long meetings.',
};
const NAME: Record<ClaudeModel, string> = { 'claude-haiku-5-5': 'Haiku', 'claude-sonnet-5-5': 'Sonnet', 'claude-opus-5-5': 'Opus' };

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
      setProblem(message(error, 'Couldn’t use that path. Check that Claude Code is there.'));
      refocus.current = document.activeElement?.getAttribute('aria-label') === 'Claude Code path'; // Return, not a click elsewhere
      setRefused(n => n + 1);
    });
  };
  const find = () => {
    if (finding) return;
    setFinding(true); setProblem(null);
    void invoke('claude_code_find').then(found => {
      if (!found) setProblem('Couldn’t find Claude Code. Install it, then click Find again.');
    }, error => setProblem(message(error, 'Couldn’t look for Claude Code. Try again in a moment.'))).finally(() => setFinding(false));
  };
  // The way in use once connected, else the one being chosen: Haiku, Sonnet, Opus and effort are Claude's alone,
  // so a local model (named under Connection) shows only what applies to it.
  const [choosing, setChoosing] = useState<ClaudeVia>(claude.claudeCode ? 'claudeCode' : 'api');
  const custom = ['local', 'openAi'].includes(claude.enabled ? claude.via : choosing); // a model named by hand: Haiku, Sonnet, Opus and effort are Claude's alone
  const keys = settings.shortcuts;
  const commandsHow = keys.command === 'off'
    ? 'Turn on Ask AI in Shortcuts to use commands.'
    : `Hold ${KEY_NAMES[keys.dictate]} with ${COMMAND_GLYPHS[keys.command]} and tell the AI what to do with the selected text, or ask it something.`;

  return <>
    <GroupHeader title="AI">AI only ever gets the text of what you say, never your voice. If you’d rather nothing left your Mac, use a local model.</GroupHeader>
    <Connection claude={claude} home={status?.home} via={choosing} onVia={setChoosing} />
    <Section title={custom ? undefined : 'Model and effort'} note={claude.enabled ? undefined : custom ? 'This applies once you’re connected.' : 'These apply once you’re connected.'}>
      <TileGroup>
        {!custom && <>
          <Tile title="Model" detail={ABOUT[claude.model]}>
            <Segmented label="Model" value={claude.model} options={MODELS} onChange={model => void update({ claude: { model } })} />
          </Tile>
          <Tile title="Effort" detail={{ low: 'It answers fastest, which is all polish needs.', medium: 'It’s a good middle ground for most things.', high: 'It’s slower, but more thorough with long meetings.' }[claude.effort]}>
            <Segmented label="Effort" value={claude.effort} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} onChange={effort => void update({ claude: { effort } })} />
          </Tile>
        </>}
        <Tile title="Commands" detail={commandsHow}>
          <Toggle label="Commands" checked={claude.commands} onChange={commands => void update({ claude: { commands } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Seen settings={settings} />
    <Section title="Claude Code" note={problem ?? 'Dictate finds Claude Code on its own, so you only need this if it’s somewhere unusual.'}>
      <TileGroup>
        <Tile title="Claude Code" detail={claude.claudeCode ? undefined : 'Dictate couldn’t find it, but it looks again every time it opens.'}>
          <TextField key={refused} label="Claude Code path" monospace value={tilde(claude.claudeCode ?? '', status?.home)} placeholder="~/.local/bin/claude" onCommit={path} />
          <Button aria-busy={finding} onClick={find}>{finding ? 'Finding…' : 'Find'}</Button>
        </Tile>
      </TileGroup>
    </Section>
  </>;
}

const VIAS: { value: ClaudeVia; label: string }[] = [{ value: 'claudeCode', label: 'Claude Code' }, { value: 'api', label: 'Anthropic key' }, { value: 'openAi', label: 'OpenAI & others' }, { value: 'local', label: 'Local model' }];

/// Two ways in: the Claude Code on this Mac, with the account signed in there, or a key pasted once,
/// tested, then shown only as saved. Connected, the way in use shows with Test and a way out. Focus never
/// falls back to the top of the page: it stays in the field while a key is tested, and moves with each step.
/// `via` is the way being chosen (Claude holds it: the model settings under this follow it). It starts on Claude
/// Code when it is on this Mac, since there is nothing to paste.
function Connection({ claude, home, via, onVia: setVia }: { claude: Settings['claude']; home?: string; via: ClaudeVia; onVia: (via: ClaudeVia) => void }) {
  const { enabled: connected, model } = claude;
  const id = useId();
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(claude.localEndpoint);
  const [localModel, setLocalModel] = useState(claude.localModel);
  const [openEndpoint, setOpenEndpoint] = useState(claude.openAiEndpoint);
  const [openModel, setOpenModel] = useState(claude.openAiModel);
  const [openKey, setOpenKey] = useState('');
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
    void invoke('claude_save_key', { key }).then(() => { setKey(''); setNote({ text: 'Connected. Your Anthropic key is in your Keychain.' }); focus('test'); },
      error => { setNote({ text: message(error, 'Couldn’t connect. Check the key and try again.'), error: true }); focus('key'); }).finally(() => setBusy(null));
  };
  const connectCode = () => {
    if (busy) return;
    setBusy('connect'); setNote(null);
    void invoke('claude_connect_code').then(() => { setNote({ text: 'Connected through Claude Code.' }); focus('test'); },
      error => { setNote({ text: message(error, 'Couldn’t connect through Claude Code. Check that you’re signed in to it.'), error: true }); focus('code'); }).finally(() => setBusy(null));
  };
  const disconnect = () => {
    setNote(null); focus('code');
    void invoke('claude_disconnect').catch(error => { setNote({ text: message(error, 'Couldn’t disconnect. Try again.'), error: true }); focus('remove'); });
  };
  const connectLocal = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy('connect'); setNote(null);
    void invoke('claude_connect_local', { endpoint, model: localModel }).then(() => { setNote({ text: `Connected to ${localModel}.` }); focus('test'); },
      error => { setNote({ text: message(error, 'Couldn’t reach the local model. Make sure it’s running.'), error: true }); focus('code'); }).finally(() => setBusy(null));
  };
  const connectOpenAi = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy('connect'); setNote(null);
    void invoke('claude_connect_open_ai', { endpoint: openEndpoint, key: openKey, model: openModel }).then(() => { setOpenKey(''); setNote({ text: `Connected to ${openModel}. The key is in your Keychain.` }); focus('test'); },
      error => { setNote({ text: message(error, 'Couldn’t connect. Check the address, the model and the key.'), error: true }); focus('key'); }).finally(() => setBusy(null));
  };
  const test = () => {
    if (busy) return;
    setBusy('test'); setNote(null);
    void invoke('claude_test').then(ms => setNote({ text: `${claude.via === 'local' ? claude.localModel : claude.via === 'openAi' ? claude.openAiModel : NAME[model]} answered in ${seconds(ms)}.` }),
      error => setNote({ text: message(error, 'The test didn’t go through. Try again in a moment.'), error: true })).finally(() => setBusy(null));
  };
  const confirm = () => { setRemoving(true); setNote(null); focus('cancel'); };
  const cancel = () => { setRemoving(false); focus('remove'); };
  const remove = () => {
    setRemoving(false); setNote(null); focus('key'); // the field appears with the settings, maybe before this answers
    void invoke('claude_remove_key').catch(error => { setNote({ text: message(error, 'Couldn’t remove the key. Try again.'), error: true }); focus('remove'); });
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
  const said = note && <span role={note.error ? 'alert' : 'status'} style={note.error ? { color: 'var(--danger)' } : undefined}>{note.text}</span>;

  const codeWhere = claude.claudeCode ? tilde(claude.claudeCode, home) : null;
  if (!connected) return <Section title="Connection" note={said ?? 'Nothing’s sent until you connect.'}>
    <TileGroup>
      <Tile title="Connect through" detail={via === 'claudeCode' ? 'Uses whichever Claude account Claude Code is signed in to.' : via === 'openAi' ? 'Any service that speaks the OpenAI API, with its own key.' : via === 'local' ? 'A model running on this Mac. Nothing leaves it.' : 'Anthropic’s API with your own key.'} stack>
        <Segmented label="Connect through" value={via} options={VIAS} onChange={setVia} />
      </Tile>
      {via === 'claudeCode' && <Tile title="Claude Code" detail={codeWhere ? undefined : 'Install Claude Code and sign in once in Terminal, then click Find below.'}>
        <Button id={`${id}-code`} variant="primary" disabled={!claude.claudeCode} aria-busy={busy === 'connect'} onClick={connectCode}>{busy === 'connect' ? 'Testing…' : 'Connect'}</Button>
      </Tile>}
      {via === 'api' && <Tile title="Anthropic API key" detail="Dictate checks that it works, then keeps it in your Keychain." stack>
        <form className="pair" onSubmit={connect}>
          <input id={`${id}-key`} className="ui-field mono" type="password" value={key} aria-label="Anthropic API key" placeholder="sk-ant-…" autoComplete="off" spellCheck={false}
            readOnly={!!busy} aria-busy={!!busy} onChange={event => setKey(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!key.trim()} aria-busy={!!busy}>{busy ? 'Testing…' : 'Connect'}</Button>
        </form>
      </Tile>}
      {via === 'local' && <Tile title="Local model" detail="Install Ollama or LM Studio, download a model like llama3.2, then connect." stack>
        <form className="pair" onSubmit={connectLocal}>
          <input id={`${id}-code`} className="ui-field mono" type="text" value={endpoint} aria-label="Ollama address" placeholder="http://localhost:11434" spellCheck={false} readOnly={!!busy} onChange={event => setEndpoint(event.target.value)} />
          <input className="ui-field mono" type="text" value={localModel} aria-label="Model name" placeholder="llama3.2" spellCheck={false} readOnly={!!busy} onChange={event => setLocalModel(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!endpoint.trim() || !localModel.trim()} aria-busy={!!busy}>{busy ? 'Testing…' : 'Connect'}</Button>
        </form>
      </Tile>}
      {via === 'openAi' && <Tile title="OpenAI-compatible service" detail="OpenAI, Mistral, Groq, OpenRouter or any service that speaks the OpenAI API: its address, the model’s name and your key. Dictate checks that they work together, then keeps the key in your Keychain." stack>
        <form className="pair" onSubmit={connectOpenAi}>
          <input className="ui-field mono" type="text" value={openEndpoint} aria-label="Service address" placeholder="https://api.openai.com" spellCheck={false} readOnly={!!busy} onChange={event => setOpenEndpoint(event.target.value)} />
          <input className="ui-field mono" type="text" value={openModel} aria-label="Model name" placeholder="gpt-4.1-mini" spellCheck={false} readOnly={!!busy} onChange={event => setOpenModel(event.target.value)} />
          <input id={`${id}-key`} className="ui-field mono" type="password" value={openKey} aria-label="API key" placeholder="sk-…" autoComplete="off" spellCheck={false} readOnly={!!busy} onChange={event => setOpenKey(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!openEndpoint.trim() || !openModel.trim() || !openKey.trim()} aria-busy={!!busy}>{busy ? 'Testing…' : 'Connect'}</Button>
        </form>
      </Tile>}
      {via === 'api' && <Tile title="No key yet?" detail="Make one in the Anthropic Console, which bills you for what you use.">
        <Button variant="quiet" icon="external" onClick={() => void invoke('claude_open_console').catch(() => {})}>Get a key</Button>
      </Tile>}
    </TileGroup>
  </Section>;

  if (claude.via === 'claudeCode') return <Section title="Connection" note={said ?? 'Requests go through Claude Code, so any Anthropic key you saved isn’t used.'}>
    <TileGroup>
      <Tile title="Claude Code">
        <span className="state" data-on><Icon name="check" size={14} />Connected</span>
        <Button id={`${id}-test`} aria-busy={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        <Button id={`${id}-remove`} disabled={busy === 'test'} onClick={disconnect}>Disconnect</Button>
      </Tile>
    </TileGroup>
  </Section>;

  if (claude.via === 'openAi') return <Section title="Connection" note={said ?? 'The key is in your Keychain and won’t be shown again.'}>
    <TileGroup>
      <Tile title="OpenAI-compatible service" detail={`${claude.openAiModel} at ${claude.openAiEndpoint.replace(/^https?:\/\//, '')}.`}>
        <span className="state" data-on><Icon name="check" size={14} />Connected</span>
        <Button id={`${id}-test`} aria-busy={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        <Button id={`${id}-remove`} disabled={busy === 'test'} onClick={disconnect}>Disconnect</Button>
      </Tile>
    </TileGroup>
  </Section>;

  if (claude.via === 'local') return <Section title="Connection" note={said}>
    <TileGroup>
      <Tile title="Local model" detail={`${claude.localModel} at ${claude.localEndpoint}.`}>
        <span className="state" data-on><Icon name="check" size={14} />Connected</span>
        <Button id={`${id}-test`} aria-busy={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        <Button id={`${id}-remove`} disabled={busy === 'test'} onClick={disconnect}>Disconnect</Button>
      </Tile>
    </TileGroup>
  </Section>;

  return <Section title="Connection" note={said ?? 'Your Anthropic key is in your Keychain and won’t be shown again.'}>
    <TileGroup>
      <Tile title={removing ? 'Remove the key?' : 'Anthropic API key'} detail={removing ? 'AI stays off until you add a key again.' : undefined}>
        {removing
          ? <><Button id={`${id}-cancel`} variant="quiet" onClick={cancel} onKeyDown={escape}>Cancel</Button><Button variant="danger" onClick={remove} onKeyDown={escape}>Remove</Button></>
          : <><span className="state" data-on><Icon name="check" size={14} />Connected</span>
            <Button id={`${id}-test`} aria-busy={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
            <Button id={`${id}-remove`} variant="danger" disabled={busy === 'test'} onClick={confirm}>Remove…</Button></>}
      </Tile>
    </TileGroup>
  </Section>;
}

/// What goes to the model, feature by feature, as the settings stand now.
function Seen({ settings }: { settings: Settings }) {
  const { claude, apps, notes, meetings, shortcuts } = settings;
  const polished = apps.styles.filter(app => app.polish && app.style !== 'raw').length;
  const commands = claude.commands && shortcuts.command !== 'off';
  const rows: { title: string; detail: string; on: boolean; state: string; route?: string; place?: string }[] = [
    { title: 'Polish', detail: 'Sees what you dictate in apps where polish is on.', on: polished > 0, state: polished ? `In ${polished} ${polished === 1 ? 'app' : 'apps'}` : 'Off', route: 'settings/apps', place: 'App styles' },
    { title: 'Commands', detail: 'Sees what you ask, and any text you’ve selected.', on: commands, state: commands ? 'On' : 'Off',
      ...(shortcuts.command === 'off' && { route: 'settings/shortcuts', place: 'Shortcuts' }) },
    { title: 'Notes', detail: 'Reads each saved note to name it and list its to-dos.', on: notes.claudeTitle || notes.claudeActions, state: notes.claudeTitle || notes.claudeActions ? 'On' : 'Off', route: 'settings/notes', place: 'Notes' },
    { title: 'Meetings', detail: 'Reads the transcript to write the summary.', on: meetings.summarize, state: meetings.summarize ? 'On' : 'Off', route: 'settings/meetings', place: 'Meetings' },
  ];
  return <Section title="What the model sees" note={claude.via === 'local' ? 'Text goes to your local model and nowhere else.' : claude.via === 'openAi' ? `Text goes to ${claude.openAiEndpoint.replace(/^https?:\/\//, '')} and nowhere else.` : claude.via === 'claudeCode' ? 'Text goes to Anthropic through Claude Code.' : 'Text goes straight to Anthropic over an encrypted connection.'}>
    <TileGroup>
      {rows.map(row => <Tile key={row.title} title={row.title} detail={row.detail} dim={!claude.enabled}>
        {row.route && <Button variant="quiet" small onClick={() => { location.hash = row.route!; }} aria-label={`Open ${row.place}`}>{row.place}</Button>}
        <span className="state" data-on={(claude.enabled && row.on) || undefined}>{claude.enabled ? row.state : 'Not sent'}</span>
      </Tile>)}
    </TileGroup>
  </Section>;
}
