export const MAX_PROJECT_BYTES = 10 * 1024 * 1024;
export const MAX_TRACE_SAMPLES = 1000;

// Two full traces have about 52,000 tokens. Bound structural work before
// JSON.parse builds any arrays or objects, then let it check the JSON grammar.
const maxTokens = 60000;
const maxDepth = 12;
const maxArrayItems = 1024;

export function withinProjectStructure(text) {
  const tokens = /["{}\[\],:]|[^ \t\r\n"{}\[\],:]+/g;
  const stringMarks = /["\\]/g;
  const containers = [];
  let count = 0;
  for (let match; (match = tokens.exec(text));) {
    if (++count > maxTokens) return false;
    const token = match[0];
    if (token === '"') {
      stringMarks.lastIndex = tokens.lastIndex;
      let mark;
      do {
        mark = stringMarks.exec(text);
        if (!mark) return null; // Unterminated JSON string.
        if (mark[0] === '\\') stringMarks.lastIndex++;
      } while (mark[0] !== '"');
      tokens.lastIndex = stringMarks.lastIndex;
    } else if (token === '{' || token === '[') {
      if (containers.length >= maxDepth) return false;
      containers.push({ token, commas: 0 });
    } else if (token === '}' || token === ']') {
      // Stop immediately on inconsistent structure. This also keeps the
      // nesting counter meaningful if malformed input contains extra closers.
      if (containers.pop()?.token !== (token === '}' ? '{' : '[')) return null;
    } else if (token === ',') {
      const container = containers.at(-1);
      if (container?.token === '[' && ++container.commas >= maxArrayItems) return false;
    }
  }
  return true;
}

export function isProjectTextTooLarge(text) {
  return text.length > MAX_PROJECT_BYTES || (
    // Every UTF-16 code unit encodes to at most three UTF-8 bytes.
    text.length > Math.floor(MAX_PROJECT_BYTES / 3)
    && new TextEncoder().encode(text).byteLength > MAX_PROJECT_BYTES
  );
}
