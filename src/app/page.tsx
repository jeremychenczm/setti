import { accountCookie } from "@/accounts/server";
import { Workspace } from "@/ui/workspace/Workspace";

export default async function Home() {
  return <Workspace initialAccount={await accountCookie()} />;
}
