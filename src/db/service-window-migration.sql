-- v207: per-service start-time window (Entry 78)
-- "Color has to start by 2pm." The bot, the booking page and owner-made
-- bookings all stop offering start times outside the window. Both columns
-- optional; null = any time the business is open. Safe to run more than once.

alter table public.services add column if not exists earliest_start time;
alter table public.services add column if not exists latest_start time;
