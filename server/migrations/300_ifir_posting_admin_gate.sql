INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES ('netsuite_ifir_posting_restlet', false,
  'Use the IR/IF RESTlet response for transaction numbers and verification; off retains native posting.')
ON CONFLICT (flag_key) DO NOTHING;
