// Split view (lot E): reads the split from the URL, adopts plain page navigations, publishes the runtime.
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import { SPLIT_MIN_VIEWPORT, isSplit, parseSplit, replacePane, splitHref, type SplitState } from './splitLogic';
import { adoption, forgetSplit, maximizedStore, runtime } from './actions';

export interface SplitRoute {
  state: SplitState;
  /** More than one pane is shown (false on mobile, even if the URL carries a split). */
  active: boolean;
}

const SplitContext = createContext<SplitRoute>({ state: { panes: [], active: 0 }, active: false });
export const SplitProvider = SplitContext.Provider;
export const useSplitRoute = () => useContext(SplitContext);

const QUERY = `(max-width: ${SPLIT_MIN_VIEWPORT - 1}px)`;
function subscribeNarrow(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
/** Viewport narrower than 768 px: the split view is disabled. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(QUERY).matches, () => false);
}

/**
 * Called once by the shell. `pageId` is the page route param (the active pane). Returns the state to
 * render. A page navigation that arrives without `split` right after a split location (push or replace,
 * never back/forward) replaces the active pane instead of dropping the split: the URL is then canonicalised.
 */
export function useSplitRouteState(workspaceId: string): SplitRoute {
  const { pageId } = useParams();
  const location = useLocation();
  const navType = useNavigationType();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const adopted = useRef<{ key: string; state: SplitState } | null>(null);

  let state: SplitState | null = pageId ? parseSplit(pageId, location.search) : null;
  let needsCanonical = false;
  if (pageId && state && !isSplit(state)) {
    const memo = adoption.memo;
    if (adopted.current && adopted.current.key === location.key) {
      state = adopted.current.state;
      needsCanonical = true;
    } else if (!narrow && navType !== 'POP' && memo && memo.workspaceId === workspaceId && memo.locationKey !== location.key) {
      const target = replacePane(memo.state, memo.state.active, pageId);
      adopted.current = { key: location.key, state: target };
      state = target;
      needsCanonical = true;
    }
  }

  const search = location.search;
  const key = location.key;
  useEffect(() => {
    if (needsCanonical && state && isSplit(state)) {
      navigate(splitHref(workspaceId, state), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsCanonical, key]);

  // Publish for non-React callers and remember a split for the next navigation.
  const serialized = state ? `${state.active}|${state.panes.join(',')}` : '';
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    runtime.workspaceId = workspaceId;
    const current = stateRef.current;
    runtime.state = current;
    adoption.memo = current && isSplit(current) && !needsCanonical ? { workspaceId, state: current, locationKey: key } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, serialized, key, search]);
  useEffect(
    () => () => {
      runtime.state = null;
      forgetSplit();
    },
    [],
  );
  // A different set of panes ends the "agrandir" mode.
  const count = state?.panes.length ?? 0;
  useEffect(() => {
    maximizedStore.set(null);
  }, [count]);

  const fallback: SplitState = state ?? { panes: [], active: 0 };
  return { state: fallback, active: !narrow && !!state && isSplit(state) };
}
