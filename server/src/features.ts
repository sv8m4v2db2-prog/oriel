// Feature modules plug their routes and background jobs in here.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerAiRoutes, startAiJobs } from './routes/ai.js';
import { registerCollabRoutes, startCollabJobs } from './routes/collab.js';
import { registerEditorRoutes, startEditorJobs } from './routes/editor.js';
import { registerIoRoutes, startIoJobs } from './routes/io.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { startAccountSecurityJobs } from './auth/securityRoutes.js';
import { registerDatabaseExtraRoutes } from './routes/databaseExtras.js';
import { registerFormRoutes } from './routes/forms.js';
import { registerReadingRoutes } from './routes/reading.js';
import { registerPropertyExtraRoutes } from './routes/propertyExtras.js';
import { registerRowBatchRoutes } from './routes/rowsBatch.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerNavigationRoutes } from './routes/navigation.js';
import { registerOrganizeRoutes } from './routes/organize.js';
import { registerBlockMetaRoutes } from './routes/blockMeta.js';
import { startTemplateRecurrenceJob } from './services/templateRecurrence.js';

export function registerFeatureRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerCollabRoutes(app, ctx);
  registerEditorRoutes(app, ctx);
  registerIoRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerTokenRoutes(app, ctx);
  registerDatabaseExtraRoutes(app, ctx);
  registerFormRoutes(app, ctx);
  registerReadingRoutes(app, ctx);
  registerPropertyExtraRoutes(app, ctx);
  registerRowBatchRoutes(app, ctx);
  registerHistoryRoutes(app, ctx);
  registerNavigationRoutes(app, ctx);
  registerOrganizeRoutes(app, ctx);
  registerBlockMetaRoutes(app, ctx);
}

export function startFeatureJobs(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  const stops = [startCollabJobs(ctx, log), startEditorJobs(ctx, log), startIoJobs(ctx, log), startAiJobs(ctx, log), startAccountSecurityJobs(ctx, log), startTemplateRecurrenceJob(ctx, log)];
  return () => stops.forEach((stop) => stop());
}
