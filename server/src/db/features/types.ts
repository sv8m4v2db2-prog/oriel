export interface FeatureMigration {
  /** Globally unique, stable id, e.g. "ai-001-briefs". */
  id: string;
  sql: string;
}
