import { BLOCK_DEFS } from './blocks.js';

// Block tree → structured S-expression AST
// AST format: [type, params-object, ...children]
//   ["cube", { size: 20 }]
//   ["paint", { color: "red" }, child]
//   ["translate", { x: 10, y: 0, z: 0 }, childExpr]
//   ["union", child1, child2]

export function generateAST(rootBlocks) {
  if (rootBlocks.length === 0) return null;
  if (rootBlocks.length === 1) return blockToAST(rootBlocks[0]);
  // Multiple roots → implicit union
  return ['union', ...rootBlocks.map(blockToAST)];
}

function blockToAST(block) {
  const def = BLOCK_DEFS[block.type];
  const params = {};

  // Enzyme blocks: convert tagRows to tags string + defaults map
  if (block.type === 'enzyme') {
    const rows = block.params.tagRows || [];
    const tagNames = [];
    const defaults = {};
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.tag) continue; // skip empty rows
      tagNames.push(row.tag);
      // Check for expr-slot block in default position
      const exprBlock = block.exprSlots && block.exprSlots['tagRow_' + i];
      if (exprBlock) {
        defaults[row.tag] = blockToAST(exprBlock);
      } else if (row.default !== '') {
        const num = parseFloat(row.default);
        defaults[row.tag] = isNaN(num) ? row.default : num;
      }
    }
    params.tags = tagNames.join(' ');
    if (Object.keys(defaults).length > 0) {
      params.defaults = defaults;
    }
  } else {
    for (const p of def.params) {
      // If this param has a block in an expr slot, emit its AST instead of the literal
      const exprBlock = block.exprSlots && block.exprSlots[p.name];
      if (exprBlock) {
        params[p.name] = blockToAST(exprBlock);
      } else {
        params[p.name] = block.params[p.name];
      }
    }
  }

  let result;
  if (def.maxChildren === 0) {
    // Primitive: [type, params]
    result = [block.type, params];
  } else {
    // Container: [type, params (if any), ...children]
    const childExprs = block.children.map(blockToAST);

    // Parameterless containers: union, intersect, anti, complement
    const noParamTypes = ['union', 'intersect', 'anti', 'complement', 'stir'];
    if (noParamTypes.includes(block.type)) {
      result = [block.type, ...childExprs];
    } else {
      // All other containers have params
      result = [block.type, params, ...childExprs];
    }
  }
  // Annotate with block ID for tap-to-highlight (non-enumerable, won't affect formatSExpr)
  result._blockId = block.id;
  return result;
}

// S-expression AST → pretty-printed string

export function formatSExpr(ast) {
  if (!ast) return '';
  return formatNode(ast, 0);
}

// Format a parameter value that may be a literal or an embedded expression.
// Expressions (AST arrays) are formatted inline without leading indentation.
function fmtParam(val) {
  if (Array.isArray(val)) {
    // Embedded expression — format it at indent 0 and strip leading whitespace
    return formatNode(val, 0);
  }
  return String(val);
}

function formatNode(node, indent) {
  const pad = '  '.repeat(indent);
  const type = node[0];

  switch (type) {
    case 'cube': {
      const p = node[1];
      return `${pad}(cube ${fmtParam(p.size)})`;
    }
    case 'sphere': {
      const p = node[1];
      return `${pad}(sphere ${fmtParam(p.radius)})`;
    }
    case 'cylinder': {
      const p = node[1];
      return `${pad}(cylinder ${fmtParam(p.radius)} ${fmtParam(p.height)})`;
    }
    case 'text': {
      const p = node[1];
      return `${pad}(text "${fmtParam(p.content)}" :size ${fmtParam(p.size)} :depth ${fmtParam(p.depth)} :font "${p.font || 'helvetiker'}")`;
    }
    case 'translate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(translate ${fmtParam(p.x)} ${fmtParam(p.y)} ${fmtParam(p.z)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(translate ${fmtParam(p.x)} ${fmtParam(p.y)} ${fmtParam(p.z)}\n${childStrs})`;
    }
    case 'rotate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(rotate :axis "${p.axis}" :angle ${fmtParam(p.angle)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(rotate :axis "${p.axis}" :angle ${fmtParam(p.angle)}\n${childStrs})`;
    }
    case 'paint': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(paint :color "${p.color}")`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(paint :color "${p.color}"\n${childStrs})`;
    }
    case 'recolor': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(recolor :from "${p.from}" :to "${p.to}")`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(recolor :from "${p.from}" :to "${p.to}"\n${childStrs})`;
    }
    case 'union':
    case 'intersect': {
      const children = node.slice(1);
      if (children.length === 0) {
        return `${pad}(${type})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(${type}\n${childStrs})`;
    }
    case 'anti':
    case 'complement': {
      const children = node.slice(1);
      if (children.length === 0) {
        return `${pad}(${type})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(${type}\n${childStrs})`;
    }
    case 'fuse': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(fuse :k ${fmtParam(p.k)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(fuse :k ${fmtParam(p.k)}\n${childStrs})`;
    }
    case 'mirror': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(mirror :axis "${p.axis}")`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(mirror :axis "${p.axis}"\n${childStrs})`;
    }
    case 'twist': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(twist :axis "${p.axis}" :rate ${fmtParam(p.rate)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(twist :axis "${p.axis}" :rate ${fmtParam(p.rate)}\n${childStrs})`;
    }
    case 'radial': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(radial :axis "${p.axis}" :count ${fmtParam(p.count)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(radial :axis "${p.axis}" :count ${fmtParam(p.count)}\n${childStrs})`;
    }
    case 'stretch': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(stretch :sx ${fmtParam(p.sx)} :sy ${fmtParam(p.sy)} :sz ${fmtParam(p.sz)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(stretch :sx ${fmtParam(p.sx)} :sy ${fmtParam(p.sy)} :sz ${fmtParam(p.sz)}\n${childStrs})`;
    }
    case 'tile': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(tile :axis "${p.axis}" :spacing ${fmtParam(p.spacing)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(tile :axis "${p.axis}" :spacing ${fmtParam(p.spacing)}\n${childStrs})`;
    }
    case 'bend': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(bend :axis "${p.axis}" :rate ${fmtParam(p.rate)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(bend :axis "${p.axis}" :rate ${fmtParam(p.rate)}\n${childStrs})`;
    }
    case 'taper': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(taper :axis "${p.axis}" :rate ${fmtParam(p.rate)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(taper :axis "${p.axis}" :rate ${fmtParam(p.rate)}\n${childStrs})`;
    }
    case 'let': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(let "${p.name}")`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(let "${p.name}"\n${childStrs})`;
    }
    case 'var': {
      const p = node[1];
      return `${pad}(var "${p.name}")`;
    }
    case 'grow': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(grow "${p.name}" :count ${fmtParam(p.count)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(grow "${p.name}" :count ${fmtParam(p.count)}\n${childStrs})`;
    }
    case 'fractal': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(fractal :count ${fmtParam(p.count)})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(fractal :count ${fmtParam(p.count)}\n${childStrs})`;
    }
    case 'stir': {
      const children = node.slice(1);
      if (children.length === 0) {
        return `${pad}(stir)`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(stir\n${childStrs})`;
    }
    case 'enzyme': {
      const p = node[1];
      const tagList = (p.tags || '').trim().split(/\s+/).filter(Boolean);
      const tagsStr = tagList.map(t => `"${t}"`).join(' ');
      let defaultsStr = '';
      if (p.defaults && Object.keys(p.defaults).length > 0) {
        const pairs = Object.entries(p.defaults).map(([k, v]) =>
          `("${k}" ${fmtParam(v)})`
        ).join(' ');
        defaultsStr = ` :defaults (${pairs})`;
      }
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(enzyme :tags (${tagsStr})${defaultsStr})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(enzyme :tags (${tagsStr})${defaultsStr}\n${childStrs})`;
    }
    case 'tags': {
      const p = node[1];
      const nameList = (p.names || '').trim().split(/\s+/).filter(Boolean);
      const namesStr = nameList.map(n => `"${n}"`).join(' ');
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(tags (${namesStr}))`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(tags (${namesStr})\n${childStrs})`;
    }
    case 'tag': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(tag "${p.name}")`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(tag "${p.name}"\n${childStrs})`;
    }
    case 'scalar': {
      const p = node[1];
      return `${pad}(scalar ${fmtParam(p.value)})`;
    }
    case 'timing': {
      const p = node[1];
      const label = (p && p.label) || '';
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(timing "${label}")`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(timing "${label}"\n${childStrs})`;
    }
    default:
      return `${pad}(${type})`;
  }
}
