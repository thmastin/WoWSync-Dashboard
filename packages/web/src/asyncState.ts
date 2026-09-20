// A tiny, pure state machine for "load something from the API": loading ->
// ready | error, with retry, and - crucially - immunity to STALE responses.
//
// Every load gets a request id. Only the reply to the CURRENT request may
// change the state; a slow earlier request (say, the version the user just
// switched away from) is ignored, so it can never overwrite newer data with
// older data or show the wrong version's facts under the current tab.
//
// Kept free of React so it can be unit-tested with plain `node --test`; the
// `useAsync` hook is a thin wrapper around it.

export type AsyncState<T> =
  | { status: "loading"; requestId: number; data?: T }
  | { status: "ready"; requestId: number; data: T }
  | { status: "error"; requestId: number; error: unknown; data?: T };

export type AsyncAction<T> =
  | { type: "start"; requestId: number; /** keep showing the previous data while reloading (a refresh), instead of blanking (a different resource) */ keepData: boolean }
  | { type: "success"; requestId: number; data: T }
  | { type: "failure"; requestId: number; error: unknown };

export function initialAsyncState<T>(): AsyncState<T> {
  return { status: "loading", requestId: 0 };
}

export function asyncReducer<T>(state: AsyncState<T>, action: AsyncAction<T>): AsyncState<T> {
  switch (action.type) {
    case "start":
      return action.keepData && state.data !== undefined
        ? { status: "loading", requestId: action.requestId, data: state.data }
        : { status: "loading", requestId: action.requestId };
    case "success":
      if (action.requestId !== state.requestId) return state; // a superseded request
      return { status: "ready", requestId: action.requestId, data: action.data };
    case "failure":
      if (action.requestId !== state.requestId) return state; // a superseded request
      return state.data !== undefined
        ? { status: "error", requestId: action.requestId, error: action.error, data: state.data }
        : { status: "error", requestId: action.requestId, error: action.error };
  }
}
