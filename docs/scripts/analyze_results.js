import fs from 'node:fs';

function run() {
  const path = 'scripts/mvp_results.json';
  if (!fs.existsSync(path)) {
    console.error('No results found at', path);
    process.exit(1);
  }
  const r = JSON.parse(fs.readFileSync(path, 'utf8'));
  const byTest = {};
  for (const x of r) {
    const k = `${x.config}|${x.test}|${x.regime}`;
    if (!byTest[k]) byTest[k] = {};
    byTest[k][x.objective] = x;
  }
  let diffs = [];
  let infeasible = [];
  function normalizeChosen(chosen, trace) {
    if (!Array.isArray(trace) || trace.length===0) return [];
    // derive signature by parcel volume V, chosen k and pair list
    const sig = trace.filter(tr => tr.chosen_k>0).map(tr => ({ V: tr.V, k: tr.chosen_k, pairs: (tr.reserved_pairs||[]).slice().sort().join('+') }));
    sig.sort((a,b)=> (b.V - a.V) || (a.k - b.k) || a.pairs.localeCompare(b.pairs));
    return sig;
  }
  for (const k of Object.keys(byTest)) {
    const g = byTest[k];
    const a = g['H1'], b = g['H2'];
    if (a && b) {
      const aSig = normalizeChosen(a.chosen, (a.reasoning_trace||a.diagnostics?.reasoning_trace||[]));
      const bSig = normalizeChosen(b.chosen, (b.reasoning_trace||b.diagnostics?.reasoning_trace||[]));
      const different = (a.feasible!==b.feasible) || (a.tankCount!==b.tankCount) || (JSON.stringify(aSig)!==JSON.stringify(bSig)) || (Math.abs(a.capacities.deadSpace - b.capacities.deadSpace) > 1e-6);
      if (different) {
        diffs.push({k, a: {tankCount:a.tankCount, dead:a.capacities.deadSpace, sig:aSig, feas:a.feasible}, b: {tankCount:b.tankCount, dead:b.capacities.deadSpace, sig:bSig, feas:b.feasible}});
      }
    }
    const any = byTest[k]['H1']||byTest[k]['H2'];
    if (any && !any.feasible) infeasible.push(k);
  }
  // Determinism check: F1 order invariance per config/regime/objective (normalize by volume-based signature)
  const det = [];
  for (const cfg of ['K1','K2','K3']) {
    for (const regime of ['Strict','Relaxed']) {
      for (const obj of ['H1','H2']) {
        const A = r.find(x => x.config===cfg && x.test==='F1_order_invariance_a' && x.regime===regime && x.objective===obj);
        const B = r.find(x => x.config===cfg && x.test==='F1_order_invariance_b' && x.regime===regime && x.objective===obj);
        if (A && B) {
          const sigA = (A.diagnostics?.reasoning_trace||[]).filter(tr=>tr.chosen_k>0).map(tr=>({V:tr.V,k:tr.chosen_k,pairs:(tr.reserved_pairs||[]).slice().sort().join('+')})).sort((u,v)=>(v.V-u.V)||(u.k-v.k)||u.pairs.localeCompare(v.pairs));
          const sigB = (B.diagnostics?.reasoning_trace||[]).filter(tr=>tr.chosen_k>0).map(tr=>({V:tr.V,k:tr.chosen_k,pairs:(tr.reserved_pairs||[]).slice().sort().join('+')})).sort((u,v)=>(v.V-u.V)||(u.k-v.k)||u.pairs.localeCompare(v.pairs));
          const same = A.feasible===B.feasible && A.tankCount===B.tankCount && JSON.stringify(sigA)===JSON.stringify(sigB);
          det.push({ cfg, regime, obj, ok: same });
        }
      }
    }
  }
  console.log('Summary');
  console.log('- Total groups:', Object.keys(byTest).length);
  console.log('- H1 vs H2 differences:', diffs.length);
  console.log('- Infeasible groups:', infeasible.length);
  console.log('- Determinism F1 a vs b (all ok?):', det.every(x=>x.ok));
  console.log('Determinism details:', det);
  console.log('Samples of H1 vs H2 diffs:', diffs.slice(0,5));
}

run();
