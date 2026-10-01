import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GEOMETRY_SI as G, TAU } from '../src/geometry.js';
import { BEARING_DETAIL as B, motorBearingKinematics, bearingRaceProfile, bearingRaceGeometry, bearingTrackRadius, brushGuideGeometry } from '../src/mechanical-geometry.js';

const near = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function verifyMesh(geometry) {
  const p = geometry.attributes.position, normals = geometry.attributes.normal;
  const key = v => v.map(n => Math.round(n * 1e9)).join(','), edges = new Map();
  let volume6 = 0;
  for (let i = 0; i < p.count; i += 3) {
    const vertices = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(p, i + j));
    const [a, b, c] = vertices, cross = b.clone().sub(a).cross(c.clone().sub(a));
    assert.ok(cross.length() > 1e-15, `degenerate triangle ${i / 3}`);
    volume6 += a.dot(b.clone().cross(c));
    for (let j = 0; j < 3; j++) {
      const normal = new THREE.Vector3().fromBufferAttribute(normals, i + j);
      near(normal.length(), 1, 6e-8); assert.ok(cross.dot(normal) > 0, 'normal opposes triangle winding');
      const start = key(vertices[j].toArray()), end = key(vertices[(j + 1) % 3].toArray());
      const sorted = [start, end].sort().join('|'), list = edges.get(sorted) ?? [];
      list.push(start < end ? 1 : -1); edges.set(sorted, list);
    }
  }
  for (const [edge, directions] of edges) {
    assert.equal(directions.length, 2, `unclosed edge ${edge}`); assert.equal(directions[0] + directions[1], 0, 'inconsistent winding');
  }
  assert.ok(volume6 > 0, 'negative signed volume');
  for (const attribute of Object.values(geometry.attributes)) assert.ok([...attribute.array].every(Number.isFinite));
  geometry.dispose(); return volume6 / 6;
}

test('both complete and sectioned bearing races are closed, outward oriented and finite', () => {
  for (const kind of ['inner', 'outer']) {
    const full = verifyMesh(bearingRaceGeometry(kind)), half = verifyMesh(bearingRaceGeometry(kind, { section: true }));
    near(half, full / 2, 1e-14);
  }
});

test('bearing geometry preserves the existing shaft, housing and axial envelopes with chamfered edges', () => {
  for (const kind of ['inner', 'outer']) {
    const geometry = bearingRaceGeometry(kind), p = geometry.attributes.position;
    const radii = Array.from({ length: p.count }, (_, i) => Math.hypot(p.getY(i), p.getZ(i)));
    near(geometry.boundingBox.min.x, -G.bearingLength / 2, 3e-10); near(geometry.boundingBox.max.x, G.bearingLength / 2, 3e-10);
    if (kind === 'inner') near(Math.min(...radii), G.shaftRadius, 3e-10);
    else near(Math.max(...radii), G.bearingOuterRadius, 5e-10);
    assert.ok(radii.every(r => r >= G.shaftRadius - 3e-10 && r <= G.bearingOuterRadius + 5e-10));
    assert.ok(bearingRaceProfile(kind).some(p => Math.abs(p.x) === G.bearingLength / 2 - B.edgeChamferM));
    geometry.dispose();
  }
});

test('concave groove geometry is tangent to the representative ball circle with explicit clearance', () => {
  for (const kind of ['inner', 'outer']) {
    const sign = kind === 'inner' ? -1 : 1;
    const centerRadius = B.pitchRadiusM - sign * (B.grooveRadiusM - B.ballRadiusM) + sign * B.radialClearanceM;
    for (const p of bearingRaceProfile(kind).filter(p => p.normal)) {
      near(p.x ** 2 + (p.r - centerRadius) ** 2, B.grooveRadiusM ** 2, 1e-19);
      near(Math.hypot(...p.normal), 1);
    }
    near(Math.abs(bearingTrackRadius(kind, 0) - B.pitchRadiusM), B.ballRadiusM + B.radialClearanceM);
  }
});

test('actual polygonal meridians and circumferential facets retain clearance through every ball phase', () => {
  // Bound all azimuths, including the mid-facet minimum of the outer race.
  // Sampling in X checks the finite meridian chords, not just the ideal circle.
  const interpolate = (profile, x) => {
    const arc = profile.filter(p => p.normal).sort((a, b) => a.x - b.x);
    if (x <= arc[0].x) return arc[0].r; if (x >= arc.at(-1).x) return arc.at(-1).r;
    const i = arc.findIndex(p => p.x >= x), a = arc[i - 1], b = arc[i]; return a.r + (b.r - a.r) * (x - a.x) / (b.x - a.x);
  };
  const inner = bearingRaceProfile('inner'), outer = bearingRaceProfile('outer');
  let minimum = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const x = -B.ballRadiusM + 2 * B.ballRadiusM * i / 2000;
    const sphereSection = Math.sqrt(Math.max(0, B.ballRadiusM ** 2 - x ** 2));
    minimum = Math.min(minimum, B.pitchRadiusM - sphereSection - interpolate(inner, x),
      interpolate(outer, x) * Math.cos(Math.PI / 96) - B.pitchRadiusM - sphereSection);
  }
  assert.ok(minimum > .000004, `mesh clearance ${minimum}`);
  for (let i = 0; i <= 720; i++) {
    const phase = motorBearingKinematics({ angleRad: i * TAU / 720 });
    const centers = Array.from({ length: B.ballCount }, (_, j) => new THREE.Vector3(0, B.pitchRadiusM * Math.cos(j * TAU / B.ballCount + phase.cageAngle), B.pitchRadiusM * Math.sin(j * TAU / B.ballCount + phase.cageAngle)));
    for (let j = 0; j < centers.length; j++) assert.ok(centers[j].distanceTo(centers[(j + 1) % centers.length]) > 2 * B.ballRadiusM + .0015);
  }
});

test('open cage rings and separator bars have positive ball and race clearances', () => {
  assert.ok(B.cageHalfSpacingM - B.cageRingThicknessM / 2 - B.ballRadiusM > .0002);
  const separatorDistance = 2 * B.pitchRadiusM * Math.sin(Math.PI / (2 * B.ballCount));
  assert.ok(separatorDistance - B.ballRadiusM - B.cageBarRadiusM > .0007);
  assert.ok(.0048 > bearingTrackRadius('inner', B.cageHalfSpacingM));
  assert.ok(.0052 < bearingTrackRadius('outer', B.cageHalfSpacingM));
});

test('signed bearing velocities satisfy independent fixed-outer and moving-inner no-slip equations', () => {
  for (const omegaRadS of [-640, -1, 0, .005, 1, 720]) {
    const k = motorBearingKinematics({ angleRad: 8.2, omegaRadS });
    const cage = k.cageRpm * TAU / 60, spin = k.ballWorldRpm * TAU / 60;
    near(cage * B.pitchRadiusM + spin * B.ballRadiusM, 0);
    near(cage * B.pitchRadiusM - spin * B.ballRadiusM, omegaRadS * (B.pitchRadiusM - B.ballRadiusM));
    near(k.ballWorldRpm, k.cageRpm + k.ballRelativeRpm);
    assert.equal(k.outerRpm, 0);
  }
});

test('unwrapped bearing phases retain full turns, reverse sign and do not depend on redraw count', () => {
  const k = motorBearingKinematics({ angleRad: TAU }), zero = motorBearingKinematics();
  assert.ok(Math.abs(k.cageAngle - zero.cageAngle) > 2.5);
  assert.ok(Math.abs(k.ballWorldAngle - zero.ballWorldAngle) > TAU);
  const reverse = motorBearingKinematics({ angleRad: -TAU });
  for (const key of ['innerAngle', 'cageAngle', 'ballWorldAngle', 'ballRelativeAngle']) near(k[key], -reverse[key]);
  const delta = .001, base = 20, speed = 120;
  const a = motorBearingKinematics({ angleRad: base, omegaRadS: speed }), b = motorBearingKinematics({ angleRad: base + speed * delta });
  near((b.cageAngle - a.cageAngle) / delta, a.cageRpm * TAU / 60, 1e-10);
  near((b.ballWorldAngle - a.ballWorldAngle) / delta, a.ballWorldRpm * TAU / 60, 1e-10);
  assert.deepEqual(a, motorBearingKinematics({ angleRad: base, omegaRadS: speed }));
  assert.throws(() => motorBearingKinematics({ angleRad: Infinity }), /finite/);
});

test('brush guide channel clears every carbon-shoe corner using the shared curved brush dimensions', () => {
  const guide = brushGuideGeometry();
  near(guide.halfXM - G.brushWidthX / 2, .0002);
  near(guide.halfYM - G.brushOuterRadius * Math.sin(G.brushArcRad / 2), .00015);
  for (const beta of Object.values(G.brushAnglesRad)) for (const r of [G.commutatorRadius, G.brushOuterRadius]) {
    for (let i = 0; i <= 200; i++) {
      const angle = beta - G.brushArcRad / 2 + G.brushArcRad * i / 200;
      assert.ok(guide.halfYM - Math.abs(r * Math.cos(angle)) >= .00015 - 1e-15);
    }
  }
});
