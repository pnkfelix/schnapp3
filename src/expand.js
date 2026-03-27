// AST expansion pass: resolve let/var, grow, stir/enzyme/tags
//
// Runs before evaluation. Expands PL constructs into the core geometry AST
// that the evaluator already knows how to handle.
//
// The key abstraction: stir is the application mechanism. A stir bag contains
// enzymes, tagged values, and bare values. Reactions fire by matching enzyme
// tag requirements against the tag sets of values in the soup.
//
// Every value carries a tag set. Bare values get implicit type-tags at runtime:
//   3           → tags: {"scalar"}
//   (cube 20)   → tags: {"shape"}
// The (tags ("radius") EXPR) form adds tags to whatever EXPR produces:
//   (tags ("radius") 3) → tags: {"radius", "scalar"}

// ---- Expression contexts ----
//
// Each entry maps an AST node type to:
//   exprParams: param keys (in node[1]) that can hold expressions, not just literals
//   childrenStart: index where child AST nodes begin (0 = no children, 1 = from index 1, 2 = from index 2)
//
// Params NOT listed in exprParams are inert (strings, constants) and are never expanded.
// Node types not listed here are handled by special cases in expandNode.

const EXPR_CONTEXTS = {
  // Primitives (leaf nodes — no children)
  cube:       { exprParams: ['size'],              childrenStart: 0 },
  sphere:     { exprParams: ['radius'],            childrenStart: 0 },
  cylinder:   { exprParams: ['radius', 'height'],  childrenStart: 0 },
  // Transforms (params + children)
  translate:  { exprParams: ['x', 'y', 'z'],       childrenStart: 2 },
  rotate:     { exprParams: ['angle'],              childrenStart: 2 },
  stretch:    { exprParams: ['sx', 'sy', 'sz'],     childrenStart: 2 },
  radial:     { exprParams: ['count'],              childrenStart: 2 },
  tile:       { exprParams: ['spacing'],            childrenStart: 2 },
  twist:      { exprParams: ['rate'],               childrenStart: 2 },
  bend:       { exprParams: ['rate'],               childrenStart: 2 },
  taper:      { exprParams: ['rate'],               childrenStart: 2 },
  // These have only string/enum params — no expression params
  paint:      { exprParams: [],                     childrenStart: 2 },
  recolor:    { exprParams: [],                     childrenStart: 2 },
  mirror:     { exprParams: [],                     childrenStart: 2 },
  // CSG (keyword-only or keyword+children)
  fuse:       { exprParams: ['k'],                  childrenStart: 2 },
  // NOTE: 'scalar' is NOT here — it reduces to a bare number in expandNode.
  // NOTE: 'tag' is NOT here — it has special semantics (transparent outside stir,
  // tag-accumulation inside stir) handled by switch cases and collectStirItem.
};

// Parameterless containers: children start at index 1, no params object
const BARE_CONTAINERS = new Set(['union', 'intersect', 'anti', 'complement']);

// ---- Implicit type tags ----

function implicitTags(node) {
  if (!Array.isArray(node)) {
    if (typeof node === 'number') return new Set(['scalar']);
    if (typeof node === 'string') return new Set(['scalar']);
    return new Set();
  }
  const type = node[0];
  if (type === 'scalar') return new Set(['scalar']);
  if (type === 'enzyme') return new Set(['enzyme']);
  return new Set(['shape']);
}

// ---- Tag operations ----
// Tags are a _tags array on the value itself: in the params object for AST
// nodes, or a .tags field on enzyme closures and bundles.  Bare scalars
// (numbers) cannot carry tags; tagging one promotes it to a structured
// ['scalar', {value, _tags}] node.

// Read the explicit tags on a value.
function getValueTags(v) {
  if (!v) return [];
  if (v.__enzyme || v.__bundle) return v.tags || [];
  if (Array.isArray(v)) {
    const params = v[1];
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      return params._tags || [];
    }
  }
  return [];
}

// Return a copy of v with tagName added to its tags.
function addTagToValue(v, tagName) {
  if (v === null || v === undefined) return v;

  // Enzyme closure
  if (v.__enzyme) {
    const tags = v.tags ? [...v.tags, tagName] : [tagName];
    return { ...v, tags };
  }
  // Bundle
  if (v.__bundle) {
    const tags = v.tags ? [...v.tags, tagName] : [tagName];
    return { ...v, tags };
  }
  // Bare scalar — promote to structured scalar
  if (!Array.isArray(v)) {
    return ['scalar', { value: v, _tags: [tagName] }];
  }
  // AST node
  const type = v[0];
  const existing = (v[1] && typeof v[1] === 'object' && !Array.isArray(v[1]))
    ? v[1] : null;

  if (existing) {
    // Node already has params — add tag there
    const tags = existing._tags ? [...existing._tags, tagName] : [tagName];
    return [type, { ...existing, _tags: tags }, ...v.slice(2)];
  }
  // Bare container (union, intersect, etc.) — insert a params object
  return [type, { _tags: [tagName] }, ...v.slice(1)];
}

// Return a copy of v with tagName removed from its tags.
function stripOneTag(v, tagName) {
  if (v === null || v === undefined) return v;

  if (v.__enzyme || v.__bundle) {
    if (!v.tags) return v;
    const tags = v.tags.filter(t => t !== tagName);
    return { ...v, tags: tags.length ? tags : undefined };
  }
  if (!Array.isArray(v)) return v;

  const type = v[0];
  const params = (v[1] && typeof v[1] === 'object' && !Array.isArray(v[1]))
    ? v[1] : null;
  if (!params || !params._tags) return v;

  const tags = params._tags.filter(t => t !== tagName);
  if (tags.length === params._tags.length) return v; // tag wasn't present

  // For promoted scalars with no remaining tags, reduce back to bare value
  if (type === 'scalar' && tags.length === 0) {
    return params.value;
  }

  const newParams = { ...params };
  if (tags.length === 0) delete newParams._tags;
  else newParams._tags = tags;

  // If this was a bare container that only had _tags in its params, strip the params
  if (BARE_CONTAINERS.has(type) && Object.keys(newParams).length === 0) {
    return [type, ...v.slice(2)];
  }
  return [type, newParams, ...v.slice(2)];
}

// Strip ALL tags from a value — used at consumption points (expression
// params) where the consumer needs the raw scalar or shape.
function stripTags(v) {
  if (v === null || v === undefined) return v;
  if (!Array.isArray(v)) return v;
  if (v[0] === 'scalar') {
    const p = v[1];
    return (p && p._tags) ? p.value : v;
  }
  return v;
}

// ---- Main entry point ----

export function expandAST(ast, env) {
  if (!ast) return ast;
  if (!env) env = new Map();
  return expandNode(ast, env);
}

function expandNode(node, env) {
  if (!Array.isArray(node)) return node;

  const type = node[0];

  switch (type) {
    case 'let': {
      // (let {name} value-expr body-expr)
      const p = node[1];
      const name = p.name || 'x';
      const children = node.slice(2);
      if (children.length < 2) {
        if (children.length === 1) return expandNode(children[0], env);
        return null;
      }
      const valueAST = expandNode(children[0], env);
      const newEnv = new Map(env);
      newEnv.set(name, valueAST);
      return expandNode(children[1], newEnv);
    }

    case 'var': {
      // (var {name})
      const p = node[1];
      const name = p.name || 'x';
      const bound = env.get(name);
      if (bound !== undefined) return bound;
      console.warn(`Unbound variable: ${name}`);
      return ['union'];
    }

    case 'grow': {
      // (grow {name, count} seed-expr step-body-expr)
      const p = node[1];
      const name = p.name || 'acc';
      const count = Math.max(1, Math.min(50, p.count || 4));
      const children = node.slice(2);
      if (children.length < 2) {
        if (children.length === 1) return expandNode(children[0], env);
        return null;
      }
      let current = expandNode(children[0], env);
      const stepBody = children[1];
      for (let i = 0; i < count; i++) {
        const iterEnv = new Map(env);
        iterEnv.set(name, current);
        current = expandNode(stepBody, iterEnv);
      }
      return current;
    }

    case 'fractal': {
      // (fractal {count} SEED (enzyme "recur" (enzyme "input" BODY)))
      // call/cc pattern: fractal doesn't name anything; the enzymes do.
      return expandFractal(node, env);
    }

    case 'tags': {
      // (tags {names} child) — attach tag names to the expanded child value.
      const p = node[1];
      const nameList = (p.names || '').trim().split(/\s+/).filter(Boolean);
      const children = node.slice(2);
      if (children.length === 0) return null;
      let inner = expandNode(children[0], env);
      if (inner === null) return null;
      for (const name of nameList) inner = addTagToValue(inner, name);
      return inner;
    }

    case 'scalar': {
      // (scalar {value}) — reduces to a bare number
      const p = node[1];
      if (Array.isArray(p.value)) return expandNode(p.value, env);
      return p.value;
    }

    case 'tag': {
      // (tag {name} child) — attach tag name to the expanded child value.
      const children = node.slice(2);
      if (children.length === 0) return null;
      const inner = expandNode(children[0], env);
      if (inner === null) return null;
      return addTagToValue(inner, node[1].name || '');
    }

    case 'enzyme': {
      // Enzymes are values — don't expand the body yet.
      // Just return the enzyme node with env captured for later.
      // We attach the captured env so stir can use it when firing the reaction.
      return { __enzyme: true, node, env: new Map(env) };
    }

    case 'stir': {
      return expandStir(node, env);
    }

    default: {
      // Bare containers: union, intersect, anti, complement
      // May or may not have a params object (tagged ones do).
      if (BARE_CONTAINERS.has(type)) {
        const hasParams = node[1] && typeof node[1] === 'object' && !Array.isArray(node[1]);
        const params = hasParams ? node[1] : null;
        const children = hasParams ? node.slice(2) : node.slice(1);
        const expanded = [];
        for (const child of children) {
          const e = expandNode(child, env);
          if (e !== null) expanded.push(e);
        }
        return params ? [type, params, ...expanded] : [type, ...expanded];
      }

      // Look up the expression context for this node type
      const ctx = EXPR_CONTEXTS[type];
      if (ctx) {
        return expandWithContext(node, env, ctx);
      }

      // Unknown node type — pass through, expanding any array children
      return node.map(item => Array.isArray(item) ? expandNode(item, env) : item);
    }
  }
}

// ---- Context-driven expansion ----
// Given a node and its EXPR_CONTEXTS entry, expand expression-valued params
// and child nodes. Params not in exprParams are copied verbatim.

function expandWithContext(node, env, ctx) {
  const type = node[0];
  const params = (node.length >= 2 && node[1] && typeof node[1] === 'object' && !Array.isArray(node[1]))
    ? node[1] : {};
  const exprSet = new Set(ctx.exprParams);

  // Expand params: only walk into expression-capable slots.
  // Strip tags here because param values live inside a plain object, not
  // as AST children — stripAllTags (which walks the AST tree) won't
  // reach inside params objects to clean them up.
  const expandedParams = {};
  for (const [key, val] of Object.entries(params)) {
    if (exprSet.has(key) && Array.isArray(val)) {
      expandedParams[key] = stripTags(expandNode(val, env));
    } else {
      expandedParams[key] = val;
    }
  }

  // Expand children
  if (ctx.childrenStart > 0) {
    const children = node.slice(ctx.childrenStart);
    const expanded = children.map(c => expandNode(c, env)).filter(c => c !== null);
    return [type, expandedParams, ...expanded];
  }

  // Leaf node (no children)
  return [type, expandedParams];
}

// ---- Stir expansion ----
// Unified pool: every participant has carries (tags it bears) and wants
// (tags it seeks). An enzyme carries "block" and wants its declared tags.
// A shape carries "shape". A scalar carries "scalar". Reactions fire when
// one participant's wants match other participants' carries.
//
// Pool item: { carries: Set<string>, wants: Set<string>, value: any }
// The value IS the thing — an AST node, a number, or an enzyme closure.
// Check value.__enzyme to know if it's callable.

function expandStir(node, env) {
  const children = node.slice(1);

  // Phase 1: Expand all children into the unified pool.
  const pool = [];

  for (const child of children) {
    collectStirItemUnified(child, env, pool);
  }

  // Phase 2 + 3: run reactions and collect results
  return runStirPool(pool);
}

// Run the stir reaction loop on an already-populated pool.
// Returns the resulting AST node (or null).
function runStirPool(pool) {
  let changed = true;
  const MAX_REACTIONS = 100;
  let reactions = 0;

  while (changed && reactions < MAX_REACTIONS) {
    changed = false;

    // Phase A: try full reactions (all wants satisfied)
    for (let ci = 0; ci < pool.length; ci++) {
      const consumer = pool[ci];
      if (!consumer || consumer.wants.size === 0) continue;
      if (!consumer.value || !consumer.value.__enzyme) continue;

      const match = matchPool(consumer.wants, pool, ci);
      if (!match) continue;

      // Fire the reaction — strip the matched tag from each consumed value
      const enz = consumer.value;
      const bodyEnv = new Map(enz.env);
      for (const [tagName, itemIndex] of match) {
        bodyEnv.set(tagName, stripOneTag(pool[itemIndex].value, tagName));
      }

      // Remove consumer and consumed items
      pool[ci] = null;
      for (const [, itemIndex] of match) {
        pool[itemIndex] = null;
      }

      // Expand body and add result to pool.  Tags in the body (e.g.
      // (tag "x" expr)) become _tags on the result value, so addToPool
      // picks them up as carries automatically.
      const body = enz.node.length > 2 ? enz.node[2] : ['union'];
      const result = expandNode(body, bodyEnv);
      if (result !== null) addToPool(result, pool);

      changed = true;
      reactions++;
      break; // restart matching
    }

    // Phase B: if no full reaction fired, try partial application (currying)
    if (!changed) {
      for (let ci = 0; ci < pool.length; ci++) {
        const consumer = pool[ci];
        if (!consumer || consumer.wants.size === 0) continue;
        if (!consumer.value || !consumer.value.__enzyme) continue;

        const partial = partialMatchPool(consumer.wants, pool, ci);
        if (!partial) continue;

        // Build partially applied enzyme: bind matched tags (stripped), keep the rest
        const enz = consumer.value;
        const newEnv = new Map(enz.env);
        for (const [tagName, itemIndex] of partial) {
          newEnv.set(tagName, stripOneTag(pool[itemIndex].value, tagName));
        }

        const remainingTags = [];
        for (const tagName of consumer.wants) {
          if (!partial.has(tagName)) remainingTags.push(tagName);
        }

        const newNode = [
          'enzyme',
          { tags: remainingTags.join(' ') },
          ...(enz.node.length > 2 ? [enz.node[2]] : [])
        ];
        const partialEnzyme = { __enzyme: true, node: newNode, env: newEnv };

        // Remove consumer and consumed items
        pool[ci] = null;
        for (const [, itemIndex] of partial) {
          pool[itemIndex] = null;
        }

        // Add the partially applied enzyme back — it may now fully match
        addToPool(partialEnzyme, pool);

        changed = true;
        reactions++;
        break; // restart matching
      }
    }
  }

  // Collect remaining values (including enzyme closures for currying support)
  const remaining = [];
  let hasEnzyme = false;
  for (const item of pool) {
    if (!item) continue;
    remaining.push(item.value);
    if (item.value && item.value.__enzyme) hasEnzyme = true;
  }

  if (remaining.length === 0) return null;
  if (remaining.length === 1) return remaining[0];
  // If any enzymes survive, bundle so a later stir can unpack them.
  // A plain ['union', ...] would bury the enzymes inside an AST node.
  if (hasEnzyme) return { __bundle: true, items: remaining };
  return ['union', ...remaining];
}

// Add an already-expanded value to the pool, with optional extra tags
function addToPool(expanded, pool, extraTags) {
  // Unpack bundles: each item enters the pool individually
  if (expanded && expanded.__bundle) {
    for (const item of expanded.items) {
      addToPool(item, pool, extraTags);
    }
    return;
  }

  let carries, wants;
  if (expanded && expanded.__enzyme) {
    const tagNames = (expanded.node[1].tags || '').trim().split(/\s+/).filter(Boolean);
    carries = new Set(['block']);
    wants = new Set(tagNames);
    // Enzyme closures can also carry explicit tags (from currying or tagging)
    if (expanded.tags) {
      for (const t of expanded.tags) carries.add(t);
    }
  } else {
    carries = implicitTags(expanded);
    // Read explicit tags from the value's _tags field
    for (const t of getValueTags(expanded)) carries.add(t);
    wants = new Set();
  }
  if (extraTags) {
    for (const t of extraTags) carries.add(t);
  }
  pool.push({ carries, wants, value: expanded });
}

// Match a set of wanted tags against pool items' carries.
// Returns Map<tagName, poolIndex> or null.
function matchPool(wants, pool, consumerIndex) {
  const match = new Map();
  const used = new Set();

  for (const tagName of wants) {
    let found = -1;
    let ambiguous = false;
    for (let i = 0; i < pool.length; i++) {
      if (i === consumerIndex) continue;
      if (pool[i] === null || used.has(i)) continue;
      if (pool[i].carries.has(tagName)) {
        if (found >= 0) { ambiguous = true; break; }
        found = i;
      }
    }
    if (found < 0 || ambiguous) return null;
    match.set(tagName, found);
    used.add(found);
  }

  return match;
}

// Partial match: like matchPool but returns whatever tags CAN be matched.
// Returns Map<tagName, poolIndex> with at least 1 entry, or null if nothing matches.
// Only returns a result if it's a proper partial match (some but not all tags).
function partialMatchPool(wants, pool, consumerIndex) {
  const match = new Map();
  const used = new Set();

  for (const tagName of wants) {
    let found = -1;
    let ambiguous = false;
    for (let i = 0; i < pool.length; i++) {
      if (i === consumerIndex) continue;
      if (pool[i] === null || used.has(i)) continue;
      if (pool[i].carries.has(tagName)) {
        if (found >= 0) { ambiguous = true; break; }
        found = i;
      }
    }
    if (found >= 0 && !ambiguous) {
      match.set(tagName, found);
      used.add(found);
    }
  }

  if (match.size > 0 && match.size < wants.size) return match;
  return null;
}

// ---- Fractal expansion (tree-recursive grow via stir) ----
//
// Syntax: (fractal :count N SEED PROC)
//
// PROC is opaque — fractal never inspects it. fractal constructs a
// depth-limited callback tagged "step" and stirs it with PROC and SEED:
//
//   expandStir(['stir', CALLBACK_N, PROC, SEED])
//
// The callback is an enzyme that wants "shape". When fired:
//   depth > 0: body = (stir PROC_AST (tag "step" CALLBACK_{N-1}) (tag "shape" input))
//              i.e. re-invoke PROC with a shallower callback and the input
//   depth = 0: body = (var "shape")  — identity, return the input as-is
//
// PROC is expected to want "step" (the callback) and "shape" (the seed).
// The convention: fractal tags its callback with "step".

function expandFractal(node, env) {
  const p = node[1];
  const count = Math.max(1, Math.min(8, p.count || 3));
  const children = node.slice(2);

  if (children.length < 2) {
    if (children.length === 1) return expandNode(children[0], env);
    return null;
  }

  const seed = expandNode(children[0], env);
  const procAST = children[1]; // opaque — not inspected

  // Build the callback chain dynamically, depth 0 up to N.
  // Each callback is an enzyme closure wanting "shape".
  //
  // At depth 0: body is (var "shape") — identity
  // At depth d: body is (stir PROC_AST (tag "step" (var "__recur")) (tag "shape" (var "shape")))
  //             where __recur is bound to callback at depth d-1

  const identityBody = ['var', { name: 'shape' }];
  const identityNode = ['enzyme', { tags: 'shape' }, identityBody];
  let callback = { __enzyme: true, node: identityNode, env: new Map(env) };

  for (let d = 1; d <= count; d++) {
    const recurBody = ['stir',
      procAST,
      ['tag', { name: 'step' }, ['var', { name: '__recur' }]],
      ['tag', { name: 'shape' }, ['var', { name: 'shape' }]]
    ];
    const recurNode = ['enzyme', { tags: 'shape' }, recurBody];
    const recurEnv = new Map(env);
    recurEnv.set('__recur', callback); // previous (shallower) callback
    callback = { __enzyme: true, node: recurNode, env: recurEnv };
  }

  // Now stir: CALLBACK (tagged "step") + PROC + SEED (tagged "shape")
  // Build a synthetic stir node and expand it
  const stirPool = [];
  addToPool(callback, stirPool, ['step']);

  // Expand PROC and add to pool
  const procExpanded = expandNode(procAST, env);
  if (procExpanded === null) return seed;
  addToPool(procExpanded, stirPool);

  // Add seed as a "shape"-tagged value
  addToPool(seed, stirPool, ['shape']);

  // Run the stir reaction loop
  return runStirPool(stirPool);
}

function collectStirItemUnified(child, env, pool) {
  // Expand the child and add to pool.
  // Tags are now preserved as AST metadata by expandNode, and addToPool
  // extracts explicit tag names as carries. No special-casing needed.
  const expanded = expandNode(child, env);
  if (expanded === null) return;
  addToPool(expanded, pool);
}
