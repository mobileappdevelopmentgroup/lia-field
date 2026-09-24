-- Audit: tag writes recorded before 1.12.2 — READ ONLY, changes nothing.
--
-- Before 1.12.2 the phone recorded a tag write the moment it ASKED the plugin
-- to write, before any tag was near it, and the payload it sent was dropped by
-- the native side anyway (iOS wrote an empty message; Android failed the
-- record). So no fp_tag_writes row from before 2026-09-24 can be trusted to
-- describe a physical tag.
--
-- Each such row also changed the item: record_fp_tag_write() set
-- assets.tag_url to our certificate URL and assets.tag_label to the typed
-- label. Where the item had a supplier's link before, that link was
-- overwritten on the asset. It survives in fp_tag_links and fp_inspections,
-- which is what `supplier_link_elsewhere` reads back.
--
-- Paste into the Supabase SQL editor. Nothing here writes.

SELECT
  w.written_at,
  a.name                                    AS account,
  u.email                                   AS written_by,
  w.serial_num,
  w.tag_label                               AS label_claimed,
  w.prev_label,
  w.nfc_tag_uid                             AS uid_claimed,
  w.prev_uid,
  w.tag_url                                 AS url_claimed,
  s.tag_label                               AS asset_label_now,
  s.nfc_tag_uid                             AS asset_uid_now,
  s.tag_url                                 AS asset_url_now,
  -- Is this write still what the item says? If a later inspection or link
  -- sighting moved the asset on, the damage has already been undone.
  (s.tag_url = w.tag_url)                   AS asset_still_shows_write,
  -- The most recent link read off this item's tag that is NOT one of ours.
  (SELECT x.url FROM (
      SELECT l.tag_url AS url, l.last_seen_at AS at
        FROM public.fp_tag_links l WHERE l.asset_id = w.asset_id
      UNION ALL
      SELECT i.tag_url, coalesce(i.captured_at, i.inspection_date::timestamptz)
        FROM public.fp_inspections i WHERE i.asset_id = w.asset_id
    ) x
    WHERE x.url IS NOT NULL AND x.url <> ''
      AND x.url NOT LIKE (SELECT value FROM public.app_settings
                           WHERE key = 'certificate_base_url') || '%'
    ORDER BY x.at DESC LIMIT 1)            AS supplier_link_elsewhere,
  w.id                                      AS tag_write_id,
  w.asset_id
FROM public.fp_tag_writes w
JOIN public.assets   s ON s.id = w.asset_id
JOIN public.accounts a ON a.id = w.account_id
LEFT JOIN auth.users u ON u.id = w.written_by
WHERE w.written_at < '2026-09-24'
ORDER BY w.written_at;
