import ELK from 'elkjs/lib/elk.bundled.js';
import Papa from 'papaparse';
import svgPanZoom from 'svg-pan-zoom';

// ==== COLORS & STATUS ========================================================
const GREEN     = '#00A082';  // Ready (SoT)
const ORANGE    = '#F97316';  // Implemented
const YELLOW    = '#FFC244';  // Implemented & Reconciled
const GRAY      = '#9CA3AF';  // Pending
const RED_DARK  = '#7F1D1D';  // Blocked

// Keys + etiquetas visibles (Capitalizadas)
const STATUS_KEYS  = ['pending','implemented','implemented_reconciled','blocked','ready'];
const STATUS_LABEL = {
  pending: 'Pending',
  implemented: 'Implemented',
  implemented_reconciled: 'Implemented & Reconciled',
  blocked: 'Blocked',
  ready: 'Ready (SoT)'
};
// Orden de ciclo
const STATUS_ORDER = ['pending','implemented','implemented_reconciled','blocked','ready'];

// Colores por estado
const STATUS_COLOR = {
  pending: GRAY,
  implemented: ORANGE,
  implemented_reconciled: YELLOW,
  blocked: RED_DARK,
  ready: GREEN
};

// Marcadores de flecha
const EDGE_MARKER  = {
  pending: 'url(#arrow-pending)',
  implemented: 'url(#arrow-implemented)',
  implemented_reconciled: 'url(#arrow-implemented_reconciled)',
  blocked: 'url(#arrow-blocked)',
  ready: 'url(#arrow-ready)'
};

// ==== BASE URL (sin Vite) & STORAGE KEY =====================================
// Deducción robusta del "base" del repo en GitHub Pages (p.ej. /pnl-lineage-view/)
const BASE = (() => {
  try {
    const p = window.location.pathname;
    // si termina en /index.html -> recorta hasta la carpeta
    if (p.endsWith('.html')) return p.replace(/\/[^\/]*$/, '/') ;
    // asegura que termina en '/'
    return p.endsWith('/') ? p : (p.substring(0, p.lastIndexOf('/') + 1));
  } catch { return '/'; }
})();

// NOTA: sube la versión si quieres “empezar de cero” sin limpiar storage
const STORE_KEY = 'lineage-statuses-v3::' + BASE;

// defaults desde raíz del repo (no en /public)
const DEFAULTS_URL = `${BASE}lineage-statuses.json`;

// ==== PASSWORD / EDIT LOCK ===================================================
const DEFAULT_PLAIN = 'key';

// ==== STATE =================================================================
let graph = { nodes: [], edges: [] };
let statuses = {};
let panzoom;
let celebrated = false;
let canEdit = false;
let resizeBound = false; // evita duplicar listeners de resize

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
const btnReset   = document.getElementById('reset');
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

// Migración desde estados antiguos a los nuevos
function migrateOldStatuses(obj){
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k,vRaw] of Object.entries(obj)){
    const v = norm(vRaw).toLowerCase();
    let mapped;
    switch (v) {
      case 'pending':
      case 'todo':              mapped = 'pending'; break;
      case 'wip':
      case 'implemented':       mapped = 'implemented'; break;
      case 'reconciled':
      case 'implemented & reconciled':
      case 'implemented_reconciled':
                                 mapped = 'implemented_reconciled'; break;
      case 'done':
      case 'confident':
      case 'ready':
      case 'ready (sot)':       mapped = 'ready'; break;
      case 'blocked':           mapped = 'blocked'; break;
      default:                  mapped = 'pending';
    }
    out[k] = mapped;
  }
  return out;
}

// Defaults desde /lineage-statuses.json
async function loadDefaultStatuses(){
  try{
    const r = await fetch(DEFAULTS_URL, { cache:'no-store' });
    if (!r.ok) return {};
    const obj = JSON.parse(await r.text());
    return migrateOldStatuses(obj);
  }catch{ return {}; }
}

// Medida de texto para tamaño de nodos
const measureCanvas = document.createElement('canvas');
const ctx = measureCanvas.getContext('2d');
ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
function measureTextSize(text){
  const m = ctx.measureText(text);
  const w = Math.max(8, Math.ceil(m.width));
  const h = 16;
  const padX = 12, padY = 8;
  return { width: w + padX*2, height: h + padY*2 };
}

// ==== PROGRESO (solo Ready/verde) ===========================================
function updateProgress(){
  const total = graph.nodes.length || 0;
  const ready = graph.nodes.reduce((acc,n)=> acc + ((statuses[n.id]||'pending') === 'ready' ? 1 : 0), 0);
  const pct   = total ? Math.round(ready*100/total) : 0;
  progFill.style.width = pct + '%';
  progFill.style.background = (pct === 100 ? GREEN : YELLOW);
  progLabel.textContent = `P&L Progress ${pct}%`;

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
      path.setAttribute('stroke', STATUS_COLOR[s] || GRAY);
      path.setAttribute('stroke-width', '1.3');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', EDGE_MARKER[s] || EDGE_MARKER.pending);
      gEdges.appendChild(path);
      edgePathById.set(e.id, path);
    }

    // Nodes (con borde dorado + glow opcional)
    for (const n of res.children){
      const st = (statuses[n.id] || 'pending');
      const color = STATUS_COLOR[st] || GRAY;

      const g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.style.cursor = 'pointer';

      // rect base
      const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      rect.setAttribute('rx','8'); rect.setAttribute('ry','8');
      rect.setAttribute('x','0'); rect.setAttribute('y','0');
      rect.setAttribute('width', String(n.width));
      rect.setAttribute('height',String(n.height));
      rect.setAttribute('fill', color);
      rect.setAttribute('stroke','#d1d5db');
      rect.setAttribute('stroke-width','1');
      rect.setAttribute('filter','url(#nodeShadow)');

      // texto
      const text = document.createElementNS('http://www.w3.org/2000/svg','text');
      text.setAttribute('x', String(n.width/2));
      text.setAttribute('y', String(n.height/2));
      text.setAttribute('text-anchor','middle');
      text.setAttribute('dominant-baseline','middle');
      text.setAttribute('font-size','12');
      text.setAttribute('fill', st === 'blocked' ? '#fff' : '#111827');
      text.textContent = n.id;

      g.appendChild(rect);
      g.appendChild(text);
      gNodes.appendChild(g);

      // hover
      g.addEventListener('mouseenter', ()=> rect.setAttribute('stroke', '#94a3b8'));
      g.addEventListener('mouseleave', ()=> rect.setAttribute('stroke', '#d1d5db'));

      // click -> ciclo de estado + actualización edges
      g.addEventListener('click', () => {
        const prev = (statuses[n.id] || 'pending');
        const nxt  = STATUS_ORDER[(STATUS_ORDER.indexOf(prev)+1) % STATUS_ORDER.length];
        statuses[n.id] = nxt;

        // nodo
        rect.setAttribute('fill', STATUS_COLOR[nxt] || GRAY);
        text.setAttribute('fill', nxt === 'blocked' ? '#fff' : '#111827');

        // edges salientes
        for (const e of graph.edges){
          if (e.source === n.id){
            const p = edgePathById.get(e.id);
            if (p){
              p.setAttribute('stroke', STATUS_COLOR[nxt] || GRAY);
              p.setAttribute('marker-end', EDGE_MARKER[nxt] || EDGE_MARKER.pending);
            }
          }
        }

        // confeti cuando pasa a Ready
        if (prev !== 'ready' && nxt === 'ready') celebrateSmall();

        saveStatuses(statuses);
        updateProgress();
      });
    }

    // Ajuste de viewBox al contenido + fit/center
    const edgesBBox = gEdges.getBBox();
    const nodesBBox = gNodes.getBBox();
    const minX = Math.min(edgesBBox.x, nodesBBox.x);
    const minY = Math.min(edgesBBox.y, nodesBBox.y);
    const maxX = Math.max(edgesBBox.x + edgesBBox.width,  nodesBBox.x + nodesBBox.width);
    const maxY = Math.max(edgesBBox.y + edgesBBox.height, nodesBBox.y + nodesBBox.height);
    const pad  = 24;
    svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${(maxX - minX) + pad*2} ${(maxY - minY) + pad*2}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Pan/Zoom
    if (panzoom) panzoom.destroy();
    panzoom = svgPanZoom(svg, {
      zoomEnabled: true,
      controlIconsEnabled: false,
      fit: true,
      center: true,
      minZoom: 0.2, maxZoom: 10,
      dblClickZoomEnabled: false,
      preventMouseEventsDefault: true
    });

    requestAnimationFrame(() => {
      panzoom.updateBBox();
      panzoom.resize();
      panzoom.fit();
      panzoom.center();
    });

    if (!resizeBound){
      window.addEventListener('resize', () => {
        if (!panzoom) return;
        panzoom.updateBBox();
        panzoom.resize();
        panzoom.fit();
        panzoom.center();
        sizeFxToCanvas();
      }, { passive:true });
      resizeBound = true;
    }

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
btnFit.onclick     = () => panzoom && (panzoom.updateBBox(), panzoom.resize(), panzoom.fit(), panzoom.center());

btnReset.onclick = async () => {
  const defs = await loadDefaultStatuses();
  statuses = { ...(defs || {}) };
  saveStatuses(statuses);
  await layoutAndRender();
  setStatus('Statuses reset to defaults', true);
};

btnExport.onclick = () => {
  const blob = new Blob([JSON.stringify(statuses, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lineage-statuses.json';
  a.click();
  URL.revokeObjectURL(a.href);
};

impInput.onchange = async () => {
  const f = impInput.files?.[0]; if (!f) return;
  try{
    const txt = await f.text();
    const obj = JSON.parse(txt);
    statuses = migrateOldStatuses(obj) || {};
    saveStatuses(statuses);
    await layoutAndRender();
    setStatus('Statuses imported', true);
  }catch(err){
    setStatus('Invalid JSON: ' + err.message', false);
  }finally{
    impInput.value = '';
  }
};

fileInput.onchange = async () => {
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
    // 1) CSV desde raíz del repo
    const r = await fetch(`${BASE}lineage.csv?ts=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('CSV not found');
    const text = await r.text();
    const parsed = Papa.parse(text, { header:true, skipEmptyLines:true });
    graph = fromCsv(parsed.data);

    // 2) defaults + local + migración
    const defs = await loadDefaultStatuses();
    const saved = migrateOldStatuses(loadStatuses());
    statuses = Object.keys(saved).length ? saved : (defs || {});
    saveStatuses(statuses);

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
  if (canEdit){ fileLabel.classList.remove('disabled'); impLabel.classList.remove('disabled'); }
  else { fileLabel.classList.add('disabled'); impLabel.classList.add('disabled'); }
}

lockBtn.onclick = () => {
  if (canEdit){
    canEdit = false; updateEditUI(); setStatus('Locked. Read-only.', true); return;
  }
  modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false');
  lockMsg.textContent = ''; passIn.value = ''; passIn.focus();
};
lockCancel.onclick = closeModal;
function closeModal(){
  modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); lockMsg.textContent = ''; passIn.value = '';
}
passIn.addEventListener('keydown', (e)=>{ if(e.key==='Enter') lockOk.click(); });
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !modal.classList.contains('hidden')) closeModal(); });

lockOk.onclick = async () => {
  const pwd = passIn.value || '';
  try{
    if (pwd !== DEFAULT_PLAIN) throw new Error('Wrong password');
    canEdit = true; updateEditUI(); setStatus('Unlocked. Edit mode enabled.', true); closeModal();
  }catch(_){ lockMsg.textContent = 'Incorrect password.'; }
};

// ==== CONFETTI ===============================================================
function sizeFxToCanvas(){
  const dpr = window.devicePixelRatio || 1;
  const rect = fxCanvas.getBoundingClientRect();
  fxCanvas.width  = Math.floor(rect.width * dpr);
  fxCanvas.height = Math.floor(rect.height * dpr);
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', sizeFxToCanvas, { passive:true });

let fxRAF = null;
function confetti({duration=1000, count=100} = {}){
  sizeFxToCanvas();
  const W = fxCanvas.clientWidth, H = fxCanvas.clientHeight;
  const colors = [ORANGE, GREEN, YELLOW, '#60a5fa', GRAY];
  const N = Math.min(count, Math.floor((W*H)/15000));
  const parts = Array.from({length:N}).map(()=>({
    x: Math.random()*W,
    y: -10 - Math.random()*H*0.15,
    vx: (Math.random()-0.5)*1.2,
    vy: 1.6 + Math.random()*2.3,
    size: 3 + Math.random()*4,
    rot: Math.random()*Math.PI,
    vr: (Math.random()-0.5)*0.2,
    color: colors[(Math.random()*colors.length)|0],
  }));

  const start = performance.now();
  const endAt = start + duration;

  if (fxRAF) cancelAnimationFrame(fxRAF);

  function tick(now){
    fxCtx.clearRect(0,0,W,H);
    for (const p of parts){
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      fxCtx.save(); fxCtx.translate(p.x, p.y); fxCtx.rotate(p.rot);
      fxCtx.fillStyle = p.color; fxCtx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
      fxCtx.restore();
    }
    if (now < endAt) fxRAF = requestAnimationFrame(tick);
    else { fxCtx.clearRect(0,0,W,H); fxRAF = null; }
  }
  fxRAF = requestAnimationFrame(tick);
}
function celebrateSmall(){ confetti({ duration: 800,  count: 70  }); }
function celebrateBig(){   confetti({ duration: 1600, count: 180 }); }
