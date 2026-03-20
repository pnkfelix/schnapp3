# Schnapp3 — Claude Code Guidelines

## What is this?

Schnapp3 is a web-based, block-based visual programming environment for designing 3D-printable objects, especially multi-filament/multi-material designs. "Scratch/Snap! meets OpenSCAD."

Live at: https://pnkfx.org/schnapp3/

## Architecture

Plain HTML/CSS/JS, no build system, no bundler, no npm. Three.js loaded via CDN import map. Deployed to GitHub Pages via GitHub Actions (`.github/workflows/deploy.yml`).

### Pipeline

```
blocks (UI state)
   │
   ▼
codegen.js: block tree → S-expression AST (structured JS arrays)
   │
   ├──► formatSExpr() → string for code preview display
   │
   └──► evaluator.js: S-expression AST → Three.js Group
                                            │
                                            ▼
                                      viewport.js: render
```

The S-expression AST is the **canonical intermediate representation**. The evaluator consumes the AST, not the block tree. Adding new export targets (OpenSCAD, 3MF, G-code) means writing another AST consumer.

### File structure

```
index.html          — entry point, Three.js import map
style.css           — responsive layout, block styling, touch targets
src/
  blocks.js         — block definitions, state management, drag/drop, DOM rendering
  codegen.js        — block tree → S-expression AST + pretty-printer
  evaluator.js      — S-expression AST → Three.js geometry
  viewport.js       — Three.js scene, camera, lights, OrbitControls
  main.js           — wiring: blocks → codegen → eval → viewport
.github/
  workflows/
    deploy.yml      — GitHub Pages deployment (static files, no build step yet)
```

## Design principles

- **Incremental end-to-end slices.** Every change should produce something visible in the browser. Don't build subsystems in isolation.
- **Mobile-first.** Must work well on iPhone/iPad. Touch-friendly, big tap targets, pointer events for drag/drop.
- **No build system.** Plain static files. `index.html` opens and works. Dependencies from CDN via import maps.
- **Every commit should leave the app working.**
- **Prefer deleting code over adding abstraction.**
- **When in doubt, hardcode it and move on.**

## Key technical decisions

- **S-expression as canonical IR:** All downstream consumers (evaluator, future exporters) operate on the S-expr AST, not on blocks. The codegen module is the only thing that knows about the block data model.
- **AST format:** Nested JS arrays — `["cube", {size: 20, color: "red"}]`, `["translate", {x: 10, y: 0, z: 0}, child]`, `["union", child1, child2]`.
- **Pointer Events for drag/drop** (not HTML DnD API) — unified mouse+touch.
- **Three.js@0.170.0 via unpkg CDN** with import map for bare module specifiers.
- **`touch-action: none` on drag handles** (palette items, block headers) to prevent scroll interference. Palette scrolls via two-finger gesture.
- **No real CSG yet** — `union` just groups objects in a Three.js Group.

## Future directions (not yet implemented)

- **S-expr → blocks round-trip:** Parse S-expressions back to block tree for code editing.
- **Multi-color 3MF export:** Client-side 3MF generation for slicer import. Preferred over separate STLs.
- **Snapmaker U1 support:** The U1 uses standard Klipper G-code with Moonraker API. Format is open and documented in the Snapmaker OrcaSlicer fork. Direct G-code generation is possible but requires a slicing engine; 3MF export + external slicer is the pragmatic path.
- **WASM slicing:** Would require adding a build step to the GitHub Actions workflow.
- **Real CSG operations:** three-bvh-csg or similar for boolean operations.

## Development workflow

The owner (pnkfelix) works from the Claude Code mobile app — no terminal access. All testing happens via the deployed GitHub Pages site.

1. Claude develops on `claude/*` branches
2. Push branch, create PR
3. Owner merges via GitHub (Safari)
4. GitHub Actions auto-deploys to Pages
5. Owner tests at https://pnkfx.org/schnapp3/

## Code style

- Plain ES modules (`import`/`export`), no CommonJS
- No TypeScript (yet)
- No framework, no React, no build tools
- Minimal comments — only where logic isn't self-evident
- CSS: dark theme (#16213e base), block type colors (cube=orange, sphere=blue, cylinder=green, translate=purple, union=gray)
