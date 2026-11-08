// End-to-end check in headless Chrome, over the DevTools protocol.
//
//   node scripts/build.mjs (with TOOLBOX_BASE_URL=http://localhost:4173)
//   node test/run.mjs
//
// Serves dist/ on :4173, plus two pages with strict CSPs on :4174, then runs
// the bookmarklet's code with Runtime.evaluate (as clicking it does) and
// drives each tool with real mouse and keyboard input. Screenshots land in
// test-results/bookmarklet/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../scripts/serve.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shots = path.join(root, process.env.SCREENSHOT_DIR || 'test-results/bookmarklet');
fs.mkdirSync(shots, { recursive: true });
const PORT = 9335;
const BASE = 'http://localhost:4173';
const bookmarklet = fs
  .readFileSync(path.join(root, 'dist/bookmarklet.txt'), 'utf8')
  .trim()
  .replace(/^javascript:/, '');
if (!bookmarklet.includes(BASE))
  throw new Error(`dist/ was built for another base URL; rebuild with TOOLBOX_BASE_URL=${BASE}`);

// ---- Servers

const site = serve(path.join(root, 'dist'), 4173);
const cspPage = (policy) =>
  `<!doctype html><meta charset="utf-8"><title>CSP</title><h1>Strict page</h1><p>${policy}</p>`;
const csp = http
  .createServer((req, res) => {
    const policy = req.url.startsWith('/tt')
      ? "require-trusted-types-for 'script'"
      : "script-src 'self'";
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': policy });
    res.end(cspPage(policy));
  })
  .listen(4174);

// ---- Chrome

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ptb-chrome-'));
// A managed Google Chrome may switch remote debugging off a few seconds in,
// once its admin policy arrives; an unmanaged build (Playwright's headless
// shell) isn't affected, so it's preferred when installed. CHROME overrides.
const playwrightShell = (() => {
  const dir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    for (const entry of fs.readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        const bin = path.join(dir, entry, arch, 'chrome-headless-shell');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  return null;
})();
const chromeBin =
  process.env.CHROME ?? playwrightShell ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
console.log(`Browser: ${chromeBin}`);
const chrome = spawn(
  chromeBin,
  [
    '--headless=new',
    ...(process.env.GPU ? [] : ['--disable-gpu']),
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--force-device-scale-factor=2',
    `--remote-debugging-port=${PORT}`,
    // Keep frames coming, so input and screenshots never wait on a throttled tab.
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: process.env.DEBUG ? ['ignore', 'ignore', fs.openSync('/tmp/ptb-chrome.log', 'w')] : 'ignore' },
);
chrome.on('exit', (code, signal) => process.env.DEBUG && console.log('CHROME EXIT', code, signal));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = (why) => {
  console.error(`ABORT ${why}`);
  try { chrome.kill('SIGKILL'); } catch {}
  process.exit(2);
};
setTimeout(() => bail('whole run took over 3 minutes'), 180000).unref();
process.on('unhandledRejection', (e) => bail(e?.stack ?? e));

let ws;
for (let i = 0; i < 150 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(200);
}
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.method === 'Debugger.paused' && process.env.DEBUG) {
    console.log('PAUSED\n' + data.params.callFrames.slice(0, 15).map((f) => `  ${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.location.lineNumber}:${f.location.columnNumber}`).join('\n'));
    return;
  }
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data.result ?? data);
    pending.delete(data.id);
  } else if (data.method) {
    if (process.env.DEBUG && /crash|Detached|Inspector|dialog/i.test(data.method)) console.log('EVENT', data.method, JSON.stringify(data.params).slice(0, 200));
    events.push(data);
  }
};
const send = (method, params = {}) =>
  new Promise((r, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (process.env.DEBUG) ws.send(JSON.stringify({ id: 999999, method: 'Debugger.pause' }));
      if (process.env.DEBUG) fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).then((l) => console.log('TARGETS', JSON.stringify(l.map((t) => [t.type, t.url, t.title]))));
      setTimeout(() => reject(new Error(`${method} timed out: ${JSON.stringify(params).slice(0, 160)}`)), 1500);
    }, 15000);
    pending.set(id, (v) => (clearTimeout(timer), r(v)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const out = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: !process.env.NOGESTURE,
  });
  if (out.exceptionDetails)
    throw new Error(`${expression.slice(0, 80)}: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
  return out.result?.value;
};

await send('Page.enable');
await send('Page.bringToFront');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
if (process.env.DEBUG) await send('Debugger.enable');
await send('Runtime.enable');
await send('Browser.grantPermissions', {
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  origin: BASE,
});

// Dialogs (alerts) are noted and dismissed, so a page's alert can't hang us.
const dialogs = [];
const watchDialogs = setInterval(async () => {
  for (const e of events.splice(0)) {
    if (e.method === 'Page.javascriptDialogOpening') {
      dialogs.push(e.params.message);
      if (process.env.DEBUG) console.log('      dialog:', e.params.message);
      await send('Page.handleJavaScriptDialog', { accept: true });
    }
    if (e.method === 'Runtime.exceptionThrown')
      errors.push(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text);
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      errors.push(e.params.args.map((a) => a.value ?? a.description).join(' '));
  }
}, 50);
const errors = [];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function go(url, width = 1600, height = 1000) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 600,
  });
  await send('Page.navigate', { url });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if ((await ev('document.readyState')) === 'complete') break;
  }
  await sleep(300);
}
const click = async (x, y, modifiers = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
  await sleep(150);
};
const hover = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(120);
};
const dragBy = async (x, y, dx, dy, modifiers = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
  for (let i = 1; i <= 8; i++)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 8, y: y + (dy * i) / 8, button: 'left', buttons: 1, modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1, modifiers });
  await sleep(150);
};
const key = async (k, code = k, keyCode = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
  await sleep(100);
};
const shot = async (name, full = false) => {
  const params = { format: 'png' };
  if (full) {
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }
  const r = await send('Page.captureScreenshot', params);
  fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
  console.log(`      screenshot ${name}`);
};

// Helpers run in the page: the shadow root, a centre point, the counts.
const PAGE_HELPERS = `
  if (!window.__clipWrapped) {
    // Note what the tools copy (reading the clipboard back stalls headless Chrome).
    window.__clipWrapped = true;
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => { window.__clip = String(text); return write(text).catch(() => {}); };
  }
  window.__t = {
    sr: () => document.querySelector('prototype-toolbox')?.shadowRoot,
    q: (sel) => window.__t.sr()?.querySelector(sel),
    center: (el) => { if (!el) return null; el.scrollIntoView({block: "nearest", inline: "nearest"}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; },
    tool: (label) => window.__t.center([...window.__t.sr().querySelectorAll('.tb-tool')].find((b) => b.dataset.tool.toLowerCase().includes(label.toLowerCase()))),
    counts: () => ({
      hosts: document.querySelectorAll('prototype-toolbox').length,
      scripts: document.querySelectorAll('script[data-prototype-toolbox-script]').length,
      shown: window.__prototypeToolbox?.isOpen() ?? null,
      appShown: window.__t.q('.tb-app')?.dataset.shown ?? null,
      trayOpen: window.__t.q('.tb-tray')?.dataset.open ?? null,
      tools: window.__t.sr()?.querySelectorAll('.tb-tool').length ?? 0,
    }),
  };`;
const helpers = () => ev(PAGE_HELPERS);
const counts = () => ev('__t.counts()');
const runBookmarklet = async () => {
  await ev(bookmarklet);
  for (let i = 0; i < 40; i++) {
    if (await ev('Boolean(window.__prototypeToolbox)')) break;
    await sleep(100);
  }
  await sleep(450);
};
const readClipboard = () => ev('window.__clip ?? ""');

// ---- 1. Toggle and no duplicates on the sample page

await go(`${BASE}/sample.html`);
await helpers();
let c = await counts();
check('sample page starts without the toolbox', c.hosts === 0 && c.scripts === 0, JSON.stringify(c));

await runBookmarklet();
await helpers();
c = await counts();
check('first click: toolbox appears with its tray open', c.hosts === 1 && c.scripts === 1 && c.shown === true && c.appShown === 'true' && c.trayOpen === 'true' && c.tools === 5, JSON.stringify(c));
await shot('sample-toolbox-open.png');

await runBookmarklet();
c = await counts();
const hostHidden = await ev(`getComputedStyle(__t.q('.tb-app')).display`);
check('second click: toolbox closes', c.hosts === 1 && c.scripts === 1 && c.shown === false && hostHidden === 'none', `${JSON.stringify(c)} display=${hostHidden}`);

await runBookmarklet();
c = await counts();
check('third click: toolbox opens again', c.hosts === 1 && c.scripts === 1 && c.shown === true && c.trayOpen === 'true', JSON.stringify(c));

// Two clicks in a row, before the script arrives, still make one copy.
await go(`${BASE}/sample.html`);
await ev(`${bookmarklet}; ${bookmarklet};`);
await sleep(1200);
await helpers();
c = await counts();
check('double click before load: one script tag, one host', c.hosts === 1 && c.scripts === 1 && c.shown === true, JSON.stringify(c));

// Isolation: the page's `button, div, span { font-family: Georgia }` stays out.
const font = await ev(`getComputedStyle(__t.q('.tb-fab')).fontFamily`);
check('host page CSS does not reach the toolbox', !/Georgia/.test(font), font.slice(0, 40));

// ---- 2. Style tweaker

const h1 = await ev(`__t.center(document.querySelector('h1'))`);
let p = await ev(`__t.tool('style')`);
await click(p.x, p.y);
check('style tweaker opens its panel', await ev(`Boolean(__t.q('[data-panel="style-tweaker"]'))`));
await hover(h1.x, h1.y);
check('hover outlines the element under the pointer', await ev(`Boolean(__t.q('.tb-outline.is-hover'))`));
await click(h1.x, h1.y);
const before = await ev(`getComputedStyle(document.querySelector('h1')).fontSize`);
check('click selects the heading', await ev(`__t.q('[data-panel="style-tweaker"] .tb-title').textContent.startsWith('h1')`), await ev(`__t.q('[data-panel="style-tweaker"] .tb-title').textContent`));
p = await ev(`__t.center(__t.q('[aria-label="More Size"]'))`);
await click(p.x, p.y);
const after = await ev(`getComputedStyle(document.querySelector('h1')).fontSize`);
check('stepping Size changes the heading on the page', before !== after, `${before} → ${after}`);
await key('ArrowDown', 'ArrowDown', 40);
await key('ArrowRight', 'ArrowRight', 39);
const weight = await ev(`getComputedStyle(document.querySelector('h1')).fontWeight`);
check('arrow keys step the next control (weight)', weight === '800', `font-weight ${weight}`);
await ev(`(() => { const i = __t.q('input[type=color][aria-label="Colour"]'); i.value = '#c2255c'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(100);
const colour = await ev(`getComputedStyle(document.querySelector('h1')).color`);
check('colour picker recolours the text', colour === 'rgb(194, 37, 92)', colour);
if (!process.env.NOSHOT) await shot('sample-style-tweaker.png');
p = await ev(`__t.center([...__t.q('[data-panel="style-tweaker"]').querySelectorAll('.tb-links button')].find((b) => b.textContent.includes('Copy')))`);
await click(p.x, p.y);
let clip = await readClipboard();
check('Copy edits puts CSS and Tailwind classes on the clipboard', clip.includes('font-size') && clip.includes('text-6xl') && clip.includes('font-extrabold'), clip.split('\n').slice(0, 4).join(' | '));
// Clicks on the page don't reach it while picking.
const quiz = await ev(`__t.center(document.querySelector('.btn-secondary'))`);
// The button calls alert(); count calls instead of opening real dialogs.
await ev(`window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m));`);
if (process.env.DEBUG) console.log('quiz', JSON.stringify(quiz), await ev(`(() => { const e = document.elementFromPoint(${quiz.x}, ${quiz.y}); return e.outerHTML.slice(0, 120) + ' active=' + (document.activeElement?.tagName) + ' / ' + (__t.sr().activeElement?.outerHTML.slice(0, 100)); })()`));
await click(quiz.x, quiz.y);
await sleep(200);
if (process.env.DEBUG) await shot('debug-after-quiz.png');
check('page clicks are held while picking (no page alert)', (await ev('__alerts.length')) === 0);

// ---- 3. Arranger (opening it closes the tweaker)

p = await ev(`__t.tool('arranger')`);
await click(p.x, p.y);
check('Arranger opens and the tweaker closes', (await ev(`Boolean(__t.q('[data-panel="arranger"]'))`)) && !(await ev(`Boolean(__t.q('[data-panel="style-tweaker"]'))`)));
const mug = await ev(`__t.center(document.querySelector('.card img'))`);
await dragBy(mug.x, mug.y, 60, 40);
const transform = await ev(`document.querySelector('.card img').style.transform`);
check('dragging an image moves it', transform.includes('translate(60px, 40px)'), transform);
check('selection gets scale and rotate handles', await ev(`__t.sr().querySelectorAll('.tb-handle').length === 4 && Boolean(__t.q('.tb-rotate-handle'))`));
p = await ev(`__t.center(__t.q('.tb-rotate-handle'))`);
const frame = await ev(`__t.center(__t.q('.tb-arrange-frame'))`);
await dragBy(p.x, p.y, frame.x - p.x + 120, frame.y - p.y, 8 /* shift: snap */);
const turned = await ev(`document.querySelector('.card img').style.transform`);
check('rotate handle turns it (Shift snaps to 15°)', /rotate\((90|75|60|105)deg\)/.test(turned), turned);
await shot('sample-arranger.png');
p = await ev(`__t.center([...__t.q('[data-panel="arranger"]').querySelectorAll('button')].find((b) => b.textContent.includes('Copy values')))`);
await click(p.x, p.y);
clip = await readClipboard();
let json = null;
try { json = JSON.parse(clip); } catch {}
const first = json && Object.values(json)[0];
check('Copy values gives JSON offsets keyed by selector', first && first.x === 60 && first.y === 40 && Object.keys(json)[0].startsWith('/sample.html|#shop >'), clip.replace(/\s+/g, ' ').slice(0, 120));
p = await ev(`__t.center([...__t.q('[data-panel="arranger"]').querySelectorAll('button')].find((b) => b.textContent.includes('Reset all')))`);
await click(p.x, p.y);
await sleep(400);
check('Reset all puts it back', (await ev(`document.querySelector('.card img').style.transform`)) === '');

// ---- 4. Content editor

p = await ev(`__t.tool('content')`);
await click(p.x, p.y);
check('content editor opens and the Arranger closes', (await ev(`Boolean(__t.q('[data-panel="content-editor"]'))`)) && !(await ev(`Boolean(__t.q('[data-panel="arranger"]'))`)));
await ev(`document.querySelector('#shop').scrollIntoView({ block: 'start' })`);
await sleep(200);
const title = await ev(`__t.center(document.querySelector('.card h3'))`);
await click(title.x, title.y);
check('clicking text makes it editable', await ev(`document.querySelector('.card h3').isContentEditable`));
await ev(`(() => { const s = getSelection(); s.selectAllChildren(document.querySelector('.card h3')); })()`);
await send('Input.insertText', { text: 'Trail Quarter Zip' });
await key('Enter', 'Enter', 13);
check('typing replaces the text', (await ev(`document.querySelector('.card h3').textContent`)) === 'Trail Quarter Zip');
check('the edit is listed with what it was', await ev(`__t.q('.tb-before')?.textContent === 'Payette Quarter Zip' && __t.q('.tb-after')?.textContent === 'Trail Quarter Zip'`));
await shot('sample-content-editor.png');
p = await ev(`__t.center([...__t.q('[data-panel="content-editor"]').querySelectorAll('.tb-links button')].find((b) => b.textContent.includes('Copy')))`);
await click(p.x, p.y);
clip = await readClipboard();
check('Copy edits gives before → after', clip.includes('"Payette Quarter Zip" → "Trail Quarter Zip"'), clip.split('\n')[1]);
p = await ev(`__t.center(__t.q('.tb-panel-foot .tb-pill'))`);
await click(p.x, p.y);
await sleep(200);
clip = await readClipboard();
let robots = null;
try { robots = JSON.parse(clip); } catch {}
check('Copy for AI gives JSON with page, selector and edits', robots?.tool === 'Content editor' && robots.page.includes('/sample.html') && robots.data.edits[0].selector.includes('nth-child'), clip.replace(/\s+/g, ' ').slice(0, 100));

// ---- 5. Copy to Figma

p = await ev(`__t.tool('figma')`);
await click(p.x, p.y);
check('Figma button offers Section or Page', await ev(`[...__t.sr().querySelectorAll('.tb-flyout button')].map((b) => b.textContent).join() === 'Section,Page'`));
check('content editor closed when Figma opened', !(await ev(`Boolean(__t.q('[data-panel="content-editor"]'))`)));
p = await ev(`__t.center([...__t.sr().querySelectorAll('.tb-flyout button')].find((b) => b.textContent === 'Section'))`);
await click(p.x, p.y);
const card = await ev(`__t.center(document.querySelectorAll('.card')[1])`);
await hover(card.x, card.y + card.h / 2 - 20);
await key('ArrowUp', 'ArrowUp', 38);
await key('ArrowUp', 'ArrowUp', 38);
check('picking outlines a section', await ev(`Boolean(__t.q('.tb-figma-outline'))`));
await shot('sample-figma-pick.png');
await click(card.x, card.y + card.h / 2 - 20);
await sleep(400);
clip = await readClipboard();
check('click copies the section as SVG with layer metadata', clip.startsWith('<svg') && clip.includes('<metadata id="prototype-section">') && clip.toLowerCase().includes('teton zip jacket'), `${(clip.length / 1024).toFixed(1)} KB`);
check('a toast says what was copied', await ev(`(__t.q('.tb-toast')?.textContent ?? '').includes('Copied')`));
await shot('sample-figma-copied.png');

// ---- 5b. Annotate

p = await ev(`__t.tool('annotate')`);
await click(p.x, p.y);
check('annotate opens its panel', await ev(`Boolean(__t.q('[data-panel="annotate"]'))`));
await ev(`document.querySelector('#shop').scrollIntoView({ block: 'start' })`);
await sleep(200);
const pinAt = await ev(`__t.center(document.querySelectorAll('.card img')[0])`);
await click(pinAt.x, pinAt.y);
await sleep(100);
check('a click drops a pin and opens a note', await ev(`Boolean(__t.q('.tb-pin')) && __t.sr().activeElement === __t.q('.tb-note-field')`));
await send('Input.insertText', { text: 'Add another product angle' });
await key('Enter', 'Enter', 13);
await sleep(100);
check('Enter saves the note to the list', (await ev(`__t.q('[data-panel="annotate"] .tb-note-text')?.textContent`)) === 'Add another product angle');
const pinBefore = await ev(`__t.center(__t.q('.tb-pin'))`);
await ev('scrollBy(0, 120)');
await sleep(150);
const pinAfter = await ev(`__t.center(__t.q('.tb-pin'))`);
check('the pin follows its element as the page scrolls', Math.round(pinBefore.y - pinAfter.y) === 120, `${pinBefore.y} → ${pinAfter.y}`);
await shot('sample-annotate.png');
p = await ev(`__t.center([...__t.q('[data-panel="annotate"]').querySelectorAll('.tb-links button')].find((b) => b.textContent.includes('Copy')))`);
await click(p.x, p.y);
clip = await readClipboard();
check('Copy notes gives a numbered list', clip.includes('1. ') && clip.includes('Add another product angle'), clip.split('\n')[1]);
p = await ev(`__t.center(__t.q('[data-panel="annotate"] .tb-pill'))`);
await click(p.x, p.y);
await sleep(200);
clip = await readClipboard();
robots = null;
try { robots = JSON.parse(clip); } catch {}
check('Copy for AI gives JSON with each note and its selector', robots?.tool === 'Annotate' && robots.data.notes[0].note === 'Add another product angle' && robots.data.notes[0].selector.includes('nth-child'), clip.replace(/\s+/g, ' ').slice(0, 100));

// Putting the toolbox away closes the tools and gives the page its clicks back.
p = await ev(`__t.tool('style')`);
await click(p.x, p.y);
await runBookmarklet();
await ev('scrollTo(0, 0)');
await sleep(150);
const quiz2 = await ev(`__t.center(document.querySelector('.btn-secondary'))`);
await click(quiz2.x, quiz2.y);
await sleep(300);
check('after toggling off, page clicks work again', (await ev('__alerts.length')) === 1, await ev('__alerts[0]'));
c = await counts();
check('still one host and one script after all that', c.hosts === 1 && c.scripts === 1, JSON.stringify(c));

// ---- 6. Strict CSP pages

for (const [url, label] of [
  ['http://localhost:4174/', "script-src 'self'"],
  ['http://localhost:4174/tt', 'Trusted Types'],
]) {
  await go(url);
  const n = dialogs.length;
  await ev(bookmarklet);
  for (let i = 0; i < 30 && dialogs.length === n; i++) await sleep(100);
  const state = await ev(`({ hosts: document.querySelectorAll('prototype-toolbox').length, scripts: document.querySelectorAll('script[data-prototype-toolbox-script]').length, loading: Boolean(window.__prototypeToolboxLoading) })`);
  check(`CSP (${label}): alerts and cleans up`, dialogs.length === n + 1 && /couldn't load/.test(dialogs.at(-1)) && state.hosts === 0 && state.scripts === 0 && !state.loading, `${dialogs.at(-1)} ${JSON.stringify(state)}`);
}

// ---- 7. Landing page

await go(`${BASE}/`);
await helpers();
c = await counts();
check('landing page runs the real toolbox', c.hosts === 1 && c.scripts === 1 && c.shown === true && c.tools === 5, JSON.stringify(c));
const href = await ev(`document.getElementById('bookmarklet').getAttribute('href')`);
check('landing page link is the bookmarklet', href === `javascript:${bookmarklet}`);
check('manual install code matches the link', (await ev(`document.getElementById('code').textContent`)) === href);
await ev(bookmarklet);
await sleep(300);
c = await counts();
check('bookmarklet on the landing page toggles, never re-injects', c.shown === false && c.hosts === 1 && c.scripts === 1, JSON.stringify(c));
await ev(bookmarklet);
await sleep(400);
const hScroll = await ev('document.documentElement.scrollWidth > innerWidth');
check('no horizontal scroll at desktop width', !hScroll);
await shot('landing-desktop.png');
await shot('landing-desktop-full.png', true);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await sleep(200);
await shot('landing-desktop-dark.png');
await send('Emulation.setEmulatedMedia', { features: [] });

await go(`${BASE}/`, 390, 844);
await helpers();
c = await counts();
check('on a phone the landing page shows just the toolbox button', c.hosts === 1 && c.shown === true && c.trayOpen === 'false', JSON.stringify(c));
check('no horizontal scroll at 390px', !(await ev('document.documentElement.scrollWidth > innerWidth')), String(await ev('document.documentElement.scrollWidth')));
await shot('landing-phone.png');
await shot('landing-phone-full.png', true);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await sleep(200);
await shot('landing-phone-dark.png');
await send('Emulation.setEmulatedMedia', { features: [] });

// The sample page on a phone, with the style tweaker open.
await go(`${BASE}/sample.html`, 390, 844);
await runBookmarklet();
await helpers();
p = await ev(`__t.tool('style')`);
await click(p.x, p.y);
const ph1 = await ev(`__t.center(document.querySelector('h1'))`);
await click(ph1.x, ph1.y);
await shot('sample-phone-style-tweaker.png');

// ---- Done

check('no script errors on any page', errors.length === 0, errors.slice(0, 3).join(' / '));
clearInterval(watchDialogs);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
ws.close();
chrome.kill('SIGKILL');
site.close();
csp.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
