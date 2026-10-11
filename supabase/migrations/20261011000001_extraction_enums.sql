-- AI Asis Phase 3 (1/2): new enum values.
-- Run this file ON ITS OWN, before 20261011000002_extraction.sql.
-- A new enum value cannot be used in the same transaction that adds it, so the two steps are separate files.

-- Job statuses requested for Phase 3: Queued, Processing, Needs Review, Completed, Failed.
-- 'queued' and 'failed' already exist. The older 'running', 'succeeded' and 'cancelled' stay but are unused.
alter type public.job_status add value if not exists 'processing';
alter type public.job_status add value if not exists 'needs_review';
alter type public.job_status add value if not exists 'completed';

-- 'completed' = AI extraction finished with no flags. It is NOT human verification ('verified' is).
alter type public.invoice_status add value if not exists 'completed';
