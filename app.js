import { buildDefaultTanks, buildT10Tanks, computePlan, computePlanMaxRemaining, computePlanMinTanksAggressive, computePlanSingleWingAlternative, computePlanMinKAlternatives, computePlanMinKeepSlopsSmall } from './engine/stowage.js?v=4';

// Reverse-solver: minimal hydro + LCG integration (from draft_calculator data)
const SHIP_PARAMS = { LBP: 171.2, RHO_REF: 1.025, LCG_FO_FW: -56.232 };
const LIGHT_SHIP = { weight_mt: 9070, lcg: -9.85 };
let HYDRO_ROWS = null; // cached hydro rows from draft_calculator
/** @type {Map<string, number>} */
let TANK_LCG_MAP = new Map(); // map tank_id -> lcg (midship +forward)

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
  const presets = loadPresets();
  const names = Object.keys(presets).sort((a,b)=>a.localeCompare(b));
  cfgSelect.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
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
    if (isFinite(p.ship.lbp)) meta.lbp = Number(p.ship.lbp);
    if (isFinite(p.ship.rho_ref)) meta.rho_ref = Number(p.ship.rho_ref);
    if (p.ship.light_ship && isFinite(p.ship.light_ship.weight) && isFinite(p.ship.light_ship.lcg)) {
      meta.light_ship = { weight_mt: Number(p.ship.light_ship.weight), lcg: Number(p.ship.light_ship.lcg) };
    }
    if (p.hydrostatics && Array.isArray(p.hydrostatics.rows)) {
      meta.hydrostatics = { rows: p.hydrostatics.rows.slice().sort((a,b)=>a.draft_m-b.draft_m) };
    }
    // Build tank LCG map for cargo/slops
    const tank_lcgs = {};
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
    }
    if (Object.keys(tank_lcgs).length) meta.tank_lcgs = tank_lcgs;
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
    return `<tr>
      <td><input value="${p.id}" data-idx="${idx}" data-field="id" style="width:70px"/></td>
      <td><input value="${p.name}" data-idx="${idx}" data-field="name" style="width:120px"/></td>
      <td><input type="number" step="0.001" min="0" value="${p.total_m3 != null ? Number(p.total_m3).toFixed(3) : ''}" data-idx="${idx}" data-field="total_m3" style="width:90px" ${p.fill_remaining? 'disabled':''}/></td>
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
        <tr><th>Parcel No.</th><th>Name</th><th>Total (m³)</th><th>Fill Remaining</th><th>Density (g/cm³)</th><th>T (°C)</th><th>Color</th><th></th></tr>
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
  let diagnostics = null;
  let reasoningTrace = [];
  if (result) {
    allocations = result.allocations || [];
    diagnostics = result.diagnostics || null;
    const { port_weight_mt, starboard_weight_mt, imbalance_pct, balance_status, warnings, errors } = diagnostics || {};
    if (diagnostics) {
      reasoningTrace = diagnostics.reasoning_trace || [];
      const dir = (port_weight_mt||0) > (starboard_weight_mt||0) ? 'port' : ((port_weight_mt||0) < (starboard_weight_mt||0) ? 'starboard' : 'even');
      const warnLine = balance_status === 'Balanced'
        ? 'Balanced'
        : `Warning imbalance ${(imbalance_pct||0).toFixed(2)}%${dir==='even'?'':` (list to ${dir})`}`;
      if (summaryEl) summaryEl.innerHTML = `
        <div class="summary-bar" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div>Port <b>${(port_weight_mt||0).toFixed(2)}</b> MT</div>
          <div>${warnLine}</div>
          <div>Starboard <b>${(starboard_weight_mt||0).toFixed(2)}</b> MT</div>
        </div>
      `;
      const warnLines = [];
      (warnings || []).forEach(w => {
        if (!/Reserved small-tank buffer pairs/.test(w)) warnLines.push('• ' + w);
      });
      (diagnostics.errors || []).forEach(w => warnLines.push('✖ ' + w));
      if (warnsEl) warnsEl.textContent = warnLines.join('\n');
    }
  }

  // Hydro summary (optional): compute F/M/A drafts, trim, displacement, DWT if hydro rows & LCG map available
  (async () => {
    try {
      const hbox = hydroSummaryEl;
      if (!hbox) return;
      if (!HYDRO_ROWS) await ensureHydroLoaded();
      if (!HYDRO_ROWS || HYDRO_ROWS.length === 0) { hbox.style.display = 'none'; return; }
      const metrics = computeHydroForAllocations(allocations);
      if (!metrics) { hbox.style.display = 'none'; return; }
      const { W_total, DWT, Tf, Tm, Ta, Trim } = metrics;
      hbox.style.display = 'block';
      hbox.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(auto-fit,minmax(140px,1fr)); gap:8px; font-size:13px;">
          <div><div class="muted">Displacement (t)</div><div><b>${W_total.toFixed(1)}</b></div></div>
          <div><div class="muted">DWT (t)</div><div><b>${DWT.toFixed(1)}</b></div></div>
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
  const wrap = document.createElement('div');
  wrap.appendChild(ship);
  if (layoutGrid) layoutGrid.appendChild(wrap);

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
let selectedVariantKey = 'min_k';

function computeVariants() {
  ensureUniqueParcelIDs();
  const vMin = computePlan(tanks, parcels);
  const vMax = computePlanMaxRemaining(tanks, parcels);
  const vAgg = computePlanMinTanksAggressive(tanks, parcels);
  const vWing = computePlanSingleWingAlternative(tanks, parcels);
  const vKeepSlopsSmall = computePlanMinKeepSlopsSmall(tanks, parcels);
  const altList = computePlanMinKAlternatives(tanks, parcels, 5);
  return {
    min_k: { id: 'Min Tanks', res: vMin },
    max_remaining: { id: 'Max Remaining', res: vMax },
    min_k_aggressive: { id: 'Min Tanks (Aggressive)', res: vAgg },
    single_wing: { id: 'Single-Wing (Ballast)', res: vWing },
    min_k_keep_slops_small: { id: 'Min Tanks (Keep SLOPs for Small)', res: vKeepSlopsSmall },
    // Alternatives at same minimal k
    ...Object.fromEntries(altList.map((r, i) => [
      `min_k_alt_${i+1}`,
      { id: `Min Tanks — Alt ${i+1}`, res: r }
    ]))
  };
}

function fillVariantSelect() {
  if (!variantSelect) return;
  function planSig(res) {
    return res.allocations.map(a => `${a.tank_id}:${a.parcel_id}:${a.assigned_m3.toFixed(3)}`).sort().join('|');
  }
  function tankCount(res) {
    return new Set(res.allocations.map(a => a.tank_id)).size;
  }
  const baseOrder = ['min_k','min_k_keep_slops_small','min_k_alt_1','min_k_alt_2','min_k_alt_3','min_k_alt_4','min_k_alt_5','single_wing','min_k_aggressive','max_remaining'];
  const order = baseOrder.filter(k => k in variantsCache).concat(Object.keys(variantsCache).filter(k => !baseOrder.includes(k)));
  const seen = new Map();
  const entries = [];
  for (const key of order) {
    const v = variantsCache[key];
    const errs = v?.res?.diagnostics?.errors || [];
    if (errs.length > 0) continue; // hide infeasible options
    const sig = planSig(v.res);
    if (seen.has(sig)) continue; // skip identical plan
    seen.set(sig, key);
    entries.push({ key, tanks: tankCount(v.res) });
  }
  const minTanks = Math.min(...entries.map(e => e.tanks));
  const opts = [];
  let minAssigned = false;
  for (const e of entries) {
    let label;
    if (e.tanks === minTanks && !minAssigned) {
      label = `Minimum Tanks (${e.tanks} tanks)`;
      minAssigned = true;
    } else if (e.key === 'max_remaining') {
      label = `Maximum Remaining (${e.tanks} tanks)`;
    } else if (e.tanks === minTanks && minAssigned) {
      label = `Alternative (${e.tanks} tanks)`;
    } else {
      label = `Alternative (${e.tanks} tanks)`;
    }
    opts.push({ key: e.key, label });
  }
  if (!opts.find(o => o.key === selectedVariantKey)) selectedVariantKey = opts[0]?.key || 'min_k';
  variantSelect.innerHTML = opts.map(o => `<option value="${o.key}" ${o.key===selectedVariantKey?'selected':''}>${o.label}</option>`).join('');
  if (opts.length === 0) {
    // No viable options: show friendly reasons and tips
    const reasons = new Set();
    Object.values(variantsCache).forEach(v => {
      (v?.res?.diagnostics?.errors || []).forEach(e => reasons.add(e));
    });
    const tips = 'Try increasing parcel volume, lowering a tank\'s min%, or reserving SLOPs for small parcels.';
    if (warnsEl) warnsEl.textContent = `No viable plan options. ${Array.from(reasons).join(' | ')} Tip: ${tips}`;
  }
}

function computeAndRender() {
  variantsCache = computeVariants();
  // If target draft is provided, filter variants that violate max(F/M/A) > target
  try {
    const target = getReverseInputs && rsTargetDraftEl ? getReverseInputs().targetDraft : NaN;
    if (isFinite(target) && target > 0) {
      const filtered = {};
      Object.entries(variantsCache || {}).forEach(([key, entry]) => {
        try {
          const m = computeHydroForAllocations(entry.res?.allocations || []);
          if (!m) return;
          const maxT = Math.max(m.Tf || 0, m.Tm || 0, m.Ta || 0);
          if (maxT <= target + 1e-3) filtered[key] = entry;
        } catch {}
      });
      if (Object.keys(filtered).length > 0) variantsCache = filtered;
    }
  } catch {}
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
}

btnCompute.addEventListener('click', computeAndRender);
if (variantSelect) {
  variantSelect.addEventListener('change', () => {
    selectedVariantKey = variantSelect.value;
    if (!variantsCache) variantsCache = computeVariants();
    const v = variantsCache[selectedVariantKey] || variantsCache['min_k'];
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
  try { cfgSelect.value = name; cfgNameInput.value = name; } catch {}
  // Apply meta if stored for this preset
  try { const meta = loadShipMeta()[name]; if (meta) applyShipMeta(meta); } catch {}
  persistLastState();
  return true;
}

if (!restored) {
  autoLoadFirstPresetIfExists();
}

render();
// Restore last view or default to cargo
try {
  const v = localStorage.getItem(LS_VIEW) || 'cargo';
  setActiveView(v);
} catch {}

// Config preset actions
btnSaveCfg.addEventListener('click', () => {
  const name = (cfgNameInput.value || '').trim();
  if (!name) { alert('Enter a config name'); return; }
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
    const name = cfgSelect.value;
    if (!name) return;
    const presets = loadPresets();
    const conf = presets[name];
    if (!Array.isArray(conf)) return;
    tanks = conf.map(t => ({ ...t }));
    try { cfgNameInput.value = name; } catch {}
    // Apply ship meta for this preset if available
    try { const meta = loadShipMeta()[name]; if (meta) applyShipMeta(meta); } catch {}
    persistLastState();
    render();
  });
}
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
  const name = cfgSelect.value;
  if (!name) return;
  if (!confirm(`Delete config '${name}'?`)) return;
  const presets = loadPresets();
  delete presets[name];
  savePresets(presets);
  refreshPresetSelect();
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
  const chosen = variantsCache[selectedVariantKey] || variantsCache['min_k'];
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
    rho: parseNum(rsRhoEl, SHIP_PARAMS.RHO_REF),
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
  W += consW; Mx += consW * consLCG;
  // constant
  if (constW && isFinite(constX)) { W += constW; Mx += constW * constX; }
  // lightship
  W += LIGHT_SHIP.weight_mt; Mx += LIGHT_SHIP.weight_mt * LIGHT_SHIP.lcg;
  if (!(W > 0)) return null;
  const LCG = Mx / W;
  const Tm = solveDraftByDisFW(HYDRO_ROWS, W / rho);
  if (!isFinite(Tm)) return null;
  const H = interpHydro(HYDRO_ROWS, Tm);
  const trim_cm = (W * (LCG - (H.LCF||0))) / (H.MCT1cm || 1);
  const trim_m = trim_cm / 100.0;
  const LBP = SHIP_PARAMS.LBP;
  const dAP = (LBP/2) + (H.LCF||0);
  const dFP = (LBP/2) - (H.LCF||0);
  const Ta = Tm + trim_m * (dAP / LBP);
  const Tf = Tm - trim_m * (dFP / LBP);
  const DWT = W - LIGHT_SHIP.weight_mt;
  return { W_total: W, DWT, Tf, Tm, Ta, Trim: trim_m };
}

async function reverseSolveAndRun() {
  await ensureHydroLoaded();
  await ensureLCGMapLoaded();
  if (!HYDRO_ROWS || HYDRO_ROWS.length === 0) { alert('Hydrostatics not found. Ensure draft_calculator/data/hydrostatics.json is present.'); return; }
  const { targetDraft, rho } = getReverseInputs();
  if (!isFinite(targetDraft) || targetDraft <= 0) { alert('Enter a valid Target Max Draft'); return; }
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
    const r = computePlan(tanks, parcels);
    let ok = r && r.allocations && r.allocations.length > 0 && (!r.diagnostics || !(r.diagnostics.errors||[]).length);
    if (ok) {
      const m = computeHydroForAllocations(r.allocations);
      if (!m) { ok = false; }
      else {
        const maxT = Math.max(m.Tf || 0, m.Tm || 0, m.Ta || 0);
        // Enforce max(F/M/A) <= target draft (with small tolerance)
        if (maxT > targetDraft + 1e-3) ok = false;
      }
    }
    if (ok) { sBest = s; sLo = s; } else { sHi = s; }
    // restore for next iteration
    parcels = old;
  }
  if (sBest <= 0) { alert('No feasible distribution under tank limits for the target draft. Try lowering target draft or adjust limits.'); return; }
  // Apply best volumes and run variants
  parcels = parcels.map(p => {
    const b = baseVolumes.find(r => r.id === p.id);
    const v = (b ? b.v0 : 0) * sBest;
    return { ...p, total_m3: Number.isFinite(v) ? v : 0, fill_remaining: false };
  });
  persistLastState();
  computeAndRender();
  setActiveView('layout');
}

if (btnSolveDraft) {
  btnSolveDraft.addEventListener('click', reverseSolveAndRun);
}
