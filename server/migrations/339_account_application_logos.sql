-- One letterhead logo per company for account applications (customer form and signed PDF).
-- Stored normalized to PNG (at most 800x300). Logos are public branding, not sensitive data.
CREATE TABLE account_application_logos (
 company text PRIMARY KEY CHECK(company IN ('MBBS','MBT','MBR')),
 image_png bytea NOT NULL CHECK(octet_length(image_png) BETWEEN 1 AND 2097152),
 sha256 text NOT NULL,
 width integer NOT NULL CHECK(width>0),
 height integer NOT NULL CHECK(height>0),
 updated_by text REFERENCES operators(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
