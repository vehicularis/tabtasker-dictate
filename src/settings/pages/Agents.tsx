import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../../bridge';
import type { PageProps } from '../../store';
import { Button, Icon, PageHeader, Section, Tile, TileGroup, Toggle } from '../../ui';

// What mcp.rs's agents_status reports.
type Added = 'no' | 'yes' | 'elsewhere';
type Install = { found: boolean; added: Added };
type Call = { atMs: number; tool: string; client: string; ok: boolean };
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
  const who = CLIENTS[call.client] ?? (call.client || 'An agent');
  const [did, doing] = TOOLS[call.tool] ?? ['asked for something', 'ask for something'];
  return call.ok ? `${who} ${did} ${ago(call.atMs)}.` : `${who} tried to ${doing} ${ago(call.atMs)}, and couldn’t.`;
}

// As a shell reads it, for pasting into an app's settings or a terminal.
const quote = (part: string) => (/^[\w./-]+$/.test(part) ? part : `"${part.replace(/(["\\$`])/g, '\\$1')}"`);

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

function Connect({ target, status, busy, confirming, onConfirm, onCancel, onAdd }: {
  target: Target; status: AgentsStatus | null; busy: boolean; confirming: boolean; onConfirm: () => void; onCancel: () => void; onAdd: () => void;
}) {
  const copy = COPY[target];
  const install = status?.[target];
  const update = install?.added === 'elsewhere';
  if (confirming) {
    return <Tile title={`${update ? 'Update' : 'Add to'} ${copy.name}?`} detail={copy.confirm}>
      <Button variant="quiet" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button variant="primary" onClick={onAdd} disabled={busy} autoFocus>{busy ? (update ? 'Updating…' : 'Adding…') : update ? 'Update' : 'Add'}</Button>
    </Tile>;
  }
  const detail = !install ? 'Looking…'
    : install.added === 'yes' ? copy.added
    : update ? 'Added for another copy of TabTasker Dictate. Update it to use this one.'
    : !install.found ? copy.missing
    : copy.about;
  return <Tile title={copy.name} detail={detail}>
    {install?.added === 'yes'
      ? <span className="state" data-on><Icon name="check" size={16} />Added</span>
      : <Button aria-label={`${update ? 'Update' : 'Add to'} ${copy.name}`} onClick={onConfirm} disabled={!install || (!install.found && !update) || !!status?.problem}>{update ? 'Update…' : 'Add…'}</Button>}
  </Tile>;
}

export function Agents({ settings, update }: PageProps) {
  const agents = settings.agents;
  const off = !agents.mcp;
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => void invoke<AgentsStatus>('agents_status').then(setStatus).catch(() => {}), []);
  // Again on focus: the last call changes while you are in the agent.
  useEffect(() => { refresh(); addEventListener('focus', refresh); return () => removeEventListener('focus', refresh); }, [refresh]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);

  const add = (target: Target) => {
    setBusy(true);
    setMessage(null);
    invoke<AgentsStatus>('agents_add', { target })
      .then(setStatus)
      .catch(error => setMessage(typeof error === 'string' ? error : `Couldn’t add it to ${COPY[target].name}`))
      .finally(() => { setBusy(false); setConfirming(null); });
  };
  const command = status?.command.map(quote).join(' ') ?? '';
  const copy = () => void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setMessage('Couldn’t copy the command'));

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
    <Section title="Connect" note={message ?? status?.problem}>
      <TileGroup>
        {(['claudeCode', 'claudeDesktop'] as const).map(target => <Connect key={target} target={target} status={status} busy={busy && confirming === target}
          confirming={confirming === target} onConfirm={() => { setMessage(null); setConfirming(target); }} onCancel={() => setConfirming(null)} onAdd={() => add(target)} />)}
        <Tile stack title="Other apps" detail="Any app that runs local MCP servers can start TabTasker Dictate with this command.">
          <span className="pair">
            <input className="ui-field mono" readOnly value={command} aria-label="Command for other apps" onFocus={event => event.target.select()} />
            <Button icon={copied ? 'check' : 'copy'} onClick={copy} disabled={!command}>{copied ? 'Copied' : 'Copy'}</Button>
          </span>
        </Tile>
      </TileGroup>
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
