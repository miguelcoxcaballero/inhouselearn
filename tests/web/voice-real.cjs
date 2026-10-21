// Opt-in integration test: downloads real local voice/recognition models (~310 MB).
const assert = require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const context=await chromium.launchPersistentContext(process.env.VOICE_TEST_PROFILE || '/tmp/inhouse-voice-test-profile', {executablePath:process.env.CHROMIUM || '/usr/bin/chromium', headless:true,ignoreHTTPSErrors:true,proxy:process.env.HTTPS_PROXY?{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}:undefined});
 try {
 const page=await context.newPage();
 page.on('console',m=>{if(m.text().startsWith('VOICE') || m.type()==='warning' || m.type()==='error')console.log(m.text())});
 await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8765/index.html');
 const output=await page.evaluate(async()=>{
  const request=(worker,data)=>new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{worker.terminate();reject(Error('Model timeout'));},240000);
   worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message))};
   worker.onmessage=({data})=>{if(data.type==='progress'){console.log('VOICE '+data.text);return;} clearTimeout(timer);if(data.type==='error')reject(Error(data.text||'Inference error'));else resolve(data);};worker.postMessage(data);
  });
  const speaker=new Worker('read-aloud-worker.js',{type:'module'});
  const spanish=await request(speaker,{text:'Hola. Quiero aprender la historia de España.',lang:'es',style:'F2',rate:1});
  const english=await request(speaker,{text:'The children were playing in the garden.',lang:'en',style:'F5',rate:1});
  speaker.terminate();
  const offline=new OfflineAudioContext(1,Math.ceil(spanish.pcm.length/spanish.sampleRate*16000),16000);
  const buffer=offline.createBuffer(1,spanish.pcm.length,spanish.sampleRate);buffer.copyToChannel(spanish.pcm,0);
  const source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();
  const audio=(await offline.startRendering()).getChannelData(0);
  const listener=new Worker('dictation-worker.js',{type:'module'});
  const transcript=await request(listener,{audio,model:'base',language:'es'});listener.terminate();
  return {spanish:{samples:spanish.pcm.length,finite:spanish.pcm.every(Number.isFinite)},english:{samples:english.pcm.length,finite:english.pcm.every(Number.isFinite)},transcript:transcript.text};
 });
 console.log(output);assert.ok(output.spanish.samples>1000&&output.spanish.finite);assert.ok(output.english.samples>1000&&output.english.finite);assert.match(output.transcript,/historia.*Espa[ñn]a/i);
 console.log('PASS real Carmen + Lucy synthesis and real local Whisper Spanish transcription');
 } finally {await context.close();}
})().catch(e=>{console.error(e);process.exit(1)});
