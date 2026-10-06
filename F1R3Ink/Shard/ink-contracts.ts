/**
 * F1R3Ink Contracts
 * Rholang source for collective emotional intelligence on the shard.
 *
 * On-chain channels:
 *   @"f1r3ink-players" — Map[playerId → { id, name, tags, joinedAt }]
 *   @"f1r3ink-inks"    — Map[targetId → List[{ from, target, color, ts }]]
 *
 * Inks are append-only — each ink event is added to the target's list.
 * No ink is ever removed or overwritten.
 */

export const DEPLOY_INK_REGISTRY = `
  new stdout(\`rho:io:stdout\`) in {
    @"f1r3ink-players"!({}) |
    @"f1r3ink-inks"!({}) |
    stdout!("F1R3Ink registry deployed")
  }
`;

export function registerPlayer(id: string, name: string, tags: string[]): string {
  const tagsRho = tags.map(t => `"${t}"`).join(", ");
  return `
    for (@players <- @"f1r3ink-players") {
      @"f1r3ink-players"!(
        players.set("${id}", { "id": "${id}", "name": "${name}", "tags": [${tagsRho}], "joinedAt": ${Date.now()} })
      )
    }
  `;
}

export function removePlayer(id: string): string {
  return `
    for (@players <- @"f1r3ink-players") {
      @"f1r3ink-players"!(players.delete("${id}"))
    }
  `;
}

export function updateTags(id: string, tags: string[]): string {
  const tagsRho = tags.map(t => `"${t}"`).join(", ");
  return `
    for (@players <- @"f1r3ink-players") {
      match players.get("${id}") {
        Nil => { @"f1r3ink-players"!(players) }
        player => {
          @"f1r3ink-players"!(
            players.set("${id}", player.set("tags", [${tagsRho}]))
          )
        }
      }
    }
  `;
}

/**
 * Ink a target player with a color. Append-only — adds to the target's ink list.
 * This is the core game action.
 */
export function inkPlayer(
  fromId: string,
  targetId: string,
  color: string
): string {
  const ts = Date.now();
  return `
    for (@inks <- @"f1r3ink-inks") {
      @"f1r3ink-inks"!(
        inks.set(
          "${targetId}",
          match inks.get("${targetId}") {
            Nil => {
              [{ "from": "${fromId}", "target": "${targetId}", "color": "${color}", "ts": ${ts} }]
            }
            existing => {
              existing ++ [{ "from": "${fromId}", "target": "${targetId}", "color": "${color}", "ts": ${ts} }]
            }
          }
        )
      )
    }
  `;
}

export const READ_PLAYERS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@players <<- @"f1r3ink-players") { ret!(players) }
  }
`;

export const READ_INKS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@inks <<- @"f1r3ink-inks") { ret!(inks) }
  }
`;

export function readInksForPlayer(targetId: string): string {
  return `
    new ret(\`rho:rchain:deployId\`) in {
      for (@inks <<- @"f1r3ink-inks") {
        ret!(inks.get("${targetId}"))
      }
    }
  `;
}
