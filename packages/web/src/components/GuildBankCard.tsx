import { formatAbsoluteTime } from "../format.ts";
import { describeGuildCapacity, describeGuildCaveats, describeGuildContents, describeGuildState, describeGuildTab } from "../guildBank.ts";
import type { GuildBankSection } from "../types.ts";

const PREVIEW_ITEMS = 12;

/**
 * TRANSITIONAL Guild Bank display. Guild storage is shared by the whole guild and
 * is a different scope from the character bank and the Warband bank, so it gets
 * its own clearly labelled card and is never merged into either, nor into any total.
 * The final model (guild-scoped reconciliation across the characters that carry
 * this data) is deliberately not decided yet - this card only makes sure the
 * section, once parsed, is not silently invisible. All wording comes from
 * guildBank.ts so UNKNOWN / LAST_SEEN / INACCESSIBLE are never presented as
 * current, empty, or known.
 */
export default function GuildBankCard({ guild }: { guild: GuildBankSection }) {
  const state = describeGuildState(guild.status);
  const capacity = describeGuildCapacity(guild);
  const caveats = describeGuildCaveats(guild);
  const unknown = guild.status.state === "UNKNOWN";
  return (
    <section className="detail-card">
      <h3>
        Guild Bank (guild-scoped) <span className={`status-badge status-${guild.status.state.toLowerCase()}`}>{guild.status.state}</span>
      </h3>
      <p className="muted small">
        Shared storage owned by the guild, seen through this character's export. It is not this character's bank or the Warband Bank, and it is
        excluded from all totals, item search and AI context until guild-scope reconciliation is implemented.
      </p>

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
            {guild.items.slice(0, PREVIEW_ITEMS).map((item, i) => (
              <li key={i}>
                {item.name ?? item.itemRef ?? "?"} × {item.qty ?? "?"}
              </li>
            ))}
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
