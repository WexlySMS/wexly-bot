-- Wexly v212: store every US phone as +1XXXXXXXXXX so a client who texts in is
-- matched to the bookings the owner made for them in the dashboard.
-- Run once in the Supabase SQL editor. Safe to re-run.

create or replace function wx_e164(p text) returns text language sql immutable as $$
  select case
    when p is null then null
    when p ~ '[A-Za-z]' then p                                   -- placeholders like nophone-xxxx stay as they are
    when p ~ '^\+1[0-9]{10}$' then p
    when regexp_replace(p, '\D', '', 'g') ~ '^1?[0-9]{10}$' then '+1' || right(regexp_replace(p, '\D', '', 'g'), 10)
    else p
  end
$$;

-- 1. Appointments: no uniqueness on phone, normalize everything.
update appointments
   set customer_phone = wx_e164(customer_phone)
 where customer_phone is distinct from wx_e164(customer_phone);

-- 2. Customers: (business_id, phone) is unique. Normalize where the normalized
--    number is not already present for that business; the leftovers are listed below.
update customers c
   set phone = wx_e164(c.phone)
 where c.phone is distinct from wx_e164(c.phone)
   and not exists (select 1 from customers d where d.business_id = c.business_id and d.phone = wx_e164(c.phone) and d.id <> c.id);

-- Duplicates that could not be merged automatically (same client saved twice in two formats):
select c.business_id, c.id, c.name, c.phone as unnormalized, d.id as keeps, d.phone
  from customers c join customers d
    on d.business_id = c.business_id and d.phone = wx_e164(c.phone) and d.id <> c.id
 where c.phone is distinct from wx_e164(c.phone);

-- 3. Keep it that way: normalize on every insert/update from any client (dashboard, bot, imports).
create or replace function wx_normalize_phone_trg() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'appointments' then new.customer_phone := wx_e164(new.customer_phone);
  elsif tg_table_name = 'customers' then new.phone := wx_e164(new.phone);
  end if;
  return new;
end $$;
drop trigger if exists wx_norm_phone on appointments;
create trigger wx_norm_phone before insert or update of customer_phone on appointments for each row execute function wx_normalize_phone_trg();
drop trigger if exists wx_norm_phone on customers;
create trigger wx_norm_phone before insert or update of phone on customers for each row execute function wx_normalize_phone_trg();
