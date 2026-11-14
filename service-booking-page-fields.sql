-- Wexly v215: per-service photo and "show description" toggle on the booking page.
-- Run once in the Supabase SQL editor. Safe to re-run.
alter table services add column if not exists image_url text;
alter table services add column if not exists show_description boolean default true;
