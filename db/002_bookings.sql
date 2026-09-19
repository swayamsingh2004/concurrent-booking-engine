CREATE TABLE  bookings (
    id         UUID        PRIMARY KEY DEFAULT uuidv7(),
    resource_id UUID      NOT NULL REFERENCES resources(id) ON DELETE RESTRICT ,
    user_id    UUID        NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at  TIMESTAMPTZ NOT NULL,
    status     TEXT        NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ends_after_starts CHECK (end_at > start_at),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired'))
);