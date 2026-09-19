import { useEffect, useState } from "react";
import { fetchAccountContext } from "../api.ts";
import { formatAbsoluteTime } from "../format.ts";
import type { AccountContext } from "../types.ts";

const DOWNLOAD_FILENAME = "wowsync-account-context.json";

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function DeveloperExportModal({ onClose }: { onClose: () => void }) {
  const [context, setContext] = useState<AccountContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetchAccountContext()
      .then(setContext)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function handleCopy() {
    if (!context) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
      setStatus("Account context copied.");
    } catch {
      setStatus("Couldn't access the clipboard — try Download instead.");
    }
  }

  function handleDownload() {
    if (!context) return;
    downloadJson(context, DOWNLOAD_FILENAME);
    setStatus(`Downloaded ${DOWNLOAD_FILENAME}.`);
  }

  const versionEntries = context ? Object.entries(context.versions) : [];
  const totalCharacters = versionEntries.reduce((sum, [, v]) => sum + v.characters.length, 0);
  const jsonSize = context ? JSON.stringify(context).length : 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Export Dashboard Context</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="modal-hint">
          A complete, deterministic snapshot of everything the dashboard currently knows — every WoW
          version, characters, economy, professions, inventory, snapshot history, and trainer summaries — as
          JSON, for pasting into an external LLM conversation. This is <strong>local-only</strong>: nothing is
          sent anywhere by this dashboard. You choose what to do with the copied/downloaded file.
        </p>

        {error && <div className="import-error">{error}</div>}

        {!context && !error && <div className="loading">Loading…</div>}

        {context && (
          <>
            <div className="import-fact-block">
              <div className="import-fact-title">Contents</div>
              <ul className="import-fact-list">
                <li>Generated: {formatAbsoluteTime(context.generatedAt)}</li>
                <li>Schema version: {context.schemaVersion}</li>
                <li>{totalCharacters} character(s) across {versionEntries.length} version(s)</li>
                {versionEntries.map(([version, v]) => (
                  <li key={version} className="muted small">
                    {version} — {v.aggregationScope} — {v.characters.length} character(s)
                  </li>
                ))}
                <li className="muted small">~{Math.round(jsonSize / 1024)} KB as JSON</li>
              </ul>
            </div>

            <div className="modal-actions">
              <button className="secondary-button" onClick={handleDownload}>
                Download JSON
              </button>
              <button className="primary-button" onClick={handleCopy}>
                Copy Account Context
              </button>
            </div>
            {status && <div className="muted small" style={{ marginTop: 8, textAlign: "right" }}>{status}</div>}
          </>
        )}
      </div>
    </div>
  );
}
