CREATE OR REPLACE FUNCTION public.mbbs_rebuild_co_order(p_co_id bigint) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM co_orders WHERE id = p_co_id;
  INSERT INTO co_orders (
    id, co_ref, source_order_ref, from_location_id, from_location, to_location_id,
    to_location, status, dispatch_plan_id, dispatch_plan_date, dispatch_truck_plate,
    dispatch_load_name, dispatch_parking_spot, delivery_order_id, created_by,
    created_at, updated_at, received_by, received_at, loaded_at, details,
    status_updated_at, preparing_operator_id, preparing_started_at
  )
  SELECT id, co_ref, source_order_ref, from_location_id, from_location, to_location_id,
         to_location, status, dispatch_plan_id, dispatch_plan_date, dispatch_truck_plate,
         dispatch_load_name, dispatch_parking_spot, delivery_order_id, created_by,
         created_at, updated_at, received_by, received_at, loaded_at, details,
         updated_at, preparing_operator_id, preparing_started_at
    FROM local_co_orders
   WHERE id = p_co_id;
END;
$$;
