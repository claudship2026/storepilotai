import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { withRetry } from "@/lib/ratelimit";

/**
 * Shopify Admin API client.
 *
 * Read calls may be made freely. Write calls are only ever reached from an
 * executor registered against the approval queue, so nothing in this file is
 * callable without a recorded human decision upstream.
 */

export class ShopifyNotConfiguredError extends Error {
  constructor() {
    super(
      "Shopify is not connected. Add SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN and " +
        "SHOPIFY_API_SECRET to .env, then reload.",
    );
  }
}

export function shopifyConfigured(): boolean {
  const c = env();
  return Boolean(c.SHOPIFY_STORE_DOMAIN && c.SHOPIFY_ADMIN_ACCESS_TOKEN);
}

function base(): string {
  const c = env();
  if (!shopifyConfigured()) throw new ShopifyNotConfiguredError();
  const domain = c.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${c.SHOPIFY_API_VERSION}`;
}

type RestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
};

export async function shopifyRest<T = unknown>(path: string, opts: RestOptions = {}): Promise<T> {
  const url = new URL(`${base()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "X-Shopify-Access-Token": env().SHOPIFY_ADMIN_ACCESS_TOKEN,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "2");
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        const err = new Error("Shopify rate limit") as Error & { status: number };
        err.status = 429;
        throw err;
      }

      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Shopify ${res.status} on ${path}: ${text.slice(0, 400)}`) as Error & {
          status: number;
        };
        err.status = res.status;
        throw err;
      }

      return (await res.json()) as T;
    },
    { attempts: 4, baseMs: 700, label: `shopify:${path}` },
  );
}

export async function shopifyGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await withRetry(
    async () => {
      const r = await fetch(`${base()}/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": env().SHOPIFY_ADMIN_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
      });
      if (!r.ok) {
        const err = new Error(`Shopify GraphQL ${r.status}: ${(await r.text()).slice(0, 400)}`) as Error & {
          status: number;
        };
        err.status = r.status;
        throw err;
      }
      return (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
    },
    { attempts: 3, baseMs: 700, label: "shopify:graphql" },
  );

  if (res.errors?.length) throw new Error(`Shopify GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
  return res.data as T;
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

/** Constant-time HMAC-SHA256 verification against the raw body. */
export function verifyWebhookHmac(rawBody: string, headerHmac: string | null): boolean {
  const secret = env().SHOPIFY_API_SECRET;
  if (!secret || !headerHmac) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(headerHmac);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const WEBHOOK_TOPICS = [
  "orders/create",
  "orders/paid",
  "orders/updated",
  "orders/cancelled",
  "orders/fulfilled",
  "orders/partially_fulfilled",
  "fulfillments/create",
  "fulfillments/update",
  "refunds/create",
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
  "app/uninstalled",
  "shop/update",
] as const;

export async function registerWebhooks(callbackUrl: string): Promise<{ registered: string[]; failed: string[] }> {
  const existing = await shopifyRest<{ webhooks: Array<{ topic: string; address: string; id: number }> }>(
    "webhooks.json",
    { query: { limit: 250 } },
  );
  const have = new Set(existing.webhooks.filter((w) => w.address === callbackUrl).map((w) => w.topic));

  const registered: string[] = [];
  const failed: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (have.has(topic)) {
      registered.push(topic);
      continue;
    }
    try {
      await shopifyRest("webhooks.json", {
        method: "POST",
        body: { webhook: { topic, address: callbackUrl, format: "json" } },
      });
      registered.push(topic);
    } catch (e) {
      log.warn("webhook registration failed", { topic, error: (e as Error).message });
      failed.push(topic);
    }
  }
  return { registered, failed };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export type ShopifyOrder = {
  id: number;
  name: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string;
  subtotal_price: string;
  total_shipping_price_set?: { shop_money: { amount: string } };
  total_tax: string;
  total_discounts: string;
  total_price: string;
  created_at: string;
  processed_at: string | null;
  cancelled_at: string | null;
  customer?: { id: number } | null;
  shipping_address?: { country_code?: string } | null;
  line_items: Array<{
    id: number;
    sku: string | null;
    title: string;
    variant_title: string | null;
    quantity: number;
    price: string;
  }>;
  fulfillments?: Array<{
    id: number;
    status: string | null;
    tracking_company: string | null;
    tracking_number: string | null;
    created_at: string;
  }>;
  refunds?: Array<{
    id: number;
    created_at: string;
    note: string | null;
    transactions?: Array<{ amount: string }>;
  }>;
};

export async function fetchOrders(sinceIso: string, limit = 250): Promise<ShopifyOrder[]> {
  const out: ShopifyOrder[] = [];
  let pageInfo: string | undefined;

  for (let page = 0; page < 10; page++) {
    const res = await shopifyRest<{ orders: ShopifyOrder[] }>("orders.json", {
      query: pageInfo
        ? { limit, page_info: pageInfo }
        : { limit, status: "any", updated_at_min: sinceIso },
    });
    out.push(...res.orders);
    if (res.orders.length < limit) break;
    pageInfo = undefined; // conservative: one page per sync unless cursors are wired
    break;
  }
  return out;
}

export type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  status: string;
  variants: Array<{
    id: number;
    sku: string | null;
    title: string;
    price: string;
    inventory_quantity: number | null;
  }>;
};

export async function fetchProducts(limit = 250): Promise<ShopifyProduct[]> {
  const res = await shopifyRest<{ products: ShopifyProduct[] }>("products.json", { query: { limit } });
  return res.products;
}

export async function fetchShop(): Promise<{ name: string; domain: string; currency: string; iana_timezone: string }> {
  const res = await shopifyRest<{ shop: { name: string; domain: string; currency: string; iana_timezone: string } }>(
    "shop.json",
  );
  return res.shop;
}

/* ------------------------------------------------------------------ */
/* Writes - only reachable through a registered executor               */
/* ------------------------------------------------------------------ */

export async function createProductDraft(payload: {
  title: string;
  body_html: string;
  vendor?: string;
  product_type?: string;
  tags?: string;
  variants?: Array<{ price: string; sku?: string; inventory_management?: string | null }>;
}): Promise<{ id: number; handle: string }> {
  const res = await shopifyRest<{ product: { id: number; handle: string } }>("products.json", {
    method: "POST",
    body: { product: { ...payload, status: "draft" } },
  });
  return res.product;
}

export async function updateProduct(
  productId: string,
  payload: Record<string, unknown>,
): Promise<{ id: number }> {
  const res = await shopifyRest<{ product: { id: number } }>(`products/${productId}.json`, {
    method: "PUT",
    body: { product: { id: Number(productId), ...payload } },
  });
  return res.product;
}

export async function createPage(payload: {
  title: string;
  body_html: string;
  handle?: string;
  published?: boolean;
}): Promise<{ id: number; handle: string }> {
  const res = await shopifyRest<{ page: { id: number; handle: string } }>("pages.json", {
    method: "POST",
    body: { page: { published: false, ...payload } },
  });
  return res.page;
}

export async function createCollection(payload: {
  title: string;
  body_html?: string;
  published?: boolean;
}): Promise<{ id: number }> {
  const res = await shopifyRest<{ custom_collection: { id: number } }>("custom_collections.json", {
    method: "POST",
    body: { custom_collection: { published: false, ...payload } },
  });
  return res.custom_collection;
}

export async function setSeoMetafields(
  ownerType: "product" | "page",
  ownerId: string,
  seo: { title: string; description: string },
): Promise<void> {
  const path = ownerType === "product" ? `products/${ownerId}/metafields.json` : `pages/${ownerId}/metafields.json`;
  for (const [key, value] of [
    ["title_tag", seo.title],
    ["description_tag", seo.description],
  ] as const) {
    await shopifyRest(path, {
      method: "POST",
      body: { metafield: { namespace: "global", key, value, type: "single_line_text_field" } },
    });
  }
}

export async function createDiscountDraft(payload: {
  title: string;
  code: string;
  valueType: "percentage" | "fixed_amount";
  value: number;
  startsAt: string;
  endsAt?: string;
  usageLimit?: number;
}): Promise<{ priceRuleId: number; discountCodeId: number }> {
  const rule = await shopifyRest<{ price_rule: { id: number } }>("price_rules.json", {
    method: "POST",
    body: {
      price_rule: {
        title: payload.title,
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        value_type: payload.valueType,
        value: `-${Math.abs(payload.value)}`,
        customer_selection: "all",
        starts_at: payload.startsAt,
        ends_at: payload.endsAt ?? null,
        usage_limit: payload.usageLimit ?? null,
      },
    },
  });
  const code = await shopifyRest<{ discount_code: { id: number } }>(
    `price_rules/${rule.price_rule.id}/discount_codes.json`,
    { method: "POST", body: { discount_code: { code: payload.code } } },
  );
  return { priceRuleId: rule.price_rule.id, discountCodeId: code.discount_code.id };
}

export async function createNavigationMenu(payload: {
  title: string;
  handle: string;
  items: Array<{ title: string; url: string }>;
}): Promise<{ id: string }> {
  const data = await shopifyGraphql<{ menuCreate: { menu: { id: string } | null; userErrors: Array<{ message: string }> } }>(
    `mutation menuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
       menuCreate(title: $title, handle: $handle, items: $items) {
         menu { id }
         userErrors { message }
       }
     }`,
    {
      title: payload.title,
      handle: payload.handle,
      items: payload.items.map((i) => ({ title: i.title, type: "HTTP", url: i.url })),
    },
  );
  if (data.menuCreate.userErrors?.length) {
    throw new Error(data.menuCreate.userErrors.map((e) => e.message).join("; "));
  }
  return { id: data.menuCreate.menu!.id };
}

/** Writes a theme asset (a section or a settings file). Highest-blast-radius write in the system. */
export async function putThemeAsset(themeId: string, key: string, value: string): Promise<void> {
  await shopifyRest(`themes/${themeId}/assets.json`, {
    method: "PUT",
    body: { asset: { key, value } },
  });
}

export async function listThemes(): Promise<Array<{ id: number; name: string; role: string }>> {
  const res = await shopifyRest<{ themes: Array<{ id: number; name: string; role: string }> }>("themes.json");
  return res.themes;
}
