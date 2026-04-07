# Incremental Scene Graph with Dependency Tracking

Design plan for replacing the rebuild-from-scratch evaluation pipeline with a
persistent, incrementally-maintained scene graph that tracks block dependencies
and exposes rich provenance for bidirectional UI highlighting.

---

## Motivation

### The performance problem

Every block edit (param change, add, delete, move) triggers a full pipeline run:

```
blocks → codegen → expand → evaluate → new Three.js Group → viewport.setContent()
                                                                  ↓
                                                      dispose old scene graph entirely
```

CSG meshing (surface-nets + octree) dominates: 50–500ms per subtree at typical
resolutions.  For a model with 5 independent CSG branches, editing one branch
re-meshes all 5.

### The inspectability problem

The Three.js scene graph is an ephemeral byproduct — built, rendered, destroyed,
rebuilt.  There is no persistent intermediate structure the user can inspect or
query.  The only feedback loop is: source blocks ↔ final rendered pixels.

Today's provenance is lossy:
- `stampProvenance()` stores a single `blockId` per vertex.
- `csgUnion` picks the closest child's blockId; runners-up are discarded.
- `csgIntersect` picks the max-distance child's blockId.
- **Fuse already computes per-child softmin weights** for color blending,
  then throws them away for provenance — keeping only the argmax winner.
- Tap handler reads one face vertex's blockId and highlights one block.

### The goal

A persistent scene graph where:
1. Unchanged subtrees stay in place across edits (performance).
2. Every scene graph node knows which blocks feed it (dependency tracking).
3. Provenance is multi-source with influence weights (rich UI).
4. Click pixel → highlight all contributing blocks (by influence weight).
5. Click block → highlight all geometry it flows to.

---

## Architecture Overview

Three phases, each delivering independent value:

```
Phase 1: Persistent scene graph + dependency-driven invalidation
Phase 2: Rich multi-source provenance in SDF field evaluation
Phase 3: Bidirectional UI (pixel↔block highlighting, geometry inspector)
```

---

## Phase 1: Persistent Scene Graph

### Core idea

**The scene graph IS the cache.**  Instead of maintaining a separate cache Map
and cloning groups in/out, keep the live Three.js scene graph across edits.
When a block changes, re-evaluate only the affected subtrees and surgically
replace them in the live scene.

### Data structures

**Two-layer architecture (BDD analogy):**

The caching system has two layers, analogous to a BDD's unique table +
operation cache:

| Layer | Addressing | Purpose | Analogy |
|-------|-----------|---------|---------|
| Scene registry + dep graph | Identity (blockId) | Know what to invalidate | BDD operation cache |
| Mesh memo table | Content (AST hash) | Reuse previously-computed geometry | BDD unique table |

The dependency graph answers "what changed?"  The memo table answers "have I
seen this content before?"  These compose:

```
Block X edited
  │
  ├─ Dependency graph (identity-based):
  │    "subtrees rooted at block_3 and block_7 need re-evaluation"
  │    (O(1) lookup via reverse index, no hashing)
  │
  └─ For each invalidated subtree:
       ├─ Re-generate AST for subtree (cheap)
       ├─ Hash the new AST → check memo table (content-addressed)
       │    ├─ HIT → reuse cached mesh (undo, shared structure)
       │    └─ MISS → mesh from scratch, store in memo table
       └─ Swap result into scene graph
```

Like BDD hash-consing, the memo table enables sharing across both **space**
(two branches with identical `intersect(cube 20, sphere 15)` share one mesh)
and **time** (changing a param from 25→26→25 finds the original mesh in the
memo table on the way back).

Content hashing of AST subtrees is O(subtree size), which is only paid for
invalidated subtrees — the dependency graph already narrowed down which
subtrees need re-evaluation.  For unchanged subtrees, no hashing occurs.

**Scene registry:** `Map<blockId, SceneEntry>`

```js
// Each meshCSGNode call produces a SceneEntry
{
  blockId: string,            // root block of the subtree that was meshed
  threeObject: THREE.Object3D, // the live scene graph node
  deps: Set<string>,          // all blockIds in the meshed subtree
  contentHash: string,        // hash of the AST subtree (for memo table)
  resolution: number,         // csgResolution when this was meshed
}
```

**Reverse dependency index:** `Map<blockId, Set<blockId>>`

Maps each block to the set of scene entries (by root blockId) that depend on it.
When block X is edited, `depsIndex.get(X)` gives all entries to invalidate.

**Mesh memo table:** `Map<contentHash, THREE.Group>`

Content-addressed cache of meshCSGNode results.  The hash is computed from the
AST subtree structure (type, params, children — excluding non-enumerable
`_blockId`).  Entries survive across invalidation cycles: when a subtree is
invalidated and re-evaluated, the new AST is hashed and checked against the
memo table before meshing.

Memo table entries need reference counting or LRU eviction since they persist
across scene graph rebuilds.  A simple approach: cap at N entries, evict oldest
on overflow.

### How `notify(changedBlockId)` flows

**Param edit** (changedBlockId is defined):
1. `invalidateCache(changedBlockId)` → find affected scene entries via reverse
   index.  Mark them as stale (don't delete yet — the memo table may rescue them).
2. Re-run codegen + expand (cheap, <5ms) to get the new AST.
3. In `evaluate()`, when `evalNode` reaches a meshCSGNode call:
   - If entry exists in scene registry AND is **not stale** → skip meshing,
     reuse the existing Three.js object directly.
   - If entry is **stale or missing** → hash the AST subtree → check memo table:
     - **Memo hit** → clone the memo'd mesh, swap into scene, update registry.
       (This handles undo and shared subexpressions.)
     - **Memo miss** → mesh from scratch, store in memo table, swap into scene,
       update registry.
4. `viewport.patchContent(diff)` instead of `viewport.setContent(newGroup)`.

**Structural change** (changedBlockId is undefined):
1. Clear entire scene registry + reverse index.
2. Memo table is **NOT cleared** — structural changes (add/delete/move blocks)
   produce new AST subtrees that may match previously-computed content.
3. Full re-evaluate.  Each meshCSGNode call checks the memo table by content hash.
   Subtrees that happened to exist in a previous state get instant hits.

### Union splitting (prerequisite)

For the scene registry to work, each CSG subtree must get its own independent
`meshCSGNode` call.  Today, `union` with CSG children sends the entire union
to one `meshCSGNode` call.

**Change:** When `evalNode` processes a `union` whose children need field eval,
evaluate each child independently via `evalNode` (each child handles its own
CSG meshing).  Fall back to joint meshing only when `anti`/`complement` are
**direct** children of the union (their polarity must interact with siblings
via `csgUnion`'s polarity summation).

This is correct because:
- Anti/complement deeply nested inside a child are handled by that child's
  own `meshCSGNode` call.  Negative polarity doesn't "leak" out of an intersect
  or fuse to affect sibling branches.
- Only direct anti/complement children of a union participate in cross-sibling
  polarity cancellation.

### Collecting dependencies

Walk the AST subtree passed to `meshCSGNode` and collect all `_blockId`
annotations:

```js
function collectBlockIds(node, ids) {
  if (!node || !Array.isArray(node)) return;
  if (node._blockId) ids.add(node._blockId);
  for (let i = 1; i < node.length; i++) {
    const v = node[i];
    if (Array.isArray(v)) collectBlockIds(v, ids);
    else if (v && typeof v === 'object') {
      for (const pv of Object.values(v))
        if (Array.isArray(pv)) collectBlockIds(pv, ids);
    }
  }
}
```

This is O(subtree size) which is negligible compared to meshing.  It's
equivalent to Salsa-style automatic dependency tracking for this specific
case because the AST structure directly encodes the data flow.

**Limitation:** After `expandAST`, synthetic nodes (from let/var substitution,
enzyme reactions) may lack `_blockId`.  For models using PL constructs, the
dependency set may be incomplete.  Conservative fallback: if `expandAST`
detects PL constructs, mark all cache entries as "PL-tainted" and invalidate
them on any change.  This is still a win for the common case (no PL).

### viewport.patchContent

Replace the current `setContent(newGroup)` with a method that can surgically
update the scene:

```js
patchContent(patches) {
  // patches: array of { oldObject, newObject }
  for (const { oldObject, newObject } of patches) {
    const parent = oldObject.parent;
    const idx = parent.children.indexOf(oldObject);
    parent.children[idx] = newObject;
    newObject.parent = parent;
    // Dispose old
    oldObject.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }
}
```

For a full rebuild (structural change), fall back to `setContent`.

### Benchmark command

`bench cache` command:
- Uses representative models with 2, 3, and 5 CSG branches under a union.
- Evaluates the model once (cold), then tweaks one branch's param and evaluates again.
- Measures: cold eval time, warm eval time (with cache), uncached eval time (cache cleared).
- Reports speedup ratio = uncached / cached.

### Files to modify (Phase 1)

| File | Changes |
|------|---------|
| `src/blocks.js` | `notify(changedBlockId)` — already done in WIP |
| `src/evaluator.js` | Scene registry, reverse index, `collectBlockIds`, invalidation logic, union split, `meshCSGNode` cache lookup/store |
| `src/main.js` | Pass `changedBlockId` through pipeline, call `patchContent` vs `setContent` |
| `src/viewport.js` | Add `patchContent` method alongside existing `setContent` |

---

## Phase 2: Rich Multi-Source Provenance

### Core idea

Expand the SDF field return type to carry an **influence list** instead of a
single blockId.  Capture all contributing sources with weights at CSG
combination points.

### Field return type change

Current:
```js
{ polarity: number, distance: number, color: [r,g,b], blockId: string|null }
```

Proposed:
```js
{
  polarity: number,
  distance: number,
  color: [r,g,b],
  blockId: string|null,           // primary (backward compat)
  influences: [{blockId, weight}, ...] | null  // new: all contributors
}
```

`influences` is `null` by default (leaf nodes, transforms — single source).
Populated by combination operations:

### Where influences are captured

**Fuse (smooth-min):**  Already computes `weights` array via log-sum-exp.
Currently discarded after color blending.  Change: also store as `influences`.

```js
// In fuse case of evalCSGField:
const influences = [];
for (let i = 0; i < results.length; i++) {
  if (weights[i] > 0.01) {  // threshold to avoid noise
    influences.push({ blockId: results[i].blockId, weight: weights[i] });
  }
}
return { polarity, distance: dist, color, blockId: bestBlockId, influences };
```

**Union:**  At blend boundaries, multiple children are nearly equidistant.
Capture runner-up:

```js
// In csgUnion:
// Sort by distance, keep top 2 (or all within some epsilon)
const influences = results
  .filter(r => r.blockId && r.distance < best.distance + epsilon)
  .map(r => ({ blockId: r.blockId, weight: 1 / (1 + r.distance - best.distance) }));
```

**Intersect:**  All children constrain the result.  All are influential:

```js
// In csgIntersect:
const influences = results
  .filter(r => r.blockId)
  .map(r => ({ blockId: r.blockId, weight: 1 / (1 + Math.abs(r.distance)) }));
```

### stampProvenance upgrade

Current: stores `blockIds: string[]` (one per vertex).
Change: store `influences: Array<Array<{blockId, weight}>>` (list per vertex).

For memory efficiency, only store multi-source influences for vertices near
blend boundaries.  For vertices deep inside a single shape, keep the compact
single-blockId form.

### Performance consideration

The `influences` array allocations add GC pressure during field evaluation.
This is acceptable because:
- Influences are only populated at combination nodes, not leaves.
- Most evaluations (grid sampling) are dominated by SDF math, not allocation.
- For the octree path, only leaf cells near surfaces are sampled densely.

If allocation becomes a bottleneck, we can use a pooled array strategy or
only enable influence tracking when the inspector is open.

### Files to modify (Phase 2)

| File | Changes |
|------|---------|
| `src/evaluator.js` | `evalCSGField` fuse/union/intersect cases; `csgUnion`; `csgIntersect`; `stampProvenance` |
| `src/eval/sdf-field.js` | If any field evaluation helpers need the new return shape |

---

## Phase 3: Bidirectional UI

### Pixel → Blocks (click to discover sources)

1. Raycast hit → get face vertices.
2. Read per-vertex `influences` (from Phase 2's upgraded stampProvenance).
3. Interpolate/merge influences across the face's three vertices.
4. Highlight all contributing blocks in the workspace panel.
5. Intensity of highlight proportional to influence weight.

UI: blocks glow brighter the more they contributed.  A fuse of two shapes
would highlight both source primitives — brighter for the dominant one,
dimmer for the secondary.

### Block → Geometry (click to see where it goes)

1. User selects a block in the workspace.
2. Look up the block's ID in the reverse dependency index (from Phase 1).
3. Find all scene entries that depend on this block.
4. Highlight those meshes in the 3D viewport.
5. Optionally: for CSG meshes, use per-vertex influences to show a spatial
   heatmap of where this block has the most geometric influence.

UI: selecting a cube block could paint the viewport with a heatmap showing
where the cube's SDF is closest to the final surface.

### Geometry inspector panel

A new UI panel showing the intermediate scene graph structure:

```
Scene
  ├─ [CSG mesh] intersect (block_3)
  │    deps: block_3, block_5, block_8
  │    vertices: 12,450  faces: 24,896
  │    mesh time: 85ms
  ├─ [CSG mesh] fuse (block_12)
  │    deps: block_12, block_15, block_17
  │    vertices: 8,200  faces: 16,398
  │    mesh time: 120ms
  └─ [Group] translate (block_20)
       └─ [Mesh] cube (block_21)
```

Clicking an entry highlights the corresponding geometry and source blocks.
This makes the intermediate constructed geometry directly visible and
navigable.

### Files to modify (Phase 3)

| File | Changes |
|------|---------|
| `src/viewport.js` | Tap handler reads influence data, multi-block highlight API |
| `src/blocks.js` | Multi-block highlight with per-block intensity |
| `index.html` | Geometry inspector panel DOM |
| `style.css` | Inspector panel styling, multi-intensity highlight colors |
| `src/main.js` | Wire block selection → viewport highlight, inspector updates |

---

## Implementation Order

### Phase 1 step-by-step

1. **Union split in evalNode** (already done in WIP).

2. **Scene registry + reverse index** in evaluator.js.
   Replace the current WIP Map-based cache with a scene registry that holds
   live Three.js objects (not clones).

3. **meshCSGNode cache lookup:** At the top of `meshCSGNode`, check if a
   valid (non-invalidated) scene entry exists for `node._blockId`.  If so,
   return the existing Three.js object directly (no clone needed — it's
   already in the scene).

4. **meshCSGNode cache store:** After meshing, register the new entry:
   collect deps via `collectBlockIds`, store in registry, update reverse index.

5. **evaluate() orchestration:** `evaluate(ast, changedBlockId)` invalidates
   affected entries, then walks the AST.  For unchanged subtrees, `evalNode`
   returns the existing scene object.  For changed subtrees, `evalNode`
   returns a new object.

6. **Patching vs. replacing:** After `evaluate()` returns, diff the old scene
   graph against the new one.  For Phase 1 MVP, this can be simple:
   - If `changedBlockId` is defined (param edit), use `patchContent`.
   - If undefined (structural change), use `setContent` (full replace).

7. **Benchmark:** `bench cache` command using representative multi-branch models.

### Phase 1 key invariant

**The scene registry and the live scene graph are always in sync.**  Every
Three.js object returned by `meshCSGNode` is either:
- A newly-created object (cache miss) that gets registered, or
- An existing registered object (cache hit) that stays in place.

The `dispose` cycle only happens for invalidated entries: the old object is
removed from the scene, disposed, and replaced by a freshly-meshed one.

### Subtlety: re-evaluation returns existing objects

When `evalNode` hits a cached subtree, it returns the *same* Three.js object
that's already in the scene.  The caller (`evaluate()`) must not add it to
a new Group — it's already parented.  This requires `evaluate()` to
understand that some children are "retained" (already in scene) vs "new"
(freshly created).

**Simplification for Phase 1 MVP:** Instead of returning existing objects from
`evalNode`, always build a new top-level Group but reuse cached meshes by
*moving* them (reparenting) from the old scene to the new one.  Then
`setContent` disposes only objects that weren't reused.  This avoids the
complexity of a true scene-graph diff while still skipping the expensive
`meshCSGNode` work.

```js
// In viewport.js:
setContent(newGroup, retainedObjects) {
  scene.remove(contentGroup);
  contentGroup.traverse(obj => {
    if (retainedObjects && retainedObjects.has(obj)) return; // don't dispose
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  contentGroup = newGroup;
  scene.add(contentGroup);
}
```

### What "dependency tracking" buys us concretely

Consider this model with 5 CSG branches at resolution 96:

```
union
  intersect(A, B)         ← 120ms to mesh
  translate(fuse(C, D))   ← 150ms to mesh
  translate(intersect(E, anti(F)))  ← 100ms to mesh
  fuse(G, H)              ← 130ms to mesh
  translate(mirror(I))    ← 90ms to mesh
```

**Without cache:** Every param edit re-meshes all 5 branches.  ~590ms.

**With dependency tracking:** Editing block A invalidates only the first
branch (A is in its dep set).  The other 4 branches are cache hits.
Re-mesh time: ~120ms + ~4ms (reuse overhead) = ~124ms.  **~4.8x speedup.**

The reverse index lookup is O(1) per block.  Invalidation walks only the
affected entries.  No JSON.stringify, no content hashing.

---

## Relationship to BDDs, Salsa, and Incremental Computation

### BDD analogy

The two-layer cache architecture mirrors BDD data structures:

- **Memo table ≈ BDD unique table.**  Content-addressed: two structurally
  identical AST subtrees map to the same cached mesh.  Enables sharing across
  space (identical sibling subtrees) and time (undo, parameter cycling).

- **Scene registry ≈ BDD operation cache.**  Identity-addressed: tracks which
  live scene graph nodes correspond to which block subtrees, and what their
  dependencies are.

Like BDD hash-consing, the memo table gives us structural sharing for free.
Unlike BDDs, our "nodes" are expensive to compute (50–500ms of meshing), so
the cache hit rate matters enormously.

**PL constructs and BDD variable ordering:** The stir/enzyme system uses
string-based tags for pattern matching.  For a true BDD-like canonical form
over enzyme reactions, tags would need to be normalized to numeric indices
(analogous to BDD variable ordering).  This is out of scope for Phase 1 but
would be relevant if we ever want canonical forms for expanded ASTs containing
PL constructs.  Without normalization, two structurally equivalent enzyme
expressions with different tag names would hash differently and miss in the
memo table.

### Salsa

This design also borrows two key ideas from Salsa:

1. **Dependency tracking:** Each "query" (meshCSGNode call) records its inputs
   (the block IDs in its subtree).  When an input changes, only queries that
   depend on it are re-executed.

2. **Memoization with invalidation:** Query results are cached and reused until
   their dependencies change.

What we **don't** do (and why):

- **Automatic dependency recording during execution:** Salsa uses tracked
  database accesses.  We use explicit AST-walking (`collectBlockIds`).
  This is equivalent for our case because the AST structure IS the
  dependency graph — there are no dynamic dependencies that emerge at
  runtime.  Exception: PL constructs (let/var/stir/enzyme) introduce
  dynamic data flow; see the PL limitation note in Phase 1.

- **Layered memoization:** Salsa memoizes every intermediate query.  We only
  memoize `meshCSGNode` (the expensive step).  Codegen and expand together
  are <5ms, so memoizing them buys nothing measurable.

- **Early cutoff:** Salsa re-executes a query and checks if the output
  changed; if not, dependents are not invalidated.  We skip this because
  CSG meshing is non-deterministic at the floating-point level (surface-nets
  vertex placement), so "same output" checks are unreliable.

---

## Current State (WIP)

As of the current commit on `claude/cache-block-subtrees-kSaZb`:

**Done:**
- `notify(changedBlockId)` in blocks.js — param edits pass blockId,
  structural changes pass undefined.
- Union split in evalNode — CSG children evaluated independently unless
  direct anti/complement children present.
- Cache infrastructure in evaluator.js — subtreeCache, depsIndex,
  collectBlockIds, invalidateCache, deepCloneGroup.  **Not yet wired into
  meshCSGNode.**

**Next steps:**
- Wire cache into meshCSGNode (lookup + store).
- Modify viewport.js setContent to accept retained objects.
- Add bench cache command.
- Test and measure.

**Previous approach (v1, preserved on branch):**
`claude/cache-block-subtrees-kSaZb-v1-content-hash` — used JSON.stringify
content hashing as cache keys.  Abandoned because: O(tree size) key
computation, no dependency tracking, doesn't enable the richer Phase 2/3
goals.
