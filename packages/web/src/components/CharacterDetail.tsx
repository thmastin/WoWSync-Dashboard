import { useEffect, useState } from "react";
import { fetchCharacter, fetchSnapshots } from "../api.ts";
import { useAsync } from "../useAsync.ts";
import ErrorNotice from "./ErrorNotice.tsx";
import { professionEntryIsEvidence } from "@wowsync-dashboard/core/professionCatalog.ts";
import { formatAbsoluteTime, formatCopper, formatPlaytime, formatRelativeTime } from "../format.ts";

import { VERSION_LABELS } from "../versions.ts";
import { EMPTY_ITEM_INFO, describeItemInfo, itemInfoSuffix, type ItemInfoLookup } from "../itemMetadata.ts";
import { useItemInfoLoader } from "../useItemInfo.ts";
import DeleteCharacterModal from "./DeleteCharacterModal.tsx";
import { characterHeaderView, latestSnapshotId } from "../characterSnapshotView.ts";
import { CARRIED_WARBAND_NOTE, CARRIED_WARBAND_TITLE, OPEN_SHARED_WARBAND } from "../sharedStorage.ts";
import GuildBankCard from "./GuildBankCard.tsx";
import TrainerCategoryCard from "./TrainerCategoryCard.tsx";

function StatusBadge({ state }: { state: string }) {
  return <span className={`status-badge status-${state.toLowerCase()}`}>{state}</span>;
}

export default function CharacterDetail({
  identityKey,
  refreshTick,
  onBack,
  onDeleted,
  onOpenSharedStorage,
}: {
  identityKey: string;
  /** Changes after an import/delete elsewhere, so this page reloads instead of showing pre-import data. */
  refreshTick: number;
  onBack: () => void;
  /** Called after this character was permanently deleted; the caller refreshes and leaves this (now empty) page. */
  onDeleted: () => void;
  /** Opens the account-level Shared Storage view (the reconciled Warband / Guild Bank), which is where that state lives. */
  onOpenSharedStorage?: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // The character and its snapshots load TOGETHER, so the page never renders a
  // header without its cards (which would read as an empty character), and a
  // failure of either shows one error with Retry instead of a spinner forever.
  const load = useAsync(
    async (signal) => {
      const [c, s] = await Promise.all([fetchCharacter(identityKey, signal), fetchSnapshots(identityKey, signal)]);
      return { character: c.character, snapshots: s.snapshots };
    },
    identityKey,
    refreshTick,
  );
  const character = load.state.data?.character ?? null;
  const snapshots = load.state.data?.snapshots ?? [];

  // Keep the chosen snapshot across a refresh if it still exists; otherwise the newest.
  useEffect(() => {
    if (!load.state.data) return;
    const list = load.state.data.snapshots;
    setSelectedId((prev) => (list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null)));
  }, [load.state.data]);

  const snapshot = snapshots.find((s) => s.id === selectedId) ?? snapshots[0];
  // Enrichment for this character's game version (bags, Character Bank, carried Warband/Guild); never blocks the page.
  const itemInfo = useItemInfoLoader(character?.version, refreshTick);

  if (!character) {
    if (load.state.status === "error") return <ErrorNotice error={load.state.error} onRetry={load.retry} onBack={onBack} />;
    return <div className="loading">Loading…</div>;
  }

  const header = characterHeaderView(character, snapshot, snapshots);

  return (
    <div className="character-detail">
      {load.state.status === "error" && <ErrorNotice error={load.state.error} onRetry={load.retry} />}
      <button className="back-link" onClick={onBack}>
        ← Back to characters
      </button>
      <div className="detail-header">
        <h1>{character.name}</h1>
        <div className="detail-subline">
          {header.className} · Level {header.level} · {header.realm}
          {header.faction ? ` · ${header.faction}` : ""}
        </div>
        <div className="detail-subline muted small">
          {header.viewingHistorical ? "This snapshot" : "Last synced"}{" "}
          {formatRelativeTime(header.syncedAt)} · {header.snapshotCount} snapshot
          {header.snapshotCount === 1 ? "" : "s"} recorded
        </div>
      </div>

      {header.viewingHistorical && snapshot && (
        <div className="historical-snapshot-banner" role="status">
          Viewing snapshot from {formatAbsoluteTime(snapshot.generatedAt ?? snapshot.importedAt)} — not the latest.{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => setSelectedId(latestSnapshotId(snapshots))}
          >
            Jump to latest
          </button>
        </div>
      )}

      {snapshots.length > 1 && (
        <div className="snapshot-picker">
          <label>Snapshot: </label>
          <select value={selectedId ?? ""} onChange={(e) => setSelectedId(Number(e.target.value))}>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {formatAbsoluteTime(s.generatedAt ?? s.importedAt)} (Level {s.parsed.character.level ?? "?"})
              </option>
            ))}
          </select>
        </div>
      )}

      {snapshot && (
        <div className="detail-grid">
          <section className="detail-card">
            <h3>Identity</h3>
            <dl>
              <dt>Realm</dt>
              <dd>{snapshot.parsed.character.realm ?? "?"}</dd>
              <dt>Faction</dt>
              <dd>{snapshot.parsed.character.faction ?? "?"}</dd>
              <dt>Class</dt>
              <dd>{snapshot.parsed.character.class ?? "?"}</dd>
              <dt>Client</dt>
              <dd>
                {snapshot.parsed.character.clientVersion ?? "?"} build {snapshot.parsed.character.clientBuild ?? "?"}
              </dd>
              {snapshot.parsed.character.clientFamily && (
                <>
                  <dt>Client family</dt>
                  <dd>{snapshot.parsed.character.clientFamily}</dd>
                </>
              )}
              {snapshot.parsed.character.interface && (
                <>
                  <dt>Interface</dt>
                  <dd>{snapshot.parsed.character.interface}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="detail-card">
            <h3>Progress</h3>
            <dl>
              <dt>Level</dt>
              <dd>{snapshot.parsed.character.level ?? "?"}</dd>
              <dt>XP</dt>
              <dd>
                {snapshot.parsed.character.xp !== undefined ? `${snapshot.parsed.character.xp}/${snapshot.parsed.character.xpMax}` : "—"}
              </dd>
              <dt>Gold</dt>
              <dd>{formatCopper(snapshot.parsed.character.moneyCopper)}</dd>
              <dt>/played (total)</dt>
              <dd>{formatPlaytime(snapshot.parsed.character.playedSeconds)}</dd>
              <dt>/played (this level)</dt>
              <dd>{formatPlaytime(snapshot.parsed.character.levelPlayedSeconds)}</dd>
            </dl>
          </section>

          <section className="detail-card">
            <h3>Location <StatusBadge state={snapshot.parsed.location.status.state} /></h3>
            <dl>
              <dt>Zone</dt>
              <dd>{snapshot.parsed.location.zone ?? "?"}</dd>
              {snapshot.parsed.location.subzone && (
                <>
                  <dt>Subzone</dt>
                  <dd>{snapshot.parsed.location.subzone}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="detail-card">
            <h3>
              Equipment <StatusBadge state={snapshot.parsed.equipment.status.state} />
            </h3>
            {snapshot.parsed.equipment.status.state === "UNKNOWN" ? (
              <p className="muted">Never observed.</p>
            ) : (
              <ul className="compact-list">
                {snapshot.parsed.equipment.slots
                  .filter((s) => !s.empty)
                  .map((s) => (
                    <li key={s.slot}>
                      <span className="muted">{s.slotName || `Slot ${s.slot}`}:</span> {s.name ?? s.itemRef ?? "?"}
                    </li>
                  ))}
                {snapshot.parsed.equipment.slots.every((s) => s.empty) && <li className="muted">Nothing equipped.</li>}
              </ul>
            )}
          </section>

          <InventoryCard title="Bags" inv={snapshot.parsed.bags} itemInfo={itemInfo} />
          <InventoryCard title="Bank" inv={snapshot.parsed.bank} itemInfo={itemInfo} />
          {snapshot.parsed.accountBank && (
            <InventoryCard
              title={CARRIED_WARBAND_TITLE}
              inv={snapshot.parsed.accountBank}
              note={CARRIED_WARBAND_NOTE}
              itemInfo={itemInfo}
              actionLabel={snapshot.parsed.accountBank.status.state !== "UNKNOWN" ? OPEN_SHARED_WARBAND : undefined}
              onAction={onOpenSharedStorage}
            />
          )}
          {snapshot.parsed.guildBank && <GuildBankCard guild={snapshot.parsed.guildBank} onOpenSharedStorage={onOpenSharedStorage} itemInfo={itemInfo} />}

          <section className="detail-card">
            <h3>
              Professions <StatusBadge state={snapshot.parsed.professions.status.state} />
            </h3>
            {snapshot.parsed.professions.status.state === "UNKNOWN" ? (
              <p className="muted">Never observed.</p>
            ) : (
              <ul className="compact-list">
                {snapshot.parsed.professions.entries.map((p) => (
                  <li key={p.name}>
                    {p.name}: {p.skill ?? "?"}/{p.maxSkill ?? "?"}
                    {!professionEntryIsEvidence(character.version, p) && (
                      <span
                        className="muted small"
                        title="Forever reports 0/0 for professions that are not learned, and possibly for data that has not loaded yet"
                      >
                        {" "}
                        — not confirmed learned
                      </span>
                    )}
                  </li>
                ))}
                {snapshot.parsed.professions.entries.length === 0 && (
                  <li className="muted">{snapshot.parsed.professions.noneMessage ?? "None observed."}</li>
                )}
              </ul>
            )}
          </section>

          <section className="detail-card">
            <h3>
              Known Spells <StatusBadge state={snapshot.parsed.spells.status.state} />
            </h3>
            {snapshot.parsed.spells.status.state === "UNKNOWN" ? (
              <p className="muted">Never observed.</p>
            ) : (
              <div className="muted small">{snapshot.parsed.spells.entries.length} spells known</div>
            )}
          </section>

          <section className="detail-card detail-card-wide">
            <h3>
              Trainers <StatusBadge state={snapshot.parsed.trainer.status.state} />
            </h3>
            {snapshot.trainerUnlocksSincePrevious && snapshot.trainerUnlocksSincePrevious.length > 0 && (
              <div className="trainer-unlocks-banner">
                Trainer changes since last snapshot — unlocked:{" "}
                {snapshot.trainerUnlocksSincePrevious
                  .map((u) => `${u.ability ?? "?"}${u.rank && u.rank !== "-" ? ` (${u.rank})` : ""}`)
                  .join(", ")}
              </div>
            )}
            {snapshot.parsed.trainer.categories.length === 0 && (
              <p className="muted">
                {snapshot.parsed.trainer.status.state === "UNKNOWN" ? "Never observed." : "No trainer visits recorded."}
              </p>
            )}
            {snapshot.parsed.trainer.categories.map((cat) => (
              <TrainerCategoryCard key={cat.category} category={cat} />
            ))}
          </section>

          <section className="detail-card detail-card-wide">
            <h3>Snapshot history ({snapshots.length})</h3>
            <div className="table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Captured</th>
                    <th>Level</th>
                    <th>Gold</th>
                    <th>/played</th>
                    <th>Zone</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s.id} className={s.id === selectedId ? "active" : ""} onClick={() => setSelectedId(s.id)}>
                      <td>{formatAbsoluteTime(s.generatedAt)}</td>
                      <td>{s.parsed.character.level ?? "?"}</td>
                      <td>{formatCopper(s.parsed.character.moneyCopper)}</td>
                      <td>{formatPlaytime(s.parsed.character.playedSeconds)}</td>
                      <td>{s.parsed.location.zone ?? "?"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      <div className="danger-zone">
        <div className="muted small">
          Remove this character and its {character.snapshotCount} stored snapshot{character.snapshotCount === 1 ? "" : "s"} from the
          local database — for example, a test or mistaken import.
        </div>
        <button className="danger-button" onClick={() => setDeleteOpen(true)}>
          Delete character…
        </button>
      </div>

      {deleteOpen && (
        <DeleteCharacterModal
          target={{
            identityKey: character.identityKey,
            name: character.name,
            realm: character.realm,
            versionLabel: VERSION_LABELS[character.version] ?? character.version,
            snapshotCount: character.snapshotCount,
          }}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            onDeleted();
          }}
        />
      )}
    </div>
  );
}

export function InventoryCard({
  title,
  inv,
  note,
  actionLabel,
  onAction,
  itemInfo = EMPTY_ITEM_INFO,
}: {
  title: string;
  /** Game-client item metadata for this character's game version; absent or empty means nothing extra is shown. */
  itemInfo?: ItemInfoLookup;
  inv: import("../types.ts").InventorySection;
  note?: string;
  /** A link-style button to somewhere more authoritative (only shown when both are given). */
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="detail-card">
      <h3>
        {title} <StatusBadge state={inv.status.state} />
      </h3>
      {note && <p className="muted small">{note}</p>}
      {actionLabel && onAction && (
        <button className="link-button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {inv.status.state === "UNKNOWN" && <p className="muted">Never observed.</p>}
      {inv.status.state !== "UNKNOWN" && (
        <>
          <div className="muted small">
            {inv.freeSlots ?? "?"} free / {inv.totalSlots ?? "?"} slots
          </div>
          <ul className="compact-list">
            {inv.items.slice(0, 12).map((item, i) => {
              const view = itemInfo.forItemRef(item.itemRef);
              const info = itemInfoSuffix(view);
              return (
                <li key={i}>
                  {item.name ?? item.itemRef ?? "?"} × {item.qty ?? "?"}
                  {info && (
                    <span className="muted small item-info" title={describeItemInfo(view).summary}>
                      {" "}
                      — {info}
                    </span>
                  )}
                </li>
              );
            })}
            {inv.itemsKnownEmpty && <li className="muted">Empty.</li>}
            {inv.items.length > 12 && <li className="muted">+{inv.items.length - 12} more…</li>}
          </ul>
        </>
      )}
    </section>
  );
}
