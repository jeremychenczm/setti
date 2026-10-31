"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface PayPalButtonsInstance { isEligible(): boolean; render(container: HTMLElement): Promise<void>; close(): Promise<void> }
interface PayPalSdk {
  FUNDING: { PAYPAL: string; PAYLATER: string };
  Buttons(options: {
    fundingSource: string; style?: Record<string, string | number>;
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

/**
 * PayPal's own PayPal and Pay Later buttons. Each opens PayPal in a window over
 * this page for the server's order; the page never navigates away.
 */
export function PayPalButtons(props: PayPalHandlers & { clientId: string; disabled: boolean }) {
  const paypal = useRef<HTMLDivElement>(null);
  const payLater = useRef<HTMLDivElement>(null);
  const handlers = useRef(props);
  handlers.current = props;
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const { clientId } = props;

  useEffect(() => {
    let closed = false;
    const rendered: PayPalButtonsInstance[] = [];
    loadPayPal(clientId).then(async (sdk) => {
      for (const [fundingSource, container] of [[sdk.FUNDING.PAYPAL, paypal.current], [sdk.FUNDING.PAYLATER, payLater.current]] as const) {
        if (closed || !container) return;
        const buttons = sdk.Buttons({
          fundingSource, style: { layout: "vertical", height: 40, shape: "rect" },
          createOrder: () => handlers.current.createOrder(), onApprove: () => handlers.current.onApprove(),
          onCancel: () => handlers.current.onCancel(), onError: () => handlers.current.onError(),
        });
        if (!buttons.isEligible()) continue;
        rendered.push(buttons);
        await buttons.render(container);
      }
      if (!closed) setState("ready");
    }).catch(() => { if (!closed) setState("failed"); });
    return () => { closed = true; for (const buttons of rendered) void buttons.close().catch(() => undefined); };
  }, [clientId]);

  return <div aria-busy={state === "loading"} className={props.disabled ? "pointer-events-none opacity-50" : undefined}>
    {state === "loading" && <p className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />Loading PayPal…</p>}
    {state === "failed" && <p role="alert" className="text-[11px] text-red-800">PayPal could not be loaded. Check the connection and reload the page.</p>}
    <div ref={paypal} />
    <div ref={payLater} className="mt-2" />
  </div>;
}
