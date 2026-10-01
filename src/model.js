// SI, average permanent-magnet DC motor. This module has no rendering or I/O.
export const MODEL_VERSION = 'motor-dc-average-1';
const K = 0.04;
export const MOTOR_CONSTANTS_SI = Object.freeze({
  resistanceOhm: 2,
  inductanceH: 0.004,
  torqueConstantNmPerA: K,
  backEmfConstantVsPerRad: K,
  inertiaKgM2: 0.0004,
  frictionCoefficient: 0.00002,
});
const { resistanceOhm: R, inductanceH: L, inertiaKgM2: J, frictionCoefficient: B } = MOTOR_CONSTANTS_SI;
const TAU = 2 * Math.PI;
export const MAX_STEP_SECONDS = 3600;
export const MAX_SIMULATION_TIME_S = 1e6;
// Conservative energy bound from E' <= 36 - 0.1 E, not a motor rating.
export const MAX_STORED_ENERGY_J = 360;
export const DEFAULT_SETTINGS = Object.freeze({ voltageV: 6, loadCoefficient: 0 });
export const SETTINGS_LIMITS_SI = Object.freeze({
  voltageV: Object.freeze({ min: 0, max: 12 }),
  loadCoefficient: Object.freeze({ min: 0, max: 0.001 }),
});
export const STATE_LIMITS_SI = Object.freeze({
  currentA: Object.freeze({ min: -Math.sqrt(2 * MAX_STORED_ENERGY_J / L), max: Math.sqrt(2 * MAX_STORED_ENERGY_J / L) }),
  omegaRadS: Object.freeze({ min: -Math.sqrt(2 * MAX_STORED_ENERGY_J / J), max: Math.sqrt(2 * MAX_STORED_ENERGY_J / J) }),
  angleRad: Object.freeze({ min: 0, max: TAU }), // max excluded
});
const SETTINGS_KEYS = ['voltageV', 'loadCoefficient'];
const ENERGY_KEYS = ['supply', 'copper', 'friction', 'load'];
const STATE_KEYS = ['modelVersion', 'settings', 'locked', 'timeS', 'currentA', 'omegaRadS', 'angleRad', 'energyJ'];
const zero = value => Object.is(value, -0) ? 0 : value;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const energyTolerance = scale => 1e-8 + 5e-11 * Math.max(1, scale);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label}: an object is required`);
}

function exactKeys(value, expected, label) {
  record(value, label);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new TypeError(`${label}: missing or unknown field`);
}

function numberIn(value, min, max, label, exclusiveMax = false) {
  if (!finite(value) || Object.is(value, -0)) throw new TypeError(`${label}: a finite canonical number is required`);
  if (value < min || (exclusiveMax ? value >= max : value > max)) throw new RangeError(`${label}: outside supported range`);
}

function validSettings(value) {
  exactKeys(value, SETTINGS_KEYS, 'settings');
  for (const key of SETTINGS_KEYS) numberIn(value[key], SETTINGS_LIMITS_SI[key].min, SETTINGS_LIMITS_SI[key].max, `settings.${key}`);
}

function wrapPhase(value) {
  const remainder = value % TAU;
  const phase = remainder < 0 ? remainder + TAU : remainder;
  return phase >= TAU ? 0 : zero(phase);
}

function cloneState(state) {
  return { ...state, settings: { ...state.settings }, energyJ: { ...state.energyJ } };
}

function storedEnergy(state) {
  const magnetic = 0.5 * L * state.currentA ** 2;
  const kinetic = 0.5 * J * state.omegaRadS ** 2;
  return { magnetic, kinetic, total: magnetic + kinetic };
}

/** Normalization is only for creating live experiments, never for saved input. */
export function normalizeSettings(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(SETTINGS_KEYS.map(key => {
    const { min, max } = SETTINGS_LIMITS_SI[key];
    return [key, zero(finite(input[key]) ? Math.min(max, Math.max(min, input[key])) : DEFAULT_SETTINGS[key])];
  }));
}

export function createExperiment(settings = DEFAULT_SETTINGS, options = {}) {
  record(options, 'options');
  if (Object.keys(options).some(key => !['locked', 'angleRad'].includes(key))) throw new TypeError('options: unknown field');
  if (options.locked !== undefined && typeof options.locked !== 'boolean') throw new TypeError('options.locked: a boolean is required');
  if (options.angleRad !== undefined && !finite(options.angleRad)) throw new TypeError('options.angleRad: a finite number is required');
  return {
    modelVersion: MODEL_VERSION,
    settings: normalizeSettings(settings),
    locked: options.locked ?? false,
    timeS: 0,
    currentA: 0,
    omegaRadS: 0,
    angleRad: wrapPhase(options.angleRad ?? 0),
    energyJ: { supply: 0, copper: 0, friction: 0, load: 0 },
  };
}

/** Validate without changing values. This checks consistency, not input history. */
export function assertValidState(state) {
  exactKeys(state, STATE_KEYS, 'state');
  if (state.modelVersion !== MODEL_VERSION) throw new RangeError('state.modelVersion: unsupported model');
  validSettings(state.settings);
  if (typeof state.locked !== 'boolean') throw new TypeError('state.locked: a boolean is required');
  numberIn(state.timeS, 0, MAX_SIMULATION_TIME_S, 'state.timeS');
  for (const key of ['currentA', 'omegaRadS']) numberIn(state[key], STATE_LIMITS_SI[key].min, STATE_LIMITS_SI[key].max, `state.${key}`);
  numberIn(state.angleRad, 0, TAU, 'state.angleRad', true);
  exactKeys(state.energyJ, ENERGY_KEYS, 'state.energyJ');
  for (const key of ENERGY_KEYS) {
    if (!finite(state.energyJ[key]) || Object.is(state.energyJ[key], -0)) throw new TypeError(`energyJ.${key}: a finite canonical number is required`);
    if (key !== 'supply' && state.energyJ[key] < 0) throw new RangeError(`energyJ.${key}: losses cannot be negative`);
  }
  const stored = storedEnergy(state).total;
  const losses = state.energyJ.copper + state.energyJ.friction + state.energyJ.load;
  const inputBound = SETTINGS_LIMITS_SI.voltageV.max * STATE_LIMITS_SI.currentA.max * state.timeS;
  const scale = Math.max(Math.abs(state.energyJ.supply), losses, stored);
  const tolerance = energyTolerance(scale);
  if (!Number.isFinite(losses) || stored > MAX_STORED_ENERGY_J + energyTolerance(MAX_STORED_ENERGY_J)) throw new RangeError('state: stored energy exceeds supported bound');
  if (Math.abs(state.energyJ.supply) > inputBound + tolerance || losses > inputBound + tolerance) throw new RangeError('state: accumulated energy exceeds time/input bound');
  if (Math.abs(state.energyJ.supply - losses - stored) > tolerance) throw new RangeError('state: cumulative energy does not balance stored energy and losses');
  if (state.timeS === 0 && (state.currentA !== 0 || state.omegaRadS !== 0 || ENERGY_KEYS.some(key => state.energyJ[key] !== 0))) throw new RangeError('state: an experiment starts from rest with zero energy');
  if (state.locked && (state.omegaRadS !== 0 || state.currentA < 0 || state.currentA > 6 + 5e-10 || state.energyJ.friction !== 0 || state.energyJ.load !== 0)) throw new RangeError('state: inconsistent locked shaft');
  return state;
}

/** Voltage/load edits retain the transient and every accumulated quantity. */
export function reconfigureExperiment(state, patch) {
  assertValidState(state);
  record(patch, 'patch');
  if (Object.keys(patch).some(key => !SETTINGS_KEYS.includes(key))) throw new TypeError('patch: only voltageV and loadCoefficient may change');
  const settings = { ...state.settings, ...patch };
  validSettings(settings);
  return { ...cloneState(state), settings };
}

export function instantSnapshot(state) {
  assertValidState(state);
  const { currentA: i, omegaRadS: w, settings: { voltageV: voltage, loadCoefficient: load } } = state;
  const di = (voltage - R * i - K * w) / L;
  const dw = state.locked ? 0 : (K * i - (B + load) * w) / J;
  return {
    timeS: state.timeS,
    angleRad: state.angleRad,
    omegaRadS: w,
    currentA: i,
    voltageV: voltage,
    backEmfV: zero(K * w),
    torqueNm: zero(K * i),
    loadTorqueNm: zero(load * w),
    loadCoefficient: load,
    locked: state.locked,
    rpm: zero(w * 60 / TAU),
    constraintTorqueNm: state.locked ? zero(-K * i) : 0,
    powerW: {
      supply: zero(voltage * i),
      copper: R * i * i,
      friction: B * w * w,
      load: load * w * w,
      electromagnetic: zero(K * i * w),
      storageRate: zero(L * i * di + J * w * dw),
    },
    storedEnergyJ: storedEnergy(state),
    energyJ: { ...state.energyJ },
  };
}

// Exact constant-coefficient moment system:
// z = [1, i, w, i², iw, w², integral(i), integral(w), integral(i²), integral(w²)].
// Integrals are evaluated independently; no energy is a residual of another.
const N = 10;
// Dimensionless coordinates keep electrical and mechanical moment magnitudes
// comparable during repeated squaring (6 A / 300 rad/s nominal scales).
const CURRENT_SCALE = 6;
const SPEED_SCALE = 300;
const CACHE_LIMIT = 128;
const transitionCache = new Map();

function identity() {
  const result = new Float64Array(N * N);
  for (let i = 0; i < N; i++) result[i * N + i] = 1;
  return result;
}

function multiply(a, b) {
  const result = new Float64Array(N * N);
  for (let row = 0; row < N; row++) {
    for (let k = 0; k < N; k++) {
      const v = a[row * N + k];
      if (v === 0) continue;
      for (let col = 0; col < N; col++) result[row * N + col] += v * b[k * N + col];
    }
  }
  return result;
}

function synchronizeMoments(matrix) {
  // These rows are exact products of the affine current/speed transition.
  // Keeping this algebraic relation prevents independent squared-state rows
  // from drifting under squaring; energy-integral rows remain independent.
  const a = [matrix[10], matrix[11], matrix[12]];
  const b = [matrix[20], matrix[21], matrix[22]];
  const product = (row, x, y) => {
    matrix[row * N] = x[0] * y[0];
    matrix[row * N + 1] = x[0] * y[1] + x[1] * y[0];
    matrix[row * N + 2] = x[0] * y[2] + x[2] * y[0];
    matrix[row * N + 3] = x[1] * y[1];
    matrix[row * N + 4] = x[1] * y[2] + x[2] * y[1];
    matrix[row * N + 5] = x[2] * y[2];
  };
  product(3, a, a);
  product(4, a, b);
  product(5, b, b);
}

function transition(settings, locked, dt) {
  const key = `${settings.voltageV}|${settings.loadCoefficient}|${locked}|${dt}`;
  if (transitionCache.has(key)) {
    const hit = transitionCache.get(key);
    transitionCache.delete(key);
    transitionCache.set(key, hit);
    return hit;
  }
  const u = settings.voltageV / (L * CURRENT_SCALE);
  const a = R / L;
  const c = K * SPEED_SCALE / (L * CURRENT_SCALE);
  const d = locked ? 0 : K * CURRENT_SCALE / (J * SPEED_SCALE);
  const e = locked ? 0 : (B + settings.loadCoefficient) / J;
  const m = new Float64Array(N * N);
  const set = (row, col, value) => { m[row * N + col] = value * dt; };
  set(1, 0, u); set(1, 1, -a); set(1, 2, -c);
  set(2, 1, d); set(2, 2, -e);
  set(3, 1, 2 * u); set(3, 3, -2 * a); set(3, 4, -2 * c);
  set(4, 2, u); set(4, 3, d); set(4, 4, -(a + e)); set(4, 5, -c);
  set(5, 4, 2 * d); set(5, 5, -2 * e);
  set(6, 1, 1); set(7, 2, 1); set(8, 3, 1); set(9, 5, 1);
  let norm = 0;
  for (let col = 0; col < N; col++) {
    let sum = 0;
    for (let row = 0; row < N; row++) sum += Math.abs(m[row * N + col]);
    norm = Math.max(norm, sum);
  }
  // ||scaled M dt||_1 <= 1/4. Eighteen Taylor terms put truncation
  // below double precision; squaring spans milliseconds through an hour.
  const squarings = Math.max(0, Math.ceil(Math.log2(norm / 0.25)));
  const divisor = 2 ** squarings;
  for (let i = 0; i < m.length; i++) m[i] /= divisor;
  let result = identity();
  let term = identity();
  for (let k = 1; k <= 18; k++) {
    term = multiply(term, m);
    for (let i = 0; i < term.length; i++) {
      term[i] /= k;
      result[i] += term[i];
    }
  }
  synchronizeMoments(result);
  for (let k = 0; k < squarings; k++) {
    result = multiply(result, result);
    synchronizeMoments(result);
  }
  transitionCache.set(key, result);
  if (transitionCache.size > CACHE_LIMIT) transitionCache.delete(transitionCache.keys().next().value);
  return result;
}

export function step(state, dt) {
  assertValidState(state);
  numberIn(dt, 0, MAX_STEP_SECONDS, 'dt');
  const timeS = state.timeS + dt;
  if (timeS > MAX_SIMULATION_TIME_S || (dt > 0 && timeS === state.timeS)) throw new RangeError('dt: simulation time limit or numeric resolution exceeded');
  if (dt === 0) return { state: cloneState(state), interval: { durationS: 0, angleDeltaRad: 0, deltaEnergyJ: { supply: 0, copper: 0, friction: 0, load: 0 } } };
  const matrix = transition(state.settings, state.locked, dt);
  const i = state.currentA / CURRENT_SCALE;
  const w = state.omegaRadS / SPEED_SCALE;
  const initial = [1, i, w, i ** 2, i * w, w ** 2];
  const final = new Float64Array(N);
  for (let row = 1; row < N; row++) {
    for (let col = 0; col < initial.length; col++) final[row] += matrix[row * N + col] * initial[col];
  }
  const deltaEnergyJ = {
    supply: zero(state.settings.voltageV * CURRENT_SCALE * final[6]),
    copper: zero(R * CURRENT_SCALE ** 2 * final[8]),
    friction: zero(B * SPEED_SCALE ** 2 * final[9]),
    load: zero(state.settings.loadCoefficient * SPEED_SCALE ** 2 * final[9]),
  };
  const next = {
    ...state,
    settings: { ...state.settings },
    timeS,
    currentA: zero(CURRENT_SCALE * final[1]),
    omegaRadS: zero(SPEED_SCALE * final[2]),
    angleRad: wrapPhase(state.angleRad + SPEED_SCALE * final[7]),
    energyJ: Object.fromEntries(ENERGY_KEYS.map(key => [key, zero(state.energyJ[key] + deltaEnergyJ[key])])),
  };
  assertValidState(next);
  return { state: next, interval: { durationS: dt, angleDeltaRad: zero(SPEED_SCALE * final[7]), deltaEnergyJ } };
}
