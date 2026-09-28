import { nodeRefSchema } from './shared/resources.js';
import { UpstreamResources } from './upstream-resources.js';
export function createNodeStore(resources: UpstreamResources) {
  return {
    list: (resourceId?: string, search = '', page = 0, force = false) =>
      resources.list(resourceId, search, page, force),
    create: (input: unknown) => resources.create(input),
    delete: (input: unknown) => resources.deleteNodes(input),
    async get(input: unknown) {
      const ref = nodeRefSchema.parse(input);
      await resources.preview(ref.resourceId);
      const row = resources.current(ref);
      return { ...row.view, original: row.original, processed: row.processed };
    },
  };
}
export type NodeStore = ReturnType<typeof createNodeStore>;
