import { isMap, isSeq, parseDocument } from 'yaml';
import { AppError } from './errors.js';
const unsafe = () =>
  new AppError(
    'NODE_DELETE_UNSAFE',
    '无法确认原始文本中的节点位置，请在 Sub-Store 原生页面编辑。',
    409,
  );
/** Edit the original container/text, preserving unrelated nodes, comments and configuration. */
export async function removeLocalNodes(
  content: string,
  removed: Set<number>,
  count: number,
  parseLine: (line: string) => Promise<unknown>,
) {
  try {
    const json: unknown = JSON.parse(content);
    if (json && typeof json === 'object') {
      const values = Array.isArray(json)
        ? json
        : 'proxies' in json && Array.isArray(json.proxies)
          ? json.proxies
          : null;
      if (values) {
        if (values.length !== count) throw unsafe();
        for (const index of [...removed].sort((a, b) => b - a)) values.splice(index, 1);
        return JSON.stringify(json, null, 2);
      }
      if ('type' in json && count === 1 && removed.has(0)) return '';
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
  }
  const doc = parseDocument(content, { uniqueKeys: true });
  if (!doc.errors.length) {
    const values = isSeq(doc.contents)
      ? doc.contents
      : isMap(doc.contents)
        ? doc.get('proxies', true)
        : null;
    if (isSeq(values)) {
      if (values.items.length !== count) throw unsafe();
      for (const index of [...removed].sort((a, b) => b - a)) values.items.splice(index, 1);
      return String(doc);
    }
    if (isMap(doc.contents) && doc.has('type') && count === 1 && removed.has(0)) return '';
  }
  const lines = content.split(/\r?\n/),
    retained: string[] = [];
  let index = 0;
  for (const line of lines) {
    if (!line.trim() || /^\s*(#|\/\/)/.test(line)) {
      retained.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = await parseLine(line);
    } catch (error) {
      if (error instanceof AppError && error.status >= 500) throw error;
      throw unsafe();
    }
    if (!Array.isArray(parsed) || parsed.length > 1) throw unsafe();
    if (!parsed.length || !removed.has(index)) retained.push(line);
    index += parsed.length;
  }
  if (index !== count) throw unsafe();
  return retained.join(content.includes('\r\n') ? '\r\n' : '\n');
}
