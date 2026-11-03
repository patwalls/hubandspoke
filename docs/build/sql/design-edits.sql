-- Designs learn from what editors change: how many AI-drafted designs (with
-- the untouched draft kept in design_docs.generated_doc, 2026-11-03+) were
-- changed by hand, by brand + format, and how many of those were exported.
-- The per-element diff itself is src/lib/design-editor/design-edits.ts.
SELECT b.slug AS brand,
       pi.format,
       count(*) AS drafted,
       count(*) FILTER (WHERE d.doc <> d.generated_doc) AS edited,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM design_renders r WHERE r.design_doc_id = d.id AND r.status = 'done')) AS exported,
       max(d.updated_at)::date AS last_edit
FROM design_docs d
JOIN production_items pi ON pi.id = d.production_item_id
LEFT JOIN accounts a ON a.id = pi.account_id
LEFT JOIN brands b ON b.id = a.brand_id
WHERE d.generated_doc IS NOT NULL
GROUP BY 1, 2
ORDER BY drafted DESC;
