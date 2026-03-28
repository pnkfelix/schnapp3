# Stir Operational Semantics

Operational semantics for `stir`, `enzyme`, `tag`, currying, and bundles.
This document captures the implemented behavior as of the enzyme-currying
work, and is intended as groundwork for a future formal SOS treatment.

## Values

The language has four kinds of runtime value:

```
v  ::=  n                              scalar (number)
     |  (shape ...)                    geometry AST node (cube, sphere, union, ...)
     |  { enzyme, node, env }          enzyme closure
     |  { bundle, [v1, v2, ...] }      bundle of values
```

Scalars and shapes are *inert* — they don't react on their own. Enzyme
closures are *reactive* — they have unsatisfied wants and can fire when
placed in a stir with matching values. Bundles are transparent containers
that unpack when they enter a stir pool.

Tags are **not** a separate kind of value. They are a field carried by
structured values:

- **AST nodes** carry tags in their params object: `['sphere', {radius: 10, _tags: ['x']}]`
- **Enzyme closures** carry tags in a `.tags` field: `{ __enzyme, node, env, tags: ['x'] }`
- **Bundles** carry tags in a `.tags` field: `{ __bundle, items, tags: ['x'] }`
- **Bare scalars** (numbers) cannot carry tags directly. Tagging a scalar promotes
  it to a structured `['scalar', {value: n, _tags: ['x']}]` node. When all tags
  are stripped, the scalar reverts to a bare number.

The `(tag "name" v)` and `(tags "names" v)` syntax nodes are consumed during
expansion: they add names to the value's `_tags` and disappear. There is no
`tag` node type in the expanded AST — only `_tags` fields on existing values.

## Tags as metadata

Tags are persistent metadata on values. They flow through `let`/`var`
bindings, stir results, and enzyme closures without being stripped.

Tags are only stripped at **consumption points**: expression params in
primitives. When `(sphere {radius: (var "x")})` is expanded and `x` is
bound to `['scalar', {value: 15, _tags: ['r']}]`, the expansion strips
tags to get the bare `15` before writing it into the sphere's params.

Evaluators (`evalNode`, `evalCSGField`, GPU tape compiler, etc.) never
see tag-related node types. They see ordinary AST nodes where some params
objects happen to have a `_tags` field, which they simply ignore.

Every value carries zero or more explicit tags (from the `_tags` field)
plus one implicit type-tag derived from its underlying kind:

```
implicitTags(n)            = {"scalar"}
implicitTags((scalar ...)) = {"scalar"}
implicitTags((shape ...))  = {"shape"}
implicitTags(enzyme)       = {"enzyme"}
```

## Enzymes

An enzyme is the function abstraction. It declares *wants* — a set of tag
names it requires — and has a body that executes when all wants are satisfied.

```
(enzyme :tags "x y z" BODY)
```

During expansion, an enzyme node is **not** evaluated. Instead it captures
the current environment as a closure:

```
expandNode((enzyme {tags: "x y"} BODY), env)
  = { __enzyme: true, node: (enzyme ...), env: Map(env) }
```

The body remains unevaluated until the enzyme fires inside a stir.

## Stir: the reaction container

Stir is the application mechanism. It collects values into an unordered
**pool** and runs reactions until no more are possible.

### Pool items

Each pool entry is a triple:

```
{ carries: Set<string>,    -- tags this value offers
  wants:   Set<string>,    -- tags this value seeks (non-empty only for enzymes)
  value:   v }             -- the runtime value itself
```

When a value enters the pool:

- **Enzyme closures**: carries = `{"block"}`, wants = declared tag names
- **Tagged values**: carries = explicit tags (from `tag`/`tags` wrappers)
  plus implicit type-tag
- **Bare values**: carries = implicit type-tag only, wants = `{}`
- **Bundles**: unpacked — each item enters the pool individually

### Reaction loop

The loop has two phases per iteration, with full reactions taking priority
over partial application. It runs until quiescence or a maximum reaction
count is reached.

```
WHILE changed AND reactions < MAX:
    changed := false

    -- Phase A: Full reaction (all wants satisfied)
    FOR each enzyme E in pool:
        match := matchPool(E.wants, pool, E)
        IF match is complete:
            fire(E, match)
            changed := true
            BREAK  -- restart from top

    -- Phase B: Partial application / currying (fallback)
    IF NOT changed:
        FOR each enzyme E in pool:
            partial := partialMatchPool(E.wants, pool, E)
            IF partial matches at least one but not all wants:
                curry(E, partial)
                changed := true
                BREAK  -- restart from top
```

**Full reactions always take priority.** Currying is a fallback that fires
only when no enzyme in the pool can be fully satisfied. This ensures that
if all arguments are available, the enzyme fires completely rather than
being partially applied.

### Matching

`matchPool(wants, pool, consumer)` tries to find exactly one pool item
for each wanted tag name:

```
FOR each tagName in wants:
    find unique item i in pool where:
        i != consumer
        i.carries contains tagName
        no other item also carries tagName   (ambiguity check)
    IF no unique match found: RETURN null
RETURN Map<tagName, poolIndex>
```

If any wanted tag has zero providers or more than one provider, the match
fails. This ambiguity rule is central to confluence — at most one reaction
can fire at a time.

`partialMatchPool` is identical except it collects whatever matches it can
and returns them as long as at least one (but not all) wants are satisfied.

### Firing a reaction

When an enzyme fires with a complete match:

```
fire(enzyme, match):
    bodyEnv := new Map(enzyme.env)
    FOR (tagName, poolIndex) in match:
        -- Strip the matched tag; preserve all others
        bodyEnv[tagName] := stripOneTag(pool[poolIndex].value, tagName)
    -- Remove enzyme and consumed items from pool
    pool[enzyme] := null
    FOR (_, poolIndex) in match:
        pool[poolIndex] := null
    -- Expand the body and add result back to pool
    result := expandNode(enzyme.body, bodyEnv)
    addToPool(result, pool)
```

The result re-enters the pool and may trigger further reactions in
subsequent iterations.

### Tag stripping on match

When an enzyme consumes a value by matching tag `"x"`, the tag `"x"` is
**stripped** from the bound value. Other tags are preserved:

```
stripOneTag(['scalar', {value: 42, _tags: ['x', 'y']}], "x")  =  ['scalar', {value: 42, _tags: ['y']}]
stripOneTag(['scalar', {value: 42, _tags: ['x']}], "x")       =  42   (reverts to bare scalar)
stripOneTag(['sphere', {radius: 10, _tags: ['x']}], "x")      =  ['sphere', {radius: 10}]
```

Rationale: the matched tag has served its routing purpose. The enzyme body
can always re-add it. Without stripping, we would need an explicit
tag-removal operator to avoid tag accumulation.

### Currying (partial application)

When the full-match phase produces no reactions, the loop tries partial
application:

```
curry(enzyme, partial):
    newEnv := new Map(enzyme.env)
    FOR (tagName, poolIndex) in partial:
        newEnv[tagName] := stripOneTag(pool[poolIndex].value, tagName)
    remainingTags := enzyme.wants \ partial.keys
    newNode := (enzyme :tags remainingTags enzyme.body)
    partialEnzyme := { __enzyme, node: newNode, env: newEnv }
    -- Remove enzyme and consumed items
    pool[enzyme] := null
    FOR (_, poolIndex) in partial:
        pool[poolIndex] := null
    -- Add partial enzyme back to pool
    addToPool(partialEnzyme, pool)
```

The partially applied enzyme is a new closure with:
- Fewer wants (only the unsatisfied tags remain)
- A richer environment (matched tags are already bound)
- The same body (unevaluated)

After currying, the loop restarts. The partial enzyme may now fully match
with other pool items, or curry again, or remain as a leftover.

### Collection phase

After the loop quiesces, remaining pool items are collected:

```
remaining := [item.value for item in pool if item != null]

IF remaining is empty:   RETURN null
IF remaining has 1 item: RETURN that item
IF remaining contains any enzyme closures:
    RETURN { __bundle, items: remaining }
ELSE:
    RETURN (union remaining...)
```

The bundle case is critical for currying: if a stir produces multiple
leftover values including enzymes, they must be bundled (not wrapped in a
union AST node) so they can be unpacked in a subsequent stir.

## Bundles

A bundle is a transparent container for multiple values that include at
least one enzyme closure. Bundles exist because enzymes are runtime closure
objects, not AST nodes — putting them inside `['union', enz1, enz2]` would
bury them where the evaluator can't distinguish them from geometry children.

When a bundle enters a stir pool (via `addToPool`), it is immediately
unpacked: each item becomes its own pool entry with its own carries/wants.

When a bundle reaches the evaluator (e.g., as a child of a union that
wasn't inside a stir), the evaluator extracts whatever geometry it can
and silently discards enzyme closures.

## Chain reactions

Enzymes can produce values that trigger other enzymes in the same stir.
This is enabled by two mechanisms:

1. **Tags in enzyme bodies** are preserved. If enzyme B's body is
   `(tag "x" (var "y"))`, the result carries explicit tag `"x"` when it
   re-enters the pool.

2. **The reaction loop restarts** after every reaction, so enzyme A
   (which wants `"x"`) will see B's freshly tagged output.

Example:

```
(stir
  (enzyme :tags "x"           -- A: wants x, makes a sphere
    (sphere {radius: (var "x")}))
  (enzyme :tags "y"           -- B: wants y, produces x
    (tag "x" (var "y")))
  (tag "y" 42))               -- supply y only
```

Execution:
1. Pool: `A{wants: x}`, `B{wants: y}`, `42{carries: y, scalar}`
2. B matches `"y"` → fires → body produces `(tag "x" 42)` → pool entry
   with carries `{"x", "scalar"}`
3. A matches `"x"` → fires → body produces `(sphere {radius: 42})`
4. Result: `(sphere {radius: 42})`

### Chain reactions with curried bundles

Currying and chain reactions compose:

```
(let :name "pair"
  (stir                               -- stir 1: no args, both enzymes survive
    (enzyme :tags "x" (sphere {radius: (var "x")}))
    (enzyme :tags "y" (tag "x" (var "y"))))
  (stir                               -- stir 2: supply y, chain reaction fires
    (var "pair")
    (tag "y" 7)))
```

Execution:
1. Stir 1 produces a bundle of `[A{wants: x}, B{wants: y}]`
2. Stir 2 unpacks the bundle, adds `7{carries: y}` to pool
3. B fires with y=7, produces `(tag "x" 7)`
4. A fires with x=7, produces `(sphere {radius: 7})`

## Confluence

The stir reaction loop is designed to be confluent: the order in which
reactions fire does not affect the final result, provided the pool has no
ambiguous matches (two items carrying the same tag that a single enzyme
wants).

The ambiguity check in `matchPool` enforces this — if two items both carry
tag `"x"` and an enzyme wants `"x"`, the match fails (returns null) rather
than picking arbitrarily.

Currying preserves confluence because it only fires when no full reaction
is possible, and the partial match is also subject to the ambiguity check.

## Relationship to lambda calculus

| Lambda calculus     | Schnapp3              |
|---------------------|-----------------------|
| `lambda x. body`    | `(enzyme :tags "x" body)` |
| `f(v)`              | `(stir f (tag "x" v))`    |
| Closure             | `{ __enzyme, node, env }` |
| Currying             | Partial application in stir |
| Multi-arg function  | Enzyme with multiple tags  |
| Application          | Tag-directed matching in pool |

Key differences from lambda calculus:
- **Unordered application**: arguments are matched by tag name, not position
- **Multiple consumers**: a stir can contain multiple enzymes that fire independently
- **Chemical semantics**: the pool is a bag, not a stack; reactions are confluent
- **Implicit type routing**: values carry implicit type-tags (scalar, shape) alongside explicit tags

## Relationship to Forsythe

Reynolds's Forsythe language has intersection types where a value inhabits
multiple types simultaneously, and records are bundles of named components.
There is a suggestive analogy:

- A **tagged value** in Schnapp3 is like a Forsythe value at an intersection
  type: `(tag "x" (tag "y" 42))` inhabits both `{x}` and `{y}`.
- A **bundle** is like a Forsythe record — a collection of named components
  that can be destructured by different consumers.
- **Stir matching** is analogous to Forsythe's function application selecting
  the component of an intersection that matches the argument type.
- **Currying** produces a value with residual wants — like a partially
  satisfied intersection type waiting for more components.

The analogy is informal; Schnapp3's tag system is not a type system in the
Forsythe sense (tags are runtime metadata, not static types). But the
structural similarity suggests that a formal treatment might benefit from
intersection type theory.

## Open questions

- **Tag-removal operator**: Currently there is no way to explicitly strip a
  tag from a value. Enzyme matching strips the matched tag automatically.
  If patterns emerge where explicit stripping is needed, a `(untag "name" v)`
  operator could be added.

- **Ambiguity resolution**: When two pool items carry the same tag, the
  current behavior is to fail the match (no reaction). An alternative would
  be to support nondeterministic choice or priority-based resolution.

- **Enzyme identity in bundles**: Bundles currently carry enzymes as opaque
  closures. If enzymes need to be inspected (e.g., for UI display of a
  partially applied enzyme's remaining wants), a richer representation
  may be needed.

- **Formal SOS**: This document describes the semantics informally. A proper
  Structured Operational Semantics with inference rules would pin down edge
  cases and make confluence provable. The pool-based reaction model maps
  naturally to a CHAM (Chemical Abstract Machine) formalization.
