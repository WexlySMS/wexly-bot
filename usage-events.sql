-- Wexly v216: per-business usage ledger (model calls and texts) for the cost report
-- and the monthly spend alert. Run once in the Supabase SQL editor. Safe to re-run.
create table if not exists usage_events (
  id bigint generated always as identity primary key,
  business_id uuid references businesses(id) on delete set null,
  sms_number text,
  kind text not null check (kind in ('model','sms')),
  detail text,
  model text,
  input_tokens int default 0,
  output_tokens int default 0,
  cache_read_tokens int default 0,
  cache_write_tokens int default 0,
  segments int default 0,
  cost_cents numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_biz_month on usage_events (business_id, created_at desc);
create index if not exists usage_events_created on usage_events (created_at desc);
alter table usage_events enable row level security;
-- service role bypasses RLS; no policies for anon/authenticated on purpose.

-- One alert per business per month.
create table if not exists usage_alerts (
  business_id uuid references businesses(id) on delete cascade,
  month date not null,
  alerted_at timestamptz not null default now(),
  cost_cents numeric(10,2),
  primary key (business_id, month)
);
