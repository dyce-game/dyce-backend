-- Audit trail of the nightly ledger invariant check (BUILD_PLAN Phase 5 gate: "ledger invariant clean for 14 days").
-- The API job inserts one row per run; `node db/ledger-gate.ts` reads them to say whether the gate is met.
-- Rows hold ids and amounts only (user ids, match ids, kobo), never phone numbers.

CREATE TABLE ledger_check_runs (
  id            bigserial PRIMARY KEY,
  ran_at        timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL CHECK (status IN ('clean', 'problems', 'error')),
  problem_count int NOT NULL DEFAULT 0 CHECK (problem_count >= 0),
  -- true when this run froze Pool for users whose cached balance disagreed with the ledger
  frozen        boolean NOT NULL DEFAULT false,
  -- the first problems found: [{ problem, ref, detail }]
  detail        jsonb NOT NULL DEFAULT '[]'::jsonb,
  error         text,
  CHECK ((status = 'clean') = (problem_count = 0 AND error IS NULL))
);
CREATE INDEX ledger_check_runs_ran_at_idx ON ledger_check_runs (ran_at DESC);

-- Append-only for the API role: it can record a run and read the history, never rewrite it.
GRANT SELECT, INSERT ON ledger_check_runs TO dyce_api;
GRANT USAGE ON SEQUENCE ledger_check_runs_id_seq TO dyce_api;
