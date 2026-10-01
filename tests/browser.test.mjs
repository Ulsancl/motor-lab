import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createExperiment, step, reconfigureExperiment } from '../src/model.js';
import { createProject, serializeProject } from '../src/project.js';
import { sampleCommutation } from '../src/geometry.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/browser-integration');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5210, strictPort: true } }); await server.listen();
const hardware = process.env.MOTOR_BROWSER_HARDWARE === '1';
const browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const page = await context.newPage(), checks = [], errors = [], externalRequests = [];
page.setDefaultTimeout(20000);
function watch(p) { p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); p.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== '127.0.0.1') externalRequests.push(r.url()); }); }
watch(page);
const current = () => page.evaluate(() => window.motorLab.getState());
const project = () => page.evaluate(() => window.motorLab.project());
const guide = () => page.evaluate(() => window.motorLab.guide());
const advance = seconds => page.evaluate(dt => window.motorLab.step(dt), seconds);
const load = value => page.evaluate(raw => window.motorLab.loadProject(raw), serializeProject(value));
const choose = id => page.locator(`[data-lesson="${id}"]`).click();
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
let gpu, failure;
try {
  await page.goto('http://127.0.0.1:5210/'); await page.waitForFunction(() => window.motorLab?.sceneDebug()?.ready);
  await check('32-part cutaway starts paused with offline assets and a real WebGL scene', async () => {
    const initial = await current(), debug = await page.evaluate(() => window.motorLab.sceneDebug());
    assert.equal(initial.running, false); assert.equal(initial.state.timeS, 0); assert.equal(debug.componentCount, 32);
    assert.ok(debug.triangles > 100 && debug.drawCalls > 1); near(debug.drawnRotorAngleRad, initial.state.angleRad);
    gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: !!gl, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) }; });
    if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
  });
  await check('model rotation and finite brush contacts update while brushes stay fixed', async () => {
    await load(createProject({ state: createExperiment({ voltageV: 12 }) }));
    const before = await current(), geometry = await page.evaluate(() => window.motorLab.sceneDebug());
    await advance(.2); const after = await current(), debug = await page.evaluate(() => window.motorLab.sceneDebug());
    assert.deepEqual(after.state, step(before.state, .2).state); near(debug.drawnRotorAngleRad, after.state.angleRad);
    assert.deepEqual(debug.commutation, sampleCommutation(after.state.angleRad)); assert.deepEqual(debug.brushWorldCenters, geometry.brushWorldCenters);
    assert.equal(debug.coilLeads.length, 6); assert.ok(after.trace.length > 10);
  });
  await check('voltage edits preserve state and distinguish short-circuit braking from regeneration', async () => {
    await load(createProject({ state: step(createExperiment({ voltageV: 12 }), 3).state }));
    const before = (await current()).state;
    await page.locator('#load').fill('50'); await page.locator('#apply-settings').click();
    assert.deepEqual((await current()).state, reconfigureExperiment(before, { loadCoefficient: .0005 }));
    await page.locator('#zero-voltage').click(); const initial = (await current()).state; await advance(.01);
    const after = (await current()).state; assert.deepEqual(after, step(initial, .01).state); assert.ok(after.currentA < 0); assert.ok(after.omegaRadS > 0);
    assert.equal((await current()).snapshot.powerW.supply, 0);
    await load(createProject({ state: step(createExperiment({ voltageV: 12 }), 3).state }));
    await page.locator('#voltage').fill('3'); await page.locator('#apply-settings').click(); await advance(.01);
    assert.ok((await current()).snapshot.powerW.supply < 0); assert.match(await page.locator('#power-supply').textContent(), /^-/);
  });
  await check('voltage lesson compares equal three-second starts and freezes its actual completion evidence', async () => {
    await choose('startup'); await advance(0); assert.equal((await guide()).stage, 0);
    await advance(30); assert.equal((await current()).state.timeS, 3); assert.equal((await guide()).stage, 1);
    await advance(1); await page.locator('#play').click(); assert.equal((await current()).running, false); assert.equal((await current()).state.timeS, 3);
    await page.locator('#guide-next').click(); const second = await current(); assert.equal(second.state.timeS, 0); assert.equal(second.comparison.state.timeS, 3);
    await page.locator('#pin-comparison').click(); await page.locator('#clear-comparison').click();
    await advance(3); assert.equal((await guide()).status, 'completed'); const end = await current(); near(end.state.omegaRadS, (await guide()).evidence.comparison.state.omegaRadS * 2, 1e-7);
    assert.equal((await guide()).evidence.comparison.state.settings.voltageV, 6); assert.equal((await guide()).evidence.comparison.state.timeS, 3);
    const result = await page.locator('#guide-result').textContent(); await page.locator('#zero-voltage').click(); await advance(.1); await page.locator('#pin-comparison').click();
    assert.equal(await page.locator('#guide-result').textContent(), result); assert.equal((await guide()).evidence.state.timeS, 3);
  });
  await check('load lesson changes a moving motor continuously and observes lower speed with higher current', async () => {
    await choose('load'); await advance(3); const before = (await current()).state;
    await page.locator('#guide-next').click(); const after = (await current()).state;
    assert.deepEqual(after, reconfigureExperiment(before, { loadCoefficient: .0005 }));
    await advance(3); const end = await current(); assert.equal((await guide()).status, 'completed'); assert.equal(end.state.timeS, 6);
    assert.ok(end.state.omegaRadS < before.omegaRadS && end.state.currentA > before.currentA); assert.equal(end.comparison.state.timeS, 3);
  });
  await check('locked-shaft lesson resolves the two-millisecond RL rise with zero shaft work', async () => {
    await choose('locked'); await advance(.002); const transient = await current();
    near(transient.state.currentA, 6 * (1 - Math.exp(-1)), 1e-10); assert.equal(transient.state.omegaRadS, 0); assert.equal((await guide()).status, 'active');
    await advance(1); const end = await current(); near(end.state.timeS, .01); assert.equal((await guide()).status, 'completed');
    assert.equal(end.snapshot.powerW.load, 0); assert.equal(end.state.energyJ.load, 0); assert.ok(end.state.energyJ.copper > 0);
  });
  await check('manual conditions interrupt active guidance and undo restores the entire previous observation', async () => {
    await choose('startup'); await advance(.1); await page.locator('#voltage').fill('8'); await page.locator('#apply-settings').click(); assert.equal((await guide()).status, 'interrupted');
    const before = await project(), previousGuide = await guide(); await page.locator('#new-project').click(); assert.equal((await current()).state.timeS, 0);
    await page.locator('#undo-new').click(); assert.deepEqual((await project()).state, before.state); assert.deepEqual((await project()).trace, before.trace); assert.deepEqual(await guide(), previousGuide);
  });
  await check('pause freezes physics and redraws the final numerical readout without continuous scene rendering', async () => {
    await page.locator('#guide-exit').click(); await page.locator('#play').click(); await page.waitForFunction(() => window.motorLab.getState().state.timeS > .15);
    await page.locator('#play').click(); const before = await current(); await page.waitForTimeout(150); assert.deepEqual((await current()).state, before.state);
    near(Number((await page.locator('#current').innerText()).replace(/[^0-9.\-]/g, '')), before.state.currentA, .00051);
    const frames = await page.evaluate(() => window.motorLab.sceneDebug().renderFrame); await page.waitForTimeout(160); assert.equal(await page.evaluate(() => window.motorLab.sceneDebug().renderFrame), frames);
  });
  await check('native disclosure keyboard actions do not toggle playback and repeated Space is ignored', async () => {
    await page.locator('.energy-details > summary').focus(); const before = await page.locator('.energy-details').evaluate(el => el.open); await page.keyboard.press('Space'); assert.equal(await page.locator('.energy-details').evaluate(el => el.open), !before); assert.equal((await current()).running, false);
    await page.locator('h1').click(); await page.evaluate(() => document.activeElement.blur()); await page.keyboard.down('Space'); await page.keyboard.down('Space'); assert.equal((await current()).running, true); await page.keyboard.up('Space'); await page.keyboard.press('Space'); assert.equal((await current()).running, false);
  });
  await check('part selection preserves camera; explicit focus and structural layers are reversible', async () => {
    const camera = (await project()).observation.camera;
    await page.locator('#part-select').selectOption('brush-positive'); assert.deepEqual((await project()).observation.camera, camera);
    await page.locator('#focus-part').click(); assert.notDeepEqual((await project()).observation.camera, camera);
    for (const mode of ['assembled', 'exploded', 'cutaway']) await page.locator(`[data-mode="${mode}"]`).click();
    for (const layer of ['housing', 'magnets', 'windings', 'contacts', 'field']) { const input = page.locator(`[data-layer="${layer}"]`); const old = await input.isChecked(); await input.setChecked(!old); await input.setChecked(old); }
    assert.match(await page.locator('[data-layer="windings"]').locator('..').innerText(), /권선·절연/);
    await page.locator('[data-layer="windings"]').uncheck();
    const visible = await page.evaluate(() => window.motorLab.sceneDebug().visibleParts);
    assert.ok(visible.includes('armature-core')); assert.equal(visible.includes('coil-a'), false); assert.equal(visible.includes('slot-insulation'), false);
    await page.locator('[data-layer="windings"]').check();
    await page.locator('#reset-camera').click();
    const width = (await page.locator('#scene').boundingBox()).width;
    await page.locator('#focus').click(); assert.equal(await page.locator('.controls').isVisible(), false); assert.ok((await page.locator('#scene').boundingBox()).width > width);
    await page.locator('#focus').click(); assert.equal(await page.locator('.controls').isVisible(), true);
  });
  await check('guide playback and explicit part focus return small-window users to the scene; notifications can be dismissed', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#new-project').click(); assert.equal(await page.locator('#toast').isVisible(), true);
    const untouched = (await current()).state; await page.getByRole('button', { name: '알림 닫기' }).click();
    assert.equal(await page.locator('#toast').isVisible(), false); assert.deepEqual((await current()).state, untouched);
    await choose('startup'); assert.equal((await current()).running, false); assert.equal(await page.locator('#guide-play').isVisible(), true);
    await page.locator('#guide-play').click(); await page.waitForFunction(() => window.motorLab.getState().state.timeS > .03);
    await page.waitForFunction(() => { const rect = document.querySelector('#scene').getBoundingClientRect(); return rect.top >= -1 && rect.bottom <= innerHeight + 1; });
    await page.locator('#play').click(); await advance(30); assert.equal((await guide()).stage, 1); assert.equal(await page.locator('#guide-play').isVisible(), false);
    await page.locator('#guide-next').click(); assert.equal(await page.locator('#guide-play').isVisible(), true);
    await page.locator('#part-select').selectOption('terminal-negative'); const before = (await current()).state;
    await page.locator('#focus-part').click();
    await page.waitForFunction(() => { const rect = document.querySelector('#scene').getBoundingClientRect(); return rect.top >= -1 && rect.bottom <= innerHeight + 1; });
    assert.deepEqual((await current()).state, before);
    await page.setViewportSize({ width: 1600, height: 1100 }); await page.locator('#guide-exit').click();
  });
  await check('download, validated import, reload and comparison records preserve exact experiment state', async () => {
    await page.locator('#pin-comparison').click(); const saved = await project();
    const downloading = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await downloading; const filename = path.join(output, 'saved.motor.json'); await download.saveAs(filename);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), saved);
    await page.locator('#new-project').click(); await page.locator('#project-file').setInputFiles(filename);
    await page.waitForFunction(expected => JSON.stringify(window.motorLab.getState().state) === JSON.stringify(expected), saved.state);
    assert.deepEqual((await project()).state, saved.state); assert.deepEqual((await project()).trace, saved.trace); assert.deepEqual((await project()).comparison, saved.comparison); assert.equal(await guide(), null);
    await page.reload(); await page.waitForFunction(() => window.motorLab?.sceneDebug()?.ready); assert.deepEqual((await project()).state, saved.state); assert.deepEqual((await project()).trace, saved.trace);
    const before = await project(); for (const raw of ['{bad JSON', JSON.stringify({ ...before, schemaVersion: 99 })]) { const message = await page.evaluate(text => { try { window.motorLab.loadProject(text); return ''; } catch (e) { return e.message; } }, raw); assert.ok(message.includes('원본')); assert.deepEqual((await project()).state, before.state); }
  });
  await check('future automatic-save originals remain byte-for-byte protected and exportable', async () => {
    const isolated = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
    const other = await isolated.newPage(); watch(other); const raw = '\ufeff{"type":"motor-lab-project","schemaVersion":99,"untouched":"한글"}';
    await other.addInitScript(value => { if (location.hostname === '127.0.0.1') localStorage.setItem('motor-lab-project-v1', value); }, raw);
    await other.goto('http://127.0.0.1:5210/'); await other.waitForFunction(() => window.motorLab?.project && !document.querySelector('#storage-recovery').hidden);
    await other.locator('#step').click(); assert.equal(await other.evaluate(() => localStorage.getItem('motor-lab-project-v1')), raw);
    const downloading = other.waitForEvent('download'); await other.locator('#recover-original').click(); const download = await downloading; const filename = path.join(output, 'protected-original.txt'); await download.saveAs(filename); assert.equal(await fs.readFile(filename, 'utf8'), raw);
    await isolated.close(); await page.locator('#new-project').click();
  });
  await check('desktop and narrow views keep essential controls reachable with no horizontal overflow', async () => {
    for (const width of [1600, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 }); await page.locator('#reset-camera').click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(overflow <= 1, `horizontal overflow ${overflow} at ${width}`);
      for (const id of ['voltage', 'load', 'apply-settings', 'play', 'step', 'save-project', 'part-select']) assert.ok(await page.locator(`#${id}`).isVisible());
      await page.screenshot({ path: path.join(output, `motor-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1600, height: 1100 }); await page.locator('#reset-camera').click();
    for (const camera of ['iso', 'commutator', 'front', 'output']) { await page.locator(`[data-camera="${camera}"]`).click(); await page.locator('#scene').screenshot({ path: path.join(output, `scene-${camera}.png`) }); }
    await page.locator('[data-mode="exploded"]').click(); await page.locator('#reset-camera').click(); await page.locator('#scene').screenshot({ path: path.join(output, 'scene-exploded.png') });
  });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failure = error; await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, externalRequests, diagnostic: await current().catch(() => null) }, null, 2));
  console.error(error.stack);
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', checks, gpu, errors, externalRequests }, null, 2));
  await context.close(); await browser.close(); await server.close();
}
if (failure) process.exitCode = 1;
