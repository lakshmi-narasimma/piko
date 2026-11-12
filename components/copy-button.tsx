"use client";

import { useState } from "react";

/** Copies `value` to the clipboard and says "Copied" for two seconds. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      className="shrink-0 rounded-md border border-line px-3 py-2 text-sm hover:bg-surface disabled:opacity-60"
    >
      {copied ? "Copied" : "Copy"} <span className="sr-only">{label}</span>
    </button>
  );
}
