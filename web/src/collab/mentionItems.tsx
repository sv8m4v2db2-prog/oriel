// Suggestion items for "@" (and "[["): people of the workspace and dates.
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { Bell, CalendarDays, NotebookPen } from 'lucide-react';
import { COLLAB_TYPES, type Member } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { queryClient } from '../lib/queryClient';
import { normalizeText } from '../lib/util';
import { Avatar } from '../components/common';
import { dateSuggestions, formatDateLabel } from './dates';
import { naturalDayKey, parseNaturalDate } from '../lib/naturalDate';
import { openJournalDay } from '../journal/openJournal';

const G_PEOPLE = 'Personnes';
const G_DATES = 'Dates';
const G_REMINDERS = 'Rappels';
const G_JOURNAL = 'Journal';

interface InsertTarget {
  insertInlineContent: (content: any) => void;
}

async function members(workspaceId: string): Promise<Member[]> {
  try {
    return await queryClient.fetchQuery({ queryKey: qk.members(workspaceId), queryFn: () => api.workspaces.members(workspaceId), staleTime: 60_000 });
  } catch {
    return queryClient.getQueryData<Member[]>(qk.members(workspaceId)) ?? [];
  }
}

export async function peopleAndDateItems(
  editor: InsertTarget,
  workspaceId: string,
  query: string,
  opts: { currentUserId?: string | null; reminders?: boolean } = {},
): Promise<DefaultReactSuggestionItem[]> {
  const q = normalizeText(query);
  const list = await members(workspaceId);
  const people = list
    .filter((m) => {
      if (!q) return true;
      const name = normalizeText(m.user.name);
      return name.includes(q) || name.split(/\s+/).some((p) => p.startsWith(q)) || normalizeText(m.user.email).startsWith(q);
    })
    .sort((a, b) => {
      const as = normalizeText(a.user.name).startsWith(q) ? 0 : 1;
      const bs = normalizeText(b.user.name).startsWith(q) ? 0 : 1;
      return as - bs || a.user.name.localeCompare(b.user.name, 'fr');
    })
    .slice(0, q ? 6 : 5)
    .map<DefaultReactSuggestionItem>((m) => ({
      title: m.user.name,
      subtext: m.user.id === opts.currentUserId ? `${m.user.email} · vous` : m.user.email,
      group: G_PEOPLE,
      icon: <Avatar name={m.user.name} id={m.user.id} url={m.user.avatarUrl} size={20} />,
      onItemClick: () => editor.insertInlineContent([{ type: COLLAB_TYPES.userMention, props: { userId: m.user.id } }, ' ']),
    }));

  // Natural language first (« vendredi prochain », « dans 3 jours », « 12 nov », « lundi 14h »);
  // a date mention only keeps the day.
  const natural = parseNaturalDate(query);
  const fromWords = natural ? { label: formatDateLabel(naturalDayKey(natural.start), new Date(), true), date: naturalDayKey(natural.start) } : null;
  const dates = [...(fromWords ? [fromWords] : []), ...dateSuggestions(query).filter((d) => d.date !== fromWords?.date)].slice(0, 4);
  const dateItems = dates.map<DefaultReactSuggestionItem>((d) => ({
    title: d.label,
    subtext: 'Date',
    group: G_DATES,
    icon: <CalendarDays size={18} />,
    onItemClick: () => editor.insertInlineContent([{ type: COLLAB_TYPES.dateMention, props: { date: d.date, reminder: false, userId: '' } }, ' ']),
  }));
  const reminderItems =
    opts.reminders && opts.currentUserId && dates.length > 0 && q.length > 0
      ? dates.slice(0, 1).map<DefaultReactSuggestionItem>((d) => ({
          title: `Me rappeler : ${d.label}`,
          subtext: 'Notification le jour même à 9 h',
          group: G_REMINDERS,
          icon: <Bell size={18} />,
          onItemClick: () =>
            editor.insertInlineContent([{ type: COLLAB_TYPES.dateMention, props: { date: d.date, reminder: true, userId: opts.currentUserId! } }, ' ']),
        }))
      : [];
  // A date written in words also offers the journal page of that day (opens it, creating it if needed).
  // Only years the journal accepts (2000-2100) are offered.
  const journalItems =
    fromWords && Number(fromWords.date.slice(0, 4)) >= 2000 && Number(fromWords.date.slice(0, 4)) <= 2100
      ? [
          {
            title: `Journal : ${fromWords.label}`,
            subtext: 'Ouvrir ou créer la page de ce jour',
            group: G_JOURNAL,
            icon: <NotebookPen size={18} />,
            onItemClick: () => void openJournalDay(workspaceId, fromWords.date),
          } satisfies DefaultReactSuggestionItem,
        ]
      : [];
  return [...people, ...dateItems, ...journalItems, ...reminderItems];
}
