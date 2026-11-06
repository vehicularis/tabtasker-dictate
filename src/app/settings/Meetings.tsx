import { useEffect, useId, useRef, useState } from 'react';
import { invoke, listen } from '../../bridge';
import { meetingLength, meetingWhen } from '../../lib/dates';
import { sentence } from '../../lib/errors';
import { useMeetingState } from '../../overlay/MeetingPill';
import { folderPath, tilde, useStatus, type PageProps } from '../../store';
import type { MeetingEvent } from '../../api/types';
import { Button, PageHeader, Section, TextField, Tile, TileGroup, Toggle } from '../../ui';


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

  useEffect(() => listen('dictate-meeting', event => { if (event.state !== 'recording') setOutcome(event); }), []);
  useEffect(() => {
    const next = focusNext.current && document.getElementById(focusNext.current);
    if (next) { focusNext.current = null; next.focus(); }
  }, [state, discarding]);

  const startOrStop = () => {
    setStartProblem(null);
    const action = recording ? 'stop' : 'start';
    void invoke('meeting', { action }).then(changed => {
      if (!changed && action === 'start') setStartProblem('Couldn’t start the meeting. Check that Dictate is allowed to use the microphone.');
      refresh();
    }, (error: unknown) => setStartProblem(typeof error === 'string' ? sentence(error) : 'Couldn’t start the meeting.'));
  };
  const recover = (id: string, save: boolean) => {
    setDiscarding(null); setRecoverProblem(null);
    const at = leftovers.findIndex(leftover => leftover.id === id);
    const neighbour = leftovers[at + 1] ?? leftovers[at - 1];
    focusNext.current = neighbour ? `${base}-save-${neighbour.id}` : `${base}-start`;
    void invoke('meeting_recover', { id, save }).then(refresh, (error: unknown) => {
      setRecoverProblem(typeof error === 'string' ? sentence(error) : save ? 'Couldn’t save the recording. Try again.' : 'Couldn’t discard the recording. Try again.');
      refresh();
    });
  };
  const confirm = (id: string) => { focusNext.current = `${base}-keep-${id}`; setDiscarding(id); };
  const keep = (id: string) => { focusNext.current = `${base}-discard-${id}`; setDiscarding(null); };
  const reveal = (path: string) => void invoke('meeting_reveal', { path }).catch(() => setStartProblem('Couldn’t find that file. It may have been moved.'));

  // What the last meeting is doing after Stop or Save: saving, saved, or why it wasn't.
  const shown: MeetingEvent | null = outcome ?? (state?.saving.length ? { state: 'saving' } : null);
  const outcomeTile = (() => {
    if (shown?.state === 'saving') return <Tile title={<span role="status">Saving the meeting</span>} detail={sentence(shown.message ?? 'Dictate is writing up the transcript')} />;
    if (shown?.state === 'saved' && shown.path) {
      const path = shown.path;
      return <Tile title={<span role="status">Meeting saved</span>} detail={<>{path.split('/').pop()?.replace(/\.md$/, '')}{shown.message && <><br />{shown.message}</>}</>}>
        <Button onClick={() => reveal(path)}>Show in Finder</Button>
      </Tile>;
    }
    if (shown?.state === 'error') {
      const message = sentence(shown.message ?? 'Something went wrong');
      return <Tile title={<span role="alert">The meeting wasn’t saved</span>} detail={shown.leftover ? `${message} You’ll find the recording below.` : message} />;
    }
    return null;
  })();

  const systemDetail = unsupported
    ? 'This needs macOS 14.2 or later, so for now meetings only record your microphone.'
    : permission === 'notDetermined' ? 'macOS asks for permission when your first meeting starts.' : undefined;
  return <>
    <PageHeader icon="meeting" title="Meetings">Record a call or a conversation and get a transcript of who said what.</PageHeader>
    <Section note={startProblem ?? undefined}>
      <TileGroup>
        <Tile title={recording ? 'Recording a meeting' : 'Start a meeting'}
          detail={recording?.since ? `You started recording at ${new Date(recording.since).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`
            : `You can also start one from the pill${chord ? ` or with ${chord}` : ''}.`}>
          <Button id={`${base}-start`} variant={recording ? 'secondary' : 'primary'} disabled={!state} onClick={startOrStop}>{recording ? 'Stop' : 'Start'}</Button>
        </Tile>
        {outcomeTile}
      </TileGroup>
    </Section>
    {leftovers.length > 0 && <Section title="Recordings kept" note={recoverProblem ?? 'These didn’t finish saving, or have parts that couldn’t be transcribed. They’re kept until you save or discard them.'}>
      <TileGroup label="Recordings kept">
        {leftovers.map(leftover => {
          const confirming = discarding === leftover.id;
          const detail = confirming
            ? (leftover.saved ? 'Discard this recording? Your saved meeting stays.' : 'Discard this recording? There’s no undo.')
            : `${meetingLength(leftover.seconds)} · ${leftover.saved ? 'Saved, but parts weren’t transcribed' : 'Not saved yet'}`;
          return <Tile key={leftover.id} title={meetingWhen(leftover.sinceMs, Date.now())} detail={detail}>
            {confirming
              ? <><Button id={`${base}-keep-${leftover.id}`} small onClick={() => keep(leftover.id)}>Keep</Button><Button small variant="danger" onClick={() => recover(leftover.id, false)}>Discard</Button></>
              : <><Button id={`${base}-discard-${leftover.id}`} small variant="quiet" onClick={() => confirm(leftover.id)}>Discard</Button>
                <Button id={`${base}-save-${leftover.id}`} small variant="primary" onClick={() => recover(leftover.id, true)}>{leftover.saved ? 'Try again' : 'Save'}</Button></>}
          </Tile>;
        })}
      </TileGroup>
    </Section>}
    <Section title="Recording" note="You don’t need headphones, because Dictate cancels the echo from your speakers.">
      <TileGroup>
        <Tile title="Record the other side of calls" detail={systemDetail} dim={unsupported}>
          <Toggle label="Record the other side of calls" checked={meetings.systemAudio && !unsupported} disabled={unsupported} onChange={systemAudio => update({ meetings: { systemAudio } })} />
        </Tile>
        {meetings.systemAudio && permission === 'denied' && <Tile title="System audio isn’t allowed" detail="Turn on TabTasker | Dictate under System Audio Recording Only in Privacy & Security.">
          <Button onClick={() => void invoke('meeting_privacy').catch(() => {})}>Open System Settings</Button>
        </Tile>}
        <Tile title="Summary" detail={settings.claude.enabled ? 'AI names the meeting and writes a summary of it.' : 'Connect AI in Agents to use this.'}>
          <Toggle label="Summary" checked={meetings.summarize} onChange={summarize => update({ meetings: { summarize } })} />
        </Tile>
        <Tile title="Decisions" dim={!meetings.summarize}>
          <Toggle label="Decisions" checked={meetings.decisions} disabled={!meetings.summarize} onChange={decisions => update({ meetings: { decisions } })} />
        </Tile>
        <Tile title="Action items" dim={!meetings.summarize}>
          <Toggle label="Action items" checked={meetings.actionItems} disabled={!meetings.summarize} onChange={actionItems => update({ meetings: { actionItems } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Transcript">
      <TileGroup>
        <Tile title="Tell speakers apart" detail={meetings.speakers ? 'Other voices are labelled Person 1, Person 2 and so on. The first time, this downloads 47 MB.' : 'Without this, everyone but you shares one label.'}>
          <Toggle label="Tell speakers apart" checked={meetings.speakers} onChange={speakers => update({ meetings: { speakers } })} />
        </Tile>
        <Tile title="Your name"><TextField label="Your name" value={meetings.you} onCommit={you => update({ meetings: { you } })} /></Tile>
        <Tile title="Everyone else" detail={meetings.speakers ? 'Used when Dictate can’t tell voices apart.' : 'The label for everyone else on a call.'}><TextField label="Everyone else" value={meetings.others} onCommit={others => update({ meetings: { others } })} /></Tile>
      </TileGroup>
    </Section>
    <Section title="Where" note={problem ?? undefined}>
      <TileGroup>
        <Tile title="Folder" detail={meetings.folder ? undefined : 'Leave this empty to keep meetings in your notes folder, under Meetings.'} stack>
          <TextField label="Meetings folder" monospace wide value={tilde(meetings.folder ?? '', home)} placeholder="Notes folder › Meetings" onCommit={typed => {
            const folder = folderPath(typed, home);
            if (folder === undefined) { setProblem('Use a full path, like ~/Meetings.'); return; }
            setProblem(null);
            update({ meetings: { folder } });
          }} />
          {meetings.folder && <Button variant="quiet" onClick={() => update({ meetings: { folder: null } })}>Use the default folder</Button>}
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
