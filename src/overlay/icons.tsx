import { useId, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';

// The overlay's icons: the same monochrome line set as Settings (a 20 grid, 1.5 stroke, the text colour),
// plus the few only the overlay needs.
const Line = ({ children }: { children: ReactNode }) => <svg className="line" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;

// Eight teeth around a ring, each narrower at its tip.
const GEAR = Array.from({ length: 8 }, (_, i) => {
  const at = (deg: number, r: number) => { const a = (i * 45 + deg) * Math.PI / 180; return `${(10 + r * Math.cos(a)).toFixed(2)} ${(10 + r * Math.sin(a)).toFixed(2)}`; };
  return `${i ? 'L' : 'M'}${at(-14, 5.9)}L${at(-8, 7.6)}L${at(8, 7.6)}L${at(14, 5.9)}A5.9 5.9 0 0 1 ${at(31, 5.9)}`;
}).join('') + 'Z';

/// The otter as sound (design/icon.swift draws the same): a waveform in the otter's shape. Bars with rounded caps,
/// each as tall as the otter is where it stands: the head's dome and the ears above (lifted a little), the body's
/// round below; tall in the middle, short at the sides, the ears two taller bars, the whole the otter. No face.
const EAR_LIFT = 2.5;
const bezier = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
const bodySpan = (x: number) => {
  const ax = Math.abs(x);
  if (ax > 13) return null;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const t = (lo + hi) / 2; if (bezier(13, 13, 7, 0, t) > ax) lo = t; else hi = t; }
  const t = (lo + hi) / 2;
  return [bezier(-16, -22, -25, -25, t), bezier(15, 22, 25, 25, t)] as const;
};
const earSpan = (x: number) => { const dx = Math.abs(x) - 9; if (Math.abs(dx) > 4.5) return null; const h = Math.sqrt(4.5 * 4.5 - dx * dx); return [-22 - EAR_LIFT - h, -22 - EAR_LIFT + h] as const; };
export const otterBars = (pitch = 2, width = 1.3) => {
  const bars: { x: number; y: number; h: number }[] = [];
  for (let x = pitch / 2; x <= 13.5; x += pitch) for (const side of [-1, 1]) {
    const cx = side * x, body = bodySpan(cx), ear = earSpan(cx);
    if (!body && !ear) continue;
    const top = Math.min(body?.[0] ?? Infinity, ear?.[0] ?? Infinity), bottom = Math.max(body?.[1] ?? -Infinity, ear?.[1] ?? -Infinity);
    bars.push({ x: cx - width / 2, y: top, h: bottom - top });
  }
  return bars;
};
const BARS = otterBars(3.25, 2.1); // eight bars: enough at 28 points
/// TabTasker Business's own mark, as its site serves it (apps/web/public/tabtasker-mark.svg): the otter on its
/// night-blue tile. For the way out to Business, so it is Business's face, not Dictate's.
export const BusinessMark = ({ size = 16 }: { size?: number }) => {
  const id = useId();
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1e293b" /><stop offset=".55" stopColor="#0f172a" /><stop offset="1" stopColor="#020617" /></linearGradient>
      <linearGradient id={`${id}-otter`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#cbd5e1" /></linearGradient>
      <clipPath id={`${id}-tile`}><rect width="64" height="64" rx="14" /></clipPath>
    </defs>
    <g clipPath={`url(#${id}-tile)`}>
      <rect width="64" height="64" fill={`url(#${id}-bg)`} />
      <g transform="translate(32 47) scale(1.3)">
        <circle cx="-9" cy="-22" r="4.5" fill="#ffffff" /><circle cx="9" cy="-22" r="4.5" fill="#ffffff" />
        <path fill={`url(#${id}-otter)`} d="M-13 -16 C-13 -22 -7 -25 0 -25 C7 -25 13 -22 13 -16 L13 15 C13 22 7 25 0 25 C-7 25 -13 22 -13 15 Z" />
        <circle cx="-9" cy="-22" r="2" fill="#0f172a" /><circle cx="9" cy="-22" r="2" fill="#0f172a" />
        <circle cx="-5" cy="-15" r="1.6" fill="#0f172a" /><circle cx="5" cy="-15" r="1.6" fill="#0f172a" />
        <ellipse cx="0" cy="-10" rx="1.7" ry="1.3" fill="#0f172a" />
        <g fill="#0f172a"><circle cx="-3.5" cy="-8" r=".45" /><circle cx="-4.6" cy="-7" r=".45" /><circle cx="-3.5" cy="-6" r=".45" /><circle cx="3.5" cy="-8" r=".45" /><circle cx="4.6" cy="-7" r=".45" /><circle cx="3.5" cy="-6" r=".45" /></g>
      </g>
    </g>
  </svg>;
};
export const Logo = ({ size = 18 }: { size?: number }) => {
  const id = useId();
  return <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-grey`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3c3d41" /><stop offset="1" stopColor="#18181b" /></linearGradient>
      <clipPath id={`${id}-tile`}><rect x="1" y="1" width="26" height="26" rx="6.2" /></clipPath>
    </defs>
    <rect x="1" y="1" width="26" height="26" rx="6.2" fill={`url(#${id}-grey)`} />
    <rect x="1.25" y="1.25" width="25.5" height="25.5" rx="5.95" fill="none" stroke="#fff" strokeOpacity=".12" strokeWidth=".5" />
    {/* Placed as Business places its mark: its tile is 64 units and this one 26; the group sits at (32 47) scaled 1.3, the body running off
        the bottom. The clip is on its own group: on a transformed one it would be read in the mark's coordinates. */}
    <g clipPath={`url(#${id}-tile)`}><g transform="translate(14 20.094) scale(.52813)">
      <g fill="#f3f4f6">{BARS.map(bar => <rect key={bar.x} x={bar.x} y={bar.y} width="2.1" height={bar.h} rx="1.05" />)}</g>
    </g></g>
  </svg>;
};
export const NoteIcon = () => <Icon name="note" size={17} />;
export const LibraryIcon = () => <Icon name="library" size={17} />;
export const MicIcon = () => <Icon name="mic" size={17} />;
export const PasteIcon = () => <Icon name="copy" size={17} />;
export const MeetingIcon = () => <Icon name="meeting" size={17} />;
export const GearIcon = () => <Line><path d={GEAR} /><circle cx="10" cy="10" r="2.4" /></Line>;
// A clock with its bells: away for a while.
export const AlarmIcon = () => <Line><circle cx="10" cy="11" r="6" /><path d="M10 8.25v2.9l1.9 1.35M3.6 5.6l2.3-2M16.4 5.6l-2.3-2" /></Line>;
// An update: an arrow coming down into a circle.
export const UpdateIcon = () => <Line><circle cx="10" cy="10" r="6.75" /><path d="M10 6.5v6.5M7.25 10.5 10 13.25l2.75-2.75" /></Line>;
// Setup: a list with its first steps ticked.
export const SetupIcon = () => <Line><rect x="3.25" y="2.75" width="13.5" height="14.5" rx="2.5" /><path d="m6.25 7.4 1.25 1.25 2.25-2.5M6.25 12.9l1.25 1.25 2.25-2.5M12 7.6h2.25M12 13.1h2.25" /></Line>;
export const Check = () => <svg className="icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>;
export const Caret = () => <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg>;
export const Globe = () => <svg width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" aria-hidden="true"><circle cx="128" cy="128" r="96" /><path d="M32 128h192M128 32c-28 26-40 60-40 96s12 70 40 96M128 32c28 26 40 60 40 96s-12 70-40 96" /></svg>;
export const X = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
