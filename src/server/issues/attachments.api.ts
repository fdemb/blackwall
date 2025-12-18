import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { createServerFn } from "@tanstack/solid-start";

export const uploadAttachment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data) => {
    if (!(data instanceof FormData)) {
      throw new Error("Expected FormData");
    }

    return {
      file: data.get("file") as File,
    };
  })
  .handler(async ({ data, context }) => {
    console.log(data.file);
  });
