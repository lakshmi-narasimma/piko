"use client";

import { useEffect, useRef, useState } from "react";
import { formatUsd } from "@/lib/money";

// The parts of PayPal's JS SDK v6 this button uses.
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
type PayPalGlobal = {
  createInstance(options: {
    clientId: string;
    components: string[];
    pageType: string;
  }): Promise<PayPalSdk>;
};

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

function loadSdk(): Promise<PayPalGlobal> {
  const existing = (window as unknown as { paypal?: PayPalGlobal }).paypal;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve((window as unknown as { paypal: PayPalGlobal }).paypal);
    script.onerror = () => reject(new Error("Couldn't load PayPal."));
    document.head.append(script);
  });
}

type Status =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

/** The final step of the demo: buy the recommended product through real PayPal checkout. */
export function CheckoutButton({
  clientId,
  name,
  priceMicro,
}: {
  clientId: string;
  name: string;
  priceMicro: bigint;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const slot = useRef<HTMLDivElement>(null);
  const price = formatUsd(priceMicro);

  useEffect(() => {
    let cancelled = false;

    async function createOrder(): Promise<{ orderId: string }> {
      const response = await fetch("/api/checkout/demo-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, price: price.replace(/[$,]/g, "") }),
      });
      const body = (await response.json()) as { orderId?: string; error?: { message: string } };
      if (!response.ok || !body.orderId) {
        throw new Error(body.error?.message ?? "Couldn't start the checkout.");
      }
      return { orderId: body.orderId };
    }

    async function setUp() {
      try {
        const paypal = await loadSdk();
        const sdk = await paypal.createInstance({
          clientId,
          components: ["paypal-payments"],
          pageType: "checkout",
        });
        const eligibility = await sdk.findEligibleMethods({ currencyCode: "USD" });
        if (cancelled) return;
        if (!eligibility.isEligible("paypal")) {
          setStatus({ kind: "error", text: "PayPal isn't available for this browser." });
          return;
        }
        const session = sdk.createPayPalOneTimePaymentSession({
          async onApprove({ orderId }) {
            setStatus({ kind: "info", text: "Approved. Completing your purchase…" });
            const response = await fetch(`/api/checkout/demo-product/${orderId}/capture`, {
              method: "POST",
            });
            const body = (await response.json()) as {
              status?: string;
              error?: { message: string };
            };
            setStatus(
              response.ok && body.status === "COMPLETED"
                ? { kind: "info", text: `Paid ${price} for ${name}. Thank you!` }
                : { kind: "error", text: body.error?.message ?? "The payment didn't complete." },
            );
          },
          onCancel() {
            setStatus({
              kind: "info",
              text: "You closed the PayPal window, so nothing was charged.",
            });
          },
          onError(error) {
            setStatus({ kind: "error", text: `PayPal reported a problem: ${error.message}` });
          },
        });

        const button = document.createElement("paypal-button");
        button.addEventListener("click", () => {
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
            kind: "error",
            text: error instanceof Error ? error.message : "PayPal didn't load.",
          });
        }
      }
    }

    void setUp();
    return () => {
      cancelled = true;
    };
  }, [clientId, name, price]);

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">
        Buy {name} for {price}
      </p>
      <div ref={slot} className="min-h-10" />
      {status.kind === "loading" && <p className="text-sm text-muted">Loading PayPal…</p>}
      {(status.kind === "info" || status.kind === "error") && (
        <p
          role={status.kind === "info" ? "status" : "alert"}
          className={status.kind === "error" ? "text-sm text-red-700 dark:text-red-400" : "text-sm"}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}
