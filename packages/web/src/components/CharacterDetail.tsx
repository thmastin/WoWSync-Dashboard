import { useEffect, useState } from "react";
import { fetchCharacter, fetchSnapshots, fetchForeverGearAllocation } from "../api.ts";
import { useAsync } from "../useAsync.ts";
import ErrorNotice from "./ErrorNotice.tsx";
import { professionEntryIsEvidence } from "@wowsync-dashboard/core/professionCatalog.ts";
import { formatAbsoluteTime, formatCopper, formatPlaytime, formatRelativeTime } from "../format.ts";

import { VERSION_LABELS } from "../versions.ts";
import { EMPTY_ITEM_INFO, describeItemInfo, itemInfoSuffix, type ItemInfoLookup } from "../itemMetadata.ts";
import { useItemInfoLoader } from "../useItemInfo.ts";
import DeleteCharacterModal from "./DeleteCharacterModal.tsx";
import { characterHeaderView, latestSnapshotId } from "../characterSnapshotView.ts";
import { sectionFreshnessCaption } from "../sectionFreshness.ts";
import { parseItemLevel, summarizeEquipmentIlvl } from "../equipmentView.ts";
import type { SectionStatus } from "../types.ts";
import { CARRIED_WARBAND_NOTE, CARRIED_WARBAND_TITLE, OPEN_SHARED_WARBAND } from "../sharedStorage.ts";
import GuildBankCard from "./GuildBankCard.tsx";
import TrainerCategoryCard from "./TrainerCategoryCard.tsx";
import { buildForeverGearObservation } from "@wowsync-dashboard/core/foreverGearObservation.ts";
import { foreverSnapshotIdentityIssue } from "../foreverIdentityGuard.ts";

function StatusBadge({ state }: { state: string }) {
  return <span className={`status-badge status-${state.toLowerCase()}`}>{state}</span>;
}

/** Relative age under a section heading; LAST_SEEN is "as of …", never current. */
function SectionFreshnessLine({ status }: { status: SectionStatus }) {
  const caption = sectionFreshnessCaption(status, Date.now() / 1000);
  if (!caption) return null;
  return (
    <p className="muted small section-freshness" title={formatAbsoluteTime(caption.at)}>
      {caption.text}
    </p>
  );
}

type TocLink = { id: string; label: string };

function DetailToc({ links }: { links: TocLink[] }) {
  if (links.length === 0) return null;
  return (
    <nav className="detail-toc" aria-label="On this page">
      {links.map((link) => (
        <a key={link.id} href={"#" + link.id}>
          {link.label}
        </a>
      ))}
    </nav>
  );
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
  const foreverIdentityIssue = character?.version === "forever" ? foreverSnapshotIdentityIssue(snapshots.map((entry) => entry.parsed.foreverGearObservation)) : undefined;
  const foreverObservation = character?.version === "forever" && snapshot && snapshot.parsed.character.clientFamily === "Forever" && snapshot.parsed.character.clientVersion === "1.60.1" && snapshot.parsed.character.clientBuild === "70291" && snapshot.parsed.character.interface === "16001"
    ? buildForeverGearObservation({ identity: { version: "forever", identityKey: character.identityKey, name: character.name, realm: character.realm }, snapshotId: snapshot.id, generatedAt: snapshot.generatedAt, importedAt: snapshot.importedAt, equipment: snapshot.parsed.equipment, bags: snapshot.parsed.bags, bank: snapshot.parsed.bank, structured: snapshot.parsed.foreverGearObservation, now: Math.floor(Date.now() / 1000) })
    : undefined;
  // Enrichment for this character's game version (bags, Character Bank, carried Warband/Guild); never blocks the page.
  const itemInfo = useItemInfoLoader(character?.version, refreshTick);
  const foreverAllocationLoad = useAsync(
    (signal) => character?.version === "forever" ? fetchForeverGearAllocation(identityKey, signal) : Promise.resolve(null),
    `forever-allocation:${identityKey}`,
    refreshTick,
  );

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

      {snapshot && (() => {
        const detailTocLinks: TocLink[] = [
          { id: "detail-location", label: "Location" },
          { id: "detail-equipment", label: "Equipment" },
          { id: "detail-bags", label: "Bags" },
          { id: "detail-bank", label: "Bank" },
        ];
        if (snapshot.parsed.accountBank) detailTocLinks.push({ id: "detail-warband", label: "Warband" });
        if (snapshot.parsed.guildBank) detailTocLinks.push({ id: "detail-guildbank", label: "Guild Bank" });
        detailTocLinks.push(
          { id: "detail-professions", label: "Professions" },
          { id: "detail-spells", label: "Spells" },
          { id: "detail-trainers", label: "Trainers" },
          { id: "detail-snapshots", label: "Snapshots" },
        );
        return (
        <>
        <DetailToc links={detailTocLinks} />
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

          <section className="detail-card" id="detail-location">
            <h3>Location <StatusBadge state={snapshot.parsed.location.status.state} /></h3>
            <SectionFreshnessLine status={snapshot.parsed.location.status} />
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

          <section className="detail-card" id="detail-equipment">
            <h3>
              Equipment <StatusBadge state={snapshot.parsed.equipment.status.state} />
            </h3>
            <SectionFreshnessLine status={snapshot.parsed.equipment.status} />
            {character.version === "forever" && foreverIdentityIssue ? <p role="status">Equipment withheld: {foreverIdentityIssue}</p> : snapshot.parsed.equipment.status.state === "UNKNOWN" ? (
              <p className="muted">Never observed.</p>
            ) : (
              <>
                {(() => {
                  const ilvl = summarizeEquipmentIlvl(snapshot.parsed.equipment.slots);
                  if (!ilvl) {
                    const emptyOnly = snapshot.parsed.equipment.slots.every((s) => s.empty);
                    return emptyOnly ? null : (
                      <div className="muted small">Average ilvl unknown (no numeric levels in this export).</div>
                    );
                  }
                  const unknownNote =
                    ilvl.unknownIlvl > 0 ? ` / ${ilvl.unknownIlvl} equipped without ilvl` : "";
                  const emptyNote = ilvl.empty > 0 ? ` / ${ilvl.empty} empty` : "";
                  return (
                    <div className="muted small">
                      Avg ilvl {ilvl.average} (from {ilvl.counted}/{ilvl.equipped} equipped)
                      {unknownNote}
                      {emptyNote}
                    </div>
                  );
                })()}
                <ul className="compact-list">
                  {snapshot.parsed.equipment.slots.map((s) => {
                    if (s.empty) {
                      return (
                        <li key={s.slot} className="muted">
                          <span>{s.slotName || `Slot ${s.slot}`}:</span> empty
                        </li>
                      );
                    }
                    const level = parseItemLevel(s.itemLevel);
                    const ilvlLabel = level !== undefined ? `ilvl ${level}` : "ilvl ?";
                    return (
                      <li key={s.slot}>
                        <span className="muted">{s.slotName || `Slot ${s.slot}`}:</span> {s.name ?? s.itemRef ?? "?"}{" "}
                        <span className="muted small">- {ilvlLabel}</span>
                      </li>
                    );
                  })}
                  {snapshot.parsed.equipment.slots.length === 0 && <li className="muted">Nothing equipped.</li>}
                </ul>
              </>
            )}
          </section>

          {character.version === "forever" && (
            <section className="detail-card" id="detail-forever-gear-observation">
              <h3>Forever gear observations</h3>
              {snapshot.parsed.character.clientFamily !== "Forever" || snapshot.parsed.character.clientVersion !== "1.60.1" || snapshot.parsed.character.clientBuild !== "70291" || snapshot.parsed.character.interface !== "16001" ? (
                <p>Observation view unavailable: this slice requires Forever 1.60.1 build 70291 / interface 16001.</p>
              ) : <>
              <p className="muted small">
                {foreverObservation?.identity.accountScope === "UNKNOWN"
                  ? `${foreverObservation.identity.accountScope}: ${foreverObservation.identity.accountScopeReason}`
                  : "Account scope unavailable."}
              </p>
              {foreverIdentityIssue && <p role="status">Observation unavailable: {foreverIdentityIssue}</p>}
              {!foreverIdentityIssue && <>
              <p className="muted small">
                {snapshot.parsed.foreverGearObservation
                  ? `Snapshot source: Forever WoWSyncDB structured sections · export ${formatAbsoluteTime(snapshot.parsed.foreverGearObservation.generatedAt)}`
                  : "Source: WOWSYNC v1 export · structured section timestamps unavailable for this snapshot."}
              </p>
              <p>Equipped slots and carried items below are observations. Potential equipment candidates use same-snapshot Forever item API evidence; they are not character eligibility or upgrade verdicts.</p>
              <p className="muted small">Equipment: {foreverObservation?.equipment.state} · {foreverObservation?.equipment.observedAt ? `observed ${formatAbsoluteTime(foreverObservation.equipment.observedAt)} (${foreverObservation.equipment.freshness})` : "timestamp UNKNOWN"} · {foreverObservation?.equipment.source}</p>
              {foreverObservation?.equipment.items.map((slot, index) => (
                <div key={`forever-eq-${slot.slot}-${index}`} className="muted small">{slot.provenance === "OBSERVED" ? "OBSERVED equipped" : "UNKNOWN equipment slot"} · item identity {slot.itemIdentity ?? "UNKNOWN"} · {slot.slotName}: {slot.name ?? "?"} · {slot.itemRef ?? "item identifier unavailable"}</div>
              ))}
              <p className="muted small">Carried inventory: {foreverObservation?.carried.state} · {foreverObservation?.carried.observedAt ? `observed ${formatAbsoluteTime(foreverObservation.carried.observedAt)} (${foreverObservation.carried.freshness})` : "timestamp UNKNOWN"} · {foreverObservation?.carried.source}</p>
              {foreverObservation?.carried.items === undefined ? <div>Carried inventory: UNKNOWN.</div> : foreverObservation.carried.items.map((item, index) => (
                <div key={`forever-bag-${index}`} className="muted small">{item.provenance} carried · item identity {item.itemIdentity ?? "UNKNOWN"} · {item.name ?? "?"} × {item.quantity ?? "?"} · {item.itemRef ?? "item variant unavailable"}</div>
              ))}
              <p className="muted small">Potential equipment candidates: {foreverObservation?.evaluationCandidates.state} | {foreverObservation?.evaluationCandidates.observedAt ? `item evidence ${formatAbsoluteTime(foreverObservation.evaluationCandidates.observedAt)} (${foreverObservation.evaluationCandidates.freshness})` : "item evidence timestamp UNKNOWN"} | {String(foreverObservation?.evaluationCandidates.source ?? "UNKNOWN")} | {foreverObservation?.evaluationCandidates.reason}</p>
              {foreverObservation?.evaluationCandidates.items.map((item, index) => (
                <div key={`forever-candidate-${index}`} className="muted small">{item.provenance} potential equipment | {item.name ?? item.itemRef} | {item.itemType ?? "type UNKNOWN"}/{item.itemSubType ?? "subtype UNKNOWN"} | {item.equipLocation} | carried {item.container === undefined ? "location UNKNOWN" : `bag ${item.container}, slot ${item.slot ?? "?"}`} x {item.quantity ?? "?"} | {item.itemRef} | eligibility UNKNOWN | suitability UNKNOWN | upgrade UNKNOWN | transferability UNKNOWN</div>
              ))}
              <p>Bank: {foreverObservation?.bank.state === "UNKNOWN" ? `UNKNOWN; ${foreverObservation.bank.reason}` : `${foreverObservation?.bank.state ?? "UNKNOWN"}.`}</p>
              </>}
              </>}
            </section>
          )}

          {character.version === "forever" && (
            <section className="detail-card" id="detail-forever-gear-allocation">
              <h3>Forever allocation assessment</h3>
              {foreverAllocationLoad.state.status === "error" ? <p role="status">Allocation evidence unavailable: {String(foreverAllocationLoad.state.error)} <button onClick={foreverAllocationLoad.retry}>Retry</button></p> : null}
              {foreverAllocationLoad.state.status === "loading" ? <p className="muted">Loading latest Forever allocation evidence…</p> : null}
              {foreverAllocationLoad.state.status === "ready" && foreverAllocationLoad.state.data?.value?.data ? (() => {
                const allocation = foreverAllocationLoad.state.data.value.data;
                return <>
                  <p>{allocation.conclusion}: {allocation.reason}</p>
                  <p className="muted small">Import-context roster scope: {allocation.scope.accountMembership}. {allocation.scope.reason}</p>
                  <p className="muted small">Recipient: {allocation.recipient.class?.value ?? "class UNKNOWN"} · level {allocation.recipient.level?.value ?? "UNKNOWN"} · character snapshot {allocation.recipient.freshness}. Equipment {allocation.recipient.equipment.state}{allocation.recipient.equipment.observedAt ? ` observed ${formatAbsoluteTime(allocation.recipient.equipment.observedAt)} (${allocation.recipient.equipment.freshness ?? "unknown freshness"})` : " timestamp UNKNOWN"}:</p>
                  {allocation.recipient.observedSkillLines.length > 0 && <p className="muted small">Observed skill lines: {allocation.recipient.observedSkillLines.map((skill) => `${skill.name} ${skill.rank ?? "?"}/${skill.maxRank ?? "?"}${skill.rawCategoryID !== undefined ? ` (category ${skill.rawCategoryID})` : ""} · ${skill.provenance}`).join(", ")}. Category IDs are shown raw; these observations do not prove weapon proficiency.</p>}
                  {allocation.recipient.equipment.items.map((item, index) => <p key={`allocation-eq-${item.slot}-${index}`} className="muted small">{item.provenance} · {item.slotName}: {item.itemRef ?? "item identity UNKNOWN"}</p>)}
                  {allocation.candidateSources.map((source) => <p key={source.source.identityKey} className="muted small">{source.source.name}: carried {source.carried.state}{source.carried.itemCount !== undefined ? ` · ${source.carried.itemCount} observed rows` : " · item count UNKNOWN"}; bank {source.bank.state}{source.bank.reason ? ` · ${source.bank.reason}` : ""}{source.bank.observedAt ? ` · observed ${formatAbsoluteTime(source.bank.observedAt)} (${source.bank.freshness ?? "unknown freshness"})` : ""}.</p>)}
                  {allocation.assessments.length === 0 ? <p>No currently classified carried potential-equipment rows are available. Missing candidate observations do not establish an empty gear source.</p> : allocation.assessments.map((assessment, index) => {
                    const sourceEvidence = allocation.candidateSources.find((source) => source.source.identityKey === assessment.source.identityKey);
                    return <div key={`${assessment.source.identityKey}:${assessment.candidate.itemRef ?? index}`} className="allocation-row">
                      <strong>{assessment.candidate.name ?? assessment.candidate.itemRef ?? "Unknown item"}</strong>
                      <p className="muted small">Observed with {assessment.source.name} ({assessment.source.realm}){assessment.candidate.container !== undefined ? ` · bag ${assessment.candidate.container}, slot ${assessment.candidate.slot ?? "?"}` : " · location UNKNOWN"} · {assessment.candidate.quantity ?? "?"} carried · {assessment.candidate.itemRef ?? "exact variant UNKNOWN"}{sourceEvidence?.carried.observedAt ? ` · carried capture ${formatAbsoluteTime(sourceEvidence.carried.observedAt)} (${sourceEvidence.carried.freshness ?? "unknown freshness"})` : " · carried capture time UNKNOWN"}</p>
                      <p className="muted small">Potential type: {assessment.candidate.itemType ?? "UNKNOWN"}/{assessment.candidate.itemSubType ?? "UNKNOWN"} · slot type {assessment.candidate.equipLocation ?? "UNKNOWN"}. Location: carried by {assessment.source.name}; ownership UNKNOWN. Item API: {assessment.candidate.itemApiEvidence?.itemInfo.state ?? "UNKNOWN"}{sourceEvidence?.observedAt ? ` · evidence observed ${formatAbsoluteTime(sourceEvidence.observedAt)} (${sourceEvidence.freshness ?? "unknown freshness"})` : " · timestamp UNKNOWN"}. Binding: {assessment.candidate.binding?.state === "OBSERVED" ? (assessment.candidate.binding.value ? "observed bound" : "observed not bound") : "UNKNOWN"}; transferability UNKNOWN.</p>
                      {assessment.candidate.itemApiEvidence && <p className="muted small">GetItemInfo {assessment.candidate.itemApiEvidence.itemInfo.state} ({assessment.candidate.itemApiEvidence.itemInfo.returnCount ?? "?"} returns); validated-field contract {assessment.candidate.itemApiEvidence.validatedFields?.contractState ?? "UNKNOWN"}. Required level {assessment.candidate.itemApiEvidence.validatedFields?.requiredLevel.state === "OBSERVED" ? String(assessment.candidate.itemApiEvidence.validatedFields.requiredLevel.value) : "UNKNOWN"}; GetItemStats {assessment.candidate.itemApiEvidence.itemStats.state} ({assessment.candidate.itemApiEvidence.itemStats.entryCount ?? "?"} raw fields).</p>}
                      <p className="muted small">Level requirement: {assessment.eligibilityChecks.requiredLevel.state}. {assessment.eligibilityChecks.requiredLevel.reason} Class restriction: UNKNOWN. {assessment.eligibilityChecks.classRestriction.reason} Weapon proficiency: UNKNOWN. {assessment.eligibilityChecks.weaponProficiency.reason} Slot compatibility: {assessment.eligibilityChecks.slotCompatibility.state}. {assessment.eligibilityChecks.slotCompatibility.reason}</p>
                      {assessment.rawStatComparisons.length > 0 && <p className="muted small">Raw same-key stat comparisons: {assessment.rawStatComparisons.map((comparison) => `${comparison.key} ${comparison.candidateValue} vs equipped ${comparison.equippedValue} in slot ${comparison.equippedSlot} (delta ${comparison.delta})`).join("; ")}. These values are not an upgrade score.</p>}
                      {assessment.candidate.itemApiEvidence?.statDeltaEvidence && <p className="muted small">GetItemStatDelta evidence: {assessment.candidate.itemApiEvidence.statDeltaEvidence.api} · {assessment.candidate.itemApiEvidence.statDeltaEvidence.state} · {assessment.candidate.itemApiEvidence.statDeltaEvidence.completeness}{assessment.candidate.itemApiEvidence.statDeltaEvidence.observedAt ? ` · observed ${formatAbsoluteTime(assessment.candidate.itemApiEvidence.statDeltaEvidence.observedAt)} (${assessment.candidate.itemApiEvidence.statDeltaEvidence.freshness ?? "unknown freshness"})` : " · timestamp UNKNOWN"}. {assessment.candidate.itemApiEvidence.statDeltaEvidence.reason} {assessment.candidate.itemApiEvidence.statDeltaComparisons?.length ? `Raw ordered pairs: ${assessment.candidate.itemApiEvidence.statDeltaComparisons.map((pair) => `${pair.candidateItemString} vs ${pair.equippedItemString}: ${pair.entries.map((entry) => `${entry.key} ${entry.observation.state === "OBSERVED" ? String(entry.observation.value) : "UNKNOWN"}`).join(", ")}`).join("; ")}. Direction and upgrade meaning are unvalidated.` : "No current exact candidate/equipped pair result is available."}</p>}
                      <p>Recipient {assessment.recipient.name}: eligibility {assessment.eligibility}; suitability {assessment.suitability}; upgrade {assessment.upgradeStatus}; transferability {assessment.transferability}; priority {assessment.allocationPriority}. {assessment.decision}.</p>
                      <p className="muted small">{assessment.reason}</p>
                      <details><summary>Evidence needed</summary><ul>{assessment.missingEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul></details>
                    </div>;
                  })}
                  {allocation.exclusions.length > 0 && <details><summary>Characters withheld from source evaluation ({allocation.exclusions.length})</summary><ul>{allocation.exclusions.map((entry) => <li key={entry.character.identityKey}>{entry.character.name}: {entry.reason}</li>)}</ul></details>}
                </>;
              })() : null}
            </section>
          )}

          {character.version === "forever" && foreverIdentityIssue ? <div className="detail-card" role="status">Forever inventory withheld: {foreverIdentityIssue}</div> : <>
            <InventoryCard id="detail-bags" title="Bags" inv={snapshot.parsed.bags} itemInfo={itemInfo} />
            <InventoryCard id="detail-bank" title="Bank" inv={snapshot.parsed.bank} itemInfo={itemInfo} />
          </>}
          {snapshot.parsed.accountBank && (
            <InventoryCard
              id="detail-warband"
              title={CARRIED_WARBAND_TITLE}
              inv={snapshot.parsed.accountBank}
              note={CARRIED_WARBAND_NOTE}
              itemInfo={itemInfo}
              actionLabel={snapshot.parsed.accountBank.status.state !== "UNKNOWN" ? OPEN_SHARED_WARBAND : undefined}
              onAction={onOpenSharedStorage}
            />
          )}
          {snapshot.parsed.guildBank && (
            <div id="detail-guildbank">
              <GuildBankCard guild={snapshot.parsed.guildBank} onOpenSharedStorage={onOpenSharedStorage} itemInfo={itemInfo} />
            </div>
          )}

          <section className="detail-card" id="detail-professions">
            <h3>
              Professions <StatusBadge state={snapshot.parsed.professions.status.state} />
            </h3>
            <SectionFreshnessLine status={snapshot.parsed.professions.status} />
            {snapshot.parsed.professions.status.state === "UNKNOWN" ? (
              <p className="muted">Never observed.</p>
            ) : (
              <ul className="compact-list">
                {snapshot.parsed.professions.entries.map((p) => (
                  <li key={p.name}>
                    {p.name}
                    {p.tier ? <span className="muted small"> ({p.tier})</span> : null}
                    {p.category && p.category !== p.tier ? <span className="muted small"> [{p.category}]</span> : null}
                    : {p.skill ?? "?"}/{p.maxSkill ?? "?"}
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

          <section className="detail-card" id="detail-spells">
            <h3>
              Known Spells <StatusBadge state={snapshot.parsed.spells.status.state} />
            </h3>
            <SectionFreshnessLine status={snapshot.parsed.spells.status} />
            {snapshot.parsed.spells.status.state === "UNKNOWN" ? (
              <p className="muted">Never observed.</p>
            ) : (
              <div className="muted small">{snapshot.parsed.spells.entries.length} spells known</div>
            )}
          </section>

          <section className="detail-card detail-card-wide" id="detail-trainers">
            <h3>
              Trainers <StatusBadge state={snapshot.parsed.trainer.status.state} />
            </h3>
            <SectionFreshnessLine status={snapshot.parsed.trainer.status} />
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

          <section className="detail-card detail-card-wide" id="detail-snapshots">
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
        </>
        );
      })()}

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
  id,
  title,
  inv,
  note,
  actionLabel,
  onAction,
  itemInfo = EMPTY_ITEM_INFO,
}: {
  id?: string;
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
    <section className="detail-card" id={id}>
      <h3>
        {title} <StatusBadge state={inv.status.state} />
      </h3>
      <SectionFreshnessLine status={inv.status} />
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
