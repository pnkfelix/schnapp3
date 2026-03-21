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
  for (const p of def.params) {
    params[p.name] = block.params[p.name];
  }

  if (def.maxChildren === 0) {
    // Primitive: [type, params]
    return [block.type, params];
  }

  // Container: [type, params (if any), ...children]
  const childExprs = block.children.map(blockToAST);

  // Parameterless containers: union, intersect, anti, complement
  const noParamTypes = ['union', 'intersect', 'anti', 'complement'];
  if (noParamTypes.includes(block.type)) {
    return [block.type, ...childExprs];
  }
  // All other containers have params: translate, paint, recolor, fuse
  return [block.type, params, ...childExprs];
}

// S-expression AST → pretty-printed string

export function formatSExpr(ast) {
  if (!ast) return '';
  return formatNode(ast, 0);
}

function formatNode(node, indent) {
  const pad = '  '.repeat(indent);
  const type = node[0];

  switch (type) {
    case 'cube': {
      const p = node[1];
      return `${pad}(cube ${p.size})`;
    }
    case 'sphere': {
      const p = node[1];
      return `${pad}(sphere ${p.radius})`;
    }
    case 'cylinder': {
      const p = node[1];
      return `${pad}(cylinder ${p.radius} ${p.height})`;
    }
    case 'translate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(translate ${p.x} ${p.y} ${p.z})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(translate ${p.x} ${p.y} ${p.z}\n${childStrs})`;
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
        return `${pad}(fuse :k ${p.k})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(fuse :k ${p.k}\n${childStrs})`;
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
        return `${pad}(twist :axis "${p.axis}" :rate ${p.rate})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(twist :axis "${p.axis}" :rate ${p.rate}\n${childStrs})`;
    }
    case 'radial': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(radial :axis "${p.axis}" :count ${p.count})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(radial :axis "${p.axis}" :count ${p.count}\n${childStrs})`;
    }
    case 'stretch': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(stretch :sx ${p.sx} :sy ${p.sy} :sz ${p.sz})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(stretch :sx ${p.sx} :sy ${p.sy} :sz ${p.sz}\n${childStrs})`;
    }
    case 'tile': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(tile :axis "${p.axis}" :spacing ${p.spacing})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(tile :axis "${p.axis}" :spacing ${p.spacing}\n${childStrs})`;
    }
    case 'bend': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(bend :axis "${p.axis}" :rate ${p.rate})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(bend :axis "${p.axis}" :rate ${p.rate}\n${childStrs})`;
    }
    case 'taper': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) {
        return `${pad}(taper :axis "${p.axis}" :rate ${p.rate})`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(taper :axis "${p.axis}" :rate ${p.rate}\n${childStrs})`;
    }
    default:
      return `${pad}(${type})`;
  }
}
