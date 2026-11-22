CREATE TABLE IF NOT EXISTS roger.round_photos (
 id uuid PRIMARY KEY,
 round_id uuid NOT NULL REFERENCES roger.rounds(id),
 officer text NOT NULL,
 image bytea NOT NULL CHECK (octet_length(image) BETWEEN 5 AND 2097152),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS round_photos_recent
 ON roger.round_photos(created_at DESC,id DESC);
