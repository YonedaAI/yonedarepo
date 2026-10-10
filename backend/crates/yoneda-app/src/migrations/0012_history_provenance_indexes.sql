CREATE INDEX IF NOT EXISTS evaluations_by_candidate ON evaluations(json_extract(payload,'$.candidate'),id);
CREATE INDEX IF NOT EXISTS artifacts_by_producer ON artifacts(json_extract(payload,'$.producer'),id);
CREATE INDEX IF NOT EXISTS artifacts_by_producer_execution ON artifacts(json_extract(payload,'$.producer.execution'),id);
CREATE INDEX IF NOT EXISTS artifacts_by_producer_execution_id ON artifacts(json_extract(payload,'$.producer.execution.id'),id);
