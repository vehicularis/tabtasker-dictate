// Renders design/dmg-background.html (the DMG window's background) at 1x and 2x with headless Chrome, and joins
// the two into design/dmg-background.tiff, which Finder shows sharp on any screen. Run from the repository root:
// node design/dmg-background.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const page = `file://${resolve('design/dmg-background.html')}`, work = mkdtempSync(join(tmpdir(), 'dmg-bg-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${work}/profile`, '--remote-debugging-port=9351', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); target = await fetch('http://127.0.0.1:9351/json/list').then(r => r.json()).then(l => l.find(t => t.type === 'page')).catch(() => null); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const waiting = new Map(); ws.addEventListener('message', ({ data }) => { const m = JSON.parse(data), done = waiting.get(m.id); if (typeof done === 'function') done(m.result); });
  const send = (method, params = {}) => new Promise(r => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const shots = [];
  for (const scale of [1, 2]) {
    await send('Emulation.setDeviceMetricsOverride', { width: 660, height: 400, deviceScaleFactor: scale, mobile: false });
    await send('Page.navigate', { url: page }); await sleep(1200);
    await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
    const file = join(work, `bg${scale}.png`);
    writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    execFileSync('sips', ['-s', 'dpiWidth', String(72 * scale), '-s', 'dpiHeight', String(72 * scale), file], { stdio: 'ignore' }); // Finder reads the 2x by its DPI
    shots.push(file);
  }
  ws.close();
  execFileSync('tiffutil', ['-cathidpicheck', ...shots, '-out', 'design/dmg-background.tiff'], { stdio: 'inherit' });
  console.log('design/dmg-background.tiff');
} finally {
  chrome.kill(); await new Promise(r => chrome.once('exit', r)); // Chrome writes its profile until it is gone
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
