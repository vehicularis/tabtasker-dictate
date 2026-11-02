import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '../../bridge';
import type { PageProps } from '../../store';
import { Button, Icon, Section, Tile, TileGroup, type IconName } from '../../ui';
import icon from '../../../src-tauri/icons/128x128@2x.png';
import licence from '../../../LICENSE?raw';
import notices from '../../../THIRD_PARTY_NOTICES.txt?raw';

type Paragraph = { text: string; indent: number; hang: number; lines: number };

// The files are wrapped at 80 columns and the box is often narrower, so each paragraph's lines are
// joined to wrap to the box. Indents carry the sections, lists and centred headings, so they stay;
// a line that is less indented, or a bare link, starts a new paragraph.
function unwrap(text: string) {
  const out: (Paragraph | null)[] = [];
  for (const line of text.replace(/^\n+/, '').trimEnd().split('\n')) {
    const words = line.trim(), indent = line.length - line.trimStart().length, last = out[out.length - 1];
    if (!words) out.push(null);
    else if (last && indent >= last.indent && !/^https?:\/\//.test(words)) { if (last.lines++ === 1) last.hang = indent; last.text += ` ${words}`; }
    else out.push({ text: words, indent, hang: indent, lines: 1 });
  }
  return out;
}
const LICENCE = unwrap(licence), NOTICES = unwrap(notices);

const Notices = ({ label, text }: { label: string; text: (Paragraph | null)[] }) => <div className="notices" role="document" tabIndex={0} aria-label={label}>
  {text.map((line, i) => line ? <p key={i} style={{ paddingLeft: `${line.hang}ch`, textIndent: `${line.indent - line.hang}ch` }}>{line.text}</p> : <br key={i} />)}
</div>;

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
        <Pledge icon="claude" title="Claude only if you connect it">It gets text, never audio: your commands, plus the dictations it polishes, notes it titles and meetings it summarizes while those are on. Your key stays in the Keychain.</Pledge>
        <Pledge icon="folder" title="Your words are yours">Notes, meetings and history are kept on this Mac. Agents see only what you share on the Agents page.</Pledge>
        <Pledge icon="check" title="No account and no analytics">Nothing to sign in to, and nothing about how you use it is sent anywhere.</Pledge>
      </TileGroup>
    </Section>
    <Section title="Made with">
      <TileGroup label="Made with">
        <Pledge icon="claudeCode" title="Claude Code">Written and polished with Claude Code, by Anthropic. The Claude page connects it to your dictation, with your own key or the Claude Code on this Mac.</Pledge>
        <Pledge icon="waveform" title="Whisper and whisper.cpp">OpenAI’s speech model, run on this Mac by whisper.cpp, with Silero VAD finding where speech ends.</Pledge>
      </TileGroup>
    </Section>
    <Section title="Licence">
      <TileGroup label="Licence">
        <Tile title="Apache License 2.0" detail="TabTasker Dictate is open source.">
          <Button small aria-expanded={reading} onClick={() => setReading(!reading)}>{reading ? 'Hide licence' : 'Read licence'}</Button>
        </Tile>
        {reading && <div className="ui-tile stack"><Notices label="Apache License 2.0" text={LICENCE} /></div>}
      </TileGroup>
    </Section>
    <Section title="Third-party notices" note="The voice models, libraries and fonts inside TabTasker Dictate, with their licences.">
      <TileGroup label="Third-party notices">
        <div className="ui-tile stack"><Notices label="Third-party notices" text={NOTICES} /></div>
      </TileGroup>
    </Section>
    <p className="about-foot">© 2026 Vehicularis Limited</p>
  </>;
}
