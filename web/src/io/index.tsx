// Import / export module (owned by the import-export team): Settings › Import / export.
// Heavy parts (headless editor, zip writer, import runner) are loaded on demand.
import type { ReactNode } from 'react';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { ExportCard } from './ExportCard';
import { ImportCard } from './ImportCard';
import './io.css';

/** Settings › Import / export tab content (workspace export zip, imports). */
export function ImportExportSettings(): ReactNode {
  const { canEdit } = useWorkspaceCtx();
  return (
    <div className="io-settings">
      <h1 className="settings__title">Import / export</h1>
      {canEdit ? (
        <>
          <ExportCard />
          <ImportCard />
        </>
      ) : (
        <p className="io-card io-muted">
          Avec le rôle « Lecteur », vous ne pouvez ni importer ni exporter cet espace. Demandez à un administrateur de modifier votre rôle.
        </p>
      )}
    </div>
  );
}
