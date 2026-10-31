"use client";

import type { CaseKey } from "@/chat/types";
import { DesignServicesPayment } from "./DesignServicesPayment";
import { ItemHolds } from "./ItemHolds";

/**
 * The client's payment of the current agreement: the design services in one
 * PayPal checkout, then each approved item held with the PayPal saved there.
 * Furniture holds start only when the viewer explicitly requests them.
 */
export function ProjectPayments({ projectKey, orderId }: { projectKey: CaseKey; orderId: string | null }) {
  return <>
    <DesignServicesPayment projectKey={projectKey} orderId={orderId} />
    {orderId === null && <ItemHolds projectKey={projectKey} orderId={orderId} />}
  </>;
}
