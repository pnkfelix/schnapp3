// Anti-solid visual rendering: checkerboard surface + wireframe outline.
// The checkerboard discards alternating 3D cells so parts of the surface
// are truly invisible. The wireframe shows the full silhouette so the
// shape remains legible even with half the surface missing.

import * as THREE from 'three';

let antiCheckerSize = 3.0;
export function getAntiCheckerSize() { return antiCheckerSize; }
export function setAntiCheckerSize(v) { antiCheckerSize = v; }

// 'off' | 'full' | 'edges'
let antiWireframeMode = 'full';
const WIREFRAME_MODES = ['off', 'full', 'edges'];
export function getAntiWireframeMode() { return antiWireframeMode; }
export function setAntiWireframeMode(v) { antiWireframeMode = v; }
export function cycleAntiWireframeMode() {
  const i = WIREFRAME_MODES.indexOf(antiWireframeMode);
  antiWireframeMode = WIREFRAME_MODES[(i + 1) % WIREFRAME_MODES.length];
  return antiWireframeMode;
}

export function addAntiMesh(group, geo) {
  // Checkerboard surface
  const antiMesh = new THREE.Mesh(geo, _makeAntiCheckerMat());
  group.add(antiMesh);
  // Wireframe overlay (mode-dependent)
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0x993333,
    transparent: true,
    opacity: 0.25,
    depthWrite: false
  });
  if (antiWireframeMode === 'full') {
    wireMat.wireframe = true;
    group.add(new THREE.Mesh(geo, wireMat));
  } else if (antiWireframeMode === 'edges') {
    const edgesGeo = new THREE.EdgesGeometry(geo, 30); // 30° threshold
    const linesMat = new THREE.LineBasicMaterial({
      color: 0x993333,
      transparent: true,
      opacity: 0.5
    });
    group.add(new THREE.LineSegments(edgesGeo, linesMat));
  }
  // 'off' → no wireframe added
}

function _makeAntiCheckerMat() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor:      { value: new THREE.Color(0xcc4444) },
      uOpacity:    { value: 0.35 },
      uSquareSize: { value: antiCheckerSize }
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3  uColor;
      uniform float uOpacity;
      uniform float uSquareSize;
      varying vec3  vWorldPos;
      varying vec3  vNormal;
      void main() {
        // 3D checkerboard: uses all three world-space coordinates so
        // the pattern is view-angle-independent. No projection needed.
        vec3 cell = floor(vWorldPos / uSquareSize);
        if (mod(cell.x + cell.y + cell.z, 2.0) < 0.5) discard;

        // Simple diffuse-ish shading so the surface reads as 3D
        float ndl = 0.4 + 0.6 * abs(dot(vNormal, normalize(vec3(1.0, 2.0, 3.0))));
        gl_FragColor = vec4(uColor * ndl, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
}
