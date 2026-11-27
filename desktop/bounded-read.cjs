const fs = require('node:fs');

async function readProjectBytes(handle, limit, stat) {
  const opened = await handle.stat();
  if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
    throw new Error('실험 파일이 변경되었습니다. 다시 선택해 주세요.');
  }
  const tooLarge = () => new Error('실험 파일은 10 MiB 이하여야 합니다.');
  if (opened.size > limit) throw tooLarge();
  const chunks = [];
  let total = 0;
  // Include a sentinel byte even when the file grows after stat().
  while (total <= limit) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) return Buffer.concat(chunks, total);
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  throw tooLarge();
}

function readWindowSettings(file) {
  const limit = 4096;
  try {
    if (!fs.lstatSync(file).isFile()) return {};
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) return {};
      const buffer = Buffer.allocUnsafe(limit + 1);
      let length = 0;
      while (length <= limit) {
        const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!read) break;
        length += read;
      }
      if (length > limit) return {};
      const parsed = JSON.parse(buffer.toString('utf8', 0, length));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } finally { fs.closeSync(fd); }
  } catch { return {}; }
}

module.exports = { readProjectBytes, readWindowSettings };
