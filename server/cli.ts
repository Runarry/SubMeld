import { emitKeypressEvents } from 'node:readline';
import { loadConfig } from './config.js';
import { openSettings } from './database.js';
import { hashPassword } from './auth.js';

async function passwordInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    let password = '';
    for await (const chunk of process.stdin) {
      password += String(chunk);
      if (Buffer.byteLength(password) > 1024) throw new Error('密码过长。');
    }
    return password.replace(/\r?\n$/, '');
  }
  process.stderr.write('管理员密码（隐藏输入）：');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = () => {
      process.stdin.off('keypress', listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    const listener = (value: string | undefined, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === 'c') {
        finish();
        reject(new Error('已取消。'));
      } else if (key.name === 'return') {
        finish();
        resolve(password);
      } else if (key.name === 'backspace') password = [...password].slice(0, -1).join('');
      else if (value && !key.ctrl) {
        password += value;
        if (Buffer.byteLength(password) > 1024) {
          finish();
          reject(new Error('密码过长。'));
        }
      }
    };
    process.stdin.on('keypress', listener);
  });
}
async function main() {
  const command = process.argv[2];
  if (!['init', 'reset-password'].includes(command ?? ''))
    throw new Error('仅支持 init 或 reset-password；密码不能通过参数传入。');
  if (process.argv.slice(3).some((arg) => arg !== '--dev'))
    throw new Error('密码不能通过参数传入。');
  const config = loadConfig(process.argv.includes('--dev'));
  const settings = openSettings(config.dataDir, config.development);
  try {
    const existing = settings.getPasswordHash();
    if (command === 'init' && existing) throw new Error('已初始化。请停机后使用 reset-password。');
    if (command === 'reset-password' && !existing) throw new Error('尚未初始化，请先使用 init。');
    const password = await passwordInput();
    if (password.length < 12 || Buffer.byteLength(password) > 1024 || /[\r\n\0]/.test(password))
      throw new Error('请使用至少 12 个字符、不含换行的密码（上限 1024 字节）。');
    settings.setPasswordHash(await hashPassword(password));
    process.stdout.write('管理员密码已设置。启动应用后登录。\n');
  } finally {
    settings.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : '维护命令失败。');
  process.exitCode = 1;
});
