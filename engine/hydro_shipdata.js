// Ship Data hydro core — copied logic
export function solveDraftByDisFWShip(rows, target_dis_fw, rho_ref = 1.025) {
  if (!Array.isArray(rows) || rows.length === 0 || !isFinite(target_dis_fw)) return null;
  const toFW = (r) => (typeof r.dis_fw === 'number') ? r.dis_fw : ((typeof r.dis_sw === 'number') ? (r.dis_sw / rho_ref) : undefined);
  const seq = rows
    .filter(r => isFinite(r.draft_m))
    .map(r => ({ T: r.draft_m, Y: toFW(r) }))
    .filter(p => isFinite(p.Y))
    .sort((a,b)=>a.T-b.T);
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

export function interpHydroShip(rows, T, rho_ref = 1.025) {
  if (!Array.isArray(rows) || rows.length === 0 || !isFinite(T)) return null;
  const rr = rows.slice().sort((a,b)=>a.draft_m-b.draft_m);
  const toFW = (r) => (typeof r.dis_fw === 'number') ? r.dis_fw : ((typeof r.dis_sw === 'number') ? (r.dis_sw / rho_ref) : undefined);
  if (T <= rr[0].draft_m) { const r=rr[0]; return { LCF:r.lcf_m, LCB:r.lcb_m, TPC:r.tpc, MCT1cm:r.mct, DIS_FW: toFW(r) }; }
  if (T >= rr[rr.length - 1].draft_m) { const r=rr[rr.length-1]; return { LCF:r.lcf_m, LCB:r.lcb_m, TPC:r.tpc, MCT1cm:r.mct, DIS_FW: toFW(r) }; }
  let lo = 0, hi = rr.length - 1;
  while (hi - lo > 1) { const mid=(lo+hi)>>1; if (rr[mid].draft_m<=T) lo=mid; else hi=mid; }
  const a = rr[lo], b = rr[hi];
  const t = (T - a.draft_m) / (b.draft_m - a.draft_m);
  const lerp = (x,y)=> x + (y - x) * t;
  const aFW = toFW(a), bFW = toFW(b);
  const DIS_FW = (isFinite(aFW)&&isFinite(bFW)) ? lerp(aFW, bFW) : undefined;
  return { LCF: lerp(a.lcf_m,b.lcf_m), LCB: lerp(a.lcb_m,b.lcb_m), TPC: lerp(a.tpc,b.tpc), MCT1cm: lerp(a.mct,b.mct), DIS_FW };
}

export function computeHydroShip(rows, W_total, LCG_total, LBP, rho_ref = 1.025) {
  if (!Array.isArray(rows) || rows.length === 0 || !(W_total>0)) return null;
  const Tm = solveDraftByDisFWShip(rows, W_total / rho_ref, rho_ref);
  if (!isFinite(Tm)) return null;
  const H = interpHydroShip(rows, Tm, rho_ref) || {};
  const LCB = (typeof H.LCB === 'number') ? H.LCB : 0;
  const MCT1cm = (typeof H.MCT1cm === 'number' && H.MCT1cm !== 0) ? H.MCT1cm : null;
  const Trim_cm = (MCT1cm ? ( - (W_total * (LCG_total - LCB)) / MCT1cm ) : 0);
  const Trim = Trim_cm / 100.0;
  let Tf = Tm, Ta = Tm;
  if (isFinite(LBP) && LBP > 0) {
    const LCF = (typeof H.LCF === 'number') ? H.LCF : 0;
    const dAP = (LBP/2) + LCF;
    const dFP = (LBP/2) - LCF;
    Tf = Tm - Trim * (dFP / LBP);
    Ta = Tm + Trim * (dAP / LBP);
  }
  return { Tf, Tm, Ta, Trim, LCB: H.LCB, LCF: H.LCF, MCT1cm, TPC: H.TPC };
}

