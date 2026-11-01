-- ============================================================================
-- 0061_video_pipeline_operations.sql
-- Durable reserve -> dispatch -> accepted/failed/unknown state for every
-- external or billable action. Provider adapters may perform the network call,
-- but completion evidence lives here and unknown results always reconcile.
-- ============================================================================

CREATE TABLE video_pipeline_operations (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  project_id        TEXT NOT NULL REFERENCES video_projects(id),
  pipeline_run_id   TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  stage_run_id      TEXT NOT NULL REFERENCES production_stage_runs(id),
  operation_key     TEXT NOT NULL,
  kind              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'reserved'
                    CHECK (state IN ('reserved','dispatched','accepted','failed','unknown')),
  idempotency_key   TEXT NOT NULL,
  request_hash      TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request           JSONB NOT NULL,
  external_id       TEXT,
  receipt           JSONB,
  cost              JSONB NOT NULL DEFAULT '{}'::jsonb,
  error             JSONB,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at     TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (stage_run_id, operation_key),
  CHECK (jsonb_typeof(request) = 'object'),
  CHECK (jsonb_typeof(cost) = 'object'),
  CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
  CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CHECK ((state = 'reserved' AND dispatched_at IS NULL AND finished_at IS NULL)
      OR (state = 'dispatched' AND dispatched_at IS NOT NULL AND finished_at IS NULL)
      OR (state IN ('accepted','failed','unknown') AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE INDEX idx_video_pipeline_operations_run
  ON video_pipeline_operations (pipeline_run_id, created_at);
CREATE INDEX idx_video_pipeline_operations_open
  ON video_pipeline_operations (workspace_id, state, updated_at)
  WHERE state IN ('reserved','dispatched');

CREATE OR REPLACE FUNCTION guard_video_pipeline_operation_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'video operation ledger is append-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM video_pipeline_runs r
      JOIN production_stage_runs s ON s.id = NEW.stage_run_id
     WHERE r.id = NEW.pipeline_run_id
       AND r.tenant_id = NEW.tenant_id
       AND r.workspace_id = NEW.workspace_id
       AND r.project_id = NEW.project_id
       AND s.pipeline_run_id = r.id
       AND s.workspace_id = NEW.workspace_id
       AND s.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'video operation scope mismatch';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.pipeline_run_id,
    NEW.stage_run_id, NEW.operation_key, NEW.kind, NEW.idempotency_key,
    NEW.request_hash, NEW.request, NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.pipeline_run_id,
    OLD.stage_run_id, OLD.operation_key, OLD.kind, OLD.idempotency_key,
    OLD.request_hash, OLD.request, OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'video operation identity is immutable';
  END IF;

  IF OLD.state IN ('accepted','failed','unknown') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'terminal video operation cannot be reopened';
  END IF;
  IF OLD.state IN ('accepted','failed','unknown') AND ROW(
    NEW.external_id, NEW.receipt, NEW.cost, NEW.error, NEW.dispatched_at, NEW.finished_at
  ) IS DISTINCT FROM ROW(
    OLD.external_id, OLD.receipt, OLD.cost, OLD.error, OLD.dispatched_at, OLD.finished_at
  ) THEN
    RAISE EXCEPTION 'terminal video operation receipt is immutable';
  END IF;
  IF OLD.state = 'reserved' AND NEW.state NOT IN ('reserved','dispatched','failed','unknown') THEN
    RAISE EXCEPTION 'video operation cannot skip dispatch';
  END IF;
  IF OLD.state = 'dispatched' AND NEW.state NOT IN ('dispatched','accepted','failed','unknown') THEN
    RAISE EXCEPTION 'invalid terminal video operation state';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER video_pipeline_operations_scope_guard
BEFORE INSERT OR UPDATE OR DELETE ON video_pipeline_operations
FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_operation_scope();

ALTER TABLE video_pipeline_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_pipeline_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY video_pipeline_operations_scope ON video_pipeline_operations
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE ON video_pipeline_operations TO workloom_app, workloom_gateway;
