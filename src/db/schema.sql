-- ============================================================
-- Wexly — Drop old tables and rebuild fresh
-- Run this entire file in your Supabase SQL editor
-- ============================================================

-- Drop old tables if they exist (from previous schema)
drop table if exists waitlist cascade;
drop table if exists conversation_sessions cascade;
drop table if exists reservations cascade;
drop table if exists restaurants cascade;
drop table if exists blocked_dates cascade;
drop table if exists appointments cascade;
drop table if exists faqs cascade;
drop table if exists services cascade;
drop table if exists businesses cascade;

-- Drop old function if exists
drop function if exists update_updated_at cascade;

-- ── BUSINESSES ───────────────────────────────────────────────
create table businesses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  owner_name text not null,
  email text not null unique,
  business_name text not null,
  business_type text not null,
  address text,
  phone text,
  website text,
  timezone text not null default 'America/Los_Angeles',
  sms_number text unique,
  bot_greeting text,
  bot_tone text default 'friendly',
  bot_restrictions text,
  meeting_link text,
  buffer_mins int default 10,
  advance_booking_days int default 30,
  min_notice_mins int default 120,
  max_daily int default 10,
  hours jsonb default '[]',
  status text not null default 'trial'
    check (status in ('trial', 'active', 'cancelled', 'past_due')),
  trial_ends_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── SERVICES ─────────────────────────────────────────────────
create table services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  name text not null,
  duration_mins int not null default 60,
  price_cents int,
  active boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- ── FAQS ─────────────────────────────────────────────────────
create table faqs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  question text not null,
  answer text not null,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- ── APPOINTMENTS ─────────────────────────────────────────────
create table appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  customer_name text,
  customer_phone text not null,
  service_id uuid references services(id),
  service_name text,
  appointment_date date,
  appointment_time time,
  duration_mins int default 60,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  notes text,
  reminder_sent boolean default false,
  followup_sent boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── CONVERSATION SESSIONS ────────────────────────────────────
create table conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  customer_phone text not null,
  messages jsonb not null default '[]',
  last_appointment_id uuid references appointments(id),
  last_activity timestamptz default now(),
  manual_mode boolean default false,
  manual_mode_until timestamptz,
  created_at timestamptz default now(),
  unique(business_id, customer_phone)
);

-- ── WAITLIST ─────────────────────────────────────────────────
create table waitlist (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  customer_phone text not null,
  customer_name text,
  service_name text,
  preferred_date date,
  preferred_time time,
  notified boolean default false,
  created_at timestamptz default now()
);

-- ── BLOCKED DATES ────────────────────────────────────────────
create table blocked_dates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  blocked_date date not null,
  start_time time,
  end_time time,
  reason text,
  created_at timestamptz default now()
);

-- ── INDEXES ──────────────────────────────────────────────────
create index idx_businesses_sms_number on businesses(sms_number);
create index idx_businesses_user_id on businesses(user_id);
create index idx_appointments_business_date on appointments(business_id, appointment_date);
create index idx_appointments_customer_phone on appointments(customer_phone);
create index idx_appointments_reminder on appointments(appointment_date, reminder_sent) where status = 'confirmed' and reminder_sent = false;
create index idx_sessions_lookup on conversation_sessions(business_id, customer_phone);
create index idx_services_business on services(business_id);
create index idx_faqs_business on faqs(business_id);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
alter table businesses enable row level security;
alter table services enable row level security;
alter table faqs enable row level security;
alter table appointments enable row level security;
alter table conversation_sessions enable row level security;
alter table waitlist enable row level security;
alter table blocked_dates enable row level security;

create policy "owners_own_business" on businesses for all using (auth.uid() = user_id);
create policy "owners_own_services" on services for all using (business_id in (select id from businesses where user_id = auth.uid()));
create policy "owners_own_faqs" on faqs for all using (business_id in (select id from businesses where user_id = auth.uid()));
create policy "owners_own_appointments" on appointments for all using (business_id in (select id from businesses where user_id = auth.uid()));
create policy "owners_own_sessions" on conversation_sessions for all using (business_id in (select id from businesses where user_id = auth.uid()));
create policy "owners_own_waitlist" on waitlist for all using (business_id in (select id from businesses where user_id = auth.uid()));
create policy "owners_own_blocked" on blocked_dates for all using (business_id in (select id from businesses where user_id = auth.uid()));

-- ── UPDATED_AT TRIGGER ───────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger businesses_updated_at before update on businesses for each row execute function update_updated_at();
create trigger appointments_updated_at before update on appointments for each row execute function update_updated_at();

-- ── PRO PLAN FEATURES ─────────────────────────────────────────────────────────

-- Pre-qualification questions
create table if not exists qualification_questions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  question text not null,
  sort_order int default 0,
  disqualify_if text, -- keyword/value that triggers disqualification
  created_at timestamptz default now()
);

-- Follow-up sequences
create table if not exists followup_sequences (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  name text not null,
  trigger_type text not null, -- 'after_appointment', 'no_show', 'no_booking_days', 'birthday'
  delay_hours int default 24,
  message text not null,
  active boolean default true,
  created_at timestamptz default now()
);

-- Staff members (for multi-staff scheduling)
create table if not exists staff_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  name text not null,
  role text,
  specialties text,
  hours jsonb default '{}',
  active boolean default true,
  created_at timestamptz default now()
);

-- Intake form fields
create table if not exists intake_fields (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  label text not null,
  field_type text default 'text', -- text, yesno, select
  options text, -- comma separated for select
  required boolean default false,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Customer intake responses
create table if not exists intake_responses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  customer_phone text not null,
  appointment_id uuid references appointments(id),
  responses jsonb default '{}',
  created_at timestamptz default now()
);

-- Add plan and pro settings to businesses
alter table businesses add column if not exists plan text default 'standard';
alter table businesses add column if not exists pro_settings jsonb default '{}';
-- pro_settings structure:
-- {
--   qualification_enabled: bool,
--   qualification_action: 'decline' | 'flag',
--   followup_sequences: bool,
--   multi_staff: bool,
--   intake_forms: bool,
--   smart_scheduling: bool,
--   notifications: {
--     new_booking_email: bool,
--     new_booking_sms: bool,
--     escalation_email: bool,
--     escalation_sms: bool,
--     daily_digest: bool,
--     weekly_report: bool,
--     low_availability: bool,
--     no_show_alert: bool
--   }
-- }
