import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY_SI as G, TAU, sampleCommutation, brushContacts, COIL_LEAD_ROUTES, coilEndpoints, coilWindingPoints, rotorToWorld, EXTERNAL_LEADS } from '../src/geometry.js';

const near = (a, b, epsilon = 1e-12) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const clamp = x => Math.max(0, Math.min(1, x));
function segmentDistance(a, b, c, d) {
  const u = sub(b, a), v = sub(d, c), w = sub(a, c), A = dot(u, u), B = dot(u, v), C = dot(v, v), D = dot(u, w), E = dot(v, w);
  let s = A * C - B * B > 1e-24 ? clamp((B * E - C * D) / (A * C - B * B)) : 0;
  let t = C > 1e-24 ? (B * s + E) / C : 0;
  if (t < 0) { t = 0; s = A ? clamp(-D / A) : 0; }
  else if (t > 1) { t = 1; s = A ? clamp((B - D) / A) : 0; }
  return Math.hypot(...w.map((value, i) => value + s * u[i] - t * v[i]));
}
test('32 stable components and immutable default view use renderer-free SI data', () => {
  assert.equal(COMPONENTS.length, 32); assert.equal(new Set(COMPONENTS.map(p => p.id)).size, 32);
  for (const p of COMPONENTS) for (const key of ['id', 'name', 'description', 'material']) assert.ok(p[key]);
  assert.equal(DEFAULT_VIEW.selectedPart, 'armature-core'); assert.equal(Object.isFrozen(DEFAULT_VIEW.layers), true);
  assert.equal(brushContacts, sampleCommutation); near(G.housingOuterRadius * 2, .060);
  near(G.magnetInnerRadius - G.windingOuterRadius, .0015);
  near(G.segmentArcRad + G.segmentGapRad, TAU / 3);
});
test('finite brushes meet copper sectors and bridge exactly the actual connected coil', () => {
  assert.deepEqual(sampleCommutation(0).positive.map(p => p.segmentId), ['segment-1']);
  assert.deepEqual(sampleCommutation(0).negative.map(p => p.segmentId), ['segment-2']);
  const at30 = sampleCommutation(Math.PI / 6), at90 = sampleCommutation(Math.PI / 2);
  assert.deepEqual(at30.positive.map(p => p.segmentId), ['segment-0', 'segment-1']);
  assert.deepEqual(at30.bridgedCoils, ['coil-a']);
  for (const contact of at30.positive) near(contact.overlapRad, 5 * Math.PI / 180);
  assert.deepEqual(at90.negative.map(p => p.segmentId), ['segment-1', 'segment-2']);
  assert.deepEqual(at90.bridgedCoils, ['coil-b']);
  assert.deepEqual(sampleCommutation(TAU), sampleCommutation(0));
  for (const d of [25, 35]) assert.equal(sampleCommutation(d * Math.PI / 180).positive.length, 1, 'zero-width contact is not a conducting interval');
});
test('one whole turn has alternating overlap windows with no terminal short or dead brush', () => {
  const bridged = new Set();
  for (let d = -360; d <= 720; d += .25) {
    const result = sampleCommutation(d * Math.PI / 180);
    for (const contacts of [result.positive, result.negative]) {
      assert.ok(contacts.length >= 1 && contacts.length <= 2);
      for (const contact of contacts) assert.ok(contact.overlapRad > 0 && contact.overlapRad <= G.brushArcRad + 1e-12);
    }
    assert.ok(!result.positive.some(p => result.negative.some(n => n.segmentId === p.segmentId)));
    assert.ok(result.positive.length === 1 || result.negative.length === 1);
    result.bridgedCoils.forEach(id => bridged.add(id));
  }
  assert.deepEqual([...bridged].sort(), ['coil-a', 'coil-b', 'coil-c']);
  assert.throws(() => sampleCommutation(NaN)); assert.throws(() => sampleCommutation(Infinity));
});
test('coil windings and six insulated lead routes have exact copper endpoints and avoid the shaft', () => {
  assert.equal(COIL_LEAD_ROUTES.length, 6);
  for (let i = 0; i < 3; i++) {
    const endpoints = coilEndpoints(i), winding = coilWindingPoints(i);
    assert.deepEqual(winding[0], endpoints[0]); assert.deepEqual(winding.at(-1), endpoints[1]);
    for (const [j, route] of COIL_LEAD_ROUTES.slice(i * 2, i * 2 + 2).entries()) {
      assert.deepEqual(route.points[0], endpoints[j]); near(route.points.at(-1)[0], G.commutatorX[1]);
      near(Math.hypot(...route.points.at(-1).slice(1)), G.commutatorRadius);
      assert.equal(route.segmentId, j ? G.coils[i].to : G.coils[i].from);
      for (const p of route.points) { assert.ok(p.every(Number.isFinite)); assert.ok(Math.hypot(p[1], p[2]) - route.radiusM > G.shaftRadius); }
      for (const p of route.points.slice(1, -1)) assert.ok(p[0] <= -.027 && p[0] >= G.commutatorX[1]);
    }
  }
});
test('six actual lead polylines maintain copper-to-copper clearance across axial fanout lanes', () => {
  let minimum = Infinity;
  for (let a = 0; a < COIL_LEAD_ROUTES.length; a++) for (let b = a + 1; b < COIL_LEAD_ROUTES.length; b++) {
    const A = COIL_LEAD_ROUTES[a], B = COIL_LEAD_ROUTES[b];
    for (let i = 1; i < A.points.length; i++) for (let j = 1; j < B.points.length; j++) {
      const clearance = segmentDistance(A.points[i - 1], A.points[i], B.points[j - 1], B.points[j]) - A.radiusM - B.radiusM;
      minimum = Math.min(minimum, clearance);
      assert.ok(clearance > .00010, `${A.id}/${B.id}: clearance ${clearance}`);
    }
  }
  assert.ok(minimum > .00010);
});
test('world transform, bearing seats, motor/load coupling and fixed external wires agree', () => {
  assert.deepEqual(rotorToWorld([0, 0, 0]), [0, .070, 0]);
  const quarter = rotorToWorld([.01, .02, 0], Math.PI / 2); near(quarter[0], .01); near(quarter[1], .070); near(quarter[2], .02);
  for (const [i, x] of G.bearingCentersX.entries()) {
    const range = i ? G.frontEndbellX : G.rearEndbellX;
    near(x - G.bearingLength / 2, range[0]); near(x + G.bearingLength / 2, range[1]);
  }
  assert.ok(G.couplingX[0] < G.shaftX[1] && G.couplingX[1] > G.loadShaftX[0]);
  assert.ok(G.loadShaftX[0] > G.shaftX[1]);
  for (const [name, points] of Object.entries(EXTERNAL_LEADS)) {
    const end = points.at(-1); near(end[0], G.brushCenterX); near(end[1], G.axisY); near(end[2], name === 'positive' ? .017 : -.017);
    near(points[0][1], G.terminalContactY); assert.ok(points[0][1] > G.supplyTopY);
  }
  assert.ok(G.brushMountX[0] < G.rearEndbellX[1] && G.brushMountX[1] > G.rearEndbellX[1], 'fixed holder is actually seated into the rear endbell');
});
