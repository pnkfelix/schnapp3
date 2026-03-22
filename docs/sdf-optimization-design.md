# SDF Optimization Design: Octree + Interval Arithmetic for Schnapp3

## Goal

Replace the brute-force `(n+1)³` grid sampling in `meshField()` with octree-based
adaptive evaluation using interval arithmetic. This skips large empty/filled regions
and focuses computation on the thin shell near surfaces.

Expected speedup: 10-100x for typical scenes at resolution 48-192, with the biggest
wins at higher resolutions and for scenes with lots of empty space.

## Current Architecture

```
evalCSGField(node) → closure: (x,y,z) → {polarity, distance, color}
                              ↓
meshCSGNode(node) calls meshField(solidField, bounds, resolution, colorField)
                              ↓
meshField: triple loop over (n+1)³ grid → Float32Array → surface nets
```

**Key files:**
- `src/evaluator.js` — `evalCSGField()` builds closure tree, `meshCSGNode()` meshes it,
  `estimateBounds()` computes bounding box from AST
- `src/surface-nets.js` — `meshField(field, bounds, resolution, colorField)` does the
  grid sampling and surface-net mesh extraction

**Current evaluator structure:** `evalCSGField` recursively walks the AST and returns a
closure `(x,y,z) → {polarity, distance, color}`. Each node type (sphere, cube, cylinder,
translate, union, intersect, fuse, mirror, twist, radial, stretch, tile, bend, taper, paint,
recolor, anti, complement) has a case that builds a closure composing child closures.

There's also a legacy `evalField` that returns `(x,y,z) → distance` (no polarity/color).

## Design

### New file: `src/interval.js`

A small module that provides interval arithmetic and an interval-evaluator for the AST.

#### Interval representation

A 2-element array `[lo, hi]` where `lo <= hi`. This is the simplest representation
and avoids object allocation overhead.

#### Interval math operations

```js
// Core operations needed by our SDF primitives:
function iAdd(a, b)      // [a[0]+b[0], a[1]+b[1]]
function iSub(a, b)      // [a[0]-b[1], a[1]-b[0]]
function iMul(a, b)      // [min(products), max(products)]
function iNeg(a)          // [-a[1], -a[0]]
function iAbs(a)          // handles span-zero case
function iSqrt(a)         // [sqrt(max(0,a[0])), sqrt(a[1])]
function iMax(a, b)       // [max(a[0],b[0]), max(a[1],b[1])]
function iMin(a, b)       // [min(a[0],b[0]), min(a[1],b[1])]
function iSq(a)           // square, careful with span-zero
function iConst(c)        // [c, c]
```

#### Interval SDF evaluator

```js
export function evalIntervalField(node)
// Returns: (xI, yI, zI) → [dLo, dHi]
// where xI, yI, zI are [lo, hi] intervals
```

This mirrors `evalCSGField` but operates on intervals. Each primitive and transform
gets an interval version. We only need the distance component for octree pruning
(not polarity or color).

**Primitive interval SDFs:**

- **Sphere** `sqrt(x²+y²+z²) - r`:
  ```
  iSub(iSqrt(iAdd(iAdd(iSq(xI), iSq(yI)), iSq(zI))), iConst(r))
  ```

- **Cube** (box SDF): interval version of `outside + inside` where
  `qx = abs(x) - s`, etc.
  ```
  qxI = iSub(iAbs(xI), iConst(s))
  // outside = sqrt(max(qx,0)² + max(qy,0)² + max(qz,0)²)
  // inside = min(max(qx, qy, qz), 0)
  ```

- **Cylinder**: combine radial distance and height distance, same pattern as cube.

**Transform interval SDFs:**

- **translate**: shift intervals: `evalChild(iSub(xI, iConst(tx)), ...)`
- **mirror**: `iAbs` on the mirrored axis interval
- **union**: `iMin` of children's intervals
- **intersect**: `iMax` of children's intervals
- **complement**: `iNeg` of child interval
- **anti**: same interval as child (anti doesn't change distance)
- **paint/recolor**: transparent, pass through to child
- **fuse (smooth min)**: conservative bound — `iMin` of children minus `iConst(k)`
  (smooth min is always ≤ min, and the difference is bounded by k)
- **stretch**: evaluate child at inverse-scaled intervals, multiply result by minScale
- **twist**: conservative — evaluate child interval, widen by cross-section radius
  (twist rotates cross-section, so the interval must cover all rotated positions)
- **radial**: conservative — similar to twist, the interval must cover the full
  radial extent
- **tile**: the interval covers all tiles, so evaluate child with wrapped interval
  (conservative: use full [-spacing/2, spacing/2] for the tiled axis)
- **bend**: conservative — expand intervals based on bend radius
- **taper**: conservative — expand cross-section intervals by max scale factor

**Conservative approximation is fine.** Interval arithmetic overestimates ranges.
The worst case is that we subdivide a node that could have been pruned — we never
miss geometry. For complex transforms (twist, bend, taper), being conservative just
means less pruning in those regions, falling back toward brute-force locally.

### Modified file: `src/surface-nets.js`

Replace the flat grid in `meshField` with an octree.

#### New `meshField` signature (backward compatible)

```js
export function meshField(field, bounds, resolution, colorField = null, intervalField = null)
```

The new optional `intervalField` parameter is `(xI, yI, zI) → [dLo, dHi]`.
When provided, the function uses octree evaluation. When null, it falls back to
the existing flat-grid behavior (no regression risk).

#### Octree algorithm

```
function octreeSubdivide(bounds, depth, maxDepth, intervalField):
    xI = [bounds.minX, bounds.maxX]
    yI = [bounds.minY, bounds.maxY]
    zI = [bounds.minZ, bounds.maxZ]

    [dLo, dHi] = intervalField(xI, yI, zI)

    if dLo > 0:  return EMPTY   // entirely outside surface
    if dHi < 0:  return FILLED  // entirely inside surface

    if depth >= maxDepth:
        return LEAF  // sample corners, run surface nets on this cell

    // Ambiguous: subdivide into 8 children
    split bounds at midpoint on each axis
    recurse on each child octant
```

**maxDepth** is derived from the resolution: `maxDepth = ceil(log2(resolution))`.
At resolution 48, maxDepth ≈ 6 (64 effective). At resolution 192, maxDepth ≈ 8 (256).

**Leaf processing:** When a leaf node is ambiguous (surface passes through), we sample
its 8 corners using the point-evaluation `field` function, check for sign changes,
and emit surface-net vertices+faces exactly as the current code does — just for this
one cell instead of the entire grid.

**Key implementation detail:** Surface nets needs to connect vertices across adjacent
cells. In the flat grid, adjacency is implicit (index arithmetic). In the octree, we
need to track which leaf cells are adjacent. Two approaches:

1. **Sparse grid approach (recommended):** Allocate a flat grid at the leaf resolution
   but only populate cells that the octree identifies as ambiguous. Use the existing
   surface-nets code on this sparse grid. Empty/filled cells naturally have no sign
   changes so they produce no vertices — the surface-nets algorithm handles them
   correctly already (the `if (!hasNeg || !hasPos) continue` check on line 51).

   This means: after octree traversal, we have a set of "active" cells. We sample
   field values at corners of active cells (and their immediate neighbors, to get
   sign-change detection on cell boundaries). Then run the existing surface-nets
   loop, which will naturally skip all the empty cells.

   **Advantage:** Minimal code change. The surface-nets algorithm is unchanged.
   We just pre-populate the grid more efficiently.

2. **Direct octree meshing:** Build mesh connectivity from the octree leaf structure.
   More complex, better for adaptive resolution (different-sized cells). Save for later.

**Recommended: Approach 1 (sparse grid).** It's the smallest change that gets the
biggest win. The octree determines *which* grid cells to sample; surface nets is
unchanged.

#### Concrete implementation plan for meshField

```js
export function meshField(field, bounds, resolution, colorField = null, intervalField = null) {
  if (!intervalField) {
    // Existing flat-grid code, unchanged
    return meshFieldFlat(field, bounds, resolution, colorField);
  }

  // Octree-accelerated path
  const n = resolution;
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const sz = (maxZ - minZ) / n;
  const gn = n + 1;

  // Grid of field values, initialized to NaN (unsampled)
  const grid = new Float32Array(gn * gn * gn).fill(NaN);

  // Octree traversal marks which cells need sampling
  const activeCells = new Uint8Array(n * n * n);  // 1 = needs sampling

  octreeMark(activeCells, intervalField, bounds, n, 0, 0, 0, n);

  // Sample field values only at corners of active cells
  for (let cz = 0; cz < n; cz++)
    for (let cy = 0; cy < n; cy++)
      for (let cx = 0; cx < n; cx++) {
        if (!activeCells[cx + cy*n + cz*n*n]) continue;
        // Sample all 8 corners of this cell (if not already sampled)
        for (const [dx,dy,dz] of cornerOffsets) {
          const gi = (cx+dx) + (cy+dy)*gn + (cz+dz)*gn*gn;
          if (isNaN(grid[gi])) {
            grid[gi] = field(minX + (cx+dx)*sx, minY + (cy+dy)*sy, minZ + (cz+dz)*sz);
          }
        }
      }

  // Fill un-sampled grid points with +1 (outside) so surface nets skips them
  for (let i = 0; i < grid.length; i++) {
    if (isNaN(grid[i])) grid[i] = 1;
  }

  // Run existing surface nets on the grid (unchanged)
  // ... (existing Phase 1 + Phase 2 code)
}

function octreeMark(activeCells, intervalField, bounds, n, cx, cy, cz, size) {
  // Compute interval bounds for this octree node
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  const sz = (maxZ - minZ) / n;

  const xI = [minX + cx*sx, minX + (cx+size)*sx];
  const yI = [minY + cy*sy, minY + (cy+size)*sy];
  const zI = [minZ + cz*sz, minZ + (cz+size)*sz];

  const [dLo, dHi] = intervalField(xI, yI, zI);

  if (dLo > 0 || dHi < 0) return;  // entirely outside or inside — skip

  if (size === 1) {
    // Leaf cell — mark as active
    activeCells[cx + cy*n + cz*n*n] = 1;
    return;
  }

  // Subdivide into 8 children
  const half = size / 2;
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        octreeMark(activeCells, intervalField, bounds, n,
                   cx + dx*half, cy + dy*half, cz + dz*half, half);
}
```

**Resolution constraint:** The octree subdivision requires `n` to be a power of 2.
We round up: `n = nextPow2(resolution)`. At resolution 48, n becomes 64. At 192,
n becomes 256. This slightly increases the grid size but the octree pruning more
than compensates.

### Modified file: `src/evaluator.js`

Minimal changes:

1. **Import** `evalIntervalField` from `src/interval.js`
2. **In `meshCSGNode`**: build the interval field alongside the point field, pass it
   to `meshField`:

```js
function meshCSGNode(node) {
  const res = csgResolution;
  const bounds = estimateBounds(node);
  const csgField = evalCSGField(node);
  const intervalField = evalIntervalField(node);  // NEW

  const solidField = (x, y, z) => { ... };  // unchanged
  const solidIntervalField = (xI, yI, zI) => {
    // For solid field: if polarity could be > 0, use distance interval
    // Conservative: just use the raw distance interval from the CSG field
    return intervalField(xI, yI, zI);
  };

  const solidGeo = meshField(solidField, bounds, res, solidColorField, solidIntervalField);
  // ... same for antiField
}
```

**Subtlety with polarity:** The `solidField` wraps the CSG field — it returns the
distance when polarity > 0, else `abs(distance) + 0.01`. For interval evaluation,
we can't easily wrap this because we don't know polarity over an interval. But we
can use a conservative approach: if the distance interval contains 0, the cell is
ambiguous and needs sampling regardless. The unwrapped distance interval is a valid
conservative bound for the solid field.

Actually, the cleanest approach: build `evalIntervalField` to return a distance
interval that works directly for the solid/anti split. Since `solidField` returns
`distance` when polarity > 0 and `abs(distance) + 0.01` when polarity ≤ 0, the
zero-crossing of `solidField` coincides with the zero-crossing of the original SDF
(where `distance = 0`). So the interval of the raw SDF distance is sufficient for
determining whether the surface passes through a region.

## Implementation Steps

### Step 1: Create `src/interval.js` with interval math + evaluator

- Implement all interval arithmetic operations
- Implement `evalIntervalField(node)` covering all node types
- Export `evalIntervalField`
- ~200-300 lines

### Step 2: Modify `src/surface-nets.js` to support octree mode

- Extract existing code into `meshFieldFlat` (or inline with a branch)
- Add `intervalField` parameter to `meshField`
- Implement `octreeMark` function
- When intervalField is provided: use octree to identify active cells,
  sample only those, then run surface nets on the sparse grid
- Round resolution up to power of 2 for octree
- ~100 lines of new code, existing surface-nets code unchanged

### Step 3: Wire it up in `src/evaluator.js`

- Import `evalIntervalField` from `./interval.js`
- In `meshCSGNode`, build interval field and pass to `meshField`
- ~5 lines changed

### Step 4: Test

Test via the deployed site (owner's workflow). Things to verify:
- Simple shapes (sphere, cube, cylinder) render identically
- CSG operations (union, intersect, anti, complement, fuse) work
- All domain warp operators (mirror, twist, radial, stretch, tile, bend, taper) work
- Paint/recolor colors are preserved
- Performance improvement is visible in the stats display

## Edge Cases and Risks

**Resolution rounding to power-of-2:** The effective resolution may be slightly higher
than requested (e.g., 64 instead of 48). The mesh quality should be equal or better.
Surface-nets vertex positions are interpolated from field values, so the mesh isn't
strictly grid-aligned anyway.

**Interval overestimation for complex transforms:** Twist, bend, taper intervals will
be conservative (wide). This means less pruning for those operators. Worst case: we
fall back to sampling every cell in the twisted region, which is no worse than today.

**NaN sentinel in grid:** We use NaN to mark un-sampled grid points, then fill with +1
before surface nets. This is safe because NaN values only appear at grid points that
the octree determined are in empty/filled regions. Setting them to +1 (outside) or -1
(inside) would both work — using +1 means the surface-nets sign-change check correctly
skips boundaries between un-sampled regions and actually-empty sampled regions.

**Anti-solid meshing:** `meshCSGNode` meshes both solid and anti-solid surfaces
separately. Both calls to `meshField` can use the same interval field (the raw
distance interval bounds both the solid and anti fields).

## What This Does NOT Change

- Block definitions, drag-and-drop, UI — untouched
- `codegen.js` — untouched
- AST format — untouched
- `viewport.js` — untouched
- `main.js` — untouched
- The `evalField` (legacy distance-only evaluator) — untouched
- The `evalCSGField` (point evaluator) — untouched
- `estimateBounds` — untouched (still used for initial bounding box)

## Future: Phase 2 — Tape Simplification

After octree + interval arithmetic is working, the next optimization is tape
simplification. During interval evaluation, when `min(A, B)` resolves to definitely
`A` (because A's interval is entirely below B's), we can create a simplified evaluator
that omits B's entire subtree for that spatial region.

This would involve changing `evalIntervalField` to return both the interval result
and a "simplified" point-evaluator closure. The octree would pass the simplified
closure to child nodes, so deeper evaluations use shorter closures.

This is most impactful for scenes with many CSG operations (union of many shapes),
where most shapes are far from any given spatial region.
