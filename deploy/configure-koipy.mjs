import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const uid = process.env.KOIPY_ADMIN_ID ?? '';
if (!/^[1-9]\d{3,15}$/.test(uid)) throw new Error('请配置 KOIPY_ADMIN_ID。');
const token = process.env.MIAOSPEED_TOKEN;
if (!token || token.length < 16) throw new Error('请设置至少 16 字符的 MIAOSPEED_TOKEN。');
const dir = resolve('runtime-v2/koipy');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const config = JSON.parse(
  readFileSync(new URL('./koipy.config.example.json', import.meta.url), 'utf8'),
);
config.admin = [Number(uid)];
if (process.env.KOIPY_LICENSE) config.license = process.env.KOIPY_LICENSE;
if (process.env.KOIPY_BOT_TOKEN) config.bot = { 'bot-token': process.env.KOIPY_BOT_TOKEN };
config.slaveConfig.slaves[0].token = token;
// Exclusive creation avoids overwriting native bot settings.
writeFileSync(resolve(dir, 'config.yaml'), JSON.stringify(config, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.info('已生成 runtime-v2/koipy/config.yaml；激活码和 Bot Token 从容器环境读取。');
