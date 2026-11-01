"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface PayPalButtonsInstance { isEligible(): boolean; render(container: HTMLElement): Promise<void>; close(): Promise<void> }
interface PayPalSdk {
  FUNDING: { PAYPAL: string; PAYLATER: string };
  Buttons(options: {
    fundingSource: string; style?: Record<string, string | number | boolean>;
    createOrder: () => Promise<string>; onApprove: () => Promise<void>; onCancel: () => Promise<void>; onError: (error: unknown) => void;
  }): PayPalButtonsInstance;
}
declare global { interface Window { settiPayPal?: PayPalSdk } }

const sdkLoads = new Map<string, Promise<PayPalSdk>>();

/** Loads the PayPal JS SDK once per client id, under its own namespace. */
function loadPayPal(clientId: string): Promise<PayPalSdk> {
  let load = sdkLoads.get(clientId);
  if (!load) {
    load = new Promise<PayPalSdk>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.paypal.com/sdk/js?${new URLSearchParams({ "client-id": clientId, currency: "USD", intent: "authorize", components: "buttons", "enable-funding": "paylater", "buyer-country": "US" })}`;
      // Probe P11: without a namespace the SDK's default global failed to start in Chrome.
      script.dataset.namespace = "settiPayPal";
      script.onload = () => window.settiPayPal ? resolve(window.settiPayPal) : reject(new Error("PayPal did not start."));
      script.onerror = () => { sdkLoads.delete(clientId); reject(new Error("PayPal could not be loaded.")); };
      document.head.appendChild(script);
    });
    sdkLoads.set(clientId, load);
  }
  return load;
}

export interface PayPalHandlers {
  /** Returns the PayPal order id the window opens: the server creates (or resumes) it. */
  createOrder: () => Promise<string>;
  onApprove: () => Promise<void>;
  onCancel: () => Promise<void>;
  onError: () => void;
}

export type PayPalFunding = "paypal" | "paylater";

/** PayPal draws its buttons in its own frame; these are the only looks it allows. Black sits better with Setti than PayPal's default gold. */
const BUTTON_STYLE = { layout: "vertical", color: "black", shape: "rect", height: 44 } as const;

/**
 * One of PayPal's own buttons, PayPal or Pay Later. It opens PayPal in a window
 * over this page for the server's order; the page never navigates away.
 */
export function PayPalButton({ clientId, funding, disabled, ...props }: PayPalHandlers & { clientId: string; funding: PayPalFunding; disabled: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef(props);
  handlers.current = props;
  const [state, setState] = useState<"loading" | "ready" | "ineligible" | "failed">("loading");

  useEffect(() => {
    let closed = false;
    let rendered: PayPalButtonsInstance | null = null;
    setState("loading");
    loadPayPal(clientId).then(async (sdk) => {
      if (closed || !container.current) return;
      const buttons = sdk.Buttons({
        fundingSource: funding === "paylater" ? sdk.FUNDING.PAYLATER : sdk.FUNDING.PAYPAL, style: BUTTON_STYLE,
        createOrder: () => handlers.current.createOrder(), onApprove: () => handlers.current.onApprove(),
        onCancel: () => handlers.current.onCancel(), onError: () => handlers.current.onError(),
      });
      if (!buttons.isEligible()) { if (!closed) setState("ineligible"); return; }
      rendered = buttons;
      await buttons.render(container.current);
      if (!closed) setState("ready");
    }).catch(() => { if (!closed) setState("failed"); });
    return () => { closed = true; void rendered?.close().catch(() => undefined); };
  }, [clientId, funding]);

  return <div aria-busy={state === "loading"} className={disabled ? "pointer-events-none opacity-50" : undefined}>
    {state === "loading" && <p className="flex h-[44px] items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />Loading PayPal…</p>}
    {state === "ineligible" && <p className="text-[11px] text-[var(--muted)]">{funding === "paylater" ? "Pay Later is not offered for this payment." : "PayPal is not offered for this payment."}</p>}
    {state === "failed" && <p role="alert" className="text-[11px] text-red-800">PayPal could not be loaded. Check the connection and reload the page.</p>}
    <div ref={container} />
  </div>;
}

/** Both PayPal buttons, for continuing a checkout PayPal already holds the order for. */
export function PayPalButtons(props: PayPalHandlers & { clientId: string; disabled: boolean }) {
  return <div className="space-y-2">
    <PayPalButton funding="paypal" {...props} />
    <PayPalButton funding="paylater" {...props} />
  </div>;
}
