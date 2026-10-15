// BlockNote ThreadStore backed by the Oriel REST API. Comment marks stay in the Yjs document
// (BlockNote's default anchoring); thread contents live on the server, which knows about them for
// notifications. Data flows through TanStack Query (key ck.threads) so that the real-time
// `comments` change invalidates it like any other query.
import { createUserStore, type BlockNoteEditor, type User as BnUser, type UserStore } from '@blocknote/core';
import { ThreadStore, ThreadStoreAuth, type CommentBody, type CommentData, type ThreadData } from '@blocknote/core/comments';
import { QueryObserver } from '@tanstack/react-query';
import type { CommentItem, CommentThread, Member, PublicUser, ThreadsResponse } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { queryClient, errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { collabApi } from './api';
import { ck } from './keys';
import { avatarDataUri } from './mentions';
import { safeCommentBody } from './commentBody';

export interface ThreadMeta {
  anchored: boolean;
  quote: string;
}

export const toBnUser = (u: PublicUser): BnUser => ({ id: u.id, username: u.name, avatarUrl: u.avatarUrl || avatarDataUri(u.name, u.id) });

function toCommentData(c: CommentItem): CommentData {
  return {
    type: 'comment',
    id: c.id,
    userId: c.userId,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    reactions: c.reactions.map((r) => ({ emoji: r.emoji, createdAt: new Date(r.createdAt), userIds: r.userIds })),
    metadata: {},
    // Stored JSON from any client: rebuilt so that BlockNote can always display it.
    body: safeCommentBody(c.body) as CommentBody,
  };
}

export function toThreadData(t: CommentThread): ThreadData {
  return {
    type: 'thread',
    id: t.id,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
    comments: t.comments.map(toCommentData),
    resolved: t.resolved,
    resolvedUpdatedAt: t.resolvedAt ? new Date(t.resolvedAt) : undefined,
    resolvedBy: t.resolvedBy ?? undefined,
    metadata: { anchored: t.anchored, quote: t.quote } satisfies ThreadMeta,
  };
}

export const threadMeta = (t: ThreadData): ThreadMeta => ({ anchored: t.metadata?.anchored !== false, quote: String(t.metadata?.quote ?? '') });

/** Permissions shown by BlockNote's comment UI (the server enforces them anyway). */
class RestThreadStoreAuth extends ThreadStoreAuth {
  constructor(
    private readonly userId: string,
    private readonly rights: { canComment: boolean; canModerate: boolean },
  ) {
    super();
  }
  canCreateThread() {
    return this.rights.canComment;
  }
  canAddComment() {
    return this.rights.canComment;
  }
  canUpdateComment(comment: CommentData) {
    return this.rights.canComment && comment.userId === this.userId;
  }
  canDeleteComment(comment: CommentData) {
    return this.rights.canComment && (comment.userId === this.userId || this.rights.canModerate);
  }
  canDeleteThread(thread: ThreadData) {
    return this.rights.canComment && (thread.comments[0]?.userId === this.userId || this.rights.canModerate);
  }
  canResolveThread() {
    return this.rights.canComment;
  }
  canUnresolveThread() {
    return this.rights.canComment;
  }
  canAddReaction(comment: CommentData, emoji?: string) {
    if (!this.rights.canComment) return false;
    return !emoji || !comment.reactions.some((r) => r.emoji === emoji && r.userIds.includes(this.userId));
  }
  canDeleteReaction(comment: CommentData, emoji?: string) {
    if (!this.rights.canComment) return false;
    return !emoji || comment.reactions.some((r) => r.emoji === emoji && r.userIds.includes(this.userId));
  }
}

/** User directory for the comment UI: preloaded with thread users, then workspace members. */
export function createWorkspaceUserStore(workspaceId: string): UserStore<BnUser> {
  return createUserStore<BnUser>(async (ids) => {
    const members = await queryClient.fetchQuery({
      queryKey: qk.members(workspaceId),
      queryFn: () => api.workspaces.members(workspaceId),
      staleTime: 60_000,
    });
    const found = (members as Member[]).filter((m) => ids.includes(m.user.id)).map((m) => toBnUser(m.user));
    // Former members: a neutral placeholder rather than an endless "loading" state.
    for (const id of ids) if (!found.some((u) => u.id === id)) found.push({ id, username: 'Ancien membre', avatarUrl: avatarDataUri('?', id) });
    return found;
  });
}

export class RestThreadStore extends ThreadStore {
  private threads = new Map<string, ThreadData>();
  private readonly subscribers = new Set<(threads: Map<string, ThreadData>) => void>();
  private observer: QueryObserver<ThreadsResponse> | null = null;
  private unsubscribe: (() => void) | null = null;
  readonly rights: { canComment: boolean; canModerate: boolean };
  /** Main editor (set by the controllers) — used to capture the commented text. */
  editor: BlockNoteEditor<any, any, any> | null = null;
  loaded = false;
  /** Not provided: BlockNote anchors new threads with its own comment mark (stored in the Yjs document). */
  addThreadToDocument: ThreadStore['addThreadToDocument'] = undefined;

  constructor(
    readonly pageId: string,
    readonly userId: string,
    readonly userStore: UserStore<BnUser>,
    initialRights: { canComment: boolean; canModerate: boolean },
  ) {
    const rights = { ...initialRights };
    super(new RestThreadStoreAuth(userId, rights));
    this.rights = rights;
  }

  start(): void {
    if (this.observer) return;
    this.observer = new QueryObserver<ThreadsResponse>(queryClient, {
      queryKey: ck.threads(this.pageId),
      queryFn: () => collabApi.threads(this.pageId),
      staleTime: 30_000,
    });
    this.unsubscribe = this.observer.subscribe((result) => {
      if (result.data) this.apply(result.data);
    });
    const current = this.observer.getCurrentResult();
    if (current.data) this.apply(current.data);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.observer = null;
  }

  private apply(data: ThreadsResponse): void {
    this.userStore.setUser(data.users.map(toBnUser));
    this.rights.canComment = data.canComment;
    this.rights.canModerate = data.canModerate;
    this.threads = new Map(data.threads.map((t) => [t.id, toThreadData(t)]));
    this.loaded = true;
    this.emit();
  }

  private emit(): void {
    for (const cb of this.subscribers) cb(this.threads);
  }

  /** Local update right after a successful call (the refetch confirms it). */
  private upsert(thread: CommentThread): void {
    const next = new Map(this.threads);
    next.set(thread.id, toThreadData(thread));
    this.threads = next;
    this.emit();
  }

  private refresh(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: ck.threads(this.pageId) });
  }

  private async run<T>(fn: () => Promise<T>, fallback = 'Action impossible.'): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      toast.error(errorMessage(err, fallback));
      void this.refresh();
      throw err;
    }
  }

  async createThread(options: { initialComment: { body: CommentBody; metadata?: unknown }; metadata?: Partial<ThreadMeta> }): Promise<ThreadData> {
    const anchored = options.metadata?.anchored !== false;
    let quote = options.metadata?.quote ?? '';
    if (anchored && !quote && this.editor) {
      try {
        quote = this.editor.getSelectedText();
      } catch {
        quote = '';
      }
    }
    const thread = await this.run(
      () => collabApi.createThread(this.pageId, { anchored, quote: quote.slice(0, 500), body: options.initialComment.body as unknown[] }),
      'Commentaire non enregistré.',
    );
    this.upsert(thread);
    void this.refresh();
    return toThreadData(thread);
  }

  async addComment(options: { comment: { body: CommentBody }; threadId: string }): Promise<CommentData> {
    const comment = await this.run(() => collabApi.addComment(options.threadId, { body: options.comment.body as unknown[] }), 'Réponse non enregistrée.');
    const t = this.threads.get(options.threadId);
    if (t) {
      const next = new Map(this.threads);
      next.set(t.id, { ...t, comments: [...t.comments, toCommentData(comment)] });
      this.threads = next;
      this.emit();
    }
    void this.refresh();
    return toCommentData(comment);
  }

  async updateComment(options: { comment: { body: CommentBody }; threadId: string; commentId: string }): Promise<void> {
    await this.run(() => collabApi.updateComment(options.commentId, options.comment.body as unknown[]));
    await this.refresh();
  }

  async deleteComment(options: { threadId: string; commentId: string }): Promise<void> {
    await this.run(() => collabApi.deleteComment(options.commentId));
    await this.refresh();
  }

  async deleteThread(options: { threadId: string }): Promise<void> {
    await this.run(() => collabApi.deleteThread(options.threadId));
    await this.refresh();
  }

  async resolveThread(options: { threadId: string }): Promise<void> {
    const t = await this.run(() => collabApi.resolveThread(options.threadId, true));
    this.upsert(t);
    void this.refresh();
  }

  async unresolveThread(options: { threadId: string }): Promise<void> {
    const t = await this.run(() => collabApi.resolveThread(options.threadId, false));
    this.upsert(t);
    void this.refresh();
  }

  async addReaction(options: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    await this.run(() => collabApi.react(options.commentId, options.emoji, true));
    await this.refresh();
  }

  async deleteReaction(options: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    await this.run(() => collabApi.react(options.commentId, options.emoji, false));
    await this.refresh();
  }

  getThread(threadId: string): ThreadData {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(`Discussion inconnue : ${threadId}`);
    return t;
  }

  getThreads(): Map<string, ThreadData> {
    return this.threads;
  }

  subscribe(cb: (threads: Map<string, ThreadData>) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }
}
