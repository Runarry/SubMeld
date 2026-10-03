import { AppError } from '../errors.js';
import {
  hy2ResolverConnectionSchema,
  type Hy2CertificateResolver,
} from '../shared/hy2-certificates.js';
import { verifyCertificateProof } from './certificate-pin.js';
import { record } from './model.js';

export function remoteCertificateResolver(input: unknown): Hy2CertificateResolver {
  const connection = hy2ResolverConnectionSchema.parse(input);
  const url = new URL(connection.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError('HY2_RESOLVER_UNAVAILABLE', 'HY2 证书解析连接配置无效。', 422);
  return async (request, signal) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + connection.token,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]),
        redirect: 'error',
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        if (
          record(value) &&
          typeof value.code === 'string' &&
          value.code.startsWith('HY2_') &&
          typeof value.message === 'string'
        )
          throw new AppError(value.code, value.message, 422);
        throw new AppError(
          'HY2_RESOLVER_UNAVAILABLE',
          '无法访问 HY2 证书解析服务，请检查配套连接配置。',
          422,
        );
      }
      return verifyCertificateProof(request.pinSHA256, value);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof AppError) throw error;
      throw new AppError(
        'HY2_RESOLVER_UNAVAILABLE',
        'HY2 自动证书解析失败或超时，请检查节点与 SubMeld 服务。',
        422,
      );
    }
  };
}
