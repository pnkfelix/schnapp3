// block-font.js — SDF-native block font for octree-friendly text rendering.
//
// Each glyph is composed of axis-aligned boxes (SDF primitives).
// The octree interval evaluator can classify each box individually,
// enabling much better culling than the mesh-based text SDF approach.

// Design constants (normalized coordinates)
const S = 0.10;       // stroke width
const H = 0.70;       // cap height
const XH = 0.50;      // x-height
const DESC = -0.20;   // descender depth

// Glyph definitions: { w: advance_width, r: [[cx, cy, fullW, fullH], ...] }
// All coordinates in normalized space; scaled by (fontSize / H) at render time.
const GLYPHS = {
  // ========================= UPPERCASE =========================
  // Standard width 0.50, advance 0.60

  'A': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.45, 0.35, 0.10, 0.70],   // right vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.35, 0.30, 0.10],   // crossbar
  ]},
  'B': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.35, 0.50, 0.10],   // mid bar
    [0.25, 0.05, 0.50, 0.10],   // bot bar
    [0.45, 0.50, 0.10, 0.20],   // right upper
    [0.45, 0.20, 0.10, 0.20],   // right lower
  ]},
  'C': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.05, 0.50, 0.10],   // bot bar
  ]},
  'D': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.05, 0.50, 0.10],   // bot bar
    [0.45, 0.35, 0.10, 0.50],   // right vert (inner)
  ]},
  'E': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.20, 0.35, 0.30, 0.10],   // mid bar (shorter)
    [0.25, 0.05, 0.50, 0.10],   // bot bar
  ]},
  'F': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.20, 0.35, 0.30, 0.10],   // mid bar (shorter)
  ]},
  'G': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.05, 0.50, 0.10],   // bot bar
    [0.45, 0.20, 0.10, 0.20],   // right lower
    [0.35, 0.35, 0.30, 0.10],   // mid stub
  ]},
  'H': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.45, 0.35, 0.10, 0.70],   // right vert
    [0.25, 0.35, 0.30, 0.10],   // crossbar
  ]},
  'I': { w: 0.45, r: [
    [0.175, 0.35, 0.10, 0.70],  // center vert
    [0.175, 0.65, 0.25, 0.10],  // top serif
    [0.175, 0.05, 0.25, 0.10],  // bot serif
  ]},
  'J': { w: 0.60, r: [
    [0.45, 0.35, 0.10, 0.70],   // right vert
    [0.25, 0.05, 0.50, 0.10],   // bot bar
    [0.05, 0.15, 0.10, 0.10],   // left hook
  ]},
  'K': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.35, 0.30, 0.10],   // mid connector
    [0.45, 0.55, 0.10, 0.30],   // upper right
    [0.45, 0.15, 0.10, 0.30],   // lower right
  ]},
  'L': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.05, 0.50, 0.10],   // bot bar
  ]},
  'M': { w: 0.70, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.55, 0.35, 0.10, 0.70],   // right vert
    [0.30, 0.65, 0.60, 0.10],   // top bar
    [0.20, 0.50, 0.10, 0.20],   // inner left drop
    [0.40, 0.50, 0.10, 0.20],   // inner right drop
  ]},
  'N': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.45, 0.35, 0.10, 0.70],   // right vert
    [0.15, 0.55, 0.10, 0.20],   // diagonal step 1 (top-left)
    [0.25, 0.35, 0.10, 0.20],   // diagonal step 2 (center)
    [0.35, 0.15, 0.10, 0.20],   // diagonal step 3 (bot-right)
  ]},
  'O': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.45, 0.35, 0.10, 0.70],   // right vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.05, 0.50, 0.10],   // bot bar
  ]},
  'P': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.35, 0.50, 0.10],   // mid bar
    [0.45, 0.50, 0.10, 0.20],   // right upper
  ]},
  'Q': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.45, 0.35, 0.10, 0.70],   // right vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.05, 0.50, 0.10],   // bot bar
    [0.35, 0.15, 0.10, 0.10],   // tail mark
  ]},
  'R': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.35, 0.50, 0.10],   // mid bar
    [0.45, 0.50, 0.10, 0.20],   // right upper
    [0.45, 0.15, 0.10, 0.30],   // right lower leg
  ]},
  'S': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.05, 0.50, 0.10, 0.20],   // left upper
    [0.25, 0.35, 0.50, 0.10],   // mid bar
    [0.45, 0.20, 0.10, 0.20],   // right lower
    [0.25, 0.05, 0.50, 0.10],   // bot bar
  ]},
  'T': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.25, 0.30, 0.10, 0.60],   // center vert
  ]},
  'U': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.45, 0.35, 0.10, 0.70],   // right vert
    [0.25, 0.05, 0.50, 0.10],   // bot bar
  ]},
  'V': { w: 0.60, r: [
    [0.05, 0.45, 0.10, 0.50],   // left outer (upper)
    [0.45, 0.45, 0.10, 0.50],   // right outer (upper)
    [0.15, 0.10, 0.10, 0.20],   // left inner (lower)
    [0.35, 0.10, 0.10, 0.20],   // right inner (lower)
  ]},
  'W': { w: 0.70, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert
    [0.55, 0.35, 0.10, 0.70],   // right vert
    [0.30, 0.05, 0.60, 0.10],   // bot bar
    [0.20, 0.20, 0.10, 0.20],   // inner left rise
    [0.40, 0.20, 0.10, 0.20],   // inner right rise
  ]},
  'X': { w: 0.60, r: [
    [0.05, 0.55, 0.10, 0.30],   // upper left
    [0.45, 0.55, 0.10, 0.30],   // upper right
    [0.25, 0.35, 0.30, 0.10],   // center
    [0.05, 0.15, 0.10, 0.30],   // lower left
    [0.45, 0.15, 0.10, 0.30],   // lower right
  ]},
  'Y': { w: 0.60, r: [
    [0.05, 0.55, 0.10, 0.30],   // upper left
    [0.45, 0.55, 0.10, 0.30],   // upper right
    [0.25, 0.35, 0.40, 0.10],   // mid bar
    [0.25, 0.15, 0.10, 0.30],   // lower center
  ]},
  'Z': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10],   // top bar
    [0.40, 0.50, 0.10, 0.20],   // upper right step
    [0.25, 0.35, 0.10, 0.10],   // center step
    [0.10, 0.20, 0.10, 0.20],   // lower left step
    [0.25, 0.05, 0.50, 0.10],   // bot bar
  ]},

  // ========================= LOWERCASE =========================
  // Standard width 0.45, advance 0.55, x-height 0.50

  'a': { w: 0.55, r: [
    [0.40, 0.25, 0.10, 0.50],   // right vert (full xh)
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // bot bar
    [0.225, 0.25, 0.45, 0.10],  // mid bar
    [0.05, 0.35, 0.10, 0.10],   // left upper stub
  ]},
  'b': { w: 0.55, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert (ascender)
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // bot bar
    [0.40, 0.25, 0.10, 0.30],   // right vert
  ]},
  'c': { w: 0.55, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // bot bar
  ]},
  'd': { w: 0.55, r: [
    [0.40, 0.35, 0.10, 0.70],   // right vert (ascender)
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // bot bar
    [0.05, 0.25, 0.10, 0.30],   // left vert
  ]},
  'e': { w: 0.55, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.25, 0.45, 0.10],  // mid bar
    [0.225, 0.05, 0.45, 0.10],  // bot bar
    [0.40, 0.35, 0.10, 0.10],   // right upper (above mid)
  ]},
  'f': { w: 0.40, r: [
    [0.15, 0.30, 0.10, 0.60],   // stem
    [0.25, 0.65, 0.20, 0.10],   // top hook
    [0.20, 0.45, 0.30, 0.10],   // crossbar
  ]},
  'g': { w: 0.55, r: [
    [0.40, 0.15, 0.10, 0.70],   // right vert (descender)
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // baseline bar
    [0.05, 0.25, 0.10, 0.30],   // left vert
    [0.225, -0.15, 0.45, 0.10], // descender bar
  ]},
  'h': { w: 0.55, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert (ascender)
    [0.225, 0.45, 0.45, 0.10],  // top connector
    [0.40, 0.20, 0.10, 0.40],   // right vert (baseline to top bar)
  ]},
  'i': { w: 0.30, r: [
    [0.10, 0.58, 0.10, 0.10],   // dot
    [0.10, 0.20, 0.10, 0.40],   // stem
  ]},
  'j': { w: 0.35, r: [
    [0.20, 0.58, 0.10, 0.10],   // dot
    [0.20, 0.10, 0.10, 0.60],   // stem (with descender)
    [0.10, -0.15, 0.10, 0.10],  // hook
  ]},
  'k': { w: 0.50, r: [
    [0.05, 0.35, 0.10, 0.70],   // left vert (ascender)
    [0.20, 0.25, 0.20, 0.10],   // mid connector
    [0.35, 0.38, 0.10, 0.15],   // upper arm
    [0.35, 0.12, 0.10, 0.15],   // lower arm
  ]},
  'l': { w: 0.30, r: [
    [0.10, 0.35, 0.10, 0.70],   // stem
  ]},
  'm': { w: 0.70, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.30, 0.25, 0.10, 0.50],   // center vert
    [0.55, 0.25, 0.10, 0.50],   // right vert
    [0.30, 0.45, 0.60, 0.10],   // top bar
  ]},
  'n': { w: 0.55, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.40, 0.25, 0.10, 0.50],   // right vert
    [0.225, 0.45, 0.45, 0.10],  // top bar
  ]},
  'o': { w: 0.55, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.40, 0.25, 0.10, 0.50],   // right vert
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // bot bar
  ]},
  'p': { w: 0.55, r: [
    [0.05, 0.15, 0.10, 0.70],   // left vert (descender)
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // baseline bar
    [0.40, 0.25, 0.10, 0.30],   // right vert
  ]},
  'q': { w: 0.55, r: [
    [0.40, 0.15, 0.10, 0.70],   // right vert (descender)
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.225, 0.05, 0.45, 0.10],  // baseline bar
    [0.05, 0.25, 0.10, 0.30],   // left vert
  ]},
  'r': { w: 0.40, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.20, 0.45, 0.30, 0.10],   // top bar stub
  ]},
  's': { w: 0.55, r: [
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.05, 0.35, 0.10, 0.10],   // left upper
    [0.225, 0.25, 0.45, 0.10],  // mid bar
    [0.40, 0.15, 0.10, 0.10],   // right lower
    [0.225, 0.05, 0.45, 0.10],  // bot bar
  ]},
  't': { w: 0.40, r: [
    [0.15, 0.30, 0.10, 0.60],   // stem
    [0.20, 0.45, 0.30, 0.10],   // crossbar
    [0.25, 0.05, 0.20, 0.10],   // bot bar (foot)
  ]},
  'u': { w: 0.55, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.40, 0.25, 0.10, 0.50],   // right vert
    [0.225, 0.05, 0.45, 0.10],  // bot bar
  ]},
  'v': { w: 0.55, r: [
    [0.05, 0.35, 0.10, 0.30],   // left upper
    [0.40, 0.35, 0.10, 0.30],   // right upper
    [0.15, 0.10, 0.10, 0.20],   // left inner
    [0.30, 0.10, 0.10, 0.20],   // right inner
  ]},
  'w': { w: 0.70, r: [
    [0.05, 0.25, 0.10, 0.50],   // left vert
    [0.30, 0.25, 0.10, 0.50],   // center vert
    [0.55, 0.25, 0.10, 0.50],   // right vert
    [0.30, 0.05, 0.60, 0.10],   // bot bar
  ]},
  'x': { w: 0.55, r: [
    [0.08, 0.38, 0.10, 0.24],   // upper left
    [0.37, 0.38, 0.10, 0.24],   // upper right
    [0.225, 0.25, 0.15, 0.10],  // center
    [0.08, 0.12, 0.10, 0.24],   // lower left
    [0.37, 0.12, 0.10, 0.24],   // lower right
  ]},
  'y': { w: 0.55, r: [
    [0.05, 0.375, 0.10, 0.25],  // left upper
    [0.40, 0.375, 0.10, 0.25],  // right upper
    [0.225, 0.25, 0.30, 0.10],  // mid connector
    [0.225, 0.025, 0.10, 0.45], // center stem (descender)
  ]},
  'z': { w: 0.55, r: [
    [0.225, 0.45, 0.45, 0.10],  // top bar
    [0.35, 0.35, 0.10, 0.10],   // upper step
    [0.225, 0.25, 0.10, 0.10],  // center step
    [0.10, 0.15, 0.10, 0.10],   // lower step
    [0.225, 0.05, 0.45, 0.10],  // bot bar
  ]},

  // ========================= DIGITS =========================
  '0': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70], [0.45, 0.35, 0.10, 0.70],
    [0.25, 0.65, 0.50, 0.10], [0.25, 0.05, 0.50, 0.10],
  ]},
  '1': { w: 0.45, r: [
    [0.225, 0.35, 0.10, 0.70],  // vert
    [0.15, 0.55, 0.10, 0.10],   // top serif
    [0.225, 0.05, 0.25, 0.10],  // bot serif
  ]},
  '2': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10], [0.45, 0.50, 0.10, 0.20],
    [0.25, 0.35, 0.50, 0.10], [0.05, 0.20, 0.10, 0.20],
    [0.25, 0.05, 0.50, 0.10],
  ]},
  '3': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10], [0.45, 0.50, 0.10, 0.20],
    [0.25, 0.35, 0.50, 0.10], [0.45, 0.20, 0.10, 0.20],
    [0.25, 0.05, 0.50, 0.10],
  ]},
  '4': { w: 0.60, r: [
    [0.05, 0.55, 0.10, 0.30], [0.45, 0.35, 0.10, 0.70],
    [0.25, 0.35, 0.50, 0.10],
  ]},
  '5': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10], [0.05, 0.50, 0.10, 0.20],
    [0.25, 0.35, 0.50, 0.10], [0.45, 0.20, 0.10, 0.20],
    [0.25, 0.05, 0.50, 0.10],
  ]},
  '6': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10], [0.05, 0.35, 0.10, 0.70],
    [0.25, 0.35, 0.50, 0.10], [0.45, 0.20, 0.10, 0.20],
    [0.25, 0.05, 0.50, 0.10],
  ]},
  '7': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10], [0.45, 0.35, 0.10, 0.70],
  ]},
  '8': { w: 0.60, r: [
    [0.05, 0.35, 0.10, 0.70], [0.45, 0.35, 0.10, 0.70],
    [0.25, 0.65, 0.50, 0.10], [0.25, 0.35, 0.50, 0.10],
    [0.25, 0.05, 0.50, 0.10],
  ]},
  '9': { w: 0.60, r: [
    [0.25, 0.65, 0.50, 0.10], [0.05, 0.50, 0.10, 0.20],
    [0.25, 0.35, 0.50, 0.10], [0.45, 0.35, 0.10, 0.70],
    [0.25, 0.05, 0.50, 0.10],
  ]},

  // ========================= PUNCTUATION =========================
  '.': { w: 0.30, r: [
    [0.10, 0.05, 0.10, 0.10],
  ]},
  ',': { w: 0.30, r: [
    [0.10, 0.05, 0.10, 0.10],
    [0.10, -0.05, 0.10, 0.10],
  ]},
  '!': { w: 0.30, r: [
    [0.10, 0.35, 0.10, 0.50],   // stem
    [0.10, 0.05, 0.10, 0.10],   // dot
  ]},
  '?': { w: 0.55, r: [
    [0.225, 0.65, 0.45, 0.10],
    [0.40, 0.50, 0.10, 0.20],
    [0.225, 0.35, 0.30, 0.10],
    [0.225, 0.25, 0.10, 0.10],
    [0.225, 0.05, 0.10, 0.10],
  ]},
  '-': { w: 0.45, r: [
    [0.175, 0.35, 0.25, 0.10],
  ]},
  '_': { w: 0.55, r: [
    [0.225, 0.00, 0.45, 0.10],
  ]},
  ':': { w: 0.30, r: [
    [0.10, 0.40, 0.10, 0.10],
    [0.10, 0.10, 0.10, 0.10],
  ]},
  ' ': { w: 0.35, r: [] },
};

// Convert a text string to an S-expression AST of translated boxes.
// Returns: ["translate", {x, y, z}, ["union", ...boxes]]
// Each box is: ["translate", {x, y, z}, ["box", {sx, sy, sz, color}]]
export function textToBlockAST(content, fontSize, depth, color) {
  const scale = fontSize / H;
  const children = [];
  let cursor = 0;

  // Track bounding box for centering
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const ch of content) {
    const g = GLYPHS[ch];
    if (!g) { cursor += 0.35; continue; } // unknown char = space

    for (const [cx, cy, w, h] of g.r) {
      const wx = (cursor + cx) * scale;
      const wy = cy * scale;
      const sx = w * scale;
      const sy = h * scale;

      minX = Math.min(minX, wx - sx / 2);
      maxX = Math.max(maxX, wx + sx / 2);
      minY = Math.min(minY, wy - sy / 2);
      maxY = Math.max(maxY, wy + sy / 2);

      children.push(
        ['translate', { x: wx, y: wy, z: 0 },
          ['box', { sx, sy, sz: depth, color: color || undefined }]]
      );
    }
    cursor += g.w;
  }

  if (children.length === 0) {
    return ['union'];
  }

  // Center offset (same as TextGeometry centering)
  const offsetX = -(minX + maxX) / 2;
  const offsetY = -(minY + maxY) / 2;

  const inner = children.length === 1 ? children[0] : ['union', ...children];
  return ['translate', { x: offsetX, y: offsetY, z: 0 }, inner];
}

// Get bounding box half-widths for a block font text node (for interval eval).
export function getBlockFontBounds(content, fontSize, depth) {
  const scale = fontSize / H;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let cursor = 0;

  for (const ch of content) {
    const g = GLYPHS[ch];
    if (!g) { cursor += 0.35; continue; }
    for (const [cx, cy, w, h] of g.r) {
      const wx = (cursor + cx) * scale;
      const wy = cy * scale;
      const sx = w * scale;
      const sy = h * scale;
      minX = Math.min(minX, wx - sx / 2);
      maxX = Math.max(maxX, wx + sx / 2);
      minY = Math.min(minY, wy - sy / 2);
      maxY = Math.max(maxY, wy + sy / 2);
    }
    cursor += g.w;
  }

  if (minX === Infinity) return { hw: 0, hh: 0, hd: depth / 2 };

  const hw = (maxX - minX) / 2;
  const hh = (maxY - minY) / 2;
  return { hw, hh, hd: depth / 2 };
}
