import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins, loadEnv } from "vite-plus";

export default defineConfig(({ mode }) => {
  // Worktrees run the API on their own port, set in the repository's .env.
  const api = `http://${loadEnv(mode, "..", "").BIND_ADDR ?? "127.0.0.1:3000"}`;
  return {
    test: { globalSetup: ["./app/sync/contract/setup.ts"] },
    fmt: {},
    lint: {
      plugins: ["react", "react-perf"],
      jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
      rules: { "vite-plus/prefer-vite-plus-imports": "error" },
      categories: {
        correctness: "error",
      },
      options: { typeAware: true, typeCheck: true },
    },
    plugins: lazyPlugins(() => [tailwindcss(), reactRouter()]),
    resolve: { tsconfigPaths: true },
    server: {
      proxy: {
        "/api": { target: api, changeOrigin: false },
        "/health": { target: api, changeOrigin: false },
      },
    },
  };
});
