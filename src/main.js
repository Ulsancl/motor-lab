import './style.css';
import { createExperiment, reconfigureExperiment, instantSnapshot, MAX_SIMULATION_TIME_S, MAX_STEP_SECONDS } from './model.js';
import { createProject, parseProject, serializeProject, normalizeView, normalizePlaybackRate, DEFAULT_VIEW, snapshotTrace } from './project.js';
import { advanceObservation, appendTrace } from './trace.js';
import { COMPONENTS, sampleCommutation } from './geometry.js';
import { MotorScene } from './scene.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'motor-lab-project-v1', desktop = window.motorDesktop, TAU = Math.PI * 2;
let state = createExperiment(), snapshot = instantSnapshot(state), trace = [snapshotTrace(state)], comparison = null;
let view = normalizeView(DEFAULT_VIEW), playbackRate = .1, scene, initialCamera = null;
let running = false, busy = false, restoring = false, focused = false, guide = null, previous = null;
let recoveredRaw = null, storageBlocked = false, saveTimer, toastTimer, lastFrame = performance.now(), lastReadout = 0, lastAutosave = 0, inputChangedAt = 0;
const number = (value, digits = 2) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const text = (selector, value) => { $(selector).textContent = value; };
function quantity(selector, value, unit, digits = 2) { $(selector).replaceChildren(document.createTextNode(`${number(value, digits)} `), Object.assign(document.createElement('small'), { textContent: unit })); }
function dismissToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
function toast(message) {
  const messageNode = Object.assign(document.createElement('span'), { textContent: message });
  const close = Object.assign(document.createElement('button'), { type: 'button', textContent: '닫기' });
  close.setAttribute('aria-label', '알림 닫기'); close.addEventListener('click', dismissToast);
  $('#toast').replaceChildren(messageNode, close); $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(dismissToast, 5000);
}
function returnToScene() { dismissToast(); requestAnimationFrame(() => $('#scene').scrollIntoView({ block: 'nearest', inline: 'nearest' })); }
function capture() { return createProject({ state, trace, comparison, playbackRate, view, camera: scene?.getCameraState() ?? initialCamera }); }
function saveLocal() {
  clearTimeout(saveTimer); if (storageBlocked || restoring) return;
  try { localStorage.setItem(STORAGE_KEY, serializeProject(capture())); text('#save-status', '이 기기에 자동 저장됨'); }
  catch { text('#save-status', '자동 저장을 완료하지 못했습니다 · 파일로 보관하세요'); }
}
function scheduleSave() { if (!restoring && !storageBlocked) { clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 220); } }
function protectOriginal(raw, future) {
  recoveredRaw = raw; storageBlocked = true;
  try { localStorage.setItem(`${STORAGE_KEY}-original-${Date.now()}`, raw); } catch { /* Keep the primary original. */ }
  $('#storage-recovery').hidden = false;
  if (future) text('#storage-recovery strong', '더 새로운 버전의 관찰 기록입니다. 원문을 보존합니다.');
  text('#save-status', '자동 저장 원문 보호 중 · 현재 실험은 파일로 보관하세요');
}
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) {
    try { const saved = parseProject(raw); ({ state, trace, comparison } = saved); ({ view, playbackRate, camera: initialCamera } = saved.observation); snapshot = instantSnapshot(state); inputChangedAt = state.timeS; }
    catch (error) { protectOriginal(raw, error.futureVersion); }
  }
} catch { storageBlocked = true; text('#save-status', '자동 저장을 사용할 수 없습니다 · 파일로 보관하세요'); }

function setBusy(value) { busy = value; $('#save-project').disabled = value; $('#open-project').disabled = value; if (desktop?.setBusy) Promise.resolve(desktop.setBusy(value)).catch(() => {}); }
function syncPlayback() {
  text('#play', running ? 'Ⅱ 일시정지' : '▶ 재생'); $('#play').setAttribute('aria-label', running ? '일시정지' : '재생');
  text('#guide-play', running ? 'Ⅱ 관찰 일시정지' : '▶ 관찰 시작');
  text('#running-indicator', running ? `관찰 재생 중 · ${number(playbackRate, playbackRate < .01 ? 3 : 2)}×` : '관찰 일시정지');
}
function stop() { const wasRunning = running; running = false; syncPlayback(); if (wasRunning) refresh(false); scheduleSave(); }
function begin() { if (busy) return; if (guide?.status === 'active' && guide.stage === 1) { toast('안내의 다음 조건을 선택하거나 자유 탐구로 전환하세요.'); return; } if (state.timeS >= MAX_SIMULATION_TIME_S) { toast('시간 범위에 도달했습니다. 새 실험으로 시작하세요.'); return; } running = true; lastFrame = performance.now(); syncPlayback(); }
function toggle() { if (running) stop(); else begin(); }
function syncControls(settings = false) {
  if (settings) { $('#voltage').value = state.settings.voltageV; $('#load').value = state.settings.loadCoefficient * 100000; }
  text('#applied-settings', `적용 중: ${number(state.settings.voltageV, 1)} V · 부하 ${number(state.settings.loadCoefficient * 100000, 1)}%`);
  text('#shaft-mode', state.locked ? '고정된 축' : '자유 회전');
  $$('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === view.mode)));
  $$('[data-layer]').forEach(input => { input.checked = view.layers[input.dataset.layer]; });
  $('#labels').checked = view.labels; $('#current-arrows').checked = view.currentArrows;
  $('#explode').value = view.explode; $('#explode').disabled = view.mode !== 'exploded'; $('#part-select').value = view.selectedPart;
  const rate = $('#playback-rate'); rate.querySelector('[data-custom]')?.remove();
  if (![...rate.options].some(option => Number(option.value) === playbackRate)) { const option = document.createElement('option'); option.dataset.custom = 'true'; option.value = String(playbackRate); option.textContent = `${number(playbackRate, 3)}×`; rate.append(option); }
  rate.value = String(playbackRate);
  $$('[data-lesson]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lesson === guide?.id)));
  syncPlayback();
}
function remember() { previous = { project: capture(), guide: structuredClone(guide), inputChangedAt }; $('#undo-new').hidden = false; }
function readProject(project, restoredGuide = null) {
  const saved = parseProject(serializeProject(project)); restoring = true;
  try {
    stop(); ({ state, trace, comparison } = saved); ({ view, playbackRate } = saved.observation); inputChangedAt = state.timeS;
    snapshot = instantSnapshot(state); guide = restoredGuide; syncControls(true); refresh(true);
    if (saved.observation.camera) scene?.setCameraState(saved.observation.camera); else scene?.resetCamera();
  } finally { restoring = false; }
  saveLocal();
}
function newExperiment(locked = false) {
  if (busy) return; remember(); stop(); state = createExperiment(undefined, { locked }); snapshot = instantSnapshot(state); trace = [snapshotTrace(state)]; comparison = null; guide = null; inputChangedAt = 0;
  view = normalizeView(DEFAULT_VIEW); playbackRate = locked ? .001 : .1; syncControls(true); refresh(true); scene?.resetCamera(); saveLocal();
  toast(locked ? '정지한 축을 고정한 새 실험입니다. 회전 중 운동 에너지를 삭제하지 않습니다.' : '정지 상태의 새 실험입니다. 직전 실험은 되돌릴 수 있습니다.');
}
function changeSettings(settings, { guided = false } = {}) {
  if (busy) return; const before = state;
  state = reconfigureExperiment(state, settings); snapshot = instantSnapshot(state); trace = appendTrace(trace, state);
  if (before.settings.voltageV !== state.settings.voltageV || before.settings.loadCoefficient !== state.settings.loadCoefficient) {
    inputChangedAt = state.timeS;
    if (!guided && guide?.status === 'active') { guide.status = 'interrupted'; guide.notice = '조건을 직접 바꿨습니다. 현재 운동은 이어집니다. 안내 비교는 다시 시작하세요.'; }
  }
  syncControls(true); refresh(true); scheduleSave();
}
function pinComparison(label) { comparison = { label: label || `${number(state.settings.voltageV, 1)} V · 부하 ${number(state.settings.loadCoefficient * 100000, 0)}% · ${number(state.timeS, 3)} s`, state: structuredClone(state), trace: structuredClone(trace) }; refresh(true); scheduleSave(); }

const lessonInfo = {
  startup: { title: '전압이 두 배가 되면?', voltageV: 6, loadCoefficient: 0, locked: false, rate: 1 },
  load: { title: '부하가 커지면 왜 느려질까?', voltageV: 12, loadCoefficient: 0, locked: false, rate: 1 },
  locked: { title: '돌지 않아도 전류가 흐를까?', voltageV: 12, loadCoefficient: 0, locked: true, rate: .001 },
};
function startLesson(id) {
  if (busy || !lessonInfo[id]) return; remember(); stop(); const lesson = lessonInfo[id];
  state = createExperiment({ voltageV: lesson.voltageV, loadCoefficient: lesson.loadCoefficient }, { locked: lesson.locked }); snapshot = instantSnapshot(state); trace = [snapshotTrace(state)]; comparison = null;
  inputChangedAt = 0; guide = { id, stage: 0, status: 'active', changedAt: 0, notice: '' }; playbackRate = lesson.rate;
  $('#plot-window').value = id === 'locked' ? 'start' : 'all'; syncControls(true); refresh(true); scheduleSave();
  if (id === 'locked') scene?.resetCamera('commutator');
}
function guideBoundary() {
  if (!guide || guide.status !== 'active') return null;
  if (guide.id === 'locked') return .01;
  if (guide.stage === 0) return 3;
  if (guide.stage === 2) return guide.id === 'load' ? guide.changedAt + 3 : 3;
  return null;
}
function observeGuide() {
  if (guide?.stage === 1) return;
  const boundary = guideBoundary(); if (boundary === null || state.timeS < boundary - 1e-10) return;
  stop();
  if (guide.id === 'locked') { guide.stage = 1; guide.status = 'completed'; }
  else if (guide.stage === 0) guide.stage = 1;
  else { guide.stage = 3; guide.status = 'completed'; }
  if (guide.status === 'completed') guide.evidence = { state: structuredClone(state), comparison: structuredClone(guide.baseline ?? null) };
}
function guideNext() {
  if (!guide || guide.status !== 'active' || guide.stage !== 1) return;
  stop();
  if (guide.id === 'startup') {
    pinComparison('6 V · 무부하 · 3초'); guide.baseline = structuredClone(comparison); state = createExperiment({ voltageV: 12, loadCoefficient: 0 }); snapshot = instantSnapshot(state); trace = [snapshotTrace(state)]; inputChangedAt = 0;
  } else if (guide.id === 'load') { pinComparison('12 V · 부하 0% · 적용 직전'); guide.baseline = structuredClone(comparison); changeSettings({ loadCoefficient: .0005 }, { guided: true }); }
  guide.stage = 2; guide.changedAt = state.timeS; syncControls(true); refresh(true); saveLocal();
}
function renderGuide() {
  $('#lesson-guide').hidden = !guide; $('#guide-next').hidden = true;
  $('#guide-play').hidden = !guide || guide.status !== 'active' || guide.stage === 1; if (!guide) return;
  const lesson = lessonInfo[guide.id]; text('#guide-title', lesson.title);
  text('#guide-progress', guide.status === 'completed' ? '관찰 완료' : guide.status === 'interrupted' ? '직접 조절 중' : `관찰 ${guide.stage < 2 ? 1 : 2} / ${guide.id === 'locked' ? 1 : 2}`);
  let action = '', result = '';
  if (guide.status === 'interrupted') action = guide.notice;
  else if (guide.status === 'completed') {
    action = '관찰을 마쳤습니다. 아래는 완료 시점의 결과입니다. 현재 조건을 더 조절하거나 자유 탐구로 이어가세요.';
    const observed = guide.evidence.state, end = instantSnapshot(observed), compared = guide.evidence.comparison;
    if (guide.id === 'locked') result = `${number(observed.timeS * 1000, 1)} ms: ${number(observed.currentA, 3)} A, 0 rpm. 축 출력은 0 W지만 구리 손실은 ${number(end.powerW.copper, 2)} W입니다.`;
    else if (compared) { const old = instantSnapshot(compared.state); result = `회전수 ${number(old.rpm, 0)} → ${number(end.rpm, 0)} rpm · 전류 ${number(old.currentA, 3)} → ${number(end.currentA, 3)} A. ${guide.id === 'load' ? '부하를 받으면 속도와 역기전력이 낮아지고 전류가 증가합니다.' : '같은 부하에서 전압이 커지면 더 높은 회전수에 도달합니다.'}`; }
  } else if (guide.id === 'locked') action = `재생을 눌러 처음 10 ms를 관찰하세요 (${number(state.timeS * 1000, 2)} / 10 ms). 전류가 바로 6 A가 되지 않고 상승하는 모습을 봅니다.`;
  else if (guide.stage === 0) action = `재생을 눌러 ${guide.id === 'startup' ? '6 V 무부하' : '12 V 무부하'}로 3초까지 관찰하세요 (${number(state.timeS, 2)} / 3 s). 회전이 빨라지면 역기전력이 증가합니다.`;
  else if (guide.stage === 1) { action = `첫 관찰: ${number(snapshot.rpm, 0)} rpm, ${number(state.currentA, 3)} A. 다음 조건과 비교할 준비가 됐습니다.`; $('#guide-next').hidden = false; text('#guide-next', guide.id === 'startup' ? '6 V 결과 보관 → 12 V로 새 출발' : '현재 회전에 부하 50% 적용'); }
  else action = `재생을 눌러 ${guide.id === 'startup' ? '12 V의 새 출발' : '속도와 전류의 연속적인 변화'}를 3초 관찰하세요 (${number(state.timeS - guide.changedAt, 2)} / 3 s). 안내 결과는 첫 번째 관찰과 비교합니다.`;
  text('#guide-action', action); text('#guide-result', result);
}

function advance(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_STEP_SECONDS) throw new RangeError('Invalid observation duration');
  if (busy) return; const boundary = guideBoundary();
  let duration = guide?.status === 'active' && guide.stage === 1 ? 0 : seconds;
  if (boundary !== null) duration = Math.min(duration, Math.max(0, boundary - state.timeS));
  duration = Math.min(duration, MAX_SIMULATION_TIME_S - state.timeS);
  const result = advanceObservation(state, trace, duration, inputChangedAt); state = result.state; trace = result.trace; snapshot = instantSnapshot(state);
  observeGuide(); if (state.timeS >= MAX_SIMULATION_TIME_S) stop(); return result;
}
function displayContacts() {
  const data = sampleCommutation(state.angleRad), short = id => `S${id.split('-').at(-1)}`;
  text('#contacts-positive', `＋ 브러시 접촉: ${data.positive.map(item => short(item.segmentId)).join(' + ') || '절연 간극'}`);
  text('#contacts-negative', `− 브러시 접촉: ${data.negative.map(item => short(item.segmentId)).join(' + ') || '절연 간극'}`);
  text('#contact-overlap', data.bridgedCoils.length ? `접점 중첩: 코일 ${data.bridgedCoils.map(id => id.at(-1).toUpperCase()).join(' · ')}의 두 편이 한 브러시에 닿습니다.` : '브러시는 고정되고 정류자 편은 축과 함께 회전합니다.');
  const center = [110, 82], radius = 49, point = (a, r = radius) => [center[0] + Math.sin(a) * r, center[1] - Math.cos(a) * r];
  const arcs = [0, 1, 2].map(index => {
    const angle = state.angleRad + index * TAU / 3, start = point(angle - 59 * Math.PI / 180), end = point(angle + 59 * Math.PI / 180), label = point(angle, 31);
    const positive = data.positive.some(item => item.segmentId === `segment-${index}`), negative = data.negative.some(item => item.segmentId === `segment-${index}`);
    return `<path d="M${start.join(',')} A49,49 0 0 1 ${end.join(',')}" fill="none" stroke="${positive ? '#e6ae73' : negative ? '#7dd0dd' : '#807465'}" stroke-width="14"/><text x="${label[0]}" y="${label[1] + 4}" text-anchor="middle" fill="#d8e4eb" font-size="11">S${index}</text>`;
  }).join('');
  $('#commutation').innerHTML = `<circle cx="110" cy="82" r="19" fill="#405562"/><circle cx="110" cy="82" r="7" fill="#8195a0"/>${arcs}<rect x="166" y="75" width="22" height="14" rx="2" fill="#e6ae73"/><rect x="32" y="75" width="22" height="14" rx="2" fill="#7dd0dd"/><text x="197" y="87" fill="#efc791" font-size="16">+</text><text x="19" y="87" fill="#97dce5" font-size="16">−</text><text x="110" y="160" text-anchor="middle" fill="#8da4b1" font-size="9">A: S0—S1 · B: S1—S2 · C: S2—S0</text>`;
}
function plot(selector, key, multiplier, color) {
  const baseline = comparison?.trace ?? [], all = [...trace, ...baseline];
  let lowX = Math.min(...all.map(point => point.timeS)), highX = Math.max(...all.map(point => point.timeS));
  if ($('#plot-window').value === 'recent') lowX = Math.max(lowX, highX - 1);
  if ($('#plot-window').value === 'start') { lowX = 0; highX = .02; }
  if (highX - lowX < 1e-9) highX = lowX + .01;
  const visible = values => values.filter(point => point.timeS >= lowX - 1e-12 && point.timeS <= highX + 1e-12);
  const current = visible(trace), compared = visible(baseline), values = [...current, ...compared].map(point => point[key] * multiplier);
  let lowY = Math.min(0, ...values), highY = Math.max(0, ...values); if (highY - lowY < .001) highY = lowY + 1;
  const margin = (highY - lowY) * .1; if (lowY < 0) lowY -= margin; highY += margin;
  const x = value => 46 + (value - lowX) / (highX - lowX) * 340, y = value => 126 - (value - lowY) / (highY - lowY) * 112;
  const line = values => values.map((p, index) => `${index ? 'L' : 'M'}${x(p.timeS).toFixed(2)},${y(p[key] * multiplier).toFixed(2)}`).join(' ');
  const axisNumber = value => Math.abs(value) >= 100 ? number(value, 0) : Math.abs(value) >= 1 ? number(value, 1) : number(value, 3);
  const grids = [lowY, (lowY + highY) / 2, highY].map(value => `<line x1="46" y1="${y(value)}" x2="386" y2="${y(value)}" stroke="#2b404c"/><text x="40" y="${y(value) + 3}" text-anchor="end" fill="#8da5b3" font-size="10">${axisNumber(value)}</text>`).join('');
  $(selector).innerHTML = `${grids}<path d="${line(compared)}" fill="none" stroke="#c8d4dc" stroke-width="1.8" stroke-dasharray="5 4"/><path d="${line(current)}" fill="none" stroke="${color}" stroke-width="2.3"/>${current.length ? `<circle cx="${x(current.at(-1).timeS)}" cy="${y(current.at(-1)[key] * multiplier)}" r="2.5" fill="${color}"/>` : '<text x="218" y="76" text-anchor="middle" fill="#9eb3bf" font-size="11">이 구간의 기록이 없습니다</text>'}<text x="46" y="146" fill="#8da5b3" font-size="10">${axisNumber(lowX)} s</text><text x="386" y="146" text-anchor="end" fill="#8da5b3" font-size="10">${axisNumber(highX)} s</text>`;
}
function refresh(renderScene = true) {
  if (renderScene && scene) scene.update(snapshot, view);
  quantity('#rpm', snapshot.rpm, 'rpm', 0); quantity('#current', state.currentA, 'A', 3); quantity('#back-emf', snapshot.backEmfV, 'V', 2); quantity('#torque', snapshot.torqueNm * 1000, 'mN·m', 2);
  text('#time', number(state.timeS, 3)); text('#direction-label', state.locked ? '축 고정 · 회전 0' : Math.abs(state.omegaRadS) < 1e-5 ? '회전 정지' : `${state.omegaRadS > 0 ? '+X' : '−X'}축 방향 · ${number(snapshot.rpm, 0)} rpm`);
  text('#observation-note', view.mode === 'exploded' ? '분해 표시는 관찰용입니다. 접촉·회전 계산은 조립 치수 기준입니다.' : '빠른 회전은 화면에서 거꾸로 보일 수 있습니다. 접점은 0.001×로 관찰하세요.');
  const part = COMPONENTS.find(item => item.id === view.selectedPart); if (part) { text('#part-name', part.name); text('#part-material', part.material); text('#part-description', part.description); }
  for (const key of ['supply', 'copper', 'friction', 'load']) { text(`#power-${key}`, `${number(snapshot.powerW[key], 3)} W`); text(`#energy-${key}`, `누적 ${number(state.energyJ[key], 4)} J`); }
  const residual = state.energyJ.supply - snapshot.storedEnergyJ.total - state.energyJ.copper - state.energyJ.friction - state.energyJ.load;
  text('#energy-balance', `저장 에너지: 자기 ${number(snapshot.storedEnergyJ.magnetic, 5)} J + 회전 ${number(snapshot.storedEnergyJ.kinetic, 5)} J · 에너지 수지 잔차 ${residual.toExponential(2)} J`);
  text('#load-torque', `현재 시험 부하 토크 ${number(snapshot.loadTorqueNm * 1000, 2)} mN·m${state.locked ? ` · 축 고정 반력 ${number(snapshot.constraintTorqueNm * 1000, 2)} mN·m` : ''}`);
  displayContacts(); plot('#plot-current', 'currentA', 1, '#e5ad6f'); plot('#plot-rpm', 'omegaRadS', 60 / TAU, '#7ad0d9'); plot('#plot-emf', 'backEmfV', 1, '#b6a0e6');
  text('#trace-info', `현재 기록 ${trace.length}개 · ${number(trace[0].timeS, 3)}—${number(trace.at(-1).timeS, 3)} s`);
  $('#clear-comparison').hidden = !comparison; $('#comparison-summary').hidden = !comparison;
  if (comparison) { const old = instantSnapshot(comparison.state); text('#comparison-summary', `흰 점선 · ${comparison.label}\n기준 ${number(old.rpm, 0)} rpm / ${number(old.currentA, 3)} A / ${number(old.backEmfV, 2)} V → 현재 ${number(snapshot.rpm, 0)} rpm / ${number(snapshot.currentA, 3)} A / ${number(snapshot.backEmfV, 2)} V`); }
  renderGuide();
}
function browserDownload(contents, name, mime = 'application/json;charset=utf-8') { const url = URL.createObjectURL(new Blob([contents], { type: mime })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function saveFile() {
  if (busy) return; stop(); setBusy(true);
  try { const contents = serializeProject(capture()), name = `motor-lab-${new Date().toISOString().slice(0, 10)}.json`; if (desktop) { const result = await desktop.saveProject({ contents, name }); if (result.canceled) { toast('저장을 취소했습니다. 현재 실험은 그대로 유지합니다.'); return; } } else browserDownload(contents, name); saveLocal(); toast('모터 상태·그래프·비교 기준·관찰 시점을 실험 파일에 저장했습니다.'); }
  catch (error) { toast(`저장하지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
async function openFile() {
  if (busy) return; stop(); if (!desktop) { $('#project-file').click(); return; } setBusy(true);
  try { const result = await desktop.openProject(); if (result.canceled) { toast('열기를 취소했습니다. 현재 실험은 그대로 유지합니다.'); return; } const saved = parseProject(result.content); remember(); readProject(saved); toast('저장한 실험을 일시정지 상태로 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
function toggleFocus() { focused = !focused; document.body.classList.toggle('focus-mode', focused); text('#focus', focused ? '실험 화면으로' : '3D 크게 보기'); returnToScene(); }

$('#part-select').replaceChildren(...COMPONENTS.map(part => Object.assign(document.createElement('option'), { value: part.id, textContent: part.name })));
try {
  scene = new MotorScene($('#scene'), { onSelect: id => { view.selectedPart = id; syncControls(); refresh(true); scheduleSave(); }, onCameraChange: scheduleSave });
  if (initialCamera) scene.setCameraState(initialCamera);
} catch (error) { $('#scene-error').hidden = false; text('#scene-error', `3D 화면을 시작하지 못했습니다. 그래픽 가속을 지원하는 환경에서 다시 실행하세요. ${error.message}`); }
syncControls(true); refresh(true);
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); if (busy || !event.currentTarget.reportValidity()) return; changeSettings({ voltageV: Number($('#voltage').value), loadCoefficient: Number($('#load').value) / 100000 }); toast('전류·속도를 유지한 채 새 조건을 적용했습니다.'); });
$('#zero-voltage').addEventListener('click', () => changeSettings({ voltageV: 0 }));
$('#new-locked').addEventListener('click', () => newExperiment(true)); $('#new-project').addEventListener('click', () => newExperiment());
$('#undo-new').addEventListener('click', () => { if (!previous || busy) return; const saved = previous; previous = null; readProject(saved.project, saved.guide); inputChangedAt = saved.inputChangedAt; $('#undo-new').hidden = true; toast('직전 실험과 안내를 복원했습니다.'); });
$$('[data-lesson]').forEach(button => button.addEventListener('click', () => startLesson(button.dataset.lesson)));
$('#guide-next').addEventListener('click', guideNext); $('#guide-restart').addEventListener('click', () => { if (guide) startLesson(guide.id); }); $('#guide-exit').addEventListener('click', () => { guide = null; syncControls(); refresh(false); });
$('#guide-play').addEventListener('click', () => { toggle(); if (running) returnToScene(); });
$('#play').addEventListener('click', toggle); $('#step').addEventListener('click', () => { if (busy) return; stop(); advance(Number($('#step-duration').value)); refresh(true); saveLocal(); });
$('#playback-rate').addEventListener('change', event => { playbackRate = normalizePlaybackRate(Number(event.target.value)); syncPlayback(); scheduleSave(); });
$$('[data-mode]').forEach(button => button.addEventListener('click', () => { view.mode = button.dataset.mode; syncControls(); refresh(true); scheduleSave(); }));
$$('[data-layer]').forEach(input => input.addEventListener('change', () => { view.layers[input.dataset.layer] = input.checked; refresh(true); scheduleSave(); }));
$('#labels').addEventListener('change', event => { view.labels = event.target.checked; refresh(true); scheduleSave(); }); $('#current-arrows').addEventListener('change', event => { view.currentArrows = event.target.checked; refresh(true); scheduleSave(); });
$('#explode').addEventListener('input', event => { view.explode = Number(event.target.value); refresh(true); scheduleSave(); });
$('#part-select').addEventListener('change', event => { view.selectedPart = event.target.value; refresh(true); scheduleSave(); }); $('#focus-part').addEventListener('click', () => { scene?.focusPart(view.selectedPart); returnToScene(); });
$$('[data-camera]').forEach(button => button.addEventListener('click', () => scene?.resetCamera(button.dataset.camera))); $('#focus').addEventListener('click', toggleFocus);
$('#plot-window').addEventListener('change', () => refresh(false)); $('#pin-comparison').addEventListener('click', () => pinComparison()); $('#clear-comparison').addEventListener('click', () => { comparison = null; refresh(false); scheduleSave(); });
$('#save-project').addEventListener('click', saveFile); $('#open-project').addEventListener('click', openFile);
$('#project-file').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file || busy) return; stop(); setBusy(true); try { if (file.size > 10 * 1024 * 1024) throw new Error('실험 파일은 10 MiB 이하여야 합니다.'); const saved = parseProject(await file.text()); remember(); readProject(saved); toast('저장한 실험을 일시정지 상태로 복원했습니다.'); } catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { event.target.value = ''; setBusy(false); } });
$('#recover-original').addEventListener('click', () => { if (recoveredRaw !== null) browserDownload(recoveredRaw, 'motor-lab-original.txt', 'text/plain;charset=utf-8'); });
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
desktop?.onCommand(command => { if (busy) return; if (command === 'new-project') newExperiment(); else if (command === 'open-project') openFile(); else if (command === 'save-project') saveFile(); else if (command === 'toggle-running') toggle(); else if (command === 'focus') toggleFocus(); else if (command === 'help') { stop(); $('#help-dialog').showModal(); } });
window.addEventListener('keydown', event => { if (event.code !== 'Space' || event.repeat || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.target.isContentEditable || event.target.closest('input,select,textarea,button,summary,dialog,[contenteditable=true]')) return; event.preventDefault(); toggle(); });
window.addEventListener('beforeunload', saveLocal); document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); saveLocal(); } });
window.motorLab = {
  getState: () => structuredClone({ state, snapshot, view, playbackRate, running, trace, comparison }),
  project: () => structuredClone(capture()), loadProject: contents => { const saved = parseProject(contents); readProject(saved); return structuredClone(capture()); },
  step: seconds => { stop(); advance(seconds); refresh(true); saveLocal(); return structuredClone({ state, snapshot }); },
  sceneDebug: () => scene?.getDebug() ?? null, guide: () => structuredClone(guide),
};
function frame(now) {
  if (running && !busy) {
    try {
      const elapsed = Math.max(0, now - lastFrame) / 1000 * playbackRate;
      if (elapsed > MAX_STEP_SECONDS) { stop(); toast('긴 대기 후 실험을 일시정지했습니다. 재생으로 이어가세요.'); }
      else { advance(elapsed); scene?.update(snapshot, view); if (now - lastReadout >= 80 || !running) { refresh(false); lastReadout = now; } if (now - lastAutosave >= 1000) { saveLocal(); lastAutosave = now; } }
    } catch (error) { stop(); toast(`계산을 일시정지했습니다. ${error.message}`); }
  }
  lastFrame = now; requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
