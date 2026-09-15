import { useEffect, useState } from "react";
import { fetchCharacter, fetchSnapshots } from "../api.ts";
import { formatAbsoluteTime, formatCopper, formatPlaytime, formatRelativeTime } from "../format.ts";
import type { StoredCharacterSummary, StoredSnapshot } from "../types.ts";
import TrainerCategoryCard from "./TrainerCategoryCard.tsx";

function StatusBadge({ state }: { state: string }) {
  return <span className={`status-badge status-${state.toLowerCase()}`}>{state}</span>;
}

export default function CharacterDetail({ identityKey, onBack }: { identityKey: string; onBack: () => void }) {
  const [character, setCharacter] = useState<StoredCharacterSummary | null>(null);
  const [snapshots, setSnapshots] = useState<StoredSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    fetchCharacter(identityKey).then((r) => setCharacter(r.character));
    fetchSnapshots(identityKey).then((r) => {
      setSnapshots(r.snapshots);
      setSelectedId(r.snapshots[0]?.id ?? null);
    });
  }, [identityKey]);

  const snapshot = snapshots.find((s) => s.id === selectedId) ?? snapshots[0];

  if (!character) return <div className="loading">Loading…</div>;

  return (
    <div className="character-detail">
      <button className="back-link" onClick={onBack}>
        ← Back to characters
      </button>
      <div className="detail-header">
        <h1>{character.name}</h1>
        <div className="detail-subline">
          {character.class ?? "?"} · Level {character.latestLevel ?? "?"} · {character.realm}
          {character.faction ? ` · ${character.faction}` : ""}
        </div>
        <div className="detail-subline muted small">
          Last seen {formatRelativeTime(character.latestImportedAt)} · {character.snapshotCount} snapshot
          {character.snapshotCount === 1 ? "" : "s"} recorded
        </div>
      </div>

      {snapshots.length > 1 && (
        <div className="snapshot-picker">
          <label>Snapshot: </label>
          <select value={selectedId ?? ""} onChange={(e) => setSelectedId(Number(e.target.value))}>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {formatAbsoluteTime(s.generatedAt)} (Level {s.parsed.character.level ?? "?"})
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
            <ul className="compact-list">
              {snapshot.parsed.equipment.slots
                .filter((s) => !s.empty)
                .map((s) => (
                  <li key={s.slot}>
                    <span className="muted">{s.slotName}:</span> {s.name ?? s.itemRef ?? "?"}
                  </li>
                ))}
              {snapshot.parsed.equipment.slots.every((s) => s.empty) && <li className="muted">Nothing equipped.</li>}
            </ul>
          </section>

          <InventoryCard title="Bags" inv={snapshot.parsed.bags} />
          <InventoryCard title="Bank" inv={snapshot.parsed.bank} />

          <section className="detail-card">
            <h3>
              Professions <StatusBadge state={snapshot.parsed.professions.status.state} />
            </h3>
            <ul className="compact-list">
              {snapshot.parsed.professions.entries.map((p) => (
                <li key={p.name}>
                  {p.name}: {p.skill ?? "?"}/{p.maxSkill ?? "?"}
                </li>
              ))}
              {snapshot.parsed.professions.entries.length === 0 && (
                <li className="muted">{snapshot.parsed.professions.noneMessage ?? "None observed."}</li>
              )}
            </ul>
          </section>

          <section className="detail-card">
            <h3>
              Known Spells <StatusBadge state={snapshot.parsed.spells.status.state} />
            </h3>
            <div className="muted small">{snapshot.parsed.spells.entries.length} spells known</div>
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
            {snapshot.parsed.trainer.categories.length === 0 && <p className="muted">No trainer visits recorded.</p>}
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
    </div>
  );
}

function InventoryCard({ title, inv }: { title: string; inv: import("../types.ts").InventorySection }) {
  return (
    <section className="detail-card">
      <h3>
        {title} <StatusBadge state={inv.status.state} />
      </h3>
      {inv.status.state === "UNKNOWN" && <p className="muted">Never observed.</p>}
      {inv.status.state !== "UNKNOWN" && (
        <>
          <div className="muted small">
            {inv.freeSlots ?? "?"} free / {inv.totalSlots ?? "?"} slots
          </div>
          <ul className="compact-list">
            {inv.items.slice(0, 12).map((item, i) => (
              <li key={i}>
                {item.name ?? item.itemRef ?? "?"} × {item.qty ?? "?"}
              </li>
            ))}
            {inv.itemsKnownEmpty && <li className="muted">Empty.</li>}
            {inv.items.length > 12 && <li className="muted">+{inv.items.length - 12} more…</li>}
          </ul>
        </>
      )}
    </section>
  );
}
