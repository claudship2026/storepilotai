import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const userRole = pgEnum("user_role", [
  "founder",
  "ops",
  "support",
  "finance",
  "analyst",
]);

export const actorType = pgEnum("actor_type", ["user", "agent", "system"]);

export const riskLevel = pgEnum("risk_level", ["low", "medium", "high", "critical"]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "modified",
  "rejected",
  "info_requested",
  "expired",
]);

export const executionStatus = pgEnum("execution_status", [
  "pending",
  "succeeded",
  "failed",
  "blocked_by_kill_switch",
  "dead_lettered",
  "rolled_back",
]);

export const targetSystem = pgEnum("target_system", [
  "shopify",
  "internal",
  "email",
  "ads",
  "supplier",
]);

export const agentRunStatus = pgEnum("agent_run_status", [
  "completed",
  "needs_human_review",
  "blocked",
  "failed",
]);

export const modelTier = pgEnum("model_tier", ["cheap", "frontier"]);

/** Every fact the system holds carries one of these. Never display a number without it. */
export const provenance = pgEnum("provenance", [
  "verified",
  "supplier_provided",
  "estimated",
  "missing",
]);

export const researchStatus = pgEnum("research_status", [
  "draft",
  "running",
  "complete",
  "failed",
]);

export const recommendation = pgEnum("recommendation", [
  "pursue",
  "research_more",
  "avoid",
]);

export const evidenceKind = pgEnum("evidence_kind", [
  "manual_url",
  "supplier_url",
  "csv_upload",
  "pasted_reviews",
  "pasted_competitor",
  "manual_note",
  "web_search",
]);

/* ------------------------------------------------------------------ */
/* core: identity, settings, audit                                     */
/* ------------------------------------------------------------------ */

export const stores = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  shopifyDomain: text("shopify_domain"),
  currency: text("currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  targetCountry: text("target_country").notNull().default("US"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    email: text("email").notNull(),
    name: text("name"),
    role: userRole("role").notNull().default("founder"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

/** Key/value store for kill switch, feature flags, budgets, research defaults. */
export const settings = pgTable(
  "settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("settings_store_key_uq").on(t.storeId, t.key)],
);

/**
 * Insert-only. UPDATE and DELETE are revoked at the database level by
 * scripts/seed.ts. An action cannot exist without its audit row.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    actionType: text("action_type").notNull(),
    targetTable: text("target_table"),
    targetId: text("target_id"),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_store_created_idx").on(t.storeId, t.createdAt),
    index("audit_correlation_idx").on(t.correlationId),
    index("audit_target_idx").on(t.targetTable, t.targetId),
  ],
);

/* ------------------------------------------------------------------ */
/* approvals: the only path to an external write                       */
/* ------------------------------------------------------------------ */

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    agentRunId: uuid("agent_run_id"),
    actionType: text("action_type").notNull(),
    targetSystem: targetSystem("target_system").notNull(),
    summary: text("summary").notNull(),
    /** The exact payload that will be sent. Rendered as a diff in the UI. */
    proposedAction: jsonb("proposed_action").notNull(),
    /** Current state being replaced, so the operator sees before vs after. */
    currentState: jsonb("current_state"),
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    riskLevel: riskLevel("risk_level").notNull().default("medium"),
    financialImpactMinCents: integer("financial_impact_min_cents"),
    financialImpactMaxCents: integer("financial_impact_max_cents"),
    rollbackPlan: text("rollback_plan").notNull(),
    recommendedDecision: text("recommended_decision"),
    alternatives: jsonb("alternatives"),
    deadline: timestamp("deadline", { withTimezone: true }),
    status: approvalStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("approvals_queue_idx").on(t.storeId, t.status, t.riskLevel, t.createdAt),
  ],
);

export const approvalDecisions = pgTable("approval_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  approvalRequestId: uuid("approval_request_id")
    .notNull()
    .references(() => approvalRequests.id),
  decidedBy: uuid("decided_by")
    .notNull()
    .references(() => users.id),
  decision: approvalStatus("decision").notNull(),
  modifiedPayload: jsonb("modified_payload"),
  note: text("note"),
  /** Drives the rubber-stamp metric: decisions under 5s are flagged. */
  latencySeconds: integer("latency_seconds").notNull().default(0),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actionExecutions = pgTable(
  "action_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id),
    actionType: text("action_type").notNull(),
    targetSystem: targetSystem("target_system").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    responsePayload: jsonb("response_payload"),
    status: executionStatus("status").notNull().default("pending"),
    rollbackPlan: jsonb("rollback_plan"),
    stateHashAtApproval: text("state_hash_at_approval"),
    stateHashAtExecution: text("state_hash_at_execution"),
    error: text("error"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("executions_idempotency_uq").on(t.idempotencyKey)],
);

/* ------------------------------------------------------------------ */
/* agent: Claude runs, validation, cost                                */
/* ------------------------------------------------------------------ */

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    agentName: text("agent_name").notNull(),
    model: text("model").notNull(),
    modelTier: modelTier("model_tier").notNull(),
    promptVersion: text("prompt_version").notNull().default("v1"),
    inputRefs: jsonb("input_refs"),
    output: jsonb("output"),
    status: agentRunStatus("status").notNull(),
    schemaValid: boolean("schema_valid").notNull().default(false),
    repairAttempted: boolean("repair_attempted").notNull().default(false),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: numeric("cost_cents", { precision: 12, scale: 4 }).notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_runs_idx").on(t.storeId, t.agentName, t.startedAt),
    index("agent_runs_correlation_idx").on(t.correlationId),
  ],
);

export const llmUsageDaily = pgTable(
  "llm_usage_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    usageDate: date("usage_date").notNull(),
    agentName: text("agent_name").notNull(),
    model: text("model").notNull(),
    runs: integer("runs").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: numeric("cost_cents", { precision: 12, scale: 4 }).notNull().default("0"),
  },
  (t) => [
    uniqueIndex("llm_usage_uq").on(t.storeId, t.usageDate, t.agentName, t.model),
  ],
);

/* ------------------------------------------------------------------ */
/* research + suppliers (populated in Phases 2-3, defined now so the    */
/* schema is pushed once)                                              */
/* ------------------------------------------------------------------ */

export const researchProjects = pgTable(
  "research_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    name: text("name").notNull(),
    niche: text("niche").notNull(),
    targetCountry: text("target_country").notNull(),
    targetPriceCents: integer("target_price_cents").notNull(),
    maxLandedCostCents: integer("max_landed_cost_cents").notNull(),
    minGrossMarginBps: integer("min_gross_margin_bps").notNull(),
    maxShippingDays: integer("max_shipping_days").notNull(),
    customerType: text("customer_type").notNull(),
    avoidCategories: jsonb("avoid_categories").notNull().default(sql`'[]'::jsonb`),
    launchBudgetCents: integer("launch_budget_cents").notNull(),
    status: researchStatus("status").notNull().default("draft"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("research_projects_store_idx").on(t.storeId, t.createdAt)],
);

export const evidenceItems = pgTable(
  "evidence_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => researchProjects.id),
    kind: evidenceKind("kind").notNull(),
    label: text("label").notNull(),
    url: text("url"),
    content: text("content"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("evidence_project_idx").on(t.projectId)],
);

export const productOpportunities = pgTable(
  "product_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => researchProjects.id),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
    name: text("name").notNull(),
    opportunityScore: integer("opportunity_score").notNull(),
    /** Full validated agent payload. Every field carries its own provenance. */
    analysis: jsonb("analysis").notNull(),
    recommendation: recommendation("recommendation").notNull(),
    suggestedPriceCents: integer("suggested_price_cents"),
    estimatedLandedCostCents: integer("estimated_landed_cost_cents"),
    grossMarginBps: integer("gross_margin_bps"),
    breakEvenCacCents: integer("break_even_cac_cents"),
    isSelected: boolean("is_selected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("opportunities_project_idx").on(t.projectId, t.opportunityScore)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    opportunityId: uuid("opportunity_id").references(() => productOpportunities.id),
    name: text("name").notNull(),
    source: text("source").notNull(),
    productUrl: text("product_url"),
    productCostCents: integer("product_cost_cents"),
    shippingCostCents: integer("shipping_cost_cents"),
    deliveryDaysMin: integer("delivery_days_min"),
    deliveryDaysMax: integer("delivery_days_max"),
    processingDays: integer("processing_days"),
    fulfillmentOrigin: text("fulfillment_origin"),
    inventoryStatus: text("inventory_status"),
    trackingAvailable: boolean("tracking_available"),
    rating: numeric("rating", { precision: 3, scale: 2 }),
    reviewCount: integer("review_count"),
    qualitySignals: text("quality_signals"),
    defectRiskNote: text("defect_risk_note"),
    brandingAvailable: boolean("branding_available"),
    communicationNote: text("communication_note"),
    sampleAvailable: boolean("sample_available"),
    integrationAvailable: text("integration_available"),
    /** Per-field provenance map: { productCostCents: "verified", rating: "supplier_provided", ... } */
    fieldProvenance: jsonb("field_provenance").notNull().default(sql`'{}'::jsonb`),
    reliabilityScore: integer("reliability_score"),
    landedCostCents: integer("landed_cost_cents"),
    profitPerOrderCents: integer("profit_per_order_cents"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isBackup: boolean("is_backup").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("suppliers_opportunity_idx").on(t.opportunityId)],
);

/** Written only when the operator clicks "Approve Product for Store Build". */
export const productDecisions = pgTable("product_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id),
  opportunityId: uuid("opportunity_id")
    .notNull()
    .references(() => productOpportunities.id),
  primarySupplierId: uuid("primary_supplier_id").references(() => suppliers.id),
  backupSupplierId: uuid("backup_supplier_id").references(() => suppliers.id),
  targetPriceCents: integer("target_price_cents").notNull(),
  deliveryEstimateMin: integer("delivery_estimate_min").notNull(),
  deliveryEstimateMax: integer("delivery_estimate_max").notNull(),
  /** The only facts Store Builder and Creative Studio may assert about the product. */
  claimsAllowed: jsonb("claims_allowed").notNull().default(sql`'[]'::jsonb`),
  claimsProhibited: jsonb("claims_prohibited").notNull().default(sql`'[]'::jsonb`),
  approvedBy: uuid("approved_by")
    .notNull()
    .references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ================================================================== */
/* PHASE 4-7                                                           */
/* ================================================================== */

export const draftKind = pgEnum("draft_kind", [
  "brand_identity",
  "homepage",
  "product_page",
  "bundles",
  "cart_upsells",
  "comparison",
  "benefits",
  "how_it_works",
  "specifications",
  "faq",
  "about",
  "contact",
  "shipping_policy",
  "refund_policy",
  "privacy_policy",
  "terms",
  "order_tracking_plan",
  "seo",
  "email_optin",
  "trust_sections",
  "mobile_structure",
  "photo_shot_list",
  "ugc_shot_list",
  "launch_checklist",
]);

export const draftStatus = pgEnum("draft_status", [
  "draft",
  "approved",
  "published",
  "rejected",
  "superseded",
]);

export const creativeKind = pgEnum("creative_kind", [
  "video_hook",
  "static_hook",
  "headline",
  "primary_text",
  "ugc_script",
  "demo_script",
  "problem_solution_script",
  "founder_story_script",
  "objection_angle",
  "retargeting_concept",
  "landing_angle",
  "offer_test",
  "ad_test_plan",
  "email_welcome",
  "email_abandoned_cart",
  "email_post_purchase",
  "email_review_request",
  "creator_outreach",
  "creator_brief",
  "photo_brief",
  "video_shot_list",
  "image_prompt",
  "storyboard_prompt",
]);

export const signalSeverity = pgEnum("signal_severity", ["info", "warning", "critical"]);

export const recommendationStatus = pgEnum("recommendation_status", [
  "open",
  "queued_for_approval",
  "accepted",
  "dismissed",
  "resolved",
]);

export const costType = pgEnum("cost_type", [
  "supplier_unit",
  "inbound_shipping",
  "packaging",
  "transaction_fee_rate",
  "transaction_fee_fixed",
  "operating_monthly",
]);

export const adChannel = pgEnum("ad_channel", ["meta", "tiktok", "google", "other"]);

export const stackStatus = pgEnum("stack_status", [
  "recommended",
  "approved",
  "installed",
  "declined",
]);

/* ---------------- Store build drafts ---------------- */

export const storeBuilds = pgTable(
  "store_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    decisionId: uuid("decision_id").notNull().references(() => productDecisions.id),
    brandName: text("brand_name"),
    status: text("status").notNull().default("drafting"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("store_builds_store_idx").on(t.storeId, t.createdAt)],
);

export const storeDrafts = pgTable(
  "store_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    buildId: uuid("build_id").notNull().references(() => storeBuilds.id),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
    kind: draftKind("kind").notNull(),
    title: text("title").notNull(),
    content: jsonb("content").notNull(),
    /** Claims asserted by this draft, each resolved against the approved claim list. */
    claimsUsed: jsonb("claims_used").notNull().default(sql`'[]'::jsonb`),
    complianceFindings: jsonb("compliance_findings").notNull().default(sql`'[]'::jsonb`),
    status: draftStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    shopifyResourceId: text("shopify_resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("store_drafts_build_idx").on(t.buildId, t.kind)],
);

/* ---------------- Creative ---------------- */

export const creativeBatches = pgTable("creative_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull().references(() => stores.id),
  decisionId: uuid("decision_id").notNull().references(() => productDecisions.id),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const creativeAssets = pgTable(
  "creative_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    batchId: uuid("batch_id").notNull().references(() => creativeBatches.id),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
    kind: creativeKind("kind").notNull(),
    title: text("title").notNull(),
    payload: jsonb("payload").notNull(),
    claimsUsed: jsonb("claims_used").notNull().default(sql`'[]'::jsonb`),
    complianceFindings: jsonb("compliance_findings").notNull().default(sql`'[]'::jsonb`),
    blocked: boolean("blocked").notNull().default(false),
    status: draftStatus("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("creative_assets_batch_idx").on(t.batchId, t.kind)],
);

/* ---------------- Shopify mirror ---------------- */

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    source: text("source").notNull().default("shopify"),
    topic: text("topic").notNull(),
    externalEventId: text("external_event_id").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    processingStatus: text("processing_status").notNull().default("pending"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_events_uq").on(t.storeId, t.source, t.externalEventId),
    index("webhook_events_status_idx").on(t.processingStatus, t.receivedAt),
  ],
);

export const shopProducts = pgTable(
  "shop_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    shopifyProductId: text("shopify_product_id").notNull(),
    title: text("title").notNull(),
    handle: text("handle"),
    status: text("status"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("shop_products_uq").on(t.storeId, t.shopifyProductId)],
);

export const shopVariants = pgTable(
  "shop_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    productId: uuid("product_id").notNull().references(() => shopProducts.id),
    shopifyVariantId: text("shopify_variant_id").notNull(),
    sku: text("sku"),
    title: text("title"),
    priceCents: integer("price_cents"),
    inventoryQuantity: integer("inventory_quantity"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("shop_variants_uq").on(t.storeId, t.shopifyVariantId)],
);

export const shopOrders = pgTable(
  "shop_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    shopifyOrderId: text("shopify_order_id").notNull(),
    orderNumber: text("order_number"),
    financialStatus: text("financial_status"),
    fulfillmentStatus: text("fulfillment_status"),
    currency: text("currency").notNull().default("USD"),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    shippingCents: integer("shipping_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    shippingCountry: text("shipping_country"),
    /** Hashed, never the raw address. Nothing here reaches a prompt. */
    customerRef: text("customer_ref"),
    placedAt: timestamp("placed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_orders_uq").on(t.storeId, t.shopifyOrderId),
    index("shop_orders_paid_idx").on(t.storeId, t.paidAt),
  ],
);

export const shopOrderLines = pgTable(
  "shop_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    orderId: uuid("order_id").notNull().references(() => shopOrders.id),
    shopifyLineId: text("shopify_line_id").notNull(),
    sku: text("sku"),
    variantTitle: text("variant_title"),
    title: text("title"),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
  },
  (t) => [uniqueIndex("shop_order_lines_uq").on(t.storeId, t.shopifyLineId)],
);

export const shopFulfillments = pgTable(
  "shop_fulfillments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    orderId: uuid("order_id").notNull().references(() => shopOrders.id),
    shopifyFulfillmentId: text("shopify_fulfillment_id").notNull(),
    status: text("status"),
    trackingCompany: text("tracking_company"),
    trackingNumber: text("tracking_number"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("shop_fulfillments_uq").on(t.storeId, t.shopifyFulfillmentId)],
);

export const shopRefunds = pgTable(
  "shop_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    orderId: uuid("order_id").notNull().references(() => shopOrders.id),
    shopifyRefundId: text("shopify_refund_id").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    reason: text("reason"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("shop_refunds_uq").on(t.storeId, t.shopifyRefundId)],
);

/* ---------------- Costs and money ---------------- */

export const costRecords = pgTable(
  "cost_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    costType: costType("cost_type").notNull(),
    scopeType: text("scope_type").notNull().default("global"),
    scopeValue: text("scope_value"),
    amountCents: integer("amount_cents"),
    rateBps: integer("rate_bps"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    provenance: provenance("provenance").notNull().default("estimated"),
    sourceNote: text("source_note"),
    enteredBy: uuid("entered_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cost_records_lookup_idx").on(t.storeId, t.costType, t.scopeValue, t.effectiveFrom)],
);

export const adSpendRecords = pgTable(
  "ad_spend_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    channel: adChannel("channel").notNull(),
    campaignRef: text("campaign_ref"),
    spendCents: integer("spend_cents").notNull(),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    spendDate: date("spend_date").notNull(),
    provenance: provenance("provenance").notNull().default("verified"),
    enteredBy: uuid("entered_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ad_spend_uq").on(t.storeId, t.channel, t.campaignRef, t.spendDate)],
);

export const orderEconomics = pgTable(
  "order_economics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    orderId: uuid("order_id").notNull().references(() => shopOrders.id),
    revenueCents: integer("revenue_cents").notNull().default(0),
    productCostCents: integer("product_cost_cents").notNull().default(0),
    shippingCostCents: integer("shipping_cost_cents").notNull().default(0),
    packagingCostCents: integer("packaging_cost_cents").notNull().default(0),
    transactionFeeCents: integer("transaction_fee_cents").notNull().default(0),
    refundCents: integer("refund_cents").notNull().default(0),
    contributionProfitCents: integer("contribution_profit_cents").notNull().default(0),
    contributionMarginBps: integer("contribution_margin_bps").notNull().default(0),
    costRecordsUsed: jsonb("cost_records_used").notNull().default(sql`'[]'::jsonb`),
    hasEstimatedInputs: boolean("has_estimated_inputs").notNull().default(true),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("order_economics_uq").on(t.orderId)],
);

export const dailyMetrics = pgTable(
  "daily_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    metricDate: date("metric_date").notNull(),
    grain: text("grain").notNull().default("store"),
    grainValue: text("grain_value"),
    sessions: integer("sessions"),
    orders: integer("orders").notNull().default(0),
    units: integer("units").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    cogsCents: integer("cogs_cents").notNull().default(0),
    adSpendCents: integer("ad_spend_cents").notNull().default(0),
    refundCents: integer("refund_cents").notNull().default(0),
    contributionProfitCents: integer("contribution_profit_cents").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("daily_metrics_uq").on(t.storeId, t.metricDate, t.grain, t.grainValue)],
);

/** Sessions cannot be read from the Admin API, so conversion rate needs an input. */
export const trafficRecords = pgTable(
  "traffic_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    recordDate: date("record_date").notNull(),
    sessions: integer("sessions").notNull(),
    source: text("source").notNull().default("manual"),
    enteredBy: uuid("entered_by").references(() => users.id),
  },
  (t) => [uniqueIndex("traffic_uq").on(t.storeId, t.recordDate)],
);

/* ---------------- Customer signals, detection, recommendations ---------------- */

export const customerSignals = pgTable(
  "customer_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    kind: text("kind").notNull(),
    theme: text("theme").notNull(),
    /** Redacted before storage. Raw customer text never lands here. */
    detail: text("detail"),
    sentiment: numeric("sentiment", { precision: 3, scale: 2 }),
    orderRef: text("order_ref"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_signals_idx").on(t.storeId, t.theme, t.occurredAt)],
);

export const detectedSignals = pgTable(
  "detected_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    code: text("code").notNull(),
    severity: signalSeverity("severity").notNull(),
    title: text("title").notNull(),
    evidence: jsonb("evidence").notNull(),
    windowStart: date("window_start"),
    windowEnd: date("window_end"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("detected_signals_idx").on(t.storeId, t.code, t.detectedAt)],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id),
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    financialImpactMinCents: integer("financial_impact_min_cents"),
    financialImpactMaxCents: integer("financial_impact_max_cents"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    riskLevel: riskLevel("risk_level").notNull().default("medium"),
    proposedAction: jsonb("proposed_action"),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    rollbackPlan: text("rollback_plan"),
    missingData: jsonb("missing_data").notNull().default(sql`'[]'::jsonb`),
    status: recommendationStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recommendations_idx").on(t.storeId, t.status, t.createdAt)],
);

/* ---------------- Recommended store stack ---------------- */

export const stackItems = pgTable(
  "stack_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => stores.id),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
    category: text("category").notNull(),
    appName: text("app_name").notNull(),
    whyNeeded: text("why_needed").notNull(),
    essentialBeforeLaunch: boolean("essential_before_launch").notNull().default(false),
    freePlanAvailable: boolean("free_plan_available").notNull().default(false),
    estimatedMonthlyCents: integer("estimated_monthly_cents"),
    dataPermissions: jsonb("data_permissions").notNull().default(sql`'[]'::jsonb`),
    setupSteps: jsonb("setup_steps").notNull().default(sql`'[]'::jsonb`),
    risks: jsonb("risks").notNull().default(sql`'[]'::jsonb`),
    alternatives: jsonb("alternatives").notNull().default(sql`'[]'::jsonb`),
    installUrl: text("install_url"),
    status: stackStatus("status").notNull().default("recommended"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stack_items_idx").on(t.storeId, t.category)],
);
