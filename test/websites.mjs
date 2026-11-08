import { chromium, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
const root=path.resolve(import.meta.dirname,'..');
const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${root}/extension-dist`,`--load-extension=${root}/extension-dist`,'--enable-unsafe-extension-debugging']});
try {
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  await worker.evaluate(()=>chrome.action.onClicked.hasListeners());
  const id=new URL(worker.url()).host;
  const browser=await context.browser().newBrowserCDPSession();
  const page=context.pages()[0];
  const host=page.locator('prototype-toolbox[data-runtime="extension"]');
  for(const url of ['https://example.com','https://github.com/melodyekbatani/prototype-toolbox','https://developer.chrome.com/docs/extensions']) {
    const response = await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    console.log('Loaded', url, response?.status(), await page.title());
    const heading=page.locator(new URL(url).hostname === 'github.com' ? 'article h1' : 'p:visible').first();
    try { await heading.waitFor({state:'visible',timeout:10000}); } catch {
      console.log('Page response:', (await page.locator('body').innerText()).slice(0,500));
      throw new Error(`No visible heading on ${url}; cannot verify a real edit`);
    }
    await page.bringToFront();
    const {targetInfos}=await browser.send('Target.getTargets',{filter:[{type:'tab',exclude:false}]});
    await browser.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===page.url()).targetId});
    await expect(host.locator('.tb-app')).toHaveAttribute('data-shown','true');
    await expect(host.locator('.tb-tool')).toHaveCount(5);
    await heading.scrollIntoViewIfNeeded();
    const before=await heading.evaluate(el=>getComputedStyle(el).fontSize);
    await host.getByRole('button',{name:'Style tweaker',exact:true}).click();
    await heading.click();
    await host.getByRole('button',{name:'More Size',exact:true}).click();
    await expect.poll(()=>heading.evaluate(el=>getComputedStyle(el).fontSize)).not.toBe(before);
    await host.getByRole('button',{name:'Reset all',exact:true}).click();
    await expect.poll(()=>heading.evaluate(el=>getComputedStyle(el).fontSize)).toBe(before);
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results',`live-${new URL(url).hostname}.png`)});
    console.log('PASS real toolbar injection, style edit and undo:',url);
  }
} finally {await context.close();}
