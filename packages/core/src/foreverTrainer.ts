// Forever trainer-window evidence. GearExport stores raw GetTrainerService* calls made while a trainer
// window was open (no purchase or learning action). This reads them as data: each service's name, rank,
// status at the visit, the level field the client returned, cost, and ability/skill requirements.
// Nothing here claims the service is still in the same state now.

export interface ForeverTrainerService {
  name: string;
  rank?: string;
  /** Client status at the visit: available, unavailable, used (already known), or another raw value. */
  statusAtVisit: string;
  /** Fourth GetTrainerServiceInfo return on Forever; it matches the required level in every checked row. */
  level?: number;
  costCopper?: number;
  requires: string[];
  skillRequirement?: { skill?: string; rank?: number };
}

export interface ForeverTrainerVisit {
  frame: string;
  /** CLASS, or the profession named by the services' skill requirements (Forever uses one frame for both). */
  kind: string;
  observedAt?: number;
  snapshotId: number;
  serviceCount: number;
  services: ForeverTrainerService[];
}

type Loose = Record<string, unknown>;
const returns = (call: unknown): unknown[] => {
  const list = (call as Loose | undefined)?.returns;
  if (!Array.isArray(list)) return [];
  const out: unknown[] = [];
  for (const entry of list as Loose[]) {
    const observation = entry.observation as Loose | undefined;
    out[Number(entry.index) - 1] = observation?.state === "OBSERVED" ? observation.value : undefined;
  }
  return out;
};

function findTrainerEvidence(value: unknown, depth = 0): Loose | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const record = value as Loose;
  if (record.trainerEvidence && typeof record.trainerEvidence === "object") return record.trainerEvidence as Loose;
  for (const child of Object.values(record)) {
    const found = findTrainerEvidence(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Reads trainer evidence from a parsed snapshot's Forever structured observation, if any. */
export function extractForeverTrainerVisit(parsed: unknown, snapshotId: number): ForeverTrainerVisit | undefined {
  const evidence = findTrainerEvidence((parsed as Loose | undefined)?.foreverGearObservation);
  const window = (evidence?.lastObserved ?? (evidence?.state === "OBSERVED" ? evidence : undefined)) as Loose | undefined;
  const rawServices = Array.isArray(window?.services) ? window!.services as Loose[] : [];
  if (!rawServices.length) return undefined;
  let frame = "UNKNOWN";
  let observedAt: number | undefined;
  const services: ForeverTrainerService[] = [];
  for (const raw of rawServices) {
    const calls = (raw.calls ?? {}) as Loose;
    const info = returns(calls.info);
    const context = ((calls.info as Loose | undefined)?.context ?? {}) as Loose;
    if (typeof context.frame === "string") frame = context.frame;
    const at = (calls.info as Loose | undefined)?.observedAt;
    if (typeof at === "number") observedAt = Math.max(observedAt ?? 0, at);
    if (typeof info[0] !== "string") continue;
    const requires = (Array.isArray(calls.abilityRequirements) ? calls.abilityRequirements : []).map((call) => returns(call)[0]).filter((name): name is string => typeof name === "string");
    const skill = returns(calls.skillRequirement);
    const cost = returns(calls.cost)[0];
    services.push({
      name: info[0],
      rank: typeof info[4] === "string" && info[4] ? info[4] : undefined,
      statusAtVisit: typeof info[1] === "string" ? info[1] : "unknown",
      level: typeof info[3] === "number" && info[3] > 0 ? info[3] : undefined,
      costCopper: typeof cost === "number" ? cost : undefined,
      requires,
      skillRequirement: typeof skill[0] === "string" || (typeof skill[1] === "number" && skill[1] > 0) ? { skill: typeof skill[0] === "string" ? skill[0] : undefined, rank: typeof skill[1] === "number" ? skill[1] : undefined } : undefined,
    });
  }
  if (!services.length) return undefined;
  const skills = services.map((service) => service.skillRequirement?.skill).filter((name): name is string => !!name);
  const kind = skills.length >= services.length / 2 ? skills.sort((a, b) => skills.filter((x) => x === b).length - skills.filter((x) => x === a).length)[0] : "CLASS";
  return { frame, kind, observedAt, snapshotId, serviceCount: Number(window?.serviceCount ?? services.length), services };
}
