import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve('vendor/sub-store/backend/src');
const lock = JSON.parse(await readFile('vendor/upstream.lock.json', 'utf8'));
for (const [file, expected] of Object.entries(lock.files)) {
  const digest = createHash('sha256')
    .update(await readFile(resolve(root, file)))
    .digest('hex');
  if (digest !== expected) throw new Error('Pinned source digest mismatch: ' + file);
}
const original = await readFile(resolve(root, 'core/proxy-utils/index.js'), 'utf8');
function between(start, end) {
  const a = original.indexOf(start);
  const b = end ? original.indexOf(end, a) : original.length;
  if (a < 0 || b < a) throw new Error('Pinned upstream structure changed');
  return original.slice(a, b);
}
// Keep the upstream parse/produce drivers and their normalization helpers verbatim.
// Exclude unrelated service/script exports at build time, never by runtime flags.
const core =
  `
import { Base64 } from 'js-base64';
import { Buffer } from 'buffer';
import { isIPv4,isIPv6,isValidPortNumber,isValidUUID,isNotBlank,getRandomPort,numberToString } from '@/utils';
import PROXY_PREPROCESSORS from './preprocessors';
import PROXY_PARSERS from './parsers';
import PROXY_PRODUCERS from './producers';
import $ from '@/core/app';
import { isShadowsocksOverTls,normalizeWireGuardInterface } from './producers/utils';
const rs = { generateFingerprint() { throw new Error('Certificate files are unsupported'); } };
function SurgeMac_Producer() { throw new Error('External processes are unsupported'); }
` +
  between('function preprocess(raw)', 'function shouldSkipByContext(') +
  between('function produce(proxies,', 'export const ProxyUtils') +
  between('function tryParse(', null) +
  '\nexport { parse, produce };\n';
await mkdir('dist/converter', { recursive: true });
const result = await build({
  stdin: { contents: "export {parse,produce} from '@/core/proxy-utils';", resolveDir: root },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/converter/upstream.mjs',
  metafile: true,
  plugins: [
    {
      name: 'submeld-offline-converter',
      setup(b) {
        b.onResolve({ filter: /^@\// }, ({ path }) => ({
          path: resolve(root, path.slice(2) + (path.endsWith('.js') ? '' : '.js')),
        }));
        b.onResolve({ filter: /./ }, ({ path, importer, resolveDir }) => {
          if (path.startsWith('.') && importer.startsWith(root)) {
            const file = resolve(resolveDir, path);
            return { path: /\.(js|json)$/.test(file) ? file : file + '.js' };
          }
        });
        b.onLoad({ filter: /\.js$/ }, async ({ path }) => {
          const rel = path
            .slice(root.length + 1)
            .replaceAll('\\', '/')
            .replace(/\.js$/, '');
          if (rel === 'core/proxy-utils')
            return { contents: core, resolveDir: resolve(root, 'core/proxy-utils') };
          if (rel === 'core/app')
            return {
              contents:
                'const noop=()=>{}; export default {env:{isNode:false},info:noop,warn:noop,error:noop,log:noop};',
            };
          if (rel === 'core/proxy-utils/producers')
            return {
              contents: "import URI from './uri'; export default {URI:URI()};",
              resolveDir: resolve(root, 'core/proxy-utils/producers'),
            };
          if (rel === 'core/proxy-utils/preprocessors')
            return { contents: 'export default []; export const normalizeClashYaml = x => x;' };
          let actual = path;
          // Upstream uses extensionless directory imports.
          try {
            await readFile(actual);
          } catch {
            actual = path.replace(/\.js$/, '/index.js');
          }
          let contents = await readFile(actual, 'utf8');
          if (actual.endsWith('parsers/index.js') || actual.endsWith('parsers\\index.js')) {
            contents = contents.replace(/^import get(?:Surge|Loon|QX)Parser from .*;\r?\n/gm, '');
            contents = contents
              .replace('auth = decodeURIComponent(auth);', '')
              .replace(
                "let [uuid, ...passwordParts] = auth.split(':');",
                "let [uuid, ...passwordParts] = auth.split(':'); uuid = decodeURIComponent(uuid);",
              );
            contents =
              contents.slice(0, contents.lastIndexOf('export default [')) +
              'export default [URI_SS(),URI_VMess(),URI_VLESS(),URI_TUIC(),URI_Hysteria2(),URI_Trojan(),Clash_All()];';
          }
          if (actual.endsWith('/uri.js') || actual.endsWith('\\uri.js')) {
            contents = contents.replace(
              "fp: proxy['client-fingerprint'],",
              "fp: proxy['client-fingerprint'], allowInsecure: proxy['skip-cert-verify'] ? 1 : 0,",
            );
            // URI credentials must be percent-encoded; upstream Trojan interpolates them raw.
            contents = contents.replace(
              'trojan://${proxy.password}@',
              'trojan://${encodeURIComponent(proxy.password)}@',
            );
            // Preserve all TUIC ALPN values instead of silently taking the first.
            contents = contents.replaceAll('? proxy[key][0]', "? proxy[key].join(',')");
            // Upstream's Trojan scalar ALPN fallback incorrectly calls .join on a string.
            contents = contents.replace(
              '? proxy.alpn\n                            : proxy.alpn.join',
              "? proxy.alpn.join(',')\n                            : String(proxy.alpn).split",
            );
          }
          return { contents, resolveDir: resolve(actual, '..') };
        });
      },
    },
  ],
});
const inputs = Object.keys(result.metafile.inputs);
if (
  inputs.some(
    (p) =>
      /processors\/|restful\/|open-api|download|core\/app\.js/.test(p) &&
      !p.endsWith('core/app.js'),
  )
)
  throw new Error('Unexpected service dependency');
await writeFile(
  'dist/converter/build.json',
  JSON.stringify(
    {
      commit: 'ece585cdac30d6a6f25a2b8815ac1dde26414153',
      coreSha256: createHash('sha256').update(original).digest('hex'),
      inputs,
    },
    null,
    2,
  ),
);
