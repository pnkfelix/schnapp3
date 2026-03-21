# Schnapp3 Type System & Language Design Notes

Design decisions emerging from the scalar/solid distinction, collections, recursion,
and chemical bag semantics. This is a living document; not all of this is implemented.

## Notation

Throughout this document:
- `{field: Type}` — a **record type** description, e.g. `{x: scalar, y: scalar, z: scalar}`
- `{field: value}` — a **record value** (literal), e.g. `{x: 10, y: 0, z: 5}`
- `A -> B` — a function type from A to B (ASCII; `→` avoided as it's hard to type)
- `a` — a type variable (stands for any type)

**Application syntax**: this document uses function-call notation `f(a, b, c)`
throughout. The canonical runtime representation is S-expressions; translation is
mechanical:

```
f(a, b, c)   ↔   (f a b c)
sphere(20)   ↔   (sphere 20)
stir(sphere, 20)  ↔  (stir sphere 20)
```

Whether type annotations ever appear in the S-expression syntax is an open question.
If the system is fully type-inferred, these notations are documentation-only and never
written by users. If not, `->` is at least typeable.

---

## The Type Ladder

```
scalar                                    number, color
{field: Type, ...}                        bundle of named+typed values (record)
solid                                     a 3D shape; anti(x) and complement(x) are also solid
{field: Type, ...} -> solid               primitive constructor (e.g. sphere, cube, cylinder)
solid -> solid                            shape transformer (e.g. translate, warp)
(solid -> solid) -> solid -> solid        transformer transformer (e.g. menger_step)
```

All primitives produce finite solids. `anti` and `complement` also return `solid` — the
type does not distinguish finite from infinite shapes. See the CSG section for the
semantic difference and the invariant that keeps `anti` finite.

Each rung is a first-class value that can flow through the graph. Each function rung
consumes values of types listed above it.

Records are bundles of *any* named+typed values — fields can be scalars, solids,
transformers, or other records. Record types with different field names (or different
field types) are distinct types, even if they have the same number of fields. Field
names are part of the type. Examples:

```
-- types
{x: scalar, y: scalar, z: scalar}                   translation vector type
{left: solid, right: solid}                          a named pair of solids
{shape: solid, xform: solid -> solid}                mixed-type record
{position: {x: scalar, y: scalar, z: scalar},
 size: scalar}                                       nested record type

-- values
{x: 10, y: 0, z: 5}                                 a translation vector value
{left: cube{size: 20}, right: sphere{radius: 10}}    a named pair of solid values
```

This is already implicit in the current AST — the params dict `{x: 10, y: 0, z: 5}`
is a record value, and the evaluator already does named projection (`node[1].x`, etc.).

### Introducing `stir`

`stir` is an unordered reaction container — you drop values in and type-directed
reactions fire with no implied ordering. (The full treatment is in the
[`stir` section](#stir--the-general-reaction-container) below; introduced here because
it motivates why record field names matter.)

The simplest example: applying `sphere` to a scalar. All three of the following are
equivalent:

```
sphere(20)           -- traditional application
stir(sphere, 20)     -- stir, constructor first
stir(20, sphere)     -- stir, scalar first
```

All evaluate to `sphere{r: 20}`. Order does not matter in `stir`.

In the block UI, these look different even though they mean the same thing. Traditional
application renders the constructor with its hole pre-wired:

```
[sphere [r: 20]]
```

The `stir` form renders the constructor and its argument as peers inside the stir
container, with the hole shown explicitly waiting to be filled:

```
[stir [sphere [r: _]]  20]
```

The `_` is the unfilled hole in the block rendering. In the S-expression notation the
hole is implicit; in the block UI it is explicit — a visual slot that the `20` snaps
into regardless of where it sits in the stir container.

### Field names as routing keys

Record field names serve as **routing keys** that determine which constructor or
operator a value reacts with in a `stir`. Two records with different field names are
different types, even if they contain the same scalar values:

```
stir(sphere, cube, {r: 3}, {w: 4})
  → {r: 3}  matches sphere  by field name  →  sphere{r: 3}
  → {w: 4}  matches cube    by field name  →  cube{w: 4}
  → result: stir(sphere, cube)  →  union(sphere, cube)
```

No ambiguity, even with multiple constructors and multiple records simultaneously in
the stir. This is why named fields on unary constructors are not merely ceremonious —
a bare scalar `3` in the same stir would be ambiguous (which constructor claims it?),
but `{r: 3}` is unambiguous.

### Bare scalar sugar

As a convenience — either in the UI or in the operational semantics (TBD) — a bare
scalar may be accepted where a single-field record is expected, when there is exactly
one unambiguous destination in the stir. The scalar is implicitly wrapped:

```
stir(sphere, 20)  →  stir(sphere, {r: 20})  →  sphere{r: 20}
```

This is syntactic sugar only; the underlying routing is always by field name.

---

## CSG Operators

### The arithmetic

Each point in space carries a value in {−1, 0, +1}:
- **solid**: +1 at interior points, 0 outside
- **anti-solid**: −1 at interior points, 0 outside
- **empty**: 0 everywhere

The three operators are:

```
union(a, b)     = sgn(a + b)    -- sign of sum  ("or" for same sign, cancellation for opposite)
intersect(a, b) = a × b         -- multiplication (sign rules: −×− = +, +×− = −)
anti(a)         = −a            -- negation
```

Truth tables over {−1, 0, +1}:

```
union:              intersect:
  +1 ∪ +1 = +1        +1 ∩ +1 = +1   solid ∩ solid = solid
  +1 ∪  0 = +1        +1 ∩  0 =  0
  +1 ∪ −1 =  0        +1 ∩ −1 = −1   solid ∩ anti  = anti
   0 ∪ −1 = −1        −1 ∩ −1 = +1   anti  ∩ anti  = solid  ("two negatives")
  −1 ∪ −1 = −1         x ∩  0 =  0
```

`union` behaves like OR for same-sign inputs, but opposite signs cancel to empty.
`intersect` follows the sign rules of multiplication exactly.
`anti` distributes through both operators via De Morgan for `union`:
`anti(union(A, B)) = union(anti(A), anti(B))` — but note De Morgan does **not** hold
for `intersect` under this arithmetic; `union` and `intersect` are not duals here.

### Anti-solid propagation and associativity/commutativity

Anti-solids propagate freely through nested `union`s — they bubble up and subtract
from any solid they encounter, regardless of grouping. This is what preserves
associativity and commutativity of `union`:

```
union(union(A, anti(B)), C)
  = union(A, anti(B), C)     -- anti(B) propagates out
  = (A ∪ C) − B              -- same regardless of grouping  ✓
```

The "anti-residue" at `B − A` (the part of B not covered by any solid) floats free
and continues to subtract from solids further up the tree. This is the intended
behaviour, not a bug.

### Anti-solids are rendered

Anti-solids are **first-class rendered objects**, not an invisible intermediate step
in a computation. In the UI they appear ghostly: alpha-blended, and possibly with
inverted colours, to distinguish them visually from solid material. Their tags persist
and are meaningful — hovering over the ghost of an anti-solid reports its tags just
as hovering over a solid does.

This has a direct consequence for the two natural ways to express "A minus B":

**`union(A, anti(B))`** — soft subtraction:
```
A − B:   solid          (A's material, B subtracted)
A ∩ B:   empty          (cancellation)
B − A:   ghostly anti   (part of B extending beyond A, rendered translucent, tagged)
```
The full extent of B is visible. You see both what it removes from A and where it
reaches beyond A. The B−A ghost carries B's tags and is hoverable.

**`intersect(A, complement(B))`** — hard clip:
```
A − B:   solid
A ∩ B:   empty
B − A:   truly empty    (complement kills it; no anti-material, nothing to render)
```
The region beyond A is dead space. B's tags are not accessible there.

These are genuinely different operations with different visual and semantic consequences.
There is no case for a first-class `subtract` operator to unify them — the choice
between soft and hard subtraction is a deliberate design decision the user makes.

### Scoped subtraction (without complement)

To subtract B from A *only*, without the anti-residue propagating to affect other
solids, intersect the result with A. Since A = 0 outside its own extent, the
intersection zeroes out any residue:

```
intersect(union(A, anti(B)), A)
```

Step by step at each region:

```
              union(A, anti(B))    then ∩ A      result
A − B:        sgn(+1 +  0) = +1   × +1 = +1     solid   ✓
A ∩ B:        sgn(+1 + −1) =  0   × +1 =  0     empty   ✓
B − A:        sgn( 0 + −1) = −1   ×  0 =  0     zeroed  ✓
```

Result: exactly A − B, no leakage. Derivable from `anti` + `union` + `intersect`
alone — no `complement` required.

### Complement (separate, careful-use)

`complement` produces an infinite solid — not part of the standard toolkit but
has legitimate uses. Both `anti` and `complement` return `solid`; the distinction
is semantic, not reflected in the type:

```
anti(B)       = −1 inside B,  0 outside    finite,   bounded anti-material
complement(B) =  0 inside B, +1 outside    infinite, fills all space outside B
```

The safe use of `complement` is as an argument to `intersect`, which clips it back
to a finite result:

```
intersect(A, complement(B))   →  A − B (hard clip, finite)
```

Used with `union`, the result is infinite and generally not useful for 3D printing.

### Two kinds of negation: a two-component model

The polarity arithmetic ({−1, 0, +1} with sgn(+) and ×) and the SDF arithmetic (ℝ
with min/max) appear to use different operations for `union` and `intersect`. They
are reconciled by recognising that `anti` and `complement` are **two distinct unary
operations acting on two distinct components** of the same underlying value.

Each point in space carries a two-component value:

```
(polarity, distance)

polarity  ∈ {−1, 0, +1}    material charge: anti-solid / empty / solid
distance  ∈ ℝ               signed distance to this shape's own nearest surface,
                             independent of any other shapes (SDF convention: negative
                             inside, positive outside); CSG operators compose distance
                             fields via min/max
```

The two negations operate on different components:

```
anti(A)        = (−polarity,  distance)    flip charge, geometry unchanged  (finite)
complement(A)  = ( polarity, −distance)    flip geometry, charge unchanged  (infinite)
```

The binary operators compose each component independently:

```
union(A, B)     = (sgn(p_A + p_B),   min(d_A, d_B))
intersect(A, B) = (p_A × p_B,        max(d_A, d_B))
fuse(A, B, k)   = (sgn(p_A + p_B),   smin(d_A, d_B, k))
```

The polarity component uses the cancellation arithmetic throughout — solid ∪ anti
cancels to empty. The distance component uses the SDF lattice throughout — rendering
and smooth blending work directly on `distance` without involving `polarity` at all.
They do not interfere.

At render time, the `distance` component is handed directly to the raymarcher or mesh
extractor. The `polarity` component determines whether the result is emitted as solid
or anti-solid material (or discarded if zero). `complement` only appears implicitly
here: the rendering volume provides a natural bound, so an infinite `complement` is
safe at this stage.

### The invariant: polarity and distance are not independent

`polarity` and `distance` are **correlated**, not independent. The invariant is:

```
polarity ≠ 0  ⟹  distance ≤ 0
```

In other words: material charge (solid or anti-solid) only exists at or inside a
surface. Outside every object's geometry, polarity is 0 and the space is empty.

Why this must hold: if `anti(sphere)` carried polarity = −1 *outside* the sphere
(where d > 0), then:

```
union(anti(sphere), empty_space)
  polarity: sgn(−1 + 0) = −1      ← anti-material leaks into all of space
  distance: min(+d, ∞)  = +d
```

The anti-solid would flood infinite space with negative polarity — identical to
`complement` behaviour, which is exactly what we wanted to avoid. Holding the
invariant keeps `anti` finite and bounded.

The two components play different roles:
- `distance`: guides the renderer (raymarcher steps toward zero; mesh extractor
  finds the zero crossing). Works on ℝ with no reference to polarity.
- `polarity`: read only at surfaces (d ≈ 0) to determine material identity. Zero
  everywhere outside, so it never bleeds.

The anti-residue propagation described in [Anti-solid propagation and associativity/commutativity](#anti-solid-propagation-and-associativitycommutativity)
is a propagation *within nested union expressions* (during evaluation), not a field
that extends outward in space. Once evaluated, the invariant holds for the result.

---

## Bag Semantics and Chemical Reactions

Inspired by the Chemical Abstract Machine (CHAM, Berry & Boudol 1992): values float
in a bag and react according to typed rules. Reactions fire non-deterministically, so
the system is only meaningful for **confluent** (order-independent) reactions.

### Runtime values with observable substructure

The tag/provenance design (see [`stir` section](#stir--the-general-reaction-container))
settles this question in one direction: CSG expressions are **runtime values with
observable substructure**. `union(3:A, 5:B)` is not eagerly flattened to an opaque
solid — its children `3:A` and `5:B` remain accessible, because the renderer needs to
walk the tree to answer "which leaf owns this point?"

This is also how SDF evaluation naturally works: you don't precompute the SDF field
everywhere, you evaluate it on demand per query point, which means the tree structure
is inherently preserved during rendering.

The remaining open question is whether bags become **fully first-class runtime values**
— passable, storable, returnable from functions, and usable in comprehensions:

```
{f(i) for i in range}  →  runtime bag<solid>  →  type ladder needs a new rung
```

The CHAM model implies this direction. The upgrade path is well-defined:
observable-substructure-but-not-first-class is the current position; fully first-class
bags are the natural extension when comprehensions become necessary.

### Where bag semantics work

| Contents | Container | Reaction | Confluent? |
|---|---|---|---|
| `solid + solid` | `union` | CSG union arithmetic | ✓ assoc+comm |
| `(solid -> solid) + solid` | `stir` | apply transformer to shape | ✓ types are distinct |
| `tagged-value + constructor` | `stir` | route by field name → solid | ✓ types are distinct |

### Where bag semantics break down

Two `solid -> solid` transformers in the same bag: their composition is not commutative
(`f ∘ g ≠ g ∘ f` for most transforms), so the result is non-deterministic in a bad way.
**Two transformers of the same type in a bag is a type error.** Explicit sequencing is
required. Two approaches:

**1. Traditional function composition** — nest calls directly, or use a dedicated
`compose`/`seq` operator that applies transformers left-to-right:

```
compose(warpA, warpB, warpC)(input)   -- warpA first, then warpB, then warpC
```

This works but is outside the bag/stir model — `compose` is an explicitly ordered
operator, not a reaction container.

**2. Numeric `tag`/`step` encoding** — promote each transformer to consume a
numbered token and produce the next, so dependency order emerges from the data:

```
stir(step(1, warpA), step(2, warpB), step(3, warpC), tag(1, input))
```

This stays within the `stir` model: the bag is still unordered, but only one step
can fire at any moment (the one whose input tag is present), so confluence is
preserved. Full details in the [`stir` section](#stir--the-general-reaction-container).

Linearity (each value consumed by exactly one reaction) prevents duplication but does
not constrain ordering for same-type values — which is exactly why one of the two
approaches above is needed.

---

## Named Definitions, DRY, and Recursion

### Named definitions (no self-reference)
For reuse without recursion — the "lizard eye" case: define a composite shape once,
instantiate it at multiple locations. No variable binding required; the name is just
a label for a constant solid value.

```
define eye = union(sphere{radius: 3}, translate{z: 1}(sphere{radius: 0.5}))

main = union(translate{x: -5}(eye), translate{x: 5}(eye))
```

### `grow` — iteration and recursion

`grow` is the universal "repeated application" combinator, covering both linear
iteration (organic growth/decay) and tree-structured recursion (fractals). The two
modes are distinguished by which argument name is used for the step function:

```
grow(seed: T, step: T -> T, hatch: T -> Solid, depth: Nat, until: (T, T) -> Bool)
grow(seed: T, self_step: (T -> T) -> T -> T, hatch: T -> Solid, depth: Nat, until: (T, T) -> Bool)
```

The argument name **is** the tag — `step` vs `self_step` tells `grow` which
evaluation strategy to use. No wrapper constructors needed; this is just field-name
routing, the same mechanism the rest of the language uses.

Parameters (all except `seed` have defaults):
- `seed`: initial value of type T (required)
- `step` or `self_step`: exactly one must be provided (both = error, neither = error)
  - `step: T -> T` — linear iteration; receives previous value, produces next
  - `self_step: (T -> T) -> T -> T` — tree recursion; receives the recursive call
    as its first argument, can invoke it at multiple positions
- `hatch: T -> Solid` — converts the final state to geometry (default: identity,
  meaning T is already Solid)
- `depth: Nat` — maximum iterations or recursion depth (default: global limit)
- `until: (T, T) -> Bool` — early termination predicate, receives (previous, current);
  default: always false (run to depth)

#### Linear iteration: `step`

For organic growth, erosion, accumulation — any process where each state depends on
exactly the previous one:

```
grow(seed: cube{size: 1}, step: erode, depth: 10)
grow(seed: sphere{r: 1}, step: scale_and_translate, hatch: identity, depth: 20,
     until: fn(prev, curr) -> diameter(curr) < 0.1)
```

This produces the sequence T₀, T₁, T₂, ... where Tₙ₊₁ = step(Tₙ). The `until`
predicate can stop early when the value has converged or become negligible.

#### Tree recursion: `self_step`

For fractal structures where the step function needs to invoke itself at multiple
positions — Menger sponge, branching trees, Sierpinski, etc.:

```
menger_step(recurse, shape) =
  intersect(
    shape,
    negate(union(bar_x, bar_y, bar_z)),
    translate{x: -1/3, y: -1/3, z: -1/3}(scale{factor: 1/3}(recurse(sub_cube(shape, 1)))),
    translate{x:    0, y: -1/3, z: -1/3}(scale{factor: 1/3}(recurse(sub_cube(shape, 2)))),
    ... × 20
  )

result = grow(seed: cube{size: 1}, self_step: menger_step, depth: 3)
```

`self_step` receives itself as its first argument, enabling branching recursion.
At `depth` limit, the recursive call returns the leaf value (empty solid) to
terminate. At depth 3–4 this gives a printable fractal approximation.

The step function `menger_step` is non-recursive and independently testable — the
recursion is isolated to `grow`.

#### Why one combinator?

Both modes share `seed`, `hatch`, `depth`, and `until`. The `depth` parameter is
especially valuable in both contexts: for linear iteration it bounds the number of
steps (important for rendering/meshing performance); for tree recursion it bounds
the recursion depth (essential for termination). The `until` predicate is more
natural for linear iteration ("has the value converged?") but can also apply to
tree recursion ("is the sub-shape too small to subdivide further?").

Having one combinator with two modes, distinguished by argument name, avoids
proliferating combinators while keeping each use site clear about which mode is
intended.

---

## `stir` — The General Reaction Container

`union` and `intersect` are specific CSG operators with defined arithmetic over solids.
They are **not** the right container for general type-directed reactions such as
transformer application or constructor routing — conflating them would be confusing and
surprising.

`stir` is the general unordered reaction container. You drop values in, and reactions
fire based on types and field names, with no implied ordering:

```
stir(grow(self_step: menger_step, depth: 3), cube{size: 1})
  → (solid -> solid) + solid → application fires
  → grow(seed: cube{size: 1}, self_step: menger_step, depth: 3)
  → solid

stir(sphere, cube, {r: 3}, {w: 4})
  → routing fires by field name
  → stir(sphere{r:3}, cube{w:4})
  → two solids remain → union(sphere{r:3}, cube{w:4})
```

The name fits the CHAM metaphor: you stir a solution and reactions happen based on
what's in it. No ordering, no directionality — unlike `feed`, which implied a
directed pipeline.

`stir` handles reactions that are unambiguous by type:
- `(solid -> solid) + solid` → application
- `tagged-value + constructor` → construction (routing by field name)
- `solid + solid` → passed through as a bag (requires explicit `union` or `intersect` to combine)

Two `solid -> solid` transformers in the same `stir` remains a type error — same
ambiguity as before.

### Transformer composition via numeric tags

To chain multiple `solid -> solid` transformers in sequence, use `step` and `tag`:

```
tag  : Nat → solid → (Nat:solid)
step : Nat → (solid -> solid) → (Nat:solid -> (Nat+1):solid)
```

`tag(N, shape)` labels a shape with a natural number. `step(N, T)` wraps a transformer
so it consumes `N:solid` and produces `(N+1):solid`. Dropped into a `stir`, the
numbered chain fires in dependency order even though `stir` is unordered:

```
stir(step(1, warpA), step(2, warpB), step(3, warpC), tag(1, input))

  tag(1, input)  →  1:solid available
  step(1, warpA) fires: consumes 1:solid, produces 2:solid
  step(2, warpB) fires: consumes 2:solid, produces 3:solid
  step(3, warpC) fires: consumes 3:solid, produces 4:solid
  → 4:solid remains
```

Confluence is preserved: at any moment at most one step can fire (the one whose input
tag is present), so there is no ordering ambiguity.

**Tags are transparent to geometric operations.** `N:solid` is a `solid` for all
purposes — `union`, `intersect`, `stir` application all treat it as a plain solid
without stripping the tag. The tag is metadata, not a wrapper that must be removed.

**Tags persist as metadata on the value.** They are not erased at the end of the
pipeline. This is useful: in the UI, hovering over a rendered pixel can report which
`solid` produced it and list its tags — giving provenance tracking and step-level
inspection for free, without any extra mechanism.

**`union` and `intersect` do nothing to tags.** They don't need to. The CSG expression
is an *object graph* — `union(3:A, 5:B)` has `3:A` and `5:B` as children in the tree,
and that structure is preserved at runtime. When the renderer hits a surface point, it
walks the graph to find which leaf primitive owns that point (by comparing SDF values),
and reports that leaf's tags. Provenance is graph traversal at query time, not a
propagation rule at construction time.

The `tag`/`step` encoding subsumes a dedicated `compose`/`seq` operator: sequential
composition is just `stir` with numbered steps. No new operator is required.

---

## Domain Warps

Shape transformers (`solid -> solid`) that deform space rather than creating new
topology. Useful for:
- **Symmetry operations**: bilateral mirror, radial repeat, linear tile
- **Smooth deformation**: twist, bend, taper, spiral path

In SDF terms: `sdf_warped(p) = sdf_original(f⁻¹(p))` — apply the inverse warp to
the query point.

Domain warps cover symmetry and smooth deformation but **not** fractal growth: a
spiral of spheres where each is 10% larger than the last requires variable-parameter
iteration (`grow` or comprehension), not a warp. Nature's fractal structures (romanesco,
branching trees, nautilus shells) generally require `grow` with `self_step`.

---

## Open Questions

- **Scalar transformers**: two classes, mirroring the solid operator structure:
  - *Unary* (`negate`, `1/`, `sin`, `cos`, …): `scalar -> scalar`. Single named
    argument; field name rarely matters since routing is unambiguous.
  - *AC multiarg* (`sum`, `product`): `bag<scalar> -> scalar`. Same bag semantics
    as `union`/`intersect` for solids. Non-AC binary ops fall out for free:
    `a - b = sum(a, negate(b))`, `a / b = product(a, 1/(b))`.
  Both fit the existing `stir` mechanism without new machinery.
- **Transformer composition**: resolved — `tag`/`step` encoding via numeric tags; see `stir` section.
- **Record literals in blocks**: largely a non-problem — the consuming block provides
  the slot structure; inline slot editing covers literal scalars (future work); exotic
  cases use the S-expression editor. See `ui-notes.md`.
- **`grow` depth control**: resolved — `depth` is a parameter on `grow`, with a global default. See the `grow` section.
