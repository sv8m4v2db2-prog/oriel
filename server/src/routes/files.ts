// Uploads (ARCHITECTURE §3.7). Files are served by capability URL (128-bit random id), no session.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UploadedFile } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, HttpError, notFound, payloadTooLarge } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { requireWorkspace } from '../access.js';

interface FileRow {
  id: string;
  workspace_id: string;
  uploader_id: string;
  name: string;
  mime: string;
  size: number;
  created_at: number;
}

const widParams = z.object({ wid: idParam });
const fileParams = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().max(1000) });

export function sanitizeFileName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(0, 200);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'fichier';
}

function sanitizeMime(mime: string | undefined): string {
  const m = (mime ?? '').toLowerCase().split(';')[0]!.trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(m) ? m : 'application/octet-stream';
}

const isInlineType = (mime: string) =>
  mime !== 'image/svg+xml' && (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf');

function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const maxBytes = config.maxUploadMb * 1024 * 1024;

  app.post('/api/workspaces/:wid/files', async (req): Promise<UploadedFile> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'edit');
    if (!req.isMultipart()) throw badRequest('Envoi multipart attendu (champ « file »).');
    const tooLarge = () => payloadTooLarge(`Fichier trop volumineux (maximum ${config.maxUploadMb} Mo).`);
    let part;
    try {
      part = await req.file({ limits: { fileSize: maxBytes, files: 1, fields: 10 } });
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) throw tooLarge();
      throw badRequest('Envoi de fichier invalide.');
    }
    if (!part) throw badRequest('Aucun fichier reçu.');
    const id = randomBytes(16).toString('hex');
    const dest = path.join(config.uploadsDir, id);
    try {
      await pipeline(part.file, fs.createWriteStream(dest, { flags: 'wx' }));
      if (part.file.truncated) throw tooLarge();
    } catch (err) {
      await fs.promises.rm(dest, { force: true });
      if (err instanceof HttpError) throw err;
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) throw tooLarge();
      throw err;
    }
    const size = (await fs.promises.stat(dest)).size;
    const name = sanitizeFileName(part.filename);
    const mime = sanitizeMime(part.mimetype);
    db.run(
      'INSERT INTO files (id, workspace_id, uploader_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      wid,
      user.id,
      name,
      mime,
      size,
      Date.now(),
    );
    return { id, name, mime, size, url: `/api/files/${id}/${encodeURIComponent(name)}` };
  });

  app.get('/api/files/:id/:name', async (req, reply) => {
    const { id } = parse(fileParams, req.params);
    const row = db.get<FileRow>('SELECT * FROM files WHERE id = ?', id);
    if (!row) throw notFound('Fichier introuvable.');
    const filePath = path.join(config.uploadsDir, row.id);
    let total: number;
    try {
      total = (await fs.promises.stat(filePath)).size;
    } catch {
      throw notFound('Fichier introuvable.');
    }
    const inline = isInlineType(row.mime);
    // A file served as an attachment and loaded in a frame (e.g. a PDF block pointing at a non-PDF
    // upload) would start a download for every reader of the page, anonymous visitors included.
    const dest = req.headers['sec-fetch-dest'];
    if (!inline && (dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object')) {
      throw forbidden('Ce fichier ne peut pas être affiché dans la page.');
    }
    reply
      .header('Content-Type', row.mime)
      .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', row.name))
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Accept-Ranges', 'bytes');
    if (row.mime !== 'application/pdf') {
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    }
    if (total === 0) return reply.header('Content-Length', 0).send(Buffer.alloc(0));
    let start = 0;
    let end = total - 1;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        if (m[1] === '') {
          start = Math.max(0, total - Number(m[2]));
        } else {
          start = Number(m[1]);
          end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        }
        if (start > end || start >= total) {
          return reply.code(416).header('Content-Range', `bytes */${total}`).send();
        }
        reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`);
      }
    }
    reply.header('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return reply.send();
    return reply.send(fs.createReadStream(filePath, { start, end }));
  });
}
