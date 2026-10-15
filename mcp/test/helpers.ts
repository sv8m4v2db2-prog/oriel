// End-to-end helpers: a real Oriel server on a temporary data directory (server test helpers),
// personal API tokens, and an MCP client connected in memory to the Oriel MCP server.
import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CreatedApiToken } from '@oriel/shared';
import { Client as HttpClient, expectOk } from '../../server/test/helpers.js';
import { createOrielMcpServer } from '../src/server.js';

export { Client as HttpClient, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from '../../server/test/helpers.js';

export async function createToken(client: HttpClient, body: Record<string, unknown>): Promise<CreatedApiToken> {
  return expectOk(await client.post<CreatedApiToken>('/me/tokens', body));
}

export interface Mcp {
  client: McpClient;
  /** Calls a tool; returns its text parts (fails on isError unless `allowError`). */
  call(name: string, args?: Record<string, unknown>, opts?: { allowError?: boolean }): Promise<{ texts: string[]; isError: boolean }>;
  /** Calls a tool whose first text part is JSON. */
  json<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export async function connectMcp(url: string, token: string, defaultWorkspace?: string): Promise<Mcp> {
  const { server } = createOrielMcpServer({ url, token, defaultWorkspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ name: 'oriel-test', version: '1.0.0' });
  await client.connect(clientTransport);
  const call: Mcp['call'] = async (name, args = {}, opts = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const texts = res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
    if (res.isError && !opts.allowError) assert.fail(`${name} → ${texts.join('\n')}`);
    return { texts, isError: !!res.isError };
  };
  return {
    client,
    call,
    async json(name, args) {
      const { texts } = await call(name, args);
      return JSON.parse(texts[0]!);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
