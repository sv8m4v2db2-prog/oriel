// Modal of the relation schema (D29); the diagram itself is loaded on demand.
import { lazy, Suspense } from 'react';
import { Modal } from '@mantine/core';
import { Network } from 'lucide-react';
import { MenuItem } from '../ui/primitives';
import { openRelationGraph, useOpenRelationGraph } from './relationGraphStore';

const RelationGraph = lazy(() => import('./RelationGraph'));

/** Entry of the database menu. */
export function RelationGraphMenuItem({ databaseId, onOpen }: { databaseId: string; onOpen?: () => void }) {
  return (
    <MenuItem
      icon={<Network size={14} />}
      label="Schéma des relations"
      onClick={() => {
        onOpen?.();
        openRelationGraph(databaseId);
      }}
    />
  );
}

/** Rendered once per database toolbar: shows the schema of the database it belongs to. */
export function RelationGraphHost({ databaseId }: { databaseId: string }) {
  const open = useOpenRelationGraph();
  if (open !== databaseId) return null;
  return (
    <Modal opened onClose={() => openRelationGraph(null)} title="Schéma des relations" centered size="xl" zIndex={400}>
      <Suspense fallback={<div className="ordb-skeleton is-short" />}>
        <RelationGraph databaseId={databaseId} onNavigate={() => openRelationGraph(null)} />
      </Suspense>
    </Modal>
  );
}
