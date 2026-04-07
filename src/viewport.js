import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createViewport(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f0);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(60, 40, 60);
  camera.lookAt(0, 0, 0);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(50, 80, 50);
  scene.add(dirLight);

  // Grid
  scene.add(new THREE.GridHelper(100, 10));

  // Orbit controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // Responsive sizing
  const observer = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  observer.observe(container);

  // Content group — replaced on each update
  let contentGroup = new THREE.Group();
  scene.add(contentGroup);

  // Animate controls.target toward a new point
  let focusAnim = null;

  function animateFocusTo(target) {
    const start = controls.target.clone();
    const end = target.clone();
    const startTime = performance.now();
    const duration = 300;
    focusAnim = { start, end, startTime, duration };
  }

  // Render loop
  function animate() {
    requestAnimationFrame(animate);
    // Animate focus shift
    if (focusAnim) {
      const t = Math.min((performance.now() - focusAnim.startTime) / focusAnim.duration, 1);
      const ease = t * (2 - t); // ease-out quadratic
      controls.target.lerpVectors(focusAnim.start, focusAnim.end, ease);
      if (t >= 1) focusAnim = null;
    }
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // --- Tap-to-select + double-tap-to-focus ---
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let tapCallback = null;
  let pointerDownPos = null;
  let pointerDownTime = 0;
  let lastTapTime = 0;
  const DOUBLE_TAP_MS = 400;

  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
    pointerDownTime = performance.now();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    const dt = performance.now() - pointerDownTime;
    pointerDownPos = null;
    // Only treat as tap if pointer barely moved and was quick
    if (dx * dx + dy * dy > 100 || dt > 300) return;

    // Raycast once for both tap-to-select and double-tap-to-focus
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(contentGroup.children, true);

    const now = performance.now();
    if (now - lastTapTime < DOUBLE_TAP_MS) {
      // Double-tap: shift camera focus to hit point
      if (hits.length > 0) {
        animateFocusTo(hits[0].point);
      }
      lastTapTime = 0;
      return;
    }
    lastTapTime = now;

    // Single tap: select block
    if (!tapCallback) return;
    if (hits.length === 0) {
      tapCallback(null);
      return;
    }

    const hit = hits[0];
    const hitObj = hit.object;

    // CSG-meshed shapes: per-vertex provenance tells us which primitive block
    if (hitObj.userData.vertexBlockIds && hit.face) {
      const ids = hitObj.userData.vertexBlockIds;
      const blockId = ids[hit.face.a] || ids[hit.face.b] || ids[hit.face.c];
      tapCallback(blockId || null);
      return;
    }

    // Non-CSG: walk up to find nearest ancestor with a blockId
    let obj = hitObj;
    while (obj && !obj.userData.blockId) {
      obj = obj.parent;
    }
    tapCallback(obj ? obj.userData.blockId : null);
  });

  return {
    getContent() {
      return contentGroup;
    },
    setContent(newGroup, retainedObjects) {
      scene.remove(contentGroup);
      contentGroup.traverse(obj => {
        if (retainedObjects && retainedObjects.has(obj)) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      contentGroup = newGroup;
      scene.add(contentGroup);
    },
    onTap(callback) {
      tapCallback = callback;
    },
    resetFocus() {
      animateFocusTo(new THREE.Vector3(0, 0, 0));
    },
    getFocusTarget() {
      return controls.target.clone();
    }
  };
}
