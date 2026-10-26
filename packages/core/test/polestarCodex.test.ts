import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importPolestarCodex, parsePolestarCodexFiles, PolestarCodexReadStore, UnsupportedCodexFormatError } from "../src/polestarCodex.ts";

const fixture = (schema=1) => ({
  "Meta.lua": `C.Register("meta", { build = "fixture.1", schema = ${schema} })`,
  "Items1.lua": `C.Register("item", [[\n100\t\tFixture Blade]], [[\n100\t3;10;;;;;;v42,100,0,e;d84,2.5,Blackrock Depths,q7,1]], 100, 100)`,
  "Npcs1.lua": `C.Register("npc", [[\n42\t\tFixture Vendor]], [[\n42\t20;22;A;r;Blackrock Depths;vendor;100;0,,-123,456]], 42, 42)`,
});

test("parses schema 1 records and typed source values from a synthetic fixture", () => {
  const parsed=parsePolestarCodexFiles(fixture());
  assert.equal(parsed.build,"fixture.1");
  assert.equal(parsed.records.length,2);
  const item=parsed.records.find(x=>x.kind==="item")!;
  assert.equal(item.name,"Fixture Blade");
  assert.equal(item.requiredLevel,10);
  assert.deepEqual(item.sources?.map(s=>s.type),["vendor","drop"]);
  assert.equal(item.sources?.[0]?.npc,42);
  assert.deepEqual(item.sources?.[0]?.provenance,["forever"]);
  assert.equal(parsed.records.find(x=>x.kind==="npc")?.levelMax,22);
});

test("rejects unknown packed format schema explicitly", () => {
  assert.throws(()=>parsePolestarCodexFiles(fixture(999)),UnsupportedCodexFormatError);
});

test("imports and reads reference rows without involving character tables", () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),"wowsync-codex-"));const dbPath=path.join(dir,"test.sqlite");
  try {
    const db=new DatabaseSync(dbPath);db.exec("CREATE TABLE characters(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO characters(name) VALUES('Unchanged');");db.close();
    const data=parsePolestarCodexFiles(fixture());assert.deepEqual(importPolestarCodex(dbPath,data),{build:"fixture.1",records:2});
    const reader=new PolestarCodexReadStore(dbPath);try{assert.equal(reader.lookup("item",100)?.name,"Fixture Blade");assert.equal(reader.meta()?.build,"fixture.1");assert.equal(reader.list("npc").length,1);}finally{reader.close();}
    const check=new DatabaseSync(dbPath,{readOnly:true});try{assert.equal(check.prepare("SELECT COUNT(*) AS n FROM characters").get()?.n,1);assert.equal(check.prepare("SELECT DISTINCT provenance FROM reference_codex_records").get()?.provenance,"REFERENCE");}finally{check.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
