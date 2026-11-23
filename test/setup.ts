import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
