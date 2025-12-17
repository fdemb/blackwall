import { renderEmail, sendEmail } from "@/lib/emails";
import { env } from "@/lib/zod-env";
import { redirect } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { auth } from "../auth/better-auth";
import { AuthQueries } from "../auth/dal/queries";
import { authMiddleware } from "../auth/middleware/auth.middleware";
import { setBetterAuthCookie } from "../shared/utils.server";
import { WorkspaceMutations } from "../workspaces/dal/mutations";
import { WorkspaceQueries } from "../workspaces/dal/queries";
import InviteEmail from "../workspaces/emails/invite.email";
import { InvitationMutations } from "./dal/mutations";
import { InvitationQueries } from "./dal/queries";

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      email: z.email(),
    }),
  )
  .handler(async ({ data, context }) => {
    const workspace = await WorkspaceQueries.getBySlug(data.workspaceSlug);

    const invitation = await InvitationMutations.create({
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
    const invitation = await InvitationQueries.fetchByToken(data.token);

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
    const invitation = await InvitationQueries.fetchByToken(data.token);

    const { response: registerResult, headers } = await auth.api.signUpEmail({
      body: {
        email: invitation.email,
        name: data.name,
        password: data.password,
      },
      returnHeaders: true,
    });

    const user = await AuthQueries.getUser(registerResult.user.id);

    await WorkspaceMutations.addUser({
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
    const invitation = await InvitationQueries.fetchByToken(data.token);

    await WorkspaceMutations.addUser({
      userId: context.user.id,
      workspaceSlug: invitation.workspace.slug,
    });

    return {
      user: context.user,
    };
  });
