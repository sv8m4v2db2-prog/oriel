// Who may restore a version from the history panel (G6). The server checks the edit right and the
// trash; a locked page (format.locked, a guard against accidental edits that any editor can lift)
// is read-only in the editor, find & replace and here alike (QA-G6-06).
import type { Page } from '@oriel/shared';

export function canRestoreVersions(detail: { canEdit: boolean; page: Pick<Page, 'kind' | 'trashedAt' | 'format'> } | undefined): boolean {
  if (!detail?.canEdit) return false;
  const { page } = detail;
  if (page.trashedAt) return false;
  return page.kind === 'database' || !page.format?.locked;
}
