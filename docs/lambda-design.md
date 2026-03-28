# Stir + Lambda + Tag: Minimal PL Design

Working through the minimal additions needed to get user-defined blocks when
`stir` is the call primitive.

## Starting point: what stir does

From lang-design.md, stir is an unordered reaction container. You drop values
in and type-directed reactions fire:

```
stir(sphere, {radius: 5})           → sphere{radius: 5}  (a solid)
stir(translate{x:10}, cube{size:5}) → translate applies to cube
stir(f, g, solid)                   → type error if f and g are both solid->solid
```

The reactions are driven by types and field names. No ordering.

## What's a built-in block, really?

`sphere` is `{radius: scalar} -> solid`. It's a function value. When it sits
in a stir next to `{radius: 5}`, the reaction produces `sphere{radius: 5}`.

But in the current block UI, `sphere` is rendered differently: it has its
`radius` param slot built in. You don't *see* the function application; you
just fill the slot and you get a solid.

This is a convenience — direct application syntax — but the underlying model
is that sphere is a function and filling its slots is application.

## What's a lambda?

A lambda is a user-defined function. It needs:

1. **A name** (for display)
2. **What it consumes** — described by tag names it matches from the stir soup
3. **A body** — the geometry expression that uses those consumed values

In the simplest form:

```
(lambda :name "eye" :takes "radius"
  (union
    (sphere (param :name "radius"))
    (translate 0 0 2
      (sphere 1))))
```

This lambda consumes a value tagged `radius` (a scalar) and produces a solid.
Inside the body, `(param :name "radius")` references the consumed value.

## What's a tag?

`tag` labels a value with a field name for routing in stir:

```
(tag :name "radius" :value 5)
```

This produces `{radius: 5}` — a tagged scalar that a lambda (or built-in
constructor) can match on.

For geometry-typed values, tag wraps a child:

```
(tag :name "shape" (cube 20))
```

This produces `{shape: cube{size:20}}` — a tagged solid.

## Stir as the application mechanism

```
(stir
  (lambda :name "eye" :takes "radius"
    (union
      (sphere (param :name "radius"))
      (translate 0 0 2 (sphere 1))))
  (tag :name "radius" :value 5))
```

Stir sees: a function that takes `{radius}` and a tagged value `{radius: 5}`.
The reaction fires. Result: `eye{radius: 5}` — a solid.

## Multiple params

A lambda can take multiple tags:

```
(lambda :name "pillar" :takes "r h"
  (paint :color "gray"
    (cylinder (param :name "r") (param :name "h"))))
```

This matches `{r: scalar, h: scalar}`. In a stir:

```
(stir
  (lambda :name "pillar" :takes "r h" ...)
  (tag :name "r" :value 10)
  (tag :name "h" :value 30))
```

## Geometry params (solid -> solid)

A lambda that transforms geometry:

```
(lambda :name "double" :takes "shape"
  (union
    (param :name "shape")
    (translate 20 0 0 (param :name "shape"))))
```

In stir:

```
(stir
  (lambda :name "double" :takes "shape" ...)
  (tag :name "shape" (cube 20)))
```

Here `shape` is tagged with a solid, not a scalar. The lambda consumes it and
produces a union of two copies.

## Named definitions (DRY)

For the "lizard eye" case — define once, use twice — combine `let` with stir:

```
(let :name "eye"
  (lambda :name "eye" :takes "radius"
    (union
      (sphere (param :name "radius"))
      (translate 0 0 2 (sphere 1))))
  (union
    (translate 5 12 5
      (stir (var :name "eye") (tag :name "radius" :value 3)))
    (translate 5 12 -5
      (stir (var :name "eye") (tag :name "radius" :value 3)))))
```

Or with a top-level define sugar (which is what `define` becomes):

```
(define :name "eye"
  (lambda :name "eye" :takes "radius"
    (union
      (sphere (param :name "radius"))
      (translate 0 0 2 (sphere 1)))))

(stir (var :name "eye") (tag :name "radius" :value 3))
```

## What about type checking?

For v1, we don't need full type inference. The stir expansion can be simple:

1. Collect all lambdas in the stir
2. Collect all tagged values in the stir
3. For each lambda, check if all its `:takes` tags are present
4. If yes, substitute `(param :name "x")` with the tagged value for `x`
5. Whatever's left over (unmatched solids, etc.) gets unioned

Ambiguity (two lambdas wanting the same tag) is a runtime error for now.

## Relation to grow

`grow` is naturally expressible as stir + lambda:

```
grow(seed: cube, step: myTransform, depth: 4)
```

becomes:

```
(stir
  (grow :depth 4)
  (tag :name "seed" (cube 20))
  (tag :name "step"
    (lambda :name "step" :takes "acc"
      (union (var :name "acc") (translate 12 4 0 (sphere 3))))))
```

But this is probably overly complex for v1. The current `grow` with its two
labeled slots (seed + body) is simpler and covers the useful cases. We can
generalize later.

## Implementation plan

### Block types needed

1. **`stir`** — bag container (maxChildren: Infinity), like union
2. **`lambda`** — has `:name` and `:takes` (space-separated tag names), maxChildren: 1 (body)
3. **`tag`** — has `:name` and optionally `:value` (scalar), maxChildren: 0 or 1 (for geometry tags)
4. **`param`** — has `:name`, maxChildren: 0 (references a lambda parameter)

### Expansion

In expand.js, `stir` triggers the reaction:
- Find lambdas and tagged values
- Match lambdas to their required tags
- Substitute `param` references with the matched values
- Union any remaining solids

### What we keep from the previous implementation

- `let`/`var` — still useful for naming things
- `grow` — still useful for iteration (simpler than the stir encoding)
- The macro-expansion approach in expand.js

### What we remove

- `define` — replaced by `let` + `lambda`
- `call` — replaced by `stir`
