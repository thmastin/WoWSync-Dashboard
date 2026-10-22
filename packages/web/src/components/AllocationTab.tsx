import { useEffect, useReducer, useState, type FormEvent } from "react";
import { createDemand, deactivateDemand, fetchAllocationReview, fetchDemands, updateDemand } from "../api.ts";
import {
  NO_TARGET_EXPLANATION,
  NO_TARGET_HEADING,
  REMOVE_TARGET_EXPLANATION,
  accountStatusView,
  cellText,
  describeDemandError,
  keepHelp,
  knownNames,
  noTargetRowView,
  pageView,
  parseItemId,
  recoveryOffset,
  parseKeepQuantity,
  removedTargetViews,
  targetRowViews,
  type Cell,
  type DetailView,
  type PageView,
  type TargetRowView,
} from "../allocationView.ts";
import { formatAbsoluteTime } from "../format.ts";
import type { AccountAllocationReview, AllocationReviewRead, ExplicitDemand, VersionOrUnknown } from "../types.ts";
import { useAsync } from "../useAsync.ts";
import ErrorNotice from "./ErrorNotice.tsx";
import GearAllocationPanel from "./GearAllocationPanel.tsx";

const PAGE_SIZE = 50;

export const targetAnchorId = (baseItemId: number) => `allocation-target-${baseItemId}`;

export interface DemandSubmit {
  baseItemId: number;
  requiredQuantity: number;
  purpose: string;
}

export interface AllocationHandlers {
  onRetry: () => void;
  onSearch: (q: string) => void;
  onDemandedPage: (offset: number) => void;
  onUnallocatedPage: (offset: number) => void;
  /** Mutations resolve true only after the server accepted the change (forms close/reset only then). */
  onCreate: (input: DemandSubmit) => Promise<boolean>;
  onUpdate: (stableId: string, input: DemandSubmit) => Promise<boolean>;
  onDeactivate: (stableId: string) => Promise<boolean>;
}

/**
 * Validates the form's text and, if valid, submits it and waits for the server. `ok` is true only when the
 * mutation succeeded; a validation problem never reaches the server, and a failed request leaves the form as is.
 */
export async function submitDemandForm(
  fields: { itemId: string; keep: string; purpose: string },
  mode: "create" | "edit" | "byId",
  baseItemId: number | undefined,
  onSubmit: (input: DemandSubmit) => Promise<boolean>,
): Promise<{ ok: boolean; problem?: string }> {
  const id = mode === "byId" ? parseItemId(fields.itemId) : baseItemId !== undefined ? { value: baseItemId } : { error: "No item selected." };
  if ("error" in id) return { ok: false, problem: id.error };
  const quantity = parseKeepQuantity(fields.keep);
  if ("error" in quantity) return { ok: false, problem: quantity.error };
  return { ok: await onSubmit({ baseItemId: id.value, requiredQuantity: quantity.value, purpose: fields.purpose }) };
}

function CellValue({ cell }: { cell: Cell }) {
  return <span className={`allocation-cell allocation-cell-${cell.kind}`}>{cellText(cell)}</span>;
}

/** "Keep N" + optional purpose, with the meaning of N (and of Keep 0) explained for what is currently typed. */
export function DemandForm({
  mode,
  baseItemId,
  initialKeep = "",
  initialPurpose = "",
  busy,
  onSubmit,
  onCancel,
  onDone,
}: {
  mode: "create" | "edit" | "byId";
  baseItemId?: number;
  initialKeep?: string;
  initialPurpose?: string;
  busy: boolean;
  onSubmit: (input: DemandSubmit) => Promise<boolean>;
  onCancel?: () => void;
  /** Called after the server accepted the submission (e.g. close the edit panel). */
  onDone?: () => void;
}) {
  const [itemId, setItemId] = useState(baseItemId !== undefined ? String(baseItemId) : "");
  const [keep, setKeep] = useState(initialKeep);
  const [purpose, setPurpose] = useState(initialPurpose);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await submitDemandForm({ itemId, keep, purpose }, mode, baseItemId, onSubmit);
    setProblem(result.problem ?? null);
    if (!result.ok) return;
    if (mode === "byId") {
      setItemId("");
      setKeep("");
      setPurpose("");
    }
    onDone?.();
  }

  return (
    <form className="allocation-form" onSubmit={submit} aria-label={mode === "edit" ? "Edit target" : mode === "byId" ? "Add target by item ID" : "Set target"}>
      <div className="allocation-form-fields">
        {mode === "byId" && (
          <label>
            Item ID
            <input className="item-search-input allocation-input" inputMode="numeric" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="e.g. 12345" />
          </label>
        )}
        <label>
          Keep
          <input className="item-search-input allocation-input" inputMode="numeric" value={keep} onChange={(e) => setKeep(e.target.value)} placeholder="N" />
        </label>
        <label className="allocation-form-purpose">
          Why / purpose (optional)
          <input className="item-search-input allocation-input" value={purpose} maxLength={500} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Enchanting mats" />
        </label>
      </div>
      <p className="muted small allocation-help">{keepHelp(keep)}</p>
      {problem && (
        <p className="allocation-form-problem small" role="alert">
          {problem}
        </p>
      )}
      <div className="allocation-actions">
        <button className="primary-button" type="submit" disabled={busy}>
          {mode === "edit" ? "Save target" : "Set target"}
        </button>
        {onCancel && (
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function DetailBlock({ detail }: { detail: DetailView }) {
  const lines = (title: string, items: DetailView["confirmed"], muted = false) =>
    items.length > 0 && (
      <div className="allocation-detail-group">
        <div className="small allocation-detail-title">{title}</div>
        <ul className={`compact-list small${muted ? " muted" : ""}`}>
          {items.map((l, i) => (
            <li key={i}>
              {l.label}: {l.text}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="allocation-detail">
      {lines("Seen in observed storage (counted)", detail.confirmed)}
      {lines("Unknown stack quantities", detail.unresolved)}
      {lines("Last seen (historical, not counted)", detail.lastSeen, true)}
      {lines("Guild context (guild-owned, not counted)", detail.guild, true)}
      {detail.identity && <p className="small">Identity: {detail.identity}</p>}
      {detail.binding && <p className="small">Binding: {detail.binding}</p>}
      {detail.lastSeenBinding && <p className="small muted">{detail.lastSeenBinding}</p>}
      {detail.reasons.length > 0 && (
        <ul className="compact-list small muted allocation-reasons">
          {detail.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chips({ chips }: { chips: TargetRowView["chips"] }) {
  if (chips.length === 0) return null;
  return (
    <span className="allocation-chips">
      {chips.map((c) => (
        <span key={c.label} className="allocation-chip" title={c.title}>
          {c.label}
        </span>
      ))}
    </span>
  );
}

function Pager({ page, label, onPage }: { page: PageView; label: string; onPage: (offset: number) => void }) {
  if (page.prevOffset === undefined && page.nextOffset === undefined) return null;
  return (
    <div className="allocation-pager" aria-label={`${label} pages`}>
      <button className="secondary-button" type="button" disabled={page.prevOffset === undefined} onClick={() => page.prevOffset !== undefined && onPage(page.prevOffset)}>
        ← Previous
      </button>
      <span className="muted small">{page.text}</span>
      <button className="secondary-button" type="button" disabled={page.nextOffset === undefined} onClick={() => page.nextOffset !== undefined && onPage(page.nextOffset)}>
        Next →
      </button>
    </div>
  );
}

export function TargetRow({
  row,
  busy,
  focused,
  handlers,
  initialMode = "view",
}: {
  row: TargetRowView;
  busy: boolean;
  focused: boolean;
  handlers: Pick<AllocationHandlers, "onUpdate" | "onDeactivate">;
  /** Which panel starts open (tests render each state; the app always starts in "view"). */
  initialMode?: "view" | "edit" | "remove";
}) {
  const [mode, setMode] = useState<"view" | "edit" | "remove">(initialMode);
  return (
    <article id={targetAnchorId(row.baseItemId)} className={`panel allocation-row allocation-state-${row.state}${focused ? " allocation-focused" : ""}`}>
      <div className="allocation-row-head">
        <h4>
          {row.title}
          {!row.nameKnown && <span className="muted small"> (name not observed)</span>}
        </h4>
        <span className={`allocation-status allocation-status-${row.status.tone}`}>{row.status.label}</span>
        <Chips chips={row.chips} />
      </div>
      <div className="allocation-summary">{row.summary}</div>
      {row.demand?.purpose && <div className="muted small">Why: {row.demand.purpose}</div>}
      {row.notes.map((n, i) => (
        <p key={i} className="small allocation-note">
          {n}
        </p>
      ))}
      {row.lastSeen && <div className="muted small allocation-last-seen">{row.lastSeen}</div>}
      {row.conflict && (
        <ul className="compact-list small allocation-conflict">
          {row.conflict.map((c) => (
            <li key={c.stableId}>
              <span>
                {c.requiredQuantity !== undefined ? `Keep ${c.requiredQuantity}` : "A target whose quantity is not loaded"}
                {c.purpose ? ` · ${c.purpose}` : ""}
              </span>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void handlers.onDeactivate(c.stableId)}>
                Remove this target
              </button>
            </li>
          ))}
        </ul>
      )}
      <details className="allocation-details">
        <summary className="small">Evidence and numbers</summary>
        <dl className="allocation-numbers small">
          <dt>Keep</dt>
          <dd>
            <CellValue cell={row.keep} />
          </dd>
          <dt>{row.state === "unproven" ? "Seen" : "Have"}</dt>
          <dd>
            <CellValue cell={row.have} />
          </dd>
          <dt>Allocated</dt>
          <dd>
            <CellValue cell={row.allocated} />
          </dd>
          <dt>Short</dt>
          <dd>
            <CellValue cell={row.short} />
          </dd>
          <dt>Surplus</dt>
          <dd>
            <CellValue cell={row.surplus} />
          </dd>
        </dl>
        <DetailBlock detail={row.detail} />
      </details>
      {row.demand && mode === "view" && (
        <div className="allocation-actions">
          <button className="secondary-button" type="button" onClick={() => setMode("edit")}>
            Edit
          </button>
          <button className="secondary-button" type="button" onClick={() => setMode("remove")}>
            Remove target
          </button>
        </div>
      )}
      {row.demand && mode === "edit" && (
        <DemandForm
          mode="edit"
          baseItemId={row.baseItemId}
          initialKeep={String(row.demand.requiredQuantity)}
          initialPurpose={row.demand.purpose ?? ""}
          busy={busy}
          onSubmit={(input) => handlers.onUpdate(row.demand!.stableId, input)}
          onCancel={() => setMode("view")}
          onDone={() => setMode("view")}
        />
      )}
      {row.demand && mode === "remove" && (
        <div className="allocation-remove-confirm">
          <p className="small">{REMOVE_TARGET_EXPLANATION}</p>
          <div className="allocation-actions">
            <button className="danger-button" type="button" disabled={busy} onClick={() => void handlers.onDeactivate(row.demand!.stableId).then((ok) => ok && setMode("view"))}>
              Remove target
            </button>
            <button className="secondary-button" type="button" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function NoTargetRow({ row, busy, onCreate }: { row: ReturnType<typeof noTargetRowView>; busy: boolean; onCreate: AllocationHandlers["onCreate"] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="allocation-held-row">
      <div className="allocation-held-main">
        <span className="allocation-held-title">
          {row.title}
          {!row.nameKnown && <span className="muted small"> (name not observed)</span>}
        </span>
        <span className="allocation-held-seen">
          Seen <CellValue cell={row.seen} />
        </span>
        {row.lastSeen && <span className="muted small">{row.lastSeen}</span>}
        <Chips chips={row.chips} />
        {!open && (
          <button className="secondary-button" type="button" onClick={() => setOpen(true)}>
            Set target
          </button>
        )}
      </div>
      {open && <DemandForm mode="create" baseItemId={row.baseItemId} busy={busy} onSubmit={onCreate} onCancel={() => setOpen(false)} onDone={() => setOpen(false)} />}
    </li>
  );
}

function RemovedRow({ row, busy, onCreate }: { row: ReturnType<typeof removedTargetViews>[number]; busy: boolean; onCreate: AllocationHandlers["onCreate"] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="allocation-removed-row">
      <div>
        <strong>{row.title}</strong> <span className="muted small">was Keep {row.requiredQuantity}{row.purpose ? ` · ${row.purpose}` : ""} · removed {formatAbsoluteTime(row.removedAt)}</span>
      </div>
      {row.hasActiveTarget ? (
        <span className="muted small">This item has a current target; edit it under Your targets.</span>
      ) : open ? (
        <DemandForm mode="create" baseItemId={row.baseItemId} initialKeep={String(row.requiredQuantity)} initialPurpose={row.purpose ?? ""} busy={busy} onSubmit={onCreate} onCancel={() => setOpen(false)} onDone={() => setOpen(false)} />
      ) : (
        <button className="secondary-button" type="button" onClick={() => setOpen(true)}>
          Set new target
        </button>
      )}
    </li>
  );
}

export interface MutationOutcome {
  flash: { tone: "ok" | "error"; message: string };
  /** Re-read the review and demand list. Decided only AFTER the request settled, never on a timer. */
  reload: boolean;
  /** A duplicate target's existing demand, to bring into view. */
  existingStableId?: string;
}

/** Awaits one demand mutation and decides what the page does next: success always re-reads; a stale-state error (duplicate, already removed, gone) re-reads too. */
export async function settleDemandMutation(run: () => Promise<unknown>, done: string): Promise<MutationOutcome> {
  try {
    await run();
    return { flash: { tone: "ok", message: done }, reload: true };
  } catch (err) {
    const view = describeDemandError(err);
    return { flash: { tone: "error", message: view.message }, reload: view.refresh, ...(view.existingStableId ? { existingStableId: view.existingStableId } : {}) };
  }
}

export type AllocationLoadStatus = "loading" | "ready" | "error";

/** The whole Allocation surface from props, so every state renders in tests. Semantics come only from allocationView.ts. */
export function AllocationBody({
  version,
  status,
  read,
  demands,
  error,
  query,
  busy,
  flash,
  focusedItemId,
  handlers,
}: {
  version: VersionOrUnknown;
  status: AllocationLoadStatus;
  read?: AllocationReviewRead;
  demands?: ExplicitDemand[];
  error?: unknown;
  query: string;
  busy: boolean;
  flash?: { tone: "ok" | "error"; message: string } | null;
  focusedItemId?: number | null;
  handlers: AllocationHandlers;
}) {
  const [search, setSearch] = useState(query);
  if (version !== "retail") {
    return (
      <div className="allocation-page">
        <h2>Allocation</h2>
        <div className="panel muted">Stock targets and allocation are Retail-only.</div>
      </div>
    );
  }
  const data = read?.data;
  const intro = (
    <div className="allocation-header">
      <h2>Allocation</h2>
      <p className="muted small">
        Stock targets for the whole account (character bags and banks plus the Warband bank). A target says how many of an item the account should keep; the
        numbers are recomputed from observed storage on every load. Nothing here moves, mails, or sells anything.
      </p>
    </div>
  );
  if (!data) {
    return (
      <div className="allocation-page" aria-busy={status === "loading"}>
        {intro}
        {status === "error" && <ErrorNotice error={error} onRetry={handlers.onRetry} />}
        {status === "loading" && (
          <div className="panel" role="status">
            Loading allocation…
          </div>
        )}
        {status === "ready" && read && <div className="panel muted">{read.provenance.reason ?? "Allocation is not available for this version."}</div>}
      </div>
    );
  }

  const account = accountStatusView(data);
  const targets = targetRowViews(data, demands ?? []);
  const held = data.unallocated.items.map(noTargetRowView);
  const removed = demands ? removedTargetViews(demands, knownNames(data)) : [];

  return (
    <div className="allocation-page" aria-busy={status === "loading"}>
      {intro}
      {status === "error" && <ErrorNotice error={error} onRetry={handlers.onRetry} />}
      <div className={`allocation-account allocation-account-${account.tone}`} role="status">
        <p>{account.message}</p>
        {account.unidentifiedNote && <p className="muted small">{account.unidentifiedNote}</p>}
      </div>
      {flash && (
        <div className={`allocation-flash allocation-flash-${flash.tone}`} role={flash.tone === "error" ? "alert" : "status"}>
          {flash.message}
        </div>
      )}

      <section className="allocation-section" aria-labelledby="allocation-targets-heading">
        <h3 id="allocation-targets-heading">Your targets</h3>
        {targets.length === 0 && data.demanded.totalCount === 0 ? (
          <p className="muted small">No targets yet. Set one from Held with no target below, or add one by item ID.</p>
        ) : targets.length === 0 ? (
          <p className="small allocation-past-end" role="status">
            This page is past the end of your {data.demanded.totalCount} targets. Showing the last page…
          </p>
        ) : (
          targets.map((row) => (
            <TargetRow key={row.baseItemId} row={row} busy={busy} focused={focusedItemId === row.baseItemId} handlers={handlers} />
          ))
        )}
        <Pager page={pageView(data.demanded)} label="Targets" onPage={handlers.onDemandedPage} />
      </section>

      <section className="allocation-section panel" aria-labelledby="allocation-byid-heading">
        <h3 id="allocation-byid-heading">Add a target by item ID</h3>
        <p className="muted small">For an item the account does not hold yet. With nothing held, the target shows as short by the full amount.</p>
        <DemandForm mode="byId" busy={busy} onSubmit={handlers.onCreate} />
      </section>

      <section className="allocation-section" aria-labelledby="allocation-held-heading">
        <h3 id="allocation-held-heading">{NO_TARGET_HEADING}</h3>
        <p className="allocation-no-target-explanation">{NO_TARGET_EXPLANATION}</p>
        <form
          className="allocation-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            handlers.onSearch(search);
          }}
        >
          <input className="item-search-input allocation-input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by item name or exact item ID" aria-label="Search held items" />
          <button className="secondary-button" type="submit">
            Search
          </button>
          {query && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setSearch("");
                handlers.onSearch("");
              }}
            >
              Clear
            </button>
          )}
        </form>
        {held.length === 0 && data.unallocated.totalCount === 0 ? (
          <p className="muted small">{query ? `No held item without a target matches “${query}”.` : "Nothing held without a target."}</p>
        ) : held.length === 0 ? (
          <p className="small allocation-past-end" role="status">
            This page is past the end of the {data.unallocated.totalCount} {query ? "matching items" : "items held without a target"}. Showing the last page…
          </p>
        ) : (
          <ul className="compact-list allocation-held-list">
            {held.map((row) => (
              <NoTargetRow key={row.baseItemId} row={row} busy={busy} onCreate={handlers.onCreate} />
            ))}
          </ul>
        )}
        <Pager page={pageView(data.unallocated)} label="Held items" onPage={handlers.onUnallocatedPage} />
      </section>

      {removed.length > 0 && (
        <details className="allocation-section allocation-removed">
          <summary>
            Removed targets ({removed.length}) <span className="muted small">· where did my target go?</span>
          </summary>
          <p className="muted small">Removed targets are kept as history and are not active intent. They cannot be edited; set a new target instead.</p>
          <ul className="compact-list">
            {removed.map((row) => (
              <RemovedRow key={row.stableId} row={row} busy={busy} onCreate={handlers.onCreate} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The tab's paging/search state. `tick` re-reads the review; every change to it is an explicit action. */
export interface PagingState {
  demandedOffset: number;
  unallocatedOffset: number;
  query: string;
  tick: number;
}
export type PagingAction =
  | { type: "search"; q: string }
  | { type: "demandedPage"; offset: number }
  | { type: "unallocatedPage"; offset: number }
  | { type: "reload" }
  | { type: "loaded"; data: Pick<AccountAllocationReview, "demanded" | "unallocated"> };
export const INITIAL_PAGING: PagingState = { demandedOffset: 0, unallocatedOffset: 0, query: "", tick: 0 };

/**
 * Pure paging transitions. A search starts the held list at its first page. After each completed read
 * ("loaded"), a page that came back past the end of rows that still exist (e.g. a mutation removed the last row
 * of a later page) moves to the last valid page and re-reads once; a read for an offset the state has already
 * left is ignored. Nothing here waits on a timer.
 */
export function pagingReducer(state: PagingState, action: PagingAction): PagingState {
  switch (action.type) {
    case "search":
      return { ...state, query: action.q.trim(), unallocatedOffset: 0, tick: state.tick + 1 };
    case "demandedPage":
      return { ...state, demandedOffset: action.offset, tick: state.tick + 1 };
    case "unallocatedPage":
      return { ...state, unallocatedOffset: action.offset, tick: state.tick + 1 };
    case "reload":
      return { ...state, tick: state.tick + 1 };
    case "loaded": {
      const demanded = action.data.demanded.offset === state.demandedOffset ? recoveryOffset(action.data.demanded) : undefined;
      const unallocated = action.data.unallocated.offset === state.unallocatedOffset ? recoveryOffset(action.data.unallocated) : undefined;
      if (demanded === undefined && unallocated === undefined) return state;
      return {
        ...state,
        ...(demanded !== undefined ? { demandedOffset: demanded } : {}),
        ...(unallocated !== undefined ? { unallocatedOffset: unallocated } : {}),
        tick: state.tick + 1,
      };
    }
  }
}

/**
 * The Allocation tab (Retail): reads GET /api/versions/:version/allocation-review and the demand list, and edits
 * STOCK_TARGET demands. Every successful change is awaited and then triggers one re-read of both, so the item
 * moves between Your targets and Held with no target from the server's own answer.
 */
export default function AllocationTab({ activeVersion, refreshTick }: { activeVersion: VersionOrUnknown; refreshTick: number }) {
  const [paging, dispatch] = useReducer(pagingReducer, INITIAL_PAGING);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "error"; message: string } | null>(null);
  const [focusedItemId, setFocusedItemId] = useState<number | null>(null);
  const tick = refreshTick + paging.tick;
  const { demandedOffset, unallocatedOffset, query } = paging;
  // One resource per version; a page/search change or a completed mutation re-reads it (keeping what is shown until the answer arrives).
  const review = useAsync((signal) => fetchAllocationReview(activeVersion, { demandedOffset, demandedLimit: PAGE_SIZE, unallocatedOffset, unallocatedLimit: PAGE_SIZE, q: query }, signal), `allocation:${activeVersion}`, tick);
  const demands = useAsync((signal) => fetchDemands(activeVersion, signal).then((r) => r.demands), `demands:${activeVersion}`, tick);

  // After each completed read: recover from a page left past the end (see pagingReducer).
  useEffect(() => {
    if (review.state.status === "ready" && review.state.data.data) dispatch({ type: "loaded", data: review.state.data.data });
  }, [review.state]);

  useEffect(() => {
    if (focusedItemId === null) return;
    document.getElementById(targetAnchorId(focusedItemId))?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedItemId, review.state.data]);

  async function mutate(run: () => Promise<unknown>, done: string, focus?: number): Promise<boolean> {
    setBusy(true);
    const outcome = await settleDemandMutation(run, done);
    setBusy(false);
    setFlash(outcome.flash);
    const existing = outcome.existingStableId ? demands.state.data?.find((d) => d.stableId === outcome.existingStableId) : undefined;
    const ok = outcome.flash.tone === "ok";
    setFocusedItemId(existing ? existing.commodity.baseItemId : ok ? (focus ?? null) : null);
    if (outcome.reload) dispatch({ type: "reload" });
    return ok;
  }

  const handlers: AllocationHandlers = {
    onRetry: () => {
      review.retry();
      demands.retry();
    },
    onSearch: (q) => dispatch({ type: "search", q }),
    onDemandedPage: (offset) => dispatch({ type: "demandedPage", offset }),
    onUnallocatedPage: (offset) => dispatch({ type: "unallocatedPage", offset }),
    onCreate: (input) => mutate(() => createDemand(activeVersion, input), `Target set: keep ${input.requiredQuantity} of item ${input.baseItemId}.`, input.baseItemId),
    onUpdate: (stableId, input) => mutate(() => updateDemand(activeVersion, stableId, { requiredQuantity: input.requiredQuantity, purpose: input.purpose }), `Target updated: keep ${input.requiredQuantity}.`, input.baseItemId),
    onDeactivate: (stableId) => mutate(() => deactivateDemand(activeVersion, stableId), "Target removed. The item has no target now, so its surplus is unknown."),
  };

  const failed = review.state.status === "error" ? review.state.error : demands.state.status === "error" ? demands.state.error : undefined;
  return (
    <>
    <AllocationBody
      version={activeVersion}
      status={failed !== undefined ? "error" : review.state.status === "ready" ? "ready" : "loading"}
      read={review.state.data}
      demands={demands.state.data}
      error={failed}
      query={query}
      busy={busy}
      flash={flash}
      focusedItemId={focusedItemId}
      handlers={handlers}
    />
    {activeVersion === "retail" && <GearAllocationPanel version={activeVersion} refreshTick={refreshTick} />}
    </>
  );
}
