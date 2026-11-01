import { useState } from 'react';
import { folderPath, tilde, useStatus, type PageProps } from '../../store';
import { Button, PageHeader, Section, TextField, Tile, TileGroup, Toggle } from '../../ui';

export function Meetings({ settings, update }: PageProps) {
  const meetings = settings.meetings;
  const [status] = useStatus();
  const [problem, setProblem] = useState<string | null>(null);
  const home = status?.home;
  return <>
    <PageHeader icon="meeting" title="Meetings">Record a call or a room, and get a transcript with who said what.</PageHeader>
    <Section title="Recording" note="Audio is transcribed on this Mac as the meeting goes, and kept safe until the file is saved.">
      <TileGroup>
        <Tile title="Record other people too" detail="Includes the Mac’s own sound, such as a call. Needs macOS 14.2 or later; otherwise only your microphone is recorded.">
          <Toggle label="Record other people too" checked={meetings.systemAudio} onChange={systemAudio => update({ meetings: { systemAudio } })} />
        </Tile>
        <Tile title="Summary" detail={settings.claude.enabled ? 'Claude adds a summary, decisions and action items.' : 'Claude adds a summary, decisions and action items once connected.'}>
          <Toggle label="Summary" checked={meetings.summarize} onChange={summarize => update({ meetings: { summarize } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Transcript">
      <TileGroup>
        <Tile title="Your name" detail="How your lines are labelled."><TextField label="Your name" value={meetings.you} onCommit={you => update({ meetings: { you } })} /></Tile>
        <Tile title="Everyone else" detail="How the Mac’s sound is labelled."><TextField label="Everyone else" value={meetings.others} onCommit={others => update({ meetings: { others } })} /></Tile>
      </TileGroup>
    </Section>
    <Section title="Where" note={problem ?? undefined}>
      <TileGroup>
        <Tile title="Folder" detail={meetings.folder ? undefined : 'Empty keeps meetings in a Meetings folder inside your notes folder.'} stack>
          <TextField label="Meetings folder" monospace wide value={tilde(meetings.folder ?? '', home)} placeholder="Notes folder › Meetings" onCommit={typed => {
            const folder = folderPath(typed, home);
            if (folder === undefined) { setProblem('Use a full path, like ~/Meetings.'); return; }
            setProblem(null);
            update({ meetings: { folder } });
          }} />
          {meetings.folder && <Button variant="quiet" onClick={() => update({ meetings: { folder: null } })}>Use default</Button>}
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
