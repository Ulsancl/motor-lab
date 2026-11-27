import * as THREE from 'three';
import { TAU } from './geometry.js';

// Closed X-axis sleeves, optionally interrupted by axial capsule-shaped slots.
export function sleeveGeometry(inner, outer, size, start = 0, sweep = TAU, ventBanks = []) {
  const position = [], normal = [], uv = [];
  const count = Math.max(12, Math.ceil(sweep / TAU * 96));
  const angles = Array.from({ length: count + 1 }, (_, i) => start + sweep * i / count);
  const half = size / 2;
  const vents = ventBanks.length ? Array.from({ length: 4 }, (_, i) => start + sweep * (i + .5) / 4) : [];
  const endRadius = .00165, angularRadius = endRadius / outer;
  for (const angle of vents) {
    // Include the exact tangent points on either side of each rounded end.
    for (let i = 0; i <= 10; i++) angles.push(angle - angularRadius * Math.cos(Math.PI * i / 10));
  }
  angles.sort((a, b) => a - b);
  const p = (x, r, a) => [x, r * Math.cos(a), r * Math.sin(a), a];
  const vector = ([x, y, z]) => new THREE.Vector3(x, y, z);
  const quad = (a, b, c, d, reverse = false, radialSign = 0) => {
    const order = reverse ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
    const face = vector(order[1]).sub(vector(a)).cross(vector(order[2]).sub(vector(a)));
    if (face.lengthSq() < 1e-26) face.copy(vector(order[4]).sub(vector(a)).cross(vector(order[5]).sub(vector(a))));
    face.normalize();
    for (const [x, y, z, angle] of order) {
      position.push(x, y, z);
      if (radialSign) {
        const r = Math.hypot(y, z);
        normal.push(0, radialSign * y / r, radialSign * z / r);
      } else normal.push(face.x, face.y, face.z);
      uv.push(angle / TAU, x / size + .5);
    }
  };
  const shell = (a, b, minA, minB, maxA, maxB) => {
    quad(p(minA, outer, a), p(minB, outer, b), p(maxB, outer, b), p(maxA, outer, a), false, 1);
    if (inner > 0) quad(p(minA, inner, a), p(maxA, inner, a), p(maxB, inner, b), p(minB, inner, b), false, -1);
  };
  const section = (a, low, high, reverse) => {
    quad(p(low, inner, a), p(low, outer, a), p(high, outer, a), p(high, inner, a), reverse);
  };
  for (let i = 1; i < angles.length; i++) {
    const a = angles[i - 1], b = angles[i];
    if (b - a < 1e-10) continue;
    const vent = vents.find(angle => Math.abs(angle - (a + b) / 2) < angularRadius);
    let minA = -half, minB = -half;
    if (vent !== undefined) {
      const depth = angle => endRadius * Math.sqrt(Math.max(0, 1 - ((angle - vent) / angularRadius) ** 2));
      for (const [low, high] of ventBanks) {
        const loA = low + endRadius - depth(a), loB = low + endRadius - depth(b);
        const hiA = high - endRadius + depth(a), hiB = high - endRadius + depth(b);
        shell(a, b, minA, minB, loA, loB);
        quad(p(loA, inner, a), p(loA, outer, a), p(loB, outer, b), p(loB, inner, b));
        quad(p(hiA, inner, a), p(hiA, outer, a), p(hiB, outer, b), p(hiB, inner, b), true);
        minA = hiA; minB = hiB;
      }
    }
    shell(a, b, minA, minB, half, half);
    for (const x of [-half, half]) quad(p(x, inner, a), p(x, inner, b), p(x, outer, b), p(x, outer, a), x > 0);
  }
  if (sweep < TAU - 1e-10) {
    section(start, -half, half, false);
    section(start + sweep, -half, half, true);
  }
  for (const angle of vents) for (const [low, high] of ventBanks) {
    section(angle - angularRadius, low + endRadius, high - endRadius, true);
    section(angle + angularRadius, low + endRadius, high - endRadius, false);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

// Sample each bend and each straight explicitly so short end turns aren't
// skipped by uniform distance samples along the whole winding.
export function windingTube(path, radius) {
  const points = [path.curves[0].getPoint(0)];
  for (const curve of path.curves) {
    const count = curve.isLineCurve3 ? 1 : 4;
    for (let i = 1; i <= count; i++) points.push(curve.getPoint(i / count));
  }
  const wire = new THREE.Curve(), last = points.length - 1;
  wire.getUtoTmapping = u => u;
  wire.getPoint = (t, target = new THREE.Vector3()) => {
    const u = t * last, i = Math.min(Math.floor(u), last - 1);
    return target.copy(points[i]).lerp(points[i + 1], u - i);
  };
  return new THREE.TubeGeometry(wire, last, radius, 8, false);
}
