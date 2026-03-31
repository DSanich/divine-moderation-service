-- Persist Nostr event metadata at classification time for DM notifications,
-- moderation notice pages, and appeal context. Data is frozen at the time of
-- moderation action -- if content is later banned and the relay event deleted,
-- this is the only record of what the content was.

ALTER TABLE moderation_results ADD COLUMN title TEXT;
ALTER TABLE moderation_results ADD COLUMN author TEXT;
ALTER TABLE moderation_results ADD COLUMN event_id TEXT;
ALTER TABLE moderation_results ADD COLUMN content_url TEXT;
ALTER TABLE moderation_results ADD COLUMN published_at TEXT;
