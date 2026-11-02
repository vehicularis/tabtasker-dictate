import { useState } from 'react';
import { KEY_NAMES } from '../../overlay/Dock';
import { GearIcon } from '../../overlay/icons';
import type { Edge, PageProps, Patch, Settings, Size, Theme } from '../../store';
import { Icon, PageHeader, Section, Segmented, Tile, TileGroup, Toggle } from '../../ui';

const THEMES: { value: Theme; label: string }[] = [{ value: 'system', label: 'Automatic' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
const EDGES: { value: Edge; label: string }[] = [{ value: 'left', label: 'Left' }, { value: 'bottom', label: 'Bottom' }, { value: 'right', label: 'Right' }];
const SIZES: { value: Size; label: string }[] = [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }];
type Moment = 'idle' | 'hover' | 'talking';
const MOMENTS: { value: Moment; label: string }[] = [{ value: 'idle', label: 'Idle' }, { value: 'hover', label: 'Pointing' }, { value: 'talking', label: 'Talking' }];

export function Appearance({ settings, update }: PageProps) {
  const look = settings.appearance;
  const key = KEY_NAMES[settings.shortcuts.dictate];
  // The preview shows the moment a change is about: the hint while pointing, nothing while idle and hidden.
  const [moment, setMoment] = useState<Moment>('idle');
  const change = (patch: Patch['appearance'], show?: Moment) => { if (show) setMoment(show); void update({ appearance: patch }); };
  return <>
    <PageHeader icon="appearance" title="Appearance">How TabTasker Dictate looks on your screen.</PageHeader>
    <Preview look={look} keyName={key} moment={moment} onMoment={setMoment} />
    <Section>
      <TileGroup>
        <Tile title="Theme" detail="For the dots and this window. Automatic follows your Mac.">
          <Segmented label="Theme" value={look.theme} options={THEMES} onChange={theme => change({ theme })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="The dots" note="You can also drag the dots to another edge.">
      <TileGroup>
        <Tile title="Edge" detail="Where the dots sit on your screen.">
          <Segmented label="Edge" value={look.edge} options={EDGES} onChange={edge => change({ edge })} />
        </Tile>
        <Tile title="Size" detail="The dots, their buttons and the orb.">
          <Segmented label="Size" value={look.size} options={SIZES} onChange={size => change({ size })} />
        </Tile>
        <Tile title="When idle" detail={`Hidden shows nothing until you hold ${key}.`}>
          <Segmented label="When idle" value={look.idle} options={[{ value: 'dots', label: 'Dots' }, { value: 'hidden', label: 'Hidden' }]} onChange={idle => change({ idle }, 'idle')} />
        </Tile>
        <Tile title="Hint" detail={`Shows “${key} hold to type” beside the dots when you point at them.`}>
          <Toggle label="Hint" checked={look.hint} onChange={hint => change({ hint }, 'hover')} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}

// A small screen with the dots on it, drawn from the settings as they are now.
function Preview({ look, keyName, moment, onMoment }: { look: Settings['appearance']; keyName: string; moment: Moment; onMoment: (moment: Moment) => void }) {
  const hidden = look.idle === 'hidden' && moment === 'idle';
  const said = { idle: hidden ? `Nothing shows until you hold ${keyName}` : 'The dots wait at the edge', hover: look.hint ? 'Pointing opens the buttons and the hint' : 'Pointing opens the buttons', talking: `While you hold ${keyName}, the orb listens` }[moment];
  return <figure className="look" data-edge={look.edge} data-size={look.size} data-moment={moment} data-quiet={look.idle === 'hidden' || undefined}>
    <div className="look-screen" role="img" aria-label={`The dots at the ${look.edge} edge, ${look.size}. ${said}.`}>
      <span className="look-menubar"><svg viewBox="0 0 36 36" aria-hidden="true"><path d="M2 14a2 2 0 0 1 4 0v8a2 2 0 0 1-4 0zM9 10a2 2 0 0 1 4 0v16a2 2 0 0 1-4 0zM23 10a2 2 0 0 1 4 0v16a2 2 0 0 1-4 0zM30 14a2 2 0 0 1 4 0v8a2 2 0 0 1-4 0zM17 4a1 1 0 0 1 2 0v28a1 1 0 0 1-2 0zM15 4h6v2h-6zM15 30h6v2h-6z" /></svg></span>
      <span className="look-window" aria-hidden="true"><i /><i /><i /></span>
      <span className="look-dock" aria-hidden="true">
        <span className="look-dots"><i /><i /><i /></span>
        <span className="look-pill"><i><Icon name="note" size={17} /></i><i><GearIcon /></i></span>
        <span className="look-orb"><i /><i /><i /><i /><i /></span>
        {look.hint && <span className="look-hint"><kbd>{keyName}</kbd>hold to type</span>}
      </span>
    </div>
    <figcaption>
      <span>{said}</span>
      <Segmented label="Preview" value={moment} options={MOMENTS} onChange={onMoment} />
    </figcaption>
  </figure>;
}
