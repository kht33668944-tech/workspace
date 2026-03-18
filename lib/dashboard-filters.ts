export const ORDERS_FILTER_KEY = "orders-filter-state";

export function setOrdersFilter(columnFilters: Record<string, string[]>) {
  try {
    sessionStorage.setItem(
      ORDERS_FILTER_KEY,
      JSON.stringify({ month: null, marketplace: null, search: "", dateFrom: null, dateTo: null, columnFilters })
    );
  } catch { /* ignore */ }
}
