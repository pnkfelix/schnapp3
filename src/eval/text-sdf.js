// text-sdf.js — Build and cache SDF field functions for text primitives.
//
// Depends on Three.js TextGeometry and the mesh-sdf voxelizer.
// Font objects must be provided by the caller (from evaluator.js font cache).

import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { meshToSDF } from './mesh-sdf.js';

// Cache: key → { field, bounds }
const textSDFCache = new Map();

function cacheKey(content, fontSize, depth, fontName) {
  return `${fontName}|${fontSize}|${depth}|${content}`;
}

// Build or retrieve a cached SDF field for a text node.
// font: a loaded Three.js Font object (or null if not yet loaded)
// Returns: (x, y, z) => distance, or null if font unavailable.
export function getTextSDF(content, fontSize, depth, font) {
  if (!font) return null;

  const key = cacheKey(content, fontSize, depth, font.data.familyName + (font.data.resolution || ''));
  if (textSDFCache.has(key)) return textSDFCache.get(key);

  // Build TextGeometry
  const geo = new TextGeometry(content, {
    font,
    size: fontSize,
    depth: depth,
    curveSegments: 4,     // lower than display for speed
    bevelEnabled: true,
    bevelThickness: Math.min(depth * 0.1, 1),
    bevelSize: Math.min(fontSize * 0.03, 0.5),
    bevelOffset: 0,
    bevelSegments: 2      // lower than display for speed
  });

  // Center the geometry (same as evalNode does for display)
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = -(bb.min.x + bb.max.x) / 2;
  const cy = -(bb.min.y + bb.max.y) / 2;
  const cz = -(bb.min.z + bb.max.z) / 2;
  geo.translate(cx, cy, cz);

  // Choose resolution based on text complexity
  const charCount = content.length;
  const res = Math.min(64, Math.max(32, charCount * 10));

  const result = meshToSDF(geo, res);
  geo.dispose();
  textSDFCache.set(key, result);
  return result;
}

// Build a serializable SDF grid for a text node at a given resolution.
// Returns { sdf: Float32Array, ox, oy, oz, nx, ny, nz, voxelSize } or null.
// This data can be postMessage'd to a worker (sdf is transferable).
export function getTextSDFGrid(content, fontSize, depth, font, resolution) {
  if (!font) return null;

  const geo = new TextGeometry(content, {
    font,
    size: fontSize,
    depth: depth,
    curveSegments: 4,
    bevelEnabled: true,
    bevelThickness: Math.min(depth * 0.1, 1),
    bevelSize: Math.min(fontSize * 0.03, 0.5),
    bevelOffset: 0,
    bevelSegments: 2
  });

  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = -(bb.min.x + bb.max.x) / 2;
  const cy = -(bb.min.y + bb.max.y) / 2;
  const cz = -(bb.min.z + bb.max.z) / 2;
  geo.translate(cx, cy, cz);

  const result = meshToSDF(geo, resolution);
  geo.dispose();

  return { sdf: result.sdf, ox: result.ox, oy: result.oy, oz: result.oz,
           nx: result.nx, ny: result.ny, nz: result.nz, voxelSize: result.voxelSize };
}

// Clear cache (call if fonts change or memory pressure)
export function clearTextSDFCache() {
  textSDFCache.clear();
}
