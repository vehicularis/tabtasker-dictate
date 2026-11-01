import type { Theme } from '../store';

// `?theme=light|dark` pins the theme in a browser, whatever the settings say.
const forced = new URLSearchParams(location.search).get('theme');

/// Follows the Mac for `system`, otherwise pins `theme` on <html>.
export function applyTheme(theme: Theme) {
  const pick = forced === 'light' || forced === 'dark' ? forced : theme;
  if (pick === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pick;
}
applyTheme('system');

export const isDark = () => {
  const pinned = document.documentElement.dataset.theme;
  return pinned ? pinned === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
