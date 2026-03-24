import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getServiceSupabaseClient } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = getServiceSupabaseClient();
  const { searchParams } = new URL(request.url);

  const from = searchParams.get("from"); // YYYY-MM-DD
  const to = searchParams.get("to");     // YYYY-MM-DD
  const filter = searchParams.get("filter"); // "up" | "down" | "alert" | null

  let query = sb
    .from("price_history")
    .select(`
      id, product_id, previous_price, new_price,
      change_amount, change_rate, source, scraped_at,
      products!inner(product_name, purchase_url, category, user_id)
    `)
    .order("scraped_at", { ascending: false })
    .limit(2000);

  if (from) query = query.gte("scraped_at", `${from}T00:00:00`);
  if (to) query = query.lte("scraped_at", `${to}T23:59:59`);

  if (filter === "up") query = query.gt("change_amount", 0);
  else if (filter === "down") query = query.lt("change_amount", 0);
  else if (filter === "alert") {
    query = query.or("change_rate.gte.10,change_rate.lte.-10");
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json(
      { error: `[PriceHistory] ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ history: data ?? [] });
}
