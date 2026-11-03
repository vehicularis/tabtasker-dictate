import { ICON_GLYPHS } from '../../overlay/glyphs';
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
  <span className="pledge-icon">{(() => { const Glyph = ICON_GLYPHS[icon]; return Glyph ? <Glyph size={26} /> : <Icon name={icon} size={18} />; })()}</span>
  <div className="what"><span className="title">{title}</span><span className="detail">{children}</span></div>
</div>;

const BUSINESS = 'https://business.tabtasker.com';
const site = (url: string) => () => { void invoke('open_site', { url }).catch(() => {}); };

/// The privacy policy and the terms, in plain words, each true of this app alone; the long form for
/// TabTasker's services is on the Business site.
const PRIVACY: [string, string][] = [
  ['Who we are', 'Vehicularis Limited, trading as TabTasker: company 15804590 in England and Wales, registered with the ICO as ZB804882. Write to info@vehicularis.com.'],
  ['What Dictate collects', 'Nothing. There is no account, no analytics and no crash reports; the app never phones home. The one download is the speech model from GitHub on first run, which shows GitHub your IP address as any download does.'],
  ['Your voice', 'It is turned into text on your Mac by Whisper, and the audio is discarded once that is done. A meeting’s recording is kept only until its transcript is saved, or until you discard a leftover.'],
  ['What you write', 'Notes, meetings, stickies, history and settings are files on your Mac, in folders you choose. Dictate never uploads them.'],
  ['AI, only if you connect it', 'With Claude, the text you turn it on for goes to Anthropic under Anthropic’s terms and privacy policy: a dictation to polish, a note’s words for its title, a meeting’s transcript for its summary, a spoken command. Your key stays in the macOS Keychain. With a local model, nothing leaves your Mac.'],
  ['Permissions', 'The microphone, to hear you. Accessibility, to type where your cursor is and to see the Dock. Screen and audio recording, only for a meeting’s other side. Each is used for that alone.'],
  ['Your rights', 'Everything is on your Mac, so deleting it is deleting the files; there is nothing to ask us for. Questions or complaints go to info@vehicularis.com, or to the UK Information Commissioner’s Office.'],
];
const TERMS: [string, string][] = [
  ['Open source', 'TabTasker Dictate is licensed under the Apache License 2.0: use it, copy it, change it and share it under that licence.'],
  ['As it is', 'It comes without warranty, and to the extent the law allows, Vehicularis is not liable for loss from using it. The licence says the same, at length.'],
  ['Your recordings', 'You are responsible for what you record and transcribe. Where the law requires it, get the consent of the people in a meeting before you record it.'],
  ['Services you connect', 'Anthropic’s Claude, or a model running on your Mac, comes with its own terms; Dictate only carries your text to it.'],
  ['The marks', 'TabTasker, Dictate and the otter are Vehicularis’s marks. The licence covers the code, not them.'],
  ['The law', 'These terms are governed by the law of England and Wales.'],
];
const Legal = ({ rows }: { rows: [string, string][] }) => <dl className="legal">{rows.map(([term, words]) => <div key={term}><dt>{term}</dt><dd>{words}</dd></div>)}</dl>;

export function About(_: PageProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => { void invoke<string>('plugin:app|version').then(setVersion).catch(() => {}); }, []);
  return <>
    <header className="about">
      <img src={icon} width="112" height="112" alt="" draggable={false} />
      <h1>TabTasker Dictate</h1>
      <p className="version">{version ? `Version ${version}` : ' '}</p>
      <p>Talk instead of typing, in any app.</p>
    </header>
    <Section title="Privacy">
      <TileGroup label="Privacy">
        <Pledge icon="mic" title="Your voice stays on your Mac">It’s turned into text right there, and the audio is deleted once that’s done.</Pledge>
        <Pledge icon="claude" title="AI only if you connect it">It only ever sees text, and only for the things you turn it on for. Your Claude key is kept in the Keychain.</Pledge>
        <Pledge icon="folder" title="Notes stay on your Mac">They’re plain files in a folder you choose. Claude Code and Claude Desktop can only read what you allow in Agents.</Pledge>
        <Pledge icon="shield" title="No account, no analytics">There’s nothing to sign up for, and nothing about how you use Dictate is sent anywhere.</Pledge>
      </TileGroup>
    </Section>
    <Section title="Privacy policy" note="In plain words, and all of it. The long form for TabTasker’s services is on the Business site.">
      <TileGroup label="Privacy policy">
        <div className="ui-tile stack"><Legal rows={PRIVACY} /></div>
        <Tile title="The full policy" detail="For every TabTasker service, with the legal detail."><Button small icon="external" onClick={site(`${BUSINESS}/privacy`)}>business.tabtasker.com/privacy</Button></Tile>
      </TileGroup>
    </Section>
    <Section title="Terms" note="What you agree to by using Dictate. Short, because the licence does most of the work.">
      <TileGroup label="Terms">
        <div className="ui-tile stack"><Legal rows={TERMS} /></div>
        <Tile title="The full terms" detail="For every TabTasker service, with the legal detail."><Button small icon="external" onClick={site(`${BUSINESS}/terms`)}>business.tabtasker.com/terms</Button></Tile>
      </TileGroup>
    </Section>
    <Section title="TabTasker Business" note="The team workspace Dictate grew out of; its design and its otter are Business’s.">
      <TileGroup label="TabTasker Business">
        <Tile title="Chat, docs, whiteboards, tasks and meetings for your team" detail="With the same editor, the same voice and the same care. Free to try."><Button small variant="primary" icon="external" onClick={site(BUSINESS)}>Open business.tabtasker.com</Button></Tile>
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
    <Section title="Third-party notices" note="The open-source projects Dictate is built on, with their licences.">
      <TileGroup label="Third-party notices">
        <div className="ui-tile stack"><Notices label="Third-party notices" text={NOTICES} /></div>
      </TileGroup>
    </Section>
    <p className="about-foot">© 2026 Vehicularis Limited</p>
  </>;
}
