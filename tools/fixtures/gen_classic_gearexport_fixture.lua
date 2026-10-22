-- Dashboard test-fixture generator. Runs inside an extracted (git archive) GearExport tree; see
-- packages/core/test/fixtures/gearexport-2c5e9b3/README.md. GearExport itself is never modified.
-- Generates a real GearExport 2c5e9b3 WoWSyncDB SavedVariables file for a Classic Era or TBC character.
-- Usage: lua5.4 gen_classic_fixture.lua <era|tbc> <outfile>
local flavor, outfile = arg[1], arg[2]
local source = assert(io.open("tests/wowsync_test.lua")):read("a")
local cut = source:find('load("BankCleanup.lua", addon)', 1, true)
local prelude = source:sub(1, cut - 1) .. "\nreturn addon, function(v) seconds = v end, function() return seconds end, frames\n"
local savedArg = arg; arg = {}
local addon, setSeconds, getSeconds = assert(load(prelude, "prelude"))()
arg = savedArg
local era = flavor == "era"
WOW_PROJECT_ID = era and 2 or 5
GetBuildInfo = era and function() return "1.15.9", "69547", "", 11509 end or function() return "2.5.5", "68101", "", 20506 end
function GetRealmName() return era and "Nightslayer" or "Dreamscythe" end
local function loadAddon(path) assert(loadfile(path))("GearExport", addon) end
for _, file in ipairs({ "WoWSyncCore.lua", "WoWSyncCollectors.lua", "WoWSyncClassicRecipes.lua", "WoWSyncClassicProgression.lua", "WoWSyncRender.lua", "WoWSyncUI.lua" }) do loadAddon(file) end
local S = addon.Sync
local function event(name, a, b) S.eventFrame.scripts.OnEvent(S.eventFrame, name, a, b) end
local function advance(duration)
  for _ = 1, math.ceil(duration / 0.1) do
    setSeconds(getSeconds() + 0.1)
    if S.eventFrame.scripts.OnUpdate then S.eventFrame.scripts.OnUpdate() end
  end
end
-- Profession skill list: Blacksmithing + Enchanting.
GetNumSkillLines = function() return 3 end
GetSkillLineInfo = function(index)
  if index == 1 then return "Professions", true, true end
  if index == 2 then return "Blacksmithing", false, true, 120, 0, 0, 150, true end
  return "Enchanting", false, true, 60, 0, 0, 75, true
end
-- Bags hold 3 Copper Bars and 2 Strange Dust.
local copper = "|cffffffff|Hitem:2840::::::::35:::::::::|h[Copper Bar]|h|r"
local dust = "|cffffffff|Hitem:10940::::::::35:::::::::|h[Strange Dust]|h|r"
C_Container.GetContainerNumSlots = function(bag) return bag == 0 and 16 or 0 end
local bagItems = { [1] = { id = 2840, count = 3, link = copper }, [2] = { id = 10940, count = 2, link = dust } }
C_Container.GetContainerItemInfo = function(bag, slot)
  local item = bag == 0 and bagItems[slot]
  if not item then return nil end
  return { hyperlink = item.link, itemID = item.id, stackCount = item.count, isLocked = false, isBound = false }
end
C_Container.GetContainerItemLink = function(bag, slot) local item = bag == 0 and bagItems[slot]; return item and item.link end
C_Container.GetContainerNumFreeSlots = function(bag) return bag == 0 and 14 or 0, 0 end
GetContainerNumSlots, GetContainerNumFreeSlots = C_Container.GetContainerNumSlots, C_Container.GetContainerNumFreeSlots
GetContainerItemLink = C_Container.GetContainerItemLink
function GetContainerItemInfo(bag, slot)
  local info = C_Container.GetContainerItemInfo(bag, slot)
  if info then return 1, info.stackCount, info.isLocked, 1, false, false, info.hyperlink end
end
GetItemInfo = function(reference)
  local id = type(reference) == "number" and reference or tonumber(tostring(reference):match("item:(%d+)"))
  local names = { [2840] = "Copper Bar", [10940] = "Strange Dust", [2853] = "Copper Bracers", [10421] = "Rough Copper Vest", [2857] = "Runed Copper Belt", [100] = "Sample" }
  return names[id] or "Sample", type(reference) == "string" and reference or ("|Hitem:" .. tostring(id) .. "|h[x]|h"), 1, 5, 1, "Trade Goods", "Metal & Stone", 20, "", 1, 1, 7, 0, 1
end
-- TradeSkill (Blacksmithing): one collapsed category keeps coverage partial.
local trade = {
  { "Armor", "header" },
  { "Copper Bracers", "trivial", 1, "|cffffffff|Hitem:2853::::::::35:::::::::|h[Copper Bracers]|h|r", copper, 2 },
  { "Rough Copper Vest", "easy", 0, "|cffffffff|Hitem:10421::::::::35:::::::::|h[Rough Copper Vest]|h|r", copper, 4 },
  { "Runed Copper Belt", "medium", 0, "|cff1eff00|Hitem:2857::::::::35:::::::::|h[Runed Copper Belt]|h|r", copper, 10 },
}
IsTradeSkillLinked = function() return nil end
GetTradeSkillLine = function() return "Blacksmithing", 120, 150, 0 end
GetNumTradeSkills = function() return #trade end
GetTradeSkillInfo = function(index) local row = trade[index]; return row and row[1], row and row[2], row and row[3] end
GetTradeSkillItemLink = function(index) return trade[index] and trade[index][4] end
GetTradeSkillNumReagents = function(index) return index == 1 and 0 or 1 end
GetTradeSkillReagentInfo = function(index) return "Copper Bar", "icon", trade[index][6], 3 end
GetTradeSkillReagentItemLink = function(index) return trade[index][5] end
GetTradeSkillNumMade = function() return 1, 1 end
GetTradeSkillRecipeLink = nil
-- Craft (Enchanting): visible rows; the Craft API does not establish learned state.
local craft = {
  { "Enchant Bracer - Minor Health", nil, "easy", 2, nil, nil, nil, nil, "|cffffffff|Henchant:7418|h[Enchant Bracer - Minor Health]|h|r", 1 },
  { "Enchant Chest - Minor Mana", nil, "trivial", 2, nil, nil, nil, nil, "|cffffffff|Henchant:7443|h[Enchant Chest - Minor Mana]|h|r", 1 },
}
GetCraftDisplaySkillLine = function() return "Enchanting", 60, 75 end
GetNumCrafts = function() return #craft end
GetCraftInfo = function(index) local r = craft[index]; if r then return r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8] end end
GetCraftItemLink = function(index) return craft[index] and craft[index][9] end
GetCraftNumReagents = function() return 1 end
GetCraftReagentInfo = function(index) return "Strange Dust", "icon", craft[index][10], 2 end
GetCraftReagentItemLink = function() return dust end
-- Quest log: two active quests, one complete; completed history.
local quests = {
  { "The Barrens", nil, nil, true, false },
  { "Plainstrider Menace", 12, 0, false, false, nil, 0, 844 },
  { "Raptor Thieves", 13, 0, false, false, 1, 0, 869 },
}
local objectives = { [2] = { { "Plainstrider Beak: 4/7", "item", false } }, [3] = { { "Raptor Head: 12/12", "item", true } } }
GetNumQuestLogEntries = function() return #quests, 2 end
GetQuestLogTitle = function(index) local r = quests[index]; if r then return r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8] end end
GetNumQuestLeaderBoards = function(index) return objectives[index] and #objectives[index] or 0 end
GetQuestLogLeaderBoard = function(objective, index) local r = objectives[index] and objectives[index][objective]; if r then return r[1], r[2], r[3] end end
GetQuestsCompleted = function() return { [840] = true, [842] = true, [870] = true, [871] = true } end
-- Reputation: one header, three visible rows.
local factions = {
  { "Horde", "", 0, 0, 0, 0, false, false, true, false, false, false, false, 67 },
  { "Orgrimmar", "", 5, 3000, 9000, 6100, false, false, false, false, true, true, true, 76 },
  { "Thunder Bluff", "", 6, 9000, 21000, 9800, false, false, false, false, true, false, true, 81 },
  { "Booty Bay", "", 4, 0, 3000, 250, false, true, false, false, true, false, false, 21 },
}
GetNumFactions = function() return #factions end
GetFactionInfo = function(index) local r = factions[index]; if r then return table.unpack(r) end end
-- Talents: three trees.
local trees = { { "Elemental", 0, {} }, { "Enhancement", 21, { { "Ancestral Knowledge", 1, 2, 5, 5 }, { "Shield Specialization", 1, 3, 0, 5 }, { "Flurry", 3, 2, 5, 5 } } }, { "Restoration", 9, { { "Improved Healing Wave", 1, 2, 5, 5 }, { "Tidal Focus", 1, 3, 4, 5 } } } }
GetNumTalentTabs = function() return #trees end
GetTalentTabInfo = function(tab) local t = trees[tab]; return t[1], "icon", t[2] end
GetNumTalents = function(tab) return #trees[tab][3] end
GetTalentInfo = function(tab, index) local r = trees[tab][3][index]; return r[1], "icon", r[2], r[3], r[4], r[5] end

event("ADDON_LOADED", "GearExport"); event("PLAYER_LOGIN"); advance(1)
event("TRADE_SKILL_SHOW"); advance(1); event("TRADE_SKILL_CLOSE")
event("CRAFT_SHOW"); advance(1); event("CRAFT_CLOSE")
event("QUEST_LOG_UPDATE"); event("UPDATE_FACTION"); advance(1)
S.Mark("talents"); advance(1)
local exported
assert(S.Export(function(text) exported = text end))
advance(5)
assert(exported, "export rendered")

local function key(k) return type(k) == "string" and string.format("[%q]", k) or "[" .. tostring(k) .. "]" end
local function emit(value, indent, out)
  local t = type(value)
  if t == "table" then
    out[#out + 1] = "{\n"
    local keys = {}
    for k in pairs(value) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) if type(a) == type(b) then return a < b end return type(a) == "number" end)
    for _, k in ipairs(keys) do
      out[#out + 1] = indent .. "\t" .. key(k) .. " = "
      emit(value[k], indent .. "\t", out)
      out[#out + 1] = ",\n"
    end
    out[#out + 1] = indent .. "}"
  elseif t == "string" then out[#out + 1] = string.format("%q", value):gsub("\\\n", "\\n")
  elseif t == "number" then out[#out + 1] = (math.type and math.type(value) == "integer") and tostring(value) or string.format("%.17g", value)
  else out[#out + 1] = tostring(value) end
end
local out = { "\nWoWSyncDB = " }
emit(WoWSyncDB, "", out)
out[#out + 1] = "\n"
local f = assert(io.open(outfile, "w")); f:write(table.concat(out)); f:close()
print("wrote " .. outfile)
