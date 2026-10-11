import { classifyFreshness } from "./freshness.ts";

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
  questID: number;
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
}
export interface ForeverQuestObservation {
  version: "forever";
  identity: { identityKey: string; name: string; realm: string };
  source: string;
  state: QuestEvidenceState;
  completeness: "complete" | "partial" | "unknown";
  observedAt?: number;
  freshness: "recent" | "stale" | "unknown";
  activeState: QuestEvidenceState;
  active?: ForeverQuestRow[];
  activeCounts?: { visibleEntries?: number; quests?: number; scannedRows?: number; returnedQuests?: number };
  completedHistory: { state: "OBSERVED" | "LAST_SEEN" | "PARTIAL" | "UNKNOWN"; questIDs?: number[]; quests?: Array<{ questID: number; title?: string; titleState: QuestEvidenceState }>; returnedCount?: number; truncated?: boolean };
  issues: string[];
  reason?: string;
}

const MAX_QUESTS = 100;
const MAX_OBJECTIVES = 32;
const MAX_COMPLETED = 500;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validID = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validCounter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 512;

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
    finishedState: validFinished ? "OBSERVED" : "UNKNOWN",
    ...(validFulfilled ? { numFulfilled: v.numFulfilled as number } : {}),
    numFulfilledState: validFulfilled ? "OBSERVED" : "UNKNOWN",
    ...(validRequired ? { numRequired: v.numRequired as number } : {}),
    numRequiredState: validRequired ? "OBSERVED" : "UNKNOWN",
  };
  return { row, partial: !text(v.text) || !validFinished || !validFulfilled || !validRequired };
}

function normalizeQuest(value: unknown): { row?: ForeverQuestRow; partial: boolean } {
  const v = record(value);
  if (!v || !validID(v.questID)) return { partial: true };
  const titleValid = text(v.title) && v.title.length > 0;
  let objectives: ForeverQuestObjective[] | undefined;
  let objectiveState: ForeverQuestRow["objectiveState"] = "UNKNOWN";
  let partial = !titleValid;
  if (Array.isArray(v.objectives) && (v.objectiveState === "OBSERVED" || v.objectiveState === "PARTIAL")) {
    objectives = [];
    objectiveState = v.objectiveState;
    if (v.objectives.length > MAX_OBJECTIVES) { objectives = v.objectives.slice(0, MAX_OBJECTIVES).flatMap((o) => normalizeObjective(o).row ? [normalizeObjective(o).row!] : []); objectiveState = "PARTIAL"; partial = true; }
    else for (const raw of v.objectives) { const parsed = normalizeObjective(raw); if (parsed.row) objectives.push(parsed.row); if (parsed.partial || !parsed.row) { objectiveState = "PARTIAL"; partial = true; } }
  } else if (v.objectives !== undefined || v.objectiveState !== "UNKNOWN") partial = true;
  const completionValid = typeof v.isComplete === "boolean";
  const readinessValid = typeof v.readyForTurnIn === "boolean";
  const watchType = typeof v.watchType === "string" && v.watchType.length <= 128 || validCounter(v.watchType) ? v.watchType as string | number : undefined;
  const waypoint = record(v.waypoint);
  const waypointValid = waypoint !== undefined && validCounter(waypoint.mapID) && typeof waypoint.x === "number" && Number.isFinite(waypoint.x) && waypoint.x >= 0 && waypoint.x <= 1 && typeof waypoint.y === "number" && Number.isFinite(waypoint.y) && waypoint.y >= 0 && waypoint.y <= 1;
  if ((v.isComplete !== undefined && !completionValid) || (v.readyForTurnIn !== undefined && !readinessValid)) partial = true;
  const row: ForeverQuestRow = {
    questID: v.questID,
    ...(validCounter(v.logIndex) ? { logIndex: v.logIndex } : {}),
    ...(titleValid ? { title: v.title as string } : {}), titleState: titleValid ? "OBSERVED" : "UNKNOWN",
    ...(validCounter(v.level) ? { level: v.level } : {}), ...(validCounter(v.difficultyLevel) ? { difficultyLevel: v.difficultyLevel } : {}),
    ...(typeof v.isTask === "boolean" ? { isTask: v.isTask } : {}), ...(typeof v.isBounty === "boolean" ? { isBounty: v.isBounty } : {}), ...(typeof v.isStory === "boolean" ? { isStory: v.isStory } : {}),
    ...(typeof v.isScaling === "boolean" ? { isScaling: v.isScaling } : {}), ...(typeof v.isOnMap === "boolean" ? { isOnMap: v.isOnMap } : {}), ...(typeof v.hasLocalPOI === "boolean" ? { hasLocalPOI: v.hasLocalPOI } : {}), ...(typeof v.isHidden === "boolean" ? { isHidden: v.isHidden } : {}), ...(typeof v.isAutoComplete === "boolean" ? { isAutoComplete: v.isAutoComplete } : {}),
    ...(validCounter(v.suggestedGroup) ? { suggestedGroup: v.suggestedGroup } : {}), ...(validCounter(v.frequency) ? { frequency: v.frequency } : {}), ...(validCounter(v.campaignID) ? { campaignID: v.campaignID } : {}),
    ...(text(v.waypointText) ? { waypointText: v.waypointText } : {}),
    ...(objectives ? { objectives } : {}), objectiveState,
    ...(completionValid ? { isComplete: v.isComplete as boolean } : {}), completionState: completionValid ? "OBSERVED" : "UNKNOWN",
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
}): ForeverQuestObservation {
  const section = record(input.section);
  const data = record(section?.data);
  const observedAt = typeof section?.observedAt === "number" && Number.isFinite(section.observedAt) ? section.observedAt : undefined;
  const freshness = observedAt === undefined ? "unknown" : classifyFreshness(observedAt, input.now);
  const reason = (detail: string): ForeverQuestObservation => ({ version: "forever", identity: input.identity, source: "Forever WoWSyncDB sections.quests", state: "UNKNOWN", completeness: "unknown", ...(observedAt !== undefined ? { observedAt } : {}), freshness, activeState: "UNKNOWN", completedHistory: { state: "UNKNOWN" }, issues: [], reason: detail });
  if (!section || !data) return reason("Quest observations were not captured in this export.");
  if (input.profile !== "Forever:1.60.1:70291:16001" && input.profile !== "Forever:1.60.1:70338:16001") return reason("The quest sidecar profile does not match an allowlisted Forever client.");
  if (data.formatVersion !== 1 || data.clientFamily !== "Forever" || data.clientProfile !== input.profile || data.source !== "C_QuestLog") return reason("The quest sidecar format or source does not match its verified Forever profile.");
  if (!observedAt || !Number.isSafeInteger(data.observedAt) || (data.observedAt as number) > observedAt || observedAt - (data.observedAt as number) > 120) return reason("Quest section timestamp is missing or inconsistent with the persisted section time.");
  const activeAvailable = data.activeState === "OBSERVED" && Array.isArray(data.active) && data.active.length <= MAX_QUESTS;
  if (data.activeState === "OBSERVED" && Array.isArray(data.active) && data.active.length > MAX_QUESTS) return reason("Active quest data exceeds the supported read bound.");
  const active: ForeverQuestRow[] = [];
  const seen = new Set<number>();
  let partial = section.completeness !== "complete" || data.activeCompleteness !== "complete" || !activeAvailable;
  for (const raw of activeAvailable ? data.active as unknown[] : []) {
    const parsed = normalizeQuest(raw);
    if (!parsed.row || seen.has(parsed.row.questID)) { partial = true; continue; }
    seen.add(parsed.row.questID); active.push(parsed.row); partial ||= parsed.partial;
  }
  const history = record(data.completedHistory);
  let completedHistory: ForeverQuestObservation["completedHistory"] = { state: "UNKNOWN" };
  if (history && (history.state === "OBSERVED" || history.state === "PARTIAL") && Array.isArray(history.questIDs) && history.questIDs.length <= MAX_COMPLETED) {
    const ids: number[] = []; const idsSeen = new Set<number>();
    for (const id of history.questIDs) { if (!validID(id) || idsSeen.has(id)) { partial = true; continue; } idsSeen.add(id); ids.push(id); }
    if (history.returnedCount !== undefined && (!validCounter(history.returnedCount) || history.returnedCount !== ids.length)) partial = true;
    const titles = new Map<number, string>();
    if (Array.isArray(history.quests)) for (const raw of history.quests.slice(0, MAX_COMPLETED)) {
      const quest = record(raw);
      if (validID(quest?.questID) && idsSeen.has(quest.questID) && text(quest.title) && quest.title.length > 0) titles.set(quest.questID, quest.title);
    }
    const failedRefresh = section.lastAttemptStale === true;
    completedHistory = { state: failedRefresh ? "LAST_SEEN" : history.state === "OBSERVED" ? "OBSERVED" : "PARTIAL", questIDs: ids, quests: ids.map((questID) => ({ questID, ...(titles.has(questID) ? { title: titles.get(questID) } : {}), titleState: titles.has(questID) ? (failedRefresh ? "LAST_SEEN" : "OBSERVED") : "UNKNOWN" })), returnedCount: ids.length, ...(history.truncated === true ? { truncated: true } : {}) };
  } else if (history?.state === "UNKNOWN") completedHistory = { state: "UNKNOWN" };
  else partial = true;
  const counts = record(data.activeCounts);
  const activeCounts = counts ? Object.fromEntries(["visibleEntries", "quests", "scannedRows", "returnedQuests"].flatMap((key) => validCounter(counts[key]) ? [[key, counts[key]]] : [])) as ForeverQuestObservation["activeCounts"] : undefined;
  if (activeAvailable && (!activeCounts || activeCounts.quests === undefined || activeCounts.returnedQuests !== active.length || activeCounts.quests !== activeCounts.returnedQuests)) partial = true;
  if (activeAvailable && activeCounts && activeCounts.visibleEntries !== undefined && activeCounts.scannedRows !== Math.min(activeCounts.visibleEntries, 120)) partial = true;
  const issues = Array.isArray(data.issues) ? data.issues.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
  const failedRefresh = section.lastAttemptStale === true;
  const stale = freshness === "stale" || failedRefresh;
  const historyAvailable = completedHistory.state === "OBSERVED" || completedHistory.state === "PARTIAL";
  const state: QuestEvidenceState = stale && (activeAvailable || historyAvailable) ? "LAST_SEEN" : activeAvailable || historyAvailable ? "OBSERVED" : "UNKNOWN";
  if (issues.length > 0) partial = true;
  const mark = (value: QuestEvidenceState): QuestEvidenceState => value === "OBSERVED" ? "LAST_SEEN" : value;
  const staleActive = stale ? active.map((row) => ({
    ...row,
    titleState: mark(row.titleState), completionState: mark(row.completionState),
    turnInReadinessState: mark(row.turnInReadinessState), watchState: mark(row.watchState), waypointState: mark(row.waypointState),
    objectiveState: row.objectiveState === "OBSERVED" ? "LAST_SEEN" as const : row.objectiveState,
    ...(row.objectives ? { objectives: row.objectives.map((objective) => ({ ...objective, finishedState: mark(objective.finishedState), numFulfilledState: mark(objective.numFulfilledState), numRequiredState: mark(objective.numRequiredState) })) } : {}),
  })) : active;
  const activeState: QuestEvidenceState = activeAvailable ? stale ? "LAST_SEEN" : "OBSERVED" : "UNKNOWN";
  if (!activeAvailable) partial = true;
  const reasonText = !activeAvailable ? "Active quest coverage is UNKNOWN; unavailable data is not an empty quest log." : typeof section.reason === "string" ? section.reason : failedRefresh ? "The latest quest refresh failed; displayed values are the last successful observation." : freshness === "stale" ? "This observation is older than the current freshness window." : undefined;
  return { version: "forever", identity: input.identity, source: "Forever C_QuestLog structured sidecar", state, completeness: partial ? "partial" : "complete", observedAt, freshness, activeState, ...(activeAvailable ? { active: staleActive } : {}), ...(activeCounts ? { activeCounts } : {}), completedHistory, issues, ...(reasonText ? { reason: reasonText } : {}) };
}

function validQuestArray(value: unknown): value is unknown[] { return Array.isArray(value) && value.length <= MAX_QUESTS; }
