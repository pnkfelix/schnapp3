// S-expression text → AST (same format as codegen.js output)
//
// Grammar:
//   (cube SIZE :color "COLOR")
//   (sphere RADIUS :color "COLOR")
//   (cylinder RADIUS HEIGHT :color "COLOR")
//   (translate X Y Z CHILD...)
//   (union CHILD...)

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
      if (kw === 'color') {
        args.color = parseStringOrIdent();
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
    const kw = parseKeywordArgs();
    next(); // )
    return ['cube', { size, color: kw.color || 'blue' }];
  }

  function parseSphere() {
    const radius = parseNumber();
    const kw = parseKeywordArgs();
    next(); // )
    return ['sphere', { radius, color: kw.color || 'blue' }];
  }

  function parseCylinder() {
    const radius = parseNumber();
    const height = parseNumber();
    const kw = parseKeywordArgs();
    next(); // )
    return ['cylinder', { radius, height, color: kw.color || 'green' }];
  }

  function parseSmoothUnion() {
    const kw = parseKeywordArgs();
    const children = parseChildren();
    next(); // )
    return ['smooth-union', { k: kw.k || 5, color: kw.color || 'orange' }, ...children];
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

    // Keyword (:color)
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
