"use client";

import { accountOrDefault, rememberAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { TrySeedNotice, type TrySeedNoticeProps } from "./TrySeedNotice";

/** Full-page pricing and payment views keep the same role-aware guide as the workspace. */
export function TryPageGuide({ projectKey, account, currentView, currentOrderId }: {
  projectKey: CaseKey;
  account?: string;
  currentView: TrySeedNoticeProps["currentView"];
  currentOrderId?: string;
}) {
  return <TrySeedNotice projectKey={projectKey} account={accountOrDefault(account)}
    onSwitchAccount={rememberAccount} onOpenChat={() => window.location.assign(`/chats/${projectKey}`)}
    currentView={currentView} currentOrderId={currentOrderId} />;
}
