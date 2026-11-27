import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, instantSnapshot, reconfigureExperiment, step } from '../src/model.js';
import { motorDetail } from '../src/detail-model.js';
import { createProject, parseProject, serializeProject, snapshotTrace } from '../src/project.js';

const near = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test('fixed resistance changes the locked RL rise, input budget and saved current bound', () => {
  const dt = .004;
  const experiments = [1, 2, 8].map(resistanceOhm => {
    const initial = createExperiment({ voltageV: 12, resistanceOhm }, { locked: true });
    const { state } = step(initial, dt);
    const snapshot = instantSnapshot(state);
    near(state.currentA, 12 / resistanceOhm * -Math.expm1(-dt * resistanceOhm / .004));
    near(snapshot.powerW.copper, resistanceOhm * state.currentA ** 2);
    near(snapshot.storedEnergyJ.total + state.energyJ.copper, state.energyJ.supply);
    const detail = motorDetail(state, snapshot);
    near(detail.electrical.resistiveV, resistanceOhm * state.currentA);
    near(detail.electrical.rlTimeConstantS, .004 / resistanceOhm);
    near(detail.steady.currentA, 12 / resistanceOhm);
    assert.equal(state.omegaRadS, 0);
    return createProject({ state, trace: [snapshotTrace(initial), snapshotTrace(state)] });
  });
  assert.ok(experiments[0].state.currentA > 6);
  assert.deepEqual(parseProject(serializeProject(experiments[0])), experiments[0]);
  const malformed = structuredClone(experiments[2]);
  malformed.trace.splice(1, 0, { ...malformed.trace[1], timeS: dt / 2, currentA: 1.51 });
  assert.throws(() => parseProject(JSON.stringify(malformed)), error => error.code === 'INVALID_TRACE');
});

test('inertia changes launch speed and acceleration while settled conditions follow resistance', () => {
  const initial = inertiaKgM2 => createExperiment({ voltageV: 12, loadCoefficient: .0005, resistanceOhm: 4, inertiaKgM2 });
  const light = step(initial(.0001), .05).state;
  const heavy = step(initial(.002), .05).state;
  assert.ok(light.omegaRadS > heavy.omegaRadS * 10);
  for (const state of [light, heavy]) {
    const snapshot = instantSnapshot(state);
    const detail = motorDetail(state, snapshot);
    near(snapshot.storedEnergyJ.kinetic, .5 * state.settings.inertiaKgM2 * state.omegaRadS ** 2);
    near(detail.mechanical.accelerationRadS2, detail.mechanical.netNm / state.settings.inertiaKgM2);
    near(detail.power.residualW, 0);
    const settled = step(state, 3600).state;
    near(settled.omegaRadS, .04 * 12 / (4 * (.00002 + .0005) + .04 ** 2), 2e-7);
    near(instantSnapshot(settled).storedEnergyJ.total + settled.energyJ.copper + settled.energyJ.friction + settled.energyJ.load,
      settled.energyJ.supply, 1e-6);
  }
  assert.throws(() => reconfigureExperiment(light, { inertiaKgM2: .002 }), TypeError);
  assert.throws(() => reconfigureExperiment(light, { resistanceOhm: 2 }), TypeError);
});

test('custom settings handle nanosecond starts, current reversal, and signed shaft state', () => {
  const initial = createExperiment({ voltageV: 12, resistanceOhm: 1, inertiaKgM2: .0001 });
  const dt = 1e-9;
  const early = step(initial, dt).state;
  near(early.currentA / dt, 12 / .004, .001);
  near(early.omegaRadS / dt ** 2, .04 * 12 / (2 * .0001 * .004), .051);

  const moving = step(initial, 2).state;
  const generating = step(reconfigureExperiment(moving, { voltageV: 1 }), .01);
  assert.ok(generating.state.currentA < 0 && generating.state.omegaRadS > 0);
  assert.ok(generating.interval.deltaEnergyJ.supply < 0);
  assert.ok(generating.interval.deltaEnergyJ.copper > 0);

  const reversed = { ...initial, timeS: 1, omegaRadS: -1e-6,
    energyJ: { ...initial.energyJ, supply: .5 * initial.settings.inertiaKgM2 * 1e-12 } };
  assert.equal(instantSnapshot(reversed).backEmfV, -4e-8);
  assert.ok(step(reversed, .01).state.omegaRadS > 0);
});

test('legacy projects and comparisons resolve nominal hardware without changing their saved state', () => {
  const initial = createExperiment({ voltageV: 12 }, { locked: true });
  const state = step(initial, .002).state;
  const legacy = createProject({ state, trace: [snapshotTrace(initial), snapshotTrace(state)],
    comparison: { label: '기준', state, trace: [snapshotTrace(state)] } });
  assert.deepEqual(legacy.state.settings, { voltageV: 12, loadCoefficient: 0 });
  const restored = parseProject(JSON.stringify(legacy));
  assert.deepEqual(restored, legacy);
  for (const saved of [restored.state, restored.comparison.state]) {
    const snapshot = instantSnapshot(saved);
    assert.equal(snapshot.resistanceOhm, 2);
    assert.equal(snapshot.inertiaKgM2, .0004);
    assert.deepEqual(step(saved, .01), step(state, .01));
  }
});

test('custom motor settings and pinned comparisons resume exactly and reject corrupt values', () => {
  const custom = step(createExperiment({ resistanceOhm: 3.125, inertiaKgM2: .0013 }), .12).state;
  const baseline = step(createExperiment({ resistanceOhm: 7, inertiaKgM2: .0001 }), .12).state;
  const project = createProject({ state: custom, comparison: { label: '기준', state: baseline, trace: [snapshotTrace(baseline)] } });
  const restored = parseProject(serializeProject(project));
  assert.deepEqual(restored, project);
  assert.deepEqual(step(restored.state, .1), step(custom, .1));
  assert.deepEqual(step(restored.comparison.state, .1), step(baseline, .1));

  for (const [key, value] of [['resistanceOhm', null], ['resistanceOhm', .99], ['resistanceOhm', 8.1],
    ['inertiaKgM2', .000099], ['inertiaKgM2', .0021], ['inertiaKgM2', '.001']]) {
    for (const compared of [false, true]) {
      const raw = structuredClone(project);
      (compared ? raw.comparison.state : raw.state).settings[key] = value;
      assert.throws(() => parseProject(JSON.stringify(raw)), error => error.code === 'INVALID_STATE');
    }
  }
});
