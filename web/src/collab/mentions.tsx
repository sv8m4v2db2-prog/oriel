// Person and date mentions (inline content of the page editor and of comment editors).
//   userMention { userId }                        → "@Prénom Nom" chip with avatar
//   dateMention { date, reminder, userId }         → localized date chip; click → "Me rappeler"
// The specs also carry BlockNote's comment mark (see withCommentMark) so that every editor built
// with the app schema — even without the comments extension (public pages, history previews,
// exports) — keeps the text of commented passages instead of dropping it.
import type { InlineContentSpec } from '@blocknote/core';
import { CommentMark } from '@blocknote/core/comments';
import { createReactInlineContentSpec } from '@blocknote/react';
import { Menu } from '@mantine/core';
import type { Node as TiptapNode } from '@tiptap/core';
import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, CalendarDays } from 'lucide-react';
import { COLLAB_TYPES, type Member } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { useSession } from '../lib/session';
import { initials, userColor } from '../lib/util';
import { propString } from '../lib/props';
import { useEditorEnv } from '../editor/env';
import { openProfile } from '../shell/nav/profile';
import { formatDateLabel, formatDateLong, isPast } from './dates';

// --- helpers ----------------------------------------------------------------------------

/** Members of a workspace (shared cache with the settings page). */
export function useWorkspaceMembers(workspaceId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.members(workspaceId ?? ''),
    queryFn: () => api.workspaces.members(workspaceId!),
    enabled: !!workspaceId && enabled,
    staleTime: 60_000,
  });
}

export function findMember(members: Member[] | undefined, userId: string) {
  return members?.find((m) => m.user.id === userId)?.user ?? null;
}

/** SVG avatar (initials on the user color) as a data URI — used where only an image URL is accepted. */
export function avatarDataUri(name: string, id: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${userColor(id)}"/><text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="26" font-weight="600" fill="#fff">${initials(name)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function MiniAvatar({ name, id, url }: { name: string; id: string; url: string | null }) {
  return (
    <span className="or-user-mention__avatar" style={{ background: url ? undefined : userColor(id) }} aria-hidden>
      {url ? <img src={url} alt="" draggable={false} /> : initials(name)}
    </span>
  );
}

/**
 * Adds BlockNote's `comment` mark to the editor through this inline content's node (TipTap
 * `addExtensions`), unless the comments extension already provides it. Applied to one spec only
 * (userMention), which every editor built with the app or comment schema includes.
 */
function withCommentMark<T extends InlineContentSpec<any>>(spec: T): T {
  const node = spec.implementation?.node as TiptapNode | undefined;
  if (!node) return spec;
  const extended = node.extend({
    // The base node has no sub-extensions; `this.parent` is not called (it can resolve to this very
    // function through configure()/extend() chains and would add the mark twice).
    addExtensions() {
      let hasComments = false;
      try {
        const editor = (this.options as { editor?: { getExtension?: (key: string) => unknown } }).editor;
        hasComments = !!editor?.getExtension?.('comments');
      } catch {
        hasComments = false;
      }
      return hasComments ? [] : [CommentMark];
    },
  });
  return { ...spec, implementation: { ...spec.implementation, node: extended } } as T;
}

// --- person mention -----------------------------------------------------------------------

function UserMentionChip({ userId }: { userId: string }) {
  const env = useEditorEnv();
  const isPublic = env.mode === 'public';
  const members = useWorkspaceMembers(env.workspaceId, !isPublic);
  const user = isPublic ? null : findMember(members.data, userId);
  const name = user?.name ?? (isPublic ? 'Membre' : members.isLoading ? '…' : 'Ancien membre');
  return (
    <span
      className={`or-user-mention${user ? ' is-link' : ' is-unknown'}`}
      data-user-id={userId}
      title={user ? `${user.email} — ouvrir le profil` : undefined}
      // Navigation module: a person mention opens their profile.
      onClick={user && env.workspaceId ? (e) => {
        e.preventDefault();
        openProfile(env.workspaceId!, user.id);
      } : undefined}
    >
      {user && <MiniAvatar name={user.name} id={user.id} url={user.avatarUrl} />}
      <span className="or-user-mention__name">@{name}</span>
    </span>
  );
}

export const UserMention = withCommentMark(
  createReactInlineContentSpec(
    { type: COLLAB_TYPES.userMention, propSchema: { userId: { default: '' } }, content: 'none' },
    {
      render: ({ inlineContent }) => <UserMentionChip userId={propString(inlineContent.props.userId)} />,
      toExternalHTML: function UserMentionExport({ inlineContent }) {
        const env = useEditorEnv();
        const members = useWorkspaceMembers(env.workspaceId, env.mode !== 'public');
        const user = findMember(members.data, inlineContent.props.userId);
        return <span>@{user?.name ?? 'membre'}</span>;
      },
    },
  ),
);

// --- date mention ---------------------------------------------------------------------------

interface DateProps {
  date: string;
  reminder: boolean;
  userId: string;
}

function DateMentionChip({
  props: raw,
  editable,
  onChange,
}: {
  props: DateProps;
  editable: boolean;
  onChange: (next: Partial<DateProps>) => void;
}) {
  // Values of the shared document: any JSON can be stored there.
  const props: DateProps = { date: propString(raw.date), reminder: raw.reminder === true, userId: propString(raw.userId) };
  const env = useEditorEnv();
  const session = useSession();
  const me = session.data?.user ?? null;
  const members = useWorkspaceMembers(env.workspaceId, props.reminder && !!props.userId && env.mode === 'app');
  const label = formatDateLabel(props.date);
  const past = isPast(props.date);
  const mine = props.reminder && !!me && props.userId === me.id;
  const reminderOwner = props.reminder && props.userId ? findMember(members.data, props.userId) : null;
  const title = props.reminder
    ? `${formatDateLong(props.date)} — rappel à 9 h${mine ? ' (pour vous)' : reminderOwner ? ` (pour ${reminderOwner.name})` : ''}`
    : formatDateLong(props.date);
  const chip = (
    <span
      className={`or-date-mention${props.reminder ? ' has-reminder' : ''}${past ? ' is-past' : ''}`}
      title={title}
      data-date={props.date}
      role={editable && env.mode === 'app' ? 'button' : undefined}
    >
      {props.reminder ? <Bell size={12} /> : <CalendarDays size={12} />}
      <span>{label}</span>
    </span>
  );
  if (!editable || env.mode !== 'app' || !me) return chip;
  return (
    <Menu position="bottom-start" withinPortal shadow="md" width={250}>
      <Menu.Target>{chip}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{formatDateLong(props.date)}</Menu.Label>
        {mine ? (
          <Menu.Item leftSection={<BellOff size={15} />} onClick={() => onChange({ reminder: false, userId: '' })}>
            Ne plus me rappeler
          </Menu.Item>
        ) : (
          <Menu.Item leftSection={<Bell size={15} />} onClick={() => onChange({ reminder: true, userId: me.id })}>
            {props.reminder ? 'Me rappeler à la place' : 'Me rappeler'}
            <span className="or-date-mention__hint">Notification le jour même à 9 h</span>
          </Menu.Item>
        )}
        <Menu.Divider />
        <div className="or-date-mention__edit" onMouseDown={(e) => e.stopPropagation()}>
          <label>
            Changer la date
            <input
              type="date"
              className="input"
              defaultValue={props.date}
              onChange={(e) => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange({ date: e.target.value });
              }}
            />
          </label>
        </div>
      </Menu.Dropdown>
    </Menu>
  );
}

export const DateMention = createReactInlineContentSpec(
  {
    type: COLLAB_TYPES.dateMention,
    propSchema: { date: { default: '' }, reminder: { default: false }, userId: { default: '' } },
    content: 'none',
  },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <DateMentionChip
        props={inlineContent.props as DateProps}
        editable={editor.isEditable}
        onChange={(next) =>
          updateInlineContent({ type: COLLAB_TYPES.dateMention, props: { ...(inlineContent.props as DateProps), ...next } } as never)
        }
      />
    ),
    toExternalHTML: ({ inlineContent }) => <span>{formatDateLong(propString(inlineContent.props.date))}</span>,
  },
);
