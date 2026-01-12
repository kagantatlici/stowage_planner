// Dynamic cache-busted import for engine module
const __cbParam = (new URLSearchParams(location.search).get('cb')) || Date.now().toString();
const __ENGINE_URL = `./engine/stowage.js?cb=${__cbParam}`;
const { buildDefaultTanks, buildT10Tanks, computePlan, computePlanMaxRemaining, computePlanMinTanksAggressive, computePlanSingleWingAlternative, computePlanMinKAlternatives, computePlanMinKeepSlopsSmall, computePlanMinKPolicy, computePlanMaxK, computePlanMaxEmptySingle, computeAllViablePlans, computeAllViablePlansSimple } = await import(__ENGINE_URL);
const __HYDRO_URL = `./engine/hydro_shipdata.js?cb=${__cbParam}`;
const { computeHydroShip, solveDraftByDisFWShip, interpHydroShip } = await import(__HYDRO_URL);

// Reverse-solver: minimal hydro + LCG integration (from draft_calculator data)
// Do NOT hardcode ship hydrostatics; these are set from imported/active ship meta.
// LCGs: prefer per-consumable (FO/FW/OTH) when available; fallback to averaged `LCG_FO_FW`.
const SHIP_PARAMS = { LBP: null, RHO_REF: null, LCG_FO_FW: null, LCG_FO: null, LCG_FW: null, LCG_OTH: null };
const LIGHT_SHIP = { weight_mt: null, lcg: null };
let HYDRO_ROWS = null; // cached hydro rows from draft_calculator
let HYDRO_META = null; // optional meta: source, units, rowsCount
// Optional global bias to shift all cargo/slop tank LCGs (meters, +fwd). Helps align with Ship Data if naming/long-ref drifts.
const LS_LCG_BIAS = 'stowage_lcg_bias_v1';
function getLCGBias() {
  try {
    const qs = new URLSearchParams(location.search || '');
    if (qs.has('lcg_bias')) return Number(qs.get('lcg_bias')) || 0;
  } catch { }
  try { const s = localStorage.getItem(LS_LCG_BIAS); if (s != null) return Number(s) || 0; } catch { }
  return 0;
}
function setLCGBias(v) { try { localStorage.setItem(LS_LCG_BIAS, String(v)); } catch { } }
/** @type {Map<string, number>} */
let TANK_LCG_MAP = new Map(); // map tank_id -> lcg (midship +forward)
/** Ballast tanks metadata imported from Ship Data (if available) */
let BALLAST_TANKS = [];
// Tolerances
const TOL_TRIM_M = 0.02;   // m
const TOL_PS_PCT = 0.2;    // percent

// Simple state
let tanks = [];
let parcels = [];

// UI helpers
const tankEditorEl = document.getElementById('tank-editor');
const ballastEditorEl = document.getElementById('ballast-editor');
const parcelEditorEl = document.getElementById('parcel-editor');
const btnCompute = document.getElementById('btn-compute');
// Demo load buttons removed from UI
const btnAddParcel = document.getElementById('btn-add-parcel');
const btnAddCenter = document.getElementById('btn-add-center');
const btnImportShip = document.getElementById('btn-import-ship');
const btnClearShips = document.getElementById('btn-clear-ships');
// Reverse-solver inputs in Cargo view
const rsEnableEl = document.getElementById('rs_enable');
const rsTargetDraftEl = document.getElementById('rs_target_draft');
const rsRhoEl = document.getElementById('rs_rho');
const rsFoEl = document.getElementById('rs_fo_mt');
const rsFwEl = document.getElementById('rs_fw_mt');
const rsOthEl = document.getElementById('rs_oth_mt');
const rsConstEl = document.getElementById('rs_const_mt');
const rsConstLcgEl = document.getElementById('rs_const_lcg');
const rsMaxCargoEl = document.getElementById('rs-max-cargo');
const activeShipEl = document.getElementById('active-ship');
const summaryEl = document.getElementById('summary');
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
const fileImportShip = document.getElementById('file-import-ship');
const btnExportJson = document.getElementById('btn-export-json');
const variantSelect = document.getElementById('plan-variant');
const viewTabs = document.querySelectorAll('.view-tabs .tab');
const btnTransferShipData = document.getElementById('btn-transfer-shipdata');
const btnSolveDraft = document.getElementById('btn-solve-draft');
// Variant dropdown will be enabled once variants are computed
if (variantSelect) {
  variantSelect.innerHTML = '<option>Computing…</option>';
  variantSelect.disabled = false;
}
if (btnSolveDraft) {
  btnSolveDraft.style.display = 'none';
}

// Initialize Target Draft toggle UI state
try { if (typeof applyDraftToggleUI === 'function') applyDraftToggleUI(); } catch { }

const hydroSummaryEl = document.getElementById('hydro-summary');

// Restore persisted config name before any render
restoreCfgName();
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
// Ballast tank editable metadata (min/max, preload)
const LS_BALLAST_META = 'stowage_ballast_meta_v1';
// Optional: config name input persistence (UI clarity)
const LS_CFG_NAME = 'stowage_cfgname_v1';

// Build metadata for debugging/versioning in exports
const APP_BUILD = (() => {
  try {
    const qs = new URLSearchParams(location.search || '');
    const cb = qs.get('cb') || null;
    return {
      app: 'stowage_planner',
      build_tag: 'min-trim-v3-dmax',
      cb,
      loaded_at: new Date().toISOString(),
      features: {
        dynamic_import: true,
        simple_hydro_summary: true,
        hydro_interp_safe: true,
        min_trim_selector: true,
        even_keel_variant: true,
        target_draft_is_dmax: true,
        over_capacity_fallbacks: true
      }
    };
  } catch (_) {
    return { app: 'stowage_planner', build_tag: 'simple-hydro-summary', loaded_at: new Date().toISOString() };
  }
})();

function maxDraftOf(h) {
  if (!h) return Infinity;
  return Math.max(Number(h.Tf) || 0, Number(h.Tm) || 0, Number(h.Ta) || 0);
}


// ---- Evenkeel helper (local) ----
function cotPairIndex(id) {
  const m = /COT(\d+)/i.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : null;
}
function persistCfgName() {
  try { if (cfgNameInput) localStorage.setItem(LS_CFG_NAME, String(cfgNameInput.value ?? '')); } catch { }
}
function restoreCfgName() {
  try { const v = localStorage.getItem(LS_CFG_NAME); if (cfgNameInput && v != null) cfgNameInput.value = v; } catch { }
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
  const options = [];
  try {
    const presets = loadPresets();
    const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
    names.forEach(n => {
      options.push({ value: `preset:${n}`, label: n });
    });
  } catch { }
  cfgSelect.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
}

function applySelectionValue(value) {
  if (!value) return false;
  if (value.startsWith('preset:')) {
    const name = value.slice(7);
    const presets = loadPresets();
    const conf = presets[name];
    if (!Array.isArray(conf)) return false;
    tanks = conf.map(t => ({ ...t }));
    try { cfgNameInput.value = name; } catch { }
    // Apply ship meta for this preset if available
    try { const meta = (typeof loadShipMeta === 'function') ? loadShipMeta()[name] : null; if (meta) applyShipMeta(meta); } catch { }
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
  } catch { }
  return restored;
}

// Parcel color helper: pick next unused color, then generate distinct HSL-based fallback
const PARCEL_COLOR_PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#06b6d4', '#10b981'];
function hslToHex(h, s, l) {
  const a = s * Math.min(l, 100 - l) / 10000;
  const f = n => {
    const k = (n + h / 30) % 12;
    const color = l / 100 - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function pickNextParcelColor(currentParcels) {
  const used = new Set((currentParcels || []).map(p => String(p.color || '').toLowerCase()));
  const preset = PARCEL_COLOR_PALETTE.find(c => !used.has(c.toLowerCase()));
  if (preset) return preset;
  // Spread hues using golden-angle increments to avoid repeats
  let idx = (currentParcels || []).length;
  for (let i = 0; i < 50; i++) {
    const hue = (idx * 137.508) % 360;
    const hex = hslToHex(hue, 70, 55).toLowerCase();
    if (!used.has(hex)) return hex;
    idx++;
  }
  return '#888888';
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

async function importShipsFromPayload(payload) {
  const entries = collectShipEntries(payload);
  if (!entries.length) return { count: 0 };
  let presets = loadPresets();
  let metaStore = loadShipMeta();
  const existingNames = new Set(Object.keys(presets || {}));
  if (metaStore) Object.keys(metaStore).forEach(n => existingNames.add(n));
  if (!Array.isArray(presets) && typeof presets !== 'object') presets = {};
  if (!metaStore || typeof metaStore !== 'object') metaStore = {};
  const importedNames = [];
  for (const entry of entries) {
    const profile = normalizeShipProfile(entry);
    if (!profile) continue;
    const cargoArr = extractCargoArray(profile);
    if (!Array.isArray(cargoArr) || cargoArr.length === 0) continue;
    const tankList = mapCargoArrayToTanks(cargoArr, { min_pct: 0.5, max_pct: 0.98 });
    if (!tankList.length) continue;
    const meta = extractShipMetaFromProfile(profile);
    const baseName = (profile.ship && profile.ship.name) ? String(profile.ship.name).trim() : 'Imported Ship';
    let name = baseName || 'Imported Ship';
    let idx = 2;
    while (existingNames.has(name)) {
      name = `${baseName} (${idx++})`;
    }
    existingNames.add(name);
    presets[name] = tankList.map(t => ({ ...t }));
    if (meta) metaStore[name] = meta;
    importedNames.push(name);
  }
  if (importedNames.length) {
    savePresets(presets);
    saveShipMeta(metaStore);
    refreshPresetSelect();
    const firstName = importedNames[0];
    if (cfgSelect) cfgSelect.value = `preset:${firstName}`;
    if (typeof applySelectionValue === 'function') {
      applySelectionValue(`preset:${firstName}`);
    }
    computeAndRender();
  }
  return { count: importedNames.length, names: importedNames };
}

function collectShipEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.ships)) return payload.ships.filter(Boolean);
  if (Array.isArray(payload)) return payload.filter(Boolean);
  return [payload];
}

function normalizeShipProfile(entry) {
  if (!entry) return null;
  if (entry.ship || entry.tanks || entry.hydrostatics) return entry;
  const ship = entry.ship ? entry.ship : {
    name: entry.name || entry.id || 'Imported Ship',
    lbp: entry.lbp,
    rho_ref: entry.rho_ref ?? entry.rhoRef ?? entry.rho,
    light_ship: entry.light_ship || entry.lightShip
  };
  const tanks = entry.tanks ? entry.tanks
    : { cargo: Array.isArray(entry.cargo) ? entry.cargo : Array.isArray(entry.tanks_array) ? entry.tanks_array : [] };
  const hydrostatics = entry.hydrostatics ? entry.hydrostatics
    : (Array.isArray(entry.rows) ? { rows: entry.rows } : undefined);
  return { ship, tanks, hydrostatics };
}

function extractCargoArray(profile) {
  if (!profile) return [];
  if (profile.tanks && Array.isArray(profile.tanks.cargo)) return profile.tanks.cargo;
  if (profile.tanks && Array.isArray(profile.tanks.CARGO)) return profile.tanks.CARGO;
  if (Array.isArray(profile.tanks)) return profile.tanks;
  if (Array.isArray(profile.cargo)) return profile.cargo;
  if (Array.isArray(profile)) return profile;
  return [];
}

function clearImportedShips() {
  try { localStorage.removeItem(LS_PRESETS); } catch { }
  try { localStorage.removeItem(LS_SHIP_META); } catch { }
  try { localStorage.removeItem(LS_BALLAST_META); } catch { }
  try { localStorage.removeItem(LS_LAST); } catch { }
  SHIP_PARAMS.LBP = null;
  SHIP_PARAMS.RHO_REF = null;
  SHIP_PARAMS.LCG_FO_FW = null;
  SHIP_PARAMS.LCG_FO = null;
  SHIP_PARAMS.LCG_FW = null;
  SHIP_PARAMS.LCG_OTH = null;
  LIGHT_SHIP.weight_mt = null;
  LIGHT_SHIP.lcg = null;
  TANK_LCG_MAP = new Map();
  BALLAST_TANKS = [];
  HYDRO_ROWS = null;
  HYDRO_META = null;
  tanks = [];
  parcels = [];
  persistLastState();
  refreshPresetSelect();
  if (cfgSelect) cfgSelect.value = '';
  if (cfgNameInput) cfgNameInput.value = '';
  render();
  computeAndRender();
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
  if (r === 'ap_plus') return x - lbp / 2;    // AP (+ forward) → midship
  if (r === 'fp_minus') return x + lbp / 2;   // FP (− aft) → midship
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
    const cats = ['cargo', 'ballast', 'consumables'];
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
  } catch { }
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
      meta.hydrostatics = { rows: p.hydrostatics.rows.slice().sort((a, b) => a.draft_m - b.draft_m) };
    } else if (Array.isArray(p.hydrostatics)) {
      meta.hydrostatics = { rows: p.hydrostatics.slice().sort((a, b) => a.draft_m - b.draft_m) };
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
        else if (/SLOP/i.test(String(t.name || ''))) {
          const side = /(\(|\s)(P|S)(\)|\b)/.exec(String(t.name || '').toUpperCase());
          if (side && side[2] === 'P') tank_lcgs['SLOPP'] = Number(t.lcg);
          if (side && side[2] === 'S') tank_lcgs['SLOPS'] = Number(t.lcg);
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
          ballast_tanks.push({ id, name: t.name || id, cap_m3: isFinite(cap) ? Number(cap) : 0, lcg: Number(t.lcg) || 0 });
        }
      }
    }
    if (Object.keys(tank_lcgs).length) meta.tank_lcgs = tank_lcgs;
    if (ballast_tanks.length) meta.ballast_tanks = ballast_tanks;
    // Consumables LCGs (FO/FW/OTH) — store individually if provided; also compute simple average as fallback
    if (p.tanks && Array.isArray(p.tanks.consumables)) {
      const cons = p.tanks.consumables;
      const pick = (type) => cons.find(x => String(x.type || '').toLowerCase() === type);
      const fo = pick('fo'); const fw = pick('fw'); const oth = pick('oth');
      const vals = [fo, fw, oth].filter(x => x && isFinite(x.lcg)).map(x => Number(x.lcg));
      if (vals.length > 0) meta.lcg_fo_fw = vals.reduce((s, v) => s + v, 0) / vals.length;
      meta.consumables_lcg = {
        fo: (fo && isFinite(fo.lcg)) ? Number(fo.lcg) : null,
        fw: (fw && isFinite(fw.lcg)) ? Number(fw.lcg) : null,
        oth: (oth && isFinite(oth.lcg)) ? Number(oth.lcg) : null,
      };
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
    if (meta.consumables_lcg && typeof meta.consumables_lcg === 'object') {
      const c = meta.consumables_lcg;
      if (isFinite(c.fo)) SHIP_PARAMS.LCG_FO = Number(c.fo);
      if (isFinite(c.fw)) SHIP_PARAMS.LCG_FW = Number(c.fw);
      if (isFinite(c.oth)) SHIP_PARAMS.LCG_OTH = Number(c.oth);
    }
    if (meta.hydrostatics && Array.isArray(meta.hydrostatics.rows) && meta.hydrostatics.rows.length) {
      HYDRO_ROWS = meta.hydrostatics.rows.slice().sort((a, b) => a.draft_m - b.draft_m);
    }
    if (meta.tank_lcgs) {
      const m = new Map();
      Object.entries(meta.tank_lcgs).forEach(([k, v]) => { if (isFinite(v)) m.set(k, Number(v)); });
      TANK_LCG_MAP = m;
    }
    if (Array.isArray(meta.ballast_tanks)) {
      BALLAST_TANKS = meta.ballast_tanks.slice();
    }
  } catch { }
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
        const name = s?.ship?.name || s?.name || `Ship ${i + 1}`;
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
      <td><input value="${t.id}" data-idx="${idx}" data-field="id" style="width:70px"/></td>
      <td>
        <select data-idx="${idx}" data-field="side" style="width:88px">
          <option value="port" ${t.side === 'port' ? 'selected' : ''}>port</option>
          <option value="starboard" ${t.side === 'starboard' ? 'selected' : ''}>starboard</option>
          <option value="center" ${t.side === 'center' ? 'selected' : ''}>center</option>
        </select>
      </td>
      <td><input type="number" step="1" min="0" value="${t.volume_m3}" data-idx="${idx}" data-field="volume_m3" style="width:72px"/></td>
      <td><input type="number" step="1" min="0" max="100" value="${Math.round((t.min_pct || 0) * 100)}" data-idx="${idx}" data-field="min_pct_pct" style="width:56px"/></td>
      <td><input type="number" step="1" min="0" max="100" value="${Math.round((t.max_pct || 0) * 100)}" data-idx="${idx}" data-field="max_pct_pct" style="width:56px"/></td>
      <td><input type="checkbox" ${t.included ? 'checked' : ''} data-idx="${idx}" data-field="included"/></td>
      <td><input type="number" step="0.1" min="0" value="${Number(t.preload_m3 || 0)}" data-idx="${idx}" data-field="preload_m3" style="width:70px"/></td>
      <td><input type="number" step="0.0001" min="0" value="${((t.preload_density_kg_m3 || 0) / 1000).toFixed(4)}" data-idx="${idx}" data-field="preload_rho_gcm3" style="width:70px"/></td>
      <td class="row-controls"><button data-act="del-tank" data-idx="${idx}">Delete</button></td>
    </tr>`;
  }).join('');
  tankEditorEl.innerHTML = `
    <table>
      <thead>
        <tr><th>Tank ID</th><th>Side</th><th>Volume (m³)</th><th>Min %</th><th>Max %</th><th>Incl.</th><th>Preload (m³)</th><th>ρ preload (g/cm³)</th><th></th></tr>
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
      if (field === 'min_pct_pct') { field = 'min_pct'; val = Math.max(0, Math.min(100, Number(val))) / 100; }
      if (field === 'max_pct_pct') { field = 'max_pct'; val = Math.max(0, Math.min(100, Number(val))) / 100; }
      if (field === 'preload_m3') { val = Math.max(0, Number(String(val).replace(',', '.')) || 0); }
      if (field === 'preload_rho_gcm3') { field = 'preload_density_kg_m3'; const gcm3 = Number(String(val).replace(',', '.')); val = isNaN(gcm3) ? (tanks[idx].preload_density_kg_m3 || 0) : gcm3 * 1000; }
      tanks[idx] = { ...tanks[idx], [field]: field === 'included' ? (target.checked) : val };
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

function loadBallastMeta() { try { return JSON.parse(localStorage.getItem(LS_BALLAST_META) || '{}'); } catch { return {}; } }
function saveBallastMeta(m) { try { localStorage.setItem(LS_BALLAST_META, JSON.stringify(m || {})); } catch { } }

function renderBallastEditor() {
  if (!ballastEditorEl) return;
  const meta = loadBallastMeta();
  const rows = (BALLAST_TANKS || []).map((bt, idx) => {
    const m = meta[bt.id] || {};
    const minPct = Math.round(((m.min_pct ?? 0) * 100));
    const maxPct = Math.round(((m.max_pct ?? 1) * 100));
    const preload = Number(m.preload_m3 || 0);
    const rho = ((m.preload_density_kg_m3 || 1025) / 1000).toFixed(4);
    const included = (m.included ?? true);
    const side = (m.side || guessSideFromId(bt.id) || '');
    return `<tr>
      <td>${bt.id}</td>
      <td>
        <select data-id="${bt.id}" data-field="side" style="width:88px">
          <option value="port" ${side === 'port' ? 'selected' : ''}>port</option>
          <option value="starboard" ${side === 'starboard' ? 'selected' : ''}>starboard</option>
          <option value="center" ${side === 'center' ? 'selected' : ''}>center</option>
        </select>
      </td>
      <td style="text-align:right;">${Number(bt.cap_m3 || 0)}</td>
      <td><input type="number" step="1" min="0" max="100" value="${minPct}" data-id="${bt.id}" data-field="min_pct_pct" style="width:56px"/></td>
      <td><input type="number" step="1" min="0" max="100" value="${maxPct}" data-id="${bt.id}" data-field="max_pct_pct" style="width:56px"/></td>
      <td><input type="checkbox" ${included ? 'checked' : ''} data-id="${bt.id}" data-field="included"/></td>
      <td><input type="number" step="0.1" min="0" value="${preload}" data-id="${bt.id}" data-field="preload_m3" style="width:70px"/></td>
      <td><input type="number" step="0.0001" min="0" value="${rho}" data-id="${bt.id}" data-field="preload_rho_gcm3" style="width:70px"/></td>
    </tr>`;
  }).join('');
  ballastEditorEl.innerHTML = `
    <table>
      <thead>
        <tr><th>Tank ID</th><th>Side</th><th>Cap (m³)</th><th>Min %</th><th>Max %</th><th>Incl.</th><th>Preload (m³)</th><th>ρ preload</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  ballastEditorEl.querySelectorAll('input,select').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.getAttribute('data-id'); const field = el.getAttribute('data-field');
      const was = loadBallastMeta(); const rec = Object.assign({ min_pct: 0, max_pct: 1, included: true, preload_m3: 0, preload_density_kg_m3: 1025 }, was[id] || {});
      if (field === 'included') rec.included = el.checked;
      else if (field === 'min_pct_pct') rec.min_pct = Math.max(0, Math.min(100, Number(el.value) || 0)) / 100;
      else if (field === 'max_pct_pct') rec.max_pct = Math.max(0, Math.min(100, Number(el.value) || 0)) / 100;
      else if (field === 'preload_m3') rec.preload_m3 = Math.max(0, Number(String(el.value).replace(',', '.')) || 0);
      else if (field === 'preload_rho_gcm3') { const g = Number(String(el.value).replace(',', '.')); rec.preload_density_kg_m3 = isNaN(g) ? rec.preload_density_kg_m3 : g * 1000; }
      else if (field === 'side') rec.side = String(el.value || '');
      was[id] = rec; saveBallastMeta(was);
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
      <td><input type="number" step="0.001" min="0" value="${p.total_m3 != null ? Number(p.total_m3).toFixed(3) : ''}" data-idx="${idx}" data-field="total_m3" style="width:90px" ${p.fill_remaining ? 'disabled' : ''}/></td>
      <td><input type="number" step="0.1" min="0" value="${wt !== '' ? Number(wt).toFixed(1) : ''}" data-idx="${idx}" data-field="weight_mt" style="width:90px" ${p.fill_remaining ? 'disabled' : ''}/></td>
      <td><input type="checkbox" ${p.fill_remaining ? 'checked' : ''} data-idx="${idx}" data-field="fill_remaining" /></td>
      <td><input type="number" step="0.0001" min="0" value="${((p.density_kg_m3 || 0) / 1000).toFixed(4)}" data-idx="${idx}" data-field="density_g_cm3" style="width:90px"/></td>
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
        let base = String(val).trim() || `P${idx + 1}`;
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
      // Allow any row to be Fill Remaining; ensure only one at a time
      if (field === 'fill_remaining' && val === true) {
        parcels = parcels.map((p, i) => i === idx ? p : ({ ...p, fill_remaining: false }));
      }
      const mappedField = field === 'density_g_cm3' ? 'density_kg_m3' : field;
      let nextParcel = { ...parcels[idx] };
      nextParcel[mappedField] = val;
      if (field === 'fill_remaining' && val) {
        // If Max Cargo is available and density is known, transfer remaining (after other parcels) to this parcel
        const dens = Number((parcels[idx] && parcels[idx].density_kg_m3) || 0);
        if (Number.isFinite(LAST_MAX_CARGO_MT) && LAST_MAX_CARGO_MT > 0 && Number.isFinite(dens) && dens > 0) {
          let otherW = 0;
          for (let i = 0; i < parcels.length; i++) {
            if (i === idx) continue;
            const op = parcels[i];
            const ov = Number(op?.total_m3);
            const orho = Number(op?.density_kg_m3);
            if (isFinite(ov) && isFinite(orho) && orho > 0 && ov > 0) {
              otherW += (ov * orho) / 1000;
            }
          }
          const remainW = Math.max(0, LAST_MAX_CARGO_MT - otherW);
          const vol = (remainW * 1000) / dens;
          nextParcel.total_m3 = vol;
        } else {
          nextParcel.total_m3 = undefined;
        }
      }
      parcels[idx] = nextParcel;
      // keep FR parcel in sync after any change
      try { if (typeof updateFRParcelFromInputs === 'function') { const changed = updateFRParcelFromInputs(); if (changed) parcels = parcels.slice(); } } catch { }
      persistLastState();
      render();
    });
  });
  parcelEditorEl.querySelectorAll('button[data-act="del-parcel"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      parcels.splice(idx, 1);
      // Ensure only one fill_remaining remains true at most
      let seen = false;
      parcels = parcels.map(p => {
        if (p.fill_remaining) {
          if (seen) return { ...p, fill_remaining: false };
          seen = true; return p;
        }
        return p;
      });
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
      const rhoB = 1.025;
      const allAllocs = allocations.concat((ballastAllocs || []).map(b => ({ tank_id: b.tank_id, parcel_id: 'BALLAST', assigned_m3: Number(b.assigned_m3) || 0, weight_mt: (Number(b.assigned_m3) || 0) * rhoB })));
      let pW = 0, sW = 0;
      allAllocs.forEach(a => {
        const t = byTank.get(a.tank_id);
        const side = t?.side || guessSideFromId(a.tank_id);
        if (side === 'port') pW += (a.weight_mt || 0);
        else if (side === 'starboard') sW += (a.weight_mt || 0);
      });
      const denom = pW + sW;
      const imb = denom > 0 ? (Math.abs(pW - sW) / denom) * 100 : 0;
      const dir = (pW > sW) ? 'port' : ((pW < sW) ? 'starboard' : 'even');
      const warnLine = imb <= TOL_PS_PCT ? `Balanced (d% ${imb.toFixed(2)})` : `Imbalance ${imb.toFixed(2)}%${dir === 'even' ? '' : ` (list to ${dir})`}`;
      if (summaryEl) summaryEl.innerHTML = `
        <div class="summary-bar" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div>Port <b>${(pW || 0).toFixed(2)}</b> MT</div>
          <div>${warnLine}</div>
          <div>Starboard <b>${(sW || 0).toFixed(2)}</b> MT</div>
        </div>
      `;
    } catch { }
  }

  // Requested vs loaded check (underfill alert)
  try {
    if (warnsEl) {
      let html = '';
      // Show engine warnings first (if any)
      const di = diagnostics || {};
      const engineWarns = Array.isArray(di.warnings) ? di.warnings : [];
      if (engineWarns.length) {
        html += engineWarns.map(w => `<div>${w}</div>`).join('');
      }
      const engineErrors = Array.isArray(di.errors) ? di.errors : [];
      if (engineErrors.length) {
        html += engineErrors.map(e => `<div style="color:#ef4444; font-weight:600;">${e}</div>`).join('');
      }
      // Compute requested cargo weight from parcels with specified volume
      let requested = 0;
      for (const p of parcels || []) {
        const v = Number(p?.total_m3);
        const r = Number(p?.density_kg_m3);
        if (isFinite(v) && isFinite(r) && r > 0) requested += (v * r) / 1000.0;
      }
      // Compute loaded weight from cargo allocations only
      let loaded = 0;
      for (const a of allocations || []) loaded += (a.weight_mt || 0);
      if (requested > 0 && loaded + 0.1 < requested) {
        const diff = requested - loaded;
        const byDraft = (() => {
          try {
            const hasFR = Array.isArray(parcels) && parcels.some(p => !!p.fill_remaining);
            return hasFR && Number.isFinite(LAST_MAX_CARGO_MT) && LAST_MAX_CARGO_MT > 0;
          } catch { return false; }
        })();
        const prefix = (selectedVariantKey === 'engine_all_max' || byDraft)
          ? `Requested by draft ${requested.toFixed(1)} t; loaded max available ${loaded.toFixed(1)} t`
          : `Requested cargo ${requested.toFixed(1)} t; loaded ${loaded.toFixed(1)} t`;
        html = `<div style="color:#ef4444; font-weight:600;">${prefix} — short by ${diff.toFixed(1)} t.</div>` + html;
      }
      warnsEl.innerHTML = html;
    }
  } catch { }

  // Hydro summary (optional): compute F/M/A drafts, trim, displacement, DWT if hydro rows & LCG map available
  try {
    const hbox = hydroSummaryEl;
    if (hbox) {
      if (!HYDRO_ROWS || HYDRO_ROWS.length === 0) {
        hbox.style.display = 'none';
      } else {
        const rhoB = 1.025;
        const allAllocs = allocations.concat((ballastAllocs || []).map(b => ({ tank_id: b.tank_id, parcel_id: 'BALLAST', assigned_m3: Number(b.assigned_m3) || 0, weight_mt: (Number(b.assigned_m3) || 0) * rhoB })));
        const metrics = computeHydroForAllocations(allAllocs);
        if (!metrics) {
          hbox.style.display = 'none';
        } else {
          const { W_total, DWT, Tf, Tm, Ta, Trim } = metrics;
          hbox.style.display = 'block';
          hbox.innerHTML = `
            <div style="display:grid; grid-template-columns: repeat(auto-fit,minmax(140px,1fr)); gap:8px; font-size:13px;">
              <div><div class="muted">Displacement (t)</div><div><b>${isFinite(W_total) ? W_total.toFixed(1) : '-'}</b></div></div>
              <div><div class="muted">DWT (t)</div><div><b>${isFinite(DWT) ? DWT.toFixed(1) : '-'}</b></div></div>
              <div><div class="muted">Draft Fwd (m)</div><div><b>${Tf.toFixed(3)}</b></div></div>
              <div><div class="muted">Draft Mean (m)</div><div><b>${Tm.toFixed(3)}</b></div></div>
              <div><div class="muted">Draft Aft (m)</div><div><b>${Ta.toFixed(3)}</b></div></div>
              <div><div class="muted">Trim (m, +stern)</div><div><b>${Trim.toFixed(3)}</b></div></div>
            </div>
          `;
        }
      }
    }
  } catch (_) { }

  // Larger, card-like ship layout (HTML/CSS)
  // Respect the order in the tank editor (array order). Show all tanks (incl/excl); mark excluded visually.
  const includedTanks = tanks.slice();
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
      const parcel = a ? parcels.find(p => p.id === a.parcel_id) : null;
      if (parcel) cellP.style.background = '#0f1a3a';
      cellP.innerHTML = `
        <div class="id">${port.id}</div>
        ${a ? `
          <div class="meta">${parcel?.name || a.parcel_id}</div>
          <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
          <div class="meta">Fill: ${(a.fill_pct * 100).toFixed(1)}%</div>
          <div class="fillbar"><div style="height:${(a.fill_pct * 100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
        ` : `
          <div class="empty-hint">Cargo</div>
          <div class="empty-hint">Volume</div>
          <div class="empty-hint">%</div>
        `}
      `;
      // Preload line
      try {
        const tk = tanks.find(t => t.id === port.id);
        const pv = Number(tk?.preload_m3) || 0; if (pv > 0) {
          const pl = document.createElement('div'); pl.className = 'meta'; pl.textContent = `Preload: ${pv.toFixed(0)} m³`;
          cellP.appendChild(pl);
        }
      } catch { }
      // Excluded mark
      try { const tk = tanks.find(t => t.id === port.id); if (tk && tk.included === false) { const ex = document.createElement('div'); ex.className = 'meta'; ex.style.color = '#ef4444'; ex.textContent = 'Excluded'; cellP.appendChild(ex); } } catch { }
      if (parcel) cellP.style.boxShadow = `inset 0 0 0 9999px ${parcel.color}18`;
      row.appendChild(cellP);
    }
    // Center cell(s) if any
    if (hasCenter) {
      const centers = groupMap[key].centers.sort((a, b) => a.id.localeCompare(b.id));
      const cellC = document.createElement('div');
      cellC.className = 'tank-cell';
      if (centerOnly) {
        cellC.style.gridColumn = '1 / span 1';
        // Single full-width center: render like a side cell and color the full cell
        const ct = centers[0];
        const a = byTank[ct.id];
        const parcel = a ? parcels.find(p => p.id === a.parcel_id) : null;
        cellC.innerHTML = `
          <div class="id">${ct.id}</div>
          ${a ? `
            <div class="meta">${parcel?.name || a.parcel_id}</div>
            <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
            <div class="meta">Fill: ${(a.fill_pct * 100).toFixed(1)}%</div>
            <div class="fillbar"><div style="height:${(a.fill_pct * 100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
          ` : `
            <div class="empty-hint">Cargo</div>
            <div class="empty-hint">Volume</div>
            <div class="empty-hint">%</div>
          `}
        `;
        // Excluded mark
        try { const tko = tanks.find(t => t.id === ct.id); if (tko && tko.included === false) { const ex = document.createElement('div'); ex.className = 'meta'; ex.style.color = '#ef4444'; ex.textContent = 'Excluded'; cellC.appendChild(ex); } } catch { }
        if (a) {
          cellC.style.background = '#0f1a3a';
          if (parcel?.color) cellC.style.boxShadow = `inset 0 0 0 9999px ${parcel.color}18`;
        }
      } else {
        centers.forEach((ct, i) => {
          const a = byTank[ct.id];
          const parcel = a ? parcels.find(p => p.id === a.parcel_id) : null;
          const block = document.createElement('div');
          block.className = 'tank-cell';
          block.style.minHeight = '100px';
          block.style.marginBottom = i < centers.length - 1 ? '6px' : '0';
          block.innerHTML = `
            <div class="id">${ct.id}</div>
            ${a ? `
              <div class="meta">${parcel?.name || a.parcel_id}</div>
              <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
              <div class="meta">Fill: ${(a.fill_pct * 100).toFixed(1)}%</div>
              <div class="fillbar"><div style="height:${(a.fill_pct * 100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
            ` : `
              <div class="empty-hint">Cargo</div>
              <div class="empty-hint">Volume</div>
              <div class="empty-hint">%</div>
            `}
          `;
          // Excluded mark
          try { const tko = tanks.find(t => t.id === ct.id); if (tko && tko.included === false) { const ex = document.createElement('div'); ex.className = 'meta'; ex.style.color = '#ef4444'; ex.textContent = 'Excluded'; block.appendChild(ex); } } catch { }
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
      const parcel = a ? parcels.find(p => p.id === a.parcel_id) : null;
      cellS.innerHTML = `
        <div class="id">${star.id}</div>
        ${a ? `
          <div class="meta">${parcel?.name || a.parcel_id}</div>
          <div class="meta">Vol: ${a.assigned_m3.toFixed(0)} m³</div>
          <div class="meta">Fill: ${(a.fill_pct * 100).toFixed(1)}%</div>
          <div class="fillbar"><div style="height:${(a.fill_pct * 100).toFixed(1)}%; background:${parcel?.color || '#3b82f6'}"></div></div>
        ` : `
          <div class="empty-hint">Cargo</div>
          <div class="empty-hint">Volume</div>
          <div class="empty-hint">%</div>
        `}
      `;
      try { const tk = tanks.find(t => t.id === star.id); const pv = Number(tk?.preload_m3) || 0; if (pv > 0) { const pl = document.createElement('div'); pl.className = 'meta'; pl.textContent = `Preload: ${pv.toFixed(0)} m³`; cellS.appendChild(pl); } if (tk && tk.included === false) { const ex = document.createElement('div'); ex.className = 'meta'; ex.style.color = '#ef4444'; ex.textContent = 'Excluded'; cellS.appendChild(ex); } } catch { }
      if (parcel) cellS.style.boxShadow = `inset 0 0 0 9999px ${parcel.color}18`;
      row.appendChild(cellS);
    }
    hull.appendChild(row);
  });
  // Cargo layout card
  const cargoCard = document.createElement('div');
  const cargoLabel = document.createElement('div');
  cargoLabel.style.cssText = 'margin:4px 0 8px; font-size:14px; color:#9aa3b2;';
  cargoLabel.textContent = 'Cargo Tanks';
  cargoCard.appendChild(cargoLabel);
  cargoCard.appendChild(ship);
  if (layoutGrid) layoutGrid.appendChild(cargoCard);
  // Ballast layout card (always shown if ballast tank metadata exists)
  if (Array.isArray(BALLAST_TANKS) && BALLAST_TANKS.length > 0) {
    const bCard = document.createElement('div');
    const bLabel = document.createElement('div');
    bLabel.style.cssText = 'margin:4px 0 8px; font-size:14px; color:#9aa3b2;';
    bLabel.textContent = 'Ballast Tanks';
    bCard.appendChild(bLabel);
    const bShip = document.createElement('div');
    bShip.className = 'ship';
    bShip.innerHTML = `
      <div class="bow"><div class="triangle"></div></div>
      <div class="hull" id="bhull"></div>
      <div class="stern"></div>
    `;
    const bhull = bShip.querySelector('#bhull');
    // Allocations map (may be empty)
    const usedB = new Map();
    (ballastAllocs || []).forEach(b => {
      const prev = usedB.get(b.tank_id);
      if (prev) usedB.set(b.tank_id, { tank_id: b.tank_id, assigned_m3: (Number(prev.assigned_m3) || 0) + (Number(b.assigned_m3) || 0) });
      else usedB.set(b.tank_id, { tank_id: b.tank_id, assigned_m3: Number(b.assigned_m3) || 0 });
    });
    // Pair by base id and sort rows by LCG from Ship Data (bow/top first)
    const bmetaSide = loadBallastMeta ? loadBallastMeta() : {};
    const getSide = (id) => {
      const m = bmetaSide && bmetaSide[id];
      if (m && m.side) return m.side;
      return guessSideFromId(id) || null;
    };
    const baseKey = (s) => String(s || '').toUpperCase().replace(/(\s*\(?[PS]\)?\s*)$/, '').trim();
    /** @type {Record<string,{P:any,S:any,centers:any[],lcg:number}>} */
    const groups = {};
    BALLAST_TANKS.forEach(t => {
      const key = baseKey(t.id);
      if (!groups[key]) groups[key] = { P: null, S: null, centers: [], lcg: NaN };
      const side = getSide(t.id);
      if (side === 'port') groups[key].P = t;
      else if (side === 'starboard') groups[key].S = t;
      else groups[key].centers.push(t);
      // update representative LCG (average of available members with numeric lcg)
      const vals = [];
      if (Number.isFinite(t.lcg)) vals.push(Number(t.lcg));
      if (Number.isFinite(groups[key].lcg)) vals.push(Number(groups[key].lcg));
      groups[key].lcg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : groups[key].lcg;
    });
    const sorted = Object.keys(groups)
      .map(k => ({ key: k, data: groups[k] }))
      .sort((a, b) => {
        const ax = Number.isFinite(a.data.lcg) ? a.data.lcg : -Infinity;
        const bx = Number.isFinite(b.data.lcg) ? b.data.lcg : -Infinity;
        return bx - ax; // larger LCG (forward) first → bow at top
      });

    const makeCell = (tank) => {
      const cell = document.createElement('div'); cell.className = 'tank-cell';
      if (!tank) { cell.innerHTML = '<div class="empty-hint">-</div>'; return cell; }
      const a = usedB.get(tank.id);
      const pct = (a && isFinite(a.percent)) ? Number(a.percent)
        : (a && isFinite(a.assigned_m3) && isFinite(tank.cap_m3) && tank.cap_m3 > 0) ? (a.assigned_m3 / tank.cap_m3 * 100)
          : NaN;
      cell.innerHTML = `
        <div class="id">${tank.id}</div>
        ${a ? `
          <div class="meta">Vol: ${(a.assigned_m3 || 0).toFixed(0)} m³</div>
          <div class="meta">Fill: ${isFinite(pct) ? pct.toFixed(1) : '-'}%</div>
          <div class="fillbar"><div style=\"height:${isFinite(pct) ? pct.toFixed(1) : '0'}%; background:#22d3ee\"></div></div>
        ` : `
          <div class="empty-hint">Ballast</div>
          <div class="empty-hint">Volume</div>
          <div class="empty-hint">%</div>
        `}
      `;
      return cell;
    };

    sorted.forEach(({ data }) => {
      const row = document.createElement('div'); row.className = 'tank-row';
      const hasCenter = data.centers && data.centers.length > 0;
      const hasSides = !!(data.P || data.S);
      if (hasCenter && !hasSides) {
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '1fr';
      } else if (hasCenter && hasSides) {
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '1fr 1fr 1fr';
      }
      if (data.P || hasSides) row.appendChild(makeCell(data.P));
      if (hasCenter) {
        if (!hasSides) {
          row.appendChild(makeCell(data.centers[0]));
        } else {
          const mid = document.createElement('div');
          mid.style.display = 'grid';
          mid.style.gridTemplateRows = `repeat(${data.centers.length}, minmax(100px, auto))`;
          data.centers.forEach(ct => mid.appendChild(makeCell(ct)));
          row.appendChild(mid);
        }
      }
      if (data.S || hasSides) row.appendChild(makeCell(data.S));
      bhull.appendChild(row);
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
    const assignedVol = allocations.filter(a => a.parcel_id === p.id).reduce((s, a) => s + a.assigned_m3, 0);
    const assignedWt = allocations.filter(a => a.parcel_id === p.id).reduce((s, a) => s + a.weight_mt, 0);
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
    const totalVol = allocations.reduce((s, a) => s + a.assigned_m3, 0);
    const totalWt = allocations.reduce((s, a) => s + a.weight_mt, 0);
    const tankOrder = new Map();
    includedTanks.forEach((t, idx) => tankOrder.set(t.id, idx));
    const sortedAllocs = allocations.slice().sort((a, b) => {
      const ai = tankOrder.has(a.tank_id) ? tankOrder.get(a.tank_id) : Number.MAX_SAFE_INTEGER;
      const bi = tankOrder.has(b.tank_id) ? tankOrder.get(b.tank_id) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return String(a.tank_id).localeCompare(String(b.tank_id));
    });
    const rows = sortedAllocs.map(a => {
      const tank = includedTanks.find(t => t.id === a.tank_id);
      const parcel = parcels.find(p => p.id === a.parcel_id);
      return `<tr>
        <td>${a.tank_id}</td>
        <td>${tank?.side || ''}</td>
        <td>${parcel?.name || a.parcel_id}</td>
        <td style="text-align:right;">${a.assigned_m3.toFixed(0)}</td>
        <td style="text-align:right;">${(a.fill_pct * 100).toFixed(1)}%</td>
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
      if ((ballastAllocs || []).length === 0) {
        bEl.innerHTML = '<div class="muted">No ballast used.</div>';
      } else {
        const bRows = ballastAllocs.map(b => {
          const rho = 1.025;
          const pct = isFinite(b.percent) ? Number(b.percent) : (() => {
            const t = (BALLAST_TANKS || []).find(x => x.id === b.tank_id);
            if (t && t.cap_m3 > 0 && isFinite(b.assigned_m3)) return (b.assigned_m3 / t.cap_m3) * 100;
            return undefined;
          })();
          const wt = isFinite(b.weight_mt) ? Number(b.weight_mt) : (Number(b.assigned_m3) || 0) * rho;
          return `<tr>
            <td>${b.tank_id}</td>
            <td style="text-align:right;">${isFinite(pct) ? pct.toFixed(1) + '%' : '-'}</td>
            <td style="text-align:right;">${(b.assigned_m3 || 0).toFixed(1)}</td>
            <td style="text-align:right;">${rho.toFixed(3)}</td>
            <td style="text-align:right;">${wt.toFixed(1)}</td>
          </tr>`;
        }).join('');
        const bTotV = ballastAllocs.reduce((s, b) => s + (b.assigned_m3 || 0), 0);
        const bTotW = ballastAllocs.reduce((s, b) => {
          const rho = 1.025;
          const wt = isFinite(b.weight_mt) ? Number(b.weight_mt) : (Number(b.assigned_m3) || 0) * rho;
          return s + wt;
        }, 0);
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
      const vol = allocations.filter(a => a.parcel_id === p.id).reduce((s, a) => s + a.assigned_m3, 0);
      const wt = allocations.filter(a => a.parcel_id === p.id).reduce((s, a) => s + a.weight_mt, 0);
      const rhoVal = Number(p.density_kg_m3);
      const rhoText = Number.isFinite(rhoVal) ? rhoVal.toFixed(4) : '';
      return `<tr>
        <td><span class="sw" style="display:inline-block; vertical-align:middle; margin-right:6px; background:${p.color || '#888'}"></span>${p.name}</td>
        <td>${p.id}</td>
        <td style="text-align:right;">${rhoText}</td>
        <td style="text-align:right;">${vol.toFixed(0)}</td>
        <td style="text-align:right;">${wt.toFixed(1)}</td>
      </tr>`;
    }).join('');
    const parcelTotalVol = allocations.reduce((s, a) => s + a.assigned_m3, 0);
    const parcelTotalWt = allocations.reduce((s, a) => s + a.weight_mt, 0);
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

let currentPlanResult = null;
let variantsCache = null;
let selectedVariantKey = 'engine_min_k';

function computeVariants() {
  ensureUniqueParcelIDs();
  // Build policy (preloads) before computing variants
  const buildPolicy = () => {
    const pre = {};
    for (const t of (tanks || [])) {
      const v = Number(t?.preload_m3) || 0; if (v > 0) pre[t.id] = { v };
    }
    return { preloads: pre };
  };
  const policy = buildPolicy();
  const vMin = computePlan(tanks, parcels, policy);
  const vMax = computePlanMaxRemaining(tanks, parcels, policy);
  const vAgg = computePlanMinTanksAggressive(tanks, parcels, policy);
  const vWing = computePlanSingleWingAlternative(tanks, parcels, policy);
  const vKeepSlopsSmall = computePlanMinKeepSlopsSmall(tanks, parcels, policy);
  const vMaxEmptySingle = computePlanMaxEmptySingle(tanks, parcels, policy);
  let vMaxEmptySingleBal = null;
  const altList = computePlanMinKAlternatives(tanks, parcels, 50, policy) || [];

  // === SIMPLE BRUTE-FORCE: All feasible combinations (no filtering) ===
  let simplePlans = [];
  try {
    simplePlans = computeAllViablePlansSimple(tanks, parcels, policy) || [];
    console.log(`[SIMPLE] Brute-force found ${simplePlans.length} feasible combinations`);
    if (simplePlans.length > 0) {
      console.log(`[SIMPLE] First 3 options:`, simplePlans.slice(0, 3).map(p => ({
        label: p.label,
        tanks: p.metrics?.tanksUsed,
        empty: p.metrics?.emptyTankCount
      })));
    }
  } catch (e) {
    console.error('[SIMPLE] Brute-force failed:', e);
  }


  // Helper: detect band underfill usage in diagnostics (disallowed for Min Trim variant)
  const usedBand = (res) => {
    try {
      const ws = res?.diagnostics?.warnings || [];
      return ws.some(w => /underfill band|Allowed underfill/i.test(String(w || '')));
    } catch { return false; }
  };
  // Helper: requested cargo weight from parcels (t)
  const requestedTons = (() => {
    let req = 0;
    try {
      for (const p of parcels || []) {
        const v = Number(p?.total_m3);
        const r = Number(p?.density_kg_m3);
        if (isFinite(v) && isFinite(r) && r > 0) req += (v * r) / 1000.0;
      }
    } catch { }
    return req;
  })();
  // Helper: compute loaded cargo weight from allocations (t)
  const loadedTons = (res) => (res?.allocations || []).reduce((s, a) => s + (Number(a?.weight_mt) || 0), 0);
  // Build All-Max (fill all capacity) variant via synthetic FR plan
  let vAllMax = null;
  try {
    if ((parcels || []).length > 0) {
      const p0 = parcels[0];
      const frParcels = [{ ...p0, total_m3: undefined, fill_remaining: true }];
      vAllMax = computePlan(tanks, frParcels, policy);
      if (!vAllMax || !Array.isArray(vAllMax.allocations) || (vAllMax?.diagnostics?.errors || []).length) vAllMax = null;
    }
  } catch { }
  // Build Min Trim (min-k) by evaluating base min-k and its alternatives, without band, minimizing |Trim|
  let vMinTrim = null;
  let vMinTrimAlts = [];
  let vEvenKeel = null;
  let vEvenKeelUse = null;
  let vMinTrimBallast = null;
  let vSingleWingAuto = null;
  try {
    const cands = [];
    if (vMin && Array.isArray(vMin.allocations)) cands.push(vMin);
    for (const r of altList) if (r && Array.isArray(r.allocations)) cands.push(r);
    // Filter infeasible for our spec: underfill band used or under-loaded vs requested (>0)
    const tol = 0.1; // tons
    const feasible = cands.filter(r => !usedBand(r) && (!isFinite(requestedTons) || requestedTons <= tol || (loadedTons(r) + tol >= requestedTons)) && !(r?.diagnostics?.errors || []).length);
    // Intra-selection trim optimization: try improving each feasible candidate without changing k or band
    const improved = [];
    for (const r of feasible) {
      const opt = optimizeTrimWithinSelection(r);
      const resUse = opt || r;
      const met = computeHydroForAllocations(resUse.allocations || []);
      if (!met || !isFinite(met.Trim)) continue;
      improved.push({ res: resUse, trim: Math.abs(met.Trim) });
    }
    improved.sort((a, b) => a.trim - b.trim);
    if (improved.length) {
      vMinTrim = improved[0].res;
      // keep a couple of unique alternatives if any remain
      const seen = new Set();
      const sig = (res) => (res.allocations || []).map(a => `${a.tank_id}:${a.assigned_m3.toFixed(3)}`).sort().join('|');
      const bestSig = sig(vMinTrim);
      seen.add(bestSig);
      for (let i = 1; i < improved.length && vMinTrimAlts.length < 2; i++) {
        const s = sig(improved[i].res);
        if (!seen.has(s)) { seen.add(s); vMinTrimAlts.push(improved[i].res); }
      }
    }
    // Build Even Keel candidate by forcing all pairs (including SLOPs) and optimizing trim across all pairs
    try {
      const fixedParcels = parcels.filter(p => !p.fill_remaining);
      const targetParcel = fixedParcels[0] || parcels[0];
      if (targetParcel) {
        // Collect all available pair indices (include SLOPs)
        const pairIdxs = Array.from(new Set(
          (tanks || [])
            .filter(t => t.included && (t.side === 'port' || t.side === 'starboard'))
            .map(t => uiPairIndex(t.id))
            .filter(i => i != null)
        ));
        if (pairIdxs.length) {
          const fpol = { forcedSelection: { [targetParcel.id]: { reservedPairs: pairIdxs, center: null } }, preloads: (policy && policy.preloads) || {} };
          const baseAll = computePlanMinKPolicy(tanks, parcels, fpol);
          if (baseAll && Array.isArray(baseAll.allocations) && !(baseAll?.diagnostics?.errors || []).length) {
            const opt = optimizeTrimWithinSelection(baseAll, { includeSlops: true }) || baseAll;
            const met = computeHydroForAllocations(opt.allocations || []);
            if (met && isFinite(met.Trim)) vEvenKeel = opt;
          }
        }
      }
    } catch { }
  } catch { }

  // Ballast optimization on top of min-trim cargo plan
  try {
    const baseForBallast = vMinTrim || vMin;
    if (baseForBallast && Array.isArray(baseForBallast.allocations)) {
      const bal = optimizeBallastForTrim(baseForBallast, { rho_t_m3: getWaterDensity(), improveThreshold: 0.05 });
      if (bal && Array.isArray(bal.ballastAllocations) && bal.ballastAllocations.length) vMinTrimBallast = bal;
    }
  } catch { }

  // Single-wing: if list/heel is broken, add counter-ballast on the opposite side; then optionally improve trim.
  try {
    if (vWing && Array.isArray(vWing.allocations)) {
      let cur = vWing;
      const heel = optimizeBallastForHeel(cur, { rho_t_m3: getWaterDensity(), tol_pct: TOL_PS_PCT });
      if (heel && Array.isArray(heel.ballastAllocations) && heel.ballastAllocations.length) cur = heel;
      const trim = optimizeBallastForTrim(cur, { rho_t_m3: getWaterDensity(), improveThreshold: 0.05 });
      if (trim && Array.isArray(trim.ballastAllocations) && trim.ballastAllocations.length) cur = trim;
      vSingleWingAuto = (cur !== vWing) ? cur : null;
    }
  } catch { }

  // Ballast optimization for single-max-empty variant
  try {
    if (vMaxEmptySingle && Array.isArray(vMaxEmptySingle.allocations)) {
      // 1) heel/list balance (if needed) 2) trim improvement (optional)
      const heel = optimizeBallastForHeel(vMaxEmptySingle, { rho_t_m3: getWaterDensity(), tol_pct: TOL_PS_PCT });
      const baseForTrim = heel || vMaxEmptySingle;
      const bal = optimizeBallastForTrim(baseForTrim, { rho_t_m3: getWaterDensity(), improveThreshold: 0.05 });
      const use = bal || heel;
      if (use && Array.isArray(use.ballastAllocations) && use.ballastAllocations.length) vMaxEmptySingleBal = use;
    }
  } catch { }

  // Only keep Even Keel if it meaningfully improves Trim vs Min Trim (or if Min Trim is absent)
  try {
    if (vEvenKeel && Array.isArray(vEvenKeel.allocations)) {
      const ekM = computeHydroForAllocations(vEvenKeel.allocations || []);
      const mtM = (vMinTrim && Array.isArray(vMinTrim.allocations)) ? computeHydroForAllocations(vMinTrim.allocations || []) : null;
      if (ekM && isFinite(ekM.Trim)) {
        if (!mtM || !isFinite(mtM.Trim) || Math.abs(mtM.Trim) - Math.abs(ekM.Trim) > 1e-3) {
          vEvenKeelUse = vEvenKeel;
        }
      }
    }
  } catch { }

  // Target Dmax helper: enumerate additional cargo-only subset plans under Dmax.
  // This helps surface feasible variants between min-k and all-tanks even-keel (e.g., the manual 19,303t case).
  /** @type {{id:string,res:any}[]} */
  let vDmaxSubset = [];
  try {
    const targetDraft = getTargetDraftMax();
    const canDmax = Number.isFinite(targetDraft) && targetDraft > 0
      && Array.isArray(HYDRO_ROWS) && HYDRO_ROWS.length > 0
      && (TANK_LCG_MAP && TANK_LCG_MAP.size > 0);
    const fixedParcels = (parcels || []).filter(p => !p.fill_remaining);
    const hasFR = (parcels || []).some(p => !!p.fill_remaining);
    if (canDmax && !hasFR && fixedParcels.length === 1) {
      const targetParcel = fixedParcels[0];
      const V = Number(targetParcel?.total_m3);
      if (Number.isFinite(V) && V > 0) {
        // Collect available symmetric pair indices (including SLOPs as 1000)
        const pairMap = new Map(); // idx -> {P:boolean,S:boolean}
        (tanks || [])
          .filter(t => t && t.included && (t.side === 'port' || t.side === 'starboard'))
          .forEach(t => {
            const idx = uiPairIndex(t.id);
            if (idx == null) return;
            const ent = pairMap.get(idx) || { P: false, S: false };
            if (t.side === 'port') ent.P = true;
            if (t.side === 'starboard') ent.S = true;
            pairMap.set(idx, ent);
          });
        const allPairs = Array.from(pairMap.entries())
          .filter(([_, ent]) => ent && ent.P && ent.S)
          .map(([idx]) => idx)
          .sort((a, b) => a - b);
        const n = allPairs.length;
        if (n > 0) {
          const eps = 1e-3;
          // Mid-only contiguous block filter (mirror engine heuristic; ignore SLOPs)
          const cotIdxs = allPairs.filter(i => i < 1000);
          const minCot = cotIdxs.length ? Math.min(...cotIdxs) : 0;
          const maxCot = cotIdxs.length ? Math.max(...cotIdxs) : 0;
          const isMidOnlyContiguousBlock = (picked) => {
            const cot = (picked || []).filter(i => i < 1000);
            if (!cot.length) return false;
            const set = new Set(cot);
            const minSel = Math.min(...cot);
            const maxSel = Math.max(...cot);
            for (let i = minSel; i <= maxSel; i++) if (!set.has(i)) return false;
            return (minSel > minCot && maxSel < maxCot);
          };
          const labelForPairs = (picked) => {
            const parts = (picked || [])
              .slice()
              .sort((a, b) => a - b)
              .map(i => (i >= 1000 ? 'SLOP' : `COT${i}`));
            return parts.join('+');
          };
          const sig = (res) => {
            try {
              return (res?.allocations || [])
                .map(a => `${a.tank_id}:${(Number(a.assigned_m3) || 0).toFixed(2)}`)
                .sort()
                .join('|');
            } catch { return ''; }
          };
          const seen = new Set();
          const results = [];
          // Enumerate subsets via bitmask (fast for typical pair counts)
          const maxMasks = (n <= 16) ? ((1 << n) - 1) : 0;
          const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const timeBudgetMs = 120; // keep UI responsive
          const considerSubset = (picked) => {
            if (!picked || picked.length === 0) return;
            if (isMidOnlyContiguousBlock(picked)) return;
            const fpol = {
              forcedSelection: { [targetParcel.id]: { reservedPairs: picked, center: null } },
              preloads: (policy && policy.preloads) || {}
            };
            const base = computePlanMinKPolicy(tanks, parcels, fpol);
            if (!base || !Array.isArray(base.allocations) || base.allocations.length === 0) return;
            if ((base?.diagnostics?.errors || []).length) return;
            if (usedBand(base)) return;
            // Intra-selection trim optimization; include SLOPs in optimizer only when used
            const opt = optimizeTrimWithinSelection(base, { includeSlops: picked.some(i => i >= 1000) }) || base;
            if (!opt || !Array.isArray(opt.allocations) || opt.allocations.length === 0) return;
            const h = computeHydroForResult(opt);
            const mx = maxDraftOf(h);
            if (!(Number.isFinite(mx) && mx <= targetDraft + eps)) return;
            const s = sig(opt);
            if (!s || seen.has(s)) return;
            seen.add(s);
            const trimAbs = h && Number.isFinite(h.Trim) ? Math.abs(Number(h.Trim)) : Infinity;
            results.push({
              res: opt,
              picked,
              cargo: loadedTons(opt),
              tanksUsed: opt.allocations.length,
              trimAbs,
              maxDraft: mx
            });
          };
          if (maxMasks > 0) {
            for (let mask = 1; mask <= maxMasks; mask++) {
              const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
              if (now - t0 > timeBudgetMs) break;
              const picked = [];
              for (let i = 0; i < n; i++) if (mask & (1 << i)) picked.push(allPairs[i]);
              considerSubset(picked);
            }
          } else {
            // Fallback for large N: sample by increasing subset size up to a sane cap
            const capPairs = Math.min(n, 12);
            const combos = function* (arr, k, start = 0, prefix = []) {
              if (k === 0) { yield prefix; return; }
              for (let i = start; i <= arr.length - k; i++) yield* combos(arr, k - 1, i + 1, prefix.concat(arr[i]));
            };
            for (let k = 1; k <= capPairs; k++) {
              for (const picked of combos(allPairs, k)) {
                const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                if (now - t0 > timeBudgetMs) break;
                considerSubset(picked);
              }
            }
          }
          results.sort((a, b) =>
            (b.cargo - a.cargo) ||
            (a.tanksUsed - b.tanksUsed) ||
            (a.trimAbs - b.trimAbs) ||
            (b.maxDraft - a.maxDraft)
          );
          vDmaxSubset = results.slice(0, 5).map((r, i) => ({
            id: `Engine — Dmax Alt ${i + 1} (${labelForPairs(r.picked)})`,
            res: r.res
          }));
        }
      }
    }
  } catch { }

  function planSig(res) {
    if (!res || !Array.isArray(res.allocations)) return '';
    const cargoSig = res.allocations
      .map(a => `${a.tank_id}:${a.parcel_id}:${(a.assigned_m3 || 0).toFixed(3)}`)
      .sort()
      .join('|');
    const ballast = (res.ballastAllocations || res.ballast_allocations) || [];
    const ballastSig = ballast.length
      ? '::B::' + ballast
        .map(b => `${b.tank_id}:${(b.assigned_m3 || 0).toFixed(3)}`)
        .sort()
        .join('|')
      : '';
    return cargoSig + ballastSig;
  }
  function isSingleWing(res) {
    try {
      if (!res || !Array.isArray(res.allocations)) return false;
      const vmap = new Map();
      res.allocations.forEach(a => vmap.set(a.tank_id, (vmap.get(a.tank_id) || 0) + (a.assigned_m3 || 0)));
      const pairs = new Map(); // idx -> {P:vol,S:vol}
      for (const [tid, vol] of vmap.entries()) {
        const idx = cotPairIndex(tid);
        if (idx == null) continue;
        const side = /P$/.test(tid) ? 'P' : (/S$/.test(tid) ? 'S' : null);
        if (!side) continue;
        const entry = pairs.get(idx) || { P: 0, S: 0 };
        entry[side] += vol;
        pairs.set(idx, entry);
      }
      for (const e of pairs.values()) {
        const p = e.P || 0, s = e.S || 0;
        if ((p > 1e-6 && s <= 1e-6) || (s > 1e-6 && p <= 1e-6)) return true;
      }
      return false;
    } catch { return false; }
  }

  const candidates = {
    engine_min_k: { id: 'Engine — Max Empty Tanks', res: vMin },
    engine_max_empty_single: vMaxEmptySingle ? { id: 'Engine — Max Empty (Single Tanks)', res: vMaxEmptySingle } : undefined,
    engine_max_empty_single_ballast: vMaxEmptySingleBal ? { id: 'Engine — Max Empty (Single + Ballast)', res: vMaxEmptySingleBal } : undefined,
    engine_min_trim: vMinTrim ? { id: 'Engine — Min Trim (min‑k)', res: vMinTrim } : undefined,
    engine_min_trim_ballast: vMinTrimBallast ? { id: 'Engine — Min Trim (cargo+ballast)', res: vMinTrimBallast } : undefined,
    engine_min_trim_alt_1: vMinTrimAlts[0] ? { id: 'Engine — Min Trim Alt 1', res: vMinTrimAlts[0] } : undefined,
    engine_min_trim_alt_2: vMinTrimAlts[1] ? { id: 'Engine — Min Trim Alt 2', res: vMinTrimAlts[1] } : undefined,
    // Dmax-feasible subset variants (cargo-only)
    ...Object.fromEntries((vDmaxSubset || []).map((e, i) => [`engine_dmax_${i + 1}`, e])),
    engine_even_keel: vEvenKeelUse ? { id: 'Engine — Even Keel (all tanks)', res: vEvenKeelUse } : undefined,
    engine_keep_slops_small: { id: 'Engine — Min Tanks (Keep SLOPs Small)', res: vKeepSlopsSmall },
    engine_all_max: (vAllMax && requestedTons > 0 && (loadedTons(vAllMax) + 0.1 < requestedTons)) ? { id: 'Engine — All Max (short)', res: vAllMax } : undefined,
    // Alternatives at same minimal k
    ...Object.fromEntries(altList.map((r, i) => [
      `engine_alt_${i + 1}`,
      { id: `Engine — Min Tanks Alt ${i + 1}`, res: r }
    ])),
    // === SIMPLE BRUTE-FORCE: All feasible combinations ===
    ...Object.fromEntries(simplePlans.map((p, i) => {
      const m = p.metrics || {};
      const label = m.label || `Option ${i + 1}`;
      const tanksUsed = m.tanksUsed ?? '?';
      const emptyCount = m.emptyTankCount ?? '?';
      return [`simple_${i + 1}`, {
        id: `${label} (${tanksUsed} tanks, ${emptyCount} empty)`,
        res: p
      }];
    })),
    engine_single_wing: vSingleWingAuto ? { id: 'Engine — Single-Wing (Auto Ballast)', res: vSingleWingAuto } : { id: 'Engine — Single-Wing (Cargo)', res: vWing },
    engine_min_k_aggressive: { id: 'Engine — Min Tanks (Aggressive)', res: vAgg },
    engine_max_remaining: { id: 'Engine — Max Cargo (All Max%)', res: vMax }
  };

  // Filter: include Single-Wing only if truly single-wing; also dedupe identical results.
  const order = [
    // Simple brute-force results first (sorted by tank count)
    'simple_1', 'simple_2', 'simple_3', 'simple_4', 'simple_5',
    'simple_6', 'simple_7', 'simple_8', 'simple_9', 'simple_10',
    'simple_11', 'simple_12', 'simple_13', 'simple_14', 'simple_15',
    'simple_16', 'simple_17', 'simple_18', 'simple_19', 'simple_20',
    // Legacy engine variants
    'engine_min_k', 'engine_max_empty_single', 'engine_max_empty_single_ballast',
    'engine_min_trim', 'engine_min_trim_ballast', 'engine_min_trim_alt_1', 'engine_min_trim_alt_2', 'engine_even_keel', 'engine_keep_slops_small',
    'engine_alt_1', 'engine_alt_2', 'engine_alt_3', 'engine_alt_4', 'engine_alt_5',
    'engine_single_wing',
    'engine_min_k_aggressive', 'engine_max_remaining'
  ];
  const seen = new Set();
  const out = {};
  for (const k of order) {
    const entry = candidates[k];
    if (!entry || !entry.res || !Array.isArray(entry.res.allocations)) continue;
    if (k === 'engine_single_wing' && !isSingleWing(entry.res)) continue; // reflect reality
    const sig = planSig(entry.res);
    if (!sig || seen.has(sig)) continue; // drop identical
    seen.add(sig);
    out[k] = entry;
  }

  // Hide Max Empty Tanks if another candidate uses the same used tank set (same empty count and identities)
  try {
    const usedSet = (res) => {
      const s = new Set();
      (res.allocations || []).forEach(a => s.add(a.tank_id));
      return Array.from(s).sort().join('|');
    };
    const minTrimKey = out['engine_min_trim'] ? usedSet(out['engine_min_trim'].res) : null;
    if (minTrimKey && out['engine_min_k']) {
      const minKKey = usedSet(out['engine_min_k'].res);
      if (minKKey === minTrimKey) delete out['engine_min_k'];
    }
  } catch { }

  // If Target Draft is enabled, only keep variants that satisfy max(F/M/A) <= target.
  try {
    const targetDraft = getTargetDraftMax();
    console.log(`[FILTER] Target draft: ${targetDraft}, HYDRO_ROWS: ${HYDRO_ROWS?.length || 0}, TANK_LCG_MAP: ${TANK_LCG_MAP?.size || 0}`);
    console.log(`[FILTER] Total variants before filter: ${Object.keys(out).length}`);

    if (Number.isFinite(targetDraft) && targetDraft > 0 && Array.isArray(HYDRO_ROWS) && HYDRO_ROWS.length > 0 && TANK_LCG_MAP && TANK_LCG_MAP.size > 0) {
      const eps = 1e-3;
      const filtered = {};
      let passCount = 0, failCount = 0;
      for (const [k, entry] of Object.entries(out)) {
        const h = computeHydroForResult(entry?.res);
        const mx = maxDraftOf(h);
        if (Number.isFinite(mx) && mx <= targetDraft + eps) {
          filtered[k] = entry;
          passCount++;
        } else {
          failCount++;
          if (k.startsWith('simple_')) {
            console.log(`[FILTER] REJECTED ${k}: maxDraft=${mx?.toFixed(3)} > target=${targetDraft}`);
          }
        }
      }
      console.log(`[FILTER] After filter: ${passCount} passed, ${failCount} rejected`);
      if (Object.keys(filtered).length > 0) return filtered;
      return {};
    }
  } catch (e) {
    console.error('[FILTER] Error:', e);
  }
  return out;
}

function fillVariantSelect() {
  if (!variantSelect || !variantsCache) return;
  const order = [
    // Simple brute-force results first (sorted by tank count)
    'simple_1', 'simple_2', 'simple_3', 'simple_4', 'simple_5',
    'simple_6', 'simple_7', 'simple_8', 'simple_9', 'simple_10',
    'simple_11', 'simple_12', 'simple_13', 'simple_14', 'simple_15',
    'simple_16', 'simple_17', 'simple_18', 'simple_19', 'simple_20',
    // Legacy engine variants
    'engine_min_k', 'engine_max_empty_single', 'engine_max_empty_single_ballast',
    'engine_min_trim', 'engine_min_trim_ballast', 'engine_min_trim_alt_1', 'engine_min_trim_alt_2',
    'engine_dmax_1', 'engine_dmax_2', 'engine_dmax_3', 'engine_dmax_4', 'engine_dmax_5',
    'engine_even_keel', 'engine_keep_slops_small',
    'engine_alt_1', 'engine_alt_2', 'engine_alt_3', 'engine_alt_4', 'engine_alt_5',
    'engine_single_wing', 'engine_min_k_aggressive', 'engine_max_remaining'
  ];
  const opts = order.filter(k => variantsCache[k])
    .map(k => ({ key: k, label: variantsCache[k].id }));
  if (opts.length === 0) {
    variantSelect.innerHTML = '<option>No feasible plan</option>';
    variantSelect.disabled = true;
    return;
  }
  variantSelect.disabled = false;
  if (!opts.find(o => o.key === selectedVariantKey)) selectedVariantKey = opts[0]?.key || 'engine_min_k';
  variantSelect.innerHTML = opts.map(o => `<option value="${o.key}" ${o.key === selectedVariantKey ? 'selected' : ''}>${o.label}</option>`).join('');
}

function computeAndRender() {
  variantsCache = computeVariants();
  fillVariantSelect();
  const keys = variantsCache ? Object.keys(variantsCache) : [];
  if (!keys.length) {
    currentPlanResult = null;
    persistLastState();
    renderSummaryAndSvg(null);
    if (warnsEl) warnsEl.innerHTML = '<div style="color:#ef4444; font-weight:600;">No feasible plan under Target Max Draft. Lower cargo or increase the target.</div>';
    return;
  }
  let chosen = variantsCache[selectedVariantKey] || variantsCache['engine_min_k'] || variantsCache[keys[0]];
  let res = chosen?.res;
  currentPlanResult = (res && Array.isArray(res.allocations) && res.allocations.length) ? res : null;
  // Fallback: if chosen is infeasible/null and All Max exists, auto-select All Max (short)
  if (!currentPlanResult && variantsCache && variantsCache['engine_all_max']) {
    selectedVariantKey = 'engine_all_max';
    if (variantSelect) variantSelect.value = 'engine_all_max';
    chosen = variantsCache['engine_all_max'];
    res = chosen?.res;
    currentPlanResult = (res && Array.isArray(res.allocations) && res.allocations.length) ? res : null;
  }
  persistLastState();
  renderSummaryAndSvg(currentPlanResult);
}

function ensureUniqueParcelIDs() {
  const seen = new Set();
  parcels = parcels.map((p, idx) => {
    let base = String(p.id || `P${idx + 1}`).trim();
    if (!base) base = `P${idx + 1}`;
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
  renderBallastEditor();
  renderParcelEditor();
  // Live layout preview based on current tank config
  renderSummaryAndSvg(null);
  renderActiveShipInfo();
}

btnCompute.addEventListener('click', computeAndRender);
if (variantSelect) {
  variantSelect.addEventListener('change', () => {
    selectedVariantKey = variantSelect.value;
    const chosen = variantsCache && (variantsCache[selectedVariantKey] || variantsCache['engine_min_k']);
    const res = chosen?.res;
    currentPlanResult = (res && Array.isArray(res.allocations) && res.allocations.length) ? res : null;
    renderSummaryAndSvg(currentPlanResult);
  });
}
// Demo handlers removed
btnAddParcel.addEventListener('click', () => {
  // Ensure only the last parcel can be fill_remaining
  parcels = parcels.map((p, i) => i === parcels.length - 1 ? p : { ...p, fill_remaining: false });
  const idx = parcels.length + 1;
  const color = pickNextParcelColor(parcels);
  parcels.push({ id: `P${idx}`, name: `Parcel ${idx}`, total_m3: 0, density_kg_m3: 800, temperature_c: 15, color });
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
if (btnImportShip) {
  btnImportShip.addEventListener('click', () => {
    if (fileImportShip) fileImportShip.click();
  });
}
if (fileImportShip) {
  fileImportShip.addEventListener('change', async () => {
    const f = fileImportShip.files && fileImportShip.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      const { count } = await importShipsFromPayload(json);
      if (count === 0) alert('Unable to parse ship data from file.');
      else alert(`${count} ship(s) imported from file.`);
    } catch (err) {
      console.error('Ship import failed', err);
      alert('Ship import failed. See console for details.');
    } finally {
      fileImportShip.value = '';
    }
  });
}
if (btnClearShips) {
  btnClearShips.addEventListener('click', () => {
    try {
      if (!confirm('Clear all imported ships from local storage?')) return;
      clearImportedShips();
      alert('Imported ship data cleared.');
    } catch (err) {
      console.error('Clear ships failed', err);
      alert('Unable to clear imported ships.');
    }
  });
}

// Initial render
const restored = restoreLastState();
refreshPresetSelect();

function autoLoadFirstPresetIfExists() {
  const presets = loadPresets();
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return false;
  const name = names[0];
  const conf = presets[name];
  if (!Array.isArray(conf)) return false;
  tanks = conf.map(t => ({ ...t }));
  try { cfgSelect.value = `preset:${name}`; cfgNameInput.value = name; } catch { }
  // Apply meta if stored for this preset
  try { const meta = loadShipMeta()[name]; if (meta) applyShipMeta(meta); } catch { }
  persistLastState();
  return true;
}

if (!restored) {
  autoLoadFirstPresetIfExists();
}

// If dropdown already has a selection, apply it as active ship on load
// Avoid overriding restored last state
try {
  if (!restored && cfgSelect && cfgSelect.value) {
    applySelectionValue(cfgSelect.value);
  }
} catch { }

render();
// Restore initial view from URL (#view or ?view=) or last view
try {
  const qs = new URLSearchParams(window.location.search || '');
  const fromParam = (qs.get('view') || '').trim();
  const fromHash = (window.location.hash || '').replace(/^#/, '').trim();
  const candidate = fromParam || fromHash || localStorage.getItem(LS_VIEW) || 'cargo';
  const allowed = new Set(['config', 'cargo', 'layout', 'shipdata']);
  setActiveView(allowed.has(candidate) ? candidate : 'cargo');
} catch { }
// Auto-compute on load so Allocation/Layout stay populated after page switches
try { computeAndRender(); } catch { }

// Build payload to transfer current plan to Ship Data (draft calculator)
async function buildShipDataTransferPayload() {
  try {
    const res = currentPlanResult;
    if (!res || !Array.isArray(res.allocations) || res.allocations.length === 0) return null;
    const rs = (typeof getRSInputs === 'function') ? getRSInputs() : null;
    const rhoWater = (rs && isFinite(rs.rho) && rs.rho > 0) ? Number(rs.rho) : (typeof SHIP_PARAMS.RHO_REF === 'number' ? Number(SHIP_PARAMS.RHO_REF) : undefined);
    // Build parcel -> density (t/m³) map for quick lookup
    const rhoByParcel = new Map();
    try {
      (parcels || []).forEach(p => {
        if (!p || !p.id) return;
        const dk = Number(p.density_kg_m3);
        if (Number.isFinite(dk) && dk > 0) rhoByParcel.set(p.id, dk / 1000);
      });
    } catch { }
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
    const ballast = Array.isArray(res.ballastAllocations) ? res.ballastAllocations.map(b => {
      const vol = Number(b.assigned_m3) || 0;
      const rho = (rs && isFinite(rs.rho) && rs.rho > 0) ? Number(rs.rho) : 1.025;
      // try compute percent using BALLAST_TANKS cap_m3
      let pct = undefined;
      try {
        const bt = (BALLAST_TANKS || []).find(t => t.id === b.tank_id);
        if (bt && isFinite(bt.cap_m3) && bt.cap_m3 > 0) pct = (vol / bt.cap_m3) * 100;
      } catch { }
      return {
        tank_id: b.tank_id,
        weight_mt: vol * rho,
        assigned_m3: vol,
        percent: (isFinite(b.percent) ? Number(b.percent) : pct),
        rho
      };
    }) : [];
    const payload = {
      type: 'apply_stowage_plan',
      version: 1,
      rho: rhoWater,
      constant: {
        w: (rs && isFinite(rs.constW)) ? Number(rs.constW) : 0,
        x_midship_m: (rs && isFinite(rs.constX)) ? Number(rs.constX) : 0,
        ref: 'ms_plus'
      },
      consumables: {
        fo: (rs && isFinite(rs.fo)) ? Number(rs.fo) : 0,
        fw: (rs && isFinite(rs.fw)) ? Number(rs.fw) : 0,
        oth: (rs && isFinite(rs.oth)) ? Number(rs.oth) : 0
      },
      // NOTE: draft_calculator expects cargo allocations here; ballast is in ballast_allocations.
      allocations: allocs,
      // Extra: for other consumers that want a single list
      allocations_with_ballast: allocs.concat(
        ballast.map(b => ({ tank_id: b.tank_id, parcel_id: 'BALLAST', weight_mt: b.weight_mt, assigned_m3: b.assigned_m3, fill_pct: undefined, percent: b.percent, rho: b.rho, is_ballast: true }))
      ),
      ballast_allocations: ballast
    };
    return payload;
  } catch (_) { return null; }
}

function postShipDataMessage(frame, payload, targetOrigin) {
  const msg = { type: 'apply_stowage_plan', payload };
  try { frame.contentWindow.postMessage(msg, targetOrigin || '*'); } catch { }
  // Also send raw payload for receivers that listen to the payload directly
  try { frame.contentWindow.postMessage(payload, targetOrigin || '*'); } catch { }
}

function waitForIframeReady(frame, timeoutMs = 2500) {
  return new Promise(resolve => {
    let done = false;
    let timeoutId = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (timeoutId) clearTimeout(timeoutId); } catch { }
      try { frame.removeEventListener('load', finish); } catch { }
      resolve();
    };
    // If same-origin and already loaded, return immediately
    try {
      if (frame && frame.contentDocument && frame.contentDocument.readyState === 'complete') { resolve(); return; }
    } catch { }
    try { frame.addEventListener('load', finish); } catch { }
    timeoutId = setTimeout(finish, timeoutMs);
  });
}

async function postPlanToShipData() {
  try {
    const frame = document.querySelector('#view-shipdata iframe');
    if (!frame || !frame.contentWindow) { alert('Ship Data view is not available.'); return; }
    const payload = await buildShipDataTransferPayload();
    if (!payload) { alert('No computed allocations to transfer. Run the planner first.'); return; }
    let targetOrigin = '*';
    try { const u = new URL(frame.getAttribute('src') || '', window.location.href); targetOrigin = u.origin; } catch { }
    setActiveView('shipdata');
    // Ensure the iframe JS is ready; then send with retries (covers first-open race)
    await waitForIframeReady(frame, 2500);
    try { postShipDataMessage(frame, payload, targetOrigin); } catch { }
  } catch (_) { alert('Transfer failed.'); }
}

if (btnTransferShipData) {
  btnTransferShipData.addEventListener('click', async () => {
    try { await postPlanToShipData(); } catch { alert('Transfer failed.'); }
  });
}

// Config preset actions
btnSaveCfg.addEventListener('click', () => {
  let name = (cfgNameInput.value || '').trim();
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
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
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
        } catch { }
        // Optionally set the first imported ship as current
        if (importedNames.length > 0) {
          const firstName = importedNames[0];
          cfgSelect.value = firstName;
          cfgNameInput.value = firstName;
          tanks = presets[firstName].map(t => ({ ...t }));
          // Apply ship meta if available
          try { const meta = loadShipMeta()[firstName]; if (meta) applyShipMeta(meta); } catch { }
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
          let prof = null; let name = (cfgNameInput.value || '').trim() || 'Imported Ship';
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
        } catch { }
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
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
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

async function buildCompactExportText() {
  // Use latest computed plan (fallback to fresh min_k)
  const res = currentPlanResult || computePlan(tanks, parcels);
  const di = res?.diagnostics || {};
  // Build line for quick version/cache verification
  let buildLine = '';
  try {
    const cb = (APP_BUILD && APP_BUILD.cb) ? ` cb=${APP_BUILD.cb}` : '';
    const tag = (APP_BUILD && APP_BUILD.build_tag) ? APP_BUILD.build_tag : 'unknown';
    buildLine = `Build: ${tag}${cb}`;
  } catch { }

  // Inputs (compact)
  const tankTokens = (tanks || []).map(t => {
    const inc = t.included === false ? 'x' : '';
    return `${t.id}:${fmtVol(t.volume_m3)}@${fmtPct01(t.min_pct)}-${fmtPct01(t.max_pct)}${inc}`;
  });
  const parcelTokens = (parcels || []).map(p => {
    const fr = p.fill_remaining ? 1 : 0;
    return `${p.id}(${(p.name || '').trim()}):V${fmtVol(p.total_m3 || 0)} R${fmtVol(p.density_kg_m3 || 0)} T${fmtVol(p.temperature_c || 0)} FR${fr}`;
  });

  const reverseLine = '';

  // Result summary
  const pwt = di.port_weight_mt != null ? Math.round(di.port_weight_mt) : 0;
  const swt = di.starboard_weight_mt != null ? Math.round(di.starboard_weight_mt) : 0;
  const imb = di.imbalance_pct != null ? Math.round(di.imbalance_pct) : 0;
  const bstat = di.balance_status || 'NA';
  const wcount = (di.warnings || []).length || 0;
  const ecount = (di.errors || []).length || 0;

  // Allocations (only used tanks)
  const allocTokens = (res.allocations || [])
    .map(a => `${a.tank_id}:${a.parcel_id}=${fmtVol(a.assigned_m3)}|F${Math.round((a.fill_pct || 0) * 100)}|W${fmtVol(a.weight_mt)}`);

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

  // Short signature over inputs+allocs (include ballast)
  const sigBase = JSON.stringify({
    t: tanks.map(t => ({ id: t.id, v: t.volume_m3, a: t.min_pct, b: t.max_pct, i: !!t.included })),
    p: parcels.map(p => ({ id: p.id, v: p.total_m3, r: p.density_kg_m3, t: p.temperature_c, fr: !!p.fill_remaining })),
    a: (res.allocations || []).map(a => ({ t: a.tank_id, p: a.parcel_id, v: a.assigned_m3 })),
    b: ((res.ballastAllocations || res.ballast_allocations) || []).map(b => ({ t: b.tank_id, v: b.assigned_m3 }))
  });
  const sig = quickHash(sigBase);

  const now = new Date();
  const hdr = `STW v1 ${now.toISOString()} plan=current sig=${sig}`;
  // Hydro summary for export (if available)
  let hydroLine = null;
  try {
    const m = computeHydroForAllocations([...(res.allocations || []), ...((res.ballastAllocations || res.ballast_allocations) || [])]);
    if (m) {
      const H = interpHydro(HYDRO_ROWS, m.Tm || 0) || {};
      hydroLine = `Hydro: DIS=${fmtVol(m.W_total)} DWT=${fmtVol(m.DWT)} Tf=${(m.Tf || 0).toFixed(3)} Tm=${(m.Tm || 0).toFixed(3)} Ta=${(m.Ta || 0).toFixed(3)} Trim=${(m.Trim || 0).toFixed(3)} LCF=${isFinite(m.LCF) ? m.LCF.toFixed(2) : '-'} LBP=${isFinite(SHIP_PARAMS.LBP) ? SHIP_PARAMS.LBP.toFixed(2) : '-'} rho=${isFinite(SHIP_PARAMS.RHO_REF) ? String(SHIP_PARAMS.RHO_REF) : '1.025'}`;
    }
  } catch { }
  const lines = [
    hdr,
    (buildLine || null),
    `Tanks(${tanks.length}): ${tankTokens.join(' ')}`,
    `Parcels(${parcels.length}): ${parcelTokens.join(' ')}`,
    reverseLine ? reverseLine : null,
    hydroLine,
    `Diag: P=${pwt} S=${swt} ${bstat} d%=${imb} warns=${wcount} errs=${ecount}`,
    `Alloc(${allocTokens.length}): ${allocTokens.join(' ')}`,
    // Ballast line
    (((res.ballastAllocations || res.ballast_allocations) || []).length ? `Ballast(${(res.ballastAllocations || res.ballast_allocations).length}): ${((res.ballastAllocations || res.ballast_allocations) || []).map(b => `${b.tank_id}:${fmtVol(b.assigned_m3)}|${isFinite(b.percent) ? Number(b.percent).toFixed(1) + '%' : '?'}`).join(' ')}` : null),
    traceTokens.length ? `Trace: ${traceTokens.join(' ')}` : null
  ].filter(Boolean);
  return lines.join('\n');
}

// Export current scenario (compact text). Hold Shift to export full JSON.
btnExportJson.addEventListener('click', async (ev) => {
  try {
    const res = currentPlanResult || computePlan(tanks, parcels);
    if (!res || !Array.isArray(res.allocations) || res.allocations.length === 0) {
      alert('No computed plan. Run Compute Plan first.');
      return;
    }
    if (ev && ev.shiftKey) {
      const data = { build: APP_BUILD, tanks, parcels, plan: res };
      const text = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(text);
      alert('Copied plan JSON to clipboard.');
      return;
    }
  } catch { }

  const compact = await buildCompactExportText();
  try {
    await navigator.clipboard.writeText(compact);
    alert('Copied compact export to clipboard. (Shift = full JSON)');
  } catch {
    alert('Copy failed. Please copy manually:\n\n' + compact);
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

// ---- Max Cargo (from target draft) ----
let LAST_MAX_CARGO_MT = null;

// ---- Min-Trim optimizer (intra-selection; no band; min/max respected) ----
function optimizeTrimWithinSelection(baseRes, opts) {
  try {
    const options = Object.assign({ includeSlops: false }, opts || {});
    if (!baseRes || !Array.isArray(baseRes.allocations) || baseRes.allocations.length === 0) return null;
    // Single fixed parcel only (keep scope tight)
    const parcelIds = Array.from(new Set(baseRes.allocations.map(a => a.parcel_id)));
    if (parcelIds.length !== 1) return null;
    const pid = parcelIds[0];
    // Map tank limits
    const tankById = new Map(tanks.map(t => [t.id, t]));
    const lim = new Map();
    for (const a of baseRes.allocations) {
      const t = tankById.get(a.tank_id); if (!t) return null;
      lim.set(a.tank_id, { min: t.volume_m3 * t.min_pct, max: t.volume_m3 * t.max_pct });
    }
    // Build per-tank volumes (only selected tanks)
    const vol = new Map();
    let totalV = 0;
    for (const a of baseRes.allocations) { vol.set(a.tank_id, Number(a.assigned_m3) || 0); totalV += Number(a.assigned_m3) || 0; }
    // Group used pairs
    const usedPairs = new Map(); // idx -> {P,S,lcg}
    for (const a of baseRes.allocations) {
      const id = a.tank_id; const idx = cotPairIndex(id);
      if (idx == null) continue;
      const ent = usedPairs.get(idx) || { P: null, S: null, lcg: 0 };
      if (/P$/.test(id)) ent.P = id; else if (/S$/.test(id)) ent.S = id;
      usedPairs.set(idx, ent);
    }
    // Only pairs with both sides; center tanks ignored
    const pairs = [];
    const cotIdxs = Array.from(usedPairs.keys()).filter(i => i < 1000);
    const minCot = cotIdxs.length ? Math.min(...cotIdxs) : 0;
    const maxCot = cotIdxs.length ? Math.max(...cotIdxs) : 0;
    const norm = (i) => (i >= 1000 ? maxCot + 1 : i);
    for (const [idx, ent] of usedPairs.entries()) {
      if (!options.includeSlops && idx >= 1000) continue; // skip slops unless allowed
      if (!ent.P || !ent.S) continue;
      let xP = TANK_LCG_MAP.has(ent.P) ? Number(TANK_LCG_MAP.get(ent.P)) : null;
      let xS = TANK_LCG_MAP.has(ent.S) ? Number(TANK_LCG_MAP.get(ent.S)) : null;
      let lcg = null;
      if (isFinite(xP) && isFinite(xS)) lcg = (xP + xS) / 2;
      else lcg = norm(idx);
      pairs.push({ idx, P: ent.P, S: ent.S, lcg });
    }
    if (!pairs.length) return null;
    pairs.sort((a, b) => a.lcg - b.lcg); // aft..fwd

    // Helper: compute trim
    const makeAllocs = () => {
      const out = [];
      for (const [tid, v] of vol.entries()) {
        const t = tankById.get(tid); if (!t) continue;
        const parcel = pid;
        const w = (v * ((parcels.find(p => p.id === pid)?.density_kg_m3) || 0)) / 1000.0;
        out.push({ tank_id: tid, parcel_id: parcel, assigned_m3: v, fill_pct: v / t.volume_m3, weight_mt: w });
      }
      return out;
    };
    const evalTrim = () => {
      const met = computeHydroForAllocations(makeAllocs());
      if (!met || !isFinite(met.Trim)) return null;
      return met.Trim;
    };
    let trim = evalTrim();
    if (trim == null) return null;
    const eps = 1e-6;
    const steps = [200, 100, 50, 25, 10]; // m3 per side
    let improved = false;
    for (const step of steps) {
      let changed = true; let guard = 0;
      while (changed && guard++ < 200) {
        changed = false;
        const wantFwd = trim > 0; // +stern → need to move cargo forward
        // Try all donor/receiver pair combinations; pick first that improves
        let didOne = false;
        const orderRecv = wantFwd ? [...pairs].sort((a, b) => b.lcg - a.lcg) : [...pairs].sort((a, b) => a.lcg - b.lcg);
        const orderDon = wantFwd ? [...pairs].sort((a, b) => a.lcg - b.lcg) : [...pairs].sort((a, b) => b.lcg - a.lcg);
        for (const pf of orderRecv) {
          for (const pa of orderDon) {
            if (pf.idx === pa.idx) continue;
            const limPf = lim.get(pf.P); const limSf = lim.get(pf.S);
            const limPa = lim.get(pa.P); const limSa = lim.get(pa.S);
            const vPf = vol.get(pf.P) || 0, vSf = vol.get(pf.S) || 0;
            const vPa = vol.get(pa.P) || 0, vSa = vol.get(pa.S) || 0;
            const addCap = Math.min((limPf.max - vPf), (limSf.max - vSf));
            const redCap = Math.min((vPa - limPa.min), (vSa - limSa.min));
            const delta = Math.min(addCap, redCap, step);
            if (delta <= eps) continue;
            vol.set(pf.P, vPf + delta); vol.set(pf.S, vSf + delta);
            vol.set(pa.P, vPa - delta); vol.set(pa.S, vSa - delta);
            const newTrim = evalTrim();
            if (newTrim != null && Math.abs(newTrim) + 1e-5 < Math.abs(trim)) {
              trim = newTrim; changed = true; improved = true; didOne = true; break;
            } else {
              vol.set(pf.P, vPf); vol.set(pf.S, vSf);
              vol.set(pa.P, vPa); vol.set(pa.S, vSa);
            }
          }
          if (didOne) break;
        }
        if (!didOne) break;
      }
    }
    if (!improved) return null;
    // Build result object similar to engine output
    const allocations = makeAllocs();
    // Diagnostics (port/starboard)
    let port_weight_mt = 0, starboard_weight_mt = 0;
    allocations.forEach(a => {
      const t = tankById.get(a.tank_id);
      if (!t) return;
      if (t.side === 'port') port_weight_mt += (a.weight_mt || 0);
      if (t.side === 'starboard') starboard_weight_mt += (a.weight_mt || 0);
    });
    const denom = port_weight_mt + starboard_weight_mt;
    const imbalance_pct = denom > 0 ? (Math.abs(port_weight_mt - starboard_weight_mt) / denom) * 100 : 0;
    const balance_status = imbalance_pct <= 10 ? 'Balanced' : 'Warning';
    const diagnostics = { port_weight_mt, starboard_weight_mt, balance_status, imbalance_pct, reasoning_trace: [{ parcel_id: pid, V: totalV, Cmin: 0, Cmax: 0, k_low: 0, k_high: 0, chosen_k: baseRes?.diagnostics?.reasoning_trace?.[0]?.chosen_k || 0, parity_adjustment: 'none', per_tank_v: 0, violates: false, reserved_pairs: [], reason: 'min-trim optimized (intra-selection, no band)' }], warnings: [], errors: [] };
    return { allocations, diagnostics };
  } catch { return null; }
}

// ---- Ballast optimizer (adds seawater; cargo fixed) ----
function optimizeBallastForTrim(baseRes, opts) {
  try {
    const options = Object.assign({ rho_t_m3: 1.025, improveThreshold: 0.05, stopEps: 0.002 }, opts || {});
    if (!baseRes || !Array.isArray(baseRes.allocations) || baseRes.allocations.length === 0) return null;
    const existingBallast = (baseRes.ballastAllocations || baseRes.ballast_allocations) || [];
    const existingVol = new Map();
    existingBallast.forEach(b => {
      const id = String(b?.tank_id || '');
      if (!id) return;
      existingVol.set(id, (existingVol.get(id) || 0) + (Number(b?.assigned_m3) || 0));
    });
    // Helper: ballast meta and grouping
    const bmeta = loadBallastMeta ? loadBallastMeta() : {};
    const getSide = (id) => guessSideFromId(id) || null;
    const baseKey = (s) => String(s || '').toUpperCase().replace(/(\s*\(?[PS]\)?\s*)$/, '').trim();
    // Build tank map and LCGs
    const tankLCG = (id) => {
      let x0 = TANK_LCG_MAP.has(id) ? Number(TANK_LCG_MAP.get(id)) : NaN;
      if (!isFinite(x0)) {
        try { const bt = (BALLAST_TANKS || []).find(t => t.id === id); if (bt && isFinite(bt.lcg)) x0 = Number(bt.lcg); } catch { }
      }
      return isFinite(x0) ? x0 : NaN;
    };
    // Effective headroom function from meta (min/max, preload)
    const effBounds = (bt) => {
      const m = bmeta[bt.id] || {};
      const cap = Number(bt.cap_m3 || 0);
      const minPct = isFinite(m.min_pct) ? m.min_pct : 0;
      const maxPct = isFinite(m.max_pct) ? m.max_pct : 1;
      const pre = Number(m.preload_m3 || 0);
      const used = Math.max(0, pre) + (existingVol.get(bt.id) || 0);
      const minV = Math.max(0, cap * minPct - used);
      const maxV = Math.max(0, cap * maxPct - used);
      return { minV, maxV };
    };
    // Group ballast tanks by base key
    const groups = {};
    (BALLAST_TANKS || []).forEach(bt => {
      const m = bmeta[bt.id] || {};
      const inc = m.included !== false; // default true
      if (!inc) return; // skip excluded ballast tanks
      const key = baseKey(bt.id);
      if (!groups[key]) groups[key] = { P: null, S: null, centers: [], lcg: NaN };
      const side = getSide(bt.id);
      if (side === 'port') groups[key].P = bt; else if (side === 'starboard') groups[key].S = bt; else groups[key].centers.push(bt);
    });
    // Build candidate list: pairs and centers with headroom and representative LCG
    const pairs = [];
    Object.keys(groups).forEach(k => {
      const g = groups[k];
      if (g.P && g.S) {
        // pair
        const bP = effBounds(g.P), bS = effBounds(g.S);
        const head = Math.min(bP.maxV, bS.maxV);
        if (head > 1e-6) {
          const xP = tankLCG(g.P.id), xS = tankLCG(g.S.id);
          const lcg = isFinite(xP) && isFinite(xS) ? (xP + xS) / 2 : NaN;
          pairs.push({ type: 'pair', P: g.P, S: g.S, head, lcg });
        }
      }
      // centers
      (g.centers || []).forEach(ct => {
        const bC = effBounds(ct);
        const head = bC.maxV;
        if (head > 1e-6) {
          const lcg = tankLCG(ct.id);
          pairs.push({ type: 'center', C: ct, head, lcg });
        }
      });
    });
    if (!pairs.length) { return null; }
    // Initial hydro and allocations
    const cargoAllocs = baseRes.allocations.map(a => ({ ...a }));
    const ballastAllocs = []; // {tank_id, assigned_m3}
    const evalTrim = () => {
      const base = existingBallast.map(b => ({
        tank_id: b.tank_id,
        parcel_id: 'BALLAST',
        assigned_m3: Number(b.assigned_m3) || 0,
        fill_pct: 0,
        weight_mt: (Number(b.weight_mt) || ((Number(b.assigned_m3) || 0) * options.rho_t_m3))
      }));
      return computeHydroForAllocations([
        ...cargoAllocs,
        ...base,
        ...ballastAllocs.map(b => ({ tank_id: b.tank_id, parcel_id: 'BALLAST', assigned_m3: b.assigned_m3, fill_pct: 0, weight_mt: b.assigned_m3 * options.rho_t_m3 }))
      ]);
    };
    let met = evalTrim();
    if (!met || !isFinite(met.Trim)) return null;
    const startTrim = met.Trim;
    const steps = [200, 100, 50, 25, 10, 5, 2, 1, 0.5];
    const eps = 1e-6;
    // Simple end-first strategy: fill from relevant end one group at a time
    for (const step of steps) {
      met = evalTrim();
      const wantFwd = met.Trim > 0; // +stern → add forward
      const ordered = [...pairs].filter(p => isFinite(p.lcg)).sort((a, b) => (wantFwd ? (b.lcg - a.lcg) : (a.lcg - b.lcg)));
      // Choose only the single best group (pair preferred, else center)
      const best = ordered.find(g => g.type === 'pair') || ordered.find(g => g.type === 'center');
      if (!best) break;
      {
        const g = best;
        if (g.type === 'pair') {
          // Bisection on per-side volume x in [0, g.head]
          const f = (x) => {
            const n = evalTrim(); if (!n) return null; const t0 = n.Trim;
            ballastAllocs.push({ tank_id: g.P.id, assigned_m3: x });
            ballastAllocs.push({ tank_id: g.S.id, assigned_m3: x });
            const n2 = evalTrim();
            ballastAllocs.pop(); ballastAllocs.pop();
            return n2 ? n2.Trim : t0;
          };
          let lo = 0, hi = Math.max(0, g.head);
          let t0 = evalTrim()?.Trim || 0;
          let flo = t0, fhi = f(hi);
          let bestX = 0, bestT = Math.abs(t0);
          if (fhi != null && Math.abs(fhi) < bestT) { bestT = Math.abs(fhi); bestX = hi; }
          if (fhi != null && flo * fhi <= 0) {
            for (let it = 0; it < 24; it++) {
              const mid = (lo + hi) / 2;
              const fm = f(mid);
              if (fm == null) break;
              const am = Math.abs(fm);
              if (am < bestT) { bestT = am; bestX = mid; }
              if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
              if (am < options.stopEps) break;
            }
          }
          // Apply bestX (per side)
          const addPerSide = Math.min(bestX, g.head);
          if (addPerSide > eps) {
            ballastAllocs.push({ tank_id: g.P.id, assigned_m3: addPerSide });
            ballastAllocs.push({ tank_id: g.S.id, assigned_m3: addPerSide });
            g.head -= addPerSide;
          }
        } else {
          // Center: simple bisection on [0, head]
          const f = (x) => {
            const n = evalTrim(); if (!n) return null;
            ballastAllocs.push({ tank_id: g.C.id, assigned_m3: x });
            const n2 = evalTrim();
            ballastAllocs.pop();
            return n2 ? n2.Trim : n.Trim;
          };
          let lo = 0, hi = Math.max(0, g.head);
          let t0 = evalTrim()?.Trim || 0;
          let flo = t0, fhi = f(hi);
          let bestX = 0, bestT = Math.abs(t0);
          if (fhi != null && Math.abs(fhi) < bestT) { bestT = Math.abs(fhi); bestX = hi; }
          if (fhi != null && flo * fhi <= 0) {
            for (let it = 0; it < 24; it++) {
              const mid = (lo + hi) / 2; const fm = f(mid); if (fm == null) break; const am = Math.abs(fm);
              if (am < bestT) { bestT = am; bestX = mid; }
              if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
              if (am < options.stopEps) break;
            }
          }
          const add = Math.min(bestX, g.head);
          if (add > eps) { ballastAllocs.push({ tank_id: g.C.id, assigned_m3: add }); g.head -= add; }
        }
        // re-check trim; if near zero, stop early
        const now = evalTrim();
        if (now && Math.abs(now.Trim) < options.stopEps) break;
      }
    }
    const final = evalTrim();
    if (!final || !isFinite(final.Trim)) return null;
    const improve = Math.abs(startTrim) - Math.abs(final.Trim);
    if (improve <= options.improveThreshold || ballastAllocs.length === 0) { return null; }
    // Build diagnostics including ballast
    const allBallast = existingBallast
      .map(b => ({ tank_id: b.tank_id, assigned_m3: Number(b.assigned_m3) || 0, weight_mt: (Number(b.weight_mt) || ((Number(b.assigned_m3) || 0) * options.rho_t_m3)), percent: b.percent }))
      .concat(ballastAllocs.map(b => ({ tank_id: b.tank_id, assigned_m3: b.assigned_m3, weight_mt: b.assigned_m3 * options.rho_t_m3 })));
    const allAllocs = [...cargoAllocs, ...allBallast.map(b => ({ tank_id: b.tank_id, parcel_id: 'BALLAST', assigned_m3: b.assigned_m3, fill_pct: 0, weight_mt: b.weight_mt }))];
    const hydro = computeHydroForAllocations(allAllocs);
    // P/S weights from combined allocations
    let port_weight_mt = 0, starboard_weight_mt = 0;
    const byId = new Map(tanks.map(t => [t.id, t]));
    allAllocs.forEach(a => { const t = byId.get(a.tank_id); if (!t) return; if (t.side === 'port') port_weight_mt += (a.weight_mt || 0); if (t.side === 'starboard') starboard_weight_mt += (a.weight_mt || 0); });
    const denom = port_weight_mt + starboard_weight_mt;
    const imbalance_pct = denom > 0 ? (Math.abs(port_weight_mt - starboard_weight_mt) / denom) * 100 : 0;
    const balance_status = imbalance_pct <= 10 ? 'Balanced' : 'Warning';
    const diagnostics = {
      port_weight_mt,
      starboard_weight_mt,
      balance_status,
      imbalance_pct,
      reasoning_trace: (baseRes?.diagnostics?.reasoning_trace || []).concat([{ parcel_id: 'BALLAST', V: -1, Cmin: 0, Cmax: 0, k_low: 0, k_high: 0, chosen_k: 0, parity_adjustment: 'none', per_tank_v: 0, violates: false, reserved_pairs: [], reason: 'ballast optimization applied' }]),
      warnings: baseRes?.diagnostics?.warnings || [],
      errors: baseRes?.diagnostics?.errors || []
    };
    return { allocations: cargoAllocs, ballastAllocations: allBallast, diagnostics };
  } catch { return null; }
}
// Helper: parse pair index including SLOPs for variant building
function uiPairIndex(id) {
  try {
    const s = String(id || '').toUpperCase();
    const m = /COT(\d+)/.exec(s);
    if (m) return parseInt(m[1], 10);
    if (s === 'SLOPP' || s === 'SLOPS') return 1000;
  } catch { }
  return null;
}

// Toggle handling for Target Draft input
function applyDraftToggleUI() {
  try {
    if (!rsEnableEl || !rsTargetDraftEl) return;
    const enabled = !!rsEnableEl.checked;
    if (!enabled) {
      if (rsTargetDraftEl.value !== '') rsTargetDraftEl.setAttribute('data-prev', rsTargetDraftEl.value);
      rsTargetDraftEl.value = '';
      rsTargetDraftEl.disabled = true;
    } else {
      rsTargetDraftEl.disabled = false;
      if (!rsTargetDraftEl.value) {
        const prev = rsTargetDraftEl.getAttribute('data-prev');
        rsTargetDraftEl.value = prev != null ? prev : '10.5';
      }
    }
  } catch { }
}

function getRSInputs() {
  const parseNum = (el, fb = NaN) => {
    if (!el) return fb;
    const v = String(el.value || '').replace(',', '.');
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fb;
  };
  return {
    T: parseNum(rsTargetDraftEl, NaN),
    rho: parseNum(rsRhoEl, (typeof SHIP_PARAMS.RHO_REF === 'number' ? SHIP_PARAMS.RHO_REF : 1.025)),
    fo: parseNum(rsFoEl, 0),
    fw: parseNum(rsFwEl, 0),
    oth: parseNum(rsOthEl, 0),
    constW: parseNum(rsConstEl, 0),
    constX: parseNum(rsConstLcgEl, 0)
  };
}

function computeParcelWeightMT(p) {
  const v = Number(p?.total_m3);
  const r = Number(p?.density_kg_m3);
  if (!isFinite(v) || !isFinite(r) || r <= 0 || v <= 0) return 0;
  return (v * r) / 1000; // tons
}

function updateFRParcelFromInputs() {
  try {
    const idx = Array.isArray(parcels) ? parcels.findIndex(pp => !!pp.fill_remaining) : -1;
    if (idx < 0) return false;
    if (!Number.isFinite(LAST_MAX_CARGO_MT) || LAST_MAX_CARGO_MT <= 0) return false;
    const dens = Number(parcels[idx]?.density_kg_m3 || 0);
    if (!isFinite(dens) || dens <= 0) return false;
    let otherW = 0;
    for (let i = 0; i < parcels.length; i++) {
      if (i === idx) continue;
      otherW += computeParcelWeightMT(parcels[i]);
    }
    const remainW = Math.max(0, LAST_MAX_CARGO_MT - otherW);
    const vol = (remainW * 1000) / dens;
    const cur = Number(parcels[idx].total_m3);
    if (!isFinite(cur) || Math.abs(cur - vol) > 1e-6) {
      parcels[idx] = { ...parcels[idx], total_m3: vol };
      return true;
    }
  } catch { }
  return false;
}

function updateMaxCargoView() {
  try {
    LAST_MAX_CARGO_MT = null;
    if (!rsMaxCargoEl) return;
    if (rsEnableEl && !rsEnableEl.checked) { rsMaxCargoEl.textContent = 'Max cargo: — mt'; return; }

    const targetDraft = getTargetDraftMax();
    const canDmax = Number.isFinite(targetDraft) && targetDraft > 0
      && Array.isArray(HYDRO_ROWS) && HYDRO_ROWS.length > 0
      && (TANK_LCG_MAP && TANK_LCG_MAP.size > 0);
    const hasFR = Array.isArray(parcels) && parcels.some(p => !!p.fill_remaining);
    if (canDmax && hasFR) {
      const best = solveFillRemainingForTargetDmax(targetDraft);
      if (best && Number.isFinite(best.cargo_mt)) {
        LAST_MAX_CARGO_MT = best.cargo_mt;
        rsMaxCargoEl.textContent = `Max cargo @ Dmax: ${best.cargo_mt.toLocaleString(undefined, { maximumFractionDigits: 0 })} mt`;
        const idx = parcels.findIndex(pp => !!pp.fill_remaining);
        if (idx >= 0) {
          const cur = Number(parcels[idx]?.total_m3);
          const want = Number(best.fr_volume_m3);
          if (!Number.isFinite(cur) || !Number.isFinite(want) || Math.abs(cur - want) > 1e-3) {
            parcels[idx] = { ...parcels[idx], total_m3: want };
            persistLastState();
            render();
          }
        }
        return;
      }
      rsMaxCargoEl.textContent = 'Max cargo @ Dmax: — mt';
      return;
    }

    // Fallback (mean-draft capacity estimate): use hydro displacement at target draft and subtract known weights.
    const { T, rho, fo, fw, oth, constW } = getRSInputs();
    if (!Array.isArray(HYDRO_ROWS) || HYDRO_ROWS.length === 0 || !Number.isFinite(T)) {
      rsMaxCargoEl.textContent = 'Max cargo: — mt';
      return;
    }
    const H = interpHydro(HYDRO_ROWS, T);
    const DIS_FW = H && Number.isFinite(H.DIS_FW) ? Number(H.DIS_FW) : NaN;
    if (!Number.isFinite(DIS_FW)) { rsMaxCargoEl.textContent = 'Max cargo: — mt'; return; }
    const W_dis = rho * DIS_FW;
    const light = (Number.isFinite(LIGHT_SHIP.weight_mt) ? Number(LIGHT_SHIP.weight_mt) : 0);
    // include preloads total weight
    let preW = 0;
    try {
      for (const t of tanks || []) {
        const v = Number(t?.preload_m3) || 0; const r = Number(t?.preload_density_kg_m3) || 0;
        if (v > 0 && r > 0) preW += (v * r) / 1000.0;
      }
      const bmeta = loadBallastMeta ? loadBallastMeta() : {};
      Object.keys(bmeta || {}).forEach(id => { const m = bmeta[id] || {}; const v = Number(m.preload_m3) || 0; const r = Number(m.preload_density_kg_m3) || 0; if (v > 0 && r > 0) preW += (v * r) / 1000.0; });
    } catch { }
    const others = light + (fo || 0) + (fw || 0) + (oth || 0) + (constW || 0) + preW;
    const cargoMax = Math.max(0, W_dis - others);
    LAST_MAX_CARGO_MT = cargoMax;
    rsMaxCargoEl.textContent = `Max cargo (mean): ${cargoMax.toLocaleString(undefined, { maximumFractionDigits: 0 })} mt`;
    // keep FR parcel in sync if exists
    const changed = updateFRParcelFromInputs();
    if (changed) { persistLastState(); render(); }
  } catch {
    LAST_MAX_CARGO_MT = null;
    if (rsMaxCargoEl) rsMaxCargoEl.textContent = 'Max cargo: — mt';
  }
}

// Wire inputs to live-update Max Cargo
try {
  [rsTargetDraftEl, rsRhoEl, rsFoEl, rsFwEl, rsOthEl, rsConstEl, rsConstLcgEl]
    .filter(Boolean)
    .forEach(el => el.addEventListener('input', updateMaxCargoView));
} catch { }
try { if (rsEnableEl) rsEnableEl.addEventListener('change', updateMaxCargoView); } catch { }
// Recompute hydro summary when RS inputs change (draft/trim reflect FO/FW/OTH/CONST/ρ)
try {
  const reHydro = () => { try { renderSummaryAndSvg(currentPlanResult); } catch { } };
  [rsRhoEl, rsFoEl, rsFwEl, rsOthEl, rsConstEl, rsConstLcgEl]
    .filter(Boolean)
    .forEach(el => el.addEventListener('input', reHydro));
} catch { }
try { updateMaxCargoView(); } catch { }

function interpHydro(rows, T) {
  try {
    if (!rows || rows.length === 0 || !isFinite(T)) return null;
    const rr = rows.slice().sort((a, b) => a.draft_m - b.draft_m);
    const rho_ref = SHIP_PARAMS.RHO_REF || 1.025;
    const toFW = (r) => (typeof r.dis_fw === 'number') ? r.dis_fw : ((typeof r.dis_sw === 'number') ? (r.dis_sw / rho_ref) : undefined);
    if (T <= rr[0].draft_m) { const r = rr[0]; return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct, DIS_FW: toFW(r) }; }
    if (T >= rr[rr.length - 1].draft_m) { const r = rr[rr.length - 1]; return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct, DIS_FW: toFW(r) }; }
    let lo = 0, hi = rr.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rr[mid].draft_m <= T) lo = mid; else hi = mid; }
    const a = rr[lo], b = rr[hi];
    const t = (T - a.draft_m) / (b.draft_m - a.draft_m);
    const lerp = (x, y) => x + (y - x) * t;
    const aFW = toFW(a), bFW = toFW(b);
    const DIS_FW = (isFinite(aFW) && isFinite(bFW)) ? lerp(aFW, bFW) : undefined;
    return { LCF: lerp(a.lcf_m, b.lcf_m), LCB: lerp(a.lcb_m, b.lcb_m), TPC: lerp(a.tpc, b.tpc), MCT1cm: lerp(a.mct, b.mct), DIS_FW };
  } catch { return null; }
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

function computeHydroForAllocations(allocations) {
  if (!HYDRO_ROWS || HYDRO_ROWS.length === 0 || !allocations) return null;
  // Safe linear interpolation against hydro table (guards against any external mutation)
  function interpHydroSafe(rows, T) {
    try {
      const rr = Array.isArray(rows) ? rows.slice().sort((a, b) => a.draft_m - b.draft_m) : [];
      if (!rr.length || !isFinite(T)) return null;
      const rho_ref = SHIP_PARAMS.RHO_REF || 1.025;
      const toFW = (r) => (typeof r.dis_fw === 'number') ? r.dis_fw : ((typeof r.dis_sw === 'number') ? (r.dis_sw / rho_ref) : undefined);
      // clamp
      if (T <= rr[0].draft_m) {
        const r = rr[0]; return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct, DIS_FW: toFW(r) };
      }
      if (T >= rr[rr.length - 1].draft_m) {
        const r = rr[rr.length - 1]; return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct, DIS_FW: toFW(r) };
      }
      let lo = 0, hi = rr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rr[mid].draft_m <= T) lo = mid; else hi = mid; }
      const a = rr[lo], b = rr[hi];
      const t = (T - a.draft_m) / (b.draft_m - a.draft_m);
      const lerp = (x, y) => x + (y - x) * t;
      const aFW = toFW(a), bFW = toFW(b);
      const DIS_FW = (isFinite(aFW) && isFinite(bFW)) ? lerp(aFW, bFW) : undefined;
      return { LCF: lerp(a.lcf_m, b.lcf_m), LCB: lerp(a.lcb_m, b.lcb_m), TPC: lerp(a.tpc, b.tpc), MCT1cm: lerp(a.mct, b.mct), DIS_FW };
    } catch { return null; }
  }
  // Build items (include consumables and constant from Cargo Input)
  let fo = 0, fw = 0, oth = 0, constW = 0, constX = null;
  try {
    const rs = getRSInputs ? getRSInputs() : null;
    if (rs) {
      if (isFinite(rs.fo)) fo = Number(rs.fo) || 0;
      if (isFinite(rs.fw)) fw = Number(rs.fw) || 0;
      if (isFinite(rs.oth)) oth = Number(rs.oth) || 0;
      if (isFinite(rs.constW)) constW = Number(rs.constW) || 0;
      if (isFinite(rs.constX)) constX = Number(rs.constX);
    }
  } catch { }
  // Use user-provided water density if available; else fall back to ship's ref density
  let rho_ref = (typeof SHIP_PARAMS.RHO_REF === 'number' && SHIP_PARAMS.RHO_REF > 0) ? SHIP_PARAMS.RHO_REF : 1.025;
  try { const rs = getRSInputs ? getRSInputs() : null; if (rs && isFinite(rs.rho) && rs.rho > 0) rho_ref = Number(rs.rho); } catch { }
  let W = 0, Mx = 0;
  const LCG_BIAS = getLCGBias();
  const ballastIdSet = new Set((BALLAST_TANKS || []).map(t => t && t.id).filter(Boolean));
  // cargo + ballast allocations
  allocations.forEach(a => {
    let w = Number(a?.weight_mt);
    if (!Number.isFinite(w)) {
      const v = Number(a?.assigned_m3);
      const pid = String(a?.parcel_id || '');
      const isBallast = pid.toUpperCase() === 'BALLAST' || ballastIdSet.has(String(a?.tank_id || ''));
      if (Number.isFinite(v) && v > 0 && isBallast) w = v * rho_ref;
      else w = 0;
    }
    let x0 = TANK_LCG_MAP.has(a.tank_id) ? Number(TANK_LCG_MAP.get(a.tank_id)) : NaN;
    if (!isFinite(x0)) {
      try { const bt = (BALLAST_TANKS || []).find(t => t.id === a.tank_id); if (bt && isFinite(bt.lcg)) x0 = Number(bt.lcg); } catch { }
    }
    const x = isFinite(x0) ? (x0 + LCG_BIAS) : LCG_BIAS;
    W += w;
    Mx += w * (isFinite(x) ? x : 0);
  });
  // preloads: treat as virtual cargo at tank LCGs
  try {
    for (const t of tanks || []) {
      const v = Number(t?.preload_m3) || 0; const r = Number(t?.preload_density_kg_m3) || 0;
      if (v > 0 && r > 0) {
        const w = (v * r) / 1000.0;
        const x0 = TANK_LCG_MAP.has(t.id) ? Number(TANK_LCG_MAP.get(t.id)) : 0;
        const x = isFinite(x0) ? (x0 + LCG_BIAS) : LCG_BIAS;
        W += w; Mx += w * (isFinite(x) ? x : 0);
      }
    }
    // ballast preloads (from editor meta)
    const bmeta = loadBallastMeta ? loadBallastMeta() : {};
    Object.keys(bmeta || {}).forEach(id => {
      const m = bmeta[id] || {}; const v = Number(m.preload_m3) || 0; const r = Number(m.preload_density_kg_m3) || 0;
      if (v > 0 && r > 0) { const w = (v * r) / 1000.0; const x0 = TANK_LCG_MAP.has(id) ? Number(TANK_LCG_MAP.get(id)) : 0; const x = isFinite(x0) ? (x0 + LCG_BIAS) : LCG_BIAS; W += w; Mx += w * (isFinite(x) ? x : 0); }
    });
  } catch { }
  // consumables — use per-type LCGs when available; else fallback to average
  const cons = {
    fo: { w: (fo || 0), x: (isFinite(SHIP_PARAMS.LCG_FO) ? SHIP_PARAMS.LCG_FO : null) },
    fw: { w: (fw || 0), x: (isFinite(SHIP_PARAMS.LCG_FW) ? SHIP_PARAMS.LCG_FW : null) },
    oth: { w: (oth || 0), x: (isFinite(SHIP_PARAMS.LCG_OTH) ? SHIP_PARAMS.LCG_OTH : null) }
  };
  const consW = cons.fo.w + cons.fw.w + cons.oth.w;
  W += consW;
  const consMomentKnown = (cons.fo.w && cons.fo.x != null ? cons.fo.w * cons.fo.x : 0)
    + (cons.fw.w && cons.fw.x != null ? cons.fw.w * cons.fw.x : 0)
    + (cons.oth.w && cons.oth.x != null ? cons.oth.w * cons.oth.x : 0);
  if (consMomentKnown !== 0) {
    Mx += consMomentKnown;
  } else if (isFinite(SHIP_PARAMS.LCG_FO_FW)) {
    Mx += consW * SHIP_PARAMS.LCG_FO_FW;
  }
  // constant
  if (constW) {
    W += constW;
    if (isFinite(constX)) Mx += constW * constX;
  }
  // lightship
  if (isFinite(LIGHT_SHIP.weight_mt)) {
    W += LIGHT_SHIP.weight_mt; if (isFinite(LIGHT_SHIP.lcg)) Mx += LIGHT_SHIP.weight_mt * LIGHT_SHIP.lcg;
  }
  if (!(W > 0)) return null;
  const LCG = Mx / W;
  const rowsUse = HYDRO_ROWS;
  const LBP = (typeof SHIP_PARAMS.LBP === 'number' && SHIP_PARAMS.LBP > 0) ? SHIP_PARAMS.LBP : null;
  const Hship = computeHydroShip(rowsUse, W, LCG, LBP, rho_ref);
  if (!Hship) return null;
  const DWT = isFinite(LIGHT_SHIP.weight_mt) ? (W - LIGHT_SHIP.weight_mt) : W;
  return { W_total: W, DWT, Tf: Hship.Tf, Tm: Hship.Tm, Ta: Hship.Ta, Trim: Hship.Trim, LCG_total: LCG, LCB: Hship.LCB, LCF: Hship.LCF, MCT1cm: Hship.MCT1cm, TPC: Hship.TPC, dAP: (LBP ? (LBP / 2) + (Hship.LCF || 0) : undefined), dFP: (LBP ? (LBP / 2) - (Hship.LCF || 0) : undefined), LCG_bias: LCG_BIAS, hydro_version: 'shipdata_core' };
}

function getTargetDraftMax() {
  try {
    if (!rsEnableEl || !rsEnableEl.checked) return NaN;
    const rs = getRSInputs ? getRSInputs() : null;
    const t = rs ? Number(rs.T) : NaN;
    return (Number.isFinite(t) && t > 0) ? t : NaN;
  } catch { return NaN; }
}

function getWaterDensity() {
  try {
    const rs = getRSInputs ? getRSInputs() : null;
    const rho = rs ? Number(rs.rho) : NaN;
    if (Number.isFinite(rho) && rho > 0) return rho;
  } catch { }
  const rhoRef = (typeof SHIP_PARAMS.RHO_REF === 'number' && SHIP_PARAMS.RHO_REF > 0) ? SHIP_PARAMS.RHO_REF : NaN;
  return Number.isFinite(rhoRef) ? rhoRef : 1.025;
}

function computeHydroForResult(res) {
  try {
    if (!res || !Array.isArray(res.allocations)) return null;
    const rho = getWaterDensity();
    const ballast = (res.ballastAllocations || res.ballast_allocations) || [];
    const ballastAsAllocs = (ballast || []).map(b => {
      const v = Number(b?.assigned_m3) || 0;
      const w = Number(b?.weight_mt);
      return { tank_id: b?.tank_id, parcel_id: 'BALLAST', assigned_m3: v, weight_mt: Number.isFinite(w) ? w : (v * rho), fill_pct: 0 };
    });
    return computeHydroForAllocations([...(res.allocations || []), ...ballastAsAllocs]);
  } catch { return null; }
}

function computeListMetricsForResult(res) {
  try {
    if (!res) return { port_weight_mt: 0, starboard_weight_mt: 0, imbalance_pct: 0, balance_status: 'NA' };
    const byId = new Map((tanks || []).map(t => [t.id, t]));
    const bmeta = loadBallastMeta ? loadBallastMeta() : {};
    const sideOfBallast = (id) => {
      const rec = bmeta && id ? bmeta[id] : null;
      const s = rec && rec.side ? String(rec.side) : (guessSideFromId(id) || '');
      return s === 'port' || s === 'starboard' ? s : null;
    };
    let port = 0;
    let star = 0;
    // cargo weights
    (res.allocations || []).forEach(a => {
      const t = byId.get(a.tank_id);
      const side = t?.side;
      const w = Number(a?.weight_mt) || 0;
      if (side === 'port') port += w;
      else if (side === 'starboard') star += w;
    });
    // ballast weights (if present)
    const rhoB = getWaterDensity();
    const ballast = (res.ballastAllocations || res.ballast_allocations) || [];
    ballast.forEach(b => {
      const side = sideOfBallast(b?.tank_id);
      if (!side) return;
      const w = Number(b?.weight_mt);
      const v = Number(b?.assigned_m3);
      const wt = Number.isFinite(w) ? w : (Number.isFinite(v) ? v * rhoB : 0);
      if (side === 'port') port += wt;
      else if (side === 'starboard') star += wt;
    });
    const denom = port + star;
    const imbalance_pct = denom > 0 ? (Math.abs(port - star) / denom) * 100 : 0;
    const balance_status = imbalance_pct <= 10 ? 'Balanced' : 'Warning';
    return { port_weight_mt: port, starboard_weight_mt: star, imbalance_pct, balance_status };
  } catch {
    return { port_weight_mt: 0, starboard_weight_mt: 0, imbalance_pct: 0, balance_status: 'NA' };
  }
}

function optimizeBallastForHeel(baseRes, opts) {
  try {
    const options = Object.assign({ rho_t_m3: getWaterDensity(), tol_pct: 0.2 }, opts || {});
    if (!baseRes || !Array.isArray(baseRes.allocations) || baseRes.allocations.length === 0) return null;
    if (!Array.isArray(BALLAST_TANKS) || BALLAST_TANKS.length === 0) return null;

    const baseList = computeListMetricsForResult(baseRes);
    if (!Number.isFinite(baseList.imbalance_pct) || baseList.imbalance_pct <= options.tol_pct) return null;

    const heavySide = baseList.port_weight_mt >= baseList.starboard_weight_mt ? 'port' : 'starboard';
    const lightSide = heavySide === 'port' ? 'starboard' : 'port';
    const deltaW = Math.abs(baseList.port_weight_mt - baseList.starboard_weight_mt); // t to add to light side for equality
    if (!(deltaW > 1e-6) || !(options.rho_t_m3 > 0)) return null;

    const bmeta = loadBallastMeta ? loadBallastMeta() : {};
    const getSide = (id) => {
      const rec = bmeta && id ? bmeta[id] : null;
      const s = rec && rec.side ? String(rec.side) : (guessSideFromId(id) || '');
      return s === 'port' || s === 'starboard' ? s : null;
    };
    const effBounds = (bt) => {
      const id = bt && bt.id;
      const cap = Number(bt?.cap_m3 || 0);
      const rec = (id && bmeta && bmeta[id]) ? bmeta[id] : {};
      const inc = (rec && typeof rec.included === 'boolean') ? rec.included : true;
      const minPct = Math.max(0, Math.min(1, Number(rec.min_pct ?? 0)));
      const maxPct = Math.max(0, Math.min(1, Number(rec.max_pct ?? 1)));
      const preload = Math.max(0, Number(rec.preload_m3 ?? 0));
      if (!inc || !(cap > 0) || !(maxPct > 0)) return { cap, preload, minV: 0, maxV: 0, minPct, maxPct };
      const minV = cap * minPct;
      const maxV = cap * maxPct;
      return { cap, preload, minV, maxV, minPct, maxPct };
    };

    // Current hydro to pick LCF for minimal trim impact
    const h0 = computeHydroForResult(baseRes);
    const lcf = (h0 && Number.isFinite(h0.LCF)) ? Number(h0.LCF) : 0;

    // Existing ballast volumes (include any already in baseRes, plus preloads)
    const usedVol = new Map();
    const existingBallast = (baseRes.ballastAllocations || baseRes.ballast_allocations) || [];
    existingBallast.forEach(b => {
      const id = String(b?.tank_id || '');
      if (!id) return;
      usedVol.set(id, (usedVol.get(id) || 0) + (Number(b?.assigned_m3) || 0));
    });

    const candidates = (BALLAST_TANKS || [])
      .filter(bt => bt && bt.id)
      .map(bt => {
        const side = getSide(bt.id);
        const bounds = effBounds(bt);
        const used = (usedVol.get(bt.id) || 0) + (bounds.preload || 0);
        const head = Math.max(0, (bounds.maxV || 0) - used);
        const minAdd = (used > 1e-9) ? 0 : (bounds.minV || 0);
        const lcg = Number.isFinite(Number(bt.lcg)) ? Number(bt.lcg) : (TANK_LCG_MAP.has(bt.id) ? Number(TANK_LCG_MAP.get(bt.id)) : NaN);
        return { bt, side, head, minAdd, used, cap: bounds.cap || 0, lcg };
      })
      .filter(c => c.side === lightSide && c.head > 1e-6);

    if (!candidates.length) return null;

    // Prefer tanks near LCF to reduce trim effect; fallback to largest headroom
    candidates.sort((a, b) => {
      const aScore = Number.isFinite(a.lcg) ? Math.abs(a.lcg - lcf) : Infinity;
      const bScore = Number.isFinite(b.lcg) ? Math.abs(b.lcg - lcf) : Infinity;
      if (aScore !== bScore) return aScore - bScore;
      return b.head - a.head;
    });

    let remainingW = deltaW;
    const ballastAllocs = existingBallast.map(b => ({ ...b }));
    const eps = 1e-6;
    for (const c of candidates) {
      if (remainingW <= eps) break;
      const needV = remainingW / options.rho_t_m3;
      const addMax = c.head;
      if (addMax <= eps) continue;
      // Respect min-fill if tank was empty (minAdd > 0)
      if (c.minAdd > eps && needV + eps < c.minAdd) continue;
      const addV = Math.min(addMax, needV);
      if (addV <= eps) continue;
      const pct = (c.cap > 0) ? ((c.used + addV) / c.cap * 100) : undefined;
      ballastAllocs.push({ tank_id: c.bt.id, assigned_m3: addV, weight_mt: addV * options.rho_t_m3, percent: pct });
      remainingW -= addV * options.rho_t_m3;
    }

    const out = { allocations: baseRes.allocations, ballastAllocations: ballastAllocs, diagnostics: baseRes.diagnostics || {} };
    const list2 = computeListMetricsForResult(out);
    const di = Object.assign({}, baseRes.diagnostics || {});
    di.port_weight_mt = list2.port_weight_mt;
    di.starboard_weight_mt = list2.starboard_weight_mt;
    di.imbalance_pct = list2.imbalance_pct;
    di.balance_status = list2.balance_status;
    di.reasoning_trace = (di.reasoning_trace || []).concat([{ parcel_id: 'BALLAST_HEEL', V: -1, Cmin: 0, Cmax: 0, k_low: 0, k_high: 0, chosen_k: 0, parity_adjustment: 'none', per_tank_v: 0, violates: false, reserved_pairs: [], reason: `heel/list balance ballast applied (${lightSide})` }]);
    out.diagnostics = di;

    // Only accept if it actually improves (or reaches tolerance)
    if (list2.imbalance_pct + 1e-9 >= baseList.imbalance_pct && list2.imbalance_pct > options.tol_pct + 1e-9) return null;
    return out;
  } catch { return null; }
}

function cargoWeightMT(res) {
  try { return (res?.allocations || []).reduce((s, a) => s + (Number(a?.weight_mt) || 0), 0); } catch { return 0; }
}

function ballastWeightMT(res) {
  try {
    const rho = getWaterDensity();
    const ballast = (res?.ballastAllocations || res?.ballast_allocations) || [];
    return ballast.reduce((s, b) => {
      const w = Number(b?.weight_mt);
      if (Number.isFinite(w)) return s + w;
      const v = Number(b?.assigned_m3);
      return s + (Number.isFinite(v) ? v * rho : 0);
    }, 0);
  } catch { return 0; }
}

function cloneParcels(ps) {
  return (ps || []).map(p => ({ ...p }));
}

function computeVariantsForParcels(tempParcels) {
  const old = parcels;
  parcels = tempParcels;
  try { return computeVariants(); } finally { parcels = old; }
}

function pickBestVariantUnderDmax(variants, targetDraft) {
  if (!variants || !Number.isFinite(targetDraft) || targetDraft <= 0) return null;
  const eps = 1e-3;
  let best = null;
  for (const [key, entry] of Object.entries(variants)) {
    const res = entry?.res;
    if (!res || !Array.isArray(res.allocations)) continue;
    const h = computeHydroForResult(res);
    const maxT = maxDraftOf(h);
    if (!(Number.isFinite(maxT) && maxT <= targetDraft + eps)) continue;
    const cw = cargoWeightMT(res);
    const bw = ballastWeightMT(res);
    if (!best || cw > best.cargo_mt + 1e-9 || (Math.abs(cw - best.cargo_mt) <= 1e-9 && bw < best.ballast_mt - 1e-6)) {
      best = { key, entry, res, hydro: h, max_draft: maxT, cargo_mt: cw, ballast_mt: bw };
    }
  }
  return best;
}

function solveFillRemainingForTargetDmax(targetDraft) {
  try {
    if (!Number.isFinite(targetDraft) || targetDraft <= 0) return null;
    if (!Array.isArray(tanks) || tanks.length === 0) return null;
    if (!Array.isArray(parcels) || parcels.length === 0) return null;
    if (!HYDRO_ROWS || HYDRO_ROWS.length === 0) return null;

    const frIdx = parcels.findIndex(p => !!p.fill_remaining);
    if (frIdx < 0) return null;
    const baseParcels = cloneParcels(parcels);
    // Upper bound: total cargo Cmax across included tanks
    const capM3 = (tanks || [])
      .filter(t => t && (t.included !== false))
      .reduce((s, t) => s + (Number(t.volume_m3) || 0) * (Number(t.max_pct) || 0), 0);
    let lo = 0;
    let hi = Number.isFinite(capM3) && capM3 > 0 ? capM3 : Math.max(0, Number(baseParcels[frIdx]?.total_m3) || 0);
    if (!(hi > 0)) hi = Math.max(1, Number(baseParcels[frIdx]?.total_m3) || 1);

    let best = null;
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      const testParcels = cloneParcels(baseParcels);
      testParcels[frIdx] = { ...testParcels[frIdx], total_m3: mid };
      const variants = computeVariantsForParcels(testParcels);
      const pick = pickBestVariantUnderDmax(variants, targetDraft);
      if (pick) {
        best = { ...pick, fr_volume_m3: mid };
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return best;
  } catch { return null; }
}
