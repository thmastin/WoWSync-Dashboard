import { useId, useState } from "react";
import { formatAbsoluteTime, formatCopper } from "../format.ts";
import {
  AGGREGATED_ITEMS_NOTE,
  DERIVED_EXPLANATION,
  contentsState,
  describeCapacity,
  describeCarriage,
  describeCompleteness,
  describeContents,
  describeCoverage,
  describeProvenance,
  describeTiming,
  filterItemRows,
  itemCountLabel,
  itemRows,
  ownerHeading,
  ownerNotices,
  tabRows,
  type Notice,
} from "../sharedStorage.ts";
import type { SharedObservationView, SharedOwnerIdentity, SharedOwnerView } from "../types.ts";

type FormatTime = (unixSeconds: number | undefined) => string;

/** The items of one observation: a filterable table in a keyboard-scrollable region (98+ rows must not stretch the page). Unknown fields show "?". */
export function ItemTable({ view, label }: { view: SharedObservationView; label: string }) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const all = itemRows(view);
  const rows = filterItemRows(all, query);
  return (
    <div className="shared-items">
      <div className="shared-items-toolbar">
        <label htmlFor={inputId} className="sr-only">
          Filter {label} items by name
        </label>
        <input
          id={inputId}
          className="item-search-input shared-filter"
          type="search"
          placeholder="Filter items by name"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted small" role="status">
          {itemCountLabel(rows.length, all.length, query.trim() !== "")}
        </span>
      </div>
      <div className="shared-table-wrap" role="region" aria-label={`${label}: item list`} tabIndex={0}>
        <table className="history-table shared-table">
          <caption className="sr-only">{label}: items, aggregated across tabs</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="num">
                Qty
              </th>
              <th scope="col" className="col-bound">
                Bound
              </th>
              <th scope="col" className="num col-vendor">
                Vendor each
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.itemRef ?? row.name}-${i}`}>
                <th scope="row" className="shared-item-name">
                  {row.name}
                </th>
                <td className="num">{row.qty ?? "?"}</td>
                <td className="col-bound">{row.bound ?? "?"}</td>
                <td className="num col-vendor">{formatCopper(row.vendorEachCopper)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No item matches “{query.trim()}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Guild tabs, worded by the tab rules: an inaccessible or unconfirmed tab is "contents unknown", never empty. Shown as text, never as colour alone. */
function TabList({ view }: { view: SharedObservationView }) {
  const rows = tabRows(view);
  if (rows.length === 0) return null;
  return (
    <div className="shared-tabs">
      <h4>Tabs</h4>
      <ul className="compact-list">
        {rows.map((row) => (
          <li key={row.key}>
            <span className="shared-tab-name">{row.name}</span>{" "}
            <span className={`status-badge ${row.description.tone === "observed" ? "status-observed" : "status-neutral"}`}>{row.description.label}</span>
            {row.description.detail && <div className="muted small">{row.description.detail}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProvenanceBlock({ view, formatTime }: { view: SharedObservationView; formatTime: FormatTime }) {
  const p = describeProvenance(view.provenance, formatTime);
  return (
    <div className="shared-provenance">
      <h4>Which exports carried this observation</h4>
      <p className="small">
        {p.headline}. {p.oneObservation}
      </p>
      <div className="table-scroll">
        <table className="history-table shared-table">
          <caption className="sr-only">Carrying exports, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Character</th>
              <th scope="col">How it was carried</th>
              <th scope="col">Export made</th>
              <th scope="col">Visit</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.character}</th>
                <td>{row.carrier}</td>
                <td>{row.exportTime}</td>
                <td>{row.visit ?? "?"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.truncation && <p className="muted small">{p.truncation}</p>}
      <p className="muted small">{p.note}</p>
    </div>
  );
}

/** One observation, in full: timing, completeness, how it was carried, capacity, tabs, items. Used for the current one and for any other observation a notice lets you open (each labelled as what it is). */
export function ObservationBody({
  view,
  ownerKind,
  label,
  formatTime = formatAbsoluteTime,
}: {
  view: SharedObservationView;
  ownerKind: SharedOwnerIdentity["kind"];
  label: string;
  formatTime?: FormatTime;
}) {
  const timing = describeTiming(view, formatTime);
  const carriage = describeCarriage(view);
  const completeness = describeCompleteness(view, ownerKind);
  const capacity = describeCapacity(view, ownerKind);
  const provenance = describeProvenance(view.provenance, formatTime);
  const state = contentsState(view);
  const coverage = describeCoverage(view, ownerKind);
  return (
    <div className="shared-observation">
      <div className="shared-summary">
        <strong>{describeContents(view)}</strong>
        {capacity && <span className="muted"> · {capacity}</span>}
      </div>

      <dl className="shared-facts">
        <dt>Observed</dt>
        <dd>
          {timing.observed} <span className="muted">({timing.age})</span>{" "}
          <span className={`freshness-badge freshness-${timing.freshness}`}>{timing.freshnessLabel}</span>
          <div className="muted small">{timing.freshnessNote}</div>
          {timing.clampNote && <div className="muted small">{timing.clampNote}</div>}
        </dd>
        <dt>Completeness</dt>
        <dd>
          <span className={`status-badge ${completeness.partial ? "status-last_seen" : "status-observed"}`}>{completeness.label}</span>
          <div className="muted small">{completeness.detail}</div>
        </dd>
        <dt>How it reached the Dashboard</dt>
        <dd>
          {carriage.headline}
          <div className="muted small">{carriage.detail}</div>
        </dd>
        <dt>Carried by</dt>
        <dd>
          {provenance.headline}
          <div className="muted small">{provenance.oneObservation}</div>
        </dd>
      </dl>

      {ownerKind === "guild" && (
        <>
          <TabList view={view} />
          {coverage.length > 0 && (
            <ul className="shared-coverage compact-list" aria-label={`${label}: tab coverage`}>
              {coverage.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {state === "items" && (
        <>
          <ItemTable view={view} label={label} />
          {(ownerKind === "guild" || (view.content.purchasedTabs ?? 1) > 1) && <p className="muted small">{AGGREGATED_ITEMS_NOTE}</p>}
        </>
      )}
      {state === "empty" && <p className="muted">{describeContents(view)}</p>}
      {state === "unknown" && <p className="muted">This observation did not confirm any contents. That is not the same as empty.</p>}
    </div>
  );
}

function NoticeBlock({ notice, ownerKind, formatTime }: { notice: Notice; ownerKind: SharedOwnerIdentity["kind"]; formatTime: FormatTime }) {
  return (
    <div className={`shared-notice shared-notice-${notice.kind}`} role="note">
      <h4>{notice.title}</h4>
      <p>{notice.text}</p>
      {notice.observations.map((o) => (
        <details key={o.label} className="shared-details">
          <summary>
            View: {o.label} ({formatTime(o.view.effectiveObservedAt)})
          </summary>
          <ObservationBody view={o.view} ownerKind={ownerKind} label={o.label} formatTime={formatTime} />
        </details>
      ))}
    </div>
  );
}

/**
 * ONE reconciled owner (the Warband, or one guild). It is rendered once per owner however many exports carried
 * it, and it says what it is: the Dashboard's reconciled view of that storage, not any character's bank.
 */
export default function SharedOwnerCard({
  owner,
  anchorId,
  onRequestClear,
  formatTime = formatAbsoluteTime,
}: {
  owner: SharedOwnerView;
  anchorId: string;
  onRequestClear: (owner: SharedOwnerIdentity) => void;
  formatTime?: FormatTime;
}) {
  const heading = ownerHeading(owner.owner);
  const notices = ownerNotices(owner, formatTime);
  const titleId = `${anchorId}-title`;
  return (
    <section className="panel shared-owner" id={anchorId} aria-labelledby={titleId}>
      <div className="shared-owner-header">
        <div>
          <h3 id={titleId}>
            {heading.title}{" "}
            <span className="tag tag-derived" title={DERIVED_EXPLANATION}>
              Derived
            </span>
          </h3>
          <div className="muted small">{heading.kindLabel}</div>
        </div>
        <button className="danger-button" onClick={() => onRequestClear(owner.owner)} aria-label={`Clear stored history for ${heading.title}`}>
          Clear stored history…
        </button>
      </div>
      <p className="muted small shared-derived-note">{DERIVED_EXPLANATION}</p>

      {owner.current ? (
        <ObservationBody view={owner.current} ownerKind={owner.owner.kind} label={heading.title} formatTime={formatTime} />
      ) : (
        <div className="shared-summary">
          <strong>Contents unknown</strong>
        </div>
      )}

      {notices.map((n) => (
        <NoticeBlock key={n.kind} notice={n} ownerKind={owner.owner.kind} formatTime={formatTime} />
      ))}

      <details className="shared-details">
        <summary>Provenance and technical details</summary>
        {owner.current && <ProvenanceBlock view={owner.current} formatTime={formatTime} />}
        <dl className="shared-facts shared-technical">
          {heading.technical.map((row) => (
            <div key={row.label} className="shared-technical-row">
              <dt>{row.label}</dt>
              <dd className="shared-mono">{row.value}</dd>
            </div>
          ))}
          <div className="shared-technical-row">
            <dt>Observations recorded</dt>
            <dd>
              {owner.observationCount.total} ({owner.observationCount.complete} complete, {owner.observationCount.partial} partial
              {owner.observationCount.informationless > 0 ? `, ${owner.observationCount.informationless} with no readable contents` : ""})
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
