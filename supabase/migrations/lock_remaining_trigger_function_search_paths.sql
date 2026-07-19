-- Lock search_path for trigger helper functions flagged by Supabase security advisor.
-- Function bodies stay unchanged; only the execution lookup path is fixed.

alter function public.handle_orders_trigger()
  set search_path = pg_catalog, public;

alter function public.handle_updated_at()
  set search_path = pg_catalog, public;

alter function public.touch_cpi_updated_at()
  set search_path = pg_catalog, public;

alter function public.touch_epi_updated_at()
  set search_path = pg_catalog, public;

alter function public.touch_marketplace_api_credentials_updated_at()
  set search_path = pg_catalog, public;

alter function public.touch_spi_updated_at()
  set search_path = pg_catalog, public;

alter function public.update_playauto_category_mappings_updated_at()
  set search_path = pg_catalog, public;
