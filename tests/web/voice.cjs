const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { openApp, idle } = require('./mock.cjs');
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
 try {
  const {page, errors} = await openApp(browser, devices['Pixel 7']);
  await page.evaluate(() => {
   window.__voiceJobs = []; window.__voiceWorkers = []; window.__stoppedTracks = 0;
   navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext(), oscillator = context.createOscillator(), output = context.createMediaStreamDestination();
    oscillator.connect(output); oscillator.start(); await context.resume();
    const track = output.stream.getTracks()[0], original = track.stop.bind(track);
    track.stop = () => { window.__stoppedTracks++; original(); context.close().catch(() => {}); };
    return output.stream;
   };
   window.Worker = class {
    constructor(url) { this.url = url; window.__voiceWorkers.push(this); }
    terminate() { this.terminated = true; }
    postMessage(data) { window.__voiceJobs.push({worker: this.url, ...data, audio: data.audio?.length});
     if (this.url.startsWith('dictation')) {
      if (window.__holdVoice) return;
      setTimeout(() => this.onmessage?.({data: window.__voiceError ? {type: 'error'} : {type:'result',text:'Quiero aprender la historia de España.'}}), 30);
     } else setTimeout(() => this.onmessage?.({data:{type:'audio',pcm:new Float32Array(24000),sampleRate:24000}}),30);
    }
   };
  });
  await page.click('#dictation-btn');
  assert.equal(await page.locator('#dictation-settings').evaluate(el => el.open),true);
  assert.equal(await page.locator('#dictation-settings input[type=password]').count(),0);
  await page.click('#dictation-settings [type=submit]');
  await page.fill('#composer','Mi pregunta:');
  await page.click('#dictation-btn');
  await page.waitForFunction(()=>document.querySelector('#dictation-panel').dataset.state==='recording');
  await page.waitForTimeout(500); await page.click('[data-voice=review]');
  await page.waitForFunction(()=>document.querySelector('#dictation-panel').hidden);
  assert.equal(await page.inputValue('#composer'),'Mi pregunta:\nQuiero aprender la historia de España.');
  assert.ok(await page.evaluate(()=>__stoppedTracks>0));
  assert.equal(await page.evaluate(()=>__requests.length),0);
  console.log('PASS local dictation setup, real MediaRecorder, review, draft preservation and mic release');
  await page.fill('#composer',''); await page.click('#dictation-btn'); await page.waitForTimeout(500); await page.click('#send-btn');
  await page.waitForFunction(()=>__requests.length===1); await idle(page);
  assert.ok(await page.evaluate(()=>getActiveChat().messages.some(m=>m.role==='user'&&m.content.includes('historia de España'))));
  console.log('PASS recording → transcribe → send exactly once');
  await page.evaluate(()=>window.__voiceError=true);
  await page.click('#dictation-btn');await page.waitForTimeout(500);await page.click('[data-voice=review]');
  await page.waitForFunction(()=>document.querySelector('#dictation-panel').dataset.state==='error');
  await page.evaluate(()=>window.__voiceError=false);await page.click('[data-voice=retry]');
  await page.waitForFunction(()=>document.querySelector('#dictation-panel').hidden);
  assert.match(await page.inputValue('#composer'),/España/);
  console.log('PASS failed inference retains audio for retry');
  await page.evaluate(()=>window.__holdVoice=true);
  await page.click('#dictation-btn');await page.waitForTimeout(500);await page.click('#send-btn');
  await page.waitForFunction(()=>document.querySelector('#dictation-panel').dataset.state==='transcribing');
  await page.evaluate(()=>{ window.__stale = __voiceWorkers.at(-1); newChat(); __stale.onmessage({data:{type:'result',text:'Do not send this'}}); });
  assert.equal(await page.evaluate(()=>__requests.length),1);
  assert.ok(await page.evaluate(()=>__stale.terminated));
  console.log('PASS chat switch cancels inference and ignores late transcripts');
  await page.evaluate(()=>InhouseReadAloud.play('Esta es una frase en español. The children were playing in the garden and they were very happy.'));
  assert.equal(await page.locator('#read-aloud-settings').evaluate(el=>el.open),true);
  assert.equal(await page.inputValue('#read-aloud-settings [name=voice]:checked'),'F2');
  await page.selectOption('#read-aloud-settings [name=voice-language]','en');
  assert.equal(await page.inputValue('#read-aloud-settings [name=voice]:checked'),'F5');
  await page.click('#read-aloud-settings [type=submit]');
  await page.waitForFunction(()=>__voiceJobs.filter(j=>j.worker.startsWith('read-aloud')).length===2);
  const voices = await page.evaluate(()=>__voiceJobs.filter(j=>j.worker.startsWith('read-aloud')).map(j=>[j.lang,j.style]));
  assert.deepEqual(voices,[['es','F2'],['en','F5']]);
  await page.click('[data-read=pause]'); assert.match(await page.textContent('.read-aloud-status'),/pausa/);
  await page.click('[data-read=pause]'); await page.click('[data-read=stop]');
  assert.equal(await page.locator('.read-aloud-bar').isVisible(),false);
  console.log('PASS same Carmen/Lucy profiles, language detection, playback pause/resume/stop');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path:'/tmp/shots/voice-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1)});
