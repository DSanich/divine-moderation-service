-- Persist interpreted Video Seal metadata alongside the durable moderation record.
-- The value is stored as JSON text so the signal shape can evolve without
-- requiring a migration for each additional field.

ALTER TABLE moderation_results ADD COLUMN videoseal TEXT;
