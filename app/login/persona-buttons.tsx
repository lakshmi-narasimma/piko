"use client";

import { useState, useTransition } from "react";
import { loginAsPersona } from "./actions";

export function PersonaButtons({
  personas,
}: {
  personas: ReadonlyArray<{ email: string; name: string; blurb: string }>;
}) {
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  return (
    <div className="flex w-full max-w-2xl flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {personas.map((persona) => (
          <button
            key={persona.email}
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError((await loginAsPersona(persona.email))?.error);
              })
            }
            className="rounded-lg border border-zinc-300 p-4 text-left hover:border-foreground disabled:opacity-60 dark:border-zinc-700"
          >
            <span className="block font-medium">{persona.name}</span>
            <span className="block text-sm text-zinc-600 dark:text-zinc-400">{persona.blurb}</span>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
