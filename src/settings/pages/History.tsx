import type { Keep, PageProps } from '../../store';
import { PageHeader, Section, Select, Tile, TileGroup } from '../../ui';

const KEEP: { value: Keep; label: string }[] = [
  { value: 'off', label: 'Don’t keep' }, { value: 'day', label: 'For a day' }, { value: 'week', label: 'For a week' }, { value: 'month', label: 'For a month' }, { value: 'forever', label: 'Forever' },
];

export function History({ settings, update }: PageProps) {
  return <>
    <PageHeader icon="history" title="History & stats">What you dictated, and how much typing it saved.</PageHeader>
    <Section title="History" note="Word counts and times are always kept for your stats. Everything stays on this Mac.">
      <TileGroup>
        <Tile title="Keep what you said" detail="Older dictations are removed for good.">
          <Select label="Keep what you said" value={settings.history.keep} options={KEEP} onChange={keep => update({ history: { keep } })} />
        </Tile>
      </TileGroup>
    </Section>
  </>;
}
