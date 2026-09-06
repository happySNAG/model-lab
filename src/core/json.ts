// Model Lab core · JSON parsing with Swift `JSONSerialization.jsonObject(with:)` semantics:
// a top-level container (object or array) is required; scalars at the top level are NOT JSON documents.

export function parseJSONContainer(text: string): Record<string, unknown> | unknown[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  return value as Record<string, unknown> | unknown[];
}

export function parseJSONObject(text: string): Record<string, unknown> | undefined {
  const value = parseJSONContainer(text);
  if (value === undefined || Array.isArray(value)) return undefined;
  return value;
}
