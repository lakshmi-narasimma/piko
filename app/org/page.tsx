import Link from "next/link";
import { Suspense } from "react";
import { AlertsPanel } from "@/components/alerts-panel";
import { requirePrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { formatUsd } from "@/lib/money";
import { loadOrgTree, type Spend, type TreeAgent, type TreeBudget } from "@/lib/org";
import { isOrgFrozen } from "@/lib/org/freeze";
import { FreezeButton, FrozenBadge, OrgFreezeSwitch } from "./freeze-controls";
import { CreateAgentForm, CreateTeamForm, MoveAgentForm, type TeamOption } from "./tree-forms";

export const metadata = { title: "Org console · Piko" };

const PER: Record<TreeBudget["period"], string> = {
  day: "per day",
  month: "per month",
  task: "per task",
};

function BudgetText({ budgets }: { budgets: TreeBudget[] }) {
  if (budgets.length === 0) return <span className="text-muted">No budget</span>;
  return (
    <span>
      {budgets
        .map(
          (b) =>
            `Budget ${formatUsd(b.maxMicro)} ${PER[b.period]}${b.category ? ` on ${b.category}` : ""}`,
        )
        .join(" · ")}
    </span>
  );
}

/** Spend this month. Any part from simulated Calls is labelled as such. */
function SpendText({ spend }: { spend: Spend }) {
  return (
    <span className="tabular-nums">
      spent {formatUsd(spend.spentMicro)} this month
      {spend.simulatedMicro !== 0n && (
        <span className="text-muted"> (incl. {formatUsd(spend.simulatedMicro)} simulated)</span>
      )}
    </span>
  );
}

function AgentRow({
  agent,
  teams,
  canEdit,
  blockedBy,
}: {
  agent: TreeAgent;
  teams: TeamOption[];
  canEdit: boolean;
  /** A wider kill switch that also stops this agent. */
  blockedBy?: "team" | "org";
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">
          <code>{agent.name}</code>
          {agent.frozen && <FrozenBadge />}
          {blockedBy && <FrozenBadge via={blockedBy} />}
        </span>
        <span className="text-sm text-muted">
          <BudgetText budgets={agent.budgets} />, <SpendText spend={agent} />
        </span>
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <MoveAgentForm
            agent={{ id: agent.id, name: agent.name, teamId: agent.teamId }}
            teams={teams}
          />
          <FreezeButton scope="agent" id={agent.id} name={agent.name} frozen={agent.frozen} />
        </div>
      )}
    </li>
  );
}

// Reads the session cookie and the database, so it renders at request time inside Suspense.
async function OrgConsoleContent() {
  const { org, role } = await requirePrincipal("org");
  const [tree, orgFrozen] = await Promise.all([
    loadOrgTree(getDb(), org.id),
    isOrgFrozen(getDb(), org.id),
  ]);
  const canEdit = role === "admin";
  const teamOptions = tree.teams.map(({ id, name }) => ({ id, name }));
  const agentCount =
    tree.unassigned.length + tree.teams.reduce((n, team) => n + team.agents.length, 0);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Org console</h1>
        <p className="text-muted">{org.name}</p>
        {canEdit && (
          <Link href="/org/spend" className="text-sm font-medium hover:underline">
            Spend grid and audit export →
          </Link>
        )}
      </header>

      <section aria-label="Org budget" className="grid gap-6 sm:grid-cols-3">
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-5">
          <span className="text-sm text-muted">Spent this month</span>
          <span className="text-4xl font-semibold tabular-nums">{formatUsd(tree.spentMicro)}</span>
          {tree.simulatedMicro !== 0n && (
            <span className="text-sm text-muted">
              incl. {formatUsd(tree.simulatedMicro)} simulated
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-line p-5">
          <span className="text-sm text-muted">Org budget</span>
          <span className="text-lg">
            <BudgetText budgets={tree.budgets} />
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-line p-5">
          <span className="text-sm text-muted">Teams and agents</span>
          <span className="text-lg">
            {tree.teams.length} teams, {agentCount} agents
          </span>
        </div>
      </section>

      {canEdit && <AlertsPanel />}

      <section aria-label="Teams and agents" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-medium">
            Teams and agents
            {orgFrozen && <FrozenBadge />}
          </h2>
          {canEdit && <OrgFreezeSwitch orgName={org.name} frozen={orgFrozen} />}
        </div>
        {orgFrozen && (
          <p
            role="status"
            className="rounded-md border border-red-700 px-4 py-3 text-sm text-red-700 dark:border-red-400 dark:text-red-400"
          >
            Kill switch on for the whole org: every agent gets 423 agent_frozen, even for Receipts
            it already holds.
          </p>
        )}
        {tree.teams.length === 0 && tree.unassigned.length === 0 && (
          <p className="text-muted">No teams or agents yet.</p>
        )}
        {tree.teams.map((team) => (
          <article key={team.id} className="rounded-xl border border-line">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line bg-surface px-4 py-3">
              <h3 className="text-lg font-medium">
                {team.name}
                {team.frozen && <FrozenBadge />}
                {orgFrozen && <FrozenBadge via="org" />}
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm">
                  <BudgetText budgets={team.budgets} />, <SpendText spend={team} />
                </span>
                {canEdit && (
                  <FreezeButton scope="team" id={team.id} name={team.name} frozen={team.frozen} />
                )}
              </div>
            </header>
            {team.agents.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">No agents in this team.</p>
            ) : (
              <ul className="divide-y divide-line">
                {team.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    teams={teamOptions}
                    canEdit={canEdit}
                    blockedBy={orgFrozen ? "org" : team.frozen ? "team" : undefined}
                  />
                ))}
              </ul>
            )}
          </article>
        ))}
        {tree.unassigned.length > 0 && (
          <article className="rounded-xl border border-dashed border-line">
            <header className="border-b border-line px-4 py-3">
              <h3 className="text-lg font-medium">No team</h3>
            </header>
            <ul className="divide-y divide-line">
              {tree.unassigned.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  teams={teamOptions}
                  canEdit={canEdit}
                  blockedBy={orgFrozen ? "org" : undefined}
                />
              ))}
            </ul>
          </article>
        )}
      </section>

      {canEdit && (
        <section aria-label="Add" className="flex flex-col gap-4 rounded-xl border border-line p-5">
          <h2 className="text-xl font-medium">Add a team or an agent</h2>
          <CreateTeamForm />
          <CreateAgentForm teams={teamOptions} />
        </section>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <OrgConsoleContent />
    </Suspense>
  );
}
