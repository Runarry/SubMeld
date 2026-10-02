import { AppError } from './errors.js';
import { byteLimit, decodeBase64, yamlObject } from './converter/input.js';
import { record } from './converter/model.js';

export function inlineNodeEntries(text: string): (string | Record<string, unknown>)[] {
  byteLimit(text);
  const content = text.trim().replace(/^\uFEFF/, '');
  if (!content) throw new AppError('EMPTY_INPUT', '请输入节点文本或配置文件。', 400);
  if (/^[\w-]+:\/\//.test(content))
    return content
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter((v) => v && !v.startsWith('#'));
  if (/^[A-Za-z0-9+/=_\s-]+$/.test(content)) return inlineNodeEntries(decodeBase64(content));
  const parsed = yamlObject(content);
  const list = Array.isArray(parsed)
    ? parsed
    : record(parsed) && Array.isArray(parsed.proxies)
      ? parsed.proxies
      : record(parsed) && Array.isArray(parsed.outbounds)
        ? parsed.outbounds
        : record(parsed) && (parsed.type || parsed.protocol)
          ? [parsed]
          : null;
  if (!list)
    throw new AppError(
      'NO_INLINE_NODES',
      '配置中没有内联节点；请提供节点、proxies 或 outbounds 列表。',
      400,
    );
  return list.map((value) => (record(value) ? value : {}));
}
