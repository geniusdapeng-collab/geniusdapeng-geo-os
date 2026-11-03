-- Keep the dispatch-time cash estimate across restart and ambiguous acceptance.
-- Older in-flight rows may have only a receipt estimate, or an unknown price.
ALTER TABLE generation_submissions
  ADD COLUMN dispatch_est_cny NUMERIC(16,2) CHECK (dispatch_est_cny >= 0);

CREATE FUNCTION guard_generation_dispatch_estimate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.dispatch_est_cny IS NOT NULL)
    OR (TG_OP = 'UPDATE' AND NEW.dispatch_est_cny IS DISTINCT FROM OLD.dispatch_est_cny
        AND NOT (OLD.state = 'submitting' AND NEW.state = 'submitting'
                 AND OLD.dispatch_count = 0 AND NEW.dispatch_count = 1)) THEN
    RAISE EXCEPTION 'generation dispatch estimate can only be set at first dispatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER generation_dispatch_estimate_guard BEFORE INSERT OR UPDATE ON generation_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_generation_dispatch_estimate();
