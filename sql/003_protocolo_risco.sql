ALTER TABLE roger.alerts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'general';
CREATE UNIQUE INDEX IF NOT EXISTS alerts_risk_per_round
 ON roger.alerts(round_id) WHERE kind='risk';
