import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { PerspectiveCamera, Vector3 } from 'three';
import { COMPONENTS, GEOMETRY_SI } from '../src/geometry.js';

// Focused real-browser acceptance for consumer part observation, not a second
// physics or installer suite. Run serially with the other GPU/native checks.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output/consumer-scene');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5212, strictPort: true, hmr: false } });
const hardware = process.env.MOTOR_BROWSER_HARDWARE === '1';
let browser, context, page, failure, gpu;
const checks = [], errors = [], evidence = [];
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const debug = () => page.evaluate(() => window.motorLab.sceneDebug());
const state = () => page.evaluate(() => window.motorLab.getState().state);
const physical = value => Object.fromEntries(['drawnRotorAngleRad', 'commutation', 'brushWorldCenters', 'segmentContacts', 'coilLeads', 'externalLeads'].map(key => [key, value[key]]));
const choose = id => page.locator('#part-select').selectOption(id);
const capture = async name => {
  // Real paint frames, so a resize capture cannot be a blank unpainted canvas.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('#scene').screenshot({ path: path.join(output, `${name}.png`) });
  evidence.push({ name, debug: await debug() });
};
async function selectedLabel(id) {
  const name = COMPONENTS.find(part => part.id === id).name;
  const label = page.locator('.motor-part-label.is-selected', { hasText: name });
  assert.ok(await label.isVisible(), `${id} selected label is absent`);
  const sceneBox = await page.locator('#scene').boundingBox(), labelBox = await label.boundingBox();
  assert.ok(labelBox.x >= sceneBox.x && labelBox.x + labelBox.width <= sceneBox.x + sceneBox.width + .01);
  assert.ok(labelBox.y >= sceneBox.y + 45 && labelBox.y + labelBox.height <= sceneBox.y + sceneBox.height - 35);
  assert.ok((await debug()).labels.length <= 4, 'focus labels should remain limited');
}
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 } }); page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:5212/'); await page.waitForFunction(() => window.motorLab?.sceneDebug()?.ready);
  const originalState = await state(), originalPhysical = physical(await debug());
  await check('real scene starts paused with all physical component groups', async () => {
    const value = await debug(); assert.equal(value.componentCount, 32); assert.ok(value.triangles > 100 && value.drawCalls > 1);
    assert.equal(await page.evaluate(() => window.motorLab.getState().running), false);
    gpu = await page.locator('#scene canvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    if (hardware) assert.match(gpu, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
  });
  await check('explicit segment and negative brush focus retain the selected visible name', async () => {
    for (const id of ['segment-2', 'brush-negative', 'brush-spring-negative']) {
      const camera = (await debug()).camera; await choose(id); assert.deepEqual((await debug()).camera, camera);
      await page.locator('#focus-part').click(); await selectedLabel(id); await capture(id);
    }
  });
  await check('terminal focus frames the actual power box and both raised terminals', async () => {
    for (const id of ['terminal-positive', 'terminal-negative']) {
      await choose(id); await page.locator('#focus-part').click(); await selectedLabel(id);
      const value = await debug(), rect = await page.locator('#scene').boundingBox();
      // The power box is at x=-94 mm; the commutator is at x=-41 mm.
      assert.ok(value.camera.target[0] > -.120 && value.camera.target[0] < -.071, 'focused on commutator instead of power box');
      const camera = new PerspectiveCamera(36, rect.width / rect.height, .0005, 10);
      camera.position.fromArray(value.camera.position); camera.zoom = value.camera.zoom;
      camera.lookAt(new Vector3(...value.camera.target)); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      for (const z of [.025, .040]) {
        const p = new Vector3(-.094, GEOMETRY_SI.terminalContactY, z).project(camera);
        assert.ok(Math.abs(p.x) < .80 && Math.abs(p.y) < .80 && p.z > -1 && p.z < 1, 'terminal outside central observation area');
      }
      await capture(id);
    }
  });
  await check('named presets keep related labels instead of retaining unrelated terminal names', async () => {
    await page.locator('[data-camera="commutator"]').click();
    const labels = (await debug()).labels.map(label => label.id);
    assert.ok(labels.length > 0 && labels.length <= 4); assert.ok(!labels.some(id => id.startsWith('terminal-')));
    await capture('commutator-preset');
    await page.locator('[data-camera="output"]').click();
    assert.ok((await debug()).labels.every(label => ['load-rotor', 'coupling', 'bearing-front'].includes(label.id)));
  });
  await check('narrow resize preserves camera and explicit focus keeps selected names readable', async () => {
    const camera = (await debug()).camera;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual((await debug()).camera, camera);
    for (const id of ['terminal-negative', 'segment-2', 'brush-negative']) {
      const before = (await debug()).camera; await choose(id); assert.deepEqual((await debug()).camera, before);
      await page.locator('#focus-part').click(); await selectedLabel(id); await capture(`narrow-${id}`);
    }
  });
  await check('observation fixes leave state and actual contact geometry unchanged', async () => {
    assert.deepEqual(await state(), originalState); assert.deepEqual(physical(await debug()), originalPhysical);
    assert.deepEqual(errors, []);
  });
} catch (error) {
  failure = error;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error.stack);
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', checks, gpu, errors, evidence, failure: failure ? { message: failure.message, stack: failure.stack } : null }, null, 2));
  await context?.close(); await browser?.close(); await server.close();
}
if (failure) process.exitCode = 1;
