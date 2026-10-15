import type { ApiErrorBody } from '@oriel/shared';

/** An error that maps directly to an HTTP response with an ApiErrorBody. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export const unauthorized = (message = 'Vous devez être connecté.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = "Vous n'avez pas les droits nécessaires pour cette action.") =>
  new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Ressource introuvable.') => new HttpError(404, 'not_found', message);
export const badRequest = (message = 'Requête invalide.') => new HttpError(400, 'validation', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const rateLimited = (message = 'Trop de tentatives. Réessayez dans une minute.') =>
  new HttpError(429, 'rate_limited', message);
export const payloadTooLarge = (message = 'Contenu trop volumineux.') => new HttpError(413, 'payload_too_large', message);

export const pageNotFound = () => notFound('Page introuvable.');
export const workspaceNotFound = () => notFound('Espace de travail introuvable.');
export const cannotEdit = () => forbidden("Vous n'avez pas les droits de modification.");
