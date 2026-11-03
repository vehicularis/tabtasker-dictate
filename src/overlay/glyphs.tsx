import { useId, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import type { IconName } from '../ui/Icon';
import './glyphs.css';

// The pill's objects, drawn like TabTasker Business's whiteboard tool tiles (apps/web/src/components/
// whiteboard/canvas/toolGlyphs.tsx): small things with one shared light source, fine edges, an enamel
// fill that takes the card colour, and a quiet cast shadow. The note and the sticky are Business's own; the
// rest are drawn here in the same hand.
const INK = 'currentColor';
const PAPER = 'var(--card)';
const ENAMEL = 'var(--wb-glyph-enamel)';
const AMBER = '#E0A33A';
/// The accent the glyphs pick out a detail in: ink, as the app's is (black by day, white by night), never blue.
const ACCENT = 'var(--accent)';

function Glyph({ children, size = 22 }: { children: ReactNode; size?: number }) {
  const id = useId();
  return <svg className="wb-tool-glyph" width={size} height={size} viewBox="0 0 28 28" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    style={{ '--wb-glyph-enamel': `url(#${id})` } as CSSProperties}>
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0.65" y2="1">
        <stop stopColor={`color-mix(in srgb, ${PAPER}, white 24%)`} />
        <stop offset="0.5" stopColor={PAPER} />
        <stop offset="1" stopColor={`color-mix(in srgb, ${PAPER}, ${INK} 14%)`} />
      </linearGradient>
    </defs>
    <g className="wb-glyph-object">{children}</g>
  </svg>;
}

/// A page being written on, with a pencil: a note.
export const NoteGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M6 3.5h9l5 5v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-17a2 2 0 0 1 2-2z" fill={ENAMEL} stroke={INK} strokeOpacity="0.45" strokeWidth="1.1" />
  <path d="M15 3.5V7a1.5 1.5 0 0 0 1.5 1.5H20" stroke={INK} strokeOpacity="0.45" strokeWidth="1.1" />
  <path d="M7.5 12.5h7M7.5 15.5h5M7.5 18.5h3" stroke={INK} strokeOpacity="0.3" strokeWidth="1.1" />
  <path d="M7.5 6h5" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
  <g transform="rotate(38 20 17)">
    <rect x="18.4" y="7.5" width="3.2" height="10.5" rx="1.2" fill={INK} fillOpacity="0.85" />
    <path d="M18.4 18h3.2L20 21.6z" fill={AMBER} stroke={INK} strokeOpacity="0.6" strokeWidth="0.7" />
    <path d="M19.3 8.8v6" stroke="white" strokeOpacity="0.4" strokeWidth="0.7" />
  </g>
</Glyph>;

/// A tray of saved pages, the newest on top: the library.
export const LibraryGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M4 13.5h20v8a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 4 21.5z" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M4 13.5l2.4-6.2A2 2 0 0 1 8.3 6h11.4a2 2 0 0 1 1.9 1.3L24 13.5" stroke={INK} strokeOpacity="0.45" strokeWidth="1.1" />
  <path d="M8.5 6v-1.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1V6" stroke={INK} strokeOpacity="0.3" strokeWidth="0.9" />
  <path d="M4 13.5h5.5l1.5 2.5h6l1.5-2.5H24" fill={ACCENT} fillOpacity="0.85" stroke={INK} strokeOpacity="0.35" strokeWidth="0.8" />
  <path d="M10.5 8.5h7M11.5 11h5" stroke={INK} strokeOpacity="0.35" strokeWidth="1" />
  <path d="M6 15.5h2" stroke="white" strokeOpacity="0.7" strokeWidth="0.8" />
</Glyph>;

/// Two people side by side, the nearer one in enamel, each head just above its shoulders: a meeting.
export const MeetingGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <circle cx="18.5" cy="11" r="3.4" fill={ACCENT} fillOpacity="0.9" stroke={INK} strokeOpacity="0.4" strokeWidth="0.9" />
  <path d="M13.2 22c0-3.6 2.3-6.2 5.3-6.2s5.3 2.6 5.3 6.2a1 1 0 0 1-1 1h-8.6a1 1 0 0 1-1-1z" fill={ACCENT} fillOpacity="0.9" stroke={INK} strokeOpacity="0.4" strokeWidth="0.9" />
  <circle cx="10" cy="10" r="4.2" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M3 23c0-4.6 3-7.8 7-7.8s7 3.2 7 7.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M7.4 7.8a3 3 0 0 1 2.6-1.4M5.4 18.1a5.6 5.6 0 0 1 3.2-2" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
</Glyph>;

/// A text field with words in it and the cursor after them: a note to type into, in the window.
export const WriteGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <rect x="3.5" y="7" width="21" height="14" rx="3.5" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M7.5 14h7" stroke={INK} strokeOpacity="0.4" strokeWidth="1.3" />
  <path d="M18 10.2v7.6M16.6 10.2h2.8M16.6 17.8h2.8" stroke={ACCENT} strokeWidth="1.3" />
  <path d="M6 9h6" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

/// A sticky with its corner turned up, Business's own (toolGlyphs.tsx StickyGlyph), in the stickies' amber.
export const StickyGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M5 4.5h18v15l-4 4H5z" fill={AMBER} stroke={INK} strokeOpacity="0.4" strokeWidth="1" />
  <path d="M5 5h18v4H5z" fill="white" opacity="0.2" />
  <path d="M23 18c-3.5-.5-6 1.5-6 5.5h2l4-4z" fill={INK} opacity="0.16" />
  <path d="M23 18c-2.5 1-4 3-4 5.5v-4a1.5 1.5 0 0 1 1.5-1.5z" fill={ENAMEL} stroke={INK} strokeOpacity="0.35" strokeWidth="0.7" />
  <path d="M7 6h14" stroke="white" strokeOpacity="0.5" />
</Glyph>;

/// A gear with an enamel face: the settings.
export const SettingsGlyph = ({ size }: { size?: number }) => {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const at = (deg: number, r: number) => { const a = (i * 45 + deg) * Math.PI / 180; return `${(14 + r * Math.cos(a)).toFixed(2)} ${(14 + r * Math.sin(a)).toFixed(2)}`; };
    return `${i ? 'L' : 'M'}${at(-13, 8)}L${at(-8, 10.6)}L${at(8, 10.6)}L${at(13, 8)}A8 8 0 0 1 ${at(32, 8)}`;
  }).join('') + 'Z';
  return <Glyph size={size}>
    <path d={teeth} fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
    <circle cx="14" cy="14" r="3.4" fill={ACCENT} stroke={INK} strokeOpacity="0.45" strokeWidth="0.9" />
    <path d="M9.2 9.6a6.4 6.4 0 0 1 4.3-2" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
  </Glyph>;
};

// ---------- the settings pages, in the same hand ----------

/// A switch, on: General.
const SwitchGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <rect x="3.5" y="8.5" width="21" height="11" rx="5.5" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <circle cx="18.6" cy="14" r="3.7" fill={ACCENT} stroke={INK} strokeOpacity="0.4" strokeWidth="0.9" />
  <path d="M6.8 11.6h5.4" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
  <path d="M17.2 12.2a1.9 1.9 0 0 1 1.6-.9" stroke="white" strokeOpacity="0.7" strokeWidth="0.8" />
</Glyph>;

/// A key, the fn key's globe on it: Shortcuts.
const KeyGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <rect x="4" y="4.5" width="20" height="19.5" rx="4" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <rect x="6.3" y="6.5" width="15.4" height="13.5" rx="2.6" fill={PAPER} stroke={INK} strokeOpacity="0.16" strokeWidth="0.8" />
  <circle cx="14" cy="13.2" r="3.6" stroke={ACCENT} strokeWidth="1.1" />
  <ellipse cx="14" cy="13.2" rx="1.5" ry="3.6" stroke={ACCENT} strokeWidth="0.9" />
  <path d="M10.4 13.2h7.2" stroke={ACCENT} strokeWidth="0.9" />
  <path d="M8 8.4h4" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

/// A microphone with its sound going out: Speech.
const MicGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M6.5 12.5a7.5 7.5 0 0 0 15 0" stroke={INK} strokeOpacity="0.45" strokeWidth="1.1" />
  <path d="M14 20v3.5M10.5 24h7" stroke={INK} strokeOpacity="0.45" strokeWidth="1.1" />
  <rect x="10" y="3.5" width="8" height="13.5" rx="4" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M12 8h4M12 10.5h4M12 13h4" stroke={INK} strokeOpacity="0.25" strokeWidth="0.9" />
  <path d="M23.3 6.5a6 6 0 0 1 0 6.5M25.5 4.8a9 9 0 0 1 0 9.9" stroke={ACCENT} strokeWidth="1.2" />
  <path d="M11.7 5.7a2 2 0 0 1 1.7-1" stroke="white" strokeOpacity="0.7" strokeWidth="0.8" />
</Glyph>;

/// Two app windows, the front one's words in its own style: App styles.
const AppsGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <rect x="8.5" y="4" width="15.5" height="12.5" rx="2.5" fill={ENAMEL} stroke={INK} strokeOpacity="0.35" strokeWidth="1" />
  <rect x="4" y="10" width="16" height="14" rx="2.5" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M4 13.6h16" stroke={INK} strokeOpacity="0.25" strokeWidth="0.9" />
  <path d="M6.6 11.8h.01M8.8 11.8h.01M11 11.8h.01" stroke={INK} strokeOpacity="0.45" strokeWidth="1.4" />
  <path d="M7 17.4h8M7 20.2h5" stroke={ACCENT} strokeWidth="1.3" />
  <path d="M11 6.2h5" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

/// A book with a ribbon in it: Vocabulary.
const BookGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M7 4.5h13a2 2 0 0 1 2 2V23a1 1 0 0 1-1 1H8a2.5 2.5 0 0 1-2.5-2.5V6A1.5 1.5 0 0 1 7 4.5z" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M5.5 21.5A2.5 2.5 0 0 1 8 19h14" stroke={INK} strokeOpacity="0.4" strokeWidth="1" />
  <path d="M15.5 4.5v8.2l2-1.5 2 1.5V4.5" fill={ACCENT} fillOpacity="0.9" stroke={INK} strokeOpacity="0.35" strokeWidth="0.8" />
  <path d="M8.5 9h4.5M8.5 11.7h3" stroke={INK} strokeOpacity="0.3" strokeWidth="1" />
  <path d="M8 6.6h5" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

/// A glass orb with the agents' wave in it: Agents.
const AgentsGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <circle cx="14" cy="14" r="10" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M7 14.6c1.4 0 1.8-3.2 3.4-3.2s2 6 3.6 6 2-7 3.6-7 1.9 4.2 3.4 4.2" stroke={ACCENT} strokeWidth="1.4" />
  <path d="M8.6 9a7 7 0 0 1 4.4-2.6" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
</Glyph>;

/// A disc half light, half dark: Appearance.
const AppearanceGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <circle cx="14" cy="14" r="10" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M14 4a10 10 0 0 1 0 20z" fill={INK} fillOpacity="0.72" />
  <circle cx="14" cy="14" r="3.4" fill={ACCENT} stroke={INK} strokeOpacity="0.4" strokeWidth="0.9" />
  <path d="M7.8 9.4a7 7 0 0 1 3.8-3.1" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
</Glyph>;

/// A card of bars, the tallest in blue: History & stats.
const StatsGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <rect x="4" y="4.5" width="20" height="19" rx="3" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M9 19.5v-4M19 19.5v-6.5" stroke={INK} strokeOpacity="0.4" strokeWidth="2.6" />
  <path d="M14 19.5v-9.5" stroke={ACCENT} strokeWidth="2.6" />
  <path d="M7 7h5" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

// ---------- the rest of the app's objects ----------

/// A lifebuoy: Help.
const HelpGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M14 4a10 10 0 1 1 0 20a10 10 0 1 1 0-20zM14 9.6a4.4 4.4 0 1 0 0 8.8a4.4 4.4 0 1 0 0-8.8z" fill={ENAMEL} fillRule="evenodd" stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <circle cx="14" cy="14" r="7.2" stroke={ACCENT} strokeWidth="5.4" strokeDasharray="5.65 5.66" transform="rotate(-23 14 14)" />
  <path d="M8.4 8.9a7.6 7.6 0 0 1 3.8-2.6" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
</Glyph>;

/// A magnifier with a tinted lens: Search.
const SearchGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M17.6 17.6l6 6" stroke={INK} strokeOpacity="0.55" strokeWidth="3" />
  <circle cx="12" cy="12" r="7.6" fill={`color-mix(in srgb, ${ACCENT} 22%, ${PAPER})`} stroke={INK} strokeOpacity="0.5" strokeWidth="1.3" />
  <path d="M8.3 9.7a4.6 4.6 0 0 1 3.3-2.5" stroke="white" strokeOpacity="0.75" strokeWidth="1" />
</Glyph>;

/// A shield with a check on it: what stays on this Mac.
const ShieldGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M14 3.5l8.5 3v6.8c0 5.2-3.6 9-8.5 11.2c-4.9-2.2-8.5-6-8.5-11.2V6.5z" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M10.2 14l2.7 2.7 5-5.2" stroke={ACCENT} strokeWidth="1.7" />
  <path d="M8 8.3l5-1.8" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

/// A folder with its front in blue: the notes folder.
const FolderGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M4 8.5a2 2 0 0 1 2-2h5l2 2.2h9a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M4 12.5h20V21a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill={ACCENT} fillOpacity="0.85" stroke={INK} strokeOpacity="0.35" strokeWidth="0.8" />
  <path d="M6.5 14.6h6" stroke="white" strokeOpacity="0.55" strokeWidth="0.8" />
</Glyph>;

/// A globe: a language, and the globe key.
export const GlobeGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <circle cx="14" cy="14" r="10" fill={`color-mix(in srgb, ${ACCENT} 18%, ${PAPER})`} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <ellipse cx="14" cy="14" rx="4.2" ry="10" stroke={ACCENT} strokeWidth="1" />
  <path d="M4 14h20M5.6 9h16.8M5.6 19h16.8" stroke={ACCENT} strokeOpacity="0.8" strokeWidth="0.9" />
  <path d="M8.4 7.6a8 8 0 0 1 3.6-2.2" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
</Glyph>;

/// The accessibility figure on a disc: Accessibility.
export const AccessGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <circle cx="14" cy="14" r="10" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <circle cx="14" cy="8.6" r="1.7" fill={ACCENT} />
  <path d="M8.5 11.5h11M14 11.5v4.2M14 15.7l-2.6 4.6M14 15.7l2.6 4.6" stroke={ACCENT} strokeWidth="1.5" />
  <path d="M8.4 8.9a7.6 7.6 0 0 1 3.8-2.6" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
</Glyph>;

/// An arrow going down into a tray: the speech model, downloading.
export const DownloadGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <path d="M5 15.5h18v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M14 4v11.2M9.5 10.9l4.5 4.5 4.5-4.5" stroke={ACCENT} strokeWidth="1.8" />
  <path d="M7.5 18h4" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

/// A check on a blue disc: done.
const DoneGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <circle cx="14" cy="14" r="10" fill={ACCENT} stroke={INK} strokeOpacity="0.35" strokeWidth="1" />
  <path d="M9.4 14.3l3.1 3.1 6.2-6.6" stroke="white" strokeWidth="1.9" />
  <path d="M8.5 8.8a7.6 7.6 0 0 1 3.6-2.6" stroke="white" strokeOpacity="0.55" strokeWidth="0.9" />
</Glyph>;

/// A tile with a plus on it: the extras.
export const ExtrasGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <rect x="4.5" y="4.5" width="19" height="19" rx="4.5" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M14 9v10M9 14h10" stroke={ACCENT} strokeWidth="1.8" />
  <path d="M7.5 7.5h5" stroke="white" strokeOpacity="0.6" strokeWidth="0.8" />
</Glyph>;

/// The glyph for an object icon, by its name in the design system's set, wherever the app shows an object
/// rather than a control: page headers, empty states, setup. Controls (plus, close, chevrons, the editor's
/// marks) stay line icons, and Claude's mark stays its own.
export const ICON_GLYPHS: Partial<Record<IconName, ComponentType<{ size?: number }>>> = {
  note: NoteGlyph, meeting: MeetingGlyph, sticky: StickyGlyph, general: SwitchGlyph, keyboard: KeyGlyph, waveform: MicGlyph, mic: MicGlyph,
  apps: AppsGlyph, book: BookGlyph, agents: AgentsGlyph, appearance: AppearanceGlyph, history: StatsGlyph, help: HelpGlyph, search: SearchGlyph,
  shield: ShieldGlyph, folder: FolderGlyph, check: DoneGlyph,
};

/// The settings pages by route, for the Settings column.
export const SETTINGS_GLYPHS: Record<string, ComponentType<{ size?: number }>> = {
  'settings': SwitchGlyph, 'settings/shortcuts': KeyGlyph, 'settings/speech': MicGlyph, 'settings/apps': AppsGlyph, 'settings/vocabulary': BookGlyph,
  'settings/notes': NoteGlyph, 'settings/meetings': MeetingGlyph, 'settings/agents': AgentsGlyph, 'settings/appearance': AppearanceGlyph, 'settings/history': StatsGlyph,
};

/// The window's places drawn as the pill draws them, so the rail and the dots show the same objects.
export const PLACE_GLYPHS: Record<string, ComponentType<{ size?: number }>> = { notes: NoteGlyph, meetings: MeetingGlyph, stickies: StickyGlyph, settings: SettingsGlyph };
