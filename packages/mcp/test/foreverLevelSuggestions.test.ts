import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestForeverForLevel } from "../src/foreverLevelSuggestions.ts";
import type { CodexRecord } from "@wowsync-dashboard/core/polestarCodex.ts";

const rec=(kind:string,id:string,name:string,fields:Record<string,unknown>):CodexRecord=>({kind:kind as any,id,name,fields:[],...fields});
test("level suggestions include ranked reachable 5-player dungeons, useful drops/rewards and stay compact",()=>{
  const instances=[
    rec("instance","1","Excavation Site: Wetlands",{instanceKind:"zone",areaId:1,levelRange:[14,18]}),
    rec("instance","2","Ruins of Lordaeron",{instanceKind:"battleground",areaId:2,levelRange:[10,20]}),
    rec("instance","3","Ragefire Chasm",{instanceKind:"Dungeon",areaId:3,levelRange:[13,18],faction:"Horde"}),
    rec("instance","4","The Deadmines",{instanceKind:"Dungeon",areaId:4,levelRange:[15,26]}),
    rec("instance","5","Shadowfang Keep",{instanceKind:"Dungeon",areaId:5,levelRange:[18,25]}),
  ];
  const quests=[rec("quest","q1","Deadmines Quest",{zone:4,level:15,startNpc:[9],objectives:"Defeat the Deadmines crew"}),rec("quest","q2","Wetlands quest",{zone:1,startNpc:[8]}),rec("quest","q3","Inferred Deadmines Quest",{zone:99,level:15,startNpc:[10],objectives:"Explore the Deadmines"}),rec("quest","q4","Unlinked quest",{startNpc:[11]})];
  const items=[rec("item","100","Quest reward",{requiredLevel:15,sources:[{type:"quest",quest: "q1",minLevel:15,maxLevel:17}]}),rec("item","101","Useful drop",{requiredLevel:14,sources:[{type:"drop",npc:9,minLevel:14,maxLevel:16}]}),...Array.from({length:30},(_,i)=>rec("item",String(i+200),`Filler ${i}`,{requiredLevel:15,sources:[{type:"vendor",npc:1,minLevel:15}]}))];
  const data=suggestForeverForLevel(15,"Alliance",instances,quests,items,[rec("npc","9","Quest Giver",{})]);
  const dungeons=data.dungeons as Array<any>;
  assert.deepEqual(dungeons.map(d=>d.name),["The Deadmines"]);
  assert.equal(dungeons[0].questCount,2);
  assert.equal(dungeons[0].questGivers[0].name,"Quest Giver");
  assert.equal(dungeons[0].questGivers.find((giver:any)=>giver.id===10).linkProvenance,"DERIVED");
  assert.deepEqual((data.notableSources as Array<any>).map(x=>x.name),["Quest reward","Useful drop"]);
  assert.ok(JSON.stringify(data).length<10_000);
});

test("dungeon ranking uses distance from the range midpoint",()=>{
  const data=suggestForeverForLevel(15,"Alliance",[
    rec("instance","1","Farther",{instanceKind:"Dungeon",levelRange:[10,22]}),
    rec("instance","2","Closer",{instanceKind:"Dungeon",levelRange:[14,16]}),
  ],[],[],[]);
  assert.equal((data.dungeons as any[])[0].name,"Closer");
});
