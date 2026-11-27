const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  const { parseProject } = await import('../src/project.js');
  try {
    const project = parseProject(workerData);
    parentPort.postMessage({ project });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
})().catch(error => { throw error; });
