import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProjectBytes, readWindowSettings } from '../desktop/bounded-read.cjs';

test('bounded reads handle short chunks and never read beyond the sentinel byte', async () => {
  const stat = { size: 2, dev: 1, ino: 2, isFile: () => true };
  function mockHandle(text) {
    let offset = 0;
    return {
      stat: async () => stat,
      read: async (buffer, start, length) => {
        assert.ok(offset + length <= 5);
        const chunk = text.slice(offset, offset + Math.min(2, length));
        offset += chunk.length;
        return { bytesRead: buffer.write(chunk, start, length) };
      },
    };
  }
  assert.equal((await readProjectBytes(mockHandle('abcd'), 4, stat)).toString(), 'abcd');
  await assert.rejects(readProjectBytes(mockHandle('abcdef'), 4, stat), /10 MiB/);
  await assert.rejects(readProjectBytes(mockHandle('abcd'), 4, { ...stat, ino: 3 }), /변경되었습니다/);
});

test('window settings use defaults for absent, non-file and oversized input', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'motor-window-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'window.json');
  assert.deepEqual(readWindowSettings(file), {});
  assert.deepEqual(readWindowSettings(root), {});
  const settings = { width: 1000, height: 800, maximized: false };
  await fs.writeFile(file, JSON.stringify(settings));
  assert.deepEqual(readWindowSettings(file), settings);
  await fs.writeFile(file, JSON.stringify(settings).padEnd(4097));
  assert.deepEqual(readWindowSettings(file), {});
});
