// Shared fixtures for the logic unit tests (not used by the app).
import type { Page, PropertyDef, PropertyValue, PublicUser } from '@oriel/shared';
import { createRowContext, type RowContext } from './values';

export const NOW = new Date(2026, 9, 13, 10, 30); // 13 Oct 2026, 10:30 local

export const SCHEMA: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'notes', name: 'Notes', type: 'text' },
  { id: 'prix', name: 'Prix', type: 'number', numberFormat: 'euro' },
  { id: 'qte', name: 'Quantité', type: 'number', numberFormat: 'number' },
  {
    id: 'cat',
    name: 'Catégorie',
    type: 'select',
    options: [
      { id: 'o1', name: 'Bleu', color: 'blue' },
      { id: 'o2', name: 'Rouge', color: 'red' },
      { id: 'o3', name: 'Vert', color: 'green' },
    ],
  },
  {
    id: 'etat',
    name: 'État',
    type: 'status',
    options: [
      { id: 'done', name: 'Terminé', color: 'green', group: 'done' },
      { id: 'todo', name: 'Pas commencé', color: 'default', group: 'todo' },
      { id: 'doing', name: 'En cours', color: 'blue', group: 'in_progress' },
    ],
  },
  {
    id: 'tags',
    name: 'Étiquettes',
    type: 'multi_select',
    options: [
      { id: 't1', name: 'Urgent', color: 'red' },
      { id: 't2', name: 'Client', color: 'purple' },
    ],
  },
  { id: 'due', name: 'Échéance', type: 'date' },
  { id: 'fait', name: 'Fait', type: 'checkbox' },
  { id: 'resp', name: 'Responsable', type: 'person' },
  { id: 'liens', name: 'Liens', type: 'relation', relation: { databaseId: 'db2' } },
  { id: 'pj', name: 'Pièces jointes', type: 'files' },
  { id: 'total', name: 'Total', type: 'formula', formula: 'prop("Prix") * prop("Quantité")' },
  { id: 'ref', name: 'Réf', type: 'unique_id', uniqueIdPrefix: 'TASK' },
  { id: 'site', name: 'Site', type: 'url' },
  { id: 'cree', name: 'Créé le', type: 'created_time' },
  { id: 'auteur', name: 'Créé par', type: 'created_by' },
];

export const USERS: PublicUser[] = [
  { id: 'u1', name: 'Alice Martin', email: 'alice@example.test', avatarUrl: null },
  { id: 'u2', name: 'Bruno Petit', email: 'bruno@example.test', avatarUrl: null },
];

export const RELATED: Record<string, string> = { p1: 'Projet Alpha', p2: 'Projet Béta' };

let counter = 0;
export function makeRow(id: string, title: string, properties: Record<string, PropertyValue> = {}, extra: Partial<Page> = {}): Page {
  counter++;
  return {
    id,
    workspaceId: 'ws',
    parentType: 'database',
    parentId: 'db',
    kind: 'page',
    title,
    icon: null,
    cover: null,
    position: `a${String(counter).padStart(4, '0')}`,
    visibility: 'workspace',
    ownerId: 'u1',
    properties,
    format: {},
    isInline: false,
    isPublic: false,
    trashedAt: null,
    trashedBy: null,
    createdAt: new Date(2026, 0, 1).getTime(),
    createdBy: 'u1',
    updatedAt: new Date(2026, 0, 2).getTime(),
    updatedBy: 'u2',
    version: 1,
    ...extra,
  };
}

export function makeContext(properties: PropertyDef[] = SCHEMA): RowContext {
  return createRowContext(properties, {
    users: USERS,
    relationTitle: (id) => RELATED[id],
    now: () => NOW,
  });
}

export const prop = (id: string): PropertyDef => {
  const p = SCHEMA.find((x) => x.id === id);
  if (!p) throw new Error(`unknown property ${id}`);
  return p;
};

/** Replaces narrow / regular non-breaking spaces by plain spaces (Intl output differs by engine). */
export const spaces = (s: string) => s.replace(/[  ]/g, ' ');
