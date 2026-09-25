-- A collection links to its delivery parent without replacing that delivery.
-- Preserve identity, assignments, active state and cargo of existing returns.
UPDATE dispatch_global_order_splits definition
   SET definition_kind = 'derived',
       full_order = (definition.full_order - 'originalOrderId')
         || jsonb_build_object('globalOrderDefinitionKind', 'derived', 'isSplit', false),
       card = (definition.card - 'originalOrderId')
         || jsonb_build_object('globalOrderDefinitionKind', 'derived', 'isSplit', false)
 WHERE definition.definition_kind = 'split'
   AND definition.order_type = 'CUSTOM'
   AND definition.split_ref ~ '^SOR[0-9]+(-S[0-9]+)?-Return$'
   AND (definition.full_order->>'orderKind' = 'sor_rental_return'
     OR EXISTS (SELECT 1 FROM dispatch_custom_orders collection
                 WHERE collection.ref_number = definition.split_ref
                   AND collection.order_kind = 'sor_rental_return'));
