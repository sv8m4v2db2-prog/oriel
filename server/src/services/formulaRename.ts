// I2 (formules structurées): renaming a property rewrites the formulas that name it, in the same
// transaction: prop("…") and page.prop("…") of its own database, and page.prop("…") of the other
// databases of the workspace whose formulas walk relations to it. Formulas are rewritten whoever can
// read them: their meaning does not change.
import type { PropertyDef } from '@oriel/shared';
import { formulaReadsPages, renameFormulaReferences, renameRelatedFormulaReferences } from '@oriel/shared';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/rows.js';

interface RenameScope {
  databaseId: string;
  workspaceId: string;
  /** Other databases whose schema changed (their viewers are notified). */
  touched?: Set<string>;
}

/**
 * Schema `properties` of `scope.databaseId` (after renaming `propId` from `oldName`) with its formulas
 * rewritten; formulas of the other databases of the workspace are rewritten and saved too.
 */
export function renameFormulaReferencesInWorkspace(db: Db, scope: RenameScope, properties: PropertyDef[], propId: string, oldName: string): PropertyDef[] {
  const rows = db.all<{ page_id: string; properties: string }>(
    'SELECT d.page_id, d.properties FROM databases d JOIN pages p ON p.id = d.page_id WHERE p.workspace_id = ?',
    scope.workspaceId,
  );
  const schemas = new Map<string, PropertyDef[]>();
  for (const r of rows) schemas.set(r.page_id, parseJson<PropertyDef[]>(r.properties, []));
  schemas.set(scope.databaseId, properties);
  const schemaOf = (id: string) => schemas.get(id);

  const next = renameFormulaReferences(properties, propId, oldName, { databaseId: scope.databaseId, schemaOf });
  schemas.set(scope.databaseId, next);
  for (const [id, props] of schemas) {
    if (id === scope.databaseId || !props.some((p) => p.type === 'formula' && formulaReadsPages(p.formula))) continue;
    const rewritten = renameRelatedFormulaReferences(props, id, scope.databaseId, next, propId, oldName, schemaOf);
    if (!rewritten) continue;
    db.run('UPDATE databases SET properties = ?, version = version + 1 WHERE page_id = ?', JSON.stringify(rewritten), id);
    scope.touched?.add(id);
  }
  return next;
}
