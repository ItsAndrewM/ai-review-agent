import { Type } from "typebox"
import { Value } from "typebox/value"

const ApiStatus = Type.Object({
  success: Type.Boolean(),
  errors: Type.Optional(Type.Array(Type.Object({ code: Type.Integer(), message: Type.String() }))),
})

export async function checkWorkersAiAccess(account: string, token: string, request: typeof fetch): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=1`
  const response = await request(url, { headers: { Authorization: `Bearer ${token}` } })
  if (response.status === 401 || response.status === 403)
    throw new Error("The API token lacks Workers AI permission for this account; no model call made.")
  const body = await response.json()
  if (!Value.Check(ApiStatus, body) || !response.ok || !body.success)
    throw new Error(`Workers AI access preflight failed with HTTP ${response.status}; no model call made.`)
}
