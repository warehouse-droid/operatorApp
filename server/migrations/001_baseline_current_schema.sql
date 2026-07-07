--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: mbbs_co_line_canonical_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mbbs_co_line_canonical_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM mbbs_rebuild_co_order_lines(OLD.co_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.co_id IS DISTINCT FROM OLD.co_id) THEN
    PERFORM mbbs_rebuild_co_order_lines(NEW.co_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: mbbs_co_line_receiving_legacy_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mbbs_co_line_receiving_legacy_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE local_co_order_lines
     SET received_pallet_qty = NEW.received_pallet_qty,
         received_layer_qty = NEW.received_layer_qty,
         received_section_qty = NEW.received_section_qty,
         received_piece_qty = NEW.received_piece_qty,
         confirmed_at = NEW.confirmed_at,
         confirmed_by = NEW.confirmed_by
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;


--
-- Name: mbbs_co_order_canonical_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mbbs_co_order_canonical_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM mbbs_rebuild_co_order(OLD.id);
    PERFORM mbbs_rebuild_co_order_lines(OLD.id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.id IS DISTINCT FROM OLD.id) THEN
    PERFORM mbbs_rebuild_co_order(NEW.id);
    PERFORM mbbs_rebuild_co_order_lines(NEW.id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: mbbs_co_receiving_legacy_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mbbs_co_receiving_legacy_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  UPDATE local_co_orders
     SET status = NEW.status,
         received_by = NEW.received_by,
         received_at = NEW.received_at,
         updated_at = NEW.updated_at,
         loaded_at = NEW.loaded_at,
         details = NEW.details
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;


--
-- Name: mbbs_rebuild_co_order(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mbbs_rebuild_co_order(p_co_id bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM co_orders WHERE id = p_co_id;
  INSERT INTO co_orders SELECT * FROM local_co_orders WHERE id = p_co_id;
END;
$$;


--
-- Name: mbbs_rebuild_co_order_lines(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mbbs_rebuild_co_order_lines(p_co_id bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM co_order_lines WHERE co_id = p_co_id;
  INSERT INTO co_order_lines SELECT * FROM local_co_order_lines WHERE co_id = p_co_id;
END;
$$;


--
-- Name: canonical_order_line_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canonical_order_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: co_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.co_order_lines (
    id bigint NOT NULL,
    co_id bigint,
    line_id bigint,
    item_id bigint,
    item_name text,
    item_type text,
    item_type_text text,
    item_description text,
    sku text,
    quantity numeric,
    unit text,
    pallet_qty numeric,
    layer_qty numeric,
    piece_qty numeric,
    section_qty numeric,
    to_plt numeric,
    to_lyr numeric,
    to_sec numeric,
    to_pcs numeric,
    received_pallet_qty numeric,
    received_layer_qty numeric,
    received_piece_qty numeric,
    received_section_qty numeric,
    confirmed_at timestamp with time zone,
    confirmed_by text,
    raw jsonb,
    item_weight numeric
);


--
-- Name: co_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.co_orders (
    id bigint NOT NULL,
    co_ref text,
    source_order_ref text,
    from_location_id bigint,
    from_location text,
    to_location_id bigint,
    to_location text,
    status text,
    dispatch_plan_id bigint,
    dispatch_plan_date date,
    dispatch_truck_plate text,
    dispatch_load_name text,
    dispatch_parking_spot text,
    delivery_order_id bigint,
    created_by text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    received_by text,
    received_at timestamp with time zone,
    loaded_at timestamp with time zone,
    details jsonb,
    status_updated_at timestamp with time zone
);


--
-- Name: customer_pickup_load_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_pickup_load_records (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    operator_id text,
    photo_data_url text NOT NULL,
    loaded_pallet_qty numeric DEFAULT 0 NOT NULL,
    loaded_layer_qty numeric DEFAULT 0 NOT NULL,
    loaded_piece_qty numeric DEFAULT 0 NOT NULL,
    loaded_section_qty numeric DEFAULT 0 NOT NULL,
    response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    loaded_qty numeric DEFAULT 0,
    loaded_uom text
);


--
-- Name: customer_pickup_load_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_pickup_load_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_pickup_load_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_pickup_load_records_id_seq OWNED BY public.customer_pickup_load_records.id;


--
-- Name: cycle_count_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_count_lines (
    id bigint NOT NULL,
    record_id bigint NOT NULL,
    item_id bigint NOT NULL,
    location_id bigint NOT NULL,
    counted_pallet_qty numeric DEFAULT 0 NOT NULL,
    counted_layer_qty numeric DEFAULT 0 NOT NULL,
    system_on_hand_qty numeric,
    system_available_qty numeric,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    counted_section_qty numeric DEFAULT 0 NOT NULL,
    counted_piece_qty numeric DEFAULT 0 NOT NULL,
    counted_total_qty numeric,
    variance_qty numeric,
    to_plt numeric,
    to_lyr numeric,
    to_sec numeric,
    to_pcs numeric
);


--
-- Name: cycle_count_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cycle_count_lines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cycle_count_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cycle_count_lines_id_seq OWNED BY public.cycle_count_lines.id;


--
-- Name: cycle_count_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_count_records (
    id bigint NOT NULL,
    operator_id text,
    status text DEFAULT 'draft'::text NOT NULL,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cycle_count_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text])))
);


--
-- Name: cycle_count_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cycle_count_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cycle_count_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cycle_count_records_id_seq OWNED BY public.cycle_count_records.id;


--
-- Name: delivery_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_audit_log (
    id bigint NOT NULL,
    actor_type text DEFAULT 'operator'::text NOT NULL,
    actor_operator_id text,
    source text DEFAULT 'delivery'::text NOT NULL,
    action text NOT NULL,
    order_id bigint,
    line_id bigint,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.delivery_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: delivery_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.delivery_audit_log_id_seq OWNED BY public.delivery_audit_log.id;


--
-- Name: delivery_fulfillment_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_fulfillment_records (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    operator_id text,
    item_fulfillment_id bigint,
    item_fulfillment_tranid text,
    fulfillment_status text DEFAULT 'submitted'::text NOT NULL,
    photo_data_url text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_fulfillment_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.delivery_fulfillment_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: delivery_fulfillment_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.delivery_fulfillment_records_id_seq OWNED BY public.delivery_fulfillment_records.id;


--
-- Name: delivery_preparation_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_preparation_records (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    operator_name text,
    photo_path text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_preparation_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.delivery_preparation_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: delivery_preparation_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.delivery_preparation_records_id_seq OWNED BY public.delivery_preparation_records.id;


--
-- Name: dispatch_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_audit_log (
    id bigint NOT NULL,
    action text NOT NULL,
    entity_type text,
    entity_id text,
    order_id text,
    load_id text,
    truck_id text,
    session_id text,
    operator_id text,
    operator_name text,
    source text DEFAULT 'dispatch'::text NOT NULL,
    before_state jsonb,
    after_state jsonb,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_id bigint,
    plan_date date
);


--
-- Name: dispatch_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_audit_log_id_seq OWNED BY public.dispatch_audit_log.id;


--
-- Name: dispatch_ollama_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_ollama_audit (
    id bigint NOT NULL,
    parser_type text NOT NULL,
    model text NOT NULL,
    source_ref text,
    prompt text NOT NULL,
    response text,
    parsed jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_ollama_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_ollama_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_ollama_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_ollama_audit_id_seq OWNED BY public.dispatch_ollama_audit.id;


--
-- Name: dispatch_operator_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_operator_requests (
    id bigint NOT NULL,
    request_type text NOT NULL,
    order_ref text NOT NULL,
    source_order_type text,
    status text DEFAULT 'open'::text NOT NULL,
    requested_by text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: dispatch_operator_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_operator_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_operator_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_operator_requests_id_seq OWNED BY public.dispatch_operator_requests.id;


--
-- Name: dispatch_parser_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_parser_rules (
    rule_key text NOT NULL,
    rule_value text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_plan_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_plan_snapshots (
    plan_id bigint NOT NULL,
    orders jsonb DEFAULT '[]'::jsonb NOT NULL,
    trucks jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    saved_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_plans (
    id bigint NOT NULL,
    plan_date date NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    note text,
    created_by bigint,
    confirmed_by bigint,
    confirmed_at timestamp with time zone,
    revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_plans_id_seq OWNED BY public.dispatch_plans.id;


--
-- Name: dispatch_so_po_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_so_po_allocations (
    id bigint NOT NULL,
    sales_order_id bigint NOT NULL,
    sales_order_ref text NOT NULL,
    sales_line_id bigint NOT NULL,
    po_order_id bigint NOT NULL,
    po_order_ref text NOT NULL,
    po_line_id bigint NOT NULL,
    item_id bigint,
    item_name text,
    sku text,
    allocated_pallet_qty numeric DEFAULT 0 NOT NULL,
    allocated_layer_qty numeric DEFAULT 0 NOT NULL,
    allocated_section_qty numeric DEFAULT 0 NOT NULL,
    allocated_piece_qty numeric DEFAULT 0 NOT NULL,
    allocated_sales_qty numeric DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_by text,
    cancelled_at timestamp with time zone,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT dispatch_so_po_allocations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])))
);


--
-- Name: dispatch_so_po_allocations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_so_po_allocations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_so_po_allocations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_so_po_allocations_id_seq OWNED BY public.dispatch_so_po_allocations.id;


--
-- Name: dispatch_truck_location_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_truck_location_history (
    id bigint NOT NULL,
    plate text NOT NULL,
    vehicle_id text,
    vehicle_name text,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    heading_degrees double precision,
    speed_miles_per_hour double precision,
    formatted_location text,
    location_time timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_truck_location_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_truck_location_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_truck_location_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_truck_location_history_id_seq OWNED BY public.dispatch_truck_location_history.id;


--
-- Name: dispatch_vendor_yards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_vendor_yards (
    id bigint NOT NULL,
    vendor text NOT NULL,
    yard text NOT NULL,
    aliases text DEFAULT ''::text NOT NULL,
    day_label text DEFAULT 'Mon-Fri'::text NOT NULL,
    window_start text DEFAULT ''::text NOT NULL,
    window_end text DEFAULT ''::text NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_vendor_yards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_vendor_yards_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_vendor_yards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_vendor_yards_id_seq OWNED BY public.dispatch_vendor_yards.id;


--
-- Name: driver_day_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_day_records (
    id bigint NOT NULL,
    driver_login text NOT NULL,
    plan_id bigint,
    plan_date date NOT NULL,
    truck_id text,
    truck_plate text,
    samsara_username text,
    samsara_driver_id text,
    samsara_vehicle_id text,
    samsara_assignment_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    samsara_on_duty_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    samsara_off_duty_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    pre_dvir_photo_data_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    post_dvir_photo_data_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    pre_dvir_completed_at timestamp with time zone,
    post_dvir_completed_at timestamp with time zone,
    on_duty_at timestamp with time zone,
    off_duty_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_day_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.driver_day_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: driver_day_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.driver_day_records_id_seq OWNED BY public.driver_day_records.id;


--
-- Name: driver_job_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_job_records (
    id bigint NOT NULL,
    job_id text NOT NULL,
    plan_id bigint,
    plan_date date,
    driver_login text NOT NULL,
    truck_id text,
    truck_plate text,
    load_id text,
    load_name text,
    stop_id text,
    stop_type text NOT NULL,
    order_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    photo_data_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'complete'::text NOT NULL,
    completed_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone
);


--
-- Name: driver_job_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.driver_job_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: driver_job_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.driver_job_records_id_seq OWNED BY public.driver_job_records.id;


--
-- Name: inventory_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_balances (
    item_id bigint NOT NULL,
    location_id bigint NOT NULL,
    location text,
    quantity_on_hand numeric DEFAULT 0 NOT NULL,
    quantity_available numeric DEFAULT 0 NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inventory_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_items (
    item_id bigint NOT NULL,
    item_name text NOT NULL,
    display_name text,
    item_description text,
    item_type text,
    item_type_text text,
    stock_unit text,
    product_type text,
    brand text,
    series text,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    classification_updated_at timestamp with time zone,
    classification_updated_by text,
    to_plt numeric,
    to_lyr numeric,
    to_sec numeric,
    to_pcs numeric,
    item_weight numeric
);


--
-- Name: local_co_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_co_order_lines (
    id bigint NOT NULL,
    co_id bigint NOT NULL,
    line_id bigint NOT NULL,
    item_id bigint,
    item_name text,
    item_type text DEFAULT 'InvtPart'::text NOT NULL,
    item_type_text text,
    item_description text,
    sku text,
    quantity numeric,
    unit text,
    pallet_qty numeric,
    layer_qty numeric,
    piece_qty numeric,
    section_qty numeric,
    to_plt numeric,
    to_lyr numeric,
    to_sec numeric,
    to_pcs numeric,
    received_pallet_qty numeric DEFAULT 0 NOT NULL,
    received_layer_qty numeric DEFAULT 0 NOT NULL,
    received_piece_qty numeric DEFAULT 0 NOT NULL,
    received_section_qty numeric DEFAULT 0 NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_by text,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    item_weight numeric
);


--
-- Name: local_co_order_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.local_co_order_lines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: local_co_order_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.local_co_order_lines_id_seq OWNED BY public.local_co_order_lines.id;


--
-- Name: local_co_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_co_orders (
    id bigint NOT NULL,
    co_ref text NOT NULL,
    source_order_ref text NOT NULL,
    from_location_id bigint,
    from_location text,
    to_location_id bigint,
    to_location text,
    status text DEFAULT 'planned'::text NOT NULL,
    dispatch_plan_id bigint,
    dispatch_plan_date date,
    dispatch_truck_plate text,
    dispatch_load_name text,
    dispatch_parking_spot text,
    delivery_order_id bigint,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    received_by text,
    received_at timestamp with time zone,
    loaded_at timestamp with time zone,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: local_co_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.local_co_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: local_co_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.local_co_orders_id_seq OWNED BY public.local_co_orders.id;


--
-- Name: local_co_receipt_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_co_receipt_records (
    id bigint NOT NULL,
    co_id bigint NOT NULL,
    operator_id text,
    photo_data_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_delivery_order_id bigint,
    response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: local_co_receipt_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.local_co_receipt_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: local_co_receipt_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.local_co_receipt_records_id_seq OWNED BY public.local_co_receipt_records.id;


--
-- Name: netsuite_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.netsuite_tokens (
    id integer DEFAULT 1 NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    token_type text,
    expires_at timestamp with time zone,
    scope text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT single_token_row CHECK ((id = 1))
);


--
-- Name: operator_load_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_load_records (
    id bigint NOT NULL,
    load_type text NOT NULL,
    order_family text NOT NULL,
    order_id bigint,
    order_ref text,
    source_table text,
    source_record_id bigint,
    operator_id text,
    photo_data_url text DEFAULT ''::text NOT NULL,
    loaded_qty numeric,
    loaded_uom text,
    line_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_load_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.operator_load_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: operator_load_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.operator_load_records_id_seq OWNED BY public.operator_load_records.id;


--
-- Name: operator_record_warnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_record_warnings (
    id bigint NOT NULL,
    operator_id text,
    record_type text NOT NULL,
    record_id text NOT NULL,
    reference text,
    reason text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    handled_by text,
    handled_at timestamp with time zone,
    resolution text,
    CONSTRAINT operator_record_warnings_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);


--
-- Name: operator_record_warnings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.operator_record_warnings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: operator_record_warnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.operator_record_warnings_id_seq OWNED BY public.operator_record_warnings.id;


--
-- Name: operator_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_sessions (
    token_hash text NOT NULL,
    operator_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operators (
    id text NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    password_salt text NOT NULL,
    role text DEFAULT 'operator'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operators_role_check CHECK ((role = ANY (ARRAY['operator'::text, 'dispatcher'::text, 'admin'::text])))
);


--
-- Name: purchase_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_order_lines (
    id bigint DEFAULT nextval('public.canonical_order_line_id_seq'::regclass) NOT NULL,
    purchase_order_id bigint,
    line_id bigint,
    item_id bigint,
    item_name text,
    sku text,
    item_description text,
    item_type text,
    item_type_text text,
    quantity numeric,
    unit text,
    location_id bigint,
    location text,
    pallet_qty numeric,
    layer_qty numeric,
    section_qty numeric,
    piece_qty numeric,
    to_plt numeric,
    to_lyr numeric,
    to_sec numeric,
    to_pcs numeric,
    received_pallet_qty numeric,
    received_layer_qty numeric,
    received_section_qty numeric,
    received_piece_qty numeric,
    netsuite_received_qty numeric,
    netsuite_active boolean,
    sync_exception text,
    synced_at timestamp with time zone,
    item_weight numeric,
    sync_exception_at timestamp with time zone,
    raw jsonb,
    confirmed_at timestamp with time zone,
    confirmed_by text
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    netsuite_id bigint NOT NULL,
    tranid text,
    trandate date,
    vendor_id bigint,
    vendor text,
    status text,
    status_text text,
    foreign_total numeric,
    destination_location_id bigint,
    destination_location text,
    memo text,
    dispatch_vendor_yard text,
    dispatch_address text,
    dispatch_window_start text,
    dispatch_window_end text,
    dispatch_instructions text,
    receipt_status text,
    netsuite_active boolean,
    synced_at timestamp with time zone,
    source_location_id bigint,
    source_location text,
    expected_delivery_date date,
    dispatch_parse_source text,
    dispatch_note_hash text,
    dispatch_parsed_at timestamp with time zone,
    netsuite_missing_at timestamp with time zone,
    last_item_receipt_id bigint,
    last_item_receipt_tranid text,
    received_at timestamp with time zone,
    status_updated_at timestamp with time zone
);


--
-- Name: receiving_receipt_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receiving_receipt_records (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    operator_id text,
    item_receipt_id bigint,
    item_receipt_tranid text,
    receipt_status text DEFAULT 'submitted'::text NOT NULL,
    photo_data_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: receiving_receipt_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.receiving_receipt_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receiving_receipt_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.receiving_receipt_records_id_seq OWNED BY public.receiving_receipt_records.id;


--
-- Name: sales_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_order_lines (
    id bigint DEFAULT nextval('public.canonical_order_line_id_seq'::regclass) NOT NULL,
    sales_order_id bigint,
    line_id bigint,
    item_id bigint,
    item_name text,
    sku text,
    item_description text,
    item_type text,
    item_type_text text,
    quantity numeric,
    unit text,
    pallet_qty numeric,
    layer_qty numeric,
    section_qty numeric,
    piece_qty numeric,
    to_plt numeric,
    to_lyr numeric,
    to_sec numeric,
    to_pcs numeric,
    packed_pallet_qty numeric,
    packed_layer_qty numeric,
    packed_section_qty numeric,
    packed_piece_qty numeric,
    confirmed boolean,
    confirmed_at timestamp with time zone,
    loaded_qty numeric,
    loaded_uom text,
    netsuite_active boolean,
    sync_exception text,
    synced_at timestamp with time zone,
    location_id bigint,
    location text,
    item_weight numeric,
    sync_exception_at timestamp with time zone,
    fulfilled_pallet_qty numeric DEFAULT 0 NOT NULL,
    fulfilled_layer_qty numeric DEFAULT 0 NOT NULL,
    fulfilled_piece_qty numeric DEFAULT 0 NOT NULL,
    fulfilled_section_qty numeric DEFAULT 0 NOT NULL
);


--
-- Name: sales_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_orders (
    netsuite_id bigint NOT NULL,
    tranid text,
    trandate date,
    customer_id bigint,
    customer text,
    status text,
    status_text text,
    foreign_total numeric,
    order_location_id bigint,
    order_location text,
    outbound_location_id bigint,
    outbound_location text,
    delivery_method_id bigint,
    sales_order_type text,
    memo text,
    expected_delivery_date date,
    dispatch_address text,
    dispatch_window_start text,
    dispatch_window_end text,
    dispatch_instructions text,
    operator_status text,
    local_yard_order_status text,
    netsuite_active boolean,
    synced_at timestamp with time zone,
    dispatch_parse_source text,
    dispatch_note_hash text,
    dispatch_parsed_at timestamp with time zone,
    fulfillment_status text,
    dispatch_planned boolean,
    dispatch_plan_date date,
    dispatch_truck_plate text,
    dispatch_load_name text,
    dispatch_parking_spot text,
    dispatch_planned_at timestamp with time zone,
    netsuite_missing_at timestamp with time zone,
    status_updated_at timestamp with time zone,
    preparing_operator_id text,
    preparing_started_at timestamp with time zone,
    last_item_fulfillment_id bigint,
    last_item_fulfillment_tranid text,
    fulfilled_at timestamp with time zone
);


--
-- Name: transfer_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfer_order_lines (
    line_stage text NOT NULL,
    id bigint DEFAULT nextval('public.canonical_order_line_id_seq'::regclass) NOT NULL,
    transfer_order_id bigint,
    line_id bigint,
    item_id bigint,
    item_name text,
    sku text,
    item_description text,
    quantity numeric,
    unit text,
    pallet_qty numeric,
    layer_qty numeric,
    section_qty numeric,
    piece_qty numeric,
    loaded_qty numeric,
    loaded_uom text,
    netsuite_active boolean,
    sync_exception text,
    synced_at timestamp with time zone,
    item_type text,
    item_type_text text,
    location_id bigint,
    location text,
    to_plt numeric,
    to_lyr numeric,
    to_sec numeric,
    to_pcs numeric,
    packed_pallet_qty numeric,
    packed_layer_qty numeric,
    packed_section_qty numeric,
    packed_piece_qty numeric,
    received_pallet_qty numeric,
    received_layer_qty numeric,
    received_section_qty numeric,
    received_piece_qty numeric,
    netsuite_received_qty numeric,
    item_weight numeric,
    sync_exception_at timestamp with time zone,
    raw jsonb,
    confirmed_at timestamp with time zone,
    confirmed_by text,
    confirmed boolean DEFAULT false NOT NULL,
    fulfilled_pallet_qty numeric DEFAULT 0 NOT NULL,
    fulfilled_layer_qty numeric DEFAULT 0 NOT NULL,
    fulfilled_piece_qty numeric DEFAULT 0 NOT NULL,
    fulfilled_section_qty numeric DEFAULT 0 NOT NULL
);


--
-- Name: transfer_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfer_orders (
    netsuite_id bigint NOT NULL,
    tranid text,
    trandate date,
    status text,
    status_text text,
    from_location_id bigint,
    from_location text,
    to_location_id bigint,
    to_location text,
    outbound_operator_status text,
    receiving_status text,
    netsuite_active boolean,
    synced_at timestamp with time zone,
    memo text,
    expected_delivery_date date,
    dispatch_address text,
    dispatch_window_start text,
    dispatch_window_end text,
    dispatch_instructions text,
    dispatch_parse_source text,
    dispatch_note_hash text,
    dispatch_parsed_at timestamp with time zone,
    local_yard_order_status text,
    fulfillment_status text,
    dispatch_planned boolean,
    dispatch_plan_date date,
    dispatch_truck_plate text,
    dispatch_load_name text,
    dispatch_parking_spot text,
    dispatch_planned_at timestamp with time zone,
    netsuite_missing_at timestamp with time zone,
    last_item_receipt_id bigint,
    last_item_receipt_tranid text,
    received_at timestamp with time zone,
    status_updated_at timestamp with time zone,
    preparing_operator_id text,
    preparing_started_at timestamp with time zone,
    last_item_fulfillment_id bigint,
    last_item_fulfillment_tranid text,
    fulfilled_at timestamp with time zone
);


--
-- Name: customer_pickup_load_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_pickup_load_records ALTER COLUMN id SET DEFAULT nextval('public.customer_pickup_load_records_id_seq'::regclass);


--
-- Name: cycle_count_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_lines ALTER COLUMN id SET DEFAULT nextval('public.cycle_count_lines_id_seq'::regclass);


--
-- Name: cycle_count_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_records ALTER COLUMN id SET DEFAULT nextval('public.cycle_count_records_id_seq'::regclass);


--
-- Name: delivery_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_audit_log ALTER COLUMN id SET DEFAULT nextval('public.delivery_audit_log_id_seq'::regclass);


--
-- Name: delivery_fulfillment_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_fulfillment_records ALTER COLUMN id SET DEFAULT nextval('public.delivery_fulfillment_records_id_seq'::regclass);


--
-- Name: delivery_preparation_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_preparation_records ALTER COLUMN id SET DEFAULT nextval('public.delivery_preparation_records_id_seq'::regclass);


--
-- Name: dispatch_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_audit_log ALTER COLUMN id SET DEFAULT nextval('public.dispatch_audit_log_id_seq'::regclass);


--
-- Name: dispatch_ollama_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_ollama_audit ALTER COLUMN id SET DEFAULT nextval('public.dispatch_ollama_audit_id_seq'::regclass);


--
-- Name: dispatch_operator_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_operator_requests ALTER COLUMN id SET DEFAULT nextval('public.dispatch_operator_requests_id_seq'::regclass);


--
-- Name: dispatch_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_plans ALTER COLUMN id SET DEFAULT nextval('public.dispatch_plans_id_seq'::regclass);


--
-- Name: dispatch_so_po_allocations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_so_po_allocations ALTER COLUMN id SET DEFAULT nextval('public.dispatch_so_po_allocations_id_seq'::regclass);


--
-- Name: dispatch_truck_location_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_truck_location_history ALTER COLUMN id SET DEFAULT nextval('public.dispatch_truck_location_history_id_seq'::regclass);


--
-- Name: dispatch_vendor_yards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_vendor_yards ALTER COLUMN id SET DEFAULT nextval('public.dispatch_vendor_yards_id_seq'::regclass);


--
-- Name: driver_day_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_day_records ALTER COLUMN id SET DEFAULT nextval('public.driver_day_records_id_seq'::regclass);


--
-- Name: driver_job_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_records ALTER COLUMN id SET DEFAULT nextval('public.driver_job_records_id_seq'::regclass);


--
-- Name: local_co_order_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_order_lines ALTER COLUMN id SET DEFAULT nextval('public.local_co_order_lines_id_seq'::regclass);


--
-- Name: local_co_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_orders ALTER COLUMN id SET DEFAULT nextval('public.local_co_orders_id_seq'::regclass);


--
-- Name: local_co_receipt_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_receipt_records ALTER COLUMN id SET DEFAULT nextval('public.local_co_receipt_records_id_seq'::regclass);


--
-- Name: operator_load_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_load_records ALTER COLUMN id SET DEFAULT nextval('public.operator_load_records_id_seq'::regclass);


--
-- Name: operator_record_warnings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_record_warnings ALTER COLUMN id SET DEFAULT nextval('public.operator_record_warnings_id_seq'::regclass);


--
-- Name: receiving_receipt_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_receipt_records ALTER COLUMN id SET DEFAULT nextval('public.receiving_receipt_records_id_seq'::regclass);


--
-- Name: co_order_lines co_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_order_lines
    ADD CONSTRAINT co_order_lines_pkey PRIMARY KEY (id);


--
-- Name: co_orders co_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.co_orders
    ADD CONSTRAINT co_orders_pkey PRIMARY KEY (id);


--
-- Name: customer_pickup_load_records customer_pickup_load_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_pickup_load_records
    ADD CONSTRAINT customer_pickup_load_records_pkey PRIMARY KEY (id);


--
-- Name: cycle_count_lines cycle_count_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_lines
    ADD CONSTRAINT cycle_count_lines_pkey PRIMARY KEY (id);


--
-- Name: cycle_count_lines cycle_count_lines_record_id_item_id_location_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_lines
    ADD CONSTRAINT cycle_count_lines_record_id_item_id_location_id_key UNIQUE (record_id, item_id, location_id);


--
-- Name: cycle_count_records cycle_count_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_records
    ADD CONSTRAINT cycle_count_records_pkey PRIMARY KEY (id);


--
-- Name: delivery_audit_log delivery_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_audit_log
    ADD CONSTRAINT delivery_audit_log_pkey PRIMARY KEY (id);


--
-- Name: delivery_fulfillment_records delivery_fulfillment_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_fulfillment_records
    ADD CONSTRAINT delivery_fulfillment_records_pkey PRIMARY KEY (id);


--
-- Name: delivery_preparation_records delivery_preparation_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_preparation_records
    ADD CONSTRAINT delivery_preparation_records_pkey PRIMARY KEY (id);


--
-- Name: dispatch_audit_log dispatch_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_audit_log
    ADD CONSTRAINT dispatch_audit_log_pkey PRIMARY KEY (id);


--
-- Name: dispatch_ollama_audit dispatch_ollama_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_ollama_audit
    ADD CONSTRAINT dispatch_ollama_audit_pkey PRIMARY KEY (id);


--
-- Name: dispatch_operator_requests dispatch_operator_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_operator_requests
    ADD CONSTRAINT dispatch_operator_requests_pkey PRIMARY KEY (id);


--
-- Name: dispatch_parser_rules dispatch_parser_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_parser_rules
    ADD CONSTRAINT dispatch_parser_rules_pkey PRIMARY KEY (rule_key);


--
-- Name: dispatch_plan_snapshots dispatch_plan_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_plan_snapshots
    ADD CONSTRAINT dispatch_plan_snapshots_pkey PRIMARY KEY (plan_id);


--
-- Name: dispatch_plans dispatch_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_plans
    ADD CONSTRAINT dispatch_plans_pkey PRIMARY KEY (id);


--
-- Name: dispatch_so_po_allocations dispatch_so_po_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_so_po_allocations
    ADD CONSTRAINT dispatch_so_po_allocations_pkey PRIMARY KEY (id);


--
-- Name: dispatch_truck_location_history dispatch_truck_location_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_truck_location_history
    ADD CONSTRAINT dispatch_truck_location_history_pkey PRIMARY KEY (id);


--
-- Name: dispatch_truck_location_history dispatch_truck_location_history_plate_location_time_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_truck_location_history
    ADD CONSTRAINT dispatch_truck_location_history_plate_location_time_key UNIQUE (plate, location_time);


--
-- Name: dispatch_vendor_yards dispatch_vendor_yards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_vendor_yards
    ADD CONSTRAINT dispatch_vendor_yards_pkey PRIMARY KEY (id);


--
-- Name: driver_day_records driver_day_records_driver_login_plan_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_day_records
    ADD CONSTRAINT driver_day_records_driver_login_plan_date_key UNIQUE (driver_login, plan_date);


--
-- Name: driver_day_records driver_day_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_day_records
    ADD CONSTRAINT driver_day_records_pkey PRIMARY KEY (id);


--
-- Name: driver_job_records driver_job_records_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_records
    ADD CONSTRAINT driver_job_records_job_id_key UNIQUE (job_id);


--
-- Name: driver_job_records driver_job_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_records
    ADD CONSTRAINT driver_job_records_pkey PRIMARY KEY (id);


--
-- Name: inventory_balances inventory_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balances
    ADD CONSTRAINT inventory_balances_pkey PRIMARY KEY (item_id, location_id);


--
-- Name: inventory_items inventory_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (item_id);


--
-- Name: local_co_order_lines local_co_order_lines_co_id_line_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_order_lines
    ADD CONSTRAINT local_co_order_lines_co_id_line_id_key UNIQUE (co_id, line_id);


--
-- Name: local_co_order_lines local_co_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_order_lines
    ADD CONSTRAINT local_co_order_lines_pkey PRIMARY KEY (id);


--
-- Name: local_co_orders local_co_orders_co_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_orders
    ADD CONSTRAINT local_co_orders_co_ref_key UNIQUE (co_ref);


--
-- Name: local_co_orders local_co_orders_delivery_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_orders
    ADD CONSTRAINT local_co_orders_delivery_order_id_key UNIQUE (delivery_order_id);


--
-- Name: local_co_orders local_co_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_orders
    ADD CONSTRAINT local_co_orders_pkey PRIMARY KEY (id);


--
-- Name: local_co_receipt_records local_co_receipt_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_receipt_records
    ADD CONSTRAINT local_co_receipt_records_pkey PRIMARY KEY (id);


--
-- Name: netsuite_tokens netsuite_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.netsuite_tokens
    ADD CONSTRAINT netsuite_tokens_pkey PRIMARY KEY (id);


--
-- Name: operator_load_records operator_load_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_load_records
    ADD CONSTRAINT operator_load_records_pkey PRIMARY KEY (id);


--
-- Name: operator_load_records operator_load_records_source_table_source_record_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_load_records
    ADD CONSTRAINT operator_load_records_source_table_source_record_id_key UNIQUE (source_table, source_record_id);


--
-- Name: operator_record_warnings operator_record_warnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_record_warnings
    ADD CONSTRAINT operator_record_warnings_pkey PRIMARY KEY (id);


--
-- Name: operator_sessions operator_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_sessions
    ADD CONSTRAINT operator_sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: operators operators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_pkey PRIMARY KEY (id);


--
-- Name: operators operators_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_username_key UNIQUE (username);


--
-- Name: purchase_order_lines purchase_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (netsuite_id);


--
-- Name: receiving_receipt_records receiving_receipt_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_receipt_records
    ADD CONSTRAINT receiving_receipt_records_pkey PRIMARY KEY (id);


--
-- Name: sales_order_lines sales_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_pkey PRIMARY KEY (id);


--
-- Name: sales_orders sales_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_pkey PRIMARY KEY (netsuite_id);


--
-- Name: transfer_order_lines transfer_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_order_lines
    ADD CONSTRAINT transfer_order_lines_pkey PRIMARY KEY (line_stage, id);


--
-- Name: transfer_orders transfer_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_orders
    ADD CONSTRAINT transfer_orders_pkey PRIMARY KEY (netsuite_id);


--
-- Name: idx_co_order_lines_co; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_co_order_lines_co ON public.co_order_lines USING btree (co_id, line_id);


--
-- Name: idx_co_orders_status_destination; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_co_orders_status_destination ON public.co_orders USING btree (status, to_location_id, created_at DESC);


--
-- Name: idx_customer_pickup_load_records_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_pickup_load_records_order ON public.customer_pickup_load_records USING btree (order_id, created_at DESC);


--
-- Name: idx_cycle_count_records_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cycle_count_records_operator ON public.cycle_count_records USING btree (operator_id, status, updated_at DESC);


--
-- Name: idx_delivery_audit_log_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_audit_log_action ON public.delivery_audit_log USING btree (action, created_at DESC);


--
-- Name: idx_delivery_audit_log_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_audit_log_actor ON public.delivery_audit_log USING btree (actor_operator_id, created_at DESC);


--
-- Name: idx_delivery_audit_log_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_audit_log_order ON public.delivery_audit_log USING btree (order_id, created_at DESC);


--
-- Name: idx_delivery_fulfillment_records_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_fulfillment_records_order ON public.delivery_fulfillment_records USING btree (order_id, created_at DESC);


--
-- Name: idx_dispatch_audit_log_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_audit_log_action ON public.dispatch_audit_log USING btree (action, created_at DESC);


--
-- Name: idx_dispatch_audit_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_audit_log_created ON public.dispatch_audit_log USING btree (created_at DESC);


--
-- Name: idx_dispatch_audit_log_load; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_audit_log_load ON public.dispatch_audit_log USING btree (load_id, created_at DESC);


--
-- Name: idx_dispatch_audit_log_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_audit_log_order ON public.dispatch_audit_log USING btree (order_id, created_at DESC);


--
-- Name: idx_dispatch_audit_log_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_audit_log_plan ON public.dispatch_audit_log USING btree (plan_id, created_at DESC);


--
-- Name: idx_dispatch_ollama_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_ollama_audit_created ON public.dispatch_ollama_audit USING btree (created_at DESC);


--
-- Name: idx_dispatch_operator_requests_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_operator_requests_order ON public.dispatch_operator_requests USING btree (order_ref, status, requested_at DESC);


--
-- Name: idx_dispatch_plans_date_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_plans_date_updated ON public.dispatch_plans USING btree (plan_date DESC, updated_at DESC);


--
-- Name: idx_dispatch_plans_plan_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_dispatch_plans_plan_date ON public.dispatch_plans USING btree (plan_date);


--
-- Name: idx_dispatch_plans_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_plans_status ON public.dispatch_plans USING btree (status, updated_at DESC);


--
-- Name: idx_dispatch_so_po_allocations_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_so_po_allocations_item ON public.dispatch_so_po_allocations USING btree (item_id, status);


--
-- Name: idx_dispatch_so_po_allocations_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_so_po_allocations_po ON public.dispatch_so_po_allocations USING btree (po_order_ref, status, po_line_id);


--
-- Name: idx_dispatch_so_po_allocations_so; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_so_po_allocations_so ON public.dispatch_so_po_allocations USING btree (sales_order_ref, status, sales_line_id);


--
-- Name: idx_dispatch_truck_location_history_plate_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_truck_location_history_plate_time ON public.dispatch_truck_location_history USING btree (plate, location_time DESC);


--
-- Name: idx_dispatch_truck_location_history_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_truck_location_history_time ON public.dispatch_truck_location_history USING btree (location_time DESC);


--
-- Name: idx_dispatch_vendor_yards_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_dispatch_vendor_yards_unique ON public.dispatch_vendor_yards USING btree (vendor, yard, day_label);


--
-- Name: idx_driver_day_records_driver_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_day_records_driver_date ON public.driver_day_records USING btree (driver_login, plan_date DESC);


--
-- Name: idx_driver_job_records_driver_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_job_records_driver_date ON public.driver_job_records USING btree (driver_login, plan_date DESC, completed_at DESC);


--
-- Name: idx_driver_job_records_plan_load_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_job_records_plan_load_stop ON public.driver_job_records USING btree (plan_id, load_id, stop_id, status);


--
-- Name: idx_inventory_balances_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_balances_location ON public.inventory_balances USING btree (location_id, item_id);


--
-- Name: idx_inventory_items_filters; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_items_filters ON public.inventory_items USING btree (product_type, brand, series, item_name);


--
-- Name: idx_local_co_lines_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_co_lines_item ON public.local_co_order_lines USING btree (item_name, sku);


--
-- Name: idx_local_co_orders_source_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_co_orders_source_order ON public.local_co_orders USING btree (source_order_ref, status);


--
-- Name: idx_local_co_orders_status_destination; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_co_orders_status_destination ON public.local_co_orders USING btree (status, to_location_id, created_at DESC);


--
-- Name: idx_operator_record_warnings_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operator_record_warnings_operator ON public.operator_record_warnings USING btree (operator_id, created_at DESC);


--
-- Name: idx_operator_record_warnings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operator_record_warnings_status ON public.operator_record_warnings USING btree (status, created_at DESC);


--
-- Name: idx_operator_sessions_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operator_sessions_operator ON public.operator_sessions USING btree (operator_id, expires_at DESC);


--
-- Name: idx_purchase_order_lines_order_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_order_lines_order_line ON public.purchase_order_lines USING btree (purchase_order_id, line_id);


--
-- Name: idx_purchase_order_lines_order_line_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_purchase_order_lines_order_line_unique ON public.purchase_order_lines USING btree (purchase_order_id, line_id) WHERE (line_id IS NOT NULL);


--
-- Name: idx_purchase_orders_vendor_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_vendor_status ON public.purchase_orders USING btree (vendor, status_text, netsuite_active, trandate DESC);


--
-- Name: idx_receiving_receipt_records_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receiving_receipt_records_order ON public.receiving_receipt_records USING btree (order_id, created_at DESC);


--
-- Name: idx_sales_order_lines_order_line; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_sales_order_lines_order_line ON public.sales_order_lines USING btree (sales_order_id, line_id);


--
-- Name: idx_sales_orders_location_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_orders_location_status ON public.sales_orders USING btree (outbound_location_id, sales_order_type, netsuite_active, trandate DESC);


--
-- Name: idx_sales_orders_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_orders_type_status ON public.sales_orders USING btree (sales_order_type, status_text, netsuite_active, trandate DESC);


--
-- Name: idx_transfer_order_lines_order_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transfer_order_lines_order_stage ON public.transfer_order_lines USING btree (transfer_order_id, line_stage, line_id);


--
-- Name: idx_transfer_order_lines_order_stage_line_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_transfer_order_lines_order_stage_line_unique ON public.transfer_order_lines USING btree (transfer_order_id, line_stage, line_id) WHERE (line_id IS NOT NULL);


--
-- Name: co_order_lines trg_co_lines_receiving_legacy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_co_lines_receiving_legacy AFTER UPDATE ON public.co_order_lines FOR EACH ROW EXECUTE FUNCTION public.mbbs_co_line_receiving_legacy_trigger();


--
-- Name: co_orders trg_co_orders_receiving_legacy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_co_orders_receiving_legacy AFTER UPDATE ON public.co_orders FOR EACH ROW EXECUTE FUNCTION public.mbbs_co_receiving_legacy_trigger();


--
-- Name: local_co_order_lines trg_local_co_order_lines_canonical; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_local_co_order_lines_canonical AFTER INSERT OR DELETE OR UPDATE ON public.local_co_order_lines FOR EACH ROW EXECUTE FUNCTION public.mbbs_co_line_canonical_trigger();


--
-- Name: local_co_orders trg_local_co_orders_canonical; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_local_co_orders_canonical AFTER INSERT OR DELETE OR UPDATE ON public.local_co_orders FOR EACH ROW EXECUTE FUNCTION public.mbbs_co_order_canonical_trigger();


--
-- Name: customer_pickup_load_records customer_pickup_load_records_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_pickup_load_records
    ADD CONSTRAINT customer_pickup_load_records_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: cycle_count_lines cycle_count_lines_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_lines
    ADD CONSTRAINT cycle_count_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(item_id) ON DELETE RESTRICT;


--
-- Name: cycle_count_lines cycle_count_lines_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_lines
    ADD CONSTRAINT cycle_count_lines_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.cycle_count_records(id) ON DELETE CASCADE;


--
-- Name: cycle_count_records cycle_count_records_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_records
    ADD CONSTRAINT cycle_count_records_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: delivery_audit_log delivery_audit_log_actor_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_audit_log
    ADD CONSTRAINT delivery_audit_log_actor_operator_id_fkey FOREIGN KEY (actor_operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: delivery_fulfillment_records delivery_fulfillment_records_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_fulfillment_records
    ADD CONSTRAINT delivery_fulfillment_records_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: dispatch_audit_log dispatch_audit_log_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_audit_log
    ADD CONSTRAINT dispatch_audit_log_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.dispatch_plans(id);


--
-- Name: dispatch_plan_snapshots dispatch_plan_snapshots_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_plan_snapshots
    ADD CONSTRAINT dispatch_plan_snapshots_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.dispatch_plans(id) ON DELETE CASCADE;


--
-- Name: dispatch_so_po_allocations dispatch_so_po_allocations_po_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_so_po_allocations
    ADD CONSTRAINT dispatch_so_po_allocations_po_line_id_fkey FOREIGN KEY (po_line_id) REFERENCES public.purchase_order_lines(id) ON DELETE CASCADE NOT VALID;


--
-- Name: dispatch_so_po_allocations dispatch_so_po_allocations_po_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_so_po_allocations
    ADD CONSTRAINT dispatch_so_po_allocations_po_order_id_fkey FOREIGN KEY (po_order_id) REFERENCES public.purchase_orders(netsuite_id) ON DELETE CASCADE NOT VALID;


--
-- Name: dispatch_so_po_allocations dispatch_so_po_allocations_sales_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_so_po_allocations
    ADD CONSTRAINT dispatch_so_po_allocations_sales_line_id_fkey FOREIGN KEY (sales_line_id) REFERENCES public.sales_order_lines(id) ON DELETE CASCADE NOT VALID;


--
-- Name: dispatch_so_po_allocations dispatch_so_po_allocations_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_so_po_allocations
    ADD CONSTRAINT dispatch_so_po_allocations_sales_order_id_fkey FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(netsuite_id) ON DELETE CASCADE NOT VALID;


--
-- Name: driver_day_records driver_day_records_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_day_records
    ADD CONSTRAINT driver_day_records_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.dispatch_plans(id) ON DELETE SET NULL;


--
-- Name: driver_job_records driver_job_records_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_job_records
    ADD CONSTRAINT driver_job_records_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.dispatch_plans(id) ON DELETE SET NULL;


--
-- Name: inventory_balances inventory_balances_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balances
    ADD CONSTRAINT inventory_balances_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(item_id) ON DELETE CASCADE;


--
-- Name: inventory_items inventory_items_classification_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_classification_updated_by_fkey FOREIGN KEY (classification_updated_by) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: local_co_order_lines local_co_order_lines_co_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_order_lines
    ADD CONSTRAINT local_co_order_lines_co_id_fkey FOREIGN KEY (co_id) REFERENCES public.local_co_orders(id) ON DELETE CASCADE;


--
-- Name: local_co_order_lines local_co_order_lines_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_order_lines
    ADD CONSTRAINT local_co_order_lines_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: local_co_orders local_co_orders_dispatch_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_orders
    ADD CONSTRAINT local_co_orders_dispatch_plan_id_fkey FOREIGN KEY (dispatch_plan_id) REFERENCES public.dispatch_plans(id) ON DELETE SET NULL;


--
-- Name: local_co_orders local_co_orders_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_orders
    ADD CONSTRAINT local_co_orders_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: local_co_receipt_records local_co_receipt_records_co_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_receipt_records
    ADD CONSTRAINT local_co_receipt_records_co_id_fkey FOREIGN KEY (co_id) REFERENCES public.local_co_orders(id) ON DELETE CASCADE;


--
-- Name: local_co_receipt_records local_co_receipt_records_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_co_receipt_records
    ADD CONSTRAINT local_co_receipt_records_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: operator_load_records operator_load_records_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_load_records
    ADD CONSTRAINT operator_load_records_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: operator_record_warnings operator_record_warnings_handled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_record_warnings
    ADD CONSTRAINT operator_record_warnings_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: operator_record_warnings operator_record_warnings_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_record_warnings
    ADD CONSTRAINT operator_record_warnings_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


--
-- Name: operator_sessions operator_sessions_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_sessions
    ADD CONSTRAINT operator_sessions_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE CASCADE;


--
-- Name: receiving_receipt_records receiving_receipt_records_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receiving_receipt_records
    ADD CONSTRAINT receiving_receipt_records_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id);


--
-- PostgreSQL database dump complete
--

SET search_path = public;
