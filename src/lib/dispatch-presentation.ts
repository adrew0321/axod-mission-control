// Presentation helpers for dispatched-specialist turns. Pure (no React/DOM) so
// they're unit-testable and shared by page.tsx (reload) and mission-control.tsx (live).

/** A short, in-character line shown on the dispatch card instead of the raw task brief. */
export function dispatchFlavor(agentId: string | null | undefined, name: string): string {
  switch (agentId) {
    case 'atlas':
      return 'Atlas heads to the anvil';
    case 'echo':
      return 'Echo uncaps the red pen';
    case 'nova':
      return 'Nova trains the telescope';
    case 'forge':
      return 'Forge fires up the pipeline';
    default:
      return `${name} gets to work`;
  }
}

/**
 * Attribution label for an agent message. `dispatchedVia` is the orchestrator id that
 * dispatched the reply (or null when the agent spoke as the primary / @-addressed agent).
 * v1 has only Sage as an orchestrator, so any non-empty value reads "via Sage".
 */
export function dispatchAttribution(dispatchedVia: string | null | undefined): string | undefined {
  return dispatchedVia ? 'via Sage' : undefined;
}
