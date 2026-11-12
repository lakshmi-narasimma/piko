"use client";

import { useActionState } from "react";
import { createAgentAction, createTeamAction, moveAgentAction, type ActionState } from "./actions";

export interface TeamOption {
  id: string;
  name: string;
}

const input = "rounded-md border border-line bg-transparent px-3 py-2 text-sm";
const button =
  "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60";

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
      <span role="status" className="text-sm text-muted">
        {state.message}
      </span>
    );
  }
  return null;
}

function TeamSelect({
  teams,
  defaultValue,
  label,
}: {
  teams: TeamOption[];
  defaultValue: string;
  label: string;
}) {
  return (
    <select name="teamId" defaultValue={defaultValue} aria-label={label} className={input}>
      <option value="">No team</option>
      {teams.map((team) => (
        <option key={team.id} value={team.id}>
          {team.name}
        </option>
      ))}
    </select>
  );
}

export function CreateTeamForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createTeamAction, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">New team</span>
        <input name="name" required maxLength={60} placeholder="Finance" className={input} />
      </label>
      <button disabled={pending} className={button}>
        {pending ? "Creating…" : "Create team"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function CreateAgentForm({ teams }: { teams: TeamOption[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createAgentAction, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">New agent</span>
        <input
          name="name"
          required
          maxLength={60}
          pattern="[a-z0-9][a-z0-9\-]*"
          title="Lowercase letters, digits and dashes"
          placeholder="invoice-checker"
          className={input}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">In team</span>
        <TeamSelect
          teams={teams}
          defaultValue={teams[0]?.id ?? ""}
          label="Team for the new agent"
        />
      </label>
      <button disabled={pending} className={button}>
        {pending ? "Creating…" : "Create agent"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function MoveAgentForm({
  agent,
  teams,
}: {
  agent: { id: string; name: string; teamId: string | null };
  teams: TeamOption[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(moveAgentAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="agentId" value={agent.id} />
      <TeamSelect
        teams={teams}
        defaultValue={agent.teamId ?? ""}
        label={`Team for ${agent.name}`}
      />
      <button disabled={pending} className={button}>
        {pending ? "Moving…" : "Move"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
