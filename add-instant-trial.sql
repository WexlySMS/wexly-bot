-- ============================================================
-- Wexly v190 — Instant trial: verified owner cell + number at signup
-- Run this in the Supabase SQL editor BEFORE deploying bot v190 / site v189.
-- Safe to run more than once.
-- ============================================================

-- One-time SMS codes sent to the owner's cell during signup.
create table if not exists phone_verifications (
  id uuid primary key default gen_random_uuid(),
  phone text not null,                 -- E.164, e.g. +19515551234
  code_hash text not null,             -- sha256(code + phone + secret); the code itself is never stored
  attempts int not null default 0,     -- wrong guesses against this code
  expires_at timestamptz not null,
  verified_at timestamptz,
  ip text,
  created_at timestamptz default now()
);
create index if not exists phone_verifications_phone_idx
  on phone_verifications (phone, created_at desc);

-- Businesses: when the owner cell was verified, and the onboarding drip state.
-- onboarding is a small JSON map of step -> ISO timestamp, e.g.
--   {"welcome_sent_at":"...","demo_offered_at":"...","bio_nudge_at":"...","card_day7_at":"..."}
alter table businesses add column if not exists owner_phone_verified_at timestamptz;
alter table businesses add column if not exists onboarding jsonb not null default '{}'::jsonb;

-- New status 'trial_expired': 14 days passed with no card. Bot stops answering
-- clients; owner still gets a reply pointing at the add-card link. The original
-- check constraint (trial/active/cancelled/past_due) is dropped if it still
-- exists; status values are enforced by the app.
alter table businesses drop constraint if exists businesses_status_check;

-- Fast lookups for the drip sweep and the one-trial-per-cell check.
create index if not exists businesses_status_trial_idx on businesses (status, trial_ends_at);
create index if not exists businesses_owner_phone_idx on businesses (owner_phone);

-- ── Owner reminders (v191) ──────────────────────────────────────────────────
-- "Remind me tomorrow at 9 to call the supplier" from the owner thread.
create table if not exists owner_reminders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  message text not null,
  remind_at timestamptz not null,
  sent_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists owner_reminders_due_idx on owner_reminders (remind_at) where sent_at is null and cancelled_at is null;

-- ── Row level security ──────────────────────────────────────────────────────
-- Both new tables are touched ONLY by the bot (service key, bypasses RLS).
-- Enabling RLS with no policies locks them away from the browser anon key.
alter table phone_verifications enable row level security;
alter table owner_reminders enable row level security;

-- ── Public demo number (v191) ───────────────────────────────────────────────
-- Flag ONE business as the public demo line used by the website and ads.
-- Its bot behaves normally but writes no appointments (see demoMode.js).
alter table businesses add column if not exists demo_mode boolean not null default false;

create table if not exists demo_leads (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  business_id uuid references businesses(id) on delete set null,
  first_message text,
  last_message text,
  message_count int not null default 1,
  last_message_at timestamptz default now(),
  converted boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists demo_leads_recent_idx on demo_leads (last_message_at desc);
alter table demo_leads enable row level security;

-- Turn the demo on for the Radiance number (change the number to move it).
update businesses set demo_mode = true
  where regexp_replace(coalesce(sms_number, ''), '\D', '', 'g') like '%4175383787';

-- ── Reminders also go to customers (v191) ───────────────────────────────────
-- "Remind me in 5 minutes to book" from a client, not just the owner.
-- to_phone null = send to the business owner's cell (the original behaviour).
alter table owner_reminders add column if not exists kind text not null default 'owner';
alter table owner_reminders add column if not exists to_phone text;
create index if not exists owner_reminders_to_phone_idx on owner_reminders (business_id, to_phone)
  where sent_at is null and cancelled_at is null;

-- ── Demo "text me first" (v193) ─────────────────────────────────────────────
-- Desktop visitors ask the bot to text them; one outbound per number per day.
alter table demo_leads add column if not exists texted_first_at timestamptz;
