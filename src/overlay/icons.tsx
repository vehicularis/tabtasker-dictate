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

// The app icon, as design/icon.swift draws it: TabTasker's otter with its voice on its chest, on Business's
// night-blue tile. The 824 tile of the icon's 1024 grid is scaled to 26 here, and the otter is drawn in the
// icon's own coordinates (y up) under one transform, so the two never drift apart.
export const Logo = ({ size = 18 }: { size?: number }) => {
  const id = useId();
  const dots = [[-14, 12], [6, 0], [-6, -16]] as const;
  return <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-sky`} x1="1" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#030718" /><stop offset="1" stopColor="#1d283a" /></linearGradient>
      <clipPath id={`${id}-tile`}><rect x="1" y="1" width="26" height="26" rx="6.2" /></clipPath>
    </defs>
    <rect x="1" y="1" width="26" height="26" rx="6.2" fill={`url(#${id}-sky)`} />
    <rect x="1.25" y="1.25" width="25.5" height="25.5" rx="5.95" fill="none" stroke="#fff" strokeOpacity=".12" strokeWidth=".5" />
    {/* The clip is on its own group: on a transformed one it would be read in the icon's coordinates. */}
    <g clipPath={`url(#${id}-tile)`}><g transform="translate(1 27) scale(.031553 -.031553) translate(-100 -100)">
      <g fill="#f3f4f6">
        <rect x="293" y="-200" width="438" height="955" rx="219" /><circle cx="357" cy="707" r="77" /><circle cx="667" cy="707" r="77" />
      </g>
      <g fill="#0e1525">
        <circle cx="357" cy="707" r="34" /><circle cx="667" cy="707" r="34" /><circle cx="430" cy="573" r="27" /><circle cx="594" cy="573" r="27" />
        <ellipse cx="512" cy="490" rx="30" ry="21" />
        {dots.map(([dx, dy]) => <circle key={`l${dx}`} cx={426 + dx} cy={452 + dy} r="7" />)}
        {dots.map(([dx, dy]) => <circle key={`r${dx}`} cx={598 - dx} cy={452 + dy} r="7" />)}
        <rect x="437" y="281" width="30" height="74" rx="15" /><rect x="497" y="254" width="30" height="128" rx="15" /><rect x="557" y="281" width="30" height="74" rx="15" />
      </g>
    </g></g>
  </svg>;
};
export const NoteIcon = () => <Icon name="note" size={17} />;
export const LibraryIcon = () => <Icon name="library" size={17} />;
export const MicIcon = () => <Icon name="mic" size={17} />;
export const FolderIcon = () => <Icon name="folder" size={17} />;
export const PasteIcon = () => <Icon name="copy" size={17} />;
export const MeetingIcon = () => <Icon name="meeting" size={17} />;
export const GearIcon = () => <Line><path d={GEAR} /><circle cx="10" cy="10" r="2.4" /></Line>;
// A clock with its bells: away for a while.
export const AlarmIcon = () => <Line><circle cx="10" cy="11" r="6" /><path d="M10 8.25v2.9l1.9 1.35M3.6 5.6l2.3-2M16.4 5.6l-2.3-2" /></Line>;
// Setup: a list with its first steps ticked.
export const SetupIcon = () => <Line><rect x="3.25" y="2.75" width="13.5" height="14.5" rx="2.5" /><path d="m6.25 7.4 1.25 1.25 2.25-2.5M6.25 12.9l1.25 1.25 2.25-2.5M12 7.6h2.25M12 13.1h2.25" /></Line>;
export const Check = () => <svg className="icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>;
export const Caret = () => <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg>;
export const Globe = () => <svg width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" aria-hidden="true"><circle cx="128" cy="128" r="96" /><path d="M32 128h192M128 32c-28 26-40 60-40 96s12 70 40 96M128 32c28 26 40 60 40 96s-12 70-40 96" /></svg>;
export const X = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
