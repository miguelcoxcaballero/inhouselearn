const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium, devices } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const plan = { title: 'Mecánica de vuelo', goal: 'Elegir el modelo físico, resolver y comprobar el resultado.', units: [
  { title: 'Construye el modelo', icon: '↗', lessons: [
    { title: 'Fuerzas y aceleración', objectives: ['Dibujar las fuerzas que actúan.', 'Calcular la aceleración y comprobar sus unidades.'], minutes: 6 },
    { title: 'Energía y velocidad', objectives: ['Elegir entre fuerzas y energía.'], minutes: 6 }
  ] }, { title: 'Llévalo más lejos', icon: '◎', lessons: [{ title: 'Modelos y límites', objectives: ['Detectar cuándo una aproximación deja de servir.'], minutes: 8 }] }
] };
const numeric = {type:'numeric',question:'Una fuerza neta de 125 N actúa sobre una masa de 100 kg. ¿Qué aceleración produce? Da el resultado en m/s².',answer:1.25,tolerance:.01,unit:'m/s²',hint:'Aísla la aceleración en la segunda ley de Newton.',skill:'apply',explanation:'a = F/m = 1,25 m/s². Usamos la fuerza neta, no cada fuerza por separado.'};
const choice = {question:'Si duplicas la masa y mantienes la fuerza neta, ¿qué pasa con la aceleración?',options:['Se reduce a la mitad','Se duplica también','Permanece constante'],correct:0,skill:'transfer',hint:'Compara la razón fuerza/masa antes y después.',explanation:'La aceleración es inversamente proporcional a la masa cuando la fuerza neta no cambia.'};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM||undefined});
 try {
  const {page,errors}=await openApp(browser,devices['Pixel 7']);
  await page.click('#plus-btn');await page.click('#guided-btn');
  await page.click('[data-g-goal="3"]');
  assert.equal(await page.getAttribute('[data-g-goal="3"]','aria-pressed'),'true');
  await page.evaluate(plan=>__replies.push({text:'Una ruta práctica.',tools:[{name:'set_course_plan',args:plan}],chunk:500,delay:1},{text:'Empezamos cuando quieras.'}),plan);
  await send(page,'Quiero aprender mecánica de vuelo.');await idle(page);
  assert.equal(await page.locator('.g-route-lesson').count(),3);
  const dir=SCRATCH+'/guided';fs.mkdirSync(dir,{recursive:true});
  await page.locator('.g-plan').screenshot({path:dir+'/route-mobile.png'});
  await page.evaluate(()=>__replies.push({text:'Primero: dibuja la fuerza neta y predice el sentido de la aceleración.\n\n```visual\n{"type":"formula","title":"Fuerza, masa y aceleración","params":{"F":{"min":0,"max":200,"value":125,"step":5},"m":{"min":10,"max":150,"value":100,"step":10}},"readouts":[{"label":"a (m/s²)","expr":"F/m"}]}\n```',chunk:500,delay:1}));
  await page.click('[data-g-start]');await idle(page);
  await page.evaluate(questions=>__replies.push({text:'Resuelve y comprueba.',tools:[{name:'quiz',args:{questions}}],chunk:500,delay:1},{text:'A tu ritmo.'}),[numeric,choice]);
  await page.click('[data-g-quick="test"]');await idle(page);
  let quiz=await page.evaluate(()=>pendingQuiz(courseOf(getActiveChat()),'check'));
  assert.ok(quiz.questions[0].type==='numeric');
  assert.equal(await page.locator('[data-g-quiz="'+quiz.id+'"] .g-q:not(.compact)').count(),1);
  await page.fill('[data-g-numeric] input','125 N');await page.click('[data-g-numeric] button');
  assert.equal(await page.getAttribute('[data-g-numeric] input','aria-invalid'),'true');
  assert.equal(await page.evaluate(id=>Object.keys(getActiveChat().course.quizzes[id].answers).length,quiz.id),0);
  await page.fill('[data-g-numeric] input','1,25');
  await page.click('[data-g-hint="'+quiz.id+':0"]');
  assert.equal(await page.inputValue('[data-g-numeric] input'),'1,25');
  assert.ok(await page.locator('.g-hint').isVisible());
  await page.locator('[data-g-quiz="'+quiz.id+'"]').screenshot({path:dir+'/numeric-mobile.png'});
  await page.reload();await page.waitForFunction(()=>!!getActiveChat().course?.quizzes);
  assert.equal(await page.inputValue('[data-g-numeric] input'),'1,25');
  await page.click('[data-g-numeric] button');
  assert.equal(await page.locator('.g-q.compact.right').count(),1);
  quiz=await page.evaluate(id=>getActiveChat().course.quizzes[id],quiz.id);
  await page.click('[data-g-answer="'+quiz.id+':1:'+quiz.questions[1].correct+'"]');
  await page.evaluate(()=>__replies.push({text:'Pasamos a energía: ¿qué cambia al duplicar la velocidad?',chunk:500,delay:1}));
  await page.click('[data-g-submit="'+quiz.id+'"]');await idle(page);
  let saved=await page.evaluate(()=>({course:getActiveChat().course,requests:__requests.length}));
  assert.equal(saved.course.currentLessonId,'L2');
  assert.equal(saved.course.learning.xp,14);
  assert.equal(saved.course.units[0].lessons[0].memory.assisted,true);
  assert.ok(saved.course.units[0].lessons[0].memory.dueAt>Date.now());
  console.log('PASS numeric tool generation, decimal/units validation, hints, draft reload, independent scoring and saved rewards');
  // Make the concept due and start a local retrieval round: no model request.
  await page.evaluate(()=>{getActiveChat().course.units[0].lessons[0].memory.dueAt=Date.now()-1;saveState();syncGuidedBannerSlot(getActiveChat());});
  const requests=await page.evaluate(()=>__requests.length);
  await page.click('[data-g-review="due"]');
  const review=await page.evaluate(()=>pendingQuiz(getActiveChat().course,'review'));
  assert.ok(review);assert.equal(await page.evaluate(()=>__requests.length),requests);
  assert.equal(await page.evaluate(()=>getActiveChat().course.currentLessonId),'L2');
  await page.reload();await page.waitForFunction(()=>!!pendingQuiz(getActiveChat().course,'review'));
  for(let i=0;i<review.questions.length;i++) {
   const q=review.questions[i];
   if(q.type==='numeric'){await page.fill('[data-g-numeric="'+review.id+':'+i+'"] input','1.25e0');await page.click('[data-g-numeric="'+review.id+':'+i+'"] button');}
   else await page.click('[data-g-answer="'+review.id+':'+i+':'+q.correct+'"]');
  }
  await page.click('[data-g-submit="'+review.id+'"]');
  saved=await page.evaluate(()=>({course:getActiveChat().course,requests:__requests.length}));
  assert.equal(saved.course.currentLessonId,'L2');assert.equal(saved.course.status,'learning');
  assert.equal(saved.requests,0);assert.equal(saved.course.units[0].lessons[0].memory.stage,2);
  assert.equal(saved.course.learning.xp,34);
  const xp=saved.course.learning.xp;
  await page.evaluate(id=>submitGuidedReview(getActiveChat(),id),review.id);
  assert.equal(await page.evaluate(()=>getActiveChat().course.learning.xp),xp);
  console.log('PASS due review works without a model, survives reload, advances spaced evidence once and preserves lesson position');
  // Exam answers are editable and never reveal feedback/hints before submission.
  const exam=await page.evaluate(questions=>{
   const chat=getActiveChat(),course=chat.course;course.status='exam';course.units.flatMap(u=>u.lessons).forEach(l=>l.status='done');
   const message=createMessage('assistant','',false);chat.messages.push(message);
   const params={questions:[...questions,...questions,...questions].map((q,i)=>({...q,lesson:'L'+(1+Math.floor(i/2))}))};
   const result=createGuidedToolHandlers(chat,message).exam(params);if(result.isError)throw Error(result.text);
   saveState();renderThread();return pendingQuiz(course,'exam');
  },[numeric,choice]);
  assert.equal(await page.locator('[data-g-quiz="'+exam.id+'"] [data-g-hint]').count(),0);
  await page.fill('[data-g-numeric="'+exam.id+':0"] input','999');await page.click('[data-g-numeric="'+exam.id+':0"] button');
  assert.equal(await page.locator('[data-g-quiz="'+exam.id+'"] .g-feedback').count(),0);
  await page.fill('[data-g-numeric="'+exam.id+':0"] input','1.25');await page.click('[data-g-numeric="'+exam.id+':0"] button');
  for(let i=1;i<exam.questions.length;i++) {
   const q=exam.questions[i];
   if(q.type==='numeric'){await page.fill('[data-g-numeric="'+exam.id+':'+i+'"] input','1.25');await page.click('[data-g-numeric="'+exam.id+':'+i+'"] button');}
   else await page.click('[data-g-answer="'+exam.id+':'+i+':'+q.correct+'"]');
  }
  await page.evaluate(()=>__replies.push({text:'Buen trabajo. El próximo repaso comprobará lo que recuerdas.',chunk:500,delay:1}));
  await page.click('[data-g-submit="'+exam.id+'"]');await idle(page);
  assert.equal(await page.evaluate(id=>getActiveChat().course.quizzes[id].score,exam.id),100);
  assert.equal(await page.evaluate(()=>getActiveChat().course.status),'done');
  console.log('PASS numeric final exam hides answers, allows revision and grades all concepts');
  // Replanning must not attach old evidence to a new lesson occupying its old ID.
  const remap=await page.evaluate(()=>{
   const chat=getActiveChat(),old=chat.course.units[0].lessons[0],key=old.key,memory=JSON.stringify(old.memory);
   const message=createMessage('assistant','',false);message.lessonId=old.id;chat.messages.push(message);
   createGuidedToolHandlers(chat,message).setPlan({title:'Ruta ajustada',units:[{title:'Base',lessons:[{title:'Nuevo concepto',objectives:['Nuevo']},{title:old.title,objectives:old.objectives}]}]});
   const course=chat.course;saveState();renderThread();syncGuidedBannerSlot(chat);
   return {key,memory,current:course.units[0].lessons[1],fresh:course.units[0].lessons[0],oldQuiz:Object.values(course.quizzes).find(q=>q.kind==='check'),messageLesson:message.lessonId,examScore:course.examScore};
  });
  assert.equal(remap.current.key,remap.key);assert.equal(JSON.stringify(remap.current.memory),remap.memory);
  assert.ok(!remap.fresh.memory);assert.equal(remap.oldQuiz.lessonId,'L2');
  assert.equal(remap.messageLesson,'L2');assert.equal(remap.examScore,undefined);
  console.log('PASS replanning preserves evidence by lesson identity, never by an accidentally reused position');
  for(const theme of ['light','dark'])for(const width of [320,390,768,1440]) {
   await page.setViewportSize({width,height:900});
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;sessionSet('course-map::'+getActiveChat().id,'1');syncGuidedBannerSlot(getActiveChat());},theme);
   await page.waitForTimeout(200);
   const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,header:document.querySelector('.g-course').getBoundingClientRect().bottom,composer:document.querySelector('.composer-area').getBoundingClientRect().top}));
   assert.equal(layout.overflow,false,JSON.stringify({theme,width,layout}));
   assert.ok(layout.header<layout.composer,JSON.stringify({theme,width,layout}));
   await page.screenshot({path:dir+'/course-'+theme+'-'+width+'.png'});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.g-earned b')).animationName),'none');
  assert.deepEqual(errors,[]);
  console.log('PASS 320–1440 px, light/AMOLED themes, no overlap or horizontal overflow, reduced motion');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
