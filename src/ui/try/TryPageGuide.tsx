"use client";

import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { switchPersona } from "../account/switchPersona";
import { TrySeedNotice, type TrySeedNoticeProps } from "./TrySeedNotice";

/** Full-page pricing and payment views keep the same role-aware guide as the workspace. */
export function TryPageGuide({ projectKey, account, currentView, currentOrderId }: {
  projectKey: CaseKey;
  account: DemoAccount;
  currentView: TrySeedNoticeProps["currentView"];
  currentOrderId?: string;
}) {
  return <TrySeedNotice projectKey={projectKey} account={account}
    onSwitchAccount={switchPersona} onOpenChat={() => window.location.assign(`/chats/${projectKey}`)}
    currentView={currentView} currentOrderId={currentOrderId} />;
}
