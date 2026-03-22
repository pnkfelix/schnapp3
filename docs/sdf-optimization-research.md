# SDF Optimization Research: Adapting Matt Keeter's Techniques for Schnapp3

## Background: Our Current Bottleneck

Schnapp3's evaluator (`src/evaluator.js`) builds a closure tree from the S-expression AST,
then `meshCSGNode()` hands that closure to `meshField()` in `surface-nets.js`, which samples
the SDF at every point on an `(n+1)³` grid. At resolution 48, that's ~117K field evaluations;
at 192, that's ~7.2M. Every single evaluation walks the full closure tree — even for voxels
that are deep inside or far outside every shape.

## Matt Keeter's Key Ideas

Keeter's work (libfive → MPR → Fidget) revolves around three interlocking techniques.
None of them require a JIT or GPU — they work fine as interpreted algorithms on the CPU.

### 1. Interval Arithmetic

**Core idea:** Instead of evaluating `f(x, y, z)` at a single point, evaluate
`f([x_lo, x_hi], [y_lo, y_hi], [z_lo, z_hi])` where each input is an *interval*
covering a region of space. The result is an interval `[d_lo, d_hi]` that *bounds*
the true distance for every point in that region.

**Why it helps:** If `d_lo > 0`, the entire region is outside the shape — skip it.
If `d_hi < 0`, the entire region is inside — fill it without further subdivision.

**Interval math rules** (straightforward to implement):
```
[a,b] + [c,d] = [a+c, b+d]
[a,b] - [c,d] = [a-d, b-c]
[a,b] * [c,d] = [min(ac,ad,bc,bd), max(ac,ad,bc,bd)]
sqrt([a,b])   = [sqrt(max(a,0)), sqrt(b)]     (for a≥0)
max([a,b], [c,d]) = [max(a,c), max(b,d)]
min([a,b], [c,d]) = [min(a,c), min(b,d)]
abs([a,b])    = if a≥0: [a,b]; if b≤0: [-b,-a]; else [0, max(-a,b)]
```

For Schnapp3, we'd write an interval-arithmetic version of each SDF primitive
(sphere, cube, cylinder) and each transform (translate, mirror, etc.) alongside
the existing point evaluators. The signatures change from `(x,y,z) → distance`
to `(xI, yI, zI) → [dLo, dHi]` where each `xI` is a `[lo, hi]` pair.

### 2. Octree Spatial Subdivision

**Core idea:** Instead of sampling a flat grid, recursively subdivide the bounding box
into an octree. At each node:

1. **Evaluate the SDF with interval arithmetic** over the node's bounding box.
2. If the interval is entirely positive (outside) or entirely negative (inside),
   **stop recursing** — mark the node as empty or filled.
3. If the interval straddles zero (surface might pass through), **subdivide into 8 children**
   and recurse.
4. At the leaf level (minimum cell size), sample corners and run surface nets
   as we do today.

**Why it helps:** Large empty/filled regions are classified in one interval evaluation
instead of `n³` point evaluations. In practice, for most shapes the surface occupies a
thin shell — the vast majority of octree nodes get pruned early.

**Expected speedup:** For a sphere at resolution 48, roughly 80-90% of voxels are
either clearly inside or clearly outside. An octree with interval pruning can skip
those entirely. The speedup grows with resolution — at resolution 192, even more
of the volume is trivially empty.

### 3. Tape Simplification (Future Enhancement)

**Core idea:** During interval evaluation, some operations become known constants.
For example, in `max(A, B)`, if interval(A) is entirely above interval(B), then A
always wins — B can be pruned from the expression for this region. This produces a
*simplified tape* (reduced expression) for each octree branch.

**Relevance to Schnapp3:** Our closure-tree structure already "compiles" the AST into
nested function calls. Tape simplification would mean creating *specialized* closures
for sub-regions where parts of the tree become irrelevant. This is more complex to
implement and is a **Phase 2** optimization — the octree + interval arithmetic alone
will give the big wins.

### 4. Lipschitz Pruning (Even Simpler Alternative)

Keeter's May 2025 blog post "Gradients are the New Intervals" describes a lighter-weight
approach for SDFs that are Lipschitz-continuous (i.e., |∇f| ≤ 1 everywhere, as proper
SDFs should be):

**Core idea:** Evaluate `f` at the *center* of a region. If `|f(center)| > radius`
(where radius is the half-diagonal of the region), the entire region is guaranteed to
be on one side of the surface.

**Why it's attractive:** Single-point evaluation is cheaper than interval evaluation,
and Schnapp3's primitives (sphere, cube, cylinder) all have proper Lipschitz-continuous
SDFs. However, some transforms (twist, taper, bend) break Lipschitz continuity, so
we'd need to fall back to interval arithmetic for those.

## Recommended Implementation Plan for Schnapp3

### Phase 1: Octree + Interval Arithmetic (Biggest Win)

1. **Add interval evaluator** — a parallel version of `evalCSGField` that takes
   interval inputs and returns interval outputs. Implement for each primitive and operator.

2. **Replace flat grid with octree in `meshField`** — instead of the triple loop over
   `(n+1)³`, build an octree that:
   - Evaluates intervals at each node
   - Prunes empty/filled nodes
   - Only samples corners at leaf nodes that straddle the surface
   - Feeds surviving leaf-cell corners into the existing surface nets algorithm

3. **Adaptive resolution** — the octree naturally gives higher effective resolution
   near surfaces and lower resolution in empty space, without increasing total work.

### Phase 2: Lipschitz Pruning for Simple Scenes

For scenes using only well-behaved primitives (no twist/bend/taper), use single-point
center evaluation + Lipschitz bound as a faster pruning test before falling back to
interval arithmetic.

### Phase 3: Tape Simplification (Later)

Build simplified closure trees per octree region. Most impactful for complex scenes
with many CSG operations.

## What We're NOT Doing (Yet)

- **JIT compilation** — Keeter's Fidget includes hand-written aarch64/x86_64 JIT.
  Way too complex for our JS context. The interpreter approach is fine.
- **GPU evaluation** — Keeter's MPR paper runs everything on CUDA. We're in a browser.
  WebGPU could be interesting someday but is not the first step.
- **SIMD batching** — Fidget evaluates 256 points simultaneously via AVX.
  JS doesn't give us that control, though TypedArrays help somewhat.

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
