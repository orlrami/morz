/* Morz motion system — Emil Kowalski / motion-primitives spring presets (Phase-0 brief). */
export const springs = {
  // Micro-interactions: badge count, dot pulse, status ring
  snappy: { type: 'spring', stiffness: 400, damping: 30 },

  // Panel open/close, sidebar expand, drawer
  panel: { type: 'spring', stiffness: 260, damping: 24 },

  // Layout morphing, tab indicator, active pill slide
  layout: { type: 'spring', stiffness: 200, damping: 22 },

  // Floating elements, command palette
  float: { type: 'spring', stiffness: 300, damping: 28 }
} as const

/* Orchestrated page-load: containers stagger their children once, on mount. */
export const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } }
}

export const staggerItem = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: springs.panel }
}
