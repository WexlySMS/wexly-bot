-- ============================================================
-- Wexly — New Features SQL
-- Run in Supabase SQL Editor
-- ============================================================

-- ── MULTI-LOCATION ───────────────────────────────────────────
-- Add parent/child relationship to businesses table
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS parent_business_id uuid REFERENCES businesses(id);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS location_name text; -- e.g. "Downtown", "Westside"
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_parent boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS location_plan text default 'standard'; -- plan per location

-- ── BIRTHDAY MESSAGES ────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS birthday date;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS birthday_enabled boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS birthday_message text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS birthday_offer text; -- e.g. "20% off your next visit"

-- ── NO-SHOW RECOVERY ─────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS noshow_recovery_enabled boolean default true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS noshow_recovery_message text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS noshow_recovery_sent boolean default false;

-- ── WAITING ROOM / RUNNING LATE ──────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS late_alert_enabled boolean default true;

-- ── REBOOKING (from previous session) ────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rebook_enabled boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rebook_interval_weeks int default 6;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cancel_rebook_enabled boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS smart_rebook_enabled boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS service_rebook_intervals jsonb default '{}';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS rebook_sent boolean default false;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS smart_rebook_sent boolean default false;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancel_rebook_sent boolean default false;

-- ── MISSED CALL (from previous session) ──────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS missed_call_enabled boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS missed_call_type text default 'wexly';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS missed_call_message text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS existing_phone text;

-- ── MISSING COLUMNS (found during audit) ─────────────────────
-- Businesses table
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS bot_name text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS bot_staff text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS checkin_enabled boolean default true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS interview_state text default 'waiting_start';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS interview_step int default 0;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS interview_answers jsonb default '{}';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_phone text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS referral_tracking_enabled boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS referral_ask_message text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS review_link text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS active_promotion text;

-- Customers table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_vip boolean default false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS vip_note text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_source text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opted_out boolean default false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS source text default 'booking';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS birthday date;

-- Also add plan column if missing (needed for pro features)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan text default 'standard';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pro_settings jsonb default '{}';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS bot_name text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website text;

-- ── SMS GROUPS (Pro feature) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz default now()
);

CREATE TABLE IF NOT EXISTS sms_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references sms_groups(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  business_id uuid references businesses(id) on delete cascade,
  added_at timestamptz default now(),
  unique(group_id, customer_id)
);

CREATE TABLE IF NOT EXISTS sms_group_broadcasts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  group_id uuid references sms_groups(id) on delete cascade,
  message text not null,
  sent_count int default 0,
  created_at timestamptz default now()
);

-- ── OPT-OUT SPLIT (marketing vs full) ────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_opted_out boolean default false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS fully_opted_out boolean default false;
-- Keep opted_out as alias for fully_opted_out for backwards compat

-- ── COMPLIANCE VIOLATIONS LOG ─────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_violations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  message text not null,
  flagged_terms text[],
  action text default 'sent_anyway', -- 'sent_anyway' or 'edited'
  group_id uuid references sms_groups(id) on delete set null,
  created_at timestamptz default now()
);

-- ── COMPLIANCE FLAG ON BUSINESSES ─────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS compliance_flagged boolean default false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS compliance_flag_reason text;
