"use client";

import { useActionState } from "react";
import { loginWithPassword, type LoginState } from "./actions";

const field = "w-full rounded-md border border-line bg-transparent px-3 py-2 ";

export function PasswordForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginWithPassword, {});
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-3">
      <input name="email" type="email" placeholder="Email" autoComplete="email" className={field} />
      <input
        name="password"
        type="password"
        placeholder="Password"
        autoComplete="current-password"
        className={field}
      />
      {state.error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {state.error}
        </p>
      )}
      <button
        disabled={pending}
        className="rounded-md bg-brand px-3 py-2 text-brand-foreground disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
