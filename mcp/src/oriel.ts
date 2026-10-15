// Oriel session of one MCP server instance: the API client plus small caches (session, tree,
// members) and the helpers shared by the tools (workspace resolution, page lookups, web URLs).
import type {
  ApiTokenInfo,
  Member,
  PageDetailResponse,
  SessionResponse,
  TreeNode,
  TreeResponse,
  WorkspaceSummary,
} from '@oriel/shared';
import { OrielApiError, OrielClient } from './client.js';
import type { ResolvedPage } from './content/markdown.js';

const SESSION_TTL = 60_000;
const TREE_TTL = 5_000;
const MEMBERS_TTL = 60_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export const looseKey = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export interface OrielOptions {
  /** ORIEL_WORKSPACE: default workspace (id or name). */
  defaultWorkspace?: string | null;
}

export class Oriel {
  private session: Cached<SessionResponse> | null = null;
  private token: Cached<ApiTokenInfo | null> | null = null;
  private readonly trees = new Map<string, Cached<TreeNode[]>>();
  private readonly memberLists = new Map<string, Cached<Member[]>>();

  constructor(
    readonly client: OrielClient,
    readonly options: OrielOptions = {},
  ) {}

  get baseUrl(): string {
    return this.client.baseUrl;
  }

  private cached<T>(entry: Cached<T> | null | undefined, ttl: number, load: () => Promise<T>, store: (c: Cached<T>) => void): Promise<T> {
    if (entry && Date.now() - entry.at < ttl) return entry.value;
    const value = load();
    const c = { at: Date.now(), value };
    store(c);
    value.catch(() => {
      // Never cache failures.
      store({ at: 0, value });
    });
    return value;
  }

  me(): Promise<SessionResponse> {
    return this.cached(this.session, SESSION_TTL, () => this.client.get<SessionResponse>('/auth/me'), (c) => (this.session = c));
  }

  /** Scope / workspace / expiry of the token in use (null when the server cannot tell). */
  tokenInfo(): Promise<ApiTokenInfo | null> {
    return this.cached(
      this.token,
      SESSION_TTL,
      () =>
        this.client.get<ApiTokenInfo>('/me/current-token').catch((err) => {
          if (err instanceof OrielApiError && err.status === 404) return null;
          throw err;
        }),
      (c) => (this.token = c),
    );
  }

  /** Workspace by id or name; default: ORIEL_WORKSPACE, then the token's workspace, then the first one. */
  async workspace(ref?: string | null): Promise<WorkspaceSummary> {
    const { workspaces } = await this.me();
    if (workspaces.length === 0) throw new Error("Ce compte n'appartient à aucun espace de travail accessible avec ce jeton.");
    const wanted = (ref ?? '').trim() || (this.options.defaultWorkspace ?? '').trim();
    if (wanted) {
      const found = workspaces.find((w) => w.id === wanted) ?? workspaces.find((w) => looseKey(w.name) === looseKey(wanted));
      if (!found) {
        throw new Error(`Espace « ${wanted} » introuvable. Espaces accessibles : ${workspaces.map((w) => `${w.name} (${w.id})`).join(', ')}.`);
      }
      return found;
    }
    return workspaces[0]!;
  }

  tree(workspaceId: string): Promise<TreeNode[]> {
    return this.cached(
      this.trees.get(workspaceId),
      TREE_TTL,
      async () => (await this.client.get<TreeResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/tree`)).nodes,
      (c) => this.trees.set(workspaceId, c),
    );
  }

  /** Members of a workspace (cached; `fresh` reloads, e.g. after a lookup miss). */
  members(workspaceId: string, opts: { fresh?: boolean } = {}): Promise<Member[]> {
    return this.cached(
      opts.fresh ? null : this.memberLists.get(workspaceId),
      MEMBERS_TTL,
      () => this.client.get<Member[]>(`/workspaces/${encodeURIComponent(workspaceId)}/members`),
      (c) => this.memberLists.set(workspaceId, c),
    );
  }

  /** Page detail without recording a visit. */
  page(pageId: string): Promise<PageDetailResponse> {
    return this.client.get<PageDetailResponse>(`/pages/${encodeURIComponent(pageId)}?visit=0`);
  }

  /** Forget cached trees after a write (titles, moves, new pages). */
  invalidate(workspaceId?: string): void {
    if (workspaceId) this.trees.delete(workspaceId);
    else this.trees.clear();
  }

  /** Page / database of `workspaceId` visible to the user (tree first, then a lookup for rows), or null. */
  async resolvePage(workspaceId: string, id: string): Promise<ResolvedPage | null> {
    const node = (await this.tree(workspaceId)).find((n) => n.id === id);
    if (node) return { id, kind: node.kind, parentType: node.parentType, parentId: node.parentId };
    try {
      const { page } = await this.page(id);
      if (page.workspaceId !== workspaceId || page.trashedAt !== null) return null;
      return { id, kind: page.kind, parentType: page.parentType, parentId: page.parentId };
    } catch (err) {
      if (err instanceof OrielApiError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  /** Titles of pages (tree, then individual lookups for rows), for Markdown links. */
  async titles(workspaceId: string, ids: Iterable<string>, max = 50): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const tree = await this.tree(workspaceId);
    const byId = new Map(tree.map((n) => [n.id, n]));
    const missing: string[] = [];
    for (const id of ids) {
      const node = byId.get(id);
      if (node) out.set(id, node.title || 'Sans titre');
      else missing.push(id);
    }
    await Promise.all(
      missing.slice(0, max).map(async (id) => {
        try {
          out.set(id, (await this.page(id)).page.title || 'Sans titre');
        } catch {
          /* inaccessible: rendered as "Sans titre" */
        }
      }),
    );
    return out;
  }

  /** Link to the page in the Oriel web app. */
  webUrl(workspaceId: string, pageId: string): string {
    return `${this.baseUrl}/w/${workspaceId}/p/${pageId}`;
  }
}
