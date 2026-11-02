import type { DictateKey } from '../store';
import type { Mock } from '.';

// The browser's names for the right-hand keys; fn never reaches a web page.
const CODES: Partial<Record<DictateKey, string>> = { rightCommand: 'MetaRight', rightOption: 'AltRight', rightControl: 'ControlRight', rightShift: 'ShiftRight' };

// In a browser: the chosen dictate key, pressed in the page, stands in for the app's key monitor. It
// sends dictate-fn, and a double tap locks hands-free listening the way the app does (each press under
// 0.25 s, the presses within 0.35 s) until the next tap, Escape, the pill's buttons or the minute is up.
export function register(mock: Mock) {
  let down = false, downAt = 0, tapAt = -1, locked = false, limit = 0;
  const lock = (on: boolean) => {
    if (on === locked) return;
    locked = on;
    clearTimeout(limit);
    if (on) limit = window.setTimeout(() => { mock.emit('dictate-notice', { message: 'Stopped at one minute' }); lock(false); }, 59_500);
    mock.emit('dictate-state', { phase: on ? 'listening' : 'idle', level: 0, dictating: on });
    mock.emit('dictate-hands-free', { locked });
  };
  const key = (event: KeyboardEvent) => {
    const pressed = event.type === 'keydown';
    if (pressed && event.code === 'Escape') { lock(false); return; }
    const { dictate, handsFree } = mock.settings().shortcuts;
    if (event.code !== CODES[dictate] || pressed === down) return;
    down = pressed;
    mock.emit('dictate-fn', { down });
    const now = event.timeStamp / 1000;
    if (pressed) { downAt = now; return; }
    if (locked) { lock(false); return; }
    if (now - downAt >= 0.25) tapAt = -1;
    else if (tapAt >= 0 && downAt - tapAt <= 0.35) { tapAt = -1; if (handsFree) lock(true); }
    else tapAt = downAt;
  };
  addEventListener('keydown', key);
  addEventListener('keyup', key);
  addEventListener('blur', () => { if (down) { down = false; mock.emit('dictate-fn', { down }); } });
  const permissions = mock.handled('request');
  mock.handle('request', args => args.kind === 'send' || args.kind === 'cancel' ? lock(false) : permissions?.(args));
}
