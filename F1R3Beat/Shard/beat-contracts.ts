/**
 * F1R3Beat Contracts
 * Rholang source for collaborative step sequencer on the shard.
 *
 * On-chain channels:
 *   @"f1r3beat-grid"    — 8×16 boolean grid (rows × steps)
 *   @"f1r3beat-players" — Map[playerId → { id, name, joinedAt }]
 *   @"f1r3beat-meta"    — { bpm, lastEditBy, lastEditAt }
 */

export const DEPLOY_BEAT_REGISTRY = `
  new stdout(\`rho:io:stdout\`) in {
    @"f1r3beat-grid"!([
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false]
    ]) |
    @"f1r3beat-players"!({}) |
    @"f1r3beat-meta"!({"bpm": 120, "lastEditBy": "", "lastEditAt": 0}) |
    stdout!("F1R3Beat registry deployed")
  }
`;

export function registerPlayer(id: string, name: string): string {
  return `
    for (@players <- @"f1r3beat-players") {
      @"f1r3beat-players"!(
        players.set("${id}", { "id": "${id}", "name": "${name}", "joinedAt": ${Date.now()} })
      )
    }
  `;
}

export function removePlayer(id: string): string {
  return `
    for (@players <- @"f1r3beat-players") {
      @"f1r3beat-players"!(players.delete("${id}"))
    }
  `;
}

/**
 * Toggle a cell in the grid. Replaces the entire grid state.
 * In production, this would use a more granular update pattern.
 */
export function writeGrid(grid: boolean[][], editBy: string): string {
  const gridRho = grid.map(row =>
    `[${row.map(v => v ? "true" : "false").join(", ")}]`
  ).join(",\n      ");
  return `
    for (_ <- @"f1r3beat-grid") {
      @"f1r3beat-grid"!([
      ${gridRho}
      ])
    } |
    for (_ <- @"f1r3beat-meta") {
      @"f1r3beat-meta"!({"bpm": 120, "lastEditBy": "${editBy}", "lastEditAt": ${Date.now()}})
    }
  `;
}

export function clearGrid(): string {
  const emptyRow = `[${Array(16).fill("false").join(", ")}]`;
  const emptyGrid = Array(8).fill(emptyRow).join(",\n      ");
  return `
    for (_ <- @"f1r3beat-grid") {
      @"f1r3beat-grid"!([
      ${emptyGrid}
      ])
    }
  `;
}

export const READ_GRID = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@grid <<- @"f1r3beat-grid") { ret!(grid) }
  }
`;

export const READ_PLAYERS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@players <<- @"f1r3beat-players") { ret!(players) }
  }
`;

export const READ_META = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@meta <<- @"f1r3beat-meta") { ret!(meta) }
  }
`;
