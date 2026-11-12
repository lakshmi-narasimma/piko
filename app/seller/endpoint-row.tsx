"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/copy-button";
import { saveEndpoint } from "./actions";

export interface EndpointRowProps {
  id: string;
  method: string;
  path: string;
  /** Display form, "$0.002". */
  price: string;
  freeQuota: number;
  gatewayUrl: string | null;
  canEdit: boolean;
}

const input =
  "w-28 rounded-md border border-line bg-transparent px-2 py-1 text-sm tabular-nums aria-[invalid=true]:border-red-600";
const errorText = "text-sm text-red-700 dark:text-red-400";

/** One Endpoint on the Seller console: its route, gateway URL and, for an admin, a price editor. */
export function EndpointRow(props: EndpointRowProps) {
  const [state, action, pending] = useActionState(saveEndpoint, {});
  const label = `${props.method} ${props.path}`;
  const priceId = `price-${props.id}`;
  const quotaId = `quota-${props.id}`;
  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm">
            <span className="font-medium">{props.method}</span> {props.path} ·{" "}
            <span className="tabular-nums">{props.price}</span> per Call
            {props.freeQuota > 0 && ` · ${props.freeQuota} free per buyer`}
          </span>
          {props.gatewayUrl ? (
            <code className="break-all text-sm text-muted">{props.gatewayUrl}</code>
          ) : (
            <span className="text-sm text-muted">MCP tool</span>
          )}
        </div>
        {props.gatewayUrl && (
          <CopyButton value={props.gatewayUrl} label={`gateway URL for ${label}`} />
        )}
      </div>
      {props.canEdit && (
        <form action={action} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="endpointId" value={props.id} />
          <label htmlFor={priceId} className="flex flex-col gap-1 text-sm">
            Price per Call ($)
            <input
              id={priceId}
              name="price"
              inputMode="decimal"
              defaultValue={props.price.replace(/^\$/, "")}
              aria-invalid={Boolean(state.fieldErrors?.price)}
              className={input}
              required
            />
          </label>
          <label htmlFor={quotaId} className="flex flex-col gap-1 text-sm">
            Free calls per buyer
            <input
              id={quotaId}
              name="freeQuota"
              inputMode="numeric"
              defaultValue={String(props.freeQuota)}
              aria-invalid={Boolean(state.fieldErrors?.freeQuota)}
              className={input}
            />
          </label>
          <button
            disabled={pending}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save"} <span className="sr-only">{label}</span>
          </button>
          <p aria-live="polite" className="w-full text-sm">
            {state.saved && (
              <span className="text-muted">
                Saved. The next 402 asks {state.saved.price}; Challenges already issued keep their
                price.
              </span>
            )}
            {state.error && <span className={errorText}>{state.error}</span>}
          </p>
          {state.fieldErrors?.price && <p className={errorText}>{state.fieldErrors.price}</p>}
          {state.fieldErrors?.freeQuota && (
            <p className={errorText}>{state.fieldErrors.freeQuota}</p>
          )}
        </form>
      )}
    </li>
  );
}
