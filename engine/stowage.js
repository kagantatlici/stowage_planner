// Tanker Stowage Planner — ITCP core and distribution engine
// Framework-agnostic, pure ESM module.

/**
 * @typedef {Object} Tank
 * @property {string} id
 * @property {number} volume_m3
 * @property {number} min_pct // 0..1
 * @property {number} max_pct // 0..1
 * @property {boolean} included
 * @property {'port'|'starboard'|'center'} side
 */

/**
 * @typedef {Object} Parcel
 * @property {string} id
 * @property {string} name
 * @property {number=} total_m3
 * @property {boolean=} fill_remaining
 * @property {number} density_kg_m3
 * @property {number} temperature_c
 * @property {string=} color
 */

/**
 * @typedef {Object} Allocation
 * @property {string} tank_id
 * @property {string} parcel_id
 * @property {number} assigned_m3
 * @property {number} fill_pct // 0..1
 * @property {number} weight_mt
 */

/**
 * @typedef {Object} TraceEntry
 * @property {string} parcel_id
 * @property {number} V
 * @property {number} Cmin
 * @property {number} Cmax
 * @property {number} k_low
 * @property {number} k_high
 * @property {number} chosen_k
 * @property {('none'|'+1'|'odd_with_center'|'infeasible')} parity_adjustment
 * @property {number} per_tank_v
 * @property {boolean} violates
 * @property {string[]} reserved_pairs
 * @property {string} reason
 */

/**
 * @typedef {Object} PlanDiagnostics
 * @property {number} port_weight_mt
 * @property {number} starboard_weight_mt
 * @property {('Balanced'|'Warning')} balance_status
 * @property {number} imbalance_pct // 0..100
 * @property {TraceEntry[]} reasoning_trace
 * @property {string[]} warnings
 * @property {string[]=} errors
 */

/**
 * Parse numeric pair index from tank id like COT2P, COT10S, COT3C
 * @param {string} id
 * @returns {number|null}
 */
export function parsePairIndex(id) {
  const m = /COT(\d+)/i.exec(id);
  if (m) return parseInt(m[1], 10);
  // Treat SLOPP/SLOPS as a symmetric pair with a synthetic index
  if (/^SLOPP$/i.test(id) || /^SLOPS$/i.test(id)) return 1000;
  return null;
}

/**
 * Compute middle-out ordering of pair indices.
 * For N=4 => [2,3,1,4]; N=5 => [3,2,4,1,5]
 * @param {number[]} pairIndices sorted ascending
 * @returns {number[]}
 */
export function middleOutOrder(pairIndices) {
  if (pairIndices.length === 0) return [];
  const sorted = [...pairIndices].sort((a, b) => a - b);
  const N = sorted.length;
  if (N === 1) return sorted;
  const result = [];
  if (N % 2 === 0) {
    const left = N / 2 - 1; // zero-based index
    const right = N / 2; // zero-based index
    let i = left;
    let j = right;
    while (i >= 0 || j < N) {
      if (i >= 0) result.push(sorted[i--]);
      if (j < N) result.push(sorted[j++]);
    }
  } else {
    const mid = Math.floor(N / 2);
    result.push(sorted[mid]);
    for (let offset = 1; offset <= mid; offset++) {
      const left = mid - offset;
      const right = mid + offset;
      if (left >= 0) result.push(sorted[left]);
      if (right < N) result.push(sorted[right]);
    }
  }
  return result;
}

/**
 * Group tanks by pair index and side, also collect centers.
 * Only included tanks are considered.
 */
function groupTanks(tanks) {
  /** @type {Record<number, {port: Tank|null, starboard: Tank|null}>} */
  const pairs = {};
  /** @type {Tank[]} */
  const centers = [];
  const included = tanks.filter(t => t.included);
  for (const t of included) {
    if (t.side === 'center') {
      centers.push(t);
      continue;
    }
    const idx = parsePairIndex(t.id);
    if (idx == null) continue; // skip if unparsable
    if (!pairs[idx]) pairs[idx] = { port: null, starboard: null };
    if (t.side === 'port') pairs[idx].port = t;
    if (t.side === 'starboard') pairs[idx].starboard = t;
  }
  return { pairs, centers, included };
}

/**
 * Compute reference tank limits from the first included tank.
 */
function refLimits(tanks) {
  const first = tanks.find(t => t.included);
  if (!first) return { T: 0, Cmin: 0, Cmax: 0 };
  const T = first.volume_m3;
  return { T, Cmin: T * first.min_pct, Cmax: T * first.max_pct };
}

/**
 * Compute k range and choose k according to rules.
 * @returns {{k_low:number,k_high:number, chosen_k:number|null, parity_adjustment: TraceEntry['parity_adjustment'], reason:string}}
 */
function chooseK_uniform(V, Cmin, Cmax, availablePairsCount, availableCentersCount) {
  const k_low = Math.ceil(V / Cmax);
  const k_high = Math.floor(V / Cmin);
  let parity_adjustment = 'none';
  let chosen_k = null;
  let reason = 'min k & P/S symmetry';
  if (k_low > k_high) {
    return { k_low, k_high, chosen_k: null, parity_adjustment: 'infeasible', reason: 'K empty: infeasible with given limits' };
  }
  // Try smallest even k in [k_low..k_high]
  for (let k = k_low; k <= k_high; k++) {
    const isEven = k % 2 === 0;
    if (isEven) {
      const needPairs = k / 2;
      if (needPairs <= availablePairsCount) {
        chosen_k = k;
        parity_adjustment = 'none';
        break;
      } else {
        // not enough pairs, try next k
      }
    }
  }
  if (chosen_k == null) {
    // Consider odd k if center exists
    if (availableCentersCount > 0) {
      for (let k = k_low; k <= k_high; k++) {
        if (k % 2 === 1) {
          const needPairs = (k - 1) / 2;
          if (needPairs <= availablePairsCount) {
            chosen_k = k;
            parity_adjustment = 'odd_with_center';
            reason = 'odd k allowed using center tank';
            break;
          }
        }
      }
    }
  }
  if (chosen_k == null) {
    // Try to adjust up by +1 if that helps reach an even k within range
    for (let k = k_low; k <= k_high; k++) {
      const k2 = k + (k % 2);
      if (k2 <= k_high && k2 % 2 === 0) {
        const needPairs = k2 / 2;
        if (needPairs <= availablePairsCount) {
          chosen_k = k2;
          parity_adjustment = '+1';
          reason = 'parity adjustment to satisfy P/S pair symmetry';
          break;
        }
      }
    }
  }
  return { k_low, k_high, chosen_k, parity_adjustment, reason };
}

/**
 * Non-uniform ITCP chooser using cumulative pair min/max and optional center.
 * Follows "middle-out" ordered pair indices. Prefers smallest even k, then odd if a center exists.
 * Returns reserved pair indices and optional center selection.
 */
function chooseK_nonuniform(V, orderedPairs, pairs, freeCenters, mode = 'min_k', opts = undefined) {
  const bandAllowed = !!(opts && typeof opts.bandMinPct === 'number' && (opts.bandSlotsLeft || 0) > 0);
  const bandMinPct = opts?.bandMinPct ?? 0.5;
  // Precompute pair min/max arrays and also for k_low/k_high bounds
  const pairStats = orderedPairs.map(idx => {
    const pr = pairs[idx];
    return {
      idx,
      min: pr.port.volume_m3 * pr.port.min_pct + pr.starboard.volume_m3 * pr.starboard.min_pct,
      max: pr.port.volume_m3 * pr.port.max_pct + pr.starboard.volume_m3 * pr.starboard.max_pct
    };
  });
  // Bounds for k_low: minimal p such that sum of top-p max >= V
  const byMaxDesc = [...pairStats].sort((a,b)=>b.max - a.max);
  let k_low = 0;
  let accMax = 0;
  for (let p = 1; p <= byMaxDesc.length; p++) {
    accMax += byMaxDesc[p-1].max;
    if (accMax + 1e-9 >= V) { k_low = 2 * p; break; }
  }
  // Consider odd with center for k_low as well
  const sortedCenters = [...freeCenters].sort((a,b)=>a.id.localeCompare(b.id));
  if (k_low === 0 && sortedCenters.length > 0) {
    const cmax = sortedCenters[0].volume_m3 * sortedCenters[0].max_pct; // best-case first center
    accMax = 0;
    if (cmax + 1e-9 >= V) k_low = 1; // center alone
    else {
      for (let p = 1; p <= byMaxDesc.length; p++) {
        accMax += byMaxDesc[p-1].max;
        if (accMax + cmax + 1e-9 >= V) { k_low = 2 * p + 1; break; }
      }
    }
  }
  // Bounds for k_high: largest p such that V >= sum of smallest-p mins
  const byMinAsc = [...pairStats].sort((a,b)=>a.min - b.min);
  let k_high = 0;
  let accMin = 0;
  for (let p = 1; p <= byMinAsc.length; p++) {
    accMin += byMinAsc[p-1].min;
    if (V + 1e-9 >= accMin) k_high = 2 * p; else break;
  }
  // Consider odd with center for k_high
  for (const c of sortedCenters) {
    const cmin = c.volume_m3 * c.min_pct;
    accMin = cmin;
    if (V + 1e-9 >= accMin) k_high = Math.max(k_high, 1);
    for (let p = 1; p <= byMinAsc.length; p++) {
      accMin += byMinAsc[p-1].min;
      if (V + 1e-9 >= accMin) k_high = Math.max(k_high, 2 * p + 1); else break;
    }
  }

  // Helper: generate lexicographic combinations by index positions in orderedPairs
  function* combos(n, k, start = 0, prefix = []) {
    if (k === 0) { yield prefix; return; }
    for (let i = start; i <= n - k; i++) {
      yield* combos(n, k - 1, i + 1, prefix.concat(i));
    }
  }
  const n = orderedPairs.length;
  // Try even k: choose subset that minimizes locked capacity (sum Cmax of chosen subset)
  let globalBest = null; // track across all p if mode==='min_locked_global'
  const feasibles = [];   // collect all feasible candidates for 'max_k'
  // Precompute F/A normalization parameters once
  const allIdxs = [...orderedPairs];
  const cotIdxs = allIdxs.filter(i => i < 1000);
  const minCot = cotIdxs.length ? Math.min(...cotIdxs) : 0;
  const maxCot = cotIdxs.length ? Math.max(...cotIdxs) : 0;
  const normIdx = (i) => (i >= 1000 ? maxCot + 1 : i);
  const midIdx = (minCot + (maxCot + 1)) / 2;

  for (let p = 1; p <= n; p++) {
    let best = null; // {sCmax, pickedPositions, pickedIdxs, score}
    for (const idxs of combos(n, p)) {
      let sMin = 0, sMax = 0, sCmax = 0, maxReduction = 0;
      const pickedIdxs = [];
      let fwdCap = 0, aftCap = 0;
      let idxSetNorm = [];
      for (const pos of idxs) {
        const idx = orderedPairs[pos];
        const pr = pairs[idx];
        const minSum = pr.port.volume_m3 * pr.port.min_pct + pr.starboard.volume_m3 * pr.starboard.min_pct;
        const maxSum = pr.port.volume_m3 * pr.port.max_pct + pr.starboard.volume_m3 * pr.starboard.max_pct;
        sMin += minSum;
        sMax += maxSum;
        sCmax += maxSum;
        const ni = normIdx(idx);
        idxSetNorm.push(ni);
        if (ni < midIdx) fwdCap += maxSum; else if (ni > midIdx) aftCap += maxSum; // center-equivalent ignored
        if (bandAllowed) {
          const redP = pr.port.volume_m3 * (pr.port.min_pct - bandMinPct);
          const redS = pr.starboard.volume_m3 * (pr.starboard.min_pct - bandMinPct);
          maxReduction = Math.max(maxReduction, redP, redS, 0);
        }
        pickedIdxs.push(idx);
      }
      const okNoBand = (V + 1e-9 >= sMin) && (V <= sMax + 1e-9);
      const okWithBand = bandAllowed && (V + 1e-9 >= (sMin - maxReduction)) && (V <= sMax + 1e-9);
      if (okNoBand || okWithBand) {
        // Hard rule: forbid contiguous midship-only blocks when extreme big pairs are idle (exclude SLOPs)
        if (isMidOnlyContiguousBlock(pickedIdxs, minCot, maxCot)) {
          continue;
        }
        // dispersion metrics
        idxSetNorm.sort((a,b)=>a-b);
        let maxRun = 0; let run = 0; let prev = null;
        for (const v of idxSetNorm) { if (prev==null || v!==prev+1) run=1; else run++; maxRun = Math.max(maxRun, run); prev=v; }
        const span = idxSetNorm.length ? (idxSetNorm[idxSetNorm.length-1] - idxSetNorm[0]) : 0;
        const usesSlop = pickedIdxs.some(i => i >= 1000) ? 1 : 0;
        const balDiff = Math.abs(fwdCap - aftCap);
        const score = [
          balDiff,        // lower is better
          maxRun,         // lower is better (avoid contiguous blocks)
          -span,          // higher span preferred
          -usesSlop,      // prefer using slop (treat as stern-extender)
          sCmax           // lower locked capacity remains a tie-breaker
        ];
        if (!best || scoreLess(score, best.score) || (eqScore(score, best.score) && idxs.join(',') < best.pickedPositions.join(','))) {
          best = { sCmax, pickedPositions: idxs, pickedIdxs, score };
        }
      }
    }
    if (best) {
      feasibles.push({ chosen_k: 2 * p, reservedPairs: best.pickedIdxs, center: null, sCmax: best.sCmax });
      if (mode === 'min_k') {
        return { chosen_k: 2 * p, reservedPairs: best.pickedIdxs, center: null, k_low, k_high, parity_adjustment: 'none', reason: 'non-uniform: balanced dispersion subset' };
      }
      const cand = { chosen_k: 2 * p, reservedPairs: best.pickedIdxs, center: null, k_low, k_high, parity_adjustment: 'none', reason: 'non-uniform: minimal locked capacity subset', sCmax: best.sCmax };
      if (!globalBest || cand.sCmax < globalBest.sCmax || (Math.abs(cand.sCmax - globalBest.sCmax) < 1e-9 && cand.chosen_k < globalBest.chosen_k)) {
        globalBest = cand;
      }
    }
  }
  // Try odd with centers
  if (sortedCenters.length > 0) {
    // consider center alone
    for (const c of sortedCenters) {
      const cmin = c.volume_m3 * c.min_pct;
      const cmax = c.volume_m3 * c.max_pct;
      const redC = bandAllowed ? Math.max(0, c.volume_m3 * (c.min_pct - bandMinPct)) : 0;
      if ((V + 1e-9 >= cmin && V <= cmax + 1e-9) || (bandAllowed && V + 1e-9 >= (cmin - redC) && V <= cmax + 1e-9)) {
        const cand = { chosen_k: 1, reservedPairs: [], center: c, k_low, k_high, parity_adjustment: 'odd_with_center', reason: 'non-uniform: feasible with center only', sCmax: cmax };
        feasibles.push(cand);
        if (mode === 'min_k') return cand;
        if (!globalBest || cand.sCmax < globalBest.sCmax || (Math.abs(cand.sCmax - globalBest.sCmax) < 1e-9 && cand.chosen_k < globalBest.chosen_k)) globalBest = cand;
      }
    }
    for (const c of sortedCenters) {
      const cmin = c.volume_m3 * c.min_pct;
      const cmax = c.volume_m3 * c.max_pct;
      for (let p = 1; p <= n; p++) {
        let best = null; // {sCmax, pickedPositions, pickedIdxs, score}
        for (const idxs of combos(n, p)) {
          let sMin = cmin, sMax = cmax, sCmax = cmax, maxReduction = bandAllowed ? Math.max(0, c.volume_m3 * (c.min_pct - bandMinPct)) : 0;
          const pickedIdxs = [];
          let fwdCap = 0, aftCap = 0;
          let idxSetNorm = [];
          for (const pos of idxs) {
            const idx = orderedPairs[pos];
            const pr = pairs[idx];
            const minSum = pr.port.volume_m3 * pr.port.min_pct + pr.starboard.volume_m3 * pr.starboard.min_pct;
            const maxSum = pr.port.volume_m3 * pr.port.max_pct + pr.starboard.volume_m3 * pr.starboard.max_pct;
            sMin += minSum;
            sMax += maxSum;
            sCmax += maxSum;
            const ni = normIdx(idx);
            idxSetNorm.push(ni);
            if (ni < midIdx) fwdCap += maxSum; else if (ni > midIdx) aftCap += maxSum;
            if (bandAllowed) {
              const redP = pr.port.volume_m3 * (pr.port.min_pct - bandMinPct);
              const redS = pr.starboard.volume_m3 * (pr.starboard.min_pct - bandMinPct);
              maxReduction = Math.max(maxReduction, redP, redS, 0);
            }
            pickedIdxs.push(idx);
          }
          const okNoBand = (V + 1e-9 >= sMin) && (V <= sMax + 1e-9);
          const okWithBand = bandAllowed && (V + 1e-9 >= (sMin - maxReduction)) && (V <= sMax + 1e-9);
          if (okNoBand || okWithBand) {
            if (isMidOnlyContiguousBlock(pickedIdxs, minCot, maxCot)) {
              continue;
            }
            idxSetNorm.sort((a,b)=>a-b);
            let maxRun = 0; let run = 0; let prev = null;
            for (const v of idxSetNorm) { if (prev==null || v!==prev+1) run=1; else run++; maxRun = Math.max(maxRun, run); prev=v; }
            const span = idxSetNorm.length ? (idxSetNorm[idxSetNorm.length-1] - idxSetNorm[0]) : 0;
            const usesSlop = pickedIdxs.some(i => i >= 1000) ? 1 : 0;
            const balDiff = Math.abs(fwdCap - aftCap);
            const score = [ balDiff, maxRun, -span, -usesSlop, sCmax ];
            if (!best || scoreLess(score, best.score) || (eqScore(score, best.score) && idxs.join(',') < best.pickedPositions.join(','))) {
              best = { sCmax, pickedPositions: idxs, pickedIdxs, score };
            }
          }
        }
        if (best) {
          feasibles.push({ chosen_k: 2 * p + 1, reservedPairs: best.pickedIdxs, center: c, sCmax: best.sCmax });
          if (mode === 'min_k') {
            return { chosen_k: 2 * p + 1, reservedPairs: best.pickedIdxs, center: c, k_low, k_high, parity_adjustment: 'odd_with_center', reason: 'non-uniform: balanced dispersion subset (with center)' };
          }
          const cand = { chosen_k: 2 * p + 1, reservedPairs: best.pickedIdxs, center: c, k_low, k_high, parity_adjustment: 'odd_with_center', reason: 'non-uniform: minimal locked capacity subset (with center)', sCmax: best.sCmax };
          if (!globalBest || cand.sCmax < globalBest.sCmax || (Math.abs(cand.sCmax - globalBest.sCmax) < 1e-9 && cand.chosen_k < globalBest.chosen_k)) {
            globalBest = cand;
          }
        }
      }
    }
  }
  if (mode === 'max_k' && feasibles.length > 0) {
    // choose candidate with largest chosen_k; tie-breaker: minimal sCmax
    feasibles.sort((a,b) => (b.chosen_k - a.chosen_k) || (a.sCmax - b.sCmax));
    const top = feasibles[0];
    return { chosen_k: top.chosen_k, reservedPairs: top.reservedPairs, center: top.center || null, k_low, k_high, parity_adjustment: 'none', reason: 'non-uniform: maximum k (spread across more tanks)' };
  }
  if (globalBest) {
    const { sCmax, ...rest } = globalBest;
    return rest;
  }
  return { chosen_k: null, reservedPairs: [], center: null, k_low, k_high, parity_adjustment: 'infeasible', reason: 'no feasible k with current non-uniform capacities' };
}

// Helper tuple comparators for internal scoring
function scoreLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}
function eqScore(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}

// Return true if picked pair indices form a contiguous block strictly inside [minCot..maxCot]
// i.e., no gap between min(selected)..max(selected), and neither extreme (minCot or maxCot) is selected.
function isMidOnlyContiguousBlock(pickedIdxs, minCot, maxCot) {
  const cot = pickedIdxs.filter(i => i < 1000);
  if (cot.length === 0) return false;
  const set = new Set(cot);
  const minSel = Math.min(...cot);
  const maxSel = Math.max(...cot);
  // contiguous?
  for (let i = minSel; i <= maxSel; i++) {
    if (!set.has(i)) return false;
  }
  // strictly inside extremes?
  if (minSel > minCot && maxSel < maxCot) return true;
  return false;
}

/**
 * Build allocations and diagnostics given tanks and parcels.
 * Deterministic selection of pairs and center per middle-out order and lexicographic tank id ties.
 *
 * @param {Tank[]} tanks
 * @param {Parcel[]} parcels
 * @returns {{ allocations: Allocation[], diagnostics: PlanDiagnostics }}
 */
function computePlanInternal(tanks, parcels, mode = 'min_k', policy = {}) {
  const { pairs, centers, included } = groupTanks(tanks);
  const { Cmin: CminRef, Cmax: CmaxRef } = refLimits(included);

  /** @type {Allocation[]} */
  const allocations = [];
  /** @type {TraceEntry[]} */
  const reasoning_trace = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const errors = [];

  // Global options (user-approved)
  const bandEnabled = true;
  const bandMinPct = 0.45; // 45%
  let bandSlotsLeft = 1;   // at most 1 tank across entire plan
  /** @type {Set<string>} */
  const bandUsedTankIds = new Set();
  const bufferEnabled = true;
  const bufferSmallThreshold = 1200; // m3
  const bufferPairsCount = 1; // reserve 1 smallest pair for small parcels
  const aggressiveSingleWing = !!policy.aggressiveSingleWing;
  const preferWingEvenIfCenter = !!policy.preferWingEvenIfCenter;
  const hardReserveSlopsSmall = !!policy.hardReserveSlopsSmall;

  // --- Early fallback: fixed over-capacity (no FR) → fill all available capacity and mark short loading
  try {
    const fixedOnly = parcels.filter(p => !p.fill_remaining);
    const hasFR = parcels.some(p => !!p.fill_remaining);
    if (!hasFR && fixedOnly.length === 1) {
      const p0 = fixedOnly[0];
      const Vreq = Number(p0.total_m3) || 0;
      const capMaxAll = included.reduce((s,t)=> s + (t.volume_m3 * (t.max_pct||0)), 0);
      if (Vreq > capMaxAll + 1e-9) {
        // Allocate every included tank at max%
        for (const t of included) {
          const vmax = t.volume_m3 * (t.max_pct || 0);
          if (vmax > 0) addAllocation(t, p0, vmax);
        }
        warnings.push(`${p0.name || p0.id}: requested ${Vreq.toFixed(1)} m³ exceeds available capacity ${capMaxAll.toFixed(1)} m³ — filled all available (short loading).`);
        // Diagnostics: weights and balance
        let port_weight_mt = 0; let starboard_weight_mt = 0;
        for (const a of allocations) {
          const tank = included.find(t => t.id === a.tank_id);
          if (!tank) continue;
          if (tank.side === 'port') port_weight_mt += a.weight_mt;
          if (tank.side === 'starboard') starboard_weight_mt += a.weight_mt;
        }
        // Validate per-tank min/max and record warnings
        for (const a of allocations) {
          const tank = included.find(t => t.id === a.tank_id);
          if (!tank) continue;
          const minV = tank.volume_m3 * tank.min_pct - 1e-6;
          const maxV = tank.volume_m3 * tank.max_pct + 1e-6;
          if (a.assigned_m3 < minV) warnings.push(`Tank ${a.tank_id}: below min (${a.assigned_m3.toFixed(1)} < ${(tank.volume_m3*tank.min_pct).toFixed(1)})`);
          if (a.assigned_m3 > maxV) warnings.push(`Tank ${a.tank_id}: above max (${a.assigned_m3.toFixed(1)} > ${(tank.volume_m3*tank.max_pct).toFixed(1)})`);
        }
        const denom = port_weight_mt + starboard_weight_mt;
        const imbalance_pct = denom > 0 ? (Math.abs(port_weight_mt - starboard_weight_mt) / denom) * 100 : 0;
        const balance_status = imbalance_pct <= 10 ? 'Balanced' : 'Warning';
        const diagnostics = {
          port_weight_mt,
          starboard_weight_mt,
          balance_status,
          imbalance_pct,
          reasoning_trace: [{ parcel_id: p0.id, V: Vreq, Cmin: CminRef, Cmax: CmaxRef, k_low: 0, k_high: 0, chosen_k: 0, parity_adjustment: 'none', per_tank_v: 0, violates: false, reserved_pairs: ['ALL@MAX'], reason: 'fixed over-capacity: filled all available (short)' }],
          warnings,
          errors
        };
        return { allocations, diagnostics };
      }
    }
  } catch {}

  // Identify SLOP pair index and capacity (synthetic pair index 1000)
  const slopIdx = 1000;
  const hasSlops = !!(pairs[slopIdx] && pairs[slopIdx].port && pairs[slopIdx].starboard);
  const slopsCmax = hasSlops ? (pairs[slopIdx].port.volume_m3 * pairs[slopIdx].port.max_pct + pairs[slopIdx].starboard.volume_m3 * pairs[slopIdx].starboard.max_pct) : 0;

  // Partition parcels: fixed first (sort deterministically), then remaining
  const fixed = parcels.filter(p => !p.fill_remaining);
  const remaining = parcels.find(p => p.fill_remaining);

  // Freeze deterministic ordering: order fixed parcels independent of input order
  // Priority: tightness (ceil(V/Cmax)) desc, then volume desc, then density desc,
  // final tie-breaker by a stable content key (ignoring id/name)
  const fixedSorted = [...fixed].sort((a, b) => {
    const aV = a.total_m3 ?? 0;
    const bV = b.total_m3 ?? 0;
    const aT = Math.ceil(aV / (CmaxRef || 1));
    const bT = Math.ceil(bV / (CmaxRef || 1));
    if (bT !== aT) return bT - aT;
    if (bV !== aV) return bV - aV;
    const aR = a.density_kg_m3 ?? 0;
    const bR = b.density_kg_m3 ?? 0;
    if (bR !== aR) return bR - aR;
    const aKey = JSON.stringify({ v: aV, rho: aR, rem: !!a.fill_remaining, t: a.temperature_c ?? 0 });
    const bKey = JSON.stringify({ v: bV, rho: bR, rem: !!b.fill_remaining, t: b.temperature_c ?? 0 });
    return aKey.localeCompare(bKey);
  });

  // Optionally reserve SLOPs for the smallest parcel that can fully fit in SLOPs
  let reservedSlopsForParcelId = null;
  if (hardReserveSlopsSmall && hasSlops) {
    const eligible = fixedSorted.filter(p => (p.total_m3 ?? 0) > 0 && (p.total_m3 ?? 0) <= slopsCmax);
    if (eligible.length > 0) {
      reservedSlopsForParcelId = eligible.reduce((minP, p) => ((p.total_m3 ?? 0) < (minP.total_m3 ?? 0) ? p : minP), eligible[0]).id;
    }
  }

  // Determine available pair indices and order
  const pairIndices = Object.keys(pairs).map(n => parseInt(n, 10)).filter(n => !!pairs[n]);
  const orderedPairs = middleOutOrder(pairIndices);

  // Small-tank buffer: reserve smallest pairs up-front if small parcels exist
  const hasSmall = fixed.some(p => (p.total_m3 ?? 0) > 0 && (p.total_m3 ?? 0) <= bufferSmallThreshold);
  /** @type {Set<number>} */
  const bufferPairs = new Set();
  if (bufferEnabled && hasSmall && bufferPairsCount > 0) {
    const pairWithVol = orderedPairs.map(idx => {
      const pr = pairs[idx];
      const vol = (pr.port?.volume_m3 || 0) + (pr.starboard?.volume_m3 || 0);
      return { idx, vol };
    }).sort((a,b)=>a.vol - b.vol);
    for (let i = 0; i < Math.min(bufferPairsCount, pairWithVol.length); i++) bufferPairs.add(pairWithVol[i].idx);
    // Hide buffer reservation details from user to reduce noise
  }

  /** reservation state */
  /** @type {Set<number>} */
  const usedPairs = new Set();
  /** @type {Set<string>} */
  const usedCenters = new Set();

  // Utility to fetch available pairs in order
  function getFreePairs() {
    const out = [];
    for (const idx of orderedPairs) {
      const pair = pairs[idx];
      if (!pair) continue;
      if (pair.port && pair.starboard && !usedPairs.has(idx)) out.push(idx);
    }
    return out;
  }

  // Assign helper
  function addAllocation(tank, parcel, vol) {
    const fill_pct = vol / tank.volume_m3;
    const weight_mt = (vol * parcel.density_kg_m3) / 1000.0;
    allocations.push({ tank_id: tank.id, parcel_id: parcel.id, assigned_m3: vol, fill_pct, weight_mt });
  }

  // Fixed parcels ITCP selection and assignment
  for (const p of fixedSorted) {
    const V = p.total_m3 ?? 0;
    let freePairsAll = getFreePairs();
    const freeCenters = centers.filter(c => !usedCenters.has(c.id));
    const isSmallParcel = V > 0 && V <= bufferSmallThreshold;
    // Keep SLOPs protected for the designated small parcel
    if (reservedSlopsForParcelId && p.id !== reservedSlopsForParcelId) {
      freePairsAll = freePairsAll.filter(idx => idx !== slopIdx);
    }
    const freePairsNoBuffer = freePairsAll.filter(idx => !bufferPairs.has(idx));
    // Non-uniform selection with buffer preference and band awareness, unless forced selection is provided
    const forcedSel = policy.forcedSelection && policy.forcedSelection[p.id];
    let selection = forcedSel
      ? { chosen_k: (forcedSel.center ? forcedSel.reservedPairs.length * 2 + 1 : forcedSel.reservedPairs.length * 2), reservedPairs: forcedSel.reservedPairs, center: forcedSel.center ? freeCenters.find(c=>c.id===forcedSel.center) || null : null, k_low: 0, k_high: 0, parity_adjustment: 'none', reason: 'forced selection' }
      : chooseK_nonuniform(V, isSmallParcel ? freePairsAll : freePairsNoBuffer, pairs, freeCenters, mode, { bandMinPct, bandSlotsLeft });
    let releasedBuffer = false;
    if ((!selection.chosen_k || selection.chosen_k === null) && !isSmallParcel && bufferPairs.size > 0) {
      const tryPairs = reservedSlopsForParcelId && p.id !== reservedSlopsForParcelId ? freePairsAll.filter(idx => idx !== slopIdx) : freePairsAll;
      selection = chooseK_nonuniform(V, tryPairs, pairs, freeCenters, mode, { bandMinPct, bandSlotsLeft });
      if (selection.chosen_k) {
        releasedBuffer = true;
        warnings.push(`Used reserved small-tank capacity to make ${p.name || p.id} fit.`);
      }
    }
    const { k_low, k_high, chosen_k, parity_adjustment, reason } = selection;

    /** @type {TraceEntry} */
    const traceEntry = {
      parcel_id: p.id,
      V,
      Cmin: CminRef,
      Cmax: CmaxRef,
      k_low,
      k_high,
      chosen_k: chosen_k ?? 0,
      parity_adjustment: chosen_k == null ? 'infeasible' : parity_adjustment,
      per_tank_v: chosen_k ? V / chosen_k : 0,
      violates: false,
      reserved_pairs: [],
      reason
    };

    // H1 preference: if objective is min_k and parcel is larger than the small-threshold,
    // prefer a single-wing load (with ballast advisory) when it reduces tank count
    if (!forcedSel && mode === 'min_k' && (((p.total_m3 ?? 0) > bufferSmallThreshold) || aggressiveSingleWing) && (selection.chosen_k ?? 0) >= 2) {
      const usedTankIdsPref = new Set(allocations.map(a => a.tank_id));
      const singlePref = included
        .filter(t => t.included && t.side !== 'center' && !usedTankIdsPref.has(t.id))
        .map(t => {
          const minV = t.volume_m3 * t.min_pct;
          const maxV = t.volume_m3 * t.max_pct;
          const bandMinV = t.volume_m3 * (typeof bandMinPct === 'number' ? bandMinPct : t.min_pct);
          const fitsStrict = V + 1e-9 >= minV && V <= maxV + 1e-9;
          const fitsWithBand = (V + 1e-9 >= bandMinV && V <= maxV + 1e-9);
          return { t, minV, maxV, fitsStrict, fitsWithBand };
        })
        .filter(x => x.fitsStrict || (x.fitsWithBand && bandEnabled && bandSlotsLeft > 0))
        .sort((a, b) => {
          const aC = a.t.volume_m3 * a.t.max_pct;
          const bC = b.t.volume_m3 * b.t.max_pct;
          if (aC !== bC) return aC - bC; // prefer smallest capacity
          return a.t.id.localeCompare(b.t.id);
        });
      if (singlePref.length > 0) {
        const cand = singlePref[0];
        const t = cand.t;
        addAllocation(t, p, V);
        const idx = parsePairIndex(t.id);
        if (idx != null) usedPairs.add(idx);
        /** @type {TraceEntry} */
        const tr = {
          parcel_id: p.id,
          V,
          Cmin: CminRef,
          Cmax: CmaxRef,
          k_low,
          k_high,
          chosen_k: 1,
          parity_adjustment: 'none',
          per_tank_v: V,
          violates: false,
          reserved_pairs: [t.id],
          reason: (reason ? reason + '; ' : '') + 'single-wing allocation (min tanks) with ballast advisory'
        };
        if (!cand.fitsStrict && cand.fitsWithBand && bandEnabled && bandSlotsLeft > 0) {
          bandSlotsLeft -= 1;
          bandUsedTankIds.add(t.id);
          warnings.push(`Allowed underfill on ${t.id} (${(V / t.volume_m3 * 100).toFixed(1)}%) to fit ${p.name || p.id}.`);
          tr.reason += `; underfill band used on ${t.id}`;
        }
        warnings.push(`Single-wing load on ${t.id}. Expect list; ballast the opposite side to correct.`);
        reasoning_trace.push(tr);
        continue;
      }
    }

    // Wing alternative even if center exists (for offering single-wing option)
    if (!forcedSel && preferWingEvenIfCenter && (selection.chosen_k ?? 0) === 1 && selection.center) {
      const usedTankIdsPref = new Set(allocations.map(a => a.tank_id));
      const singlePref2 = included
        .filter(t => t.included && t.side !== 'center' && !usedTankIdsPref.has(t.id))
        .map(t => {
          const minV = t.volume_m3 * t.min_pct;
          const maxV = t.volume_m3 * t.max_pct;
          const bandMinV = t.volume_m3 * (typeof bandMinPct === 'number' ? bandMinPct : t.min_pct);
          const fitsStrict = V + 1e-9 >= minV && V <= maxV + 1e-9;
          const fitsWithBand = (V + 1e-9 >= bandMinV && V <= maxV + 1e-9);
          return { t, minV, maxV, fitsStrict, fitsWithBand };
        })
        .filter(x => x.fitsStrict || (x.fitsWithBand && bandEnabled && bandSlotsLeft > 0))
        .sort((a, b) => {
          const aC = a.t.volume_m3 * a.t.max_pct;
          const bC = b.t.volume_m3 * b.t.max_pct;
          if (aC !== bC) return aC - bC; // prefer smallest capacity
          return a.t.id.localeCompare(b.t.id);
        });
      if (singlePref2.length > 0) {
        const cand = singlePref2[0];
        const t = cand.t;
        addAllocation(t, p, V);
        const idx = parsePairIndex(t.id);
        if (idx != null) usedPairs.add(idx);
        /** @type {TraceEntry} */
        const tr = {
          parcel_id: p.id,
          V,
          Cmin: CminRef,
          Cmax: CmaxRef,
          k_low,
          k_high,
          chosen_k: 1,
          parity_adjustment: 'none',
          per_tank_v: V,
          violates: false,
          reserved_pairs: [t.id],
          reason: (reason ? reason + '; ' : '') + 'single-wing alternative (ballast advisory)'
        };
        if (!cand.fitsStrict && cand.fitsWithBand && bandEnabled && bandSlotsLeft > 0) {
          bandSlotsLeft -= 1;
          bandUsedTankIds.add(t.id);
          warnings.push(`Allowed underfill on ${t.id} (${(V / t.volume_m3 * 100).toFixed(1)}%) to fit ${p.name || p.id}.`);
          tr.reason += `; underfill band used on ${t.id}`;
        }
        warnings.push(`Single-wing load on ${t.id}. Expect list; ballast the opposite side to correct.`);
        reasoning_trace.push(tr);
        continue;
      }
    }

    if (!forcedSel && !chosen_k) {
      // Fallback: allow a single wing tank (unsymmetrical) if parcel fits per-tank min/max.
      // This introduces list; operator must ballast the opposite side. We emit a clear warning.
      const usedTankIds = new Set(allocations.map(a => a.tank_id));
      const singleCandidates = included
        .filter(t => t.included && t.side !== 'center' && !usedTankIds.has(t.id))
        .map(t => {
          const minV = t.volume_m3 * t.min_pct;
          const maxV = t.volume_m3 * t.max_pct;
          const bandMinV = t.volume_m3 * (typeof bandMinPct === 'number' ? bandMinPct : t.min_pct);
          const fitsStrict = V + 1e-9 >= minV && V <= maxV + 1e-9;
          const fitsWithBand = (V + 1e-9 >= bandMinV && V <= maxV + 1e-9);
          return { t, minV, maxV, fitsStrict, fitsWithBand };
        })
        .filter(x => x.fitsStrict || (x.fitsWithBand && bandEnabled && bandSlotsLeft > 0))
        .sort((a, b) => {
          const aC = a.t.volume_m3 * a.t.max_pct;
          const bC = b.t.volume_m3 * b.t.max_pct;
          if (aC !== bC) return aC - bC; // prefer smallest capacity
          return a.t.id.localeCompare(b.t.id);
        });
      if (singleCandidates.length > 0) {
        const cand = singleCandidates[0];
        const t = cand.t;
        addAllocation(t, p, V);
        const idx = parsePairIndex(t.id);
        if (idx != null) usedPairs.add(idx); // remove pair from future symmetric use
        traceEntry.chosen_k = 1;
        traceEntry.parity_adjustment = 'none';
        traceEntry.reserved_pairs.push(t.id);
        traceEntry.per_tank_v = V;
        traceEntry.reason = (traceEntry.reason ? traceEntry.reason + '; ' : '') + 'single-wing allocation with ballast advisory';
        // If band used, record it and consume the slot
        if (!cand.fitsStrict && cand.fitsWithBand && bandEnabled && bandSlotsLeft > 0) {
          bandSlotsLeft -= 1;
          const pct = (V / t.volume_m3) * 100;
          warnings.push(`Allowed underfill on ${t.id} (${pct.toFixed(1)}%) to fit ${p.name || p.id}.`);
          traceEntry.reason += `; underfill band used on ${t.id}`;
          bandUsedTankIds.add(t.id);
        }
        warnings.push(`Single-wing load on ${t.id}. Expect list; ballast the opposite side to correct.`);
        reasoning_trace.push(traceEntry);
        continue;
      }
      // No single-wing candidate; remain infeasible
      errors.push(`${p.name || p.id}: cannot be placed with current tank limits.`);
      reasoning_trace.push(traceEntry);
      continue;
    }

    const needPairs = chosen_k % 2 === 0 ? chosen_k / 2 : (chosen_k - 1) / 2;
    // Reserve pairs as selected
    const chosenPairIdxs = selection.reservedPairs;
    for (const idx of chosenPairIdxs) {
      usedPairs.add(idx);
      traceEntry.reserved_pairs.push(`COT${idx}P/S`);
    }

    // Reserve center if odd
    let centerTank = null;
    if (chosen_k % 2 === 1) {
      centerTank = selection.center;
      if (!centerTank) {
        errors.push(`Parcel ${p.name || p.id} needs a center tank to keep symmetry, but none is available.`);
        reasoning_trace.push(traceEntry);
        continue;
      }
      usedCenters.add(centerTank.id);
      traceEntry.reserved_pairs.push(`${centerTank.id}`);
    }

    // Assign volumes using water-filling within [min_i,max_i], with optional band
    /** @type {{tank: Tank, min:number, max:number, vol:number}[]} */
    const vessels = [];
    for (const idx of chosenPairIdxs) {
      const pr = pairs[idx];
      vessels.push({ tank: pr.port, min: pr.port.volume_m3 * pr.port.min_pct, max: pr.port.volume_m3 * pr.port.max_pct, vol: 0 });
      vessels.push({ tank: pr.starboard, min: pr.starboard.volume_m3 * pr.starboard.min_pct, max: pr.starboard.volume_m3 * pr.starboard.max_pct, vol: 0 });
    }
    if (centerTank) {
      vessels.push({ tank: centerTank, min: centerTank.volume_m3 * centerTank.min_pct, max: centerTank.volume_m3 * centerTank.max_pct, vol: 0 });
    }
    let sumMin = vessels.reduce((s, e) => s + e.min, 0);
    const sumMax = vessels.reduce((s, e) => s + e.max, 0);
    let bandApplied = false; let bandTankId = null;
    if (V + 1e-9 < sumMin && bandEnabled && bandSlotsLeft > 0) {
      // Try relaxing one tank down to bandMinPct
      let bestReduction = 0; let bestIdx = -1;
      vessels.forEach((e, i) => {
        const bandMinV = e.tank.volume_m3 * bandMinPct;
        const red = Math.max(0, e.min - bandMinV);
        if (red > bestReduction) { bestReduction = red; bestIdx = i; }
      });
      if (bestReduction > 0 && V + 1e-9 >= (sumMin - bestReduction)) {
        const e = vessels[bestIdx];
        e.min = e.tank.volume_m3 * bandMinPct;
        sumMin -= bestReduction;
        bandApplied = true; bandTankId = e.tank.id;
      }
    }
    if (V + 1e-9 < sumMin || V > sumMax + 1e-9) {
      const minMsg = `minimum required = ${sumMin.toFixed(1)} m³`;
      const maxMsg = `maximum allowed = ${sumMax.toFixed(1)} m³`;
      errors.push(`${p.name || p.id}: requested ${V} m³ is outside allowable range [${minMsg}, ${maxMsg}]. Consider adjusting volume or tank limits.`);
      reasoning_trace.push(traceEntry);
      continue;
    }
    // Start at mins
    vessels.forEach(e => { e.vol = e.min; });
    let rem = V - sumMin;
    while (rem > 1e-9) {
      const unsat = vessels.filter(e => e.vol + 1e-9 < e.max);
      if (unsat.length === 0) break;
      const delta = rem / unsat.length;
      let consumed = 0;
      for (const e of unsat) {
        const add = Math.min(delta, e.max - e.vol);
        e.vol += add;
        consumed += add;
      }
      rem -= consumed;
      if (consumed <= 1e-9) break; // guard
    }
    for (const e of vessels) {
      addAllocation(e.tank, p, e.vol);
    }
    if (bandApplied) {
      bandSlotsLeft -= 1;
      const v = vessels.find(v=>v.tank.id===bandTankId);
      warnings.push(`Allowed underfill on ${bandTankId} (${(v.vol / v.tank.volume_m3 * 100).toFixed(1)}%) to fit ${p.name || p.id}.`);
      traceEntry.reason += `; underfill band used on ${bandTankId}`;
      bandUsedTankIds.add(bandTankId);
    }

    traceEntry.per_tank_v = V / chosen_k;
    
    reasoning_trace.push(traceEntry);
  }

  // Remaining parcel distribution
  if (remaining) {
    const Vrem = remaining.total_m3;
    const freePairsAll = getFreePairs();
    const freeCentersList = centers.filter(c => !usedCenters.has(c.id));
    if (Number.isFinite(Vrem)) {
      // If requested remaining volume exceeds total available capacity, fill all available (short load)
      let capSumAll = 0;
      for (const idx of freePairsAll) {
        const pr = pairs[idx];
        capSumAll += pr.port.volume_m3 * pr.port.max_pct + pr.starboard.volume_m3 * pr.starboard.max_pct;
      }
      for (const c of freeCentersList) capSumAll += c.volume_m3 * c.max_pct;
      if (Vrem > capSumAll + 1e-9) {
        // Fill centers at max first, then all pairs at max
        const reserved = [];
        for (const c of freeCentersList) {
          addAllocation(c, remaining, c.volume_m3 * c.max_pct);
          usedCenters.add(c.id);
          reserved.push(c.id);
        }
        for (const idx of freePairsAll) {
          const pr = pairs[idx];
          addAllocation(pr.port, remaining, pr.port.volume_m3 * pr.port.max_pct);
          addAllocation(pr.starboard, remaining, pr.starboard.volume_m3 * pr.starboard.max_pct);
          usedPairs.add(idx);
          reserved.push(`COT${idx}P/S`);
        }
        warnings.push(`${remaining.name || remaining.id}: requested ${Vrem.toFixed(1)} m³ exceeds available capacity ${capSumAll.toFixed(1)} m³ — filled all available (short loading).`);
        reasoning_trace.push({ parcel_id: remaining.id, V: Vrem, Cmin: CminRef, Cmax: CmaxRef, k_low: 0, k_high: 0, chosen_k: 0, parity_adjustment: 'none', per_tank_v: 0, violates: false, reserved_pairs: reserved, reason: 'FR over-capacity: filled all available (short)' });
      } else {
      // Treat FR like a fixed parcel: select subset and water-fill to exactly Vrem
      const isSmallParcel = Vrem > 0 && Vrem <= bufferSmallThreshold;
      const freePairsNoBuffer = freePairsAll.filter(idx => !bufferPairs.has(idx));
      // Honor forced selection policy for remaining parcel if provided
      let selection = null;
      if (policy && policy.forcedSelection && policy.forcedSelection[remaining.id]) {
        const fs = policy.forcedSelection[remaining.id];
        const rp = Array.isArray(fs.reservedPairs) ? fs.reservedPairs.slice() : [];
        const useCenter = fs.center ? (freeCentersList.find(c=>c.id===fs.center) || null) : null;
        selection = { chosen_k: useCenter ? (rp.length * 2 + 1) : (rp.length * 2), reservedPairs: rp, center: useCenter, k_low: 0, k_high: 0, parity_adjustment: 'none', reason: 'forced selection' };
      } else {
        selection = chooseK_nonuniform(Vrem, isSmallParcel ? freePairsAll : freePairsNoBuffer, pairs, freeCentersList, mode, { bandMinPct, bandSlotsLeft });
      }
      if (!selection.chosen_k) {
        // Try releasing buffer if it helps
        selection = chooseK_nonuniform(Vrem, freePairsAll, pairs, freeCentersList, mode, { bandMinPct, bandSlotsLeft });
      }
      const { chosen_k } = selection;
      /** @type {TraceEntry} */
      const traceEntry = {
        parcel_id: remaining.id,
        V: Vrem,
        Cmin: CminRef,
        Cmax: CmaxRef,
        k_low: selection.k_low,
        k_high: selection.k_high,
        chosen_k: chosen_k ?? 0,
        parity_adjustment: chosen_k == null ? 'infeasible' : selection.parity_adjustment,
        per_tank_v: chosen_k ? Vrem / chosen_k : 0,
        violates: false,
        reserved_pairs: [],
        reason: selection.reason || 'FR water-fill'
      };
      if (!chosen_k) {
        errors.push(`${remaining.name || remaining.id}: cannot be placed with current tank limits.`);
        reasoning_trace.push(traceEntry);
      } else {
        const chosenPairIdxs = selection.reservedPairs || [];
        for (const idx of chosenPairIdxs) { usedPairs.add(idx); traceEntry.reserved_pairs.push(`COT${idx}P/S`); }
        let centerTank = null;
        if (chosen_k % 2 === 1) {
          centerTank = selection.center;
          if (!centerTank) { errors.push(`${remaining.name || remaining.id}: needs a center tank but none available.`); reasoning_trace.push(traceEntry); }
          else { usedCenters.add(centerTank.id); traceEntry.reserved_pairs.push(centerTank.id); }
        }
        // Build vessels and water-fill
        /** @type {{tank: Tank, min:number, max:number, vol:number}[]} */
        const vessels = [];
        for (const idx of chosenPairIdxs) {
          const pr = pairs[idx];
          vessels.push({ tank: pr.port, min: pr.port.volume_m3 * pr.port.min_pct, max: pr.port.volume_m3 * pr.port.max_pct, vol: 0 });
          vessels.push({ tank: pr.starboard, min: pr.starboard.volume_m3 * pr.starboard.min_pct, max: pr.starboard.volume_m3 * pr.starboard.max_pct, vol: 0 });
        }
        if (centerTank) {
          vessels.push({ tank: centerTank, min: centerTank.volume_m3 * centerTank.min_pct, max: centerTank.volume_m3 * centerTank.max_pct, vol: 0 });
        }
        let sumMin = vessels.reduce((s, e) => s + e.min, 0);
        const sumMax = vessels.reduce((s, e) => s + e.max, 0);
        let bandApplied = false; let bandTankId = null;
        if (Vrem + 1e-9 < sumMin && bandEnabled && bandSlotsLeft > 0) {
          let bestReduction = 0; let bestIdx = -1;
          vessels.forEach((e, i) => {
            const bandMinV = e.tank.volume_m3 * bandMinPct;
            const red = Math.max(0, e.min - bandMinV);
            if (red > bestReduction) { bestReduction = red; bestIdx = i; }
          });
          if (bestReduction > 0 && Vrem + 1e-9 >= (sumMin - bestReduction)) {
            const e = vessels[bestIdx];
            e.min = e.tank.volume_m3 * bandMinPct;
            sumMin -= bestReduction;
            bandApplied = true; bandTankId = e.tank.id;
          }
        }
        if (Vrem + 1e-9 < sumMin || Vrem > sumMax + 1e-9) {
          const minMsg = `minimum required = ${sumMin.toFixed(1)} m³`;
          const maxMsg = `maximum allowed = ${sumMax.toFixed(1)} m³`;
          errors.push(`${remaining.name || remaining.id}: requested ${Vrem} m³ is outside allowable range [${minMsg}, ${maxMsg}].`);
          reasoning_trace.push(traceEntry);
        } else {
          vessels.forEach(e => { e.vol = e.min; });
          let rem = Vrem - sumMin;
          while (rem > 1e-9) {
            const unsat = vessels.filter(e => e.vol + 1e-9 < e.max);
            if (unsat.length === 0) break;
            const delta = rem / unsat.length;
            let consumed = 0;
            for (const e of unsat) {
              const add = Math.min(delta, e.max - e.vol);
              e.vol += add;
              consumed += add;
            }
            rem -= consumed;
            if (consumed <= 1e-9) break;
          }
          for (const e of vessels) addAllocation(e.tank, remaining, e.vol);
          if (bandApplied) {
            bandSlotsLeft -= 1;
            const v = vessels.find(v=>v.tank.id===bandTankId);
            warnings.push(`Allowed underfill on ${bandTankId} (${(v.vol / v.tank.volume_m3 * 100).toFixed(1)}%) to fit ${remaining.name || remaining.id}.`);
            bandUsedTankIds.add(bandTankId);
          }
          reasoning_trace.push(traceEntry);
        }
      }
      }
    } else {
      // No specific target: fill all free capacity to max
      let reserved = [];
      // centers first
      for (const c of freeCentersList) {
        addAllocation(c, remaining, c.volume_m3 * c.max_pct);
        usedCenters.add(c.id);
        reserved.push(c.id);
      }
      for (const idx of freePairsAll) {
        const pr = pairs[idx];
        addAllocation(pr.port, remaining, pr.port.volume_m3 * pr.port.max_pct);
        addAllocation(pr.starboard, remaining, pr.starboard.volume_m3 * pr.starboard.max_pct);
        usedPairs.add(idx);
        reserved.push(`COT${idx}P/S`);
      }
      reasoning_trace.push({ parcel_id: remaining.id, V: -1, Cmin: CminRef, Cmax: CmaxRef, k_low: 0, k_high: 0, chosen_k: 0, parity_adjustment: 'none', per_tank_v: 0, violates: false, reserved_pairs: reserved, reason: 'Remaining parcel filled to max capacity' });
    }
  }

  // Diagnostics: weights and balance
  let port_weight_mt = 0;
  let starboard_weight_mt = 0;
  for (const a of allocations) {
    const tank = included.find(t => t.id === a.tank_id);
    if (!tank) continue;
    if (tank.side === 'port') port_weight_mt += a.weight_mt;
    if (tank.side === 'starboard') starboard_weight_mt += a.weight_mt;
  }
  // Validate per-tank min/max and record warnings
  for (const a of allocations) {
    const tank = included.find(t => t.id === a.tank_id);
    if (!tank) continue;
    const minV = tank.volume_m3 * tank.min_pct - 1e-6;
    const maxV = tank.volume_m3 * tank.max_pct + 1e-6;
    if (a.assigned_m3 < minV) {
      if (!bandUsedTankIds.has(a.tank_id)) {
        warnings.push(`Tank ${a.tank_id}: below min (${a.assigned_m3.toFixed(1)} < ${(tank.volume_m3*tank.min_pct).toFixed(1)})`);
      }
    }
    if (a.assigned_m3 > maxV) warnings.push(`Tank ${a.tank_id}: above max (${a.assigned_m3.toFixed(1)} > ${(tank.volume_m3*tank.max_pct).toFixed(1)})`);
  }
  const denom = port_weight_mt + starboard_weight_mt;
  const imbalance_pct = denom > 0 ? (Math.abs(port_weight_mt - starboard_weight_mt) / denom) * 100 : 0;
  const balance_status = imbalance_pct <= 10 ? 'Balanced' : 'Warning';

  const diagnostics = {
    port_weight_mt,
    starboard_weight_mt,
    balance_status,
    imbalance_pct,
    reasoning_trace,
    warnings,
    errors
  };

  return { allocations, diagnostics };
}

export function computePlan(tanks, parcels) {
  return computePlanInternal(tanks, parcels, 'min_k');
}

export function computePlanMaxRemaining(tanks, parcels) {
  return computePlanInternal(tanks, parcels, 'min_locked_global');
}

export function computePlanSingleWingAlternative(tanks, parcels) {
  return computePlanInternal(tanks, parcels, 'min_k', { preferWingEvenIfCenter: true });
}

export function computePlanMinTanksAggressive(tanks, parcels) {
  return computePlanInternal(tanks, parcels, 'min_k', { aggressiveSingleWing: true });
}

export function computePlanMaxK(tanks, parcels) {
  return computePlanInternal(tanks, parcels, 'max_k');
}

export function computePlanMinKeepSlopsSmall(tanks, parcels) {
  return computePlanInternal(tanks, parcels, 'min_k', { hardReserveSlopsSmall: true });
}

// Expert: compute plan with custom policy (e.g., relaxed band minimums for upper-bound draft solve)
export function computePlanMinKPolicy(tanks, parcels, policy) {
  return computePlanInternal(tanks, parcels, 'min_k', policy || {});
}

// Enumerate alternative minimal-k plans: returns up to maxAlts results with different pair selections.
export function computePlanMinKAlternatives(tanks, parcels, maxAlts = 5) {
  // Current implementation supports the common case with one fixed (non-remaining) parcel.
  const { pairs, centers, included } = groupTanks(tanks);
  const fixed = parcels.filter(p => !p.fill_remaining);
  if (fixed.length === 0) return [];
  const p0 = fixed[0];
  const V = p0.total_m3 ?? 0;
  const pairIndices = Object.keys(pairs).map(n => parseInt(n, 10)).filter(n => !!pairs[n]);
  const orderedPairs = middleOutOrder(pairIndices);
  // Determine minimal k using the existing selector
  const sel = chooseK_nonuniform(V, orderedPairs, pairs, centers, 'min_k', {});
  if (!sel.chosen_k) return [];
  const pCount = sel.chosen_k % 2 === 0 ? sel.chosen_k / 2 : (sel.chosen_k - 1) / 2;
  const useCenter = sel.chosen_k % 2 === 1;
  // Generate combinations of orderedPairs of size pCount
  function* combos(arr, k, start = 0, prefix = []) {
    if (k === 0) { yield prefix; return; }
    for (let i = start; i <= arr.length - k; i++) yield* combos(arr, k - 1, i + 1, prefix.concat(arr[i]));
  }
  const results = [];
  const seenSig = new Set();
  const centersList = useCenter ? [...centers] : [null];
  const cotIdxs = Object.keys(pairs).map(n => parseInt(n,10)).filter(n => !!pairs[n] && n < 1000);
  const minCot = cotIdxs.length ? Math.min(...cotIdxs) : 0;
  const maxCot = cotIdxs.length ? Math.max(...cotIdxs) : 0;
  for (const idxs of combos(orderedPairs, pCount)) {
    if (isMidOnlyContiguousBlock(idxs, minCot, maxCot)) continue;
    for (const c of centersList) {
      const policy = { forcedSelection: { [p0.id]: { reservedPairs: idxs, center: c ? c.id : null } } };
      const r = computePlanInternal(tanks, parcels, 'min_k', policy);
      const diag = r.diagnostics || {};
      if ((diag.errors && diag.errors.length) || !r.allocations || r.allocations.length === 0) continue;
      // Signature for dedupe
      const sig = r.allocations.map(a => `${a.tank_id}:${a.parcel_id}:${a.assigned_m3.toFixed(3)}`).sort().join('|');
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      // Metrics: dead space and fore/aft moment
      const usedTankIds = new Set(r.allocations.map(a => a.tank_id));
      let cmaxUsed = 0, assignedUsed = 0;
      const pairWeights = new Map();
      for (const a of r.allocations) {
        const t = included.find(tt => tt.id === a.tank_id);
        if (!t) continue;
        cmaxUsed += t.volume_m3 * t.max_pct;
        assignedUsed += a.assigned_m3;
        const idxRaw = parsePairIndex(t.id) ?? 0;
        pairWeights.set(idxRaw, (pairWeights.get(idxRaw) || 0) + a.weight_mt);
      }
      const deadSpace = Math.max(0, cmaxUsed - assignedUsed);
      // Normalize indices for F/A metrics: place SLOP at the stern end just after max COT index
      const cotIdxs = Object.keys(pairs).map(n=>parseInt(n,10)).filter(n => !!pairs[n] && n < 1000);
      const minCot = Math.min(...cotIdxs);
      const maxCot = Math.max(...cotIdxs);
      const norm = (idx) => (idx >= 1000 ? maxCot + 1 : idx);
      // fwd/aft balance around mid of [minCot..maxCot+1]
      const mid = (minCot + (maxCot + 1)) / 2;
      let fwdW = 0, aftW = 0;
      const usedNormIdxs = [];
      for (const [idxRaw, wt] of pairWeights.entries()) {
        const idx = norm(idxRaw);
        usedNormIdxs.push(idx);
        if (idx < mid) fwdW += wt; else if (idx > mid) aftW += wt;
      }
      const fwdAftDiff = Math.abs(fwdW - aftW);
      // spread metrics
      usedNormIdxs.sort((a,b)=>a-b);
      const span = (usedNormIdxs.length ? (usedNormIdxs[usedNormIdxs.length-1] - usedNormIdxs[0]) : 0);
      // contiguity: longest consecutive run length (prefer smaller)
      let maxRun = 0; let run = 0; let prev = null;
      for (const idx of usedNormIdxs) {
        if (prev == null || idx !== prev + 1) { run = 1; } else { run++; }
        if (run > maxRun) maxRun = run;
        prev = idx;
      }
      const usesSlop = usedNormIdxs.some(i => i === maxCot + 1) ? 1 : 0;
      results.push({ res: r, metrics: { deadSpace, fwdAftDiff, span, maxRun, usesSlop } });
    }
  }
  results.sort((a,b) =>
    (b.metrics.usesSlop - a.metrics.usesSlop) ||
    (a.metrics.fwdAftDiff - b.metrics.fwdAftDiff) ||
    (a.metrics.deadSpace - b.metrics.deadSpace) ||
    (a.metrics.maxRun - b.metrics.maxRun) ||
    (b.metrics.span - a.metrics.span)
  );
  return results.slice(0, maxAlts).map(x => x.res);
}

/**
 * Build default 8 tanks x 1000 m3 configuration.
 * Pair numbers 1..4, sides P/S.
 * @returns {Tank[]}
 */
export function buildDefaultTanks() {
  // Custom default per user request: 5 pairs + slops with specific volumes
  const min_pct = 0.5;
  const max_pct = 0.98;
  return [
    // Pair 1
    { id: 'COT1P', volume_m3: 3100.7, min_pct, max_pct, included: true, side: 'port' },
    { id: 'COT1S', volume_m3: 3113.1, min_pct, max_pct, included: true, side: 'starboard' },
    // Pair 2
    { id: 'COT2P', volume_m3: 4882.8, min_pct, max_pct, included: true, side: 'port' },
    { id: 'COT2S', volume_m3: 4882.8, min_pct, max_pct, included: true, side: 'starboard' },
    // Pair 3
    { id: 'COT3P', volume_m3: 4806.5, min_pct, max_pct, included: true, side: 'port' },
    { id: 'COT3S', volume_m3: 4813.0, min_pct, max_pct, included: true, side: 'starboard' },
    // Pair 4
    { id: 'COT4P', volume_m3: 4944.7, min_pct, max_pct, included: true, side: 'port' },
    { id: 'COT4S', volume_m3: 4965.7, min_pct, max_pct, included: true, side: 'starboard' },
    // Pair 5
    { id: 'COT5P', volume_m3: 3434.6, min_pct, max_pct, included: true, side: 'port' },
    { id: 'COT5S', volume_m3: 3431.0, min_pct, max_pct, included: true, side: 'starboard' },
    // Slops as small wing tanks
    { id: 'SLOPP', volume_m3: 156.4, min_pct, max_pct, included: true, side: 'port' },
    { id: 'SLOPS', volume_m3: 156.2, min_pct, max_pct, included: true, side: 'starboard' },
  ];
}

/**
 * Build T10 regression config: 8×3000 m3, min 50%, max 98%.
 */
export function buildT10Tanks() {
  const out = [];
  const min_pct = 0.5;
  const max_pct = 0.98;
  const volume_m3 = 3000;
  for (let i = 1; i <= 4; i++) {
    out.push({ id: `COT${i}P`, volume_m3, min_pct, max_pct, included: true, side: 'port' });
    out.push({ id: `COT${i}S`, volume_m3, min_pct, max_pct, included: true, side: 'starboard' });
  }
  return out;
}

/** K2: 24×1000 m3, symmetric pairs (12 pairs) */
export function buildK2Tanks() {
  const out = [];
  const min_pct = 0.5;
  const max_pct = 0.98;
  const volume_m3 = 1000;
  for (let i = 1; i <= 12; i++) {
    out.push({ id: `COT${i}P`, volume_m3, min_pct, max_pct, included: true, side: 'port' });
    out.push({ id: `COT${i}S`, volume_m3, min_pct, max_pct, included: true, side: 'starboard' });
  }
  return out;
}

/** K3: 36 tanks (18 pairs), asymmetric volumes repeating pattern [500,1000,1500,1700,1200,800] */
export function buildK3Tanks() {
  const out = [];
  const min_pct = 0.5;
  const max_pct = 0.98;
  const pattern = [500, 1000, 1500, 1700, 1200, 800];
  let pair = 1;
  for (let r = 0; r < 3; r++) {
    for (const vol of pattern) {
      out.push({ id: `COT${pair}P`, volume_m3: vol, min_pct, max_pct, included: true, side: 'port' });
      out.push({ id: `COT${pair}S`, volume_m3: vol, min_pct, max_pct, included: true, side: 'starboard' });
      pair++;
    }
  }
  return out;
}

/**
 * Convenience to pretty summarize allocations by parcel.
 */
export function summarizeAllocations(allocations) {
  /** @type {Record<string, {tanks:number, total:number, perTank:number[]}>} */
  const m = {};
  for (const a of allocations) {
    if (!m[a.parcel_id]) m[a.parcel_id] = { tanks: 0, total: 0, perTank: [] };
    m[a.parcel_id].tanks++;
    m[a.parcel_id].total += a.assigned_m3;
    m[a.parcel_id].perTank.push(a.assigned_m3);
  }
  return m;
}
