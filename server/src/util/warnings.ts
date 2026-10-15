// Silence only the "SQLite is an experimental feature" warning printed by some Node versions when
// `node:sqlite` is loaded. Every other warning goes through untouched. Imported first by the entry
// point so it runs before the database module is evaluated. (Alternative: run node with
// `--disable-warning=ExperimentalWarning`.)
const originalEmitWarning = process.emitWarning;

function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : typeOrOptions && typeof typeOrOptions === 'object'
        ? (typeOrOptions as { type?: unknown }).type
        : warning instanceof Error
          ? warning.name
          : undefined;
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  return type === 'ExperimentalWarning' && /sqlite/i.test(message);
}

process.emitWarning = function patchedEmitWarning(this: unknown, warning: string | Error, ...rest: unknown[]) {
  if (isSqliteExperimentalWarning(warning, rest[0])) return;
  return (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;

export {};
