import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from './errors.js';
import { publicAddress, resolveSource } from './probe-address.js';
import { SCAN_MAX_BYTES, scanDomain } from './shared/reality-scanner.js';

export function scannerSourceUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[\s\\]/u.test(value)
    )
      throw new Error();
    url.hash = '';
    return url;
  } catch {
    throw new AppError(
      'SCAN_URL_INVALID',
      '请输入不含用户名、密码或空白的 HTTP(S) 网页地址。',
      400,
    );
  }
}

/** Pin the validated public address for this request, retaining HTTP Host and TLS SNI. */
export async function fetchScannerPage(input: string, signal: AbortSignal): Promise<string> {
  let url = scannerSourceUrl(input);
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await resolveSource(host, signal);
    for (const address of addresses) publicAddress(address.address);
    const result = await new Promise<{ redirect?: string; text?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: addresses[0].address,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          servername: isIP(host) ? undefined : host,
          headers: {
            Host: url.host,
            'User-Agent': 'SubMeld-RealityScanner/1.0',
            'Accept-Encoding': 'identity',
          },
          signal,
          agent: false,
        },
        (response) => {
          const code = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(code) && response.headers.location) {
            resolve({ redirect: response.headers.location });
            response.destroy();
            return;
          }
          if (
            code < 200 ||
            code >= 300 ||
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity')
          ) {
            reject(new AppError('SCAN_PAGE_FAILED', '网页响应失败或使用不支持的压缩编码。', 502));
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > SCAN_MAX_BYTES) {
              reject(new AppError('SCAN_PAGE_LIMIT', '网页正文超过 4 MiB。', 413));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve({
                text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
              });
            } catch {
              reject(new AppError('SCAN_PAGE_ENCODING', '网页需要 UTF-8 文本。', 422));
            }
          });
        },
      );
      request.on('error', reject);
      request.end();
    });
    if (result.text !== undefined) return result.text;
    url = scannerSourceUrl(new URL(result.redirect!, url).href);
  }
  throw new AppError('SCAN_PAGE_REDIRECT', '网页重定向超过 4 次。', 422);
}

export function extractScannerDomains(html: string): string[] {
  const domains = new Set<string>();
  // Like the upstream URL mode, inspect absolute HTTP(S) links on this page only.
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    try {
      const url = new URL(match[0]);
      const domain = scanDomain(url.hostname);
      if (domain && !url.username && !url.password) domains.add(domain);
    } catch {
      /* An unrelated malformed page link is not a scanner target. */
    }
  }
  return [...domains];
}
