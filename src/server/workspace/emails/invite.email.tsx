import EmailButton from "@/components/emails/email-button";
import EmailHeading from "@/components/emails/email-heading";
import EmailShell from "@/components/emails/email-shell";
import EmailText from "@/components/emails/email-text";
import type { User, Workspace } from "@/db/schema";

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
