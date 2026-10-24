// Test material · a JSON Schema validator for exactly the keywords Cernum's own schemas use.
//
// WHY NOT A LIBRARY. Adding a dependency is outside what this repository's lanes may do, and a validator
// one can read in a minute is easier to trust than one nobody here has read. It is STRICT about its own
// reach: a schema keyword it does not implement is an error, never silently ignored, so a schema can
// never look validated while one of its constraints went unchecked.

export type JsonSchema = Record<string, unknown>;

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description']);
const IMPLEMENTED = new Set(['$ref', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'minLength', 'minimum', 'pattern']);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** Every violation, as `path: problem`. Empty means the value is valid. */
export function validateAgainstSchema(value: unknown, root: JsonSchema): string[] {
  const errors: string[] = [];
  const resolve = (ref: string): JsonSchema => {
    const match = /^#\/\$defs\/(.+)$/.exec(ref);
    const target = match === null ? undefined : (root.$defs as Record<string, JsonSchema> | undefined)?.[match[1]];
    if (target === undefined) throw new Error(`schema: unresolvable $ref ${ref}`);
    return target;
  };
  const walk = (node: unknown, schema: JsonSchema, at: string): void => {
    for (const keyword of Object.keys(schema)) {
      if (!ANNOTATIONS.has(keyword) && !IMPLEMENTED.has(keyword)) throw new Error(`schema: keyword '${keyword}' at ${at} is not implemented`);
    }
    if (typeof schema.$ref === 'string') { walk(node, resolve(schema.$ref), at); return; }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
      if (!types.some((type) => matchesType(node, type))) { errors.push(`${at}: expected ${types.join('|')}, found ${typeOf(node)}`); return; }
    }
    if ('const' in schema && JSON.stringify(node) !== JSON.stringify(schema.const)) {
      errors.push(`${at}: expected ${JSON.stringify(schema.const)}, found ${JSON.stringify(node)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(node))) {
      errors.push(`${at}: ${JSON.stringify(node)} is not one of ${JSON.stringify(schema.enum)}`);
    }
    if (typeof node === 'string') {
      if (typeof schema.minLength === 'number' && node.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(node)) errors.push(`${at}: does not match ${schema.pattern}`);
    }
    if (typeof node === 'number' && typeof schema.minimum === 'number' && node < schema.minimum) {
      errors.push(`${at}: ${node} is below ${schema.minimum}`);
    }
    if (Array.isArray(node)) {
      if (typeof schema.minItems === 'number' && node.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === 'number' && node.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
      if (schema.items !== undefined) node.forEach((item, index) => walk(item, schema.items as JsonSchema, `${at}[${index}]`));
    }
    if (typeOf(node) === 'object') {
      const object = node as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!(key in object)) errors.push(`${at}: missing required '${key}'`);
      }
      const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
      for (const [key, child] of Object.entries(object)) {
        if (key in properties) walk(child, properties[key], `${at}.${key}`);
        else if (schema.additionalProperties === false) errors.push(`${at}: '${key}' is not allowed`);
        else if (typeof schema.additionalProperties === 'object') walk(child, schema.additionalProperties as JsonSchema, `${at}.${key}`);
      }
    }
  };
  walk(value, root, '$');
  return errors;
}
