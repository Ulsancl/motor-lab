import { MODEL_VERSION, normalizeSettings, createExperiment, instantSnapshot, assertValidState,
  MOTOR_CONSTANTS_SI, SETTINGS_LIMITS_SI, STATE_LIMITS_SI } from './model.js';
import { DEFAULT_VIEW, COMPONENTS } from './geometry.js';

export { DEFAULT_VIEW };
export const projectType = 'motor-lab-project';
export const projectVersion = 1;
export const projectModelVersion = MODEL_VERSION;
export const MAX_TRACE_SAMPLES = 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const layerKeys = ['housing', 'magnets', 'windings', 'contacts', 'field'];
const modes = ['assembled', 'cutaway', 'exploded'];
const partIds = new Set(COMPONENTS.map(part => part.id));
const sampleKeys = ['timeS', 'currentA', 'omegaRadS', 'backEmfV', 'voltageV', 'loadCoefficient'];
const stateKeys = ['modelVersion', 'settings', 'locked', 'timeS', 'currentA', 'omegaRadS', 'angleRad', 'energyJ'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const copy = value => structuredClone(value);

export class ProjectError extends Error {
  constructor(message, code = 'INVALID_PROJECT') {
    super(`${message} 원본 파일은 변경하지 않습니다.`);
    this.name = 'ProjectError'; this.code = code; this.preserveOriginal = true;
    this.futureVersion = code === 'FUTURE_SCHEMA' || code === 'FUTURE_MODEL';
  }
}
const fail = (message, code) => { throw new ProjectError(message, code); };
function shape(value, required, label, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    fail(`${label}에 누락되거나 지원하지 않는 항목이 있습니다.`);
  }
}
function numeric(value, label, low, high) {
  if (!finite(value) || Object.is(value, -0) || value < low || value > high) fail(`${label} 수치가 올바르지 않습니다.`);
}
function modelVersion(value) {
  if (value === MODEL_VERSION) return;
  const candidate = typeof value === 'string' ? /^motor-dc-average-(\d+)$/.exec(value) : null;
  fail('이 모터 모형 버전의 원래 기록을 보호합니다.', candidate && Number(candidate[1]) > 1 ? 'FUTURE_MODEL' : 'UNSUPPORTED_MODEL');
}
export function normalizePlaybackRate(value) { return finite(value) ? clamp(value, .001, 4) : 1; }
export function normalizeView(input) {
  const value = record(input) ? input : {}, layers = record(value.layers) ? value.layers : {};
  return {
    mode: modes.includes(value.mode) ? value.mode : DEFAULT_VIEW.mode,
    explode: finite(value.explode) ? clamp(value.explode, 0, 1) : DEFAULT_VIEW.explode,
    labels: typeof value.labels === 'boolean' ? value.labels : DEFAULT_VIEW.labels,
    layers: Object.fromEntries(layerKeys.map(key => [key, typeof layers[key] === 'boolean' ? layers[key] : DEFAULT_VIEW.layers[key]])),
    currentArrows: typeof value.currentArrows === 'boolean' ? value.currentArrows : DEFAULT_VIEW.currentArrows,
    selectedPart: partIds.has(value.selectedPart) ? value.selectedPart : DEFAULT_VIEW.selectedPart,
  };
}
function savedView(value) {
  shape(value, ['mode', 'explode', 'labels', 'layers', 'currentArrows', 'selectedPart'], '관찰 화면');
  if (!modes.includes(value.mode) || !partIds.has(value.selectedPart)) fail('지원하지 않는 관찰 방식 또는 부품입니다.');
  numeric(value.explode, '분해 간격', 0, 1);
  for (const key of ['labels', 'currentArrows']) if (typeof value[key] !== 'boolean') fail('관찰 표시 상태가 올바르지 않습니다.');
  shape(value.layers, layerKeys, '구조 레이어');
  if (layerKeys.some(key => typeof value.layers[key] !== 'boolean')) fail('구조 레이어 상태가 올바르지 않습니다.');
  return normalizeView(value);
}
function savedCamera(value) {
  if (value === null) return null;
  shape(value, ['position', 'target'], '카메라', ['zoom']);
  for (const key of ['position', 'target']) {
    if (!Array.isArray(value[key]) || value[key].length !== 3) fail('카메라 좌표는 세 개의 수치여야 합니다.');
    for (const coordinate of value[key]) numeric(coordinate, '카메라 좌표', -100, 100);
  }
  const distance = Math.hypot(...value.position.map((coordinate, index) => coordinate - value.target[index]));
  numeric(distance, '카메라 거리', .05 - 1e-10, 3 + 1e-10);
  if (Object.hasOwn(value, 'zoom')) numeric(value.zoom, '카메라 확대', .25, 4);
  return copy(value);
}
function savedState(value) {
  shape(value, stateKeys, '모터 실험 상태'); modelVersion(value.modelVersion);
  shape(value.settings, ['voltageV', 'loadCoefficient'], '모터 설정');
  shape(value.energyJ, ['supply', 'copper', 'friction', 'load'], '누적 에너지');
  try { assertValidState(value); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    fail(`모터 상태가 모형의 수치 범위 또는 에너지 관계와 맞지 않습니다. ${error.message}`, 'INVALID_STATE');
  }
  return copy(value);
}
export function snapshotTrace(state) {
  assertValidState(state);
  const snapshot = instantSnapshot(state);
  return { timeS: state.timeS, currentA: state.currentA, omegaRadS: state.omegaRadS,
    backEmfV: snapshot.backEmfV, voltageV: state.settings.voltageV, loadCoefficient: state.settings.loadCoefficient };
}
function savedTrace(value, state) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TRACE_SAMPLES) fail('그래프 기록은 현재 표본을 포함해 1~1000개여야 합니다.', 'INVALID_TRACE');
  let previousTime = 0;
  for (const sample of value) {
    shape(sample, sampleKeys, '그래프 표본');
    numeric(sample.timeS, '표본 시간', previousTime, state.timeS); previousTime = sample.timeS;
    for (const key of ['currentA', 'omegaRadS']) numeric(sample[key], key, STATE_LIMITS_SI[key].min, STATE_LIMITS_SI[key].max);
    for (const key of ['voltageV', 'loadCoefficient']) numeric(sample[key], key, SETTINGS_LIMITS_SI[key].min, SETTINGS_LIMITS_SI[key].max);
    const expectedEmf = MOTOR_CONSTANTS_SI.backEmfConstantVsPerRad * sample.omegaRadS;
    if (!finite(sample.backEmfV) || Object.is(sample.backEmfV, -0)
      || Math.abs(sample.backEmfV - expectedEmf) > 1e-12 * Math.max(1, Math.abs(expectedEmf))) fail('그래프 역기전력이 회전 속도와 일치하지 않습니다.', 'INVALID_TRACE');
    // Samples contain no energy ledger: only complete saved states go through
    // the model's energy validator. Do not invent a historical ledger here.
    if (sample.timeS === 0 && (sample.currentA !== 0 || sample.omegaRadS !== 0)) fail('새 실험의 첫 표본은 정지 상태여야 합니다.', 'INVALID_TRACE');
    if (state.locked && (sample.omegaRadS !== 0 || sample.currentA < 0)) fail('고정축 그래프의 운동 또는 전류가 일치하지 않습니다.', 'INVALID_TRACE');
  }
  const current = snapshotTrace(state), last = value.at(-1);
  if (sampleKeys.some(key => last[key] !== current[key])) fail('그래프의 마지막 표본이 현재 실험 상태와 다릅니다.', 'INVALID_TRACE');
  return copy(value);
}
function savedComparison(value) {
  if (value === null) return null;
  shape(value, ['label', 'state', 'trace'], '비교 기록');
  if (typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 80 || !value.label.trim()
    || /[\u0000-\u001f\u007f]/.test(value.label)) fail('비교 이름은 제어 문자 없는 1~80자여야 합니다.');
  const state = savedState(value.state);
  return { label: value.label, state, trace: savedTrace(value.trace, state) };
}
function validateProject(value) {
  if (!record(value) || value.type !== projectType) fail('지원하지 않는 모터 실험 파일입니다.', 'UNSUPPORTED_FORMAT');
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > projectVersion) fail('새로운 저장 형식을 보호합니다.', 'FUTURE_SCHEMA');
  if (value.schemaVersion !== projectVersion) fail('지원하지 않는 저장 형식 버전입니다.', 'UNSUPPORTED_SCHEMA');
  modelVersion(value.modelVersion);
  shape(value, ['type', 'schemaVersion', 'modelVersion', 'state', 'trace', 'comparison', 'observation'], '모터 실험 파일');
  const state = savedState(value.state);
  shape(value.observation, ['playbackRate', 'view', 'camera'], '관찰 기록');
  numeric(value.observation.playbackRate, '관찰 재생 배율', .001, 4);
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION, state,
    trace: savedTrace(value.trace, state), comparison: savedComparison(value.comparison),
    observation: { playbackRate: value.observation.playbackRate, view: savedView(value.observation.view), camera: savedCamera(value.observation.camera) } };
}
export function createProject(input = {}) {
  const value = record(input) ? input : {};
  let state;
  try { state = savedState(value.state); }
  catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    const original = record(value.state) ? value.state : {};
    const angle = finite(original.angleRad) ? ((original.angleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : 0;
    state = createExperiment(normalizeSettings(original.settings), { locked: original.locked === true, angleRad: angle });
  }
  let trace = [snapshotTrace(state)], comparison = null, camera = null;
  if (value.trace !== undefined) try { trace = savedTrace(value.trace, state); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  if (value.comparison !== undefined) try { comparison = savedComparison(value.comparison); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  if (value.camera !== undefined) try { camera = savedCamera(value.camera); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION, state, trace, comparison,
    observation: { playbackRate: normalizePlaybackRate(value.playbackRate), view: normalizeView(value.view), camera } };
}
export function parseProject(text) {
  if (typeof text !== 'string') fail('실험 파일은 JSON 텍스트여야 합니다.', 'INVALID_JSON');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('실험 파일은 10 MiB 이하여야 합니다.', 'PROJECT_TOO_LARGE');
  let value;
  try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { fail('JSON 실험 파일을 읽을 수 없습니다.', 'INVALID_JSON'); }
  return validateProject(value);
}
export function serializeProject(project) { return JSON.stringify(validateProject(project), null, 2); }
