function findUncloneablePath(value: unknown, path: string, seen: WeakSet<object>): string | undefined {
  if (value === null || value === undefined) return undefined;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return undefined;
  if (type === 'function' || type === 'symbol' || type === 'bigint') return path;
  if (type !== 'object') return path;

  const objectValue = value as object;
  if (value instanceof Error || value instanceof Promise) return path;
  const NodeConstructor = globalThis.Node;
  if (typeof NodeConstructor === 'function' && value instanceof NodeConstructor) return path;
  if (seen.has(objectValue)) return undefined;
  seen.add(objectValue);

  let cloneError: unknown;
  try {
    structuredClone(value);
    return undefined;
  } catch (error) {
    cloneError = error;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const unsafe = findUncloneablePath(value[index], `${path}[${index}]`, seen);
      if (unsafe) return unsafe;
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      const unsafe = findUncloneablePath(entry, `${path}.${key}`, seen);
      if (unsafe) return unsafe;
    }
  }

  return cloneError ? path : undefined;
}

export function cloneStructuredMessage<T>(message: T, rootPath = '$'): T {
  const unsafePath = findUncloneablePath(message, rootPath, new WeakSet<object>());
  if (unsafePath) throw new TypeError(`Message payload is not structured-clone safe at ${unsafePath}`);
  try {
    return structuredClone(message);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Message payload could not be cloned at ${rootPath}: ${reason}`);
  }
}
