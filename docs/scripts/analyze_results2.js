import fs from 'node:fs';

const r = JSON.parse(fs.readFileSync('scripts/mvp_results.json','utf8'));
const groups = {};
for (const x of r) { const k = `${x.config}|${x.test}|${x.regime}`; if (!groups[k]) groups[k] = {}; groups[k][x.objective] = x; }
let betterDead=0, equalTankBetter=0, worseDead=0;
for (const k of Object.keys(groups)) {
  const a = groups[k]['H1'], b = groups[k]['H2'];
  if (!a || !b) continue;
  if (a.feasible && b.feasible) {
    if (b.capacities.deadSpace + 1e-6 < a.capacities.deadSpace) { betterDead++; if (a.tankCount===b.tankCount) equalTankBetter++; }
    else if (b.capacities.deadSpace > a.capacities.deadSpace + 1e-6) { worseDead++; }
  }
}
console.log({betterDead, equalTankBetter, worseDead});

