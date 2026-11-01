import { useState } from 'react';
import type { PageProps, Style } from '../../store';
import { Button, PageHeader, Section, Select, Tile, TileGroup, Toggle } from '../../ui';

const STYLES: { value: Style; label: string }[] = [
  { value: 'default', label: 'Default' }, { value: 'casual', label: 'Casual' }, { value: 'formal', label: 'Formal' }, { value: 'code', label: 'Code' }, { value: 'raw', label: 'Raw' },
];

export function AppStyles({ settings, update }: PageProps) {
  const apps = settings.apps;
  const [name, setName] = useState('');
  const [bundleId, setBundleId] = useState('');
  const set = (index: number, change: Partial<(typeof apps.styles)[number]>) => update({ apps: { styles: apps.styles.map((app, i) => i === index ? { ...app, ...change } : app) } });
  const add = () => {
    if (!bundleId.trim()) return;
    update({ apps: { styles: [{ bundleId: bundleId.trim(), name: name.trim() || bundleId.trim(), style: 'default', polish: false }, ...apps.styles.filter(app => app.bundleId !== bundleId.trim())] } });
    setName(''); setBundleId('');
  };
  return <>
    <PageHeader icon="apps" title="App styles">How your words are written in each app.</PageHeader>
    <Section title="Everywhere else" note="Casual drops the last full stop; formal adds capitals and a full stop; code turns spoken symbols and casing into code; raw is Whisper as it heard you.">
      <TileGroup>
        <Tile title="Default style">
          <Select label="Default style" value={apps.defaultStyle} options={STYLES} onChange={defaultStyle => update({ apps: { defaultStyle } })} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Apps" note={settings.claude.enabled ? 'Polish asks Claude to tidy your words in that app, within a few seconds; your own words stand if it can’t.' : 'Polish works once Claude is connected.'}>
      <TileGroup>
        <Tile title="Add an app" stack>
          <span className="pair">
            <input className="ui-field wide" aria-label="App name" placeholder="Name" value={name} onChange={event => setName(event.target.value)} />
            <input className="ui-field wide mono" aria-label="Bundle ID" placeholder="com.example.app" value={bundleId} spellCheck={false} onChange={event => setBundleId(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') add(); }} />
            <Button icon="plus" small disabled={!bundleId.trim()} onClick={add}>Add</Button>
          </span>
        </Tile>
        {apps.styles.map((app, index) => <Tile key={app.bundleId} title={app.name} detail={app.bundleId}>
          <Select label={`Style in ${app.name}`} value={app.style} options={STYLES} onChange={style => set(index, { style })} />
          <span className="labelled"><span>Polish</span><Toggle label={`Polish in ${app.name}`} checked={app.polish} onChange={polish => set(index, { polish })} /></span>
          <Button variant="quiet" small icon="trash" aria-label={`Remove ${app.name}`} onClick={() => update({ apps: { styles: apps.styles.filter((_, i) => i !== index) } })} />
        </Tile>)}
      </TileGroup>
    </Section>
  </>;
}
