-- Phase 8: a runaway query or an abandoned transaction must not be able to hold the database hostage.
-- These apply to every connection PostgREST opens for each role. Tune them with the numbers in docs/LOAD_TEST_RESULTS.md and production telemetry.
-- (Settings, not data: safe to re-run.)
alter role anon set statement_timeout = '5s';
alter role authenticated set statement_timeout = '20s';
alter role service_role set statement_timeout = '60s';              -- scheduled jobs and webhook processing do real work
alter role anon set idle_in_transaction_session_timeout = '15s';
alter role authenticated set idle_in_transaction_session_timeout = '30s';
alter role service_role set idle_in_transaction_session_timeout = '60s';
