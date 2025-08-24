import ELK from 'elkjs/lib/elk.bundled.js';
import Papa from 'papaparse';
import svgPanZoom from 'svg-pan-zoom';

// ==== BRAND & STATUS =========================================================
const GLOVO_YELLOW = '#FFC244';
const GLOVO_GREEN  = '#00A082';

const STATUS_ORDER = ['pending','wip','blocked','done'];
const STATUS_COLOR = {
  pending:'#9ca3af',
  wip:    GLOVO_YELLOW,
  blocked:'#ef4444',
  done:   GLOVO_GREEN
};
const EDGE_MARKER  = {
  pending: 'url(#arrow-pending)',
  wip:     'url(#arrow-wip)',
  blocked: 'url(#arrow-blocked)',
  done:    'url(#arrow-done)'
};

// ==== BASE URL (GH Pages) & STORAGE KEY =====================================
const BASE = import.meta.env.BASE_URL || '/';
const STORE_KEY = 'lineage-statuses-v1::' + BASE;
const DEFAULTS_URL = `${BASE}lineage-statuses.json`; // <<-- aquí leemos los defaults

// ==== PASSWORD / EDIT LOCK ===================================================
const EDIT_HASH   = import.meta.env.VITE_EDIT_HASH  || null; // SHA-256 hex
const EDIT_PLAIN  = import.meta.env.VITE_EDIT_PLAIN || null; // plain text
const DEFAULT_PLAIN = 'pbutron'; // fallback si no configuras nada

// ==== STATE =================================================================
let graph = { nodes: [], edges: [] };
let statuses = {};         // se carga en boot
let panzoom;
let celebrated = false;    // para el 100%
let canEdit = false;       // 🔒 bloqueado por defecto

// ==== DOM ===================================================================
const svg       = document.getElementById('svg');
const gEdges    = document.getElementById('edges');
const gNodes    = document.getElementById('nodes');
const fileInput = document.getElementById('file');
const impInput  = document.getElementById('imp');
const fileLabel = document.getElementById('file-label');
const impLabel  = document.getElementById('imp-label');

const btnZoomIn  = document.getElementById('zoom-in');
const btnZoomOut = document.getElementById('zoom-out');
const btnFit     = document.getElementById('fit');
const btnReset   = document.getElementById('reset');     // ahora: Reset a defaults
const btnExport  = document.getElementById('btn-export');

const progFill  = document.getElementById('prog-fill');
const progLabel = document.getElementById('prog-label');
const statusBox = document.getElementById('status');

const lockBtn   = document.getElementById('lock-btn');
const lockState = document.getElementById('lock-state');
const modal     = document.getElementById('lock-modal');
const passIn    = document.getElementById('lock-pass');
const lockMsg   = document.getElementById('lock-msg');
const lockCancel= document.getElementById('lock-cancel');
const lockOk    = document.getElementById('lock-confirm');

// Confetti canvas
const fxCanvas = document.getElementById('fx');
const fxCtx    = fxCanvas.getContext('2d');

// ==== UTILS =================================================================
const norm = v => (v == null ? '' : String(v)).trim();

function loadStatuses(){
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch { return {}; }
}
function saveStatuses(obj){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); }
  catch {}
}
function setStatus(msg, ok=true){
  statusBox.textContent = msg;
  statusBox.className = 'status ' + (ok ? 'ok' : 'err');
}

// leer defaults desde /public/lineage-statuses.json
async function loadDefaultStatuses(){
  try{
    const r = await fetch(DEFAULTS_URL, { cache:'no-store' });
    if (!r.ok) return {};
    const txt = await r.text();
    const obj = JSON.parse(txt);
    return (obj && typeof obj === 'object') ? obj : {};
  }catch(_){ return {}; }
}

// Medida de texto para tamaño de nodos
const measureCanvas = document.createElement('canvas');
const ctx = measureCanvas.getContext('2d');
ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
function measureTextSize(text){
  const m = ctx.measureText(text);
  const w = Math.max(8, Math.ceil(m.width));
  const h = 16; // aprox
  const padX = 12, padY = 8;
  return { width: w + padX*2, height: h + padY*2 };
}

// SHA-256 helper (para EDIT_HASH)
async function sha256Hex(s){
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ==== PROGRESO ==============================================================
function updateProgress(){
  const total = graph.nodes.length || 0;
  const done  = graph.nodes.reduce((acc,n)=> acc + ((statuses[n.id]||'pending') === 'done' ? 1 : 0), 0);
  const pct   = total ? Math.round(done*100/total) : 0;
  progFill.style.width = pct + '%';
  progFill.style.background = (pct === 100 ? GLOVO_GREEN : GLOVO_YELLOW);
  progLabel.textContent = `Done ${pct}%`;

  if (pct === 100 && !celebrated){
    celebrated = true;
    progFill.classList.add('is-complete');
    celebrateBig();
  } else if (pct < 100){
    celebrated = false;
    progFill.classList.remove('is-complete');
  }
}

// ==== CSV -> GRAPH ==========================================================
function pickHeader(headers, wanted){
  const lc = wanted.toLowerCase();
  return headers.find(h => (h||'').toLowerCase() === lc) || null;
}
function fromCsv(rows){
  if (!rows || !rows.length) return { nodes:[], edges:[] };
  const headers = Object.keys(rows[0] || {});
  const fcol = pickHeader(headers,'from') || headers[0];
  const tcol = pickHeader(headers,'to')   || headers[1] || headers[0];

  const nodesSet = new Set();
  const edges = [];
  const seenE = new Set();

  for (const r of rows){
    const fr = norm(r[fcol]), to = norm(r[tcol]);
    if (!fr || !to) continue;
    nodesSet.add(fr); nodesSet.add(to);
    const id = `${fr}→${to}`;
    if (!seenE.has(id)){ seenE.add(id); edges.push({ id, source: fr, target: to }); }
  }
  const nodes = Array.from(nodesSet).map(id => ({ id, label:id }));
  return { nodes, edges };
}

// ==== LAYOUT & RENDER (ELK + SVG) ===========================================
async function layoutAndRender(){
  try{
    const elk = new ELK();
    const elkGraph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': '60',
        'elk.spacing.nodeNode': '28',
        'elk.portAlignment.default': 'CENTER'
      },
      children: graph.nodes.map(n => {
        const size = measureTextSize(n.label);
        return { id: n.id, width: size.width, height: size.height };
      }),
      edges: graph.edges.map(e => ({ id: e.id, sources: [e.source], targets: [e.target] }))
    };

    const res = await elk.layout(elkGraph);

    // limpiar
    gEdges.innerHTML = '';
    gNodes.innerHTML = '';

    // Edges
    const edgePathById = new Map();
    for (const e of res.edges){
      const sec = e.sections?.[0]; if (!sec) continue;
      const pts = [
        {x:sec.startPoint.x, y:sec.startPoint.y},
        ...(sec.bendPoints || []),
        {x:sec.endPoint.x, y:sec.endPoint.y}
      ];
      const d = pts.map((p,i)=> (i===0?`M ${p.x} ${p.y}`:`L ${p.x} ${p.y}`)).join(' ');
      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d', d);
      const srcId = e.sources[0];
      const s = statuses[srcId] || 'pending';
      path.setAttribute('stroke', STATUS_COLOR[s] || STATUS_COLOR.pending);
      path.setAttribute('stroke-width', '1.3');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', EDGE_MARKER[s] || EDGE_MARKER.pending);
      gEdges.appendChild(path);
      edgePathById.set(e.id, path);
    }

    // Nodes
    for (const n of res.children){
      const st = (statuses[n.id] || 'pending');
      const color = STATUS_COLOR[st] || STATUS_COLOR.pending;

      const g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.style.cursor = 'pointer';

      const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      rect.setAttribute('rx','8'); rect.setAttribute('ry','8');
      rect.setAttribute('x','0'); rect.setAttribute('y','0');
      rect.setAttribute('width', String(n.width));
      rect.setAttribute('height',String(n.height));
      rect.setAttribute('fill', color);
      rect.setAttribute('stroke','#d1d5db');
      rect.setAttribute('stroke-width','1');
      rect.setAttribute('filter','url(#nodeShadow)');

      const text = document.createElementNS('http://www.w3.org/2000/svg','text');
      text.setAttribute('x', String(n.width/2));
      text.setAttribute('y', String(n.height/2));
      text.setAttribute('text-anchor','middle');
      text.setAttribute('dominant-baseline','middle');
      text.setAttribute('font-size','12');
      text.setAttribute('fill','#111827');
      text.textContent = n.id;

      g.appendChild(rect); g.appendChild(text);
      gNodes.appendChild(g);

      // hover
      g.addEventListener('mouseenter', ()=> rect.setAttribute('stroke', '#94a3b8'));
      g.addEventListener('mouseleave', ()=> rect.setAttribute('stroke', '#d1d5db'));

      // click -> ciclo de estado
      g.addEventListener('click', () => {
        if (!canEdit){ setStatus('Read-only. Click "Unlock" to enable editing.', false); return; }
        const prev = (statuses[n.id] || 'pending');
        const nxt  = STATUS_ORDER[(STATUS_ORDER.indexOf(prev)+1) % STATUS_ORDER.length];
        statuses[n.id] = nxt;

        // nodo
        rect.setAttribute('fill', STATUS_COLOR[nxt] || STATUS_COLOR.pending);

        // edges desde este nodo
        for (const e of graph.edges){
          if (e.source === n.id){
            const p = edgePathById.get(e.id);
            if (p){
              p.setAttribute('stroke', STATUS_COLOR[nxt] || STATUS_COLOR.pending);
              p.setAttribute('marker-end', EDGE_MARKER[nxt] || EDGE_MARKER.pending);
            }
          }
        }

        // confeti pequeño cuando pasa a done
        if (prev !== 'done' && nxt === 'done') celebrateSmall();

        saveStatuses(statuses);
        updateProgress();
      });
    }

    // Pan/Zoom
    if (panzoom) panzoom.destroy();
    panzoom = svgPanZoom(svg, {
      zoomEnabled: true,
      controlIconsEnabled: false,
      fit: true, center: true,
      minZoom: 0.2, maxZoom: 10,
      dblClickZoomEnabled: false,
      preventMouseEventsDefault: true
    });
    panzoom.fit(); panzoom.center();

    sizeFxToCanvas();
    setStatus(`Loaded ${graph.nodes.length} nodes · ${graph.edges.length} edges`, true);
    updateProgress();
  }catch(err){
    console.error(err);
    setStatus(`Layout/render error: ${err.message}`, false);
  }
}

// ==== CONTROLES ==============================================================
btnZoomIn.onclick  = () => panzoom && panzoom.zoomBy(1.2);
btnZoomOut.onclick = () => panzoom && panzoom.zoomBy(0.85);
btnFit.onclick     = () => panzoom && (panzoom.fit(), panzoom.center());

// RESET: ahora vuelve a los defaults (no a gris)
btnReset.onclick = async () => {
  if (!canEdit){ setStatus('Read-only. Unlock to reset.', false); return; }
  const defs = await loadDefaultStatuses();
  statuses = { ...(defs || {}) };   // reset a defaults
  saveStatuses(statuses);
  await layoutAndRender();
  setStatus('Statuses reset to defaults', true);
};

btnExport.onclick = () => {
  if (!canEdit){ setStatus('Read-only. Unlock to export.', false); return; }
  const blob = new Blob([JSON.stringify(statuses, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lineage-statuses.json';
  a.click();
  URL.revokeObjectURL(a.href);
};

impInput.onchange = async () => {
  if (!canEdit){ setStatus('Read-only. Unlock to import.', false); impInput.value=''; return; }
  const f = impInput.files?.[0]; if (!f) return;
  try{
    const txt = await f.text();
    const obj = JSON.parse(txt);
    statuses = obj || {};
    saveStatuses(statuses);
    await layoutAndRender();
    setStatus('Statuses imported', true);
  }catch(err){
    setStatus('Invalid JSON: ' + err.message, false);
  }finally{
    impInput.value = '';
  }
};

fileInput.onchange = async () => {
  if (!canEdit){ setStatus('Read-only. Unlock to upload.', false); fileInput.value=''; return; }
  const f = fileInput.files?.[0]; if (!f) return;
  Papa.parse(f, {
    header: true,
    skipEmptyLines: true,
    complete: async (res) => {
      graph = fromCsv(res.data);
      await layoutAndRender();
    },
    error: (err) => setStatus('CSV error: ' + err.message, false)
  });
  fileInput.value = '';
};

// ==== BOOT (autoload CSV + defaults + localStorage) ==========================
(async function boot(){
  try{
    // 1) CSV
    const r = await fetch(`${BASE}lineage.csv?ts=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('CSV not found');
    const text = await r.text();
    const parsed = Papa.parse(text, { header:true, skipEmptyLines:true });
    graph = fromCsv(parsed.data);

    // 2) defaults + local
    const defs = await loadDefaultStatuses();
    const saved = loadStatuses();
    statuses = Object.keys(saved).length ? saved : (defs || {});
    saveStatuses(statuses); // asegura persistencia tras primer boot

    await layoutAndRender();
    setStatus('Ready', true);
  }catch(_){
    setStatus('Ready. Upload a CSV to render.', true);
  }
  updateEditUI();
})();

// ==== EDIT LOCK / UNLOCK =====================================================
function updateEditUI(){
  lockState.textContent = canEdit ? 'Edit mode' : 'Read-only';
  lockBtn.textContent   = canEdit ? '🔓 Lock' : '🔒 Unlock';

  btnExport.disabled = !canEdit;
  btnReset.disabled  = !canEdit;

  if (canEdit){
    fileLabel.classList.remove('disabled');
    impLabel.classList.remove('disabled');
  } else {
    fileLabel.classList.add('disabled');
    impLabel.classList.add('disabled');
  }
}

lockBtn.onclick = () => {
  if (canEdit){
    canEdit = false;
    updateEditUI();
    setStatus('Locked. Read-only.', true);
    return;
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden','false');
  lockMsg.textContent = '';
  passIn.value = '';
  passIn.focus();
};
lockCancel.onclick = closeModal;
function closeModal(){
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden','true');
  lockMsg.textContent = '';
  passIn.value = '';
}
passIn.addEventListener('keydown', (e)=>{ if(e.key==='Enter') lockOk.click(); });
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !modal.classList.contains('hidden')) closeModal(); });

lockOk.onclick = async () => {
  const pwd = passIn.value || '';
  try{
    if (EDIT_HASH){
      const hex = await sha256Hex(pwd);
      if (hex !== EDIT_HASH) throw new Error('Wrong password');
    } else if (EDIT_PLAIN){
      if (pwd !== EDIT_PLAIN) throw new Error('Wrong password');
    } else {
      if (pwd !== DEFAULT_PLAIN) throw new Error('Wrong password');
    }
    canEdit = true;
    updateEditUI();
    setStatus('Unlocked. Edit mode enabled.', true);
    closeModal();
  }catch(_){
    lockMsg.textContent = 'Incorrect password.';
  }
};

// ==== CONFETTI ==============================================================
// Resize canvas to container
function sizeFxToCanvas(){
  const dpr = window.devicePixelRatio || 1;
  const rect = fxCanvas.getBoundingClientRect();
  fxCanvas.width  = Math.floor(rect.width * dpr);
  fxCanvas.height = Math.floor(rect.height * dpr);
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', sizeFxToCanvas, { passive:true });

function confetti({duration=1200, count=120} = {}){
  sizeFxToCanvas();
  const W = fxCanvas.clientWidth, H = fxCanvas.clientHeight;
  const colors = [GLOVO_YELLOW, GLOVO_GREEN, '#ef4444', '#60a5fa'];
  const N = Math.min(count, Math.floor((W*H)/12000));

  const parts = Array.from({length:N}).map(()=>({
    x: Math.random()*W,
    y: -10 - Math.random()*H*0.2,
    vx: (Math.random()-0.5)*1.5,
    vy: 1.8 + Math.random()*2.8,
    size: 3 + Math.random()*4,
    rot: Math.random()*Math.PI,
    vr: (Math.random()-0.5)*0.22,
    color: colors[(Math.random()*colors.length)|0],
  }));

  const start = performance.now();
  (function tick(now){
    const t = now - start;
    fxCtx.clearRect(0,0,W,H);
    for (const p of parts){
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      fxCtx.save();
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.rot);
      fxCtx.fillStyle = p.color;
      fxCtx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
      fxCtx.restore();
    }
    if (t < duration){ requestAnimationFrame(tick); }
    else fxCtx.clearRect(0,0,W,H);
  })(performance.now());
}

function celebrateSmall(){ confetti({ duration: 900,  count: 90  }); }
function celebrateBig(){   confetti({ duration: 1800, count: 220 }); }
