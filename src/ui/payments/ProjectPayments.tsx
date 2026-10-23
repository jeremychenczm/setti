"use client";

import { useState } from "react";
import type { CaseKey } from "@/chat/types";
import { DesignServicesPayment } from "./DesignServicesPayment";
import { ItemHolds } from "./ItemHolds";

/**
 * The client's payment of the current agreement: the design services in one
 * PayPal checkout, then each approved item held with the PayPal saved there.
 * Paying the design services starts the item holds.
 */
export function ProjectPayments({ projectKey, orderId }: { projectKey: CaseKey; orderId: string | null }) {
  const [holdRequest, setHoldRequest] = useState(0);
  return <>
    <DesignServicesPayment projectKey={projectKey} orderId={orderId} onPaid={() => setHoldRequest((count) => count + 1)} />
    <ItemHolds projectKey={projectKey} orderId={orderId} holdRequest={holdRequest} />
  </>;
}
