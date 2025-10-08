// MVP Distribution Test Runner
// Runs scenarios across Strict/Relaxed and K1/K2/K3. Prints concise summaries.

import {
  computePlan,
  computePlanMaxRemaining,
  buildT10Tanks,
  buildK2Tanks,
  buildK3Tanks,
} from '../engine/stowage.js';
import fs from 'node:fs';

const CONFIGS = {
  K1: buildT10Tanks,
  K2: buildK2Tanks,
  K3: buildK3Tanks,
};

function relaxTanks(tanks) {
  return tanks.map(t => ({ ...t, min_pct: 0, max_pct: 1 }));
}

function summarize(result) {
  const { allocations, diagnostics } = result;
  const usedTanks = new Set(allocations.map(a => a.tank_id));
  const tankCount = usedTanks.size;
  const perParcelParts = {};
  for (const a of allocations) {
    perParcelParts[a.parcel_id] = (perParcelParts[a.parcel_id] || 0) + 1;
  }
  // collect chosen pairs from trace
  const trace = diagnostics?.reasoning_trace || [];
  const chosen = trace.map(tr => ({ parcel: tr.parcel_id, k: tr.chosen_k, pairs: tr.reserved_pairs })).filter(x => x.k);
  return { tankCount, perParcelParts, chosen, errors: diagnostics?.errors || [], warnings: diagnostics?.warnings || [] };
}

function fmtPct(x) { return (x*100).toFixed(1)+'%'; }

function printReport(title, tanks, parcels, res) {
  const { allocations, diagnostics } = res;
  const s = summarize(res);
  const feasible = (s.errors.length === 0);
  console.log(`\n=== ${title} — ${feasible ? 'Feasible' : 'Infeasible'} ===`);
  console.log(`Used tanks: ${s.tankCount}`);
  console.log(`Chosen sets: ${s.chosen.map(c=>`${c.parcel}: k=${c.k} [${c.pairs.join(', ')}]`).join(' | ') || '-'}`);
  if (!feasible) console.log('Errors:', s.errors.join(' | '));
  // Strict: list fills
  if (allocations.length) {
    const lines = allocations.map(a => `${a.tank_id}:${fmtPct(a.fill_pct)}`).join(', ');
    console.log('Fills:', lines);
    // Capacity metrics
    const included = tanks.filter(t => t.included);
    const used = new Set(allocations.map(a => a.tank_id));
    let cmaxUsed = 0, cmaxFree = 0, assignedUsed = 0;
    for (const t of included) {
      const cmax = t.volume_m3 * t.max_pct;
      if (used.has(t.id)) cmaxUsed += cmax; else cmaxFree += cmax;
    }
    for (const a of allocations) assignedUsed += a.assigned_m3;
    const deadSpace = Math.max(0, cmaxUsed - assignedUsed);
    console.log(`Capacities — Locked: ${cmaxUsed.toFixed(0)} m³, Remaining: ${cmaxFree.toFixed(0)} m³, Dead-space: ${deadSpace.toFixed(0)} m³`);
  }
}

function makeParcelsHuman(name, spec) {
  // spec: array of numbers or objects; number => total_m3 parcel; string 'rem' => fill_remaining
  const out = [];
  let idx = 1;
  for (const entry of spec) {
    if (typeof entry === 'number') {
      out.push({ id: `P${idx}`, name: `${name} P${idx}`, total_m3: entry, density_kg_m3: 800, temperature_c: 20, color: '#f59e0b' });
    } else if (entry === 'rem') {
      out.push({ id: `P${idx}`, name: `${name} P${idx}`, fill_remaining: true, density_kg_m3: 850, temperature_c: 20, color: '#10b981' });
    } else if (typeof entry === 'object') {
      out.push({ id: `P${idx}`, name: entry.name || `${name} P${idx}`, total_m3: entry.v, fill_remaining: entry.rem || false, density_kg_m3: entry.rho || 800, temperature_c: 20, color: entry.color || '#3b82f6' });
    }
    idx++;
  }
  return out;
}

const TESTS = [
  // A) Single parcel capacity/thresholds
  { id: 'A1_1m3', spec: [1] },
  { id: 'A2_fill_one_tank', spec: [3000] },
  { id: 'A3_split_two', spec: [5000] },
  { id: 'A4_fill_all', spec: [24000] },
  { id: 'A5_exceed_all', spec: [25000] },
  { id: 'A6_upper_bound', spec: [24480] },
  { id: 'A7_round_edge', spec: [24001] },
  // B) Multi-parcel basics
  { id: 'B1_two_equal', spec: [7000, 7000] },
  { id: 'B2_two_plus_rem', spec: [7000, 7000, 'rem'] },
  { id: 'B3_big_mid', spec: [15000, 4000] },
  { id: 'B4_one_full_plus_smalls', spec: [3000, 100, 100, 100, 100, 100] },
  { id: 'B5_12_not_full', spec: Array(12).fill(1000) },
  { id: 'B6_12_near_full', spec: Array(12).fill(2000) },
  { id: 'B7_three_close', spec: [8000, 8000, 8000] },
  // D) Errors
  { id: 'D1_total_32000', spec: [32000] },
  { id: 'D2_3001', spec: [3001] },
  { id: 'D3_100x100', spec: Array(100).fill(100) },
  { id: 'D4_zero_parcels', spec: [] },
  { id: 'D5_negative', spec: [{ v: -10 }] },
  // E) Edge percentages (K1 scale)
  { id: 'E1_min50_1500', spec: [1500] },
  { id: 'E2_max98_2940', spec: [2940] },
  { id: 'E3_min_below_1000', spec: [1000] },
  // C) Greedy/Heuristic Traps & Quality
  { id: 'C1_BIG_MED_SMALL', spec: [10000, 8000, 6000] },
  { id: 'C2_SMALL_MED_BIG', spec: [6000, 8000, 10000] },
  { id: 'C3_K3_5100_4900', spec: [5100, 4900] },
  { id: 'C4_NEAR_FULL_2990_20_20', spec: [2990, 20, 20] },
  { id: 'C5_MIN_TANKS_6000', spec: [6000] },
  { id: 'C6_MIN_TOTAL_TANKS_10000', spec: [10000] },
  // F) Determinism
  { id: 'F1_order_invariance_a', spec: [7000, 8000, 6000, 3000, 4000] },
  { id: 'F1_order_invariance_b', spec: [3000, 4000, 6000, 7000, 8000] },
  // G) Asymmetric K3 specials
  { id: 'G1_best_fit_1292_800_1500', spec: [1292, 800, 1500] },
  { id: 'G2_near_fit_1300', spec: [1300] },
  { id: 'G3_consolidate_residuals_3x1500', spec: [1500, 1500, 1500] },
  // H) Fill-remaining variants
  { id: 'H1_7000_7000_rem', spec: [7000, 7000, 'rem'] },
  { id: 'H2_21500_500', spec: [21500, 500] },
];

function runAll() {
  const only = process.argv[2];
  const objectives = [
    { id: 'H1', fn: computePlan },
    { id: 'H2', fn: computePlanMaxRemaining }
  ];
  const results = [];
  for (const [kID, build] of Object.entries(CONFIGS)) {
    console.log(`\n##### Config ${kID}`);
    const baseTanks = build();
    for (const test of TESTS) {
      if (only && !test.id.includes(only)) continue;
      const parcels = makeParcelsHuman(test.id, test.spec);
      for (const regime of ['Strict', 'Relaxed']) {
        const tanks = regime === 'Strict' ? baseTanks : relaxTanks(baseTanks);
        for (const obj of objectives) {
          const res = obj.fn(tanks, parcels);
          printReport(`${test.id} | ${regime} | ${obj.id}`, tanks, parcels, res);
          const s = summarize(res);
          // compute capacity metrics
          const included = tanks.filter(t => t.included);
          const used = new Set(res.allocations.map(a => a.tank_id));
          let cmaxUsed = 0, cmaxFree = 0, assignedUsed = 0;
          for (const t of included) {
            const cmax = t.volume_m3 * t.max_pct;
            if (used.has(t.id)) cmaxUsed += cmax; else cmaxFree += cmax;
          }
          for (const a of res.allocations) assignedUsed += a.assigned_m3;
          const deadSpace = Math.max(0, cmaxUsed - assignedUsed);
          results.push({
            config: kID,
            test: test.id,
            regime,
            objective: obj.id,
            feasible: s.errors.length === 0,
            tankCount: s.tankCount,
            chosen: s.chosen,
            errors: s.errors,
            warnings: s.warnings,
            capacities: { cmaxUsed, cmaxFree, deadSpace }
          });
        }
      }
    }
  }
  try {
    fs.writeFileSync('scripts/mvp_results.json', JSON.stringify(results, null, 2));
    console.log('\nSaved detailed results to scripts/mvp_results.json');
  } catch {}
}

runAll();
