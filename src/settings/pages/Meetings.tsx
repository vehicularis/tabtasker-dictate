import { useState } from 'react';
import { invoke } from '../../bridge';
import { meetingLength, meetingWhen, useMeetingState } from '../../overlay/MeetingPill';
import { folderPath, tilde, useStatus, type PageProps } from '../../store';
import { Button, PageHeader, Section, TextField, Tile, TileGroup, Toggle } from '../../ui';

export function Meetings({ settings, update }: PageProps) {
  const meetings = settings.meetings;
  const [status] = useStatus();
  const [state, refresh] = useMeetingState();
  const [problem, setProblem] = useState<string | null>(null);
  const [startProblem, setStartProblem] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [recoverProblem, setRecoverProblem] = useState<string | null>(null);
  const home = status?.home;
  const recording = state?.recording;
  const permission = state?.systemAudio;
  const unsupported = permission === 'unsupported';
  const chord = settings.shortcuts.meeting?.label;

  const startOrStop = () => {
    setStartProblem(null);
    void invoke<boolean>('meeting', { action: recording ? 'stop' : 'start' }).then(changed => {
      if (!changed && !recording) setStartProblem('Couldn’t start the meeting. Check that TabTasker Dictate can use the microphone.');
      refresh();
    }, () => setStartProblem('Couldn’t start the meeting.'));
  };
  const recover = (id: string, save: boolean) => {
    setDiscarding(null); setRecoverProblem(null);
    void invoke('meeting_recover', { id, save }).then(refresh, (error: unknown) => { setRecoverProblem(typeof error === 'string' ? error : 'Couldn’t do that. Try again.'); refresh(); });
  };

  const systemDetail = unsupported
    ? 'Needs macOS 14.2 or later. On this Mac, meetings record your microphone only.'
    : `Includes the Mac’s own sound, such as the other side of a call.${permission === 'notDetermined' ? ' macOS asks once, when the first meeting starts.' : ''}`;
  return <>
    <PageHeader icon="meeting" title="Meetings">Record a call or a room, and get a transcript with who said what.</PageHeader>
    <Section note={startProblem ?? undefined}>
      <TileGroup>
        <Tile title={recording ? 'Recording a meeting' : 'Start a meeting'}
          detail={recording?.since ? `Started at ${new Date(recording.since).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Stop it here or with Stop by the dots.`
            : `Also from the menu bar, the dots’ menu${chord ? ` or ${chord}` : ''}. A pill by the dots shows the time and Stop.`}>
          <Button variant={recording ? 'secondary' : 'primary'} disabled={!state} onClick={startOrStop}>{recording ? 'Stop' : 'Start'}</Button>
        </Tile>
      </TileGroup>
    </Section>
    {!!state?.leftovers.length && <Section title="Not saved yet" note={recoverProblem ?? 'These recordings stopped before they were saved, and are kept until you choose. Save transcribes one now.'}>
      <TileGroup label="Not saved yet">
        {state.leftovers.map(leftover => <Tile key={leftover.id} title={meetingWhen(leftover.sinceMs)}
          detail={discarding === leftover.id ? 'Discard this recording? It can’t be undone.' : meetingLength(leftover.seconds)}>
          {discarding === leftover.id
            ? <><Button small onClick={() => setDiscarding(null)}>Keep</Button><Button small variant="danger" onClick={() => recover(leftover.id, false)}>Discard</Button></>
            : <><Button small variant="quiet" onClick={() => setDiscarding(leftover.id)}>Discard</Button><Button small variant="primary" onClick={() => recover(leftover.id, true)}>Save</Button></>}
        </Tile>)}
      </TileGroup>
    </Section>}
    <Section title="Recording" note="Your microphone has echo cancellation, so speakers work as well as headphones. Audio is transcribed on this Mac as the meeting goes, and kept safe until the file is saved.">
      <TileGroup>
        <Tile title="Record other people too" detail={systemDetail} dim={unsupported}>
          <Toggle label="Record other people too" checked={meetings.systemAudio && !unsupported} disabled={unsupported} onChange={systemAudio => update({ meetings: { systemAudio } })} />
        </Tile>
        {meetings.systemAudio && permission === 'denied' && <Tile title="System audio isn’t allowed" detail="Meetings record your microphone only. In Privacy & Security, turn on TabTasker Dictate under System Audio Recording Only.">
          <Button onClick={() => void invoke('meeting_privacy').catch(() => {})}>Open System Settings</Button>
        </Tile>}
        <Tile title="Summary" detail={settings.claude.enabled ? 'Claude names the meeting and adds a summary, decisions and action items.' : 'Claude names the meeting and adds a summary, decisions and action items once connected.'}>
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
