-- Whether an event appears on the landing page. Unlisted events stay bookable through their
-- direct link (/e/<slug>); only the public list (GET /api/events) leaves them out.
--
-- 1 (listed) is the default, so every existing event, and any row inserted without the column,
-- stays on the landing page. The CHECK keeps the column to 0 or 1.

ALTER TABLE events ADD COLUMN listed INTEGER NOT NULL DEFAULT 1 CHECK (listed IN (0, 1));
