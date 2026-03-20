import { BLOCK_DEFS } from './blocks.js';

// Block tree → structured S-expression AST
// AST format: [type, params-object, ...children]
//   ["cube", { size: 20, color: "red" }]
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

  if (block.type === 'translate') {
    return ['translate', params, ...childExprs];
  }
  // union: no params, just children
  return ['union', ...childExprs];
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
      return `${pad}(cube ${p.size} :color "${p.color}")`;
    }
    case 'sphere': {
      const p = node[1];
      return `${pad}(sphere ${p.radius} :color "${p.color}")`;
    }
    case 'cylinder': {
      const p = node[1];
      return `${pad}(cylinder ${p.radius} ${p.height} :color "${p.color}")`;
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
    case 'union': {
      const children = node.slice(1);
      if (children.length === 0) {
        return `${pad}(union)`;
      }
      const childStrs = children.map(c => formatNode(c, indent + 1)).join('\n');
      return `${pad}(union\n${childStrs})`;
    }
    default:
      return `${pad}(${type})`;
  }
}
