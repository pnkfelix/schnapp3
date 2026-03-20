import * as THREE from 'three';

// S-expression AST → Three.js geometry
// Consumes the structured AST from codegen.js, knows nothing about blocks.

const COLOR_MAP = {
  red:   0xff4444,
  blue:  0x4488ff,
  green: 0x44cc44
};

export function evaluate(ast) {
  if (!ast) return new THREE.Group();
  const result = evalNode(ast);
  if (!result) return new THREE.Group();
  const group = new THREE.Group();
  group.add(result);
  return group;
}

function evalNode(node) {
  const type = node[0];

  switch (type) {
    case 'cube': {
      const p = node[1];
      const s = p.size || 20;
      const geo = new THREE.BoxGeometry(s, s, s);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[p.color] || 0xcccccc });
      return new THREE.Mesh(geo, mat);
    }
    case 'sphere': {
      const p = node[1];
      const geo = new THREE.SphereGeometry(p.radius || 15, 32, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[p.color] || 0xcccccc });
      return new THREE.Mesh(geo, mat);
    }
    case 'cylinder': {
      const p = node[1];
      const r = p.radius || 10;
      const h = p.height || 30;
      const geo = new THREE.CylinderGeometry(r, r, h, 32);
      const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[p.color] || 0xcccccc });
      return new THREE.Mesh(geo, mat);
    }
    case 'translate': {
      const p = node[1];
      const children = node.slice(2);
      if (children.length === 0) return null;
      const group = new THREE.Group();
      group.position.set(p.x || 0, p.y || 0, p.z || 0);
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return group;
    }
    case 'union': {
      const children = node.slice(1);
      const group = new THREE.Group();
      for (const child of children) {
        const obj = evalNode(child);
        if (obj) group.add(obj);
      }
      return group;
    }
    default:
      return null;
  }
}
