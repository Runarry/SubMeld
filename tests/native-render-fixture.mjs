import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { resetUpstream } from './upstream-fixture.mjs';
import { openSettings } from '../dist/server/database.js';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';
export async function nativeRenderer() {
  const client = await resetUpstream();
  mkdirSync('.cache', { recursive: true });
  const directory = mkdtempSync(resolve('.cache/native-cores-')),
    store = openSettings(directory, true, client);
  await store.resources.sync();
  return {
    async render({ items, target, listenPort = 1080 }) {
      const resources = [];
      let plan;
      const add = async (drafts) => {
        const resource = await store.nodes.create({
          name: 'core-fixture',
          source: 'local',
          content: JSON.stringify({ proxies: drafts.map(toUpstream) }),
        });
        resources.push(resource);
        return resource;
      };
      try {
        const inputs = [];
        for (const item of items.filter((i) => !i.excluded)) {
          const resource = await add([item.draft]);
          inputs.push({ kind: 'resource', id: resource.id });
        }
        plan = await store.subscriptions.create({
          ...newSubscription(),
          name: 'native-core-config',
          inputs,
          formats: [target],
          listenPort,
        });
        const full = (await store.subscriptions.artifact(plan.id, target)).content;
        const config = target === 'mihomo' ? parse(full) : JSON.parse(full);
        assert.equal(
          target === 'mihomo'
            ? config['mixed-port']
            : target === 'singbox'
              ? config.inbounds[0].listen_port
              : config.inbounds[0].port,
          listenPort,
          'Native templates must use the requested listener port',
        );
        const emitted =
          target === 'mihomo'
            ? config.proxies
            : config.outbounds.filter((n) => n.type !== 'selector');
        assert.equal(
          emitted.length,
          inputs.length,
          'Native output must retain every ordinary node',
        );
        return { full, counts: { output: emitted.length } };
      } finally {
        if (plan) await store.subscriptions.delete(plan.id, plan.revision);
        for (const resource of resources)
          await client.api('/api/sub/' + resource.upstreamName, undefined, 'DELETE');
        await store.resources.sync();
      }
    },
    close() {
      store.close();
      assert.ok(directory.startsWith(resolve('.cache') + sep));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
