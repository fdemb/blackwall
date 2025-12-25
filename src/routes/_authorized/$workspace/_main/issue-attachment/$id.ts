import { getFile } from "@/lib/file-upload";
import { getAttachmentForDownload } from "@/server/issues/attachments.api";
import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute(
  "/_authorized/$workspace/_main/issue-attachment/$id",
)({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const attachment = await getAttachmentForDownload({
          data: { attachmentId: params.id },
        });

        if (!attachment) {
          return new Response("Not found", { status: 404 });
        }

        const { file, exists } = await getFile(attachment.filePath);

        if (!exists) {
          return new Response("File not found", { status: 404 });
        }

        return new Response(file, {
          headers: {
            "Content-Type": attachment.mimeType,
            "Content-Disposition": `inline; filename="${attachment.originalFileName}"`,
          },
        });
      },
    },
  },
});
