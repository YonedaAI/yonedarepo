UPDATE nodes
SET payload = json_set(payload, '$.data', json((SELECT payload FROM runs WHERE runs.id = nodes.id)))
WHERE json_extract(payload, '$.kind') = 'run'
  AND EXISTS (SELECT 1 FROM runs WHERE runs.id = nodes.id);
UPDATE nodes
SET payload = json_set(payload, '$.data', json((SELECT payload FROM candidates WHERE candidates.id = nodes.id)))
WHERE json_extract(payload, '$.kind') = 'candidate'
  AND EXISTS (SELECT 1 FROM candidates WHERE candidates.id = nodes.id);
