// Secrets are not in wrangler.jsonc, so `wrangler types` does not know them.
interface Env {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
}
