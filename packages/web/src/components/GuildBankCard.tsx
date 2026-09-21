import { formatAbsoluteTime } from "../format.ts";
import { EMPTY_ITEM_INFO, describeItemInfo, itemInfoSuffix, type ItemInfoLookup } from "../itemMetadata.ts";
import { describeGuildCapacity, describeGuildCaveats, describeGuildContents, describeGuildState, describeGuildTab } from "../guildBank.ts";
import { CARRIED_GUILD_NOTE, CARRIED_GUILD_TITLE, OPEN_SHARED_GUILD } from "../sharedStorage.ts";
import type { GuildBankSection } from "../types.ts";

const PREVIEW_ITEMS = 12;

/**
 * What THIS EXPORT carried about a guild's Guild Bank: historical evidence from one export,
 * shown on the character page. It is not the guild's state - that is the reconciled owner view
 * in Shared Storage (one card per guild however many exports carried it), which this card links to.
 * Guild storage is a different scope from the character bank and the Warband bank, so it is never
 * merged into either, nor into any total. All wording comes from guildBank.ts so UNKNOWN /
 * LAST_SEEN / INACCESSIBLE are never presented as current, empty, or known.
 */
export default function GuildBankCard({
  guild,
  onOpenSharedStorage,
  itemInfo = EMPTY_ITEM_INFO,
}: {
  guild: GuildBankSection;
  onOpenSharedStorage?: () => void;
  itemInfo?: ItemInfoLookup;
}) {
  const state = describeGuildState(guild.status);
  const capacity = describeGuildCapacity(guild);
  const caveats = describeGuildCaveats(guild);
  const unknown = guild.status.state === "UNKNOWN";
  return (
    <section className="detail-card">
      <h3>
        {CARRIED_GUILD_TITLE} <span className={`status-badge status-${guild.status.state.toLowerCase()}`}>{guild.status.state}</span>
      </h3>
      <p className="muted small">{CARRIED_GUILD_NOTE}</p>
      {!unknown && onOpenSharedStorage && (
        <button className="link-button" onClick={onOpenSharedStorage}>
          {OPEN_SHARED_GUILD}
        </button>
      )}

      <div>{state.headline}</div>
      {state.detail && <p className="muted small">{state.detail}</p>}

      {!unknown && (
        <dl>
          <dt>Guild</dt>
          <dd>{guild.guildName ?? "Unknown guild"}</dd>
          {guild.guildClubId && (
            <>
              <dt>Guild club ID</dt>
              <dd>{guild.guildClubId}</dd>
            </>
          )}
          <dt>Scope</dt>
          <dd>{guild.ownerScope}</dd>
          {guild.status.lastVisit !== undefined && (
            <>
              <dt>Last visit</dt>
              <dd>{formatAbsoluteTime(guild.status.lastVisit)}</dd>
            </>
          )}
        </dl>
      )}

      {!unknown && guild.tabs.length > 0 && (
        <>
          <div className="muted small">Tabs</div>
          <ul className="compact-list">
            {guild.tabs.map((tab, i) => {
              const d = describeGuildTab(tab);
              return (
                <li key={tab.id ?? `tab-${i}`}>
                  {tab.name ?? `Tab ${tab.id ?? "?"}`}{" "}
                  <span className={`status-badge status-${d.tone === "observed" ? "observed" : "unknown"}`}>{d.label}</span>
                  {d.detail && <div className="muted small">{d.detail}</div>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {capacity && <div className="muted small">{capacity}</div>}
      {!unknown && (
        <>
          <div className="muted small">{describeGuildContents(guild)}</div>
          <ul className="compact-list">
            {guild.items.slice(0, PREVIEW_ITEMS).map((item, i) => {
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
            {guild.items.length > PREVIEW_ITEMS && <li className="muted">+{guild.items.length - PREVIEW_ITEMS} more…</li>}
          </ul>
        </>
      )}
      {caveats.map((c) => (
        <p key={c} className="muted small">
          {c}
        </p>
      ))}
      {!unknown && guild.coverage && <p className="muted small">Coverage: {guild.coverage}</p>}
    </section>
  );
}
