import { useEffect, useRef } from "react";

/** Which focusable element receives focus after Tab (or Shift+Tab) inside a dialog: it wraps at both ends, and an outside focus enters at the edge. Pure so it can be tested. */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for a modal dialog: Escape closes it (unless `closable` is false, e.g. while a request is
 * in flight), Tab / Shift+Tab stay inside it, and focus returns to what had it before the dialog opened.
 * Initial focus is left to the element carrying `autoFocus` (the safe/Cancel button).
 */
export function useDialogBehavior(onClose: () => void, closable: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, closable });
  latest.current = { onClose, closable };
  // What had focus BEFORE the dialog opened, read during the first render: by the time an effect runs,
  // `autoFocus` has already moved focus into the dialog, so an effect would only "remember" the Cancel button.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const before = opener.current;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (latest.current.closable) {
          event.stopPropagation();
          latest.current.onClose();
        }
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      event.preventDefault();
      focusable[nextFocusIndex(focusable.length, focusable.indexOf(document.activeElement as HTMLElement), event.shiftKey)].focus();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);

  return ref;
}
