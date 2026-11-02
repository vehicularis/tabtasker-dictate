import { useId, type CSSProperties, type ReactNode } from 'react';

// The pill's objects, drawn like TabTasker Business's whiteboard tool tiles (apps/web/src/components/
// whiteboard/canvas/toolGlyphs.tsx): small things with one shared light source, fine edges, an enamel
// fill that takes the card colour, and a quiet cast shadow. The note is Business's own; the library and
// the settings are drawn here in the same hand.
const INK = 'currentColor';
const PAPER = 'var(--card)';
const ENAMEL = 'var(--wb-glyph-enamel)';
const AMBER = '#E0A33A';
const BLUE = '#4A8CD2';

export function Glyph({ children, size = 22 }: { children: ReactNode; size?: number }) {
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
  <path d="M4 13.5h5.5l1.5 2.5h6l1.5-2.5H24" fill={BLUE} fillOpacity="0.85" stroke={INK} strokeOpacity="0.35" strokeWidth="0.8" />
  <path d="M10.5 8.5h7M11.5 11h5" stroke={INK} strokeOpacity="0.35" strokeWidth="1" />
  <path d="M6 15.5h2" stroke="white" strokeOpacity="0.7" strokeWidth="0.8" />
</Glyph>;

/// Two people side by side, the nearer one in enamel: a meeting.
export const MeetingGlyph = ({ size }: { size?: number }) => <Glyph size={size}>
  <circle cx="18.5" cy="9.5" r="3.4" fill={BLUE} fillOpacity="0.9" stroke={INK} strokeOpacity="0.4" strokeWidth="0.9" />
  <path d="M13.2 23.5c0-3.6 2.3-6.2 5.3-6.2s5.3 2.6 5.3 6.2a1 1 0 0 1-1 1h-8.6a1 1 0 0 1-1-1z" fill={BLUE} fillOpacity="0.9" stroke={INK} strokeOpacity="0.4" strokeWidth="0.9" />
  <circle cx="10" cy="8.5" r="4.2" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M3 24.5c0-4.6 3-7.8 7-7.8s7 3.2 7 7.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
  <path d="M7.4 6.3a3 3 0 0 1 2.6-1.4M5.4 19.6a5.6 5.6 0 0 1 3.2-2" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
</Glyph>;

/// A gear with an enamel face: the settings.
export const SettingsGlyph = ({ size }: { size?: number }) => {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const at = (deg: number, r: number) => { const a = (i * 45 + deg) * Math.PI / 180; return `${(14 + r * Math.cos(a)).toFixed(2)} ${(14 + r * Math.sin(a)).toFixed(2)}`; };
    return `${i ? 'L' : 'M'}${at(-13, 8)}L${at(-8, 10.6)}L${at(8, 10.6)}L${at(13, 8)}A8 8 0 0 1 ${at(32, 8)}`;
  }).join('') + 'Z';
  return <Glyph size={size}>
    <path d={teeth} fill={ENAMEL} stroke={INK} strokeOpacity="0.5" strokeWidth="1.1" />
    <circle cx="14" cy="14" r="3.4" fill={BLUE} stroke={INK} strokeOpacity="0.45" strokeWidth="0.9" />
    <path d="M9.2 9.6a6.4 6.4 0 0 1 4.3-2" stroke="white" strokeOpacity="0.7" strokeWidth="0.9" />
  </Glyph>;
};
