# Schnapp3 Type System & Language Design Notes

Design decisions emerging from the scalar/solid distinction, collections, recursion,
and chemical bag semantics. This is a living document; not all of this is implemented.

## Notation

Throughout this document:
- `{field: Type}` — a **record type** description, e.g. `{x: scalar, y: scalar, z: scalar}`
- `{field: value}` — a **record value** (literal), e.g. `{x: 10, y: 0, z: 5}`
- `A → B` — a function type from A to B
- `a` — a type variable (stands for any type)

---

## The Type Ladder

```
scalar                                    number, color
record<{field: Type, ...}>                named bundle of typed values
solid                                     a 3D shape / Three.js geometry
solid → solid                             shape transformer (e.g. translate, warp)
(solid → solid) → solid → solid           transformer transformer (e.g. menger_step)
```

Each rung is a first-class value that can flow through the graph. Higher rungs consume
lower rungs.

Records are named bundles of *any* typed values — fields can be scalars, solids,
transformers, or other records. Record types with different field names (or different
field types) are distinct types, even if they have the same number of fields. Field
names are part of the type. Examples:

```
-- types
{x: scalar, y: scalar, z: scalar}                   translation vector type
{left: solid, right: solid}                          a named pair of solids
{shape: solid, xform: solid → solid}                 mixed-type record
{position: {x: scalar, y: scalar, z: scalar},
 size: scalar}                                       nested record type

-- values
{x: 10, y: 0, z: 5}                                 a translation vector value
{left: cube{size: 20}, right: sphere{radius: 10}}    a named pair of solid values
```

This is already implicit in the current AST — the params dict `{x: 10, y: 0, z: 5}`
is a record value, and the evaluator already does named projection (`node[1].x`, etc.).

---

## CSG Operators

### Primitives
- `union` — AC (associative, commutative), bag semantics
- `intersect` — AC, bag semantics
- `negate` — unary; flips inside/outside (in SDF: `sdf_anti(p) = -sdf(p)`)

### Derived
- `difference(A, B)` = `intersect(A, negate(B))` = `max(sdf_A, -sdf_B)`

### Anti-solids and scoped subtraction

`negate(B)` produces an anti-solid. When passed to `intersect`, it scopes the
subtraction: `intersect(A, negate(B))` removes B only from A, not from anything else.
The result is a regular solid that can be freely unioned with other things.

`union` with mixed solids and anti-solids uses two-class bag semantics:
```
(⋃ all solids) − (⋃ all anti-solids)
```
This is AC, but anti-solids subtract from *everything* in the union, not selectively.
For selective subtraction, use `intersect` with `negate`.

---

## Bag Semantics and Chemical Reactions

Inspired by the Chemical Abstract Machine (CHAM, Berry & Boudol 1992): values float
in a bag and react according to typed rules. Reactions fire non-deterministically, so
the system is only meaningful for **confluent** (order-independent) reactions.

### Where bag semantics work

| Contents | Reaction | Confluent? |
|---|---|---|
| `solid + solid` | `union` | ✓ AC |
| `(solid → solid) + solid` | apply transformer to shape | ✓ types are distinct |
| `{x: scalar, y: scalar, z: scalar} + solid` | translate solid by record | ✓ types are distinct |

### Where bag semantics break down

Two `solid → solid` transformers in the same bag: their composition is not commutative
(`f ∘ g ≠ g ∘ f` for most transforms), so the result is non-deterministic in a bad way.
**Two transformers of the same type in a bag is a type error.** Explicit sequencing is
required.

Linearity (each value consumed by exactly one reaction) prevents duplication but does
not constrain ordering for same-type values.

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

### Fixed-point recursion

For fractal structures, recursion is unavoidable. The key is to express it via `fix`
rather than named self-reference, keeping `menger_step` itself non-recursive and
independently understandable.

```
menger_step(recurse, shape) =
  intersect(
    shape,
    negate(union(bar_x, bar_y, bar_z)),
    translate{x: -1/3, y: -1/3, z: -1/3}(scale{factor: 1/3}(recurse(sub_cube(shape, 1)))),
    translate{x:    0, y: -1/3, z: -1/3}(scale{factor: 1/3}(recurse(sub_cube(shape, 2)))),
    ... × 20
  )

menger = fix(menger_step)
result = menger(cube{size: 1})   -- or: feed(cube{size: 1}, fix(menger_step))
```

Types:
```
menger_step  : (solid → solid) → solid → solid
fix          : (a → a) → a
fix(menger_step) : solid → solid
```

`fix` is depth-bounded in practice (`fix_n`) — unroll n levels, substitute a leaf
(empty solid) at the bottom. At depth 3–4 this gives a printable fractal approximation.

### Why not implicit self-reference?

A `[self]` block inside a definition is equivalent to `fix` with an implicit argument.
The explicit `fix(menger_step)` formulation is preferred because `menger_step` is a
well-typed, non-recursive, independently testable function. The recursion is isolated
to `fix`.

---

## The `feed` Operator (Explicit Application)

Currently, `translate`'s shape argument is a structural child slot — application is
implicit in the tree. Once `fix(menger_step)` produces a first-class `solid → solid`
value, explicit application is needed.

`feed(shape, transformer)` — shape-first order, pipeline / `|>` style.

In the chemical model, `feed` may be implicit: a `solid → solid` and a `solid` in the
same bag react to produce a `solid`, with no explicit application operator needed.
The type distinctness makes the reaction unambiguous.

Type-specific variants (`feed_scalar`, `feed_solid`) may be useful for error reporting
but can likely be unified under a single polymorphic `feed` distinguished by block
color/shape in the UI.

---

## Domain Warps

Shape transformers (`solid → solid`) that deform space rather than creating new
topology. Useful for:
- **Symmetry operations**: bilateral mirror, radial repeat, linear tile
- **Smooth deformation**: twist, bend, taper, spiral path

In SDF terms: `sdf_warped(p) = sdf_original(f⁻¹(p))` — apply the inverse warp to
the query point.

Domain warps cover symmetry and smooth deformation but **not** fractal growth: a
spiral of spheres where each is 10% larger than the last requires variable-parameter
iteration (`fix` or comprehension), not a warp. Nature's fractal structures (romanesco,
branching trees, nautilus shells) generally require `fix`.

---

## Open Questions

- **Argument order for `feed`**: shape-first (`|>` style) vs transformer-first (`$` style)?
- **Scalar transformers**: math blocks that compute scalars from scalars — same `feed`
  mechanism, different type rung.
- **Transformer composition**: if not via bags, what is the explicit composition syntax?
- **Record literals in blocks**: how does a user construct a `{x: scalar, y: scalar, z: scalar}`
  record value in the UI?
- **`fix` depth control**: is the depth a parameter on `fix`, or a separate `iterate_n` wrapper?
