import { buildDefaultTanks, buildT10Tanks, computePlan, computePlanMaxRemaining, computePlanMinTanksAggressive, computePlanSingleWingAlternative, computePlanMinKAlternatives, computePlanMinKeepSlopsSmall, computePlanMinKPolicy, computePlanMaxK } from './engine/stowage.js?v=6';

// Reverse-solver: minimal hydro + LCG integration (from draft_calculator data)
// Do NOT hardcode ship hydrostatics; these are set from imported/active ship meta.
const SHIP_PARAMS = { LBP: null, RHO_REF: null, LCG_FO_FW: null };
const LIGHT_SHIP = { weight_mt: null, lcg: null };
let HYDRO_ROWS = null; // cached hydro rows from draft_calculator
/** @type {Map<string, number>} */
let TANK_LCG_MAP = new Map(); // map tank_id -> lcg (midship +forward)
/** Ballast tanks metadata imported from Ship Data (if available) */
let BALLAST_TANKS = [];
// Tolerances
const TOL_TRIM_M = 0.02;   // m
const TOL_PS_PCT = 0.2;    // percent

// Simple state
let tanks = buildDefaultTanks();
let parcels = [
  { id: 'P1', name: 'naphtha', total_m3: 41000.000, density_kg_m3: 710, temperature_c: 15, color: '#ef4444' }
];

// UI helpers
const tankEditorEl = document.getElementById('tank-editor');
const parcelEditorEl = document.getElementById('parcel-editor');
const btnCompute = document.getElementById('btn-compute');
// Demo load buttons removed from UI
const btnAddParcel = document.getElementById('btn-add-parcel');
const btnAddCenter = document.getElementById('btn-add-center');
const activeShipEl = document.getElementById('active-ship');
const summaryEl = document.getElementById('summary');
const svgContainer = document.getElementById('svg-container');
const layoutGrid = document.getElementById('layout-grid');
const traceEl = document.getElementById('trace');
const warnsEl = document.getElementById('warnings');
const allocTableEl = document.getElementById('alloc-table');
const parcelTableEl = document.getElementById('parcel-table');
const cfgNameInput = document.getElementById('cfg-name');
const cfgSelect = document.getElementById('cfg-select');
const btnSaveCfg = document.getElementById('btn-save-cfg');
const btnLoadCfg = document.getElementById('btn-load-cfg');
const btnExportCfg = document.getElementById('btn-export-cfg');
const btnDelCfg = document.getElementById('btn-del-cfg');
const fileImportCfg = document.getElementById('file-import-cfg');
const btnExportJson = document.getElementById('btn-export-json');
const variantSelect = document.getElementById('plan-variant');
const viewTabs = document.querySelectorAll('.view-tabs .tab');
const btnTransferShipData = document.getElementById('btn-transfer-shipdata');

// Reverse-solver UI
const btnSolveDraft = document.getElementById('btn-solve-draft');
const rsTargetDraftEl = document.getElementById('rs_target_draft');
const rsRhoEl = document.getElementById('rs_rho');
const rsFoEl = document.getElementById('rs_fo_mt');
const rsFwEl = document.getElementById('rs_fw_mt');
const rsOthEl = document.getElementById('rs_oth_mt');
const rsConstEl = document.getElementById('rs_const_mt');
const rsConstLcgEl = document.getElementById('rs_const_lcg');
const hydroSummaryEl = document.getElementById('hydro-summary');

// Restore persisted UI inputs (reverse-solver + config name) before any render
restoreReverseInputs();
restoreCfgName();

// Persist on change
[rsTargetDraftEl, rsRhoEl, rsFoEl, rsFwEl, rsOthEl, rsConstEl, rsConstLcgEl]
  .filter(Boolean)
  .forEach(el => el.addEventListener('input', persistReverseInputs));
if (cfgNameInput) cfgNameInput.addEventListener('input', persistCfgName);

// View switching
const LS_VIEW = 'stowage_view_v1';
function setActiveView(view) {
  document.querySelectorAll('.view').forEach(sec => {
    const want = `view-${view}`;
    sec.classList.toggle('active', sec.id === want);
  });
  viewTabs.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-view') === view));
  localStorage.setItem(LS_VIEW, view);
}
viewTabs.forEach(btn => btn.addEventListener('click', () => setActiveView(btn.getAttribute('data-view'))));

// Local storage helpers for configs and last state
const LS_PRESETS = 'stowage_presets_v1';
// Bump last-state key to avoid overriding new defaults with old cached state
const LS_LAST = 'stowage_last_v2';
// Per-preset ship meta (stability/hydro/LCGs) storage
const LS_SHIP_META = 'stowage_ship_meta_v1';
const LS_VARIANT = 'stowage_variant_v1';
// Reverse-solver input persistence
const LS_RS = 'stowage_revsolver_v1';
// Optional: config name input persistence (UI clarity)
const LS_CFG_NAME = 'stowage_cfgname_v1';

function persistReverseInputs() {
  try {
    const payload = {
      targetDraft: rsTargetDraftEl ? String(rsTargetDraftEl.value ?? '') : '',
      rho: rsRhoEl ? String(rsRhoEl.value ?? '') : '',
      fo: rsFoEl ? String(rsFoEl.value ?? '') : '',
      fw: rsFwEl ? String(rsFwEl.value ?? '') : '',
      oth: rsOthEl ? String(rsOthEl.value ?? '') : '',
      constW: rsConstEl ? String(rsConstEl.value ?? '') : '',
      constX: rsConstLcgEl ? String(rsConstLcgEl.value ?? '') : ''
    };
    localStorage.setItem(LS_RS, JSON.stringify(payload));
  } catch {}
}
function restoreReverseInputs() {
  try {
    const raw = localStorage.getItem(LS_RS);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (rsTargetDraftEl && p && 'targetDraft' in p) rsTargetDraftEl.value = p.targetDraft ?? rsTargetDraftEl.value;
    if (rsRhoEl && p && 'rho' in p) rsRhoEl.value = p.rho ?? rsRhoEl.value;
    if (rsFoEl && p && 'fo' in p) rsFoEl.value = p.fo ?? rsFoEl.value;
    if (rsFwEl && p && 'fw' in p) rsFwEl.value = p.fw ?? rsFwEl.value;
    if (rsOthEl && p && 'oth' in p) rsOthEl.value = p.oth ?? rsOthEl.value;
    if (rsConstEl && p && 'constW' in p) rsConstEl.value = p.constW ?? rsConstEl.value;
    if (rsConstLcgEl && p && 'constX' in p) rsConstLcgEl.value = p.constX ?? rsConstLcgEl.value;
  } catch {}
}
function persistCfgName() {
  try { if (cfgNameInput) localStorage.setItem(LS_CFG_NAME, String(cfgNameInput.value ?? '')); } catch {}
}
function restoreCfgName() {
  try { const v = localStorage.getItem(LS_CFG_NAME); if (cfgNameInput && v != null) cfgNameInput.value = v; } catch {}
}

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(LS_PRESETS) || '{}'); } catch { return {}; }
}
function savePresets(p) {
  localStorage.setItem(LS_PRESETS, JSON.stringify(p));
}
function loadShipMeta() {
  try { return JSON.parse(localStorage.getItem(LS_SHIP_META) || '{}'); } catch { return {}; }
}
function saveShipMeta(m) {
  localStorage.setItem(LS_SHIP_META, JSON.stringify(m || {}));
}
function refreshPresetSelect() {
  const seenLabels = new Set();
  const options = [];
  // Draft Calculator ships (Hydrostatic)
  try {
    const dcIdxRaw = localStorage.getItem('dc_ships_index');
    const dcIdx = dcIdxRaw ? JSON.parse(dcIdxRaw) : [];
    if (Array.isArray(dcIdx) && dcIdx.length > 0) {
      dcIdx.forEach(entry => {
        if (!entry || !entry.id) return;
        const base = entry.name || entry.id;
        const label = `${base} (Hydrostatic)`;
        if (seenLabels.has(label)) return;
        seenLabels.add(label);
        options.push({ value: `dc:${entry.id}`, label });
      });
    }
  } catch {}
  // Local presets (tanks-only)
  try {
    const presets = loadPresets();
    const names = Object.keys(presets).sort((a,b)=>a.localeCompare(b));
    names.forEach(n => {
      const label = n;
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        options.push({ value: `preset:${n}`, label });
      }
    });
  } catch {}
  cfgSelect.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
}

function applySelectionValue(value) {
  if (!value) return false;
  if (value.startsWith('dc:')) {
    const id = value.slice(3);
    if (!id) return false;
    if (loadDCShip(id)) {
      try { cfgNameInput.value = getDCShipName(id) || id; } catch {}
      persistLastState();
      render();
      return true;
    }
    return false;
  }
  if (value.startsWith('preset:')) {
    const name = value.slice(7);
    const presets = loadPresets();
    const conf = presets[name];
    if (!Array.isArray(conf)) return false;
    tanks = conf.map(t => ({ ...t }));
    try { cfgNameInput.value = name; } catch {}
    // Apply ship meta for this preset if available
    try { const meta = (typeof loadShipMeta === 'function') ? loadShipMeta()[name] : null; if (meta) applyShipMeta(meta); } catch {}
    persistLastState();
    render();
    return true;
  }
  return false;
}
function persistLastState() {
  localStorage.setItem(LS_LAST, JSON.stringify({ tanks, parcels }));
}
function restoreLastState() {
  let restored = false;
  try {
    const raw = localStorage.getItem(LS_LAST);
    if (!raw) return;
    const { tanks: t, parcels: p } = JSON.parse(raw);
    if (Array.isArray(t) && Array.isArray(p)) {
      tanks = t;
      parcels = p;
      restored = true;
    }
  } catch {}
  return restored;
}

// Save current tank configuration to project folder via dev server API
async function saveConfigToFile(filename, name, currentTanks) {
  try {
    const res = await fetch('/api/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, name, tanks: currentTanks })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (e) {
    console.warn('Save to file failed:', e);
    return null;
  }
}

// Load only capacities (volume_m3) from ships_export_2025-10-05.json if present
async function tryLoadCapacitiesFromExport() {
  try {
    const res = await fetch('/ships_export_2025-10-05.json', { cache: 'no-store' });
    if (!res.ok) return false;
    const json = await res.json();
    /** Build a map id -> volume_m3 from flexible shapes */
    const volumeMap = new Map();
    const consumeTankArr = (arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach(item => {
        if (!item) return;
        const id = item.id || item.tank_id;
        const vol = (typeof item.volume_m3 === 'number') ? item.volume_m3
          : (typeof item.capacity_m3 === 'number') ? item.capacity_m3
          : (typeof item.volume === 'number') ? item.volume
          : undefined;
        if (id && typeof vol === 'number') volumeMap.set(id, vol);
      });
    };
    if (Array.isArray(json)) consumeTankArr(json);
    else if (json && Array.isArray(json.tanks)) consumeTankArr(json.tanks);
    else if (json && Array.isArray(json.ships) && json.ships[0] && Array.isArray(json.ships[0].tanks)) consumeTankArr(json.ships[0].tanks);

    if (volumeMap.size === 0) return false;
    // Update only volumes, preserve other fields
    tanks = tanks.map(t => volumeMap.has(t.id) ? { ...t, volume_m3: volumeMap.get(t.id) } : t);
    persistLastState();
    render();
    try { alert('Capacities loaded from ships_export_2025-10-05.json'); } catch {}
    return true;
  } catch (e) {
    console.warn('Capacity import failed:', e);
    return false;
  }
}

// Build volume map from flexible JSON shapes
function buildVolumeMapFromJSON(json) {
  const volumeMap = new Map();
  const consumeTankArr = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach(item => {
      if (!item) return;
      const id = item.id || item.tank_id;
      const vol = (typeof item.volume_m3 === 'number') ? item.volume_m3
        : (typeof item.capacity_m3 === 'number') ? item.capacity_m3
        : (typeof item.volume === 'number') ? item.volume
        : undefined;
      if (id && typeof vol === 'number') volumeMap.set(id, vol);
    });
  };
  if (Array.isArray(json)) consumeTankArr(json);
  else if (json && Array.isArray(json.tanks)) consumeTankArr(json.tanks);
  else if (json && Array.isArray(json.ships) && json.ships[0] && Array.isArray(json.ships[0].tanks)) consumeTankArr(json.ships[0].tanks);
  return volumeMap;
}

// Helpers to normalize tank ids from external names
function normalizeCargoNameToId(name) {
  if (!name) return null;
  const s = String(name).toUpperCase().trim();
  // Accept patterns: COT n P/S/C or NO.n CARGO TK (P|S|C) or similar variants
  const mCot = /\bCOT\s*(\d+)\s*(P|S|C)\b/.exec(s);
  if (mCot) {
    const num = mCot[1];
    const sideLetter = mCot[2];
    const id = `COT${num}${sideLetter}`;
    const side = sideLetter === 'P' ? 'port' : (sideLetter === 'S' ? 'starboard' : 'center');
    return { id, side };
  }
  // NO.n CARGO TK (P|S|C) → COTnP/S/C
  const mNo = /NO\.?\s*(\d+)\s*CARGO\s*TK\s*\((P|S|C)\)/.exec(s);
  if (mNo) {
    const num = mNo[1];
    const sideLetter = mNo[2];
    const id = `COT${num}${sideLetter}`;
    const side = sideLetter === 'P' ? 'port' : (sideLetter === 'S' ? 'starboard' : 'center');
    return { id, side };
  }
  // SLOP variants (SLOP TK(P), Slop Tank 6 P, etc.)
  if (/SLOP/.test(s)) {
    let sideLetter = null;
    const mSide = /(\(|\s)(P|S)(\)|\b)/.exec(s);
    if (mSide) sideLetter = mSide[2];
    if (!sideLetter) return null;
    const id = sideLetter === 'P' ? 'SLOPP' : 'SLOPS';
    const side = sideLetter === 'P' ? 'port' : 'starboard';
    return { id, side };
  }
  return null;
}

// ---- Ship meta handling (import stability/hydro/LCGs) ----
function convertLongitudinalToMidship(x, lbp, ref) {
  if (!isFinite(x)) return x;
  const r = String(ref || '').toLowerCase();
  if (!r || r === 'ms_plus') return x;      // midship (+ forward)
  if (r === 'ms_minus') return -x;          // midship (− forward)
  if (!isFinite(lbp) || lbp <= 0) return x; // AP/FP need LBP
  if (r === 'ap_plus') return x - lbp/2;    // AP (+ forward) → midship
  if (r === 'fp_minus') return x + lbp/2;   // FP (− aft) → midship
  return x;
}

function convertProfileLongitudes(profile) {
  try {
    const lbp = Number(profile?.ship?.lbp);
    const ref = profile?.ship?.long_ref;
    if (!ref) return profile;
    // Hydro rows
    if (profile.hydrostatics && Array.isArray(profile.hydrostatics.rows)) {
      for (const r of profile.hydrostatics.rows) {
        if (r && typeof r.lcf_m === 'number') r.lcf_m = convertLongitudinalToMidship(r.lcf_m, lbp, ref);
        if (r && typeof r.lcb_m === 'number') r.lcb_m = convertLongitudinalToMidship(r.lcb_m, lbp, ref);
      }
    }
    // Tank LCGs
    const cats = ['cargo','ballast','consumables'];
    if (profile.tanks) {
      for (const c of cats) {
        const arr = profile.tanks[c];
        if (Array.isArray(arr)) {
          for (const t of arr) {
            if (t && typeof t.lcg === 'number') t.lcg = convertLongitudinalToMidship(t.lcg, lbp, ref);
          }
        }
      }
    }
    // Light ship / constant
    if (profile.ship && profile.ship.light_ship && typeof profile.ship.light_ship.lcg === 'number') {
      profile.ship.light_ship.lcg = convertLongitudinalToMidship(profile.ship.light_ship.lcg, lbp, ref);
    }
    if (profile.ship && profile.ship.constant && typeof profile.ship.constant.lcg === 'number') {
      profile.ship.constant.lcg = convertLongitudinalToMidship(profile.ship.constant.lcg, lbp, ref);
    }
  } catch {}
  return profile;
}

function extractShipMetaFromProfile(profile) {
  try {
    if (!profile || !profile.ship) return null;
    const p = convertProfileLongitudes(JSON.parse(JSON.stringify(profile)));
    const name = p.ship.name || p.ship.id || 'Ship';
    const meta = { name };
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
    // LBP (robust keys)
    meta.lbp = num(p.ship.lbp ?? p.ship.LBP ?? p.LBP ?? undefined);
    // rho_ref
    meta.rho_ref = num(p.ship.rho_ref ?? p.ship.rhoRef ?? p.ship.rho ?? undefined);
    // Light ship
    const ls = p.ship.light_ship || p.ship.lightShip || p.LIGHT_SHIP || null;
    if (ls && num(ls.weight) != null && num(ls.lcg) != null) {
      meta.light_ship = { weight_mt: num(ls.weight), lcg: num(ls.lcg) };
    }
    // Hydro rows (accept both {rows:[]} and [] shapes)
    if (p.hydrostatics && Array.isArray(p.hydrostatics.rows)) {
      meta.hydrostatics = { rows: p.hydrostatics.rows.slice().sort((a,b)=>a.draft_m-b.draft_m) };
    } else if (Array.isArray(p.hydrostatics)) {
      meta.hydrostatics = { rows: p.hydrostatics.slice().sort((a,b)=>a.draft_m-b.draft_m) };
    }
    // Build tank LCG map for cargo/slops and ballast
    const tank_lcgs = {};
    const ballast_tanks = [];
    const pushLCGs = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const t of arr) {
        if (!t || typeof t.lcg !== 'number') continue;
        const norm = normalizeCargoNameToId(t.name || t.id || '');
        if (norm && /^COT\d+(P|S|C)$/.test(norm.id)) tank_lcgs[norm.id] = Number(t.lcg);
        else if (/SLOP/i.test(String(t.name||''))) {
          const side = /(\(|\s)(P|S)(\)|\b)/.exec(String(t.name||'').toUpperCase());
          if (side && side[2]==='P') tank_lcgs['SLOPP'] = Number(t.lcg);
          if (side && side[2]==='S') tank_lcgs['SLOPS'] = Number(t.lcg);
        }
      }
    };
    if (p.tanks) {
      pushLCGs(p.tanks.cargo);
      // slops are usually in cargo array; included above
      // Ballast: store native IDs and LCGs and capacities for planner usage
      if (Array.isArray(p.tanks.ballast)) {
        for (const t of p.tanks.ballast) {
          if (!t) continue;
          const id = t.id || t.name;
          if (!id) continue;
          if (isFinite(t.lcg)) tank_lcgs[id] = Number(t.lcg);
          const cap = (typeof t.cap_m3 === 'number') ? t.cap_m3 : (typeof t.capacity_m3 === 'number') ? t.capacity_m3 : (typeof t.volume_m3 === 'number') ? t.volume_m3 : (typeof t.volume === 'number') ? t.volume : undefined;
          ballast_tanks.push({ id, name: t.name || id, cap_m3: isFinite(cap) ? Number(cap) : 0, lcg: Number(t.lcg)||0 });
        }
      }
    }
    if (Object.keys(tank_lcgs).length) meta.tank_lcgs = tank_lcgs;
    if (ballast_tanks.length) meta.ballast_tanks = ballast_tanks;
    // Approximate single consumables LCG from FO/FW/OTH if provided
    if (p.tanks && Array.isArray(p.tanks.consumables)) {
      const cons = p.tanks.consumables;
      const pick = (type)=> cons.find(x => String(x.type||'').toLowerCase()===type);
      const fo = pick('fo'); const fw = pick('fw'); const oth = pick('oth');
      const vals = [fo, fw, oth].filter(x => x && isFinite(x.lcg)).map(x => Number(x.lcg));
      if (vals.length > 0) {
        const avg = vals.reduce((s,v)=>s+v,0)/vals.length;
        meta.lcg_fo_fw = avg;
      }
    }
    return meta;
  } catch { return null; }
}

function applyShipMeta(meta) {
  if (!meta || typeof meta !== 'object') return;
  try {
    if (isFinite(meta.lbp)) SHIP_PARAMS.LBP = Number(meta.lbp);
    if (isFinite(meta.rho_ref)) SHIP_PARAMS.RHO_REF = Number(meta.rho_ref);
    if (meta.light_ship && isFinite(meta.light_ship.weight_mt) && isFinite(meta.light_ship.lcg)) {
      LIGHT_SHIP.weight_mt = Number(meta.light_ship.weight_mt);
      LIGHT_SHIP.lcg = Number(meta.light_ship.lcg);
    }
    if (isFinite(meta.lcg_fo_fw)) SHIP_PARAMS.LCG_FO_FW = Number(meta.lcg_fo_fw);
    if (meta.hydrostatics && Array.isArray(meta.hydrostatics.rows) && meta.hydrostatics.rows.length) {
      HYDRO_ROWS = meta.hydrostatics.rows.slice().sort((a,b)=>a.draft_m-b.draft_m);
    }
    if (meta.tank_lcgs) {
      const m = new Map();
      Object.entries(meta.tank_lcgs).forEach(([k,v])=>{ if (isFinite(v)) m.set(k, Number(v)); });
      TANK_LCG_MAP = m;
    }
    if (Array.isArray(meta.ballast_tanks)) {
      BALLAST_TANKS = meta.ballast_tanks.slice();
    }
  } catch {}
}
function mapCargoArrayToTanks(cargoArr, defaults = { min_pct: 0.5, max_pct: 0.98 }) {
  const out = [];
  if (!Array.isArray(cargoArr)) return out;
  const seen = new Set();
  for (const row of cargoArr) {
    const norm = normalizeCargoNameToId(row?.name);
    if (!norm) continue; // skip non-COT non-SLOP items
    const id = norm.id;
    if (seen.has(id)) continue; // avoid duplicates
    const volume = (typeof row.cap_m3 === 'number') ? row.cap_m3
      : (typeof row.volume_m3 === 'number') ? row.volume_m3
      : (typeof row.capacity_m3 === 'number') ? row.capacity_m3
      : (typeof row.volume === 'number') ? row.volume
      : undefined;
    if (typeof volume !== 'number') continue;
    out.push({ id, volume_m3: volume, min_pct: defaults.min_pct, max_pct: defaults.max_pct, included: true, side: norm.side });
    seen.add(id);
  }
  return out;
}

function parseShipsFromExport(json) {
  const ships = [];
  const defaults = { min_pct: 0.5, max_pct: 0.98 };
  const pushIfAny = (name, cargoArr) => {
    const tanksArr = mapCargoArrayToTanks(cargoArr, defaults);
    if (tanksArr.length > 0) ships.push({ name, tanks: tanksArr });
  };
  if (json && Array.isArray(json.ships)) {
    for (const s of json.ships) {
      const name = s?.ship?.name || s?.name || 'Ship';
      const cargo = s?.tanks?.cargo || [];
      pushIfAny(name, cargo);
    }
  } else if (json && Array.isArray(json)) {
    // array of ship entries or array of cargo rows
    if (json.length && json[0] && json[0].name && json[0].cap_m3 != null) {
      pushIfAny('Imported Ship', json);
    } else {
      for (let i = 0; i < json.length; i++) {
        const s = json[i];
        const name = s?.ship?.name || s?.name || `Ship ${i+1}`;
        const cargo = s?.tanks?.cargo || s?.cargo || [];
        pushIfAny(name, cargo);
      }
    }
  } else if (json && json.tanks && Array.isArray(json.tanks.cargo)) {
    const name = json?.ship?.name || json?.name || 'Imported Ship';
    pushIfAny(name, json.tanks.cargo);
  }
  return ships;
}

function renderTankEditor() {
  const rows = tanks.map((t, idx) => {
    return `<tr>
      <td><input value="${t.id}" data-idx="${idx}" data-field="id" style="width:90px"/></td>
      <td>
        <select data-idx="${idx}" data-field="side">
          <option value="port" ${t.side==='port'?'selected':''}>port</option>
          <option value="starboard" ${t.side==='starboard'?'selected':''}>starboard</option>
          <option value="center" ${t.side==='center'?'selected':''}>center</option>
        </select>
      </td>
      <td><input type="number" step="1" min="0" value="${t.volume_m3}" data-idx="${idx}" data-field="volume_m3" style="width:90px"/></td>
      <td><input type="number" step="1" min="0" max="100" value="${Math.round((t.min_pct||0)*100)}" data-idx="${idx}" data-field="min_pct_pct" style="width:70px"/></td>
      <td><input type="number" step="1" min="0" max="100" value="${Math.round((t.max_pct||0)*100)}" data-idx="${idx}" data-field="max_pct_pct" style="width:70px"/></td>
      <td><input type="checkbox" ${t.included?'checked':''} data-idx="${idx}" data-field="included"/></td>
      <td class="row-controls"><button data-act="del-tank" data-idx="${idx}">Delete</button></td>
    </tr>`;
  }).join('');
  tankEditorEl.innerHTML = `
    <table>
      <thead>
        <tr><th>Tank ID</th><th>Side</th><th>Volume (m³)</th><th>Min %</th><th>Max %</th><th>Incl.</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  tankEditorEl.querySelectorAll('input,select').forEach(el => {
    el.addEventListener('change', (e) => {
      const target = e.target;
      const idx = Number(target.getAttribute('data-idx'));
      let field = target.getAttribute('data-field');
      let val = target.type === 'checkbox' ? target.checked : target.value;
      if (field === 'volume_m3') val = Number(val);
      if (field === 'min_pct_pct') { field = 'min_pct'; val = Math.max(0, Math.min(100, Number(val)))/100; }
      if (field === 'max_pct_pct') { field = 'max_pct'; val = Math.max(0, Math.min(100, Number(val)))/100; }
      tanks[idx] = { ...tanks[idx], [field]: field==='included' ? (target.checked) : val };
      persistLastState();
      render();
    });
  });
  tankEditorEl.querySelectorAll('button[data-act="del-tank"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = Number(btn.getAttribute('data-idx'));
      tanks.splice(idx, 1);
      persistLastState();
      render();
    });
  });
}

function renderParcelEditor() {
  const rows = parcels.map((p, idx) => {
    const dens = Number(p.density_kg_m3 || 0);
    const wt = isFinite(dens) && dens > 0 && isFinite(p.total_m3) ? (p.total_m3 * dens / 1000) : '';
    return `<tr>
      <td><input value="${p.id}" data-idx="${idx}" data-field="id" style="width:70px"/></td>
      <td><input value="${p.name}" data-idx="${idx}" data-field="name" style="width:120px"/></td>
      <td><input type="number" step="0.001" min="0" value="${p.total_m3 != null ? Number(p.total_m3).toFixed(3) : ''}" data-idx="${idx}" data-field="total_m3" style="width:90px" ${p.fill_remaining? 'disabled':''}/></td>
      <td><input type="number" step="0.1" min="0" value="${wt!=='' ? Number(wt).toFixed(1) : ''}" data-idx="${idx}" data-field="weight_mt" style="width:90px" ${p.fill_remaining? 'disabled':''}/></td>
      <td><input type="checkbox" ${p.fill_remaining?'checked':''} data-idx="${idx}" data-field="fill_remaining" ${idx===parcels.length-1 ? '' : 'disabled'}/></td>
      <td><input type="number" step="0.001" min="0" value="${((p.density_kg_m3||0)/1000).toFixed(3)}" data-idx="${idx}" data-field="density_g_cm3" style="width:80px"/></td>
      <td><input type="number" step="1" value="${p.temperature_c}" data-idx="${idx}" data-field="temperature_c" style="width:70px"/></td>
      <td><input type="color" value="${p.color || '#888888'}" data-idx="${idx}" data-field="color"/></td>
      <td class="row-controls"><button data-act="del-parcel" data-idx="${idx}">Delete</button></td>
    </tr>`;
  }).join('');
  parcelEditorEl.innerHTML = `
    <table>
      <thead>
        <tr><th>Parcel No.</th><th>Name</th><th>Total (m³)</th><th>Weight (t)</th><th>Fill Remaining</th><th>Density (g/cm³)</th><th>T (°C)</th><th>Color</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  parcelEditorEl.querySelectorAll('input').forEach(el => {
    el.addEventListener('change', (e) => {
      const target = e.target;
      const idx = Number(target.getAttribute('data-idx'));
      const field = target.getAttribute('data-field');
      let val = target.type === 'checkbox' ? target.checked : target.value;
      if (field === 'temperature_c') val = Number(val);
      if (field === 'density_g_cm3') {
        // accept comma decimals and convert g/cm3 to kg/m3
        const txt = String(val).replace(',', '.');
        const gcm3 = Number(txt);
        val = isNaN(gcm3) ? parcels[idx].density_kg_m3 : gcm3 * 1000;
      }
      if (field === 'total_m3') {
        const txt = String(val).replace(',', '.');
        val = txt === '' ? undefined : Number(txt);
      }
      if (field === 'weight_mt') {
        const txt = String(val).replace(',', '.');
        const w = Number(txt);
        const dens = Number(parcels[idx].density_kg_m3 || 0);
        if (isFinite(w) && isFinite(dens) && dens > 0) {
          const vol = (w * 1000) / dens; // m3
          parcels[idx] = { ...parcels[idx], total_m3: vol };
          persistLastState();
          render();
          return;
        }
      }
      // Ensure unique parcel IDs; auto-adjust duplicates
      if (field === 'id') {
        let base = String(val).trim() || `P${idx+1}`;
        let unique = base;
        let n = 2;
        while (parcels.some((p, i) => i !== idx && p.id === unique)) {
          unique = `${base}_${n++}`;
        }
        if (unique !== val) {
          val = unique;
          target.value = unique;
        }
      }
      // Ensure only last parcel can be fill_remaining
      if (field === 'fill_remaining' && val === true && idx !== parcels.length - 1) return;
      const mappedField = field === 'density_g_cm3' ? 'density_kg_m3' : field;
      parcels[idx] = { ...parcels[idx], [mappedField]: val };
      // If fill_remaining is toggled true, clear total_m3
      if (field === 'fill_remaining') {
        if (val) parcels[idx].total_m3 = undefined;
      }
      persistLastState();
      render();
    });
  });
  parcelEditorEl.querySelectorAll('button[data-act="del-parcel"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      parcels.splice(idx, 1);
      // Ensure last parcel has fill_remaining enabled state preserved only if it was last
      if (parcels.length > 0) {
        parcels = parcels.map((p, i) => i === parcels.length - 1 ? p : { ...p, fill_remaining: false });
      }
      persistLastState();
      render();
    });
  });
}

function liters(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); }

function renderActiveShipInfo() {
  if (!activeShipEl) return;
  const lbpNum = (SHIP_PARAMS && typeof SHIP_PARAMS.LBP === 'number') ? SHIP_PARAMS.LBP : NaN;
  const rhoNum = (SHIP_PARAMS && typeof SHIP_PARAMS.RHO_REF === 'number') ? SHIP_PARAMS.RHO_REF : NaN;
  const lsWNum = (LIGHT_SHIP && typeof LIGHT_SHIP.weight_mt === 'number') ? LIGHT_SHIP.weight_mt : NaN;
  const lsXNum = (LIGHT_SHIP && typeof LIGHT_SHIP.lcg === 'number') ? LIGHT_SHIP.lcg : NaN;
  const lbp = Number.isFinite(lbpNum) ? lbpNum.toFixed(2) : '-';
  const rho = Number.isFinite(rhoNum) ? String(rhoNum) : '-';
  const lsW = Number.isFinite(lsWNum) ? lsWNum.toFixed(0) : '-';
  const lsX = Number.isFinite(lsXNum) ? lsXNum.toFixed(2) : '-';
  const hRows = (HYDRO_ROWS && HYDRO_ROWS.length) ? HYDRO_ROWS.length : 0;
  const any = (lbp !== '-' || rho !== '-' || lsW !== '-' || hRows > 0);
  if (!any) { activeShipEl.style.display = 'none'; activeShipEl.innerHTML = ''; return; }
  activeShipEl.style.display = 'block';
  activeShipEl.innerHTML = `
    <div>LBP <b>${lbp}</b> m</div>
    <div>ρ_ref <b>${rho}</b> t/m³</div>
    <div>Light Ship <b>${lsW}</b> t @ <b>${lsX}</b> m</div>
    <div>Hydro Rows <b>${hRows}</b></div>
  `;
}

function guessSideFromId(id) {
  const s = String(id || '').toUpperCase();
  if (/(\(|\s|\b)P(\)|\s|\b)$/.test(s) || / P$/.test(s) || /P$/.test(s)) return 'port';
  if (/(\(|\s|\b)S(\)|\s|\b)$/.test(s) || / S$/.test(s) || /S$/.test(s)) return 'starboard';
  return null;
}

function renderSummaryAndSvg(result) {
  if (summaryEl) summaryEl.innerHTML = '';
  if (svgContainer) svgContainer.innerHTML = '';
  if (layoutGrid) layoutGrid.innerHTML = '';
  // Preserve existing warning text when result is null (e.g., no viable options)
  if (result) { if (warnsEl) warnsEl.textContent = ''; }
  if (traceEl) traceEl.innerHTML = '';
  if (allocTableEl) allocTableEl.innerHTML = '';
  if (parcelTableEl) parcelTableEl.innerHTML = '';
  let allocations = [];
  let ballastAllocs = [];
  let diagnostics = null;
  let reasoningTrace = [];
  if (result) {
    allocations = result.allocations || [];
    ballastAllocs = result.ballastAllocations || result.ballast_allocations || [];
    diagnostics = result.diagnostics || null;
    const { warnings, errors } = diagnostics || {};
    // Combined P/S summary (cargo + ballast)
    try {
      const byTank = new Map();
      tanks.forEach(t => byTank.set(t.id, t));
      const allAllocs = allocations.concat(ballastAllocs || []);
      let pW = 0, sW = 0;
      allAllocs.forEach(a => {
        const t = byTank.get(a.tank_id);
        const side = t?.side || guessSideFromId(a.tank_id);
        if (side === 'port') pW += (a.weight_mt||0);
        else if (side === 'starboard') sW += (a.weight_mt||0);
      });
      const denom = pW + sW;
      const imb = denom > 0 ? (Math.abs(pW - sW) / denom) * 100 : 0;
      const dir = (pW > sW) ? 'port' : ((pW < sW) ? 'starboard' : 'even');
      const warnLine = imb <= TOL_PS_PCT ? `Balanced (d% ${imb.toFixed(2)})` : `Imbalance ${imb.toFixed(2)}%${dir==='even'?'':` (list to ${dir})`}`;
      if (summaryEl) summaryEl.innerHTML = `
        <div class="summary-bar" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div>Port <b>${(pW||0).toFixed(2)}</b> MT</div>
          <div>${warnLine}</div>
          <div>Starboard <b>${(sW||0).toFixed(2)}</b> MT</div>
        </div>
      `;
    } catch {}
  }

  // Hydro summary (optional): compute F/M/A drafts, trim, displacement, DWT if hydro rows & LCG map available
  (async () => {
    try {
      const hbox = hydroSummaryEl;
      if (!hbox) return;
      if (!HYDRO_ROWS) await ensureHydroLoaded();
      if (!HYDRO_ROWS || HYDRO_ROWS.length === 0) { hbox.style.display = 'none'; return; }
      const allAllocs = allocations.concat(ballastAllocs || []);
      const metrics = computeHydroForAllocations(allAllocs);
      if (!metrics) { hbox.style.display = 'none'; return; }
      const { W_total, DWT, Tf, Tm, Ta, Trim } = metrics;
      hbox.style.display = 'block';
      hbox.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(auto-fit,minmax(140px,1fr)); gap:8px; font-size:13px;">
          <div><div class="muted">Displacement (t)</div><div><b>${isFinite(W_total)?W_total.toFixed(1):'-'}</b></div></div>
          <div><div class="muted">DWT (t)</div><div><b>${isFinite(DWT)?DWT.toFixed(1):'-'}</b></div></div>
          <div><div class="muted">Draft Fwd (m)</div><div><b>${Tf.toFixed(3)}</b></div></div>
          <div><div class="muted">Draft Mean (m)</div><div><b>${Tm.toFixed(3)}</b></div></div>
          <div><div class="muted">Draft Aft (m)</div><div><b>${Ta.toFixed(3)}</b></div></div>
          <div><div class="muted">Trim (m, +stern)</div><div><b>${Trim.toFixed(3)}</b></div></div>
        </div>
      `;
    } catch(_) {
      // ignore
    }
  })();

  // Larger, card-like ship layout (HTML/CSS)
  // Respect the order in the tank editor (array order), and place SLOP tanks at the bottom.
  const includedTanks = tanks.filter(t => t.included);
  /** @type {Record<string, {port:any, starboard:any, centers:any[]}>} */
  const groupMap = {};
  /** @type {string[]} */
  const rowKeys = [];
  includedTanks.forEach(t => {
    const m = /COT(\d+)/.exec(t.id);
    const key = m ? `PAIR:${m[1]}` : (/SLOP/i.test(t.id) ? 'SLOP' : `OTHER:${t.id}`);
    if (!groupMap[key]) { groupMap[key] = { port: null, starboard: null, centers: [] }; rowKeys.push(key); }
    if (t.side === 'port') groupMap[key].port = t;
    else if (t.side === 'starboard') groupMap[key].starboard = t;
    else if (t.side === 'center') groupMap[key].centers.push(t);
  });
  // Respect editor order entirely (including SLOP); do not reorder
  const orderedKeys = rowKeys;

  const byTank = Object.create(null);
  allocations.forEach(a => { byTank[a.tank_id] = a; });

  const ship = document.createElement('div');
  ship.className = 'ship';
  ship.innerHTML = `
    <div class="bow"><div class="triangle"></div></div>
    <div class="hull" id="hull"></div>
    <div class="stern"></div>
  `;
  const hull = ship.querySelector('#hull');
  orderedKeys.forEach(key => {
    const row = document.createElement('div');
    row.className = 'tank-row';
    const hasCenter = groupMap[key].centers && groupMap[key].centers.length > 0;
    const port = groupMap[key].port;
    const star = groupMap[key].starboard;
    const centerOnly = hasCenter && !port && !star;
    if (centerOnly) {
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '1fr';
    } else if (hasCenter) {
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '1fr 1fr 1fr';
      row.style.gap = '0px';
    }
    // Port cell
    if (port && !centerOnly) {
      const cellP = document.createElement('div');
      cellP.className = 'tank-cell';
      const a = byTank[port.id];
      const parcel = a ? parcels.find(p=>p.id===a.parcel_id) : null;
      if (parcel) cellP.style.background = '#0f1a3a';
      cellP.innerHTML = `
        <div class="id">${port.id}</div>
        ${a ? `
          <div class="meta">${parcel?.name || a.parcel_id}</div>
          <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
          <div class="meta">Fill: ${(a.fill_pct*100).toFixed(1)}%</div>
          <div class="fillbar"><div style="height:${(a.fill_pct*100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
        ` : `
          <div class="empty-hint">Cargo</div>
          <div class="empty-hint">Volume</div>
          <div class="empty-hint">%</div>
        `}
      `;
      if (parcel) cellP.style.boxShadow = `inset 0 0 0 9999px ${parcel.color}18`;
      row.appendChild(cellP);
    }
    // Center cell(s) if any
    if (hasCenter) {
      const centers = groupMap[key].centers.sort((a,b)=>a.id.localeCompare(b.id));
      const cellC = document.createElement('div');
      cellC.className = 'tank-cell';
      if (centerOnly) {
        cellC.style.gridColumn = '1 / span 1';
        // Single full-width center: render like a side cell and color the full cell
        const ct = centers[0];
        const a = byTank[ct.id];
        const parcel = a ? parcels.find(p=>p.id===a.parcel_id) : null;
        cellC.innerHTML = `
          <div class="id">${ct.id}</div>
          ${a ? `
            <div class="meta">${parcel?.name || a.parcel_id}</div>
            <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
            <div class="meta">Fill: ${(a.fill_pct*100).toFixed(1)}%</div>
            <div class="fillbar"><div style="height:${(a.fill_pct*100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
          ` : `
            <div class="empty-hint">Cargo</div>
            <div class="empty-hint">Volume</div>
            <div class="empty-hint">%</div>
          `}
        `;
        if (a) {
          cellC.style.background = '#0f1a3a';
          if (parcel?.color) cellC.style.boxShadow = `inset 0 0 0 9999px ${parcel.color}18`;
        }
      } else {
        centers.forEach((ct, i) => {
          const a = byTank[ct.id];
          const parcel = a ? parcels.find(p=>p.id===a.parcel_id) : null;
          const block = document.createElement('div');
          block.className = 'tank-cell';
          block.style.minHeight = '100px';
          block.style.marginBottom = i < centers.length-1 ? '6px' : '0';
          block.innerHTML = `
            <div class="id">${ct.id}</div>
            ${a ? `
              <div class="meta">${parcel?.name || a.parcel_id}</div>
              <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
              <div class="meta">Fill: ${(a.fill_pct*100).toFixed(1)}%</div>
              <div class="fillbar"><div style="height:${(a.fill_pct*100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
            ` : `
              <div class="empty-hint">Cargo</div>
              <div class="empty-hint">Volume</div>
              <div class="empty-hint">%</div>
            `}
          `;
          if (a) {
            block.style.background = '#0f1a3a';
            if (parcel?.color) block.style.boxShadow = `inset 0 0 0 9999px ${parcel.color}18`;
          }
          cellC.appendChild(block);
        });
      }
      row.appendChild(cellC);
    }
    // Starboard cell
    if (star && !centerOnly) {
      const cellS = document.createElement('div');
      cellS.className = 'tank-cell';
      const a = byTank[star.id];
      const parcel = a ? parcels.find(p=>p.id===a.parcel_id) : null;
      cellS.innerHTML = `
        <div class="id">${star.id}</div>
        ${a ? `
          <div class="meta">${parcel?.name || a.parcel_id}</div>
          <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
          <div class="meta">Fill: ${(a.fill_pct*100).toFixed(1)}%</div>
          <div class="fillbar"><div style="height:${(a.fill_pct*100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
        ` : `
          <div class="empty-hint">Cargo</div>
          <div class="empty-hint">Volume</div>
          <div class="empty-hint">%</div>
        `}
      `;
      if (parcel) cellS.style.boxShadow = `inset 0 0 0 9999px ${parcel.color}18`;
      row.appendChild(cellS);
    }
    hull.appendChild(row);
  });
  // Cargo layout card
  const cargoCard = document.createElement('div');
  cargoCard.appendChild(ship);
  if (layoutGrid) layoutGrid.appendChild(cargoCard);
  // Ballast layout card (if ballast allocations exist)
  if ((ballastAllocs||[]).length > 0 && Array.isArray(BALLAST_TANKS) && BALLAST_TANKS.length > 0) {
    const bCard = document.createElement('div');
    const bShip = document.createElement('div');
    bShip.className = 'ship';
    bShip.innerHTML = `
      <div class="bow"><div class="triangle"></div></div>
      <div class="hull" id="bhull"></div>
      <div class="stern"></div>
    `;
    const bhull = bShip.querySelector('#bhull');
    // Build used ballast pair rows
    const usedB = new Map();
    (ballastAllocs||[]).forEach(b => usedB.set(b.tank_id, b));
    const getSide = (id)=> guessSideFromId(id) || 'port';
    const baseKey = (s)=> String(s||'').toUpperCase().replace(/(\s*\(?[PS]\)?\s*)$/, '').trim();
    /** @type {Record<string,{P:any,S:any}>} */
    const bpairs = {};
    BALLAST_TANKS.forEach(t => {
      if (!usedB.has(t.id)) return;
      const key = baseKey(t.id);
      if (!bpairs[key]) bpairs[key] = { P:null, S:null };
      const side = getSide(t.id);
      if (side === 'port') bpairs[key].P = t; else if (side === 'starboard') bpairs[key].S = t;
    });
    const browKeys = Object.keys(bpairs);
    browKeys.forEach(key => {
      const row = document.createElement('div');
      row.className = 'tank-row';
      const P = bpairs[key].P; const S = bpairs[key].S;
      // Port ballast cell
      if (P) {
        const cell = document.createElement('div'); cell.className = 'tank-cell';
        const a = usedB.get(P.id);
        cell.innerHTML = `
          <div class="id">${P.id}</div>
          ${a ? `
            <div class="meta">Vol: ${(a.assigned_m3||0).toFixed(0)} m³</div>
            <div class="meta">Fill: ${isFinite(a.percent)?Number(a.percent).toFixed(1):'-'}%</div>
            <div class="fillbar"><div style="height:${isFinite(a.percent)?Number(a.percent).toFixed(1):'0'}%; background:#22d3ee"></div></div>
          ` : `
            <div class="empty-hint">Ballast</div>
            <div class="empty-hint">Volume</div>
            <div class="empty-hint">%</div>
          `}
        `;
        bhull.appendChild(cell);
      } else { const cell = document.createElement('div'); cell.className='tank-cell'; cell.innerHTML = '<div class="empty-hint">-</div>'; bhull.appendChild(cell); }
      // Starboard ballast cell
      if (S) {
        const cell = document.createElement('div'); cell.className = 'tank-cell';
        const a = usedB.get(S.id);
        cell.innerHTML = `
          <div class="id">${S.id}</div>
          ${a ? `
            <div class="meta">Vol: ${(a.assigned_m3||0).toFixed(0)} m³</div>
            <div class="meta">Fill: ${isFinite(a.percent)?Number(a.percent).toFixed(1):'-'}%</div>
            <div class="fillbar"><div style="height:${isFinite(a.percent)?Number(a.percent).toFixed(1):'0'}%; background:#22d3ee"></div></div>
          ` : `
            <div class="empty-hint">Ballast</div>
            <div class="empty-hint">Volume</div>
            <div class="empty-hint">%</div>
          `}
        `;
        bhull.appendChild(cell);
      } else { const cell = document.createElement('div'); cell.className='tank-cell'; cell.innerHTML = '<div class="empty-hint">-</div>'; bhull.appendChild(cell); }
    });
    bCard.appendChild(bShip);
    if (layoutGrid) layoutGrid.appendChild(bCard);
  }
  // layoutGrid already has class 'layout-wrap' which arranges children side-by-side

  // Legend with per-parcel totals
  const legend = document.createElement('div');
  legend.className = 'legend';
  parcels.forEach(p => {
    // calc totals actually assigned (not requested)
    const assignedVol = allocations.filter(a => a.parcel_id === p.id).reduce((s,a)=>s+a.assigned_m3,0);
    const assignedWt = allocations.filter(a => a.parcel_id === p.id).reduce((s,a)=>s+a.weight_mt,0);
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div class="sw" style="background:${p.color || '#888'}"></div>
      <div>
        <div style="font-size:13px; font-weight:600;">${p.name} (${p.id})</div>
        <div class="meta">${assignedVol.toFixed(0)} m³ | ${assignedWt.toFixed(1)} MT</div>
      </div>
    `;
    legend.appendChild(item);
  });
  // Place legend under Cargo Input section
  const legendContainer = document.getElementById('legend');
  if (legendContainer) {
    legendContainer.innerHTML = '';
    legendContainer.appendChild(legend);
  }

  // Only render tables when allocations exist (after compute)
  if (allocations.length > 0) {
    // Capacity metrics (no commingling): remaining usable = sum Cmax of unused tanks
    const used = new Set(allocations.map(a => a.tank_id));
    let cmaxUsed = 0, cmaxFree = 0, assignedUsed = 0;
    includedTanks.forEach(t => {
      const cmax = t.volume_m3 * t.max_pct;
      if (used.has(t.id)) cmaxUsed += cmax; else cmaxFree += cmax;
    });
    allocations.forEach(a => { assignedUsed += a.assigned_m3; });
    const deadSpace = Math.max(0, cmaxUsed - assignedUsed);
    // Free symmetric pair capacity
    let freePairCap = 0;
    orderedKeys.filter(k => k.startsWith('PAIR:')).forEach(k => {
      const pr = groupMap[k];
      if (pr.port && pr.starboard && !used.has(pr.port.id) && !used.has(pr.starboard.id)) {
        freePairCap += pr.port.volume_m3 * pr.port.max_pct + pr.starboard.volume_m3 * pr.starboard.max_pct;
      }
    });
    const capDiv = document.createElement('div');
    capDiv.className = 'capacity-bar';
    capDiv.innerHTML = `
      <div class="cap-item"><span>Remaining Capacity</span><b>${cmaxFree.toFixed(0)} m³</b></div>
      <div class="cap-item"><span>Unusable / Dead-Space on Tank Tops</span><b>${deadSpace.toFixed(0)} m³</b></div>
    `;
    if (summaryEl) summaryEl.appendChild(capDiv);

    // Allocations table
    const totalVol = allocations.reduce((s,a)=>s+a.assigned_m3,0);
    const totalWt = allocations.reduce((s,a)=>s+a.weight_mt,0);
    const rows = allocations.map(a => {
      const tank = includedTanks.find(t => t.id === a.tank_id);
      const parcel = parcels.find(p => p.id === a.parcel_id);
      return `<tr>
        <td>${a.tank_id}</td>
        <td>${tank?.side || ''}</td>
        <td>${parcel?.name || a.parcel_id}</td>
        <td style="text-align:right;">${a.assigned_m3.toFixed(0)}</td>
        <td style="text-align:right;">${(a.fill_pct*100).toFixed(1)}%</td>
        <td style="text-align:right;">${a.weight_mt.toFixed(1)}</td>
      </tr>`;
    }).join('');
    if (allocTableEl) allocTableEl.innerHTML = `
      <table class="table">
        <thead><tr><th>Tank</th><th>Side</th><th>Parcel</th><th style="text-align:right;">Vol (m³)</th><th style="text-align:right;">Fill %</th><th style="text-align:right;">Weight (MT)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">Totals</td><td style="text-align:right;">${totalVol.toFixed(0)}</td><td></td><td style="text-align:right;">${totalWt.toFixed(1)}</td></tr></tfoot>
      </table>
    `;

    // Ballast table if any ballast allocations exist (rendered in Cargo & Allocation view)
    const bEl = document.getElementById('ballast-table');
    if (bEl) {
      if ((ballastAllocs||[]).length === 0) {
        bEl.innerHTML = '<div class="muted">No ballast used.</div>';
      } else {
        const bRows = ballastAllocs.map(b => {
          const rho = 1.025;
          const pct = isFinite(b.percent) ? Number(b.percent) : (()=>{
            const t = (BALLAST_TANKS||[]).find(x => x.id === b.tank_id);
            if (t && t.cap_m3 > 0 && isFinite(b.assigned_m3)) return (b.assigned_m3 / t.cap_m3) * 100;
            return undefined;
          })();
          return `<tr>
            <td>${b.tank_id}</td>
            <td style="text-align:right;">${isFinite(pct)?pct.toFixed(1)+'%':'-'}</td>
            <td style="text-align:right;">${(b.assigned_m3||0).toFixed(1)}</td>
            <td style="text-align:right;">${rho.toFixed(3)}</td>
            <td style="text-align:right;">${(b.weight_mt||0).toFixed(1)}</td>
          </tr>`;
        }).join('');
        const bTotV = ballastAllocs.reduce((s,b)=>s+(b.assigned_m3||0),0);
        const bTotW = ballastAllocs.reduce((s,b)=>s+(b.weight_mt||0),0);
        bEl.innerHTML = `
          <table class="table">
            <thead><tr><th>Ballast Tank</th><th style=\"text-align:right;\">%</th><th style=\"text-align:right;\">Vol (m³)</th><th style=\"text-align:right;\">ρ (t/m³)</th><th style=\"text-align:right;\">Weight (t)</th></tr></thead>
            <tbody>${bRows}</tbody>
            <tfoot><tr><td>Totals</td><td></td><td style=\"text-align:right;\">${bTotV.toFixed(1)}</td><td></td><td style=\"text-align:right;\">${bTotW.toFixed(1)}</td></tr></tfoot>
          </table>
        `;
      }
    }

    // Parcels summary table
    const parcelRows = parcels.map(p => {
      const vol = allocations.filter(a => a.parcel_id === p.id).reduce((s,a)=>s+a.assigned_m3,0);
      const wt = allocations.filter(a => a.parcel_id === p.id).reduce((s,a)=>s+a.weight_mt,0);
      return `<tr>
        <td><span class="sw" style="display:inline-block; vertical-align:middle; margin-right:6px; background:${p.color || '#888'}"></span>${p.name}</td>
        <td>${p.id}</td>
        <td style="text-align:right;">${p.density_kg_m3}</td>
        <td style="text-align:right;">${vol.toFixed(0)}</td>
        <td style="text-align:right;">${wt.toFixed(1)}</td>
      </tr>`;
    }).join('');
    const parcelTotalVol = allocations.reduce((s,a)=>s+a.assigned_m3,0);
    const parcelTotalWt = allocations.reduce((s,a)=>s+a.weight_mt,0);
  if (parcelTableEl) parcelTableEl.innerHTML = `
      <table class="table">
        <thead><tr><th>Parcel</th><th>ID</th><th style="text-align:right;">ρ (kg/m³)</th><th style="text-align:right;">Assigned Vol (m³)</th><th style="text-align:right;">Weight (MT)</th></tr></thead>
        <tbody>${parcelRows}</tbody>
        <tfoot><tr><td colspan="3">Totals</td><td style="text-align:right;">${parcelTotalVol.toFixed(0)}</td><td style="text-align:right;">${parcelTotalWt.toFixed(1)}</td></tr></tfoot>
      </table>
    `;
  }

  // trace
  // Reasoning trace hidden in UI
}

let variantsCache = null;
let solvingUpperBound = false;
let selectedVariantKey = (typeof localStorage !== 'undefined' && localStorage.getItem(LS_VARIANT)) || 'optimum';

function computeVariants() {
  ensureUniqueParcelIDs();
  // Base plan and alternative selections (cargo-only)
  const base = computePlan(tanks, parcels);
  const alts = computePlanMinKAlternatives(tanks, parcels, 8);
  // Expand candidate pool with other objective modes to increase diversity
  const cMaxK = computePlanMaxK(tanks, parcels);
  const cMinLocked = computePlanMaxRemaining(tanks, parcels);
  const cWing = computePlanSingleWingAlternative(tanks, parcels);
  const candidates = [base, ...alts, cMaxK, cMinLocked, cWing]
    .filter(r => r && Array.isArray(r.allocations) && !(r?.diagnostics?.errors||[]).length);
  // Helper: metrics
  const metric = (r) => {
    const m = computeHydroForAllocations(r.allocations || []);
    const di = r.diagnostics || {};
    return {
      r,
      W: (m && isFinite(m.DWT)) ? m.DWT : (r.allocations||[]).reduce((s,a)=>s+(a.weight_mt||0),0),
      Trim: m ? m.Trim : Infinity,
      Tf: m ? m.Tf : Infinity,
      Tm: m ? m.Tm : Infinity,
      Ta: m ? m.Ta : Infinity,
      dps: isFinite(di.imbalance_pct) ? di.imbalance_pct : 0
    };
  };
  const mets = candidates.map(metric).filter(m => isFinite(m.Tf) && isFinite(m.Tm) && isFinite(m.Ta));
  // Enforce Dmax filter if target provided
  const target = getReverseInputs && rsTargetDraftEl ? getReverseInputs().targetDraft : NaN;
  const withinDmax = (m) => (!isFinite(target) || target <= 0) ? true : (Math.max(m.Tf, m.Tm, m.Ta) <= target + 1e-3);
  const pool = mets.filter(withinDmax);
  // Signature for deduping by allocation volumes
  const sigOf = (res) => (res && Array.isArray(res.allocations))
    ? res.allocations.map(a => `${a.tank_id}:${a.parcel_id}:${Number(a.assigned_m3||0).toFixed(3)}`).sort().join('|')
    : '';
  // Scoring functions
  const absTrim = (m)=> Math.abs(m.Trim || 0);
  const scoreEven = (m)=> ({ key: 'alt_even', m, sort: [absTrim(m), Math.abs(m.dps||0), -m.W] });
  const scoreMax = (m)=> ({ key: 'alt_max', m, sort: [-m.W, absTrim(m), Math.abs(m.dps||0)] });
  const scoreFwd = (m)=> ({ key: 'alt_fwd', m, sort: [ (m.Trim!=null ? (m.Trim<0 ? Math.abs(m.Trim) : 999) : 999), Math.abs(m.dps||0), -m.W ] });
  function sortedBy(scoring) {
    return pool
      .map(scoring)
      .sort((a,b)=>{
        for (let i=0;i<Math.max(a.sort.length,b.sort.length);i++) {
          const av = a.sort[i] ?? 0; const bv = b.sort[i] ?? 0;
          if (av < bv) return -1; if (av > bv) return 1;
        }
        return 0;
      })
      .map(x => x.m.r || base);
  }
  function pickDistinct(scoring, takenSigs) {
    const ordered = sortedBy(scoring);
    for (const r of ordered) {
      const s = sigOf(r);
      if (!takenSigs.has(s)) { takenSigs.add(s); return r; }
    }
    return null;
  }
  const usedSigs = new Set();
  // Always consider base as a valid fallback
  usedSigs.add(sigOf(base));
  const altEven = pickDistinct(scoreEven, usedSigs) || base;
  const altMax = pickDistinct(scoreMax, usedSigs);
  const altFwd = pickDistinct(scoreFwd, usedSigs);
  // Build Max Cargo + Aft Ballast candidate: fill remaining at capacity, then ballast to meet Dmax
  let maxCargoBallast = null;
  try {
    // Fill-remaining at capacity: ensure last parcel's total_m3 is undefined
    const capParcels = parcels.map((p,i,arr) => (i===arr.length-1
      ? { ...p, total_m3: undefined, fill_remaining: true }
      : { ...p, fill_remaining: false }));
    const capRes = computePlan(tanks, capParcels);
    const capAlloc = Array.isArray(capRes.allocations) ? capRes.allocations : [];
    if (capAlloc.length > 0) {
      const capBallast = computeBallastForOptimum(capAlloc, { targetDraft: (isFinite(target)?target:undefined) });
      maxCargoBallast = { allocations: capAlloc, ballastAllocations: Array.isArray(capBallast) ? capBallast : [] };
    }
  } catch {}
  // Optimum: prefer Max Cargo + Ballast if available; otherwise evenkeel cargo + minimal ballast
  let optimumRes;
  if (maxCargoBallast && (maxCargoBallast.allocations||[]).length) {
    optimumRes = maxCargoBallast;
  } else {
    const optBase = altEven;
    const optBallast = computeBallastForOptimum(optBase?.allocations || [], { targetDraft: (isFinite(target)?target:undefined) });
    optimumRes = { allocations: optBase?.allocations || [], ballastAllocations: optBallast || [] };
  }
  // Build variants map but omit duplicates/non-existent results
  const out = {
    optimum: { id: 'Optimum (ballast allowed)', res: optimumRes },
    alt_evenkeel: { id: 'Alt 1 — Evenkeel (no ballast)', res: altEven }
  };
  const sigOpt = sigOf(optimumRes);
  if (altMax && sigOf(altMax) !== sigOf(altEven) && sigOf(altMax) !== sigOpt) out['alt_maxdraft'] = { id: 'Alt 2 — Max Draft (no ballast)', res: altMax };
  if (altFwd && sigOf(altFwd) !== sigOf(altEven) && sigOf(altFwd) !== sigOpt) out['alt_fwdtrim'] = { id: 'Alt 3 — Fwd Trim (no ballast)', res: altFwd };
  // Fallbacks: ensure we always provide three distinct no-ballast alternatives
  const needKeys = ['alt_maxdraft','alt_fwdtrim'];
  const haveSigs = new Set([sigOf(optimumRes), sigOf(out.alt_evenkeel.res)]);
  if (out.alt_maxdraft) haveSigs.add(sigOf(out.alt_maxdraft.res));
  if (out.alt_fwdtrim) haveSigs.add(sigOf(out.alt_fwdtrim.res));
  const distinctList = [];
  const seen = new Set();
  candidates.forEach(r => { const s = sigOf(r); if (!seen.has(s)) { seen.add(s); distinctList.push(r); } });
  for (const k of needKeys) {
    if (!out[k]) {
      const pick = distinctList.find(r => !haveSigs.has(sigOf(r)) && sigOf(r) !== sigOf(out.alt_evenkeel.res));
      if (pick) {
        haveSigs.add(sigOf(pick));
        out[k] = { id: (k==='alt_maxdraft' ? 'Alt 2 — Diversified' : 'Alt 3 — Diversified'), res: pick };
      }
    }
  }
  return out;
}

function fillVariantSelect() {
  if (!variantSelect) return;
  const order = ['optimum','alt_evenkeel','alt_maxdraft','alt_fwdtrim'];
  const opts = order.filter(k => variantsCache[k]).map(k => ({ key: k, label: variantsCache[k].id }));
  if (!opts.find(o => o.key === selectedVariantKey)) selectedVariantKey = opts[0]?.key || 'optimum';
  variantSelect.innerHTML = opts.map(o => `<option value="${o.key}" ${o.key===selectedVariantKey?'selected':''}>${o.label}</option>`).join('');
}

function computeAndRender() {
  // If user set a target draft and last parcel is Fill Remaining,
  // interpret as "max cargo under target" and run upper-bound solver automatically.
  try {
    const inputs = (typeof getReverseInputs === 'function') ? getReverseInputs() : {};
    const target = inputs ? inputs.targetDraft : NaN;
    const fr = Array.isArray(parcels) && parcels.length > 0 ? !!parcels[parcels.length - 1].fill_remaining : false;
    if (!solvingUpperBound && isFinite(target) && target > 0 && fr) {
      solvingUpperBound = true;
      reverseSolveAndRun().finally(() => { solvingUpperBound = false; });
      return;
    }
  } catch {}
  variantsCache = computeVariants();
  // Dmax filter already applied in computeVariants
  fillVariantSelect();
  const v = variantsCache[selectedVariantKey];
  persistLastState();
  if (!v || (v.res?.diagnostics?.errors || []).length > 0 || (variantSelect && variantSelect.options.length === 0)) {
    renderSummaryAndSvg(null);
    return;
  }
  renderSummaryAndSvg(v.res);
}

function ensureUniqueParcelIDs() {
  const seen = new Set();
  parcels = parcels.map((p, idx) => {
    let base = String(p.id || `P${idx+1}`).trim();
    if (!base) base = `P${idx+1}`;
    let unique = base;
    let n = 2;
    while (seen.has(unique)) unique = `${base}_${n++}`;
    seen.add(unique);
    return { ...p, id: unique };
  });
}

// No alternative panel; variants selectable via the Plan Options dropdown

function render() {
  renderTankEditor();
  renderParcelEditor();
  // Live layout preview based on current tank config
  renderSummaryAndSvg(null);
  renderActiveShipInfo();
}

btnCompute.addEventListener('click', computeAndRender);
if (variantSelect) {
  variantSelect.addEventListener('change', () => {
    selectedVariantKey = variantSelect.value;
    try { localStorage.setItem(LS_VARIANT, selectedVariantKey); } catch {}
    // Recompute variants on selection change to ensure fresh scoring under current inputs
    variantsCache = computeVariants();
    const v = variantsCache[selectedVariantKey] || variantsCache['optimum'];
    renderSummaryAndSvg(v.res);
  });
}
// Demo handlers removed
btnAddParcel.addEventListener('click', () => {
  // Ensure only the last parcel can be fill_remaining
  parcels = parcels.map((p, i) => i === parcels.length - 1 ? p : { ...p, fill_remaining: false });
  const idx = parcels.length + 1;
  parcels.push({ id: `P${idx}`, name: `Parcel ${idx}`, total_m3: 0, density_kg_m3: 800, temperature_c: 15, color: '#a855f7' });
  persistLastState();
  render();
});
btnAddCenter.addEventListener('click', () => {
  // Add a center tank with next index number
  const ids = tanks.map(t => t.id);
  let maxIdx = 0;
  ids.forEach(id => { const m = /COT(\d+)/.exec(id); if (m) maxIdx = Math.max(maxIdx, Number(m[1])); });
  const next = maxIdx > 0 ? maxIdx : 1;
  tanks.push({ id: `COT${next}C`, volume_m3: 1000, min_pct: 0.5, max_pct: 0.98, included: true, side: 'center' });
  persistLastState();
  render();
});

// Initial render
const restored = restoreLastState();
refreshPresetSelect();

function autoLoadFirstPresetIfExists() {
  const presets = loadPresets();
  const names = Object.keys(presets).sort((a,b)=>a.localeCompare(b));
  if (names.length === 0) return false;
  const name = names[0];
  const conf = presets[name];
  if (!Array.isArray(conf)) return false;
  tanks = conf.map(t => ({ ...t }));
  try { cfgSelect.value = `preset:${name}`; cfgNameInput.value = name; } catch {}
  // Apply meta if stored for this preset
  try { const meta = loadShipMeta()[name]; if (meta) applyShipMeta(meta); } catch {}
  persistLastState();
  return true;
}

if (!restored) {
  // Try DC active ship first
  let loaded = false;
  try {
    const active = localStorage.getItem('dc_active_ship');
    if (active) {
      // Apply only metadata to preserve user's current tanks
      const metaApplied = applyActiveShipMetaOnly();
      if (metaApplied) loaded = true;
    }
  } catch {}
  if (!loaded) autoLoadFirstPresetIfExists();
}

// If dropdown already has a selection, apply it as active ship on load
// Avoid overriding restored last state
try {
  if (!restored && cfgSelect && cfgSelect.value) {
    applySelectionValue(cfgSelect.value);
  }
} catch {}

render();
// Restore initial view from URL (#view or ?view=) or last view
try {
  const qs = new URLSearchParams(window.location.search || '');
  const fromParam = (qs.get('view') || '').trim();
  const fromHash = (window.location.hash || '').replace(/^#/, '').trim();
  const candidate = fromParam || fromHash || localStorage.getItem(LS_VIEW) || 'cargo';
  const allowed = new Set(['config','cargo','layout','shipdata']);
  setActiveView(allowed.has(candidate) ? candidate : 'cargo');
} catch {}
// Auto-compute on load so Allocation/Layout stay populated after page switches
try { computeAndRender(); } catch {}

// Build payload to transfer current plan to Ship Data (draft calculator)
function buildShipDataTransferPayload() {
  try {
    if (!variantsCache) variantsCache = computeVariants();
    const chosen = variantsCache && (variantsCache[selectedVariantKey] || variantsCache['optimum']);
    const res = chosen && chosen.res;
    if (!res || !Array.isArray(res.allocations) || res.allocations.length === 0) return null;
    const inputs = (typeof getReverseInputs === 'function') ? getReverseInputs() : {};
    // Build parcel -> density (t/m³) map for quick lookup
    const rhoByParcel = new Map();
    try {
      (parcels || []).forEach(p => {
        if (!p || !p.id) return;
        const dk = Number(p.density_kg_m3);
        if (Number.isFinite(dk) && dk > 0) rhoByParcel.set(p.id, dk / 1000);
      });
    } catch {}
    const allocs = res.allocations.map(a => {
      const vol = Number(a.assigned_m3);
      const wt = Number(a.weight_mt);
      let rho = rhoByParcel.get(a.parcel_id);
      if (!Number.isFinite(rho) || !(rho > 0)) {
        // Fallback: derive from W/V if available
        if (Number.isFinite(vol) && vol > 0 && Number.isFinite(wt) && wt > 0) {
          rho = wt / vol; // t/m³ (numerically = g/cm³)
        } else {
          rho = undefined;
        }
      }
      // Also send percent in 0..100 for convenience
      const pct = (Number.isFinite(a.fill_pct) ? (a.fill_pct * 100) : undefined);
      return {
        tank_id: a.tank_id,
        parcel_id: a.parcel_id,
        weight_mt: wt,
        assigned_m3: vol,
        fill_pct: a.fill_pct,
        percent: pct,
        rho
      };
    });
    const ballast = Array.isArray(res.ballastAllocations) ? res.ballastAllocations.map(b => ({
      tank_id: b.tank_id,
      weight_mt: Number(b.weight_mt)||0,
      assigned_m3: Number(b.assigned_m3)||0,
      percent: isFinite(b.percent)?Number(b.percent):undefined,
      rho: 1.025
    })) : [];
    return {
      type: 'apply_stowage_plan',
      version: 1,
      rho: (inputs && isFinite(inputs.rho)) ? Number(inputs.rho) : undefined,
      constant: {
        w: (inputs && isFinite(inputs.constW)) ? Number(inputs.constW) : 0,
        x_midship_m: (inputs && isFinite(inputs.constX)) ? Number(inputs.constX) : 0,
        ref: 'ms_plus'
      },
      consumables: {
        fo: (inputs && isFinite(inputs.fo)) ? Number(inputs.fo) : 0,
        fw: (inputs && isFinite(inputs.fw)) ? Number(inputs.fw) : 0,
        oth: (inputs && isFinite(inputs.oth)) ? Number(inputs.oth) : 0
      },
      allocations: allocs,
      ballast_allocations: ballast
    };
  } catch (_) { return null; }
}

function postPlanToShipData() {
  try {
    const frame = document.querySelector('#view-shipdata iframe');
    if (!frame || !frame.contentWindow) { alert('Ship Data view is not available.'); return; }
    const payload = buildShipDataTransferPayload();
    if (!payload) { alert('No computed allocations to transfer. Run the planner first.'); return; }
    const msg = { type: 'apply_stowage_plan', payload };
    let targetOrigin = '*';
    try { const u = new URL(frame.getAttribute('src') || '', window.location.href); targetOrigin = u.origin; } catch {}
    frame.contentWindow.postMessage(msg, targetOrigin || '*');
    setActiveView('shipdata');
  } catch (_) { alert('Transfer failed.'); }
}

if (btnTransferShipData) {
  btnTransferShipData.addEventListener('click', postPlanToShipData);
}

// Config preset actions
btnSaveCfg.addEventListener('click', () => {
  let name = (cfgNameInput.value || '').trim();
  if (!name) { alert('Enter a config name'); return; }
  // Prevent collision with Hydrostatic (dc) ships by suffixing
  try {
    const dcIdxRaw = localStorage.getItem('dc_ships_index');
    const dcIdx = dcIdxRaw ? JSON.parse(dcIdxRaw) : [];
    if (Array.isArray(dcIdx) && dcIdx.some(e => (e?.name || e?.id) === name)) {
      name = `${name} (Local)`;
    }
  } catch {}
  const presets = loadPresets();
  if (presets[name] && !confirm('Overwrite existing config?')) return;
  // Only save tanks (exclude ephemeral fields)
  const clean = tanks.map(t => ({ id: t.id, volume_m3: t.volume_m3, min_pct: t.min_pct, max_pct: t.max_pct, included: t.included, side: t.side }));
  presets[name] = clean;
  savePresets(presets);
  refreshPresetSelect();
  cfgSelect.value = name;
  // remember the name in the input for clarity
  cfgNameInput.value = name;
  // Also save to a JSON file in project folder via dev server
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth()+1).padStart(2,'0');
  const d = String(today.getDate()).padStart(2,'0');
  const defaultFile = `ships_export_${y}-${m}-${d}.json`;
  saveConfigToFile(defaultFile, name, clean).then((resp) => {
    if (resp && resp.ok) {
      console.log('Saved to', resp.filename);
    } else {
      console.log('Local file save not available (static hosting?)');
    }
  });
});

// Change selected preset -> immediately load into Tank Editor
if (cfgSelect) {
  cfgSelect.addEventListener('change', () => {
    const value = cfgSelect.value;
    if (!value) return;
    applySelectionValue(value);
  });
}

function getDCShipName(id) {
  try {
    const idxRaw = localStorage.getItem('dc_ships_index');
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    const e = Array.isArray(idx) ? idx.find(x => x && x.id === id) : null;
    return e ? (e.name || id) : id;
  } catch { return id; }
}

function loadDCShip(id) {
  try {
    const raw = localStorage.getItem('dc_ship_' + id);
    if (!raw) return false;
    const prof = JSON.parse(raw);
    // Extract meta and apply
    const meta = extractShipMetaFromProfile(prof);
    if (meta) applyShipMeta(meta);
    // Build tanks from cargo list
    const cargoArr = (prof && prof.tanks && Array.isArray(prof.tanks.cargo)) ? prof.tanks.cargo : [];
    const arr = mapCargoArrayToTanks(cargoArr, { min_pct: 0.5, max_pct: 0.98 });
    if (arr && arr.length) tanks = arr.map(t => ({ ...t }));
    return true;
  } catch {
    return false;
  }
}
// Apply only ship metadata (LBP, hydro rows, LCGs) from currently active DC ship without altering tanks
function applyActiveShipMetaOnly() {
  try {
    const id = localStorage.getItem('dc_active_ship');
    if (!id) return false;
    const raw = localStorage.getItem('dc_ship_' + id);
    if (!raw) return false;
    const prof = JSON.parse(raw);
    const meta = extractShipMetaFromProfile(prof);
    if (meta) { applyShipMeta(meta); return true; }
  } catch {}
  return false;
}
// Keep dropdown in sync when Ship Data (draft_calculator) updates localStorage
window.addEventListener('storage', (e) => {
  try {
    if (!e || typeof e.key !== 'string') return;
    if (e.key === 'dc_ships_index' || e.key.startsWith('dc_ship_')) {
      refreshPresetSelect();
    }
    if (e.key === 'dc_active_ship') {
      const applied = applyActiveShipMetaOnly();
      if (applied) { computeAndRender(); renderActiveShipInfo(); }
    }
  } catch {}
});
window.addEventListener('focus', () => { try { refreshPresetSelect(); } catch {} });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { try { refreshPresetSelect(); } catch {} } });
// Load now imports JSON via file chooser and updates only capacities
btnLoadCfg.addEventListener('click', () => {
  if (fileImportCfg) fileImportCfg.click();
});

if (fileImportCfg) {
  fileImportCfg.addEventListener('change', async () => {
    const f = fileImportCfg.files && fileImportCfg.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      // Try multi-ship import first
      const ships = parseShipsFromExport(json);
      if (ships.length > 0) {
        const presets = loadPresets();
        const existingNames = new Set(Object.keys(presets));
        const uniquify = (base) => {
          let name = base;
          let n = 2;
          while (existingNames.has(name)) name = `${base} (${n++})`;
          existingNames.add(name);
          return name;
        };
        const importedNames = [];
        const nameMap = {}; // baseName -> assignedName
        for (const s of ships) {
          const baseName = String(s.name || 'Ship');
          const name = uniquify(baseName);
          const clean = s.tanks.map(t => ({ id: t.id, volume_m3: t.volume_m3, min_pct: t.min_pct, max_pct: t.max_pct, included: t.included, side: t.side }));
          presets[name] = clean;
          importedNames.push(name);
          nameMap[baseName] = name;
        }
        savePresets(presets);
        refreshPresetSelect();
        // If JSON bundle contains full ship profiles, extract and save meta per preset name
        try {
          const metaStore = loadShipMeta();
          if (json && Array.isArray(json.ships)) {
            for (const prof of json.ships) {
              const baseName = prof?.ship?.name || prof?.name || 'Ship';
              const assigned = nameMap[baseName];
              if (!assigned) continue;
              const meta = extractShipMetaFromProfile(prof);
              if (meta) metaStore[assigned] = meta;
            }
            saveShipMeta(metaStore);
          }
        } catch {}
        // Optionally set the first imported ship as current
        if (importedNames.length > 0) {
          const firstName = importedNames[0];
          cfgSelect.value = firstName;
          cfgNameInput.value = firstName;
          tanks = presets[firstName].map(t => ({ ...t }));
          // Apply ship meta if available
          try { const meta = loadShipMeta()[firstName]; if (meta) applyShipMeta(meta); } catch {}
          persistLastState();
          render();
        }
        alert(`${importedNames.length} gemi konfigürasyonu içe aktarıldı: ${importedNames.join(', ')}`);
      } else {
        // Fallback: update only capacities using id mapping
        const vmap = buildVolumeMapFromJSON(json);
        if (!vmap || vmap.size === 0) { alert('JSON içinde tanınan tank kapasitesi bulunamadı.'); return; }
        tanks = tanks.map(t => vmap.has(t.id) ? { ...t, volume_m3: vmap.get(t.id) } : t);
        // Also try to extract single-ship meta if present
        try {
          const metaStore = loadShipMeta();
          let prof = null; let name = (cfgNameInput.value||'').trim() || 'Imported Ship';
          if (json && json.ship && (json.tanks || json.hydrostatics)) prof = json;
          else if (Array.isArray(json) && json.length && json[0] && json[0].ship) prof = json[0];
          if (prof) {
            const meta = extractShipMetaFromProfile(prof);
            if (meta) {
              metaStore[name] = meta;
              saveShipMeta(metaStore);
              applyShipMeta(meta);
            }
          }
        } catch {}
        persistLastState();
        render();
        alert('JSON dosyasından tank kapasiteleri içe aktarıldı.');
      }
    } catch (e) {
      console.warn('Import error', e);
      alert('JSON import başarısız. Dosyayı kontrol edin.');
    } finally {
      fileImportCfg.value = '';
    }
  });
}

// Export Config: download current tanks as JSON
if (btnExportCfg) {
  btnExportCfg.addEventListener('click', () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth()+1).padStart(2,'0');
    const d = String(today.getDate()).padStart(2,'0');
    const filename = `ships_export_${y}-${m}-${d}.json`;
    const clean = tanks.map(t => ({ id: t.id, volume_m3: t.volume_m3, min_pct: t.min_pct, max_pct: t.max_pct, included: t.included, side: t.side }));
    const payload = { saved_at: today.toISOString(), name: (cfgNameInput.value || '').trim() || null, tanks: clean };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}
btnDelCfg.addEventListener('click', () => {
  const selVal = cfgSelect.value;
  if (!selVal) return;
  if (selVal.startsWith('dc:')) { alert('Hydrostatic ships are managed in Ship Data. Use Delete Ship there.'); return; }
  if (selVal.startsWith('preset:')) {
    const name = selVal.slice(7);
    if (!confirm(`Delete config '${name}'?`)) return;
    const presets = loadPresets();
    delete presets[name];
    savePresets(presets);
    refreshPresetSelect();
  }
});

// ---- Compact export for quick copy/paste diagnostics ----
function quickHash(str) {
  // Tiny 32-bit FNV-1a-like hash for short signature
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36);
}

function fmtPct01(x) {
  // 0..1 -> integer percent
  const v = Math.round((x || 0) * 100);
  return String(v);
}

function fmtVol(v) {
  if (!isFinite(v)) return '0';
  const iv = Math.round(v);
  return Math.abs(iv - v) < 1e-6 ? String(iv) : v.toFixed(1);
}

function buildCompactExportText() {
  // Choose currently selected plan (fallback min_k)
  if (!variantsCache) variantsCache = computeVariants();
  const chosen = variantsCache[selectedVariantKey] || variantsCache['optimum'];
  const res = chosen?.res || computePlan(tanks, parcels);
  const di = res?.diagnostics || {};

  // Inputs (compact)
  const tankTokens = (tanks || []).map(t => {
    const inc = t.included === false ? 'x' : '';
    return `${t.id}:${fmtVol(t.volume_m3)}@${fmtPct01(t.min_pct)}-${fmtPct01(t.max_pct)}${inc}`;
  });
  const parcelTokens = (parcels || []).map(p => {
    const fr = p.fill_remaining ? 1 : 0;
    return `${p.id}(${(p.name||'').trim()}):V${fmtVol(p.total_m3||0)} R${fmtVol(p.density_kg_m3||0)} T${fmtVol(p.temperature_c||0)} FR${fr}`;
  });

  // Reverse-solver inputs (if present)
  let reverseLine = '';
  try {
    const target = rsTargetDraftEl && parseFloat(rsTargetDraftEl.value);
    const rho = rsRhoEl && parseFloat(String(rsRhoEl.value||'').replace(',','.'));
    const fo = rsFoEl && parseFloat(rsFoEl.value);
    const fw = rsFwEl && parseFloat(rsFwEl.value);
    const oth = rsOthEl && parseFloat(rsOthEl.value);
    const cst = rsConstEl && parseFloat(rsConstEl.value);
    const clcg = rsConstLcgEl && parseFloat(rsConstLcgEl.value);
    if (isFinite(target) || isFinite(rho) || isFinite(fo) || isFinite(fw) || isFinite(oth) || isFinite(cst)) {
      const parts = [];
      if (isFinite(target)) parts.push(`T=${fmtVol(target)}`);
      if (isFinite(rho)) parts.push(`rho=${String(rho)}`);
      if (isFinite(fo)) parts.push(`FO=${fmtVol(fo)}`);
      if (isFinite(fw)) parts.push(`FW=${fmtVol(fw)}`);
      if (isFinite(oth)) parts.push(`OTH=${fmtVol(oth)}`);
      if (isFinite(cst)) parts.push(`CONST=${fmtVol(cst)}`);
      if (isFinite(clcg)) parts.push(`CONST_LCG=${fmtVol(clcg)}`);
      reverseLine = parts.length ? `RS{${parts.join(' ')}}` : '';
    }
  } catch {}

  // Result summary
  const pwt = di.port_weight_mt != null ? Math.round(di.port_weight_mt) : 0;
  const swt = di.starboard_weight_mt != null ? Math.round(di.starboard_weight_mt) : 0;
  const imb = di.imbalance_pct != null ? Math.round(di.imbalance_pct) : 0;
  const bstat = di.balance_status || 'NA';
  const wcount = (di.warnings || []).length || 0;
  const ecount = (di.errors || []).length || 0;

  // Allocations (only used tanks)
  const allocTokens = (res.allocations || [])
    .map(a => `${a.tank_id}:${a.parcel_id}=${fmtVol(a.assigned_m3)}|F${Math.round((a.fill_pct||0)*100)}|W${fmtVol(a.weight_mt)}`);

  // Minimal trace per parcel (chosen k)
  const trace = Array.isArray(di.reasoning_trace) ? di.reasoning_trace : [];
  const byParcel = new Map();
  trace.forEach(tr => {
    if (!tr || !tr.parcel_id) return;
    byParcel.set(tr.parcel_id, tr);
  });
  const traceTokens = Array.from(byParcel.entries()).map(([pid, tr]) => {
    const kL = tr.k_low != null ? tr.k_low : '?';
    const kH = tr.k_high != null ? tr.k_high : '?';
    const kC = tr.chosen_k != null ? tr.chosen_k : '?';
    const per = tr.per_tank_v != null ? fmtVol(tr.per_tank_v) : '?';
    const par = tr.parity_adjustment || 'n';
    return `${pid}:k${kL}-${kH}->${kC}@${per}(${par})`;
  });

  // Short signature over inputs+allocs
  const sigBase = JSON.stringify({
    t: tanks.map(t => ({ id: t.id, v: t.volume_m3, a: t.min_pct, b: t.max_pct, i: !!t.included })),
    p: parcels.map(p => ({ id: p.id, v: p.total_m3, r: p.density_kg_m3, t: p.temperature_c, fr: !!p.fill_remaining })),
    a: (res.allocations||[]).map(a => ({ t: a.tank_id, p: a.parcel_id, v: a.assigned_m3 }))
  });
  const sig = quickHash(sigBase);

  const now = new Date();
  const hdr = `STW v1 ${now.toISOString()} opt=${chosen?.id || 'min_k'} sig=${sig}`;
  // Hydro summary for export (if available)
  let hydroLine = null;
  try {
    const m = computeHydroForAllocations(res.allocations || []);
    if (m) {
      const H = interpHydro(HYDRO_ROWS, m.Tm || 0) || {};
      hydroLine = `Hydro: DIS=${fmtVol(m.W_total)} DWT=${fmtVol(m.DWT)} Tf=${(m.Tf||0).toFixed(3)} Tm=${(m.Tm||0).toFixed(3)} Ta=${(m.Ta||0).toFixed(3)} Trim=${(m.Trim||0).toFixed(3)} LCF=${isFinite(H.LCF)?H.LCF.toFixed(2):'-'} LBP=${isFinite(SHIP_PARAMS.LBP)?SHIP_PARAMS.LBP.toFixed(2):'-'} rho=${isFinite(getReverseInputs().rho)?String(getReverseInputs().rho):String(SHIP_PARAMS.RHO_REF)}`;
    }
  } catch {}
  const lines = [
    hdr,
    `Tanks(${tanks.length}): ${tankTokens.join(' ')}`,
    `Parcels(${parcels.length}): ${parcelTokens.join(' ')}`,
    reverseLine ? reverseLine : null,
    hydroLine,
    `Diag: P=${pwt} S=${swt} ${bstat} d%=${imb} warns=${wcount} errs=${ecount}`,
    `Alloc(${allocTokens.length}): ${allocTokens.join(' ')}`,
    traceTokens.length ? `Trace: ${traceTokens.join(' ')}` : null
  ].filter(Boolean);
  return lines.join('\n');
}

// Export current scenario (compact text). Hold Shift to export previous full JSON.
btnExportJson.addEventListener('click', async (ev) => {
  try {
    if (ev && ev.shiftKey) {
      // Previous behavior: export verbose JSON for all plan options
      if (!variantsCache) variantsCache = computeVariants();
      const plans = {};
      Object.entries(variantsCache).forEach(([key, entry]) => {
        const { id, res } = entry;
        plans[key] = { label: id, allocations: res.allocations || [], diagnostics: res.diagnostics || null };
      });
      const data = { tanks, parcels, plans };
      const text = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(text);
      alert('Copied ALL plan options JSON to clipboard.');
      return;
    }
  } catch {}

  const compact = buildCompactExportText();
  try {
    await navigator.clipboard.writeText(compact);
    alert('Kısa çıktı panoya kopyalandı. (Shift = tam JSON)');
  } catch (e) {
    console.log(compact);
    alert('Otomatik kopyalanamadı. Kısa çıktı console\'a yazdırıldı.');
  }
});

// Expose small debug API for console usage
window.stowage = {
  getState: () => ({ tanks, parcels }),
  compute: () => computePlan(tanks, parcels),
  export: () => JSON.stringify({ tanks, parcels, result: computePlan(tanks, parcels) }, null, 2)
};

// expose engine variants
window.stowageEngine = { computePlanMaxRemaining, computePlanMinTanksAggressive };

// ---------------- Reverse-solver: helpers ----------------
async function ensureHydroLoaded() {
  if (HYDRO_ROWS && HYDRO_ROWS.length) return HYDRO_ROWS;
  try {
    const res = await fetch('./data/hydrostatics.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const rows = Array.isArray(json.rows) ? json.rows : [];
    HYDRO_ROWS = rows.sort((a,b)=>a.draft_m - b.draft_m);
    return HYDRO_ROWS;
  } catch { return null; }
}

async function ensureLCGMapLoaded() {
  if (TANK_LCG_MAP && TANK_LCG_MAP.size) return TANK_LCG_MAP;
  const map = new Map();
  try {
    const res = await fetch('./data/tanks.json', { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      const arr = Array.isArray(json.tanks) ? json.tanks : [];
      arr.forEach(t => {
        if (!t || typeof t.lcg !== 'number') return;
        const norm = normalizeCargoNameToId(t.name || t.id || '');
        if (norm && /^COT\d+(P|S|C)$/.test(norm.id)) {
          map.set(norm.id, Number(t.lcg));
        } else if (/SLOP/i.test(String(t.name||''))) {
          const side = /(\(|\s)(P|S)(\)|\b)/.exec(String(t.name||'').toUpperCase());
          if (side && side[2]==='P') map.set('SLOPP', Number(t.lcg));
          if (side && side[2]==='S') map.set('SLOPS', Number(t.lcg));
        }
      });
    }
  } catch {}
  TANK_LCG_MAP = map;
  return TANK_LCG_MAP;
}

function interpHydro(rows, T) {
  if (!rows || rows.length === 0 || !isFinite(T)) return null;
  const rho_ref = SHIP_PARAMS.RHO_REF || 1.025;
  const getDISFW = (r) => {
    const fw = (r && typeof r.dis_fw === 'number') ? r.dis_fw : null;
    if (isFinite(fw)) return fw;
    const sw = (r && typeof r.dis_sw === 'number') ? r.dis_sw : null;
    return isFinite(sw) ? (sw / rho_ref) : undefined;
  };
  if (T <= rows[0].draft_m) return {
    LCF: rows[0].lcf_m, LCB: rows[0].lcb_m, TPC: rows[0].tpc, MCT1cm: rows[0].mct, DIS_FW: getDISFW(rows[0])
  };
  if (T >= rows[rows.length - 1].draft_m) {
    const r = rows[rows.length - 1];
    return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct, DIS_FW: getDISFW(r) };
  }
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].draft_m <= T) lo = mid; else hi = mid;
  }
  const a = rows[lo], b = rows[hi];
  const t = (T - a.draft_m) / (b.draft_m - a.draft_m);
  const lerp = (x,y)=> x + (y - x) * t;
  const aFW = getDISFW(a); const bFW = getDISFW(b);
  const DIS_FW = (isFinite(aFW) && isFinite(bFW)) ? lerp(aFW, bFW) : undefined;
  return { LCF: lerp(a.lcf_m, b.lcf_m), LCB: lerp(a.lcb_m, b.lcb_m), TPC: lerp(a.tpc, b.tpc), MCT1cm: lerp(a.mct, b.mct), DIS_FW };
}

function solveDraftByDisFW(rows, target_dis_fw) {
  // rows: have draft_m and dis_fw (tons at ρ=1.0)
  if (!rows || rows.length === 0 || !isFinite(target_dis_fw)) return null;
  const rho_ref = SHIP_PARAMS.RHO_REF || 1.025;
  const toFW = (r) => (typeof r.dis_fw === 'number') ? r.dis_fw : ((typeof r.dis_sw === 'number') ? (r.dis_sw / rho_ref) : undefined);
  const seq = rows
    .filter(r => isFinite(r.draft_m))
    .map(r => ({ T: r.draft_m, Y: toFW(r) }))
    .filter(p => isFinite(p.Y));
  if (!seq.length) return null;
  if (target_dis_fw <= seq[0].Y) return seq[0].T;
  if (target_dis_fw >= seq[seq.length - 1].Y) return seq[seq.length - 1].T;
  let lo = 0, hi = seq.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (seq[mid].Y <= target_dis_fw) lo = mid; else hi = mid;
  }
  const a = seq[lo], b = seq[hi];
  const t = (target_dis_fw - a.Y) / (b.Y - a.Y);
  return a.T + (b.T - a.T) * t;
}

function getReverseInputs() {
  const parseNum = (el, fallback = 0) => {
    if (!el) return fallback;
    const v = String(el.value || '').replace(',', '.');
    const n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  };
  return {
    targetDraft: parseNum(rsTargetDraftEl, NaN),
    rho: parseNum(rsRhoEl, (SHIP_PARAMS.RHO_REF != null ? SHIP_PARAMS.RHO_REF : NaN)),
    fo: parseNum(rsFoEl, 0),
    fw: parseNum(rsFwEl, 0),
    oth: parseNum(rsOthEl, 0),
    constW: parseNum(rsConstEl, 0),
    constX: parseNum(rsConstLcgEl, 0)
  };
}

function computeHydroForAllocations(allocations) {
  if (!HYDRO_ROWS || !allocations) return null;
  // Build items
  const inputs = getReverseInputs();
  const { rho, fo, fw, oth, constW, constX } = inputs;
  let W = 0, Mx = 0;
  // cargo allocations
  allocations.forEach(a => {
    const w = a.weight_mt || 0;
    const x = TANK_LCG_MAP.has(a.tank_id) ? Number(TANK_LCG_MAP.get(a.tank_id)) : 0;
    W += w;
    Mx += w * (isFinite(x) ? x : 0);
  });
  // consumables
  const consLCG = SHIP_PARAMS.LCG_FO_FW;
  const consW = (fo||0) + (fw||0) + (oth||0);
  W += consW;
  if (isFinite(consLCG)) Mx += consW * consLCG;
  // constant
  if (constW && isFinite(constX)) { W += constW; Mx += constW * constX; }
  // lightship
  if (isFinite(LIGHT_SHIP.weight_mt)) {
    W += LIGHT_SHIP.weight_mt; if (isFinite(LIGHT_SHIP.lcg)) Mx += LIGHT_SHIP.weight_mt * LIGHT_SHIP.lcg;
  }
  if (!(W > 0)) return null;
  const LCG = Mx / W;
  const Tm = solveDraftByDisFW(HYDRO_ROWS, W / rho);
  if (!isFinite(Tm)) return null;
  const H = interpHydro(HYDRO_ROWS, Tm);
  // Use LCB for trim moment, sign convention: stern trim (+)
  const LCB = (H && typeof H.LCB === 'number') ? H.LCB : 0;
  const MCT = (H && typeof H.MCT1cm === 'number' && H.MCT1cm !== 0) ? H.MCT1cm : null;
  const trim_cm = (MCT ? ( - (W * (LCG - LCB)) / MCT ) : 0);
  const trim_m = trim_cm / 100.0;
  const LBP = (typeof SHIP_PARAMS.LBP === 'number' && SHIP_PARAMS.LBP > 0) ? SHIP_PARAMS.LBP : null;
  let Tf = Tm, Ta = Tm;
  if (LBP) {
    const dAP = (LBP/2) + (H?.LCF || 0);
    const dFP = (LBP/2) - (H?.LCF || 0);
    Tf = Tm - trim_m * (dFP / LBP);
    Ta = Tm + trim_m * (dAP / LBP);
  }
  const DWT = isFinite(LIGHT_SHIP.weight_mt) ? (W - LIGHT_SHIP.weight_mt) : W;
  return { W_total: W, DWT, Tf, Tm, Ta, Trim: trim_m };
}

// Compute minimal symmetric ballast (P/S pairs) to meet strict trim tolerance for Optimum variant.
function computeBallastForOptimum(cargoAllocs, opts) {
  try {
    if (!HYDRO_ROWS || !Array.isArray(cargoAllocs)) return [];
    if (!Array.isArray(BALLAST_TANKS) || BALLAST_TANKS.length < 2) return [];
    const baseM = computeHydroForAllocations(cargoAllocs);
    if (!baseM) return [];
    if (Math.abs(baseM.Trim || 0) <= TOL_TRIM_M) return [];
    const targetDraft = (opts && isFinite(opts.targetDraft)) ? Number(opts.targetDraft) : NaN;
    const rho = getReverseInputs().rho || (SHIP_PARAMS.RHO_REF || 1.025);
    // Build P/S pairs by name heuristic (… P / … S)
    const pairsMap = new Map();
    const getSide = (s)=>/(\(|\s|\b)P(\)|\s|\b)$/.test(s.toUpperCase())? 'P' : (/(\(|\s|\b)S(\)|\s|\b)$/.test(s.toUpperCase())? 'S' : null);
    const baseKey = (s)=>{
      const u = s.toUpperCase().trim();
      return u.replace(/(\s*\(?[PS]\)?\s*)$/, '').trim();
    };
    BALLAST_TANKS.forEach(t => {
      const id = t.id || t.name; if (!id) return;
      const side = getSide(id); if (!side) return; // require explicit P/S to form pairs
      const key = baseKey(id);
      const entry = pairsMap.get(key) || { P:null, S:null };
      entry[side] = t; pairsMap.set(key, entry);
    });
    const pairs = [];
    pairsMap.forEach((v,k) => { if (v.P && v.S) pairs.push({ key:k, P:v.P, S:v.S }); });
    if (pairs.length === 0) return [];
    // Helper: LCG lookup
    const getLCG = (id, fallback)=> TANK_LCG_MAP.has(id) ? Number(TANK_LCG_MAP.get(id)) : (fallback ?? 0);
    // Working state
    let ballast = [];
    let curAllocs = cargoAllocs.slice();
    let m = baseM;
    let iter = 0;
    while (Math.abs(m.Trim || 0) > TOL_TRIM_M + 1e-4 && iter < 6) {
      iter++;
      const H = interpHydro(HYDRO_ROWS, m.Tm);
      if (!H || !isFinite(H.MCT1cm)) break;
      const LCF = H.LCF || 0;
      const M_req = -(m.Trim * 100.0) * H.MCT1cm; // t·m needed about LCF
      const desir = M_req >= 0 ? 1 : -1;
      // Rank pairs by lever magnitude in desired direction
      const ranked = pairs
        .map(p => {
          const lcg = ((getLCG(p.P.id, p.P.lcg) + getLCG(p.S.id, p.S.lcg)) / 2) || 0;
          const lever = lcg - LCF; // m
          const cap_m3 = (Number(p.P.cap_m3)||0) + (Number(p.S.cap_m3)||0);
          return { p, lcg, lever, cap_m3 };
        })
        .filter(x => x.cap_m3 > 0 && x.lever * desir > 0 && Math.abs(x.lever) > 1e-6)
        .sort((a,b)=> Math.abs(b.lever) - Math.abs(a.lever));
      if (ranked.length === 0) break;
      const pick = ranked[0];
      const capW = pick.cap_m3 * rho; // t
      const wNeeded = Math.min(Math.abs(M_req) / Math.abs(pick.lever), capW);
      if (!(wNeeded > 0)) break;
      // Try full wNeeded then back off if Dmax violated
      function buildBallast(w) {
        const wSide = w/2;
        const vSide = wSide / rho;
        const pP = { tank_id: pick.p.P.id, parcel_id: 'BALLAST', weight_mt: wSide, assigned_m3: vSide, percent: (pick.p.P.cap_m3>0? (vSide/pick.p.P.cap_m3*100):undefined) };
        const pS = { tank_id: pick.p.S.id, parcel_id: 'BALLAST', weight_mt: wSide, assigned_m3: vSide, percent: (pick.p.S.cap_m3>0? (vSide/pick.p.S.cap_m3*100):undefined) };
        return [pP, pS];
      }
      let wTry = wNeeded;
      let ok = true;
      if (isFinite(targetDraft) && targetDraft > 0) {
        // Binary search fraction to satisfy Dmax
        let lo = 0, hi = 1, best = 0;
        for (let k=0;k<20;k++) {
          const f = (lo + hi) / 2;
          const test = buildBallast(wNeeded * f);
          const mt = computeHydroForAllocations(curAllocs.concat(ballast, test));
          if (mt) {
            const maxT = Math.max(mt.Tf||0, mt.Tm||0, mt.Ta||0);
            if (maxT <= targetDraft + 1e-3) { best = f; lo = f; } else { hi = f; }
          } else { hi = f; }
        }
        wTry = wNeeded * best;
        ok = best > 1e-4;
      }
      if (!ok || !(wTry > 0)) break;
      const add = buildBallast(wTry);
      ballast = ballast.concat(add);
      curAllocs = cargoAllocs.concat(ballast);
      const m2 = computeHydroForAllocations(curAllocs);
      if (!m2) break;
      m = m2;
    }
    return ballast;
  } catch { return []; }
}

async function reverseSolveAndRun() {
  await ensureHydroLoaded();
  await ensureLCGMapLoaded();
  if (!HYDRO_ROWS || HYDRO_ROWS.length === 0) { alert('Hydrostatics not found. Ensure draft_calculator/data/hydrostatics.json is present.'); return; }
  const { targetDraft, rho } = getReverseInputs();
  // If target is empty/zero/invalid, do not apply any max draft constraint; just run normal compute
  if (!isFinite(targetDraft) || targetDraft <= 0) { computeAndRender(); setActiveView('layout'); return; }

  // If last parcel is Fill Remaining: implement user's simple TPC-guided mass iteration on FR parcel
  try {
    if (Array.isArray(parcels) && parcels.length > 0 && parcels[parcels.length - 1].fill_remaining) {
      const frIdx = parcels.length - 1;
      const frId = parcels[frIdx].id;
      const origParcels = parcels.map(p => ({ ...p }));

      // Capacity headroom for FR (with other parcels fixed)
      const pfixed = origParcels.map((p,i)=> ({ ...p, fill_remaining: false, total_m3: (i===frIdx ? 0 : (p.total_m3 || 0)) }));
      const rFixed = computePlan(tanks, pfixed);
      const allocFixed = Array.isArray(rFixed.allocations) ? rFixed.allocations.filter(a => a.parcel_id !== frId) : [];
      const usedVolByTank = new Map();
      allocFixed.forEach(a => usedVolByTank.set(a.tank_id, (usedVolByTank.get(a.tank_id)||0) + (a.assigned_m3||0)));
      const includedTanks = (tanks||[]).filter(t => t && t.included);
      let Vcap = 0;
      includedTanks.forEach(t => {
        const cmax = (t.volume_m3||0) * (t.max_pct||0);
        const used = usedVolByTank.get(t.id) || 0;
        const head = Math.max(0, cmax - used);
        Vcap += head;
      });

      // Start at capacity FR assignment
      const rCap = computePlan(tanks, origParcels.map((p,i)=> ({ ...p, fill_remaining: (i===frIdx ? true : false) })));
      const VcapAssigned = (rCap.allocations||[]).filter(a => a.parcel_id === frId).reduce((s,a)=> s + (a.assigned_m3||0), 0);
      let V = Math.min(Vcap, VcapAssigned);
      const rho_cargo = Number(origParcels[frIdx].density_kg_m3 || 1000);

      for (let iter = 0; iter < 24; iter++) {
        const testParcels = origParcels.map((p,i)=> ({ ...p, fill_remaining: false, total_m3: (i===frIdx ? V : (p.total_m3||0)) }));
        const r = computePlan(tanks, testParcels);
        const okAlloc = r && Array.isArray(r.allocations) && r.allocations.length > 0 && !(r?.diagnostics?.errors||[]).length;
        if (!okAlloc) { V = (V + 0) / 2; continue; }
        const m = computeHydroForAllocations(r.allocations);
        if (!m) { V = (V + 0) / 2; continue; }
        const maxT = Math.max(m.Tf||0, m.Tm||0, m.Ta||0);
        if (Math.abs(maxT - targetDraft) <= 1e-3) {
          parcels = testParcels; persistLastState(); computeAndRender(); setActiveView('layout'); return;
        }
        // Guide next V using TPC at Tm
        const Hm = interpHydro(HYDRO_ROWS, m.Tm || 0) || {};
        const TPC = Number(Hm.TPC || 0); // t/cm
        if (!isFinite(TPC) || TPC <= 0 || rho_cargo <= 0) {
          // fallback: halve/double step with clamp
          if (maxT > targetDraft) V = Math.max(0, V * 0.5); else V = Math.min(Vcap, V + (Vcap - V) * 0.5);
          continue;
        }
        const dT = (targetDraft - maxT); // m
        const dW = TPC * (dT * 100); // tons to add (if positive) or remove (if negative)
        const dV = (dW * 1000) / rho_cargo; // m3
        const Vnext = Math.max(0, Math.min(Vcap, V + dV));
        if (Math.abs(Vnext - V) < 1e-3) { // cm-level no progress → stop
          parcels = testParcels; persistLastState(); computeAndRender(); setActiveView('layout'); return;
        }
        V = Vnext;
      }
      // After loop, accept last test V
      parcels = origParcels.map((p,i)=> ({ ...p, fill_remaining: false, total_m3: (i===frIdx ? V : (p.total_m3||0)) }));
      persistLastState(); computeAndRender(); setActiveView('layout'); return;
    }
  } catch {}

  // NEW: Capacity-first upper-bound logic (simple and monotonic)
  try {
    const origParcels = parcels.map(p => ({ ...p }));
    const capParcels = origParcels.map((p,i,arr) => (i===arr.length-1 ? { ...p, fill_remaining: true } : { ...p }));
    const capRes = computePlan(tanks, capParcels);
    const capHydro = computeHydroForAllocations(capRes.allocations || []);
    if (capHydro) {
      const maxTcap = Math.max(capHydro.Tf||0, capHydro.Tm||0, capHydro.Ta||0);
      if (maxTcap <= targetDraft + 1e-3) {
        parcels = capParcels;
        persistLastState();
        computeAndRender();
        setActiveView('layout');
        return;
      }
      // Build base volumes by parcel from capacity plan
      const baseVolMap = new Map();
      (capRes.allocations || []).forEach(a => {
        baseVolMap.set(a.parcel_id, (baseVolMap.get(a.parcel_id)||0) + (a.assigned_m3||0));
      });
      if ((capRes.allocations||[]).length > 0) {
        let sLo = 0.0, sHi = 1.0, sBest = null;
        for (let iter = 0; iter < 28; iter++) {
          const s = (sLo + sHi) / 2;
          const testParcels = origParcels.map(p => ({ ...p, fill_remaining: false, total_m3: Number.isFinite(baseVolMap.get(p.id)) ? baseVolMap.get(p.id) * s : 0 }));
          const r = computePlan(tanks, testParcels);
          const okAlloc = r && Array.isArray(r.allocations) && r.allocations.length > 0 && !(r?.diagnostics?.errors||[]).length;
          if (!okAlloc) { sLo = s; continue; }
          const m = computeHydroForAllocations(r.allocations);
          if (!m) { sLo = s; continue; }
          const maxT = Math.max(m.Tf||0, m.Tm||0, m.Ta||0);
          if (maxT <= targetDraft + 1e-3) { sBest = s; sLo = s; } else { sHi = s; }
        }
        if (sBest != null) {
          parcels = origParcels.map(p => ({ ...p, fill_remaining: false, total_m3: Number.isFinite(baseVolMap.get(p.id)) ? baseVolMap.get(p.id) * sBest : 0 }));
          persistLastState();
          computeAndRender();
          setActiveView('layout');
          return;
        }
      }
    }
  } catch {}
  // Compute target displacement at given draft
  const Ht = interpHydro(HYDRO_ROWS, targetDraft);
  if (!Ht || !isFinite(Ht.DIS_FW)) { alert('Hydro table missing DIS(FW).'); return; }
  const W_target = Ht.DIS_FW * rho; // tons at given density
  const { fo, fw, oth, constW } = getReverseInputs();
  const W_known = (LIGHT_SHIP.weight_mt) + (fo||0) + (fw||0) + (oth||0) + (constW||0);
  let M_cargo_allow = Math.max(0, W_target - W_known);

  // Determine base parcel volumes as proportions
  const baseVolumes = parcels.map(p => {
    const v0 = (p.total_m3 != null && isFinite(Number(p.total_m3))) ? Number(p.total_m3) : 1.0;
    const rho_i = p.density_kg_m3 || 1000;
    return { id: p.id, v0, rho_i };
  });
  const denomMass0 = baseVolumes.reduce((s, r) => s + (r.v0 * (r.rho_i/1000)), 0) || 1;
  const scaleHydro = M_cargo_allow / denomMass0; // scales volumes to meet hydro mass

  // Try high → if infeasible or violates max draft, decrease scale until feasible
  let sLo = 0, sHi = scaleHydro, sBest = 0;
  for (let iter = 0; iter < 20; iter++) {
    const s = (sLo + sHi) / 2;
    // Apply tentative volumes
    const old = parcels.map(p => ({ ...p }));
    parcels = parcels.map(p => {
      const b = baseVolumes.find(r => r.id === p.id);
      const v = (b ? b.v0 : 0) * s;
      return { ...p, total_m3: Number.isFinite(v) ? v : 0, fill_remaining: false };
    });
    let r = computePlan(tanks, parcels);
    let hasAlloc = r && Array.isArray(r.allocations) && r.allocations.length > 0;
    const hasErr = !!(r?.diagnostics?.errors || []).length;
    let ok = false;
    if (hasAlloc && !hasErr) {
      const m = computeHydroForAllocations(r.allocations);
      if (m) {
        const maxT = Math.max(m.Tf || 0, m.Tm || 0, m.Ta || 0);
        // Upper-bound constraint: accept any plan with max(F/M/A) <= target
        ok = (maxT <= targetDraft + 1e-3);
      }
    }
    // If no allocations at this scale due to per-tank mins, try relaxed band (progressively allow underfill)
    if (!hasAlloc || hasErr) {
      try {
        const tries = [2, 6, 999];
        for (const slots of tries) {
          const rRelax = computePlanMinKPolicy(tanks, parcels, { bandMinPctOverride: 0.0, bandSlotsLeftOverride: slots, aggressiveSingleWing: true });
          if (rRelax && Array.isArray(rRelax.allocations) && rRelax.allocations.length) {
            r = rRelax;
            hasAlloc = true;
            const m = computeHydroForAllocations(r.allocations);
            if (m) {
              const maxT = Math.max(m.Tf || 0, m.Tm || 0, m.Ta || 0);
              ok = (maxT <= targetDraft + 1e-3);
            }
            break;
          }
        }
      } catch {}
    }
    if (ok) { sBest = s; sLo = s; }
    else {
      // If no allocations (below per-tank min cap), move upward; otherwise drafts too high → move downward
      if (!hasAlloc || hasErr) sLo = s; else sHi = s;
    }
    // restore for next iteration
    parcels = old;
  }
  if (sBest <= 0) {
    // Fallback: if current parcels (e.g., Fill Remaining) at capacity already satisfy target, accept them
    try {
      // Build a capacity plan: preserve fill_remaining flags if user had them
      const capOld = parcels.map(p => ({ ...p }));
      const withFR = capOld.map((p,i,arr) => (i===arr.length-1 ? { ...p, fill_remaining: true, total_m3: p.total_m3 } : { ...p }));
      parcels = withFR;
      let rCap = computePlan(tanks, parcels);
      let mCap = computeHydroForAllocations(rCap.allocations || []);
      // If still no alloc due to mins, try relaxed policy at capacity too
      if (!mCap || !(rCap.allocations||[]).length) {
        rCap = computePlanMinKPolicy(tanks, parcels, { bandMinPctOverride: 0.0, bandSlotsLeftOverride: 999, aggressiveSingleWing: true });
        mCap = computeHydroForAllocations(rCap.allocations || []);
      }
      parcels = capOld; // restore
      if (mCap) {
        const maxT2 = Math.max(mCap.Tf || 0, mCap.Tm || 0, mCap.Ta || 0);
        if (maxT2 <= targetDraft + 1e-3) { computeAndRender(); setActiveView('layout'); return; }
      }
    } catch {}
    alert('No feasible distribution under tank limits for the target draft. Try lowering target draft or adjust limits.');
    return;
  }
  // Apply best volumes and run variants
  parcels = parcels.map(p => {
    const b = baseVolumes.find(r => r.id === p.id);
    const v = (b ? b.v0 : 0) * sBest;
    return { ...p, total_m3: Number.isFinite(v) ? v : 0, fill_remaining: false };
  });
  persistLastState();
  // If still below target and not all tanks full, try to increase by allowing the last parcel to fill remaining up to capacity
  try {
    const rBest = computePlan(tanks, parcels);
    const mBest = computeHydroForAllocations(rBest.allocations || []);
    if (mBest) {
      const maxT = Math.max(mBest.Tf||0, mBest.Tm||0, mBest.Ta||0);
      if (maxT < targetDraft - 1e-3) {
        const capOld = parcels.map(p => ({ ...p }));
        const withFR = capOld.map((p,i,arr) => (i===arr.length-1 ? { ...p, fill_remaining: true, total_m3: p.total_m3 } : { ...p }));
        parcels = withFR;
        const rUp = computePlan(tanks, parcels);
        const mUp = computeHydroForAllocations(rUp.allocations || []);
        parcels = capOld;
        if (mUp) {
          const maxUp = Math.max(mUp.Tf||0, mUp.Tm||0, mUp.Ta||0);
          if (maxUp <= targetDraft + 1e-3) {
            parcels = withFR;
          }
        }
      }
    }
  } catch {}
  computeAndRender();
  setActiveView('layout');
}

if (btnSolveDraft) {
  btnSolveDraft.addEventListener('click', reverseSolveAndRun);
}
