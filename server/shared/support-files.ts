import { z } from 'zod';
import { revisionSchema } from './resources.js';
export const supportFileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.enum(['runtime', 'template', 'certificate-resolver']),
  revision: revisionSchema,
  matchesBuiltin: z.boolean(),
});
export const supportFilesSchema = z.object({ files: z.array(supportFileSchema) });
export type SupportFile = z.infer<typeof supportFileSchema>;
