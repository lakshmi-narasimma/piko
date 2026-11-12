"use client";

import { useActionState, useState } from "react";
import { setFrozenAction, type ActionState } from "./actions";

const button =
  "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60";
const danger =
  "rounded-md border border-red-700 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-950";

function Feedback({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <span role="alert" className="text-sm text-red-700 dark:text-red-400">
        {state.error}
      </span>
    );
  }
  if (state.message) {
    return (
      <span role="status" className="max-w-xs text-sm text-muted">
        {state.message}
      </span>
    );
  }
  return null;
}

/** A clear marker for a scope whose kill switch is on, or one blocked by a wider switch. */
export function FrozenBadge({ via }: { via?: "team" | "org" }) {
  return (
    <span className="ml-2 rounded border border-red-700 px-1.5 text-xs font-medium text-red-700 dark:border-red-400 dark:text-red-400">
      {via ? `frozen by ${via}` : "frozen"}
    </span>
  );
}

/** Freezes or unfreezes one agent or team. */
export function FreezeButton({
  scope,
  id,
  name,
  frozen,
}: {
  scope: "agent" | "team";
  id: string;
  name: string;
  frozen: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setFrozenAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="frozen" value={String(!frozen)} />
      <button
        disabled={pending}
        className={frozen ? button : danger}
        aria-label={`${frozen ? "Unfreeze" : "Freeze"} ${scope} ${name}`}
      >
        {pending ? "Saving…" : frozen ? "Unfreeze" : "Freeze"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

/** The org-wide kill switch. Both directions ask for a confirmation first. */
export function OrgFreezeSwitch({ orgName, frozen }: { orgName: string; frozen: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setFrozenAction, {});
  const [confirming, setConfirming] = useState(false);
  const verb = frozen ? "Unfreeze" : "Freeze";

  return (
    <form
      action={(form) => {
        setConfirming(false);
        action(form);
      }}
      className="flex flex-wrap items-center gap-3"
    >
      <input type="hidden" name="scope" value="org" />
      <input type="hidden" name="frozen" value={String(!frozen)} />
      {confirming ? (
        <>
          <span className="text-sm">
            {frozen
              ? `Let every agent in ${orgName} spend again?`
              : `Stop every agent in ${orgName} from paying, including Receipts they already hold?`}
          </span>
          <button disabled={pending} className={frozen ? button : danger}>
            {`Yes, ${verb.toLowerCase()} the org`}
          </button>
          <button type="button" className={button} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={pending}
          className={frozen ? button : danger}
          onClick={() => setConfirming(true)}
        >
          {pending ? "Saving…" : `${verb} the whole org`}
        </button>
      )}
      <Feedback state={state} />
    </form>
  );
}
