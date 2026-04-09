import * as THREE from 'three';
export { buildOctree, resToDepth, depthForBounds, resToVoxelSize } from './octree-core.js';
import { meshOctreeLeavesRaw } from './octree-core.js';

// Wrap raw mesh data into Three.js BufferGeometry
function rawToGeometry(raw) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(raw.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(raw.normals, 3));
  if (raw.colors) {
    geo.setAttribute('color', new THREE.Float32BufferAttribute(raw.colors, 3));
  }
  geo.setIndex(raw.faces);
  return geo;
}

// Three.js-wrapped API for main thread use
export function meshOctreeLeaves(leaves, pointField, bounds, maxDepth, colorField, stats) {
  const raw = meshOctreeLeavesRaw(leaves, pointField, bounds, maxDepth, colorField, stats);
  return rawToGeometry(raw);
}
