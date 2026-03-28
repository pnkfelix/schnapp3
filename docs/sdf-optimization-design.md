# SDF Optimization: Current Architecture and Future Work

## Current State (as of March 2026)

The octree + interval arithmetic optimization is fully implemented and deployed.
This doc describes the current architecture and remaining optimization opportunities.

## Architecture Overview

```
AST (from codegen.js / expand.js)
 │
 ├─► evalCSGField(node)           → (x,y,z) → {polarity, distance, color}
 │     src/evaluator.js (main thread)
 │     src/csg-field.js (workers, pure computation)
 │
 ├─► evalCSGFieldInterval(node)   → (xIv, yIv, zIv) → {distance: [lo,hi], polarity: [lo,hi]}
 │     src/interval-eval.js
 │     uses src/interval.js for arithmetic
 │
 ├─► buildOctree(intervalField, bounds, maxDepth)  → leaf list
 │     src/octree-core.js
 │
 ├─► meshOctreeLeavesRaw(leaves, pointField, bounds, depth, colorField)  → raw mesh
 │     src/octree-core.js
 │
 ├─► meshFieldRaw(field, bounds, resolution, colorField)  → raw mesh  (flat grid fallback)
 │     src/surface-nets.js (Three.js-free) and src/octree-core.js (worker copy)
 │
 └─► GPU path: compileTape(ast) → gpuDispatchTape(tape, bounds, resolution)
       src/gpu-tape.js, src/gpu-engine.js, src/gpu-sdf.wgsl, src/gpu-sdf-sparse.wgsl
```

### File inventory

| File | Lines | Role |
|------|-------|------|
| `src/interval.js` | 153 | Core interval arithmetic operations |
| `src/interval-eval.js` | 544 | AST → interval field evaluator |
| `src/octree-core.js` | 306 | Octree build + sparse surface-nets meshing (pure computation) |
| `src/octree-mesh.js` | 21 | Three.js wrapper for octree meshing |
| `src/csg-field.js` | 436 | Point field evaluator (pure computation, worker-safe) |
| `src/progressive.js` | 190 | Multi-resolution progressive refinement via Web Workers |
| `src/mesh-worker.js` | 105 | Web Worker for background octree + meshing |
| `src/gpu-engine.js` | 1068 | WebGPU dispatch engine |
| `src/gpu-tape.js` | 442 | AST → linear tape compiler for GPU |
| `src/gpu-tape-eval.js` | 404 | CPU tape evaluator (reference impl) |
| `src/gpu-sdf.wgsl` | 527 | WGSL compute shader (uniform grid) |
| `src/gpu-sdf-sparse.wgsl` | 404 | WGSL compute shader (sparse octree-guided dispatch) |
| `src/surface-nets.js` | 153 | Flat-grid surface nets (original, refactored to raw+geometry split) |

### How evaluation works now

1. `meshCSGNode()` in `evaluator.js` builds both a point field (`evalCSGField`) and
   an interval field (`evalCSGFieldInterval`).

2. If `useOctree` is enabled (default), it calls `buildOctree()` with the interval field.
   - Octree does a two-phase bailout: shallow probe to depth 3, bail to flat grid if
     culling rate < 10%.
   - If octree succeeds, `meshOctreeLeaves()` meshes only the leaf cells.
   - If octree bails out, falls back to `meshField()` (flat grid).

3. For the solid mesh, `solidIntervalField` wraps the interval evaluator to handle
   polarity straddling — when the polarity interval spans both solid and non-solid,
   the distance interval is forced to span zero to prevent incorrect culling (PR #57).

4. Progressive refinement (`src/progressive.js`) spawns workers at multiple octree
   depths for instant feedback → refined result.

5. When WebGPU is available, `src/gpu-engine.js` can evaluate the SDF on the GPU via
   a tape-based compute shader, with either uniform grid or sparse dispatch.

## Known Issues and Limitations

### Interval overestimation for domain warps
Twist, bend, taper, and radial operators produce conservative (wide) intervals.
In regions dominated by these operators, the octree degrades toward brute-force.
The bailout heuristic catches the worst cases, but there may be room for tighter
warp-specific interval bounds.

### No tape simplification
The current interval evaluator evaluates the full AST for every octree node.
For scenes with many shapes in a union, most shapes are irrelevant to any given
spatial region. Tape simplification (pruning dead subtrees during interval eval)
would give the biggest remaining speedup for complex scenes.

### Resolution rounding
`resToDepth(resolution)` rounds up to the next power of 2 via `ceil(log2(n))`.
Resolution 48 → depth 6 → effective resolution 64. This is generally fine (equal
or better quality) but means the user's resolution slider maps non-linearly to
actual grid size.

## Future Optimization Opportunities

### 1. Tape Simplification (Biggest Remaining Win)

During interval evaluation of `min(A, B)`, if A's interval is entirely below B's,
B's subtree is dead code for that region. Create a simplified evaluator that omits it.

**Approach for closure-tree evaluator:**
- `evalCSGFieldInterval` already evaluates min/max with known-winner detection.
- When a winner is known, return both the interval result and a "simplified" point
  evaluator closure that skips the losing subtree.
- Pass the simplified closure to child octree nodes.
- Keeter reports 10-200x tape reduction in practice.

**Approach for tape-based evaluator (GPU path):**
- After interval eval of a tape instruction, mark dead instructions.
- Copy only live instructions into a shortened tape for the sub-region.
- This is closer to Keeter's original design (Fidget does exactly this).

### 2. Lipschitz Pruning for Simple Scenes

For SDFs with |∇f| ≤ 1 (sphere, cube, cylinder, translate), evaluate `f` at the
region center. If `|f(center)| > half_diagonal`, the region is entirely inside or
outside.

- Cheaper than interval evaluation (one point eval vs. full interval eval).
- Only valid when all transforms preserve the Lipschitz bound.
- Could be used as a fast pre-check before interval eval.
- Twist/bend/taper break the bound; need per-node Lipschitz tracking.

### 3. SIMD-style Batching

Evaluate multiple points simultaneously using TypedArray operations. The flat arrays
in `meshOctreeLeavesRaw` are already structured for this. A batch evaluator could
process all leaf-cell corners in bulk rather than one at a time.

### 4. Adaptive Resolution

The octree already provides natural adaptivity — fine cells near surfaces, nothing
in empty space. A further step would be multi-resolution leaves: coarser cells in
low-curvature regions, finer cells at sharp features. This would require dual
contouring or a similar feature-preserving meshing algorithm.
