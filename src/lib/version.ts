// Single source of truth for the app version shown in the UI + health check.
// Bump this together with package.json on every release (the ship-mc-feature
// skill's Phase 4 enforces it). The HUD topbar and /api/health both read this,
// so the two can never drift from each other.
export const APP_VERSION = "1.13.0";
