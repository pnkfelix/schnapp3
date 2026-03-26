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

  // Render loop
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // --- Tap-to-select: raycast on tap, ignoring orbit drags ---
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let tapCallback = null;
  let pointerDownPos = null;
  let pointerDownTime = 0;

  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
    pointerDownTime = performance.now();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!tapCallback || !pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    const dt = performance.now() - pointerDownTime;
    pointerDownPos = null;
    // Only treat as tap if pointer barely moved and was quick
    if (dx * dx + dy * dy > 100 || dt > 300) return;

    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(contentGroup.children, true);
    if (hits.length === 0) {
      tapCallback(null);
      return;
    }

    // Walk up from hit mesh to find nearest ancestor with a blockId
    let obj = hits[0].object;
    while (obj && !obj.userData.blockId) {
      obj = obj.parent;
    }
    tapCallback(obj ? obj.userData.blockId : null);
  });

  return {
    setContent(newGroup) {
      scene.remove(contentGroup);
      contentGroup.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      contentGroup = newGroup;
      scene.add(contentGroup);
    },
    onTap(callback) {
      tapCallback = callback;
    }
  };
}
