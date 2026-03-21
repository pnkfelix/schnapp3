# Schnapp3

**A visual block-based programming environment for designing 3D-printable objects.**

## Live Demo

https://pnkfx.org/schnapp3/

## Project Goals

Schnapp3 is a web-based tool combining the ease of block-based visual programming (like [Scratch](https://scratch.mit.edu/)/[Snap!](https://snap.berkeley.edu/)) with the power of parametric 3D modeling (like OpenSCAD). Design multi-filament and multi-material objects interactively without writing code.

- **Visual design:** Block-based interface for intuitive 3D object creation
- **Multi-material support:** Design parts for multi-filament and multi-material 3D printing
- **No code required:** Create parametric designs without learning OpenSCAD or programming
- **Simple architecture:** Plain HTML/CSS/JavaScript, no build system, deployable to GitHub Pages
- **Open for extension:** Export formats (OpenSCAD, 3MF, G-code) can be added without changing core

## Architecture

The app uses a three-stage pipeline:

1. **Blocks UI** → Block tree state management and visual editor
2. **Codegen** → Block tree → S-expression AST (structured JS arrays)
3. **Evaluator** → S-expression AST → Three.js 3D geometry → Viewport

The S-expression AST is the canonical intermediate representation, allowing future exporters (OpenSCAD, 3MF, G-code) to be added independently.

## Tech Stack

- **Frontend:** Plain ES modules, no framework
- **3D Rendering:** Three.js (via CDN)
- **Deployment:** Static files to GitHub Pages
- **Build System:** None — works as plain HTML/CSS/JS

## Development

The project follows incremental end-to-end development: every commit should leave the app working and something visible in the browser.

See `CLAUDE.md` for detailed guidelines on code style, architecture decisions, and development workflow.
