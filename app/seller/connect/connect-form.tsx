"use client";

import { startTransition, useActionState, useRef, useState, type FormEvent } from "react";
import { CopyButton } from "@/components/copy-button";
import { connectApi } from "./actions";
import type { ConnectedListing, ConnectState } from "./connect";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
// The same limits as lib/listings (MAX_ENDPOINTS, MAX_DESCRIPTION_LENGTH), which the server
// enforces; this client bundle doesn't import it, since it pulls in the database.
const MAX_ENDPOINTS = 50;
const MAX_DESCRIPTION = 500;

const input =
  "w-full rounded-md border border-line bg-transparent px-3 py-2 aria-[invalid=true]:border-red-600";
const button =
  "rounded-md border border-line px-3 py-2 text-sm hover:bg-surface disabled:opacity-60";
const errorText = "text-sm text-red-700 dark:text-red-400";

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className={errorText}>
      {message}
    </p>
  ) : null;
}

export function ConnectForm({ demoBaseUrl }: { demoBaseUrl: string }) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(connectApi, {});
  // Each row's stable id, so removing one keeps the others' typed values.
  const nextId = useRef(1);
  const [rows, setRows] = useState<number[]>([0]);
  // The rows as they were when the form was sent, so a row's errors stay with that row.
  const [sentRows, setSentRows] = useState<number[]>([]);
  const [description, setDescription] = useState("");

  if (state.listing) return <Connected listing={state.listing} />;

  // Called directly rather than through <form action>, so a refused form keeps what was typed.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSentRows(rows);
    startTransition(() => action(form));
  }

  const errors = state.fieldErrors ?? {};
  const rowError = (rowId: number, field: string) => {
    const sent = sentRows.indexOf(rowId);
    return sent < 0 ? undefined : errors[`endpoints.${sent}.${field}`];
  };
  const invalid = (message?: string) => (message ? true : undefined);

  return (
    <form onSubmit={submit} noValidate className="flex w-full flex-col gap-6">
      {state.error && (
        <p role="alert" className={`rounded-md border border-red-600/40 p-3 ${errorText}`}>
          {state.error}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="baseUrl" className="text-sm font-medium">
          Base URL
        </label>
        <input
          id="baseUrl"
          name="baseUrl"
          type="url"
          inputMode="url"
          required
          placeholder={demoBaseUrl}
          aria-invalid={invalid(errors.baseUrl)}
          aria-describedby="baseUrl-hint baseUrl-error"
          className={input}
        />
        <p id="baseUrl-hint" className="text-sm text-muted">
          Public http or https, port 80 or 443. Buyers never see it: they call the gateway URL.
        </p>
        <FieldError id="baseUrl-error" message={errors.baseUrl} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            required
            maxLength={120}
            placeholder="Price History"
            aria-invalid={invalid(errors.name)}
            aria-describedby="name-error"
            className={input}
          />
          <FieldError id="name-error" message={errors.name} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="category" className="text-sm font-medium">
            Category <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="category"
            name="category"
            maxLength={60}
            placeholder="shopping"
            aria-invalid={invalid(errors.category)}
            aria-describedby="category-error"
            className={input}
          />
          <FieldError id="category-error" message={errors.category} />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="description" className="text-sm font-medium">
          Description
        </label>
        <textarea
          id="description"
          name="description"
          required
          rows={3}
          maxLength={MAX_DESCRIPTION}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What it does, in a sentence or two. Buyers' agents read this."
          aria-invalid={invalid(errors.description)}
          aria-describedby="description-count description-error"
          className={input}
        />
        <p id="description-count" className="text-sm text-muted">
          {description.length}/{MAX_DESCRIPTION}
        </p>
        <FieldError id="description-error" message={errors.description} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="kind" className="text-sm font-medium">
          Kind
        </label>
        <select
          id="kind"
          name="kind"
          defaultValue="http"
          aria-describedby="kind-error"
          className={`${input} sm:w-60`}
        >
          <option value="http">HTTP</option>
          <option value="mcp">MCP</option>
          <option value="both">HTTP and MCP</option>
        </select>
        <FieldError id="kind-error" message={errors.kind} />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-lg font-medium">Endpoints and prices</legend>
        <p className="text-sm text-muted">
          Price per Call in dollars, $0 to $100. Free calls are given to each buyer before the price
          applies.
        </p>
        <FieldError id="endpoints-error" message={errors.endpoints} />
        <ol className="flex flex-col gap-3">
          {rows.map((rowId, i) => {
            const n = i + 1;
            const pathError = rowError(rowId, "path");
            const methodError = rowError(rowId, "method");
            const priceError = rowError(rowId, "price");
            const quotaError = rowError(rowId, "freeQuota");
            const id = (field: string) => `endpoint-${rowId}-${field}`;
            return (
              <li
                key={rowId}
                className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 sm:grid-cols-[7rem_1fr_8rem_7rem_auto] sm:items-start"
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor={id("method")} className="text-sm text-muted">
                    Method <span className="sr-only">for endpoint {n}</span>
                  </label>
                  <select
                    id={id("method")}
                    name={`endpoints.${i}.method`}
                    defaultValue="GET"
                    aria-invalid={invalid(methodError)}
                    aria-describedby={id("method-error")}
                    className={input}
                  >
                    {METHODS.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                  <FieldError id={id("method-error")} message={methodError} />
                </div>
                <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
                  <label htmlFor={id("path")} className="text-sm text-muted">
                    Path <span className="sr-only">for endpoint {n}</span>
                  </label>
                  <input
                    id={id("path")}
                    name={`endpoints.${i}.path`}
                    required
                    placeholder="/history"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={invalid(pathError)}
                    aria-describedby={id("path-error")}
                    className={input}
                  />
                  <FieldError id={id("path-error")} message={pathError} />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={id("price")} className="text-sm text-muted">
                    Price ($) <span className="sr-only">for endpoint {n}</span>
                  </label>
                  <input
                    id={id("price")}
                    name={`endpoints.${i}.price`}
                    required
                    inputMode="decimal"
                    placeholder="0.002"
                    aria-invalid={invalid(priceError)}
                    aria-describedby={id("price-error")}
                    className={input}
                  />
                  <FieldError id={id("price-error")} message={priceError} />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={id("freeQuota")} className="text-sm text-muted">
                    Free calls <span className="sr-only">for endpoint {n}</span>
                  </label>
                  <input
                    id={id("freeQuota")}
                    name={`endpoints.${i}.freeQuota`}
                    inputMode="numeric"
                    placeholder="0"
                    aria-invalid={invalid(quotaError)}
                    aria-describedby={id("freeQuota-error")}
                    className={input}
                  />
                  <FieldError id={id("freeQuota-error")} message={quotaError} />
                </div>
                <div className="flex items-end sm:h-full sm:pt-6">
                  <button
                    type="button"
                    disabled={rows.length === 1}
                    onClick={() => setRows(rows.filter((r) => r !== rowId))}
                    className={button}
                  >
                    Remove <span className="sr-only">endpoint {n}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        <div>
          <button
            type="button"
            disabled={rows.length >= MAX_ENDPOINTS}
            onClick={() => setRows([...rows, nextId.current++])}
            className={button}
          >
            Add an endpoint
          </button>
          {rows.length >= MAX_ENDPOINTS && (
            <span className="ml-3 text-sm text-muted">{MAX_ENDPOINTS} is the most.</span>
          )}
        </div>
      </fieldset>

      <div>
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-brand px-4 py-2 text-brand-foreground disabled:opacity-60 sm:w-auto"
        >
          {pending ? "Publishing…" : "Publish"}
        </button>
      </div>
    </form>
  );
}

function Connected({ listing }: { listing: ConnectedListing }) {
  return (
    <section role="status" className="flex w-full flex-col gap-4 rounded-xl border border-line p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-medium">{listing.name} is live</h2>
        <p className="text-sm text-muted">
          Buyers&rsquo; agents call these gateway URLs. An unpaid call gets a 402 with the price.
        </p>
        {!listing.embedded && (
          <p className="text-sm text-muted">
            Search indexing pending: the Directory adds it on its next search.
          </p>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {listing.endpoints.map((e) => (
          <li key={e.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm">
                <span className="font-medium">{e.method}</span> {e.path} ·{" "}
                <span className="tabular-nums">{e.price}</span> per Call
                {e.freeQuota > 0 && ` · ${e.freeQuota} free`}
              </span>
              <code className="break-all text-sm">{e.gatewayUrl}</code>
            </div>
            <CopyButton value={e.gatewayUrl} label={`gateway URL for ${e.method} ${e.path}`} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        {/* A full page load, so the form starts empty again. */}
        <a href="/seller/connect" className={button}>
          Connect another API
        </a>
        <a href="/seller" className={button}>
          Back to the console
        </a>
      </div>
    </section>
  );
}
