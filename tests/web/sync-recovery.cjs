const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { openApp, BASE } = require('./mock.cjs');
const files = new Map();
let serial = 0, failWrites = 0, conflicts = 0, race = false;
const chat = (id, content = id) => ({id,title:content,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',messages:[{id:id+'-msg',role:'user',content,createdAt:'2026-01-01T00:00:00Z'}]});
function version(file) { file.modifiedTime = new Date(Date.now() + ++serial).toISOString(); file.etag = '"v'+serial+'"'; }
function add(id, meta, data) {const f={id,...meta,content:data ? JSON.stringify(data):''};version(f);files.set(id,f);return f;}
function snapshot(chats) { return {version:1,chats,activeChatId:chats[0]?.id||'',deletedChats:{}}; }
function multipart(req) {
 const boundary = /boundary=([^;]+)/.exec(req.headers()['content-type'])[1];
 const parts=req.postData().split('--'+boundary).slice(1,-1).map(p=>p.replace(/^\r\n/,'').split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/,''));
 return {meta:JSON.parse(parts[0]),content:parts[1]};
}
async function drive(route) {
 const req=route.request(),url=new URL(req.url());
 const json=(data,status=200,headers={})=>route.fulfill({status,headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
 if(url.pathname.includes('userinfo'))return json({email:'sync-test@example.com',name:'Sync test'});
 if(req.headers().authorization==='Bearer expired-test-token')return json({},401);
 if(req.method()==='DELETE'){files.delete(decodeURIComponent((url.pathname.match(/\/files\/([^/]+)$/)||[])[1]||''));return route.fulfill({status:204,body:''});}
 const id=decodeURIComponent((url.pathname.match(/\/files\/([^/]+)$/)||[])[1]||'');
 if(req.method()==='GET'&&!id) {
  const q=url.searchParams.get('q')||'',props=[...q.matchAll(/key='([^']+)' and value='([^']*)'/g)].map(m=>[m[1],m[2]]);
  const name=(/name='([^']+)'/.exec(q)||[])[1],parent=(/'([^']+)' in parents/.exec(q)||[])[1],contains=(/name contains '([^']+)'/.exec(q)||[])[1];
  let found=[...files.values()].filter(f=>props.every(([k,v])=>f.appProperties?.[k]===v)&&(!name||f.name===name)&&(!parent||f.parents?.includes(parent))&&(!contains||f.name.includes(contains))&&(!q.includes("mimeType='application/vnd.google-apps.folder'")||f.mimeType==='application/vnd.google-apps.folder'));
  if(req.headers().authorization==='Bearer device-b')found.reverse();
  const offset=Number(url.searchParams.get('pageToken')||0),limit=1;
  return json({files:found.slice(offset,offset+limit).map(({content,etag,...f})=>f),nextPageToken:offset+limit<found.length?String(offset+limit):undefined});
 }
 if(req.method()==='GET') {
  const f=files.get(id);if(!f)return json({},404);
  if(url.searchParams.get('alt')==='media')return route.fulfill({status:200,headers:{'content-type':'application/json',etag:f.etag,'access-control-expose-headers':'etag'},body:f.content});
  return json({id,modifiedTime:f.modifiedTime},200,{etag:f.etag});
 }
 if(req.method()==='POST') {
  const {meta,content}=req.headers()['content-type']?.includes('multipart')?multipart(req):{meta:JSON.parse(req.postData()),content:''};
  const f=add('new-'+(++serial),meta);f.content=content;return json({id:f.id,modifiedTime:f.modifiedTime});
 }
 const f=files.get(id);if(!f)return json({},404);
 if(f.name==='conversations.json') {
  if(failWrites){failWrites--;return json({error:{message:'Temporary test failure'}},503);}
  if(race){race=false;const data=JSON.parse(f.content);data.chats.push(chat('concurrent'));f.content=JSON.stringify(data);version(f);}
  if(req.headers()['if-match']&&req.headers()['if-match']!==f.etag){conflicts++;return json({},412);}
 }
 if(req.headers()['content-type']?.includes('multipart'))Object.assign(f,multipart(req).meta,{content:multipart(req).content});else f.content=req.postData();
 version(f);return json({id,modifiedTime:f.modifiedTime});
}
async function device(browser,token) {
 const app=await openApp(browser,{viewport:{width:1000,height:800}});
 await app.context.route('https://www.googleapis.com/**',drive);
 await app.context.addInitScript(()=>{window.RTCPeerConnection=undefined;const original=window.fetch;window.__driveCache=[];window.fetch=(url,opts)=>{if(String(url).includes('googleapis.com/drive'))__driveCache.push(opts?.cache);return original(url,opts);};});
 await app.page.evaluate(token=>{const key='inhouseGeminiStandaloneV1';localStorage.setItem(key+'::oauthToken',JSON.stringify({accessToken:token,expiresAt:Date.now()+3600000}));localStorage.setItem(key+'::oauthRemember','1');localStorage.setItem(key+'::oauthHintEmail','sync-test@example.com');},token);
 await app.page.reload();
 await app.page.waitForFunction(()=>appState.driveReady,null,{timeout:15000});
 return app;
}
const waitSaved=page=>page.waitForFunction(()=>!appState.driveSyncTimer&&!appState.driveSyncPromise&&!appState.driveSyncQueued,null,{timeout:20000});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM||undefined});
 try {
  for(const id of ['folder-a','folder-b'])add(id,{name:'inhouse learn',mimeType:'application/vnd.google-apps.folder',appProperties:{inhouseLearnFolder:'1'}});
  add('history-a',{name:'conversations.json',parents:['folder-a'],appProperties:{inhouseLearnSnapshot:'1'}},snapshot([chat('only-a')]));
  add('history-b',{name:'conversations.json',parents:['folder-b'],appProperties:{inhouseLearnSnapshot:'1'}},snapshot([chat('only-b')]));
  add('history-c',{name:'conversations.json',parents:['folder-a'],appProperties:{inhouseLearnSnapshot:'1'}},snapshot([chat('only-c')]));
  const A=await device(browser,'device-a'),B=await device(browser,'device-b');
  for(const app of [A,B]) {
   assert.deepEqual(await app.page.evaluate(()=>appState.chats.map(c=>c.id).filter(id=>id.startsWith('only-')).sort()),['only-a','only-b','only-c']);
   assert.equal(await app.page.evaluate(()=>appState.driveFolderId),'folder-a');
   assert.equal(await app.page.evaluate(()=>appState.driveSnapshotFileId),'history-a');
  }
  console.log('PASS normal login bootstrap recovers all duplicate folders/files despite different list order and pagination');
  await waitSaved(A.page);await waitSaved(B.page);
  assert.ok(await A.page.evaluate(()=>__driveCache.length>0&&__driveCache.every(v=>v==='no-store')));
  // Save once, force a server failure, and leave the UI alone: it must retry.
  failWrites=1;
  await A.page.evaluate(()=>{const c=createChat();c.id='retry-chat';c.messages=[createMessage('user','Saved after a transient error')];appState.chats.push(c);saveState();});
  await waitSaved(A.page);
  assert.ok(JSON.parse(files.get('history-a').content).chats.some(c=>c.id==='retry-chat'));
  console.log('PASS failed upload retries automatically; mutable Drive reads bypass HTTP cache');
  // A concurrent write between GET and PATCH must be merged after a 412.
  race=true;
  await A.page.evaluate(()=>{const c=createChat();c.id='local-chat';c.messages=[createMessage('user','Local edit')];appState.chats.push(c);saveState();});
  await waitSaved(A.page);
  const ids=JSON.parse(files.get('history-a').content).chats.map(c=>c.id);
  assert.ok(conflicts>0&&ids.includes('concurrent')&&ids.includes('local-chat'),JSON.stringify({conflicts,ids}));
  console.log('PASS competing writes are re-read and merged after ETag conflict');
  // Existing bad live file must not prevent durable polling on the other device.
  add('broken-live',{name:'live.json',parents:['folder-a'],appProperties:{inhouseLearnLive:'1'}}).content='not json';
  await B.page.waitForFunction(()=>appState.chats.some(c=>c.id==='local-chat'),null,{timeout:15000});
  await A.context.close();
  await B.page.reload();await B.page.waitForFunction(()=>appState.driveReady&&appState.chats.some(c=>c.id==='retry-chat'),null,{timeout:15000});
  console.log('PASS history arrives without WebRTC despite broken live data, and survives reload with the source device closed');
  // Other chats still update while the local agent owns its active chat object.
  await B.page.evaluate(()=>{window.__running=getActiveChat();appState.busy=true;});
  const f=files.get('history-a'),remote=JSON.parse(f.content);remote.chats.push(chat('while-busy'));f.content=JSON.stringify(remote);version(f);
  await B.page.evaluate(()=>pullDriveChanges(true));
  assert.ok(await B.page.evaluate(()=>getActiveChat()===__running&&appState.chats.some(c=>c.id==='while-busy')));
  await B.page.evaluate(()=>appState.busy=false);
  console.log('PASS polling preserves the running agent object while importing other chats');
  const deleted=files.get('history-b');deleted.content=JSON.stringify({...snapshot([]),deletedChats:{'only-a':new Date().toISOString()}});version(deleted);
  await B.page.evaluate(()=>pullDriveChanges(true));
  assert.ok(await B.page.evaluate(()=>!appState.chats.some(c=>c.id==='only-a')&&appState.chats.some(c=>c.id==='only-c')));
  console.log('PASS an empty legacy snapshot still carries deletions without dropping other chats');
  // Two tabs share storage, but must not ignore each other's live messages.
  const tab=await B.context.newPage();await tab.goto(BASE);await tab.waitForFunction(()=>appState.driveReady);
  assert.notEqual(await B.page.evaluate(()=>liveDeviceId()),await tab.evaluate(()=>liveDeviceId()));
  await Promise.all([[B.page,'from-first-tab'],[tab,'from-second-tab']].map(([page,id])=>page.evaluate(async id=>{
   await writeLivePayload({v:1,device:liveDeviceId(),turn:id,seq:1,at:nowIso(),done:true,
    chat:{id,title:id,createdAt:nowIso(),updatedAt:nowIso()},messages:[createMessage('assistant',id)]});
  },id)));
  await Promise.all([
   B.page.waitForFunction(()=>appState.chats.some(c=>c.id==='from-second-tab'),null,{timeout:10000}),
   tab.waitForFunction(()=>appState.chats.some(c=>c.id==='from-first-tab'),null,{timeout:10000})
  ]);
  assert.notEqual(await B.page.evaluate(()=>appState.driveLiveFileId),await tab.evaluate(()=>appState.driveLiveFileId));
  console.log('PASS two tabs share simultaneous live messages without overwriting each other');
  // Transient media fetch failures cannot mark a live version as consumed.
  const payload=await B.page.evaluate(()=>({v:1,device:'other-device',turn:'test-turn',seq:2,at:nowIso(),done:true,chat:{id:'live-other',title:'Live',createdAt:nowIso(),updatedAt:nowIso()},messages:[createMessage('assistant','Live recovered')]}));
  add('live-good',{name:'live-other.json',parents:['folder-a'],appProperties:{inhouseLearnLive:'1'}},payload);
  let failed=false;
  await B.page.route('**/drive/v3/files/live-good?alt=media',route=>{if(!failed){failed=true;return route.fulfill({status:503,body:'{}'});}return route.fallback();});
  await B.page.waitForFunction(()=>appState.chats.some(c=>c.id==='live-other'),null,{timeout:10000});
  assert.ok(failed);
  console.log('PASS separate tab identities and retry of an unchanged live-file version after failed download');
  await B.context.close();
  // A rejected cached token during bootstrap used to await the very login that
  // was waiting for that Drive read. Exercise real login/refresh coordination.
  const C=await openApp(browser,{viewport:{width:1000,height:800}});
  await C.context.route('https://www.googleapis.com/**',drive);
  await C.page.evaluate(()=>{
   window.RTCPeerConnection=undefined;
   window.google={accounts:{oauth2:{}}};
   window.__renewals=0;
   googleTokenClient={requestAccessToken(){window.__renewals++;setTimeout(()=>this.callback({access_token:'renewed-test-token',expires_in:3600}),10);}};
   appState.accessToken='expired-test-token';appState.accessTokenExpiresAt=Date.now()+3600000;
   loginWithGoogle({interactive:false,toast:false}).then(result=>window.__loginResult=result);
  });
  await C.page.waitForFunction(()=>window.__loginResult===true&&appState.driveReady,null,{timeout:15000});
  assert.equal(await C.page.evaluate(()=>window.__renewals),1);
  assert.ok(await C.page.evaluate(()=>appState.chats.some(c=>c.id==='retry-chat')));
  console.log('PASS a 401 during initial history load renews once and resumes login without deadlock');
  await C.context.close();
  console.log('All sync recovery assertions passed.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
