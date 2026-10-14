import { NextResponse } from "next/server";

const buckets = new Map<string, number[]>();

export function clientKey(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  return (xf?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}

/**
 * Sliding-window limit per client and route. Returns a 429 response to send
 * back, or null when the request may proceed. The window lives in memory, which
 * is right for one instance; move the map to Redis/Upstash when running several.
 */
export function rateLimit(req: Request, route: string, limit: number, windowMs: number): NextResponse | null {
  const key = `${route}:${clientKey(req)}`;
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    const retry = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    return NextResponse.json({ error: `Too many requests. Try again in ${retry}s.` }, { status: 429, headers: { "Retry-After": String(retry) } });
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
  return null;
}
