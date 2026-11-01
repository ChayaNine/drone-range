/**
 * The few things you might want to change when you fork this project.
 */

export const BRAND = {
  name: 'Drone Range',
  tagline: 'Fly it. Shoot it. Fork it.',
  /** Shown in the footer when set, e.g. 'https://github.com/you/drone-range'. */
  repoUrl: '' as string,
} as const

/** A drone carries at most this many weapons AND this many special systems. */
export const SLOT_CAPS = { weapons: 2, systems: 2 } as const

/** Prefix for everything this app writes to localStorage, so it never collides with another app on the same origin. */
export const STORAGE_PREFIX = 'range.'
