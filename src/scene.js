import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEOMETRY_SI as G, COMPONENTS, DEFAULT_VIEW, sampleCommutation, COIL_LEAD_ROUTES, coilWindingPoints, EXTERNAL_LEADS, radialPoint, TAU } from './geometry.js';
import { BEARING_DETAIL as B, motorBearingKinematics, bearingRaceGeometry, revolvedProfileGeometry, brushGuideGeometry } from './mechanical-geometry.js';
import { sleeveGeometry, windingTube } from './scene-geometry.js';
import './scene.css';

const V = a => new THREE.Vector3(...a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ordinary = x => Object.is(x, -0) ? 0 : x;
const center = range => (range[0] + range[1]) / 2;
const length = range => range[1] - range[0];
const shaftRpm = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const STAGE_COLOR = '#182732';
function polyline(points) {
  const path = new THREE.CurvePath();
  for (let i = 1; i < points.length; i++) if (V(points[i]).distanceToSquared(V(points[i - 1])) > 1e-24) path.add(new THREE.LineCurve3(V(points[i - 1]), V(points[i])));
  return path;
}
function rounded(points, radius = .003) {
  const path = new THREE.CurvePath(), p = points.map(V); let cursor = p[0];
  for (let i = 1; i < p.length - 1; i++) {
    const r = Math.min(radius, p[i].distanceTo(p[i - 1]) * .2, p[i].distanceTo(p[i + 1]) * .2);
    const a = p[i].clone().addScaledVector(p[i - 1].clone().sub(p[i]).normalize(), r);
    const b = p[i].clone().addScaledVector(p[i + 1].clone().sub(p[i]).normalize(), r);
    path.add(new THREE.LineCurve3(cursor, a)); path.add(new THREE.QuadraticBezierCurve3(a, p[i], b)); cursor = b;
  }
  path.add(new THREE.LineCurve3(cursor, p.at(-1))); return path;
}

export class MotorScene {
  constructor(container, { onSelect = () => {}, onCameraChange = () => {} } = {}) {
    this.container = container; this.onSelect = onSelect; this.onCameraChange = onCameraChange;
    this.view = structuredClone(DEFAULT_VIEW); this.components = new Map(); this.geometries = new Set(); this.materials = new Set(); this.textures = new Set();
    this.covers = []; this.explodedParts = []; this.segments = []; this.leadMeshes = []; this.arrowSets = []; this.bearings = []; this.instances = []; this.rotationIntegralRad = 0; this.disposed = false; this.updating = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(STAGE_COLOR);
    this.scene.fog = new THREE.Fog(STAGE_COLOR, .48, 1.35);
    this.camera = new THREE.PerspectiveCamera(36, 1, .0005, 10);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    // The cut plane stays fixed while the complete inner race turns behind it.
    this.bearingCutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.renderer.domElement.setAttribute('aria-label', '브러시 DC 전동기의 자석, 권선과 정류 접점을 관찰하는 3D 시험대'); this.renderer.domElement.tabIndex = 0;
    container.classList.add('motor-scene'); container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = false;
    this.controls.minDistance = .05; this.controls.maxDistance = 3; this.controls.minPolarAngle = 0; this.controls.maxPolarAngle = Math.PI;
    this.controls.panSpeed = .65; this.controls.zoomSpeed = .75;
    this.controlChange = () => { if (!this.updating && !this.disposed) { this.render(); this.onCameraChange(this.getCameraState()); } };
    this.controls.addEventListener('change', this.controlChange);
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, .035); this.scene.environment = this.environment.texture; this.scene.environmentIntensity = .9; room.dispose(); pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xc9e9f7, 0x192c38, 1.65));
    const key = new THREE.DirectionalLight(0xffeccd, 3.2); key.position.set(-.12, .6, .38); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -.3, right: .3, top: .25, bottom: -.25, near: .05, far: 1.5 }); key.shadow.bias = -.0001; key.shadow.normalBias = .00015; this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8dcde8, 2.8); rim.position.set(.3, .3, -.45); this.scene.add(rim);
    this.root = new THREE.Group(); this.scene.add(this.root); this.rotor = new THREE.Group(); this.rotor.position.y = G.axisY; this.root.add(this.rotor);
    this.createMaterials(); this.buildStator(); this.buildRotor(); this.buildContacts(); this.buildBench(); this.buildStage(); this.buildField(); this.buildOverlay();
    this.root.traverse(object => {
      if (!object.isMesh) return; let p = object;
      // The stage fades into its backdrop without reducing part or path contrast.
      object.material.fog = false;
      while (p && !p.userData.partId) p = p.parent;
      if (p) object.userData.partId = p.userData.partId;
    });
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.pointerDown = event => { this.down = { x: event.clientX, y: event.clientY, button: event.button }; };
    this.pointerUp = event => this.pick(event);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown); this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    this.applyView(); this.resize(); this.resetCamera();
  }
  material(values) { const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...values }); this.materials.add(m); return m; }
  finishTexture(size, sample) {
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      pixels.fill(sample(x, y), i, i + 3); pixels[i + 3] = 255;
    }
    const texture = new THREE.DataTexture(pixels, size, size);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true; texture.needsUpdate = true; this.textures.add(texture);
    return texture;
  }
  createMaterials() {
    // Circumferential tool marks. Mipmaps keep the details stable in wide views.
    const turned = this.finishTexture(256, (x, y) => Math.round(150 + 18 * Math.sin(TAU * 42 * y / 256) + 3 * Math.sin(TAU * (7 * x + 11 * y) / 256)));
    const grain = this.finishTexture(128, (x, y) => {
      const seed = Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263);
      return 166 + (Math.imul(seed ^ seed >>> 13, 1274126177) >>> 26);
    });
    const machined = { roughnessMap: turned, bumpMap: turned };
    this.mat = {
      steel: this.material({ color: '#aebac1', metalness: .92, roughness: .25 }), chrome: this.material({ color: '#d0dce3', metalness: .98, roughness: .16 }),
      iron: this.material({ color: '#657784', metalness: .9, roughness: .36 }), dark: this.material({ color: '#263d49', metalness: .67, roughness: .4 }),
      case: this.material({ color: '#7c9aa8', metalness: .85, roughness: .31 }), painted: this.material({ color: '#286379', metalness: .55, roughness: .4 }),
      housing: this.material({ color: '#647f88', metalness: .72, roughness: .56, roughnessMap: grain, bumpMap: grain, bumpScale: .00007 }),
      copper: this.material({ color: '#b87343', metalness: .88, roughness: .38, ...machined, bumpScale: .000009 }),
      shaft: this.material({ color: '#b2bec7', metalness: .96, roughness: .33, ...machined, bumpScale: .0000045 }),
      brass: this.material({ color: '#d0ab62', metalness: .85, roughness: .3 }),
      insulation: this.material({ color: '#cfb99a', metalness: .02, roughness: .76 }), resin: this.material({ color: '#323434', metalness: .02, roughness: .66 }),
      graphite: this.material({ color: '#3b3e41', metalness: .16, roughness: .93, roughnessMap: grain, bumpMap: grain, bumpScale: .000025 }),
      rubber: this.material({ color: '#182027', metalness: .05, roughness: .8 }),
      magnetN: this.material({ color: '#945f58', metalness: .36, roughness: .56 }), magnetS: this.material({ color: '#4b788b', metalness: .36, roughness: .56 }),
      positive: this.material({ color: '#c66c59', metalness: .2, roughness: .53 }), negative: this.material({ color: '#497d9d', metalness: .2, roughness: .5 }),
      arrow: new THREE.MeshBasicMaterial({ color: '#f6f5d3', toneMapped: false }),
      markPositive: new THREE.MeshBasicMaterial({ color: '#ffb16a', side: THREE.DoubleSide, toneMapped: false }),
      markNegative: new THREE.MeshBasicMaterial({ color: '#7bdef2', side: THREE.DoubleSide, toneMapped: false }),
    };
    for (const material of [this.mat.arrow, this.mat.markPositive, this.mat.markNegative]) this.materials.add(material);
    this.mat.race = this.material({ color: '#aab7bf', metalness: .94, roughness: .29, ...machined, bumpScale: .0000018 });
    this.mat.cage = this.material({ color: '#ad8245', metalness: .8, roughness: .38 });
  }
  mesh(geometry, material, parent, position) {
    this.geometries.add(geometry); const own = material.clone(); this.materials.add(own);
    const mesh = new THREE.Mesh(geometry, own); mesh.castShadow = true; mesh.receiveShadow = true;
    if (position) mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  instanced(geometry, material, count, parent) {
    this.geometries.add(geometry); const own = material.clone(); this.materials.add(own);
    const mesh = new THREE.InstancedMesh(geometry, own, count); mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); parent.add(mesh); this.instances.push(mesh); return mesh;
  }
  box(size, material, parent, position) { return this.mesh(new THREE.BoxGeometry(...size), material, parent, position); }
  cylinder(radius, size, material, parent, position, axis = 'x', sides = 48) {
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, size, sides), material, parent, position);
    if (axis === 'x') mesh.rotation.z = -Math.PI / 2; else if (axis === 'z') mesh.rotation.x = Math.PI / 2; return mesh;
  }
  sleeve(inner, outer, size, material, parent, position, start = 0, sweep = TAU) { return this.mesh(sleeveGeometry(inner, outer, size, start, sweep), material, parent, position); }
  tube(points, radius, material, parent, round = false) {
    const curve = round ? rounded(points, radius * 3) : polyline(points);
    return { mesh: this.mesh(new THREE.TubeGeometry(curve, Math.max(28, points.length * 3), radius, 8, false), material, parent), curve };
  }
  rod(a, b, radius, material, parent, sides = 16) {
    const delta = V(b).sub(V(a)), mesh = this.cylinder(radius, delta.length(), material, parent, V(a).add(V(b)).multiplyScalar(.5).toArray(), 'y', sides);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return mesh;
  }
  part(id, anchor, parent = this.root) {
    const node = new THREE.Group(); node.name = id; node.userData.partId = id; parent.add(node);
    this.components.set(id, { ...COMPONENTS.find(p => p.id === id), node, anchor: V(anchor) }); return node;
  }
  bolt(parent, position, axis = 'x', scale = 1) {
    this.cylinder(.00165 * scale, .0014 * scale, this.mat.chrome, parent, position, axis, 6);
    const axisDelta = axis === 'x' ? [.0008, 0, 0] : axis === 'y' ? [0, .0008, 0] : [0, 0, .0008];
    this.cylinder(.0007 * scale, .00018, this.mat.dark, parent, position.map((p, i) => p + axisDelta[i] * scale), axis, 6);
  }
  splitSleeve(id, inner, outer, range, mat, displacement, parent = this.root, ventBanks = []) {
    const node = this.part(id, [center(range), G.axisY + outer * .8, -outer * .55], parent), back = new THREE.Group(), front = new THREE.Group(); node.add(back, front);
    const vents = ventBanks.map(bank => bank.map(x => x - center(range)));
    for (const [half, start] of [[back, Math.PI], [front, 0]]) {
      this.mesh(sleeveGeometry(inner, outer, length(range), start, Math.PI, vents), mat, half, [center(range), G.axisY, 0]);
    }
    this.covers.push({ front, displacement, layer: 'housing' }); return node;
  }
  plateText(text, width, height, parent, position, rotation = [0, 0, 0], colors = {}) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
    const context = canvas.getContext('2d'); context.fillStyle = colors.background || '#203d4d'; context.fillRect(0, 0, 512, 128);
    context.strokeStyle = '#88a4af'; context.strokeRect(7, 7, 498, 114); context.fillStyle = colors.text || '#dae6e9'; context.font = '600 36px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(text, 256, 64);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
    const material = this.material({ map: texture, roughness: .58, metalness: .1 }); const mesh = this.mesh(new THREE.PlaneGeometry(width, height), material, parent, position);
    mesh.rotation.set(...rotation); mesh.userData.nonPickable = true; mesh.castShadow = false; return mesh;
  }
  buildStator() {
    const m = this.mat;
    // The two vent banks clear the cradle bands and the centre nameplate.
    this.housing = this.splitSleeve('housing', G.housingInnerRadius, G.housingOuterRadius, G.housingX, m.housing, [0, .010, .115], this.root, [[-.039, -.026], [.008, .018]]);
    for (const x of [-.051, .032]) this.sleeve(.030, .0312, .003, m.chrome, this.housing, [x, G.axisY, 0], Math.PI, Math.PI);
    this.plateText('MOTOR LAB  /  PM DC', .064, .011, this.housing, [-.008, .082, -.0294], [0, Math.PI, 0]);
    for (const [id, range, delta] of [['endbell-rear', G.rearEndbellX, -.05], ['endbell-front', G.frontEndbellX, .045]]) {
      const node = this.splitSleeve(id, G.bearingOuterRadius, .030, range, m.steel, [0, .010, .10]);
      this.explodedParts.push({ node, vector: [delta, 0, 0] });
      for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; this.bolt(node, [id.endsWith('rear') ? range[0] - .0007 : range[1] + .0007, G.axisY + .025 * Math.cos(a), .025 * Math.sin(a)]); }
    }
    for (const [index, id] of ['bearing-rear', 'bearing-front'].entries()) {
      const x = G.bearingCentersX[index], node = this.part(id, [x, G.axisY + .005, .004]);
      this.buildBearing(id, node, x);
      this.explodedParts.push({ node, vector: [index ? .045 : -.05, 0, 0] });
    }
    for (const [id, centerAngle, mat] of [['magnet-n', 0, m.magnetN], ['magnet-s', Math.PI, m.magnetS]]) {
      const node = this.part(id, [0, G.axisY + .025 * Math.cos(centerAngle), -.010]);
      const a = centerAngle - G.magnetArcRad / 2, b = centerAngle + G.magnetArcRad / 2;
      const back = new THREE.Group(), front = new THREE.Group(); node.add(back, front);
      const backStart = centerAngle === 0 ? a : Math.PI, frontStart = centerAngle === 0 ? 0 : a;
      this.sleeve(G.magnetInnerRadius, G.magnetOuterRadius, length(G.magnetX), mat, back, [0, G.axisY, 0], backStart, G.magnetArcRad / 2);
      this.sleeve(G.magnetInnerRadius, G.magnetOuterRadius, length(G.magnetX), mat, front, [0, G.axisY, 0], frontStart, G.magnetArcRad / 2);
      this.covers.push({ front, displacement: [0, .055 * Math.cos(centerAngle), .07], layer: 'magnets' });
      for (const x of [-.022, .022]) this.sleeve(.0275, .028, .002, m.dark, back, [x, G.axisY, 0], backStart, G.magnetArcRad / 2);
    }
  }
  buildBearing(id, node, x) {
    const assembly = new THREE.Group(); assembly.position.set(x, G.axisY, 0); node.add(assembly);
    const inner = new THREE.Group(), cage = new THREE.Group(); assembly.add(inner, cage);
    const clipped = [], caps = [];
    for (const kind of ['inner', 'outer']) {
      clipped.push(this.mesh(bearingRaceGeometry(kind), this.mat.race, kind === 'inner' ? inner : assembly));
      caps.push(this.mesh(bearingRaceGeometry(kind, { section: true, capsOnly: true }), this.mat.steel, assembly));
    }
    // A shallow contrasting witness line makes inner-race rotation readable.
    const witness = this.sleeve(.00332, .00378, .000006, this.mat.dark, inner, [G.bearingLength / 2 + .000004, 0, 0], -.024, .048);
    clipped.push(witness);
    for (const sign of [-1, 1]) {
      const low = sign * B.cageHalfSpacingM - B.cageRingThicknessM / 2, high = low + B.cageRingThicknessM;
      const profile = [{ x: low, r: .00480 }, { x: low, r: .00520 }, { x: high, r: .00520 }, { x: high, r: .00480 }];
      this.mesh(revolvedProfileGeometry(profile), this.mat.cage, cage);
    }
    const sphere = new THREE.SphereGeometry(B.ballRadiusM, 24, 16), colors = [];
    for (let i = 0; i < sphere.attributes.position.count; i++) {
      // A narrow inspection stripe records spin without changing the sphere.
      const stripe = Math.abs(sphere.attributes.position.getY(i)) < B.ballRadiusM * .13;
      const color = new THREE.Color(stripe ? '#466579' : '#d1dce2'); colors.push(color.r, color.g, color.b);
    }
    sphere.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const ballMaterial = this.material({ color: '#ffffff', vertexColors: true, metalness: .93, roughness: .23 });
    const balls = this.instanced(sphere, ballMaterial, B.ballCount, assembly);
    const bar = new THREE.CylinderGeometry(B.cageBarRadiusM, B.cageBarRadiusM, B.cageHalfSpacingM * 2, 10); bar.rotateZ(-Math.PI / 2);
    const bars = this.instanced(bar, this.mat.cage, B.ballCount, cage);
    this.bearings.push({ id, node, assembly, inner, cage, balls, bars, clipped, caps, visibleBallIndices: [], phase: motorBearingKinematics() });
  }
  resetRotation(angleRad = 0) {
    if (!Number.isFinite(angleRad)) throw new TypeError('Rotation must be finite');
    this.rotationIntegralRad = angleRad;
  }
  advanceRotation(angleDeltaRad) {
    if (!Number.isFinite(angleDeltaRad)) throw new TypeError('Rotation increment must be finite');
    this.rotationIntegralRad += angleDeltaRad;
  }
  updateBearings(cut) {
    const matrix = new THREE.Matrix4();
    for (const bearing of this.bearings) {
      const phase = motorBearingKinematics({ angleRad: this.rotationIntegralRad, omegaRadS: this.snapshot?.omegaRadS ?? 0 }); bearing.phase = phase;
      bearing.inner.rotation.x = this.snapshot?.angleRad ?? 0; bearing.cage.rotation.x = phase.cageAngle;
      if (bearing.cut !== cut) {
        for (const mesh of bearing.clipped) { mesh.material.clippingPlanes = cut ? [this.bearingCutPlane] : []; mesh.material.clipShadows = true; mesh.material.needsUpdate = true; }
        bearing.cut = cut;
      }
      for (const cap of bearing.caps) cap.visible = cut;
      let count = 0, barCount = 0; bearing.visibleBallIndices = [];
      for (let i = 0; i < B.ballCount; i++) {
        const initial = i * TAU / B.ballCount, angle = initial + phase.cageAngle;
        matrix.makeRotationX(initial + phase.ballWorldAngle); matrix.setPosition(0, B.pitchRadiusM * Math.cos(angle), B.pitchRadiusM * Math.sin(angle));
        bearing.balls.setMatrixAt(count++, matrix); bearing.visibleBallIndices.push(i);
        const barAngle = initial + Math.PI / B.ballCount;
        matrix.identity().setPosition(0, B.pitchRadiusM * Math.cos(barAngle), B.pitchRadiusM * Math.sin(barAngle)); bearing.bars.setMatrixAt(barCount++, matrix);
      }
      bearing.balls.count = count; bearing.bars.count = barCount;
      for (const mesh of [bearing.balls, bearing.bars]) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
    }
  }
  buildRotor() {
    const m = this.mat;
    const shaft = this.part('shaft', [.024, .003, .002], this.rotor);
    const [left, right] = G.shaftX, radius = G.shaftRadius, chamfer = .00018;
    const shaftProfile = [[left, 0], [left, radius - chamfer], [left + chamfer, radius],
      [right - chamfer, radius], [right, radius - chamfer], [right, 0]].map(([x, r]) => ({ x, r }));
    this.mesh(revolvedProfileGeometry(shaftProfile, { segments: 48 }), m.shaft, shaft);
    for (const x of [-.052, .031]) this.sleeve(.003, .0048, .0012, m.brass, shaft, [x, 0, 0]);
    const core = this.part('armature-core', [0, .014, .010], this.rotor), insulation = this.part('slot-insulation', [.021, .012, .010], this.rotor);
    this.sleeve(G.shaftRadius, G.coreHubRadius, length(G.coreX), m.iron, core, [0, 0, 0]);
    const laminations = [[], []];
    for (let i = 0; i < 27; i++) {
      laminations[i % 3 === 0 ? 0 : 1].push(sleeveGeometry(.018, .021, .00138, -Math.PI / 6, Math.PI / 3).translate(-.0193 + i * .001485, 0, 0));
    }
    const stacks = laminations.map(sheets => {
      const stack = mergeGeometries(sheets);
      for (const sheet of sheets) sheet.dispose();
      return stack;
    });
    for (const coil of G.coils) {
      const tooth = new THREE.Group(); tooth.rotation.x = coil.axisRad; core.add(tooth);
      this.box([.040, .012, .006], m.iron, tooth, [0, .0125, 0]);
      this.mesh(stacks[0], m.steel, tooth);
      this.mesh(stacks[1], m.iron, tooth);
      const liner = new THREE.Group(); liner.rotation.x = coil.axisRad; insulation.add(liner);
      for (const side of [-1, 1]) {
        this.box([.042, .0115, .0005], m.insulation, liner, [0, .0125, side * .00345]);
        this.box([.0005, .0115, .0074], m.insulation, liner, [side * .0206, .0125, 0]);
      }
    }
    G.coils.forEach((coil, index) => {
      const node = this.part(coil.id, radialPoint(0, .016, coil.axisRad), this.rotor);
      const material = new THREE.MeshPhysicalMaterial({ color: coil.color, metalness: .58, roughness: .32, clearcoat: .72, clearcoatRoughness: .16 });
      this.materials.add(material);
      this.mesh(windingTube(rounded(coilWindingPoints(index), .00085), .00028), material, node);
      for (const route of COIL_LEAD_ROUTES.filter(route => route.coilId === coil.id)) {
        // Exact polyline: CPU clearance tests apply to the same centre line.
        const { mesh } = this.tube(route.points, route.radiusM, material, node); mesh.userData.route = route; this.leadMeshes.push(mesh);
      }
    });
    const hub = this.part('commutator-hub', [-.04, .005, .003], this.rotor);
    this.sleeve(.003, G.commutatorHubRadius, .017, m.resin, hub, [-.041, 0, 0]);
    for (let i = 0; i < 3; i++) {
      const node = this.part(`segment-${i}`, radialPoint(-.041, .010, G.segmentCentersRad[i]), this.rotor);
      const mesh = this.sleeve(G.commutatorHubRadius, G.commutatorRadius, length(G.commutatorX), m.copper, node, [center(G.commutatorX), 0, 0], G.segmentCentersRad[i] - G.segmentArcRad / 2, G.segmentArcRad);
      for (const side of [-1, 1]) {
        this.sleeve(.0088, .01035, .0011, m.copper, node, [-.0338, 0, 0], G.segmentCentersRad[i] + side * Math.PI / 9 - .035, .07);
      }
      this.segments.push({ id: `segment-${i}`, node, mesh });
    }
    const coupling = this.part('coupling', [.056, .007, 0], this.rotor);
    for (const x of [.052, .062]) this.sleeve(.003, .008, .006, m.steel, coupling, [x, 0, 0]);
    this.sleeve(.0032, .0075, .004, m.rubber, coupling, [.057, 0, 0]);
    for (const x of [.052, .062]) this.bolt(coupling, [x, .008, 0], 'y', .75);
    const load = this.part('load-rotor', [.085, .019, .006], this.rotor);
    this.cylinder(.003, length(G.loadShaftX), m.shaft, load, [center(G.loadShaftX), 0, 0]);
    this.cylinder(G.loadRotorRadius, length(G.loadRotorX), m.iron, load, [center(G.loadRotorX), 0, 0]);
    for (const x of [.075, .095]) this.sleeve(.012, .0243, .0014, m.steel, load, [x, 0, 0]);
    this.box([.020, .001, .003], m.brass, load, [.085, .0244, 0]);
  }
  buildContacts() {
    const m = this.mat;
    this.brushes = []; this.brushGuides = [];
    this.contactMarks = new THREE.Group(); this.root.add(this.contactMarks);
    for (const [name, beta] of Object.entries(G.brushAnglesRad)) {
      const sign = name === 'positive' ? 1 : -1, material = sign > 0 ? m.positive : m.negative;
      const brush = this.part(`brush-${name}`, [G.brushCenterX, G.axisY + .00125, sign * .0115]);
      const mesh = this.sleeve(G.commutatorRadius, G.brushOuterRadius, G.brushWidthX, m.graphite, brush, [G.brushCenterX, G.axisY, 0], beta - G.brushArcRad / 2, G.brushArcRad);
      this.sleeve(.0179, .01835, .0064, m.brass, brush, [G.brushCenterX, G.axisY, 0], beta - G.brushArcRad * .4, G.brushArcRad * .8);
      const marks = [0, 1].map(() => this.createContactMark(sign > 0 ? m.markPositive : m.markNegative));
      this.brushes.push({ id: `brush-${name}`, node: brush, mesh, center: V([G.brushCenterX, G.axisY, sign * .014]), name, beta, marks });
      const holder = this.part(`brush-holder-${name}`, [-.041, G.axisY + .004, sign * .020]);
      // Four walls leave a real radial guide channel around the carbon shoe.
      const g = brushGuideGeometry(), walls = [];
      walls.push(this.box([g.wallThicknessM, g.outerHeightYM, g.lengthM], m.resin, holder, [G.brushCenterX - g.sideCenterXM, G.axisY, sign * g.centerRadiusM]));
      walls.push(this.box([g.outerWidthXM, g.wallThicknessM, g.lengthM], m.resin, holder, [G.brushCenterX, G.axisY - g.roofCenterYM, sign * g.centerRadiusM]));
      const guideCover = new THREE.Group(); holder.add(guideCover);
      walls.push(this.box([g.wallThicknessM, g.outerHeightYM, g.lengthM], m.resin, guideCover, [G.brushCenterX + g.sideCenterXM, G.axisY, sign * g.centerRadiusM]));
      walls.push(this.box([g.outerWidthXM, g.wallThicknessM, g.lengthM], m.resin, guideCover, [G.brushCenterX, G.axisY + g.roofCenterYM, sign * g.centerRadiusM]));
      this.brushGuides.push({ id: `brush-holder-${name}`, brush: mesh, walls });
      // Section the guide roof and near side, never the carbon shoe/contact arc.
      this.covers.push({ front: guideCover, displacement: [.010, .035, 0], layer: 'contacts' });
      this.box([.012, .008, .003], m.resin, holder, [-.041, G.axisY, sign * .027]);
      this.box([length(G.brushMountX), .011, .018], m.resin, holder, [center(G.brushMountX), G.axisY, sign * .023]);
      this.box([.012, .011, .0025], m.resin, holder, [-.047, G.axisY, sign * .030]);
      const spring = this.part(`brush-spring-${name}`, [-.041, G.axisY + .0015, sign * .022]);
      const points = [];
      for (let i = 0; i <= 100; i++) { const t = i / 100; points.push([-.041 + .00125 * Math.cos(t * TAU * 5), G.axisY + .00125 * Math.sin(t * TAU * 5), sign * (.018 + .007 * t)]); }
      this.tube(points, .00022, m.chrome, spring);
      const terminal = this.part(`terminal-${name}`, [-.094, G.terminalContactY, sign > 0 ? .040 : .025]);
      this.cylinder(.0023, .004, material, terminal, [-.094, G.supplyTopY + .002, sign > 0 ? .040 : .025], 'y');
      this.cylinder(.0009, .0045, m.brass, terminal, [-.094, G.terminalContactY, sign > 0 ? .040 : .025], 'y');
      const lead = this.part(`lead-${name}`, EXTERNAL_LEADS[name][2]), tube = this.tube(EXTERNAL_LEADS[name], .00105, material, lead, true);
      const cone = new THREE.ConeGeometry(.00145, .0043, 10);
      const arrows = [.22, .49, .76].map(progress => {
        const arrow = this.mesh(cone, m.arrow, lead);
        arrow.position.copy(tube.curve.getPointAt(progress));
        arrow.position.y += .00235;
        arrow.userData.forward = tube.curve.getTangentAt(progress);
        arrow.userData.nonPickable = true; arrow.visible = false;
        arrow.castShadow = false; arrow.receiveShadow = false;
        return arrow;
      });
      this.arrowSets.push({ id: `lead-${name}`, arrows, sign });
    }
  }
  createContactMark(material) {
    const geometry = new THREE.BufferGeometry(), steps = 6, indices = [];
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((steps + 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    for (let i = 0; i < steps * 2; i += 2) indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    geometry.setIndex(indices);
    const mark = this.mesh(geometry, material, this.contactMarks, [0, G.axisY, 0]);
    mark.userData.nonPickable = true; mark.visible = false; mark.frustumCulled = false;
    mark.castShadow = false; mark.receiveShadow = false;
    return mark;
  }
  updateContactMarks() {
    // Draw each actual overlap just beyond the brush's axial edge so the
    // graphite does not hide it. The tints identify brush terminals.
    const { angleRad } = this.drawnCommutation;
    for (const { name, beta, marks } of this.brushes) {
      for (const [i, mark] of marks.entries()) {
        const overlap = this.drawnCommutation[name][i];
        mark.visible = !!overlap;
        if (!overlap) continue;
        const segment = G.segmentCentersRad[Number(overlap.segmentId.at(-1))] + angleRad;
        const delta = Math.atan2(Math.sin(segment - beta), Math.cos(segment - beta));
        const start = beta + Math.max(-G.brushArcRad / 2, delta - G.segmentArcRad / 2);
        const vertices = mark.geometry.attributes.position, edge = G.brushCenterX + G.brushWidthX / 2;
        const steps = vertices.count / 2 - 1;
        for (let j = 0; j <= steps; j++) {
          const angle = start + overlap.overlapRad * j / steps;
          const y = (G.commutatorRadius + .00009) * Math.cos(angle), z = (G.commutatorRadius + .00009) * Math.sin(angle);
          vertices.setXYZ(2 * j, edge, y, z);
          vertices.setXYZ(2 * j + 1, edge + .00215, y, z);
        }
        vertices.needsUpdate = true;
      }
    }
  }
  buildBench() {
    const m = this.mat, base = this.part('test-base', [.015, .013, .055]);
    this.box([.260, .010, .130], m.case, base, [.004, .009, -.005]);
    this.box([.254, .003, .124], m.dark, base, [.004, .0155, -.005]);
    for (const x of [-.100, .105]) for (const z of [-.052, .044]) { this.cylinder(.010, .004, m.rubber, base, [x, .002, z], 'y'); this.bolt(base, [x, .018, z], 'y'); }
    const supply = new THREE.Group(); base.add(supply); this.powerSupply = supply;
    this.box([.045, .021, .043], m.dark, supply, [-.094, .027, .020]);
    this.box([.046, .002, .044], m.case, supply, [-.094, .0385, .020]);
    // Leads exit a pair of raised, insulated connectors in the top panel.
    for (const z of [.025, .040]) this.cylinder(.0032, .002, m.resin, supply, [-.094, .040, z], 'y');
    this.plateText('DC  /  0–12 V', .034, .009, supply, [-.094, .027, .0416]);
    this.plateText('MOTOR LAB', .056, .010, base, [.066, .012, .0601]);
    const mount = this.part('motor-mount', [-.006, .034, -.015]);
    for (const x of [-.046, .024]) {
      this.box([.011, .023, .045], m.painted, mount, [x, .028, -.008]);
      this.sleeve(.030, .035, .011, m.painted, mount, [x, G.axisY, 0], Math.PI * .5, Math.PI);
      this.box([.025, .004, .057], m.steel, mount, [x, .019, -.008]);
      for (const z of [-.031, .016]) this.bolt(mount, [x, .022, z], 'y');
    }
    const load = this.splitSleeve('load-housing', .026, G.loadHousingRadius, G.loadHousingX, m.painted, [.025, .015, .075]);
    for (const x of [.072, .104]) {
      this.sleeve(.007, .030, .005, m.steel, load, [x, G.axisY, 0], Math.PI, Math.PI);
      this.sleeve(.003, .007, .005, m.chrome, load, [x, G.axisY, 0]);
      this.box([.012, .027, .043], m.painted, load, [x, .030, -.007]);
      this.box([.018, .004, .060], m.steel, load, [x, .019, -.007]);
      for (const z of [-.031, .018]) this.bolt(load, [x, .022, z], 'y');
    }
  }
  radialTexture(stops) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(texture);
    return texture;
  }
  buildStage() {
    this.stage = new THREE.Group();
    this.scene.add(this.stage);

    const floorMap = this.radialTexture([[0, '#1e303c'], [.22, '#182832'], [.5, '#101b24'], [1, '#101b24']]);
    const floorMaterial = this.material({ map: floorMap, roughness: .92, side: THREE.FrontSide });
    const floor = this.mesh(new THREE.PlaneGeometry(3, 3), floorMaterial, this.stage, [0, -.001, 0]);
    floor.rotation.x = -Math.PI / 2;
    floor.castShadow = false;

    const shadowMap = this.radialTexture([[0, 'rgba(0,0,0,.65)'], [.55, 'rgba(0,0,0,.45)'], [1, 'rgba(0,0,0,0)']]);
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false });
    const shadow = this.mesh(new THREE.PlaneGeometry(.38, .21), shadowMaterial, this.stage, [.004, -.0008, -.005]);
    shadowMaterial.dispose();
    shadow.rotation.x = -Math.PI / 2;
    shadow.castShadow = false;
    shadow.receiveShadow = false;
  }
  buildField() {
    this.field = new THREE.Group(); this.root.add(this.field);
    const material = new THREE.MeshBasicMaterial({ color: '#8fc9be', transparent: true, opacity: .68, depthWrite: false });
    this.materials.add(material);
    for (const x of [-.013, 0, .013]) for (const z of [-.008, .008]) {
      const points = [[x, G.axisY + .023, z], [x, G.axisY + .01, z * 1.4], [x, G.axisY - .01, z * 1.4], [x, G.axisY - .023, z]];
      const { mesh: line } = this.tube(points, .00017, material, this.field, true);
      const arrow = this.mesh(new THREE.ConeGeometry(.0012, .003, 10), material, this.field, [x, G.axisY, z * 1.4]);
      arrow.rotation.x = Math.PI;
      for (const item of [line, arrow]) { item.userData.nonPickable = true; item.castShadow = false; item.receiveShadow = false; }
    }
  }
  buildOverlay() {
    this.overlay = document.createElement('div'); this.overlay.className = 'motor-scene-overlay'; this.container.append(this.overlay);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.svg.classList.add('motor-label-lines'); this.overlay.append(this.svg); this.labels = new Map();
    for (const part of COMPONENTS) {
      const button = document.createElement('button'); button.className = 'motor-part-label'; button.textContent = part.name; button.title = part.name; button.type = 'button'; button.hidden = true;
      button.addEventListener('click', () => this.select(part.id)); this.overlay.append(button);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.style.display = 'none'; this.svg.append(line); this.labels.set(part.id, { button, line });
    }
    const status = document.createElement('div'); status.className = 'motor-scene-status'; this.overlay.append(status);
    this.note = document.createElement('p'); this.note.className = 'motor-scene-note'; this.note.hidden = true; status.append(this.note);
    this.observation = document.createElement('div'); this.observation.className = 'motor-scene-observation';
    this.observation.setAttribute('role', 'group'); this.observation.setAttribute('aria-label', '전동기 동작과 정류 접촉'); status.append(this.observation);
    const operating = document.createElement('p'); operating.className = 'motor-operating-readout'; this.observation.append(operating);
    this.currentReadout = document.createElement('span'); this.currentReadout.className = 'motor-current-readout';
    this.speedReadout = document.createElement('span'); this.speedReadout.className = 'motor-speed-readout';
    operating.append(this.currentReadout, this.speedReadout);
    this.contactReadout = document.createElement('p'); this.contactReadout.className = 'motor-contact-readout'; this.observation.append(this.contactReadout);
    const positive = document.createElement('span'); positive.className = 'motor-contact-positive';
    const negative = document.createElement('span'); negative.className = 'motor-contact-negative';
    const overlap = document.createElement('span'); overlap.className = 'motor-contact-overlap';
    this.contactReadout.append('브러시 접촉', positive, negative, overlap);
    this.contactValues = { positive, negative, overlap };
  }
  applyView() {
    const explode = this.view.mode === 'exploded' ? this.view.explode : 0, cut = this.view.mode !== 'assembled';
    for (const pair of this.covers) { pair.front.visible = this.view.layers[pair.layer] && (!cut || explode > 0); pair.front.position.set(...pair.displacement.map(n => n * explode)); }
    for (const item of this.explodedParts) item.node.position.set(...item.vector.map(n => n * explode));
    for (const [id, item] of this.components) {
      let visible = true;
      if (['housing', 'endbell-front', 'endbell-rear', 'load-housing'].includes(id)) visible = this.view.layers.housing;
      else if (id.startsWith('magnet-')) visible = this.view.layers.magnets;
      else if (id.startsWith('coil-') || id === 'slot-insulation') visible = this.view.layers.windings;
      else if (id.startsWith('brush-') || id.startsWith('segment-') || id.startsWith('terminal-') || id.startsWith('lead-') || id === 'commutator-hub') visible = this.view.layers.contacts;
      item.node.visible = visible;
    }
    this.field.visible = this.view.layers.field && !this.inspection;
    this.contactMarks.visible = this.view.layers.contacts && !this.inspection;
    this.updateBearings(cut);
    if (this.inspection) {
      for (const [id, item] of this.components) item.node.visible = id === this.inspection.id;
      const node = this.components.get(this.inspection.id).node, position = node.position.clone();
      if (this.inspection.position) {
        const delta = position.clone().sub(this.inspection.position);
        this.camera.position.add(delta); this.controls.target.add(delta);
      }
      this.inspection.position = position;
    }
    this.stage.visible = !this.inspection;
    this.observation.hidden = !this.snapshot || !!this.inspection;
    this.contactReadout.hidden = !this.view.layers.contacts;
    const notes = this.inspection ? [`${cut ? '궤도 반절개 · 볼·케이지 전체 유지 · ' : ''}대표 베어링 · 외륜 고정·접촉각 0° · 줄무늬는 자전 관찰 표시`] : [];
    if (!this.inspection && explode) notes.push('분해 관찰 · 접촉과 회전은 조립 치수 기준');
    if (this.field.visible) notes.push('자기장 N → S · 방향 도식 (정량 눈금 없음)');
    this.note.hidden = !notes.length; setText(this.note, notes.join(' / '));
  }
  update(snapshot, view, { elapsedS = 0 } = {}) {
    if (this.disposed) return;
    this.updating = true; this.snapshot = snapshot;
    this.view = { ...DEFAULT_VIEW, ...view, layers: { ...DEFAULT_VIEW.layers, ...view?.layers } };
    this.rotor.rotation.x = snapshot.angleRad;
    if (this.contactAngle !== snapshot.angleRad) {
      this.contactAngle = snapshot.angleRad;
      this.drawnCommutation = sampleCommutation(snapshot.angleRad);
      for (const item of this.segments) {
        const pos = this.drawnCommutation.positive.some(c => c.segmentId === item.id), neg = this.drawnCommutation.negative.some(c => c.segmentId === item.id);
        item.mesh.userData.contact = pos ? 'positive' : neg ? 'negative' : null;
      }
      this.updateContactMarks();
    }
    const current = snapshot.currentA, direction = Math.sign(current);
    const arrowDirection = this.view.currentArrows ? direction : 0;
    if (arrowDirection !== this.arrowDirection) {
      const up = new THREE.Vector3(0, 1, 0), tangent = new THREE.Vector3();
      for (const set of this.arrowSets) for (const arrow of set.arrows) {
        arrow.visible = arrowDirection !== 0;
        if (arrow.visible) arrow.quaternion.setFromUnitVectors(up, tangent.copy(arrow.userData.forward).multiplyScalar(arrowDirection * set.sign));
      }
      this.arrowDirection = arrowDirection;
    }
    this.applyView(); this.highlight(this.view.selectedPart);
    this.updateObservation(snapshot, direction);
    this.updating = false; this.render();
  }
  updateObservation({ currentA, rpm, locked }, direction) {
    const magnitude = Math.abs(currentA), current = magnitude > 0 && magnitude < .001 ? '<0.001' : magnitude.toFixed(3);
    const flow = direction > 0 ? '+ → 모터 → −' : '− → 모터 → +';
    setText(this.currentReadout, `평균 전류 ${direction < 0 && magnitude >= .001 ? '−' : ''}${current} A · ${direction ? flow : '흐름 없음'}`);
    const speed = Math.abs(rpm), speedText = speed > 0 && speed < 1 ? '<1' : shaftRpm.format(speed);
    const rotation = locked ? '축 고정' : rpm ? `${rpm > 0 ? '+' : '−'}X축` : '정지';
    setText(this.speedReadout, `회전 ${speedText} rpm · ${rotation}`);
    const ids = contacts => contacts.map(p => p.segmentId.replace('segment-', 'S')).join('·');
    const { positive, negative, bridgedCoils } = this.drawnCommutation;
    setText(this.contactValues.positive, `+ ${ids(positive)}`);
    setText(this.contactValues.negative, `− ${ids(negative)}`);
    this.contactValues.overlap.hidden = !bridgedCoils.length;
    setText(this.contactValues.overlap, bridgedCoils.length ? `두 편 동시 접촉 · 권선 ${bridgedCoils.map(id => id.at(-1).toUpperCase()).join('·')}` : '');
  }
  highlight(id) {
    if (id === this.highlightedPart) return;
    this.highlightedPart = id;
    this.root.traverse(object => {
      if (!object.isMesh || !object.userData.partId || object.userData.nonPickable) return;
      object.material.emissive.set(object.userData.partId === id ? '#2b7582' : '#000000'); object.material.emissiveIntensity = object.userData.partId === id ? .4 : 0;
    });
  }
  select(id) { if (!this.components.has(id)) return; this.view.selectedPart = id; this.highlight(id); this.render(); this.onSelect(id); }
  pick(event) {
    if (!this.down || this.down.button !== 0 || Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.root, true).find(result => {
      let item = result.object; if (item.userData.nonPickable || !item.userData.partId) return false;
      if (item.material.clippingPlanes?.some(plane => plane.distanceToPoint(result.point) < 0)) return false;
      while (item) { if (!item.visible) return false; item = item.parent; } return true;
    });
    if (hit) this.select(hit.object.userData.partId);
  }
  layoutLabels() {
    if (!this.labels || !this.width) return;
    const width = this.width, height = this.height, compact = width < 620;
    const standard = compact ? ['armature-core', 'brush-positive', 'load-rotor'] : ['magnet-n', 'coil-b', 'brush-positive', 'segment-1', 'load-rotor', 'bearing-front'];
    const candidates = this.focusContext
      ? (this.focusIsPreset ? this.focusContext : [...new Set([this.view.selectedPart, ...this.focusContext])].slice(0, 4))
      : [...new Set([this.view.selectedPart, ...standard])];
    for (const [id, label] of this.labels) { label.button.hidden = true; label.line.style.display = 'none'; label.button.classList.toggle('is-selected', id === this.view.selectedPart); }
    if (!this.view.labels || height < 180 || width < 160) return;
    this.root.updateMatrixWorld(true); const projected = [];
    for (const id of candidates) {
      const component = this.components.get(id); if (!component) continue;
      let ancestor = component.node, visible = true; while (ancestor) { if (!ancestor.visible) visible = false; ancestor = ancestor.parent; }
      if (!visible) continue; const p = component.node.localToWorld(component.anchor.clone()).project(this.camera);
      if (p.z < -1 || p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
      projected.push({ id, x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 });
    }
    const sides = [[], []]; projected.sort((a, b) => a.x - b.x).forEach((item, i) => sides[i < Math.ceil(projected.length / 2) ? 0 : 1].push(item));
    const top = Math.min(88, Math.max(65, height * .14));
    const footerSpace = this.inspection ? 70 : this.note.hidden ? 88 : compact ? 132 : 114;
    const bottom = Math.max(top + 25, height - footerSpace), labelWidth = compact ? Math.min(118, width * .32) : 148;
    for (let side = 0; side < 2; side++) {
      const items = sides[side].sort((a, b) => a.y - b.y), spacing = Math.min(45, (bottom - top) / Math.max(1, items.length - 1)); let last = top - spacing;
      items.forEach((p, index) => {
        const label = this.labels.get(p.id), y = clamp(p.y, Math.max(top, last + spacing), bottom - (items.length - index - 1) * spacing); last = y;
        const x = side ? width - labelWidth - 10 : 10, endX = side ? x : x + labelWidth;
        label.button.hidden = false; Object.assign(label.button.style, { left: `${x}px`, top: `${y - 15}px`, width: `${labelWidth}px` });
        label.line.setAttribute('d', `M ${p.x} ${p.y} L ${endX + (side ? -10 : 10)} ${y} L ${endX} ${y}`); label.line.style.display = ''; label.line.classList.toggle('is-selected', p.id === this.view.selectedPart);
      });
    }
  }
  visiblePoints(node = this.root) {
    const points = []; this.root.updateMatrixWorld(true);
    node.traverseVisible(object => {
      if (!object.isMesh || object.userData.nonPickable) return; object.geometry.computeBoundingBox(); const b = object.geometry.boundingBox;
      const matrices = [];
      if (object.isInstancedMesh) for (let i = 0; i < object.count; i++) { const matrix = new THREE.Matrix4(); object.getMatrixAt(i, matrix); matrices.push(matrix.premultiply(object.matrixWorld)); }
      else matrices.push(object.matrixWorld);
      for (const matrix of matrices) for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) points.push(new THREE.Vector3(x, y, z).applyMatrix4(matrix));
    }); return points;
  }
  fit(points, direction) {
    if (!points.length) return false;
    const bounds = new THREE.Box3().setFromPoints(points), target = bounds.getCenter(new THREE.Vector3()), dir = V(direction).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize(), up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan(this.camera.fov * Math.PI / 360), tanH = tanV * this.camera.aspect;
    let distance = .05;
    for (let iteration = 0; iteration < 5; iteration++) {
      const relative = points.map(p => p.clone().sub(target)); distance = .05;
      for (const p of relative) distance = Math.max(distance, p.dot(dir) + Math.abs(p.dot(right)) / (tanH * .83), p.dot(dir) + Math.abs(p.dot(up)) / (tanV * .78));
      if (iteration === 4) break;
      let left = Infinity, rightEdge = -Infinity, low = Infinity, high = -Infinity;
      for (const p of relative) { const depth = Math.max(.001, distance - p.dot(dir)), x = p.dot(right) / depth, y = p.dot(up) / depth; left = Math.min(left, x); rightEdge = Math.max(rightEdge, x); low = Math.min(low, y); high = Math.max(high, y); }
      target.addScaledVector(right, (left + rightEdge) * distance / 2).addScaledVector(up, (low + high) * distance / 2);
    }
    this.updating = true; this.camera.zoom = 1; this.camera.updateProjectionMatrix(); this.controls.target.copy(target); this.camera.position.copy(target.clone().addScaledVector(dir, Math.min(3, distance))); this.controls.update(); this.updating = false;
    this.render(); this.onCameraChange(this.getCameraState()); return true;
  }
  resetCamera(preset = 'iso') {
    this.endInspection();
    if (preset === 'commutator') return this.focusPart('segment-1', { preset: true });
    if (preset === 'output') return this.focusPart('load-rotor', { preset: true });
    this.focusContext = null; return this.fit(this.visiblePoints(), preset === 'front' ? [0, .12, 1] : [-.72, .44, 1]);
  }
  focusPart(id, { preset = false } = {}) {
    this.endInspection();
    const item = this.components.get(id); if (!item) return false;
    this.focusIsPreset = preset;
    let ids = [id], direction = [-.5, .25, 1], contextPoints = [];
    if (id.startsWith('terminal-')) {
      ids = ['terminal-positive', 'terminal-negative']; this.focusContext = ids;
      contextPoints = this.visiblePoints(this.powerSupply); direction = [-.65, 1.2, 1];
    } else if (id.startsWith('brush-') || id.startsWith('segment-') || id === 'commutator-hub') {
      ids = ['segment-0', 'segment-1', 'segment-2', 'commutator-hub', 'brush-positive', 'brush-negative', 'brush-holder-positive', 'brush-holder-negative', 'brush-spring-positive', 'brush-spring-negative'];
      this.focusContext = ['segment-0', 'segment-1', 'brush-positive', 'brush-spring-positive']; direction = [.75, 1.6, 1];
    } else if (id.startsWith('coil-') || id.startsWith('magnet-') || ['armature-core', 'slot-insulation'].includes(id)) {
      ids = ['armature-core', 'coil-a', 'coil-b', 'coil-c', 'magnet-n', 'magnet-s']; this.focusContext = ['coil-a', 'coil-b', 'coil-c', 'magnet-n']; direction = [-.25, .18, 1];
    } else if (['load-housing', 'load-rotor', 'coupling'].includes(id)) {
      ids = ['load-rotor', 'load-housing', 'coupling', 'bearing-front']; this.focusContext = ['load-rotor', 'coupling', 'bearing-front']; direction = [.65, .35, 1];
    } else if (id.startsWith('bearing-')) { this.focusContext = [id]; direction = [id.endsWith('front') ? .35 : -.35, .12, 1]; }
    else this.focusContext = [id];
    if (!preset) this.focusContext = [...new Set([id, ...this.focusContext])].slice(0, 4);
    const points = [...contextPoints, ...ids.flatMap(key => { const part = this.components.get(key); return part?.node.visible ? this.visiblePoints(part.node) : []; })];
    return this.fit(points, direction);
  }
  beginInspection(id) {
    if (!this.view.layers.housing || !this.bearings.some(b => b.id === id)) return false;
    if (this.inspection?.id === id) return true;
    this.endInspection();
    const saved = { camera: this.getCameraState(), focusContext: this.focusContext ? [...this.focusContext] : null, focusIsPreset: this.focusIsPreset };
    this.inspection = { id, saved, position: null };
    this.focusContext = [id]; this.focusIsPreset = true;
    this.applyView();
    const points = this.visiblePoints(this.components.get(id).node);
    this.fit(points, [.8, .35, 1]);
    // Keep the normal OrbitControls distance floor; optical zoom fits small
    // parts without a near-plane or orbit-distance exception.
    this.camera.updateMatrixWorld();
    const projected = points.map(p => p.clone().project(this.camera));
    const width = Math.max(...projected.map(p => p.x)) - Math.min(...projected.map(p => p.x));
    const height = Math.max(...projected.map(p => p.y)) - Math.min(...projected.map(p => p.y));
    this.camera.zoom = Math.min(4, Math.max(1, Math.min(1.6 / width, 1.5 / height)));
    this.camera.updateProjectionMatrix(); this.render();
    return true;
  }
  endInspection() {
    if (!this.inspection) return false;
    const saved = this.inspection.saved; this.inspection = null;
    this.applyView(); this.setCameraState(saved.camera);
    this.focusContext = saved.focusContext; this.focusIsPreset = saved.focusIsPreset;
    this.render(); return true;
  }
  getInspection() { return this.inspection ? { id: this.inspection.id } : null; }
  getProjectCameraState() { return this.inspection ? structuredClone(this.inspection.saved.camera) : this.getCameraState(); }
  getCameraState() { return { position: this.camera.position.toArray().map(ordinary), target: this.controls.target.toArray().map(ordinary), zoom: ordinary(this.camera.zoom) }; }
  setCameraState(state) {
    if (!state || ![state.position, state.target].every(a => Array.isArray(a) && a.length === 3 && a.every(n => Number.isFinite(n) && Math.abs(n) <= 100))) return false;
    const position = V(state.position), target = V(state.target), distance = position.distanceTo(target), zoom = state.zoom ?? 1;
    if (distance < .05 - 1e-10 || distance > 3 + 1e-10 || !Number.isFinite(zoom) || zoom < .25 || zoom > 4) return false;
    this.focusContext = null; this.updating = true; this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); this.camera.position.copy(position); this.controls.target.copy(target); this.controls.update();
    this.camera.position.copy(position); this.controls.target.copy(target); this.camera.lookAt(target); this.updating = false; this.render(); return true;
  }
  getComponents() { return COMPONENTS.map(p => ({ ...p })); }
  getDebug() {
    this.root.updateMatrixWorld(true);
    return { ready: !!this.snapshot, componentCount: this.components.size,
      inspection: this.getInspection(),
      rotationIntegralRad: this.rotationIntegralRad,
      bearings: this.bearings.map(b => {
        const ballTransforms = [];
        for (let i = 0; i < b.balls.count; i++) {
          const matrix = new THREE.Matrix4(); b.balls.getMatrixAt(i, matrix);
          const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(); matrix.decompose(position, quaternion, scale);
          ballTransforms.push({ index: b.visibleBallIndices[i], center: position.clone().applyMatrix4(b.balls.matrixWorld).toArray(), localCenter: position.toArray(), quaternion: quaternion.toArray() });
        }
        const trackRadii = b.clipped.slice(0, 2).map(mesh => {
          const p = mesh.geometry.attributes.position, values = [];
          for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) < 1e-10) values.push(Math.hypot(p.getY(i), p.getZ(i)));
          return mesh === b.clipped[0] ? Math.max(...values) : Math.min(...values);
        });
        return { id: b.id, ...b.phase, innerRotation: b.inner.rotation.x, cageRotation: b.cage.rotation.x,
          axis: b.assembly.getWorldPosition(new THREE.Vector3()).toArray(), pitchRadiusM: B.pitchRadiusM, ballRadiusM: B.ballRadiusM,
          grooveVertexClearanceM: Math.min(B.pitchRadiusM - trackRadii[0] - B.ballRadiusM, trackRadii[1] - B.pitchRadiusM - B.ballRadiusM),
          ballCount: B.ballCount, visibleBallCount: b.balls.count, sectioned: b.cut, sectionConvention: b.cut ? 'races-half-section-rolling-assembly-complete' : 'complete', ballTransforms };
      }),
      brushGuides: this.brushGuides.map(g => {
        const bounds = mesh => { mesh.geometry.computeBoundingBox(); return mesh.geometry.boundingBox.clone().translate(mesh.position); };
        // Manufacturing dimensions are taken before the cover's display offset.
        const walls = g.walls.map(bounds), brush = bounds(g.brush);
        const channel = { minX: walls[0].max.x, maxX: walls[2].min.x, minY: walls[1].max.y, maxY: walls[3].min.y };
        return { id: g.id, channel, brushBounds: { minX: brush.min.x, maxX: brush.max.x, minY: brush.min.y, maxY: brush.max.y },
          clearanceXM: Math.min(brush.min.x - channel.minX, channel.maxX - brush.max.x),
          clearanceYM: Math.min(brush.min.y - channel.minY, channel.maxY - brush.max.y) };
      }),
      drawnRotorAngleRad: this.rotor.rotation.x, commutation: sampleCommutation(this.rotor.rotation.x),
      brushWorldCenters: this.brushes.map(b => ({ id: b.id, center: b.node.localToWorld(b.center.clone()).toArray() })),
      segmentContacts: this.segments.map(s => ({ id: s.id, contact: s.mesh.userData.contact ?? null })),
      coilLeads: this.leadMeshes.map(mesh => ({ id: mesh.userData.route.id, coilId: mesh.userData.route.coilId, segmentId: mesh.userData.route.segmentId,
        start: mesh.localToWorld(V(mesh.userData.route.points[0])).toArray(), end: mesh.localToWorld(V(mesh.userData.route.points.at(-1))).toArray() })),
      externalLeads: this.arrowSets.map(set => ({ id: set.id, currentA: this.snapshot?.currentA ?? 0, visibleArrowCount: set.arrows.filter(a => a.visible && this.components.get(set.id).node.visible).length })),
      visibleParts: [...this.components].filter(([, p]) => p.node.visible).map(([id]) => id),
      labels: [...this.labels].filter(([, l]) => !l.button.hidden).map(([id, l]) => ({ id, left: parseFloat(l.button.style.left), top: parseFloat(l.button.style.top) })),
      camera: this.getCameraState(), drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, renderFrame: this.renderer.info.render.frame };
  }
  resize() { if (this.disposed) return; this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight); this.renderer.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); this.render(); }
  render() { if (this.disposed) return; this.camera.updateMatrixWorld(); this.layoutLabels(); this.renderer.render(this.scene, this.camera); }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.resizeObserver.disconnect(); this.controls.removeEventListener('change', this.controlChange); this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown); this.renderer.domElement.removeEventListener('pointerup', this.pointerUp);
    for (const mesh of this.instances) mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose(); for (const material of this.materials) material.dispose(); for (const texture of this.textures) texture.dispose();
    this.environment.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); this.overlay.remove(); this.container.classList.remove('motor-scene');
  }
}
