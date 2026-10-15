// Entry point: `node oriel-mcp.mjs` (stdio) or `node oriel-mcp.mjs --http --port 3333`.
// Logs go to stderr only (stdout carries the MCP protocol in stdio mode). The token is never logged.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_VERSION } from './client.js';
import { ConfigError, parseConfig, USAGE } from './config.js';
import { startHttpServer } from './http.js';
import { createOrielMcpServer } from './server.js';

const log = (msg: string) => process.stderr.write(`[oriel-mcp] ${msg}\n`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${MCP_VERSION}\n`);
    return;
  }
  const config = parseConfig(argv, process.env);
  if (config.http) {
    const http = await startHttpServer({ url: config.url, token: config.token, workspace: config.workspace, ...config.http, log });
    log(`v${MCP_VERSION} — Streamable HTTP sur ${http.url} → ${config.url} (${config.token ? 'jeton configuré' : 'jeton de chaque client'})`);
    const stop = () => void http.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  const { server } = createOrielMcpServer({ url: config.url, token: config.token!, defaultWorkspace: config.workspace });
  await server.connect(new StdioServerTransport());
  log(`v${MCP_VERSION} — stdio → ${config.url}`);
}

main().catch((err) => {
  log(err instanceof ConfigError ? err.message : `erreur fatale : ${(err as Error)?.message ?? String(err)}`);
  process.exit(1);
});
