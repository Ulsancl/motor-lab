import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_VERSION, MOTOR_CONSTANTS_SI, DEFAULT_SETTINGS, SETTINGS_LIMITS_SI,
  STATE_LIMITS_SI, MAX_STEP_SECONDS, MAX_SIMULATION_TIME_S, MAX_STORED_ENERGY_J,
  normalizeSettings, createExperiment, reconfigureExperiment, assertValidState,
  instantSnapshot, step,
} from '../src/model.js';

const { resistanceOhm: R, inductanceH: L, inertiaKgM2: J, frictionCoefficient: B,
  torqueConstantNmPerA: K } = MOTOR_CONSTANTS_SI;
const TAU = Math.PI * 2;
const energyKeys = ['supply', 'copper', 'friction', 'load'];
function near(actual, expected, abs = 1e-10, rel = 1e-10, label = '') {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: nonfinite`);
  assert.ok(Math.abs(actual - expected) <= abs + rel * Math.max(Math.abs(actual), Math.abs(expected)), `${label}: ${actual} != ${expected}`);
}
function phaseNear(actual, expected, tolerance = 1e-8) {
  const delta = Math.abs(actual - expected) % TAU;
  assert.ok(Math.min(delta, TAU - delta) <= tolerance, `phase ${actual} != ${expected}`);
}
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function energyBalance(state, abs = 1e-8, rel = 5e-11) {
  const storage = 0.5 * L * state.currentA ** 2 + 0.5 * J * state.omegaRadS ** 2;
  near(state.energyJ.supply, storage + state.energyJ.copper + state.energyJ.friction + state.energyJ.load, abs, rel, 'energy balance');
}
function compareStates(actual, expected, tolerance = 1e-8) {
  assert.deepEqual(actual.settings, expected.settings);
  assert.equal(actual.locked, expected.locked);
  near(actual.timeS, expected.timeS, tolerance);
  near(actual.currentA, expected.currentA, tolerance);
  near(actual.omegaRadS, expected.omegaRadS, tolerance);
  phaseNear(actual.angleRad, expected.angleRad, tolerance * 10);
  for (const key of energyKeys) near(actual.energyJ[key], expected.energyJ[key], tolerance, 5e-10, key);
}

// Independent scalar RL integrals. Series prevent cancellation at tiny time.
function lockedOracle(voltage, time) {
  const equilibrium = voltage / R;
  const x = R / L * time;
  let chargeFactor;
  let squareFactor;
  if (x < 0.1) {
    chargeFactor = 0;
    squareFactor = 0;
    let power = 1;
    let factorial = 1;
    for (let n = 1; n <= 30; n++) {
      power *= x;
      factorial *= n + 1;
      chargeFactor += (n % 2 ? 1 : -1) * power / factorial;
      if (n >= 2) squareFactor += (n % 2 ? -1 : 1) * (2 ** n - 2) * power / factorial;
    }
  } else {
    chargeFactor = 1 + Math.expm1(-x) / x;
    squareFactor = 1 + 2 * Math.expm1(-x) / x - Math.expm1(-2 * x) / (2 * x);
  }
  return {
    currentA: equilibrium * -Math.expm1(-x),
    supply: voltage * equilibrium * time * chargeFactor,
    copper: R * equilibrium ** 2 * time * squareFactor,
  };
}

// Independent 2-mode closed form for the free motor, not the production
// matrix exponential or an energy-balance residual.
function freeOracle(state, time) {
  const { voltageV: v, loadCoefficient: load } = state.settings;
  const damping = B + load;
  const omegaInf = K * v / (K * K + R * damping);
  const currentInf = damping * omegaInf / K;
  const a = R / L;
  const e = damping / J;
  const root = Math.sqrt(((a - e) / 2) ** 2 - K * K / (L * J));
  const fast = -(a + e) / 2 - root;
  const slow = ((R * damping + K * K) / (L * J)) / fast;
  const exponentialIntegral = lambda => Math.expm1(lambda * time) / lambda;
  const scalar = (initial, equilibrium, initialDerivative) => {
    const offset = initial - equilibrium;
    const cs = (initialDerivative - fast * offset) / (slow - fast);
    const cf = offset - cs;
    const integral = equilibrium * time + cs * exponentialIntegral(slow) + cf * exponentialIntegral(fast);
    const squareIntegral = equilibrium ** 2 * time +
      2 * equilibrium * (cs * exponentialIntegral(slow) + cf * exponentialIntegral(fast)) +
      cs ** 2 * exponentialIntegral(2 * slow) + cf ** 2 * exponentialIntegral(2 * fast) +
      2 * cs * cf * exponentialIntegral(slow + fast);
    return { final: equilibrium + cs * Math.exp(slow * time) + cf * Math.exp(fast * time), integral, squareIntegral };
  };
  const current = scalar(state.currentA, currentInf, (v - R * state.currentA - K * state.omegaRadS) / L);
  const omega = scalar(state.omegaRadS, omegaInf, (K * state.currentA - damping * state.omegaRadS) / J);
  return {
    currentA: current.final,
    omegaRadS: omega.final,
    angleDeltaRad: omega.integral,
    deltaEnergyJ: { supply: v * current.integral, copper: R * current.squareIntegral,
      friction: B * omega.squareIntegral, load: load * omega.squareIntegral },
  };
}

test('SI constants and public bounds are fixed, and Kt equals Ke', () => {
  assert.equal(MODEL_VERSION, 'motor-dc-average-1');
  assert.deepEqual(MOTOR_CONSTANTS_SI, { resistanceOhm: 2, inductanceH: 0.004,
    torqueConstantNmPerA: 0.04, backEmfConstantVsPerRad: 0.04, inertiaKgM2: 0.0004, frictionCoefficient: 0.00002 });
  assert.equal(MAX_STEP_SECONDS, 3600);
  assert.equal(MAX_SIMULATION_TIME_S, 1e6);
  assert.equal(MAX_STORED_ENERGY_J, 360);
  near(0.5 * L * STATE_LIMITS_SI.currentA.max ** 2, 360);
  near(0.5 * J * STATE_LIMITS_SI.omegaRadS.max ** 2, 360);
  assert.equal(STATE_LIMITS_SI.angleRad.max, TAU);
  assert.ok(Object.isFrozen(MOTOR_CONSTANTS_SI) && Object.isFrozen(SETTINGS_LIMITS_SI.voltageV));
});

test('live normalization clamps only settings and starts from rest', () => {
  assert.deepEqual(normalizeSettings({ voltageV: 500, loadCoefficient: -1 }), { voltageV: 12, loadCoefficient: 0 });
  assert.deepEqual(normalizeSettings({ voltageV: '12', loadCoefficient: Infinity }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ voltageV: -0, loadCoefficient: NaN }), { voltageV: 0, loadCoefficient: 0 });
  const state = createExperiment({ voltageV: 12, loadCoefficient: 0.001 }, { locked: true, angleRad: -Math.PI / 2 });
  assert.equal(state.angleRad, 3 * Math.PI / 2);
  assert.equal(state.currentA, 0);
  assert.equal(state.omegaRadS, 0);
  assert.equal(state.timeS, 0);
  assert.deepEqual(state.energyJ, { supply: 0, copper: 0, friction: 0, load: 0 });
  assert.equal(assertValidState(state), state);
  assertValidState(createExperiment({}, { angleRad: -1e-30 }));
  for (const options of [{ locked: 1 }, { angleRad: NaN }, { unknown: 1 }, null]) assert.throws(() => createExperiment({}, options), TypeError);
});

test('zero volts from rest remain exactly at rest through a one-hour step', () => {
  for (const locked of [false, true]) {
    const original = createExperiment({ voltageV: 0, loadCoefficient: 0.001 }, { locked, angleRad: 1.23 });
    const result = step(original, 3600);
    assert.deepEqual(result.state, { ...original, timeS: 3600 });
    assert.deepEqual(result.interval.deltaEnergyJ, original.energyJ);
    assert.equal(result.interval.angleDeltaRad, 0);
  }
});

test('locked-shaft RL current and both separate energy integrals match analytic series and long-time formulas', () => {
  for (const voltage of [0.3, 6, 12]) {
    for (const time of [1e-9, 1e-6, 0.0005, 0.002, 0.01, 1, 3600]) {
      const result = step(createExperiment({ voltageV: voltage }, { locked: true }), time);
      const oracle = lockedOracle(voltage, time);
      near(result.state.currentA, oracle.currentA, 1e-14, 5e-11, `RL ${time}`);
      near(result.interval.deltaEnergyJ.supply, oracle.supply, 1e-30, 2e-10, `supply ${time}`);
      near(result.interval.deltaEnergyJ.copper, oracle.copper, 1e-30, 2e-10, `copper ${time}`);
      assert.equal(result.state.omegaRadS, 0);
      assert.equal(result.interval.angleDeltaRad, 0);
      assert.equal(result.interval.deltaEnergyJ.friction, 0);
      assert.equal(result.interval.deltaEnergyJ.load, 0);
      energyBalance(result.state);
    }
  }
});

test('free motor endpoints, angle and all energy integrals match independent two-exponential solutions', () => {
  for (const voltage of [0.1, 6, 12]) {
    for (const load of [0, 0.0005, 0.001]) {
      for (const time of [0.01, 0.25, 3, 3600]) {
        const state = createExperiment({ voltageV: voltage, loadCoefficient: load });
        const actual = step(state, time);
        const oracle = freeOracle(state, time);
        near(actual.state.currentA, oracle.currentA, 1e-10, 2e-10, 'current');
        near(actual.state.omegaRadS, oracle.omegaRadS, 1e-9, 2e-10, 'omega');
        near(actual.interval.angleDeltaRad, oracle.angleDeltaRad, 1e-8, 2e-10, 'angle integral');
        for (const key of energyKeys) near(actual.interval.deltaEnergyJ[key], oracle.deltaEnergyJ[key], 5e-9, 2e-10, key);
        energyBalance(actual.state);
      }
    }
  }
});

test('free steady state obeys independent circuit and torque equations across loads', () => {
  let previousSpeed = Infinity;
  let previousCurrent = -Infinity;
  for (const load of [0, 0.0005, 0.001]) {
    const state = step(createExperiment({ voltageV: 12, loadCoefficient: load }), 30).state;
    const omega = K * 12 / (K ** 2 + R * (B + load));
    const current = (12 - K * omega) / R;
    near(state.omegaRadS, omega, 1e-8);
    near(state.currentA, current);
    near(K * state.currentA, (B + load) * state.omegaRadS);
    assert.ok(state.omegaRadS < previousSpeed);
    assert.ok(state.currentA > previousCurrent);
    previousSpeed = state.omegaRadS;
    previousCurrent = state.currentA;
  }
});

test('locked steady state has 6 A, 72 W copper loss and a balancing constraint torque', () => {
  const snapshot = instantSnapshot(step(createExperiment({ voltageV: 12, loadCoefficient: 0.001 }, { locked: true }), 1).state);
  near(snapshot.currentA, 6);
  near(snapshot.powerW.copper, 72);
  near(snapshot.powerW.supply, 72);
  near(snapshot.torqueNm, 0.24);
  near(snapshot.constraintTorqueNm, -0.24);
  assert.equal(snapshot.powerW.electromagnetic, 0);
  assert.equal(snapshot.powerW.load, 0);
  assert.equal(snapshot.rpm, 0);
});

test('reconfiguration retains time, magnetic and kinetic state, phase, and cumulative history exactly', () => {
  const state = freezeDeep(step(createExperiment(), 0.25).state);
  const before = structuredClone(state);
  const changed = reconfigureExperiment(state, { voltageV: 12, loadCoefficient: 0.0005 });
  assert.deepEqual(changed, { ...before, settings: { voltageV: 12, loadCoefficient: 0.0005 } });
  assert.notEqual(changed.energyJ, state.energyJ);
  assert.deepEqual(state, before);
  for (const patch of [{ locked: true }, { voltageV: 13 }, { voltageV: '6' }, { loadCoefficient: NaN }, null]) {
    assert.throws(() => reconfigureExperiment(state, patch), error => error instanceof TypeError || error instanceof RangeError);
    assert.deepEqual(state, before);
  }
});

test('voltage reduction keeps negative current and signed returned supply energy', () => {
  const moving = step(createExperiment({ voltageV: 12 }), 10).state;
  const reduced = reconfigureExperiment(moving, { voltageV: 3 });
  const result = step(reduced, 0.02);
  const oracle = freeOracle(reduced, 0.02);
  assert.ok(result.state.currentA < -3);
  assert.ok(result.interval.deltaEnergyJ.supply < 0);
  assert.ok(result.state.energyJ.supply < moving.energyJ.supply);
  assert.ok(instantSnapshot(result.state).powerW.supply < 0);
  for (const key of energyKeys) near(result.interval.deltaEnergyJ[key], oracle.deltaEnergyJ[key], 1e-9, 1e-9, key);
  near(result.state.currentA, oracle.currentA);
  near(result.state.omegaRadS, oracle.omegaRadS);
  energyBalance(result.state);
});

test('zero-voltage braking is a short: inertia persists and stored energy becomes independently integrated losses', () => {
  const moving = step(createExperiment({ voltageV: 12 }), 10).state;
  const zeroVoltage = reconfigureExperiment(moving, { voltageV: 0 });
  const result = step(zeroVoltage, 0.03);
  const beforeEnergy = instantSnapshot(moving).storedEnergyJ.total;
  const after = instantSnapshot(result.state);
  assert.ok(result.state.currentA < 0 && result.state.omegaRadS > 0);
  assert.ok(result.state.omegaRadS < moving.omegaRadS);
  assert.equal(result.interval.deltaEnergyJ.supply, 0);
  assert.ok(after.storedEnergyJ.total < beforeEnergy);
  near(beforeEnergy - after.storedEnergyJ.total,
    result.interval.deltaEnergyJ.copper + result.interval.deltaEnergyJ.friction + result.interval.deltaEnergyJ.load, 1e-9);
  energyBalance(result.state);
  const stopped = step(zeroVoltage, 3600).state;
  assert.equal(stopped.currentA, 0);
  assert.equal(stopped.omegaRadS, 0);
  assert.equal(stopped.energyJ.supply, moving.energyJ.supply);
  energyBalance(stopped);
});

test('load added during motion changes acceleration without restarting the transient', () => {
  const moving = step(createExperiment({ voltageV: 12 }), 10).state;
  const loaded = reconfigureExperiment(moving, { loadCoefficient: 0.0005 });
  assert.equal(loaded.omegaRadS, moving.omegaRadS);
  const early = step(loaded, 0.0005).state;
  assert.ok(early.omegaRadS < loaded.omegaRadS);
  assert.ok(early.currentA > loaded.currentA);
  const settled = step(loaded, 10).state;
  near(settled.omegaRadS, K * 12 / (K ** 2 + R * (B + 0.0005)), 1e-7);
  assert.ok(settled.energyJ.load > 0);
  energyBalance(settled);
});

test('nanosecond startup remains resolved without fixed substeps or cancellation', () => {
  const result = step(createExperiment({ voltageV: 12 }), 1e-9);
  near(result.state.currentA, 12 / L * 1e-9, 0, 3e-7);
  near(result.state.omegaRadS, 0.5 * K / J * 12 / L * 1e-18, 0, 3e-7);
  near(result.interval.angleDeltaRad, K / J * 12 / L * 1e-27 / 6, 0, 3e-7);
  assert.ok(result.interval.deltaEnergyJ.copper > 0);
  assert.ok(result.interval.deltaEnergyJ.friction > 0);
  energyBalance(result.state, 1e-27, 1e-10);
});

test('one hour matches irregularly partitioned elapsed time and independently accumulated angle', () => {
  const initial = createExperiment({ voltageV: 12, loadCoefficient: 0.0005 }, { angleRad: 6.1 });
  const one = step(initial, 3600);
  let state = initial;
  let angle = 0;
  for (const dt of [1e-9, 1e-6, 0.0005, 0.0015, 0.013, 0.2, 1, 30, 300, 600, 1000]) {
    const result = step(state, dt);
    state = result.state;
    angle += result.interval.angleDeltaRad;
  }
  const last = step(state, 3600 - state.timeS);
  state = last.state;
  angle += last.interval.angleDeltaRad;
  compareStates(state, one.state, 5e-7);
  near(angle, one.interval.angleDeltaRad, 1e-6, 1e-10);
});

test('settings timeline has the same final state for coarse versus 5000 small steps', () => {
  const segments = [{ dt: 0.7, patch: { voltageV: 12 } }, { dt: 0.8, patch: { loadCoefficient: 0.0005 } },
    { dt: 0.2, patch: { voltageV: 3 } }, { dt: 0.3, patch: { voltageV: 0 } }];
  let coarse = createExperiment();
  let fine = createExperiment();
  for (const segment of segments) {
    coarse = reconfigureExperiment(coarse, segment.patch);
    fine = reconfigureExperiment(fine, segment.patch);
    coarse = step(coarse, segment.dt).state;
    const count = Math.round(segment.dt / 0.0004);
    for (let i = 0; i < count; i++) fine = step(fine, segment.dt / count).state;
  }
  compareStates(fine, coarse, 2e-8);
  energyBalance(fine);
});

test('snapshot powers reflect derivatives and signed electromechanical conversion without efficiency fiction', () => {
  let state = step(createExperiment({ voltageV: 12 }), 2).state;
  state = step(reconfigureExperiment(state, { voltageV: 3, loadCoefficient: 0.0005 }), 0.01).state;
  const snapshot = instantSnapshot(state);
  assert.equal(snapshot.backEmfV, K * state.omegaRadS);
  assert.equal(snapshot.torqueNm, K * state.currentA);
  assert.equal(snapshot.loadTorqueNm, 0.0005 * state.omegaRadS);
  near(snapshot.powerW.supply - snapshot.powerW.copper - snapshot.powerW.friction - snapshot.powerW.load, snapshot.powerW.storageRate, 1e-12);
  near(snapshot.powerW.electromagnetic, snapshot.backEmfV * state.currentA, 1e-12);
  assert.equal(snapshot.constraintTorqueNm, 0);
  assert.ok(!('efficiency' in snapshot));
  snapshot.energyJ.supply = 999;
  assert.notEqual(state.energyJ.supply, 999);
});

test('phase wraps, full angle increment is retained, and zero-duration output is an independent exact clone', () => {
  const start = createExperiment({ voltageV: 12 }, { angleRad: TAU - 1e-3 });
  const moving = step(start, 0.5);
  assert.ok(moving.interval.angleDeltaRad > TAU);
  assert.ok(moving.state.angleRad >= 0 && moving.state.angleRad < TAU);
  phaseNear(moving.state.angleRad, (start.angleRad + moving.interval.angleDeltaRad) % TAU);
  const unchanged = step(freezeDeep(moving.state), 0);
  assert.deepEqual(unchanged.state, moving.state);
  assert.notEqual(unchanged.state, moving.state);
  assert.notEqual(unchanged.state.settings, moving.state.settings);
  assert.notEqual(unchanged.state.energyJ, moving.state.energyJ);
  assert.deepEqual(unchanged.interval, { durationS: 0, angleDeltaRad: 0, deltaEnergyJ: { supply: 0, copper: 0, friction: 0, load: 0 } });
});

test('step and snapshot do not mutate frozen caller objects', () => {
  const state = freezeDeep(step(createExperiment(), 0.02).state);
  const before = JSON.stringify(state);
  const result = step(state, 0.03);
  instantSnapshot(state);
  assert.equal(JSON.stringify(state), before);
  result.state.settings.voltageV = 0;
  result.state.energyJ.load = 25;
  assert.equal(JSON.stringify(state), before);
});

test('strict state validation rejects malformed scalars, unknown keys and physically inconsistent energy', () => {
  const valid = step(createExperiment(), 0.1).state;
  const mutations = [
    s => { s.extra = 1; }, s => { delete s.angleRad; }, s => { s.modelVersion = 'future'; },
    s => { s.settings.voltageV = '6'; }, s => { s.settings.loadCoefficient = 0.002; }, s => { s.settings.extra = 0; },
    s => { s.locked = 'false'; }, s => { s.timeS = -1; }, s => { s.timeS = Infinity; },
    s => { s.currentA = NaN; }, s => { s.omegaRadS = Infinity; }, s => { s.angleRad = TAU; },
    s => { s.angleRad = -0; }, s => { s.energyJ.copper = -1; }, s => { s.energyJ.supply += 0.1; },
    s => { s.energyJ.friction = NaN; }, s => { s.energyJ.extra = 0; }, s => { s.timeS = 0; },
    s => { s.locked = true; }, s => { s.currentA = STATE_LIMITS_SI.currentA.max + 1; },
    s => { s.omegaRadS = STATE_LIMITS_SI.omegaRadS.max + 1; },
    s => { s.currentA = STATE_LIMITS_SI.currentA.max; s.energyJ.supply += 360; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    const before = structuredClone(invalid);
    assert.throws(() => assertValidState(invalid), error => error instanceof TypeError || error instanceof RangeError);
    assert.deepEqual(invalid, before);
  }
  for (const invalid of [null, [], 1, 'state']) assert.throws(() => assertValidState(invalid), TypeError);
  assert.equal(assertValidState(valid), valid);
});

test('locked state validation rejects impossible mechanical history and over-limit current', () => {
  const valid = step(createExperiment({ voltageV: 12 }, { locked: true }), 0.01).state;
  for (const mutate of [s => { s.omegaRadS = 1; }, s => { s.energyJ.load = 1; },
    s => { s.energyJ.friction = 1; }, s => { s.currentA = -s.currentA; },
    s => { s.currentA = 6.001; s.energyJ.supply = 0.5 * L * s.currentA ** 2 + s.energyJ.copper; }]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => assertValidState(invalid), RangeError);
  }
});

test('invalid time steps fail atomically and the total time budget accepts its exact endpoint', () => {
  const state = freezeDeep(createExperiment());
  for (const dt of [-1, -0, Infinity, NaN, '0.1', 3600.001]) assert.throws(() => step(state, dt), error => error instanceof TypeError || error instanceof RangeError);
  // An unpowered rest history is an exact valid way to reach the boundary.
  const end = { ...createExperiment({ voltageV: 0 }), timeS: MAX_SIMULATION_TIME_S - 1 };
  const endpoint = step(end, 1).state;
  assert.equal(endpoint.timeS, MAX_SIMULATION_TIME_S);
  assertValidState(endpoint);
  assert.throws(() => step(endpoint, 1e-3), RangeError);
  assert.throws(() => step(end, Number.EPSILON), RangeError);
  assert.deepEqual(state, createExperiment());
});

test('maximum cumulative duration stays finite and conserves independently accumulated energies', () => {
  let state = createExperiment({ voltageV: 12, loadCoefficient: 0.001 });
  while (state.timeS < MAX_SIMULATION_TIME_S) state = step(state, Math.min(3600, MAX_SIMULATION_TIME_S - state.timeS)).state;
  assert.equal(state.timeS, MAX_SIMULATION_TIME_S);
  assertValidState(state);
  energyBalance(state);
  const power = instantSnapshot(state).powerW;
  near(power.supply, power.copper + power.friction + power.load, 1e-8);
});

test('transition cache remains correct across more distinct entries than its bound and locked/free settings', () => {
  for (let index = 0; index < 150; index++) {
    const state = createExperiment({ voltageV: 12 * (index + 1) / 151, loadCoefficient: 0.001 * index / 150 });
    const time = 0.02 + index / 1000;
    const actual = step(state, time);
    const oracle = freeOracle(state, time);
    near(actual.state.currentA, oracle.currentA, 1e-10);
    near(actual.state.omegaRadS, oracle.omegaRadS, 1e-9);
    near(actual.interval.deltaEnergyJ.copper, oracle.deltaEnergyJ.copper, 1e-9);
  }
  const settings = { voltageV: 12, loadCoefficient: 0.0005 };
  assert.equal(step(createExperiment(settings, { locked: true }), 0.1).state.omegaRadS, 0);
  assert.ok(step(createExperiment(settings), 0.1).state.omegaRadS > 0);
});

test('many voltage/load changes spanning short RL and long intervals retain nonnegative losses and signed balance', () => {
  let seed = 231791;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  let state = createExperiment();
  let returnedEnergyIntervals = 0;
  for (let index = 0; index < 1200; index++) {
    state = reconfigureExperiment(state, { voltageV: index % 3 === 0 ? 0 : 12 * random(),
      loadCoefficient: index % 5 === 0 ? 0 : 0.001 * random() });
    const result = step(state, 10 ** (-8 + 11 * random()));
    for (const key of ['copper', 'friction', 'load']) assert.ok(result.interval.deltaEnergyJ[key] >= 0, key);
    if (result.interval.deltaEnergyJ.supply < 0) returnedEnergyIntervals++;
    state = result.state;
    energyBalance(state);
  }
  assert.ok(returnedEnergyIntervals > 10);
  assert.ok(state.timeS > 40000);
});
