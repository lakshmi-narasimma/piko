"use client";

import { useActionState } from "react";
import { withdrawAction, type WithdrawState } from "./payout-actions";

/** Sends the whole-cent earnings balance to the seller's PayPal now. */
export function WithdrawButton({ disabled, label }: { disabled: boolean; label: string }) {
  const [state, action, pending] = useActionState<WithdrawState, FormData>(withdrawAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <button
        disabled={disabled || pending}
        className="rounded-md bg-brand px-3 py-2 text-sm text-brand-foreground hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Sending…" : label}
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
  );
}
