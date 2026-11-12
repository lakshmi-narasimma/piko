# 0013. How Budgets count spend, and what a "task" is

**Status:** Accepted · 2026-11-12

## Context
DESIGN.md §9 and §12 give Budgets a scope (org, team or Agent), a period (`day`, `month` or `task`) and an optional category, and say spend comes from the Ledger. They don't say:
- when a period starts and ends,
- whether money held by a reservation, but not yet settled, counts,
- what a "task" is. Nothing in the schema or the API identifies a task: no Call, Challenge or request carries a task id.

## Decision
- **Spend** is the buyer wallet's Ledger entries for Calls (`reason` `call` and `refund`, so refunds net out), joined to `calls` for the Agent, team and Listing category. A Call and its refund count in the period of the Call's `created_at`.
- **Holds count.** Every active reservation in the Budget's scope is added to spend, whenever it started. The budget check runs a second time inside `reserveFunds`, under the buyer org's row lock, so concurrent payments can't both fit under one cap. A retried payment's own hold isn't counted against itself.
- **Periods** are UTC calendar days and months. The current one is found with the database clock (`date_trunc` on `now()`), which also sets `calls.created_at`, so the two agree.
- **A task** runs from when its Budget was saved (`budgets.created_at`), with no end. Changing its cap starts a new task (the Wallet's limits form replaces the row). Saving the form with the same cap, for example to change only "notify above", keeps the row and so keeps the task going. This needs no schema change and fits the demo, where Sam's agent runs one shopping task against a $1.00 Budget.
- A **category** Budget covers only Calls to Listings with that category, compared without case.
- A Budget row only applies if its scope is the paying Agent, that Agent's team or that Agent's org, all under the Budget's `org_id`. `createBudget` refuses a scope from another org, because `scope_id` has no foreign key.

## Consequences
- An agent can't name a task. If per-task budgets have to follow the agent's own notion of a task (say a `X-Piko-Task` header), that needs a column on `challenges` and `calls`, and a record that supersedes this one.
- A Call that moves to another team keeps counting against its Agent's current team, since spend is joined through `agents.team_id` today.
- Each budget check is one query per covering Budget, twice per payment. That is fine at demo scale; a cached spend per Budget and period can replace it later without changing the rules.
