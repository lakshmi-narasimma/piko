import type { DirectoryListing } from "@/lib/directory";

const badge = "rounded-full border px-2 py-0.5 text-xs font-medium";

/** HTTP and MCP badges for a Listing's kind. */
export function KindBadges({ kind }: { kind: DirectoryListing["kind"] }) {
  return (
    <span className="flex gap-1.5">
      {kind !== "mcp" && <span className={`${badge} border-accent text-accent`}>HTTP</span>}
      {kind !== "http" && <span className={`${badge} border-brand text-brand`}>MCP</span>}
    </span>
  );
}

/** A Listing's 0-5 rating as stars and a number, or "Not rated yet". */
export function Rating({ rating }: { rating: string | null }) {
  if (rating === null) return <span className="text-sm text-muted">Not rated yet</span>;
  const value = Number(rating);
  const full = Math.round(value);
  return (
    <span className="flex items-center gap-1 text-sm">
      <span aria-hidden="true" className="text-amber-500">
        {"★".repeat(full)}
        <span className="text-line">{"★".repeat(5 - full)}</span>
      </span>
      <span>
        <span className="sr-only">Rated </span>
        {value.toFixed(1)}
        <span className="sr-only"> out of 5</span>
      </span>
    </span>
  );
}
