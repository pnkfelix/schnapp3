// S-expression text → AST (same format as codegen.js output)
//
// Grammar:
//   (cube SIZE)
//   (sphere RADIUS)
//   (cylinder RADIUS HEIGHT)
//   (paint :color "COLOR" CHILD)
//   (recolor :from "COLOR" :to "COLOR" CHILD)
//   (translate X Y Z CHILD...)
//   (union CHILD...)
//   (fuse :k K CHILD...)

export function parseSExpr(text) {
  const tokens = tokenize(text);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parseExpr() {
    const t = next();
    if (t !== '(') return null;

    const type = next();
    if (typeof type !== 'string') return null;

    switch (type) {
      case 'cube': return parseCube();
      case 'sphere': return parseSphere();
      case 'cylinder': return parseCylinder();
      case 'text': return parseText();
      case 'translate': return parseTranslate();
      case 'paint': return parsePaint();
      case 'recolor': return parseRecolor();
      case 'union': return parseUnion();
      case 'intersect': return parseIntersect();
      case 'anti': return parseAnti();
      case 'complement': return parseComplement();
      case 'fuse': return parseFuse();
      case 'rotate': return parseRotate();
      case 'mirror': return parseMirror();
      case 'twist': return parseTwist();
      case 'radial': return parseRadial();
      case 'stretch': return parseStretch();
      case 'tile': return parseTile();
      case 'bend': return parseBend();
      case 'taper': return parseTaper();
      case 'let': return parseLet();
      case 'var': return parseVar();
      case 'grow': return parseGrow();
      case 'fractal': return parseFractal();
      case 'stir': return parseStir();
      case 'enzyme': return parseEnzyme();
      case 'tags': return parseTags();
      case 'tag': return parseTag();
      case 'scalar': return parseScalar();
      default: {
        skipUntilClose();
        return [type];
      }
    }
  }

  function parseNumber() {
    // Allow sub-expressions (e.g. (var "x")) in numeric positions
    if (peek() === '(') {
      return parseExpr();
    }
    const t = next();
    return Number(t);
  }

  function parseKeywordArgs() {
    const args = {};
    while (peek() && peek().startsWith(':')) {
      const kw = next().slice(1); // strip ':'
      if (kw === 'color' || kw === 'from' || kw === 'to' || kw === 'axis'
          || kw === 'name' || kw === 'params' || kw === 'args' || kw === 'font') {
        args[kw] = parseStringOrIdent();
      } else if (kw === 'k' || kw === 'rate' || kw === 'count' || kw === 'spacing' || kw === 'sx' || kw === 'sy' || kw === 'sz'
                 || kw === 'angle' || kw === 'value' || kw === 'size' || kw === 'depth') {
        args[kw] = parseNumber();
      } else if (kw === 'tags') {
        // :tags takes a parenthesized list of strings
        args[kw] = parseStringList();
      } else if (kw === 'defaults') {
        // :defaults takes a parenthesized list of (name value) pairs
        args[kw] = parseDefaultsList();
      }
    }
    return args;
  }

  function parseStringOrIdent() {
    const t = next();
    if (typeof t === 'string' && t.startsWith('"')) {
      return t.slice(1, -1);
    }
    return t;
  }

  function parseCube() {
    const size = parseNumber();
    parseKeywordArgs(); // consume any trailing keywords (backwards compat)
    next(); // )
    return ['cube', { size }];
  }

  function parseSphere() {
    const radius = parseNumber();
    parseKeywordArgs();
    next(); // )
    return ['sphere', { radius }];
  }

  function parseCylinder() {
    const radius = parseNumber();
    const height = parseNumber();
    parseKeywordArgs();
    next(); // )
    return ['cylinder', { radius, height }];
  }

  function parseText() {
    // (text "CONTENT" :size S :depth D :font "FONT")
    const content = parseStringOrIdent();
    const kw = parseKeywordArgs();
    next(); // )
    return ['text', {
      content: content || 'Text',
      size: kw.size || 20,
      depth: kw.depth || 4,
      font: kw.font || 'helvetiker'
    }];
  }

  function parsePaint() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['paint', { color: kw.color || 'red' }, ...children];
  }

  function parseRecolor() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['recolor', { from: kw.from || 'gray', to: kw.to || 'red' }, ...children];
  }

  function parseFuse() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['fuse', { k: kw.k || 5 }, ...children];
  }

  function parseTranslate() {
    const x = parseNumber();
    const y = parseNumber();
    const z = parseNumber();
    const children = parseChildren();
    next(); // )
    return ['translate', { x, y, z }, ...children];
  }

  function parseUnion() {
    const children = parseChildren();
    next(); // )
    return ['union', ...children];
  }

  function parseIntersect() {
    const children = parseChildren();
    next(); // )
    return ['intersect', ...children];
  }

  function parseAnti() {
    const children = parseChildren();
    next(); // )
    return ['anti', ...children];
  }

  function parseComplement() {
    const children = parseChildren();
    next(); // )
    return ['complement', ...children];
  }

  function parseRotate() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['rotate', { axis: kw.axis || 'y', angle: kw.angle != null ? kw.angle : 45 }, ...children];
  }

  function parseMirror() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['mirror', { axis: kw.axis || 'x' }, ...children];
  }

  function parseTwist() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['twist', { axis: kw.axis || 'y', rate: kw.rate != null ? kw.rate : 0.1 }, ...children];
  }

  function parseRadial() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['radial', { axis: kw.axis || 'y', count: kw.count || 6 }, ...children];
  }

  function parseStretch() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['stretch', { sx: kw.sx != null ? kw.sx : 1, sy: kw.sy != null ? kw.sy : 1, sz: kw.sz != null ? kw.sz : 1 }, ...children];
  }

  function parseTile() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['tile', { axis: kw.axis || 'x', spacing: kw.spacing || 30 }, ...children];
  }

  function parseBend() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['bend', { axis: kw.axis || 'y', rate: kw.rate != null ? kw.rate : 0.05 }, ...children];
  }

  function parseTaper() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['taper', { axis: kw.axis || 'y', rate: kw.rate != null ? kw.rate : 0.02 }, ...children];
  }

  function parseLet() {
    const name = parseStringOrIdent();
    const children = parseChildren();
    next(); // )
    return ['let', { name: name || 'x' }, ...children];
  }

  function parseVar() {
    const name = parseStringOrIdent();
    next(); // )
    return ['var', { name: name || 'x' }];
  }

  function parseGrow() {
    const name = parseStringOrIdent();
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['grow', { name: name || 'acc', count: kw.count || 4 }, ...children];
  }

  function parseFractal() {
    // (fractal :count N SEED SELF_STEP)
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['fractal', { count: kw.count || 3 }, ...children];
  }

  function parseStir() {
    const children = parseChildren();
    next(); // )
    return ['stir', ...children];
  }

  function parseEnzyme() {
    const kw = parseKeywordArgs();
    // :tags is parsed as a parenthesized list of strings
    const tagList = kw.tags || [];
    const params = { tags: tagList.join(' ') };
    if (kw.defaults && Object.keys(kw.defaults).length > 0) {
      params.defaults = kw.defaults;
    }
    const children = parseChildren();
    next(); // )
    return ['enzyme', params, ...children];
  }

  function parseTags() {
    // (tags ("name1" "name2" ...) CHILD)
    const nameList = parseStringList();
    const children = parseChildren();
    next(); // )
    return ['tags', { names: nameList.join(' ') }, ...children];
  }

  function parseTag() {
    // (tag "name" CHILD)
    const name = parseStringOrIdent();
    const children = parseChildren();
    next(); // )
    return ['tag', { name: name || 'x' }, ...children];
  }

  function parseScalar() {
    // (scalar VALUE) or (scalar :value VALUE)
    // Try keyword form first, fall back to positional
    const kw = parseKeywordArgs();
    if (kw.value != null) {
      next(); // )
      return ['scalar', { value: kw.value }];
    }
    const value = parseNumber();
    next(); // )
    return ['scalar', { value }];
  }

  // Parse a parenthesized list of (name value) pairs: (("x" 5) ("y" (scalar 0)))
  // Returns an object mapping name → value (number or AST expression).
  function parseDefaultsList() {
    const defaults = {};
    if (peek() === '(') {
      next(); // consume outer (
      while (peek() === '(') {
        next(); // consume inner (
        const name = parseStringOrIdent();
        const value = parseNumber(); // handles both literals and sub-expressions
        if (peek() === ')') next(); // consume inner )
        if (name) defaults[name] = value;
      }
      if (peek() === ')') next(); // consume outer )
    }
    return defaults;
  }

  // Parse a parenthesized list of strings: ("a" "b" "c")
  function parseStringList() {
    const list = [];
    if (peek() === '(') {
      next(); // consume (
      while (peek() && peek() !== ')') {
        list.push(parseStringOrIdent());
      }
      next(); // consume )
    }
    return list;
  }

  function parseChildren() {
    const children = [];
    while (peek() === '(') {
      const child = parseExpr();
      if (child) children.push(child);
    }
    return children;
  }

  function skipUntilClose() {
    let depth = 1;
    while (pos < tokens.length && depth > 0) {
      const t = next();
      if (t === '(') depth++;
      if (t === ')') depth--;
    }
  }

  if (tokens.length === 0) return null;
  return parseExpr();
}

function tokenize(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    // Skip whitespace
    if (/\s/.test(text[i])) { i++; continue; }

    // Parens
    if (text[i] === '(' || text[i] === ')') {
      tokens.push(text[i]);
      i++;
      continue;
    }

    // Quoted string
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j++;
      tokens.push(text.slice(i, j + 1)); // includes quotes
      i = j + 1;
      continue;
    }

    // Keyword (:color, :from, :to, :k)
    if (text[i] === ':') {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) j++;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }

    // Number or identifier
    let j = i;
    while (j < text.length && !/[\s()":]/.test(text[j])) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }

  return tokens;
}
