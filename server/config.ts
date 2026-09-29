import { resolve, isAbsolute } from 'node:path';
import { isIPv4 } from 'node:net';
export type Config = {
  publicOrigin: string;
  port: number;
  dataDir: string;
  development: boolean;
  subStoreUrl: string;
  miaospeedUrl: string;
  miaospeedToken: string;
  miaospeedBridgeHost: string;
  miaospeedBridgeBind: string;
};
export function loadConfig(development = false, env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.PUBLIC_ORIGIN || !env.DATA_DIR)
    throw new Error('请显式配置 PUBLIC_ORIGIN 和 DATA_DIR。');
  const url = new URL(env.PUBLIC_ORIGIN);
  if (
    url.origin !== env.PUBLIC_ORIGIN ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('PUBLIC_ORIGIN 必须是完整且不含路径的 origin。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ((development && local) || env.ALLOW_HTTP === 'true'))
  )
    throw new Error('默认要求 HTTPS；可信内网 HTTP 需显式设置 ALLOW_HTTP=true。');
  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT 必须是 1–65535 的整数。');
  const miaospeedBridgeBind = env.MIAOSPEED_BRIDGE_BIND ?? '0.0.0.0';
  if (!isIPv4(miaospeedBridgeBind))
    throw new Error('MIAOSPEED_BRIDGE_BIND 必须是本机可监听的 IPv4 地址。');
  return {
    publicOrigin: url.origin,
    port,
    dataDir: isAbsolute(env.DATA_DIR) ? env.DATA_DIR : resolve(env.DATA_DIR),
    development,
    subStoreUrl: env.SUB_STORE_URL ?? 'http://127.0.0.1:39091/gateway',
    miaospeedUrl:
      env.MIAOSPEED_URL ??
      (development ? 'ws://127.0.0.1:39092/miaospeed' : 'ws://miaospeed:8765/miaospeed'),
    miaospeedToken: env.MIAOSPEED_TOKEN ?? '',
    miaospeedBridgeHost:
      env.MIAOSPEED_BRIDGE_HOST ?? (development ? 'host.docker.internal' : 'submeld'),
    miaospeedBridgeBind,
  };
}
