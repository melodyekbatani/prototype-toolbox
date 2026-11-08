import { chromium, expect } from '@playwright/test';
import { serve } from '../scripts/serve.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const site = serve(path.join(root, 'dist'), 4183);
const fixture = http.createServer((req,res) => {
  const policy = req.url === '/strict' ? "script-src 'none'; style-src 'none'; require-trusted-types-for 'script'" : '';
  res.writeHead(200, { 'Content-Type':'text/html', ...(policy ? {'Content-Security-Policy':policy} : {}) });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Toolbox fixture</title></head><body>
  <h1 id="title" style="font-size:32px!important;color:rgb(10,20,30)">A real heading</h1>
  <p id="mixed">Original <strong id="nested">nested label</strong> stays interactive.</p>
  <button id="page-button">Page action</button>
  <div id="card" style="width:250px;height:150px;background:#cadbd2;transform:rotate(5deg)">Movable card</div>
  <div id="shadow-host"></div><p>Public page content for export</p></body></html>`);
}).listen(4184);
let context;
const results=[];
async function check(name, fn) {
  await fn(); results.push(name); console.log('PASS',name);
}
try {
  context = await chromium.launchPersistentContext('', {
    channel:'chromium', headless:true, viewport:{width:1440,height:1000},
    args:[`--disable-extensions-except=${root}/extension-dist`,`--load-extension=${root}/extension-dist`,'--enable-unsafe-extension-debugging'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.action.onClicked.hasListeners());
  const page = context.pages()[0];
  const session = await context.newCDPSession(page);
  const {targetInfo} = await session.send('Target.getTargetInfo');
  const browserSession = await context.browser().newBrowserCDPSession();
  await context.grantPermissions(['clipboard-read'], {origin:'http://localhost:4184'});
  const clip = () => page.evaluate(()=>navigator.clipboard.readText());
  const errors=[];
  await session.send('Runtime.enable');
  session.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
  async function toggle() {
    await page.bringToFront();
    const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{type:'tab', exclude:false}] });
    const tab = targetInfos.find(t => t.url === page.url());
    if (!tab) throw new Error(JSON.stringify(targetInfos));
    await browserSession.send('Extensions.triggerAction',{id,targetId:tab.targetId});
  }
  const host=page.locator('prototype-toolbox[data-runtime="extension"]');
  const tool=(name)=>host.getByRole('button',{name,exact:true});
  async function open(url) {
    await page.goto(url); await toggle();
    try { await expect(host.locator('.tb-app')).toHaveAttribute('data-shown','true'); } catch(e) { console.log('ACTION',await worker.evaluate(async()=>Promise.all((await chrome.tabs.query({})).map(async t=>({id:t.id,url:t.url,title:await chrome.action.getTitle({tabId:t.id})}))))); console.log('ERRORS',errors); throw e; }
  }
  // Verify the production package with an actual browser action/activeTab grant.
  await check('Toolbar action injects bundled tools on strict CSP + Trusted Types',async()=>{
    await open('http://localhost:4184/strict');
    await expect(host.locator('.tb-tool')).toHaveCount(5);
    expect(await page.evaluate(()=>window.__prototypeToolbox)).toBeUndefined();
  });
  await check('Toolbar action toggles without duplicate hosts',async()=>{
    await toggle(); await expect(host.locator('.tb-app')).toHaveAttribute('data-shown','false');
    await toggle(); await expect(host.locator('.tb-app')).toHaveAttribute('data-shown','true');
    await expect(host).toHaveCount(1);
  });
  await check('Style changes affect the page under strict CSP; reset restores inline value and priority',async()=>{
    await page.locator('#title').evaluate(el => el.style.setProperty('font-size', '32px', 'important'));
    await tool('Style tweaker').click(); await page.locator('#title').click();
    await host.getByRole('button',{name:'More Size',exact:true}).click();
    expect(await page.locator('#title').evaluate(el=>getComputedStyle(el).fontSize)).not.toBe('32px');
    await host.getByRole('button',{name:'Reset all',exact:true}).click();
    expect(await page.locator('#title').evaluate(el=>[el.style.fontSize,el.style.getPropertyPriority('font-size')])).toEqual(['32px','important']);
  });
  await check('Content editor edits real text and undo restores child nodes and listeners',async()=>{
    await tool('Content editor').click();
    await page.evaluate(()=>{window.nestedClicks=0;document.querySelector('#nested').addEventListener('click',()=>window.nestedClicks++);});
    await page.locator('#mixed').click({position:{x:8,y:8}});
    await expect(page.locator('#mixed')).toHaveAttribute('contenteditable','plaintext-only');
    await page.locator('#mixed').fill('Changed text'); await page.keyboard.press('Enter');
    await expect(page.locator('#mixed')).toHaveText('Changed text');
    await host.getByRole('button',{name:'Undo this edit',exact:true}).click();
    await expect(page.locator('#nested')).toHaveText('nested label');
    await tool('Close content editor').click();
    await page.locator('#nested').click();
    expect(await page.evaluate(()=>window.nestedClicks)).toBe(1);
  });
  await check('Annotations save, edit, export, and delete',async()=>{
    await tool('Annotate').click(); await page.locator('#title').click();
    await host.locator('.tb-note-field').fill('Make this clearer');
    await host.locator('.tb-note-field').press('Enter');
    await expect(host.locator('.tb-note-text')).toHaveText('Make this clearer');
    await host.getByRole('button',{name:'Note 1',exact:true}).click();
    await host.locator('.tb-note-field').fill('A revised note'); await host.locator('.tb-note-field').press('Enter');
    await expect(host.locator('.tb-note-text')).toHaveText('A revised note');
    await host.getByRole('button',{name:'Copy notes',exact:true}).click();
    await expect(host.getByRole('button',{name:'Copied',exact:true})).toBeVisible();
    expect(await clip()).toContain('A revised note');
    await host.getByLabel('Instructions for your AI').fill('Use our existing spacing tokens');
    await host.getByRole('button',{name:'Copy for AI',exact:true}).click();
    await expect.poll(async()=>JSON.parse(await clip()).schemaVersion).toBe(1);
    const brief=JSON.parse(await clip());
    expect(brief.data.notes[0].note).toBe('A revised note');
    expect(brief.note).toBe('Use our existing spacing tokens');
    expect(brief.instructions).toContain('source project');
    expect(brief.page).toContain('/strict');
    expect(brief.viewport.width).toBe(1440);
    const briefDownload=page.waitForEvent('download');
    await host.getByRole('button',{name:'Download brief',exact:true}).click();
    const downloaded=JSON.parse(fs.readFileSync(await (await briefDownload).path(),'utf8'));
    expect(downloaded.data).toEqual(brief.data);
    await host.getByRole('button',{name:'Delete this note',exact:true}).click();
    await expect(host.locator('.tb-pin')).toHaveCount(0);
  });
  await check('Arranger moves, rotates, scales, flips, exports, and resets',async()=>{
    await page.locator('#card').evaluate(el=>{Object.assign(el.style,{width:'250px',height:'150px',background:'#cadbd2',transform:'rotate(5deg)'});});
    await tool('Arranger').click();
    await expect(host.locator('[data-panel=arranger]')).toBeVisible();
    const box=await page.locator('#card').boundingBox();
    await page.mouse.move(box.x+30,box.y+20); await page.mouse.down();
    await page.mouse.move(box.x+90,box.y+60,{steps:10}); await page.mouse.up();
    await expect.poll(()=>page.locator('#card').evaluate(el=>el.style.transform)).toContain('translate(');
    await host.getByLabel('Rotate',{exact:true}).fill('30');
    await host.getByLabel('Scale',{exact:true}).fill('1.5');
    await expect.poll(()=>page.locator('#card').evaluate(el=>el.style.transform)).toContain('rotate(30deg)');
    await expect.poll(()=>page.locator('#card').evaluate(el=>el.style.transform)).toContain('scale(1.5');
    await host.getByRole('button',{name:'Flip horizontal',exact:true}).click();
    await expect.poll(()=>page.locator('#card').evaluate(el=>el.style.transform)).toContain('-1.5');
    await host.getByRole('button',{name:'Copy values',exact:true}).click();
    await expect(host.getByRole('button',{name:'Copied',exact:true})).toBeVisible();
    const values = Object.values(JSON.parse(await clip())); expect(values[0].rotate).toBe(30); expect(values[0].scale).toBe(1.5);
    await host.getByRole('button',{name:'Reset all',exact:true}).click();
    await expect.poll(()=>page.locator('#card').evaluate(el=>el.style.transform)).toBe('rotate(5deg)');
  });
  await check('Figma export produces valid SVG with real text and downloadable layers',async()=>{
    await tool('Copy to Figma').click(); await host.getByRole('button',{name:'Section',exact:true}).click();
    await page.locator('#title').hover(); await page.locator('#title').click();
    await expect(host.getByRole('status')).toContainText('Copied');
    const downloadEvent=page.waitForEvent('download');
    await host.getByRole('button',{name:'Download SVG',exact:true}).click();
    const download=await downloadEvent; const svg=fs.readFileSync(await download.path(),'utf8');
    expect(svg).toContain('A real heading'); expect(svg).toContain('<svg'); expect(svg).toContain('prototype-section');
    const validator=await context.newPage();
    const valid=await validator.evaluate(s=>!new DOMParser().parseFromString(s,'image/svg+xml').querySelector('parsererror'),svg);
    await validator.close();
    expect(valid).toBe(true);
  });
  await check('Closing restores normal page interactions',async()=>{
    await page.evaluate(()=>{window.clicks=0;document.querySelector('#page-button').addEventListener('click',()=>window.clicks++);});
    await tool('Annotate').click(); await toggle(); await page.locator('#page-button').click();
    expect(await page.evaluate(()=>window.clicks)).toBe(1);
  });
  await check('Clipboard denial reports failure instead of a false success', async()=>{
    await open('http://localhost:4184/');
    await tool('Annotate').click(); await page.locator('#title').click();
    await host.locator('.tb-note-field').fill('Keep this note'); await host.locator('.tb-note-field').press('Enter');
    await worker.evaluate(async()=>{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
        window.savedCopy = navigator.clipboard.writeText.bind(navigator.clipboard);
        window.savedExec = document.execCommand.bind(document);
        navigator.clipboard.writeText = async()=>{throw new Error('Denied for test')};
        document.execCommand = ()=>false;
      }});
    });
    await host.getByRole('button',{name:'Copy notes',exact:true}).click();
    await expect(host.getByRole('button',{name:'Copy failed · retry',exact:true})).toBeVisible();
    await expect(host.getByRole('button',{name:'Copied',exact:true})).toHaveCount(0);
    await worker.evaluate(async()=>{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
        navigator.clipboard.writeText=window.savedCopy; document.execCommand=window.savedExec;
      }});
    });
    await host.getByRole('button',{name:'Copy failed · retry',exact:true}).click();
    await expect(host.getByRole('button',{name:'Copied',exact:true})).toBeVisible();
    expect(await clip()).toContain('Keep this note');
  });
  await check('Open web components can be styled and exported with usable selectors',async()=>{
    await open('http://localhost:4184/');
    await page.evaluate(()=>{
      const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});
      const p=document.createElement('p');p.id='inside';p.textContent='Inside a component';root.append(p);
    });
    await tool('Style tweaker').click(); await page.locator('#inside').click();
    await host.getByRole('button',{name:'More Size',exact:true}).click();
    await host.getByRole('button',{name:'Copy edits',exact:true}).click();
    await expect(host.getByRole('button',{name:'Copied',exact:true})).toBeVisible();
    expect(await clip()).toContain('#shadow-host >>> #inside');
  });
  await check('Reload clears edits; the toolbar opens again without remote code',async()=>{
    await page.reload(); await expect(host).toHaveCount(0);
    await toggle(); await expect(host.locator('.tb-app')).toHaveAttribute('data-shown','true');
  });
  await check('Opening the extension closes the landing-page demo and its pickers',async()=>{
    await page.goto('http://localhost:4183/');
    const demo=page.locator('prototype-toolbox[data-runtime="bookmarklet"]');
    await demo.getByRole('button',{name:'Style tweaker',exact:true}).click();
    await toggle();
    await expect(demo.locator('.tb-app')).toHaveAttribute('data-shown','false');
    await expect(host.locator('.tb-app')).toHaveAttribute('data-shown','true');
    await expect(demo.locator('[data-panel="style-tweaker"]')).toHaveCount(0);
  });
  await check('Protected browser pages show a real error state',async()=>{
    await page.goto('chrome://version'); await toggle();
    await expect.poll(()=>worker.evaluate(async()=>{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return chrome.action.getBadgeText({tabId:tab.id});
    })).toBe('!');
    const title=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return chrome.action.getTitle({tabId:tab.id});});
    expect(title).toContain('protected');
  });
  await check('No runtime errors',async()=>expect(errors).toEqual([]));
  await fs.promises.mkdir(path.join(root,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-results/extension.png')});
  console.log(`${results.length} extension checks passed`);
} finally { await context?.close(); site.close(); fixture.close(); }
