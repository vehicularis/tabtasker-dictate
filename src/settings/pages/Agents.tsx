import type { PageProps } from '../../store';
import { PageHeader, Section, Tile, TileGroup, Toggle } from '../../ui';

export function Agents({ settings, update }: PageProps) {
  const agents = settings.agents;
  const off = !agents.mcp;
  return <>
    <PageHeader icon="agents" title="Agents (MCP)">Let Claude Code and Claude Desktop read your notes and meetings, on this Mac.</PageHeader>
    <Section title="Server" note="Agents talk to TabTasker Dictate through a local MCP server. Nothing goes over the network.">
      <TileGroup>
        <Tile title="Answer agents" detail="Turn off to refuse every agent at once.">
          <Toggle label="Answer agents" checked={agents.mcp} onChange={mcp => update({ agents: { mcp } })} />
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
    <Section title="What agents can do">
      <TileGroup>
        <Tile title="Write notes" detail="Create notes and add to them. Agents never delete or overwrite one." dim={off}>
          <Toggle label="Write notes" checked={agents.allowWrite} onChange={allowWrite => update({ agents: { allowWrite } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
