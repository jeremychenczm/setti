import { toNextJsHandler } from "better-auth/next-js";
import { appAuth } from "@/auth/app";

// Built on the first request, so `next build` needs no database.
export async function GET(request: Request) {
  return toNextJsHandler(appAuth()).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(appAuth()).POST(request);
}
