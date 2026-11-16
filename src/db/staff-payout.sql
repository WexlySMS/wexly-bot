-- v222: who did the work at checkout. Feeds "Pay your team" on the Money page and the
-- "what do I owe Jess this week" text command. The app works without this column
-- (it retries the insert without it), but nothing gets attributed until it exists.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS staff_name text;
CREATE INDEX IF NOT EXISTS transactions_business_created_idx ON transactions (business_id, created_at DESC);
