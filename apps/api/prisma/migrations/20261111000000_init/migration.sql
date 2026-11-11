-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('ORDER_RECEIVED', 'PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'DELIVERY_UNKNOWN', 'DELAYED', 'FAILED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "DeliverySource" AS ENUM ('SHOPIFY', 'CARRIER_API', 'MANUAL');

-- CreateEnum
CREATE TYPE "SalesChannel" AS ENUM ('IDEALO', 'GOOGLE_SHOPPING', 'GOOGLE_ADS', 'GOOGLE_ORGANIC', 'GEIZHALS', 'BILLIGER', 'DIRECT', 'EMAIL', 'SOCIAL', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AttributionConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'NONE');

-- CreateEnum
CREATE TYPE "ShippingRule" AS ENUM ('TRACKED', 'UNTRACKED_FALLBACK');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('PENDING', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'REVIEW_RECEIVED', 'CONSENT_MISSING', 'REVIEW_STATUS_UNKNOWN');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('UNKNOWN', 'NOT_REVIEWED', 'REVIEWED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlatformKey" AS ENUM ('GOOGLE_CUSTOMER_REVIEWS', 'GOOGLE_BUSINESS', 'IDEALO', 'TRUSTED_SHOPS', 'TRUSTPILOT', 'JUDGEME');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('LINK', 'API', 'EXTERNAL_PROGRAM');

-- CreateEnum
CREATE TYPE "LegalBasis" AS ENUM ('NONE', 'CONSENT', 'UWG_7_3');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'REVOKED', 'OBJECTED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'HARD_BOUNCE', 'OBJECTION', 'COMPLAINT', 'MANUAL');

-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'BOUNCED_SOFT', 'BOUNCED_HARD', 'CLICKED', 'UNSUBSCRIBED', 'TEST_SENT');

-- CreateEnum
CREATE TYPE "ReviewEventType" AS ENUM ('REVIEW_CONFIRMED', 'REVIEW_MARKED_MANUALLY', 'LINK_CLICKED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'VIEWER');

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "shopify_domain" TEXT NOT NULL,
    "shopify_shop_id" TEXT,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "plan" TEXT NOT NULL DEFAULT 'internal',
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "last_order_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_integrations" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_config" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "status_detail" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "shopify_customer_id" TEXT NOT NULL,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "locale" TEXT,
    "marketing_state" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order_number" INTEGER,
    "order_created_at" TIMESTAMP(3) NOT NULL,
    "customer_id" UUID,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "locale" TEXT,
    "total_price" DECIMAL(12,2) NOT NULL,
    "total_refunded" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "financial_status" TEXT,
    "fulfillment_status" TEXT,
    "return_status" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "source_name" TEXT,
    "shipping_method" TEXT,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "accepts_marketing" BOOLEAN NOT NULL DEFAULT false,
    "delivery_status" "DeliveryStatus" NOT NULL DEFAULT 'ORDER_RECEIVED',
    "delivery_source" "DeliverySource",
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "has_tracking" BOOLEAN NOT NULL DEFAULT false,
    "carrier" TEXT,
    "is_freight" BOOLEAN NOT NULL DEFAULT false,
    "channel" "SalesChannel" NOT NULL DEFAULT 'UNKNOWN',
    "channel_method" TEXT,
    "channel_confidence" "AttributionConfidence" NOT NULL DEFAULT 'NONE',
    "review_blocked" BOOLEAN NOT NULL DEFAULT false,
    "review_blocked_reason" TEXT,
    "shopify_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shopify_line_item_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "shopify_product_id" TEXT,
    "unit_price" DECIMAL(12,2),

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shopify_fulfillment_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "display_status" TEXT,
    "carrier" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "shipped_at" TIMESTAMP(3) NOT NULL,
    "in_transit_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "estimated_delivery_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfillments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_events" (
    "id" UUID NOT NULL,
    "fulfillment_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" "DeliverySource" NOT NULL,
    "status" TEXT NOT NULL,
    "happened_at" TIMESTAMP(3) NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribution_sources" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "source_name" TEXT,
    "referrer_url" TEXT,
    "landing_page" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "visit_source" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_mapping_rules" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "channel" "SalesChannel" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_mapping_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_platforms" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "key" "PlatformKey" NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "review_url" TEXT,
    "integration_type" "IntegrationType" NOT NULL,
    "api_available" BOOLEAN NOT NULL DEFAULT false,
    "status_query_available" BOOLEAN NOT NULL DEFAULT false,
    "reminders_allowed" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "target_share" INTEGER NOT NULL DEFAULT 0,
    "extra_delay_days" INTEGER NOT NULL DEFAULT 0,
    "only_for_channels" "SalesChannel"[],
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_rules" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "first_request_days_after_delivery" INTEGER NOT NULL DEFAULT 4,
    "fallback_days_after_order" INTEGER NOT NULL DEFAULT 14,
    "reminder_interval_days" INTEGER NOT NULL DEFAULT 3,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "send_window_start_hour" INTEGER NOT NULL DEFAULT 9,
    "send_window_end_hour" INTEGER NOT NULL DEFAULT 19,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
    "daily_send_limit" INTEGER NOT NULL DEFAULT 200,
    "freight_patterns" TEXT[] DEFAULT ARRAY['spedition', 'freight', 'dachser', 'schenker', 'hellmann', 'rhenus', 'kühne', 'kuehne']::TEXT[],
    "legal_basis" "LegalBasis" NOT NULL DEFAULT 'NONE',
    "sending_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sending_released_at" TIMESTAMP(3),
    "sending_released_by" TEXT,
    "reminders_on_unknown_status" BOOLEAN NOT NULL DEFAULT false,
    "consider_judgeme_invitations" BOOLEAN NOT NULL DEFAULT true,
    "test_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_campaigns" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "platform_id" UUID,
    "status" "CampaignStatus" NOT NULL DEFAULT 'PENDING',
    "status_reason" TEXT,
    "shipping_rule" "ShippingRule",
    "anchor_at" TIMESTAMP(3),
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'UNKNOWN',
    "paused_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_invitations" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "status_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "message_id" TEXT,
    "tracking_token" TEXT NOT NULL,
    "first_clicked_at" TIMESTAMP(3),
    "click_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_events" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "platform_id" UUID,
    "order_id" UUID,
    "campaign_id" UUID,
    "type" "ReviewEventType" NOT NULL,
    "external_id" TEXT,
    "rating" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "platform_id" UUID,
    "scope" TEXT NOT NULL DEFAULT 'default',
    "step" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_events" (
    "id" UUID NOT NULL,
    "invitation_id" UUID,
    "shop_id" UUID NOT NULL,
    "type" "EmailEventType" NOT NULL,
    "detail" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "webhook_id" TEXT NOT NULL,
    "event_id" TEXT,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_error" TEXT,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopify_domain_key" ON "shops"("shopify_domain");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopify_shop_id_key" ON "shops"("shopify_shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_integrations_shop_id_provider_key" ON "shop_integrations"("shop_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "customers_shop_id_email_idx" ON "customers"("shop_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_shop_id_shopify_customer_id_key" ON "customers"("shop_id", "shopify_customer_id");

-- CreateIndex
CREATE INDEX "orders_shop_id_order_created_at_idx" ON "orders"("shop_id", "order_created_at");

-- CreateIndex
CREATE INDEX "orders_shop_id_delivery_status_idx" ON "orders"("shop_id", "delivery_status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shop_id_shopify_order_id_key" ON "orders"("shop_id", "shopify_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_shopify_line_item_id_key" ON "order_items"("order_id", "shopify_line_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillments_order_id_shopify_fulfillment_id_key" ON "fulfillments"("order_id", "shopify_fulfillment_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_events_fulfillment_id_external_id_key" ON "tracking_events"("fulfillment_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "attribution_sources_order_id_key" ON "attribution_sources"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_mapping_rules_shop_id_field_pattern_key" ON "channel_mapping_rules"("shop_id", "field", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "review_platforms_shop_id_key_key" ON "review_platforms"("shop_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "review_rules_shop_id_key" ON "review_rules"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_campaigns_order_id_key" ON "review_campaigns"("order_id");

-- CreateIndex
CREATE INDEX "review_campaigns_shop_id_status_idx" ON "review_campaigns"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_invitations_tracking_token_key" ON "review_invitations"("tracking_token");

-- CreateIndex
CREATE INDEX "review_invitations_status_scheduled_at_idx" ON "review_invitations"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "review_invitations_campaign_id_step_key" ON "review_invitations"("campaign_id", "step");

-- CreateIndex
CREATE INDEX "review_events_shop_id_occurred_at_idx" ON "review_events"("shop_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "review_events_shop_id_platform_id_external_id_key" ON "review_events"("shop_id", "platform_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_shop_id_scope_step_key" ON "email_templates"("shop_id", "scope", "step");

-- CreateIndex
CREATE INDEX "email_events_shop_id_type_occurred_at_idx" ON "email_events"("shop_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "consent_records_shop_id_email_recorded_at_idx" ON "consent_records"("shop_id", "email", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_shop_id_email_key" ON "email_suppressions"("shop_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_webhook_id_key" ON "webhook_events"("webhook_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "audit_logs_shop_id_created_at_idx" ON "audit_logs"("shop_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "jobs_status_run_at_idx" ON "jobs"("status", "run_at");

-- AddForeignKey
ALTER TABLE "shop_integrations" ADD CONSTRAINT "shop_integrations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_sources" ADD CONSTRAINT "attribution_sources_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_mapping_rules" ADD CONSTRAINT "channel_mapping_rules_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_platforms" ADD CONSTRAINT "review_platforms_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_rules" ADD CONSTRAINT "review_rules_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_campaigns" ADD CONSTRAINT "review_campaigns_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_campaigns" ADD CONSTRAINT "review_campaigns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_campaigns" ADD CONSTRAINT "review_campaigns_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "review_platforms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_invitations" ADD CONSTRAINT "review_invitations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "review_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "review_platforms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "review_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "review_platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "review_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

