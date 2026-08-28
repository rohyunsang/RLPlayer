/**
 * `import.meta.glob` is Vite's, and electron-vite builds the main process with
 * Vite. The main tsconfig deliberately carries only `types: ["node"]`, so the
 * one Vite API we use is declared here rather than pulling in `vite/client`
 * (which would drag DOM lib types into the main process).
 *
 * Two overloads, because the difference matters: `{ eager: true }` returns the
 * MODULES (their top-level code has already run), and the lazy form returns
 * IMPORTERS. `src/main/features/index.ts` needs the lazy one so that no feature
 * module's body runs before core has finished wiring itself — see the comment
 * there. A single `Record<string, T>` signature quietly typed the lazy form as
 * eager and made that distinction invisible.
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { eager: true; import?: string; query?: string }
  ): Record<string, T>
  glob<T = unknown>(
    pattern: string,
    options?: { eager?: false; import?: string; query?: string }
  ): Record<string, () => Promise<T>>
}
