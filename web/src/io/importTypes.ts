// Types and small helpers of the import runner.
import type { TreeNode, Visibility } from '@oriel/shared';
import type { ImportPlan, PlanNode } from './plan';
import { looseKey } from './text';
import { extname } from './vfs';

export type ImportDestination = { type: 'root'; visibility: Visibility } | { type: 'page'; pageId: string; title: string };

export interface ImportProgress {
  phase: 'structure' | 'content' | 'files';
  done: number;
  total: number;
  label: string;
}

export interface ImportReport {
  created: { pages: number; databases: number; rows: number; files: number };
  roots: Array<{ id: string; title: string; kind: 'page' | 'database' }>;
  skipped: string[];
  warnings: string[];
  errors: string[];
  cancelled: boolean;
  durationMs: number;
}

export interface ImportOptions {
  workspaceId: string;
  destination: ImportDestination;
  /** Top-level items whose title already exists at the destination are not imported again. */
  skipExisting: boolean;
  existing: TreeNode[];
  signal: AbortSignal;
  onProgress: (p: ImportProgress) => void;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const mimeOf = (name: string): string => MIME[extname(name)] ?? 'application/octet-stream';

/** Block type showing an uploaded file of this MIME type. */
export const fileBlockType = (mime: string): 'image' | 'video' | 'audio' | 'file' =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';

/** Top-level items of the plan whose title already exists at the destination. */
export function findDuplicates(plan: ImportPlan, existing: TreeNode[]): PlanNode[] {
  const titles = new Set(existing.map((n) => `${n.kind}:${looseKey(n.title)}`));
  return plan.roots.filter((n) => titles.has(`${n.kind}:${looseKey(n.title)}`));
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
