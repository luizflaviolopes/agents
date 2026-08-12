/**
 * Tiny fetch wrapper for the app's own API routes (client components).
 * Throws `Error(message)` with the server's `{ error }` message on failure.
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return json as T;
}
