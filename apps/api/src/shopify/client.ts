import { config } from "../config.js";
import { logger } from "../lib/logger.js";

/**
 * Shopify Admin GraphQL Client für eine Dev-Dashboard-App im eigenen Shop.
 * Token per Client Credentials Grant (24 h gültig, wird vor Ablauf erneuert).
 * Doku: shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
 */
export class ShopifyClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly shopDomain: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(): ShopifyClient {
    const c = config();
    if (!c.SHOPIFY_SHOP_DOMAIN || !c.SHOPIFY_CLIENT_ID || !c.SHOPIFY_CLIENT_SECRET) {
      throw new Error("Shopify nicht konfiguriert (SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)");
    }
    return new ShopifyClient(c.SHOPIFY_SHOP_DOMAIN, c.SHOPIFY_CLIENT_ID, c.SHOPIFY_CLIENT_SECRET, c.SHOPIFY_API_VERSION);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 5 * 60_000 > Date.now()) return this.token.value;
    const res = await this.fetchImpl(`https://${this.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`Shopify-Token-Anfrage fehlgeschlagen: HTTP ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  /** GraphQL mit Retry bei Throttling (429/THROTTLED) und 5xx, exponentielles Backoff */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}, maxRetries = 5): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await this.fetchImpl(`https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await this.accessToken() },
        body: JSON.stringify({ query, variables }),
      });
      const retryable = res.status === 429 || res.status >= 500;
      if (res.status === 401) this.token = null;
      if (!res.ok && !(retryable && attempt <= maxRetries)) throw new Error(`Shopify GraphQL HTTP ${res.status}: ${await res.text()}`);
      if (res.ok) {
        const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
        const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
        if (!throttled) {
          if (json.errors?.length) throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
          return json.data as T;
        }
        if (attempt > maxRetries) throw new Error("Shopify GraphQL: dauerhaft gedrosselt");
      }
      const wait = Math.min(30_000, 500 * 2 ** attempt);
      logger.warn({ attempt, wait, status: res.status }, "Shopify-Anfrage wird wiederholt");
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
