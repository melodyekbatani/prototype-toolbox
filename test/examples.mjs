// Actual extension screenshots for the landing page; no simulated tool UI.
import { chromium, expect } from '@playwright/test';
import { serve } from '../scripts/serve.mjs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const site=serve(path.join(root,'dist'),4185);
let context;
try {
  context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,viewport:{width:1120,height:700},deviceScaleFactor:2,args:[`--disable-extensions-except=${root}/extension-dist`,`--load-extension=${root}/extension-dist`,'--enable-unsafe-extension-debugging']});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  await worker.evaluate(()=>chrome.action.onClicked.hasListeners());
  const id=new URL(worker.url()).host;
  const session=await context.browser().newBrowserCDPSession();
  const page=context.pages()[0];
  const host=page.locator('prototype-toolbox[data-runtime="extension"]');
  const tool=name=>host.getByRole('button',{name,exact:true});
  async function open(){
    await page.goto('http://localhost:4185/sample.html');
    await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode().catch(()=>{}))));
    const {targetInfos}=await session.send('Target.getTargets',{filter:[{type:'tab',exclude:false}]});
    await session.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===page.url()).targetId});
    await expect(tool('Style tweaker')).toBeVisible();
  }
  async function shot(name){
    await page.mouse.move(10,10);
    await page.screenshot({path:path.join(root,'site/examples',name+'.jpg'),type:'jpeg',quality:90,animations:'disabled'});
    console.log('Captured',name);
  }
  await open();
  await tool('Style tweaker').click(); await page.locator('h1').click();
  await tool('More Size').click();
  await host.getByLabel('Colour',{exact:true}).fill('#ffffff');
  await shot('style-tweaker');

  await open();
  await page.locator('.cards').scrollIntoViewIfNeeded();
  await tool('Arranger').click();
  const box=await page.locator('.card img').first().boundingBox();
  await page.mouse.move(box.x+100,box.y+100);await page.mouse.down();
  await page.mouse.move(box.x+118,box.y+115,{steps:12});await page.mouse.up();
  await host.getByLabel('Rotate',{exact:true}).fill('8');
  await host.getByLabel('Scale',{exact:true}).fill('0.9');
  await shot('arranger');

  await open();
  await tool('Content editor').click();await page.locator('h1').click();
  await page.locator('h1').fill('Go your own way');await page.keyboard.press('Enter');
  await host.getByLabel('Instructions for your AI').fill('Keep the headline short and direct.');
  await shot('content-editor');

  await open();
  await tool('Copy to Figma').click();await tool('Section').click();
  await page.locator('h1').hover();await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');
  // Keep the actual selected outline visible for the screenshot.
  await page.screenshot({path:path.join(root,'site/examples/figma.jpg'),type:'jpeg',quality:90,animations:'disabled'});
  console.log('Captured figma');

  await open();
  await page.locator('.cards').scrollIntoViewIfNeeded();
  await tool('Annotate').click();await page.locator('.card img').first().click();
  await host.locator('.tb-note-field').fill('Show a second angle of the jacket.');
  await host.locator('.tb-note-field').press('Enter');
  await shot('annotate');
} finally {await context?.close();site.close();}
