/** Hysteria2 port lists use inclusive ranges, separated by commas. */
export function hysteriaPortRanges(value: string): [number, number][] {
  if (!value) return [];
  return value.split(',').map((part) => {
    if (!/^\d+(?:-\d+)?$/.test(part)) throw new Error('Invalid Hysteria2 ports');
    const [start, end = start] = part.split('-').map(Number);
    if (!start || !end || start > end || end > 65535) throw new Error('Invalid Hysteria2 ports');
    return [start, end];
  });
}

export function certificatePin(value: string): string {
  if (!value) return '';
  if (!/^(?:[\da-f]{64}|(?:[\da-f]{2}:){31}[\da-f]{2})$/i.test(value))
    throw new Error('Invalid certificate SHA-256');
  return value.replaceAll(':', '').toLowerCase();
}

/** Adapt official multi-port authorities to the pinned upstream's stable mport form. */
export function hysteriaUri(value: string): string {
  const match = /^((?:hysteria2|hy2):\/\/[^/?#]+):([\d,-]+)(?=[/?#]|$)/i.exec(value);
  if (!match || !/[-,]/.test(match[2]!)) return value;
  const ports = match[2]!,
    ranges = hysteriaPortRanges(ports);
  const url = new URL(match[1] + ':' + ranges[0]![0] + value.slice(match[0].length));
  if (url.searchParams.has('mport') && url.searchParams.get('mport') !== ports)
    throw new Error('Conflicting Hysteria2 ports');
  if (!url.searchParams.has('mport')) url.searchParams.set('mport', ports);
  return url.href;
}
