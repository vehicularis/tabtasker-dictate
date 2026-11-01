import { useEffect, useState } from 'react';
import { invoke } from '../../bridge';
import type { PageProps } from '../../store';
import { Button, Icon, Section, Tile, TileGroup } from '../../ui';
import notices from '../../../THIRD_PARTY_NOTICES.txt?raw';

export function About(_: PageProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { void invoke<string>('plugin:app|version').then(setVersion).catch(() => {}); }, []);
  return <>
    <header className="about">
      <svg width="72" height="72" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="1" y="1" width="26" height="26" rx="7" fill="#000" />
        {[[7, 5.6], [10.4, 9.6], [17.6, 9.6], [21, 5.6]].map(([x, h]) => <rect key={x} x={x - 1} y={14 - h / 2} width="2" height={h} rx="1" fill="#fff" />)}
        <path d="M14 7v14M12.6 7h2.8M12.6 21h2.8" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <h1>TabTasker Dictate</h1>
      <p>{version ? `Version ${version}` : ' '}</p>
    </header>
    <Section title="Privacy">
      <TileGroup>
        <Tile title="Your voice stays on this Mac" detail="Whisper transcribes on this Mac. Audio is never uploaded, stored or shared.">
          <Icon name="shield" size={18} />
        </Tile>
        <Tile title="Claude is your choice" detail="Only when you connect it, and only text: what you dictated, never the audio.">
          <Icon name="claude" size={18} />
        </Tile>
        <Tile title="No account" detail="Nothing to sign in to, and no analytics.">
          <Icon name="check" size={18} />
        </Tile>
      </TileGroup>
    </Section>
    <Section title="Licence" note="© 2026 Vehicularis Limited">
      <TileGroup>
        <Tile title="Apache License 2.0" detail="TabTasker Dictate is open source." />
        <Tile title="Third-party notices" detail="The models and libraries it uses, with their licences.">
          <Button small icon={open ? 'chevronDown' : 'chevronRight'} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Button>
        </Tile>
        {open && <div className="ui-tile stack"><pre className="notices" tabIndex={0}>{notices}</pre></div>}
      </TileGroup>
    </Section>
  </>;
}
