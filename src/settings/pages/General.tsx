import { useState } from 'react';
import { invoke } from '../../bridge';
import { resetSettings, useStatus, type PageProps } from '../../store';
import { Button, Icon, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';

const ask = (kind: string) => void invoke('request', { kind }).catch(() => {});

export function General({ settings, update }: PageProps) {
  const [status, refresh] = useStatus();
  const [resetting, setResetting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reset, setReset] = useState<string | null>(null);
  const run = (work: Promise<unknown>, failed: string) => { setProblem(null); void work.then(refresh).catch(() => setProblem(failed)); };
  const icon = settings.general.menuBarIcon;
  const mic = status?.microphone;
  return <>
    <PageHeader icon="general" title="General">How TabTasker Dictate starts and listens.</PageHeader>
    <Section title="Startup">
      <TileGroup>
        <Tile title="Open at Login" detail="Starts in the menu bar when you log in.">
          <Toggle label="Open at Login" checked={!!status?.openAtLogin} disabled={!status}
            onChange={on => run(invoke('set_open_at_login', { enabled: on }), 'Couldn’t change Open at Login')} />
        </Tile>
        <Tile title="Menu bar icon" detail={icon ? 'New notes, meetings and recent notes from the menu bar.'
          : 'Hidden. To come back here, open TabTasker Dictate again from Finder or Spotlight, or right-click the dots.'}>
          <Toggle label="Menu bar icon" checked={icon} onChange={menuBarIcon => void update({ general: { menuBarIcon } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Listening" note={problem}>
      <TileGroup>
        <Tile title="Microphone" detail={status ? `In use: ${status.inputInUse}` : undefined}>
          <Select label="Microphone" value={status?.input ?? ''} options={[{ value: '', label: 'Automatic' }, ...(status?.inputs ?? []).map(input => ({ value: input.id, label: input.name }))]}
            onChange={id => run(invoke('set_input', { id: id || null }), 'Couldn’t change the microphone')} />
        </Tile>
        <Tile title="Pause dictation" detail="The microphone and Whisper stay off until you turn this off again. Your model is kept.">
          <Toggle label="Pause dictation" checked={!!status && !status.enabled} disabled={!status}
            onChange={paused => run(invoke('set_enabled', { enabled: !paused }), 'Couldn’t change dictation')} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Setup">
      <TileGroup>
        <Tile title="Microphone access" detail={mic === 'allowed' ? 'Allowed. It is on only while you hold your key or take a note.'
          : mic === 'denied' ? 'Off. In Privacy & Security › Microphone, turn on TabTasker Dictate.' : 'Not asked yet.'}>
          {mic === 'allowed' ? <State>Allowed</State> : status && <Button onClick={() => ask('microphone')}>{mic === 'denied' ? 'Open System Settings' : 'Allow'}</Button>}
        </Tile>
        <Tile title="Accessibility" detail={status?.accessibility ? 'On. Your key works in every app and your words type there.'
          : 'Off. In Privacy & Security › Accessibility, turn on TabTasker Dictate.'}>
          {status?.accessibility ? <State>On</State> : status && <Button onClick={() => ask('accessibility')}>Open System Settings</Button>}
        </Tile>
        <Tile title="Set up again" detail="Permissions, your key, the speech model and a practice run, one step at a time.">
          <Button onClick={() => { location.hash = 'setup'; }}>Open setup</Button>
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Reset" note={reset}>
      <TileGroup>
        <Tile title={resetting ? 'Reset all settings?' : 'Reset all settings'} detail="Every setting goes back to how it was at first launch. Your notes and the speech model stay.">
          {resetting
            ? <><Button variant="quiet" autoFocus onClick={() => setResetting(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => {
                setResetting(false); setReset(null);
                void resetSettings().then(() => setReset('Settings are back to how they were at first launch.')).catch(() => setReset('Couldn’t reset settings.'));
              }}>Reset</Button></>
            : <Button variant="danger" onClick={() => { setReset(null); setResetting(true); }}>Reset…</Button>}
        </Tile>
      </TileGroup>
    </Section>
  </>;
}

const State = ({ children }: { children: string }) => <span className="state" data-on><Icon name="check" size={14} />{children}</span>;
