import crypto from "node:crypto"
import fs from "node:fs"
/**
 * Registers the GitHub App from a manifest, so GitHub generates the webhook
 * secret and private key and hands them to this script instead of a form and
 * a download. Run it, open http://localhost:8790/ in a browser signed in to
 * GitHub, and confirm. The App's id, slug, private key and webhook secret are
 * written to the output file (mode 600), ready for scripts/set-secrets.sh.
 *
 *   node scripts/register-app.mjs <out.json> [name] [webhook url] [homepage]
 */
import http from "node:http"

const [
  ,
  ,
  outPath,
  name = "andabot",
  webhookUrl = "https://andabot.dinocode.workers.dev/webhook",
  homepage = "https://github.com/ItsAndrewM/ai-review-agent",
] = process.argv
if (!outPath) {
  console.error("usage: node scripts/register-app.mjs <out.json> [name] [webhook url] [homepage]")
  process.exit(2)
}
const port = 8790
const state = crypto.randomBytes(16).toString("hex")
const manifest = {
  name,
  url: homepage,
  description: `A self-hosted pull request reviewer: summary, inline findings, request changes and approve. Tag @${name} in a pull request.`,
  hook_attributes: { url: webhookUrl, active: true },
  redirect_url: `http://localhost:${port}/callback`,
  public: false,
  // check_suite needs checks: read, or GitHub rejects the manifest.
  default_permissions: { pull_requests: "write", contents: "read", issues: "write", checks: "read", metadata: "read" },
  default_events: [
    "pull_request",
    "issue_comment",
    "pull_request_review_comment",
    "pull_request_review_thread",
    "check_suite",
  ],
}
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`)
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(`<!doctype html><title>Register ${escapeHtml(name)}</title><body style="font-family:system-ui;padding:2rem">
<form id="f" action="https://github.com/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Register ${escapeHtml(name)} on GitHub</button></form>
<script>document.getElementById("f").submit()</script>`)
    return
  }
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code")
    if (url.searchParams.get("state") !== state || !code) {
      res.writeHead(400)
      res.end("bad state or code")
      return
    }
    const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": `${name}-setup` },
    })
    const body = await r.json()
    if (!r.ok) {
      console.error("conversion failed", r.status, JSON.stringify(body))
      res.writeHead(500)
      res.end("conversion failed; see the terminal")
      return
    }
    fs.writeFileSync(outPath, JSON.stringify(body, null, 2), { mode: 0o600 })
    console.log(`registered ${body.slug} (id ${body.id}) at ${body.html_url}; credentials in ${outPath}`)
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(
      `<!doctype html><title>Registered</title><body style="font-family:system-ui;padding:2rem"><h1>${escapeHtml(body.slug)} is registered</h1><p>App id ${body.id}. The key and webhook secret were saved locally. You can close this tab.</p>`,
    )
    server.close()
    server.closeAllConnections()
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(port, "127.0.0.1", () => console.log(`open http://localhost:${port}/ in a browser signed in to GitHub`))
