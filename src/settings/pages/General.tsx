import { useState } from 'react';
import { invoke } from '../../bridge';
import { resetSettings, useStatus, type PageProps } from '../../store';
import { Button, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';

export function General(_: PageProps) {
  const [status, refresh] = useStatus();
  const [resetting, setResetting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (work: Promise<unknown>, failed: string) => { setProblem(null); void work.then(refresh).catch(() => setProblem(failed)); };
  return <>
    <PageHeader icon="general" title="General">How TabTasker Dictate starts and listens.</PageHeader>
    <Section title="Startup">
      <TileGroup>
        <Tile title="Open at Login" detail="Starts in the menu bar when you log in.">
          <Toggle label="Open at Login" checked={!!status?.openAtLogin} disabled={!status}
            onChange={on => run(invoke('set_open_at_login', { enabled: on }), 'Couldn’t change Open at Login')} />
        </Tile>
        <Tile title="Set up again" detail="Permissions, your key and the speech model, one step at a time.">
          <Button onClick={() => { location.hash = 'setup'; }}>Open setup</Button>
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
    <Section title="Reset">
      <TileGroup>
        <Tile title={resetting ? 'Reset all settings?' : 'Reset all settings'} detail="Every setting goes back to how it was at first launch. Your notes and the speech model stay.">
          {resetting
            ? <><Button variant="quiet" onClick={() => setResetting(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => { setResetting(false); run(resetSettings(), 'Couldn’t reset settings'); }}>Reset</Button></>
            : <Button variant="danger" onClick={() => setResetting(true)}>Reset…</Button>}
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
