import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/uploaded-files/$")({
	loader(ctx) {
		console.log(ctx.params._splat);
	},
	server: {
		handlers: {
			GET: async ({ params }) => {
				const file = Bun.file(`blackwall_data/uploads/${params._splat}`);
				const exists = await file.exists();

				if (!exists) {
					return new Response("File not found", { status: 404 });
				}

				return new Response(file);
			},
		},
	},
});
