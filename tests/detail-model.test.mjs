import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, instantSnapshot, reconfigureExperiment, step, MOTOR_CONSTANTS_SI as M } from '../src/model.js';
import { COMPONENTS, GEOMETRY_SI as G, TAU } from '../src/geometry.js';
import { motorDetail } from '../src/detail-model.js';
import { describeMotorDetail } from '../src/detail-readouts.js';
import { BEARING_DETAIL } from '../src/mechanical-geometry.js';

const near = (actual, expected, tolerance = 1e-10) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);
const at = (state, seconds) => step(state, seconds).state;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const running = at(createExperiment({ voltageV: 12, loadCoefficient: 0 }), 3);
const regeneration = at(reconfigureExperiment(running, { voltageV: 3 }), .01);
const braking = at(reconfigureExperiment(running, { voltageV: 0 }), .01);
// The strict file contract allows consistent signed states without reconstructing
// a unique input history. This exercises the sign convention in that domain too.
const reverse = { ...createExperiment({ voltageV: 3, loadCoefficient: .0005 }),
  timeS: 1, currentA: -1, omegaRadS: -50,
  energyJ: { supply: .5 * M.inductanceH + .5 * M.inertiaKgM2 * 50 ** 2, copper: 0, friction: 0, load: 0 } };

test('Startup voltage first changes magnetic state; locked RL derivative matches an independent exponential', () => {
  const initial = createExperiment({ voltageV: 12, loadCoefficient: 0 });
  const d = motorDetail(initial);
  near(d.electrical.currentRateAps, 3000); near(d.electrical.inductiveV, 12);
  near(d.mechanical.accelerationRadS2, 0); near(d.power.supplyW, 0);
  near(d.electrical.rlTimeConstantS, .002);
  const locked = createExperiment(initial.settings, { locked: true }), time = .003;
  const value = motorDetail(at(locked, time));
  const decay = Math.exp(-time / .002), expectedCurrent = 6 * (1 - decay);
  near(value.currentA, expectedCurrent, 1e-11);
  near(value.electrical.currentRateAps, 3000 * decay, 1e-8);
  near(value.power.magneticStorageW, .004 * expectedCurrent * 3000 * decay, 1e-9);
});

test('Independent finite changes recover current, speed and both individual stored-energy rates', () => {
  const conditions = [
    [createExperiment({ voltageV: 12, loadCoefficient: 0 }), .003],
    [createExperiment({ voltageV: 6, loadCoefficient: .001 }), .25],
    [createExperiment({ voltageV: 12, loadCoefficient: 0 }, { locked: true }), .004],
    [reconfigureExperiment(running, { voltageV: 3 }), .004],
    [reconfigureExperiment(running, { voltageV: 0 }), .02],
    [reverse, .003],
  ];
  const h = 1e-7;
  for (const [start, t] of conditions) {
    const before = at(start, t - h), after = at(start, t + h), d = motorDetail(at(start, t));
    near((after.currentA - before.currentA) / (2 * h), d.electrical.currentRateAps, 5e-5);
    near((after.omegaRadS - before.omegaRadS) / (2 * h), d.mechanical.accelerationRadS2, 5e-5);
    const magnetic = state => .5 * M.inductanceH * state.currentA ** 2;
    const kinetic = state => .5 * M.inertiaKgM2 * state.omegaRadS ** 2;
    near((magnetic(after) - magnetic(before)) / (2 * h), d.power.magneticStorageW, 2e-6);
    near((kinetic(after) - kinetic(before)) / (2 * h), d.power.kineticStorageW, 1e-5);
  }
});

test('Signed circuit and torque terms reconstruct the dynamics including reverse imported motion and constraints', () => {
  const cases = [createExperiment(), running, regeneration, braking, reverse,
    at(createExperiment({ voltageV: 12, loadCoefficient: .001 }, { locked: true }), .002)];
  for (const state of cases) {
    const d = motorDetail(state), { electrical: e, mechanical: m, power: p } = d;
    near(e.sourceV, e.resistiveV + e.backEmfV + e.inductiveV);
    near(m.netNm, m.electromagneticNm + m.frictionNm + m.loadNm + m.constraintNm);
    near(m.netNm, M.inertiaKgM2 * m.accelerationRadS2);
    near(p.electromagneticW, m.electromagneticNm * state.omegaRadS);
    near(p.supplyW, p.copperW + p.frictionW + p.loadW + p.magneticStorageW + p.kineticStorageW);
    near(p.electromagneticW, p.frictionW + p.loadW + p.kineticStorageW);
    near(e.residualV, 0); near(m.residualNm, 0); near(p.residualW, 0);
    near(p.electricalResidualW, 0); near(p.mechanicalResidualW, 0);
    near(p.magneticStorageW + p.kineticStorageW, instantSnapshot(state).powerW.storageRate);
  }
  const reversed = motorDetail(reverse);
  assert.ok(reversed.mechanical.frictionNm > 0 && reversed.mechanical.loadNm > 0);
  assert.ok(reversed.contact.surfaceVelocityMps < 0 && reversed.contact.passesPerBrushHz > 0);
});

test('Regeneration and zero-volt short-circuit braking preserve signed power without an efficiency quotient', () => {
  const regen = motorDetail(regeneration), short = motorDetail(braking);
  assert.ok(regen.currentA < 0 && regen.power.supplyW < 0 && regen.power.electromagneticW < 0);
  assert.ok(regen.power.copperW > 0 && regen.power.kineticStorageW < 0);
  near(short.power.supplyW, 0); assert.ok(short.currentA < 0 && short.power.copperW > 0);
  assert.ok(short.power.magneticStorageW + short.power.kineticStorageW < 0);
  assert.ok(short.electrical.resistiveV < 0 && short.electrical.backEmfV > 0);
  for (const value of [regen, short, motorDetail(createExperiment({ voltageV: 0 }))]) {
    assert.doesNotMatch(JSON.stringify(value), /NaN|Infinity|efficiency/);
  }
});

test('Locked shaft has a balancing reaction without mechanical power, including magnetic startup storage', () => {
  const initial = createExperiment({ voltageV: 12, loadCoefficient: .001 }, { locked: true });
  const transient = motorDetail(at(initial, .001)), final = motorDetail(at(initial, .2));
  assert.ok(transient.power.magneticStorageW > 0 && transient.power.supplyW > transient.power.copperW);
  for (const d of [transient, final]) {
    near(d.mechanical.constraintNm, -d.mechanical.electromagneticNm);
    near(d.mechanical.netNm, 0); near(d.mechanical.accelerationRadS2, 0);
    near(d.power.electromagneticW, 0); near(d.power.kineticStorageW, 0);
    near(d.power.frictionW, 0); near(d.power.loadW, 0);
    near(d.contact.surfaceVelocityMps, 0); near(d.contact.passesPerBrushHz, 0);
    assert.ok(d.contact.positive.copperAreaM2 > 0);
  }
  near(final.currentA, 6, 1e-10); near(final.mechanical.constraintNm, -.24, 1e-11);
  near(final.power.copperW, 72, 1e-8);
});

test('Steady references satisfy the independent circuit/load intersection and the long-time solution', () => {
  for (const voltageV of [0, 3, 6, 12]) for (const loadCoefficient of [0, .0005, .001]) for (const locked of [false, true]) {
    const initial = createExperiment({ voltageV, loadCoefficient }, { locked }), d = motorDetail(initial), s = d.steady;
    near(voltageV, 2 * s.currentA + .04 * s.omegaRadS);
    if (!locked) near(.04 * s.currentA, (.00002 + loadCoefficient) * s.omegaRadS);
    else { near(s.omegaRadS, 0); near(s.currentA, voltageV / 2); }
    near(s.supplyW, s.copperW + s.frictionW + s.loadW);
    const later = motorDetail(at(initial, 30));
    near(later.currentA, s.currentA, 2e-9); near(later.omegaRadS, s.omegaRadS, 2e-8);
    assert.deepEqual(later.steady, s);
    assert.equal(initial.timeS, 0); assert.equal(initial.currentA, 0);
  }
  const decelerating = reconfigureExperiment(running, { voltageV: 3 });
  assert.deepEqual(motorDetail(decelerating).steady, motorDetail(createExperiment(decelerating.settings)).steady);
  assert.ok(motorDetail(decelerating).rpm > motorDetail(decelerating).steady.rpm);
});

test('Curved copper contact footprints resolve the finite brush and zero-area bridge boundaries', () => {
  const detailAt = degrees => motorDetail(createExperiment({}, { angleRad: degrees * Math.PI / 180 })).contact;
  const nominal = .010 * .008 * 12 * Math.PI / 180;
  near(detailAt(0).nominalAreaM2, nominal);
  near(detailAt(0).positive.copperAreaM2, nominal);
  const overlap = detailAt(30);
  assert.deepEqual(overlap.positive.contacts.map(row => row.segmentId), ['segment-0', 'segment-1']);
  for (const contact of overlap.positive.contacts) near(contact.areaM2, .010 * .008 * 5 * Math.PI / 180);
  near(overlap.positive.copperAreaM2, nominal * 10 / 12);
  assert.deepEqual(overlap.bridgedCoils, ['coil-a']);
  assert.equal(detailAt(25).positive.contacts.length, 1); assert.equal(detailAt(35).positive.contacts.length, 1);
  assert.equal(detailAt(25.001).positive.contacts.length, 2); assert.equal(detailAt(34.999).positive.contacts.length, 2);
  near(detailAt(390).positive.copperAreaM2, overlap.positive.copperAreaM2);
});

test('Whole-revolution overlap integral equals the copper duty fraction, and speeds use actual SI geometry', () => {
  let positiveArea = 0, negativeArea = 0, bridged = 0;
  // Midpoint quadrature is exact here: the overlap is piecewise linear and its
  // integer-degree corners lie on the boundaries of these half-degree cells.
  const samples = 720, initial = createExperiment();
  for (let index = 0; index < samples; index++) {
    const c = motorDetail({ ...initial, angleRad: (index + .5) * TAU / samples }).contact;
    positiveArea += c.positive.copperAreaM2; negativeArea += c.negative.copperAreaM2;
    bridged += Number(c.bridgedCoils.length > 0);
    for (const brush of [c.positive, c.negative]) {
      assert.ok(brush.copperAreaM2 >= c.nominalAreaM2 * 10 / 12 - 1e-15);
      assert.ok(brush.copperAreaM2 <= c.nominalAreaM2 + 1e-15);
    }
  }
  const nominal = G.commutatorRadius * G.brushWidthX * G.brushArcRad;
  near(positiveArea / samples, nominal * 118 / 120, 1e-15);
  near(negativeArea / samples, nominal * 118 / 120, 1e-15);
  near(bridged / samples, 1 / 6);
  for (const state of [running, regeneration, reverse]) {
    const c = motorDetail(state).contact;
    near(c.surfaceVelocityMps / state.omegaRadS, G.commutatorRadius);
    near(c.passesPerBrushHz * TAU / Math.abs(state.omegaRadS), G.segmentCentersRad.length);
  }
});

test('All 32 component readouts are compact, have coherent units and leave frozen state/snapshot untouched', () => {
  for (const original of [createExperiment(), running, regeneration, braking, reverse]) {
    const state = freeze(structuredClone(original)), snapshot = freeze(instantSnapshot(state)), before = JSON.stringify({ state, snapshot });
    for (const part of COMPONENTS) {
      const result = describeMotorDetail(part.id, state, snapshot);
      assert.ok(result.facts.length > 0 && result.facts.length <= 6, part.id);
      assert.ok(result.note.length > 0); assert.equal(new Set(result.facts.map(row => row.label)).size, result.facts.length);
      for (const row of result.facts) {
        assert.ok(row.label && typeof row.unit === 'string');
        assert.ok(typeof row.value === 'string' || Number.isFinite(row.value), `${part.id}: ${row.label}`);
      }
    }
    assert.equal(JSON.stringify({ state, snapshot }), before);
  }
  const rows = Object.fromEntries(describeMotorDetail('terminal-negative', regeneration).facts.map(row => [row.label, row]));
  near(rows['전기자 저항 전압'].value, regeneration.currentA * 2); assert.equal(rows['전기자 저항 전압'].unit, 'V');
  const brush = Object.fromEntries(describeMotorDetail('brush-positive', createExperiment({}, { angleRad: Math.PI / 6 })).facts.map(row => [row.label, row]));
  near(brush['구리 접촉 기하 면적'].value, .010 * .008 * 10 * Math.PI / 180 * 1e6); assert.equal(brush['구리 접촉 기하 면적'].unit, 'mm²');
});

test('Bearing instantaneous rates satisfy both no-slip contact velocities without inventing saved phases', () => {
  const { pitchRadiusM: radius, ballRadiusM: ball } = BEARING_DETAIL;
  for (const state of [createExperiment(), running, regeneration, reverse]) {
    const b = motorDetail(state).bearing;
    const cage = b.cageRpm * TAU / 60, spin = b.ballWorldRpm * TAU / 60;
    near(cage * radius + spin * ball, 0);
    near(cage * radius - spin * ball, state.omegaRadS * (radius - ball));
    near(b.innerRpm, state.omegaRadS * 60 / TAU); near(b.outerRpm, 0);
    assert.ok(!Object.keys(b).some(key => /angle|phase/i.test(key)));
  }
});

test('Derived outputs have no shared mutable records and preserve strict legacy state/snapshot contracts', () => {
  const state = structuredClone(running), snapshot = instantSnapshot(state), before = structuredClone({ state, snapshot });
  const d = motorDetail(state, snapshot);
  d.energyJ.supply = -100; d.storedEnergyJ.total = -100; d.contact.positive.contacts[0].segmentId = 'changed'; d.contact.bridgedCoils.push('changed');
  assert.deepEqual({ state, snapshot }, before);
  assert.deepEqual(Object.keys(state), Object.keys(createExperiment()));
  assert.ok(!('detail' in instantSnapshot(state)));
  for (const bad of [{ ...state, extra: 0 }, { ...state, currentA: NaN }, { ...state, omegaRadS: -0 }]) {
    assert.throws(() => motorDetail(bad)); assert.throws(() => describeMotorDetail('shaft', bad));
  }
  let timeline = createExperiment();
  for (const [voltageV, loadCoefficient, duration] of [[12, 0, .001], [12, .001, .2], [3, 0, .2], [0, .0005, 1], [6, 0, 10]]) {
    timeline = at(reconfigureExperiment(timeline, { voltageV, loadCoefficient }), duration);
    const detail = motorDetail(timeline);
    near(detail.balance.energyResidualJ, 0, 2e-8);
    near(detail.power.residualW, 0, 1e-10);
  }
});
