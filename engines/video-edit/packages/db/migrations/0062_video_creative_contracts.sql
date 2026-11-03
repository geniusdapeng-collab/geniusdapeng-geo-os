-- Creative contracts and immutable evidence alongside the existing pipeline ledger.

ALTER TABLE workspaces ADD CONSTRAINT workspaces_creative_scope_uq UNIQUE (tenant_id, id);
ALTER TABLE video_projects ADD CONSTRAINT video_projects_creative_scope_uq UNIQUE (workspace_id, id);
ALTER TABLE video_pipeline_runs ADD CONSTRAINT video_pipeline_runs_creative_scope_uq
  UNIQUE (tenant_id, workspace_id, project_id, id);
ALTER TABLE video_artifacts ADD CONSTRAINT video_artifacts_creative_scope_uq
  UNIQUE (tenant_id, workspace_id, project_id, pipeline_run_id, id);

CREATE TABLE video_creative_contracts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  contract_hash TEXT NOT NULL CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
  raw_intent_hash TEXT NOT NULL CHECK (raw_intent_hash ~ '^[a-f0-9]{64}$'),
  supersedes_hash TEXT,
  contract JSONB NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, project_id, revision),
  UNIQUE (tenant_id, workspace_id, project_id, contract_hash),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES video_projects(workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, project_id, supersedes_hash)
    REFERENCES video_creative_contracts(tenant_id, workspace_id, project_id, contract_hash),
  CHECK ((revision = 1 AND supersedes_hash IS NULL) OR (revision > 1 AND supersedes_hash IS NOT NULL)),
  CHECK ((contract->>'revision')::int IS NOT DISTINCT FROM revision),
  CHECK (contract->>'hash' IS NOT DISTINCT FROM contract_hash),
  CHECK (contract->>'rawIntentHash' IS NOT DISTINCT FROM raw_intent_hash),
  CHECK (contract#>>'{scope,tenantId}' IS NOT DISTINCT FROM tenant_id),
  CHECK (contract#>>'{scope,workspaceId}' IS NOT DISTINCT FROM workspace_id),
  CHECK (contract#>>'{scope,projectId}' IS NOT DISTINCT FROM project_id)
);

CREATE TABLE video_creative_run_contracts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, contract_hash),
  FOREIGN KEY (tenant_id, workspace_id, project_id, run_id)
    REFERENCES video_pipeline_runs(tenant_id, workspace_id, project_id, id),
  FOREIGN KEY (tenant_id, workspace_id, project_id, contract_hash)
    REFERENCES video_creative_contracts(tenant_id, workspace_id, project_id, contract_hash)
);

CREATE TABLE video_creative_g1_evidence (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('preproduction','candidates')),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  proof JSONB NOT NULL CHECK (jsonb_typeof(proof) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, contract_hash),
  FOREIGN KEY (tenant_id, workspace_id, project_id, run_id)
    REFERENCES video_pipeline_runs(tenant_id, workspace_id, project_id, id),
  FOREIGN KEY (run_id, contract_hash) REFERENCES video_creative_run_contracts(run_id, contract_hash),
  FOREIGN KEY (tenant_id, workspace_id, project_id, contract_hash)
    REFERENCES video_creative_contracts(tenant_id, workspace_id, project_id, contract_hash)
);

CREATE TABLE video_creative_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (candidate_hash ~ '^[a-f0-9]{64}$'),
  generation JSONB NOT NULL CHECK (jsonb_typeof(generation) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, project_id, run_id, artifact_id)
    REFERENCES video_artifacts(tenant_id, workspace_id, project_id, pipeline_run_id, id),
  FOREIGN KEY (tenant_id, workspace_id, project_id, contract_hash)
    REFERENCES video_creative_contracts(tenant_id, workspace_id, project_id, contract_hash),
  UNIQUE (run_id, candidate_hash)
);

CREATE TABLE video_creative_receipts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('started', 'applied', 'failed')),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  actor_id TEXT NOT NULL,
  run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, project_id, idempotency_key, phase),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES video_projects(workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, project_id, run_id)
    REFERENCES video_pipeline_runs(tenant_id, workspace_id, project_id, id)
);

CREATE INDEX video_creative_cache_lookup ON video_artifacts
  (tenant_id, workspace_id, project_id, (metadata->>'cacheKey')) WHERE role = 'creative-cache';
CREATE INDEX video_creative_repair_lookup ON video_artifacts
  (tenant_id, workspace_id, project_id, (metadata->>'contractHash'), (metadata->>'sourceHash'))
  WHERE role IN ('creative-event','creative-rejected-shot');
CREATE INDEX video_creative_operation_budget ON video_pipeline_operations
  (tenant_id, workspace_id, project_id, created_at) WHERE kind IN ('creative.model','creative.search','creative.media');

DO $$
DECLARE relation TEXT;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'video_creative_contracts', 'video_creative_run_contracts', 'video_creative_g1_evidence', 'video_creative_candidates', 'video_creative_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY creative_scope ON %I USING
      (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true))
      WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true))', relation);
    EXECUTE format('CREATE TRIGGER creative_append_only BEFORE UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION reject_video_control_append_only_mutation()', relation);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO workloom_app', relation);
  END LOOP;
END $$;
