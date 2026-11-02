// A monochrome line set on a 20 grid at 1.5 stroke, drawn in the current text colour.
const PATHS = {
  general: <><path d="M3 6.5h2.5M9.5 6.5H17M3 13.5h8M15 13.5h2" /><circle cx="7.5" cy="6.5" r="2" /><circle cx="13" cy="13.5" r="2" /></>,
  keyboard: <><rect x="2.5" y="5" width="15" height="10" rx="2" /><path d="M6 8.25h.01M8.67 8.25h.01M11.33 8.25h.01M14 8.25h.01M7 11.75h6" /></>,
  waveform: <path d="M4 8.5v3M7 5.5v9M10 3.5v13M13 6.5v7M16 8.5v3" />,
  book: <><path d="M4.25 15.75V4.5A1.75 1.75 0 0 1 6 2.75h9.75v11.5H6a1.75 1.75 0 0 0-1.75 1.75 1.75 1.75 0 0 0 1.75 1.75h9.75v-3.5" /><path d="M7.5 6.5h5" /></>,
  apps: <><rect x="3" y="3" width="5.75" height="5.75" rx="1.6" /><rect x="11.25" y="3" width="5.75" height="5.75" rx="1.6" /><rect x="3" y="11.25" width="5.75" height="5.75" rx="1.6" /><rect x="11.25" y="11.25" width="5.75" height="5.75" rx="1.6" /></>,
  note: <><path d="M5.5 2.75h5.75L15.5 7v9a1.75 1.75 0 0 1-1.75 1.75h-8.25A1.75 1.75 0 0 1 3.75 16V4.5A1.75 1.75 0 0 1 5.5 2.75z" /><path d="M11 2.75V7h4.5M7 10.75h5.5M7 13.75h3.5" /></>,
  meeting: <><circle cx="7.5" cy="7" r="2.75" /><path d="M2.75 16.25a4.75 4.75 0 0 1 9.5 0" /><circle cx="14" cy="7.75" r="2.25" /><path d="M13.6 11.9a4 4 0 0 1 3.65 4.35" /></>,
  // Claude's starburst: twelve rays, long and short by turns.
  claude: <path d="M10 10 10.00 2.75M10 10 12.62 5.45M10 10 16.28 6.38M10 10 15.25 10.00M10 10 16.28 13.62M10 10 12.62 14.55M10 10 10.00 17.25M10 10 7.38 14.55M10 10 3.72 13.62M10 10 4.75 10.00M10 10 3.72 6.37M10 10 7.37 5.45" />,
  agents: <><circle cx="5" cy="5" r="2.25" /><circle cx="15" cy="5" r="2.25" /><circle cx="10" cy="15" r="2.25" /><path d="M7.25 5h5.5M6.1 7 8.9 13M13.9 7l-2.8 6" /></>,
  history: <><path d="M3.75 10a6.25 6.25 0 1 0 1.83-4.42L3.75 7.4" /><path d="M3.75 3.75V7.4H7.4M10 6.75v3.5l2.5 1.5" /></>,
  appearance: <><circle cx="10" cy="10" r="7.25" /><path d="M10 2.75a7.25 7.25 0 0 1 0 14.5z" fill="currentColor" stroke="none" /></>,
  about: <><circle cx="10" cy="10" r="7.25" /><path d="M10 9.25v4.5M10 6.5h.01" /></>,
  search: <><circle cx="8.75" cy="8.75" r="5.25" /><path d="m12.75 12.75 3.75 3.75" /></>,
  chevronDown: <path d="m6 8 4 4 4-4" />,
  chevronRight: <path d="m8 6 4 4-4 4" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  close: <path d="m5.5 5.5 9 9m0-9-9 9" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  minus: <path d="M4.5 10h11" />,
  trash: <path d="M3.75 5.75h12.5M8 5.75v-1.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.25 5.75l.7 9.6a1.5 1.5 0 0 0 1.5 1.4h5.1a1.5 1.5 0 0 0 1.5-1.4l.7-9.6" />,
  folder: <path d="M2.75 6.25a1.5 1.5 0 0 1 1.5-1.5h3.5l1.75 1.75h6.25a1.5 1.5 0 0 1 1.5 1.5v6.75a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z" />,
  mic: <><rect x="7.25" y="2.75" width="5.5" height="9" rx="2.75" /><path d="M4.75 9.75a5.25 5.25 0 0 0 10.5 0M10 15v2.25" /></>,
  shield: <path d="M10 2.75 16 5v4.5c0 3.9-2.6 6.6-6 7.75-3.4-1.15-6-3.85-6-7.75V5z" />,
  external: <path d="M8.25 4.25h-3A1.5 1.5 0 0 0 3.75 5.75v9a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-3M11.25 3.75h5v5M16.25 3.75 9.5 10.5" />,
  copy: <><rect x="7" y="7" width="9.5" height="9.5" rx="1.75" /><path d="M13 7V5.25a1.75 1.75 0 0 0-1.75-1.75h-6A1.75 1.75 0 0 0 3.5 5.25v6A1.75 1.75 0 0 0 5.25 13H7" /></>,
  dots: <path d="M5.5 10h.01M10 10h.01M14.5 10h.01" strokeWidth="2.2" />,
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {PATHS[name]}
  </svg>;
}
