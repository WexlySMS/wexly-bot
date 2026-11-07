-- v206: calendar import (Entry 77)
-- Lets imported appointments remember where they came from so a re-read of the
-- owner's old calendar feed can mirror moves and cancellations instead of
-- creating duplicates. The bot works without these columns (it falls back to
-- date|time|name de-duplication) and picks them up automatically within
-- 10 minutes of this running. Safe to run more than once.

alter table public.appointments add column if not exists source text;        -- 'calendar' | 'screenshot' | null (booked in Wexly)
alter table public.appointments add column if not exists source_uid text;    -- '<source>:<calendar UID>' for feed de-dup / sync

create unique index if not exists appointments_business_source_uid_key
  on public.appointments (business_id, source_uid)
  where source_uid is not null;

-- Speeds up the 15-minute sync's "which businesses have a linked calendar" query.
create index if not exists businesses_calendar_feed_active_idx
  on public.businesses ((onboarding -> 'calendar_feed' ->> 'active'))
  where (onboarding -> 'calendar_feed' ->> 'active') = 'true';
