import { resolve, isAbsolute } from 'node:path';
export type Config = {
  publicOrigin: string;
  dataDir: string;
  development: boolean;
  subStoreUrl: string;
  telegramBot: string;
  koipyConfigPath: string;
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
  if (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:'))
    throw new Error('生产必须使用 HTTPS；HTTP 仅允许显式回环开发模式。');
  return {
    publicOrigin: url.origin,
    dataDir: isAbsolute(env.DATA_DIR) ? env.DATA_DIR : resolve(env.DATA_DIR),
    development,
    subStoreUrl: env.SUB_STORE_URL ?? 'http://127.0.0.1:39091/gateway',
    koipyConfigPath: resolve(env.KOIPY_CONFIG_PATH ?? 'runtime-v2/koipy/config.yaml'),
    telegramBot: /^\w{5,32}$/.test(env.KOIPY_BOT_USERNAME ?? '')
      ? (env.KOIPY_BOT_USERNAME ?? '')
      : '',
  };
}
