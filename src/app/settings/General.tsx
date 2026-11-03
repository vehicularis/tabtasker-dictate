import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '../../bridge';
import { ask } from '../../lib/request';
import { resetSettings, useStatus, type PageProps } from '../../store';
import { Button, Icon, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';

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
    <PageHeader icon="general" title="General">How Dictate starts and which microphone it uses.</PageHeader>
    <Section title="Startup">
      <TileGroup>
        <Tile title="Open at login">
          <Toggle label="Open at login" checked={!!status?.openAtLogin} disabled={!status}
            onChange={on => run(invoke('set_open_at_login', { enabled: on }), 'Couldn’t change whether Dictate opens at login.')} />
        </Tile>
        <Tile title="Menu bar icon" detail={icon ? undefined
          : `You can still get back here from Spotlight${settings.appearance.idle === 'dots' ? ' or by right-clicking the dots' : ''}.`}>
          <Toggle label="Menu bar icon" checked={icon} onChange={menuBarIcon => void update({ general: { menuBarIcon } })} />
        </Tile>
        <Tile title="Show in the Dock" detail={settings.general.showInDock ? undefined : 'Dictate only shows in the Dock while its window is open.'}>
          <Toggle label="Show in the Dock" checked={settings.general.showInDock} onChange={showInDock => void update({ general: { showInDock } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Listening" note={problem}>
      <TileGroup>
        <Tile title="Microphone" detail={!status ? undefined : mic === 'allowed' ? `Right now it’s ${status.inputInUse}.` : 'Allow microphone access below first.'}>
          <Select label="Microphone" value={status?.input ?? ''} options={[{ value: '', label: 'Automatic' }, ...(status?.inputs ?? []).map(input => ({ value: input.id, label: input.name }))]}
            onChange={id => run(invoke('set_input', { id: id || null }), 'Couldn’t switch to that microphone.')} />
        </Tile>
        <Tile title="Pause dictation" detail={status && !status.enabled
          ? 'Turn this off to start dictating again.'
          : 'Your microphone stays off while dictation is paused.'}>
          <Toggle label="Pause dictation" checked={!!status && !status.enabled} disabled={!status}
            onChange={paused => run(invoke('set_enabled', { enabled: !paused }), paused ? 'Couldn’t pause dictation.' : 'Couldn’t start dictation again.')} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Setup">
      <TileGroup>
        <Tile title="Microphone access" detail={!status ? undefined : mic === 'allowed' ? undefined
          : mic === 'denied' ? 'Turn this on in System Settings so Dictate can hear you.' : 'Dictate needs this to hear you.'}>
          {mic === 'allowed' ? <State>Allowed</State> : status && <Button onClick={() => ask('microphone')}>{mic === 'denied' ? 'Open System Settings' : 'Allow'}</Button>}
        </Tile>
        <Tile title="Accessibility" detail={!status ? undefined : status.accessibility ? undefined
          : 'Turn this on in System Settings so Dictate can type into other apps.'}>
          {status?.accessibility ? <State>On</State> : status && <Button onClick={() => ask('accessibility')}>Open System Settings</Button>}
        </Tile>
        <Tile title="Set up again" detail="Go through setup from the start.">
          <Button onClick={() => { location.hash = 'setup'; }}>Open setup</Button>
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Reset">
      <TileGroup>
        <Tile title={resetting ? 'Reset all settings?' : 'Reset all settings'} detail="Puts every setting back to its default. Your notes aren’t touched.">
          {resetting
            ? <><Button variant="quiet" autoFocus onClick={() => confirm(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => {
                confirm(false); setReset(null);
                void resetSettings().then(() => setReset('Your settings are back to their defaults.')).catch(() => setReset('Couldn’t reset your settings. Try again.'));
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
