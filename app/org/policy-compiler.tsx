"use client";

import { useActionState, useState } from "react";
import { compilePolicyAction, confirmPolicyAction, type CompileState } from "./policy-actions";

const MAX_LENGTH = 500;
const button =
  "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60";
const primary =
  "rounded-md border border-foreground bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-60";

/** Where an admin types a rule in plain English, reads the compiled rule, and confirms it. */
export function PolicyCompiler() {
  const [text, setText] = useState("");
  const [compiled, compile, compiling] = useActionState<CompileState, FormData>(
    compilePolicyAction,
    {},
  );
  const [confirmed, confirm, confirming] = useActionState<CompileState, FormData>(
    confirmPolicyAction,
    {},
  );
  // Discard hides the preview it was clicked on. Compiling again makes a new `compiled` object.
  const [discarded, setDiscarded] = useState<CompileState | null>(null);
  // A confirm result belongs to the preview it answered; a newer compile replaces it.
  const [confirmedFor, setConfirmedFor] = useState<CompileState | null>(null);

  const preview = compiled.preview && discarded !== compiled ? compiled.preview : undefined;
  const done = confirmedFor === compiled && confirmed.message && !confirmed.error;

  return (
    <div className="flex flex-col gap-4">
      <form action={compile} className="flex flex-col gap-2">
        <label htmlFor="policy-text" className="text-sm text-muted">
          Describe a rule in plain English
        </label>
        <textarea
          id="policy-text"
          name="text"
          required
          rows={3}
          maxLength={MAX_LENGTH}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Support agents can spend at most $10 a day"
          aria-describedby="policy-count"
          className="w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span id="policy-count" className="text-xs tabular-nums text-muted">
            {text.length} / {MAX_LENGTH}
          </span>
          <button disabled={compiling || text.trim().length === 0} className={button}>
            {compiling ? "Compiling…" : "Compile"}
          </button>
        </div>
      </form>

      {compiled.error && (
        <p
          role="alert"
          className="rounded-md border border-red-700 px-4 py-3 text-sm text-red-700 dark:border-red-400 dark:text-red-400"
        >
          {compiled.error}
        </p>
      )}

      {preview && !done && (
        <section
          aria-label="Compiled rule"
          className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-medium">Compiled rule</h3>
            <span className="rounded border border-amber-700 px-1.5 text-xs font-medium text-amber-700 dark:border-amber-400 dark:text-amber-400">
              Not enforced yet
            </span>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {preview.readable.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {preview.warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-400">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted">
            Nothing is enforced until you confirm. Check this matches what you meant.
          </p>
          <form
            action={(form) => {
              setConfirmedFor(compiled);
              confirm(form);
            }}
            className="flex flex-wrap items-center gap-3"
          >
            <input type="hidden" name="sourceText" value={preview.sourceText} />
            <input type="hidden" name="document" value={preview.document} />
            <button disabled={confirming} className={primary}>
              {confirming ? "Confirming…" : "Confirm"}
            </button>
            <button
              type="button"
              disabled={confirming}
              onClick={() => setDiscarded(compiled)}
              className={button}
            >
              Discard
            </button>
            {confirmedFor === compiled && confirmed.error && (
              <span role="alert" className="text-sm text-red-700 dark:text-red-400">
                {confirmed.error}
              </span>
            )}
          </form>
        </section>
      )}

      {done && (
        <p role="status" className="text-sm text-muted">
          {confirmed.message}
        </p>
      )}
    </div>
  );
}
