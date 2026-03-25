# PL Feature Decisions

Design decisions made during the initial implementation of the programming-language
oriented blocks: `let`/`var`, `grow`, `define`/`call`.

This document records what was built, why each choice was made, and what was
deliberately deferred to align with the fuller `lang-design.md` vision.

---

## 1. Macro-expansion vs. closure-based evaluation

**Decision:** AST macro-expansion (textual substitution) in a separate `expand.js` pass,
run before the existing evaluator.

**Why:** The evaluator has deep, performance-critical code paths — field evaluation,
interval arithmetic, octree acceleration, GPU tape compilation — all of which thread
`(x, y, z)` coordinates through closures. Threading an environment through all of those
would be a large, invasive change with high regression risk.

Macro-expansion is simpler: `let`/`var`/`grow`/`define`/`call` are expanded away into
the core geometry AST before the evaluator ever sees them. The evaluator stays untouched.

**Tradeoff:** This means variables are not first-class runtime values — they're resolved
statically at expansion time. This is sufficient for the current feature set (named
reuse, iteration, parameterized definitions) but would need revisiting for first-class
functions or `stir`-based type-directed reactions.

---

## 2. `call` block instead of `stir` for user-defined block invocation

**Decision:** A dedicated `call` block rather than using `stir` for invoking user-defined
blocks.

**Why:** `stir` as described in `lang-design.md` is a general unordered reaction container
with type-directed routing by field names. Implementing full `stir` requires:

- A type system (even a simple inferred one) to determine which values react with which
- Field-name routing for record types
- Handling of the `step`/`tag` encoding for transformer composition
- Confluence checking or at minimum clear error reporting for ambiguous reactions

This is a significant amount of machinery. The `call` block provides the immediate
practical value — "define a shape once, use it in multiple places with different
parameters" — without requiring any of the above.

**Future path:** When `stir` is implemented, `call` becomes sugar for
`stir(user_defined_block, {param1: val1, param2: val2})`. The `call` block can be
deprecated or kept as convenient shorthand. User-defined blocks would need to carry
the metadata (parameter field names and types) that `stir` needs for routing.

---

## 3. `grow` as linear iteration only (no `self_step` yet)

**Decision:** `grow` implements linear iteration: `seed`, `count` iterations of a `step`
body that can reference the accumulator by name.

The full `lang-design.md` spec distinguishes two modes via argument name:
- `step: T -> T` — linear iteration (implemented)
- `self_step: (T -> T) -> T -> T` — tree recursion (deferred)

**Why linear only:** Linear iteration covers the most common practical cases — stacking
spheres, building towers, creating spirals, growing/eroding shapes iteratively. Tree
recursion (Menger sponge, branching fractals) requires the step function to receive
itself as an argument, which needs either:

- First-class function values in the AST, or
- A special expansion strategy where the expander inserts the recursive structure

Both are doable but add complexity. Linear `grow` delivers immediate value.

**What's missing:** The `hatch`, `until`, and `self_step` parameters from the spec.
These can be added incrementally. `hatch` is identity for now (the accumulator is
already a solid). `until` would require evaluating a predicate on geometry, which needs
scalar extraction (e.g. bounding box size), not yet available.

---

## 4. `let`/`var` for simple name bindings

**Decision:** `let` binds a name to a geometry expression; `var` references it.
`let` has two labeled child slots: "value" (the bound expression) and "body" (the scope
where the name is available).

**Why labeled slots:** Unlike `translate` or `paint` which take a single child, `let`
and `grow` need exactly two children with distinct roles. The UI renders these with
labels ("value:", "body:" for `let`; "seed:", "body:" for `grow`) and per-slot drop
targets. This is a new rendering mode in the block system — previously blocks were
either single-slot or bag (unlimited) containers.

**Scoping:** Lexical scope. The name bound by `let` is visible only in the body child,
not in the value child (no recursive self-reference via `let`). This matches standard
`let` semantics and avoids the complexity of `letrec`.

---

## 5. `define` with string-encoded parameters

**Decision:** `define` takes a `name` (text) and `params` (space-separated names as a
single text string). `call` takes a `name` and `args` (space-separated numbers as a
single text string).

**Why strings, not structured params:** The block system's parameter model is flat
key-value pairs (each param is a single scalar: number, color/enum, or text). There's
no mechanism for a block to have a *variable number* of named parameters. Encoding the
parameter list as a space-separated string in a single text field is a pragmatic
workaround that works within the existing block model.

**Tradeoff:** Parameter values in `call` are currently numbers only, parsed from the
args string. Passing geometry as arguments requires `let`/`var` wrapping. This is
intentionally simple — rich parameter passing is what `stir` is designed for.

**Future path:** When the block model supports structured/variadic parameters, `define`
could expose its parameters as proper named slots. This would integrate naturally with
`stir`'s field-name routing.

---

## 6. Top-level `define` extraction

**Decision:** `define` blocks at the top level (in the implicit union of root blocks)
are collected in a first pass before any expansion happens. They don't produce geometry
themselves.

**Why:** This matches the `lang-design.md` mental model where definitions are declarations
that exist in a flat namespace alongside the main geometry. A `define` block sitting next
to a `cube` in the workspace doesn't union with the cube — it just registers a name.

**Scoping:** Definitions are global (visible to all root blocks and their children).
Nested `define` inside other blocks also works but is scoped to the subtree being
expanded. This is a natural consequence of the expansion-pass approach.

---

## 7. What's not implemented (and why)

**`stir`:** The general reaction container. Deferred because it requires type-directed
routing, which requires at minimum a type inference pass. This is the biggest gap between
the current implementation and the `lang-design.md` vision.

**`self_step` in `grow`:** Tree recursion. Deferred because it requires either first-class
functions or a special-purpose recursive expansion strategy.

**Scalar variables in params:** The `__scalar` marker in `expand.js` is a placeholder for
passing numeric arguments from `call` into `define` bodies. It works for substituting
into S-expression params but is limited — you can't compute with scalars (no `sum`,
`product`, etc. yet).

**`hatch` and `until` in `grow`:** Deferred. `hatch` is identity (accumulator is
already geometry). `until` would need scalar extraction from geometry.

**Blocks as first-class values:** Variables (`var`) reference geometry AST nodes, not
arbitrary values. You can't bind a name to a transformer and apply it later. This is
the key limitation that `stir` would solve.

---

## Summary of new S-expression forms

```
(let :name "x" value-expr body-expr)
(var :name "x")
(grow :name "acc" :count 4 seed-expr step-body-expr)
(define :name "myShape" :params "a b" body-expr)
(call :name "myShape" :args "10 20")
```

All are expanded away before evaluation. The evaluator never sees them.
