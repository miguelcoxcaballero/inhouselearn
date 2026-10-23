const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { openApp } = require('./mock.cjs');
const explain = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/explain-example.json'), 'utf8'));

(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
 try {
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 850 } });
  await page.evaluate(() => {
   const host = document.createElement('div'); host.id = 'controls-fixture';
   host.style.cssText = 'position:fixed;inset:0;z-index:10000;overflow:auto;background:var(--bg);padding:16px';
   document.body.append(host);
   window.mountControlScene = spec => {
    host.replaceChildren();
    window.controlView = new SceneView(spec, {}, 'control-test');
    host.append(controlView.el);
   };
   window.moveControl = value => {
    const input = host.querySelector('input[type=range]'); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
   };
  });
  // This layer is initially hidden, then appears with opacity on first input.
  // Previously the opacity wrapper lost `this` and aborted the whole redraw.
  await page.evaluate(() => mountControlScene({ type:'scene', loop:'static',
   controls:[{id:'a',kind:'slider',min:0,max:10,value:0}],
   layers:[{kind:'arrow',id:'force',from:[1,1],to:['a',3],opacity:.7,visible:'a>0',color:'#e87532'},
    {kind:'circle',at:['a',2],r:.2,color:'#2671b8'}],readouts:[{expr:'a',label:'Valor'}]
  }));
  for (const value of [2,10,0,5,1]) {
   const state = await page.evaluate(value => {moveControl(value);return {x:controlView.layers[0].node.getAttribute('x2'),hidden:controlView.layers[0].g.style.display,opacity:controlView.layers[0].g.getAttribute('opacity'),readout:controlView.el.querySelector('[data-scene-readout]').textContent,warnings:controlView.renderErrors};}, value);
   assert.deepEqual(state.warnings,[]);
   assert.equal(state.readout,String(value));
   if (value) {assert.equal(Number(state.x),value*80);assert.equal(state.hidden,'');assert.equal(state.opacity,'0.7');}
   else assert.equal(state.hidden,'none');
  }
  console.log('PASS slider updates translucent layers and the rest of the scene without losing geometry');

  const singular = {type:'scene',loop:'static',controls:[{id:'a',kind:'slider',min:0,max:2,value:1}],layers:[{kind:'circle',id:'singular',at:['1/a',2],r:.2},{kind:'rect',x:3,y:1,w:2,h:1}],readouts:[{expr:'1/a',label:'Inverso'}]};
  await page.evaluate(spec=>mountControlScene(spec),singular);
  await page.evaluate(()=>moveControl(0));
  assert.ok(await page.locator('.scene-warning').isVisible());
  assert.equal(await page.evaluate(()=>controlView.layers[1].g.style.display),'');
  assert.equal(await page.evaluate(()=>/NaN|Infinity|-9999/.test(controlView.svg.outerHTML)),false);
  await page.evaluate(()=>moveControl(2));
  assert.equal(await page.locator('.scene-warning').isVisible(),false);
  assert.equal(await page.evaluate(()=>controlView.layers[0].g.style.display),'');
  assert.equal(await page.evaluate(()=>Number(controlView.layers[0].node.getAttribute('cx'))),40);
  const preflight = await page.evaluate(spec=>checkLearningDiagram({spec:JSON.stringify(spec)}),singular);
  assert.match(preflight.text,/a=0.*Non-finite SVG geometry/);
  console.log('PASS undefined values isolate the affected layer, explain the problem and recover; preflight also tests slider extremes');

  await page.evaluate(()=>{
   const host=document.querySelector('#controls-fixture'); host.replaceChildren();
   host.append(vizPlot({type:'plot',expr:'a',params:{a:{min:-100,max:100,value:0}}},{}));
  });
  for (const theme of ['light','dark']) for (const value of [-100,-50,0,50,100]) {
   await page.evaluate(([theme,value])=>{document.documentElement.dataset.theme=theme;moveControl(value);},[theme,value]);
   const curve=await page.evaluate(()=>{const node=document.querySelector('.viz-curve');const rect=node.getBBox();return {y:rect.y,color:getComputedStyle(node).stroke};});
   assert.ok(curve.y>=14 && curve.y<=330,JSON.stringify(curve));
   assert.notEqual(curve.color,'none');
  }
  await page.evaluate(()=>{
   const host=document.querySelector('#controls-fixture');host.replaceChildren();
   host.append(vizPlot({type:'plot',expr:'a',y:[-1,1],params:{a:{min:0,max:10,value:0}}},{}));moveControl(10);
  });
  assert.equal(await page.locator('[data-viz-fit]').count(),0);
  assert.ok(await page.evaluate(()=>document.querySelector('.viz-curve').getBBox().y<14),'explicit fixed axes remain fixed');
  await page.evaluate(()=>{
   const host=document.querySelector('#controls-fixture');host.replaceChildren();
   host.append(vizPlot({type:'plot',expr:'sqrt(a)',params:{a:{min:-1,max:1,value:1}}},{}));moveControl(-1);
  });
  assert.ok(await page.locator('.viz-plot-warning').isVisible());
  await page.evaluate(()=>moveControl(1));
  assert.equal(await page.locator('.viz-plot-warning').isVisible(),false);
  assert.ok(await page.locator('.viz-curve').getAttribute('d'));
  console.log('PASS plot axes track slider values in both themes; fixed axes stay fixed; undefined functions explain and recover');

  await page.evaluate(spec=>{
   const host=document.querySelector('#controls-fixture');host.replaceChildren();
   window.explainState={};host.append(vizExplain(spec,explainState,{key:'controls:explain'}));
  },explain);
  await page.click('[data-ex-step="1"]');
  await page.locator('.viz-explain input[type=range]').focus();
  await page.keyboard.press('ArrowRight');
  const original = await page.locator('.ex-description').elementHandle();
  for (let k=0;k<20;k++) await page.keyboard.press(k%2 ? 'ArrowRight' : 'ArrowLeft');
  const sliderBox = await page.locator('.viz-explain input[type=range]').boundingBox();
  await page.mouse.move(sliderBox.x + sliderBox.width * .2, sliderBox.y + sliderBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sliderBox.x + sliderBox.width * .85, sliderBox.y + sliderBox.height / 2, {steps:15});
  await page.mouse.up();
  const exploration = await page.evaluate(()=>({dim:document.querySelectorAll('.ex-dim').length,step:explainState.step,free:explainState.exploring,warnings:document.querySelector('.viz-explain').__explainView.renderErrors,animations:document.querySelector('.scene-svg').getAnimations().length}));
  assert.deepEqual(exploration,{dim:0,step:1,free:true,warnings:[],animations:0});
  assert.ok(await original.evaluate(node=>node.isConnected));
  assert.match(await page.locator('.ex-description').textContent(),/Exploración libre/);
  await page.click('[data-ex-next]');
  assert.equal(await page.evaluate(()=>explainState.exploring),false);
  assert.deepEqual(errors,[]);
  console.log('PASS rapid keyboard and pointer slider movement keeps the same diagram, clears dimming/fades and restores the example without browser errors');
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
