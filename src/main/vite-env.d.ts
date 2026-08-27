/**
 * `import.meta.glob` is Vite's, and electron-vite builds the main process with
 * Vite. The main tsconfig deliberately carries only `types: ["node"]`, so the
 * one Vite API we use is declared here rather than pulling in `vite/client`
 * (which would drag DOM lib types into the main process).
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { eager?: boolean; import?: string; query?: string }
  ): Record<string, T>
}
