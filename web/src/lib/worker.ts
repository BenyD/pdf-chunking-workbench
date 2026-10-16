/** Calls into the Python worker. Only ever from route handlers. */
export async function worker<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const base = process.env.WORKER_URL;
  if (!base) throw new Error("WORKER_URL not set");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": process.env.WORKER_SECRET ?? "" },
    body: JSON.stringify(body),
    cache: "no-store",
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) throw new Error(`worker ${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}
