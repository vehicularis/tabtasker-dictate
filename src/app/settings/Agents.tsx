import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '../../bridge';
import { configEntry, lastCall } from '../../lib/agents';
import { message } from '../../lib/errors';
import type { PageProps } from '../../store';
import { Button, Icon, GroupHeader, Section, Tile, TileGroup, Toggle } from '../../ui';
import type { AgentsStatus } from '../../api/types';

type Target = 'claudeCode' | 'claudeDesktop';

const Failed = ({ children }: { children: string }) => <span role="alert" style={{ color: 'var(--danger)' }}>{children}</span>;

const COPY: Record<Target, { name: string; about: string; added: string; missing: string; confirm: string }> = {
  claudeCode: {
    name: 'Claude Code',
    about: 'Lets Claude Code use your notes in every project.',
    added: 'Start a new Claude Code session to use it.',
    missing: 'Couldn’t find Claude Code. If it’s installed, set its path above.',
    confirm: 'This runs “claude mcp add” for your user, so it works in every project.',
  },
  claudeDesktop: {
    name: 'Claude Desktop',
    about: 'Lets Claude Desktop use your notes in any chat.',
    added: 'If Claude Desktop is open, quit and reopen it.',
    missing: 'Claude Desktop isn’t installed.',
    confirm: 'This adds Dictate to Claude Desktop’s settings and backs up the old file first.',
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
    : update ? 'It’s set up for another copy of Dictate. Update it to use this one.'
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
    invoke('agents_status').then(next => { if (mine === asked.current) setStatus(next); }).catch(() => {});
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
      const next = await invoke('agents_add', { target });
      if (mine === asked.current) setStatus(next);
      setSaid(`Added to ${name}.`);
    } catch (error) {
      setFailed({ target, message: message(error, `Couldn’t add it to ${name}. Try again.`) });
    }
    inFlight.current = false;
    setAdding(null);
    setConfirming(now => (now === target ? null : now));
  };
  const usable = status && !status.problem ? configEntry(status.command) : '';
  const copy = () => void navigator.clipboard.writeText(usable).then(() => setCopied(true), () => setCopied(false));

  return <>
    <GroupHeader title="Reading your notes">Let agents read your notes and meetings: Claude Code, Claude Desktop and any app that speaks MCP. If you connected Claude Code above, it’s already set up.</GroupHeader>
    <Section title="Server" note="What an agent reads is sent to its model, like anything else you share with it.">
      <TileGroup>
        <Tile title="Answer agents">
          <Toggle label="Answer agents" checked={agents.mcp} onChange={mcp => update({ agents: { mcp } })} />
        </Tile>
        <Tile title="Last call" detail={status ? lastCall(status.lastCall, Date.now()) : 'Looking…'} />
      </TileGroup>
    </Section>
    <Section title="Connect">
      <TileGroup>
        {status?.problem && <Tile title="Agents can’t use this copy" detail={status.problem} />}
        {(['claudeCode', 'claudeDesktop'] as const).map(target => <Connect key={target} target={target} status={status} adding={adding}
          confirming={confirming === target} failed={failed?.target === target ? failed.message : null}
          onConfirm={() => { setFailed(null); setSaid(''); setConfirming(target); }} onCancel={() => setConfirming(null)} onAdd={() => void add(target)} />)}
        {usable
          ? <Tile stack title="Other apps" detail={copied === false ? <Failed>Couldn’t copy it. Select the entry and press ⌘C.</Failed> : 'To use it in another app that supports MCP, add this to “mcpServers” in its settings.'}>
            <span className="pair">
              <pre className="notices" tabIndex={0} aria-label="Settings entry for other apps">{usable}</pre>
              <Button icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            </span>
          </Tile>
          : <Tile title="Other apps" detail={status ? 'Other apps that support MCP can use it once Dictate is in your Applications folder.' : 'Looking…'} />}
      </TileGroup>
      <p className="sr" role="status">{said}</p>
    </Section>
    <Section title="What agents can see">
      <TileGroup>
        <Tile title="Notes" dim={off}>
          <Toggle label="Share notes" checked={agents.shareNotes} onChange={shareNotes => update({ agents: { shareNotes } })} />
        </Tile>
        <Tile title="Meetings" dim={off}>
          <Toggle label="Share meetings" checked={agents.shareMeetings} onChange={shareMeetings => update({ agents: { shareMeetings } })} />
        </Tile>
        <Tile title="Recent dictations" detail="Agents see only what’s still in History." dim={off}>
          <Toggle label="Share recent dictations" checked={agents.shareHistory} onChange={shareHistory => update({ agents: { shareHistory } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="What agents can do" note="Changes apply right away, even to agents that are already connected.">
      <TileGroup>
        <Tile title="Write notes" detail="Agents can add to your notes, but never delete or overwrite them." dim={off}>
          <Toggle label="Write notes" checked={agents.allowWrite} onChange={allowWrite => update({ agents: { allowWrite } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
