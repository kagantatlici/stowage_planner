Tanker Stowage Planner — MVP
============================

Single-page web app implementing the ITCP (Integer Tank Count Planner) and a deterministic stowage distribution engine with explainability trace, per the PRD.

How to use
----------

- Open `index.html` in a browser.
- Use Tank Editor to adjust volumes, min/max, and inclusion.
- Use Cargo Input to define parcels. Ensure only the last parcel has `fill_remaining` enabled.
- Click "Load T10 Example" to preload the regression case (8×3000 m³; 11k Gasoline, 5k Jet A-1, remainder Gasoil) and then click "Compute Plan".
- Distribution Result shows P/S weights, balance tag, SVG layout, and a reasoning trace.

Regression test (CLI)
---------------------

Requires Node 18+.

```
npm run regression
```

This runs `scripts/run_regression.js`, verifying the T10 edge case:

- Gasoline: k=4, 4×2750 m³
- Jet A-1: k=2, 2×2500 m³
- Gasoil (remaining): 2×2940 m³
- Total assigned volume: 21,880 m³

Notes
-----

- The MVP assumes uniform tank volumes when computing ITCP feasibility (k_low/k_high) via reference limits from the first included tank. Actual per-tank min/max are respected on assignment; the default and T10 scenarios are uniform.
- Center tanks are supported and used only when odd k is chosen and a center exists.
- P/S balance excludes center tank weight.

