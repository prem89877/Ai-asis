-- AI Asis: Zoho Sheet, Zoho Books and TallyPrime connections (migration 020).
-- Prerequisite: 010_integrations.sql. STATUS: written, NOT executed against a real database. Run it on a scratch project first.
--
-- What changes (additive, nothing is dropped except two CHECK constraints that are re-created wider):
--  * integration_connections.provider and oauth_states.provider accept 'zoho_sheet', 'zoho_books', 'tally_prime'.
--  * integration_connections.region: the Zoho data centre of the account (com, in, eu, com.au, jp, ca, sa, uk). NULL for other providers.
--    It is not a secret, so browsers may read it (column grant extended).
--  * oauth_states.region: the data centre chosen on the Connect screen, carried through the Zoho sign-in.
--  * For tally_prime the connection URL (and optional token) is stored ENCRYPTED in refresh_token_enc, like every other secret.
-- Rollback: delete the zoho_* / tally_prime rows, drop the two columns, re-create the old CHECKs from 010.

alter table public.integration_connections drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections add constraint integration_connections_provider_check
  check (provider in ('google_sheets', 'microsoft_excel', 'zoho_sheet', 'zoho_books', 'tally_prime'));

alter table public.oauth_states drop constraint if exists oauth_states_provider_check;
alter table public.oauth_states add constraint oauth_states_provider_check
  check (provider in ('google_sheets', 'microsoft_excel', 'zoho_sheet', 'zoho_books'));

alter table public.integration_connections add column if not exists region text
  check (region is null or region in ('com', 'in', 'eu', 'com.au', 'jp', 'ca', 'sa', 'uk'));
alter table public.oauth_states add column if not exists region text
  check (region is null or region in ('com', 'in', 'eu', 'com.au', 'jp', 'ca', 'sa', 'uk'));

grant select (region) on public.integration_connections to authenticated;
