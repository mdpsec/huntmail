import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, API_KEY: "a7c3e9f1b2d4068e5f7a9c1b3d5e7f9012345678abcdef0123456789abcdef01", BASE_PATH: "p7f3a9c2e8b14d6f0a5c", FORWARD_TO: "" },
        },
      }),
    ],
    // Heavy tests take about 1 s; leave room for a busy machine.
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 20_000 },
  };
});
