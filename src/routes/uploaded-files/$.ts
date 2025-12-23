import { getFile } from "@/lib/file-upload";
import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/uploaded-files/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { file, exists } = await getFile(
          `blackwall_data/uploads/public/${params._splat}`,
        );

        if (!exists) {
          return new Response("File not found", { status: 404 });
        }

        return new Response(file);
      },
    },
  },
});
