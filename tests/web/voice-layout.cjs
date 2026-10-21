const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { openApp } = require('./mock.cjs');
(async () => {
 const browser = await chromium.launch({executablePath: process.env.CHROMIUM || '/usr/bin/chromium'});
 try {
  const {page,errors} = await openApp(browser,{viewport:{width:390,height:844}});
  await page.evaluate(() => {
   const chat=getActiveChat();
   chat.messages=[createMessage('assistant','La Segunda República comenzó en 1931. Vamos a estudiar sus principales reformas. Texto dañado: Президент.')];
   chat.messages[0].alternatives=[{content:'Una versión anterior de la explicación.'}];
   chat.messages[0].activeAlternative=1;
   renderThread();
   window.__readingJobs=[];
   window.Worker=class {
    postMessage(data){__readingJobs.push(data);setTimeout(()=>this.onmessage?.({data:{type:'audio',pcm:new Float32Array(160000),sampleRate:16000}}),10);}
    terminate(){}
   };
  });
  const button=page.locator('[data-listen-msg]');
  assert.equal((await button.textContent()).trim(),'');
  assert.equal(await button.locator('svg').count(),1);
  assert.equal(await button.getAttribute('aria-label'),'Leer en voz alta');
  for (const width of [320,360,390,768,1440]) {
   await page.setViewportSize({width,height:844});
   await button.scrollIntoViewIfNeeded();
   const overlap=await page.evaluate(()=>{
    const controls=[...document.querySelectorAll('.msg-actions button,.msg-nav-label')].map(n=>n.getBoundingClientRect());
    for(let i=0;i<controls.length;i++) {
     const a=controls[i];if(a.left<0||a.right>innerWidth+1)return 'outside viewport';
     for(const b of controls.slice(i+1))if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)return 'overlapping actions';
    }
    return null;
   });
   assert.equal(overlap,null,`message actions at ${width}px`);
   await button.click();
   const menu=page.locator('#read-aloud-settings');
   assert.equal(await menu.evaluate(el=>el.open),true);
   const geometry=await menu.evaluate(el=>{const r=el.getBoundingClientRect();return {inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:el.scrollWidth>el.clientWidth};});
   assert.deepEqual(geometry,{inside:true,overflow:false});
   await page.waitForTimeout(220);
   if(width===390||width===1440)await page.screenshot({path:`/tmp/shots/voice-menu-${width}.png`});
   await page.keyboard.press('Escape');
  }
  console.log('PASS icon-only action, no collisions including repair/version controls, menu fits 320–1440px');
  await page.setViewportSize({width:390,height:844});
  await button.click();
  await page.selectOption('#read-aloud-settings [name=voice-language]','en');
  await page.getByRole('radio',{name:'Grace',exact:true}).check();
  await page.selectOption('#read-aloud-settings [name=voice-language]','es');
  assert.equal(await page.getByRole('radio',{name:'Carmen',exact:true}).isChecked(),true);
  await page.click('#read-aloud-settings [type=submit]');
  await page.waitForFunction(()=>__readingJobs.length>0);
  assert.ok(await page.evaluate(()=>__readingJobs[0].text.includes('La Segunda República')));
  await page.click('[data-read=stop]');
  await page.evaluate(()=>InhouseReadAloud.configure());
  await page.selectOption('#read-aloud-settings [name=voice-language]','en');
  assert.equal(await page.getByRole('radio',{name:'Grace',exact:true}).isChecked(),true);
  // Radio navigation stays native and saving keeps the selected language's voice.
  await page.getByRole('radio',{name:'Grace',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio',{name:'Hannah',exact:true}).isChecked(),true);
  await page.setViewportSize({width:320,height:400});
  await page.locator('#read-aloud-settings [type=submit]').scrollIntoViewIfNeeded();
  await page.click('#read-aloud-settings [type=submit]');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('inhouseLearn.readAloud.v1')).voices.en),'F4');
  await page.setViewportSize({width:390,height:844});
  await button.scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/shots/voice-actions-390.png'});
  console.log('PASS real message icon opens reader; per-language selection, persistence, keyboard and short-screen scrolling');
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
