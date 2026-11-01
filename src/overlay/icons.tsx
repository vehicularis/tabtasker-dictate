// The overlay's objects, drawn like small enamel tiles with one light, in ink only; the logo is the app
// icon's mark.
export const Logo = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
  <rect x="1" y="1" width="26" height="26" rx="7" fill="#000" />
  {[[7, 5.6], [10.4, 9.6], [17.6, 9.6], [21, 5.6]].map(([x, h]) => <rect key={x} x={x - 1} y={14 - h / 2} width="2" height={h} rx="1" fill="#fff" />)}
  <path d="M14 7v14M12.6 7h2.8M12.6 21h2.8" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
</svg>;
export const NoteIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M6 3.5h9l5 5v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-17a2 2 0 0 1 2-2z" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.2" />
  <path d="M15 3.5V7a1.5 1.5 0 0 0 1.5 1.5H20M7.5 12.5h7M7.5 15.5h5M7.5 18.5h3" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
  <g transform="rotate(38 20 17)"><rect x="18.4" y="7.5" width="3.2" height="10.5" rx="1.2" fill="currentColor" fillOpacity="0.85" /><path d="M18.4 18h3.2L20 21.6z" fill="currentColor" fillOpacity="0.5" /></g>
</svg>;
export const MicIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" aria-hidden="true">
  <rect x="9.5" y="2.5" width="9" height="14.5" rx="4.5" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
  <path d="M12 7.5h4M12 10h4M12 12.5h4" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.3" />
  <path d="M6.5 12.5a7.5 7.5 0 0 0 15 0M14 20v4M10.5 24.5h7" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.5" />
</svg>;
export const FolderIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinejoin="round" aria-hidden="true">
  <path d="M3.5 8a2 2 0 0 1 2-2h5.5l2.5 2.5h9a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2z" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.2" />
  <path d="M3.5 11.5h21" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.2" />
</svg>;
export const AlarmIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" aria-hidden="true">
  <circle cx="14" cy="15" r="8.5" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
  <path d="M14 10.5V15l3 2M5 6.5l3-2.5M23 6.5l-3-2.5" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.4" />
</svg>;
// The teeth are one dashed ring: eight dashes around r=10.4.
export const GearIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" aria-hidden="true">
  <circle cx="14" cy="14" r="10.4" stroke="currentColor" strokeOpacity="0.55" strokeWidth="3.4" strokeDasharray="3.6 4.57" />
  <circle cx="14" cy="14" r="8.6" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
  <circle cx="14" cy="14" r="3" stroke="currentColor" strokeOpacity="0.8" strokeWidth="1.5" />
</svg>;
export const MeetingIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" aria-hidden="true">
  <circle cx="10.5" cy="10" r="4" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
  <path d="M3.5 23a7 7 0 0 1 14 0z" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" strokeLinejoin="round" />
  <circle cx="19.5" cy="11" r="3.2" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
  <path d="M19 17.6a5.6 5.6 0 0 1 6 5.4" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
</svg>;
// Setup: a list with its first steps ticked.
export const SetupIcon = () => <svg width="17" height="17" viewBox="0 0 28 28" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="4" y="3.5" width="20" height="21" rx="3" fill="var(--enamel)" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.2" />
  <path d="M8 9.5l1.6 1.6L12.5 8M8 15.5l1.6 1.6 2.9-3.1" stroke="currentColor" strokeOpacity="0.8" strokeWidth="1.4" />
  <path d="M15.5 10h4.5M15.5 16h4.5M8.5 21h11" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
</svg>;
export const Check = () => <svg className="icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>;
export const Caret = () => <svg className="more" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg>;
export const Globe = () => <svg width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16"><circle cx="128" cy="128" r="96" /><path d="M32 128h192M128 32c-28 26-40 60-40 96s12 70 40 96M128 32c28 26 40 60 40 96s-12 70-40 96" /></svg>;
export const X = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
