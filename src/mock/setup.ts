import type { Mock } from '.';
import type { DictateKey } from '../store';

// In a browser: the first-run flow and the General page, walkable from start to end.
// - `?status=new` starts as a Mac never set up; `&mic=denied` as one that said no to the microphone, and
//   `&globe=emoji` as one whose globe key opens emoji.
// - Asking for a permission grants it a moment later, as if done in System Settings.
// - On the setup page and the overlay's setup previews only, the dictate key is the real key on this
//   keyboard (right ⌘, ⌥, ⌃ or ⇧). Browsers never see fn, so ` stands in for it. Once voice is ready, a
//   hold types a sentence into the focused field. Everywhere else the keys type as usual.
const CODES: Record<DictateKey, string> = { fn: 'Backquote', rightCommand: 'MetaRight', rightOption: 'AltRight', rightControl: 'ControlRight', rightShift: 'ShiftRight' };
const SAID = 'Remind me to call Maria at three tomorrow.';

export function register(mock: Mock) {
  const { status } = mock;
  const params = new URLSearchParams(location.search);
  if (params.get('mic') === 'denied') status.microphone = 'denied';
  const globe = params.get('globe');
  if (globe === 'inputSource' || globe === 'emoji' || globe === 'dictation') status.globeKey = globe;

  const later = (ms: number, change: () => void) => void setTimeout(change, ms);
  mock.handle('request', ({ kind }) => {
    if (kind === 'microphone') later(900, () => { status.microphone = 'allowed'; });
    if (kind === 'accessibility') later(2000, () => { status.accessibility = true; });
    if (kind === 'keyboard') later(2000, () => { status.globeKey = ''; });
  });

  let since = 0;
  const setup = () => location.pathname.endsWith('/settings.html') ? location.hash === '#setup' : !!params.get('preview')?.startsWith('setup');
  const isKey = (event: KeyboardEvent) => event.code === CODES[mock.settings().shortcuts.dictate]
    && (event.code !== 'Backquote' || !(event.metaKey || event.ctrlKey || event.altKey));
  const release = () => {
    const held = performance.now() - since;
    since = 0;
    mock.emit('dictate-fn', { down: false });
    const ready = status.enabled && status.modelReady && status.microphone === 'allowed' && status.accessibility;
    const field = document.activeElement;
    if (held > 350 && ready && (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) {
      // As the app types: keystrokes at the caret, with a space first when it follows a word.
      document.execCommand('insertText', false, `${/\S$/.test(field.value.slice(0, field.selectionStart ?? 0)) ? ' ' : ''}${SAID}`);
    }
  };
  addEventListener('keydown', event => {
    if (!isKey(event) || !setup()) return;
    if (event.code === 'Backquote') event.preventDefault();
    if (since) return;
    since = performance.now();
    mock.emit('dictate-fn', { down: true });
  }, true);
  addEventListener('keyup', event => { if (since && isKey(event)) release(); }, true);
  addEventListener('blur', () => { if (since) release(); });
}
