UPDATE nodes
SET payload = json_set(payload, '$.data', json((SELECT payload FROM executions WHERE executions.id = nodes.id)))
WHERE json_extract(payload, '$.kind') = 'execution'
  AND EXISTS (SELECT 1 FROM executions WHERE executions.id = nodes.id);
