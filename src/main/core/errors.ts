/**
 * Boot-time failures that must NOT be swallowed by module isolation.
 *
 * §3.5 rule 7 draws a deliberate asymmetry: a *collision* fails the build,
 * because it is a programming error CI must catch; a *runtime* failure inside
 * one module degrades to that module only. `ContributionError` is the marker
 * for the first kind — the registry re-throws it out of the per-module
 * try/catch so the app refuses to start, with both module names in the message.
 */
export class ContributionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContributionError'
  }
}

/** A module tried to write an mpv property it does not own (§3.7). */
export class OwnershipError extends Error {
  readonly property: string
  readonly owner: string | null
  readonly offender: string

  constructor(offender: string, property: string, owner: string | null, hint: string) {
    super(
      owner
        ? `${offender} may not write '${property}' (owned by ${owner}). ${hint}`
        : `${offender} may not write '${property}': no module owns it. ` +
            `Declare it in ownsProperties and add it to docs/parity/modules.json. ${hint}`
    )
    this.name = 'OwnershipError'
    this.property = property
    this.owner = owner
    this.offender = offender
  }
}
