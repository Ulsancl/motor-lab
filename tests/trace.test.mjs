import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, step, reconfigureExperiment } from '../src/model.js';
import { snapshotTrace, createProject, parseProject, serializeProject } from '../src/project.js';
import { appendTrace, advanceObservation } from '../src/trace.js';

test('graph samples retain electrical startup detail without changing the model endpoint', () => {
  const initial = createExperiment({ voltageV: 12 }, { locked: true });
  const original = structuredClone(initial), trace = [snapshotTrace(initial)];
  const result = advanceObservation(initial, trace, .1, 0);
  assert.deepEqual(result.state, step(initial, .1).state);
  assert.deepEqual(initial, original); assert.equal(trace.length, 1);
  const sample = result.trace.find(point => Math.abs(point.timeS - .002) < 1e-12);
  assert.ok(sample); assert.ok(Math.abs(sample.currentA - 6 * (1 - Math.exp(-1))) < 1e-10);
  assert.deepEqual(result.trace.at(-1), snapshotTrace(result.state));
  parseProject(serializeProject(createProject({ state: result.state, trace: result.trace })));
});

test('an input change at the same time updates the graph sample without inventing a time interval', () => {
  const before = step(createExperiment(), .5).state;
  const trace = [snapshotTrace(before)], after = reconfigureExperiment(before, { voltageV: 0 });
  const updated = appendTrace(trace, after);
  assert.equal(updated.length, 1); assert.equal(updated[0].voltageV, 0);
  assert.equal(updated[0].currentA, before.currentA); assert.equal(trace[0].voltageV, 6);
  assert.throws(() => appendTrace(updated, createExperiment()), /backwards/);
});

test('long graph observations remain bounded and roundtrip their final sample exactly', () => {
  const state = createExperiment({ voltageV: 12, loadCoefficient: .0005 });
  const result = advanceObservation(state, [snapshotTrace(state)], 3600, 0);
  assert.deepEqual(result.state, step(state, 3600).state);
  assert.ok(result.trace.length <= 902 && result.trace.length > 100); // at most 900 intermediate samples + initial/end
  assert.ok(result.trace.every((point, index) => !index || point.timeS > result.trace[index - 1].timeS));
  const next = advanceObservation(result.state, result.trace, 1, 0);
  assert.ok(next.trace.length <= 1000);
  assert.deepEqual(parseProject(serializeProject(createProject({ state: next.state, trace: next.trace }))).trace, next.trace);
});

test('zero duration preserves the experiment and invalid observations reject atomically', () => {
  const state = createExperiment(), trace = [snapshotTrace(state)], original = structuredClone({ state, trace });
  assert.deepEqual(advanceObservation(state, trace, 0).state, state);
  for (const value of [-1, NaN, Infinity, 3601]) assert.throws(() => advanceObservation(state, trace, value), RangeError);
  for (const inputChangedAt of [-1, NaN, Infinity, .01]) assert.throws(() => advanceObservation(state, trace, 0, inputChangedAt), RangeError);
  assert.deepEqual({ state, trace }, original);
});

test('144 and 240 Hz slow playback retain the zero and two-millisecond RL evidence', () => {
  for (const frameHz of [60, 144, 240]) {
    let state = createExperiment({ voltageV: 12 }, { locked: true }), trace = [snapshotTrace(state)];
    const frames = frameHz * 10, dt = .01 / frames;
    for (let index = 0; index < frames; index++) {
      const before = state, result = advanceObservation(state, trace, dt, 0);
      assert.deepEqual(result.state, step(before, dt).state);
      ({ state, trace } = result);
    }
    assert.equal(trace[0].timeS, 0);
    assert.equal(trace[0].currentA, 0);
    const sample = trace.find(point => Math.abs(point.timeS - .002) < 1e-12);
    assert.ok(sample, `${frameHz} Hz missing electrical time constant`);
    assert.ok(Math.abs(sample.currentA - 6 * (1 - Math.exp(-1))) < 1e-9);
    assert.ok(trace.length <= 22, `frame endpoints accumulated at ${frameHz} Hz: ${trace.length}`);
    assert.deepEqual(trace.at(-1), snapshotTrace(state));
    parseProject(serializeProject(createProject({ state, trace })));
  }
});

test('irregular frames share the model-time sampling grid and always retain the exact endpoint', () => {
  let state = createExperiment({ voltageV: 12 }), trace = [snapshotTrace(state)];
  const intervals = [.000013, .000107, .000003, .00071, .000033];
  let index = 0;
  while (state.timeS < .01) {
    const dt = Math.min(intervals[index++ % intervals.length], .01 - state.timeS);
    ({ state, trace } = advanceObservation(state, trace, dt, 0));
    assert.deepEqual(trace.at(-1), snapshotTrace(state));
  }
  const direct = advanceObservation(createExperiment({ voltageV: 12 }), [snapshotTrace(createExperiment({ voltageV: 12 }))], .01, 0);
  assert.equal(trace.length, direct.trace.length);
  trace.forEach((sample, i) => {
    assert.ok(Math.abs(sample.timeS - direct.trace[i].timeS) < 1e-12);
    assert.ok(Math.abs(sample.currentA - direct.trace[i].currentA) < 1e-9);
    assert.ok(Math.abs(sample.omegaRadS - direct.trace[i].omegaRadS) < 1e-9);
  });
});

test('imported off-grid observations and later settings-change anchors are not mistaken for disposable endpoints', () => {
  const imported = step(createExperiment({ voltageV: 12 }), .003123).state;
  let state = imported, trace = [snapshotTrace(createExperiment({ voltageV: 12 })), snapshotTrace(imported)];
  const anchor = imported.timeS;
  for (let index = 0; index < 12; index++) ({ state, trace } = advanceObservation(state, trace, .0001, anchor));
  assert.deepEqual(trace.find(point => point.timeS === anchor), snapshotTrace(imported));
  state = reconfigureExperiment(state, { voltageV: 3 }); trace = appendTrace(trace, state);
  const changed = snapshotTrace(state), changedAt = state.timeS;
  for (let index = 0; index < 12; index++) ({ state, trace } = advanceObservation(state, trace, .0001, changedAt));
  assert.deepEqual(trace.find(point => point.timeS === anchor), snapshotTrace(imported));
  assert.deepEqual(trace.find(point => point.timeS === changedAt), changed);
  assert.deepEqual(trace.at(-1), snapshotTrace(state));
});

test('bounded history prioritizes initial and settings anchors while retaining actual samples only', () => {
  let state = createExperiment({ voltageV: 12 }), trace = [snapshotTrace(state)];
  ({ state, trace } = advanceObservation(state, trace, 15, 0));
  state = reconfigureExperiment(state, { voltageV: 3 }); trace = appendTrace(trace, state);
  const changed = snapshotTrace(state), anchor = state.timeS;
  for (let index = 0; index < 3; index++) ({ state, trace } = advanceObservation(state, trace, 15, anchor));
  assert.equal(trace.length, 1000);
  assert.equal(trace[0].timeS, 0);
  assert.deepEqual(trace.find(point => point.timeS === anchor), changed);
  assert.deepEqual(trace.at(-1), snapshotTrace(state));
  assert.ok(trace.every((point, index) => !index || point.timeS > trace[index - 1].timeS));
  parseProject(serializeProject(createProject({ state, trace })));

  // More than capacity worth of user changes cannot all fit; keep the first
  // observation and the latest changes without exceeding the file contract.
  state = createExperiment(); trace = [snapshotTrace(state)];
  for (let index = 0; index < 1010; index++) {
    state = step(state, .0001).state;
    state = reconfigureExperiment(state, { voltageV: index % 2 ? 3 : 12 });
    trace = appendTrace(trace, state);
  }
  assert.equal(trace.length, 1000);
  assert.equal(trace[0].timeS, 0);
  assert.deepEqual(trace.at(-1), snapshotTrace(state));
  parseProject(serializeProject(createProject({ state, trace })));
});
