import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentActor } from "@/auth/viewer";
import { appDb } from "@/db/shared";
import { readInvite } from "@/projects/invite";
import { InviteJoin } from "@/ui/account/InviteJoin";

// The token is in the address: never pass it on to another site.
export const metadata: Metadata = { title: "Join a project · Setti", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** A client opens the link their designer sent, then signs in or creates an account and joins the project. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  const invite = /^[A-Za-z0-9_-]{20,100}$/.test(token) ? await readInvite(appDb(), token) : null;
  const actor = await currentActor();
  if (invite && actor && !actor.studio && actor.projects.some((project) => project.studioId === invite.studioId && project.key === invite.key)) redirect(`/chats/${invite.key}`);
  return <InviteJoin token={token}
    invite={invite && { status: invite.status, projectName: invite.projectName, studioName: invite.studioName, designerName: invite.designerName }}
    viewer={actor && { name: actor.name, email: actor.email, kind: actor.demoPersona ? "demo" : actor.studio ? "studio" : "client" }} />;
}
