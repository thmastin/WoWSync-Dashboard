import { useState } from "react";
import { importExport } from "../api.ts";
import { formatCopper, formatCopperDelta, formatPlaytime } from "../format.ts";
import type { ImportResult } from "../types.ts";
import { VERSION_LABELS } from "../versions.ts";

export default function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function handleImport() {
    setBusy(true);
    setError(null);
    try {
      const { result } = await importExport(text);
      setResult(result);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleFile(file: File) {
    file.text().then(setText);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import WoWSync</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {!result && (
          <>
            <p className="modal-hint">
              Paste a WOWSYNC v1 export (copy from <code>WOWSYNC v1</code> through <code>[END]</code> in-game), or
              drop a <code>.txt</code> file below.
            </p>
            <textarea
              className="import-textarea"
              placeholder="WOWSYNC v1&#10;Generated: ...&#10;..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) handleFile(file);
              }}
              rows={14}
            />
            <div className="modal-actions">
              <label className="file-drop">
                Choose file…
                <input
                  type="file"
                  accept=".txt"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                  }}
                />
              </label>
              <button className="primary-button" onClick={handleImport} disabled={busy || text.trim().length === 0}>
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
            {error && <div className="import-error">{error}</div>}
          </>
        )}

        {result && (
          <div className="import-result">
            <p>
              Imported <strong>{result.character.name}</strong>
              <br />
              <span className="muted">{VERSION_LABELS[result.character.version]}</span>
            </p>
            <div className="import-fact-block">
              <div className="import-fact-title">Snapshot</div>
              <ul className="import-fact-list">
                <li>Level {result.snapshot.parsed.character.level ?? "?"}</li>
                <li>Gold {formatCopper(result.snapshot.parsed.character.moneyCopper)}</li>
                <li>/played {formatPlaytime(result.snapshot.parsed.character.playedSeconds)}</li>
              </ul>
            </div>
            {result.isFirstSnapshot ? (
              <p className="muted">This is the first snapshot for this character — no history to compare yet.</p>
            ) : (
              <div className="import-fact-block">
                <div className="import-fact-title">Changes since previous snapshot</div>
                <ul className="import-fact-list">
                  {result.diff?.level.delta ? <li>Level {result.diff.level.delta > 0 ? "+" : ""}{result.diff.level.delta}</li> : null}
                  {result.diff?.xp.delta ? <li>XP {result.diff.xp.delta > 0 ? "+" : ""}{result.diff.xp.delta}</li> : null}
                  {result.diff?.moneyCopper.delta ? <li>Gold {formatCopperDelta(result.diff.moneyCopper.delta)}</li> : null}
                  {result.diff?.playedSeconds.delta ? <li>/played +{formatPlaytime(result.diff.playedSeconds.delta)}</li> : null}
                  {result.diff?.location.changed ? (
                    <li>
                      Location {result.diff.location.fromZone ?? "?"} → {result.diff.location.toZone ?? "?"}
                    </li>
                  ) : null}
                  {result.diff?.professions.map((p) => (
                    <li key={p.name}>
                      {p.name} {p.skill.delta ? (p.skill.delta > 0 ? "+" : "") + p.skill.delta : "unchanged"}
                    </li>
                  ))}
                  {result.diff && result.diff.equipment.length > 0 && <li>Equipment: {result.diff.equipment.length} slot(s) changed</li>}
                  {result.diff && result.diff.bagsItems.length > 0 && <li>Bags: {result.diff.bagsItems.length} item(s) changed</li>}
                  {result.diff && result.diff.bankItems.length > 0 && <li>Bank: {result.diff.bankItems.length} item(s) changed</li>}
                  {result.diff &&
                    !result.diff.level.delta &&
                    !result.diff.moneyCopper.delta &&
                    !result.diff.location.changed &&
                    result.diff.professions.length === 0 &&
                    result.diff.bagsItems.length === 0 &&
                    result.diff.bankItems.length === 0 &&
                    result.diff.equipment.length === 0 && <li className="muted">No changes detected.</li>}
                </ul>
              </div>
            )}
            <div className="modal-actions">
              <button className="primary-button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
