import type { Edge, PageProps, Size, Theme } from '../../store';
import { PageHeader, Section, Segmented, Tile, TileGroup, Toggle } from '../../ui';

const THEMES: { value: Theme; label: string }[] = [{ value: 'system', label: 'Automatic' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
const EDGES: { value: Edge; label: string }[] = [{ value: 'left', label: 'Left' }, { value: 'bottom', label: 'Bottom' }, { value: 'right', label: 'Right' }];
const SIZES: { value: Size; label: string }[] = [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }];

export function Appearance({ settings, update }: PageProps) {
  const look = settings.appearance;
  return <>
    <PageHeader icon="appearance" title="Appearance">How TabTasker Dictate looks on your screen.</PageHeader>
    <Section title="Theme">
      <TileGroup>
        <Tile title="Theme" detail="Automatic follows your Mac.">
          <Segmented label="Theme" value={look.theme} options={THEMES} onChange={theme => update({ appearance: { theme } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="The dots" note="You can also drag the dots to another edge.">
      <TileGroup>
        <Tile title="Edge" detail="Where the dots sit on your screen.">
          <Segmented label="Edge" value={look.edge} options={EDGES} onChange={edge => update({ appearance: { edge } })} />
        </Tile>
        <Tile title="Size" detail="The dots and the orb.">
          <Segmented label="Size" value={look.size} options={SIZES} onChange={size => update({ appearance: { size } })} />
        </Tile>
        <Tile title="When idle" detail="Hidden shows nothing until you hold the key.">
          <Segmented label="When idle" value={look.idle} options={[{ value: 'dots', label: 'Dots' }, { value: 'hidden', label: 'Hidden' }]} onChange={idle => update({ appearance: { idle } })} />
        </Tile>
        <Tile title="Hint" detail="“fn hold to type” beside the dots when you point at them.">
          <Toggle label="Hint" checked={look.hint} onChange={hint => update({ appearance: { hint } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
