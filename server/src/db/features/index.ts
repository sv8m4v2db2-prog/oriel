// Feature migrations are applied after the core MIGRATIONS, once each, tracked by id in
// `applied_migrations` — so modules developed in parallel never compete for version numbers.
import type { FeatureMigration } from './types.js';
import { migrations as ai } from './ai.js';
import { migrations as databases } from './databases.js';
import { migrations as collab } from './collab.js';
import { migrations as editor } from './editor.js';
import { migrations as io } from './io.js';
import { migrations as mcp } from './mcp.js';
import { migrations as accountSecurity } from './accountSecurity.js';
import { migrations as history } from './history.js';
import { migrations as dateReminders } from './dateReminders.js';
import { migrations as navigation } from './navigation.js';
import { migrations as organize } from './organize.js';

export type { FeatureMigration } from './types.js';
export const FEATURE_MIGRATIONS: FeatureMigration[] = [...databases, ...collab, ...editor, ...io, ...ai, ...mcp, ...history, ...accountSecurity, ...navigation, ...dateReminders, ...organize];
