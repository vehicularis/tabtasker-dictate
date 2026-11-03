import { ICON_GLYPHS } from '../../overlay/glyphs';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { invoke } from '../../bridge';
import type { PageProps } from '../../store';
import { Button, Icon, Section, Tile, TileGroup, type IconName } from '../../ui';
import { BusinessMark, otterBars } from '../../overlay/icons';
import otters from '../assets/otters-talking.webp';
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
/// Apple's icon tile has continuous corners: the curve eases out of each straight edge over about 1.53 radii
/// (design/icon.swift draws the same points). In radii from the corner, along the edge first and then into it.
const CORNER: [number, number][] = [[1.52866483, 0], [1.08849323, 0], [0.86840689, 0], [0.66993427, 0.065496], [0.63149399, 0.074911], [0.37282392, 0.16905899], [0.16906013, 0.37282401], [0.07491176, 0.63149399], [0, 0.86840701], [0, 1.08849299], [0, 1.52866483]];
const squircle = (size: number, r: number) => {
  const corners: [number, number, number, number, boolean][] = [[size, size, -1, -1, false], [size, 0, -1, 1, true], [0, 0, 1, 1, false], [0, size, 1, -1, true]];
  return corners.map(([cx, cy, sx, sy, swap], i) => {
    const p = CORNER.map(([a, b]) => swap ? [cx + sx * b * r, cy + sy * a * r] : [cx + sx * a * r, cy + sy * b * r]).map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`);
    return `${i ? 'L' : 'M'}${p[0]}C${p[1]} ${p[2]} ${p[3]}L${p[4]}C${p[5]} ${p[6]} ${p[7]}C${p[8]} ${p[9]} ${p[10]}`;
  }).join('') + 'Z';
};
const TILE = squircle(64, 64 * 0.2237);
const BARS = otterBars(2, 1.3).sort((a, b) => a.x - b.x); // fourteen, left to right, as the app icon has them

/// The app icon, drawn rather than pictured, so that under the pointer the otter does what it is: its bars
/// rise and fall in a wave from left to right, the sound of a voice, and settle again when the pointer leaves.
const AppIcon = ({ size = 112 }: { size?: number }) => <svg className="about-icon" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="about-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3c3d41" /><stop offset="1" stopColor="#18181b" /></linearGradient>
    <clipPath id="about-clip"><path d={TILE} /></clipPath>
  </defs>
  <path d={TILE} fill="url(#about-tile)" />
  <g clipPath="url(#about-clip)">
    <g transform="translate(32 47) scale(1.3)" fill="#ffffff">
      {BARS.map((bar, i) => <rect key={i} className="about-bar" x={bar.x} y={bar.y} width={1.3} height={bar.h} rx=".65" style={{ animationDelay: `${i * 70}ms` }} />)}
    </g>
  </g>
</svg>;

/// The Highlands as an ink wash, in the page's own tones: a sky that is the page, a sun's warmth low in it, three
/// ridges receding into mist, a loch taking the sky, a moor in front, every wash the ink mixed a little deeper into
/// the canvas, so by night it is moonlit grey on grey and by day grey on white. Each wash is a flat shape whose
/// edge a little turbulence makes wobble as a wet brush does.
const Highlands = () => {
  const id = useId();
  const tone = (mix: number) => `color-mix(in srgb, var(--ink) ${mix}%, var(--shell-canvas))`;
  const wash = (d: string, mix: number) => <path d={d} fill={tone(mix)} filter={`url(#${id}-edge)`} />;
  return <svg className="about-sky" viewBox="0 0 1200 360" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-air`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--shell-canvas)" /><stop offset=".62" stopColor={tone(5)} /><stop offset="1" stopColor={tone(3)} /></linearGradient>
      <linearGradient id={`${id}-loch`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={tone(11)} /><stop offset="1" stopColor={tone(6)} /></linearGradient>
      <filter id={`${id}-edge`} x="-5%" y="-10%" width="110%" height="120%"><feTurbulence type="fractalNoise" baseFrequency=".012 .02" numOctaves="3" seed="7" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="12" xChannelSelector="R" yChannelSelector="G" /></filter>
      <filter id={`${id}-soft`} x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="16" /></filter>
    </defs>
    <rect width="1200" height="360" fill={`url(#${id}-air)`} />
    <circle cx="930" cy="84" r="54" fill="color-mix(in srgb, #e0a23c 42%, var(--shell-canvas))" opacity=".55" filter={`url(#${id}-soft)`} />
    {wash('M0 152 C110 114 220 96 340 130 C440 158 500 92 620 106 C720 118 790 70 900 98 C1000 120 1090 94 1200 122 L1200 360 L0 360 Z', 10)}
    <ellipse cx="620" cy="190" rx="720" ry="22" fill="var(--shell-canvas)" opacity=".5" filter={`url(#${id}-soft)`} />
    {wash('M0 206 C90 180 180 150 300 176 C400 198 470 160 560 170 C660 182 740 140 860 164 C960 184 1060 150 1200 182 L1200 360 L0 360 Z', 17)}
    <rect x="0" y="238" width="1200" height="56" fill={`url(#${id}-loch)`} />
    <path d="M180 262 C300 258 420 266 520 262 M640 274 C760 270 900 276 1040 270" stroke="var(--shell-canvas)" strokeOpacity=".5" strokeWidth="2" strokeLinecap="round" fill="none" />
    {wash('M0 252 C140 212 260 220 420 246 C470 254 520 268 560 292 L0 292 Z', 25)}
    {wash('M640 290 C700 262 840 224 980 216 C1060 212 1130 226 1200 240 L1200 292 L640 292 Z', 23)}
    {wash('M0 302 C200 282 380 298 600 288 C800 280 1000 300 1200 290 L1200 360 L0 360 Z', 36)}
  </svg>;
};

const Legal = ({ rows }: { rows: [string, string][] }) => <dl className="legal">{rows.map(([term, words]) => <div key={term}><dt>{term}</dt><dd>{words}</dd></div>)}</dl>;

export function About(_: PageProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => { void invoke<string>('plugin:app|version').then(setVersion).catch(() => {}); }, []);
  return <>
    <header className="about">
      <AppIcon />
      <h1>TabTasker Dictate</h1>
      <p className="version">{version ? `Version ${version}` : ' '}</p>
      <p>Talk instead of typing, in any app.</p>
    </header>
    <Section title="Privacy">
      <TileGroup label="Privacy">
        <Pledge icon="mic" title="Your voice stays on your Mac">It’s turned into text right there, and the audio is deleted once that’s done.</Pledge>
        <Pledge icon="agents" title="Agents only if you connect them">They only ever see text, and only for the things you turn them on for. Your Claude key is kept in the Keychain.</Pledge>
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
    <Section title="TabTasker Business" icon={<BusinessMark size={18} />} note="The team workspace Dictate grew out of; its design and its otter are Business’s.">
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
    <footer className="about-end">
      <Highlands />
      <img className="about-otters" src={otters} alt="" width={1448} height={1086} draggable={false} />
      <div className="about-end-words">
        <p className="about-lockup"><BusinessMark size={22} /><span>TabTasker</span></p>
        <p className="about-end-line">Dictate is made by Vehicularis, the team behind TabTasker Business.</p>
        <nav className="about-links" aria-label="More from TabTasker">
          <button type="button" className="link" onClick={site(BUSINESS)}>TabTasker Business</button>
          <button type="button" className="link" onClick={site(`${BUSINESS}/privacy`)}>Privacy</button>
          <button type="button" className="link" onClick={site(`${BUSINESS}/terms`)}>Terms</button>
          <button type="button" className="link" onClick={site('https://github.com/vehicularis/tabtasker-dictate')}>Source</button>
        </nav>
        <p className="about-foot">© 2026 Vehicularis Limited</p>
      </div>
    </footer>
  </>;
}
