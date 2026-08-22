CREATE TABLE IF NOT EXISTS delivery_instruction_translation_cache (
  source_hash text NOT NULL,
  target_language text NOT NULL CHECK (target_language IN ('en', 'zh-CN')),
  model text NOT NULL,
  source_language text NOT NULL CHECK (source_language IN ('en', 'zh-CN')),
  source_text text NOT NULL,
  translated_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, target_language, model)
);

CREATE INDEX IF NOT EXISTS idx_delivery_instruction_translation_cache_updated
  ON delivery_instruction_translation_cache (updated_at DESC);
