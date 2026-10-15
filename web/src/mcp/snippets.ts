// Ready-to-paste configuration of the Oriel MCP server for Claude Desktop and Claude Code.

/** Where the user's checkout keeps the built server (they adapt the path). */
export const MCP_SCRIPT_PLACEHOLDER = '/chemin/vers/Oriel/mcp/dist/oriel-mcp.mjs';
export const TOKEN_PLACEHOLDER = 'or_VOTRE_JETON';

export interface SnippetInput {
  url: string;
  token?: string | null;
  workspaceId?: string | null;
}

function envOf({ url, token, workspaceId }: SnippetInput): Record<string, string> {
  const env: Record<string, string> = { ORIEL_URL: url, ORIEL_TOKEN: token || TOKEN_PLACEHOLDER };
  if (workspaceId) env.ORIEL_WORKSPACE = workspaceId;
  return env;
}

/** `claude_desktop_config.json` (Réglages › Développeur › Modifier la configuration). */
export function claudeDesktopSnippet(input: SnippetInput): string {
  return JSON.stringify({ mcpServers: { oriel: { command: 'node', args: [MCP_SCRIPT_PLACEHOLDER], env: envOf(input) } } }, null, 2);
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** `claude mcp add …` command for Claude Code. */
export function claudeCodeSnippet(input: SnippetInput): string {
  const env = Object.entries(envOf(input))
    .map(([k, v]) => `--env ${k}=${shellQuote(v)}`)
    .join(' ');
  return `claude mcp add oriel ${env} -- node ${MCP_SCRIPT_PLACEHOLDER}`;
}
