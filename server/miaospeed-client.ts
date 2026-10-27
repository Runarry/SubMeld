import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { SpeedSettings } from './shared/miaospeed.js';

export type BackendScript = {
  ID: string;
  Type: 'media' | 'ip';
  Content: string;
  TimeoutMillis: number;
};
export type Matrix = { Type: string; Params: string };
export const slotSchema = z.object({
  ProxyInfo: z
    .object({ Name: z.string(), Address: z.string(), Type: z.string() })
    .nullable()
    .optional(),
  Matrices: z.array(z.object({ Type: z.string(), Payload: z.string() })).nullable(),
});
export type BackendSlot = z.infer<typeof slotSchema>;
const responseSchema = z.object({
  MiaoSpeedVersion: z.string().optional(),
  Error: z.string().optional(),
  Progress: z
    .object({ Index: z.number().int(), Record: slotSchema.nullable().optional() })
    .nullable()
    .optional(),
  Result: z
    .object({ Results: z.array(slotSchema).nullable() })
    .nullable()
    .optional(),
});
const buildToken = 'MIAOKO4|580JxAo049R|GEnERAl|1X571R930|T0kEN';
export function makeRequest(
  token: string,
  settings: SpeedSettings,
  nodes: { Name: string; Payload: string }[],
  matrices: Matrix[],
  scripts: BackendScript[],
) {
  const request = {
    Basics: {
      ID: randomUUID(),
      Slave: 'local',
      SlaveName: 'SubMeld',
      Invoker: 'SubMeld',
      Version: '2.0.0',
    },
    Options: { Filter: '', Matrices: matrices.map(({ Type, Params }) => ({ Type, Params })) },
    Configs: {
      STUNURL: settings.stunAddress,
      DownloadURL: settings.downloadUrl,
      DownloadDuration: settings.downloadSeconds,
      DownloadThreading: settings.downloadThreads,
      PingAverageOver: settings.pingCount,
      PingAddress: settings.pingUrl,
      TaskRetry: settings.retries,
      DNSServers: [] as string[],
      TaskTimeout: settings.requestTimeoutMs,
      Scripts: scripts.map(({ ID, Type, Content, TimeoutMillis }) => ({
        ID,
        Type,
        Content,
        TimeoutMillis,
      })),
      ApiVersion: 3,
      UploadURL: settings.uploadUrl,
      UploadDuration: settings.uploadSeconds,
      UploadThreading: settings.uploadThreads,
    },
    Vendor: 'Clash',
    Nodes: nodes.map(({ Name, Payload }) => ({ Name, Payload })),
    RandomSequence: randomUUID(),
    Challenge: '',
  };
  // Official v3 Clone() signs a zero-value Vendor. jsoniter also HTML-escapes strings.
  const serialized = JSON.stringify({ ...request, Vendor: '' }).replace(
    /[<>&\u2028\u2029]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  const hasher = createHash('sha512').update(serialized);
  for (const segment of [token, ...buildToken.split('|')])
    hasher.update(Buffer.concat([Buffer.from(segment || 'SOME_TOKEN'), hasher.copy().digest()]));
  request.Challenge = hasher.digest('base64').replaceAll('+', '-').replaceAll('/', '_');
  return request;
}

export class MiaospeedClient {
  constructor(
    readonly url: string,
    private token: string,
  ) {}
  configured() {
    return !!this.url && !!this.token;
  }
  clearCredentials() {
    this.token = '';
  }
  async run(
    settings: SpeedSettings,
    nodes: { Name: string; Payload: string }[],
    matrices: Matrix[],
    scripts: BackendScript[],
    signal: AbortSignal,
    progress?: (slot: BackendSlot, index: number, version: string) => void,
    check = false,
  ) {
    if (!this.configured())
      throw new AppError(
        'MIAOSPEED_UNCONFIGURED',
        '请配置 MIAOSPEED_URL 和 MIAOSPEED_TOKEN。',
        503,
      );
    signal.throwIfAborted();
    const request = makeRequest(this.token, settings, nodes, matrices, scripts);
    if (Buffer.byteLength(JSON.stringify(request)) > 32 * 1024 * 1024)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '测试任务超过 32 MiB。', 413);
    return new Promise<{ version: string; slots: BackendSlot[] }>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let settled = false,
        cancelling = false,
        version = '';
      const finish = (error?: Error, slots: BackendSlot[] = []) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.close();
        if (cancelling) reject(new AppError('TEST_CANCELLED', '测试已取消。'));
        else if (error) reject(error);
        else resolve({ version, slots });
      };
      // 4.7.6 cannot interrupt an in-flight macro. Keep this single-node socket
      // until its final response so the shared batch lock also covers that work.
      const abort = () => {
        cancelling = true;
        if (socket.readyState === WebSocket.CONNECTING) finish();
      };
      const timer = setTimeout(
        () =>
          finish(new AppError('MIAOSPEED_TIMEOUT', '后端未按时返回完整结果，任务已停止。', 504)),
        check ? 10000 : (settings.timeoutSeconds + 60) * 1000,
      );
      signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => {
        if (signal.aborted) finish(new AppError('TEST_CANCELLED', '测试已取消。'));
        else socket.send(JSON.stringify(request));
      });
      socket.addEventListener('message', (event) => {
        if (settled) return;
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 32 * 1024 * 1024)
            throw new Error('Invalid frame');
          const response = responseSchema.parse(JSON.parse(event.data));
          version = response.MiaoSpeedVersion || version;
          if (response.Error) {
            finish(
              new AppError(
                'MIAOSPEED_REJECTED',
                /token|verify/i.test(response.Error)
                  ? 'miaospeed 拒绝请求签名，请核对后端 Token。'
                  : /disabled|upload/i.test(response.Error)
                    ? 'miaospeed 未启用所选测试能力，请核对启动参数。'
                    : 'miaospeed 拒绝了测试请求，请检查后端配置。',
                502,
              ),
            );
          } else if (check && version) finish();
          else if (response.Result) finish(undefined, response.Result.Results ?? []);
          else if (!cancelling && response.Progress?.Record?.Matrices?.length)
            progress?.(response.Progress.Record, response.Progress.Index, version);
        } catch {
          finish(
            new AppError('MIAOSPEED_PROTOCOL', '后端返回了无法验证的测试结果，任务已停止。', 502),
          );
        }
      });
      socket.addEventListener('error', () =>
        finish(new AppError('MIAOSPEED_UNAVAILABLE', '无法连接 miaospeed 后端。', 503)),
      );
      socket.addEventListener('close', () => {
        if (!settled)
          finish(new AppError('MIAOSPEED_DISCONNECTED', '后端连接中断，已完成的结果保留。', 502));
      });
      if (signal.aborted) abort();
    });
  }
}
