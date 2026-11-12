"use client";

import { useEffect, useState } from "react";

/** Copies `value` to the clipboard and says so for a moment, to sighted and screen-reader users. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // No clipboard (an insecure origin, or permission refused): the URL is still on screen to select.
      setState("failed");
    }
  }

  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
      >
        {text}
      </button>
      <span role="status" className="sr-only">
        {state === "idle" ? "" : text}
      </span>
    </>
  );
}
