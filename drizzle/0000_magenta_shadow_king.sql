CREATE TYPE "public"."actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."ad_channel" AS ENUM('meta', 'tiktok', 'google', 'other');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('completed', 'needs_human_review', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'modified', 'rejected', 'info_requested', 'expired');--> statement-breakpoint
CREATE TYPE "public"."cost_type" AS ENUM('supplier_unit', 'inbound_shipping', 'packaging', 'transaction_fee_rate', 'transaction_fee_fixed', 'operating_monthly');--> statement-breakpoint
CREATE TYPE "public"."creative_kind" AS ENUM('video_hook', 'static_hook', 'headline', 'primary_text', 'ugc_script', 'demo_script', 'problem_solution_script', 'founder_story_script', 'objection_angle', 'retargeting_concept', 'landing_angle', 'offer_test', 'ad_test_plan', 'email_welcome', 'email_abandoned_cart', 'email_post_purchase', 'email_review_request', 'creator_outreach', 'creator_brief', 'photo_brief', 'video_shot_list', 'image_prompt', 'storyboard_prompt');--> statement-breakpoint
CREATE TYPE "public"."draft_kind" AS ENUM('brand_identity', 'homepage', 'product_page', 'bundles', 'cart_upsells', 'comparison', 'benefits', 'how_it_works', 'specifications', 'faq', 'about', 'contact', 'shipping_policy', 'refund_policy', 'privacy_policy', 'terms', 'order_tracking_plan', 'seo', 'email_optin', 'trust_sections', 'mobile_structure', 'photo_shot_list', 'ugc_shot_list', 'launch_checklist');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('draft', 'approved', 'published', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('manual_url', 'supplier_url', 'csv_upload', 'pasted_reviews', 'pasted_competitor', 'manual_note', 'web_search');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('pending', 'succeeded', 'failed', 'blocked_by_kill_switch', 'dead_lettered', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."model_tier" AS ENUM('cheap', 'frontier');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('verified', 'supplier_provided', 'estimated', 'missing');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('pursue', 'research_more', 'avoid');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('open', 'queued_for_approval', 'accepted', 'dismissed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."research_status" AS ENUM('draft', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."signal_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."stack_status" AS ENUM('recommended', 'approved', 'installed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."target_system" AS ENUM('shopify', 'internal', 'email', 'ads', 'supplier');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('founder', 'ops', 'support', 'finance', 'analyst');--> statement-breakpoint
CREATE TABLE "action_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"approval_request_id" uuid,
	"action_type" text NOT NULL,
	"target_system" "target_system" NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"response_payload" jsonb,
	"status" "execution_status" DEFAULT 'pending' NOT NULL,
	"rollback_plan" jsonb,
	"state_hash_at_approval" text,
	"state_hash_at_execution" text,
	"error" text,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_spend_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"channel" "ad_channel" NOT NULL,
	"campaign_ref" text,
	"spend_cents" integer NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"spend_date" date NOT NULL,
	"provenance" "provenance" DEFAULT 'verified' NOT NULL,
	"entered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agent_name" text NOT NULL,
	"model" text NOT NULL,
	"model_tier" "model_tier" NOT NULL,
	"prompt_version" text DEFAULT 'v1' NOT NULL,
	"input_refs" jsonb,
	"output" jsonb,
	"status" "agent_run_status" NOT NULL,
	"schema_valid" boolean DEFAULT false NOT NULL,
	"repair_attempted" boolean DEFAULT false NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" numeric(12, 4) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"decided_by" uuid NOT NULL,
	"decision" "approval_status" NOT NULL,
	"modified_payload" jsonb,
	"note" text,
	"latency_seconds" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid,
	"action_type" text NOT NULL,
	"target_system" "target_system" NOT NULL,
	"summary" text NOT NULL,
	"proposed_action" jsonb NOT NULL,
	"current_state" jsonb,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"risk_level" "risk_level" DEFAULT 'medium' NOT NULL,
	"financial_impact_min_cents" integer,
	"financial_impact_max_cents" integer,
	"rollback_plan" text NOT NULL,
	"recommended_decision" text,
	"alternatives" jsonb,
	"deadline" timestamp with time zone,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action_type" text NOT NULL,
	"target_table" text,
	"target_id" text,
	"before_state" jsonb,
	"after_state" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"cost_type" "cost_type" NOT NULL,
	"scope_type" text DEFAULT 'global' NOT NULL,
	"scope_value" text,
	"amount_cents" integer,
	"rate_bps" integer,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"provenance" "provenance" DEFAULT 'estimated' NOT NULL,
	"source_note" text,
	"entered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"kind" "creative_kind" NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"claims_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compliance_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"theme" text NOT NULL,
	"detail" text,
	"sentiment" numeric(3, 2),
	"order_ref" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"grain" text DEFAULT 'store' NOT NULL,
	"grain_value" text,
	"sessions" integer,
	"orders" integer DEFAULT 0 NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"cogs_cents" integer DEFAULT 0 NOT NULL,
	"ad_spend_cents" integer DEFAULT 0 NOT NULL,
	"refund_cents" integer DEFAULT 0 NOT NULL,
	"contribution_profit_cents" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detected_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" "signal_severity" NOT NULL,
	"title" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"window_start" date,
	"window_end" date,
	"resolved_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"label" text NOT NULL,
	"url" text,
	"content" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"agent_name" text NOT NULL,
	"model" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" numeric(12, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_economics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"product_cost_cents" integer DEFAULT 0 NOT NULL,
	"shipping_cost_cents" integer DEFAULT 0 NOT NULL,
	"packaging_cost_cents" integer DEFAULT 0 NOT NULL,
	"transaction_fee_cents" integer DEFAULT 0 NOT NULL,
	"refund_cents" integer DEFAULT 0 NOT NULL,
	"contribution_profit_cents" integer DEFAULT 0 NOT NULL,
	"contribution_margin_bps" integer DEFAULT 0 NOT NULL,
	"cost_records_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_estimated_inputs" boolean DEFAULT true NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"primary_supplier_id" uuid,
	"backup_supplier_id" uuid,
	"target_price_cents" integer NOT NULL,
	"delivery_estimate_min" integer NOT NULL,
	"delivery_estimate_max" integer NOT NULL,
	"claims_allowed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claims_prohibited" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"name" text NOT NULL,
	"opportunity_score" integer NOT NULL,
	"analysis" jsonb NOT NULL,
	"recommendation" "recommendation" NOT NULL,
	"suggested_price_cents" integer,
	"estimated_landed_cost_cents" integer,
	"gross_margin_bps" integer,
	"break_even_cac_cents" integer,
	"is_selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"approval_request_id" uuid,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"financial_impact_min_cents" integer,
	"financial_impact_max_cents" integer,
	"confidence" numeric(4, 3),
	"risk_level" "risk_level" DEFAULT 'medium' NOT NULL,
	"proposed_action" jsonb,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"rollback_plan" text,
	"missing_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "recommendation_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"niche" text NOT NULL,
	"target_country" text NOT NULL,
	"target_price_cents" integer NOT NULL,
	"max_landed_cost_cents" integer NOT NULL,
	"min_gross_margin_bps" integer NOT NULL,
	"max_shipping_days" integer NOT NULL,
	"customer_type" text NOT NULL,
	"avoid_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"launch_budget_cents" integer NOT NULL,
	"status" "research_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_fulfillment_id" text NOT NULL,
	"status" text,
	"tracking_company" text,
	"tracking_number" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shop_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_line_id" text NOT NULL,
	"sku" text,
	"variant_title" text,
	"title" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_order_id" text NOT NULL,
	"order_number" text,
	"financial_status" text,
	"fulfillment_status" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"shipping_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"shipping_country" text,
	"customer_ref" text,
	"placed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_product_id" text NOT NULL,
	"title" text NOT NULL,
	"handle" text,
	"status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"shopify_refund_id" text NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"refunded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shop_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"shopify_variant_id" text NOT NULL,
	"sku" text,
	"title" text,
	"price_cents" integer,
	"inventory_quantity" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"category" text NOT NULL,
	"app_name" text NOT NULL,
	"why_needed" text NOT NULL,
	"essential_before_launch" boolean DEFAULT false NOT NULL,
	"free_plan_available" boolean DEFAULT false NOT NULL,
	"estimated_monthly_cents" integer,
	"data_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"install_url" text,
	"status" "stack_status" DEFAULT 'recommended' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"brand_name" text,
	"status" text DEFAULT 'drafting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"kind" "draft_kind" NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"claims_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compliance_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"shopify_resource_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"shopify_domain" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"target_country" text DEFAULT 'US' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"product_url" text,
	"product_cost_cents" integer,
	"shipping_cost_cents" integer,
	"delivery_days_min" integer,
	"delivery_days_max" integer,
	"processing_days" integer,
	"fulfillment_origin" text,
	"inventory_status" text,
	"tracking_available" boolean,
	"rating" numeric(3, 2),
	"review_count" integer,
	"quality_signals" text,
	"defect_risk_note" text,
	"branding_available" boolean,
	"communication_note" text,
	"sample_available" boolean,
	"integration_available" text,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reliability_score" integer,
	"landed_cost_cents" integer,
	"profit_per_order_cents" integer,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_backup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traffic_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"record_date" date NOT NULL,
	"sessions" integer NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"entered_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'founder' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"source" text DEFAULT 'shopify' NOT NULL,
	"topic" text NOT NULL,
	"external_event_id" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend_records" ADD CONSTRAINT "ad_spend_records_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend_records" ADD CONSTRAINT "ad_spend_records_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_batch_id_creative_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."creative_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_batches" ADD CONSTRAINT "creative_batches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_batches" ADD CONSTRAINT "creative_batches_decision_id_product_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."product_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_signals" ADD CONSTRAINT "customer_signals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_signals" ADD CONSTRAINT "detected_signals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage_daily" ADD CONSTRAINT "llm_usage_daily_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_economics" ADD CONSTRAINT "order_economics_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_economics" ADD CONSTRAINT "order_economics_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_decisions" ADD CONSTRAINT "product_decisions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_decisions" ADD CONSTRAINT "product_decisions_opportunity_id_product_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."product_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_decisions" ADD CONSTRAINT "product_decisions_primary_supplier_id_suppliers_id_fk" FOREIGN KEY ("primary_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_decisions" ADD CONSTRAINT "product_decisions_backup_supplier_id_suppliers_id_fk" FOREIGN KEY ("backup_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_decisions" ADD CONSTRAINT "product_decisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_opportunities" ADD CONSTRAINT "product_opportunities_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_opportunities" ADD CONSTRAINT "product_opportunities_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_opportunities" ADD CONSTRAINT "product_opportunities_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_projects" ADD CONSTRAINT "research_projects_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_projects" ADD CONSTRAINT "research_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_fulfillments" ADD CONSTRAINT "shop_fulfillments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_fulfillments" ADD CONSTRAINT "shop_fulfillments_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_order_lines" ADD CONSTRAINT "shop_order_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_order_lines" ADD CONSTRAINT "shop_order_lines_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_refunds" ADD CONSTRAINT "shop_refunds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_refunds" ADD CONSTRAINT "shop_refunds_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_variants" ADD CONSTRAINT "shop_variants_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_variants" ADD CONSTRAINT "shop_variants_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_items" ADD CONSTRAINT "stack_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_items" ADD CONSTRAINT "stack_items_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_builds" ADD CONSTRAINT "store_builds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_builds" ADD CONSTRAINT "store_builds_decision_id_product_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."product_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_drafts" ADD CONSTRAINT "store_drafts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_drafts" ADD CONSTRAINT "store_drafts_build_id_store_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."store_builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_drafts" ADD CONSTRAINT "store_drafts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_opportunity_id_product_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."product_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_records" ADD CONSTRAINT "traffic_records_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_records" ADD CONSTRAINT "traffic_records_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "executions_idempotency_uq" ON "action_executions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_uq" ON "ad_spend_records" USING btree ("store_id","channel","campaign_ref","spend_date");--> statement-breakpoint
CREATE INDEX "agent_runs_idx" ON "agent_runs" USING btree ("store_id","agent_name","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_correlation_idx" ON "agent_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "approvals_queue_idx" ON "approval_requests" USING btree ("store_id","status","risk_level","created_at");--> statement-breakpoint
CREATE INDEX "audit_store_created_idx" ON "audit_logs" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_correlation_idx" ON "audit_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_logs" USING btree ("target_table","target_id");--> statement-breakpoint
CREATE INDEX "cost_records_lookup_idx" ON "cost_records" USING btree ("store_id","cost_type","scope_value","effective_from");--> statement-breakpoint
CREATE INDEX "creative_assets_batch_idx" ON "creative_assets" USING btree ("batch_id","kind");--> statement-breakpoint
CREATE INDEX "customer_signals_idx" ON "customer_signals" USING btree ("store_id","theme","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_metrics_uq" ON "daily_metrics" USING btree ("store_id","metric_date","grain","grain_value");--> statement-breakpoint
CREATE INDEX "detected_signals_idx" ON "detected_signals" USING btree ("store_id","code","detected_at");--> statement-breakpoint
CREATE INDEX "evidence_project_idx" ON "evidence_items" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_uq" ON "llm_usage_daily" USING btree ("store_id","usage_date","agent_name","model");--> statement-breakpoint
CREATE UNIQUE INDEX "order_economics_uq" ON "order_economics" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "opportunities_project_idx" ON "product_opportunities" USING btree ("project_id","opportunity_score");--> statement-breakpoint
CREATE INDEX "recommendations_idx" ON "recommendations" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "research_projects_store_idx" ON "research_projects" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_store_key_uq" ON "settings" USING btree ("store_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_fulfillments_uq" ON "shop_fulfillments" USING btree ("store_id","shopify_fulfillment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_order_lines_uq" ON "shop_order_lines" USING btree ("store_id","shopify_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_orders_uq" ON "shop_orders" USING btree ("store_id","shopify_order_id");--> statement-breakpoint
CREATE INDEX "shop_orders_paid_idx" ON "shop_orders" USING btree ("store_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_products_uq" ON "shop_products" USING btree ("store_id","shopify_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_refunds_uq" ON "shop_refunds" USING btree ("store_id","shopify_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_variants_uq" ON "shop_variants" USING btree ("store_id","shopify_variant_id");--> statement-breakpoint
CREATE INDEX "stack_items_idx" ON "stack_items" USING btree ("store_id","category");--> statement-breakpoint
CREATE INDEX "store_builds_store_idx" ON "store_builds" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "store_drafts_build_idx" ON "store_drafts" USING btree ("build_id","kind");--> statement-breakpoint
CREATE INDEX "suppliers_opportunity_idx" ON "suppliers" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "traffic_uq" ON "traffic_records" USING btree ("store_id","record_date");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_uq" ON "webhook_events" USING btree ("store_id","source","external_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("processing_status","received_at");