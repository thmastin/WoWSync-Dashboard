# GearExport 2c5e9b3 Classic SavedVariables fixtures

`WoWSync-classic-era.lua` and `WoWSync-tbc-anniversary.lua` are `WoWSyncDB` SavedVariables files produced by
the **unmodified GearExport collectors at commit `2c5e9b388215cd0446308cd95b23a976dced8035`**
(`feature/gearexport-launch-readiness`), executed headlessly under GearExport's own test harness with mocked
Classic client APIs (Lua 5.4). They are realistic in *shape* (every field, envelope, merge label, and the
WOWSYNC v1 text are the addon's own output) but the game values are synthetic.

They are automated fixtures, **not live client captures**.

Scenario: Torahn (Shaman 35, Horde) opens Blacksmithing (TradeSkill window: Copper Bracers, Rough Copper Vest,
Runed Copper Belt), then Enchanting (Craft window: Enchant Bracer - Minor Health `enchant:7418`, Enchant Chest -
Minor Mana `enchant:7443`), with a two-quest log, four completed quest IDs, three visible factions, and three
talent trees (0/21/9). Bags hold 3 Copper Bar and 2 Strange Dust; the bank is not observed.

Regenerate (GearExport is only read, never modified):

```sh
mkdir -p /tmp/ge && git -C ~/src/GearExport archive 2c5e9b3 | tar -x -C /tmp/ge
cp tools/fixtures/gen_classic_gearexport_fixture.lua /tmp/ge/
(cd /tmp/ge && lua5.4 gen_classic_gearexport_fixture.lua era /tmp/WoWSync-classic-era.lua \
  && lua5.4 gen_classic_gearexport_fixture.lua tbc /tmp/WoWSync-tbc-anniversary.lua)
```
