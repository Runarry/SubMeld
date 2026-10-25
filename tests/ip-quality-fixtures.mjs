export function qualityPayloads(ip = '1.1.1.1') {
  return {
    maxmind: {
      ip,
      ASN: { AutonomousSystemNumber: 13335, AutonomousSystemOrganization: 'Example Network' },
      Country: { IsoCode: 'AU', Name: 'Australia', RegisteredCountry: { IsoCode: 'US' } },
      City: { Name: 'Sydney' },
    },
    ipinfo: {
      data: {
        ip,
        country: 'AU',
        city: 'Sydney',
        asn: { asn: 'AS13335', name: 'Example Network', type: 'hosting' },
        privacy: { proxy: false, vpn: true, tor: false, hosting: true },
      },
    },
    scamalytics: {
      ip,
      external_datasources: {
        maxmind_geolite2: { ip_country_code: 'AU' },
        firehol: { is_proxy: false },
      },
      scamalytics: {
        scamalytics_score: 0,
        scamalytics_proxy: { is_vpn: false, is_datacenter: true },
      },
    },
    ipregistry: {
      ip,
      connection: { asn: 13335, organization: 'Example Network', type: 'hosting' },
      location: { country: { code: 'AU', name: 'Australia' }, city: 'Sydney' },
      security: {
        is_proxy: false,
        is_vpn: false,
        is_tor: false,
        is_tor_exit: false,
        is_cloud_provider: true,
        is_abuser: false,
      },
    },
    ipapi: {
      ip,
      company: {
        name: 'Example Network',
        type: 'hosting',
        network: '1.1.1.0/24',
        abuser_score: '0.125 (High)',
      },
      asn: { asn: 13335, abuser_score: '0.005 (Low)' },
      is_proxy: false,
      is_vpn: false,
      is_datacenter: true,
    },
    abuseipdb: {
      data: {
        ipAddress: ip,
        isp: 'Example Network',
        usageType: 'Data Center/Web Hosting/Transit',
        abuseConfidenceScore: 0,
        isTor: false,
        totalReports: 0,
        lastReportedAt: null,
      },
    },
    ip2location: {
      ip,
      country_code: 'AU',
      asn: '13335',
      usage_type: 'DCH',
      fraud_score: 33,
      is_proxy: false,
      proxy: { is_public_proxy: false, is_web_proxy: false, is_vpn: false, is_data_center: true },
    },
    ipdata: {
      ip,
      country_code: 'AU',
      threat: {
        is_proxy: false,
        is_tor: false,
        is_datacenter: true,
        is_threat: false,
        is_known_abuser: false,
      },
    },
    ipqs: {
      success: true,
      ip,
      country_code: 'AU',
      fraud_score: 85,
      proxy: false,
      vpn: false,
      tor: false,
      recent_abuse: false,
    },
  };
}
export function qualityRequest(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'ipregistry.co') return { id: 'registry-page' };
  const ip = decodeURIComponent(parsed.pathname.split('/').at(-1));
  const db = parsed.searchParams.get('db');
  const id =
    parsed.hostname === 'api.ipregistry.co'
      ? 'ipregistry'
      : parsed.hostname === 'ipinfo.io'
        ? 'ipinfo'
        : db === 'ipqualityscore'
          ? 'ipqs'
          : (db ?? 'maxmind');
  return { id, ip };
}
export async function qualityFetch(url) {
  const { id, ip } = qualityRequest(url);
  return id === 'registry-page'
    ? new Response('<html>no dynamic key</html>')
    : Response.json(qualityPayloads(ip)[id]);
}
export function absent() {
  return Object.assign(new Error('query name not found'), { code: 'ENOTFOUND' });
}
export async function qualityDns(name) {
  if (name.startsWith('2.0.0.127.') || name.startsWith('2.0.0.0.0.0.f.7.f.f.f.f.'))
    return ['127.0.0.2'];
  throw absent();
}
