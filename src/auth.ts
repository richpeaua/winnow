// P2: headless HTTP auth token sources for the Streamable-HTTP upstream.
// All browserless — a gateway/agent running unattended never opens a browser.
export type BearerProvider = () => Promise<string | undefined>;

/** Static pre-provisioned bearer (config `auth.type: "bearer"`). */
export function staticBearer(token?: string): BearerProvider {
  return async () => token;
}

/**
 * Pre-provisioned OAuth (config `auth.type: "oauth"`): `tokens` is either a raw
 * access token or a JSON token set `{ access_token, ... }`. We already hold a
 * valid token, so we use its access token directly as the Bearer — no flow.
 */
export function preProvisionedOAuth(tokens: string): BearerProvider {
  let access: string | undefined;
  try {
    const parsed = JSON.parse(tokens);
    access = parsed.access_token ?? parsed.accessToken ?? undefined;
  } catch {
    access = tokens; // not JSON -> treat the whole string as the access token
  }
  return async () => access;
}

export interface ClientCredentialsConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scope?: string;
}

/**
 * OAuth 2.0 client_credentials grant (config `auth.type: "client_credentials"`):
 * POST client id/secret to the token endpoint, cache the access token, and
 * refresh it when it nears expiry. Fully machine-to-machine.
 */
export function clientCredentials(cfg: ClientCredentialsConfig, now: () => number = Date.now): BearerProvider {
  let token: string | undefined;
  let expiresAt = 0;
  return async () => {
    const t = now();
    if (token && t < expiresAt - 30_000) return token; // 30s safety buffer
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    if (cfg.scope) body.set("scope", cfg.scope);
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`client_credentials token request failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    token = json.access_token;
    expiresAt = t + (json.expires_in ?? 3600) * 1000;
    return token;
  };
}
