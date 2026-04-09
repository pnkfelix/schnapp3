import * as THREE from 'three';

// Naive Surface Nets — extract a mesh from a signed distance field.
// No lookup tables. For each grid cell the surface crosses, place a vertex
// at the average of edge-crossing positions, then connect adjacent cells' vertices
// into quads (split into triangles). Normals estimated from field gradient.

// Pure computation — returns raw arrays, no Three.js dependency.
// colorField: optional (x,y,z) => [r, g, b] in 0..1
// resolution: number (isotropic) or [nx, ny, nz] (per-axis)
export function meshFieldRaw(field, bounds, resolution = 48, colorField = null) {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  let nx, ny, nz;
  if (Array.isArray(resolution)) {
    [nx, ny, nz] = resolution;
  } else {
    nx = ny = nz = resolution;
  }
  const sx = (maxX - minX) / nx;
  const sy = (maxY - minY) / ny;
  const sz = (maxZ - minZ) / nz;

  // Sample field on (nx+1)*(ny+1)*(nz+1) grid
  const gnx = nx + 1, gny = ny + 1, gnz = nz + 1;
  const grid = new Float32Array(gnx * gny * gnz);
  for (let z = 0; z < gnz; z++)
    for (let y = 0; y < gny; y++)
      for (let x = 0; x < gnx; x++)
        grid[x + y * gnx + z * gnx * gny] =
          field(minX + x * sx, minY + y * sy, minZ + z * sz);

  const g = (x, y, z) => grid[x + y * gnx + z * gnx * gny];

  // Phase 1: For each cell crossed by the surface, compute a vertex
  const vertIndex = new Int32Array(nx * ny * nz).fill(-1);
  const verts = []; // flat [x,y,z, x,y,z, ...]

  const cornerOff = [
    [0,0,0],[1,0,0],[0,1,0],[1,1,0],
    [0,0,1],[1,0,1],[0,1,1],[1,1,1]
  ];
  const edges = [
    [0,1],[2,3],[4,5],[6,7],  // x-aligned
    [0,2],[1,3],[4,6],[5,7],  // y-aligned
    [0,4],[1,5],[2,6],[3,7]   // z-aligned
  ];

  for (let cz = 0; cz < nz; cz++) {
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        const vals = cornerOff.map(([dx,dy,dz]) => g(cx+dx, cy+dy, cz+dz));

        let hasNeg = false, hasPos = false;
        for (const v of vals) {
          if (v < 0) hasNeg = true; else hasPos = true;
        }
        if (!hasNeg || !hasPos) continue;

        // Average edge-crossing positions
        let px = 0, py = 0, pz = 0, count = 0;
        for (const [a, b] of edges) {
          if ((vals[a] < 0) !== (vals[b] < 0)) {
            const t = vals[a] / (vals[a] - vals[b]);
            const ca = cornerOff[a], cb = cornerOff[b];
            px += minX + (cx + ca[0] + t * (cb[0] - ca[0])) * sx;
            py += minY + (cy + ca[1] + t * (cb[1] - ca[1])) * sy;
            pz += minZ + (cz + ca[2] + t * (cb[2] - ca[2])) * sz;
            count++;
          }
        }

        vertIndex[cx + cy * nx + cz * nx * ny] = verts.length / 3;
        verts.push(px / count, py / count, pz / count);
      }
    }
  }

  // Phase 2: Emit quads — for each grid edge with a sign change,
  // connect the 4 surrounding cells' vertices into two triangles.
  const ci = (x, y, z) => vertIndex[x + y * nx + z * nx * ny];
  const faces = [];

  function quad(c0, c1, c2, c3, flip) {
    const i0 = ci(...c0), i1 = ci(...c1), i2 = ci(...c2), i3 = ci(...c3);
    if (i0 < 0 || i1 < 0 || i2 < 0 || i3 < 0) return;
    if (flip) {
      faces.push(i0, i2, i1, i0, i3, i2);
    } else {
      faces.push(i0, i1, i2, i0, i2, i3);
    }
  }

  // X-edges: (ix,iy,iz)→(ix+1,iy,iz), cells: 4 sharing that edge
  for (let iz = 1; iz < nz; iz++)
    for (let iy = 1; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++)
        if ((g(ix,iy,iz) < 0) !== (g(ix+1,iy,iz) < 0))
          quad([ix,iy-1,iz-1],[ix,iy,iz-1],[ix,iy,iz],[ix,iy-1,iz], g(ix,iy,iz) >= 0);

  // Y-edges: (ix,iy,iz)→(ix,iy+1,iz)
  for (let iz = 1; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 1; ix < nx; ix++)
        if ((g(ix,iy,iz) < 0) !== (g(ix,iy+1,iz) < 0))
          quad([ix-1,iy,iz-1],[ix,iy,iz-1],[ix,iy,iz],[ix-1,iy,iz], g(ix,iy,iz) >= 0);

  // Z-edges: (ix,iy,iz)→(ix,iy,iz+1)
  for (let iz = 0; iz < nz; iz++)
    for (let iy = 1; iy < ny; iy++)
      for (let ix = 1; ix < nx; ix++)
        if ((g(ix,iy,iz) < 0) !== (g(ix,iy,iz+1) < 0))
          quad([ix-1,iy-1,iz],[ix,iy-1,iz],[ix,iy,iz],[ix-1,iy,iz], g(ix,iy,iz) >= 0);

  // Compute per-vertex normals from field gradient
  const normals = new Float32Array(verts.length);
  const eps = Math.min(sx, sy, sz) * 0.5;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i+1], z = verts[i+2];
    let fnx = field(x + eps, y, z) - field(x - eps, y, z);
    let fny = field(x, y + eps, z) - field(x, y - eps, z);
    let fnz = field(x, y, z + eps) - field(x, y, z - eps);
    const len = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz) || 1;
    normals[i] = fnx / len;
    normals[i + 1] = fny / len;
    normals[i + 2] = fnz / len;
  }

  const positions = new Float32Array(verts);
  let colors = null;
  if (colorField) {
    colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 3) {
      const [r, g, b] = colorField(verts[i], verts[i+1], verts[i+2]);
      colors[i] = r;
      colors[i+1] = g;
      colors[i+2] = b;
    }
  }

  return { positions, normals, faces, colors };
}

// Wrap raw mesh data into Three.js BufferGeometry
export function rawToGeometry(raw) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(raw.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(raw.normals, 3));
  if (raw.colors) {
    geo.setAttribute('color', new THREE.Float32BufferAttribute(raw.colors, 3));
  }
  geo.setIndex(raw.faces);
  return geo;
}

// Original API — returns Three.js BufferGeometry (used by evaluator.js)
// resolution: number (isotropic) or [nx, ny, nz] (per-axis)
export function meshField(field, bounds, resolution = 48, colorField = null) {
  const raw = meshFieldRaw(field, bounds, resolution, colorField);
  return rawToGeometry(raw);
}
