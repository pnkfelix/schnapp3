// 3MF exporter: Three.js Group → .3mf file (ZIP containing XML + mesh data)
// Preserves per-object material/color for multi-material 3D printing.

import * as THREE from 'three';

// Build a minimal 3MF ZIP file from raw bytes.
// 3MF is a ZIP containing XML files — we build it manually to avoid dependencies.

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  // entries: [{ name: string, data: Uint8Array }]
  const enc = new TextEncoder();
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 + name + data)
    const local = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true);  // signature
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0, true);           // flags
    lv.setUint16(8, 0, true);           // compression: stored
    lv.setUint16(10, 0, true);          // mod time
    lv.setUint16(12, 0, true);          // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);       // compressed size
    lv.setUint32(22, size, true);       // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);         // extra field length
    new Uint8Array(local, 30).set(nameBytes);
    parts.push(new Uint8Array(local));
    parts.push(entry.data);

    // Central directory entry
    const cd = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cd);
    cv.setUint32(0, 0x02014b50, true);  // signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0, true);           // flags
    cv.setUint16(10, 0, true);          // compression: stored
    cv.setUint16(12, 0, true);          // mod time
    cv.setUint16(14, 0, true);          // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);          // extra field length
    cv.setUint16(32, 0, true);          // comment length
    cv.setUint16(34, 0, true);          // disk number
    cv.setUint16(36, 0, true);          // internal attrs
    cv.setUint32(38, 0, true);          // external attrs
    cv.setUint32(42, offset, true);     // local header offset
    new Uint8Array(cd, 46).set(nameBytes);
    centralDir.push(new Uint8Array(cd));

    offset += 30 + nameBytes.length + size;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDir) {
    parts.push(cd);
    cdSize += cd.length;
  }

  // End of central directory
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);             // disk number
  ev.setUint16(6, 0, true);             // disk with CD
  ev.setUint16(8, entries.length, true); // entries on disk
  ev.setUint16(10, entries.length, true);// total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);            // comment length
  parts.push(new Uint8Array(eocd));

  // Concatenate
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

// Collect all Mesh objects from a Three.js scene graph,
// with world transforms baked into vertex positions.
function collectMeshes(group) {
  const meshes = [];
  group.updateMatrixWorld(true);
  group.traverse(obj => {
    if (!obj.isMesh) return;
    if (!obj.geometry) return;
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);

    // Ensure indexed geometry
    if (!geo.index) {
      const pos = geo.attributes.position;
      const indices = [];
      for (let i = 0; i < pos.count; i++) indices.push(i);
      geo.setIndex(indices);
    }

    // Extract color from material
    let color = '#aaaaaa';
    if (obj.material && obj.material.color) {
      color = '#' + obj.material.color.getHexString();
    }

    meshes.push({ geometry: geo, color });
  });
  return meshes;
}

// Generate the 3D model XML for 3MF
function generate3dModel(meshes) {
  const colorSet = new Map(); // color hex → index
  let nextColorId = 0;

  // Collect unique colors
  for (const m of meshes) {
    if (!colorSet.has(m.color)) {
      colorSet.set(m.color, nextColorId++);
    }
  }

  // Build XML
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n';

  // Resources: base materials
  xml += '  <resources>\n';
  xml += '    <m:basematerials id="1">\n';
  for (const [hex, _idx] of colorSet) {
    xml += `      <m:base name="Material ${hex}" displaycolor="${hex}" />\n`;
  }
  xml += '    </m:basematerials>\n';

  // One mesh object containing all geometry, with per-triangle material
  let vertexOffset = 0;
  let allVertices = '';
  let allTriangles = '';

  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    const idx = m.geometry.index;
    const colorIdx = colorSet.get(m.color);

    for (let i = 0; i < pos.count; i++) {
      allVertices += `          <vertex x="${pos.getX(i)}" y="${pos.getY(i)}" z="${pos.getZ(i)}" />\n`;
    }

    for (let i = 0; i < idx.count; i += 3) {
      const v1 = idx.getX(i) + vertexOffset;
      const v2 = idx.getX(i + 1) + vertexOffset;
      const v3 = idx.getX(i + 2) + vertexOffset;
      allTriangles += `          <triangle v1="${v1}" v2="${v2}" v3="${v3}" pid="1" p1="${colorIdx}" />\n`;
    }

    vertexOffset += pos.count;
  }

  xml += '    <object id="2" type="model">\n';
  xml += '      <mesh>\n';
  xml += '        <vertices>\n';
  xml += allVertices;
  xml += '        </vertices>\n';
  xml += '        <triangles>\n';
  xml += allTriangles;
  xml += '        </triangles>\n';
  xml += '      </mesh>\n';
  xml += '    </object>\n';
  xml += '  </resources>\n';

  // Build section
  xml += '  <build>\n';
  xml += '    <item objectid="2" />\n';
  xml += '  </build>\n';
  xml += '</model>\n';

  return xml;
}

// Content_Types XML (required by 3MF/OPC)
function generateContentTypes() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    + '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />\n'
    + '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />\n'
    + '</Types>\n';
}

// Relationships XML (required by 3MF/OPC)
function generateRels() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
    + '  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />\n'
    + '</Relationships>\n';
}

// Main export: Three.js Group → Blob (.3mf)
export function exportTo3MF(group) {
  const meshes = collectMeshes(group);
  if (meshes.length === 0) return null;

  const enc = new TextEncoder();
  const zipBytes = buildZip([
    { name: '[Content_Types].xml', data: enc.encode(generateContentTypes()) },
    { name: '_rels/.rels', data: enc.encode(generateRels()) },
    { name: '3D/3dmodel.model', data: enc.encode(generate3dModel(meshes)) },
  ]);

  return new Blob([zipBytes], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
}

// Trigger browser download of a 3MF blob
export function download3MF(group, filename = 'schnapp3-export.3mf') {
  const blob = exportTo3MF(group);
  if (!blob) {
    console.warn('Nothing to export — scene is empty');
    return false;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}
