-- Idempotency keys: make retrying a request safe.
--
-- The client generates a key (one per logical operation) and sends it with the original
-- request AND every retry. The server records the response against that key, so a retry
-- returns the ORIGINAL answer instead of doing the work a second time.
--
-- Why the client must supply it: only the client knows whether it is retrying. Two
-- identical requests may be one retried operation or two deliberate ones, and nothing in
-- the request body can distinguish them. The server has to be told, not left to guess.

CREATE TABLE idempotency_keys (
  -- Client-generated, globally unique. TEXT rather than UUID so a malformed key is a
  -- clean application-level error instead of a Postgres cast failure.
  -- The length floor stops a client using a trivially collidable key like "1".
  key           TEXT        PRIMARY KEY CHECK (length(key) BETWEEN 8 AND 255),

  -- Hash of the request body. Global uniqueness of the key is a promise the CLIENT makes,
  -- and clients have bugs: the same key can legitimately arrive carrying a DIFFERENT body
  -- (user edits the form and resubmits, retry logic reuses a key object, or someone does
  -- it deliberately). Without this column the server would cheerfully return the stored
  -- response for the old body, showing the user a confirmation for something they did not
  -- ask for. With it, that case becomes a loud 422.
  request_hash  TEXT        NOT NULL,

  -- The stored response. NULL means "claimed, work still in progress".
  -- The status code is stored too: a retry of a 201 must answer 201, not 200.
  -- The whole body is stored rather than re-fetching the booking, because a retry must
  -- return what the ORIGINAL returned -- the booking may have been confirmed since.
  status_code   INTEGER,
  response_body JSONB,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keys live 24 hours, then get swept. Retries happen within seconds (minutes at most with
-- backoff), so anything older is dead weight. A fixed TTL also works identically for
-- successes and failures, and keeps the table bounded -- unlike tying retention to the
-- booking's end time, which would mean storing a key for 15 months for a booking made far
-- in advance, and would have no answer at all for requests that created no booking.
CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at);
