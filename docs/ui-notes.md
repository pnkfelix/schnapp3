# Schnapp3 UI Design Notes

Interaction design decisions and future work for the block-based editor.
Companion to `lang-design.md`; assumes familiarity with the type ladder and
`stir` semantics described there.

---

## Scalar input: inline slot editing

Most blocks expose named parameter slots (e.g. `translate` shows `x`, `y`, `z`
slots). For scalar values, the primary interaction is dragging a scalar block into
a slot. But dragging is overkill when you just want to type `10`.

**Future work**: clicking an unfilled scalar slot should open an inline text field
for typing a literal value directly, without opening the full S-expression editor.
This covers the common case — most scalar inputs are constants, not computed values.

The S-expression editor remains available for anything more complex.

---

## Record literals: blocks provide the structure

Users rarely need to construct a freestanding record literal `{x: 10, y: 0, z: 5}`.
In practice, the *consuming block* provides the structure: `translate` exposes `x`,
`y`, `z` slots; dragging scalars into those slots *is* constructing the record.

For the bare-scalar routing case in `stir` (`{r: 20}` routing to `sphere`), the
single-field sugar handles the unambiguous case. Anything exotic can be typed in
the S-expression editor.

---

## `stir` block: type-directed label suggestions

When adding a new input to a `stir` block, the UI can inspect the block's current
contents and suggest valid field labels based on what constructors and transformers
are already in the soup.

Example: if `sphere` is in the stir, the UI knows `sphere` expects `{r: scalar}`,
so it offers `r` as a label suggestion when the user creates a new record input.
If both `sphere` and `cube` are present, it offers both `r` and `w` (or whatever
cube's field is).

This is type-directed autocomplete: the same field-name routing keys that drive
the *semantics* also drive the *UI suggestion*. No separate schema needed.

For `step`-based transformer pipelines, the suggestion is numeric: if `step(1, warpA)`
is in the stir, the natural suggestion for a new input is "tag this with `1`" to
start the chain. Same mechanism, different label form.

---

## Anti-solid rendering

Anti-solids are rendered as ghostly objects: alpha-blended, and possibly with
inverted colours, to distinguish them visually from solid material. They are
hoverable — the hover tooltip reports their tags just as it does for solids.

This makes the distinction between soft subtraction (`union(A, anti(B))`, ghost
visible in B−A) and hard clip (`intersect(A, complement(B))`, B−A truly empty)
visible directly in the viewport.

Details of the exact visual treatment (alpha value, colour inversion, outline) are
not yet decided.

---

## Hover: provenance from the object graph

When the user hovers over a rendered pixel, the renderer walks the CSG object graph
to find which leaf primitive owns that point (by comparing SDF values), then reports
that leaf's tags.

For a pipeline built with `tag`/`step`, the tags on the leaf include the step number,
so the hover can report "this surface came from step 3 of this pipeline."

No separate provenance system is needed — it falls out of tags persisting on values
and the object graph being preserved at runtime.
