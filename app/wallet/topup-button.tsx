"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatUsd, parseUsd } from "@/lib/money";

// The parts of PayPal's JS SDK v6 this screen uses.
interface PayPalSession {
  start(options: { presentationMode: "auto" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface PayPalSdk {
  findEligibleMethods(options: { currencyCode: string }): Promise<{
    isEligible(method: string): boolean;
  }>;
  createPayPalOneTimePaymentSession(callbacks: {
    onApprove(data: { orderId: string }): Promise<void> | void;
    onCancel(data?: unknown): void;
    onError(error: Error): void;
  }): PayPalSession;
}
declare global {
  interface Window {
    paypal?: {
      createInstance(options: {
        clientId: string;
        components: string[];
        pageType: string;
      }): Promise<PayPalSdk>;
    };
  }
}

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

function loadSdk(): Promise<void> {
  if (window.paypal) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Couldn't load PayPal."));
    document.head.append(script);
  });
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable"; text: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export function TopupButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("5.00");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const slot = useRef<HTMLDivElement>(null);
  // The PayPal callbacks outlive renders, so they read the amount from here.
  const amountRef = useRef(amount);
  useEffect(() => {
    amountRef.current = amount;
  }, [amount]);

  useEffect(() => {
    let cancelled = false;

    async function createOrder(): Promise<{ orderId: string }> {
      const response = await fetch("/api/topups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amountRef.current }),
      });
      const body = (await response.json()) as { orderId?: string; error?: { message: string } };
      if (!response.ok || !body.orderId) {
        throw new Error(body.error?.message ?? "Couldn't start the top-up.");
      }
      return { orderId: body.orderId };
    }

    async function setUp() {
      try {
        await loadSdk();
        const sdk = await window.paypal!.createInstance({
          clientId,
          components: ["paypal-payments"],
          pageType: "checkout",
        });
        const eligibility = await sdk.findEligibleMethods({ currencyCode: "USD" });
        if (cancelled) return;
        if (!eligibility.isEligible("paypal")) {
          setStatus({ kind: "unavailable", text: "PayPal isn't available for this browser." });
          return;
        }

        const session = sdk.createPayPalOneTimePaymentSession({
          async onApprove({ orderId }) {
            setStatus({ kind: "info", text: "Approved. Adding the money to your wallet…" });
            const response = await fetch(`/api/topups/${orderId}/capture`, { method: "POST" });
            const body = (await response.json()) as {
              credited: boolean;
              pending: boolean;
              amountMicro: string;
              error?: { message: string };
            };
            if (!response.ok) {
              setStatus({ kind: "error", text: body.error?.message ?? "The top-up failed." });
            } else if (body.pending) {
              setStatus({
                kind: "info",
                text: "PayPal is still processing the payment. Your balance updates when it finishes.",
              });
            } else {
              setStatus({
                kind: "info",
                text: `Added ${formatUsd(BigInt(body.amountMicro))} to your wallet.`,
              });
            }
            router.refresh();
          },
          onCancel() {
            setStatus({
              kind: "info",
              text: "You closed the PayPal window, so nothing was charged. Click the button to try again.",
            });
          },
          onError(error) {
            setStatus({ kind: "error", text: `PayPal reported a problem: ${error.message}` });
          },
        });

        const button = document.createElement("paypal-button");
        button.addEventListener("click", () => {
          try {
            parseUsd(amountRef.current);
          } catch {
            setStatus({ kind: "error", text: "Enter an amount in dollars, like 5.00." });
            return;
          }
          setStatus({ kind: "idle" });
          // Not awaited first: the popup must open inside the click.
          session
            .start({ presentationMode: "auto" }, createOrder())
            .catch((error: Error) => setStatus({ kind: "error", text: error.message }));
        });
        slot.current?.replaceChildren(button);
        setStatus({ kind: "idle" });
      } catch (error) {
        if (!cancelled) {
          setStatus({
            kind: "unavailable",
            text: error instanceof Error ? error.message : "PayPal didn't load.",
          });
        }
      }
    }

    void setUp();
    return () => {
      cancelled = true;
    };
  }, [clientId, router]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Amount (USD)</span>
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          className="w-40 rounded-md border border-line bg-transparent px-3 py-2"
        />
      </label>
      <div ref={slot} className="min-h-10" />
      {status.kind === "loading" && <p className="text-sm text-muted">Loading PayPal…</p>}
      {status.kind !== "idle" && status.kind !== "loading" && (
        <p
          role={status.kind === "info" ? "status" : "alert"}
          className={status.kind === "info" ? "text-sm" : "text-sm text-red-700 dark:text-red-400"}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}
