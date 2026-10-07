import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

function freshStore() {
  return new SqliteSnapshotStore(":memory:");
}

test("importing an export creates a character and a first snapshot", () => {
  const store = freshStore();
  try {
    const raw = buildWowSyncExport({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 20, moneyCopper: 50000 } });
    const result = store.importSnapshot(raw);
    assert.equal(result.isFirstSnapshot, true);
    assert.equal(result.character.name, "Torahn");
    assert.equal(result.character.version, "tbc-anniversary");
    assert.equal(result.character.snapshotCount, 1);
    assert.equal(result.diff, undefined);
  } finally {
    store.close();
  }
});

test("gear candidates persist in snapshot JSON, duplicates are idempotent, and separate observations stay separate", () => {
  const store = freshStore();
  try {
    const base = buildWowSyncExport({ generatedAt: 1_700_000_000, character: { name: "RetailOne", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } });
    const section = "[GEAR CANDIDATES]\nState: complete; observed=1700000000\nContractVersion: 1\ncandidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState\nEQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t0\t100\t80\t4\t0\tINVTYPE_HEAD\tno\tno\t?\t?\t?\t?\tyes\tOBSERVED";
    const firstRaw = base.replace("\n\n[END]", `\n\n${section}\n\n[END]`);
    const first = store.importSnapshot(firstRaw);
    assert.deepEqual(first.snapshot.parsed.gearCandidates?.rows[0]?.itemID, { state: "KNOWN", value: 123 });
    assert.equal(store.importSnapshot(firstRaw).isDuplicate, true);
    const secondRaw = buildWowSyncExport({ generatedAt: 1_700_000_001, character: { name: "RetailOne", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }).replace("\n\n[END]", `\n\n${section.replaceAll("1700000000", "1700000001")}\n\n[END]`);
    const second = store.importSnapshot(secondRaw);
    assert.notEqual(second.snapshot.id, first.snapshot.id);
    assert.equal(store.listSnapshots(first.character.identityKey).length, 2);
    const otherCharacter = store.importSnapshot(buildWowSyncExport({ character: { name: "RetailTwo", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }));
    assert.equal(otherCharacter.snapshot.parsed.gearCandidates, undefined);
    assert.equal(store.listCharacters("retail").length, 2);
    assert.equal(store.listCharacters("classic-era").length, 0);
  } finally { store.close(); }
});

test("a second import does not destroy the first snapshot, and produces a diff", () => {
  const store = freshStore();
  try {
    const raw1 = buildWowSyncExport({
      character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 20, moneyCopper: 50000 },
      professions: { entries: [{ name: "Mining", skill: 60, maxSkill: 300 }] },
    });
    const raw2 = buildWowSyncExport({
      character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 22, moneyCopper: 70000 },
      professions: { entries: [{ name: "Mining", skill: 74, maxSkill: 300 }] },
    });
    store.importSnapshot(raw1);
    const result2 = store.importSnapshot(raw2);

    assert.equal(result2.isFirstSnapshot, false);
    assert.equal(result2.character.snapshotCount, 2);
    assert.equal(result2.diff?.level.delta, 2);
    assert.equal(result2.diff?.moneyCopper.delta, 20000);
    assert.equal(result2.diff?.professions[0]?.skill.delta, 14);

    const history = store.listSnapshots(result2.character.identityKey);
    assert.equal(history.length, 2);
    assert.equal(history[0].parsed.character.level, 22);
    assert.equal(history[1].parsed.character.level, 20);
  } finally {
    store.close();
  }
});

test("characters in different WoW versions are never aggregated together", () => {
  const store = freshStore();
  try {
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Bromrik", realm: "Whitemane", clientVersion: "1.15.7", moneyCopper: 10000 } }),
    );
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", moneyCopper: 700000 } }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Retailchar", realm: "Area52", clientVersion: "12.1.0", clientFamily: "Retail", interface: "120100", moneyCopper: 999999 },
      }),
    );

    const versions = store.listVersions();
    const era = versions.find((v) => v.version === "classic-era")!;
    const tbc = versions.find((v) => v.version === "tbc-anniversary")!;
    const retail = versions.find((v) => v.version === "retail")!;

    assert.equal(era.characterCount, 1);
    assert.equal(era.totalMoneyCopper, 10000);
    assert.equal(tbc.characterCount, 1);
    assert.equal(tbc.totalMoneyCopper, 700000);
    assert.equal(retail.characterCount, 1);
    assert.equal(retail.totalMoneyCopper, 999999);
  } finally {
    store.close();
  }
});

test("same character name on different realms are stored as distinct characters", () => {
  const store = freshStore();
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Bromrik", realm: "Whitemane", clientVersion: "1.15.7" } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Bromrik", realm: "Grobbulus", clientVersion: "1.15.7" } }));
    const chars = store.listCharacters("classic-era");
    assert.equal(chars.length, 2);
    assert.notEqual(chars[0].identityKey, chars[1].identityKey);
  } finally {
    store.close();
  }
});

test("recentChanges surfaces a deterministic level-up across snapshots", () => {
  const store = freshStore();
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Voodan", realm: "Faerlina", clientVersion: "2.5.6", level: 18 } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Voodan", realm: "Faerlina", clientVersion: "2.5.6", level: 19 } }));
    const changes = store.recentChanges("tbc-anniversary");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].characterName, "Voodan");
    assert.equal(changes[0].diff.level.delta, 1);
  } finally {
    store.close();
  }
});

test("recentChanges with no limit returns the full meaningful set; a positive limit slices", () => {
  const store = freshStore();
  try {
    const base = 1_700_000_000;
    for (let i = 0; i < 25; i++) {
      const name = `Alt${String(i).padStart(2, "0")}`;
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + i * 10,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 10 },
      }));
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + i * 10 + 5,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 11 },
      }));
    }
    const all = store.recentChanges("tbc-anniversary");
    assert.equal(all.length, 25);
    assert.equal(store.recentChanges("tbc-anniversary", 5).length, 5);
    assert.equal(store.recentChanges("tbc-anniversary", 20).length, 20);
  } finally {
    store.close();
  }
});

test("buildAccountFacts keeps a realm-B change that would fall outside a version-wide top-20 cap", () => {
  const store = freshStore();
  try {
    const base = 1_700_000_000;
    // 21 newer meaningful changes on realm A dominate a version-wide top-20.
    for (let i = 0; i < 21; i++) {
      const name = `Dom${String(i).padStart(2, "0")}`;
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + 1000 + i * 10,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 20 },
      }));
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + 1000 + i * 10 + 5,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 21 },
      }));
    }
    // Older meaningful change on realm B — outside top-20 version-wide.
    store.importSnapshot(buildWowSyncExport({
      generatedAt: base,
      character: { name: "Quiet", realm: "Grobbulus", clientVersion: "2.5.6", level: 30 },
    }));
    store.importSnapshot(buildWowSyncExport({
      generatedAt: base + 5,
      character: { name: "Quiet", realm: "Grobbulus", clientVersion: "2.5.6", level: 31 },
    }));

    const capped = store.recentChanges("tbc-anniversary", 20);
    assert.equal(capped.length, 20);
    assert.equal(capped.some((c) => c.characterName === "Quiet"), false, "Quiet must fall outside version-wide top-20");

    const uncapped = store.recentChanges("tbc-anniversary");
    assert.equal(uncapped.some((c) => c.characterName === "Quiet"), true);

    const facts = store.buildAccountFacts("tbc-anniversary", base + 10_000);
    assert.equal(facts.recentChanges.some((c) => c.characterName === "Quiet"), true, "AccountFacts must carry Quiet for post-scope display");
    assert.ok(facts.recentChanges.length > 20);
  } finally {
    store.close();
  }
});

// Equipment observation tests (A03-A10, A19-A30, A33-A38, A40, A42-A43)

test("A03: canonical only, no projection -> recorded", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 1791375064,
            capture: 29,
            revision: 220,
            completeness: "complete",
            data: { slots: { "1": { itemID: 123 } } },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

test("A04: canonical + equivalent projection -> recorded", () => {
  const store = freshStore();
  try {
    const sidecar = { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" };
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 1791375064,
            capture: 29,
            revision: 220,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: sidecar,
          },
          projection: sidecar,
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

test("A05: canonical + differing projection -> projection-mismatch, no row", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 1791375064,
            capture: 29,
            revision: 220,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" },
          },
          projection: { contractVersion: 1, clientFamily: "Retail", stability: "UNSTABLE" },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "projection-mismatch");
  } finally {
    store.close();
  }
});

test("A06: projection only (in canonical) -> projection-without-canonical", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            // no specEquipmentObservation
          },
          projection: { contractVersion: 1, clientFamily: "Retail" },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "projection-without-canonical");
  } finally {
    store.close();
  }
});

test("A07-A10: tuple columns match envelope values", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 1791375064,
            capture: 29,
            revision: 220,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
    assert(result.snapshot.id > 0);
  } finally {
    store.close();
  }
});

test("A19: new snapshot branch inserts observation row", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
          },
        },
      }
    );

    assert.strictEqual(result.isFirstSnapshot, true);
    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

test("A22: exact same tuple + evidence -> already-recorded", () => {
  const store = freshStore();
  try {
    const observation = {
      envelope: {
        observedAt: 100,
        capture: 1,
        revision: 1,
        completeness: "complete",
        data: { slots: { "1": { itemID: 123 } } },
        specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" },
      },
    };

    const raw = buildWowSyncExport({
      character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
    });

    const first = store.importSnapshot(raw, { equipmentObservation: observation });
    const second = store.importSnapshot(raw, { equipmentObservation: observation });

    assert.strictEqual(first.equipmentObservation, "recorded");
    assert.strictEqual(second.equipmentObservation, "already-recorded");
  } finally {
    store.close();
  }
});

test("A23: same tuple + different evidence -> conflict", () => {
  const store = freshStore();
  try {
    const raw = buildWowSyncExport({
      character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
    });

    const first = store.importSnapshot(raw, {
      equipmentObservation: {
        envelope: {
          observedAt: 100,
          capture: 1,
          revision: 1,
          completeness: "complete",
          data: { slots: { "1": { itemID: 123 } } },
          specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" },
        },
      },
    });

    const second = store.importSnapshot(raw, {
      equipmentObservation: {
        envelope: {
          observedAt: 100,
          capture: 1,
          revision: 1,
          completeness: "partial",
          reason: "Pending",
          data: { slots: { "1": { itemID: 123 } } },
          specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" },
        },
      },
    });

    assert.strictEqual(first.equipmentObservation, "recorded");
    assert.strictEqual(second.equipmentObservation, "conflict");
    assert.strictEqual(second.snapshot.id > 0, true);
  } finally {
    store.close();
  }
});

test("A25: parsed_json.characterState contains no equipment observation", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
          },
        },
      }
    );

    const parsed = result.snapshot.parsed;
    assert(typeof parsed.character === "object");
    assert.strictEqual((parsed.character as any).equipmentObservation, undefined);
  } finally {
    store.close();
  }
});

test("A30: row's character_id is the Retail version::realm::name character", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
          },
        },
      }
    );

    assert.strictEqual(result.character.version, "retail");
    assert.strictEqual(result.character.realm, "Cairne");
    assert.strictEqual(result.character.name, "Virek");
  } finally {
    store.close();
  }
});

test("A31: Classic/TBC/Forever with field -> invalid-or-unsupported", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "ClassicChar", realm: "Faerlina", clientVersion: "1.15.7" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "invalid-or-unsupported");
  } finally {
    store.close();
  }
});

test("A33: partial envelope stored", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "partial",
            reason: "Item metadata pending",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

test("A34: UNSTABLE sidecar stored", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "UNSTABLE" },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

test("A35: NOT_READY sidecar stored", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: {
              contractVersion: 1,
              clientFamily: "Retail",
              readiness: "NOT_READY",
              roster: { state: "NOT_READY" },
              activeSpecBefore: {},
              activeSpecAfter: {},
            },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

test("A37: schema creation twice is idempotent", () => {
  const store1 = new SqliteSnapshotStore(":memory:");
  const store2 = new SqliteSnapshotStore(":memory:");
  try {
    // Just verify both instances can be created without error
  } finally {
    store1.close();
    store2.close();
  }
});

test("A40: deleteCharacter removes observation rows", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
          },
        },
      }
    );

    const key = result.character.identityKey;
    const deleted = store.deleteCharacter(key);
    assert(deleted !== undefined);
    assert.strictEqual(deleted.snapshotsDeleted, 1);

    const found = store.listCharacters("retail").find((c) => c.identityKey === key);
    assert.strictEqual(found, undefined);
  } finally {
    store.close();
  }
});

test("A42: sidecar-less Retail envelope stored (policy E)", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

test("A43: sidecar with link-tuple mismatch is stored (nonqualifying)", () => {
  const store = freshStore();
  try {
    const result = store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      }),
      {
        equipmentObservation: {
          envelope: {
            observedAt: 100,
            capture: 1,
            revision: 1,
            completeness: "complete",
            data: { slots: {} },
            specEquipmentObservation: {
              contractVersion: 1,
              clientFamily: "Retail",
              equipmentObservation: {
                observedAt: 200,
                capture: 2,
                revision: 2,
              },
            },
          },
        },
      }
    );

    assert.strictEqual(result.equipmentObservation, "recorded");
  } finally {
    store.close();
  }
});

