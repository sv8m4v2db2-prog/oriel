// Configuration from the environment and the command line.
//   ORIEL_URL        https://notes.mondomaine.fr (required)
//   ORIEL_TOKEN      or_… personal API token (required for stdio; optional for --http, see http.ts)
//   ORIEL_WORKSPACE  default workspace (id or name, optional)
//   --http [--port 3333] [--host 127.0.0.1]   Streamable HTTP transport instead of stdio
import { API_TOKEN_PREFIX, hasApiTokenPrefix } from '@oriel/shared';

export interface McpConfig {
  url: string;
  token: string | null;
  workspace: string | null;
  http: { port: number; host: string } | null;
}

export class ConfigError extends Error {}

export const USAGE = `Serveur MCP d’Oriel

Usage : node oriel-mcp.mjs [--http [--port 3333] [--host 127.0.0.1]]

Variables d'environnement :
  ORIEL_URL        adresse de votre Oriel (ex. https://notes.mondomaine.fr)
  ORIEL_TOKEN      jeton d'API personnel (Réglages › API et MCP), commence par ${API_TOKEN_PREFIX}
  ORIEL_WORKSPACE  espace par défaut (id ou nom, facultatif)

Sans option, le serveur parle MCP sur l'entrée/sortie standard (Claude Desktop, Claude Code).
Avec --http, il écoute en Streamable HTTP sur /mcp ; chaque requête doit porter
« Authorization: Bearer <jeton> » (le jeton ORIEL_TOKEN, ou à défaut le jeton Oriel de l'appelant).`;

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): McpConfig {
  let http = false;
  let port = Number(env.ORIEL_MCP_PORT ?? 3333);
  let host = env.ORIEL_MCP_HOST ?? '127.0.0.1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--http') http = true;
    else if (a === '--port') port = Number(argv[++i]);
    else if (a.startsWith('--port=')) port = Number(a.slice(7));
    else if (a === '--host') host = argv[++i] ?? host;
    else if (a.startsWith('--host=')) host = a.slice(7);
    else throw new ConfigError(`Option inconnue : ${a}\n\n${USAGE}`);
  }
  const rawUrl = (env.ORIEL_URL ?? '').trim().replace(/\/+$/, '');
  if (!rawUrl) throw new ConfigError(`ORIEL_URL manquant.\n\n${USAGE}`);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`ORIEL_URL invalide : ${rawUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('ORIEL_URL doit commencer par https:// (ou http:// en local).');
  const token = (env.ORIEL_TOKEN ?? '').trim() || null;
  if (token && !hasApiTokenPrefix(token)) throw new ConfigError(`ORIEL_TOKEN doit être un jeton d'API Oriel (${API_TOKEN_PREFIX}…).`);
  if (!token && !http) throw new ConfigError(`ORIEL_TOKEN manquant : créez un jeton dans Oriel › Réglages › API et MCP.\n\n${USAGE}`);
  if (http && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new ConfigError('Port invalide.');
  return {
    url: url.origin + url.pathname.replace(/\/+$/, ''),
    token,
    workspace: (env.ORIEL_WORKSPACE ?? '').trim() || null,
    http: http ? { port, host } : null,
  };
}
