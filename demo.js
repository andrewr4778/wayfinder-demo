/* demo.js — everything that makes this a demo.
   init() and the sample data, the scripted helper, and the guided tour.
   Loaded after app.js, and the last line starts the app. */
/* ============ init (demo) ============
   The demo never touches a real hub. Every collection is in memory, seeded
   with a sample life, and a reload starts the visitor from scratch. */
async function init(){
  document.getElementById('today-line').textContent =
    new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });

  db = null;
  COLS.forEach(name => {
    cols[name] = localCollection(name);
    cols[name].onSnapshot(arr => {
      state[name] = arr;
      if(name === 'chat'){ renderChat(); }
      else if(name === 'settings'){
        const doc = arr.find(d => d.id === 'ui');
        if(doc){
          look = { theme: doc.theme || DEFAULT_THEME, font: doc.font || 'publicsans',
                   scale: doc.scale || 100, textColor: doc.textColor || '',
                   bgTone: doc.bgTone || 'dark', bgDim: typeof doc.bgDim === 'number' ? doc.bgDim : 20 };   // "Your image" settings
          applyLook(look);
          if(document.getElementById('settings-sheet').classList.contains('open')) renderSettings();
        }
      }
      else if(name === 'drawing'){
        const doc = arr.find(d => d.id === 'hub');
        if(doc && !drawing && !inkDirty){
          strokes = Array.isArray(doc.strokes) ? doc.strokes.slice() : [];
          redrawInk();
        }
      }
      else render();
    });
  });

  seedDemo();
  // the floating helper button stays hidden: Cosmo lives in the middle bubble now

  attachInk();
  attachCamera();
  watchNoteResize();
  renderHistory();
  renderSettings();
  renderSwatches();
  setHubMode('move');
  sizeInkCanvas();
  applyCamera();
  render();
  renderSuggests();
  requestAnimationFrame(() => fitView(false));
}

function seedDemo(){
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return toDateStr(x); };
  const W = (type, title, size, data) => normalizeWidget({ type, title, size, data: hydrate(type, data) });
  const streak = (...back) => { const c = {}; back.forEach(n => { c[d(-n)] = true; }); return c; };
  let t = Date.now() - 600000;
  const B = (id, doc) => cols.bubbles.set(id, Object.assign({ createdAt: t += 1000 }, doc));

  B('b-school', { name:'School', tone:'teal', widgets:[
    W('dates', 'Exams & deadlines', 'sm', { items:[
      { label:'Calc II quiz', date:d(2) }, { label:'Data Structures project', date:d(9) }, { label:'Physics midterm', date:d(13) } ] }),
    W('checklist', 'This week', 'sm', { items:[
      { text:'Read chapter 7', done:true }, { text:'Finish lab write-up' }, { text:'Go to office hours' } ] }),
    W('metric', 'Study hours', 'sm', { value:'14', unit:'hrs', target:'20', label:'This week' }),
    W('progress', 'Course progress', 'md', { items:[
      { label:'Data Structures', pct:62 }, { label:'Calculus II', pct:40 }, { label:'Physics I', pct:55 } ] }),
    W('links', 'Quick links', 'sm', { items:[
      { label:'Canvas', url:'https://canvas.instructure.com' }, { label:'Library', url:'https://www.libraries.rutgers.edu' } ] }),
    W('sticky', 'Notes to self', 'lg', { items:[
      { text:'Ask about the curve on quiz 3', tone:'yellow' }, { text:'Study group Thursday 7pm', tone:'blue' },
      { text:'Return library books', tone:'pink' } ] }),
  ]});
  B('b-work', { name:'Work', tone:'blue', widgets:[
    W('metric', 'Hours this week', 'sm', { value:'22', unit:'hrs', target:'30', label:'Scheduled' }),
    W('table', 'Shifts', 'md', { columns:['Day','Hours','Where'], rows:[
      ['Friday','4pm – 9pm','Front desk'], ['Saturday','9am – 3pm','Front desk'], ['Monday','5pm – 9pm','Training'] ] }),
    W('checklist', 'To sort out', 'sm', { items:[ { text:'Update availability for December' }, { text:'Pick up W-2 form', done:true } ] }),
  ]});
  B('b-finance', { name:'Finance', tone:'green', widgets:[
    W('metric', 'Saved this month', 'sm', { value:'340', unit:'dollars', target:'500', label:'Goal' }),
    W('table', 'Monthly bills', 'md', { columns:['Bill','Amount','Due'], rows:[
      ['Rent','$850','1st'], ['Phone','$45','15th'], ['Music','$6','22nd'] ] }),
  ]});
  B('b-projects', { name:'Projects', tone:'violet', widgets:[
    W('progress', 'Wayfinder roadmap', 'md', { items:[
      { label:'Bubble map & panels', pct:100 }, { label:'Cosmo, the assistant that edits the hub', pct:80 }, { label:'Calendar sync', pct:15 } ] }),
    W('notes', 'Ideas', 'sm', { text:'Pull class deadlines straight from Canvas.\nWidget for bus times.' }),
  ]});
  B('b-misc', { name:'Misc', tone:'amber', widgets:[
    W('notes', 'Scratchpad', 'sm', { text:'Old notes to clean out.' }),
  ]});

  let n = 0;
  const T = (text, due, bubbleId, done) =>
    cols.tasks.add({ text, due: due == null ? '' : d(due), bubbleId: bubbleId || '', done: !!done, createdAt: Date.now() + (n++) });
  T('Finish lab write-up', 0, 'b-school');
  T('Order Calc II textbook', -1, 'b-school');
  T('Swap Saturday shift', 1, 'b-work');
  T('Pay phone bill', 3, 'b-finance');
  T('Email advisor about spring classes', null, 'b-school');
  T('Renew parking permit', null, '', true);

  cols.important.add({ text:'Advisor office hours: Tue & Thu, 2–4 pm', createdAt: Date.now() - 3000 });
  cols.important.add({ text:'Rent is due on the 1st', createdAt: Date.now() - 2000 });
  cols.important.add({ text:'Library is open until 2 am during finals', createdAt: Date.now() - 1000 });
}

/* ============ camera helpers for the tour ============ */
function hubBounds(){
  let x0 = -R_CEN, x1 = R_CEN, y0 = -R_CEN, y1 = R_CEN;
  bubbleEls.forEach(el => {
    if(!el._pos) return;
    const r = el._r || R_SEC;
    x0 = Math.min(x0, el._pos.x - r); x1 = Math.max(x1, el._pos.x + r);
    y0 = Math.min(y0, el._pos.y - r); y1 = Math.max(y1, el._pos.y + r);
  });
  return { x0, x1, y0, y1 };
}
function fitView(animated){
  const b = hubBounds(), r = hubRect();
  if(!r.width) return Promise.resolve();
  const padX = 50, padY = 70;
  const z = clamp(Math.min((r.width - padX*2) / (b.x1 - b.x0), (r.height - padY*2) / (b.y1 - b.y0)), 0.35, 1.05);
  const tx = (b.x0 + b.x1) / 2, ty = (b.y0 + b.y1) / 2 - 12 / z;
  if(animated === false){ cam.x = tx; cam.y = ty; cam.z = z; applyCamera(); return Promise.resolve(); }
  return animateCam(tx, ty, z);
}
function animateCam(x, y, z, dur){
  dur = REDUCED ? 1 : (dur || 650);
  return new Promise(res => {
    const s = { x:cam.x, y:cam.y, z:cam.z }, t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const frame = now => {
      const t = Math.min(1, (now - t0) / dur), k = ease(t);
      cam.x = s.x + (x - s.x) * k; cam.y = s.y + (y - s.y) * k; cam.z = s.z + (z - s.z) * k;
      applyCamera();
      if(t < 1) requestAnimationFrame(frame); else res();
    };
    requestAnimationFrame(frame);
  });
}

/* ============ the demo helper ============
   Same activity card, same tools, same hub — only the reasoning is scripted.
   It understands a handful of commands well instead of pretending to
   understand everything. */
let demoRun = null;
function demoSend(){
  if(chatBusy) return demoRun;
  const input = document.getElementById('chat-input');
  const text = (input.value || '').trim();
  if(!text) return Promise.resolve();
  demoRun = demoReply(text);
  return demoRun;
}
const pause = ms => new Promise(r => setTimeout(r, REDUCED ? 40 : ms));
const capFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

async function demoReply(text){
  const input = document.getElementById('chat-input');
  input.value = ''; input.style.height = 'auto';
  chatBusy = true; setSendMode(true);
  document.getElementById('helper-bubble').classList.add('busy');
  actStart();
  const body = document.getElementById('chat-body');
  await cols.chat.add({ role:'user', content:text, createdAt: Date.now() });
  const working = document.createElement('div');
  working.className = 'working'; working.id = 'chat-working';
  body.appendChild(working); renderActivity(); body.scrollTop = body.scrollHeight;

  let reply = '';
  try{
    const step = actStep('Reading your hub'); actSet('Reading your hub');
    await pause(750); actDone(step); actSet('Thinking');
    await pause(450);
    const tools = {};
    instrument(buildTools()).forEach(t => { tools[t.name] = t; });
    reply = await demoAct(text, tools);
  }catch(e){
    reply = 'That did not work: ' + ((e && e.message) || 'something went wrong') + '.';
  }
  actSet('Writing the reply');
  const el = document.createElement('div');
  el.className = 'msg assistant';
  body.insertBefore(el, working);
  for(let i = 0; i <= reply.length; i += 3){
    el.textContent = reply.slice(0, i);
    body.scrollTop = body.scrollHeight;
    await pause(14);
  }
  working.remove();
  actEnd('Done');
  chatBusy = false; setSendMode(false);
  document.getElementById('helper-bubble').classList.remove('busy');
  await cols.chat.add({ role:'assistant', content:reply, createdAt: Date.now() });
}

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function parseDay(raw){
  let s = String(raw || '').toLowerCase().trim().replace(/^(?:this|the|on)\s+/, '');
  const now = new Date(); now.setHours(0,0,0,0);
  const plus = n => { const x = new Date(now); x.setDate(x.getDate() + n); return toDateStr(x); };
  if(/^(today|tonight)$/.test(s)) return plus(0);
  if(s === 'tomorrow') return plus(1);
  let m = s.match(/^in (\d+) days?$/); if(m) return plus(+m[1]);
  m = s.match(/^in (a|one|\d+) weeks?$/); if(m) return plus(7 * (/\d/.test(m[1]) ? +m[1] : 1));
  if(s === 'next week') return plus(7);
  m = s.match(/^(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if(m){
    const idx = DAY_NAMES.findIndex(n => n.startsWith(m[2]));
    let diff = (idx - now.getDay() + 7) % 7;
    if(m[1] && diff === 0) diff = 7;
    return plus(diff);
  }
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  const yearOf = dt => { if(dt < now) dt.setFullYear(dt.getFullYear() + 1); return toDateStr(dt); };
  if(m) return yearOf(new Date(now.getFullYear(), +m[1] - 1, +m[2]));
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if(m){
    const dt = new Date(m[1] + ' ' + m[2] + ' ' + now.getFullYear());
    if(!isNaN(dt)) return yearOf(dt);
  }
  return null;
}
function longDate(ds){ return parseDateStr(ds).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' }); }

function matchSection(text){
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
  const byName = state.bubbles.slice().sort((a, b) => b.name.length - a.name.length)
    .find(b => t.includes(' ' + b.name.toLowerCase() + ' '));
  if(byName) return byName;
  const hints = [
    ['School', /\b(homework|hw|exam|quiz|lab|essay|class|midterm|final|study|lecture|reading|professor|assignment)\b/],
    ['Finance', /\b(pay|bill|rent|budget|bank|venmo|tuition)\b/],
    ['Work', /\b(shift|boss|manager|work)\b/],
    ['Gym', /\b(gym|run|workout|lift|stretch)\b/],
  ];
  for(const [name, re] of hints){
    if(re.test(t)){ const b = state.bubbles.find(x => x.name === name); if(b) return b; }
  }
  return null;
}

function templateFor(name){
  const n = String(name).toLowerCase();
  if(/travel|trip|vacation/.test(n)) return [
    { type:'dates', title:'Trip dates', size:'sm', data:{ items:[] } },
    { type:'checklist', title:'Packing list', size:'sm', data:{ items:[{ text:'Passport' }, { text:'Chargers' }, { text:'Toiletries' }] } },
    { type:'table', title:'Budget', size:'md', data:{ columns:['Item','Cost'], rows:[['Flights',''], ['Hotel','']] } },
    { type:'notes', title:'Plans', size:'sm', data:{ text:'' } },
  ];
  if(/gym|fitness|workout|health/.test(n)) return [
    { type:'habit', title:'Daily habits', size:'md', data:{ items:[{ name:'Workout' }, { name:'8 hours of sleep' }] } },
    { type:'progress', title:'Goals', size:'sm', data:{ items:[{ label:'Bench 185', pct:60 }, { label:'Run a 5K', pct:30 }] } },
    { type:'notes', title:'Program', size:'sm', data:{ text:'Push / Pull / Legs' } },
  ];
  if(/chem|bio|physics|calc|math|class|course/.test(n)) return [
    { type:'dates', title:'Exams & due dates', size:'sm', data:{ items:[] } },
    { type:'checklist', title:'Study plan', size:'sm', data:{ items:[{ text:'Review lecture notes' }, { text:'Practice problems' }] } },
    { type:'progress', title:'Units covered', size:'sm', data:{ items:[{ label:'Unit 1', pct:100 }, { label:'Unit 2', pct:45 }] } },
    { type:'links', title:'Course links', size:'sm', data:{ items:[] } },
  ];
  return [
    { type:'checklist', title:'To do', size:'sm', data:{ items:[] } },
    { type:'dates', title:'Key dates', size:'sm', data:{ items:[] } },
    { type:'notes', title:'Notes', size:'sm', data:{ text:'' } },
  ];
}

async function demoAct(text, tools){
  const t = text.trim().replace(/[.!?]+$/, '');
  let m;

  if(/\b(what'?s|what is|what am i|anything)\b.*\b(due|today|this week|coming up|forgetting|focus)\b/i.test(t)){
    const soon = openTasks().filter(x => x.due && daysUntil(x.due) <= 7)
      .sort((a, b) => a.due.localeCompare(b.due));
    if(!soon.length) return 'Nothing is due in the next week. A good time to get ahead on something.';
    return 'Coming up in the next week:\n' + soon.map(x => '• ' + x.text + ' — ' + whenLabel(x.due)).join('\n') +
      (soon.some(x => daysUntil(x.due) < 0) ? '\n\nOne of these is already overdue, so I would start there.' : '');
  }

  if(/\bdesign\b/i.test(t)){
    const b = (view === 'section' && bubbleById(activeBubbleId)) || matchSection(t);
    if(!b) return 'Open the section you want designed, then ask me again.';
    await pause(400);
    const widgets = templateFor(b.name);
    await tools.designSection.execute({ sectionId: b.id, widgets });
    return 'I laid out ' + b.name + ' with ' + widgets.map(w => w.title).join(', ') + '. Rename or remove anything that does not fit.';
  }

  if((m = t.match(/^(?:please\s+)?add\s+(?:a\s+|an\s+)?(.+?)\s+panel$/i))){
    const b = (view === 'section' && bubbleById(activeBubbleId)) || matchSection(t);
    if(!b) return 'Open a section first, then ask me to add the panel there.';
    const w = m[1].toLowerCase();
    const type = /deadline|date|due|calendar/.test(w) ? 'dates' : /habit|streak/.test(w) ? 'habit'
      : /note/.test(w) ? 'notes' : /link/.test(w) ? 'links' : /progress|goal/.test(w) ? 'progress'
      : /table|budget|bill/.test(w) ? 'table' : /sticky/.test(w) ? 'sticky' : /number|metric|count/.test(w) ? 'metric' : 'checklist';
    const title = /deadline/.test(w) ? 'Deadlines' : capFirst(m[1]);
    await pause(300);
    await tools.addPanel.execute({ sectionId: b.id, type, title, size: type === 'table' ? 'md' : 'sm' });
    return 'Added a "' + title + '" panel to ' + b.name + '.';
  }

  if((m = t.match(/^(?:please\s+)?(?:make|create|add|start)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:section|bubble)\s*(?:for|called|named|about)?\s+(.+)$/i))){
    const name = capFirst(m[1].replace(/^(?:my|the)\s+/i, '').trim());
    const under = matchSection(name);
    await pause(300);
    const input = { name };
    if(under && under.name.toLowerCase() !== name.toLowerCase() && /class|chem|calc|physics|bio/i.test(name)) input.branchesOff = under.id;
    await tools.createSection.execute(input);
    return 'Made a ' + name + ' bubble' + (input.branchesOff ? ' branching off ' + under.name : '') +
      '. Open it and say "design this section" and I will lay it out.';
  }

  if((m = t.match(/^(?:please\s+)?(?:pin|remember|save)\s+(?:that\s+)?(.+)$/i))){
    const fact = capFirst(m[1]);
    await pause(300);
    await tools.pinImportant.execute({ text: fact });
    return 'Pinned "' + fact + '" to Important info.';
  }

  if((m = t.match(/^(?:please\s+)?(?:add|remind me to|remind me about|i need to|to-?do:?)\s+(.+)$/i))){
    let what = m[1].trim(), due = '';
    const k = what.match(/^(.+?)\s+(?:due|by|on|for)\s+(.+)$/i);
    if(k && parseDay(k[2])){ what = k[1]; due = parseDay(k[2]); }
    else {
      const tail = what.match(/^(.+?)\s+((?:this |next )?(?:today|tonight|tomorrow|next week|(?:sun|mon|tues|wednes|thurs|fri|satur)day|in \d+ days?))$/i);
      if(tail && parseDay(tail[2])){ what = tail[1]; due = parseDay(tail[2]); }
    }
    what = capFirst(what.replace(/^(?:a|an|my)\s+/i, ''));
    const b = matchSection(what);
    await pause(300);
    await tools.addTask.execute({ text: what, due, sectionName: b ? b.name : undefined });
    return 'Added "' + what + '"' + (b ? ' to ' + b.name : '') +
      (due ? ', due ' + longDate(due) + '.' : ' with no date on it.') +
      ' It is on your list in the middle too.';
  }

  return 'This demo understands a few commands. Try "Add essay due Monday", "Make a section for Travel", ' +
    '"Pin locker combo 12-34-08", or "What\'s due this week?". In the full app Cosmo runs on Claude and handles anything you type.';
}

/* ================= GUIDED TOUR =================
   A fake cursor drives the real app: every click below calls the same
   handler a person's click would, so what the visitor watches is the
   product working, not a recording of it.

   The key clicks in each step are the visitor's own: press() blurs
   everything except the button, waits for a real click on it, and the
   step carries on from there. "Show me" lets the cursor do that click,
   and "Next (mid-step)" fast-forwards the rest of the step so later steps still
   find what they expect. Once a step is done, "Show again" replays it as
   a demo. Rewinding works because the demo store is in memory: the whole
   hub is snapshotted before a step and put back before every replay. */
const tour = { on:false, token:0, stepTok:0, name:'', choice:null, replaying:false, skipReplay:false,
               fast:false, pressing:null };
const TOUR_STEPS = 12;
const PACE = 1.7;                       // everything below runs this much slower than real time
class TourStop extends Error{}
class StepSkip extends Error{}
const q = s => document.querySelector(s);
const sleepers = new Set();

function tsleep(ms){
  const tk = tour.token, sk = tour.stepTok;
  const wait = tour.fast ? 0 : REDUCED ? Math.min(ms, 120) : ms * PACE;
  return new Promise((res, rej) => {
    const entry = { rej };
    sleepers.add(entry);
    entry.fire = () => {
      sleepers.delete(entry);
      if(!tour.on || tk !== tour.token) rej(new TourStop());
      else if(sk !== tour.stepTok) rej(new StepSkip());
      else res();
    };
    entry.timer = setTimeout(entry.fire, wait);
  });
}
function wakeSleepers(err){
  sleepers.forEach(e => { clearTimeout(e.timer); e.rej(err); });
  sleepers.clear();
}
/* fast-forward: every pending pause ends now instead of failing */
function hurrySleepers(){
  sleepers.forEach(e => { clearTimeout(e.timer); e.timer = setTimeout(e.fire, 0); });
}
function resolveEl(t){
  if(!t) return null;
  if(typeof t === 'function') return t();
  if(typeof t === 'string') return q(t);
  return t;
}

/* ---- cursor ---- */
const cur = { x: innerWidth / 2, y: innerHeight * 0.72 };
function placeCursor(x, y, dur){
  const el = q('#tour-cursor');
  el.hidden = tour.fast;
  el.style.transition = dur ? 'transform ' + dur + 'ms cubic-bezier(.32,.72,0,1)' : 'none';
  el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  cur.x = x; cur.y = y;
}
async function ensureVisible(el){
  if(!el || el.closest('.sheet, #modal')) return;
  const r = el.getBoundingClientRect();
  if(r.top < 70 || r.bottom > innerHeight - 30){
    el.scrollIntoView({ block:'center', behavior: (REDUCED || tour.fast) ? 'auto' : 'smooth' });
    await tsleep(480);
  }
}
async function moveTo(target, dur){
  dur = (REDUCED || tour.fast) ? 0 : Math.round((dur || 620) * PACE);
  let p = target;
  if(!(target && typeof target.x === 'number')){
    const el = resolveEl(target);
    if(!el) return;
    await ensureVisible(el);
    const r = el.getBoundingClientRect();
    p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  placeCursor(p.x, p.y, dur);
  await tsleep(dur / PACE + 60);
}
async function tap(target, action){
  await moveTo(target);
  await tsleep(220);                    // rest on it a beat so the eye catches up
  const c = q('#tour-cursor');
  c.classList.remove('tap'); void c.offsetWidth; c.classList.add('tap');
  await tsleep(170);
  if(action) await action();
  else { const el = resolveEl(target); if(el) el.click(); }
  await tsleep(380);
}
async function typeInto(target, text, speed){
  const el = resolveEl(target);
  if(!el) return;
  await moveTo(el, 420);
  el.classList.add('tour-typing');
  el.value = '';
  try{
    for(const ch of text){
      el.value += ch;
      el.dispatchEvent(new Event('input', { bubbles:true }));
      await tsleep((speed || 55) + Math.random() * 40);
    }
  } finally { el.classList.remove('tour-typing'); }
  await tsleep(300);
}

/* A pause that only happens while the cursor is driving (Show me, Show
   again, Next (mid-step)). On the visitor's own run these are skipped, and
   blurPause() alone sets the rhythm before each turn. */
function beat(ms){ return (tour.replaying || tour.fast) ? tsleep(ms) : Promise.resolve(); }
/* Before each turn the ring shows the visitor where to look, then the blur
   comes in. BLUR_DELAY is in real milliseconds (tsleep runs PACE times slower). */
const BLUR_DELAY = 1000;
function blurPause(){ return tsleep(BLUR_DELAY / PACE); }

/* ---- the visitor's turn ----
   Blur everything but the target and wait for a real click on it. The
   click itself goes through untouched, so the app's own handler runs.
   check() guards targets that can be dragged instead of clicked (bubbles):
   the step only moves on once the click actually did its job. When the
   cursor is driving (replay, fast-forward) this is just a tap. */
async function press(target, opts){
  opts = opts || {};
  if(tour.fast || tour.replaying || !resolveEl(target)) return tap(target, opts.action);
  await ensureVisible(resolveEl(target));
  spot(opts.area || target, { round: !!opts.round, pad: opts.pad == null ? 6 : opts.pad });
  await blurPause();
  if(tour.fast) return tap(target, opts.action);     // Next was pressed during the pause
  const how = await handOver(opts.area || target, opts, opts.label || 'Your turn: click it', () => waitPress(target, opts.check));
  if(how === 'user') await beat(380);
  else await tap(target, opts.action);     // Show me, or Next (mid-step)
}
/* A freer turn: light up an area (the map), let the visitor do something
   there (draw, erase, shake a bubble loose), and move on once done() says
   it happened. demo() is what Show me / Next (mid-step) / Show again play. */
async function yourTurn(area, opts){
  if(tour.fast || tour.replaying || !resolveEl(area)) return opts.demo();
  await blurPause();
  if(tour.fast) return opts.demo();
  const how = await handOver(area, opts, opts.label || 'Your turn', () => waitUntil(opts.done));
  if(how === 'user') await beat(600);
  else await opts.demo();
}
/* A dropdown the visitor picks from. want is the value to land on, a
   function returning it, or a test (v => ...) when any of several will do;
   fallback is what Show me picks in that last case. apply() runs the side
   effect the app's own onchange would, for when the cursor picks. */
async function choose(sel, want, label, apply, fallback){
  const isTest = typeof want === 'function' && want.length === 1;
  const target = () => isTest ? fallback : (typeof want === 'function' ? want() : want);
  const ok = () => { const el = q(sel); return !!el && (isTest ? want(el.value) : el.value === target()); };
  await yourTurn(sel, { pad:4, label, done: ok,
    demo: () => tap(sel, () => { const el = q(sel); if(el && !ok()){ el.value = target(); if(apply) apply(); } }) });
}
/* blur everything but target, hand the controls over, take them back */
async function handOver(target, opts, label, wait){
  const prev = { t: spotTarget, o: spotOpts };
  spot(target, { round: !!opts.round, pad: opts.pad == null ? 6 : opts.pad });
  q('#tour-cursor').hidden = true;
  q('#tour-block').hidden = true;
  q('#tour-shade').hidden = false;
  spotFrame();          // cut the hole now, not on the next frame, so an instant click still lands
  cardMode('press', null, label);
  try{
    return await wait();
  }finally{
    q('#tour-shade').hidden = true;
    q('#tour-block').hidden = !tour.on;
    if(tour.on){ cardMode('watch'); spot(prev.t, prev.o); }
  }
}
function waitUntil(done){
  return new Promise((res, rej) => {
    const entry = { done: finish };
    const iv = setInterval(() => { if(tour.pressing === entry && done()) finish('user'); }, 150);
    function finish(how, err){
      clearInterval(iv);
      if(tour.pressing === entry) tour.pressing = null;
      err ? rej(err) : res(how);
    }
    tour.pressing = entry;
  });
}
function waitPress(target, check){
  return new Promise((res, rej) => {
    let armed = false;
    const inside = e => { const el = resolveEl(target); return !!(el && e.target instanceof Node && el.contains(e.target)); };
    const settle = () => setTimeout(() => { if(tour.pressing === entry && (!check || check())) done('user'); }, 40);
    const down = e => { armed = inside(e); };
    const up = () => { if(armed){ armed = false; settle(); } };
    const key = e => { if(e.detail === 0 && inside(e)) settle(); };   // keyboard activation
    function done(how, err){
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('click', key, true);
      if(tour.pressing === entry) tour.pressing = null;
      err ? rej(err) : res(how);
    }
    const entry = { done };
    tour.pressing = entry;
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('click', key, true);
  });
}
const opened = () => view === 'section';

/* ---- spotlight ---- */
let spotTarget = null, spotOpts = {}, spotRaf = 0;
function spot(target, opts){
  spotTarget = target || null;
  spotOpts = opts || {};
  q('#tour-spot').classList.toggle('round', !!spotOpts.round);
  if(!spotRaf) spotLoop();
}
function spotLoop(){
  spotRaf = requestAnimationFrame(spotLoop);
  spotFrame();
}
/* place the ring, and cut the blur's hole, around whatever is lit right now */
function spotFrame(){
  const s = q('#tour-spot'), card = q('#tour-card'), shade = q('#tour-shade');
  const el = resolveEl(spotTarget);
  if(!el || !el.getClientRects().length){ s.style.opacity = '0'; shade.style.clipPath = 'none'; return; }
  const r = el.getBoundingClientRect();
  const pad = spotOpts.pad == null ? 8 : spotOpts.pad;
  s.hidden = false;
  s.style.opacity = '1';
  s.style.transform = 'translate(' + (r.left - pad) + 'px,' + (r.top - pad) + 'px)';
  s.style.width = (r.width + pad * 2) + 'px';
  s.style.height = (r.height + pad * 2) + 'px';
  if(!shade.hidden){
    // the blur covers the whole screen except a hole the shape of the ring,
    // and clicks pass through that hole to the real button underneath
    const x = r.left - pad, y = r.top - pad, w = r.width + pad * 2, h = r.height + pad * 2;
    const k = Math.min(spotOpts.round ? Math.min(w, h) / 2 : 18, w / 2, h / 2);
    const W = innerWidth, H = innerHeight;
    shade.style.clipPath = 'path(evenodd, "M0 0H' + W + 'V' + H + 'H0Z' +
      'M' + (x + k) + ' ' + y + 'H' + (x + w - k) + 'A' + k + ' ' + k + ' 0 0 1 ' + (x + w) + ' ' + (y + k) +
      'V' + (y + h - k) + 'A' + k + ' ' + k + ' 0 0 1 ' + (x + w - k) + ' ' + (y + h) +
      'H' + (x + k) + 'A' + k + ' ' + k + ' 0 0 1 ' + x + ' ' + (y + h - k) +
      'V' + (y + k) + 'A' + k + ' ' + k + ' 0 0 1 ' + (x + k) + ' ' + y + 'Z")';
  }
  // on a narrow screen the caption gets out of the way of whatever is lit
  if(innerWidth < 760) card.classList.toggle('at-top', (r.top + r.height / 2) > innerHeight * 0.5 && r.height < innerHeight * 0.7);
  else card.classList.remove('at-top');
}

/* ---- caption ---- */
let curStepN = 0;
function say(n, title, body){
  curStepN = n;
  const card = q('#tour-card');
  card.hidden = false;
  q('#tc-step').textContent = 'Step ' + n + ' of ' + TOUR_STEPS;
  q('#tc-bar').style.width = (n / TOUR_STEPS * 100) + '%';
  if(q('#tc-title').textContent !== title){
    q('#tc-title').textContent = title;
    card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
  }
  q('#tc-body').textContent = body;
}
/* 'watch'  = the cursor is doing the in-between bits; Next (mid-step)
   'press'  = the visitor's turn; Show me or Next (mid-step)
   'replay' = Show again is playing; Next cuts it short
   'idle'   = step done; Show again or Next */
let lastNextLabel = 'Next';
function cardMode(mode, nextLabel, turnLabel){
  const wait = q('#tc-wait');
  wait.hidden = mode === 'idle';
  wait.classList.toggle('your-turn', mode === 'press');
  q('#tc-wait-text').textContent = mode === 'replay' ? 'Showing it again' : mode === 'press' ? (turnLabel || 'Your turn: click it') : 'Watch';
  q('#tc-replay-tag').hidden = mode !== 'replay';
  const again = q('#tc-again');
  again.hidden = !(mode === 'idle' || mode === 'press');
  again.innerHTML = mode === 'press' ? 'Show me' : '&#8634; Show again';
  const next = q('#tc-next');
  next.hidden = false;
  if(mode === 'idle' || mode === 'replay') lastNextLabel = nextLabel || 'Next';
  next.textContent = (mode === 'watch' || mode === 'press') ? 'Next' : lastNextLabel;
  next.classList.add('btn-primary');
  if(mode === 'idle'){ try{ next.focus({ preventScroll:true }); }catch(e){} }
}
function waitChoice(){
  const tk = tour.token;
  return new Promise((res, rej) => {
    tour.choice = c => { tour.choice = null; tk === tour.token ? res(c) : rej(new TourStop()); };
  });
}
function tourNext(){
  if(tour.choice){ tour.choice('next'); return; }
  if(tour.replaying){ tour.skipReplay = true; cancelStep(); return; }
  // Next (mid-step): run the rest of this step instantly, then move on
  if(tour.on && !tour.fast){
    tour.fast = true;
    q('#tour-cursor').hidden = true;
    hurrySleepers();
    if(tour.pressing) tour.pressing.done('skip');
  }
}
function tourAgain(){
  if(tour.choice){ tour.choice('again'); return; }
  if(tour.pressing) tour.pressing.done('show');
}
function cancelStep(){ tour.stepTok++; wakeSleepers(new StepSkip()); }

/* ---- rewinding ---- */
function snapshot(){
  const docs = {};
  COLS.forEach(n => { docs[n] = cols[n]._dump(); });
  return {
    docs, strokes: JSON.parse(JSON.stringify(strokes)), look: Object.assign({}, look),
    view, active: activeBubbleId, cam: { x:cam.x, y:cam.y, z:cam.z }, scroll: window.scrollY,
  };
}
function closeAllUi(){
  if(document.getElementById('modal').classList.contains('open')) closeModal();
  ['tasks-sheet', 'imp-sheet', 'trash-sheet', 'settings-sheet'].forEach(closeSheet);
  closeHelper();
  setHubMode('move');
  document.getElementById('toast').classList.remove('show');
  document.getElementById('activity').hidden = true;
}
async function restore(s){
  if(chatBusy && demoRun){ try{ await demoRun; }catch(e){} }
  closeAllUi();
  clearTimeout(inkSaveTimer); inkDirty = false;
  drawing = null;
  COLS.forEach(n => cols[n]._load(s.docs[n]));
  strokes = JSON.parse(JSON.stringify(s.strokes));
  look = Object.assign({}, s.look); applyLook(look); renderSettings();
  if(s.view === 'section' && bubbleById(s.active)) openSection(s.active); else goHub();
  cam.x = s.cam.x; cam.y = s.cam.y; cam.z = s.cam.z;
  applyCamera(); redrawInk();
  window.scrollTo(0, s.scroll);
}

/* ---- shared moves ---- */
async function backToHub(){
  if(view !== 'hub') await press('#sec-title-wrap .btn-ghost');
  window.scrollTo({ top:0, behavior: REDUCED ? 'auto' : 'smooth' });
  await beat(380);
  const glide = fitView();
  if(tour.replaying || tour.fast) await glide;   // on the visitor's own run the blur follows the glide
}
const bubbleNamed = name => () => {
  const b = state.bubbles.find(x => x.name === name);
  return b ? bubbleEls.get(b.id) : null;
};
const idNamed = name => (state.bubbles.find(x => x.name === name) || {}).id;
const lastWidgetId = () => {
  const b = bubbleById(activeBubbleId);
  const ws = b ? getWidgets(b) : [];
  return ws.length ? ws[ws.length - 1].id : '';
};
const rowWith = (sel, text) => () =>
  Array.from(document.querySelectorAll(sel)).find(el => el.textContent.includes(text)) || null;

/* ---- the twelve steps ----
   play() shows the action and may run any number of times; after() tidies
   up once the viewer moves on. */
const STEPS = [
  {
    async play(){
      if(view !== 'hub') goHub();
      await fitView();
      say(1, 'Meet Cosmo', 'The bubble in the middle is Cosmo, your assistant. It can see your whole hub and change it for you.');
      spot('#bubble-center', { round:true, pad:10 });
      await beat(1300);
      await press('#bubble-center', { action: () => openHelper(), round:true, pad:10 });
      await beat(420);
      spot('#helper-sheet .sheet-card', { pad:-3 });
      say(1, 'Meet Cosmo', 'This is Cosmo. Ask a question or tell it what to add, and it does the work. You will try it in a few steps, so close it with the X for now.');
      await press('#helper-sheet .sheet-head .icon-btn', { area:'#helper-sheet .sheet-card', pad:-3, label:'Your turn: close Cosmo' });
      await beat(350);
      say(1, 'Your to-dos', 'Every to-do and reminder from every part of your life lives behind the checklist up top. The number shows what is due right now.');
      spot('#todo-btn', { round:true, pad:6 });
      await beat(1100);
      await press('#todo-btn', { round:true });
      await tsleep(420);
      spot('#tasks-sheet .sheet-card', { pad:-3 });
      say(1, 'Your to-dos', 'Sorted into Overdue, Today and Upcoming. Each to-do is tagged with the bubble it belongs to.');
      await tsleep(1800);
    },
    after(){ closeHelper(); closeSheet('tasks-sheet'); },
  },
  {
    async play(){
      say(2, 'Add a bubble', 'Every bubble around the middle is one part of your life. Making a new one takes a name and a colour.');
      spot('#add-bubble-btn', { pad:6 });
      await beat(1100);
      await press('#add-bubble-btn');
      await beat(320);
      spot('#modal-card', { pad:4 });
      await typeInto('#nb-name', 'Gym');
      await press('#tone-picker [data-tone="green"]', { round:true, pad:4 });
      await beat(250);
      await press('#modal-card .btn-primary');
      await tsleep(520);
      spot('#sec-title-wrap', { pad:8 });
      say(2, 'Add a bubble', 'Gym is now on the map, and Wayfinder opens it straight away so you can fill it in.');
      await tsleep(1500);
    },
  },
  {
    async play(){
      say(3, 'Add panels', 'A bubble is a grid of panels. There are ten kinds: checklists, notes, numbers with targets, tables, dates, progress bars, habit streaks, links, sticky notes and a job-application tracker.');
      spot('.add-widget', { pad:6 });
      await beat(1500);
      await press('.add-widget');
      await tsleep(320);
      spot('#modal-card', { pad:4 });
      await typeInto('#aw-title', 'Daily habits');
      // whatever kind gets picked, the name follows it, so the visitor never has to type one
      const kindSel = q('#aw-type');
      if(kindSel) kindSel.addEventListener('change', () => {
        const t = q('#aw-title');
        if(t) t.value = kindSel.value === 'habit' ? 'Daily habits' : WIDGET_KINDS[kindSel.value].label;
      });
      say(3, 'Add panels', 'Pick the kind of panel you want from the Type list, then click Add panel. Habit streak is a fun one to try.');
      await press('#modal-card .btn-primary', {
        area:'#modal-card', pad:4, label:'Your turn: pick a type, then Add panel',
        action: () => { q('#aw-type').value = 'habit'; q('#aw-title').value = 'Daily habits'; submitAddWidget(); },
      });
      await tsleep(450);
      const kind = (getWidgets(bubbleById(activeBubbleId)).find(w => w.id === lastWidgetId()) || {}).type;
      const panel = () => { const box = q('[data-wid="add:' + lastWidgetId() + '"]'); return box ? box.closest('.widget') : null; };
      const box = () => q('[data-wid="add:' + lastWidgetId() + '"]');
      const newPanel = () => { const w = document.querySelectorAll('#widget-grid .widget'); return w[w.length - 1] || null; };
      spot(() => panel() || newPanel(), { pad:6 });
      if(kind === 'habit'){
        say(3, 'Add panels', 'Type into a panel to fill it. Here, two habits go in and a few days get ticked off. The streak counts itself.');
        await typeInto(box, 'Morning run');
        addItem(lastWidgetId(), 'Morning run');
        await tsleep(300);
        await typeInto(box, 'Stretch for 10 minutes');
        addItem(lastWidgetId(), 'Stretch for 10 minutes');
        await tsleep(300);
        const day = (row, i) => () => { const p = panel(); const rows = p ? p.querySelectorAll('.habit-row') : []; return rows[row] ? rows[row].querySelectorAll('.habit-day')[i] : null; };
        for(const i of [4, 5, 6]) await tap(day(0, i));
        await tap(day(1, 6));
      }
      say(3, 'Add panels', (kind === 'habit' ? '' : 'Your panel is in. Type straight into it to fill it, and everything saves as you go. ') +
        'Panels come in sizes too. Click the resize button in its corner.');
      await press(() => { const p = panel() || newPanel(); return p ? p.querySelector('[title="Resize"]') : null; });
      await tsleep(300);
      say(3, 'Add panels', 'Every panel can be resized, renamed or removed from the buttons in its corner.');
      await tsleep(1500);
    },
  },
  {
    async play(){
      say(4, 'Step inside a bubble', 'Back on the map, click any bubble to open it.');
      await backToHub();
      const school = bubbleNamed('School');
      spot(school, { round:true, pad:10 });
      await beat(700);
      await press(school, { action: () => openSection(idNamed('School')), round:true, pad:10, check: opened });
      await tsleep(650);
      spot('#widget-grid', { pad:8 });
      say(4, 'Step inside a bubble', 'School is already set up: deadlines that turn orange as they get close, a weekly checklist, study hours against a goal, progress per class, quick links and sticky notes.');
      await tsleep(2000);
      await tap(() => { const r = rowWith('.check-row', 'Go to office hours')(); return r ? r.querySelector('input') : null; });
      const plus = () => { const r = rowWith('.prog-row', 'Calculus II')(); return r ? r.querySelectorAll('.icon-btn')[1] : null; };
      await tap(plus);
      await tap(plus);
      say(4, 'Step inside a bubble', 'Everything is live. Ticking a box or bumping a progress bar saves on the spot.');
      await tsleep(1500);
    },
  },
  {
    async play(){
      say(5, 'Delete a bubble', 'Removing a bubble is just as quick, and nothing is lost for good.');
      await backToHub();
      const misc = bubbleNamed('Misc');
      spot(misc, { round:true, pad:10 });
      await beat(700);
      await press(misc, { action: () => openSection(idNamed('Misc')), round:true, pad:10, check: opened });
      await beat(550);
      spot('[onclick="deleteCurrentBubble()"]', { pad:6 });
      await beat(500);
      await press('[onclick="deleteCurrentBubble()"]');
      await beat(320);
      spot('#modal-card', { pad:4 });
      await beat(900);
      await press('.dlg-acts .btn-danger');
      await beat(500);
      { const glide = fitView(); if(tour.replaying || tour.fast) await glide; }
      spot('#trash-btn', { round:true, pad:6 });
      say(5, 'Delete a bubble', 'Misc went to the trash. Undo it from the pop-up, press ⌘Z, or open the trash can that just appeared.');
      await beat(1500);
      await press('#trash-btn', { round:true });
      await tsleep(420);
      spot('#trash-sheet .sheet-card', { pad:-3 });
      say(5, 'Delete a bubble', 'Anything in here can be restored with one click, panels and all.');
      await tsleep(1500);
    },
    after(){ closeSheet('trash-sheet'); },
  },
  {
    async play(){
      say(6, 'Sub-sections', 'Bubbles can branch off other bubbles, so a big area like School can split into one bubble per class.');
      spot('#add-bubble-btn', { pad:6 });
      await beat(1000);
      await press('#add-bubble-btn');
      await tsleep(320);
      spot('#modal-card', { pad:4 });
      await typeInto('#nb-name', 'Chemistry');
      await tap('#nb-parent', () => { q('#nb-parent').value = idNamed('School'); parentChanged(); });
      await tsleep(400);
      await tap('#tone-picker [data-tone="violet"]');
      await beat(250);
      say(6, 'Sub-sections', 'Chemistry is set to sit under School. Click Create.');
      await press('#modal-card .btn-primary');
      await beat(500);
      await backToHub();
      spot(bubbleNamed('Chemistry'), { round:true, pad:12 });
      say(6, 'Sub-sections', 'Chemistry now hangs off School, and School gets a ring to show it has branches.');
      await tsleep(2000);
    },
  },
  {
    async play(){
      say(7, 'Detach and reattach', 'Chemistry hangs off School right now. To break it loose, press and hold Chemistry, then shake it quickly left and right until the line to School snaps.');
      await backToHub();
      spot(bubbleNamed('Chemistry'), { round:true, pad:12 });
      await beat(1300);
      await yourTurn('#hub-canvas', {
        pad:-2, label:'Your turn: shake Chemistry',
        done: () => { const b = bubbleById(idNamed('Chemistry')); return !!b && !b.parentId && draggingId === null; },
        demo: () => shakeLoose('Chemistry'),
      });
      spot(bubbleNamed('Chemistry'), { round:true, pad:12 });
      say(7, 'Detach and reattach', 'Chemistry is on its own now. To attach it again, drag it on top of School and let go.');
      spot(bubbleNamed('School'), { round:true, pad:12 });
      await beat(1400);
      await yourTurn('#hub-canvas', {
        pad:-2, label:'Your turn: drop Chemistry on School',
        done: () => { const b = bubbleById(idNamed('Chemistry')); return !!b && b.parentId === idNamed('School') && draggingId === null; },
        demo: () => dragOnto('Chemistry', 'School'),
      });
      spot(bubbleNamed('Chemistry'), { round:true, pad:12 });
      say(7, 'Detach and reattach', 'Back under School. Drop any bubble onto another to attach it, or onto Cosmo in the middle to put it back on the main map.');
      await tsleep(2000);
    },
  },
  {
    async play(){
      say(8, 'Resize a bubble', 'Bubbles can be any size, so the big parts of your life can look big. Grab the small handle on the bottom-right edge of Work and drag it outward.');
      await backToHub();
      const work = bubbleNamed('Work');
      const el = work();
      if(el) el.classList.add('tour-grip');
      spot(work, { round:true, pad:14 });
      await beat(1200);
            const size0 = (bubbleById(idNamed('Work')) || {}).size;
      await yourTurn('#hub-canvas', {
        pad:-2, label:'Your turn: drag the handle',
        done: () => { const b = bubbleById(idNamed('Work')); return !!b && b.size !== size0 && resizingId === null; },
        demo: () => resizeBubble('Work', 1.35),
      });
      spot(work, { round:true, pad:14 });
      say(8, 'Resize a bubble', 'Drag it back in to shrink it. Every bubble has the handle when you hover over it.');
      await tsleep(1800);
    },
    after(){ const el = bubbleNamed('Work')(); if(el) el.classList.remove('tour-grip'); },
  },
  {
    async play(){
      // this step plays by itself: the visitor just watches Cosmo work
      say(9, 'Ask Cosmo', 'Watch Cosmo at work. You tell it what you need in plain words, and it does the rest.');
      await backToHub();
      spot('#bubble-center', { round:true, pad:10 });
      await tsleep(900);
      await tap('#bubble-center', () => openHelper());
      await tsleep(420);
      spot('#helper-sheet .sheet-foot', { pad:-3 });
      await typeInto('#chat-input', 'Add chemistry homework due Friday', 50);
      await tsleep(250);
      await tap('#send-btn');
      spot('#chat-body', { pad:-3 });
      say(9, 'Ask Cosmo', 'It reads the hub, works out the date, matches "chemistry" to the Chemistry bubble and adds the to-do.');
      if(demoRun) await demoRun;
      await tsleep(1600);
      await tap('#helper-sheet .sheet-head .icon-btn', () => closeHelper());
      await tsleep(300);
      spot(bubbleNamed('Chemistry'), { round:true, pad:10 });
      await tap(bubbleNamed('Chemistry'), () => openSection(idNamed('Chemistry')));
      await tsleep(600);
      spot(() => { const w = document.querySelectorAll('#widget-grid .widget'); return w[1] || w[0]; }, { pad:6 });
      const t = state.tasks.find(x => /chemistry homework/i.test(x.text));
      say(9, 'Ask Cosmo', 'Open Chemistry and the homework is already there' + (t && t.due ? ', due ' + whenLabel(t.due) : '') +
        '. In the full app Cosmo runs on Claude, so it can also lay out a whole bubble from one sentence.');
      await tsleep(1800);
    },
  },
  {
    async play(){
      say(10, 'Draw on the map', 'Switch to Draw to sketch right on the grid: circle what matters or map out an idea.');
      await backToHub();
      spot('#ink-bar', { pad:6 });
      await beat(700);
      await press('#tool-draw');
      await beat(250);
      inkWidth = 4;
      say(10, 'Draw on the map', 'Hold and drag anywhere on the map to draw. Try circling Chemistry.');
      const n0 = strokes.length;
      await yourTurn('#hub-canvas', {
        pad:-2, label:'Your turn: draw something',
        done: () => strokes.length > n0 && !drawing,
        demo: async () => {
          await tap('#ink-swatches [data-col="#E0A53E"]');
          await drawRing('Chemistry');
        },
      });
      say(10, 'Draw on the map', 'Drawings are pinned to the map, so they move with it as you pan and zoom. Now switch to Erase.');
      spot('#ink-bar', { pad:6 });
      await beat(900);
      await press('#tool-erase');
      await beat(250);
      say(10, 'Draw on the map', 'Drag across your drawing to rub it out.');
      const n1 = strokes.length;
      await yourTurn('#hub-canvas', {
        pad:-2, label:'Your turn: erase it',
        done: () => strokes.length < n1,
        demo: () => eraseLast(),
      });
      say(10, 'Draw on the map', 'Gone. Undo (⌘Z) brings it back if you change your mind. Switch back to Move to finish.');
      await press('#tool-move');
      await tsleep(1100);
    },
  },
  {
    async play(){
      say(11, 'Make it yours', 'Wayfinder can look however you like: themes, fonts, text size and colour, all from one panel.');
      spot('#settings-btn', { round:true, pad:6 });
      await beat(1000);
      await press('#settings-btn', { round:true });
      await beat(420);
      spot('#theme-grid', { pad:8 });
      say(11, 'Make it yours', 'Try one: click any theme and the whole hub repaints on the spot.');
      const themeCard = id => () => q('#theme-grid [onclick="setTheme(\'' + id + '\')"]');
      await yourTurn('#theme-grid', {
        pad:8, label:'Your turn: pick a theme',
        done: () => look.theme !== DEFAULT_THEME,
        demo: () => tap(themeCard('forest')),
      });
      await tsleep(900);
      // a quick taste only: the tour always carries on in the default look
      say(11, 'Make it yours', 'That is all it takes. Back to the default for the rest of the tour. You can change it any time from here.');
      await tsleep(900);
      await tap(themeCard(DEFAULT_THEME));
      await tsleep(1200);
    },
    after(){ if(look.theme !== DEFAULT_THEME) setTheme(DEFAULT_THEME); closeSheet('settings-sheet'); },
  },
  {
    async play(){
      say(12, 'Important info', 'The warning sign keeps what you never want to dig for again: office hours, rent day, codes and IDs. It is one click from anywhere.');
      spot('#imp-btn', { round:true, pad:6 });
      await beat(1100);
      await press('#imp-btn', { round:true });
      await beat(420);
      spot('#imp-sheet .sheet-foot', { pad:-3 });
      await typeInto('#new-imp', 'Locker combo: 12-34-08');
      await press('#imp-sheet .sheet-foot .btn-primary');
      await tsleep(350);
      spot('#imp-body', { pad:-3 });
      say(12, 'Important info', 'Pinned. Anything due in the next couple of days shows up here too, and the sign glows red until it is handled.');
      await tsleep(1500);
    },
    after(){ closeSheet('imp-sheet'); },
    last: true,
  },
];

function line(a, b, n){
  const out = [];
  for(let i = 0; i <= n; i++) out.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
  return out;
}
async function drawStroke(points){
  if(!points.length) return;
  await moveTo(points[0], 380);
  const [wx, wy] = screenToWorld(points[0].x, points[0].y);
  drawing = { id: uid(), c: inkColor, w: inkWidth, v: 2, p: [Math.round(wx*10)/10, Math.round(wy*10)/10] };
  for(let i = 1; i < points.length; i++){
    placeCursor(points[i].x, points[i].y, 0);
    const [x, y] = screenToWorld(points[i].x, points[i].y);
    drawing.p.push(Math.round(x*10)/10, Math.round(y*10)/10);
    redrawInk();
    await tsleep(14);
  }
  commitStroke();
  await tsleep(120);
}

/* map position -> screen position (the inverse of screenToWorld) */
function worldToScreen(wx, wy){
  const r = hubRect();
  return { x: r.left + r.width / 2 + (wx - cam.x) * cam.z, y: r.top + r.height / 2 + (wy - cam.y) * cam.z };
}
/* Show me for drawing: one loose ring around a bubble */
async function drawRing(name){
  const el = bubbleNamed(name)();
  if(!el) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width / 2 + 16;
  const ring = [];
  for(let i = 0; i <= 64; i++){
    const a = -Math.PI * 0.6 + (i / 64) * Math.PI * 2.15;
    const w = 1 + Math.sin(i * 0.5) * 0.035;
    ring.push({ x: cx + Math.cos(a) * rad * 1.12 * w, y: cy + Math.sin(a) * rad * 0.98 * w });
  }
  await drawStroke(ring);
}
/* Show me for erasing: run the cursor along the newest stroke and rub it out */
async function eraseLast(){
  const st = strokes[strokes.length - 1];
  if(!st) return;
  const p = st.p || [], pts = [];
  const every = Math.max(2, 2 * Math.floor(p.length / 2 / 24));
  for(let i = 0; i < p.length; i += every) pts.push(worldToScreen(p[i], p[i + 1]));
  if(pts.length) await moveTo(pts[0], 380);
  for(const pt of pts){ placeCursor(pt.x, pt.y, 0); await tsleep(18); }
  const gone = () => { strokes = strokes.filter(s => s.id !== st.id); redrawInk(); saveInk(); };
  gone();
  record('erase a stroke', () => { strokes = strokes.concat([st]); redrawInk(); saveInk(); }, gone);
  await tsleep(300);
}
/* Show me for detaching: wiggle the cursor on the bubble and shake it off */
async function shakeLoose(name){
  const el = bubbleNamed(name)();
  const id = idNamed(name), b = bubbleById(id);
  if(!el || !b || !b.parentId) return;
  await moveTo(el);
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for(let i = 0; i < 6; i++){ placeCursor(cx + (i % 2 ? -26 : 26), cy, tour.fast ? 0 : 90); await tsleep(70); }
  placeCursor(cx, cy, tour.fast ? 0 : 120);
  const was = parentOf(b);
  el.classList.add('shaken');
  setTimeout(() => el.classList.remove('shaken'), 420);
  await setParent(id, null, 'shaking "' + name + '" loose');
  toast('Shook "' + name + '" off ' + ((was && was.name) || 'the hub'));
  await tsleep(500);
}

/* Show me for reattaching: carry a bubble onto another and drop it there,
   landing just outside the rim the way a real drop does */
async function dragOnto(name, ontoName){
  const el = bubbleNamed(name)(), onto = bubbleNamed(ontoName)();
  const id = idNamed(name), ontoId = idNamed(ontoName);
  if(!el || !onto || !el._pos || !onto._pos) return;
  await moveTo(el);
  await tsleep(200);
  const a = { x: el._pos.x, y: el._pos.y }, t = { x: onto._pos.x, y: onto._pos.y };
  el.classList.add('dragging');
  const n = tour.fast ? 1 : 24;
  for(let i = 1; i <= n; i++){
    const k = 1 - Math.pow(1 - i / n, 2);
    const x = a.x + (t.x - a.x) * k * 0.8, y = a.y + (t.y - a.y) * k * 0.8;
    el.style.left = x + 'px'; el.style.top = y + 'px'; el._pos = { x, y };
    const sp = worldToScreen(x, y); placeCursor(sp.x, sp.y, 0);
    drawLinks();
    await tsleep(22);
  }
  el.classList.remove('dragging');
  let vx = a.x - t.x, vy = a.y - t.y, len = Math.hypot(vx, vy);
  if(len < 1){ vx = 0; vy = -1; len = 1; }
  const gap = radiusOf(bubbleById(ontoId)) + radiusOf(bubbleById(id)) + 26;
  const fx = Math.round(t.x + vx / len * gap), fy = Math.round(t.y + vy / len * gap);
  el.style.left = fx + 'px'; el.style.top = fy + 'px'; el._pos = { x: fx, y: fy };
  await cols.bubbles.update(id, { wx: fx, wy: fy });
  await setParent(id, ontoId, 'connecting "' + name + '" to "' + ontoName + '"');
  toast('Connected "' + name + '" to ' + ontoName);
  drawLinks();
  await tsleep(500);
}
/* Show me for resizing: pull the rim handle outward */
async function resizeBubble(name, factor){
  const el = bubbleNamed(name)(), b = bubbleById(idNamed(name));
  if(!el || !b) return;
  const grip = el.querySelector('.b-grip');
  if(grip) await moveTo(grip);
  await tsleep(200);
  const r0 = radiusOf(b), r1 = clamp(r0 * factor, R_MIN, R_MAX);
  el.classList.add('resizing');
  const n = tour.fast ? 1 : 18;
  for(let i = 1; i <= n; i++){
    const r = r0 + (r1 - r0) * i / n;
    el.style.width = el.style.height = (r * 2) + 'px'; el._r = r;
    drawLinks();
    const box = el.getBoundingClientRect();
    placeCursor(box.left + box.width * 0.854, box.top + box.height * 0.854, 0);
    await tsleep(30);
  }
  el.classList.remove('resizing');
  const prev = typeof b.size === 'number' ? b.size : null, next = Math.round(r1);
  const write = v => cols.bubbles.update(b.id, { size: v }).catch(() => {});
  await write(next);
  record('resizing "' + name + '"', () => write(prev), () => write(next));
  await tsleep(400);
}

/* ---- running it ---- */
/* one replay that Next can cut short; if it does, jump to how the step ends */
async function replay(step, before, after){
  await restore(before);
  await tsleep(500);
  tour.replaying = true;
  tour.skipReplay = false;
  try{
    await step.play();
  }catch(e){
    if(!(e instanceof StepSkip)) throw e;
    tour.stepTok++;                   // fresh token for whatever comes next
    await restore(after);
  }finally{
    tour.replaying = false;
  }
}
async function runStep(step){
  const before = snapshot();
  tour.fast = false;
  cardMode('watch');
  try{
    await step.play();
  }finally{
    const skipped = tour.fast;
    tour.fast = false;
    if(skipped && tour.on){ if(step.after) step.after(); return; }   // Next (mid-step): straight on
  }
  const after = snapshot();

  for(;;){
    cardMode('idle', step.last ? 'Finish' : 'Next');
    const choice = await waitChoice();
    if(choice === 'next') break;
    cardMode('replay', step.last ? 'Finish' : 'Next');
    await replay(step, before, after);
    if(tour.skipReplay) break;
  }
  if(step.after) step.after();
}
async function runTour(){
  tour.on = true;
  tour.token++;
  document.body.classList.add('touring');
  q('#tour-block').hidden = false;
  q('#tour-btn').hidden = true;
  placeCursor(innerWidth / 2, innerHeight * 0.72, 0);
  try{
    for(const step of STEPS) await runStep(step);
    endTour();
    showDone();
  }catch(e){
    if(!(e instanceof TourStop)) console.error('tour', e);
  }
}
function endTour(){
  tour.on = false;
  tour.token++;
  tour.replaying = false;
  tour.fast = false;
  wakeSleepers(new TourStop());
  if(tour.choice){ const c = tour.choice; tour.choice = null; try{ c('stop'); }catch(e){} }
  if(tour.pressing){ const p = tour.pressing; tour.pressing = null; p.done(null, new TourStop()); }
  cancelAnimationFrame(spotRaf); spotRaf = 0; spotTarget = null;
  ['#tour-spot', '#tour-cursor', '#tour-card', '#tour-block', '#tour-shade'].forEach(s => { q(s).hidden = true; });
  document.body.classList.remove('touring');
  if(drawing) commitStroke();
  closeAllUi();
  if(view !== 'hub') goHub();
  q('#tour-btn').hidden = false;
  setTimeout(() => fitView(), 60);
}
function skipTour(){ endTour(); }

function showDone(){
  const d = q('#tour-done');
  q('#td-title').textContent = tour.name ? 'You are all set, ' + tour.name + '.' : 'That is Wayfinder.';
  d.hidden = false;
  setTimeout(() => { const b = q('#td-explore'); if(b) b.focus(); }, 60);
}
function closeDone(){ q('#tour-done').hidden = true; }

function resetDemo(){
  COLS.forEach(n => cols[n]._reset());
  strokes = []; drawing = null; redrawInk();
  history.past = []; history.future = []; renderHistory();
  pinnedPos.clear();
  look = { theme: DEFAULT_THEME, font:'publicsans', scale:100, textColor:'' };
  applyLook(look);
  seedDemo();
  if(view !== 'hub') goHub(); else render();
  document.getElementById('activity').hidden = true;
}
function replayTour(){
  closeDone();
  if(tour.on) endTour();
  resetDemo();
  window.scrollTo(0, 0);
  setTimeout(runTour, 350);
}

/* ---- welcome and name ---- */
function setGreeting(name){
  const el = q('#greet-name');
  el.textContent = name ? 'Welcome, ' + name : 'Welcome';
  el.classList.remove('greet-in'); void el.offsetWidth; el.classList.add('greet-in');
}
function welcomeClick(e){
  const hello = q('#tw-hello');
  if(hello.hidden) return;
  if(e && e.target && e.target.closest('.tw-card')) return;
  hello.hidden = true;
  q('#tw-name').hidden = false;
  setTimeout(() => { const i = q('#tw-name-input'); if(i) i.focus(); }, 80);
}
function startFromName(e){
  if(e) e.preventDefault();
  const raw = (q('#tw-name-input').value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  tour.name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
  setGreeting(tour.name);
  closeWelcome();
  setTimeout(runTour, 420);
}
function skipFromWelcome(){
  const raw = (q('#tw-name-input').value || '').trim().slice(0, 40);
  tour.name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
  setGreeting(tour.name);
  closeWelcome();
  q('#tour-btn').hidden = false;
}
function closeWelcome(){
  const w = q('#tour-welcome');
  w.classList.add('leaving');
  setTimeout(() => { w.hidden = true; }, REDUCED ? 0 : 380);
}

q('#tour-welcome').addEventListener('click', welcomeClick);
q('#tour-welcome').addEventListener('keydown', e => {
  if((e.key === 'Enter' || e.key === ' ') && !q('#tw-hello').hidden){ e.preventDefault(); welcomeClick(); }
});
q('#tw-name').addEventListener('submit', startFromName);
q('#tw-skip').addEventListener('click', skipFromWelcome);
document.addEventListener('keydown', e => {
  if(!tour.on) return;
  if(e.key === 'Escape'){ e.stopImmediatePropagation(); skipTour(); return; }
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  // Enter only moves on between steps, so it never skips a step by accident
  if(e.key === 'ArrowRight' || (e.key === 'Enter' && tour.choice)){ e.preventDefault(); tourNext(); }
  else if(e.key === 'ArrowLeft' || e.key.toLowerCase() === 'r'){ e.preventDefault(); tourAgain(); }
}, true);


// start the app
init();
