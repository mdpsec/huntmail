// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface __BaseEnv_Env {
  API_KEY: string;
  BASE_PATH: string;
}
