import type { Workspace, WorkspaceInvitation } from "@/db/schema";
import { defineWorker } from "plainjob";
import queue, { noDebugLogger } from "./src/lib/queueing";

type WorkspaceInviteEmailJobData = {
  workspace: Workspace;
  invitation: WorkspaceInvitation;
  invitationUrl: string;
};

const worker = defineWorker(
  "general",
  async (job) => {
    const data = JSON.parse(job.data);

    if (data.type === "workspace-invite-email") {
      const { workspace, invitation, invitationUrl } =
        data.data as WorkspaceInviteEmailJobData;
    }
  },
  { queue, logger: noDebugLogger },
);

worker.start();
