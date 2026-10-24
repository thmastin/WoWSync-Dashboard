import { classifyFreshness } from "./freshness.ts";
import { classicProfileVersion } from "./classicState.ts";
import { isForeverProfile } from "./foreverProfile.ts";

export type QuestEvidenceState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
export interface ForeverQuestObjective {
  index?: number;
  text?: string;
  type?: string;
  objectiveType?: string | number;
  finished?: boolean;
  finishedState: QuestEvidenceState;
  numFulfilled?: number;
  numFulfilledState: QuestEvidenceState;
  numRequired?: number;
  numRequiredState: QuestEvidenceState;
}
export interface ForeverQuestRow {
  /** Newer Classic collectors may expose a title without a stable client quest ID. */
  questID?: number;
  logIndex?: number;
  title?: string;
  titleState: QuestEvidenceState;
  level?: number;
  difficultyLevel?: number;
  isTask?: boolean;
  isBounty?: boolean;
  isStory?: boolean;
  isScaling?: boolean;
  isOnMap?: boolean;
  hasLocalPOI?: boolean;
  isHidden?: boolean;
  isAutoComplete?: boolean;
  suggestedGroup?: number;
  frequency?: number;
  campaignID?: number;
  waypointText?: string;
  objectives?: ForeverQuestObjective[];
  objectiveState: "OBSERVED" | "LAST_SEEN" | "PARTIAL" | "UNKNOWN";
  isComplete?: boolean;
  completionState: QuestEvidenceState;
  readyForTurnIn?: boolean;
  turnInReadinessState: QuestEvidenceState;
  watchType?: string | number;
  watchState: QuestEvidenceState;
  waypoint?: { mapID: number; x: number; y: number; state: "OBSERVED" };
  waypointState: QuestEvidenceState;
  /** Classic: GetQuestLogTitle reported the quest failed. */
  isFailed?: boolean;
  /**
   * LAST_SEEN when the exporter kept this row from an earlier refresh because it was missing from the latest
   * quest log (turned in, abandoned, filtered, or a partial scan). Missing from the log never proves completion.
   */
  rowEvidence: QuestEvidenceState;
  lastSeenAt?: number;
}
export interface ForeverQuestObservation {
  version: "forever" | "classic-era" | "tbc-anniversary";
  identity: { identityKey: string; name: string; realm: string };
  source: string;
  state: QuestEvidenceState;
  completeness: "complete" | "partial" | "unknown";
  observedAt?: number;
  freshness: "recent" | "stale" | "unknown";
  activeState: QuestEvidenceState;
  active?: ForeverQuestRow[];
  activeCounts?: { visibleEntries?: number; quests?: number; scannedRows?: number; returnedQuests?: number };
  completedHistory: {
    state: "OBSERVED" | "LAST_SEEN" | "PARTIAL" | "UNKNOWN";
    questIDs?: number[];
    quests?: Array<{ questID: number; title?: string; titleState: QuestEvidenceState; evidence?: QuestEvidenceState }>;
    returnedCount?: number;
    truncated?: boolean;
    /** IDs returned by an earlier query but not by the latest one; kept as LAST_SEEN, not re-confirmed. */
    lastSeenCount?: number;
    /** Exact lookups requested by the caller: OBSERVED/LAST_SEEN in the returned history, or NOT_IN_RETURNED_HISTORY. */
    lookup?: Array<{ questID: number; state: "OBSERVED" | "LAST_SEEN" | "NOT_IN_RETURNED_HISTORY" | "UNKNOWN" }>;
    coverage?: string;
  };
  issues: string[];
  reason?: string;
}

const MAX_QUESTS = 200;
const MAX_OBJECTIVES = 32;
/** Accepted completed-history size (GearExport's Classic bound) and the bounded number of IDs returned per read. */
const MAX_COMPLETED = 5000;
const MAX_COMPLETED_RETURNED = 500;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validID = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validCounter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;

function evidence(value: unknown, expected?: boolean): QuestEvidenceState {
  if (expected !== undefined) return typeof value === "boolean" ? "OBSERVED" : "UNKNOWN";
  return value === "OBSERVED" || value === "LAST_SEEN" ? value : "UNKNOWN";
}

function normalizeObjective(value: unknown): { row?: ForeverQuestObjective; partial: boolean } {
  const v = record(value);
  if (!v) return { partial: true };
  const validFinished = typeof v.finished === "boolean";
  const validFulfilled = validCounter(v.numFulfilled);
  const validRequired = validCounter(v.numRequired);
  const row: ForeverQuestObjective = {
    ...(validCounter(v.index) ? { index: v.index } : {}),
    ...(text(v.text) ? { text: v.text } : {}),
    ...(text(v.type) ? { type: v.type } : {}),
    ...(typeof v.objectiveType === "string" && v.objectiveType.length <= 128 || validCounter(v.objectiveType) ? { objectiveType: v.objectiveType as string | number } : {}),
    ...(validFinished ? { finished: v.finished as boolean } : {}),
    finishedState: validFinished ? (v.evidence === "LAST_SEEN" || v.finishedState === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED") : "UNKNOWN",
    ...(validFulfilled ? { numFulfilled: v.numFulfilled as number } : {}),
    numFulfilledState: validFulfilled ? "OBSERVED" : "UNKNOWN",
    ...(validRequired ? { numRequired: v.numRequired as number } : {}),
    numRequiredState: validRequired ? "OBSERVED" : "UNKNOWN",
  };
  return { row, partial: !text(v.text) || !validFinished || !validFulfilled || !validRequired };
}

function normalizeQuest(value: unknown): { row?: ForeverQuestRow; partial: boolean } {
  const v = record(value);
  if (!v || !validID(v.questID) && !text(v.title)) return { partial: true };
  const titleValid = text(v.title) && v.title.length > 0;
  let objectives: ForeverQuestObjective[] | undefined;
  let objectiveState: ForeverQuestRow["objectiveState"] = "UNKNOWN";
  let partial = !titleValid;
  const emptyLuaArray = v.objectiveState === "OBSERVED" && record(v.objectives) !== undefined && Object.keys(record(v.objectives)!).length === 0;
  if ((Array.isArray(v.objectives) || emptyLuaArray) && (v.objectiveState === "OBSERVED" || v.objectiveState === "PARTIAL")) {
    objectives = [];
    objectiveState = v.objectiveState;
    const rows = Array.isArray(v.objectives) ? v.objectives : [];
    if (rows.length > MAX_OBJECTIVES) { objectives = rows.slice(0, MAX_OBJECTIVES).flatMap((o) => normalizeObjective(o).row ? [normalizeObjective(o).row!] : []); objectiveState = "PARTIAL"; partial = true; }
    else for (const raw of rows) { const parsed = normalizeObjective(raw); if (parsed.row) objectives.push(parsed.row); if (parsed.partial || !parsed.row) { objectiveState = "PARTIAL"; partial = true; } }
  } else if (v.objectives !== undefined || v.objectiveState !== "UNKNOWN") partial = true;
  const completionValid = typeof v.isComplete === "boolean";
  const readinessValid = typeof v.readyForTurnIn === "boolean";
  const watchType = typeof v.watchType === "string" && v.watchType.length <= 128 || validCounter(v.watchType) ? v.watchType as string | number : undefined;
  const waypoint = record(v.waypoint);
  const waypointValid = waypoint !== undefined && validCounter(waypoint.mapID) && typeof waypoint.x === "number" && Number.isFinite(waypoint.x) && waypoint.x >= 0 && waypoint.x <= 1 && typeof waypoint.y === "number" && Number.isFinite(waypoint.y) && waypoint.y >= 0 && waypoint.y <= 1;
  if ((v.isComplete !== undefined && !completionValid) || (v.readyForTurnIn !== undefined && !readinessValid)) partial = true;
  const rowEvidence: QuestEvidenceState = v.evidence === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED";
  const row: ForeverQuestRow = {
    ...(validID(v.questID) ? { questID: v.questID } : {}),
    rowEvidence,
    ...(rowEvidence === "LAST_SEEN" && Number.isSafeInteger(v.lastSeenAt) ? { lastSeenAt: v.lastSeenAt as number } : {}),
    ...(v.isFailed === true ? { isFailed: true } : {}),
    ...(validCounter(v.logIndex) ? { logIndex: v.logIndex } : {}),
    ...(titleValid ? { title: v.title as string } : {}), titleState: titleValid ? "OBSERVED" : "UNKNOWN",
    ...(validCounter(v.level) ? { level: v.level } : {}), ...(validCounter(v.difficultyLevel) ? { difficultyLevel: v.difficultyLevel } : {}),
    ...(typeof v.isTask === "boolean" ? { isTask: v.isTask } : {}), ...(typeof v.isBounty === "boolean" ? { isBounty: v.isBounty } : {}), ...(typeof v.isStory === "boolean" ? { isStory: v.isStory } : {}),
    ...(typeof v.isScaling === "boolean" ? { isScaling: v.isScaling } : {}), ...(typeof v.isOnMap === "boolean" ? { isOnMap: v.isOnMap } : {}), ...(typeof v.hasLocalPOI === "boolean" ? { hasLocalPOI: v.hasLocalPOI } : {}), ...(typeof v.isHidden === "boolean" ? { isHidden: v.isHidden } : {}), ...(typeof v.isAutoComplete === "boolean" ? { isAutoComplete: v.isAutoComplete } : {}),
    ...(validCounter(v.suggestedGroup) ? { suggestedGroup: v.suggestedGroup } : {}), ...(validCounter(v.frequency) ? { frequency: v.frequency } : {}), ...(validCounter(v.campaignID) ? { campaignID: v.campaignID } : {}),
    ...(text(v.waypointText) ? { waypointText: v.waypointText } : {}),
    ...(objectives ? { objectives } : {}), objectiveState,
    ...(completionValid ? { isComplete: v.isComplete as boolean } : {}), completionState: completionValid ? (v.completionState === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED") : "UNKNOWN",
    ...(readinessValid ? { readyForTurnIn: v.readyForTurnIn as boolean } : {}), turnInReadinessState: readinessValid ? "OBSERVED" : "UNKNOWN",
    ...(watchType !== undefined ? { watchType } : {}), watchState: watchType !== undefined ? evidence(v.watchState) : "UNKNOWN",
    ...(waypointValid ? { waypoint: { mapID: waypoint.mapID as number, x: waypoint.x as number, y: waypoint.y as number, state: "OBSERVED" } } : {}),
    waypointState: waypointValid ? "OBSERVED" : "UNKNOWN",
  };
  return { row, partial };
}

/** Converts only a profile/identity-validated WoWSyncDB quest section into a bounded read model. */
export function buildForeverQuestObservation(input: {
  section?: unknown;
  profile: string;
  identity: { identityKey: string; name: string; realm: string };
  now: number;
  completedLookup?: readonly number[];
}): ForeverQuestObservation {
  return buildQuestObservation({ ...input, version: "forever" });
}

/**
 * Forever (C_QuestLog) and Classic Era / TBC (legacy quest log) quest sections share one evidence model.
 * Each family keeps its own profile, source, and row bound; nothing is accepted across families.
 */
export function buildQuestObservation(input: {
  version: "forever" | "classic-era" | "tbc-anniversary";
  section?: unknown;
  profile: string;
  identity: { identityKey: string; name: string; realm: string };
  now: number;
  completedLookup?: readonly number[];
}): ForeverQuestObservation {
  const forever = input.version === "forever";
  const section = record(input.section);
  const data = record(section?.data);
  const observedAt = typeof section?.observedAt === "number" && Number.isFinite(section.observedAt) ? section.observedAt : undefined;
  const freshness = observedAt === undefined ? "unknown" : classifyFreshness(observedAt, input.now);
  const sourceName = forever ? "Forever WoWSyncDB sections.quests" : "Classic WoWSyncDB sections.quests (legacy quest log)";
  const reason = (detail: string): ForeverQuestObservation => ({ version: input.version, identity: input.identity, source: sourceName, state: "UNKNOWN", completeness: "unknown", ...(observedAt !== undefined ? { observedAt } : {}), freshness, activeState: "UNKNOWN", completedHistory: { state: "UNKNOWN" }, issues: [], reason: detail });
  if (!section || !data) return reason("Quest observations were not captured in this export.");
  if (forever) {
    if (!isForeverProfile(input.profile)) return reason("The quest sidecar profile is not a well-formed Forever client profile.");
    if (data.formatVersion !== 1 || data.clientFamily !== "Forever" || data.clientProfile !== input.profile || data.source !== "C_QuestLog") return reason("The quest sidecar format or source does not match its verified Forever profile.");
  } else {
    if (classicProfileVersion(input.profile) !== input.version) return reason(`The quest sidecar profile is not a ${input.version} client profile.`);
    if (data.formatVersion !== 1 || data.clientFamily !== "Classic" || data.clientProfile !== input.profile || data.source !== "legacy quest log APIs") return reason("The quest sidecar format or source does not match its Classic profile.");
  }
  if (!observedAt || !Number.isSafeInteger(data.observedAt) || (data.observedAt as number) > observedAt || observedAt - (data.observedAt as number) > 120) return reason("Quest section timestamp is missing or inconsistent with the persisted section time.");
  const activeRows = Array.isArray(data.active) ? data.active : Array.isArray(data.quests) ? data.quests : undefined;
  const activeAvailable = (data.activeState === "OBSERVED" || data.evidence === "OBSERVED") && activeRows !== undefined && activeRows.length <= MAX_QUESTS;
  if ((data.activeState === "OBSERVED" || data.evidence === "OBSERVED") && activeRows && activeRows.length > MAX_QUESTS) return reason("Active quest data exceeds the supported read bound.");
  const active: ForeverQuestRow[] = [];
  const seen = new Set<number>();
  const seenTitles = new Set<string>();
  let partial = section.completeness !== "complete" || data.activeCompleteness !== "complete" || !activeAvailable;
  for (const raw of activeAvailable ? activeRows! : []) {
    const parsed = normalizeQuest(raw);
    const key = parsed.row?.questID !== undefined ? `id:${parsed.row.questID}` : `title:${parsed.row?.title?.toLocaleLowerCase() ?? ""}`;
    if (!parsed.row || parsed.row.questID !== undefined && seen.has(parsed.row.questID) || parsed.row.questID === undefined && seenTitles.has(key)) { partial = true; continue; }
    if (parsed.row.questID !== undefined) seen.add(parsed.row.questID); else seenTitles.add(key);
    active.push(parsed.row); partial ||= parsed.partial || parsed.row.questID === undefined;
  }
  const history = record(data.completedHistory);
  let completedHistory: ForeverQuestObservation["completedHistory"] = { state: "UNKNOWN" };
  if (history && (history.state === "OBSERVED" || history.state === "PARTIAL") && Array.isArray(history.questIDs) && history.questIDs.length <= MAX_COMPLETED) {
    const ids: number[] = []; const idsSeen = new Set<number>();
    for (const id of history.questIDs) { if (!validID(id) || idsSeen.has(id)) { partial = true; continue; } idsSeen.add(id); ids.push(id); }
    if (history.returnedCount !== undefined && (!validCounter(history.returnedCount) || history.returnedCount !== ids.length)) partial = true;
    const titles = new Map<number, string>();
    const lastSeenIDs = new Set<number>();
    if (Array.isArray(history.quests)) for (const raw of history.quests.slice(0, MAX_COMPLETED)) {
      const quest = record(raw);
      if (!validID(quest?.questID) || !idsSeen.has(quest.questID)) continue;
      if (text(quest.title) && quest.title.length > 0) titles.set(quest.questID, quest.title);
      // The exporter keeps IDs an earlier query returned but the latest did not; they are not re-confirmed.
      if (quest.evidence === "LAST_SEEN") lastSeenIDs.add(quest.questID);
    }
    const failedRefresh = section.lastAttemptStale === true;
    const rowEvidence = (questID: number): QuestEvidenceState => failedRefresh || lastSeenIDs.has(questID) ? "LAST_SEEN" : "OBSERVED";
    const returned = ids.slice(0, MAX_COMPLETED_RETURNED);
    const lookup = (input.completedLookup ?? []).slice(0, 50).map((questID) => ({ questID, state: idsSeen.has(questID) ? rowEvidence(questID) : history.state === "OBSERVED" && !failedRefresh ? "NOT_IN_RETURNED_HISTORY" as const : "UNKNOWN" as const }));
    completedHistory = { state: failedRefresh ? "LAST_SEEN" : history.state === "OBSERVED" ? "OBSERVED" : "PARTIAL", questIDs: returned, quests: returned.map((questID) => ({ questID, ...(titles.has(questID) ? { title: titles.get(questID) } : {}), titleState: titles.has(questID) ? (failedRefresh ? "LAST_SEEN" : "OBSERVED") : "UNKNOWN", evidence: rowEvidence(questID) })), returnedCount: ids.length, ...(history.truncated === true || ids.length > returned.length ? { truncated: true } : {}), ...(lastSeenIDs.size > 0 ? { lastSeenCount: lastSeenIDs.size } : {}), ...(lookup.length > 0 ? { lookup } : {}), ...(typeof history.coverage === "string" ? { coverage: history.coverage } : {}) };
  } else if (history?.state === "UNKNOWN") completedHistory = { state: "UNKNOWN" };
  else partial = true;
  const counts = record(data.activeCounts);
  const activeCounts = counts ? Object.fromEntries(["visibleEntries", "quests", "scannedRows", "returnedQuests"].flatMap((key) => validCounter(counts[key]) ? [[key, counts[key]]] : [])) as ForeverQuestObservation["activeCounts"] : undefined;
  if (activeAvailable && (!activeCounts || activeCounts.quests === undefined || activeCounts.returnedQuests !== active.length || activeCounts.quests !== activeCounts.returnedQuests)) partial = true;
  if (activeAvailable && activeCounts && activeCounts.visibleEntries !== undefined && activeCounts.scannedRows !== Math.min(activeCounts.visibleEntries, forever ? 120 : 250)) partial = true;
  const issues = Array.isArray(data.issues) ? data.issues.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
  const failedRefresh = section.lastAttemptStale === true;
  const stale = freshness === "stale" || failedRefresh;
  const historyAvailable = completedHistory.state === "OBSERVED" || completedHistory.state === "PARTIAL";
  const state: QuestEvidenceState = stale && (activeAvailable || historyAvailable) ? "LAST_SEEN" : activeAvailable || historyAvailable ? "OBSERVED" : "UNKNOWN";
  if (issues.length > 0) partial = true;
  const mark = (value: QuestEvidenceState): QuestEvidenceState => value === "OBSERVED" ? "LAST_SEEN" : value;
  const staleActive = active.map((row) => !stale && row.rowEvidence !== "LAST_SEEN" ? row : ({
    ...row, rowEvidence: "LAST_SEEN" as const,
    titleState: mark(row.titleState), completionState: mark(row.completionState),
    turnInReadinessState: mark(row.turnInReadinessState), watchState: mark(row.watchState), waypointState: mark(row.waypointState),
    objectiveState: row.objectiveState === "OBSERVED" ? "LAST_SEEN" as const : row.objectiveState,
    ...(row.objectives ? { objectives: row.objectives.map((objective) => ({ ...objective, finishedState: mark(objective.finishedState), numFulfilledState: mark(objective.numFulfilledState), numRequiredState: mark(objective.numRequiredState) })) } : {}),
  }));
  if (active.some((row) => row.rowEvidence === "LAST_SEEN")) partial = true;
  const activeState: QuestEvidenceState = activeAvailable ? stale ? "LAST_SEEN" : "OBSERVED" : "UNKNOWN";
  if (!activeAvailable) partial = true;
  const reasonText = !activeAvailable ? "Active quest coverage is UNKNOWN; unavailable data is not an empty quest log." : typeof section.reason === "string" ? section.reason : failedRefresh ? "The latest quest refresh failed; displayed values are the last successful observation." : freshness === "stale" ? "This observation is older than the current freshness window." : undefined;
  return { version: input.version, identity: input.identity, source: forever ? "Forever C_QuestLog structured sidecar" : "Classic legacy quest log structured sidecar", state, completeness: partial ? "partial" : "complete", observedAt, freshness, activeState, ...(activeAvailable ? { active: staleActive } : {}), ...(activeCounts ? { activeCounts } : {}), completedHistory, issues, ...(reasonText ? { reason: reasonText } : {}) };
}
