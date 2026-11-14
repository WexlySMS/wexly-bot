-- Wexly v216: marketing consent on customers. Run once in the Supabase SQL editor. Safe to re-run.
-- texted_in / web_booking may receive marketing texts (rebooking, birthday, campaigns, blasts, review asks).
-- imported / owner_added wait until that number texts the business; the webhook flips them to texted_in.
alter table customers add column if not exists consent_source text;
alter table customers add column if not exists consented_at timestamptz;

-- Backfill from what we already know.
update customers c set consent_source = 'texted_in', consented_at = coalesce(c.consented_at, now())
 where c.consent_source is null
   and exists (select 1 from conversation_sessions s where s.business_id = c.business_id and s.customer_phone = c.phone);
update customers set consent_source = 'web_booking' where consent_source is null and source = 'website';
update customers set consent_source = 'owner_added' where consent_source is null and source in ('manual', 'owner');
update customers set consent_source = 'imported' where consent_source is null and source in ('calendar', 'import', 'csv', 'screenshot', 'glossgenius', 'booksy', 'square');

-- Keep it right from here on: default by source on insert, never downgrade on update.
create or replace function wx_consent_trg() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.consent_source is null then
      new.consent_source := case
        when new.source = 'website' then 'web_booking'
        when new.source in ('booking', 'sms', 'text') then 'texted_in'
        when new.source in ('manual', 'owner') then 'owner_added'
        else 'imported' end;
      new.consented_at := case when new.consent_source in ('texted_in', 'web_booking') then now() else null end;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.consent_source in ('texted_in', 'web_booking') and (new.consent_source is null or new.consent_source not in ('texted_in', 'web_booking')) then
      new.consent_source := old.consent_source;
      new.consented_at := old.consented_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists wx_consent on customers;
create trigger wx_consent before insert or update on customers for each row execute function wx_consent_trg();
