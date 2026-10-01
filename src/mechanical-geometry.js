import * as THREE from 'three';
import { GEOMETRY_SI as G, TAU } from './geometry.js';

// Representative open radial bearing, not a catalogue bearing/load model.
export const BEARING_DETAIL = Object.freeze({
  pitchRadiusM: .005, ballRadiusM: .00093, ballCount: 9,
  grooveRadiusM: .00093 * 1.07, grooveHalfWidthM: .00070,
  radialClearanceM: .000008, edgeChamferM: .00008,
  cageHalfSpacingM: .00125, cageRingThicknessM: .00020,
  cageBarRadiusM: .00010,
});

export function motorBearingKinematics({ angleRad = 0, omegaRadS = 0 } = {}) {
  if (![angleRad, omegaRadS].every(Number.isFinite)) throw new TypeError('Bearing rotation must be finite');
  const q = BEARING_DETAIL.ballRadiusM / BEARING_DETAIL.pitchRadiusM;
  const cageRatio = (1 - q) / 2, ballRelativeRatio = -(1 / q - q) / 2;
  const ballWorldRatio = cageRatio + ballRelativeRatio, rpm = omegaRadS * 60 / TAU;
  return { innerAngle: angleRad, cageAngle: angleRad * cageRatio,
    ballRelativeAngle: angleRad * ballRelativeRatio, ballWorldAngle: angleRad * ballWorldRatio,
    innerRpm: rpm, outerRpm: 0, cageRpm: rpm * cageRatio,
    ballRelativeRpm: rpm * ballRelativeRatio, ballWorldRpm: rpm * ballWorldRatio };
}

export function bearingTrackRadius(kind, x) {
  const b = BEARING_DETAIL, sign = kind === 'inner' ? -1 : 1;
  if (!['inner', 'outer'].includes(kind)) throw new RangeError('Unknown bearing race');
  const clampedX = Math.min(Math.abs(x), b.grooveHalfWidthM);
  return b.pitchRadiusM - sign * (b.grooveRadiusM - b.ballRadiusM)
    + sign * Math.sqrt(b.grooveRadiusM ** 2 - clampedX ** 2) + sign * b.radialClearanceM;
}

// Ordered meridian in {x,r}; outer walls travel towards +X. Arc normals are
// analytic; the separate bevel/end strips deliberately retain their hard edges.
export function bearingRaceProfile(kind) {
  const b = BEARING_DETAIL, h = G.bearingLength / 2, c = b.edgeChamferM;
  const shoulder = bearingTrackRadius(kind, b.grooveHalfWidthM);
  const arc = [];
  for (let i = 0; i <= 32; i++) {
    const x = -b.grooveHalfWidthM + 2 * b.grooveHalfWidthM * i / 32;
    arc.push({ x, r: bearingTrackRadius(kind, x), normal: [-x / b.grooveRadiusM,
      (kind === 'inner' ? 1 : -1) * Math.sqrt(b.grooveRadiusM ** 2 - x ** 2) / b.grooveRadiusM] });
  }
  const p = (x, r) => ({ x, r });
  if (kind === 'inner') return [p(-h, G.shaftRadius + c), p(-h, shoulder - c), p(-h + c, shoulder),
    ...arc, p(h - c, shoulder), p(h, shoulder - c), p(h, G.shaftRadius + c),
    p(h - c, G.shaftRadius), p(-h + c, G.shaftRadius)];
  return [p(-h, shoulder + c), p(-h, G.bearingOuterRadius - c),
    p(-h + c, G.bearingOuterRadius), p(h - c, G.bearingOuterRadius),
    p(h, G.bearingOuterRadius - c), p(h, shoulder + c), p(h - c, shoulder),
    ...arc.reverse(), p(-h + c, shoulder)];
}

export function revolvedProfileGeometry(profile, { start = 0, sweep = TAU, segments = 96, capsOnly = false } = {}) {
  const positions = [], normals = [], uvs = [];
  const point = (p, a) => [p.x, p.r * Math.cos(a), p.r * Math.sin(a)];
  const emit = (p, n, uv) => { positions.push(...p); normals.push(...n); uvs.push(...uv); };
  const axialMin = Math.min(...profile.map(p => p.x)), axialSpan = Math.max(...profile.map(p => p.x)) - axialMin;
  const n = Math.max(12, Math.ceil(segments * sweep / TAU));
  if (!capsOnly) for (let j = 0; j < profile.length; j++) {
    const a = profile[j], b = profile[(j + 1) % profile.length], dx = b.x - a.x, dr = b.r - a.r, norm = Math.hypot(dx, dr);
    for (let i = 0; i < n; i++) {
      const angle0 = start + sweep * i / n, angle1 = start + sweep * (i + 1) / n;
      for (const [p, angle] of [[a, angle0], [b, angle1], [b, angle0], [a, angle0], [a, angle1], [b, angle1]]) {
        const [nx, nr] = a.normal && b.normal ? p.normal : [-dr / norm, dx / norm];
        emit(point(p, angle), [nx, nr * Math.cos(angle), nr * Math.sin(angle)], [angle / TAU, (p.x - axialMin) / axialSpan]);
      }
    }
  }
  if (sweep < TAU - 1e-10) {
    const triangles = THREE.ShapeUtils.triangulateShape(profile.map(p => new THREE.Vector2(p.x, p.r)), []);
    for (const [angle, sign] of [[start, -1], [start + sweep, 1]]) for (const triangle of triangles) {
      const normal = new THREE.Vector3(0, -Math.sin(angle) * sign, Math.cos(angle) * sign);
      const vertices = triangle.map(i => point(profile[i], angle));
      const cross = new THREE.Vector3().subVectors(new THREE.Vector3(...vertices[1]), new THREE.Vector3(...vertices[0]))
        .cross(new THREE.Vector3().subVectors(new THREE.Vector3(...vertices[2]), new THREE.Vector3(...vertices[0])));
      if (cross.dot(normal) < 0) [vertices[1], vertices[2]] = [vertices[2], vertices[1]];
      for (const p of vertices) emit(p, normal.toArray(), [(p[0] - axialMin) / axialSpan, Math.hypot(p[1], p[2]) / G.bearingOuterRadius]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

export function bearingRaceGeometry(kind, { section = false, capsOnly = false } = {}) {
  return revolvedProfileGeometry(bearingRaceProfile(kind), { start: section ? Math.PI : 0, sweep: section ? Math.PI : TAU, capsOnly });
}

export function brushGuideGeometry() {
  const wallThicknessM = .0012, halfXM = G.brushWidthX / 2 + .0002;
  const brushHalfYM = G.brushOuterRadius * Math.sin(G.brushArcRad / 2), halfYM = brushHalfYM + .00015;
  return { halfXM, halfYM, brushHalfYM, wallThicknessM, lengthM: .013, centerRadiusM: .020,
    sideCenterXM: halfXM + wallThicknessM / 2, roofCenterYM: halfYM + wallThicknessM / 2,
    outerWidthXM: 2 * (halfXM + wallThicknessM), outerHeightYM: 2 * (halfYM + wallThicknessM) };
}
