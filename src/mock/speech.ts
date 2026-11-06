import type { Mock } from '.';

// In a browser: the speech models, the vocabulary's prompt budget and the apps to give a style.
// `?speech=fail` makes a model download stop partway, to check the error state.

type Model = 'turbo' | 'small';
type Step = { model: Model; message: string; percent: number | null; failed: boolean };
const BYTES: Record<Model, number> = { turbo: 874188075, small: 264464607 };
const LABEL: Record<Model, string> = { turbo: 'Whisper large-v3 Turbo', small: 'Whisper small' };
const failing = new URLSearchParams(location.search).get('speech') === 'fail';

// Sample apps with drawn icons: open ones, recent ones, and the installed apps the default styles name.
const APPS: [string, string, string, 'open' | 'recent' | 'installed'][] = [
  ['com.apple.Notes', 'Notes', '#f5c400', 'open'], ['com.apple.Safari', 'Safari', '#1e88e5', 'open'], ['com.apple.Terminal', 'Terminal', '#2b2b2b', 'open'],
  ['com.tinyspeck.slackmacgap', 'Slack', '#4a154b', 'open'], ['com.microsoft.VSCode', 'Visual Studio Code', '#0065a9', 'open'], ['com.apple.mail', 'Mail', '#2f80ed', 'open'],
  ['com.figma.Desktop', 'Figma', '#1e1e1e', 'recent'], ['com.linear', 'Linear', '#5e6ad2', 'recent'], ['md.obsidian', 'Obsidian', '#7c3aed', 'recent'],
  ['com.apple.iWork.Pages', 'Pages', '#f39c12', 'recent'], ['notion.id', 'Notion', '#111111', 'recent'], ['com.apple.MobileSMS', 'Messages', '#34c759', 'installed'],
  ['com.apple.dt.Xcode', 'Xcode', '#147efb', 'installed'], ['com.mitchellh.ghostty', 'Ghostty', '#3b3b5c', 'installed'],
];
const icon = (name: string, fill: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="13" fill="${fill}"/><text x="32" y="42" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="26" font-weight="600" fill="#fff">${name[0]}</text></svg>`)}`;

/// crates/engine/src/prompt.rs's prompt_text with its estimate: a token for every three bytes, under 200.
const fit = (words: string[]) => {
  let text = '', count = 0;
  for (const word of words.map(word => word.trim()).filter(Boolean)) {
    const next = text ? `${text}, ${word}` : ` ${word}`;
    if (Math.ceil(new TextEncoder().encode(next).length / 3) >= 200) break;
    text = next; count++;
  }
  return count;
};

export function register(mock: Mock) {
  let active: Model | null = mock.status.enabled ? 'turbo' : null;
  const downloaded: Record<Model, boolean> = { turbo: true, small: false };
  let step: Step | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const state = () => ({ active, enabled: mock.status.enabled, step, models: (['turbo', 'small'] as const).map(model => ({ model, bytes: BYTES[model], downloaded: downloaded[model] })) });
  const changed = () => mock.emit('dictate-model', state());
  // As speech.rs does when the choice changes: download, load, then swap, the model in use answering meanwhile.
  const prepare = () => {
    const want = mock.settings().dictation.model;
    if (step && !step.failed && step.model === want) return;
    clearInterval(timer);
    step = null;
    if (!mock.status.enabled || active === want) { changed(); return; }
    let percent = downloaded[want] ? 100 : 0;
    timer = setInterval(() => {
      if (mock.settings().dictation.model !== want) { clearInterval(timer); step = null; changed(); return; }
      if (failing && percent >= 40) {
        clearInterval(timer);
        step = { model: want, message: 'Couldn’t download the speech model. Check your connection and try again.', percent: null, failed: true };
      } else if (percent < 100) {
        percent = Math.min(100, percent + 6);
        step = { model: want, message: `Downloading ${LABEL[want]} · ${percent}%`, percent, failed: false };
      } else if (step?.message.startsWith('Loading')) {
        clearInterval(timer);
        downloaded[want] = true; active = want; step = null;
      } else {
        step = { model: want, message: `Loading ${LABEL[want]} on this Mac…`, percent: null, failed: false };
      }
      changed();
    }, 400);
  };
  mock.handle('speech_models', () => { prepare(); return state(); });
  mock.handle('prepare_model', () => {
    if (!mock.status.enabled) throw 'Turn dictation on first';
    step = null;
    prepare();
  });
  mock.handle('vocabulary_fit', ({ words }) => fit(Array.isArray(words) ? words.filter((word): word is string => typeof word === 'string') : []));
  mock.handle('list_apps', ({ known }) => new Promise(done => setTimeout(() => {
    const wanted = new Set((Array.isArray(known) ? known : []).map(id => String(id).toLowerCase()));
    done(APPS.filter(([bundleId, , , kind]) => kind !== 'installed' || wanted.has(bundleId.toLowerCase()))
      .map(([bundleId, name, fill, kind]) => ({ bundleId, name, icon: icon(name, fill), running: kind === 'open', recent: kind === 'recent' })));
  }, 300)));
}
