import { createHash, X509Certificate } from 'node:crypto';
import { AppError } from '../errors.js';
import { hy2CertificateSchema, type Hy2Certificate } from '../shared/hy2-certificates.js';

export function certificateProof(pinSHA256: string, certificatePem: string): Hy2Certificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new AppError('HY2_CERTIFICATE_INVALID', 'HY2 服务端证书无法读取。', 422);
  }
  if (createHash('sha256').update(certificate.raw).digest('hex') !== pinSHA256)
    throw new AppError('HY2_CERTIFICATE_MISMATCH', 'HY2 服务端证书与 pinSHA256 不匹配。', 422);
  return {
    pinSHA256,
    certificatePem: certificate.toString(),
    publicKeySha256: createHash('sha256')
      .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64'),
  };
}

export function verifyCertificateProof(pinSHA256: string, input: unknown): Hy2Certificate {
  const value = hy2CertificateSchema.parse(input);
  const verified = certificateProof(pinSHA256, value.certificatePem);
  if (value.pinSHA256 !== pinSHA256 || value.publicKeySha256 !== verified.publicKeySha256)
    throw new AppError('HY2_CERTIFICATE_INVALID', 'HY2 证书缓存的公钥摘要不匹配。', 422);
  return verified;
}
