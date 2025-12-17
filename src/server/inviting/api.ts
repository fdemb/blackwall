import { renderEmail, sendEmail } from "@/lib/emails";
import { env } from "@/lib/zod-env";
import { auth } from "@/server/auth/better-auth";
import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import {
  createInvitation as createInvitationFn,
  fetchInvitationByToken as fetchInvitationByTokenFn,
} from "@/server/inviting/data";
import { setBetterAuthCookie } from "@/server/shared/utils.server";
import {
  addUserToWorkspace,
  getWorkspaceBySlug,
} from "@/server/workspace/data";
import InviteEmail from "@/server/workspace/emails/invite.email";
import { redirect } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { getUserById } from "../auth/data";

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      email: z.email(),
    }),
  )
  .handler(async ({ data, context }) => {
    const workspace = await getWorkspaceBySlug(data.workspaceSlug);

    const invitation = await createInvitationFn({
      user: context.user,
      workspace,
      email: data.email,
    });

    const invitationUrl = `${env.APP_BASE_URL}/invite/${invitation.token}`;

    await sendEmail({
      to: data.email,
      subject: "You've been invited to Blackwall",
      text: `You've been invited to Blackwall. Join using this URL - ${invitationUrl}`,
      html: renderEmail(
        InviteEmail({
          workspace,
          invitationUrl,
          email: data.email,
          invitatingUser: context.user,
        }),
      ),
    });

    return {
      message: "Invitation sent successfully.",
      invitation,
      invitationUrl,
    };
  });

export const fetchInvitation = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      token: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    redirect({
      to: "/",
    });
    const invitation = await fetchInvitationByTokenFn(data.token);

    return invitation;
  });

/**
 * For users who don't have an account
 */
export const registerAndAcceptInvitation = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      token: z.string(),
      name: z.string().min(2, "Name is required"),
      password: z.string().min(8, "Password must be at least 8 characters"),
    }),
  )
  .handler(async ({ data }) => {
    const invitation = await fetchInvitationByTokenFn(data.token);

    const { response: registerResult, headers } = await auth.api.signUpEmail({
      body: {
        email: invitation.email,
        name: data.name,
        password: data.password,
      },
      returnHeaders: true,
    });

    const user = await getUserById(registerResult.user.id);

    await addUserToWorkspace({
      userId: user.id,
      workspaceSlug: invitation.workspace.slug,
    });

    // await InvitationMutations.deleteInvitation(invitation.id);

    console.log({
      registerResult,
      user,
      invitation,
    });

    setBetterAuthCookie(headers.get("set-cookie"));

    return {
      user,
    };
  });

/**
 * For users who already have an account
 */
export const acceptInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      token: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const invitation = await fetchInvitationByTokenFn(data.token);

    await addUserToWorkspace({
      userId: context.user.id,
      workspaceSlug: invitation.workspace.slug,
    });

    return {
      user: context.user,
    };
  });
