import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

/** Fixed executable/argument arrays only. Child output never reaches application logs. */
export function startProcess(binary: string, args: string[], cwd?: string, input?: string) {
  const child = spawn(binary, args, {
    cwd,
    windowsHide: true,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
    },
  });
  child.stdin?.on('error', () => {
    /* A cancelled child may close stdin first. */
  });
  child.stdin?.end(input);
  let output = '',
    stdout = '',
    failed = false,
    ended = false;
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-65536);
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = (stdout + chunk.toString('utf8')).slice(-65536);
    append(chunk);
  });
  child.stderr?.on('data', append);
  child.on('error', () => {
    failed = true;
  });
  const done = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      ended = true;
      resolve(code);
    }),
  );
  return {
    get exited() {
      return failed || ended || child.exitCode !== null;
    },
    get output() {
      return output;
    },
    get stdout() {
      return stdout;
    },
    done,
    async stop() {
      if (!ended) child.kill();
      const timer = setTimeout(() => {
        if (!ended) child.kill('SIGKILL');
      }, 1000);
      try {
        await done;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function runProcess(
  binary: string,
  args: string[],
  signal: AbortSignal,
  cwd?: string,
) {
  signal.throwIfAborted();
  const process = startProcess(binary, args, cwd);
  const abort = () => {
    void process.stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const code = await process.done;
    signal.throwIfAborted();
    if (code !== 0) throw new AppError('KERNEL_COMMAND_FAILED', '内核启动或配置自检失败。');
    return process.output;
  } finally {
    signal.removeEventListener('abort', abort);
    await process.stop();
  }
}
