# SDF Optimization: Keeter's Techniques as Implemented in Schnapp3

## Background

This document was originally written as a research/planning doc proposing the
adaptation of Matt Keeter's SDF optimization techniques for Schnapp3. The core
techniques (interval arithmetic + octree pruning) have since been implemented
and extended. This doc now serves as a reference for the theory behind the
implementation and a record of lessons learned.

## Matt Keeter's Key Ideas

Keeter's work (libfive → MPR → Fidget) revolves around three interlocking techniques.

### 1. Interval Arithmetic

**Core idea:** Instead of evaluating `f(x, y, z)` at a single point, evaluate
`f([x_lo, x_hi], [y_lo, y_hi], [z_lo, z_hi])` where each input is an *interval*
covering a region of space. The result is an interval `[d_lo, d_hi]` that *bounds*
the true distance for every point in that region.

**Why it helps:** If `d_lo > 0`, the entire region is outside the shape — skip it.
If `d_hi < 0`, the entire region is inside — fill it without further subdivision.

**Interval math rules:**
```
[a,b] + [c,d] = [a+c, b+d]
[a,b] - [c,d] = [a-d, b-c]
[a,b] * [c,d] = [min(ac,ad,bc,bd), max(ac,ad,bc,bd)]
sqrt([a,b])   = [sqrt(max(a,0)), sqrt(b)]     (for a≥0)
max([a,b], [c,d]) = [max(a,c), max(b,d)]
min([a,b], [c,d]) = [min(a,c), min(b,d)]
abs([a,b])    = if a≥0: [a,b]; if b≤0: [-b,-a]; else [0, max(-a,b)]
```

**Our implementation:** `src/interval.js` (153 lines). Also includes `icos`, `isin`,
`iatan2`, `imod` for domain-warp operators, plus `isoftmin` for fuse, and a
`classify(interval) → 'inside'|'outside'|'ambiguous'` helper.

### 2. Octree Spatial Subdivision

**Core idea:** Instead of sampling a flat grid, recursively subdivide the bounding box
into an octree. At each node:

1. Evaluate the SDF with interval arithmetic over the node's bounding box.
2. If the interval is entirely positive (outside) or entirely negative (inside),
   stop recursing — the node is culled.
3. If the interval straddles zero (surface might pass through), subdivide into 8 children.
4. At the leaf level (minimum cell size), sample corners and run surface nets.

**Our implementation:** `src/octree-core.js` (306 lines). Key additions beyond the
textbook algorithm:

- **Two-phase bailout:** A shallow probe to depth 3 checks whether octree pruning
  is worthwhile. If less than 10% of nodes are culled at the shallow level, the
  octree is abandoned and we fall back to a flat uniform grid. This avoids overhead
  for shapes where interval arithmetic doesn't help (e.g., a shape filling the
  entire bounding box).

- **Sparse surface nets on octree leaves:** Rather than materializing a full `n³` grid,
  `meshOctreeLeavesRaw` takes the list of leaf cells from `buildOctree`, samples field
  values only at corners of active cells (with a Map-based cache for shared corners),
  and runs surface nets only on those cells. Extended cells (1-ring neighbors of active
  cells) are included for quad connectivity.

### 3. Tape Simplification (Not Yet Implemented)

**Core idea:** During interval evaluation, when `min(A, B)` resolves to definitely `A`
(because A's interval is entirely below B's), B's entire subtree can be pruned for that
spatial region. This produces a *simplified evaluator* that gets shorter as you descend
the octree.

**Status:** Not yet implemented. Would be most impactful for scenes with many CSG
operations (union of many shapes), where most shapes are far from any given region.
The closure-tree structure in `evalCSGField` could support this by returning specialized
closures per octree branch.

### 4. Lipschitz Pruning (Not Yet Implemented)

Keeter's May 2025 blog post "Gradients are the New Intervals" describes evaluating `f`
at the center of a region and using `|f(center)| > half_diagonal` as a cheaper pruning
test for proper SDFs (|∇f| ≤ 1). Attractive for simple scenes, but some of our
transforms (twist, taper, bend) break Lipschitz continuity.

## What Was Actually Built (Beyond the Original Plan)

The implementation went significantly further than the original research doc anticipated:

### Interval AST evaluator (`src/interval-eval.js`, 544 lines)
Mirrors `evalCSGField` but over intervals. Returns `{distance: [lo,hi], polarity: [lo,hi]}`
for each node type including all domain warps (twist, radial, stretch, tile, bend, taper,
mirror) and PL nodes (let, var, fractal, stir, enzyme).

### Progressive refinement (`src/progressive.js`, 190 lines)
Spawns parallel Web Workers at multiple octree depths. Lower depths finish first (blocky
preview), higher depths refine. Uses a worker pool (up to 6 workers) and generation
counter to discard stale results.

### Web Worker meshing (`src/mesh-worker.js`, 105 lines)
Offloads octree build + surface-net meshing to background threads, keeping the UI
responsive during evaluation.

### WebGPU evaluation (`src/gpu-engine.js`, 1068 lines)
Compiles AST to a linear tape (`src/gpu-tape.js`), dispatches via WebGPU compute shader.
Supports both uniform-grid and sparse (octree-guided) dispatch. Falls back to CPU
when WebGPU is unavailable.

### Pure-computation CSG field (`src/csg-field.js`, 436 lines)
Extracted from evaluator.js so that Web Workers can import it without Three.js.

### Test suite
- `test/interval-tests.js` — interval arithmetic correctness
- `test/interval-containment-tests.js` — verify intervals contain point samples
- `test/octree-culling-tests.js` — octree culling correctness including polarity edge cases
- `test/fp-audit.js` — floating-point width analysis
- `test/gpu-tape-tests.js` — GPU tape compilation/evaluation
- `test/bench*.js` — performance benchmarks

## Lessons Learned

### Polarity straddling (PR #57)
The original research doc flagged a "subtlety with polarity" — the solidField wrapper
returns `distance` when polarity > 0 and `abs(distance) + 0.01` otherwise. When a
solid and anti-solid overlap, polarity cancels to 0 but the raw SDF distance may be
entirely negative (deep inside), causing the octree to wrongly cull the cell as
"inside" — missing the surface. Fix: detect polarity-straddling intervals and force the
distance interval to span zero.

### Bailout heuristic matters
Without the two-phase bailout, the octree overhead can slow down simple scenes where
most of the bounding box is occupied by the shape. The shallow probe at depth 3 catches
these cases cheaply.

### Conservative intervals for warps are fine
Twist, bend, taper produce wide intervals. The octree falls back toward brute-force in
those regions, but the surrounding empty space is still culled efficiently. The FP audit
(`test/fp-audit.js`) verified that interval overestimation stays bounded in practice.

## References

- Keeter, M. "Massively Parallel Rendering of Complex Closed-Form Implicit Surfaces."
  ACM Trans. Graphics (SIGGRAPH 2020). https://www.mattkeeter.com/research/mpr/
- Keeter, M. "Hierarchical Volumetric Object Representations for Digital Fabrication
  Workflows." MIT MS Thesis, 2013. http://cba.mit.edu/docs/theses/13.05.Keeter.pdf
- Keeter, M. "Gradients are the New Intervals." Blog post, May 2025.
  https://www.mattkeeter.com/blog/2025-05-14-gradients/
- Keeter, M. Fidget library. https://github.com/mkeeter/fidget
- Duff, T. "Interval Arithmetic Recursive Subdivision for Implicit Functions and
  Constructive Solid Geometry." ACM SIGGRAPH 1992. (The foundational paper.)
- Frisken et al. "Adaptively Sampled Distance Fields." SIGGRAPH 2000. (ASDFs on octrees.)
