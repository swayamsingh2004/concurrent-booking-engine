CREATE TABLE resources (
    id         UUID        PRIMARY KEY DEFAULT uuidv7(),
    name       TEXT        NOT NULL,
    type       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);