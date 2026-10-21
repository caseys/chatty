/** How many requests' fix state (see ConversationOrchestrator) is kept; older requests' is dropped */
export const MAX_REQUESTS_KEPT = 20;

/**
 * Sets an entry in a map of per-request state, then drops the entries of all but the
 * MAX_REQUESTS_KEPT most recently written requests. `requestOf` names the request an entry belongs
 * to (the key itself by default), for maps with several entries per request. The entry just set is
 * always kept, so a request's fix loop never loses its own state, however long it runs.
 */
export function setForRecentRequests<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  requestOf: (key: string, value: V) => string = (k) => k,
  max = MAX_REQUESTS_KEPT
): void {
  map.delete(key); // (written last = most recent in the map's order)
  map.set(key, value);
  if (map.size <= max) return;
  const recent = new Set<string>();
  const entries = [...map];
  for (let i = entries.length - 1; i >= 0 && recent.size < max; i--) recent.add(requestOf(entries[i][0], entries[i][1]));
  for (const [k, v] of entries) if (!recent.has(requestOf(k, v))) map.delete(k);
}
