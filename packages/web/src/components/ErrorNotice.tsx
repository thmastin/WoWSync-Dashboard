import { describeApiError } from "../api.ts";

/**
 * The one place a failed load is shown: what went wrong, in plain words, and
 * a Retry button. Used instead of leaving "Loading…" on screen forever or
 * rendering empty/zero data as if the request had succeeded.
 */
export default function ErrorNotice({ error, onRetry, onBack }: { error: unknown; onRetry?: () => void; onBack?: () => void }) {
  return (
    <div className="error-notice" role="alert">
      <div className="error-notice-message">{describeApiError(error)}</div>
      <div className="error-notice-actions">
        {onRetry && (
          <button className="secondary-button" onClick={onRetry}>
            Retry
          </button>
        )}
        {onBack && (
          <button className="secondary-button" onClick={onBack}>
            Back
          </button>
        )}
      </div>
    </div>
  );
}
