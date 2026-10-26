import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const POLESTAR_CODEX_FORMAT_SCHEMA = 1;
export type CodexKind = "item" | "mount" | "pet" | "recipe" | "tabard" | "npc" | "rare" | "object" | "treasure" | "quest" | "instance" | "zone" | "faction" | "spell";
export interface CodexRecord { kind: CodexKind; id: string; name?: string; title?: string; fields: string[]; sources?: Array<Record<string, unknown>>; [key: string]: unknown }
export interface CodexDataset { schema: number; build: string; records: CodexRecord[] }
export class UnsupportedCodexFormatError extends Error { readonly code = "UNSUPPORTED_FORMAT"; constructor(schema: unknown) { super(`UNSUPPORTED_FORMAT: Polestar Codex schema ${String(schema)} is not supported.`); } }

const groups = new Set<CodexKind>(["item", "mount", "pet", "recipe", "tabard", "npc", "rare", "object", "treasure", "quest", "instance", "zone", "faction", "spell"]);
const FROM: Record<string,string> = {a:"atlasloot",c:"client",d:"dungeons",f:"flbis",g:"guides",j:"journal",l:"recordings",p:"pfquest",q:"questie",r:"rarescanner",u:"curated",w:"wowhead",e:"forever"};
const SOURCE: Record<string,[string,string[]]> = {v:["vendor",["npc","cost","limited"]],d:["drop",["npc","chance","instance"]],o:["object",["object","chance"]],q:["quest",["quest","choice"]],g:["gift",["npc","spell"]],c:["craft",["spell","skillLine","skill"]],r:["rep",["faction","standing","npc"]],p:["pvp",["rank","npc"]],n:["container",["item","chance"]],w:["world",["minLevel","maxLevel"]]};
function split(s:string, sep:string):string[] { return s.split(sep); }
function decodeSource(s:string):Record<string,unknown>|undefined { const def=SOURCE[s[0]!]; if(!def)return; const out:Record<string,unknown>={type:def[0]}; const parts=s.slice(1).split(","); for(let i=0;i<def[1].length;i++){const k=def[1][i]!,v=parts[i];if(v){out[k]=k==="limited"||k==="choice"?v==="1":k==="instance"?decodeURIComponent(v.replace(/%([0-9a-f]{2})/gi,"%$1")):Number(v);}} out.provenance=(parts[def[1].length]??"").split("").map(x=>FROM[x]).filter(Boolean);return out; }
function decodeRecord(kind:CodexKind,id:string,name:string,s:string):CodexRecord {
 const f=split(s,";"); const r:CodexRecord={kind,id,name,fields:f};
 if(["item","mount","pet","recipe","tabard"].includes(kind)){r.quality=Number(f[0]?.replace(/[a-z]$/i,""))||undefined;r.requiredLevel=Number(f[1])||undefined;r.sources=f.slice(7).map(decodeSource).filter((x):x is Record<string,unknown>=>!!x);}
 else if(kind==="npc"||kind==="rare"){r.level=Number(f[0])||undefined;r.levelMax=Number(f[1])||undefined;r.faction=f[2]||undefined;r.instance=f[4]||undefined;r.roles=f[5]?f[5].split(","):[];r.loot=(f[6]||"").split(",").filter(Boolean).map(Number);r.spawns=f.slice(7).map(g=>{const p=g.split(",");const map=Number(p[0]);const coords:number[]=[];for(let i=2;i+1<p.length;i+=2)coords.push(Number(p[i])/10,Number(p[i+1])/10);return {map,faction:p[1]||undefined,coordinates:coords};});}
 else if(kind==="quest"){Object.assign(r,{level:Number(f[0])||undefined,minLevel:Number(f[1])||undefined,faction:f[2]||undefined,zone:Number(f[5])||undefined,startNpc:(f[6]||"").split(",").filter(Boolean).map(Number),endNpc:(f[9]||"").split(",").filter(Boolean).map(Number),prerequisites:(f[11]||"").split(",").filter(Boolean).map(Number),rewards:(f[12]||"").split(",").filter(Boolean).map(Number)});r.title=name;}
 else if(kind==="instance"){Object.assign(r,{instanceKind:f[0],areaId:Number(f[2])||undefined,map:Number(f[3])||undefined,levelRange:(f[5]||"").split(",").map(Number).filter(Number.isFinite),bosses:f.slice(6)});}
 return r;
}
function longStrings(src:string):string[]{const out:string[]=[];const re=/\[(=*)\[([\s\S]*?)\]\1\]/g;for(const m of src.matchAll(re))out.push(m[2]!);return out;}
function registrationCalls(src:string):Array<{kind:string;names:string;records?:string;lo?:number;hi?:number}>{
 const out=[] as Array<{kind:string;names:string;records?:string;lo?:number;hi?:number}>;const re=/Register\(\s*"([^"]+)"\s*,/g;
 for(const m of src.matchAll(re)){const tail=src.slice(m.index!+m[0].length);const args=longStrings(tail).slice(0,2);if(args.length<1)continue;const after=tail.slice(tail.indexOf("]]")+2);const nums=after.match(/^\s*,\s*(\d+)\s*,\s*(\d+)/);out.push({kind:m[1]!,names:args[0]!,...(args[1]!==undefined?{records:args[1]}:{}),...(nums?{lo:Number(nums[1]),hi:Number(nums[2])}:{})});}
 return out;
}
export function parsePolestarCodexFiles(files:Readonly<Record<string,string>>):CodexDataset {
 const metaSrc=files["Meta.lua"];if(!metaSrc)throw new TypeError("Polestar Codex Meta.lua is required.");const schemaMatch=metaSrc.match(/schema\s*=\s*(\d+)/);const build=metaSrc.match(/build\s*=\s*"([^"]+)"/)?.[1];const schema=schemaMatch?Number(schemaMatch[1]):NaN;if(schema!==POLESTAR_CODEX_FORMAT_SCHEMA)throw new UnsupportedCodexFormatError(Number.isFinite(schema)?schema:"missing");if(!build)throw new TypeError("Meta.lua has no Codex build.");const records:CodexRecord[]=[];
 for(const [filename,src] of Object.entries(files)){if(filename==="Meta.lua")continue;for(const call of registrationCalls(src)){if(!groups.has(call.kind as CodexKind)||!call.records)continue;const names=new Map<string,string>();for(const line of call.names.split("\n")){const p=line.split("\t");if(p.length>=3)names.set(p[0]!,p[2]!);}for(const line of call.records.split("\n")){const i=line.indexOf("\t");if(i<0)continue;const id=line.slice(0,i);const name=names.get(id);if(name!==undefined)records.push(decodeRecord(call.kind as CodexKind,id,name,line.slice(i+1)));}}
 }
 return {schema,build,records};
}
export function loadPolestarCodexDirectory(directory:string):CodexDataset { const files:Record<string,string>={};for(const filename of readdirSync(directory)){if(filename.endsWith(".lua"))files[filename]=readFileSync(path.join(directory,filename),"utf8");}return parsePolestarCodexFiles(files); }

export function importPolestarCodex(dbPath:string,dataset:CodexDataset):{build:string;records:number}{const db=new DatabaseSync(dbPath);try{db.exec(`CREATE TABLE IF NOT EXISTS reference_codex_builds(source TEXT NOT NULL, build TEXT NOT NULL, format_schema INTEGER NOT NULL, provenance TEXT NOT NULL CHECK(provenance='REFERENCE'), imported_at TEXT NOT NULL, PRIMARY KEY(source,build)); CREATE TABLE IF NOT EXISTS reference_codex_records(source TEXT NOT NULL, build TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, name TEXT, record_json TEXT NOT NULL, provenance TEXT NOT NULL CHECK(provenance='REFERENCE'), PRIMARY KEY(source,build,kind,record_id)); CREATE INDEX IF NOT EXISTS idx_reference_codex_name ON reference_codex_records(source,build,kind,name);`);db.exec("BEGIN IMMEDIATE");db.prepare("INSERT OR REPLACE INTO reference_codex_builds VALUES('polestar-codex',?,?, 'REFERENCE',?)").run(dataset.build,dataset.schema,new Date().toISOString());const put=db.prepare("INSERT OR REPLACE INTO reference_codex_records VALUES('polestar-codex',?,?,?,?,?,'REFERENCE')");db.prepare("DELETE FROM reference_codex_records WHERE source='polestar-codex' AND build=?").run(dataset.build);for(const r of dataset.records)put.run(dataset.build,r.kind,r.id,r.name??r.title??null,JSON.stringify(r));db.exec("COMMIT");return {build:dataset.build,records:dataset.records.length};}catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}finally{db.close();}}

export class PolestarCodexReadStore {
  private db: DatabaseSync;
  constructor(dbPath: string) { this.db = new DatabaseSync(dbPath, { readOnly: true }); }
  close() { this.db.close(); }
  lookup(kind: string, query: string | number): CodexRecord | undefined {
    try {
      const latest = "build=(SELECT build FROM reference_codex_builds WHERE source='polestar-codex' ORDER BY imported_at DESC LIMIT 1)";
      const row = typeof query === "number"
        ? this.db.prepare(`SELECT record_json FROM reference_codex_records WHERE source='polestar-codex' AND ${latest} AND kind=? AND record_id=? LIMIT 1`).get(kind, String(query))
        : this.db.prepare(`SELECT record_json FROM reference_codex_records WHERE source='polestar-codex' AND ${latest} AND kind=? AND name LIKE ? ESCAPE '\\' ORDER BY name=? DESC, length(name), record_id LIMIT 1`).get(kind, `%${String(query).replace(/[\\%_]/g, "\\$&")}%`, String(query));
      return row ? JSON.parse(String((row as { record_json: string }).record_json)) as CodexRecord : undefined;
    } catch { return undefined; }
  }
  list(kind: string): CodexRecord[] {
    try {
      const rows = this.db.prepare("SELECT record_json FROM reference_codex_records WHERE source='polestar-codex' AND build=(SELECT build FROM reference_codex_builds WHERE source='polestar-codex' ORDER BY imported_at DESC LIMIT 1) AND kind=? ORDER BY record_id").all(kind);
      return rows.map(x => JSON.parse(String((x as { record_json: string }).record_json)) as CodexRecord);
    } catch { return []; }
  }
  meta(): { build: string } | undefined {
    try { return this.db.prepare("SELECT build FROM reference_codex_builds WHERE source='polestar-codex' ORDER BY imported_at DESC LIMIT 1").get() as { build: string } | undefined; }
    catch { return undefined; }
  }
}
