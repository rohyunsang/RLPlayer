/**
 * M23's IPC payloads, DECLARED ONCE.
 *
 * §10 of `docs/parity/02-wave0-api.md`: "Your two halves DO have a file they
 * both compile: `src/shared/features/<your id>/`. Declare every payload that
 * crosses your own IPC there, once."
 *
 * They did not, and both halves of this module carried the same paragraph
 * saying so: only 3 of the 40 feature rows in `docs/parity/modules.json` listed
 * a shared directory, creating one anyway is a file owned by nobody (which
 * `check:partition` fails), and adding it to the row is a manifest edit a module
 * may not make. So `JobWire` was written twice, with a `declarations.test.ts`
 * tripwire asserting the duplication was a recorded consequence and not a habit.
 * The row has the directory now; the tripwire fired; this is the fix it asked
 * for.
 *
 * The two copies had already drifted, which is the whole argument in one line:
 * the main half typed `kind` as `JobKind` and the renderer half as `string`, so
 * the renderer would have compiled happily against a value the main half can
 * never send.
 */

export type JobKind = 'clip' | 'audio' | 'gif' | 'webp' | 'burst' | 'sheet' | 'cut'
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** One row of the encode panel. `percent` is null while the job has no progress. */
export interface JobWire {
  readonly id: string
  readonly kind: JobKind
  readonly label: string
  readonly name: string
  readonly state: JobState
  readonly percent: number | null
  readonly error: string | null
}

/** The `capture-encode:getJobs` reply and the `capture-encode:jobs` push. */
export interface JobsWire {
  readonly jobs: readonly JobWire[]
}
