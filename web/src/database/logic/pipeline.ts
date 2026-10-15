// Rows displayed by a view: manual order (the view's own, else page positions) → filters → search → sorts.
import type { Page, ViewConfig } from '@oriel/shared';
import { activeRuleCount, applySearch, matchesFilter, prepareFilter } from './filter';
import { normalizeText } from './text';
import { applySorts, sortByManualOrder } from './sort';
import type { RowContext } from './values';

export interface DeriveOptions {
  /** Title search from the toolbar. */
  search?: string;
  /** Rows that stay visible even if they don't match (rows just created in this view). */
  keepIds?: ReadonlySet<string>;
  /** I1: the view's own manual order (row id → fractional index); page positions otherwise. */
  rowOrder?: Readonly<Record<string, string>>;
}

export function deriveRows(
  rows: readonly Page[],
  config: Pick<ViewConfig, 'filter' | 'sorts'>,
  ctx: RowContext,
  opts: DeriveOptions = {},
): Page[] {
  let out = sortByManualOrder(rows, opts.rowOrder);
  const prepared = prepareFilter(config.filter, out, ctx);
  const query = normalizeText((opts.search ?? '').trim());
  const keep = opts.keepIds;
  if (activeRuleCount(prepared) > 0 || query) {
    const now = ctx.now();
    out = out.filter(
      (row) =>
        (keep?.has(row.id) ?? false) ||
        ((!query || normalizeText(row.title).includes(query)) && matchesFilter(row, prepared, ctx, now)),
    );
  }
  if (config.sorts && config.sorts.length > 0) out = applySorts(out, config.sorts, ctx);
  return out;
}

export { applySearch };
