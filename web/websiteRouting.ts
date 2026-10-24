import {
  parseWebsiteRoutingResponse,
  type WebsiteRoutingResult,
  type WebsiteRoutingSite,
} from '../server/shared/website-routing';

export const WEBSITE_ROUTING_TIMEOUT = 8000;
export const WEBSITE_ROUTING_CONCURRENCY = 4;

export async function probeWebsite(
  site: WebsiteRoutingSite,
  signal: AbortSignal,
): Promise<WebsiteRoutingResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WEBSITE_ROUTING_TIMEOUT);
  const start = performance.now();
  const finish = (result: WebsiteRoutingResult): WebsiteRoutingResult => ({
    ...result,
    elapsedMs: Math.round(performance.now() - start),
    checkedAt: new Date().toISOString(),
  });
  try {
    const url = new URL(site.url);
    url.searchParams.set('_submeld', Date.now() + '-' + Math.random().toString(36).slice(2));
    const response = await fetch(url, {
      method: site.probe === 'cf-trace' ? 'GET' : 'HEAD',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok)
      return finish({
        state: 'unavailable',
        message: '检测接口返回 HTTP ' + response.status + '。',
      });
    const result = parseWebsiteRoutingResponse(
      site.probe,
      site.probe === 'cf-trace' ? await response.text() : '',
      {
        'cdn-user-ip': response.headers.get('cdn-user-ip'),
        'x-request-ip': response.headers.get('x-request-ip'),
        'x-response-cinfo': response.headers.get('x-response-cinfo'),
      },
    );
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return finish(
      result
        ? { state: 'success', ...result }
        : { state: 'invalid', message: '检测接口未提供可读取的有效公网 IP。' },
    );
  } catch {
    return finish(
      signal.aborted
        ? { state: 'cancelled', message: '已停止本次检测。' }
        : timedOut
          ? { state: 'timeout', message: '检测超过 8 秒，请稍后重试。' }
          : { state: 'unavailable', message: '请求未完成，可能受到网络、跨域或重定向限制。' },
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
