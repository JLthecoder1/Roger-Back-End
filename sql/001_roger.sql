CREATE SCHEMA IF NOT EXISTS roger;
REVOKE ALL ON SCHEMA roger FROM PUBLIC;
CREATE TABLE IF NOT EXISTS roger.checkpoints (
 id text PRIMARY KEY, name text NOT NULL, task text NOT NULL, x float8 NOT NULL CHECK(x BETWEEN 0 AND 100),
 y float8 NOT NULL CHECK(y BETWEEN 0 AND 100), location text NOT NULL, created_at timestamptz DEFAULT now(), archived boolean DEFAULT false
);
CREATE TABLE IF NOT EXISTS roger.rounds (
 id uuid PRIMARY KEY, officer text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_round ON roger.rounds ((true)) WHERE finished_at IS NULL;
CREATE TABLE IF NOT EXISTS roger.checks (
 round_id uuid REFERENCES roger.rounds(id), id text REFERENCES roger.checkpoints(id), officer text NOT NULL,
 created_at timestamptz DEFAULT now(), outcome text, PRIMARY KEY(round_id,id)
);
CREATE TABLE IF NOT EXISTS roger.checkpoint_tasks (
 id uuid PRIMARY KEY, checkpoint_id text REFERENCES roger.checkpoints(id), parent_id uuid REFERENCES roger.checkpoint_tasks(id),
 title text NOT NULL, done integer NOT NULL DEFAULT 0 CHECK(done IN (0,1)), created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS roger.alerts (
 id uuid PRIMARY KEY, round_id uuid REFERENCES roger.rounds(id), message text NOT NULL,
 created_at timestamptz DEFAULT now(), acknowledged_at timestamptz
);
CREATE TABLE IF NOT EXISTS roger.voice_sessions (
 id uuid PRIMARY KEY, round_id uuid REFERENCES roger.rounds(id), agent_id text,
 expires_at timestamptz NOT NULL, ended_at timestamptz
);

ALTER TABLE roger.checkpoint_tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS roger.task_reports (
 id uuid PRIMARY KEY,
 round_id uuid NOT NULL REFERENCES roger.rounds(id),
 task_id uuid NOT NULL REFERENCES roger.checkpoint_tasks(id),
 task_title text NOT NULL,
 checkpoint_name text NOT NULL,
 location text NOT NULL,
 officer text NOT NULL,
 done boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS task_reports_round_task_date
 ON roger.task_reports(round_id, task_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS task_reports_date ON roger.task_reports(created_at DESC);

ALTER TABLE roger.voice_sessions ADD COLUMN IF NOT EXISTS role text CHECK (role IN ('painel','ronda'));
