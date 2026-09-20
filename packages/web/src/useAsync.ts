import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { asyncReducer, initialAsyncState, type AsyncAction, type AsyncState } from "./asyncState.ts";

/**
 * Loads data through `load` and tracks loading / ready / error.
 *
 * - `key` identifies WHAT is being loaded (e.g. the active version). When it
 *   changes, the previous data is dropped at once - the screen must never show
 *   another resource's data while the new one loads.
 * - `refreshTick` re-loads the SAME resource (after an import, say): the
 *   previous data stays visible while it reloads, so the page does not flash
 *   or lose its place.
 * - `retry()` re-runs the load after a failure.
 * - The in-flight request is aborted when the inputs change or the component
 *   unmounts, and a reply from a superseded request is ignored (asyncState.ts).
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, key: string, refreshTick = 0) {
  const [state, dispatch] = useReducer(
    (s: AsyncState<T>, a: AsyncAction<T>) => asyncReducer(s, a),
    undefined,
    () => initialAsyncState<T>(),
  );
  const [retryTick, setRetryTick] = useState(0);
  const lastKey = useRef<string | null>(null);
  const sequence = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++sequence.current;
    dispatch({ type: "start", requestId, keepData: lastKey.current === key });
    lastKey.current = key;
    loadRef.current(controller.signal).then(
      (data) => dispatch({ type: "success", requestId, data }),
      (error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return; // superseded on purpose
        dispatch({ type: "failure", requestId, error });
      },
    );
    return () => controller.abort();
  }, [key, refreshTick, retryTick]);

  const retry = useCallback(() => setRetryTick((t) => t + 1), []);
  return { state, retry };
}
