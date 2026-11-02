import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '../../bridge';
import type { PageProps } from '../../store';
import { Button, Icon, PageHeader, Section, Tile, TileGroup, Toggle } from '../../ui';

// What mcp.rs's agents_status reports.
type Added = 'no' | 'yes' | 'elsewhere';
type Install = { found: boolean; added: Added };
type Call = { atMs: number; tool: string; client: string; clientTitle?: string | null; ok: boolean };
export type AgentsStatus = { command: string[]; claudeCode: Install; claudeDesktop: Install; lastCall: Call | null; problem: string | null };
type Target = 'claudeCode' | 'claudeDesktop';

// Each tool as "Claude Code {did}" and "Claude Code tried to {do}".
const TOOLS: Record<string, [string, string]> = {
  list_notes: ['listed your notes', 'list your notes'],
  read_note: ['read a note', 'read a note'],
  search_notes: ['searched your notes', 'search your notes'],
  list_meetings: ['listed your meetings', 'list your meetings'],
  read_meeting: ['read a meeting', 'read a meeting'],
  recent_dictations: ['read your recent dictations', 'read your recent dictations'],
  create_note: ['created a note', 'create a note'],
  append_to_note: ['added to a note', 'add to a note'],
};
const CLIENTS: Record<string, string> = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude Desktop' };

const ago = (ms: number) => {
  const seconds = Math.round((ms - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (-seconds >= size) return format.format(Math.round(seconds / size), unit);
  }
  return 'just now';
};

function lastCall(call: Call | null) {
  if (!call) return 'No agent has asked yet.';
  const who = CLIENTS[call.client] ?? (call.clientTitle || 'An agent');
  const [did, doing] = TOOLS[call.tool] ?? ['asked for something', 'ask for something'];
  return call.ok ? `${who} ${did} ${ago(call.atMs)}.` : `${who} tried to ${doing} ${ago(call.atMs)}, and couldn’t.`;
}

// The entry Claude Desktop gets, which most apps take as is: a program and its arguments, never a shell line.
const entry = ([command, ...args]: string[]) => `"tabtasker-dictate": {\n  "command": ${JSON.stringify(command)},\n  "args": ${JSON.stringify(args)}\n}`;

const Failed = ({ children }: { children: string }) => <span role="alert" style={{ color: 'var(--danger)' }}>{children}</span>;

const COPY: Record<Target, { name: string; about: string; added: string; missing: string; confirm: string }> = {
  claudeCode: {
    name: 'Claude Code',
    about: 'Lets Claude Code use your notes and meetings in every project.',
    added: 'Added for every project. Start a new session to use it.',
    missing: 'Not found. If it is installed, set its path on the Claude page.',
    confirm: 'Runs “claude mcp add” for your user, so every project can use it.',
  },
  claudeDesktop: {
    name: 'Claude Desktop',
    about: 'Lets Claude Desktop use your notes and meetings in any chat.',
    added: 'Added. Quit and reopen Claude Desktop if it was open.',
    missing: 'Claude Desktop isn’t installed on this Mac.',
    confirm: 'Adds it to Claude Desktop’s settings and keeps a copy of the old file. Your other servers stay as they are.',
  },
};

function Connect({ target, status, adding, confirming, failed, onConfirm, onCancel, onAdd }: {
  target: Target; status: AgentsStatus | null; adding: Target | null; confirming: boolean; failed: string | null; onConfirm: () => void; onCancel: () => void; onAdd: () => void;
}) {
  const copy = COPY[target];
  const install = status?.[target];
  const update = install?.added === 'elsewhere';
  const busy = adding === target;
  // The confirm replaces the tile's own control, so the keyboard goes back to it when the confirm closes.
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    if (wasConfirming.current && !confirming) document.querySelector<HTMLElement>(`[data-connect="${target}"]`)?.focus();
    wasConfirming.current = confirming;
  }, [confirming, target]);
  if (confirming) {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); } };
    return <Tile title={`${update ? 'Update' : 'Add to'} ${copy.name}?`} detail={copy.confirm}>
      <Button variant="quiet" onClick={onCancel} onKeyDown={escape} disabled={busy}>Cancel</Button>
      <Button variant="primary" onClick={onAdd} onKeyDown={escape} disabled={busy} autoFocus>{busy ? (update ? 'Updating…' : 'Adding…') : update ? 'Update' : 'Add'}</Button>
    </Tile>;
  }
  const detail = !install ? 'Looking…'
    : failed ? <Failed>{failed}</Failed>
    : install.added === 'yes' ? copy.added
    : update ? 'Added for another copy of TabTasker Dictate. Update it to use this one.'
    : !install.found ? copy.missing
    : copy.about;
  return <Tile title={copy.name} detail={detail}>
    {install?.added === 'yes'
      ? <span className="state" data-on data-connect={target} tabIndex={-1}><Icon name="check" size={16} />Added</span>
      : <Button aria-label={`${update ? 'Update' : 'Add to'} ${copy.name}`} data-connect={target} onClick={onConfirm}
        disabled={!install || (!install.found && !update) || !!status?.problem || adding !== null}>{update ? 'Update…' : 'Add…'}</Button>}
  </Tile>;
}

export function Agents({ settings, update }: PageProps) {
  const agents = settings.agents;
  const off = !agents.mcp;
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [adding, setAdding] = useState<Target | null>(null);
  const [failed, setFailed] = useState<{ target: Target; message: string } | null>(null);
  const [said, setSaid] = useState('');
  const [copied, setCopied] = useState<boolean | null>(null);
  // A status asked for before an add finishes may predate it, so only the newest answer is kept.
  const asked = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    const mine = ++asked.current;
    invoke<AgentsStatus>('agents_status').then(next => { if (mine === asked.current) setStatus(next); }).catch(() => {});
  }, []);
  // Again on focus, and each minute while it shows: the last call changes while you are in the agent.
  useEffect(() => {
    refresh();
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    addEventListener('focus', refresh);
    return () => { clearInterval(timer); removeEventListener('focus', refresh); };
  }, [refresh]);
  useEffect(() => { if (copied === null) return; const timer = setTimeout(() => setCopied(null), copied ? 1600 : 4000); return () => clearTimeout(timer); }, [copied]);

  const add = async (target: Target) => {
    const name = COPY[target].name;
    inFlight.current = true;
    const mine = ++asked.current;
    setAdding(target);
    setFailed(null);
    setSaid('');
    try {
      const next = await invoke<AgentsStatus>('agents_add', { target });
      if (mine === asked.current) setStatus(next);
      setSaid(`Added to ${name}.`);
    } catch (error) {
      setFailed({ target, message: typeof error === 'string' ? error : `Couldn’t add it to ${name}.` });
    }
    inFlight.current = false;
    setAdding(null);
    setConfirming(now => (now === target ? null : now));
  };
  const usable = status && !status.problem ? entry(status.command) : '';
  const copy = () => void navigator.clipboard.writeText(usable).then(() => setCopied(true), () => setCopied(false));

  return <>
    <PageHeader icon="agents" title="Agents (MCP)">Let Claude Code and Claude Desktop use your notes and meetings.</PageHeader>
    <Section title="Server" note="The server runs on this Mac and opens only your notes and meetings folders. What an agent reads goes to its own model, like anything else you share with it.">
      <TileGroup>
        <Tile title="Answer agents" detail="Turn off to refuse every agent at once.">
          <Toggle label="Answer agents" checked={agents.mcp} onChange={mcp => update({ agents: { mcp } })} />
        </Tile>
        <Tile title="Last call" detail={status ? lastCall(status.lastCall) : 'Looking…'} />
      </TileGroup>
    </Section>
    <Section title="Connect">
      <TileGroup>
        {status?.problem && <Tile title="Agents can’t use this copy" detail={status.problem} />}
        {(['claudeCode', 'claudeDesktop'] as const).map(target => <Connect key={target} target={target} status={status} adding={adding}
          confirming={confirming === target} failed={failed?.target === target ? failed.message : null}
          onConfirm={() => { setFailed(null); setSaid(''); setConfirming(target); }} onCancel={() => setConfirming(null)} onAdd={() => void add(target)} />)}
        {usable
          ? <Tile stack title="Other apps" detail={copied === false ? <Failed>Couldn’t copy it. Select the entry and press ⌘C.</Failed> : 'For any other app that runs local MCP servers, add this to “mcpServers” in its settings.'}>
            <span className="pair">
              <pre className="notices" tabIndex={0} aria-label="Entry for other apps">{usable}</pre>
              <Button icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            </span>
          </Tile>
          : <Tile title="Other apps" detail={status ? 'Any app that runs local MCP servers can use it too, once TabTasker Dictate is in Applications.' : 'Looking…'} />}
      </TileGroup>
      <p className="sr" role="status">{said}</p>
    </Section>
    <Section title="What agents can see">
      <TileGroup>
        <Tile title="Notes" detail="List, read and search your notes." dim={off}>
          <Toggle label="Share notes" checked={agents.shareNotes} onChange={shareNotes => update({ agents: { shareNotes } })} />
        </Tile>
        <Tile title="Meetings" detail="List and read meeting transcripts." dim={off}>
          <Toggle label="Share meetings" checked={agents.shareMeetings} onChange={shareMeetings => update({ agents: { shareMeetings } })} />
        </Tile>
        <Tile title="Recent dictations" detail="What you dictated lately, while History keeps it." dim={off}>
          <Toggle label="Share recent dictations" checked={agents.shareHistory} onChange={shareHistory => update({ agents: { shareHistory } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="What agents can do" note="Changes on this page reach agents that are already connected.">
      <TileGroup>
        <Tile title="Write notes" detail="Create notes and add to them. Agents never delete or overwrite one." dim={off}>
          <Toggle label="Write notes" checked={agents.allowWrite} onChange={allowWrite => update({ agents: { allowWrite } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
