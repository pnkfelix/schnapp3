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
//   (smooth-union :k K CHILD...)

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
      case 'translate': return parseTranslate();
      case 'paint': return parsePaint();
      case 'recolor': return parseRecolor();
      case 'union': return parseUnion();
      case 'smooth-union': return parseSmoothUnion();
      default: {
        skipUntilClose();
        return [type];
      }
    }
  }

  function parseNumber() {
    const t = next();
    return Number(t);
  }

  function parseKeywordArgs() {
    const args = {};
    while (peek() && peek().startsWith(':')) {
      const kw = next().slice(1); // strip ':'
      if (kw === 'color' || kw === 'from' || kw === 'to') {
        args[kw] = parseStringOrIdent();
      } else if (kw === 'k') {
        args.k = parseNumber();
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

  function parseSmoothUnion() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['smooth-union', { k: kw.k || 5 }, ...children];
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
