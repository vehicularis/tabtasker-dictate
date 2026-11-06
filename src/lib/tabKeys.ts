import type { TabAction } from '../api/types';

const SELECT = ['select:1', 'select:2', 'select:3', 'select:4', 'select:5', 'select:6', 'select:7', 'select:8', 'select:9'] as const satisfies TabAction[];

/// What a key press means to the tab strip, by `event.code` (the brackets and digits are on the same keys whatever
/// the layout prints on them): the tab keys of Safari and Chrome. ⌃Tab and ⌃⇧Tab; ⌘⇧] and ⌘⇧[, or ⌘⌥→ and ⌘⌥←, for
/// the next and the previous tab; ⌘⌥⇧→ and ⌘⌥⇧← move the tab itself. ⌘[, ⌘] and ⌘, are back, forward and settings.
export function tabKey(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }): TabAction | 'back' | 'forward' | 'settings' | null {
  const { metaKey: cmd, ctrlKey: ctrl, altKey: alt, shiftKey: shift, code } = event;
  if (ctrl && !cmd && !alt && code === 'Tab') return shift ? 'prev' : 'next';
  if (!cmd || ctrl) return null;
  const arrow = code === 'ArrowLeft' || code === 'ArrowRight', bracket = code === 'BracketLeft' || code === 'BracketRight';
  if (alt && shift && arrow) return code === 'ArrowRight' ? 'right' : 'left';
  if (alt && !shift && arrow) return code === 'ArrowRight' ? 'next' : 'prev';
  if (!alt && shift && bracket) return code === 'BracketRight' ? 'next' : 'prev';
  if (!alt && !shift && bracket) return code === 'BracketLeft' ? 'back' : 'forward';
  if (!alt && !shift && code === 'Comma') return 'settings';
  if (!alt && code === 'KeyT') return shift ? 'reopen' : 'new';
  if (!alt && code === 'KeyW') return shift ? 'window' : 'close';
  if (!alt && !shift && /^Digit[1-9]$/.test(code)) return SELECT[Number(code.slice(5)) - 1];
  return null;
}
