CREATE TABLE IF NOT EXISTS csv_row (
    id            INTEGER PRIMARY KEY,
    name          VARCHAR(255),
    email         VARCHAR(255),
    body          TEXT,
    date_created  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    post_id       BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS csv_row_history (
    id            SERIAL PRIMARY KEY,
    row_id        INTEGER NOT NULL,
    name          VARCHAR(255),
    email         VARCHAR(255),
    body          TEXT,
    date_created  TIMESTAMPTZ NOT NULL,
    post_id       BIGINT NOT NULL,
    date_archived TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_row_id
    FOREIGN KEY (row_id)
    REFERENCES csv_row(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_csv_row_history_row_id ON csv_row_history(row_id);
