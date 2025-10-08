// Regression test for T10 edge case
import { buildT10Tanks, computePlan, summarizeAllocations } from '../engine/stowage.js';

function approxEqual(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

function run() {
  const tanks = buildT10Tanks();
  const parcels = [
    { id: 'P1', name: 'Gasoline', total_m3: 11000, density_kg_m3: 780, temperature_c: 20, color: '#f59e0b' },
    { id: 'P2', name: 'Jet A-1', total_m3: 5000, density_kg_m3: 820, temperature_c: 20, color: '#3b82f6' },
    { id: 'P3', name: 'Gasoil', fill_remaining: true, density_kg_m3: 850, temperature_c: 20, color: '#10b981' }
  ];

  const { allocations, diagnostics } = computePlan(tanks, parcels);
  const summary = summarizeAllocations(allocations);

  const cmin = 1500; // 3000 * 0.5
  const cmax = 2940; // 3000 * 0.98

  // Expect P1: k=4, per tank 2750
  const p1 = summary['P1'];
  const p2 = summary['P2'];
  const p3 = summary['P3'];

  let ok = true;
  function check(cond, msg) {
    if (!cond) {
      ok = false;
      console.error('FAIL:', msg);
    } else {
      console.log('OK  :', msg);
    }
  }

  check(!!p1, 'P1 exists');
  check(!!p2, 'P2 exists');
  check(!!p3, 'P3 exists');

  if (p1) {
    check(p1.tanks === 4, 'P1 uses 4 tanks');
    for (const v of p1.perTank) {
      check(approxEqual(v, 2750), `P1 per tank = 2750 (got ${v})`);
      check(v >= cmin - 1e-6 && v <= cmax + 1e-6, 'P1 per tank within [Cmin,Cmax]');
    }
  }
  if (p2) {
    check(p2.tanks === 2, 'P2 uses 2 tanks');
    for (const v of p2.perTank) {
      check(approxEqual(v, 2500), `P2 per tank = 2500 (got ${v})`);
      check(v >= cmin - 1e-6 && v <= cmax + 1e-6, 'P2 per tank within [Cmin,Cmax]');
    }
  }
  if (p3) {
    check(p3.tanks === 2, 'P3 uses 2 tanks');
    for (const v of p3.perTank) {
      check(approxEqual(v, 2940), `P3 per tank = 2940 (got ${v})`);
      check(v >= cmin - 1e-6 && v <= cmax + 1e-6, 'P3 per tank within [Cmin,Cmax]');
    }
    check(approxEqual(p3.total, 5880), 'P3 total = 5880');
  }

  const totalVol = (p1?.total || 0) + (p2?.total || 0) + (p3?.total || 0);
  check(approxEqual(totalVol, 21880), `Total assigned volume = 21880 (got ${totalVol})`);

  console.log('Port MT:', diagnostics.port_weight_mt.toFixed(2));
  console.log('Starboard MT:', diagnostics.starboard_weight_mt.toFixed(2));
  console.log('Imbalance %:', diagnostics.imbalance_pct.toFixed(3));
  console.log('Balance Status:', diagnostics.balance_status);

  if (ok) {
    console.log('\nREGRESSION T10: PASS');
    process.exit(0);
  } else {
    console.error('\nREGRESSION T10: FAIL');
    process.exit(1);
  }
}

run();

