/**
 * The renderer bundle is Vite's, and the module registry uses `import.meta.glob`
 * to discover feature directories. The web tsconfig carries no ambient types, so
 * the one Vite API we rely on is declared here.
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { eager?: boolean; import?: string; query?: string }
  ): Record<string, T>
}
