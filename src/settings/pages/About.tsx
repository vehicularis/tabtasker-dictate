import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '../../bridge';
import type { PageProps } from '../../store';
import { Button, Icon, Section, Tile, TileGroup, type IconName } from '../../ui';
import icon from '../../../src-tauri/icons/128x128@2x.png';
import licence from '../../../LICENSE?raw';
import notices from '../../../THIRD_PARTY_NOTICES.txt?raw';

// A promise with its icon in front, as macOS lists privacy.
const Pledge = ({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) => <div className="ui-tile pledge">
  <span className="pledge-icon"><Icon name={icon} size={18} /></span>
  <div className="what"><span className="title">{title}</span><span className="detail">{children}</span></div>
</div>;

export function About(_: PageProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => { void invoke<string>('plugin:app|version').then(setVersion).catch(() => {}); }, []);
  return <>
    <header className="about">
      <img src={icon} width="112" height="112" alt="" draggable={false} />
      <h1>TabTasker Dictate</h1>
      <p className="version">{version ? `Version ${version}` : ' '}</p>
      <p>Talk instead of typing, on your Mac.</p>
    </header>
    <Section title="Privacy">
      <TileGroup label="Privacy">
        <Pledge icon="shield" title="Your voice stays on this Mac">Whisper transcribes it here. Audio is never uploaded or shared, and isn’t kept once it’s transcribed.</Pledge>
        <Pledge icon="claude" title="Claude only if you connect it">It gets text, never audio, and only for what you ask of it. Your key stays in the Keychain.</Pledge>
        <Pledge icon="folder" title="Your words are yours">Notes, meetings and history are kept on this Mac. Agents see only what you share on the Agents page.</Pledge>
        <Pledge icon="check" title="No account and no analytics">Nothing to sign in to, and nothing about how you use it is sent anywhere.</Pledge>
      </TileGroup>
    </Section>
    <Section title="Licence">
      <TileGroup label="Licence">
        <Tile title="Apache License 2.0" detail="TabTasker Dictate is open source.">
          <Button small aria-expanded={reading} onClick={() => setReading(!reading)}>{reading ? 'Hide licence' : 'Read licence'}</Button>
        </Tile>
        {reading && <div className="ui-tile stack"><pre className="notices" tabIndex={0} aria-label="Apache License 2.0">{licence.replace(/^\n+/, '').trimEnd()}</pre></div>}
      </TileGroup>
    </Section>
    <Section title="Third-party notices" note="The speech model and the libraries inside TabTasker Dictate, with their licences.">
      <TileGroup label="Third-party notices">
        <div className="ui-tile stack"><pre className="notices" tabIndex={0} aria-label="Third-party notices">{notices.trimEnd()}</pre></div>
      </TileGroup>
    </Section>
    <p className="about-foot">© 2026 Vehicularis Limited</p>
  </>;
}
