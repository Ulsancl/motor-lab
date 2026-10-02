import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createExperiment, reconfigureExperiment, step } from '../src/model.js';
import { createProject } from '../src/project.js';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'detail-browser'), address = 'http://127.0.0.1:5253';
const checks = [], errors = [], evidence = [], externalRequests = [];
const TAU = 2 * Math.PI, R = 2, L = .004, K = .04, J = .0004, B = .00002;
let server, browser, context, page;
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const vectorNear = (actual, expected, tolerance = 1e-9) => actual.forEach((value, index) => near(value, expected[index], tolerance));
const cameraNear = (actual, expected) => { for (const key of ['position', 'target']) vectorNear(actual[key], expected[key], 1e-10); near(actual.zoom ?? 1, expected.zoom ?? 1, 1e-10); };
const state = () => page.evaluate(() => window.motorLab.getState());
const project = () => page.evaluate(() => window.motorLab.project());
const debug = () => page.evaluate(() => window.motorLab.sceneDebug());
const camera = async () => (await project()).observation.camera;
const guide = () => page.evaluate(() => window.motorLab.guide());
const load = value => page.evaluate(value => window.motorLab.loadProject(JSON.stringify(value)), value);
const fresh = (settings = {}, options = {}) => createProject({ state: createExperiment(settings, options) });
const advance = seconds => page.evaluate(value => window.motorLab.step(value), seconds);
const select = id => page.locator('#part-select').selectOption(id);
const facts = (focus = false) => page.locator(focus ? '#focus-detail-facts .detail-fact' : '#part-detail-facts .detail-fact').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.label, { value: node.dataset.value, unit: node.dataset.unit, text: node.querySelector('dd').textContent.trim() }])));
const rendering = (target = page) => target.evaluate(() => {
  const canvas = document.querySelector('#scene canvas'), gl = canvas?.getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info'), scene = window.motorLab?.sceneDebug();
  return { documentId: window.__detailDocumentId, readyState: document.readyState, contextLost: gl?.isContextLost() ?? true,
    renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER), drawCalls: scene?.drawCalls, triangles: scene?.triangles };
});
async function ready(previousDocumentId = null, target = page) {
  await target.waitForFunction(previous => {
    if (document.readyState !== 'complete' || !window.__detailDocumentId || window.__detailDocumentId === previous || !window.motorLab) return false;
    const canvas = document.querySelector('#scene canvas'), gl = canvas?.getContext('webgl2'), scene = window.motorLab.sceneDebug();
    return !!gl && !gl.isContextLost() && canvas.width > 0 && canvas.height > 0 && scene.ready && scene.drawCalls > 0 && scene.triangles > 0;
  }, previousDocumentId, { polling: 100, timeout: 60000 });
}
function watch(target) {
  target.on('pageerror', error => errors.push({ kind: 'page', message: error.message }));
  target.on('console', message => { if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() }); });
  target.on('requestfailed', request => errors.push({ kind: 'request', message: request.url() + ': ' + request.failure()?.errorText }));
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); await page?.clock.resume().catch(() => {}); evidence.push({ failureRendering: await rendering().catch(() => null) }); await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {}); throw error; }
}
function physicalClosure(current) {
  const { state: s, detail: d } = current, i = s.currentA, w = s.omegaRadS, C = s.settings.loadCoefficient;
  near(d.electrical.sourceV, s.settings.voltageV); near(d.electrical.resistiveV, R * i); near(d.electrical.backEmfV, K * w);
  near(d.electrical.inductiveV, s.settings.voltageV - R * i - K * w); near(d.electrical.currentRateAps, (s.settings.voltageV - R * i - K * w) / L, 1e-7); near(d.electrical.residualV, 0, 1e-10);
  near(d.mechanical.electromagneticNm, K * i); near(d.mechanical.frictionNm, -B * w); near(d.mechanical.loadNm, -C * w);
  const freeTorque = K * i - (B + C) * w;
  near(d.mechanical.constraintNm, s.locked ? -freeTorque : 0); near(d.mechanical.netNm, s.locked ? 0 : freeTorque); near(d.mechanical.accelerationRadS2, s.locked ? 0 : freeTorque / J, 1e-7); near(d.mechanical.residualNm, 0, 1e-10);
  near(d.power.supplyW, s.settings.voltageV * i); near(d.power.copperW, R * i * i); near(d.power.frictionW, B * w * w); near(d.power.loadW, C * w * w);
  near(d.power.magneticStorageW, L * i * d.electrical.currentRateAps); near(d.power.kineticStorageW, J * w * d.mechanical.accelerationRadS2);
  near(d.power.supplyW, d.power.copperW + d.power.frictionW + d.power.loadW + d.power.magneticStorageW + d.power.kineticStorageW, 1e-8);
  near(d.power.residualW, 0, 1e-8); near(d.power.electricalResidualW, 0, 1e-8); near(d.power.mechanicalResidualW, 0, 1e-8);
}

try {
  await mkdir(output, { recursive: true }); await rm(path.join(output, 'failure.png'), { force: true });
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5253, strictPort: true, hmr: false, watch: null } }); await server.listen();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.exposeBinding('__reportDetailContextLoss', (_source, message) => errors.push({ kind: 'webgl', message }));
  await context.addInitScript(() => { window.__detailDocumentId = crypto.randomUUID(); document.addEventListener('webglcontextlost', event => window.__reportDetailContextLoss(event.statusMessage || 'WebGL context lost'), true); });
  page = await context.newPage(); page.setDefaultTimeout(30000); watch(page);
  const origin = new Date('2026-10-02T00:00:00Z'); await page.clock.install({ time: origin });
  await page.goto(address, { waitUntil: 'commit', timeout: 60000 }); await ready(); assert.equal((await state()).running, false);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60000)); evidence.push({ initialRendering: await rendering() });

  await check('All motor components render real WebGL and expose details without changing state or saved camera', async () => {
    const before = await state(), beforeCamera = await camera(), scene = await debug();
    assert.equal(before.running, false); assert.equal(before.state.modelVersion, 'motor-dc-average-1'); assert.ok(scene.drawCalls > 0 && scene.triangles > 0);
    const components = await page.evaluate(() => window.motorLab.components()); assert.equal(components.length, 32);
    for (const part of components) {
      await select(part.id); const current = await state(), rows = await facts();
      assert.equal(current.view.selectedPart, part.id); assert.deepEqual(current.state, before.state); assert.deepEqual(current.trace, before.trace); cameraNear(await camera(), beforeCamera);
      assert.ok(Object.keys(rows).length > 0 && Object.keys(rows).length <= 6, part.id);
      for (const row of Object.values(rows)) { assert.ok(row.text, part.id); assert.doesNotMatch(row.text, /NaN|Infinity|undefined/); }
      assert.ok((await page.locator('#part-detail-note').textContent()).trim(), part.id);
    }
  });

  await check('The physical voltage and signed torque decomposition obey the fixed R-L and inertia equations', async () => {
    for (const example of [fresh({ voltageV: 12 }), createProject({ state: step(createExperiment({ voltageV: 12, loadCoefficient: .0005 }), .035).state }), fresh({ voltageV: 12 }, { locked: true })]) {
      await load(example); physicalClosure(await state()); await advance(.002); physicalClosure(await state());
    }
    await load(fresh({ voltageV: 12 }, { locked: true })); const start = await state(); near(start.detail.electrical.currentRateAps, 3000); near(start.detail.mechanical.accelerationRadS2, 0);
    await advance(.002); const rise = await state(); near(rise.state.currentA, 6 * (1 - Math.exp(-1)), 1e-10); near(rise.state.omegaRadS, 0);
    near(rise.detail.mechanical.constraintNm, -K * rise.state.currentA); near(rise.snapshot.powerW.load, 0); near(rise.state.energyJ.load, 0);
    evidence.push({ lockedRise: rise.detail });
  });

  await check('Zero-volt electric braking and positive-voltage regeneration retain distinct signed supply power', async () => {
    const spinning = step(createExperiment({ voltageV: 12 }), 3).state;
    await load(createProject({ state: spinning })); await page.locator('#zero-voltage').click();
    const applied = await state(); near(applied.state.currentA, spinning.currentA); near(applied.state.omegaRadS, spinning.omegaRadS); assert.deepEqual(applied.state.energyJ, spinning.energyJ);
    await advance(.01); const braking = await state(); physicalClosure(braking);
    assert.ok(braking.state.currentA < 0 && braking.state.omegaRadS > 0); near(braking.snapshot.powerW.supply, 0); assert.ok(braking.detail.mechanical.electromagneticNm < 0);
    await load(createProject({ state: spinning })); await page.locator('#voltage').fill('3'); await page.locator('#apply-settings').click(); await advance(.01);
    const regen = await state(); physicalClosure(regen); assert.ok(regen.state.currentA < 0 && regen.snapshot.powerW.supply < 0);
    near(regen.snapshot.powerW.supply, 3 * regen.state.currentA); assert.ok(regen.snapshot.powerW.copper > 0 && regen.snapshot.powerW.friction > 0);
    evidence.push({ shortCircuit: braking.detail, regeneration: regen.detail });
  });

  await check('Steady-state observations solve the same equations and remain distinct from the current transient', async () => {
    for (const [voltageV, C] of [[0, 0], [6, 0], [12, .0005], [8.25, .000375]]) {
      await load(fresh({ voltageV, loadCoefficient: C })); const d = (await state()).detail;
      const omega = K * voltageV / (R * (B + C) + K * K), current = (B + C) * omega / K;
      near(d.steady.omegaRadS, omega); near(d.steady.currentA, current); near(d.steady.rpm, omega * 60 / TAU, 1e-8); near(d.steady.backEmfV, K * omega); near(d.steady.torqueNm, K * current);
      near((await state()).state.omegaRadS, 0); await advance(30); const settled = await state(); near(settled.state.omegaRadS, omega, 1e-8); near(settled.state.currentA, current, 1e-9);
    }
    await load(fresh({ voltageV: 12 }, { locked: true })); const d = (await state()).detail;
    near(d.steady.currentA, 6); near(d.steady.omegaRadS, 0); near(d.steady.torqueNm, .24);
  });

  await check('Unapplied drafts and playback rate leave physical observations and comparison history unchanged', async () => {
    await load(fresh({ voltageV: 12 })); await advance(.2); await select('coil-a'); await page.locator('#pin-comparison').click();
    const before = await state(), beforeFacts = await facts(), reference = await page.locator('#detail-reference').textContent(), beforeCamera = await camera();
    await page.locator('#voltage').fill('8.25'); await page.locator('#load').fill('37.5');
    for (const rate of ['0.001', '4', '0.1']) {
      await page.locator('#playback-rate').selectOption(rate); await page.clock.runFor(80); const current = await state();
      assert.deepEqual(current.state, before.state); assert.deepEqual(current.detail, before.detail); assert.deepEqual(current.trace, before.trace); assert.deepEqual(current.comparison, before.comparison);
      assert.deepEqual(await facts(), beforeFacts); assert.equal(await page.locator('#detail-reference').textContent(), reference); cameraNear(await camera(), beforeCamera);
    }
    await page.locator('#apply-settings').click(); const changed = await state();
    near(changed.state.settings.voltageV, 8.25); near(changed.state.settings.loadCoefficient, .000375);
    for (const key of ['timeS', 'angleRad', 'currentA', 'omegaRadS']) near(changed.state[key], before.state[key]); assert.deepEqual(changed.state.energyJ, before.state.energyJ);
    assert.deepEqual(changed.comparison, before.comparison); physicalClosure(changed); near(Number(await page.locator('#voltage').inputValue()), 8.25); near(Number(await page.locator('#load').inputValue()), 37.5);
    for (const selector of ['#applied-settings', '#detail-reference', '#steady-reference-note']) { const text = await page.locator(selector).textContent(); assert.match(text, /8\.25 V/); assert.match(text, /37\.5%/); }
    await load(await project()); near((await state()).state.settings.voltageV, 8.25); near((await state()).state.settings.loadCoefficient, .000375); assert.deepEqual((await state()).comparison, before.comparison);
  });

  await check('Voltage, torque and storage bars display signed physical quantities rather than playback-scaled values', async () => {
    const spinning = step(createExperiment({ voltageV: 12 }), 3).state;
    const scenarios = [fresh({ voltageV: 0 }), fresh({ voltageV: 12 }), createProject({ state: step(createExperiment({ voltageV: 12 }, { locked: true }), .002).state }), createProject({ state: step(reconfigureExperiment(spinning, { voltageV: 0 }), .01).state }), createProject({ state: step(reconfigureExperiment(spinning, { voltageV: 3 }), .01).state })];
    for (const example of scenarios) {
      await load(example); const current = await state(), d = current.detail;
      const groups = {
        voltage: { source: d.electrical.sourceV, resistance: d.electrical.resistiveV, emf: d.electrical.backEmfV, induction: d.electrical.inductiveV },
        torque: { electromagnetic: d.mechanical.electromagneticNm * 1000, friction: d.mechanical.frictionNm * 1000, load: d.mechanical.loadNm * 1000, constraint: d.mechanical.constraintNm * 1000, net: d.mechanical.netNm * 1000 },
      };
      for (const [prefix, values] of Object.entries(groups)) for (const [id, expected] of Object.entries(values)) {
        const bar = page.locator(`#${prefix}-bar-${id}`), output = page.locator(`#${prefix}-value-${id}`), scale = Math.max(...Object.values(values).map(Math.abs), 1e-12);
        near(Number(await bar.getAttribute('data-value')), expected); near(Number(await output.getAttribute('data-value')), expected); near(Number(await bar.getAttribute('data-scale')), scale);
        near(await bar.evaluate(node => Number.parseFloat(node.style.width)), Math.abs(expected) / scale * 50, 1e-4);
        assert.doesNotMatch(await output.textContent(), /NaN|Infinity|undefined|^-0(?:\.0+)?(?:\s|$)/);
      }
      near(Number(await page.locator('#current-rate').getAttribute('data-value')), d.electrical.currentRateAps);
      near(Number(await page.locator('#angular-acceleration').getAttribute('data-value')), d.mechanical.accelerationRadS2);
      near(Number(await page.locator('#storage-magnetic-rate').getAttribute('data-value')), L * current.state.currentA * d.electrical.currentRateAps);
      near(Number(await page.locator('#storage-kinetic-rate').getAttribute('data-value')), J * current.state.omegaRadS * d.mechanical.accelerationRadS2);
      near(Number(await page.locator('#steady-current').getAttribute('data-value')), d.steady.currentA); near(Number(await page.locator('#steady-rpm').getAttribute('data-value')), d.steady.rpm); near(Number(await page.locator('#steady-emf').getAttribute('data-value')), d.steady.backEmfV);
    }
  });

  await check('Brush footprint and overlap derive from finite copper geometry while brush locations stay fixed', async () => {
    const nominalArea = .008 * .01 * 12 * Math.PI / 180, bridgeArea = .008 * .01 * 10 * Math.PI / 180;
    for (const angle of [Math.PI / 2, Math.PI / 6]) {
      await load(fresh({ voltageV: 12 }, { angleRad: angle })); const contact = (await state()).detail.contact;
      near(contact.nominalAreaM2, nominalArea); near(contact.surfaceVelocityMps, 0); near(contact.passesPerBrushHz, 0);
      const single = angle === Math.PI / 2 ? contact.positive : contact.negative, bridged = angle === Math.PI / 2 ? contact.negative : contact.positive;
      assert.equal(single.contacts.length, 1); near(single.copperAreaM2, nominalArea); assert.equal(bridged.contacts.length, 2); near(bridged.copperAreaM2, bridgeArea);
      for (const brush of [contact.positive, contact.negative]) near(brush.contacts.reduce((sum, c) => sum + c.areaM2, 0), brush.copperAreaM2);
      const centers = (await debug()).brushWorldCenters; await advance(.1); const current = await state();
      assert.deepEqual((await debug()).brushWorldCenters, centers); near(current.detail.contact.surfaceVelocityMps, .01 * current.state.omegaRadS);
      near(current.detail.contact.passesPerBrushHz, Math.abs(current.state.omegaRadS) * 3 / TAU);
    }
  });

  await check('Detail selection and explicit focus preserve saved traces, comparisons and a manually orbited camera', async () => {
    await load(fresh({ voltageV: 12 })); await advance(.15); await page.locator('#pin-comparison').click();
    const before = await state(), startCamera = await camera();
    await page.locator('#scene canvas').evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' }));
    const box = await page.locator('#scene canvas').boundingBox();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .45); await page.mouse.down(); await page.mouse.move(box.x + box.width * .57, box.y + box.height * .56, { steps: 8 }); await page.mouse.up(); await page.clock.runFor(80);
    const manual = await camera(); assert.notDeepEqual(manual, startCamera);
    for (const id of ['brush-positive', 'coil-b', 'bearing-front', 'load-rotor']) { await select(id); cameraNear(await camera(), manual); const current = await state(); assert.deepEqual(current.state, before.state); assert.deepEqual(current.trace, before.trace); assert.deepEqual(current.comparison, before.comparison); }
    await select('bearing-front'); await page.locator('#focus-part').click(); const focusedCamera = await camera(); assert.notDeepEqual(focusedCamera, manual);
    const saved = await project(); await page.clock.runFor(300); const downloadEvent = page.waitForEvent('download'); await page.locator('#save-project').click();
    const filename = path.join(output, 'detail-observation.motor.json'); await (await downloadEvent).saveAs(filename); assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), saved);
    await page.locator('#new-project').click(); await page.locator('#project-file').setInputFiles(filename); await page.clock.runFor(100);
    assert.deepEqual(await project(), saved); cameraNear(await camera(), focusedCamera); await page.clock.runFor(300);
    assert.equal((await state()).running, false); const previousDocumentId = await page.evaluate(() => window.__detailDocumentId);
    await page.clock.resume(); await page.reload({ waitUntil: 'commit', timeout: 60000 }); await ready(previousDocumentId); assert.equal((await state()).running, false);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60000)); assert.deepEqual(await project(), saved); cameraNear(await camera(), focusedCamera);
    evidence.push({ reloadRendering: await rendering(), previousDocumentId });
  });

  await check('Guided completion and new-experiment undo retain independent evidence while current details stay live', async () => {
    await page.locator('[data-lesson="load"]').click(); await advance(3); const stageOne = await guide(); assert.equal(stageOne.stage, 1);
    await select('bearing-rear'); await page.locator('#focus-part').click(); assert.deepEqual(await guide(), stageOne);
    await page.locator('#inspect-part').click(); const phaseBeforeLoad = (await debug()).rotationIntegralRad;
    await page.locator('#guide-next').click(); near((await debug()).rotationIntegralRad, phaseBeforeLoad); assert.equal((await state()).inspection.id, 'bearing-rear');
    await advance(3); const done = await guide(); assert.equal(done.status, 'completed');
    const result = await page.locator('#guide-result').textContent(), saved = await project(), d = (await state()).detail;
    await select('terminal-positive'); assert.deepEqual(await guide(), done); assert.equal(await page.locator('#guide-result').textContent(), result);
    await page.locator('#zero-voltage').click(); await advance(.01); assert.deepEqual(await guide(), done); assert.equal(await page.locator('#guide-result').textContent(), result); assert.notDeepEqual((await state()).detail, d);
    const previous = await project(), previousDetail = (await state()).detail; await page.locator('#new-project').click(); await page.locator('#undo-new').click();
    assert.deepEqual(await project(), previous); assert.deepEqual(await guide(), done); assert.deepEqual((await state()).detail, previousDetail); assert.deepEqual((await project()).comparison, saved.comparison);
    await page.locator('[data-lesson="startup"]').click(); await advance(3); await select('bearing-front'); await page.locator('#inspect-part').click();
    assert.ok((await debug()).rotationIntegralRad > TAU); await page.locator('#guide-next').click();
    assert.equal((await state()).inspection, null); near((await debug()).rotationIntegralRad, 0); near((await state()).state.timeS, 0);
  });

  await check('Selected terminal, coil, shaft and brush facts preserve their physical meaning and display units', async () => {
    const spun = step(createExperiment({ voltageV: 12, loadCoefficient: .0005 }), .3).state;
    await load(createProject({ state: spun })); const current = await state(), d = current.detail;
    await select('terminal-positive'); let rows = await facts(); near(Number(rows['적용 단자 전압'].value), 12); near(Number(rows['평균 단자 전류 · +단자 유입 +'].value), spun.currentA);
    near(Number(rows['전원 공급 동력 · 모터 유입 +'].value), 12 * spun.currentA); assert.equal(rows['전원 공급 동력 · 모터 유입 +'].unit, 'W');
    near(Number(rows['인덕턴스 전압'].value), 12 - R * spun.currentA - K * spun.omegaRadS);
    for (const [id, connections] of [['coil-a', 'S0 → S1'], ['coil-b', 'S1 → S2'], ['coil-c', 'S2 → S0']]) {
      await select(id); rows = await facts(); assert.equal(rows['권선의 연결 편'].value, connections); near(Number(rows['전체 전기자 저항'].value), R); assert.equal(rows['전체 전기자 저항'].unit, 'Ω');
      near(Number(rows['전체 전기자 인덕턴스'].value), 4); assert.equal(rows['전체 전기자 인덕턴스'].unit, 'mH'); near(Number(rows['전체 전기자 구리 손실'].value), R * spun.currentA ** 2);
      near(Number(rows['전체 자기 저장 에너지'].value), .5 * L * spun.currentA ** 2 * 1000); assert.equal(rows['전체 자기 저장 에너지'].unit, 'mJ');
      assert.match(await page.locator('#part-detail-note').textContent(), /전체 전기자.*평균/); assert.match(await page.locator('#part-detail-note').textContent(), /권선별.*계산하지/);
    }
    await select('shaft'); rows = await facts(); near(Number(rows['현재 회전수'].value), spun.omegaRadS * 60 / TAU); near(Number(rows['평균 전자기 토크'].value), K * spun.currentA * 1000); assert.equal(rows['평균 전자기 토크'].unit, 'mN·m');
    near(Number(rows['외부 부하 토크 · 부호 포함'].value), -.0005 * spun.omegaRadS * 1000); near(Number(rows['현재 각가속도'].value), d.mechanical.accelerationRadS2);
    for (const [id, branch] of [['brush-positive', 'positive'], ['brush-negative', 'negative']]) {
      await select(id); rows = await facts(); near(Number(rows['구리 접촉 기하 면적'].value), d.contact[branch].copperAreaM2 * 1e6); assert.equal(rows['구리 접촉 기하 면적'].unit, 'mm²');
      near(Number(rows['브러시당 편 통과 빈도'].value), Math.abs(spun.omegaRadS) * 3 / TAU); near(Number(rows['정류자 표면 속도 · +X 회전 +'].value), spun.omegaRadS * .01);
    }
    await load(createProject({ state: step(createExperiment({ voltageV: 12 }, { locked: true }), .002).state })); await select('motor-mount'); rows = await facts();
    near(Number(rows['고정축 구속반력'].value), -K * (await state()).state.currentA * 1000); assert.equal(rows['고정축 구속반력'].unit, 'mN·m');
  });

  await check('Narrow focused facts remain synchronized and native disclosure keys do not start playback', async () => {
    await load(createProject({ state: step(createExperiment({ voltageV: 12 }), .1).state })); await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    await page.locator('#focus').click(); await page.clock.runFor(100); assert.equal((await state()).focused, true);
    const disclosure = page.locator('.focus-detail-panel details'); assert.equal(await disclosure.evaluate(node => node.open), false);
    const beforeCamera = await camera(), before = await state(); await page.locator('#focus-part-select').selectOption('brush-negative'); cameraNear(await camera(), beforeCamera);
    assert.equal((await state()).view.selectedPart, 'brush-negative'); assert.deepEqual((await state()).state, before.state); assert.deepEqual((await state()).trace, before.trace);
    await disclosure.locator('summary').focus(); await page.keyboard.press('Space'); assert.equal(await disclosure.evaluate(node => node.open), true); assert.equal((await state()).running, false);
    assert.deepEqual(await facts(true), await facts()); assert.equal(await page.locator('#focus-detail-note').textContent(), await page.locator('#part-detail-note').textContent()); assert.equal(await page.locator('#focus-detail-reference').textContent(), await page.locator('#detail-reference').textContent());
    await page.locator('#focus-part-inline').click(); assert.notDeepEqual(await camera(), beforeCamera); await advance(.005); assert.deepEqual(await facts(true), await facts());
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, sceneHeight: document.querySelector('#scene').getBoundingClientRect().height }));
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout)); assert.ok(layout.sceneHeight >= 280, JSON.stringify(layout));
    await page.locator('#focus').click(); await page.setViewportSize({ width: 1600, height: 1100 }); await page.clock.runFor(100); evidence.push({ narrowLayout: layout });
  });

  await check('Real-clock motor, brush and bearing closeups show the actual geometry and readable balance observations', async () => {
    const visualContext = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
    await visualContext.exposeBinding('__reportDetailContextLoss', (_source, message) => errors.push({ kind: 'webgl', message }));
    await visualContext.addInitScript(() => { window.__detailDocumentId = crypto.randomUUID(); document.addEventListener('webglcontextlost', event => window.__reportDetailContextLoss(event.statusMessage || 'WebGL context lost'), true); });
    try {
      const visual = await visualContext.newPage(); watch(visual);
      await visual.goto(address, { waitUntil: 'commit', timeout: 60000 }); await ready(null, visual);
      assert.equal(await visual.evaluate(() => window.motorLab.getState().running), false); evidence.push({ visualRendering: await rendering(visual) });
      await visual.evaluate(value => window.motorLab.loadProject(JSON.stringify(value)), createProject({ state: step(createExperiment({ voltageV: 12, loadCoefficient: .0005 }), .1).state }));
      await visual.waitForTimeout(200); await visual.screenshot({ path: path.join(output, 'motor-detail-overview.png'), fullPage: true });
      for (const [id, filename] of [['brush-positive', 'brush-closeup'], ['bearing-front', 'bearing-front-closeup'], ['bearing-rear', 'bearing-rear-closeup'], ['coil-a', 'winding-closeup']]) {
        await visual.locator('#part-select').selectOption(id); await visual.locator(id.startsWith('bearing-') ? '#inspect-part' : '#focus-part').click(); await visual.waitForTimeout(200);
        await visual.locator('.workbench').screenshot({ path: path.join(output, `${filename}.png`) });
      }
      await visual.setViewportSize({ width: 390, height: 844 }); await visual.locator('#focus').click(); await visual.locator('#focus-part-select').selectOption('bearing-front');
      await visual.locator('#focus-inspect-part').click(); await visual.locator('.focus-detail-panel summary').click(); await visual.waitForTimeout(200);
      await visual.screenshot({ path: path.join(output, 'narrow-bearing-detail.png'), fullPage: true });
    } finally { await visualContext.close(); }
  });

  await check('Bearing phase consumes each solver interval once, survives complete turns and resets only on explicit experiment restore', async () => {
    const initial = step(createExperiment({ voltageV: 12 }), .2).state;
    await load(createProject({ state: initial })); const start = await debug(); near(start.rotationIntegralRad, initial.angleRad);
    let low = 0, high = .2;
    for (let n = 0; n < 55; n++) { const mid = (low + high) / 2; if (step(initial, mid).interval.angleDeltaRad < TAU) low = mid; else high = mid; }
    const dt = (low + high) / 2, delta = step(initial, dt).interval.angleDeltaRad; near(delta, TAU, 1e-10);
    await advance(dt); let scene = await debug(), current = await state(); near(scene.rotationIntegralRad, initial.angleRad + delta, 1e-9); near(current.state.angleRad, initial.angleRad, 1e-9);
    const verify = (scene, current) => {
      assert.equal(scene.bearings.length, 2);
      for (const bearing of scene.bearings) {
        const { pitchRadiusM: radius, ballRadiusM: ball } = bearing, q = ball / radius, cageRatio = (1 - q) / 2, relativeRatio = -(1 / q - q) / 2, rpm = current.state.omegaRadS * 60 / TAU;
        near(bearing.innerAngle, scene.rotationIntegralRad); near(bearing.cageAngle, scene.rotationIntegralRad * cageRatio); near(bearing.ballRelativeAngle, scene.rotationIntegralRad * relativeRatio); near(bearing.ballWorldAngle, bearing.cageAngle + bearing.ballRelativeAngle);
        near(bearing.innerRpm, rpm); near(bearing.cageRpm, rpm * cageRatio); near(bearing.ballWorldRpm, rpm * (cageRatio + relativeRatio)); near(bearing.outerRpm, 0);
        near(radius * bearing.cageRpm + ball * bearing.ballWorldRpm, 0, 1e-9); near(radius * bearing.cageRpm - ball * bearing.ballWorldRpm, (radius - ball) * rpm, 1e-9);
        near(bearing.innerRotation, current.state.angleRad); near(bearing.cageRotation, bearing.cageAngle); assert.equal(bearing.ballCount, 9); assert.ok(bearing.grooveVertexClearanceM > 0);
        assert.equal(bearing.ballTransforms.length, bearing.visibleBallCount); assert.ok(bearing.visibleBallCount > 0);
        for (const transform of bearing.ballTransforms) {
          const a = transform.index * TAU / 9 + bearing.cageAngle;
          vectorNear(transform.localCenter, [0, radius * Math.cos(a), radius * Math.sin(a)], 1e-8);
          near(Math.hypot(transform.center[1] - bearing.axis[1], transform.center[2] - bearing.axis[2]), radius, 1e-8);
          const spin = 2 * Math.atan2(transform.quaternion[0], transform.quaternion[3]), expectedSpin = transform.index * TAU / 9 + bearing.ballWorldAngle;
          near(Math.sin(spin), Math.sin(expectedSpin), 1e-7); near(Math.cos(spin), Math.cos(expectedSpin), 1e-7);
        }
      }
    };
    verify(scene, current); assert.ok(Math.abs(scene.bearings[0].cageAngle - start.bearings[0].cageAngle) > 2);
    const rotation = scene.rotationIntegralRad;
    await select('bearing-front'); await page.locator('#playback-rate').selectOption('4'); await page.clock.runFor(100);
    await page.evaluate(() => window.advanceTime(0)); near((await debug()).rotationIntegralRad, rotation); verify(await debug(), await state());
    const saved = await project(); await load(saved); scene = await debug(); near(scene.rotationIntegralRad, saved.state.angleRad); verify(scene, await state());
    const reverse = { ...initial, currentA: -initial.currentA, omegaRadS: -initial.omegaRadS, settings: { ...initial.settings, voltageV: 0 } };
    await load(createProject({ state: reverse })); await advance(.005); scene = await debug(); current = await state(); assert.ok(scene.rotationIntegralRad < reverse.angleRad); assert.ok(current.state.omegaRadS < 0); verify(scene, current); physicalClosure(current);
    await load(fresh({ voltageV: 12 }, { locked: true, angleRad: .7 })); await advance(.01); scene = await debug(); near(scene.rotationIntegralRad, .7); verify(scene, await state());
    for (const g of scene.brushGuides) { assert.ok(g.clearanceXM >= .000199 && g.clearanceYM >= .000149, JSON.stringify(g)); }
    await page.locator('[data-mode="assembled"]').click(); for (const b of (await debug()).bearings) assert.equal(b.visibleBallCount, 9);
    evidence.push({ bearingFullTurn: { startAngle: initial.angleRad, intervalDelta: delta, cageAdvance: delta * (1 - start.bearings[0].ballRadiusM / start.bearings[0].pitchRadiusM) / 2 }, lockedBearing: scene.bearings[0] });
  });

  await check('Explicit bearing isolation preserves the project camera through refresh, motion, saving and deliberate return', async () => {
    await load(createProject({ state: step(createExperiment({ voltageV: 12 }), .2).state })); await select('bearing-front');
    await page.locator('#pin-comparison').click(); const before = await state(), savedCamera = await camera(), beforeScene = await debug();
    await page.locator('#inspect-part').click(); let current = await state(), scene = await debug();
    assert.deepEqual(current.inspection, { id: 'bearing-front' }); assert.deepEqual(scene.visibleParts, ['bearing-front']);
    assert.deepEqual(current.state, before.state); assert.deepEqual(current.view, before.view); assert.deepEqual(current.trace, before.trace); assert.deepEqual(current.comparison, before.comparison);
    cameraNear(await camera(), savedCamera); assert.notDeepEqual(scene.camera, beforeScene.camera); assert.ok(scene.camera.zoom > 1);
    const phase = scene.rotationIntegralRad; await page.evaluate(() => window.advanceTime(0)); await page.clock.runFor(100);
    near((await debug()).rotationIntegralRad, phase); cameraNear(await camera(), savedCamera);
    await advance(.01); current = await state(); scene = await debug(); assert.ok(scene.rotationIntegralRad > phase); assert.deepEqual(scene.visibleParts, ['bearing-front']);
    cameraNear(await camera(), savedCamera); assert.deepEqual(current.comparison, before.comparison);
    const b = scene.bearings.find(b => b.id === 'bearing-front'), rows = await facts();
    for (const [label, key] of [['내륜 회전수', 'innerRpm'], ['외륜 회전수', 'outerRpm'], ['케이지 공전 회전수', 'cageRpm'], ['볼 자전 · 고정 좌표 기준', 'ballWorldRpm']]) near(Number(rows[label].value), b[key], 1e-8);
    const saved = await project(), download = page.waitForEvent('download'); await page.locator('#save-project').click();
    const filename = path.join(output, 'bearing-inspection.motor.json'); await (await download).saveAs(filename); assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), saved);
    await page.locator('[data-mode="assembled"]').click(); assert.equal(await page.locator('#explode').isEnabled(), false);
    await page.locator('[data-mode="exploded"]').click(); assert.equal(await page.locator('#explode').isEnabled(), true);
    await page.locator('#explode').focus(); await page.keyboard.press('Home'); for (let n = 0; n < 6; n++) await page.keyboard.press('PageUp');
    await page.locator('#scene canvas').evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' }));
    const box = await page.locator('#scene canvas').boundingBox(); await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45); await page.mouse.down(); await page.mouse.move(box.x + box.width * .56, box.y + box.height * .53, { steps: 6 }); await page.mouse.up();
    cameraNear(await camera(), savedCamera); assert.deepEqual((await debug()).visibleParts, ['bearing-front']);
    await page.locator('#end-inspection').click(); assert.equal((await state()).inspection, null); cameraNear((await debug()).camera, savedCamera); cameraNear(await camera(), savedCamera);
    assert.equal((await state()).view.mode, 'exploded'); near((await state()).view.explode, .6); assert.ok((await debug()).visibleParts.length > 1);
    await page.locator('#inspect-part').click(); await select('shaft'); assert.equal((await state()).inspection, null); cameraNear((await debug()).camera, savedCamera);
    await select('bearing-rear'); await page.locator('#inspect-part').click(); await load(saved); assert.equal((await state()).inspection, null); cameraNear((await debug()).camera, savedCamera);
    await page.locator('#inspect-part').click(); const beforeNew = await project(); await page.locator('#new-project').click(); assert.equal((await state()).inspection, null); near((await debug()).rotationIntegralRad, 0);
    await page.locator('#undo-new').click(); assert.deepEqual(await project(), beforeNew); assert.equal((await state()).inspection, null); near((await debug()).rotationIntegralRad, beforeNew.state.angleRad);
    await page.locator('#inspect-part').click(); await page.locator('#focus-part').click(); assert.equal((await state()).inspection, null); cameraNear((await debug()).camera, await camera());
    await page.locator('#inspect-part').click(); await page.locator('#reset-camera').click(); assert.equal((await state()).inspection, null);
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#focus').click(); await page.locator('#focus-part-select').selectOption('bearing-rear'); const narrowCamera = await camera();
    await page.locator('#focus-inspect-part').click(); assert.deepEqual((await debug()).visibleParts, ['bearing-rear']); cameraNear(await camera(), narrowCamera);
    await page.locator('#end-inspection').click(); assert.equal((await state()).inspection, null); cameraNear((await debug()).camera, narrowCamera);
    await page.locator('#focus').click(); await page.setViewportSize({ width: 1600, height: 1100 });
    evidence.push({ isolatedBearing: b, savedInspectionCamera: savedCamera });
  });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'detail-browser-results.json'), JSON.stringify({ version, renderer: 'Headless Chromium default backend; actual renderer recorded in evidence. Functional geometry evidence, not physical GPU performance.', checks, evidence, errors, externalRequests }, null, 2));
  await context?.close(); await browser?.close(); await server?.close();
}
