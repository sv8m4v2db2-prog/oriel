// Small shared helpers: colors, formatting, downloads, routing bridge.
import { useEffect } from 'react';
import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns';
import { fr } from 'date-fns/locale';

// --- Collaborator colors ------------------------------------------------------

const USER_COLORS = [
  '#e8590c',
  '#2f9e44',
  '#1c7ed6',
  '#ae3ec9',
  '#d6336c',
  '#0c8599',
  '#f08c00',
  '#5f3dc4',
  '#c92a2a',
  '#2b8a3e',
  '#364fc7',
  '#a61e4d',
];

/** Deterministic color for a user id. */
export function userColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return USER_COLORS[Math.abs(h) % USER_COLORS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// --- Dates ---------------------------------------------------------------------

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return `Aujourd’hui à ${format(d, 'HH:mm', { locale: fr })}`;
  if (isYesterday(d)) return `Hier à ${format(d, 'HH:mm', { locale: fr })}`;
  return format(d, 'd MMMM yyyy à HH:mm', { locale: fr });
}

/** Inline wording: « aujourd’hui à 14:05 », « hier à 09:12 », « le 3 mars 2026 à 10:00 ». */
export function formatWhen(ts: number): string {
  const d = new Date(ts);
  const time = format(d, 'HH:mm', { locale: fr });
  if (isToday(d)) return `aujourd’hui à ${time}`;
  if (isYesterday(d)) return `hier à ${time}`;
  return `le ${format(d, 'd MMMM yyyy', { locale: fr })} à ${time}`;
}

export function formatDate(ts: number): string {
  return format(new Date(ts), 'd MMMM yyyy', { locale: fr });
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'à l’instant';
  return `il y a ${formatDistanceToNowStrict(new Date(ts), { locale: fr })}`;
}

// --- Downloads -----------------------------------------------------------------

export function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title: string, ext: string): string {
  const base = (title || 'Sans titre').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${base || 'Sans titre'}.${ext}`;
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// --- Text ----------------------------------------------------------------------

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export const UNTITLED = 'Sans titre';

export function pageTitle(title: string | null | undefined): string {
  return title && title.trim() ? title : UNTITLED;
}

// --- Routing bridge (usable outside React components) --------------------------

let navigateFn: ((to: string, opts?: { replace?: boolean }) => void) | null = null;

export function registerAppNavigate(fn: (to: string, opts?: { replace?: boolean }) => void) {
  navigateFn = fn;
}

export function appNavigate(to: string, opts?: { replace?: boolean }) {
  if (navigateFn) navigateFn(to, opts);
  else window.location.assign(to);
}

export const pagePath = (workspaceId: string, pageId: string) => `/w/${workspaceId}/p/${pageId}`;
export const sharePath = (pageId: string) => `/share/${pageId}`;

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export const modKey = () => (isMac() ? '⌘' : 'Ctrl+');

/** Sets <title> while the component is mounted. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Oriel` : 'Oriel';
  }, [title]);
}
