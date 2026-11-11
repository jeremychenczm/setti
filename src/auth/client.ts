"use client";
/** Sign-up, sign-in and sign-out from the browser, against `/api/auth`. */
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: [organizationClient()] });
