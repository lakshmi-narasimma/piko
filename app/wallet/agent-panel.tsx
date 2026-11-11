"use client";

import { useActionState } from "react";
import { createKeyAction, revokeKeyAction, saveLimits, type ActionState } from "./actions";

export interface AgentPanelData {
  id: string;
  name: string;
  /** Dollar strings for the inputs, "" when unset. */
  task: string;
  day: string;
  notify: string;
  keys: Array<{ id: string; prefix: string; created: string; revoked: boolean }>;
}

const input = "w-32 rounded-md border border-line bg-transparent px-3 py-2";
const button = "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface";

export function AgentPanel({ agent }: { agent: AgentPanelData }) {
  const [limits, saveAction, saving] = useActionState<ActionState, FormData>(saveLimits, {});
  const [created, createAction, creating] = useActionState<ActionState, FormData>(
    createKeyAction,
    {},
  );

  return (
    <article className="flex flex-col gap-5 rounded-xl border border-line p-5">
      <h3 className="text-lg font-medium">{agent.name}</h3>

      <form action={saveAction} className="flex flex-col gap-3">
        <input type="hidden" name="agentId" value={agent.id} />
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Budget per task ($)</span>
            <input name="task" defaultValue={agent.task} placeholder="1.00" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Budget per day ($)</span>
            <input name="day" defaultValue={agent.day} placeholder="5.00" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Notify me above, per call ($)</span>
            <input name="notify" defaultValue={agent.notify} placeholder="0.05" className={input} />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button disabled={saving} className={button}>
            {saving ? "Saving…" : "Save limits"}
          </button>
          {limits.message && (
            <span role="status" className="text-sm text-muted">
              {limits.message}
            </span>
          )}
          {limits.error && (
            <span role="alert" className="text-sm text-red-700 dark:text-red-400">
              {limits.error}
            </span>
          )}
        </div>
        <p className="text-sm text-muted">Leave a box empty for no limit.</p>
      </form>

      <div className="flex flex-col gap-3">
        <h4 className="font-medium">Keys</h4>
        {agent.keys.length === 0 && <p className="text-sm text-muted">No keys yet.</p>}
        <ul className="divide-y divide-line rounded-md border border-line">
          {agent.keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>
                <code>{key.prefix}…</code>{" "}
                <span className="text-muted">
                  created {key.created}
                  {key.revoked ? " · revoked" : ""}
                </span>
              </span>
              {!key.revoked && (
                <form action={revokeKeyAction}>
                  <input type="hidden" name="keyId" value={key.id} />
                  <button className={button}>Revoke</button>
                </form>
              )}
            </li>
          ))}
        </ul>

        {created.rawKey && (
          <div role="status" className="rounded-md border border-line bg-surface p-3 text-sm">
            <p className="font-medium">Copy this key now. It won&rsquo;t be shown again.</p>
            <code className="mt-1 block break-all">{created.rawKey}</code>
          </div>
        )}
        {created.error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {created.error}
          </p>
        )}
        <form action={createAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <button disabled={creating} className={button}>
            {creating ? "Creating…" : "Create a key"}
          </button>
        </form>
      </div>
    </article>
  );
}
