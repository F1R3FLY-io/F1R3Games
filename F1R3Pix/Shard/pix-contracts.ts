/**
 * F1R3Pix Contracts
 * Rholang source for collaborative pixel grid on the shard.
 *
 * On-chain channels:
 *   @"f1r3pix-grid"     — Map["{x},{y}" → { x, y, color, by, byName, ts }]
 *   @"f1r3pix-players"  — Map[playerId → { id, name, joinedAt }]
 */

export const DEPLOY_PIX_REGISTRY = `
  new stdout(\`rho:io:stdout\`) in {
    @"f1r3pix-grid"!({}) |
    @"f1r3pix-players"!({}) |
    stdout!("F1R3Pix registry deployed")
  }
`;

export function registerPlayer(id: string, name: string): string {
  return `
    for (@players <- @"f1r3pix-players") {
      @"f1r3pix-players"!(
        players.set("${id}", { "id": "${id}", "name": "${name}", "joinedAt": ${Date.now()} })
      )
    }
  `;
}

export function removePlayer(id: string): string {
  return `
    for (@players <- @"f1r3pix-players") {
      @"f1r3pix-players"!(players.delete("${id}"))
    }
  `;
}

export function placePixel(
  x: number, y: number, color: string,
  byId: string, byName: string
): string {
  return `
    for (@grid <- @"f1r3pix-grid") {
      @"f1r3pix-grid"!(
        grid.set(
          "${x},${y}",
          { "x": ${x}, "y": ${y}, "color": "${color}", "by": "${byId}", "byName": "${byName}", "ts": ${Date.now()} }
        )
      )
    }
  `;
}

export const READ_GRID = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@grid <<- @"f1r3pix-grid") { ret!(grid) }
  }
`;

export const READ_PLAYERS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@players <<- @"f1r3pix-players") { ret!(players) }
  }
`;
