-- A worker may disappear after claiming but before any external dispatch is authorized.
-- Replace only the original owner's zero-dispatch reservation under the same project lease.
CREATE OR REPLACE FUNCTION guard_generation_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM render_scripts s
      JOIN video_projects p ON p.id=s.project_id AND p.workspace_id=s.workspace_id
      JOIN workspaces w ON w.id=s.workspace_id
      WHERE s.id=NEW.script_id AND s.version=NEW.script_version AND s.project_id=NEW.project_id
        AND s.workspace_id=NEW.workspace_id AND w.tenant_id=NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'generation submission scope mismatch';
    END IF;
    IF NEW.state <> 'reserved' OR NEW.owner_token IS NOT NULL OR NEW.dispatch_count <> 0 THEN
      RAISE EXCEPTION 'generation submission must begin reserved';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.script_id, NEW.script_version,
           NEW.idempotency_key, NEW.request_hash, NEW.job_id, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.script_id, OLD.script_version,
           OLD.idempotency_key, OLD.request_hash, OLD.job_id, OLD.created_at) THEN
      RAISE EXCEPTION 'generation submission identity is immutable';
    END IF;
    IF OLD.owner_token IS NOT NULL AND NEW.owner_token IS DISTINCT FROM OLD.owner_token THEN
      IF NOT (OLD.state='submitting' AND NEW.state='submitting'
        AND OLD.dispatch_count=0 AND NEW.dispatch_count=0 AND NEW.owner_token IS NOT NULL
        AND OLD.provider IS NULL AND OLD.provider_model IS NULL AND OLD.task_id IS NULL AND OLD.receipt IS NULL
        AND NEW.provider IS NULL AND NEW.provider_model IS NULL AND NEW.task_id IS NULL AND NEW.receipt IS NULL
        AND NEW.last_error IS NOT DISTINCT FROM OLD.last_error
        AND EXISTS (
          SELECT 1 FROM production_qualifications q
           WHERE q.tenant_id=OLD.tenant_id AND q.workspace_id=OLD.workspace_id AND q.project_id=OLD.project_id
             AND q.script_id=OLD.script_id AND q.script_version=OLD.script_version
             AND q.request_hash=OLD.request_hash AND q.status='passed'
             AND OLD.idempotency_key='render:' || q.request_hash
        )
        -- The key must match archive-host.ts projectRunLockKey.
        AND pg_try_advisory_xact_lock(hashtext(
          '["archive-run",' || to_json(OLD.tenant_id)::text || ',' || to_json(OLD.workspace_id)::text
            || ',' || to_json(OLD.project_id)::text || ']'
        ))
      ) THEN
        RAISE EXCEPTION 'generation submission owner is immutable';
      END IF;
    END IF;
    IF NOT ((OLD.state='reserved' AND NEW.state='submitting')
      OR (OLD.state='submitting' AND NEW.state IN ('submitting','accepted','rejected','unknown'))
      OR (OLD.state='accepted' AND NEW.state='finalized')) THEN
      RAISE EXCEPTION 'generation submission transition forbidden';
    END IF;
    IF OLD.state='accepted' AND ROW(NEW.provider, NEW.provider_model, NEW.task_id, NEW.receipt, NEW.dispatch_count)
       IS DISTINCT FROM ROW(OLD.provider, OLD.provider_model, OLD.task_id, OLD.receipt, OLD.dispatch_count) THEN
      RAISE EXCEPTION 'generation accepted receipt is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
