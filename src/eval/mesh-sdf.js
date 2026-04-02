// mesh-sdf.js — Convert a Three.js BufferGeometry into a sampled SDF grid.
//
// Algorithm:
// For each voxel center, find the nearest point on any triangle in the mesh.
// The unsigned distance is the Euclidean distance to that point.
// The sign is determined by the dot product of the displacement vector with
// the triangle's face normal (pseudo-normal method).
//
// This is O(voxels × triangles) which is slow for large meshes, but robust
// for non-manifold geometry like TextGeometry produces.

// Build an SDF field function from a centered BufferGeometry.
// resolution: number of voxels along the longest axis
// Returns: { field: (x,y,z) => distance, bounds: {min,max}, nx, ny, nz, voxelSize }
export function meshToSDF(geometry, resolution = 48) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const pad = 2; // voxels of padding

  const size = [
    bb.max.x - bb.min.x,
    bb.max.y - bb.min.y,
    bb.max.z - bb.min.z
  ];
  const maxDim = Math.max(size[0], size[1], size[2]);
  if (maxDim < 1e-6) {
    // Degenerate geometry
    return { field: () => 1e10, bounds: { min: [0,0,0], max: [1,1,1] }, nx: 1, ny: 1, nz: 1, voxelSize: 1 };
  }
  const voxelSize = maxDim / (resolution - 2 * pad);

  // Grid dimensions
  const nx = Math.ceil(size[0] / voxelSize) + 2 * pad;
  const ny = Math.ceil(size[1] / voxelSize) + 2 * pad;
  const nz = Math.ceil(size[2] / voxelSize) + 2 * pad;

  // Grid origin (world coords of voxel [0,0,0])
  const ox = bb.min.x - pad * voxelSize;
  const oy = bb.min.y - pad * voxelSize;
  const oz = bb.min.z - pad * voxelSize;

  // Extract triangles with precomputed normals
  const pos = geometry.getAttribute('position');
  const idx = geometry.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;

  // Flat arrays for triangle data (cache-friendly)
  const tAx = new Float32Array(triCount), tAy = new Float32Array(triCount), tAz = new Float32Array(triCount);
  const tBx = new Float32Array(triCount), tBy = new Float32Array(triCount), tBz = new Float32Array(triCount);
  const tCx = new Float32Array(triCount), tCy = new Float32Array(triCount), tCz = new Float32Array(triCount);
  // Face normals
  const tNx = new Float32Array(triCount), tNy = new Float32Array(triCount), tNz = new Float32Array(triCount);

  for (let i = 0; i < triCount; i++) {
    const i0 = idx ? idx.getX(i * 3) : i * 3;
    const i1 = idx ? idx.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
    tAx[i] = pos.getX(i0); tAy[i] = pos.getY(i0); tAz[i] = pos.getZ(i0);
    tBx[i] = pos.getX(i1); tBy[i] = pos.getY(i1); tBz[i] = pos.getZ(i1);
    tCx[i] = pos.getX(i2); tCy[i] = pos.getY(i2); tCz[i] = pos.getZ(i2);
    // Cross product (B-A) × (C-A)
    const e1x = tBx[i] - tAx[i], e1y = tBy[i] - tAy[i], e1z = tBz[i] - tAz[i];
    const e2x = tCx[i] - tAx[i], e2y = tCy[i] - tAy[i], e2z = tCz[i] - tAz[i];
    const nx_ = e1y * e2z - e1z * e2y;
    const ny_ = e1z * e2x - e1x * e2z;
    const nz_ = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx_ * nx_ + ny_ * ny_ + nz_ * nz_);
    if (len > 1e-12) {
      tNx[i] = nx_ / len; tNy[i] = ny_ / len; tNz[i] = nz_ / len;
    }
  }


  // For each voxel, find nearest triangle and compute signed distance
  const sdf = new Float32Array(nx * ny * nz);

  for (let iz = 0; iz < nz; iz++) {
    const wz = oz + (iz + 0.5) * voxelSize;
    for (let iy = 0; iy < ny; iy++) {
      const wy = oy + (iy + 0.5) * voxelSize;
      for (let ix = 0; ix < nx; ix++) {
        const wx = ox + (ix + 0.5) * voxelSize;

        let bestDist2 = Infinity;
        let bestSign = 1;

        for (let t = 0; t < triCount; t++) {
          const result = closestPointOnTriangle(
            wx, wy, wz,
            tAx[t], tAy[t], tAz[t],
            tBx[t], tBy[t], tBz[t],
            tCx[t], tCy[t], tCz[t]
          );

          if (result.dist2 < bestDist2) {
            bestDist2 = result.dist2;
            // Sign: dot product of (point - closest) with face normal
            // If positive, point is outside; if negative, inside
            const dx = wx - result.cx;
            const dy = wy - result.cy;
            const dz = wz - result.cz;
            const dot = dx * tNx[t] + dy * tNy[t] + dz * tNz[t];
            bestSign = dot >= 0 ? 1 : -1;
          }
        }

        sdf[ix + iy * nx + iz * nx * ny] = bestSign * Math.sqrt(bestDist2);
      }
    }
  }

  const bounds = {
    min: [ox, oy, oz],
    max: [ox + nx * voxelSize, oy + ny * voxelSize, oz + nz * voxelSize]
  };

  // Return field function with trilinear interpolation
  const field = (x, y, z) => {
    const gx = (x - ox) / voxelSize - 0.5;
    const gy = (y - oy) / voxelSize - 0.5;
    const gz = (z - oz) / voxelSize - 0.5;

    // Outside grid — positive distance estimate
    if (gx < 0 || gy < 0 || gz < 0 || gx >= nx - 1 || gy >= ny - 1 || gz >= nz - 1) {
      const dx = Math.max(ox - x, 0, x - (ox + nx * voxelSize));
      const dy = Math.max(oy - y, 0, y - (oy + ny * voxelSize));
      const dz = Math.max(oz - z, 0, z - (oz + nz * voxelSize));
      return Math.sqrt(dx * dx + dy * dy + dz * dz) + voxelSize;
    }

    // Trilinear interpolation
    const iix = Math.floor(gx), iiy = Math.floor(gy), iiz = Math.floor(gz);
    const fx = gx - iix, fy = gy - iiy, fz = gz - iiz;

    const i000 = iix + iiy * nx + iiz * nx * ny;
    const i100 = i000 + 1;
    const i010 = i000 + nx;
    const i110 = i000 + nx + 1;
    const i001 = i000 + nx * ny;
    const i101 = i001 + 1;
    const i011 = i001 + nx;
    const i111 = i001 + nx + 1;

    const c00 = sdf[i000] * (1 - fx) + sdf[i100] * fx;
    const c10 = sdf[i010] * (1 - fx) + sdf[i110] * fx;
    const c01 = sdf[i001] * (1 - fx) + sdf[i101] * fx;
    const c11 = sdf[i011] * (1 - fx) + sdf[i111] * fx;

    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;

    return c0 * (1 - fz) + c1 * fz;
  };

  return { field, sdf, bounds, nx, ny, nz, voxelSize, ox, oy, oz };
}

// ---- Closest point on triangle ----
// Returns { cx, cy, cz, dist2 } — the closest point and squared distance.
// Uses the Voronoi region method.
function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    // Closest to vertex A
    const dx = px - ax, dy = py - ay, dz = pz - az;
    return { cx: ax, cy: ay, cz: az, dist2: dx*dx + dy*dy + dz*dz };
  }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    const dx = px - bx, dy = py - by, dz = pz - bz;
    return { cx: bx, cy: by, cz: bz, dist2: dx*dx + dy*dy + dz*dz };
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    return { cx: cx, cy: cy, cz: cz, dist2: dx*dx + dy*dy + dz*dz };
  }

  // Edge AB
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const rx = ax + v * abx, ry = ay + v * aby, rz = az + v * abz;
    const dx = px - rx, dy = py - ry, dz = pz - rz;
    return { cx: rx, cy: ry, cz: rz, dist2: dx*dx + dy*dy + dz*dz };
  }

  // Edge AC
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const rx = ax + w * acx, ry = ay + w * acy, rz = az + w * acz;
    const dx = px - rx, dy = py - ry, dz = pz - rz;
    return { cx: rx, cy: ry, cz: rz, dist2: dx*dx + dy*dy + dz*dz };
  }

  // Edge BC
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const rx = bx + w * (cx - bx), ry = by + w * (cy - by), rz = bz + w * (cz - bz);
    const dx = px - rx, dy = py - ry, dz = pz - rz;
    return { cx: rx, cy: ry, cz: rz, dist2: dx*dx + dy*dy + dz*dz };
  }

  // Inside the triangle face
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const rx = ax + abx * v + acx * w;
  const ry = ay + aby * v + acy * w;
  const rz = az + abz * v + acz * w;
  const dx = px - rx, dy = py - ry, dz = pz - rz;
  return { cx: rx, cy: ry, cz: rz, dist2: dx*dx + dy*dy + dz*dz };
}
