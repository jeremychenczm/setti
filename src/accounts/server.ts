import { cookies } from "next/headers";
import { ACCOUNT_COOKIE } from "./demo";

/** The demo account cookie, for pages rendered on the server. */
export async function accountCookie(): Promise<string | undefined> {
  return (await cookies()).get(ACCOUNT_COOKIE)?.value;
}
