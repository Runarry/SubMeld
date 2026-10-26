import { z } from 'zod';
import { scanResultSchema, type ScanResult } from './shared/reality-scanner.js';

type ScanEvent =
  | { kind: 'started' | 'completed' | 'ignored' }
  | { kind: 'geoip'; available: boolean }
  | { kind: 'fatal'; message: string }
  | { kind: 'result'; result: ScanResult };

/** slog.TextHandler uses Go quoted strings, including escapes JSON cannot decode. */
export function parseScannerFields(line: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  let index = 0;
  while (index < line.length) {
    while (/\s/.test(line[index] ?? '') && index < line.length) index++;
    if (index === line.length) break;
    const key = /^[\w-]+=/u.exec(line.slice(index));
    if (!key) throw new Error('Invalid scanner log field');
    index += key[0].length;
    let value = '';
    if (line[index] === '"') {
      index++;
      let closed = false;
      while (index < line.length) {
        const character = line[index++];
        if (character === '"') {
          closed = true;
          break;
        }
        if (character !== '\\') {
          value += character;
          continue;
        }
        const escape = line[index++];
        const simple: Record<string, string> = {
          a: '\x07',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
          v: '\v',
          '\\': '\\',
          '"': '"',
        };
        if (escape in simple) value += simple[escape];
        else if (['x', 'u', 'U'].includes(escape)) {
          const length = escape === 'x' ? 2 : escape === 'u' ? 4 : 8;
          const digits = line.slice(index, index + length);
          if (digits.length !== length || !/^[\da-f]+$/i.test(digits))
            throw new Error('Invalid scanner escape');
          value += String.fromCodePoint(Number.parseInt(digits, 16));
          index += length;
        } else throw new Error('Invalid scanner escape');
      }
      if (!closed || (index < line.length && !/\s/.test(line[index])))
        throw new Error('Invalid scanner quote');
    } else {
      const end = line.slice(index).search(/\s/);
      const next = end === -1 ? line.length : index + end;
      value = line.slice(index, next);
      index = next;
    }
    const name = key[0].slice(0, -1);
    // Upstream start/completion messages add their own time attribute to slog's time.
    if (name in fields && name !== 'time') throw new Error('Duplicate scanner field');
    fields[name] = value;
  }
  if (!fields.msg || !fields.level) throw new Error('Missing scanner message');
  return fields;
}

export function parseScannerLine(line: string, port: number, position: number): ScanEvent {
  const f = parseScannerFields(line);
  if (f.msg === 'Started all scanning threads') return { kind: 'started' };
  if (f.msg === 'Scanning completed') return { kind: 'completed' };
  if (f.msg === 'Enabled GeoIP') return { kind: 'geoip', available: true };
  if (f.msg === 'Cannot open Country.mmdb') return { kind: 'geoip', available: false };
  if (f.msg === 'Error reading geo') return { kind: 'ignored' };
  const row: ScanResult = {
    position,
    port,
    state: 'failed',
    ip: '',
    origin: '',
    tls: '',
    alpn: '',
    curve: '',
    certLength: '',
    certSignature: '',
    certPublicKey: '',
    certDomain: '',
    certIssuer: '',
    countryCode: '',
    message: '',
  };
  if (f.msg === 'Connected to target') {
    if (!['true', 'false'].includes(f.feasible)) throw new Error('Missing feasibility');
    row.ip = z.union([z.ipv4(), z.ipv6()]).parse(f.ip);
    row.origin = z.string().max(253).parse(f.origin);
    row.state = f.feasible === 'true' ? 'matched' : 'unmatched';
    row.tls = f.tls ?? '';
    row.alpn = f.alpn ?? '';
    row.curve = f.curve ?? '';
    row.certLength = f['cert-length'] ?? '';
    row.certSignature = f['cert-signature'] ?? '';
    row.certPublicKey = f['cert-publickey'] ?? '';
    row.certDomain = f['cert-domain'] ?? '';
    row.certIssuer = f['cert-issuer'] ?? '';
    row.countryCode = /^[A-Z]{2}$/.test(f.geo ?? '') ? f.geo : '';
    row.message =
      row.state === 'matched'
        ? '符合上游筛选条件；未验证证书信任链及 REALITY 实际部署。'
        : [
            row.tls !== 'TLS 1.3' && '未协商 TLS 1.3',
            row.alpn !== 'h2' && '未协商 HTTP/2',
            !row.certDomain && '证书缺少域名',
            !row.certIssuer && '证书缺少颁发者',
          ]
            .filter(Boolean)
            .join('；') || '不符合上游筛选条件。';
  } else if (f.msg === 'Failed to get IP from the origin') {
    row.origin = z.string().max(253).parse(f.origin);
    row.message = 'DNS 解析失败或没有允许的地址。';
  } else if (['Cannot dial', 'TLS handshake failed'].includes(f.msg)) {
    const target = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(f.target ?? '');
    if (!target || Number(target[3]) !== port) throw new Error('Invalid scanner target');
    row.ip = z.union([z.ipv4(), z.ipv6()]).parse(target[1] || target[2]);
    row.message =
      f.msg === 'Cannot dial'
        ? 'TCP 连接失败（可能包含超时）；上游未返回详细原因。'
        : 'TLS 握手失败（可能包含超时）；上游未返回详细原因。';
  } else if (f.msg === 'Error setting deadline') {
    row.message = '设置连接期限失败；上游未返回目标身份。';
  } else if (f.level === 'ERROR' || f.level === 'WARN') {
    return { kind: 'fatal', message: '扫描器报告执行错误，结果可能不完整。' };
  } else return { kind: 'ignored' };
  return { kind: 'result', result: scanResultSchema.parse(row) };
}
