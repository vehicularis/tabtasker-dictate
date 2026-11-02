import { useEffect, useId, useRef, useState } from 'react';
import { invoke, listen } from '../../bridge';
import { meetingLength, meetingWhen, useMeetingState, type MeetingEvent } from '../../overlay/MeetingPill';
import { folderPath, tilde, useStatus, type PageProps } from '../../store';
import { Button, PageHeader, Section, TextField, Tile, TileGroup, Toggle } from '../../ui';

const sentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;

export function Meetings({ settings, update }: PageProps) {
  const meetings = settings.meetings;
  const [status] = useStatus();
  const [state, refresh] = useMeetingState();
  const [outcome, setOutcome] = useState<MeetingEvent | null>(null); // the last meeting saving, saved or not
  const [problem, setProblem] = useState<string | null>(null);
  const [startProblem, setStartProblem] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [recoverProblem, setRecoverProblem] = useState<string | null>(null);
  const base = useId();
  const focusNext = useRef<string | null>(null); // where focus goes once the row that had it is gone
  const home = status?.home;
  const recording = state?.recording;
  const permission = state?.systemAudio;
  const unsupported = permission === 'unsupported';
  const chord = settings.shortcuts.meeting?.label;
  const leftovers = state?.leftovers ?? [];

  useEffect(() => listen<MeetingEvent>('dictate-meeting', event => { if (event.state !== 'recording') setOutcome(event); }), []);
  useEffect(() => {
    const next = focusNext.current && document.getElementById(focusNext.current);
    if (next) { focusNext.current = null; next.focus(); }
  }, [state, discarding]);

  const startOrStop = () => {
    setStartProblem(null);
    const action = recording ? 'stop' : 'start';
    void invoke<boolean>('meeting', { action }).then(changed => {
      if (!changed && action === 'start') setStartProblem('Couldn’t start the meeting. Check that TabTasker Dictate can use the microphone.');
      refresh();
    }, (error: unknown) => setStartProblem(typeof error === 'string' ? sentence(error) : 'Couldn’t start the meeting.'));
  };
  const recover = (id: string, save: boolean) => {
    setDiscarding(null); setRecoverProblem(null);
    const at = leftovers.findIndex(leftover => leftover.id === id);
    const neighbour = leftovers[at + 1] ?? leftovers[at - 1];
    focusNext.current = neighbour ? `${base}-save-${neighbour.id}` : `${base}-start`;
    void invoke('meeting_recover', { id, save }).then(refresh, (error: unknown) => {
      setRecoverProblem(typeof error === 'string' ? sentence(error) : 'Couldn’t do that. Try again.');
      refresh();
    });
  };
  const confirm = (id: string) => { focusNext.current = `${base}-keep-${id}`; setDiscarding(id); };
  const keep = (id: string) => { focusNext.current = `${base}-discard-${id}`; setDiscarding(null); };
  const reveal = (path: string) => void invoke('meeting_reveal', { path }).catch(() => setStartProblem('The meeting’s file has moved.'));

  // What the last meeting is doing after Stop or Save: saving, saved, or why it wasn't.
  const shown: MeetingEvent | null = outcome ?? (state?.saving.length ? { state: 'saving' } : null);
  const outcomeTile = (() => {
    if (shown?.state === 'saving') return <Tile title={<span role="status">Saving the meeting</span>} detail={sentence(shown.message ?? 'Finishing the transcript')} />;
    if (shown?.state === 'saved' && shown.path) {
      const path = shown.path;
      return <Tile title={<span role="status">Meeting saved</span>} detail={<>{path.split('/').pop()?.replace(/\.md$/, '')}{shown.message && <><br />{shown.message}</>}</>}>
        <Button onClick={() => reveal(path)}>Show in Finder</Button>
      </Tile>;
    }
    if (shown?.state === 'error') {
      const message = sentence(shown.message ?? 'Something went wrong');
      return <Tile title={<span role="alert">The meeting wasn’t saved</span>} detail={shown.leftover ? `${message} The recording is kept below.` : message} />;
    }
    return null;
  })();

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
          <Button id={`${base}-start`} variant={recording ? 'secondary' : 'primary'} disabled={!state} onClick={startOrStop}>{recording ? 'Stop' : 'Start'}</Button>
        </Tile>
        {outcomeTile}
      </TileGroup>
    </Section>
    {leftovers.length > 0 && <Section title="Recordings kept" note={recoverProblem ?? 'These stopped before they were saved, or have parts that couldn’t be transcribed. Each is kept until you choose.'}>
      <TileGroup label="Recordings kept">
        {leftovers.map(leftover => {
          const confirming = discarding === leftover.id;
          const detail = confirming
            ? (leftover.saved ? 'Discard the recording? The saved meeting stays.' : 'Discard this recording? It can’t be undone.')
            : `${meetingLength(leftover.seconds)} · ${leftover.saved ? 'Saved, with parts not transcribed' : 'Not saved yet'}`;
          return <Tile key={leftover.id} title={meetingWhen(leftover.sinceMs)} detail={detail}>
            {confirming
              ? <><Button id={`${base}-keep-${leftover.id}`} small onClick={() => keep(leftover.id)}>Keep</Button><Button small variant="danger" onClick={() => recover(leftover.id, false)}>Discard</Button></>
              : <><Button id={`${base}-discard-${leftover.id}`} small variant="quiet" onClick={() => confirm(leftover.id)}>Discard</Button>
                <Button id={`${base}-save-${leftover.id}`} small variant="primary" onClick={() => recover(leftover.id, true)}>{leftover.saved ? 'Try again' : 'Save'}</Button></>}
          </Tile>;
        })}
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
