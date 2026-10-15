// MCP server of Oriel: every tool, bound to one Oriel session (API client + token).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Oriel, type OrielOptions } from './oriel.js';
import { OrielClient, MCP_VERSION, type ClientOptions } from './client.js';
import { registerPageTools } from './tools/pages.js';
import { registerDatabaseTools } from './tools/databases.js';
import { registerCollabTools } from './tools/collab.js';
import { registerOrganizeTools } from './tools/organize.js';

export const INSTRUCTIONS = `Oriel est un espace de travail collaboratif (pages de blocs, bases de données dont chaque ligne est une page).
- Commencez par oriel_whoami (droits du jeton, espaces) ; oriel_search et oriel_list_pages pour trouver des pages ; oriel_read_page pour les lire.
- Contenu en Markdown. Références Oriel : [Titre](oriel://page/<id>) (seul sur sa ligne = carte de page ; dans une phrase = mention), [@Nom](oriel://user/<id>), [📅 date](oriel://date/AAAA-MM-JJ), > 💡 encadré, <details><summary>…</summary>…</details> = dépliable. Recopiez tels quels les liens oriel:// que vous lisez.
- Bases : oriel_get_database (schéma) puis oriel_query_database (filtres par nom de propriété). Les valeurs s'écrivent sous forme lisible : nom d'option, date AAAA-MM-JJ, personne par nom ou e-mail, relation par titre de ligne.
- Avant un remplacement complet (oriel_write_page_content mode 'replace'), lisez la page : l'ancien contenu reste dans l'historique mais les commentaires ancrés et les couleurs absents du Markdown sont perdus. Préférez 'append' pour ajouter.
- Tags et collections : oriel_list_tags, oriel_list_collections, puis oriel_query_pages (par tag ou collection, paginé).
- Un jeton « lecture seule » refuse toute modification (erreur 403) : dites-le à l'utilisateur plutôt que de réessayer.`;

export interface McpServerOptions extends OrielOptions {
  url: string;
  token: string;
  client?: ClientOptions;
}

export function createOrielMcpServer(opts: McpServerOptions): { server: McpServer; oriel: Oriel } {
  const client = new OrielClient(opts.url, opts.token, opts.client);
  const oriel = new Oriel(client, { defaultWorkspace: opts.defaultWorkspace });
  const server = new McpServer({ name: 'oriel', title: 'Oriel', version: MCP_VERSION }, { instructions: INSTRUCTIONS });
  const ctx = { oriel };
  registerPageTools(server, ctx);
  registerDatabaseTools(server, ctx);
  registerCollabTools(server, ctx);
  registerOrganizeTools(server, ctx);
  return { server, oriel };
}
