import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, reconfigureExperiment, step, instantSnapshot } from '../src/model.js';
import { COMPONENTS } from '../src/geometry.js';
import { createProject, parseProject, serializeProject, snapshotTrace, normalizeView, normalizePlaybackRate,
  DEFAULT_VIEW, ProjectError, MAX_TRACE_SAMPLES } from '../src/project.js';
const clone = value => structuredClone(value);
function example() {
  const initial = createExperiment({ voltageV: 9, loadCoefficient: .0003 }, { angleRad: .7 });
  const state = step(initial, .19).state;
  const baseline = step(createExperiment({ voltageV: 6, loadCoefficient: 0 }), .12).state;
  return createProject({ state, trace: [snapshotTrace(initial), snapshotTrace(state)],
    comparison: { label: '6 V 기준', state: baseline, trace: [snapshotTrace(baseline)] }, playbackRate: .001,
    view: { mode: 'exploded', explode: .72, labels: false, currentArrows: false, selectedPart: 'segment-1',
      layers: { housing: false, magnets: false, windings: true, contacts: true, field: true } },
    camera: { position: [.4, .3, .6], target: [0, .07, 0], zoom: 1.5 } });
}
function invalid(change, code) {
  const original = example(), before = clone(original), imported = clone(original); change(imported);
  const raw = JSON.stringify(imported);
  assert.throws(() => parseProject(raw), error => error instanceof ProjectError && error.preserveOriginal && (!code || error.code === code));
  assert.deepEqual(original, before); assert.equal(JSON.stringify(imported), raw);
}
function roundTrip(state) {
  const saved = createProject({ state }), original = clone(state), raw = serializeProject(saved), restored = parseProject(raw);
  assert.deepEqual(restored, saved); assert.equal(serializeProject(restored), raw);
  assert.deepEqual(state, original); assert.deepEqual(instantSnapshot(restored.state), instantSnapshot(state));
  assert.deepEqual(step(restored.state, .017), step(state, .017));
  return restored;
}
test('default project is an explicit rest experiment with one real trace sample and no comparison', () => {
  const project = createProject();
  assert.deepEqual(project.state, createExperiment());
  assert.deepEqual(project.trace, [snapshotTrace(project.state)]); assert.equal(project.comparison, null);
  assert.deepEqual(project.observation, { playbackRate: 1, view: DEFAULT_VIEW, camera: null });
  assert.deepEqual(parseProject(serializeProject(project)), project);
});
test('state, historic trace, comparison and manual observation survive exact isolated round trips', () => {
  const project = example(), original = clone(project), raw = serializeProject(project), restored = parseProject(raw);
  assert.deepEqual(restored, project); assert.equal(serializeProject(restored), raw);
  restored.state.settings.voltageV = 0; restored.trace[0].currentA = 9;
  restored.comparison.state.energyJ.supply = -5; restored.comparison.trace[0].voltageV = 11;
  restored.observation.view.layers.housing = true; restored.observation.camera.position[0] = 1;
  assert.deepEqual(project, original);
});
test('startup, live setting changes, locked shaft and signed braking current resume identically', () => {
  let state = step(createExperiment({ voltageV: 12, loadCoefficient: 0 }), .4).state;
  roundTrip(state);
  state = reconfigureExperiment(state, { voltageV: 0, loadCoefficient: .0005 });
  roundTrip(state); state = step(state, .01).state;
  assert.ok(state.currentA < 0, 'The fixture must exercise regenerative current rather than only rest'); roundTrip(state);
  const locked = step(createExperiment({ voltageV: 12 }, { locked: true }), .008).state;
  assert.equal(locked.omegaRadS, 0); assert.ok(locked.currentA > 0); roundTrip(locked);
});
test('trace supports repeated timestamps and the bounded last 1000 samples without guessing older history', () => {
  const project = example(), current = snapshotTrace(project.state);
  project.trace = Array.from({ length: MAX_TRACE_SAMPLES }, () => clone(current));
  assert.deepEqual(parseProject(serializeProject(project)).trace, project.trace);
  invalid(value => { value.trace = []; }, 'INVALID_TRACE');
  invalid(value => { value.trace = Array.from({ length: MAX_TRACE_SAMPLES + 1 }, () => snapshotTrace(value.state)); }, 'INVALID_TRACE');
});
test('trace rejects changed terminal values, reversed/future time and inconsistent back EMF', () => {
  for (const change of [
    p => { p.trace.at(-1).currentA += .1; }, p => { p.trace.at(-1).voltageV = 5; },
    p => { p.trace[0].timeS = p.state.timeS + .1; }, p => { p.trace[0].timeS = -.1; },
    p => { p.trace[0].backEmfV = 1; }, p => { p.trace[0].loadCoefficient = .1; },
    p => { p.trace[0].currentA = 10000; }, p => { p.trace[0].extra = true; },
    p => { p.trace[0].currentA = 1; },
    p => { p.trace.splice(1, 0, { ...p.trace[0], timeS: .1 }, { ...p.trace[0], timeS: .05 }); },
  ]) invalid(change);
  const locked = step(createExperiment({ voltageV: 12 }, { locked: true }), .01).state;
  const saved = createProject({ state: locked, trace: [snapshotTrace(createExperiment({ voltageV: 12 }, { locked: true })), snapshotTrace(locked)] });
  saved.trace[0] = { ...saved.trace[0], timeS: .001, omegaRadS: 1, backEmfV: .04 };
  assert.throws(() => parseProject(JSON.stringify(saved)), error => error.code === 'INVALID_TRACE');
});
test('comparison validates its complete independent state, label and trace instead of silently dropping invalid data', () => {
  for (const change of [
    p => { p.comparison.label = ''; }, p => { p.comparison.label = 'x'.repeat(81); }, p => { p.comparison.label = 'bad\nlabel'; },
    p => { p.comparison.state.energyJ.supply += 10; }, p => { p.comparison.trace.at(-1).timeS += .1; },
    p => { p.comparison.guide = { done: true }; }, p => { p.comparison.comparison = null; },
  ]) invalid(change);
});
test('strict model validation rejects inconsistent energy, shape, settings and locked motion', () => {
  for (const change of [
    p => { p.state.energyJ.copper = -1; }, p => { p.state.energyJ.supply += 100; },
    p => { p.state.settings.voltageV = 13; }, p => { p.state.settings.loadCoefficient = -.1; },
    p => { p.state.angleRad = 2 * Math.PI; }, p => { p.state.timeS = -1; },
    p => { p.state.locked = true; }, p => { p.state.extra = 1; }, p => { delete p.state.energyJ.load; },
  ]) invalid(change);
});
test('every geometry part and exact supported camera endpoints remain valid', () => {
  for (const part of COMPONENTS) {
    const p = example(); p.observation.view.selectedPart = part.id;
    assert.equal(parseProject(serializeProject(p)).observation.view.selectedPart, part.id);
  }
  for (const distance of [.05, 3, .05 - 5e-11, 3 + 5e-11]) {
    const p = example(); p.observation.camera = { position: [distance, 0, 0], target: [0, 0, 0], zoom: .25 };
    assert.deepEqual(parseProject(serializeProject(p)).observation.camera, p.observation.camera);
  }
  for (const change of [
    p => { p.observation.camera.position = [...p.observation.camera.target]; },
    p => { p.observation.camera.zoom = 4.1; }, p => { p.observation.camera.position[0] = 101; },
    p => { p.observation.view.selectedPart = 'invented'; }, p => { p.observation.view.layers.unknown = true; },
    p => { p.observation.playbackRate = .0001; },
  ]) invalid(change);
});
test('future formats and models preserve original data and expose recovery flags', () => {
  for (const [field, value, code] of [['schemaVersion', 2, 'FUTURE_SCHEMA'], ['modelVersion', 'motor-dc-average-2', 'FUTURE_MODEL']]) {
    const project = example(); project[field] = value; const raw = JSON.stringify(project);
    assert.throws(() => parseProject(raw), error => error.code === code && error.futureVersion && error.preserveOriginal);
    assert.equal(JSON.stringify(project), raw);
  }
  invalid(p => { p.state.modelVersion = 'motor-dc-average-2'; }, 'FUTURE_MODEL');
  invalid(p => { p.type = 'hydraulic-lab-project'; }, 'UNSUPPORTED_FORMAT');
  invalid(p => { p.schemaVersion = 0; }, 'UNSUPPORTED_SCHEMA');
});
test('BOM, malformed and oversized JSON keep strict size and schema semantics', () => {
  const p = example(), raw = serializeProject(p);
  assert.deepEqual(parseProject('\ufeff' + raw), p);
  for (const value of ['{bad', '\ufeff\ufeff' + raw, null, '[]']) assert.throws(() => parseProject(value), ProjectError);
  assert.throws(() => parseProject(' '.repeat(10 * 1024 * 1024 + 1)), error => error.code === 'PROJECT_TOO_LARGE');
  assert.throws(() => parseProject('한'.repeat(4 * 1024 * 1024)), error => error.code === 'PROJECT_TOO_LARGE');
  const negativeZero = example(); negativeZero.observation.camera.target[0] = -0;
  assert.throws(() => serializeProject(negativeZero), ProjectError);
});
test('live invalid input creates coherent rest state without fabricating energy or history', () => {
  const bad = example(); bad.state.energyJ.supply = -10000;
  const result = createProject({ state: bad.state, trace: bad.trace, comparison: { label: '' }, camera: { bad: true }, playbackRate: Infinity });
  assert.equal(result.state.timeS, 0); assert.equal(result.state.currentA, 0); assert.equal(result.state.omegaRadS, 0);
  assert.deepEqual(result.state.energyJ, { supply: 0, copper: 0, friction: 0, load: 0 });
  assert.deepEqual(result.trace, [snapshotTrace(result.state)]); assert.equal(result.comparison, null); assert.equal(result.observation.camera, null);
  assert.equal(result.observation.playbackRate, 1); assert.deepEqual(parseProject(serializeProject(result)), result);
  assert.equal(normalizePlaybackRate(.0001), .001); assert.equal(normalizePlaybackRate(5), 4);
  assert.equal(normalizeView({ selectedPart: 'unknown', explode: 3 }).selectedPart, DEFAULT_VIEW.selectedPart);
});
