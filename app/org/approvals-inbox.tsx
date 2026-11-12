"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";
import { decideApprovalAction } from "./approvals-actions";

export interface InboxItem {
  id: string;
  agent: string;
  listing: string;
  path: string;
  amount: string;
  createdAt: string;
}

const button =
  "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60";
const danger =
  "rounded-md border border-red-700 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-950";

function ApprovalRow({ item }: { item: InboxItem }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(decideApprovalAction, {});
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">
          <code>{item.agent}</code> wants to pay <span className="tabular-nums">{item.amount}</span>
        </span>
        <span className="text-sm text-muted">
          {item.listing} <code>{item.path}</code> · asked{" "}
          {new Date(item.createdAt).toLocaleTimeString()}
        </span>
      </div>
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={item.id} />
        <button
          name="decision"
          value="approved"
          disabled={pending}
          className={button}
          aria-label={`Approve ${item.amount} for ${item.agent}`}
        >
          Approve
        </button>
        <button
          name="decision"
          value="denied"
          disabled={pending}
          className={danger}
          aria-label={`Deny ${item.amount} for ${item.agent}`}
        >
          Deny
        </button>
        {state.error && (
          <span role="alert" className="text-sm text-red-700 dark:text-red-400">
            {state.error}
          </span>
        )}
        {state.message && (
          <span role="status" className="text-sm text-muted">
            {state.message}
          </span>
        )}
      </form>
    </li>
  );
}

/** Payments waiting for an admin, oldest first. */
export function ApprovalsInbox({ items }: { items: InboxItem[] }) {
  return (
    <section
      id="approvals"
      aria-label="Approvals"
      className="flex flex-col gap-3 rounded-xl border border-line"
    >
      <h2 className="px-4 pt-4 text-xl font-medium">
        Approvals{items.length > 0 && <span className="text-muted"> ({items.length} waiting)</span>}
      </h2>
      {items.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted">
          No payments are waiting. A policy&apos;s &ldquo;approval above&rdquo; rule sends them
          here.
        </p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {items.map((item) => (
            <ApprovalRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
