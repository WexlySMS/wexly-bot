-- Wexly v205: native client reviews (SMS-collected, shown on the booking page, owner can hide/show)
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  appointment_id uuid,
  customer_phone text not null,
  customer_name text,
  service_name text,
  rating smallint check (rating between 1 and 5),
  comment text,
  source text not null default 'sms',
  status text not null default 'requested',   -- requested | awaiting_comment | published | hidden
  requested_at timestamptz not null default now(),
  rated_at timestamptz,
  commented_at timestamptz,
  hidden_at timestamptz,
  owner_reply text,
  created_at timestamptz not null default now()
);
create index if not exists idx_reviews_business_status on public.reviews(business_id, status);
create index if not exists idx_reviews_customer on public.reviews(business_id, customer_phone, requested_at desc);
create unique index if not exists idx_reviews_appointment on public.reviews(appointment_id) where appointment_id is not null;
alter table public.reviews enable row level security;
drop policy if exists reviews_owner_select on public.reviews;
create policy reviews_owner_select on public.reviews for select to authenticated
  using (business_id in (select id from public.businesses where user_id = auth.uid()));
drop policy if exists reviews_owner_update on public.reviews;
create policy reviews_owner_update on public.reviews for update to authenticated
  using (business_id in (select id from public.businesses where user_id = auth.uid()))
  with check (business_id in (select id from public.businesses where user_id = auth.uid()));
alter table public.businesses add column if not exists reviews_ask_enabled boolean not null default true;
alter table public.businesses add column if not exists reviews_show_enabled boolean not null default true;
