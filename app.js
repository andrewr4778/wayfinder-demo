/* app.js — Wayfinder itself.
   Storage, the bubble map (hub), panels (widgets), drawing, themes,
   undo/redo, to-dos, Important info and the helper's tools.
   Loaded first; demo.js builds on the functions defined here. */
const DEMO = true;
const REDUCED = (() => { try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } })();
/* ============ utils ============ */
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
function pad2(n){ return String(n).padStart(2,'0'); }
function toDateStr(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function todayStr(){ return toDateStr(new Date()); }
function parseDateStr(s){ const p=String(s||'').split('-').map(Number); return new Date(p[0], (p[1]||1)-1, p[2]||1); }
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }
function daysUntil(dateStr){
  const a = parseDateStr(todayStr()), b = parseDateStr(dateStr);
  return Math.round((b - a) / 86400000);
}
function whenLabel(dateStr){
  if(!dateStr) return '';
  const d = daysUntil(dateStr);
  if(d === 0) return 'today';
  if(d === 1) return 'tomorrow';
  if(d === -1) return 'yesterday';
  if(d < 0) return Math.abs(d)+'d ago';
  if(d <= 13) return 'in '+d+'d';
  return parseDateStr(dateStr).toLocaleDateString(undefined,{month:'short', day:'numeric'});
}
function fmtDate(s){ if(!s) return ''; const d=parseDateStr(s);
  return d.toLocaleDateString(undefined,{month:'short', day:'numeric', year: d.getFullYear()!==new Date().getFullYear()?'numeric':undefined}); }

/* ============ storage (db capability + in-memory fallback) ============ */
let db = null, sampleFn = null, sampleCaps = null;

/* The fallback store, used when there is no hub behind the page — running the
   file yourself for design work. It was in-memory only, which meant anything
   added locally vanished on reload and the default sections reappeared; it now
   keeps each collection in localStorage so a local copy behaves like the real
   thing. Never used in the published artifact, where the real store exists. */
function localCollection(name){
  const KEY = 'wf_local_' + name;
  let docs = {};
  try{ docs = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }catch(e){ docs = {}; }
  let listeners = [];
  docs = {};                              // demo: every visit starts from the sample hub
  const persist = () => {};
  const arr = () => Object.entries(docs).map(([id,d]) => Object.assign({id}, thaw(d)));
  const notify = () => { persist(); listeners.forEach(fn => fn(arr())); };
  return {
    onSnapshot(fn){ listeners.push(fn); fn(arr()); return () => { listeners = listeners.filter(l=>l!==fn); }; },
    getAll(){ return Promise.resolve(arr()); },
    _reset(){ docs = {}; notify(); },
    _dump(){ return JSON.parse(JSON.stringify(docs)); },
    _load(d){ docs = JSON.parse(JSON.stringify(d || {})); notify(); },
    getOne(id){ return Promise.resolve(docs[id] ? Object.assign({id}, thaw(docs[id])) : null); },
    add(data){ const id = uid(); docs[id] = Object.assign({}, data); notify(); return Promise.resolve({id}); },
    set(id, data){ docs[id] = Object.assign({}, data); notify(); return Promise.resolve(); },
    update(id, data){ docs[id] = Object.assign({}, docs[id]||{}, data); notify(); return Promise.resolve(); },
    delete(id){ delete docs[id]; notify(); return Promise.resolve(); },
  };
}
/* The store hands back FROZEN documents — everything nested inside them is
   read-only. The app edits lists and objects in place, so take a mutable copy on
   the way in. Without this, a second stroke, a second checklist item, or a habit
   toggle silently does nothing once the first snapshot has landed. */
function thaw(o){
  if(o == null || typeof o !== 'object') return o;
  try{ return JSON.parse(JSON.stringify(o)); }
  catch(e){ return Array.isArray(o) ? o.slice() : Object.assign({}, o); }
}
function dbCollection(path){
  const col = db.collection(path);
  return {
    onSnapshot(fn){
      return col.onSnapshot(
        snap => fn(snap.docs.map(d => Object.assign({id:d.id}, thaw(d.data())))),
        err => console.error('db', path, err)
      );
    },
    async getAll(){ const s = await col.get(); return s.docs.map(d => Object.assign({id:d.id}, thaw(d.data()))); },
    async getOne(id){ const s = await col.doc(id).get(); return s.exists ? Object.assign({id:s.id}, thaw(s.data())) : null; },
    async add(data){ const ref = await col.add(data); return {id: ref.id}; },
    set(id, data){ return col.doc(id).set(data); },
    update(id, data){ return col.doc(id).update(data); },
    delete(id){ return col.doc(id).delete(); },
  };
}

const COLS = ['bubbles','tasks','important','chat','meta','drawing','trash','settings','drafts'];
const cols = {};
const state = { bubbles:[], tasks:[], important:[], chat:[], meta:[], drawing:[], trash:[], settings:[], drafts:[] };

/* ============ app state ============ */
let view = 'hub';            // 'hub' | 'section'
let activeBubbleId = null;
const TONES = ['teal','amber','violet','green','rose','blue'];

function bubbleById(id){ return state.bubbles.find(b => b.id === id) || null; }
function sortedBubbles(){ return state.bubbles.slice().sort((a,b) => (a.createdAt||0) - (b.createdAt||0)); }
function openTasks(){ return state.tasks.filter(t => !t.done); }
function tasksFor(id){ return state.tasks.filter(t => t.bubbleId === id && !t.done); }
/* Due dates are flagged in one place only: the warning sign in the top bar
   (see renderImportant). Overdue, today and the next two days count. */
const COMING_UP_DAYS = 2;
function comingUp(){
  return openTasks().filter(t => t.due && daysUntil(t.due) <= COMING_UP_DAYS)
    .sort((a, b) => daysUntil(a.due) - daysUntil(b.due));
}

/* ============ HUB ============ */
/* Bubbles are updated in place, never torn down and rebuilt. Rebuilding was what
   made them slide in from the corner on every save — a fresh element animates its
   centring transform from nothing. */

/* ============ THE CAMERA ============
   The hub is not a box any more — it is a window onto an endless graph. Bubbles
   and strokes live at world coordinates with the to-do bubble parked at (0,0),
   and everything you see is that world pushed through one camera: cam.x/cam.y is
   the world point sitting in the middle of the window, cam.z is the zoom.
   The page grid is driven from the same numbers, so the graph really does slide
   underneath you instead of the bubbles sliding over a fixed backdrop. */
const cam = { x:0, y:0, z:1 };
const ZMIN = 0.2, ZMAX = 3;
const R_SEC = 54, R_CEN = 68;          // default section radius, and the hub's
const R_MIN = 24, R_MAX = 120;         // how far a bubble can be resized by hand
/* A bubble gets smaller the further it branches out, so the shape of the web
   tells you the shape of your life without you having to size anything. A bubble
   with its own `size` ignores this — that is the manual override. */
const DEPTH_R = [54, 44, 36, 30, 26];

/* The parent link is just an id on the document, which means the data can lie:
   a parent that was deleted, a bubble pointing at itself, or a loop made by
   dropping A on B and then B on A. Every read goes through these, so a broken
   link degrades to "hangs off the centre" instead of hanging the browser in a
   while-loop. Never walk parentId by hand. */
function parentOf(b){
  if(!b || !b.parentId || b.parentId === b.id) return null;
  return bubbleById(b.parentId) || null;
}
function ancestorsOf(id){
  const chain = [];
  const seen = new Set();
  let cur = bubbleById(id);
  while(cur && !seen.has(cur.id)){
    seen.add(cur.id);
    cur = parentOf(cur);
    if(cur) chain.push(cur);
  }
  return chain;
}
function depthOf(id){ return ancestorsOf(id).length; }
/* true when `id` is `maybeAncestor` itself or sits somewhere beneath it —
   which is exactly when attaching one to the other would make a loop */
function isUnder(id, maybeAncestor){
  if(id === maybeAncestor) return true;
  return ancestorsOf(id).some(a => a.id === maybeAncestor);
}
function childrenOf(id){
  return state.bubbles.filter(b => (parentOf(b) || {}).id === id);
}
function radiusOf(b){
  if(!b) return R_SEC;
  if(typeof b.size === 'number' && isFinite(b.size)) return clamp(b.size, R_MIN, R_MAX);
  return DEPTH_R[Math.min(depthOf(b.id), DEPTH_R.length - 1)];
}
/* where a bubble's line should end: its parent, or the hub itself */
function anchorOf(b){
  const p = parentOf(b);
  if(!p) return { x:0, y:0, r:R_CEN };
  const el = bubbleEls.get(p.id);
  const pos = (el && el._pos) || { x: p.wx || 0, y: p.wy || 0 };
  return { x:pos.x, y:pos.y, r:radiusOf(p) };
}

function hubEl(){ return document.getElementById('hub-canvas'); }
function hubRect(){ const h = hubEl(); return h ? h.getBoundingClientRect() : {left:0,top:0,width:0,height:0}; }
function screenToWorld(sx, sy){
  const r = hubRect();
  return [ cam.x + (sx - r.left - r.width/2) / cam.z,
           cam.y + (sy - r.top  - r.height/2) / cam.z ];
}
/* The map has edges. Its size is fixed (big enough for the sections and the
   hidden story scenes in the corners) and grows only if sections are placed
   further out. You can't pan past an edge, and zooming out stops once the
   whole map fills the view. */
const WORLD = { x0: -3000, x1: 2700, y0: -1800, y1: 1800 };
function worldBounds(){
  const b = { x0: WORLD.x0, x1: WORLD.x1, y0: WORLD.y0, y1: WORLD.y1 };
  bubbleEls.forEach(el => {
    if(!el._pos) return;
    const r = (el._r || R_SEC) + 300;
    b.x0 = Math.min(b.x0, el._pos.x - r); b.x1 = Math.max(b.x1, el._pos.x + r);
    b.y0 = Math.min(b.y0, el._pos.y - r); b.y1 = Math.max(b.y1, el._pos.y + r);
  });
  return b;
}
function clampCamera(){
  const r = hubRect();
  if(!r.width || !r.height) return;
  const b = worldBounds(), bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  cam.z = clamp(cam.z, Math.max(ZMIN, Math.min(r.width / bw, r.height / bh)), ZMAX);
  const hw = r.width / 2 / cam.z, hh = r.height / 2 / cam.z;
  cam.x = bw > hw * 2 ? clamp(cam.x, b.x0 + hw, b.x1 - hw) : (b.x0 + b.x1) / 2;
  cam.y = bh > hh * 2 ? clamp(cam.y, b.y0 + hh, b.y1 - hh) : (b.y0 + b.y1) / 2;
}
function applyCamera(){
  clampCamera();
  if(window.wfPetals) window.wfPetals.moved();     // safe even before the petals code has loaded
  if(window.wfAscii) window.wfAscii.moved();
  if(window.wfSnow) window.wfSnow.moved();
  if(window.wfStory) window.wfStory.moved();
  if(window.wfAstronaut) window.wfAstronaut.moved();
  const world = document.getElementById('hub-world');
  if(world) world.style.transform = 'scale(' + cam.z + ') translate(' + (-cam.x) + 'px,' + (-cam.y) + 'px)';
  const r = hubRect();
  const root = document.documentElement;
  // world (0,0) in page coordinates — the grid hangs off the same origin
  const ox = r.left + r.width/2  - cam.x * cam.z;
  const oy = r.top  + r.height/2 - cam.y * cam.z;
  root.style.setProperty('--gs',  (26 * cam.z) + 'px');
  root.style.setProperty('--gsb', (130 * cam.z) + 'px');
  root.style.setProperty('--gx',  (ox - 1) + 'px');
  root.style.setProperty('--gy',  (oy - 1) + 'px');
  // the further a layer is meant to be, the less it moves — that difference is
  // the only thing telling your eye the sky has depth
  const sky = document.getElementById('sky');
  if(sky){
    const drift = (k) => [(-cam.x * cam.z * k) + 'px', (-cam.y * cam.z * k) + 'px'];
    const [bx,by] = drift(0.03);
    const [x1,y1] = drift(0.10), [x2,y2] = drift(0.26), [x3,y3] = drift(0.52);
    sky.style.setProperty('--bx', bx);  sky.style.setProperty('--by', by);
    sky.style.setProperty('--sx1', x1); sky.style.setProperty('--sy1', y1);
    sky.style.setProperty('--sx2', x2); sky.style.setProperty('--sy2', y2);
    sky.style.setProperty('--sx3', x3); sky.style.setProperty('--sy3', y3);
  }
  const lvl = document.getElementById('zoom-level');
  if(lvl) lvl.textContent = Math.round(cam.z * 100) + '%';
  redrawInk();
  saveCam();
  scheduleMinimap();
}

/* ---- the mini-map ----
   Pops up in the corner once the sections are mostly out of view: the whole
   map, a dot for every section in its colour, Cosmo in the middle, and a box
   for where you are looking. Click or drag on it to go there; "Back to
   sections" flies home. It never shows the hidden story scenes. */
let minimapRaf = 0;
function scheduleMinimap(){ if(!minimapRaf) minimapRaf = requestAnimationFrame(() => { minimapRaf = 0; drawMinimap(); }); }
function sectionsBox(){                       // the part of the map the sections take up
  let b = { x0: -R_CEN, x1: R_CEN, y0: -R_CEN, y1: R_CEN };
  bubbleEls.forEach(el => {
    if(!el._pos) return;
    const r = el._r || R_SEC;
    b = { x0: Math.min(b.x0, el._pos.x - r), x1: Math.max(b.x1, el._pos.x + r), y0: Math.min(b.y0, el._pos.y - r), y1: Math.max(b.y1, el._pos.y + r) };
  });
  return b;
}
function minimapScale(cv){
  const b = worldBounds(), W = cv.clientWidth, H = cv.clientHeight;
  const s = Math.min(W / (b.x1 - b.x0), H / (b.y1 - b.y0));
  return { b, s, ox: (W - (b.x1 - b.x0) * s) / 2 - b.x0 * s, oy: (H - (b.y1 - b.y0) * s) / 2 - b.y0 * s };
}
function drawMinimap(){
  const box = document.getElementById('minimap'), cv = document.getElementById('minimap-canvas');
  if(!box || !cv) return;
  const r = hubRect();
  if(view !== 'hub' || !r.width){ box.hidden = true; return; }
  // how much of the sections area is still on screen
  const hw = r.width / 2 / cam.z, hh = r.height / 2 / cam.z;
  const v = { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh }, sb = sectionsBox();
  const ix = Math.max(0, Math.min(v.x1, sb.x1) - Math.max(v.x0, sb.x0)), iy = Math.max(0, Math.min(v.y1, sb.y1) - Math.max(v.y0, sb.y0));
  const seen = (ix * iy) / ((sb.x1 - sb.x0) * (sb.y1 - sb.y0));
  const zoomedRightOut = (v.x1 - v.x0) >= (worldBounds().x1 - worldBounds().x0) * 0.98;
  box.hidden = seen > 0.6 || zoomedRightOut;
  if(box.hidden) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight;
  if(cv.width !== Math.round(W * dpr)){ cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const x = cv.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
  const { b, s, ox, oy } = minimapScale(cv), X = wx => ox + wx * s, Y = wy => oy + wy * s;
  x.fillStyle = col('--surface-2'); x.strokeStyle = col('--border'); x.lineWidth = 1;
  x.beginPath(); x.roundRect(X(b.x0), Y(b.y0), (b.x1 - b.x0) * s, (b.y1 - b.y0) * s, 6); x.fill(); x.stroke();
  // links, then sections in their colours, then Cosmo
  x.strokeStyle = col('--line'); x.lineWidth = 1;
  sortedBubbles().forEach(bb => {
    const el = bubbleEls.get(bb.id); if(!el || !el._pos) return;
    const p = parentOf(bb), pel = p ? bubbleEls.get(p.id) : null, to = pel && pel._pos ? pel._pos : { x: 0, y: 0 };
    x.beginPath(); x.moveTo(X(el._pos.x), Y(el._pos.y)); x.lineTo(X(to.x), Y(to.y)); x.stroke();
  });
  sortedBubbles().forEach(bb => {
    const el = bubbleEls.get(bb.id); if(!el || !el._pos) return;
    x.fillStyle = (bb.tone && bb.tone !== 'none') ? getComputedStyle(el).getPropertyValue('--tone').trim() || col('--text-muted') : col('--text-muted');
    x.beginPath(); x.arc(X(el._pos.x), Y(el._pos.y), Math.max(2.2, (el._r || R_SEC) * s), 0, Math.PI * 2); x.fill();
  });
  x.fillStyle = col('--accent');
  x.beginPath(); x.arc(X(0), Y(0), Math.max(3, R_CEN * s), 0, Math.PI * 2); x.fill();
  // where you are looking
  x.fillStyle = col('--accent-soft'); x.strokeStyle = col('--accent'); x.lineWidth = 1.5;
  x.beginPath(); x.rect(X(v.x0), Y(v.y0), (v.x1 - v.x0) * s, (v.y1 - v.y0) * s); x.fill(); x.stroke();
}
/* whenever the map area itself changes size (not just the window), re-fit the
   drawing layer and the camera to it */
(function watchHubSize(){
  const host = document.getElementById('hub-canvas');
  if(!host || typeof ResizeObserver !== 'function') return;
  new ResizeObserver(() => { if(typeof sizeInkCanvas === 'function') sizeInkCanvas(); applyCamera(); }).observe(host);
})();
(function wireMinimap(){
  const cv = document.getElementById('minimap-canvas');
  if(!cv) return;
  let dragging = false;
  const go = (e, glide) => {
    const rect = cv.getBoundingClientRect(), { s, ox, oy } = minimapScale(cv);
    const wx = (e.clientX - rect.left - ox) / s, wy = (e.clientY - rect.top - oy) / s;
    if(glide && typeof animateCam === 'function') animateCam(wx, wy, cam.z, 420);
    else { cam.x = wx; cam.y = wy; applyCamera(); }
  };
  cv.addEventListener('pointerdown', e => { dragging = true; try{ cv.setPointerCapture(e.pointerId); }catch(err){} go(e, true); });
  cv.addEventListener('pointermove', e => { if(dragging && e.buttons) go(e, false); });
  const stop = () => { dragging = false; };
  cv.addEventListener('pointerup', stop); cv.addEventListener('pointercancel', stop);
  addEventListener('resize', scheduleMinimap);
})();
/* zoom so the world point under the cursor stays put */
function zoomAt(sx, sy, factor){
  const z0 = cam.z;
  const z1 = clamp(z0 * factor, ZMIN, ZMAX);
  if(z1 === z0) return;
  const r = hubRect();
  const dx = sx - r.left - r.width/2, dy = sy - r.top - r.height/2;
  cam.x += dx / z0 - dx / z1;
  cam.y += dy / z0 - dy / z1;
  cam.z = z1;
  applyCamera();
}
function zoomBy(factor){
  const r = hubRect();
  zoomAt(r.left + r.width/2, r.top + r.height/2, factor);
}
function resetView(){ cam.x = 0; cam.y = 0; cam.z = 1; applyCamera(); }
let camSaved = '';
function saveCam(){
  const s = JSON.stringify({x:Math.round(cam.x), y:Math.round(cam.y), z:Math.round(cam.z*1000)/1000});
  if(s === camSaved) return;
  camSaved = s;
  try{ localStorage.setItem('wf_cam', s); }catch(e){}
}
function loadCam(){
  if(window.innerWidth < 620) cam.z = 0.72;
  return;                                  // demo: never restore a previous visitor's view
  try{
    const v = JSON.parse(localStorage.getItem('wf_cam') || 'null');
    if(v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z)){
      cam.x = v.x; cam.y = v.y; cam.z = clamp(v.z, ZMIN, ZMAX);
      return;
    }
  }catch(e){}
  // first run on a narrow screen: pull back a little so the whole hub fits
  if(window.innerWidth < 620) cam.z = 0.72;
}

loadCam();          // before anything paints, so the first frame is where he left off

const activePointers = new Map();
let panFrom = null, pinchFrom = null;

function attachCamera(){
  const host = hubEl();
  if(!host || host._cam) return;
  host._cam = true;

  // trackpad: two fingers scrolls the graph, ctrl/⌘ + scroll (and a pinch,
  // which the browser reports as ctrl+wheel) zooms about the pointer
  host.addEventListener('wheel', e => {
    e.preventDefault();
    if(e.ctrlKey || e.metaKey){
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0022));
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      cam.x += (e.deltaX * k) / cam.z;
      cam.y += (e.deltaY * k) / cam.z;
      applyCamera();
    }
  }, { passive:false });

  host.addEventListener('pointerdown', e => {
    if(hubMode !== 'move') return;                 // drawing owns the surface
    if(e.target.closest && e.target.closest('.bubble, .ink-bar, .zoom-bar, .minimap')) return;
    activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    try{ host.setPointerCapture(e.pointerId); }catch(err){}
    if(activePointers.size === 1){
      panFrom = { px:e.clientX, py:e.clientY, cx:cam.x, cy:cam.y };
      host.classList.add('panning');
    } else if(activePointers.size === 2){
      panFrom = null;
      const [a, b] = [...activePointers.values()];
      pinchFrom = { d: Math.hypot(a.x-b.x, a.y-b.y) || 1, z: cam.z,
                    mx: (a.x+b.x)/2, my: (a.y+b.y)/2 };
    }
  });
  host.addEventListener('pointermove', e => {
    if(!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if(pinchFrom && activePointers.size === 2){
      const [a, b] = [...activePointers.values()];
      const d = Math.hypot(a.x-b.x, a.y-b.y) || 1;
      const want = clamp(pinchFrom.z * (d / pinchFrom.d), ZMIN, ZMAX);
      zoomAt(pinchFrom.mx, pinchFrom.my, want / cam.z);
    } else if(panFrom){
      cam.x = panFrom.cx - (e.clientX - panFrom.px) / cam.z;
      cam.y = panFrom.cy - (e.clientY - panFrom.py) / cam.z;
      applyCamera();
    }
  });
  const letGo = e => {
    activePointers.delete(e.pointerId);
    try{ host.releasePointerCapture(e.pointerId); }catch(err){}
    if(activePointers.size < 2) pinchFrom = null;
    if(activePointers.size === 0){ panFrom = null; host.classList.remove('panning'); }
  };
  host.addEventListener('pointerup', letGo);
  host.addEventListener('pointercancel', letGo);
}

const bubbleEls = new Map();
let draggingId = null;

function makeBubble(el){
  el.classList.add('no-anim');                    // no transition on first placement
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-anim')));
}
function renderHub(){
  const canvas = document.getElementById('hub-world') || document.getElementById('hub-canvas');

  let center = document.getElementById('bubble-center');
  if(!center){
    center = document.createElement('div');
    center.className = 'bubble center';
    center.id = 'bubble-center';
    center.onclick = () => openHelper();      // the middle of the map is Cosmo
    attachTilt(center);
    makeBubble(center);
    canvas.appendChild(center);
  }
  const centerHtml = `<span class="b-cosmo" aria-hidden="true"><svg viewBox="0 0 100 100" aria-hidden="true"><use href="#wf-logo"/></svg></span>
    <span class="b-name">Cosmo</span>
    <span class="b-meta">Ask me anything</span>`;
  if(center._html !== centerHtml){ center.innerHTML = centerHtml; center._html = centerHtml; }

  const live = new Set();
  sortedBubbles().forEach(b => {
    live.add(b.id);
    let el = bubbleEls.get(b.id);
    if(!el){
      el = document.createElement('div');
      el.dataset.id = b.id;
      attachBubbleInteractions(el, b);
      attachTilt(el);
      makeBubble(el);
      canvas.appendChild(el);
      bubbleEls.set(b.id, el);
    }
    el._bubble = b;
    /* A snapshot can land in the middle of a drag, so every class that marks a
       gesture in progress has to be carried over — drop one and the drop-target
       ring blinks off, or a half-resized bubble snaps back. */
    const keep = ['dragging','no-anim','drop-target','resizing','shaken']
      .filter(k => el.classList.contains(k)).join(' ');
    const cls = ('bubble section tone-' + (b.tone || 'teal') + ''
      + (keep ? ' ' + keep : ''));
    if(el.className !== cls) el.className = cls;
    const tint = String(tintOf(b));
    if(el.style.getPropertyValue('--tint') !== tint) el.style.setProperty('--tint', tint);
    const n = (b.widgets || []).length, t = tasksFor(b.id).length;
    const bits = [];
    if(n) bits.push(n + (n === 1 ? ' panel' : ' panels'));
    if(t) bits.push(t + (t === 1 ? ' to-do' : ' to-dos'));
    const meta = bits.length ? bits.join(' · ') : 'empty';
    const html = `<span class="b-tone"></span><span class="b-name">${esc(b.name)}</span><span class="b-meta">${esc(meta)}</span>`;
    if(el._html !== html){ el.innerHTML = html; el._html = html; }
    ensureGrip(el, b);     // innerHTML wipes it, so put the handle back after
    ensureRing(el, b);
  });
  bubbleEls.forEach((el, id) => {
    if(!live.has(id)){ el.remove(); bubbleEls.delete(id); }
  });

  layoutHub();
}

function layoutHub(){
  const world = document.getElementById('hub-world');
  if(!world || view !== 'hub') return;
  sizeInkCanvas();

  const center = document.getElementById('bubble-center');
  if(center){
    center.style.width = center.style.height = (R_CEN*2) + 'px';
    center.style.left = '0px'; center.style.top = '0px';
    center._pos = { x:0, y:0 };
  }

  const list = sortedBubbles();
  const spots = placeAll(list);
  list.forEach(b => {
    const el = bubbleEls.get(b.id);
    if(!el) return;
    const r = radiusOf(b);
    el._r = r;
    if(draggingId === b.id || resizingId === b.id) return;   // hands off mid-gesture
    const [wx, wy] = spots[b.id];
    el.style.width = el.style.height = (r*2) + 'px';
    el.style.left = wx + 'px'; el.style.top = wy + 'px';
    el._pos = { x:wx, y:wy };
  });
  drawLinks(spots);
  applyCamera();
}

/* One line per bubble, drawn to its parent — or to the hub if it has none.
   That single rule is what turns a ring of bubbles into a web: nothing else in
   the app has to know the tree exists. */
function drawLinks(spots){
  let lines = '';
  sortedBubbles().forEach(b => {
    const el = bubbleEls.get(b.id);
    let from = el && el._pos;
    if(!from && spots && spots[b.id]) from = { x:spots[b.id][0], y:spots[b.id][1] };
    if(!from) return;

    const p = parentOf(b);
    let to, tr;
    if(p){
      const pel = bubbleEls.get(p.id);
      to = pel && pel._pos;
      if(!to && spots && spots[p.id]) to = { x:spots[p.id][0], y:spots[p.id][1] };
      tr = radiusOf(p);
    } else {
      to = { x:0, y:0 }; tr = R_CEN;
    }
    if(!to) return;
    lines += linkLine(from, radiusOf(b), to, tr, !p);
  });
  const svg = document.getElementById('hub-links');
  if(svg) svg.innerHTML = lines;
}
/* a segment between two circles, stopping at each rim rather than at the centre */
function linkLine(from, fr, to, tr, toCosmo){
  const dx = from.x - to.x, dy = from.y - to.y;
  const len = Math.hypot(dx, dy) || 1;
  const sx = to.x + dx/len * tr,   sy = to.y + dy/len * tr;
  const ex = from.x - dx/len * fr, ey = from.y - dy/len * fr;
  return '<line x1="' + sx + '" y1="' + sy + '" x2="' + ex + '" y2="' + ey +
         '" class="' + (toCosmo ? 'cosmo' : '') + '"></line>';
}

/* Where every bubble sits. Anything already placed keeps its spot; the rest get
   one found for them — and a child looks for room around its PARENT, not around
   the hub, which is what makes a new branch come out looking like a branch. */
function placeAll(list){
  const spots = {};
  const taken = [];
  const fits = (x, y, r) => {
    if(Math.hypot(x, y) < R_CEN + r + 12) return false;
    return taken.every(t => Math.hypot(x - t[0], y - t[1]) >= t[2] + r + 10);
  };
  const keep = (b, x, y, r, persist) => {
    spots[b.id] = [x, y];
    taken.push([x, y, r]);
    if(persist && !pinnedPos.has(b.id)){
      pinnedPos.add(b.id);
      cols.bubbles.update(b.id, { wx: Math.round(x), wy: Math.round(y) }).catch(() => {});
    }
  };

  list.forEach(b => {
    if(typeof b.wx === 'number' && typeof b.wy === 'number') keep(b, b.wx, b.wy, radiusOf(b), false);
  });

  // shallowest first, so a child always has a parent position to orbit
  const pending = list.filter(b => !spots[b.id]).sort((a, b) => depthOf(a.id) - depthOf(b.id));
  pending.forEach((b, i) => {
    const r = radiusOf(b);
    const p = parentOf(b);
    const anchor = (p && spots[p.id])
      ? { x: spots[p.id][0], y: spots[p.id][1], r: radiusOf(p) }
      : { x: 0, y: 0, r: R_CEN };

    if(!p && typeof b.x === 'number' && typeof b.y === 'number'){
      const lx = b.x * 470, ly = b.y * 300;        // the old fixed-canvas layout
      if(fits(lx, ly, r)){ keep(b, Math.round(lx), Math.round(ly), r, true); return; }
    }

    let x = anchor.x, y = anchor.y;
    for(let step = 0; step < 400; step++){
      const ring = Math.floor(step / 12);
      const ang = (-Math.PI/2) + (step % 12) * (Math.PI/6) + ring * 0.26 + i * 0.7;
      const rad = anchor.r + r + 42 + ring * (r * 2 + 16);
      x = anchor.x + Math.cos(ang) * rad;
      y = anchor.y + Math.sin(ang) * rad;
      if(fits(x, y, r)) break;
    }
    keep(b, Math.round(x), Math.round(y), r, true);
  });
  return spots;
}

let resizingId = null;
let dropTargetId = undefined;        // undefined = none; null = the hub itself

/* Which bubble is under the one being dragged. Returns the target's id, null for
   the hub, or undefined for empty space. Anything at or beneath the dragged
   bubble is skipped — dropping a parent onto its own child would make a loop. */
function dropTargetAt(x, y, selfId){
  const r = radiusOf(bubbleById(selfId));
  let best, bestD = Infinity;
  bubbleEls.forEach((el, id) => {
    if(id === selfId || !el._pos || isUnder(id, selfId)) return;
    const d = Math.hypot(x - el._pos.x, y - el._pos.y);
    if(d < radiusOf(bubbleById(id)) + r * 0.45 && d < bestD){ bestD = d; best = id; }
  });
  if(best !== undefined) return best;
  if(Math.hypot(x, y) < R_CEN + r * 0.45) return null;     // the hub
  return undefined;
}
function paintDropTarget(id){
  if(id === dropTargetId) return;
  dropTargetId = id;
  bubbleEls.forEach(el => el.classList.remove('drop-target'));
  const centre = document.getElementById('bubble-center');
  if(centre) centre.classList.toggle('drop-target', id === null);
  if(id){
    const el = bubbleEls.get(id);
    if(el) el.classList.add('drop-target');
  }
}
function clearDropTarget(){
  dropTargetId = undefined;
  bubbleEls.forEach(el => el.classList.remove('drop-target'));
  const centre = document.getElementById('bubble-center');
  if(centre) centre.classList.remove('drop-target');
}

/* Shake detection. Count how many times the drag reverses direction inside a
   short window: a deliberate scrub flips four or more times in well under a
   second, and nothing you do while simply moving a bubble ever does. */
function shakeTracker(){
  return { lastX:null, dir:0, flips:[] };
}
function sawShake(track, x){
  const now = Date.now();
  if(track.lastX !== null){
    const dx = x - track.lastX;
    if(Math.abs(dx) > 4){
      const dir = dx > 0 ? 1 : -1;
      if(track.dir && dir !== track.dir) track.flips.push(now);
      track.dir = dir;
    }
  }
  track.lastX = x;
  track.flips = track.flips.filter(t => now - t < 700);
  if(track.flips.length >= 4){ track.flips = []; return true; }
  return false;
}

async function setParent(id, parentId, label){
  const b = bubbleById(id);
  if(!b) return;
  const before = b.parentId || null;
  if((before || null) === (parentId || null)) return;
  if(parentId && isUnder(parentId, id)) return;         // would make a loop
  const write = v => cols.bubbles.update(id, { parentId: v }).catch(() => {});
  await write(parentId || null);
  record(label, () => write(before), () => write(parentId || null));
}

function attachBubbleInteractions(el, b){
  let start = null, moved = false, shake = null, shookLoose = false;
  el.addEventListener('contextmenu', e => { e.preventDefault(); openTonePicker(b.id); });
  el.addEventListener('pointerdown', e => {
    if(e.button != null && e.button !== 0) return;
    if(e.target.closest && e.target.closest('.b-grip')) return;   // the resize handle
    e.stopPropagation();                 // dragging a bubble must not pan the graph
    // a finger wobbles on the way down, so touch gets far more slack before a tap
    // counts as a drag — otherwise tapping a bubble nudges it instead of opening it
    const slack = (e.pointerType === 'touch' || e.pointerType === 'pen') ? 12 : 5;
    draggingId = b.id;
    start = { px:e.clientX, py:e.clientY, x:el._pos ? el._pos.x : 0, y:el._pos ? el._pos.y : 0,
              slack, at: Date.now() };
    moved = false;
    shookLoose = false;
    shake = shakeTracker();
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
  });
  el.addEventListener('pointermove', e => {
    if(!start) return;
    const dx = e.clientX - start.px, dy = e.clientY - start.py;
    if(!moved && Math.hypot(dx, dy) > start.slack){
      moved = true;
      el.classList.add('dragging');      // only look picked up once it really is
    }
    if(!moved) return;
    const x = start.x + dx / cam.z, y = start.y + dy / cam.z;   // screen px -> world
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el._pos = {x, y};

    // shake it hard and it comes off whatever it is hanging from
    if(sawShake(shake, e.clientX)){
      const cur = bubbleById(b.id);
      if(cur && cur.parentId){
        const was = parentOf(cur);
        el.classList.add('shaken');
        setTimeout(() => el.classList.remove('shaken'), 420);
        setParent(b.id, null, 'shaking "' + b.name + '" loose');
        toast('Shook "' + b.name + '" off ' + ((was && was.name) || 'the hub'));
      }
      // you are almost certainly still hovering the thing you just shook off;
      // stop offering to reconnect it for the rest of this drag
      shookLoose = true;
      clearDropTarget();
    }

    if(!shookLoose) paintDropTarget(dropTargetAt(x, y, b.id));
    drawLinks();
  });
  const finish = e => {
    if(!start) return;
    el.classList.remove('dragging');
    try{ el.releasePointerCapture(e.pointerId); }catch(err){}
    const dist = Math.hypot((e.clientX || start.px) - start.px, (e.clientY || start.py) - start.py);
    const quick = (Date.now() - start.at) < 300 && dist < 22;
    const landedOn = shookLoose ? undefined : dropTargetId;
    clearDropTarget();

    if(moved && !quick){
      if(landedOn !== undefined){
        // dropped on top of something: link it, and sit it just outside the rim
        const target = landedOn ? bubbleById(landedOn) : null;
        const anchor = target ? (bubbleEls.get(target.id) || {})._pos || {x:target.wx||0, y:target.wy||0}
                              : { x:0, y:0 };
        const ar = target ? radiusOf(target) : R_CEN;
        const mine = radiusOf(b);
        let vx = el._pos.x - anchor.x, vy = el._pos.y - anchor.y;
        let len = Math.hypot(vx, vy);
        // dropped bang on the middle of the target: pick a direction for it,
        // otherwise it lands at zero distance and hides underneath
        if(len < 1){ vx = 0; vy = -1; len = 1; }
        const gap = ar + mine + 26;
        const fx = Math.round(anchor.x + (vx/len) * gap);
        const fy = Math.round(anchor.y + (vy/len) * gap);
        el.style.left = fx + 'px'; el.style.top = fy + 'px';
        el._pos = { x:fx, y:fy };
        cols.bubbles.update(b.id, { wx: fx, wy: fy });
        setParent(b.id, landedOn, 'connecting "' + b.name + '" to ' +
          (target ? '"' + target.name + '"' : 'the hub'));
        toast('Connected "' + b.name + '" to ' + (target ? target.name : 'Cosmo'));
      } else {
        const [fx, fy] = nudgeClear(el._pos.x, el._pos.y, b.id);
        el.style.left = fx + 'px'; el.style.top = fy + 'px';
        el._pos = { x: fx, y: fy };
        cols.bubbles.update(b.id, { wx: Math.round(fx), wy: Math.round(fy) });
      }
      drawLinks();
    } else {
      if(moved) layoutHub();          // a quick slip is still a tap: put it back
      openSection(b.id);
    }
    start = null;
    moved = false;
    shookLoose = false;
    shake = null;
    draggingId = null;
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

/* A planet leans toward the cursor. Only the one you are actually over gets
   this — mousemove on the element itself fires far less often than a global
   listener, and the work is one style write per frame at most. */
const TILT = 13;
function attachTilt(el){
  if(el._tilt) return;
  el._tilt = true;
  let queued = false, last = null;
  const apply = () => {
    queued = false;
    if(!last) return;
    const box = el.getBoundingClientRect();
    if(!box.width) return;
    const nx = (last.x - (box.left + box.width/2))  / (box.width/2);
    const ny = (last.y - (box.top  + box.height/2)) / (box.height/2);
    el.style.setProperty('--ry', clamp(nx, -1, 1) *  TILT + 'deg');
    el.style.setProperty('--rx', clamp(ny, -1, 1) * -TILT + 'deg');
  };
  el.addEventListener('pointermove', e => {
    if(e.pointerType === 'touch') return;      // no hover to speak of
    last = { x:e.clientX, y:e.clientY };
    if(!queued){ queued = true; requestAnimationFrame(apply); }
  });
  el.addEventListener('pointerleave', () => {
    last = null;
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--rx', '0deg');
  });
}

/* A ring says this planet has moons. It is drawn from the live tree, so it
   appears the moment something is attached and goes when the last one leaves. */
function ensureRing(el, b){
  const wanted = childrenOf(b.id).length > 0;
  const ring = el.querySelector('.b-ring');
  if(wanted && !ring){
    const r = document.createElement('span');
    r.className = 'b-ring';
    el.insertBefore(r, el.firstChild);
  } else if(!wanted && ring){
    ring.remove();
  }
}

/* ---- the resize handle on the rim ---- */
function ensureGrip(el, b){
  if(el.querySelector('.b-grip')) return;
  const grip = document.createElement('span');
  grip.className = 'b-grip';
  grip.title = 'Drag to resize';
  let from = null;
  grip.addEventListener('pointerdown', e => {
    e.stopPropagation();
    e.preventDefault();
    resizingId = b.id;
    from = { r: radiusOf(bubbleById(b.id)) };
    el.classList.add('resizing');
    try{ grip.setPointerCapture(e.pointerId); }catch(err){}
  });
  grip.addEventListener('pointermove', e => {
    if(!from) return;
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width/2, cy = box.top + box.height/2;
    // the pointer's distance from the middle IS the new radius, in world units
    const r = clamp(Math.hypot(e.clientX - cx, e.clientY - cy) / cam.z, R_MIN, R_MAX);
    el.style.width = el.style.height = (r*2) + 'px';
    el._r = r;
    drawLinks();
  });
  const done = e => {
    if(!from) return;
    try{ grip.releasePointerCapture(e.pointerId); }catch(err){}
    el.classList.remove('resizing');
    const before = bubbleById(b.id);
    const prev = (before && typeof before.size === 'number') ? before.size : null;
    const next = Math.round(el._r);
    const write = v => cols.bubbles.update(b.id, { size: v }).catch(() => {});
    write(next);
    record('resizing "' + b.name + '"', () => write(prev), () => write(next));
    from = null;
    resizingId = null;
  };
  grip.addEventListener('pointerup', done);
  grip.addEventListener('pointercancel', done);
  el.appendChild(grip);
}

/* A bubble dropped into open space must not come to rest buried under another
   one — that looks exactly like it was deleted. Sizes vary now, so the spacing
   has to be worked out from the two radii rather than assumed. */
function nudgeClear(x, y, selfId){
  const mine = radiusOf(bubbleById(selfId));
  const push = (px, py, ox, oy, minGap) => {
    let dx = px - ox, dy = py - oy;
    let d = Math.hypot(dx, dy);
    if(d >= minGap) return [px, py];
    if(d < 0.001){ dx = 0; dy = -1; d = 1; }          // dead centre: send it upward
    return [ ox + (dx/d) * minGap, oy + (dy/d) * minGap ];
  };
  [x, y] = push(x, y, 0, 0, R_CEN + mine + 12);       // clear of the to-do bubble
  bubbleEls.forEach((el, id) => {
    if(id === selfId || !el._pos) return;
    [x, y] = push(x, y, el._pos.x, el._pos.y, radiusOf(bubbleById(id)) + mine + 10);
  });
  return [x, y];
}


/* ============ APPEARANCE ============
   Themes, typeface, text size and text colour. Saved to the hub so it follows
   Andrew between devices, and mirrored to localStorage so the right look paints
   on the very first frame instead of flashing the default. */
const THEMES = [
  { id:'clarity',     name:'Clarity',      ink:'#FFFFFF', line:'rgba(0,0,0,0.09)',       dot:'#0071E3' },
  { id:'claritydark', name:'Clarity Space', ink:'#000000', line:'rgba(255,255,255,0.10)', dot:'#0A84FF' },
  { id:'paper',     name:'Paper',      ink:'#FBFBFA', line:'rgba(20,24,28,0.13)',    dot:'#2D5F68' },
  { id:'cream',     name:'Cream',      ink:'#F7F1E4', line:'rgba(84,64,38,0.16)',    dot:'#8A5A2B' },
  { id:'blueprint', name:'Blueprint',  ink:'#0E2150', line:'rgba(165,216,255,0.32)', dot:'#38BDF8' },
  { id:'slate',     name:'Slate',      ink:'#151719', line:'rgba(255,255,255,0.09)', dot:'#C08B5C' },
  { id:'forest',    name:'Forest',     ink:'#0B4734', line:'rgba(220,245,232,0.22)', dot:'#9EE6C2' },
  { id:'warp',      name:'Warp',       ink:'#120F17', line:'rgba(199,85,247,0.22)',  dot:'#C755F7' },
  { id:'mono',      name:'Mono',       ink:'#000000', line:'rgba(146,146,146,0.30)', dot:'#FFFFFF' },
  { id:'ascii',     name:'Horizon',    ink:'#050B24', line:'rgba(56,189,248,0.35)',  dot:'#38BDF8' },
  { id:'snow',      name:'Snow',       ink:'#0B1426', line:'rgba(200,225,255,0.18)', dot:'#9FD6FF' },
  { id:'terminal',  name:'Terminal',   ink:'#040704', line:'rgba(167,239,158,0.22)', dot:'#A7EF9E' },
  { id:'iridescence', name:'Cherry Blossom', ink:'#F9ECFF', line:'rgba(226,110,200,0.32)', dot:'#C9497F' },
  { id:'custom',    name:'Your image', ink:'#3A3A3C', line:'transparent', dot:'#FFFFFF' },
];
/* Word's familiar faces. Each one asks for the real font first — if Andrew's
   machine has it, that is what he gets — then falls back to a metric-matched
   web font that is fetched only when chosen. */
const FONTS = [
  { id:'publicsans', name:'System (SF Pro)',  stack:"-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', sans-serif" },
  { id:'wayfinder',  name:'Public Sans',      stack:"'Public Sans', -apple-system, BlinkMacSystemFont, sans-serif" },
  { id:'calibri',    name:'Calibri',           stack:"Calibri, Carlito, 'Segoe UI', sans-serif", web:'Carlito' },
  { id:'cambria',    name:'Cambria',           stack:"Cambria, Caladea, Georgia, serif", web:'Caladea' },
  { id:'times',      name:'Times New Roman',   stack:"'Times New Roman', Tinos, Times, serif", web:'Tinos' },
  { id:'arial',      name:'Arial',             stack:"Arial, Arimo, Helvetica, sans-serif", web:'Arimo' },
  { id:'georgia',    name:'Georgia',           stack:"Georgia, Gelasio, serif", web:'Gelasio' },
  { id:'garamond',   name:'Garamond',          stack:"Garamond, 'EB Garamond', Georgia, serif", web:'EB+Garamond' },
  { id:'bookman',    name:'Book Antiqua',      stack:"'Book Antiqua', Palatino, 'Palatino Linotype', 'EB Garamond', serif", web:'EB+Garamond' },
  { id:'courier',    name:'Courier New',       stack:"'Courier New', Cousine, monospace", web:'Cousine' },
  { id:'consolas',   name:'Consolas',          stack:"Consolas, Inconsolata, 'Courier New', monospace", web:'Inconsolata' },
  { id:'verdana',    name:'Verdana',           stack:"Verdana, 'DejaVu Sans', Geneva, sans-serif" },
  { id:'tahoma',     name:'Tahoma',            stack:"Tahoma, Verdana, Geneva, sans-serif" },
  { id:'trebuchet',  name:'Trebuchet MS',      stack:"'Trebuchet MS', 'Fira Sans', sans-serif" },
  { id:'segoe',      name:'Segoe UI',          stack:"'Segoe UI', 'Open Sans', system-ui, sans-serif", web:'Open+Sans' },
  { id:'franklin',   name:'Franklin Gothic',   stack:"'Franklin Gothic Book', 'Franklin Gothic', 'Libre Franklin', sans-serif", web:'Libre+Franklin' },
  { id:'century',    name:'Century Gothic',    stack:"'Century Gothic', Questrial, 'URW Gothic', sans-serif", web:'Questrial' },
  { id:'rockwell',   name:'Rockwell',          stack:"Rockwell, 'Zilla Slab', 'Roboto Slab', serif", web:'Zilla+Slab' },
  { id:'candara',    name:'Candara',           stack:"Candara, 'PT Sans', Optima, sans-serif", web:'PT+Sans' },
  { id:'corbel',     name:'Corbel',            stack:"Corbel, 'Source Sans 3', sans-serif", web:'Source+Sans+3' },
  { id:'comic',      name:'Comic Sans MS',     stack:"'Comic Sans MS', 'Comic Neue', cursive", web:'Comic+Neue' },
  { id:'impact',     name:'Impact',            stack:"Impact, Anton, 'Arial Black', sans-serif", web:'Anton' },
];
const TEXT_COLORS = ['', '#FFFFFF', '#C9D1D3', '#0E1113', '#6FBAC4', '#DAA84A', '#7BC894', '#DE94A2', '#A79AD6'];

const DEFAULT_THEME = 'clarity';
/* Themes that have been retired, and what each one became. A saved setting
   still naming a retired theme is answered with its successor instead of
   being silently dropped to the default — which is what losing a theme id
   from THEMES would otherwise do, and it would land a dark-theme user in a
   white room. applyLook writes the new id back, so this fires once. */
/* The starfield behind Clarity Space: three tiles of stars drawn once, then
   repeated across the sky. Far stars are small and many, near ones few and
   bright; each layer drifts with the map at its own rate (see applyCamera). */
function paintStars(){
  const layers = [
    { el:'.stars.s1', size:420, count:150, r:[0.35, 0.8],  a:[0.25, 0.6] },
    { el:'.stars.s2', size:560, count:55,  r:[0.6, 1.2],   a:[0.45, 0.85] },
    { el:'.stars.s3', size:760, count:16,  r:[1.0, 1.7],   a:[0.75, 1], glow:true },
  ];
  const tints = ['255,255,255', '255,255,255', '255,255,255', '214,228,255', '255,236,214'];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;   // same sky every visit
  layers.forEach(L => {
    const el = document.querySelector('#sky ' + L.el);
    if(!el) return;
    const c = document.createElement('canvas');
    c.width = c.height = L.size * dpr;
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    for(let i = 0; i < L.count; i++){
      const px = rand() * L.size, py = rand() * L.size;
      const r = L.r[0] + rand() * (L.r[1] - L.r[0]);
      const a = L.a[0] + rand() * (L.a[1] - L.a[0]);
      const tint = tints[Math.floor(rand() * tints.length)];
      if(L.glow){
        const g = x.createRadialGradient(px, py, 0, px, py, r * 5);
        g.addColorStop(0, 'rgba(' + tint + ',' + (a * 0.35) + ')');
        g.addColorStop(1, 'rgba(' + tint + ',0)');
        x.fillStyle = g; x.beginPath(); x.arc(px, py, r * 5, 0, Math.PI * 2); x.fill();
      }
      x.fillStyle = 'rgba(' + tint + ',' + a + ')';
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
    el.style.backgroundImage = 'url(' + c.toDataURL() + ')';
    el.style.backgroundSize = L.size + 'px ' + L.size + 'px';
  });
}
paintStars();

/* Shooting stars for Clarity Space: every few seconds, at random, one bright
   streak with a fading tail crosses the sky. Between them nothing is drawn and
   nothing runs. Off for reduced motion, in other themes and in hidden tabs. */
/* A lone astronaut far off in the Clarity Space sky, made of cut crystal:
   tapered, jointed limbs, a life-support pack, a chest unit, gloves and boots,
   a helmet with a dark mirrored visor, and a slack tether floating loose. Every
   part is built from triangular facets that catch a slowly moving light (white
   and silver highlights, deep shadows, warm amber from below, cool blue at the
   edge), with twinkling glints and specks of light drifting around it. It lives on the map like the petals (it pans and
   zooms with the bubbles) and drifts in a slow, wide loop around one patch of
   sky, tumbling gently, small and a little dim so it reads as far away. Off in
   other themes and hidden tabs; still for reduced motion. */
const astronaut = (() => {
  const cv = document.getElementById('astronaut');
  if(!cv) return null;
  const ctx = cv.getContext('2d');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, raf = 0, last = 0, lastDraw = 0, t = 40, dirty = true;
  const HOME = { x: 1350, y: 760 };            // his spot: far out in the bottom right of the map, in map units
  const SIZE = 0.55;                           // the figure is 100 drawing units tall: about 55 map units
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  };
  const camera = () => {
    if(typeof cam !== 'object' || view !== 'hub') return { ox: w * 0.25, oy: h * 0.75, z: 1 };
    const r = hubRect();
    return { ox: r.left + r.width / 2 - cam.x * cam.z, oy: r.top + r.height / 2 - cam.y * cam.z, z: cam.z };
  };
  // a tapered limb segment: round at both ends, r1 at (x1,y1) narrowing to r2 at (x2,y2)
  const capsule = (x1, y1, r1, x2, y2, r2) => {
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.arc(x1, y1, r1, a + Math.PI / 2, a + Math.PI * 1.5);
    ctx.arc(x2, y2, r2, a - Math.PI / 2, a + Math.PI / 2);
    ctx.closePath();
  };
  // ---- the crystal surface ----
  // One sheet of triangular facets covering the figure, drawn into a small
  // canvas and clipped into each body part. Every facet has its own tilt, so it
  // catches the moving light differently: white and silver highlights, deep
  // shadow facets, warm amber reflections from below and cool blue at the edge.
  const BX = -56, BY = -48, BW = 112, BH = 104, RES = 5, CELL = 8.5;
  let seed = 29;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cols = Math.ceil(BW / CELL) + 1, rows = Math.ceil(BH / CELL) + 1;
  const pts = [];
  for(let r = 0; r <= rows; r++) for(let c = 0; c <= cols; c++){
    const edge = r === 0 || c === 0 || r === rows || c === cols;
    pts.push([BX + c * CELL + (edge ? 0 : (rnd() - 0.5) * CELL * 0.8), BY + r * CELL + (edge ? 0 : (rnd() - 0.5) * CELL * 0.8)]);
  }
  const tris = [];
  for(let r = 0; r < rows; r++) for(let c = 0; c < cols; c++){
    const i = r * (cols + 1) + c, A = pts[i], B = pts[i + 1], C = pts[i + cols + 1], D = pts[i + cols + 2];
    const flip = rnd() < 0.5;
    for(const tri of flip ? [[A, B, D], [A, D, C]] : [[A, B, C], [B, D, C]])
      tris.push({ p: tri, nx: rnd() * 2 - 1, ny: rnd() * 2 - 1, tint: rnd() });
  }
  const sheet = document.createElement('canvas');
  sheet.width = BW * RES; sheet.height = BH * RES;
  const sx = sheet.getContext('2d');
  let sheetPhase = -1;
  const paintSheet = phase => {
    sheetPhase = phase;
    sx.setTransform(RES, 0, 0, RES, -BX * RES, -BY * RES);
    sx.clearRect(BX, BY, BW, BH);
    const lx = Math.cos(phase) * 0.8 - 0.4, ly = Math.sin(phase) * 0.5 - 0.6;      // the light, slowly circling
    for(const f of tris){
      const [A, B, C] = f.p, cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3;
      const lit = Math.max(0, Math.min(1, 0.5 + (f.nx * lx + f.ny * ly) * 0.75));
      let rgb;
      // chrome: hard contrast between facets, from near-black to flashes of pure white
      const g = lit > 0.86 ? 255 : lit < 0.5 ? 18 + lit * 2 * 100 : 118 + (lit - 0.5) * 2 * 120;
      if(cy > 12 && f.tint < 0.13 + (cy - 12) / 420) rgb = [240, 158, 92].map(v => v * (0.45 + lit * 0.7));     // a few warm reflections, lower down
      else if(f.tint > 0.84 || (Math.abs(cx) > 30 && f.tint > 0.6)) rgb = (f.tint > 0.92 ? [190, 140, 255] : [120, 165, 255]).map(v => v * (0.5 + lit * 0.6));   // blue and violet space light
      else rgb = [g, g * 0.99, Math.min(255, g * 1.04)];                                                        // white, silver, shadow
      const top = rgb.map(v => Math.min(255, Math.round(v * 1.12))), bot = rgb.map(v => Math.round(v * 0.86));
      const grad = sx.createLinearGradient(A[0], A[1], C[0], C[1]);                // a soft shade within each facet, so it never looks pixelated
      grad.addColorStop(0, 'rgb(' + top + ')'); grad.addColorStop(1, 'rgb(' + bot + ')');
      sx.fillStyle = grad;
      sx.beginPath(); sx.moveTo(A[0], A[1]); sx.lineTo(B[0], B[1]); sx.lineTo(C[0], C[1]); sx.closePath();
      sx.fill();
      sx.strokeStyle = 'rgba(255,255,255,0.2)'; sx.lineWidth = 0.35; sx.stroke();    // bright seams, like cut glass
    }
  };
  // fill the current path with crystal, darkened by `shade` (1 = full light)
  const crystal = shade => {
    ctx.save(); ctx.clip();
    ctx.drawImage(sheet, BX, BY, BW, BH);
    if(shade && shade < 1){ ctx.fillStyle = 'rgba(0,0,8,' + (1 - shade) + ')'; ctx.fillRect(BX, BY, BW, BH); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(18,14,24,0.55)'; ctx.lineWidth = 0.7; ctx.stroke();      // a fine edge, no heavy ink
  };
  const sparkle = (x, y, r, a) => {                     // a four-point glint
    if(a <= 0.02) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + a + ')'); g.addColorStop(1, 'rgba(255,240,220,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x - r, y); ctx.quadraticCurveTo(x, y, x, y - r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r); ctx.quadraticCurveTo(x, y, x - r, y); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,' + a + ')'; ctx.beginPath(); ctx.arc(x, y, r * 0.12, 0, Math.PI * 2); ctx.fill();
  };
  const SPECKS = Array.from({ length: 14 }, () => ({ x: -55 + rnd() * 110, y: -65 + rnd() * 130, warm: rnd() < 0.6, ph: rnd() * 6.3, r: 0.6 + rnd() * 1.1 }));
  const limb = (p, radii) => {                            // upper + lower segment, joined
    capsule(p[0][0], p[0][1], radii[0], p[1][0], p[1][1], radii[1]); crystal(0.95);
    capsule(p[1][0], p[1][1], radii[1], p[2][0], p[2][1], radii[2]); crystal(0.9);
  };
  // Facing us, floating free: arms spread out to the sides with the gloves
  // open, legs a little apart and bent, the pack and its thrusters showing
  // above the shoulders. `s` sways the limbs a touch.
  const drawFigure = (s, tt) => {
    const phase = Math.round(tt * 0.35 * 8) / 8;          // the light moves in small steps: the facets glint
    if(phase !== sheetPhase) paintSheet(phase);
    const glow = ctx.createRadialGradient(0, 0, 8, 0, 0, 72);
    glow.addColorStop(0, 'rgba(170,190,255,0.09)'); glow.addColorStop(1, 'rgba(170,190,255,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 72, 0, Math.PI * 2); ctx.fill();
    for(const p of SPECKS){
      const a = 0.25 + 0.55 * Math.max(0, Math.sin(tt * 1.3 + p.ph));
      ctx.fillStyle = p.warm ? 'rgba(255,170,110,' + a + ')' : 'rgba(150,170,255,' + a + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    // life-support pack and its two thruster pods, behind the shoulders and helmet
    ctx.beginPath(); ctx.roundRect(-18, -43, 36, 30, 4); crystal(0.65);
    ctx.beginPath(); ctx.roundRect(-24, -41, 7, 20, 3); crystal(0.75);
    ctx.beginPath(); ctx.roundRect(17, -41, 7, 20, 3); crystal(0.75);
    // legs, a little apart and bent, seen slightly from above
    limb([[-7, 12], [-12 - s * 0.6, 28], [-13, 40 + s]], [6.6, 5.4, 4.4]);
    ctx.beginPath(); ctx.roundRect(-19, 39 + s, 12, 8, [2.5, 2.5, 4, 4]); crystal(0.8);
    limb([[7, 12], [12 + s * 0.6, 28], [13, 40 - s]], [6.6, 5.4, 4.4]);
    ctx.beginPath(); ctx.roundRect(7, 39 - s, 12, 8, [2.5, 2.5, 4, 4]); crystal(0.8);
    // torso: broad shoulders narrowing to the waist; chest unit and waist ring
    ctx.beginPath();
    ctx.moveTo(-17, -16);
    ctx.bezierCurveTo(-18, -2, -13, 6, -11, 13);
    ctx.lineTo(11, 13);
    ctx.bezierCurveTo(13, 6, 18, -2, 17, -16);
    ctx.quadraticCurveTo(0, -21, -17, -16);
    crystal(1);
    ctx.beginPath(); ctx.roundRect(-7.5, -9, 15, 10, 1.8); crystal(0.75);
    ctx.fillStyle = '#0A0A10';
    for(const dx of [-4, 0, 4]){ ctx.beginPath(); ctx.arc(dx, -4, 0.9, 0, Math.PI * 2); ctx.fill(); }
    ctx.beginPath(); ctx.ellipse(0, 12.5, 12, 2.6, 0, 0, Math.PI * 2); crystal(0.8);
    // arms spread wide, gloves open
    limb([[-15, -13], [-30, -9 + s], [-43, -13 + s * 1.6]], [5.6, 4.6, 3.9]);
    ctx.beginPath(); ctx.ellipse(-47.5, -14 + s * 1.6, 4.6, 5.8, 0.5, 0, Math.PI * 2); crystal(0.9);
    limb([[15, -13], [30, -9 - s], [43, -13 - s * 1.6]], [5.6, 4.6, 3.9]);
    ctx.beginPath(); ctx.ellipse(47.5, -14 - s * 1.6, 4.6, 5.8, -0.5, 0, Math.PI * 2); crystal(0.9);
    // shoulder joint rings
    for(const dx of [-15, 15]){ ctx.beginPath(); ctx.ellipse(dx, -13, 4.5, 6, 0, 0, Math.PI * 2); crystal(0.85); }
    // neck ring and helmet, straight on
    ctx.beginPath(); ctx.ellipse(0, -18.5, 11, 3.2, 0, 0, Math.PI * 2); crystal(0.8);
    ctx.beginPath(); ctx.ellipse(0, -30, 12, 13, 0, 0, Math.PI * 2); crystal(1);
    // the visor: dark mirrored glass holding a little reflected space light
    const visor = ctx.createLinearGradient(-8, -38, 8, -22);
    visor.addColorStop(0, '#2B2F55'); visor.addColorStop(0.45, '#07070D'); visor.addColorStop(0.85, '#3A2A6A'); visor.addColorStop(1, '#7FA6FF');
    ctx.fillStyle = visor;
    ctx.beginPath(); ctx.ellipse(0, -29, 9, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(18,14,24,0.7)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(0, -29, 6.6, 5.6, 0, Math.PI * 1.12, Math.PI * 1.45); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for(const [dx, dy, r] of [[4.5, -32, 0.8], [-2.5, -25, 0.5], [3, -24.5, 0.4]]){ ctx.beginPath(); ctx.arc(dx, dy, r, 0, Math.PI * 2); ctx.fill(); }
    // twinkling glints
    sparkle(-7, -40, 6, 0.85 * Math.max(0, Math.sin(tt * 1.1)));
    sparkle(43, -16, 5, 0.75 * Math.max(0, Math.sin(tt * 0.8 + 2)));
    sparkle(-12, 28, 4.5, 0.7 * Math.max(0, Math.sin(tt * 1.4 + 4)));
  };
  const draw = () => {
    const { ox, oy, z } = camera();
    // a slow, wide loop around its patch of sky
    const X = HOME.x + Math.sin(t * 0.07) * 10, Y = HOME.y + Math.sin(t * 0.35) * 5;          // just floating there, bobbing gently
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(ox + X * z, oy + Y * z);
    ctx.rotate(-0.12 + Math.sin(t * 0.16) * 0.1);                                               // a lazy sway, never tumbling
    ctx.scale(SIZE * z, SIZE * z);
    ctx.globalAlpha = 0.88;                                  // a touch dim, from the distance
    drawFigure(Math.sin(t * 0.6), t);
    ctx.restore();
    dirty = false;
  };
  const frame = now => {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now; t += dt;
    if(dirty || now - lastDraw > 33){ lastDraw = now; draw(); }
  };
  const on = () => document.documentElement.getAttribute('data-theme') === 'claritydark' && !document.hidden;
  const update = () => {
    if(on()){
      if(!w) size();
      if(still){ draw(); return; }
      if(!raf){ last = 0; raf = requestAnimationFrame(frame); }
    } else if(raf){ cancelAnimationFrame(raf); raf = 0; }
  };
  new MutationObserver(update).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  document.addEventListener('visibilitychange', update);
  addEventListener('resize', () => { if(w){ size(); if(still && on()) draw(); } });
  update();
  return { moved: () => { dirty = true; if(still && on() && w) draw(); } };
})();
window.wfAstronaut = astronaut;

/* ---- The astronaut's story ----
   Each theme hides one small scene far out at the edge of the map, too small
   and too far to notice at the normal zoom; zoom right out and it is there in
   the corner. Scenes live in map coordinates, so they pan and zoom with the
   bubbles, and a scene is only drawn while it is actually on screen.
   Add a chapter by adding an entry to CHAPTERS: { theme, at, reach, draw }. */
const story = (() => {
  const cv = document.getElementById('story');
  if(!cv) return null;
  const ctx = cv.getContext('2d');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, raf = 0, last = 0, lastDraw = 0, t = 0, dirty = true, shown = false;

  // ---- Chapter 1, Clarity: a space shuttle pulled into a black hole, in ink on the white page ----
  const INKC = '#1D1D1F';
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const STARS1 = Array.from({ length: 22 }, () => ({ x: -470 + rnd() * 940, y: -300 + rnd() * 560, r: 3 + rnd() * 5 }));
  // a small, original space shuttle, nose pointing along +x, about 70 units long
  const shuttle = () => {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = INKC; ctx.lineWidth = 2;
    // delta wings
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-18, -24); ctx.lineTo(-28, -24); ctx.lineTo(-24, 0); ctx.lineTo(-28, 24); ctx.lineTo(-18, 24); ctx.closePath();
    ctx.fill(); ctx.stroke();
    // body
    ctx.beginPath(); ctx.moveTo(38, 0); ctx.bezierCurveTo(32, -9, 10, -9, -30, -8); ctx.lineTo(-34, -6); ctx.lineTo(-34, 6); ctx.lineTo(-30, 8); ctx.bezierCurveTo(10, 9, 32, 9, 38, 0);
    ctx.fill(); ctx.stroke();
    // dark nose and wing edges, cockpit windows, tail fin, engines
    ctx.fillStyle = INKC;
    ctx.beginPath(); ctx.moveTo(38, 0); ctx.bezierCurveTo(36, -4, 33, -6, 30, -6); ctx.lineTo(30, 6); ctx.bezierCurveTo(33, 6, 36, 4, 38, 0); ctx.fill();
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-18, -24); ctx.lineTo(-28, -24); ctx.moveTo(-18, 24); ctx.lineTo(-28, 24); ctx.stroke();
    for(const y of [-3, 1]){ ctx.beginPath(); ctx.rect(22, y, 4, 2.6); ctx.fill(); }
    ctx.lineWidth = 2; ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-30, -2); ctx.lineTo(-34, -1); ctx.lineTo(-34, 1); ctx.lineTo(-30, 2); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INKC;
    for(const y of [-5, 0, 5]){ ctx.beginPath(); ctx.arc(-36, y, 2.2, 0, Math.PI * 2); ctx.fill(); }
    // a few panel lines
    ctx.strokeStyle = 'rgba(29,29,31,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(10, -6.5); ctx.lineTo(10, 6.5); ctx.moveTo(-6, -7.5); ctx.lineTo(-6, 7.5); ctx.stroke();
  };
  // the crystal surface for the black hole: triangular facets that catch a
  // slowly moving light (white and silver highlights, deep shadow, blue-violet
  // and a little amber), the same look as the Clarity Space astronaut
  const crystalSheet = (() => {
    const SW = 260, SH = 260, CELL = 13, RES = 3;
    let sd = 17;
    const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const cols = Math.ceil(SW / CELL), rows = Math.ceil(SH / CELL), pts = [];
    for(let r = 0; r <= rows; r++) for(let c = 0; c <= cols; c++){
      const edge = r === 0 || c === 0 || r === rows || c === cols;
      pts.push([c * CELL + (edge ? 0 : (rr() - 0.5) * CELL * 0.8), r * CELL + (edge ? 0 : (rr() - 0.5) * CELL * 0.8)]);
    }
    const tris = [];
    for(let r = 0; r < rows; r++) for(let c = 0; c < cols; c++){
      const i = r * (cols + 1) + c, A = pts[i], B = pts[i + 1], C = pts[i + cols + 1], D = pts[i + cols + 2];
      for(const t of rr() < 0.5 ? [[A, B, D], [A, D, C]] : [[A, B, C], [B, D, C]]) tris.push({ p: t, nx: rr() * 2 - 1, ny: rr() * 2 - 1, tint: rr() });
    }
    const cv2 = document.createElement('canvas'); cv2.width = SW * RES; cv2.height = SH * RES;
    const x = cv2.getContext('2d'); let phaseNow = -1;
    const paint = phase => {
      if(phase === phaseNow) return; phaseNow = phase;
      x.setTransform(RES, 0, 0, RES, 0, 0); x.clearRect(0, 0, SW, SH);
      const lx = Math.cos(phase) * 0.8 - 0.4, ly = Math.sin(phase) * 0.5 - 0.6;
      for(const f of tris){
        const [A, B, C] = f.p;
        const lit = Math.max(0, Math.min(1, 0.5 + (f.nx * lx + f.ny * ly) * 0.75));
        const g = lit > 0.86 ? 255 : lit < 0.5 ? 18 + lit * 2 * 100 : 118 + (lit - 0.5) * 2 * 120;
        const rgb = f.tint > 0.86 ? [190, 140, 255].map(v => v * (0.5 + lit * 0.6))
                  : f.tint > 0.72 ? [120, 165, 255].map(v => v * (0.5 + lit * 0.6))
                  : f.tint < 0.07 ? [240, 158, 92].map(v => v * (0.45 + lit * 0.7))
                  : [g, g * 0.99, Math.min(255, g * 1.04)];
        const gr = x.createLinearGradient(A[0], A[1], C[0], C[1]);
        gr.addColorStop(0, 'rgb(' + rgb.map(v => Math.min(255, Math.round(v * 1.12))) + ')');
        gr.addColorStop(1, 'rgb(' + rgb.map(v => Math.round(v * 0.86)) + ')');
        x.fillStyle = gr;
        x.beginPath(); x.moveTo(A[0], A[1]); x.lineTo(B[0], B[1]); x.lineTo(C[0], C[1]); x.closePath(); x.fill();
        x.strokeStyle = 'rgba(255,255,255,0.2)'; x.lineWidth = 0.35; x.stroke();
      }
    };
    return { cv: cv2, paint };
  })();
  const chapter1 = tt => {
    ctx.scale(0.7, 0.7);                                         // the whole scene, a little smaller
    const R = 34, tilt = -0.15;                                  // a small black hole
    // little ink stars
    ctx.strokeStyle = 'rgba(29,29,31,0.55)'; ctx.lineWidth = 1.4;
    for(const s of STARS1){ ctx.beginPath(); ctx.moveTo(s.x - s.r, s.y); ctx.lineTo(s.x + s.r, s.y); ctx.moveTo(s.x, s.y - s.r); ctx.lineTo(s.x, s.y + s.r); ctx.stroke(); }
    crystalSheet.paint(Math.round(tt * 0.35 * 8) / 8);          // the light moves in small steps: the facets glint
    const RO = R * 3.75, RI = R * 1.45, FLAT = 0.22;
    // the disk: a flattened ring of crystal shards sliding slowly round; far half first
    const disk = back => {
      ctx.save();
      ctx.rotate(tilt);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, RO, RO * FLAT, 0, 0, Math.PI * 2);
      ctx.ellipse(0, 0, RI, RI * FLAT, 0, 0, Math.PI * 2);
      ctx.clip('evenodd');
      ctx.beginPath(); ctx.rect(-RO - 2, back ? -RO : 0, RO * 2 + 4, RO); ctx.clip();      // just the far (or near) half
      const sheetW = RO * 2, shift = ((tt * 9) % sheetW + sheetW) % sheetW;
      for(const k of [-1, 0]) ctx.drawImage(crystalSheet.cv, -RO + shift + k * sheetW, -RO * FLAT, sheetW, RO * FLAT * 2);
      ctx.restore();
      ctx.strokeStyle = 'rgba(29,29,31,0.55)'; ctx.lineWidth = 1;                         // a fine ink edge
      ctx.beginPath(); ctx.ellipse(0, 0, RO, RO * FLAT, 0, back ? Math.PI : 0, back ? Math.PI * 2 : Math.PI); ctx.stroke();
      ctx.restore();
    };
    disk(true);
    // the bent light around the hole: faint ink rings, a ring of crystal, then the dark centre
    for(const [k, a] of [[1.9, 0.12], [1.6, 0.2]]){
      ctx.strokeStyle = 'rgba(29,29,31,' + a + ')'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, R * k, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, R * 1.32, 0, Math.PI * 2); ctx.arc(0, 0, R * 0.98, 0, Math.PI * 2, true); ctx.clip();
    ctx.drawImage(crystalSheet.cv, -R * 1.4, -R * 1.4, R * 2.8, R * 2.8);
    ctx.restore();
    ctx.strokeStyle = 'rgba(29,29,31,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.32, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#0B0B0D'; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    disk(false);
    // the shuttle, spiralling in over ~40 seconds: it shrinks, stretches toward the hole and is gone
    const u = ((tt / 40) % 1 + 1) % 1;
    const ang = (r0, k) => 2.6 - k * 5.2;                       // how far round it has come
    const pos = k => { const rr = 430 * (1 - k) + 70 * k; const a = ang(0, k); return [Math.cos(a) * rr, Math.sin(a) * rr * 0.62]; };
    ctx.strokeStyle = 'rgba(29,29,31,0.4)'; ctx.lineWidth = 1.6; ctx.setLineDash([2, 7]);       // its dotted trail
    ctx.beginPath();
    for(let k = Math.max(0, u - 0.28), first = true; k <= u; k += 0.01){ const [x, y] = pos(k); if(first){ ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);
    const [x, y] = pos(u), [nx, ny] = pos(Math.min(1, u + 0.01));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(ny - y, nx - x));
    const shrink = 1 - u * 0.75, stretch = 1 + Math.pow(u, 3) * 2.2;
    ctx.scale(shrink * stretch * 0.9, shrink / Math.sqrt(stretch) * 0.9);
    ctx.globalAlpha = u > 0.93 ? (1 - u) / 0.07 : 1;
    shuttle();
    ctx.restore();
  };

  const CHAPTERS = [
    { theme: 'clarity', at: { x: -2700, y: 1180 }, reach: 360, draw: chapter1 },    // tucked into the bottom-left corner
  ];

  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  };
  const camera = () => {
    const r = hubRect();
    return { ox: r.left + r.width / 2 - cam.x * cam.z, oy: r.top + r.height / 2 - cam.y * cam.z, z: cam.z };
  };
  const visible = () => {
    if(typeof cam !== 'object' || view !== 'hub' || document.hidden) return [];
    const theme = document.documentElement.getAttribute('data-theme');
    const { ox, oy, z } = camera();
    return CHAPTERS.filter(c => {
      if(c.theme !== theme) return false;
      const sx = ox + c.at.x * z, sy = oy + c.at.y * z, m = c.reach * z;
      return sx + m > 0 && sx - m < w && sy + m > 0 && sy - m < h;
    });
  };
  const draw = list => {
    ctx.clearRect(0, 0, w, h);
    const { ox, oy, z } = camera();
    for(const c of list){
      ctx.save();
      ctx.translate(ox + c.at.x * z, oy + c.at.y * z);
      ctx.scale(z, z);
      c.draw(t);
      ctx.restore();
    }
    shown = list.length > 0;
    dirty = false;
  };
  const frame = now => {
    raf = 0;
    const list = visible();
    if(!list.length){ if(shown){ ctx.clearRect(0, 0, w, h); shown = false; } return; }   // nothing on screen: stop
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    if(!still) t += dt;
    if(dirty || (!still && now - lastDraw > 33)){ lastDraw = now; draw(list); }
    if(!still) raf = requestAnimationFrame(frame);
  };
  const wake = () => { if(!w) size(); dirty = true; if(!raf){ last = 0; raf = requestAnimationFrame(frame); } };
  new MutationObserver(wake).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  document.addEventListener('visibilitychange', wake);
  addEventListener('resize', () => { size(); wake(); });
  return { moved: wake };
})();
window.wfStory = story;

const meteors = (() => {
  const cv = document.getElementById('meteors');
  if(!cv) return null;
  const ctx = cv.getContext('2d');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, raf = 0, timer = 0, last = 0, list = [];
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const on = () => !still && document.documentElement.getAttribute('data-theme') === 'claritydark' && !document.hidden;
  const launch = () => {
    timer = 0;
    if(!on()) return;
    // start somewhere along the top or the right edge, heading down and to the left
    const angle = Math.PI * (0.78 + Math.random() * 0.1);
    const fromTop = Math.random() < 0.6;
    list.push({
      x: fromTop ? w * (0.25 + Math.random() * 0.75) : w + 20, y: fromTop ? -20 : h * Math.random() * 0.45,
      dx: Math.cos(angle), dy: Math.sin(angle),
      speed: 900 + Math.random() * 600, len: 120 + Math.random() * 120,
      age: 0, life: 0.7 + Math.random() * 0.5,
    });
    if(!raf){ last = 0; raf = requestAnimationFrame(frame); }
    timer = setTimeout(launch, 3000 + Math.random() * 6000);
  };
  const frame = now => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    ctx.clearRect(0, 0, w, h);
    list = list.filter(m => (m.age += dt) < m.life);
    for(const m of list){
      m.x += m.dx * m.speed * dt; m.y += m.dy * m.speed * dt;
      const k = m.age / m.life, fade = Math.min(1, k * 6) * (1 - k);         // flick on, then die away
      const tx = m.x - m.dx * m.len, ty = m.y - m.dy * m.len;
      const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
      g.addColorStop(0, 'rgba(255,255,255,' + 0.95 * fade + ')');
      g.addColorStop(0.3, 'rgba(190,215,255,' + 0.45 * fade + ')');
      g.addColorStop(1, 'rgba(190,215,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + 0.9 * fade + ')';             // the bright head
      ctx.beginPath(); ctx.arc(m.x, m.y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    raf = list.length ? requestAnimationFrame(frame) : 0;
  };
  const update = () => {
    if(on()){
      if(!w) size();
      if(!timer) timer = setTimeout(launch, 1200 + Math.random() * 2500);
    } else {
      clearTimeout(timer); timer = 0;
      if(raf){ cancelAnimationFrame(raf); raf = 0; }
      list = []; if(w) ctx.clearRect(0, 0, w, h);
    }
  };
  new MutationObserver(update).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  document.addEventListener('visibilitychange', update);
  addEventListener('resize', () => { if(w) size(); });
  update();
  return { launch };
})();

/* Cherry blossom petals for the Cherry Blossom theme. Each petal falls,
   sways side to side and tumbles (its width squeezes as it turns over). It
   only runs while that theme is on and the tab is visible; with reduced motion
   it paints one still scatter of petals instead. */
const petals = (() => {
  const cv = document.getElementById('petals');
  if(!cv) return null;
  const ctx = cv.getContext('2d');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tints = ['#F9C5D8', '#F6B2CB', '#FBD9E6', '#F4A3BF', '#FDE8F0', '#F8BBD0'];
  let list = [], raf = 0, w = 0, h = 0, last = 0;
  const make = (anywhere) => {
    const size = 7 + Math.random() * 8;
    return {
      x: Math.random() * w, y: anywhere ? Math.random() * h : -20 - Math.random() * h * 0.3,
      size, fall: 18 + size * 2.2 + Math.random() * 14,          // px per second, bigger is nearer and faster
      drift: -6 + Math.random() * 18,                              // a light breeze from the left
      sway: 10 + Math.random() * 22, swayRate: 0.6 + Math.random() * 0.9, phase: Math.random() * 6.28,
      rot: Math.random() * 6.28, spin: -1 + Math.random() * 2,
      tumble: Math.random() * 6.28, tumbleRate: 1 + Math.random() * 2,
      tint: tints[Math.floor(Math.random() * tints.length)], alpha: 0.7 + Math.random() * 0.3,
    };
  };
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.round(Math.min(55, Math.max(18, w * h / 26000)));
    while(list.length < want) list.push(make(true));
    list.length = want;
  };
  // one petal: a rounded teardrop with the little notch cherry petals have at the tip
  // Petals live on the map, not the screen. Their positions are map
  // coordinates inside one tile (TW x TH) that repeats across the whole map,
  // and every copy is placed with the same camera maths as the grid and the
  // bubbles: panning slides them, zooming spreads or gathers them and scales
  // them, and there are petals wherever you scroll or however far you zoom out.
  const TW = () => w + 80, TH = () => h + 40;
  const wrap = (v, lo, hi) => lo + (((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo);
  const camera = () => {
    if(typeof cam !== 'object' || view !== 'hub') return { ox: 0, oy: 0, z: 1 };
    const r = hubRect();
    return { ox: r.left + r.width / 2 - cam.x * cam.z, oy: r.top + r.height / 2 - cam.y * cam.z, z: cam.z };   // where map (0,0) sits on screen
  };
  const drawAll = () => {
    const { ox, oy, z } = camera();
    const tw = TW(), th = TH();
    ctx.clearRect(0, 0, w, h);
    for(const p of list){
      const fx = wrap(p.x + Math.sin(p.phase) * p.sway, 0, tw), fy = wrap(p.y, 0, th);
      const m = 20 * z;                                   // keep edge petals drawn until fully off screen
      const i0 = Math.floor(((-m - ox) / z - fx) / tw), i1 = Math.floor(((w + m - ox) / z - fx) / tw);
      const j0 = Math.floor(((-m - oy) / z - fy) / th), j1 = Math.floor(((h + m - oy) / z - fy) / th);
      for(let i = i0; i <= i1; i++) for(let j = j0; j <= j1; j++)
        drawPetal(p, ox + (fx + i * tw) * z, oy + (fy + j * th) * z, z);
    }
  };
  const drawPetal = (p, sx, sy, z) => {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(p.rot);
    ctx.scale(z * (0.35 + 0.65 * Math.abs(Math.cos(p.tumble))), z);   // zooming in makes petals bigger
    ctx.globalAlpha = p.alpha;
    const s = p.size;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.55);
    ctx.bezierCurveTo(s * 0.75, s * 0.25, s * 0.55, -s * 0.55, s * 0.14, -s * 0.5);
    ctx.lineTo(0, -s * 0.34);
    ctx.lineTo(-s * 0.14, -s * 0.5);
    ctx.bezierCurveTo(-s * 0.55, -s * 0.55, -s * 0.75, s * 0.25, 0, s * 0.55);
    ctx.fillStyle = p.tint;
    ctx.fill();
    ctx.globalAlpha = p.alpha * 0.35;                              // a soft darker vein down the middle
    ctx.strokeStyle = '#E58BAE'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(0, s * 0.4); ctx.lineTo(0, -s * 0.25); ctx.stroke();
    ctx.restore();
  };
  const frame = now => {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    for(const p of list){
      p.y += p.fall * dt; p.x += p.drift * dt;            // map units: falling off the tile wraps back to its top
      p.phase += p.swayRate * dt; p.rot += p.spin * dt; p.tumble += p.tumbleRate * dt;
    }
    drawAll();
  };
  const paintStill = () => drawAll();
  const on = () => document.documentElement.getAttribute('data-theme') === 'iridescence' && !document.hidden;
  const update = () => {
    if(on()){
      if(!w) size();
      if(still){ paintStill(); return; }
      if(!raf){ last = 0; raf = requestAnimationFrame(frame); }
    } else if(raf){ cancelAnimationFrame(raf); raf = 0; }
  };
  new MutationObserver(update).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  document.addEventListener('visibilitychange', update);
  addEventListener('resize', () => { if(w){ size(); if(still && on()) paintStill(); } });
  update();
  // with reduced motion nothing animates, so the still petals are repainted when the map moves
  return { update, moved: () => { if(still && on() && w) paintStill(); } };
})();
window.wfPetals = petals;

/* The Horizon theme: a planet horizon drawn in text characters, after the
   Gradient ASCII effect. Everything is placed in map coordinates (like the
   petals), so it pans and zooms with the bubbles. Brightness picks both the
   colour, from the effect's blue ramp, and the character, from ' =+xX0S8#@'
   (denser characters where it is brighter). A soft low-resolution glow sits
   underneath the characters. Runs only in this theme, ~25 frames a second. */
const asciiSky = (() => {
  const cv = document.getElementById('ascii');
  if(!cv) return null;
  const ctx = cv.getContext('2d');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CHARS = ' =+xX0S8#@';
  const RAMP = [[30,63,216], [56,189,248], [165,216,255], [246,248,255]];   // #1E3FD8 #38BDF8 #A5D8FF #F6F8FF
  const LEVELS = 8;
  const CW = 11, CH = 18;                    // one character cell, in map units
  const glow = document.createElement('canvas'), gctx = glow.getContext('2d');
  let w = 0, h = 0, dpr = 1, raf = 0, t = 0, last = 0, lastDraw = 0, dirty = true;
  let sprites = null, spriteSize = 0;

  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const smooth = v => v * v * (3 - 2 * v);
  const noise = (x, y) => {                  // smooth value noise, 0..1
    const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  const rampColor = v => {
    const x = Math.min(0.999, Math.max(0, v)) * (RAMP.length - 1), i = Math.floor(x), f = x - i;
    return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f));
  };
  // how bright the horizon is at a map point: a glowing rim just above the
  // planet's edge fading up into the sky, a faint planet below, a little dust
  // The whole map is covered in characters. Two layers of slow noise roll
  // through it, so patches brighten into dense characters and fade back to
  // faint ones, always changing, never empty and never in bands.
  const field = (X, Y) => {
    const u = X / 620, v = Y / 620;
    const n1 = noise(u * 1.3 + t * 0.16, v * 1.3 - t * 0.11);
    const n2 = noise(u * 3.1 - t * 0.22, v * 3.1 + t * 0.14);
    const n3 = noise(u * 0.55 - t * 0.05, v * 0.55 + t * 0.07);
    const mix = n1 * 0.45 + n2 * 0.3 + n3 * 0.25;
    return 0.12 + 0.95 * Math.pow(Math.max(0, mix - 0.18) / 0.82, 1.35);
  };
  const camera = () => {
    if(typeof cam !== 'object' || view !== 'hub') return { ox: w / 2, oy: h / 2, z: 1 };
    const r = hubRect();
    return { ox: r.left + r.width / 2 - cam.x * cam.z, oy: r.top + r.height / 2 - cam.y * cam.z, z: cam.z };
  };
  // every character in every colour level, drawn once per text size
  const buildSprites = px => {
    spriteSize = px;
    const sw = Math.ceil(px * 0.62 * dpr), sh = Math.ceil(px * dpr);
    sprites = [];
    for(let l = 0; l < LEVELS; l++){
      const col = rampColor(l / (LEVELS - 1));
      sprites.push([...CHARS].map(ch => {
        const c = document.createElement('canvas'); c.width = sw; c.height = sh;
        const x = c.getContext('2d');
        x.font = '300 ' + Math.round(px * 0.78 * dpr) + 'px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillStyle = 'rgb(' + col.join(',') + ')';
        x.fillText(ch, sw / 2, sh / 2 + 1);
        return c;
      }));
    }
  };
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glow.width = Math.ceil(w / 10); glow.height = Math.ceil(h / 10);
    dirty = true;
  };
  const draw = () => {
    const { ox, oy, z } = camera();
    ctx.clearRect(0, 0, w, h);
    // 1. the soft glow underneath, at a tenth of the resolution and scaled up
    const gw = glow.width, gh = glow.height, img = gctx.createImageData(gw, gh), d = img.data;
    for(let gy = 0; gy < gh; gy++) for(let gx = 0; gx < gw; gx++){
      const val = field(((gx + 0.5) * 10 - ox) / z, ((gy + 0.5) * 10 - oy) / z);
      const a = Math.min(1, val) * 0.32;
      if(a < 0.01) continue;
      const col = rampColor(val * 0.8), i = (gy * gw + gx) * 4;
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = a * 255;
    }
    gctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(glow, 0, 0, gw * 10, gh * 10);
    // 2. the characters, on a grid fixed to the map; far out, cells merge so text stays readable
    const k = Math.max(1, Math.ceil(9 / (CH * z)));
    const cw = CW * k, ch = CH * k, sx = cw * z, sy = ch * z;
    const px = Math.round(sy);
    if(!sprites || px !== spriteSize) buildSprites(px);
    const X0 = Math.floor((-ox / z) / cw) * cw, Y0 = Math.floor((-oy / z) / ch) * ch;
    const tick = Math.floor(t * 9);
    for(let Y = Y0; Y < (h - oy) / z + ch; Y += ch){
      const screenY = oy + Y * z;
      for(let X = X0; X < (w - ox) / z + cw; X += cw){
        const val = field(X + cw / 2, Y + ch / 2);
        if(val < 0.08) continue;
        const cx = X / cw, cy = Y / ch;
        if(hash(cx, cy) > 0.93) continue;                                      // nearly every cell has a character
        const wobble = (hash(cx * 2.31 + tick * 17.7, cy) - 0.5) * 0.16 + (hash(cx * 1.73, cy + 4.1) - 0.5) * 0.1;   // characters flicker and swap
        const tone = Math.min(1, Math.max(0, Math.pow(Math.min(1, val), 0.75) + wobble));
        const ci = Math.max(1, Math.round(tone * (CHARS.length - 1)));
        const li = Math.min(LEVELS - 1, Math.round(tone * (LEVELS - 1)));
        ctx.globalAlpha = 0.45 + 0.55 * tone;
        ctx.drawImage(sprites[li][ci], ox + X * z, screenY, sx, sy);
      }
    }
    ctx.globalAlpha = 1;
    dirty = false;
  };
  const frame = now => {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if(!still) t += dt * 0.5;
    if(dirty || (!still && now - lastDraw > 40)){ lastDraw = now; draw(); }
  };
  const on = () => document.documentElement.getAttribute('data-theme') === 'ascii' && !document.hidden;
  const update = () => {
    if(on()){
      if(!w) size();
      dirty = true;
      if(!raf){ last = 0; raf = requestAnimationFrame(frame); }
    } else if(raf){ cancelAnimationFrame(raf); raf = 0; }
  };
  new MutationObserver(update).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  document.addEventListener('visibilitychange', update);
  addEventListener('resize', () => { if(w){ size(); } });
  update();
  return { moved: () => { dirty = true; } };   // the map moved: redraw on the next frame
})();
window.wfAscii = asciiSky;

/* The Snow theme: pixel snowflakes from the Pixel Snow effect, drawn crisp.
   Five depth levels (small, dim and slow far away; big, bright and fast up
   close), each flake swaying, drifting on a light wind and now and then
   twinkling, with a soft glow. Like the petals they live in map coordinates
   inside a repeating tile, so the snow pans and zooms with the bubbles. */
const snowSky = (() => {
  const cv = document.getElementById('snow');
  if(!cv) return null;
  const ctx = cv.getContext('2d');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // the effect's "snowflake" sprites: '@' core, 'o' body, 'x' tips, '.' empty;
  // levels 0-4, then alternate shapes for levels 2-4
  const SPRITES = [
    ['@'],
    ['.x.', 'x@x', '.x.'],
    ['..x..', 'x.o.x', '.o@o.', 'x.o.x', '..x..'],
    ['...x...', '.x.o.x.', '..ooo..', 'xoo@oox', '..ooo..', '.x.o.x.', '...x...'],
    ['....x....', '.x..o..x.', '..o.o.o..', '...ooo...', 'xooo@ooox', '...ooo...', '..o.o.o..', '.x..o..x.', '....x....'],
    ['x...x', '.o.o.', '..@..', '.o.o.', 'x...x'],
    ['x..x..x', '.o.o.o.', '..ooo..', 'xoo@oox', '..ooo..', '.o.o.o.', 'x..x..x'],
    ['x...x...x', '.o..o..o.', '..o.o.o..', '...ooo...', 'xooo@ooox', '...ooo...', '..o.o.o..', '.o..o..o.', 'x...x...x'],
  ];
  const WEIGHTS = [0.46, 0.27, 0.15, 0.08, 0.04];
  const FALL = [16, 24, 34, 48, 66];          // map units per second, by level
  const LIGHT = [0.42, 0.58, 0.76, 0.92, 1];
  const PIXEL = 2.4;                          // one sprite pixel, in map units (the effect's 3, made 20% smaller)
  let list = [], w = 0, h = 0, dpr = 1, raf = 0, last = 0, t = 0, built = 0, imgs = [];
  const pickLevel = () => { let r = Math.random(), acc = 0; for(let l = 0; l < 5; l++){ acc += WEIGHTS[l]; if(r <= acc) return l; } return 4; };
  const make = () => {
    const level = pickLevel();
    return { level, alt: level >= 2 && Math.random() < 0.5, x: Math.random() * (w + 80), y: Math.random() * (h + 40),
      phase: Math.random() * 6.28, rate: 0.6 + Math.random() * 0.9, drift: 0.7 + Math.random() * 0.6, sparkle: Math.random() * 100 };
  };
  // each sprite drawn once per on-screen pixel size, white with a soft glow baked in
  const build = p => {
    built = p;
    imgs = SPRITES.map(rows => {
      const n = rows.length, pad = Math.ceil(p * 3), c = document.createElement('canvas');
      c.width = c.height = Math.ceil((n * p + pad * 2) * dpr);
      const x = c.getContext('2d');
      x.scale(dpr, dpr);
      const paint = () => rows.forEach((line, ry) => [...line].forEach((m, rx) => {
        if(m === '.') return;
        const core = m === '@' ? 1 : m === 'o' ? 0.5 : 0;
        x.fillStyle = 'rgba(255,255,255,' + (0.82 + core * 0.18) + ')';
        x.fillRect(pad + rx * p, pad + ry * p, p, p);
      }));
      x.shadowColor = 'rgba(210,232,255,0.85)'; x.shadowBlur = p * 2.2; paint();   // the glow
      x.shadowBlur = 0; paint();                                                   // crisp pixels on top
      return { img: c, size: n * p + pad * 2 };
    });
  };
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const want = Math.round(Math.min(420, w * h / 2600));
    while(list.length < want) list.push(make());
    list.length = want;
    built = 0;
  };
  const wrap = (v, lo, hi) => lo + (((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo);
  const camera = () => {
    if(typeof cam !== 'object' || view !== 'hub') return { ox: 0, oy: 0, z: 1 };
    const r = hubRect();
    return { ox: r.left + r.width / 2 - cam.x * cam.z, oy: r.top + r.height / 2 - cam.y * cam.z, z: cam.z };
  };
  const draw = () => {
    const { ox, oy, z } = camera();
    const p = Math.max(0.75, Math.round(PIXEL * z * 20) / 20);  // sprites are redrawn only when the size really changes
    if(p !== built) build(p);
    const tw = w + 80, th = h + 40;
    ctx.clearRect(0, 0, w, h);
    for(const f of list){
      const sway = Math.sin(t * f.rate + f.phase) * 0.5 * (6 + f.level * 7) * f.drift;
      const fx = wrap(f.x + sway, 0, tw), fy = wrap(f.y, 0, th);
      const s = imgs[f.level >= 2 && f.alt ? f.level + 3 : f.level];
      const spark = Math.pow(Math.max(0, Math.sin(t * 0.9 + f.sparkle)), 60) * 0.35;
      ctx.globalAlpha = Math.min(1, (1 - 0.6 * (1 - LIGHT[f.level])) * (0.85 + spark * 0.6));
      const m = s.size;
      const i0 = Math.floor(((-m - ox) / z - fx) / tw), i1 = Math.floor(((w + m - ox) / z - fx) / tw);
      const j0 = Math.floor(((-m - oy) / z - fy) / th), j1 = Math.floor(((h + m - oy) / z - fy) / th);
      for(let i = i0; i <= i1; i++) for(let j = j0; j <= j1; j++)
        ctx.drawImage(s.img, Math.round(ox + (fx + i * tw) * z - m / 2), Math.round(oy + (fy + j * th) * z - m / 2), m, m);
    }
    ctx.globalAlpha = 1;
  };
  const frame = now => {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now; t += dt;
    for(const f of list){
      const parallax = 1 - 0.6 * (1 - (f.level + 1) / 5) * 0.75;
      f.y += FALL[f.level] * parallax * f.drift * dt;
      f.x += 11.5 * parallax * f.drift * dt;                     // the light wind
    }
    draw();
  };
  const on = () => document.documentElement.getAttribute('data-theme') === 'snow' && !document.hidden;
  const update = () => {
    if(on()){
      if(!w) size();
      if(still){ draw(); return; }
      if(!raf){ last = 0; raf = requestAnimationFrame(frame); }
    } else if(raf){ cancelAnimationFrame(raf); raf = 0; }
  };
  new MutationObserver(update).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  document.addEventListener('visibilitychange', update);
  addEventListener('resize', () => { if(w){ size(); if(still && on()) draw(); } });
  update();
  return { moved: () => { if(still && on() && w) draw(); } };
})();
window.wfSnow = snowSky;

const RETIRED_THEMES = { glass:'clarity', glassdark:'claritydark', orbit:'clarity', prism:'clarity', dark:'claritydark' };

let look = { theme:DEFAULT_THEME, font:'publicsans', scale:100, textColor:'' };

function applyLook(l){
  const root = document.documentElement;
  const theme = THEMES.some(t => t.id === l.theme)
    ? l.theme
    : (RETIRED_THEMES[l.theme] || DEFAULT_THEME);
  if(theme !== l.theme) l.theme = theme;        // carry a retired id forward
  root.setAttribute('data-theme', theme === 'custom' && !customBg ? DEFAULT_THEME : theme);   // no picture yet: fall back
  applyCustomBg(l);
  const f = FONTS.find(x => x.id === l.font) || FONTS[0];
  if(f.web) loadWebFont(f.web);
  root.style.setProperty('--font-ui', f.stack);
  root.style.setProperty('--font-display', f.stack);
  root.style.setProperty('--font-scale', (Number(l.scale) || 100) / 100);
  const themeInk = getComputedStyle(root).getPropertyValue('--ink-default').trim();
  if(themeInk && (inkColor === '#E7EBEC' || inkColor === '#12161A')){
    inkColor = themeInk; renderSwatches();
  }
  if(l.textColor) root.style.setProperty('--text', l.textColor);
  else root.style.removeProperty('--text');
  try{ localStorage.setItem('wf_look', JSON.stringify(l)); }catch(e){}
  if(typeof view !== 'undefined' && view === 'hub'){ try{ layoutHub(); redrawInk(); }catch(e){} }
}
const _webFonts = {};
function loadWebFont(fam){
  if(_webFonts[fam]) return;
  _webFonts[fam] = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=' + fam + ':wght@400;600;700&display=swap';
  document.head.appendChild(link);
}
function saveLook(){
  applyLook(look);
  if(cols.settings) cols.settings.set('ui', Object.assign({}, look, { updatedAt: Date.now() })).catch(() => {});
  renderSettings();
}
function setTheme(id){ look.theme = id; saveLook(); }

/* ---- "Choose image": the visitor's own picture as the background ----
   For this visit only: it never leaves the browser and is not stored, so a
   refresh goes back to the default look. Large pictures are shrunk (longest
   side 2400px) so the page stays quick, and the picture is checked for whether
   it is mostly light or dark so the panels and text can match it. */
let customBg = null;
// clear anything an earlier version stored, so old pictures and presets don't come back
try{ Object.keys(localStorage).filter(k => k === 'wf_bg' || k === 'wf_presets' || k.indexOf('wf_preset_bg_') === 0).forEach(k => localStorage.removeItem(k)); }catch(e){}
function applyCustomBg(l){
  const root = document.documentElement, el = document.getElementById('custom-bg');
  if(el) el.style.backgroundImage = customBg ? 'url(' + customBg + ')' : '';
  root.setAttribute('data-bg-tone', l.bgTone === 'light' ? 'light' : 'dark');
  root.style.setProperty('--bg-dim', String((typeof l.bgDim === 'number' ? l.bgDim : 20) / 100));
  const controls = document.getElementById('bg-controls');
  if(controls) controls.hidden = !(customBg && l.theme === 'custom');
  const dim = document.getElementById('bg-dim'), read = document.getElementById('bg-dim-read');
  const v = typeof l.bgDim === 'number' ? l.bgDim : 20;
  if(dim && document.activeElement !== dim) dim.value = v;
  if(read) read.textContent = v + '%';
}
function pickBackground(){ const f = document.getElementById('bg-file'); if(f) f.click(); }
async function loadBackground(file){
  if(!file || !/^image\//.test(file.type)){ toast('That file is not a picture'); return; }
  const url = URL.createObjectURL(file);
  try{
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    // mostly light or mostly dark? sample it small and average the brightness
    const t = document.createElement('canvas'); t.width = t.height = 24;
    const tx = t.getContext('2d'); tx.drawImage(img, 0, 0, 24, 24);
    const d = tx.getImageData(0, 0, 24, 24).data; let lum = 0;
    for(let i = 0; i < d.length; i += 4) lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    lum /= d.length / 4;
    customBg = c.toDataURL('image/jpeg', 0.86);
    look.bgTone = lum > 0.56 ? 'light' : 'dark';
    look.bgDim = 20;                                         // a light tint to start; the slider changes it
    look.theme = 'custom';
    saveLook();
    toast('Background set');
  }catch(e){
    toast('Could not open that picture');
  }finally{ URL.revokeObjectURL(url); }
}
function removeBackground(){
  customBg = null;
  if(look.theme === 'custom') look.theme = DEFAULT_THEME;
  saveLook();
}
function setBgDim(v){ look.bgDim = Number(v) || 0; saveLook(); }

/* ---- your own themes ("Save as my theme") ----
   A saved theme is the whole appearance at once: theme, font, text size, text
   colour and, with a picture, the picture and its tint. It shows up in the
   theme grid like the built-in themes. Like everything in the demo it lasts
   for this visit only; a refresh starts fresh. */
const LOOK_KEYS = ['theme', 'font', 'scale', 'textColor', 'bgTone', 'bgDim'];
let presets = [];
const savePresets = () => {};      // demo: kept for this visit only
const presetBg = id => { const p = presets.find(x => x.id === id); return p ? p.bg || null : null; };
const sameLook = p => LOOK_KEYS.every(k => k === 'bgTone' || k === 'bgDim' ? (p.theme !== 'custom' || p[k] === look[k]) : (p[k] || '') === (look[k] || ''))
  && (p.theme !== 'custom' || presetBg(p.id) === customBg);
function openSavePreset(){
  const t = THEMES.find(x => x.id === look.theme);
  openModal('Save as my theme', `
    <div class="field"><label>Name</label>
      <input class="input" id="preset-name" maxlength="30" placeholder="e.g. Late-night study" value="${esc(t ? t.name : '')}"
        onkeydown="if(event.key==='Enter') savePreset()"></div>
    <p style="margin:0; font-size:0.78rem; color:var(--text-muted);">Saves your theme, font, text size and colour${look.theme === 'custom' ? ', plus your picture and its tint' : ''}.</p>
    <button class="btn btn-primary" onclick="savePreset()">Save theme</button>`);
  setTimeout(() => { const i = document.getElementById('preset-name'); if(i){ i.focus(); i.select(); } }, 40);
}
function savePreset(){
  const name = ((document.getElementById('preset-name') || {}).value || '').trim();
  if(!name) return;
  const p = { id: uid(), name };
  LOOK_KEYS.forEach(k => { if(look[k] !== undefined) p[k] = look[k]; });
  if(look.theme === 'custom' && customBg) p.bg = customBg;
  presets.push(p);
  savePresets();
  closeModal();
  renderSettings();
  toast('Saved "' + name + '" to your themes');
}
function applyPreset(id){
  const p = presets.find(x => x.id === id);
  if(!p) return;
  if(p.theme === 'custom'){
    const pic = presetBg(p.id);
    if(pic) customBg = pic;
  }
  look = Object.assign({}, look);
  LOOK_KEYS.forEach(k => { if(p[k] !== undefined) look[k] = p[k]; });
  saveLook();
}
function deletePreset(id){
  const p = presets.find(x => x.id === id);
  presets = presets.filter(x => x.id !== id);
  savePresets();
  renderSettings();
  if(p) toast('Deleted "' + p.name + '"');
}
// paste a picture (⌘V) or drop one onto the Appearance panel while it is open
document.addEventListener('paste', e => {
  if(!document.getElementById('settings-sheet').classList.contains('open')) return;
  const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith('image/'));
  if(item){ e.preventDefault(); loadBackground(item.getAsFile()); }
});
(function wireDrop(){
  const card = document.querySelector('#settings-sheet .sheet-card');
  if(!card) return;
  card.addEventListener('dragover', e => { if([...e.dataTransfer.types].includes('Files')){ e.preventDefault(); card.classList.add('dropping'); } });
  card.addEventListener('dragleave', () => card.classList.remove('dropping'));
  card.addEventListener('drop', e => {
    card.classList.remove('dropping');
    const f = [...(e.dataTransfer.files || [])].find(x => x.type.startsWith('image/'));
    if(f){ e.preventDefault(); loadBackground(f); }
  });
})();
function setFont(id){ look.font = id; saveLook(); }
function setScale(v){ look.scale = Number(v) || 100; saveLook(); }
function setTextColor(col){ look.textColor = col; saveLook(); }
function resetLook(){ look = { theme: look.theme, font:'publicsans', scale:100, textColor:'' }; saveLook(); }
function openSettings(){ openSheet('settings-sheet'); renderSettings(); }
function renderSettings(){
  const grid = document.getElementById('theme-grid');
  const mineOn = presets.find(sameLook);
  if(grid) grid.innerHTML = THEMES.filter(t => t.id !== 'custom').map(t => `
    <button class="theme-card ${look.theme === t.id ? 'on' : ''}" onclick="setTheme('${t.id}')">
      <span class="theme-swatch" style="background-color:${t.ink};
        background-image:linear-gradient(${t.line} 1px, transparent 1px), linear-gradient(90deg, ${t.line} 1px, transparent 1px);
        background-size:9px 9px;"><i style="background:${t.dot}"></i></span>
      <span>${esc(t.name)}</span>
    </button>`).join('')
    // your own themes, made with "Save as my theme"
    + presets.map(p => {
      const t = THEMES.find(x => x.id === p.theme) || THEMES[0];
      const sw = p.bg ? `<span class="theme-swatch custom" style="background-image:url(${p.bg})"></span>`
        : `<span class="theme-swatch" style="background-color:${t.ink};
            background-image:linear-gradient(${t.line} 1px, transparent 1px), linear-gradient(90deg, ${t.line} 1px, transparent 1px);
            background-size:9px 9px;"><i style="background:${t.dot}"></i></span>`;
      return `<button class="theme-card mine ${mineOn === p ? 'on' : ''}" onclick="applyPreset('${p.id}')" title="${esc(p.name)}">
        ${sw}<span>${esc(p.name)}</span>
        <span class="theme-del" role="button" aria-label="Delete ${esc(p.name)}" title="Delete" onclick="event.stopPropagation(); deletePreset('${p.id}')">✕</span>
      </button>`;
    }).join('')
    // always last, always the picker
    + `<button class="theme-card ${look.theme === 'custom' && !mineOn ? 'on' : ''}" onclick="pickBackground()" title="Use a picture from your computer">
        <span class="theme-swatch empty">+</span><span>Choose image</span>
      </button>`;
  const sel = document.getElementById('set-font');
  if(sel && sel.options.length !== FONTS.length){
    sel.innerHTML = FONTS.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  }
  if(sel) sel.value = look.font;
  const sample = document.getElementById('font-sample');
  if(sample){
    const f = FONTS.find(x => x.id === look.font) || FONTS[0];
    sample.style.fontFamily = f.stack;
  }
  const size = document.getElementById('set-size');
  if(size) size.value = look.scale;
  const read = document.getElementById('size-read');
  if(read) read.textContent = look.scale + '%';
  const cols_ = document.getElementById('text-colors');
  if(cols_) cols_.innerHTML = TEXT_COLORS.map(col => `
    <button class="swatch-lg ${look.textColor === col ? 'on' : ''}"
      style="background:${col || 'var(--text)'};${col ? '' : 'background-image:linear-gradient(135deg,var(--text) 50%,var(--surface-2) 50%);'}"
      title="${col ? col : 'Theme default'}" onclick="setTextColor('${col}')"></button>`).join('');
}


/* ============ UNDO / REDO ============
   One stack for the whole hub: deleted panels, notes, rows, to-dos, pinned facts,
   whole sections, and anything drawn or erased. Session-length, 60 steps deep. */
const history = { past: [], future: [] };
function record(label, undo, redo){
  history.past.push({ label, undo, redo });
  if(history.past.length > 60) history.past.shift();
  history.future = [];
  renderHistory();
}
async function doUndo(){
  const a = history.past.pop();
  if(!a) return;
  try{ await a.undo(); }catch(e){ console.error('undo', e); }
  history.future.push(a);
  renderHistory();
  toast('Undid: ' + a.label);
}
async function doRedo(){
  const a = history.future.pop();
  if(!a) return;
  try{ await a.redo(); }catch(e){ console.error('redo', e); }
  history.past.push(a);
  renderHistory();
  toast('Redid: ' + a.label);
}
function renderHistory(){
  const u = document.getElementById('undo-btn'), r = document.getElementById('redo-btn');
  if(u){
    u.disabled = !history.past.length;
    u.title = history.past.length ? 'Undo ' + history.past[history.past.length-1].label : 'Nothing to undo';
  }
  if(r){
    r.disabled = !history.future.length;
    r.title = history.future.length ? 'Redo ' + history.future[history.future.length-1].label : 'Nothing to redo';
  }
}
/* Snapshot a section's panels, make the change, and file both sides of it. */
async function withUndo(bubbleId, label, mutate){
  const b = bubbleById(bubbleId);
  if(!b) return;
  const before = JSON.parse(JSON.stringify(getWidgets(b)));
  const widgets = getWidgets(b);
  mutate(widgets);
  const after = JSON.parse(JSON.stringify(widgets));
  await saveWidgets(bubbleId, after);
  record(label,
    () => saveWidgets(bubbleId, before),
    () => saveWidgets(bubbleId, after));
}

/* ============ DRAWING ON THE GRID ============
   Strokes are vectors in a 0-1000 space scaled by canvas WIDTH, so a drawing keeps
   its shape when the canvas resizes. They live in one db doc and survive reloads. */
const INK_COLORS = ['#E7EBEC', '#12161A', '#8A9397', '#5FBCC8', '#E0A53E', '#E0787F', '#7FC98F', '#9B8FD8'];
const pinnedPos = new Set();
let hubMode = 'move';
let inkColor = INK_COLORS[0], inkWidth = 3;
let strokes = [];            // [{id, c, w, p:[x,y,x,y,...]}]
let drawing = null;          // stroke in progress
let inkDirty = false;        // a local save is in flight — ignore older snapshots
let inkSaveTimer = null;

function setHubMode(mode){
  if(drawing) commitStroke();
  hubMode = mode;
  const canvas = document.getElementById('hub-canvas');
  canvas.classList.toggle('inking', mode !== 'move');
  canvas.classList.toggle('erasing', mode === 'erase');
  ['move','draw','erase'].forEach(m => {
    const b = document.getElementById('tool-' + m);
    if(b) b.classList.toggle('on', m === mode);
  });
  const tools = document.getElementById('ink-tools');
  const sep = document.getElementById('ink-tools-sep');
  const show = mode === 'draw';
  if(tools) tools.classList.toggle('ink-hidden', !show);
  if(sep) sep.style.display = (mode === 'move') ? 'none' : '';
  const hint = document.getElementById('hub-hint');
  if(hint) hint.textContent = mode === 'draw' ? 'Hold and drag to draw · release to stop'
    : mode === 'erase' ? 'Drag across a stroke to rub it out'
    : 'Scroll to move around \u00b7 pinch or \u2318-scroll to zoom \u00b7 drag a bubble to rearrange';
}
function renderSwatches(){
  const wrap = document.getElementById('ink-swatches');
  if(!wrap) return;
  wrap.innerHTML = INK_COLORS.map(col =>
    `<button class="swatch ${col === inkColor ? 'on' : ''}" style="background:${col}" data-col="${col}"
      onclick="pickInk('${col}')" aria-label="Colour ${col}"></button>`).join('');
}
function pickInk(col){ inkColor = col; renderSwatches(); }

function inkCanvas(){ return document.getElementById('ink'); }
/* strokes are stored in world units, exactly like bubbles, so a drawing stays
   welded to the patch of graph you drew it on however far you pan or zoom */
function toWorld(e){ return screenToWorld(e.clientX, e.clientY); }
function sizeInkCanvas(){
  const cv = inkCanvas(); if(!cv) return;
  const host = hubEl(); if(!host) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(host.clientWidth * dpr), h = Math.round(host.clientHeight * dpr);
  if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
}
function drawStrokeOn(ctx, st){
  const p = st.p || [];
  if(p.length < 2) return;
  ctx.strokeStyle = st.c || '#E7EBEC';
  ctx.lineWidth = Math.max(0.4, st.w || 3);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  if(p.length === 2){ ctx.lineTo(p[0] + 0.1, p[1] + 0.1); }
  for(let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i+1]);
  ctx.stroke();
}
function redrawInk(){
  const cv = inkCanvas(); if(!cv) return;
  const host = hubEl(); if(!host) return;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  // the same camera the bubbles ride on, so the ink stays crisp at any zoom
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(host.clientWidth/2, host.clientHeight/2);
  ctx.scale(cam.z, cam.z);
  ctx.translate(-cam.x, -cam.y);
  strokes.forEach(st => drawStrokeOn(ctx, st));
  if(drawing) drawStrokeOn(ctx, drawing);
}
/* a drawing made before the graph went endless was stored as a fraction of the
   old fixed canvas — lift those onto the world once, keeping their shape */
function migrateStrokes(list){
  return (list || []).map(st => {
    if(!st || st.v === 2) return st;
    const s = 1.16, cx = 580, cy = 330;      // the old canvas, near enough
    const p = (st.p || []).map((n, i) => Math.round((n * s - (i % 2 ? cy : cx)) * 10) / 10);
    return Object.assign({}, st, { p, w: (st.w || 3) * s, v: 2 });
  });
}
function saveInk(){
  inkDirty = true;
  clearTimeout(inkSaveTimer);
  inkSaveTimer = setTimeout(() => {
    let out = strokes;
    // keep the document comfortably inside the per-document size limit
    while(out.length > 1 && JSON.stringify(out).length > 200000) out = out.slice(1);
    if(out.length !== strokes.length) strokes = out;
    cols.drawing.set('hub', { strokes: out, updatedAt: Date.now() })
      .then(() => { inkDirty = false; })
      .catch(e => { inkDirty = false; console.error('ink save', e); });
  }, 400);
}
function attachInk(){
  const cv = inkCanvas(); if(!cv || cv._wired) return;
  cv._wired = true;
  let erasing = false;

  // Hold to draw, let go to stop. Nothing clever.
  cv.addEventListener('pointerdown', e => {
    if(hubMode === 'move') return;
    try{ cv.setPointerCapture(e.pointerId); }catch(err){}
    const [x, y] = toWorld(e);
    if(hubMode === 'erase'){ erasing = true; eraseBatch = []; eraseAt(x, y); return; }
    drawing = { id: uid(), c: inkColor, w: inkWidth, v: 2, p: [Math.round(x*10)/10, Math.round(y*10)/10] };
    redrawInk();
  });
  cv.addEventListener('pointermove', e => {
    if(hubMode === 'move') return;
    const [x, y] = toWorld(e);
    if(hubMode === 'erase'){ if(erasing) eraseAt(x, y); return; }
    if(!drawing) return;
    const p = drawing.p, lx = p[p.length-2], ly = p[p.length-1];
    if(Math.hypot(x - lx, y - ly) < 2 / cam.z) return;   // simplify as we go
    p.push(Math.round(x*10)/10, Math.round(y*10)/10);
    redrawInk();
  });
  const release = e => {
    try{ cv.releasePointerCapture(e.pointerId); }catch(err){}
    if(erasing){
      erasing = false;
      if(eraseBatch.length){
        const wiped = eraseBatch.slice();
        eraseBatch = [];
        record(wiped.length === 1 ? 'erase a stroke' : 'erase ' + wiped.length + ' strokes',
          () => { strokes = strokes.concat(wiped); redrawInk(); saveInk(); },
          () => { const ids = new Set(wiped.map(s => s.id));
                  strokes = strokes.filter(s => !ids.has(s.id)); redrawInk(); saveInk(); });
      }
      return;
    }
    commitStroke();
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  cv.addEventListener('pointerleave', e => { if(drawing || erasing) release(e); });
}
function commitStroke(){
  if(!drawing) return;
  const st = drawing;
  drawing = null;
  if(st.p.length >= 4){                 // needs at least two points to be a mark
    strokes.push(st);
    saveInk();
    record('draw a stroke',
      () => { strokes = strokes.filter(s => s.id !== st.id); redrawInk(); saveInk(); },
      () => { strokes.push(st); redrawInk(); saveInk(); });
  }
  redrawInk();
}
let eraseBatch = [];
function eraseAt(x, y){
  const r = 14 / cam.z;
  const keep = [];
  strokes.forEach(st => {
    const p = st.p || [];
    for(let i = 0; i < p.length; i += 2){
      if(Math.hypot(p[i] - x, p[i+1] - y) <= r + (st.w || 3)){ eraseBatch.push(st); return; }
    }
    keep.push(st);
  });
  if(keep.length !== strokes.length){ strokes = keep; redrawInk(); saveInk(); }
}

async function clearInk(){
  if(!strokes.length) return;
  if(!await askConfirm('Clear the drawing?', 'Every stroke on the grid will be removed. You can undo this.', 'Clear', true)) return;
  const wiped = strokes.slice();
  strokes = []; drawing = null;
  redrawInk(); saveInk();
  record('clear the drawing',
    () => { strokes = wiped.slice(); redrawInk(); saveInk(); },
    () => { strokes = []; redrawInk(); saveInk(); });
}

/* Entrances are class-driven so they fire on an actual view change and not
   on the innerHTML rebuild that follows every save. */
function flashEnter(el){
  if(!el) return;
  el.classList.remove('wf-enter');
  void el.offsetWidth;                 // restart the animation
  el.classList.add('wf-enter');
  clearTimeout(el._enterT);
  el._enterT = setTimeout(() => el.classList.remove('wf-enter'), 900);
}

function goHub(){
  view = 'hub'; activeBubbleId = null;
  document.getElementById('hub-view').hidden = false;
  document.getElementById('section-view').hidden = true;
  document.getElementById('add-bubble-btn').hidden = false;
  document.getElementById('helper-context').textContent = 'Your whole hub';
  render();
  flashEnter(document.getElementById('hub-view'));
}
function openSection(id){
  view = 'section'; activeBubbleId = id;
  document.getElementById('hub-view').hidden = true;
  document.getElementById('section-view').hidden = false;
  document.getElementById('add-bubble-btn').hidden = true;
  const b = bubbleById(id);
  document.getElementById('helper-context').textContent = b ? 'Section: ' + b.name : 'Section';
  attachInk();
  renderHistory();
  renderSettings();
  renderSwatches();
  setHubMode('move');
  sizeInkCanvas();
  render();
  renderSuggests();
  flashEnter(document.getElementById('section-view'));
}

/* ============ new / delete section ============ */
let pickedTone = 'teal';
let pickedSize = R_SEC;
let toneTouched = false;          // once a colour is picked by hand, changing the parent no longer overrides it
let pickedTint = 45;
/* How strongly a section is filled with its colour: 0 is the theme's own
   colour, 100 is full colour. Sections made before this existed get 45. */
const TINT_DEFAULT = 45;
const tintOf = b => (b && typeof b.tint === 'number') ? b.tint : TINT_DEFAULT;
function tintSlider(value, oninput, onchange){
  return `<div class="tint-row" id="tint-row">
      <span>Natural</span>
      <input class="ink-size tint-slider" id="tint-slider" type="range" min="0" max="100" value="${value}"
             oninput="${oninput}" ${onchange ? `onchange="${onchange}"` : ''} aria-label="How much colour">
      <span>Full colour</span>
    </div>`;
}
const TONE_NAMES = { none:'No colour', teal:'Teal', amber:'Amber', violet:'Violet', green:'Green', rose:'Rose', blue:'Blue' };
/* the swatches: "no colour" first, then the six section colours */
function toneSwatches(selected, onPick){
  return ['none'].concat(TONES).map(t =>
    `<button class="tone-swatch tone-${t} ${t === selected ? 'sel' : ''}" data-tone="${t}" onclick="${onPick}('${t}')"
       title="${TONE_NAMES[t]}" aria-label="${TONE_NAMES[t]}"></button>`).join('');
}
/* a sub-section starts out in its parent's colour */
function inheritedTone(parentId){
  const p = parentId ? bubbleById(parentId) : null;
  return p ? (p.tone || 'teal') : TONES[state.bubbles.length % TONES.length];
}
function openNewBubbleModal(parentId){
  toneTouched = false;
  pickedTone = inheritedTone(parentId);
  pickedTint = parentId ? tintOf(bubbleById(parentId)) : TINT_DEFAULT;
  const options = sortedBubbles()
    .map(b => `<option value="${b.id}" ${b.id === parentId ? 'selected' : ''}>${esc(b.name)}</option>`)
    .join('');
  pickedSize = DEPTH_R[Math.min(parentId ? depthOf(parentId) + 1 : 0, DEPTH_R.length - 1)];
  openModal('New section', `
    <div class="field"><label>Name</label><input class="input" id="nb-name" placeholder="School, Work, Finance, Gym…"></div>
    <div class="field"><label>Branches off</label>
      <select class="select" id="nb-parent" onchange="parentChanged()">
        <option value="">Cosmo (the middle)</option>
        ${options}
      </select>
    </div>
    <div class="field"><label>Colour</label>
      <div class="tone-picker" id="tone-picker">
        ${toneSwatches(pickedTone, 'pickTone')}
      </div>
      ${tintSlider(pickedTint, 'pickedTint = +this.value; previewTint();')}
      <div class="tint-preview tone-${pickedTone}" id="tint-preview" style="--tint:${pickedTint}">Preview</div>
    </div>
    <div class="field"><label>Size <span class="mono" id="nb-size-out" style="color:var(--text-muted)">${pickedSize}</span></label>
      <input class="ink-size" style="width:100%" id="nb-size" type="range" min="${R_MIN}" max="${R_MAX}" value="${pickedSize}"
             oninput="this.dataset.touched='1'; pickedSize = +this.value; document.getElementById('nb-size-out').textContent = this.value;">
    </div>
    <button class="btn btn-primary" onclick="submitNewBubble()">Create section</button>
    <p style="margin:0; font-size:0.78rem; color:var(--text-muted);">You can also drop one bubble on another later to connect them, or shake one hard to break it loose.</p>
  `);
  setTimeout(()=>{ const el = document.getElementById('nb-name'); if(el) el.focus(); }, 40);
}
/* pick a different parent and the suggested size follows the depth, unless you
   have already moved the slider yourself */
function parentChanged(){
  const sel = document.getElementById('nb-parent');
  if(sel && !toneTouched) selectTone(inheritedTone(sel.value || null));   // follow the new parent's colour
  const slider = document.getElementById('nb-size');
  if(!sel || !slider || slider.dataset.touched) return;
  const want = DEPTH_R[Math.min(sel.value ? depthOf(sel.value) + 1 : 0, DEPTH_R.length - 1)];
  pickedSize = want;
  slider.value = want;
  const out = document.getElementById('nb-size-out');
  if(out) out.textContent = want;
}
function selectTone(t){
  pickedTone = t;
  document.querySelectorAll('#tone-picker .tone-swatch').forEach(s => s.classList.toggle('sel', s.dataset.tone === t));
  previewTint();
}
/* the little preview bubble in the form, and hiding the slider for "no colour" */
function previewTint(){
  const pv = document.getElementById('tint-preview');
  if(pv){ pv.className = 'tint-preview tone-' + pickedTone; pv.style.setProperty('--tint', pickedTint); }
  const row = document.getElementById('tint-row');
  if(row) row.classList.toggle('off', pickedTone === 'none');
}
function pickTone(t){ toneTouched = true; selectTone(t); }

/* Colour-code a section any time: click the dot next to its name, or
   right-click its bubble on the map. Undo puts the old colour back. */
let toneTarget = null;
function openTonePicker(id){
  const b = bubbleById(id);
  if(!b) return;
  toneTarget = id;
  openModal('Colour for ' + b.name, `
    <div class="tone-picker tone-picker-lg" id="tone-picker">${toneSwatches(b.tone || 'teal', 'setSectionTone')}</div>
    <div class="field"><label>How much colour</label>
      ${tintSlider(tintOf(b), 'liveTint(+this.value)', 'saveTint(+this.value)')}
    </div>
    <button class="btn btn-primary" onclick="closeModal()">Done</button>`);
  const row = document.getElementById('tint-row');
  if(row) row.classList.toggle('off', (b.tone || 'teal') === 'none');
  tintAtOpen = tintOf(b);
}
async function setSectionTone(t){
  const b = bubbleById(toneTarget);
  if(!b) return;
  const before = b.tone || 'teal';
  document.querySelectorAll('#tone-picker .tone-swatch').forEach(s => s.classList.toggle('sel', s.dataset.tone === t));
  const row = document.getElementById('tint-row');
  if(row) row.classList.toggle('off', t === 'none');
  if(t === before) return;
  const write = v => cols.bubbles.update(b.id, { tone: v }).catch(() => {});
  await write(t);
  record('colouring "' + b.name + '" ' + TONE_NAMES[t].toLowerCase(), () => write(before), () => write(t));
}
/* dragging the slider repaints the bubble as you go;
   letting go saves it, and undo puts the strength back to where it started */
let tintAtOpen = TINT_DEFAULT;
function liveTint(v){
  const el = bubbleEls.get(toneTarget);
  if(el) el.style.setProperty('--tint', String(v));
}
async function saveTint(v){
  const b = bubbleById(toneTarget);
  if(!b) return;
  const before = tintAtOpen;
  if(v === before) return;
  const write = x => cols.bubbles.update(b.id, { tint: x }).catch(() => {});
  await write(v);
  tintAtOpen = v;
  record('changing how much colour "' + b.name + '" has', () => write(before), () => write(v));
}
async function submitNewBubble(){
  const name = (document.getElementById('nb-name').value || '').trim();
  if(!name) return;
  const sel = document.getElementById('nb-parent');
  const parentId = (sel && sel.value) || null;
  const slider = document.getElementById('nb-size');
  const size = slider ? clamp(+slider.value, R_MIN, R_MAX) : R_SEC;
  const auto = DEPTH_R[Math.min(parentId ? depthOf(parentId) + 1 : 0, DEPTH_R.length - 1)];
  const doc = { name, tone: pickedTone, tint: pickedTint, widgets: [], createdAt: Date.now() };
  if(parentId) doc.parentId = parentId;
  // only pin a size if he actually chose one; otherwise let it follow its depth
  if(size !== auto) doc.size = size;
  const {id} = await cols.bubbles.add(doc);
  closeModal();
  openSection(id);
}
async function deleteCurrentBubble(){
  const b = bubbleById(activeBubbleId);
  if(!b) return;
  const n = (b.widgets || []).length;
  if(!await askConfirm('Move this section to the trash?',
      '"' + b.name + '"' + (n ? ' and its ' + n + ' panel' + (n===1?'':'s') + ' will go to the trash.'
                               : ' will go to the trash.') +
      ' You can restore it afterwards.', 'Move to trash', true)) return;
  const id = b.id, name = b.name;
  await trashBubble(b);
  goHub();
  record('deleting the "' + name + '" section',
    () => restoreBubble(id),
    () => { const cur = bubbleById(id); if(cur) return trashBubble(cur); });
  toast('Moved "' + name + '" to the trash', () => { doUndo(); });
}
async function trashBubble(b){
  const copy = Object.assign({}, b);
  delete copy.id;
  copy.deletedAt = Date.now();
  // its branch would otherwise point at a section that no longer exists, so
  // hand the children up to their grandparent before it goes
  const kids = childrenOf(b.id);
  copy.hadChildren = kids.map(k => k.id);
  for(const kid of kids){
    await cols.bubbles.update(kid.id, { parentId: b.parentId || null }).catch(() => {});
  }
  await cols.trash.set(b.id, copy);       // keep the original id so its to-dos reconnect
  await cols.bubbles.delete(b.id);
}
async function restoreBubble(id){
  const t = state.trash.find(x => x.id === id) || await cols.trash.getOne(id);
  if(!t) return;
  // put its branch back on it, for any child that still exists
  for(const kidId of (t.hadChildren || [])){
    if(bubbleById(kidId)) await cols.bubbles.update(kidId, { parentId: id }).catch(() => {});
  }
  const data = Object.assign({}, t);
  delete data.id; delete data.deletedAt;
  await cols.bubbles.set(id, data);
  await cols.trash.delete(id);
  renderTrash();
  toast('Restored "' + (data.name || 'section') + '"');
}
function openTrash(){ openSheet('trash-sheet'); renderTrash(); }
function renderTrash(){
  const list = state.trash.slice().sort((a,b) => (b.deletedAt||0) - (a.deletedAt||0));
  const btn = document.getElementById('trash-btn');
  if(btn){
    btn.hidden = list.length === 0;
    const cnt = document.getElementById('trash-count');
    if(cnt) cnt.textContent = list.length;
  }
  const body = document.getElementById('trash-body');
  if(!body) return;
  body.innerHTML = list.length ? list.map(t => {
    const n = (t.widgets || []).length;
    return `<div class="task-row">
      <div class="task-main">
        <div class="task-text">${esc(t.name || 'Untitled section')}</div>
        <div class="task-meta">
          <span class="chip">${n ? n + (n===1?' panel':' panels') : 'empty'}</span>
          <span class="due">deleted ${fmtWhen(t.deletedAt)}</span>
        </div>
      </div>
      <button class="btn btn-sm" onclick="restoreBubble('${t.id}')">Restore</button>
      <button class="icon-btn" title="Delete for good" onclick="purgeBubble('${t.id}')">✕</button>
    </div>`;
  }).join('') : '<div class="empty">Nothing in the trash.</div>';
}
function fmtWhen(ts){
  if(!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + 'm ago';
  if(mins < 1440) return Math.floor(mins/60) + 'h ago';
  return Math.floor(mins/1440) + 'd ago';
}
async function purgeBubble(id){
  const t = state.trash.find(x => x.id === id);
  if(!await askConfirm('Delete for good?',
      '"' + ((t && t.name) || 'this section') + '" will be gone permanently. This cannot be undone.',
      'Delete for good', true)) return;
  cols.trash.delete(id).then(renderTrash);
}
let toastTimer = null;
function toast(text, undo){
  const el = document.getElementById('toast');
  if(!el) return;
  el.innerHTML = `<span>${esc(text)}</span>` + (undo ? `<button class="btn btn-sm" id="toast-undo">Undo</button>` : '');
  el.classList.add('show');
  if(undo){
    const b = document.getElementById('toast-undo');
    if(b) b.onclick = () => { el.classList.remove('show'); undo(); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 9000 : 4000);
}
function renameSection(value){
  const b = bubbleById(activeBubbleId); if(!b) return;
  const name = (value||'').trim(); if(!name || name === b.name) return;
  cols.bubbles.update(b.id, { name });
}

/* ============ WIDGETS ============ */
const WIDGET_KINDS = {
  checklist: { label:'Checklist', blank: () => ({ items: [] }) },
  notes:     { label:'Notes',     blank: () => ({ text: '' }) },
  metric:    { label:'Number',    blank: () => ({ value: '', label: '', target: null, unit: '' }) },
  table:     { label:'Table',     blank: () => ({ columns: ['Item','Value'], rows: [] }) },
  dates:     { label:'Dates',     blank: () => ({ items: [] }) },
  progress:  { label:'Progress',  blank: () => ({ items: [] }) },
  habit:     { label:'Habits',    blank: () => ({ items: [] }) },
  links:     { label:'Links',     blank: () => ({ items: [] }) },
  sticky:    { label:'Sticky notes', blank: () => ({ items: [] }) },
  jobs:      { label:'Job applications', blank: () => ({ resume:'', resumeFile:'', rows: [] }) },
};
function normalizeWidget(w){
  const type = WIDGET_KINDS[w.type] ? w.type : 'checklist';
  const base = WIDGET_KINDS[type].blank();
  return {
    id: w.id || uid(),
    type,
    title: w.title || WIDGET_KINDS[type].label,
    size: ['sm','md','lg'].includes(w.size) ? w.size : 'sm',
    data: Object.assign(base, thaw(w.data) || {}),
  };
}
function getWidgets(b){ return (b && b.widgets ? b.widgets : []).map(normalizeWidget); }
function saveWidgets(bubbleId, widgets){ return cols.bubbles.update(bubbleId, { widgets }); }
function withWidget(bubbleId, widgetId, fn){
  const b = bubbleById(bubbleId); if(!b) return Promise.resolve();
  const widgets = getWidgets(b);
  const w = widgets.find(x => x.id === widgetId); if(!w) return Promise.resolve();
  fn(w);
  return saveWidgets(bubbleId, widgets);
}

/* Every snapshot rebuilds the whole panel grid from innerHTML, and a fresh
   element has none of what the browser was quietly holding for you: the height
   you dragged a notes box to, where the caret was, or anything typed since the
   last save. Tabbing away mid-sentence fires `change` — which saves, which
   re-renders — so the moment you are most likely to notice is the exact moment
   that causes it. Carry that state across the rebuild by hand. */
function findByWid(grid, wid, tag){
  return Array.prototype.find.call(grid.querySelectorAll('[data-wid]'),
    el => el.dataset.wid === wid && (!tag || el.tagName === tag)) || null;
}
function captureGridState(grid){
  const saved = { heights: [], focus: null };
  grid.querySelectorAll('[data-wid]').forEach(el => {
    if(el.style && el.style.height) saved.heights.push([el.dataset.wid, el.tagName, el.style.height]);
  });
  const a = document.activeElement;
  if(a && a.dataset && a.dataset.wid && grid.contains(a)){
    saved.focus = { wid:a.dataset.wid, tag:a.tagName, value:a.value,
                    start:a.selectionStart, end:a.selectionEnd, scroll:a.scrollTop };
  }
  return saved;
}
function restoreGridState(grid, saved){
  saved.heights.forEach(([wid, tag, h]) => {
    const el = findByWid(grid, wid, tag);
    if(el) el.style.height = h;
  });
  const f = saved.focus;
  if(!f) return;
  const el = findByWid(grid, f.wid, f.tag);
  if(!el) return;
  if(el.value !== f.value) el.value = f.value;       // keep whatever he had typed
  try{
    el.focus({ preventScroll:true });
    if(f.start != null && el.setSelectionRange) el.setSelectionRange(f.start, f.end);
  }catch(e){}
  el.scrollTop = f.scroll;
}

/* A manual resize only ever happens by dragging, so bracket the drag: note the
   height on the way down, and if it changed by the time the button comes up,
   that was deliberate — write it down. No observers, so no save/render loop. */
let noteResizeFrom = null;
function watchNoteResize(){
  document.addEventListener('pointerdown', e => {
    const t = e.target;
    if(t && t.tagName === 'TEXTAREA' && t.dataset && t.dataset.wid && !/^add:/.test(t.dataset.wid)){
      noteResizeFrom = { el: t, h: t.offsetHeight, wid: t.dataset.wid };
    }
  }, true);
  document.addEventListener('pointerup', () => {
    const from = noteResizeFrom;
    noteResizeFrom = null;
    if(!from || !from.el.isConnected) return;
    const now = from.el.offsetHeight;
    if(Math.abs(now - from.h) < 5) return;           // a click, not a drag
    withWidget(activeBubbleId, from.wid, w => { w.data.h = Math.round(now); });
  }, true);
}

function renderSection(){
  const b = bubbleById(activeBubbleId);
  const grid = document.getElementById('widget-grid');
  if(!b){ grid.innerHTML = '<div class="empty">This section no longer exists.</div>'; return; }
  const titleEl = document.getElementById('sec-title');
  if(document.activeElement !== titleEl) titleEl.value = b.name;
  document.getElementById('sec-title-wrap').className = 'sec-title-wrap tone-' + (b.tone || 'teal');

  const widgets = getWidgets(b);
  const secTasks = state.tasks.filter(t => t.bubbleId === b.id);
  let html = '';

  if(secTasks.length){
    const open = secTasks.filter(t => !t.done);
    html += widgetShell({ id:'__tasks', title:'To-dos in this section', size:'sm', type:'tasks' },
      (open.length ? open.slice(0,8).map(t => `
        <div class="check-row">
          <input type="checkbox" onchange="toggleTask('${t.id}')">
          <span>${esc(t.text)}</span>
          ${t.due ? `<span class="due ${daysUntil(t.due)<0?'over':(daysUntil(t.due)===0?'today':'')}">${whenLabel(t.due)}</span>` : ''}
        </div>`).join('') : '<div class="w-empty">All done here.</div>'), true);
  }

  html += widgets.map(w => renderWidget(b, w)).join('');
  html += `<button class="add-widget" onclick="openAddWidget()">+ Add panel</button>`;
  const carried = captureGridState(grid);
  grid.innerHTML = html;
  restoreGridState(grid, carried);

  if(!widgets.length && !secTasks.length){
    grid.insertAdjacentHTML('afterbegin', `<div class="widget size-md"><div class="w-body">
      <div style="font-weight:650; font-size:0.92rem;">Nothing here yet</div>
      <div style="font-size:0.85rem; color:var(--text-muted); line-height:1.55;">Add a panel yourself, or open Cosmo and say what this section is for — it will build the panels for you.</div>
      <button class="btn btn-primary btn-sm" style="align-self:flex-start;" onclick="openHelperForDesign()">Ask Cosmo</button>
    </div></div>`);
  }
}
function widgetShell(w, body, plain){
  return `<div class="widget size-${w.size}">
    <div class="w-head">
      <div style="min-width:0;">
        <div class="w-title">${esc(w.title)}</div>
        <div class="w-kind">${plain ? 'tasks' : (WIDGET_KINDS[w.type] ? WIDGET_KINDS[w.type].label : w.type)}</div>
      </div>
      ${plain ? '' : `<div class="row">
        <button class="icon-btn" title="Resize" onclick="cycleSize('${w.id}')">⤢</button>
        <button class="icon-btn" title="Rename" onclick="renameWidget('${w.id}')">✎</button>
        <button class="icon-btn" title="Remove" onclick="removeWidget('${w.id}')">✕</button>
      </div>`}
    </div>
    <div class="w-body">${body}</div>
  </div>`;
}
function renderWidget(b, w){
  const d = w.data;
  let body = '';
  if(w.type === 'checklist'){
    body = (d.items || []).length ? (d.items || []).map(it => `
      <div class="check-row ${it.done?'done':''}">
        <input type="checkbox" ${it.done?'checked':''} onchange="toggleItem('${w.id}','${it.id}')">
        <span>${esc(it.text)}</span>
        <button class="icon-btn" onclick="removeItem('${w.id}','${it.id}')">✕</button>
      </div>`).join('') : '<div class="w-empty">Nothing yet.</div>';
    body += inlineAdd(w.id, 'Add an item…');
  } else if(w.type === 'notes'){
    const h = (typeof d.h === 'number' && d.h > 40) ? ('height:' + Math.round(d.h) + 'px;') : '';
    body = `<textarea class="textarea" data-wid="${w.id}" style="min-height:96px;${h}" placeholder="Write anything…"
      onchange="setNotes('${w.id}', this.value)">${esc(d.text || '')}</textarea>`;
  } else if(w.type === 'jobs'){
    body = jobsPanel(w);
  } else if(w.type === 'metric'){
    const val = (d.value === '' || d.value == null) ? '—' : d.value;
    const num = parseFloat(d.value), tgt = parseFloat(d.target);
    const pct = (isFinite(num) && isFinite(tgt) && tgt > 0) ? clamp(Math.round(num/tgt*100),0,100) : null;
    body = `<div>
        <span class="metric-value">${esc(String(val))}</span>
        ${d.unit ? `<span style="font-size:0.9rem; color:var(--text-muted); margin-left:4px;">${esc(d.unit)}</span>` : ''}
      </div>
      ${pct !== null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      <div class="metric-sub">${esc(d.label || '')}${(d.target!=null && d.target!=='') ? (d.label?' · ':'') + 'target ' + esc(String(d.target)) : ''}</div>
      <button class="btn btn-sm" style="align-self:flex-start;" onclick="editMetric('${w.id}')">Update</button>`;
  } else if(w.type === 'table'){
    const colsArr = d.columns && d.columns.length ? d.columns : ['Item','Value'];
    body = `<div class="tbl-scroll"><table class="w-table">
      <thead><tr>${colsArr.map(c=>`<th>${esc(c)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${(d.rows||[]).map((r,ri)=>`<tr>${colsArr.map((c,ci)=>`<td>${esc(r[ci] != null ? r[ci] : '')}</td>`).join('')}
        <td style="text-align:right;"><button class="icon-btn" onclick="removeRow('${w.id}',${ri})">✕</button></td></tr>`).join('')}</tbody>
    </table></div>
    ${(d.rows||[]).length ? '' : '<div class="w-empty">No rows yet.</div>'}
    <button class="btn btn-sm" style="align-self:flex-start;" onclick="addRow('${w.id}')">+ Row</button>`;
  } else if(w.type === 'dates'){
    const items = (d.items || []).slice().sort((a,b2) => String(a.date).localeCompare(String(b2.date)));
    body = items.length ? items.map(it => {
      const dd = daysUntil(it.date);
      return `<div class="date-row">
        <span style="font-size:0.85rem; min-width:0;">${esc(it.label)}</span>
        <span class="row" style="gap:6px;">
          <span class="date-when ${dd<0?'past':(dd<=3?'soon':'')}">${whenLabel(it.date)}</span>
          <button class="icon-btn" onclick="removeItem('${w.id}','${it.id}')">✕</button>
        </span>
      </div>`;
    }).join('') : '<div class="w-empty">No dates yet.</div>';
    body += `<button class="btn btn-sm" style="align-self:flex-start;" onclick="addDate('${w.id}')">+ Date</button>`;
  } else if(w.type === 'progress'){
    body = (d.items||[]).length ? (d.items||[]).map(it => `
      <div class="prog-row">
        <div class="prog-top"><span>${esc(it.label)}</span>
          <span class="row" style="gap:5px;">
            <span class="prog-pct">${clamp(Math.round(it.pct||0),0,100)}%</span>
            <button class="icon-btn" onclick="bumpProgress('${w.id}','${it.id}',-10)">−</button>
            <button class="icon-btn" onclick="bumpProgress('${w.id}','${it.id}',10)">+</button>
            <button class="icon-btn" onclick="removeItem('${w.id}','${it.id}')">✕</button>
          </span>
        </div>
        <div class="bar"><i style="width:${clamp(Math.round(it.pct||0),0,100)}%"></i></div>
      </div>`).join('') : '<div class="w-empty">Nothing tracked yet.</div>';
    body += inlineAdd(w.id, 'Add something to track…');
  } else if(w.type === 'habit'){
    const days = last7();
    body = (d.items||[]).length ? (d.items||[]).map(it => `
      <div class="habit-row">
        <span style="font-size:0.85rem; font-weight:600;">${esc(it.name)}</span>
        <span class="streak">${streakOf(it)}d</span>
        <span class="habit-days">${days.map(ds => `<button class="habit-day ${(it.completions||{})[ds]?'done':''}"
          onclick="toggleHabit('${w.id}','${it.id}','${ds}')">${parseDateStr(ds).getDate()}</button>`).join('')}</span>
        <button class="icon-btn" onclick="removeItem('${w.id}','${it.id}')">✕</button>
      </div>`).join('') : '<div class="w-empty">No habits yet.</div>';
    body += inlineAdd(w.id, 'Add a habit…');
  } else if(w.type === 'sticky'){
    const items = d.items || [];
    body = `<div class="sticky-wrap">` + items.map(it => `
      <div class="sticky" style="background:${STICKY_TONES[it.tone] || STICKY_TONES.yellow};">
        <button class="s-kill" onclick="removeItem('${w.id}','${it.id}')" aria-label="Remove note">✕</button>
        <span class="s-text" contenteditable="true" role="textbox" aria-label="Sticky note"
          onblur="setSticky('${w.id}','${it.id}', this.innerText)">${esc(it.text || '')}</span>
        <span class="s-tone">${Object.keys(STICKY_TONES).map(t =>
          `<i style="background:${STICKY_TONES[t]}" title="${t}" onclick="stickyTone('${w.id}','${it.id}','${t}')"></i>`).join('')}</span>
      </div>`).join('') +
      `<button class="sticky-add" onclick="addSticky('${w.id}')">+ Note</button></div>`;
  } else if(w.type === 'links'){
    body = (d.items||[]).length ? (d.items||[]).map(it => `
      <div class="date-row link-row">
        <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.label || it.url)}</a>
        <button class="icon-btn" onclick="removeItem('${w.id}','${it.id}')">✕</button>
      </div>`).join('') : '<div class="w-empty">No links yet.</div>';
    body += `<button class="btn btn-sm" style="align-self:flex-start;" onclick="addLink('${w.id}')">+ Link</button>`;
  }
  return widgetShell(w, body);
}
function inlineAdd(wid, placeholder){
  return `<input class="input" data-wid="add:${wid}" placeholder="${esc(placeholder)}" onkeydown="if(event.key==='Enter'){ addItem('${wid}', this.value); this.value=''; }">`;
}
function last7(){ const a=[]; for(let i=6;i>=0;i--){ const d=new Date(); d.setDate(d.getDate()-i); a.push(toDateStr(d)); } return a; }
function streakOf(it){
  const c = it.completions || {}; let n = 0; const d = new Date();
  if(!c[toDateStr(d)]) d.setDate(d.getDate()-1);
  while(c[toDateStr(d)]){ n++; d.setDate(d.getDate()-1); }
  return n;
}

/* widget mutations */
const STICKY_TONES = { yellow:'#FCE68A', pink:'#F8C0CF', blue:'#AFD7F5', green:'#BCE5B4', orange:'#FBC98C', purple:'#D6C6F2' };
function addSticky(wid){
  const tones = Object.keys(STICKY_TONES);
  withWidget(activeBubbleId, wid, w => {
    const n = (w.data.items || []).length;
    w.data.items = (w.data.items || []).concat([{ id: uid(), text: '', tone: tones[n % tones.length] }]);
  });
}
function setSticky(wid, iid, text){
  const b = bubbleById(activeBubbleId); if(!b) return;
  const w = getWidgets(b).find(x => x.id === wid); if(!w) return;
  const it = (w.data.items || []).find(i => i.id === iid);
  if(it && String(it.text || '') === String(text || '').trim()) return;   // nothing changed
  withWidget(activeBubbleId, wid, x => {
    (x.data.items || []).forEach(i => { if(i.id === iid) i.text = String(text || '').trim(); });
  });
}
function stickyTone(wid, iid, tone){
  withWidget(activeBubbleId, wid, w => {
    (w.data.items || []).forEach(i => { if(i.id === iid) i.tone = tone; });
  });
}
function addItem(wid, raw){
  const text = (raw||'').trim(); if(!text) return;
  withWidget(activeBubbleId, wid, w => {
    if(w.type === 'habit') w.data.items.push({ id: uid(), name: text, completions: {} });
    else if(w.type === 'progress') w.data.items.push({ id: uid(), label: text, pct: 0 });
    else w.data.items.push({ id: uid(), text, done: false });
  });
}
function removeItem(wid, iid){
  const b = bubbleById(activeBubbleId);
  const w = b && getWidgets(b).find(x => x.id === wid);
  const it = w && (w.data.items || []).find(i => i.id === iid);
  const what = it ? (it.text || it.label || it.name || 'an item') : 'an item';
  withUndo(activeBubbleId, 'deleting "' + String(what).slice(0, 28) + '"', ws => {
    const t = ws.find(x => x.id === wid);
    if(t) t.data.items = (t.data.items || []).filter(i => i.id !== iid);
  });
}
function toggleItem(wid, iid){ withWidget(activeBubbleId, wid, w => { (w.data.items||[]).forEach(i => { if(i.id===iid) i.done = !i.done; }); }); }
function setNotes(wid, text){ withWidget(activeBubbleId, wid, w => { w.data.text = text; }); }
function bumpProgress(wid, iid, delta){ withWidget(activeBubbleId, wid, w => {
  (w.data.items||[]).forEach(i => { if(i.id===iid) i.pct = clamp(Math.round((i.pct||0)+delta),0,100); }); }); }
function toggleHabit(wid, iid, ds){ withWidget(activeBubbleId, wid, w => {
  (w.data.items||[]).forEach(i => { if(i.id===iid){ i.completions = i.completions||{}; if(i.completions[ds]) delete i.completions[ds]; else i.completions[ds] = true; } }); }); }
function removeRow(wid, ri){
  withUndo(activeBubbleId, 'deleting a table row', ws => {
    const t = ws.find(x => x.id === wid);
    if(t) t.data.rows = (t.data.rows || []).filter((_, i) => i !== ri);
  });
}
function cycleSize(wid){ withWidget(activeBubbleId, wid, w => { w.size = w.size==='sm'?'md':(w.size==='md'?'lg':'sm'); }); }
async function removeWidget(wid){
  const b = bubbleById(activeBubbleId); if(!b) return;
  const w = getWidgets(b).find(x => x.id === wid);
  const name = (w && w.title) || 'panel';
  if(!await askConfirm('Remove this panel?', 'The "' + name + '" panel and everything in it will go. You can undo this.', 'Remove', true)) return;
  withUndo(b.id, 'deleting the "' + name + '" panel',
    ws => { const i = ws.findIndex(x => x.id === wid); if(i >= 0) ws.splice(i, 1); });
}
async function renameWidget(wid){
  const b = bubbleById(activeBubbleId); if(!b) return;
  const w = getWidgets(b).find(x => x.id === wid); if(!w) return;
  const name = await askText('Rename panel', 'Panel name', w.title, 'Rename');
  if(name && name.trim()) withWidget(b.id, wid, x => { x.title = name.trim(); });
}
function addRow(wid){
  const b = bubbleById(activeBubbleId); const w = getWidgets(b).find(x => x.id === wid); if(!w) return;
  const colsArr = w.data.columns && w.data.columns.length ? w.data.columns : ['Item','Value'];
  openModal('Add row', `
    ${colsArr.map((c,i) => `<div class="field"><label>${esc(c)}</label><input class="input" id="row-f-${i}"></div>`).join('')}
    <button class="btn btn-primary" onclick="submitRow('${wid}', ${colsArr.length})">Add row</button>`);
}
function submitRow(wid, n){
  const vals = []; for(let i=0;i<n;i++){ const el = document.getElementById('row-f-'+i); vals.push(el ? el.value.trim() : ''); }
  if(vals.every(v => !v)) return;
  withWidget(activeBubbleId, wid, w => { w.data.rows = (w.data.rows||[]).concat([vals]); });
  closeModal();
}
function addDate(wid){
  openModal('Add a date', `
    <div class="field"><label>What</label><input class="input" id="dt-label" placeholder="Midterm, rent due…"></div>
    <div class="field"><label>When</label><input class="input" type="date" id="dt-date" value="${todayStr()}"></div>
    <button class="btn btn-primary" onclick="submitDate('${wid}')">Add date</button>`);
}
function submitDate(wid){
  const label = (document.getElementById('dt-label').value||'').trim();
  const date = document.getElementById('dt-date').value;
  if(!label || !date) return;
  withWidget(activeBubbleId, wid, w => { w.data.items = (w.data.items||[]).concat([{ id: uid(), label, date }]); });
  closeModal();
}
function addLink(wid){
  openModal('Add a link', `
    <div class="field"><label>Label</label><input class="input" id="lk-label" placeholder="Canvas, Degree Navigator…"></div>
    <div class="field"><label>URL</label><input class="input" id="lk-url" placeholder="https://…"></div>
    <button class="btn btn-primary" onclick="submitLink('${wid}')">Add link</button>`);
}
function submitLink(wid){
  const label = (document.getElementById('lk-label').value||'').trim();
  let url = (document.getElementById('lk-url').value||'').trim();
  if(!url) return;
  if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
  withWidget(activeBubbleId, wid, w => { w.data.items = (w.data.items||[]).concat([{ id: uid(), label: label || url, url }]); });
  closeModal();
}
function editMetric(wid){
  const b = bubbleById(activeBubbleId); const w = getWidgets(b).find(x => x.id === wid); if(!w) return;
  openModal('Update ' + w.title, `
    <div class="field"><label>Value</label><input class="input" id="mt-value" value="${esc(String(w.data.value==null?'':w.data.value))}"></div>
    <div class="field"><label>Unit (optional)</label><input class="input" id="mt-unit" value="${esc(w.data.unit||'')}" placeholder="hrs, $, %"></div>
    <div class="field"><label>Target (optional)</label><input class="input" id="mt-target" value="${esc(String(w.data.target==null?'':w.data.target))}"></div>
    <div class="field"><label>Caption</label><input class="input" id="mt-label" value="${esc(w.data.label||'')}" placeholder="Cumulative GPA"></div>
    <button class="btn btn-primary" onclick="submitMetric('${wid}')">Save</button>`);
}
function submitMetric(wid){
  const value = document.getElementById('mt-value').value.trim();
  const unit = document.getElementById('mt-unit').value.trim();
  const targetRaw = document.getElementById('mt-target').value.trim();
  const label = document.getElementById('mt-label').value.trim();
  withWidget(activeBubbleId, wid, w => { w.data.value = value; w.data.unit = unit; w.data.target = targetRaw === '' ? null : targetRaw; w.data.label = label; });
  closeModal();
}
function openAddWidget(){
  openModal('Add a panel', `
    <div class="field"><label>Panel name</label><input class="input" id="aw-title" placeholder="Grades, Deadlines, GPA…"></div>
    <div class="field"><label>Type</label>
      <select class="select" id="aw-type">${Object.entries(WIDGET_KINDS).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
    </div>
    <button class="btn btn-primary" onclick="submitAddWidget()">Add panel</button>
    <p style="margin:0; font-size:0.78rem; color:var(--text-muted);">Not sure? Ask Cosmo to lay the whole section out instead.</p>`);
}
function submitAddWidget(){
  const b = bubbleById(activeBubbleId); if(!b) return;
  const type = document.getElementById('aw-type').value;
  const title = (document.getElementById('aw-title').value||'').trim() || WIDGET_KINDS[type].label;
  const size = (type === 'jobs') ? 'lg' : (type === 'sticky' || type === 'table') ? 'md' : 'sm';
  saveWidgets(b.id, getWidgets(b).concat([ normalizeWidget({ type, title, size }) ]));
  closeModal();
}

/* ============ TASKS (center bubble) ============ */
function openTasksSheet(){
  openSheet('tasks-sheet');
  renderTasks();
}
function renderTasks(){
  const body = document.getElementById('tasks-body');
  const sel = document.getElementById('new-task-section');
  if(sel && document.activeElement !== sel){
    sel.innerHTML = '<option value="">No section</option>' + sortedBubbles().map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    if(view === 'section' && activeBubbleId) sel.value = activeBubbleId;
  }
  const all = state.tasks.slice().sort((a,b) => String(a.due||'9999').localeCompare(String(b.due||'9999')) || (a.createdAt||0)-(b.createdAt||0));
  const open = all.filter(t => !t.done), done = all.filter(t => t.done).slice(-6).reverse();
  const groups = [
    ['Overdue', open.filter(t => t.due && daysUntil(t.due) < 0)],
    ['Today', open.filter(t => t.due && daysUntil(t.due) === 0)],
    ['Upcoming', open.filter(t => t.due && daysUntil(t.due) > 0)],
    ['No date', open.filter(t => !t.due)],
  ];
  document.getElementById('tasks-sub').textContent = open.length + (open.length === 1 ? ' open item' : ' open items');
  let html = '';
  groups.forEach(([label, list]) => {
    if(!list.length) return;
    html += `<div class="group-label">${label}</div>` + list.map(taskRow).join('');
  });
  if(!open.length) html += '<div class="empty">Nothing on your plate. Enjoy it.</div>';
  if(done.length) html += `<div class="group-label">Recently done</div>` + done.map(taskRow).join('');
  body.innerHTML = html;
}
function taskRow(t){
  const b = t.bubbleId ? bubbleById(t.bubbleId) : null;
  const dd = t.due ? daysUntil(t.due) : null;
  return `<div class="task-row ${t.done?'done':''}">
    <input type="checkbox" ${t.done?'checked':''} onchange="toggleTask('${t.id}')">
    <div class="task-main">
      <div class="task-text">${esc(t.text)}</div>
      <div class="task-meta">
        ${b ? `<span class="chip">${esc(b.name)}</span>` : ''}
        ${t.due ? `<span class="due ${dd<0?'over':(dd===0?'today':'')}">${whenLabel(t.due)}</span>` : ''}
      </div>
    </div>
    <button class="icon-btn" onclick="deleteTask('${t.id}')">✕</button>
  </div>`;
}
function submitTask(){
  const el = document.getElementById('new-task-text');
  const text = (el.value||'').trim(); if(!text) return;
  const due = document.getElementById('new-task-due').value || '';
  const bubbleId = document.getElementById('new-task-section').value || '';
  cols.tasks.add({ text, due, bubbleId, done:false, createdAt: Date.now() });
  el.value = ''; document.getElementById('new-task-due').value = '';
}
function toggleTask(id){
  const t = state.tasks.find(x => x.id === id); if(!t) return;
  cols.tasks.update(id, { done: !t.done });
}
function deleteTask(id){
  const t = state.tasks.find(x => x.id === id);
  cols.tasks.delete(id).then(() => {
    if(!t) return;
    const data = Object.assign({}, t); delete data.id;
    record('deleting the to-do "' + String(t.text || '').slice(0, 28) + '"',
      () => cols.tasks.set(id, data).then(renderTasks),
      () => cols.tasks.delete(id).then(renderTasks));
  });
}
function deleteImportant(id){
  const it = state.important.find(x => x.id === id);
  cols.important.delete(id).then(() => {
    if(!it) return;
    const data = Object.assign({}, it); delete data.id;
    record('deleting a pinned note',
      () => cols.important.set(id, data).then(renderImportant),
      () => cols.important.delete(id).then(renderImportant));
  });
}

/* ============ IMPORTANT ============ */
function openImportant(){ openSheet('imp-sheet'); renderImportant(); }
function renderImportant(){
  const body = document.getElementById('imp-body');
  const list = state.important.slice().sort((a,b) => (b.createdAt||0)-(a.createdAt||0));
  const soon = comingUp();
  const pinned = list.length ? list.map(i => `
    <div class="task-row">
      <div class="task-main"><div class="task-text">${esc(i.text)}</div></div>
      <button class="icon-btn" onclick="deleteImportant('${i.id}')">✕</button>
    </div>`).join('') : '<div class="empty">Nothing pinned yet. Put the things you always forget here.</div>';
  body.innerHTML = (soon.length ? '<div class="group-label">Coming up</div>' + soon.map(taskRow).join('') +
    '<div class="group-label">Pinned</div>' : '') + pinned;
  const badge = document.getElementById('imp-count');
  badge.textContent = list.length; badge.hidden = list.length === 0;
  const btn = document.getElementById('imp-btn');
  btn.classList.toggle('alerting', soon.length > 0);
  btn.title = soon.length ? 'Important info: ' + soon.length + ' coming up' : 'Important info';
}
function submitImportant(){
  const el = document.getElementById('new-imp');
  const text = (el.value||'').trim(); if(!text) return;
  cols.important.add({ text, createdAt: Date.now() });
  el.value = '';
}

/* ============ sheets + modal ============ */
function openSheet(id){ document.getElementById(id).classList.add('open'); }
function closeSheet(id){ document.getElementById(id).classList.remove('open'); }
function openModal(title, bodyHtml, wide){
  document.getElementById('modal-card').style.maxWidth = wide ? '760px' : '';
  document.getElementById('modal-card').innerHTML =
    `<div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" onclick="closeModal()" aria-label="Close">✕</button></div>
     <div class="modal-body">${bodyHtml}</div>`;
  document.getElementById('modal').classList.add('open');
}
/* The artifact viewer never shows the browser's own dialogs: confirm() returns
   false and prompt() returns null the instant they are called, with nothing on
   screen. Every control gated behind one silently did nothing in the published
   app — the panel's X and its rename, deleting a section, clearing a drawing,
   emptying the trash. These build the step into the page instead. */
let dialogResolve = null;
function closeModal(){
  document.getElementById('modal').classList.remove('open');
  const fn = dialogResolve;        // dismissed by the X, the backdrop or Escape
  dialogResolve = null;
  if(fn) fn(null);
}
function settle(value){
  const fn = dialogResolve;
  dialogResolve = null;
  closeModal();
  if(fn) fn(value);
}
function askConfirm(title, message, okLabel, danger){
  return new Promise(resolve => {
    dialogResolve = resolve;
    openModal(title, `
      <p class="dlg-msg">${esc(message)}</p>
      <div class="dlg-acts">
        <button class="btn btn-sm btn-ghost" onclick="settle(false)">Cancel</button>
        <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" onclick="settle(true)">${esc(okLabel || 'OK')}</button>
      </div>`);
    setTimeout(() => { const el = document.querySelector('.dlg-acts .btn-primary, .dlg-acts .btn-danger'); if(el) el.focus(); }, 40);
  }).then(v => v === true);
}
function askText(title, label, value, okLabel){
  return new Promise(resolve => {
    dialogResolve = resolve;
    openModal(title, `
      <div class="field"><label>${esc(label)}</label>
        <input class="input" id="dlg-input" value="${esc(value || '')}"
          onkeydown="if(event.key==='Enter'){ event.preventDefault(); settle(this.value); }"></div>
      <div class="dlg-acts">
        <button class="btn btn-sm btn-ghost" onclick="settle(null)">Cancel</button>
        <button class="btn btn-sm btn-primary" onclick="settle(document.getElementById('dlg-input').value)">${esc(okLabel || 'Save')}</button>
      </div>`);
    setTimeout(() => { const el = document.getElementById('dlg-input'); if(el){ el.focus(); el.select(); } }, 40);
  });
}

/* ============ HELPER (Claude in the hub) ============ */
const TEXT_FILE_RE = /\.(txt|md|markdown|csv|json|log|yml|yaml)$/i;
const MAX_TEXT_BYTES = 300000, MAX_DOC_BYTES = 15*1024*1024, MAX_CHARS = 6000;
const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
let pendingImages = [], pendingFiles = [];
const attThumbs = {};
let chatBusy = false, chatAbort = null, thoughtBusy = false, thoughtDone = false;
let lastCall = null;

/* ---- live activity: what the helper is doing, right now ---- */
const act = { on:false, status:'', steps:[], startedAt:0, timer:null, hideTimer:null };
function actStart(){
  clearTimeout(act.hideTimer);
  act.on = true; act.steps = []; act.status = 'Thinking'; act.startedAt = Date.now();
  clearInterval(act.timer);
  act.timer = setInterval(renderActivity, 1000);
  document.getElementById('thought').hidden = true;
  document.getElementById('act-foot').hidden = false;
  renderActivity();
}
function actSet(status){ act.status = status; renderActivity(); }
function actStep(text){ const s = { text, state:'doing' }; act.steps.push(s); renderActivity(); return s; }
function actDone(s, text){ if(!s) return; s.state = 'done'; if(text) s.text = text; renderActivity(); }
function actFail(s, msg){ if(!s) return; s.state = 'fail'; s.text = s.text + (msg ? ' — ' + msg : ''); renderActivity(); }
function actEnd(finalStatus){
  act.on = false;
  clearInterval(act.timer); act.timer = null;
  act.status = finalStatus || 'Done';
  document.getElementById('act-foot').hidden = true;
  renderActivity();
  act.hideTimer = setTimeout(() => { document.getElementById('activity').hidden = true; }, 7000);
}
function actBody(){
  const secs = Math.max(0, Math.round((Date.now() - act.startedAt)/1000));
  const status = act.on
    ? `<span class="dots"><i></i><i></i><i></i></span> ${esc(act.status)}…`
    : `<span style="color:var(--success);">✓</span> ${esc(act.status)}`;
  const steps = act.steps.map(s => `<li class="${s.state}"><span class="mark">${s.state==='done'?'✓':(s.state==='fail'?'!':'·')}</span><span>${esc(s.text)}</span></li>`).join('');
  return { status, steps, timer: act.on ? secs + 's' : (secs ? 'took ' + secs + 's' : '') };
}
function renderActivity(){
  const parts = actBody();
  const card = document.getElementById('activity');
  if(card){
    card.hidden = false;
    document.getElementById('act-status').innerHTML = parts.status;
    document.getElementById('act-steps').innerHTML = parts.steps;
    document.getElementById('act-timer').textContent = parts.timer;
  }
  const inChat = document.getElementById('chat-working');
  if(inChat){
    inChat.innerHTML = `<div class="act-head"><span class="act-label">What I'm doing</span><span class="act-timer mono">${parts.timer}</span></div>
      <div class="act-status">${parts.status}</div>
      <ul class="act-steps">${parts.steps}</ul>`;
  }
}
function setSendMode(busy){
  const btn = document.getElementById('send-btn');
  if(!btn) return;
  btn.disabled = false;
  btn.textContent = busy ? 'Stop' : 'Send';
  btn.classList.toggle('btn-primary', !busy);
}
function onSendClick(){ if(chatBusy) stopHelper(); else sendChat(); }
function stopHelper(){
  if(chatAbort){ try{ chatAbort.abort(); }catch(e){} }
  chatBusy = false;
  setSendMode(false);
  document.getElementById('helper-bubble').classList.remove('busy');
  actEnd('Stopped');
}
function showFailure(text){
  const body = document.getElementById('chat-body');
  const card = document.createElement('div');
  card.className = 'err-card';
  card.innerHTML = esc(text) + '<br><button class="btn btn-sm" onclick="retryLast()">Try again</button>';
  body.appendChild(card);
  body.scrollTop = body.scrollHeight;
}
function showOrphanReply(text){
  const body = document.getElementById('chat-body');
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.textContent = text;
  body.appendChild(el);
  const note = document.createElement('div');
  note.className = 'notice';
  note.textContent = 'This reply could not be saved to your hub history.';
  body.appendChild(note);
  body.scrollTop = body.scrollHeight;
}
const TOOL_LABELS = {
  getHub: () => 'Reading your hub',
  readSection: i => 'Reading the ' + ((resolveBubble(i||{})||{}).name || 'section') + ' section',
  designSection: i => 'Designing ' + ((resolveBubble(i||{})||{}).name || 'the section'),
  addPanel: i => 'Adding the "' + (i && i.title ? i.title : 'new') + '" panel',
  updatePanel: i => 'Updating "' + (i && i.panelTitle ? i.panelTitle : 'a panel') + '"',
  removePanel: i => 'Removing "' + (i && i.panelTitle ? i.panelTitle : 'a panel') + '"',
  createSection: i => 'Creating the ' + (i && i.name ? i.name : 'new') + ' section',
  removeSection: i => 'Deleting the ' + (i && i.sectionName ? i.sectionName : '') + ' section',
  addTask: i => 'Adding to-do: ' + (i && i.text ? String(i.text).slice(0,40) : ''),
  completeTask: () => 'Checking off a to-do',
  pinImportant: () => 'Pinning important info',
  searchWeb: i => 'Searching the web: ' + ((i && i.queries && i.queries[0]) ? String(i.queries[0]).slice(0,40) : '…'),
  readWebPage: i => {
    let host = 'a page';
    try{ host = new URL((i.urls || [])[0]).hostname.replace(/^www\./, ''); }catch(e){}
    return 'Reading ' + host;
  },
};
function allTools(){
  return buildTools().concat(webOn ? webTools() : []);
}
function instrument(tools){
  return tools.map(t => Object.assign({}, t, {
    execute: async (input, ctx) => {
      const label = TOOL_LABELS[t.name] ? TOOL_LABELS[t.name](input) : t.name;
      const step = actStep(label);
      actSet(label);
      try{
        const out = await t.execute(input, ctx);
        actDone(step);
        actSet('Thinking');
        return out;
      }catch(e){
        actFail(step, e && e.message ? e.message : 'failed');
        actSet('Thinking');
        throw e;
      }
    }
  }));
}

const _scripts = {};
function loadScriptOnce(src){
  if(_scripts[src]) return _scripts[src];
  _scripts[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('load failed'));
    document.head.appendChild(s);
  });
  return _scripts[src];
}
let pdfReady = null, mammothReady = null;
function ensurePdf(){
  if(!pdfReady) pdfReady = loadScriptOnce(PDFJS_BASE + '/pdf.min.js').then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + '/pdf.worker.min.js';
  });
  return pdfReady;
}
function ensureMammoth(){ if(!mammothReady) mammothReady = loadScriptOnce(MAMMOTH_URL); return mammothReady; }
async function extractPdf(file){
  await ensurePdf();
  const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = '';
  for(let i=1; i<=Math.min(doc.numPages,30); i++){
    const c = await (await doc.getPage(i)).getTextContent();
    text += c.items.map(x => x.str).join(' ') + '\n\n';
    if(text.length > MAX_CHARS*2) break;
  }
  return text.trim();
}
async function extractDocx(file){
  await ensureMammoth();
  const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return (r.value || '').trim();
}
function looksLikeImage(f){
  return /^image\//i.test(f.type || '') || /\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff?|avif)$/i.test(f.name || '');
}
async function refreshSampleCaps(){
  if(!sampleFn || !sampleFn.limits) return sampleCaps;
  try{ const c = await sampleFn.limits(); if(c) sampleCaps = c; }catch(e){ /* keep what we had */ }
  return sampleCaps;
}
/* Re-encode anything the browser can decode into a plain, accepted, right-sized image.
   Fixes phone formats (HEIC on Safari), odd types, and files over the size cap. */
async function normalizeImage(file, cap){
  const accepted = (cap && cap.mediaTypes && cap.mediaTypes.length) ? cap.mediaTypes : ['image/jpeg','image/png','image/webp','image/gif'];
  const target = accepted.includes('image/jpeg') ? 'image/jpeg' : (accepted.includes('image/png') ? 'image/png' : accepted[0]);
  let bmp = null;
  try{ bmp = await createImageBitmap(file); }
  catch(e){
    try{
      bmp = await new Promise((res, rej) => {
        const img = new Image(); const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); res(img); };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
        img.src = url;
      });
    }catch(e2){ return null; }
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  if(!w || !h) return null;
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if(target === 'image/jpeg'){ ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); }
  ctx.drawImage(bmp, 0, 0, cw, ch);
  const blob = await new Promise(res => canvas.toBlob(res, target, 0.9));
  if(!blob) return null;
  const ext = target === 'image/jpeg' ? '.jpg' : (target === 'image/png' ? '.png' : '');
  const base = String(file.name || 'image').replace(/\.[^.]+$/, '');
  try{ return new File([blob], base + ext, { type: target }); }
  catch(e){ blob.name = base + ext; return blob; }
}
function readText(file){
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result||'')); r.onerror = () => rej(r.error); r.readAsText(file); });
}
function notice(text, keep){
  const body = document.getElementById('chat-body');
  const el = document.createElement('div');
  el.className = 'notice'; el.textContent = text;
  body.appendChild(el); body.scrollTop = body.scrollHeight;
  if(!keep) setTimeout(() => el.remove(), 4500);
  return el;
}
async function onFilesChosen(fileList){
  const files = Array.from(fileList || []);
  for(const f of files){
    const nm = f.name.toLowerCase();
    if(looksLikeImage(f)){
      // The capability probe can be stale or have failed at load — ask again before refusing anything.
      let cap = (sampleCaps && sampleCaps.images) || null;
      if(!cap){ await refreshSampleCaps(); cap = (sampleCaps && sampleCaps.images) || null; }
      if(pendingImages.length >= ((cap && cap.maxCount) || 4)){ notice('Only ' + ((cap && cap.maxCount) || 4) + ' images at a time.'); continue; }

      const typeOk = (cap && cap.mediaTypes && cap.mediaTypes.length)
        ? cap.mediaTypes.includes(f.type)
        : /^image\/(png|jpe?g|webp|gif)$/i.test(f.type || '');
      const tooBig = !!(cap && cap.maxInputBytes && f.size > cap.maxInputBytes);
      let use = f;
      if(!typeOk || tooBig){
        const conv = await normalizeImage(f, cap);
        if(conv){ use = conv; }
        else {
          const ext = (nm.match(/\.([a-z0-9]+)$/) || [,'that'])[1].toUpperCase();
          notice('This browser cannot read ' + ext + ' images. Send a JPG or PNG (a screenshot works).');
          continue;
        }
      }
      const entry = { file: use, url: URL.createObjectURL(use), label: f.name, ocr: null, ocrText: '' };
      entry.ocr = ocrImage(use)
        .then(t => { entry.ocrText = t; entry.ocrDone = true; renderPending(); return t; })
        .catch(e => { entry.ocrDone = true; entry.ocrFailed = true; renderPending(); console.error('ocr', e); return ''; });
      pendingImages.push(entry);
      renderPending();
    } else if(f.type === 'application/pdf' || nm.endsWith('.pdf')){
      if(f.size > MAX_DOC_BYTES){ notice('"'+f.name+'" is too large.'); continue; }
      const n = notice('Reading "'+f.name+'"…', true);
      try{
        let content = await extractPdf(f); n.remove();
        if(!content){ notice('No readable text in "'+f.name+'" — it may be scanned.'); continue; }
        let truncated = false;
        if(content.length > MAX_CHARS){ content = content.slice(0, MAX_CHARS); truncated = true; }
        pendingFiles.push({ name: f.name, content, truncated, kind:'pdf' });
      }catch(e){ n.remove(); notice('Could not read "'+f.name+'".'); }
    } else if(nm.endsWith('.docx') || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'){
      if(f.size > MAX_DOC_BYTES){ notice('"'+f.name+'" is too large.'); continue; }
      const n = notice('Reading "'+f.name+'"…', true);
      try{
        let content = await extractDocx(f); n.remove();
        if(!content){ notice('No readable text in "'+f.name+'".'); continue; }
        let truncated = false;
        if(content.length > MAX_CHARS){ content = content.slice(0, MAX_CHARS); truncated = true; }
        pendingFiles.push({ name: f.name, content, truncated, kind:'docx' });
      }catch(e){ n.remove(); notice('Could not read "'+f.name+'".'); }
    } else if((f.type && f.type.startsWith('text/')) || f.type === 'application/json' || TEXT_FILE_RE.test(f.name)){
      if(f.size > MAX_TEXT_BYTES){ notice('"'+f.name+'" is too large.'); continue; }
      try{
        let content = await readText(f);
        let truncated = false;
        if(content.length > MAX_CHARS){ content = content.slice(0, MAX_CHARS); truncated = true; }
        pendingFiles.push({ name: f.name, content, truncated, kind:'text' });
      }catch(e){ notice('Could not read "'+f.name+'".'); }
    } else {
      notice('Images, PDFs, Word docs and text files only — "'+f.name+'" is not supported.');
    }
  }
  renderPending();
}
function removePendingImage(i){ const [x] = pendingImages.splice(i,1); if(x) URL.revokeObjectURL(x.url); renderPending(); }
function removePendingFile(i){ pendingFiles.splice(i,1); renderPending(); }
function glyphFor(kind){ return kind === 'pdf' ? 'PDF' : kind === 'docx' ? 'DOC' : 'TXT'; }
function renderPending(){
  const wrap = document.getElementById('pending');
  const chips = pendingImages.map((im,i) => {
    const state = im.ocrDone ? (ocrIsUseful(im.ocrText) ? 'text read' : '') : 'reading…';
    return `<span class="p-chip"><img src="${im.url}" alt=""><span class="nm">${esc(im.label || im.file.name)}${state ? ' · ' + state : ''}</span><button onclick="removePendingImage(${i})" aria-label="Remove">✕</button></span>`;
  })
    .concat(pendingFiles.map((f,i) => `<span class="p-chip"><span class="glyph">${glyphFor(f.kind)}</span><span class="nm">${esc(f.name)}</span><button onclick="removePendingFile(${i})" aria-label="Remove">✕</button></span>`));
  wrap.innerHTML = chips.join('');
  wrap.hidden = !chips.length;
}

function openHelper(){
  if(chatBusy && !chatAbort){ chatBusy = false; setSendMode(false); document.getElementById('helper-bubble').classList.remove('busy'); }
  openSheet('helper-sheet'); renderChat(); renderSuggests(); setTimeout(()=>{ const i=document.getElementById('chat-input'); if(i) i.focus(); }, 60); }
function closeHelper(){ closeSheet('helper-sheet'); }
function openHelperForDesign(){
  openHelper();
  const b = bubbleById(activeBubbleId);
  const input = document.getElementById('chat-input');
  input.value = b ? 'Design the ' + b.name + ' section for me — ' : 'Design this section for me — ';
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function renderSuggests(){
  const el = document.getElementById('suggests');
  const b = view === 'section' ? bubbleById(activeBubbleId) : null;
  const list = DEMO ? (b
    ? ['Design this section for me', 'Add a deadline panel', 'What\'s due this week?']
    : ['Add essay due Monday', 'What\'s due this week?', 'Make a section for Travel', 'Pin locker combo 12-34-08'])
    : b
    ? ['Design this section for me', 'What should I focus on here?'].concat(webOn ? ['Look something up for this…'] : ['Add a deadline panel'])
    : ['What should I do today?', 'What am I forgetting?'].concat(webOn ? ['Look up…'] : ['Make me a section for…']);
  const sub = document.getElementById('helper-context');
  if(sub && webOn && !/web/.test(sub.textContent)) sub.textContent = sub.textContent + ' · web access on';
  el.innerHTML = list.map(s => `<button class="suggest" onclick="useSuggest(this)">${esc(s)}</button>`).join('');
}
function useSuggest(btn){
  const input = document.getElementById('chat-input');
  input.value = btn.textContent;
  input.focus();
  if(!/…$/.test(btn.textContent)) sendChat();
}
function renderChat(){
  const body = document.getElementById('chat-body');
  const msgs = state.chat.slice().sort((a,b) => (a.createdAt||0)-(b.createdAt||0)).slice(-60);
  if(!msgs.length){
    body.innerHTML = `<div class="chat-empty">I can see your whole hub — every section, panel, to-do and reminder.<br>Tell me what to build, what to track, or just ask what is going on.</div>`;
  } else {
    body.innerHTML = msgs.map(m => {
      const atts = m.attachments || [];
      const a = atts.length ? `<div class="msg-atts">${atts.map(x => {
        const th = x.kind === 'image' ? attThumbs[m.id + ':' + x.name] : null;
        return `<span class="msg-att">${th ? `<img src="${th}" alt="">` : ''}${esc(x.name)}</span>`;
      }).join('')}</div>` : '';
      return `<div class="msg ${esc(m.role)}">${esc(m.content)}${a}</div>`;
    }).join('');
  }
  body.scrollTop = body.scrollHeight;
}

function hubSnapshot(){
  const lines = [];
  lines.push('TODAY: ' + todayStr());
  lines.push('VIEW: ' + (view === 'section' ? ('inside section "' + ((bubbleById(activeBubbleId)||{}).name || '?') + '" (id ' + activeBubbleId + ')') : 'hub home'));
  lines.push('SECTIONS (indented under whatever they branch off):');
  const seen = new Set();
  const describe = (b, depth) => {
    const ws = getWidgets(b).map(w => w.title + ' [' + w.type + ']').join(', ') || 'no panels yet';
    lines.push('  '.repeat(depth) + '- ' + b.name + ' (id ' + b.id + '): ' + ws);
  };
  const walk = (parentId, depth) => {
    sortedBubbles().forEach(b => {
      if(seen.has(b.id)) return;
      if((((parentOf(b) || {}).id) || null) !== parentId) return;
      seen.add(b.id);
      describe(b, depth);
      if(depth < 8) walk(b.id, depth + 1);
    });
  };
  walk(null, 0);
  // anything left is in a broken loop; list it flat rather than hiding it
  sortedBubbles().forEach(b => { if(!seen.has(b.id)) describe(b, 0); });
  if(!state.bubbles.length) lines.push('- none yet');
  const open = openTasks();
  lines.push('OPEN TO-DOS (' + open.length + '): ' + (open.slice(0,18).map(t => {
    const b = t.bubbleId ? bubbleById(t.bubbleId) : null;
    return t.text + (t.due ? ' [due ' + t.due + ']' : '') + (b ? ' {' + b.name + '}' : '');
  }).join('; ') || 'none'));
  const imp = state.important.slice(0,10).map(i => i.text).join('; ');
  lines.push('PINNED IMPORTANT INFO: ' + (imp || 'none'));
  return lines.join('\n');
}
function sectionDetail(id){
  const b = bubbleById(id); if(!b) return 'Section not found.';
  const out = ['SECTION "' + b.name + '" (id ' + b.id + ')'];
  getWidgets(b).forEach(w => {
    const d = w.data;
    let body = '';
    if(w.type === 'checklist') body = (d.items||[]).map(i => (i.done?'[x] ':'[ ] ') + i.text).join(' | ');
    else if(w.type === 'notes') body = (d.text||'').slice(0,400);
    else if(w.type === 'metric') body = String(d.value) + (d.unit||'') + (d.target?(' of ' + d.target):'') + ' — ' + (d.label||'');
    else if(w.type === 'table') body = (d.columns||[]).join(' / ') + ' :: ' + (d.rows||[]).slice(0,12).map(r => r.join(' / ')).join(' | ');
    else if(w.type === 'dates') body = (d.items||[]).map(i => i.label + ' ' + i.date).join(' | ');
    else if(w.type === 'progress') body = (d.items||[]).map(i => i.label + ' ' + (i.pct||0) + '%').join(' | ');
    else if(w.type === 'habit') body = (d.items||[]).map(i => i.name + ' (' + streakOf(i) + 'd streak)').join(' | ');
    else if(w.type === 'links') body = (d.items||[]).map(i => i.label).join(' | ');
    else if(w.type === 'jobs'){
      const rows = d.rows || [];
      const ready = rows.filter(r => draftFor(r.id)).length;
      body = rows.length
        ? (rows.length + ' applications, ' + ready + ' tailored: '
           + rows.slice(0,12).map(r => (r.company || 'untitled') + (draftFor(r.id) ? ' ✓' : '')).join(', ')
           + ((d.resume||'').trim() ? '' : ' — no résumé saved yet'))
        : 'no applications yet';
    }
    else if(w.type === 'sticky') body = (d.items||[]).map(i => i.text).filter(Boolean).join(' | ');
    out.push('- ' + w.title + ' [' + w.type + ', ' + w.size + ']: ' + (body || 'empty'));
  });
  return out.join('\n');
}

function resolveBubble(input){
  if(input.sectionId){
    const b = bubbleById(String(input.sectionId));
    if(b) return b;
  }
  if(input.sectionName){
    const q = String(input.sectionName).toLowerCase();
    const b = state.bubbles.find(x => x.name.toLowerCase() === q) || state.bubbles.find(x => x.name.toLowerCase().includes(q));
    if(b) return b;
  }
  if(activeBubbleId) return bubbleById(activeBubbleId);
  return null;
}
function buildTools(){
  return [
    {
      name: 'getHub',
      description: 'Returns the full state of the hub: every section with its panels, open to-dos and reminders, pinned important info, and what Andrew is currently looking at. Call this first for anything about his life, plans, or what to do.',
      execute: async () => hubSnapshot(),
    },
    {
      name: 'readSection',
      description: 'Returns the full contents of one section, including the data inside each panel. Use before redesigning a section so you do not throw away what is already there.',
      inputSchema: { type:'object', properties:{ sectionId:{type:'string'}, sectionName:{type:'string'} } },
      execute: async (input) => { const b = resolveBubble(input || {}); return b ? sectionDetail(b.id) : 'No such section.'; },
    },
    {
      name: 'designSection',
      description: 'Designs or redesigns a section by setting its panels. Pass the full list of panels you want the section to have (this replaces the current layout). Panel types: checklist, notes, metric (one big number, optional target), table (columns + rows), dates (deadlines/events), progress (labelled % bars), habit (daily streaks), links, sticky (a board of short sticky notes — items are {text, tone} where tone is yellow/pink/blue/green/orange/purple). Sizes: sm, md, lg. You may include starting data. Use this when Andrew asks you to build, design, lay out, or set up a section.',
      inputSchema: { type:'object', properties:{
        sectionId:{type:'string', description:'Optional; defaults to the section Andrew is viewing'},
        sectionName:{type:'string', description:'Optional; match a section by name'},
        widgets:{ type:'array', description:'Panels in display order', items:{ type:'object', properties:{
          type:{type:'string', enum:['checklist','notes','metric','table','dates','progress','habit','links','sticky']},
          title:{type:'string'}, size:{type:'string', enum:['sm','md','lg']},
          data:{type:'object', description:'Optional starting content, shaped for the type: checklist/progress/habit/dates/links use items arrays, notes uses text, metric uses value/label/target/unit, table uses columns and rows'}
        }, required:['type','title'] } }
      }, required:['widgets'] },
      execute: async (input) => {
        const b = resolveBubble(input || {});
        if(!b) throw new Error('No section to design. Create one first with createSection.');
        const list = Array.isArray(input.widgets) ? input.widgets : [];
        if(!list.length) throw new Error('widgets must contain at least one panel');
        const widgets = list.slice(0,10).map(w => normalizeWidget({ type: w.type, title: w.title, size: w.size, data: hydrate(w.type, w.data) }));
        await saveWidgets(b.id, widgets);
        return 'Designed "' + b.name + '" with ' + widgets.length + ' panels: ' + widgets.map(w => w.title).join(', ') + '.';
      },
    },
    {
      name: 'addPanel',
      description: 'Adds one panel to a section without touching the existing ones. Same panel types and data shapes as designSection.',
      inputSchema: { type:'object', properties:{
        sectionId:{type:'string'}, sectionName:{type:'string'},
        type:{type:'string', enum:['checklist','notes','metric','table','dates','progress','habit','links','sticky']},
        title:{type:'string'}, size:{type:'string', enum:['sm','md','lg']}, data:{type:'object'}
      }, required:['type','title'] },
      execute: async (input) => {
        const b = resolveBubble(input || {});
        if(!b) throw new Error('No section found.');
        const w = normalizeWidget({ type: input.type, title: input.title, size: input.size, data: hydrate(input.type, input.data) });
        await saveWidgets(b.id, getWidgets(b).concat([w]));
        return 'Added "' + w.title + '" to ' + b.name + '.';
      },
    },
    {
      name: 'updatePanel',
      description: 'Changes the content of an existing panel, matched by its title. Use set to overwrite fields (e.g. a metric value or notes text) or appendItems to add rows/items to a list panel.',
      inputSchema: { type:'object', properties:{
        sectionId:{type:'string'}, sectionName:{type:'string'}, panelTitle:{type:'string'},
        set:{type:'object', description:'Fields to overwrite inside the panel data'},
        appendItems:{type:'array', description:'Items (or table rows) to append', items:{type:'object'}}
      }, required:['panelTitle'] },
      execute: async (input) => {
        const b = resolveBubble(input || {});
        if(!b) throw new Error('No section found.');
        const widgets = getWidgets(b);
        const q = String(input.panelTitle||'').toLowerCase();
        const w = widgets.find(x => x.title.toLowerCase() === q) || widgets.find(x => x.title.toLowerCase().includes(q));
        if(!w) throw new Error('No panel named "' + input.panelTitle + '" in ' + b.name + '.');
        if(input.set && typeof input.set === 'object') Object.assign(w.data, input.set);
        if(Array.isArray(input.appendItems) && input.appendItems.length){
          const add = hydrate(w.type, { items: input.appendItems, rows: input.appendItems });
          if(w.type === 'table') w.data.rows = (w.data.rows||[]).concat(add.rows||[]);
          else w.data.items = (w.data.items||[]).concat(add.items||[]);
        }
        await saveWidgets(b.id, widgets);
        return 'Updated "' + w.title + '" in ' + b.name + '.';
      },
    },
    {
      name: 'removePanel',
      description: 'Removes a panel from a section by title.',
      inputSchema: { type:'object', properties:{ sectionId:{type:'string'}, sectionName:{type:'string'}, panelTitle:{type:'string'} }, required:['panelTitle'] },
      execute: async (input) => {
        const b = resolveBubble(input || {});
        if(!b) throw new Error('No section found.');
        const q = String(input.panelTitle||'').toLowerCase();
        const keep = getWidgets(b).filter(w => w.title.toLowerCase() !== q);
        await saveWidgets(b.id, keep);
        return 'Removed "' + input.panelTitle + '" from ' + b.name + '.';
      },
    },
    {
      name: 'createSection',
      description: 'Creates a new section bubble on the hub. Pass branchesOff to hang it under an existing section instead of off the middle — that is how sub-sections are made (e.g. a "Calculus" bubble branching off "School"). Returns its id so you can design it straight away.',
      inputSchema: { type:'object', properties:{
        name:{type:'string'},
        tone:{type:'string', enum:['teal','amber','violet','green','rose','blue']},
        branchesOff:{type:'string', description:'Optional name or id of the section this one hangs off'}
      }, required:['name'] },
      execute: async (input) => {
        const name = String(input.name||'').trim();
        if(!name) throw new Error('name is required');
        const tone = TONES.includes(input.tone) ? input.tone : TONES[state.bubbles.length % TONES.length];
        const doc = { name, tone, widgets: [], createdAt: Date.now() };
        let under = null;
        if(input.branchesOff){
          under = resolveBubble({ sectionId: input.branchesOff, sectionName: input.branchesOff });
          if(!under) throw new Error('No section called "' + input.branchesOff + '" to branch off.');
          doc.parentId = under.id;
        }
        const { id } = await cols.bubbles.add(doc);
        return 'Created section "' + name + '" (id ' + id + ')'
          + (under ? ' branching off "' + under.name + '".' : '.');
      },
    },
    {
      name: 'removeSection',
      description: 'Moves a section bubble and its panels to the trash, where Andrew can restore it. Only when he clearly asks for it.',
      inputSchema: { type:'object', properties:{ sectionName:{type:'string'} }, required:['sectionName'] },
      execute: async (input) => {
        const b = resolveBubble(input || {});
        if(!b) throw new Error('No section found.');
        await trashBubble(b);
        if(activeBubbleId === b.id) goHub();
        return 'Moved section "' + b.name + '" to the trash — Andrew can restore it from the trash button on the hub.';
      },
    },
    {
      name: 'addTask',
      description: 'Adds a to-do or reminder to the centre of the hub, optionally due on a date and tied to a section.',
      inputSchema: { type:'object', properties:{
        text:{type:'string'}, due:{type:'string', description:'YYYY-MM-DD, optional'},
        sectionName:{type:'string', description:'Optional section to file it under'} }, required:['text'] },
      execute: async (input) => {
        const text = String(input.text||'').trim();
        if(!text) throw new Error('text is required');
        const due = input.due && /^\d{4}-\d{2}-\d{2}$/.test(String(input.due)) ? String(input.due) : '';
        const b = input.sectionName ? resolveBubble({ sectionName: input.sectionName }) : null;
        await cols.tasks.add({ text, due, bubbleId: b ? b.id : '', done:false, createdAt: Date.now() });
        return 'Added "' + text + '"' + (due ? ' due ' + due : '') + (b ? ' under ' + b.name : '') + '.';
      },
    },
    {
      name: 'completeTask',
      description: 'Marks a to-do done, matched by its text.',
      inputSchema: { type:'object', properties:{ text:{type:'string'} }, required:['text'] },
      execute: async (input) => {
        const q = String(input.text||'').toLowerCase();
        const t = state.tasks.find(x => !x.done && x.text.toLowerCase().includes(q));
        if(!t) throw new Error('No open to-do matching "' + input.text + '".');
        await cols.tasks.update(t.id, { done: true });
        return 'Checked off "' + t.text + '".';
      },
    },
    {
      name: 'pinImportant',
      description: 'Pins a fact to the Important info tab — things Andrew should never have to search for.',
      inputSchema: { type:'object', properties:{ text:{type:'string'} }, required:['text'] },
      execute: async (input) => {
        const text = String(input.text||'').trim();
        if(!text) throw new Error('text is required');
        await cols.important.add({ text, createdAt: Date.now() });
        return 'Pinned to Important info.';
      },
    },
  ];
}
/* ============ SCREENSHOT READING (OCR, runs entirely in the browser) ============
   Some viewers cannot pass images through to Claude at all. Rather than leave the
   helper blind, every attached image is also read here and its text travels with
   the message, so a screenshot always lands even when the picture itself cannot. */
const OCR = { boot: null, worker: null };
async function ensureOcr(){
  if(OCR.worker) return OCR.worker;
  if(!OCR.boot){
    OCR.boot = (async () => {
      await loadScriptOnce('ocr/tesseract.min.js');
      const w = await window.Tesseract.createWorker('eng', 1, {
        workerPath: 'ocr/worker.min.js',
        corePath: 'ocr/',
        // the language pack ships under a served extension; the query tail is what
        // Tesseract appends to langPath, so the real request is for this one file
        langPath: 'ocr/eng-traineddata.wasm?pack=',
      });
      OCR.worker = w;
      return w;
    })().catch(err => { OCR.boot = null; throw err; });
  }
  return OCR.boot;
}
async function ocrImage(file){
  const worker = await ensureOcr();
  const res = await worker.recognize(file);
  const text = (res && res.data && res.data.text) ? res.data.text : '';
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function ocrIsUseful(text){
  if(!text) return false;
  const letters = text.replace(/[^A-Za-z0-9]/g, '');
  return letters.length >= 12;
}

/* ============ WEB ACCESS (via the viewer's Parallel Search connector) ============ */
const WEB_SERVER = 'Parallel Search';
let mcpNs = null, mcpTried = false, webOn = false;
const webSession = (function(){
  let s = '';
  try{ s = sessionStorage.getItem('wf_websession') || ''; }catch(e){}
  if(!s){
    s = Array.from({length:4}, () => Math.random().toString(16).slice(2,10)).join('').slice(0,32);
    try{ sessionStorage.setItem('wf_websession', s); }catch(e){}
  }
  return s;
})();

async function ensureMcp(){
  if(mcpTried) return mcpNs;
  mcpTried = true;
  try{ mcpNs = window.claude ? await window.claude.use('mcp') : null; }catch(e){ mcpNs = null; }
  return mcpNs;
}
function webErrorMessage(e){
  const code = e && e.code;
  if(code === 'server_not_connected') return 'Web access is not connected. Add "' + WEB_SERVER + '" in claude.ai under Settings → Connectors.';
  if(code === 'needs_reauth') return 'Web access needs reconnecting in claude.ai under Settings → Connectors.';
  if(code === 'not_in_manifest') return 'Web access is switched off for this page.';
  if(code === 'selection_required') return 'Several connectors share that name — pick one in claude.ai, then try again.';
  if(code === 'blocked_by_policy' || code === 'approval_required') return 'Web access is blocked by policy for this account.';
  if(code === 'server_unavailable') return 'The search service did not answer just now. Try again in a moment.';
  if(code === 'tool_error') return 'The search service reported an error: ' + (e.message || 'unknown');
  if(code === 'cancelled') return 'The search was cancelled.';
  return 'Web access failed' + (code ? ' (' + code + ')' : '') + '.';
}
function trimTo(s, n){ s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function formatWebResults(payload, perItem, maxItems){
  const results = (payload && payload.results) || [];
  if(!results.length) return 'No results.';
  return results.slice(0, maxItems).map((r, i) => {
    const ex = Array.isArray(r.excerpts) ? r.excerpts.join(' ') : (r.full_content || '');
    return (i+1) + '. ' + trimTo(r.title || r.url, 120) + '\n   ' + (r.url || '') +
           (r.publish_date ? '\n   published ' + r.publish_date : '') +
           '\n   ' + trimTo(ex, perItem);
  }).join('\n\n');
}
async function webCall(tool, input, signal){
  const mcp = await ensureMcp();
  if(!mcp) throw new Error('Web access is not available in this view.');
  const res = await mcp.callTool(WEB_SERVER, tool, input, {
    signal,
    cache: { staleTime: 60000, gcTime: 600000 },
  });
  return res && res.payload ? res.payload : res;
}
function webTools(){
  return [
    {
      name: 'searchWeb',
      description: 'Searches the live web and returns titles, links and excerpts. Use it for anything current or factual you are not certain of — deadlines, requirements, hours, prices, news, how-tos. Prefer one call with two or three related queries over several calls.',
      inputSchema: { type:'object', properties:{
        objective:{ type:'string', description:'What you are trying to find, in one sentence' },
        queries:{ type:'array', items:{type:'string'}, description:'2-3 keyword queries, 3-6 words each' }
      }, required:['objective','queries'] },
      execute: async (input, ctx) => {
        const queries = (Array.isArray(input.queries) ? input.queries : [String(input.queries||'')]).filter(Boolean).slice(0,3);
        if(!queries.length) throw new Error('queries is required');
        try{
          const payload = await webCall('web_search', {
            objective: String(input.objective || queries[0]),
            search_queries: queries,
            session_id: webSession,
          }, ctx && ctx.signal);
          return formatWebResults(payload, 700, 5);
        }catch(e){ throw new Error(webErrorMessage(e)); }
      },
    },
    {
      name: 'readWebPage',
      description: 'Fetches one or more web pages and returns the parts relevant to your objective. Use it when Andrew shares a link, or when a search excerpt is not enough. Up to 4 URLs per call.',
      inputSchema: { type:'object', properties:{
        urls:{ type:'array', items:{type:'string'}, description:'Full http(s) URLs' },
        objective:{ type:'string', description:'What to look for on those pages' }
      }, required:['urls'] },
      execute: async (input, ctx) => {
        const urls = (Array.isArray(input.urls) ? input.urls : [String(input.urls||'')])
          .map(u => String(u).trim()).filter(u => /^https?:\/\//i.test(u)).slice(0,4);
        if(!urls.length) throw new Error('Give me full http(s) URLs.');
        try{
          const payload = await webCall('web_fetch', {
            urls,
            objective: trimTo(input.objective || 'the main content of the page', 200),
            session_id: webSession,
          }, ctx && ctx.signal);
          const errs = (payload && payload.errors) || [];
          const body = formatWebResults(payload, 1600, 4);
          return body + (errs.length ? '\n\nCould not read: ' + errs.map(x => (x && (x.url || x.message)) || 'one URL').join(', ') : '');
        }catch(e){ throw new Error(webErrorMessage(e)); }
      },
    },
  ];
}


/* ============ JOB APPLICATIONS ============
   One résumé in, a tailored résumé and cover letter out for every link.

   Three deliberate choices here:

   1. The tailored documents live in their own `drafts` collection, not inside
      the panel's data. A résumé plus a cover letter is a few kilobytes; twenty
      of them inside the bubble document would make every unrelated save on that
      section rewrite a hundred kilobytes.

   2. Progress is held in memory and written straight to the DOM. Persisting
      "fetching… writing…" would be four database round trips per row, and with
      ten rows queued that is a write storm that re-renders the grid each time.
      Only the finished draft is saved.

   3. The model is told, firmly, that it may reorder and rephrase what is in the
      résumé and nothing else. A résumé that claims experience he does not have
      is worse than no résumé — it fails at the interview instead of the filter.
      Anything the posting wants that he cannot back up comes back under GAPS,
      which is the genuinely useful half of the output. */

const jobStatus = new Map();          // rowId -> {text, kind}
let jobQueue = null;                  // {stop:boolean} while a run is going

function draftFor(rowId){ return state.drafts.find(d => d.id === rowId) || null; }

function setJobStatus(rowId, text, kind){
  jobStatus.set(rowId, { text, kind });
  const el = document.querySelector('[data-job-status="' + rowId + '"]');
  if(el){
    el.textContent = text;
    el.className = 'job-pill ' + (kind || '');
  }
}

function jobsPanel(w){
  const d = w.data || {};
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const hasResume = !!(d.resume || '').trim();
  const done = rows.filter(r => draftFor(r.id)).length;

  const head = `
    <div class="job-resume">
      <div class="job-resume-top">
        <span class="w-kind">Your résumé</span>
        <span class="job-count" id="job-count-${w.id}">${hasResume ? (done + ' of ' + rows.length + ' tailored') : 'choose a file or paste it'}</span>
      </div>
      <div class="job-pick">
        <button class="btn btn-sm" onclick="pickResume('${w.id}')">Choose file…</button>
        <input type="file" id="resume-file-${w.id}" class="job-file"
          accept=".docx,.pdf,.txt,.md,.rtf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain"
          onchange="loadResumeFile('${w.id}', this)">
        <span class="job-file-name" id="job-file-${w.id}">${esc(d.resumeFile || '')}</span>
      </div>
      <textarea class="textarea job-resume-box" data-wid="resume:${w.id}"
        placeholder="Choose your Word résumé above, or paste it here. Every link below gets tailored to it automatically."
        onchange="setJobResume('${w.id}', this.value)">${esc(d.resume || '')}</textarea>
    </div>`;

  const list = rows.length ? rows.map(r => {
    const draft = draftFor(r.id);
    const st = jobStatus.get(r.id);
    const pill = st ? st : draft ? { text:'ready', kind:'ok' } : { text:'waiting', kind:'' };
    return `
    <div class="job-row">
      <input class="input job-company" value="${esc(r.company || '')}" placeholder="Company"
        data-wid="co:${r.id}" onchange="setJobField('${w.id}','${r.id}','company', this.value)">
      <input class="input job-url" value="${esc(r.url || '')}" placeholder="https://… job posting link"
        data-wid="url:${r.id}" onchange="setJobField('${w.id}','${r.id}','url', this.value)">
      <span class="job-pill ${pill.kind}" data-job-status="${r.id}">${esc(pill.text)}</span>
      <div class="job-acts">
        ${draft ? `<button class="btn btn-sm btn-primary" onclick="openDraft('${r.id}')">Preview</button>` : ''}
        <button class="icon-btn" title="${draft ? 'Redo this one' : 'Tailor this one'}" onclick="runJobRow('${w.id}','${r.id}', true)">${draft ? '⟳' : '▶'}</button>
        <button class="icon-btn" title="Paste the description yourself" onclick="pasteJobDescription('${w.id}','${r.id}')">✎</button>
        <button class="icon-btn" title="Remove" onclick="removeJobRow('${w.id}','${r.id}')">✕</button>
      </div>
      ${r.role ? `<div class="job-role">${esc(r.role)}</div>` : ''}
    </div>`;
  }).join('') : '<div class="w-empty">Add a job link and it will be tailored to your résumé.</div>';

  const foot = `
    <div class="job-foot">
      <button class="btn btn-sm" onclick="addJobRow('${w.id}')">+ Add a job</button>
      ${rows.length ? `<button class="btn btn-sm" onclick="runAllJobs('${w.id}')">Tailor all</button>` : ''}
      <button class="btn btn-sm btn-ghost" id="job-stop-${w.id}" hidden onclick="stopJobs()">Stop</button>
      <span class="job-note" id="job-note-${w.id}"></span>
    </div>`;

  return head + '<div class="job-list">' + list + '</div>' + foot;
}

/* A write and the snapshot that reflects it are not the same moment. Awaiting
   the save tells you the database has it; `state` still holds the version from
   before until the subscription fires. So anything that acts on what was JUST
   typed has to be handed that value — read it back out of state and you get the
   empty résumé you had a tick ago. This cost an afternoon once already. */
function jobCtx(wid, over){
  const b = bubbleById(activeBubbleId); if(!b) return null;
  const w = getWidgets(b).find(x => x.id === wid); if(!w) return null;
  const data = Object.assign({}, w.data, over || {});
  return { w, data };
}


/* ---- reading a Word file without a library ----
   A .docx is a ZIP holding word/document.xml. The browser can already inflate
   (DecompressionStream), so pulling one entry out is just walking the central
   directory. Doing it here means picking a résumé does not depend on a CDN
   answering — mammoth stays as a fallback for anything this misses. */
async function unzipEntry(buf, wanted){
  const dv = new DataView(buf);
  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 66000);
  for(let i = buf.byteLength - 22; i >= floor; i--){
    if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error('not a Word file');
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for(let n = 0; n < count; n++){
    if(at + 46 > buf.byteLength || dv.getUint32(at, true) !== 0x02014b50) break;
    const method   = dv.getUint16(at + 10, true);
    const compSize = dv.getUint32(at + 20, true);
    const nameLen  = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const cmtLen   = dv.getUint16(at + 32, true);
    const localOff = dv.getUint32(at + 42, true);
    const name = dec.decode(new Uint8Array(buf, at + 46, nameLen));
    if(name === wanted){
      // the local header repeats the name and extra fields at its own lengths
      const lnLen = dv.getUint16(localOff + 26, true);
      const leLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lnLen + leLen;
      const data = new Uint8Array(buf, start, compSize);
      if(method === 0) return data;
      if(method !== 8) throw new Error('unsupported compression');
      if(typeof DecompressionStream !== 'function') throw new Error('browser cannot inflate');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    at += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error('no document inside that file');
}
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function docxToText(xml){
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if(doc.getElementsByTagName('parsererror').length) throw new Error('unreadable document');
  const paras = doc.getElementsByTagNameNS(W_NS, 'p');
  const lines = [];
  for(let i = 0; i < paras.length; i++){
    // descendants come back in document order, so runs stay in reading order
    const kids = paras[i].getElementsByTagNameNS(W_NS, '*');
    let line = '';
    for(let k = 0; k < kids.length; k++){
      const tag = kids[k].localName;
      if(tag === 't') line += kids[k].textContent;
      else if(tag === 'tab') line += '\t';
      else if(tag === 'br' || tag === 'cr') line += '\n';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
async function extractDocxHere(file){
  const bytes = await unzipEntry(await file.arrayBuffer(), 'word/document.xml');
  return docxToText(new TextDecoder().decode(bytes)).trim();
}

/* PDFs still go through pdf.js, which the chat already loads on demand. */
function pickResume(wid){
  const el = document.getElementById('resume-file-' + wid);
  if(el) el.click();
}
async function loadResumeFile(wid, input){
  const file = input && input.files && input.files[0];
  if(!file) return;
  const nameEl = document.getElementById('job-file-' + wid);
  const show = t => { if(nameEl) nameEl.textContent = t; };
  show('Reading ' + file.name + '…');
  try{
    if(file.size > MAX_DOC_BYTES) throw new Error('that file is too big');
    const nm = (file.name || '').toLowerCase();
    let text = '';
    if(nm.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'){
      try{ text = await extractDocxHere(file); }
      catch(err){ text = await extractDocx(file); }       // fall back to mammoth
    } else if(nm.endsWith('.pdf') || file.type === 'application/pdf'){
      text = await extractPdf(file);
    } else if(nm.endsWith('.doc')){
      throw new Error('old .doc files are not readable — save it as .docx');
    } else {
      text = await readText(file);
    }
    text = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
    if(text.length < 40) throw new Error('almost no text came out of that file');

    const box = document.querySelector('[data-wid="resume:' + wid + '"]');
    if(box) box.value = text;                       // show it before the save lands
    await withWidget(activeBubbleId, wid, w => {
      w.data.resume = text;
      w.data.resumeFile = file.name;
    });
    show(file.name);
    runAllJobs(wid, text);
  }catch(e){
    show((e && e.message) ? e.message : 'could not read that file');
  }finally{
    if(input) input.value = '';                     // let the same file be picked again
  }
}

/* ---- editing ---- */
async function setJobResume(wid, text){
  const resume = String(text || '');
  await withWidget(activeBubbleId, wid, w => { w.data.resume = resume; w.data.resumeFile = ''; });
  // the whole point: a résumé landing in the panel kicks off every link
  if(resume.trim()) runAllJobs(wid, resume);
}
function setJobField(wid, rowId, field, value){
  return withWidget(activeBubbleId, wid, w => {
    const r = (w.data.rows || []).find(x => x.id === rowId);
    if(r) r[field] = String(value || '');
  });
}
function addJobRow(wid){
  return withWidget(activeBubbleId, wid, w => {
    w.data.rows = (w.data.rows || []).concat([{ id: uid(), company:'', url:'', jd:'', role:'' }]);
  });
}
async function removeJobRow(wid, rowId){
  await withWidget(activeBubbleId, wid, w => {
    w.data.rows = (w.data.rows || []).filter(x => x.id !== rowId);
  });
  jobStatus.delete(rowId);
  cols.drafts.delete(rowId).catch(() => {});
}
function pasteJobDescription(wid, rowId){
  const b = bubbleById(activeBubbleId); if(!b) return;
  const w = getWidgets(b).find(x => x.id === wid); if(!w) return;
  const row = (w.data.rows || []).find(x => x.id === rowId); if(!row) return;
  openModal('Paste the job description', `
    <p style="margin:0; font-size:0.8rem; color:var(--text-muted);">
      Some sites — LinkedIn and Workday especially — will not hand over their pages.
      Paste the description here and it gets used instead of the link.</p>
    <div class="field"><label>Description</label>
      <textarea class="textarea" id="jd-box" style="min-height:220px;">${esc(row.jd || '')}</textarea></div>
    <button class="btn btn-primary" onclick="saveJobDescription('${wid}','${rowId}')">Save and tailor</button>`);
}
async function saveJobDescription(wid, rowId){
  const el = document.getElementById('jd-box');
  const text = el ? el.value : '';
  await setJobField(wid, rowId, 'jd', text);
  closeModal();
  if(String(text || '').trim()) runJobRow(wid, rowId, true, { jd: text });
}

/* ---- the run ---- */
function stopJobs(){ if(jobQueue) jobQueue.stop = true; }

async function runAllJobs(wid, resumeNow){
  if(jobQueue && !jobQueue.stop) return;              // one run at a time
  const ctx = jobCtx(wid, resumeNow != null ? { resume: resumeNow } : null);
  if(!ctx) return;
  const resume = (ctx.data.resume || '').trim();
  if(!resume) return jobNote(wid, 'Paste your résumé first.');
  const todo = (ctx.data.rows || []).filter(r => (r.url || r.jd) && !draftFor(r.id));
  if(!todo.length) return jobNote(wid, 'Everything with a link is already tailored.');

  jobQueue = { stop:false };
  const stopBtn = document.getElementById('job-stop-' + wid);
  if(stopBtn) stopBtn.hidden = false;
  todo.forEach(r => setJobStatus(r.id, 'queued', ''));

  let n = 0;
  for(const row of todo){
    if(jobQueue.stop){ setJobStatus(row.id, 'stopped', ''); continue; }
    n++;
    jobNote(wid, 'Tailoring ' + n + ' of ' + todo.length + '…');
    await runJobRow(wid, row.id, false, { resume });
  }
  jobNote(wid, jobQueue.stop ? 'Stopped.' : 'Done.');
  jobQueue = null;
  if(stopBtn) stopBtn.hidden = true;
}

function jobNote(wid, text){
  const el = document.getElementById('job-note-' + wid);
  if(el) el.textContent = text || '';
}

async function runJobRow(wid, rowId, solo, over){
  const ctx = jobCtx(wid, over && over.resume != null ? { resume: over.resume } : null);
  if(!ctx) return;
  const row = Object.assign({}, (ctx.data.rows || []).find(x => x.id === rowId));
  if(!row.id) return;
  if(over && over.jd != null) row.jd = over.jd;
  const resume = (ctx.data.resume || '').trim();
  if(!resume){ setJobStatus(rowId, 'no résumé', 'bad'); return; }
  if(!sampleFn){ setJobStatus(rowId, 'Cosmo unavailable', 'bad'); return; }

  try{
    let jd = (row.jd || '').trim();
    if(!jd){
      if(!/^https?:\/\//i.test(row.url || '')){
        setJobStatus(rowId, 'needs a link', 'bad');
        return;
      }
      setJobStatus(rowId, 'reading the posting', 'busy');
      try{
        const payload = await webCall('web_fetch', {
          urls: [row.url.trim()],
          objective: 'the full job description: responsibilities, required and preferred qualifications, team and location',
          session_id: webSession,
        });
        jd = formatWebResults(payload, 6000, 1);
        if(!jd || jd === 'No results.' || jd.length < 200) throw new Error('too little came back');
      }catch(e){
        // most big job boards refuse to be read; say so and offer the paste box
        setJobStatus(rowId, 'cannot read — paste it', 'bad');
        return;
      }
    }

    setJobStatus(rowId, 'writing', 'busy');
    const out = await sampleFn(jobTurns(resume, jd, row), { modelTier: 'default' });
    const parsed = parseDraft(out && out.text ? out.text : '');
    if(!parsed.resume){ setJobStatus(rowId, 'no draft came back', 'bad'); return; }

    await cols.drafts.set(rowId, {
      company: row.company || parsed.company || '',
      role: parsed.role || '',
      resume: parsed.resume,
      cover: parsed.cover,
      gaps: parsed.gaps,
      url: row.url || '',
      at: Date.now(),
    });
    if(parsed.role && parsed.role !== row.role) await setJobField(wid, rowId, 'role', parsed.role);
    setJobStatus(rowId, 'ready', 'ok');
  }catch(e){
    console.error('tailor', e);
    setJobStatus(rowId, (e && e.message) ? trimTo(e.message, 40) : 'failed', 'bad');
  }
}

function jobTurns(resume, jd, row){
  const rules = [
    'You are tailoring Andrew Rodriguez\'s résumé and writing a cover letter for one specific job.',
    '',
    'RULES. These matter more than style:',
    '- Use ONLY facts that appear in his résumé below. Never invent an employer, a job title, a date, a degree, a GPA, a number, an award or a technology he has not listed.',
    '- You may reorder sections, regroup bullets, retitle things, and rewrite his existing bullets in the posting\'s own language — but only where that is honestly true of what he already wrote.',
    '- Put the most relevant experience first. Drop what the posting does not care about.',
    '- If the posting asks for something his résumé does not evidence, leave it out of the résumé entirely and name it under GAPS. Do not imply he has it.',
    '- Keep the résumé to roughly one page of plain text. No markdown tables, no emoji.',
    '- The cover letter is three short paragraphs, specific to this posting, no flattery and no "I am writing to express my interest".',
    '',
    'Reply in exactly this shape and nothing else:',
    '===ROLE===',
    'Job title at Company',
    '===RESUME===',
    '(the tailored résumé)',
    '===COVER===',
    '(the cover letter)',
    '===GAPS===',
    '(bullets: what the posting asks for that his résumé does not show. Write "None" if there is nothing.)',
  ].join('\n');

  const body = [
    'JOB POSTING' + (row.company ? ' at ' + row.company : '') + ':',
    trimTo(jd, 9000),
    '',
    'HIS RÉSUMÉ:',
    resume.slice(0, 14000),
  ].join('\n');

  return [{ role:'user', content: rules }, { role:'user', content: body }];
}

function parseDraft(text){
  const grab = (tag, next) => {
    const re = new RegExp('===' + tag + '===\\s*([\\s\\S]*?)(?=\\n===(?:' + next + ')===|$)', 'i');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const role = grab('ROLE', 'RESUME|COVER|GAPS');
  const resume = grab('RESUME', 'COVER|GAPS');
  const cover = grab('COVER', 'GAPS');
  const gaps = grab('GAPS', 'ROLE');
  const company = (role.split(/\s+at\s+/i)[1] || '').trim();
  // if the model ignored the format, treat the whole reply as the résumé
  if(!resume && text.trim()) return { role:'', company:'', resume:text.trim(), cover:'', gaps:'' };
  return { role, company, resume, cover, gaps };
}

/* ---- preview ---- */
const CAN_SAVE_FILES = true;      // the downloads capability, with a local fallback

/* ---- a real Word file, built by hand ----
   A .docx is a ZIP of three XML parts. Writing the ZIP with the STORE method
   (no compression) means no deflate implementation and no library — a résumé is
   a few kilobytes, so the compression would have saved nothing worth a 100KB
   dependency behind a restrictive CSP. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let i = 0; i < 256; i++){
    let ch = i;
    for(let k = 0; k < 8; k++) ch = (ch & 1) ? (0xEDB88320 ^ (ch >>> 1)) : (ch >>> 1);
    t[i] = ch >>> 0;
  }
  return t;
})();
function crc32(bytes){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files){
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  files.forEach(f => {
    const name = enc.encode(f.name);
    const body = enc.encode(f.body);
    const crc = crc32(body);
    const local = [].concat(
      [0x50,0x4B,0x03,0x04], u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(body.length), u32(body.length), u16(name.length), u16(0));
    parts.push(new Uint8Array(local), name, body);
    central.push([].concat(
      [0x50,0x4B,0x01,0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(body.length), u32(body.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      Array.from(name)));
    offset += local.length + name.length + body.length;
  });

  const dir = central.reduce((a, b) => a.concat(b), []);
  const end = [].concat(
    [0x50,0x4B,0x05,0x06], u16(0), u16(0), u16(files.length), u16(files.length),
    u32(dir.length), u32(offset), u16(0));

  const total = offset + dir.length + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  parts.forEach(chunk => { out.set(chunk, at); at += chunk.length; });
  out.set(new Uint8Array(dir), at); at += dir.length;
  out.set(new Uint8Array(end), at);
  return out;
}
function xmlEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/\x00-\x08\x0B\x0C\x0E-\x1F/g,'');
}
function buildDocx(text){
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const paras = lines.map((line, i) => {
    const t = line.trim();
    // the first non-empty line is the name at the top of a résumé
    const heading = (i === 0 && t);
    const runProps = heading ? '<w:rPr><w:b/><w:sz w:val="30"/></w:rPr>' : '';
    return '<w:p><w:pPr><w:spacing w:after="' + (heading ? '160' : '60') +
      '"/></w:pPr><w:r>' + runProps +
      '<w:t xml:space="preserve">' + xmlEsc(line) + '</w:t></w:r></w:p>';
  }).join('');

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + paras +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>' +
    '</w:body></w:document>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  return zipStore([
    { name:'[Content_Types].xml', body: contentTypes },
    { name:'_rels/.rels',         body: rels },
    { name:'word/document.xml',   body: document },
  ]);
}

let downloadsNs = null, downloadsTried = false;
async function ensureDownloads(){
  if(downloadsTried) return downloadsNs;
  downloadsTried = true;
  try{ downloadsNs = window.claude ? await window.claude.use('downloads') : null; }
  catch(e){ downloadsNs = null; }
  return downloadsNs;
}

let draftTab = 'resume';

function openDraft(rowId, tab){
  const d = draftFor(rowId);
  if(!d) return;
  draftTab = tab || 'resume';
  const title = (d.company || 'Application') + (d.role ? ' · ' + d.role : '');
  const text = draftTab === 'cover' ? d.cover : draftTab === 'gaps' ? d.gaps : d.resume;
  openModal(title, `
    <div class="draft-tabs">
      <button class="ink-btn ${draftTab==='resume'?'on':''}" onclick="openDraft('${rowId}','resume')">Résumé</button>
      <button class="ink-btn ${draftTab==='cover'?'on':''}" onclick="openDraft('${rowId}','cover')">Cover letter</button>
      <button class="ink-btn ${draftTab==='gaps'?'on':''}" onclick="openDraft('${rowId}','gaps')">Gaps</button>
    </div>
    <pre class="draft-text" id="draft-text">${esc(text || '(empty)')}</pre>
    <div class="row" style="flex-wrap:wrap;">
      <button class="btn btn-sm btn-primary" onclick="saveDraftFile('${rowId}','docx')">Download .docx</button>
      <button class="btn btn-sm" onclick="saveDraftFile('${rowId}','txt')">.txt</button>
      <button class="btn btn-sm" onclick="copyDraft()">Copy</button>
      <button class="btn btn-sm btn-ghost" onclick="closeModal()">Close</button>
    </div>`, true);
}
async function copyDraft(){
  const el = document.getElementById('draft-text');
  if(!el) return;
  try{
    await navigator.clipboard.writeText(el.textContent || '');
    toast('Copied');
  }catch(e){
    const r = document.createRange(); r.selectNodeContents(el);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    toast('Selected — press ⌘C');
  }
}
async function saveDraftFile(rowId, fmt){
  const d = draftFor(rowId); if(!d) return;
  const text = draftTab === 'cover' ? d.cover : draftTab === 'gaps' ? d.gaps : d.resume;
  if(!text){ toast('Nothing to save on this tab'); return; }
  const stem = ((d.company || 'application') + '-' + draftTab)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = stem + '.' + (fmt === 'docx' ? 'docx' : 'txt');
  const data = fmt === 'docx'
    ? new Blob([buildDocx(text)], { type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    : text;

  const dl = await ensureDownloads();
  if(dl){
    try{
      await dl.save({ filename, data });
      toast('Saved ' + filename);
    }catch(e){
      const code = e && e.code;
      if(code === 'declined') return;                      // he said no; say nothing
      if(code === 'rate_limited') toast('One download at a time — try again in a second');
      else toast('Could not save that file' + (code ? ' (' + code + ')' : ''));
    }
    return;
  }
  // running the page yourself: the ordinary browser save still works
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type:'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function hydrate(type, data){
  const d = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : {};
  const withIds = arr => (Array.isArray(arr) ? arr : []).map(x => {
    const o = (x && typeof x === 'object') ? Object.assign({}, x) : { text: String(x) };
    o.id = o.id || uid();
    return o;
  });
  if(type === 'checklist'){ d.items = withIds(d.items).map(i => ({ id:i.id, text: String(i.text != null ? i.text : (i.label||'')), done: !!i.done })); }
  else if(type === 'progress'){ d.items = withIds(d.items).map(i => ({ id:i.id, label: String(i.label != null ? i.label : (i.text||'')), pct: clamp(Math.round(Number(i.pct)||0),0,100) })); }
  else if(type === 'habit'){ d.items = withIds(d.items).map(i => ({ id:i.id, name: String(i.name != null ? i.name : (i.text||i.label||'')), completions: i.completions || {} })); }
  else if(type === 'dates'){ d.items = withIds(d.items).map(i => ({ id:i.id, label: String(i.label != null ? i.label : (i.text||'')), date: String(i.date||todayStr()) })); }
  else if(type === 'links'){ d.items = withIds(d.items).map(i => ({ id:i.id, label: String(i.label||i.url||''), url: String(i.url||'') })); }
  else if(type === 'jobs'){
    d.resume = String(d.resume || '');
    d.resumeFile = String(d.resumeFile || '');
    d.rows = withIds(d.rows).map(r => ({
      id: r.id,
      company: String(r.company != null ? r.company : (r.label || r.text || '')),
      url: String(r.url || r.link || ''),
      jd: String(r.jd || ''),
      role: String(r.role || ''),
    })).slice(0, 40);
  }
  else if(type === 'sticky'){
    const tones = Object.keys(STICKY_TONES);
    d.items = withIds(d.items).map((i, n) => ({ id:i.id, text: String(i.text != null ? i.text : (i.label||'')),
      tone: STICKY_TONES[i.tone] ? i.tone : tones[n % tones.length] }));
  }
  else if(type === 'table'){
    d.columns = Array.isArray(d.columns) && d.columns.length ? d.columns.map(String) : ['Item','Value'];
    d.rows = (Array.isArray(d.rows) ? d.rows : []).map(r => Array.isArray(r) ? r.map(v => String(v == null ? '' : v))
      : d.columns.map(c => String(r && r[c] != null ? r[c] : '')));
  }
  else if(type === 'notes'){ d.text = String(d.text || d.body || ''); }
  else if(type === 'metric'){ d.value = d.value == null ? '' : d.value; d.label = String(d.label||''); d.unit = String(d.unit||''); d.target = (d.target === '' || d.target == null) ? null : d.target; }
  return d;
}

function systemPrompt(){
  return [
    'You are Cosmo, the assistant that runs Andrew\'s personal hub — a bubble app where you are the centre bubble, his to-dos and reminders live in a list in the top bar, and every other bubble is a section of his life (School, Work, Finance, whatever he adds).',
    'You are Claude, working inside his hub: you reason, give opinions, push back when something looks off, and you can actually operate the app through your tools — create and delete sections, design a section\'s panels, fill panels with content, add to-dos and reminders, and pin important info.',
    'Designing is the headline feature: when he asks you to build or lay out a section, call readSection first if it already has panels, then designSection with a complete, opinionated layout using the panel types that genuinely fit what that part of his life needs. Choose sizes deliberately (lg for tables and anything wide, sm for single numbers). Seed the panels with sensible starting content where you can, and say in one line what you built and why.',
    'Be direct and warm; short answers unless he wants depth. Offer your actual opinion rather than a list of options. Never invent facts about his life — read the hub first.',
    'He can attach photos, PDFs, Word docs and text files. Look at images directly when they reach you. Some viewers cannot pass a picture through at all — in that case the page reads the text off it for you and includes it under his message as "Text read from the image". That OCR text IS the screenshot: work from it and never tell him nothing came through when it is there. It is reliable for screenshots but can garble odd characters, so sanity-check figures that look wrong rather than inventing them.',
    webOn
      ? 'You have live web access: searchWeb looks things up on the internet and readWebPage fetches a specific URL. Use them whenever the answer depends on current facts you cannot be sure of, and whenever he shares a link — read it rather than guessing. Cite the source briefly (site name) when you use what you found, and say plainly if a search turns up nothing useful.'
      : 'You have no internet access in this view and cannot open links — if he shares a URL, ask him to paste the text or attach the file instead of guessing.',
    'Today is ' + todayStr() + '.',
  ].join(' ');
}

let pendingNotice = null;
/* One call, with graceful degradation: if this view turns out not to support images or
   page tools, drop just that part and send again rather than failing the whole message. */
async function callSample(turns, opts){
  try{
    return await sampleFn(turns, opts);
  }catch(e){
    const code = e && e.code;
    if(code === 'images_unavailable' && opts.images){
      actStep('Images are not supported here — sending the text on its own');
      pendingNotice = 'This viewer cannot pass the picture itself to Claude — but the text read off it was sent, so Cosmo can still work from it.';
      const next = Object.assign({}, opts); delete next.images;
      next.signal = (chatAbort = new AbortController()).signal;
      return await sampleFn(turns, next);
    }
    if(code === 'tools_unavailable' && opts.tools){
      actStep('Page tools unavailable — answering without them');
      const next = Object.assign({}, opts); delete next.tools; next.cache = false;
      next.signal = (chatAbort = new AbortController()).signal;
      return await sampleFn(turns, next);
    }
    throw e;
  }
}
function byteLen(s){ try{ return new Blob([s]).size; }catch(e){ return String(s).length; } }
function trimTurns(turns, maxBytes){
  let total = turns.reduce((n,t) => n + byteLen(t.content), 0);
  // drop the oldest history turns first; never drop the instructions turn (0) or the newest (last)
  while(total > maxBytes && turns.length > 2){
    total -= byteLen(turns[1].content);
    turns.splice(1, 1);
  }
  return turns;
}
function errorCopy(e){
  const code = e && e.code;
  if(code === 'not_granted') return 'You have not allowed this page to use Claude yet — reload and choose Allow when it asks.';
  if(code === 'rate_limited') return 'That hit your Claude usage limit for now. Wait a few minutes and try again.';
  if(code === 'prompt_too_large') return 'That was too much for one message — I trimmed the history, try sending it again.';
  if(code === 'session_expired') return 'Your Claude session expired. Refresh the page and sign in again.';
  if(code === 'refused') return 'Claude would not answer that one. Try rephrasing it.';
  if(code === 'empty_completion') return 'Claude came back with nothing. Try asking for a bit less at once.';
  if(code === 'invalid_request') return 'Cosmo sent a malformed request. Try again — if it keeps happening, tell Claude in the main chat.';
  if(code === 'sampling_disabled' || code === 'not_declared') return 'Claude is not available for this page right now.';
  return 'Something went wrong' + (code ? ' (' + code + ')' : '') + ' — try again.';
}

async function sendChat(){
  if(DEMO) return demoSend();
  if(chatBusy || !sampleFn) return;
  const input = document.getElementById('chat-input');
  const text = (input.value || '').trim();
  const images = pendingImages.slice(), files = pendingFiles.slice();
  if(!text && !images.length && !files.length) return;
  input.value = ''; input.style.height = 'auto';
  pendingImages = []; pendingFiles = []; renderPending();

  // lock FIRST, and make absolutely sure it is released no matter what happens below
  chatBusy = true;
  setSendMode(true);
  document.getElementById('helper-bubble').classList.add('busy');
  actStart();

  const body = document.getElementById('chat-body');
  let workingEl = null, streamEl = null, failure = null, orphanReply = null;

  try{
    const attachments = images.map(i => ({ name: i.label || i.file.name, kind:'image' })).concat(files.map(f => ({ name: f.name, kind: f.kind })));
    const names = attachments.map(a => a.name);
    const shown = text || (names.length ? 'Sent ' + names.join(', ') : '');

    let msgId = null;
    try{
      const added = await cols.chat.add({ role:'user', content: shown, attachments, createdAt: Date.now() });
      msgId = added.id;
      images.forEach(i => { attThumbs[msgId + ':' + (i.label || i.file.name)] = i.url; });
    }catch(e){ console.error('could not save your message', e); }
    renderChat();

    workingEl = document.createElement('div');
    workingEl.className = 'working'; workingEl.id = 'chat-working';
    body.appendChild(workingEl); body.scrollTop = body.scrollHeight;
    renderActivity();

    // Build the conversation deterministically. The database snapshot can lag,
    // so the turn we just sent is appended explicitly and must be the last turn.
    const prior = state.chat
      .filter(m => m.id !== msgId && m.content)
      .sort((a,b) => (a.createdAt||0)-(b.createdAt||0))
      .slice(-14)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
    while(prior.length && prior[prior.length-1].role === 'assistant' && prior[prior.length-1].content === '') prior.pop();

    let mine = shown;
    if(files.length){
      mine += '\n\n' + files.map(f => '[Attached file: ' + f.name + ']\n' + f.content + (f.truncated ? '\n[...truncated]' : '')).join('\n\n');
    }
    if(images.length){
      const pending = images.filter(i => i.ocr && !i.ocrDone);
      if(pending.length){
        const step = actStep('Reading the text off ' + (pending.length === 1 ? 'the screenshot' : pending.length + ' images'));
        try{ await Promise.all(images.map(i => i.ocr)); }catch(e){}
        actDone(step);
      }
      const read = images.filter(i => ocrIsUseful(i.ocrText));
      if(read.length){
        mine += '\n\n' + read.map(i =>
          '[Text read from the image "' + (i.label || i.file.name) + '" by automatic OCR — reliable for screenshots, but check unusual characters]\n'
          + i.ocrText.slice(0, 4000)).join('\n\n');
      }
    }
    mine += '\n\n[Current hub state]\n' + hubSnapshot().slice(0, 6000);

    const turns = trimTurns(
      [{ role:'user', content: systemPrompt() }].concat(prior, [{ role:'user', content: mine }]),
      50000
    );

    chatAbort = new AbortController();
    const opts = {
      signal: chatAbort.signal,
      modelTier: 'default',
      onText: ({ text: whole }) => {
        if(!streamEl){
          streamEl = document.createElement('div');
          streamEl.className = 'msg assistant';
          body.insertBefore(streamEl, workingEl);
        }
        streamEl.textContent = whole;
        actSet('Writing the reply');
        body.scrollTop = body.scrollHeight;
      },
    };
    if(images.length) opts.images = images.map(i => i.file);
    const toolsUsable = !sampleCaps || sampleCaps.tools;   // unknown means try, do not assume no
    if(toolsUsable) opts.tools = instrument(allTools()); else opts.cache = false;

    lastCall = { turns, images: images.map(i => i.file), hasTools: toolsUsable };

    const res = await callSample(turns, opts);
    try{ await cols.chat.add({ role:'assistant', content: res.text, createdAt: Date.now() }); }
    catch(e){ orphanReply = res.text; console.error('could not save the reply', e); }
    actEnd('Done');
  }catch(e){
    if(e && e.code === 'cancelled'){
      actEnd('Stopped');
    } else {
      actEnd('Hit a problem');
      failure = errorCopy(e);
      console.error('helper call failed', e);
    }
  }finally{
    chatBusy = false;
    setSendMode(false);
    document.getElementById('helper-bubble').classList.remove('busy');
    chatAbort = null;
    if(workingEl) workingEl.remove();
    renderChat();
    if(orphanReply) showOrphanReply(orphanReply);
    if(pendingNotice){ notice(pendingNotice, true); pendingNotice = null; }
    if(failure) showFailure(failure);
  }
}

async function retryLast(){
  if(chatBusy || !sampleFn || !lastCall) return;
  chatBusy = true;
  setSendMode(true);
  document.getElementById('helper-bubble').classList.add('busy');
  actStart();
  const body = document.getElementById('chat-body');
  let workingEl = document.createElement('div');
  workingEl.className = 'working'; workingEl.id = 'chat-working';
  body.appendChild(workingEl); renderActivity();
  let streamEl = null, failure = null, orphanReply = null;
  try{
    chatAbort = new AbortController();
    const opts = {
      signal: chatAbort.signal, modelTier:'default',
      onText: ({ text: whole }) => {
        if(!streamEl){ streamEl = document.createElement('div'); streamEl.className = 'msg assistant'; body.insertBefore(streamEl, workingEl); }
        streamEl.textContent = whole; actSet('Writing the reply'); body.scrollTop = body.scrollHeight;
      },
    };
    if(lastCall.images && lastCall.images.length) opts.images = lastCall.images;
    if(lastCall.hasTools) opts.tools = instrument(allTools()); else opts.cache = false;
    const res = await callSample(lastCall.turns, opts);
    try{ await cols.chat.add({ role:'assistant', content: res.text, createdAt: Date.now() }); }
    catch(e){ orphanReply = res.text; }
    actEnd('Done');
  }catch(e){
    if(e && e.code === 'cancelled'){ actEnd('Stopped'); }
    else { actEnd('Hit a problem'); failure = errorCopy(e); }
  }finally{
    chatBusy = false;
    setSendMode(false);
    document.getElementById('helper-bubble').classList.remove('busy');
    chatAbort = null;
    if(workingEl) workingEl.remove();
    renderChat();
    if(orphanReply) showOrphanReply(orphanReply);
    if(pendingNotice){ notice(pendingNotice, true); pendingNotice = null; }
    if(failure) showFailure(failure);
  }
}

/* a short unprompted thought from the helper */
async function think(force){
  if(!sampleFn || thoughtBusy) return;
  if(!force && thoughtDone) return;
  if(!state.bubbles.length && !state.tasks.length) return;
  if(!force){
    // one unprompted thought per tab session, so reloading does not keep spending usage
    try{ if(sessionStorage.getItem('wf_thought')) { thoughtDone = true; return; } }catch(e){}
  }
  thoughtBusy = true; thoughtDone = true;
  try{ sessionStorage.setItem('wf_thought', '1'); }catch(e){}
  document.getElementById('helper-bubble').classList.add('busy');
  try{
    const prompt = 'You are Cosmo, the assistant inside Andrew\'s personal life hub. Here is its current state:\n\n' + hubSnapshot() +
      '\n\nIn ONE short sentence (max 22 words), say the single most useful thing you notice right now — something due, something neglected, or a concrete suggestion. No greeting, no preamble, no quotes.';
    const res = await sampleFn(prompt, { modelTier:'quick', cache: force ? { gcTime: 600000, refresh: true } : { gcTime: 600000 } });
    showThought(res.text.trim());
  }catch(e){ /* stay quiet if the helper cannot speak */ }
  finally{ thoughtBusy = false; document.getElementById('helper-bubble').classList.remove('busy'); }
}
function showThought(text){
  if(!text) return;
  document.getElementById('thought-text').textContent = text;
  document.getElementById('thought').hidden = act.on;   // stay out of the way while it is working
}
function hideThought(){ document.getElementById('thought').hidden = true; }

/* ============ render ============ */
/* the to-dos button in the top bar: how many are due now, or how many are open */
function renderTodoBadge(){
  const dot = document.getElementById('todo-count');
  if(!dot) return;
  const open = openTasks();
  const due = open.filter(t => t.due && daysUntil(t.due) <= 0).length;
  dot.textContent = open.length;
  dot.hidden = !open.length;
  dot.style.background = 'var(--text-muted)';
  document.getElementById('todo-btn').title = open.length
    ? 'To-dos & reminders: ' + open.length + ' open' + (due ? ', ' + due + ' due now' : '') : 'To-dos & reminders';
}
function render(){
  document.documentElement.classList.toggle('hub-mode', view === 'hub');   // locks the page scroll on the hub
  if(view === 'hub') renderHub(); else renderSection();
  scheduleMinimap();
  renderTodoBadge();
  renderImportant();
  renderTrash();
  if(document.getElementById('tasks-sheet').classList.contains('open')) renderTasks();
}

/* A redesign that only new users see is invisible to the one person actually
   using this, so move him onto the new default once. The flag key changes with
   each redesign; the old keys stay set so a past adoption never replays. */
async function adoptNewLookOnce(){
  const flag = await cols.meta.getOne('skin_clarity2');
  if(flag) return;
  await cols.meta.set('skin_clarity2', { at: Date.now() });
  look = Object.assign({}, look, { theme:DEFAULT_THEME });
  applyLook(look);
  saveLook();
}

/* ============ migration from the older Wayfinder ============ */
async function migrateOnce(){
  const flag = await cols.meta.getOne('migrated_hub');
  if(flag) return;
  let created = 0;
  if(db){
    const read = async name => { try{ return await dbCollection(name).getAll(); }catch(e){ return []; } };
    const [goals, ideas, events, habits, journal, oldSections] = await Promise.all(
      ['goals','ideas','events','habits','journal','sections'].map(read));

    const mk = async (name, tone, widgets) => { await cols.bubbles.add({ name, tone, widgets, createdAt: Date.now() + (created++) }); };

    if(goals.length) await mk('Goals', 'teal', [ normalizeWidget({ type:'progress', title:'Goals', size:'md',
      data: hydrate('progress', { items: goals.map(g => ({ label: g.title, pct: g.progress || 0 })) }) }) ]);
    if(ideas.length) await mk('Ideas', 'violet', [ normalizeWidget({ type:'checklist', title:'Ideas', size:'md',
      data: hydrate('checklist', { items: ideas.map(i => ({ text: i.title + (i.note ? ' — ' + i.note : '') })) }) }) ]);
    if(events.length) await mk('Calendar', 'blue', [ normalizeWidget({ type:'dates', title:'Dates', size:'md',
      data: hydrate('dates', { items: events.map(e => ({ label: e.title, date: e.date })) }) }) ]);
    if(habits.length) await mk('Habits', 'green', [ normalizeWidget({ type:'habit', title:'Daily habits', size:'md',
      data: hydrate('habit', { items: habits.map(h => ({ name: h.name, completions: h.completions || {} })) }) }) ]);
    if(journal.length) await mk('Journal', 'rose', [ normalizeWidget({ type:'notes', title:'Journal', size:'lg',
      data: { text: journal.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,12)
        .map(j => (j.title ? j.title + '\n' : '') + (j.body||'')).join('\n\n———\n\n') } }) ]);
    for(const s of oldSections){
      await mk(s.name || 'Section', 'amber', [ normalizeWidget({ type:'checklist', title: s.name || 'Items', size:'md',
        data: hydrate('checklist', { items: (s.items||[]).map(i => ({ text: i.text, done: !!i.done })) }) }) ]);
    }
  }
  const have = await cols.bubbles.getAll();
  if(!have.length){
    const seed = [['School','teal'], ['Work','blue'], ['Finance','green'], ['Other','amber']];
    for(const [name, tone] of seed) await cols.bubbles.add({ name, tone, widgets: [], createdAt: Date.now() + (created++) });
  }
  await cols.meta.set('migrated_hub', { at: Date.now() });
}

/* ============ init ============ */
(function bootLook(){
  try{
    /* demo: always open on the default look */
  }catch(e){}
  applyLook(look);
})();

document.getElementById('sec-title').addEventListener('change', function(){ renameSection(this.value); });
document.getElementById('sec-title').addEventListener('keydown', function(e){ if(e.key === 'Enter') this.blur(); });
document.getElementById('chat-input').addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); }
});
document.getElementById('chat-input').addEventListener('input', function(){
  this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});
document.getElementById('helper-bubble').addEventListener('contextmenu', e => { e.preventDefault(); think(true); });
window.addEventListener('resize', () => { if(view === 'hub'){ sizeInkCanvas(); layoutHub(); } });
window.addEventListener('scroll', () => { if(view === 'hub') applyCamera(); }, { passive:true });
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
  if((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'z' && !typing){
    e.preventDefault();
    if(e.shiftKey) doRedo(); else doUndo();
    return;
  }
  if((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'y' && !typing){ e.preventDefault(); doRedo(); return; }
  if(e.key === 'Escape'){ closeModal(); closeHelper(); closeSheet('tasks-sheet'); closeSheet('imp-sheet'); closeSheet('trash-sheet'); closeSheet('settings-sheet'); } });


/* the floating button is gone from view, but everything still marks it busy;
   mirror that onto the middle bubble so Cosmo visibly works */
new MutationObserver(() => {
  const c = document.getElementById('bubble-center');
  if(c) c.classList.toggle('busy', document.getElementById('helper-bubble').classList.contains('busy'));
}).observe(document.getElementById('helper-bubble'), { attributes:true, attributeFilter:['class'] });
