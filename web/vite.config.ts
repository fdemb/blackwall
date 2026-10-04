import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
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
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
});
