CREATE TABLE IF NOT EXISTS csv_file (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    path          TEXT NOT NULL,
    date_uploaded TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
