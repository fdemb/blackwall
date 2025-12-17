import type { User, Workspace } from "@/db/schema";
import EmailButton from "@/features/shared/components/emails/email-button";
import EmailHeading from "@/features/shared/components/emails/email-heading";
import EmailShell from "@/features/shared/components/emails/email-shell";
import EmailText from "@/features/shared/components/emails/email-text";

export default function InviteEmail(props: {
  workspace: Workspace;
  invitationUrl: string;
  invitatingUser: User;
  email: string;
}) {
  return (
    <EmailShell>
      <EmailHeading>You have been invited to Blackwall</EmailHeading>
      <EmailText>
        {props.invitatingUser.name} has invited you to join{" "}
        <span style="font-weight: bold">{props.workspace.displayName}</span>{" "}
        workspace on Blackwall. Click the link below to accept the invitation.
      </EmailText>
      <EmailButton href={props.invitationUrl}>
        Accept the invitation
      </EmailButton>
    </EmailShell>
  );
}
