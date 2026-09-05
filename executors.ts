import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { storeDrafts, stackItems, recommendations } from "@/lib/db/schema";
import { registerExecutor } from "@/lib/approvals";
import {
  createProductDraft,
  updateProduct,
  createPage,
  createCollection,
  createDiscountDraft,
  createNavigationMenu,
  setSeoMetafields,
  putThemeAsset,
  registerWebhooks,
} from "@/lib/shopify";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";

/**
 * Every external write the system is capable of, in one file.
 *
 * These functions are only ever reached from executeApproved(), which means
 * each one has a recorded human decision, an idempotency key, and a kill-switch
 * check in front of it. Nothing here is callable from a page, an action or an
 * agent directly.
 */

let registered = false;

export function registerAllExecutors(): void {
  if (registered) return;
  registered = true;

  /** Shopify writes are additionally gated by the shopifyWrites feature flag. */
  const guardFlag = async (storeId: string) => {
    const flags = await getSetting({ storeId }, "feature_flags");
    if (!flags.shopifyWrites) {
      throw new Error(
        "Shopify write actions are disabled by feature flag. Turn on 'Shopify write actions' in Settings once you have tested against the development store.",
      );
    }
  };

  registerExecutor("shopify.create_product_draft", async (payload) => {
    const p = payload as {
      storeId: string;
      draftId?: string;
      title: string;
      bodyHtml: string;
      priceCents: number;
      sku?: string;
      vendor?: string;
      productType?: string;
      tags?: string;
    };
    await guardFlag(p.storeId);
    const product = await createProductDraft({
      title: p.title,
      body_html: p.bodyHtml,
      vendor: p.vendor,
      product_type: p.productType,
      tags: p.tags,
      variants: [{ price: (p.priceCents / 100).toFixed(2), sku: p.sku }],
    });
    if (p.draftId) {
      await db
        .update(storeDrafts)
        .set({ status: "published", shopifyResourceId: String(product.id) })
        .where(eq(storeDrafts.id, p.draftId));
    }
    return { productId: product.id, handle: product.handle, status: "draft" };
  });

  registerExecutor("shopify.update_product", async (payload) => {
    const p = payload as { storeId: string; productId: string; fields: Record<string, unknown>; draftId?: string };
    await guardFlag(p.storeId);
    const res = await updateProduct(p.productId, p.fields);
    if (p.draftId) {
      await db.update(storeDrafts).set({ status: "published" }).where(eq(storeDrafts.id, p.draftId));
    }
    return { productId: res.id };
  });

  registerExecutor("shopify.create_page", async (payload) => {
    const p = payload as { storeId: string; title: string; bodyHtml: string; handle?: string; draftId?: string };
    await guardFlag(p.storeId);
    const page = await createPage({ title: p.title, body_html: p.bodyHtml, handle: p.handle });
    if (p.draftId) {
      await db
        .update(storeDrafts)
        .set({ status: "published", shopifyResourceId: String(page.id) })
        .where(eq(storeDrafts.id, p.draftId));
    }
    return { pageId: page.id, handle: page.handle, published: false };
  });

  registerExecutor("shopify.create_collection", async (payload) => {
    const p = payload as { storeId: string; title: string; bodyHtml?: string };
    await guardFlag(p.storeId);
    const c = await createCollection({ title: p.title, body_html: p.bodyHtml });
    return { collectionId: c.id, published: false };
  });

  registerExecutor("shopify.create_navigation_menu", async (payload) => {
    const p = payload as { storeId: string; title: string; handle: string; items: Array<{ title: string; url: string }> };
    await guardFlag(p.storeId);
    const menu = await createNavigationMenu(p);
    return { menuId: menu.id };
  });

  registerExecutor("shopify.set_seo", async (payload) => {
    const p = payload as {
      storeId: string;
      ownerType: "product" | "page";
      ownerId: string;
      title: string;
      description: string;
    };
    await guardFlag(p.storeId);
    await setSeoMetafields(p.ownerType, p.ownerId, { title: p.title, description: p.description });
    return { ok: true };
  });

  registerExecutor("shopify.create_discount_draft", async (payload) => {
    const p = payload as {
      storeId: string;
      title: string;
      code: string;
      valueType: "percentage" | "fixed_amount";
      value: number;
      startsAt: string;
      endsAt?: string;
      usageLimit?: number;
    };
    await guardFlag(p.storeId);
    const d = await createDiscountDraft(p);
    return d as unknown as Record<string, unknown>;
  });

  registerExecutor("shopify.put_theme_asset", async (payload) => {
    const p = payload as { storeId: string; themeId: string; key: string; value: string };
    await guardFlag(p.storeId);
    await putThemeAsset(p.themeId, p.key, p.value);
    return { themeId: p.themeId, key: p.key, bytes: p.value.length };
  });

  registerExecutor("shopify.register_webhooks", async (payload) => {
    const p = payload as { storeId: string };
    await guardFlag(p.storeId);
    const url = `${env().APP_URL.replace(/\/$/, "")}/api/webhooks/shopify`;
    const res = await registerWebhooks(url);
    return { callbackUrl: url, ...res };
  });

  /** Marks an app as approved for installation. Installation itself is manual and stays that way. */
  registerExecutor("stack.approve_app", async (payload) => {
    const p = payload as { stackItemId: string };
    await db.update(stackItems).set({ status: "approved" }).where(eq(stackItems.id, p.stackItemId));
    return { stackItemId: p.stackItemId, status: "approved", note: "Install manually from the App Store listing." };
  });

  registerExecutor("recommendation.accept", async (payload) => {
    const p = payload as { recommendationId: string };
    await db.update(recommendations).set({ status: "accepted" }).where(eq(recommendations.id, p.recommendationId));
    return { recommendationId: p.recommendationId, status: "accepted" };
  });

  /** Explicit no-op used by the Phase 1 pipeline test. */
  registerExecutor("test.noop", async (payload) => ({ echoed: payload, note: "No external system was touched." }));
}
