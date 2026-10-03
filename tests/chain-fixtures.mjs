import { node } from './fixtures.mjs';
export function chainItem(entryProtocol = 'ss', exitProtocol = 'ss', nodeIndex = 0) {
  const entry = node(entryProtocol),
    exit = node(exitProtocol);
  entry.name = 'entry';
  exit.name = 'exit';
  entry.tls.insecure = false;
  exit.tls.insecure = false;
  return {
    kind: 'chain',
    nodeIndex,
    name: 'two hop',
    entry,
    exit,
    excluded: false,
    diagnostics: [],
    available: true,
  };
}
export function chainFixtures(target, start = 0) {
  const pairs = [
    ['ss', 'ss'],
    ['vless', 'trojan'],
    ['vmess', 'vless'],
  ];
  pairs.push(['hysteria2', 'ss'], ['ss', 'hysteria2']);
  if (target !== 'xray') pairs.push(['ss', 'tuic']);
  return pairs.map(([entry, exit], index) => {
    const item = chainItem(entry, exit, start + index);
    item.name += ' ' + index;
    if (item.entry.protocol === 'vless') item.entry.transport.type = 'ws';
    if (item.exit.protocol === 'trojan') item.exit.transport.type = 'grpc';
    return item;
  });
}
