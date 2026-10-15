// Opens (creating on first use) the journal page of a day. Usable outside React: the `@` menu,
// the global shortcut and the calendar all go through here.
import { qk } from '../lib/queryKeys';
import { errorMessage, queryClient } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { appNavigate, pagePath } from '../lib/util';
import { orgApi } from '../organize/api';
import { invalidateOrg } from '../organize/hooks';
import { dayKey, dayLabel } from './calendar';

/** Server round trip only: resolves the page of the day. */
export async function resolveJournalDay(workspaceId: string, day: string) {
  const r = await orgApi.openDay(workspaceId, day);
  if (r.created) {
    invalidateOrg('journal');
    void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
  }
  return r;
}

export async function openJournalDay(workspaceId: string, day: string): Promise<void> {
  try {
    const r = await resolveJournalDay(workspaceId, day);
    appNavigate(pagePath(workspaceId, r.pageId));
  } catch (e) {
    toast.error(errorMessage(e, `Impossible d’ouvrir le journal du ${dayLabel(day)}.`));
  }
}

export const openJournalToday = (workspaceId: string) => openJournalDay(workspaceId, dayKey(new Date()));
