import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '../../bridge';
import { resetSettings, useStatus, type PageProps } from '../../store';
import { Button, Icon, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';

const ask = (kind: string) => void invoke('request', { kind }).catch(() => {});

export function General({ settings, update }: PageProps) {
  const [status, refresh] = useStatus();
  const [resetting, setResetting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reset, setReset] = useState<string | null>(null);
  // Leaving the confirm swaps its buttons for Reset…, which takes the focus back.
  const resetId = useId(), refocus = useRef(false);
  useEffect(() => { if (!resetting && refocus.current) { refocus.current = false; document.getElementById(resetId)?.focus(); } }, [resetting, resetId]);
  const confirm = (open: boolean) => { refocus.current = !open; setResetting(open); };
  const run = (work: Promise<unknown>, failed: string) => { setProblem(null); void work.then(refresh).catch(() => setProblem(failed)); };
  const icon = settings.general.menuBarIcon;
  const mic = status?.microphone;
  return <>
    <PageHeader icon="general" title="General">How TabTasker Dictate starts, and which microphone it listens with.</PageHeader>
    <Section title="Startup">
      <TileGroup>
        <Tile title="Open at Login" detail="Starts in the menu bar when you log in.">
          <Toggle label="Open at Login" checked={!!status?.openAtLogin} disabled={!status}
            onChange={on => run(invoke('set_open_at_login', { enabled: on }), 'Couldn’t change Open at Login')} />
        </Tile>
        <Tile title="Menu bar icon" detail={icon ? 'New notes, meetings and recent notes from the menu bar.'
          : `Hidden. To come back here, open TabTasker Dictate again from Finder or Spotlight${settings.appearance.idle === 'dots' ? ', or right-click the dots' : ''}.`}>
          <Toggle label="Menu bar icon" checked={icon} onChange={menuBarIcon => void update({ general: { menuBarIcon } })} />
        </Tile>
        <Tile title="Show in the Dock" detail={settings.general.showInDock ? 'Always in the Dock; clicking the icon opens TabTasker Dictate.' : 'In the Dock only while the window is open.'}>
          <Toggle label="Show in the Dock" checked={settings.general.showInDock} onChange={showInDock => void update({ general: { showInDock } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Listening" note={problem}>
      <TileGroup>
        <Tile title="Microphone" detail={!status ? undefined : mic === 'allowed' ? `In use: ${status.inputInUse}` : 'Allow microphone access under Setup first.'}>
          <Select label="Microphone" value={status?.input ?? ''} options={[{ value: '', label: 'Automatic' }, ...(status?.inputs ?? []).map(input => ({ value: input.id, label: input.name }))]}
            onChange={id => run(invoke('set_input', { id: id || null }), 'Couldn’t change the microphone')} />
        </Tile>
        <Tile title="Pause dictation" detail={status && !status.enabled
          ? 'Dictation is off. Turn this off to start it; the speech model downloads first if it isn’t on this Mac.'
          : 'The microphone and Whisper stay off until you turn this off again. Your model is kept.'}>
          <Toggle label="Pause dictation" checked={!!status && !status.enabled} disabled={!status}
            onChange={paused => run(invoke('set_enabled', { enabled: !paused }), 'Couldn’t change dictation')} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Setup">
      <TileGroup>
        <Tile title="Microphone access" detail={!status ? undefined : mic === 'allowed' ? 'Allowed. It is on only while you hold your key or take a note.'
          : mic === 'denied' ? 'Off. In Privacy & Security › Microphone, turn on TabTasker Dictate.' : 'Not asked yet.'}>
          {mic === 'allowed' ? <State>Allowed</State> : status && <Button onClick={() => ask('microphone')}>{mic === 'denied' ? 'Open System Settings' : 'Allow'}</Button>}
        </Tile>
        <Tile title="Accessibility" detail={!status ? undefined : status.accessibility ? 'On. Your key works in every app and your words type there.'
          : 'Off. In Privacy & Security › Accessibility, turn on TabTasker Dictate.'}>
          {status?.accessibility ? <State>On</State> : status && <Button onClick={() => ask('accessibility')}>Open System Settings</Button>}
        </Tile>
        <Tile title="Set up again" detail="Permissions, your key, the speech model and a practice run, one step at a time.">
          <Button onClick={() => { location.hash = 'setup'; }}>Open setup</Button>
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Reset">
      <TileGroup>
        <Tile title={resetting ? 'Reset all settings?' : 'Reset all settings'} detail="Every setting goes back to how it was at first launch. Your notes, the speech model and your Claude key stay.">
          {resetting
            ? <><Button variant="quiet" autoFocus onClick={() => confirm(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => {
                confirm(false); setReset(null);
                void resetSettings().then(() => setReset('Settings are back to how they were at first launch.')).catch(() => setReset('Couldn’t reset settings.'));
              }}>Reset</Button></>
            : <Button id={resetId} variant="danger" onClick={() => { setReset(null); confirm(true); }}>Reset…</Button>}
        </Tile>
      </TileGroup>
      {/* Always there, so VoiceOver reads the outcome when it fills in. */}
      <p className="ui-section-note" role="status">{reset}</p>
    </Section>
  </>;
}

const State = ({ children }: { children: string }) => <span className="state" data-on><Icon name="check" size={14} />{children}</span>;
