/**
 * F1R3Skein Contracts
 * Rholang source for collective narrative intelligence on the shard.
 *
 * On-chain channels:
 *   @"f1r3skein-players" — Map[playerId → { id, name, joinedAt }]
 *   @"f1r3skein-threads" — Map[threadId → { id, parentId, author, text, ts, children }]
 *   @"f1r3skein-roots"   — List[threadId] (top-level story roots)
 *
 * Narrative model: branching story threads.
 * Any player can start a root thread or fork an existing thread.
 * The community weaves by branching, braiding (merging), and binding (concluding).
 */

export const DEPLOY_SKEIN_REGISTRY = `
  new stdout(\`rho:io:stdout\`) in {
    @"f1r3skein-players"!({}) |
    @"f1r3skein-threads"!({}) |
    @"f1r3skein-roots"!([]) |
    stdout!("F1R3Skein registry deployed")
  }
`;

export function registerPlayer(id: string, name: string): string {
  return `
    for (@players <- @"f1r3skein-players") {
      @"f1r3skein-players"!(
        players.set("${id}", { "id": "${id}", "name": "${name}", "joinedAt": ${Date.now()} })
      )
    }
  `;
}

export function removePlayer(id: string): string {
  return `
    for (@players <- @"f1r3skein-players") {
      @"f1r3skein-players"!(players.delete("${id}"))
    }
  `;
}

/**
 * Start a new root story thread.
 */
export function startThread(
  threadId: string,
  authorId: string,
  authorName: string,
  text: string
): string {
  const escaped = text.replace(/"/g, '\\"');
  return `
    for (@threads <- @"f1r3skein-threads") {
      @"f1r3skein-threads"!(
        threads.set(
          "${threadId}",
          {
            "id": "${threadId}",
            "parentId": "",
            "author": "${authorId}",
            "authorName": "${authorName}",
            "text": "${escaped}",
            "ts": ${Date.now()},
            "children": []
          }
        )
      )
    } |
    for (@roots <- @"f1r3skein-roots") {
      @"f1r3skein-roots"!(roots ++ ["${threadId}"])
    }
  `;
}

/**
 * Fork (branch) an existing thread — add a child continuation.
 */
export function forkThread(
  newThreadId: string,
  parentThreadId: string,
  authorId: string,
  authorName: string,
  text: string
): string {
  const escaped = text.replace(/"/g, '\\"');
  return `
    for (@threads <- @"f1r3skein-threads") {
      // Add the new thread
      @"f1r3skein-threads"!(
        threads
          .set(
            "${newThreadId}",
            {
              "id": "${newThreadId}",
              "parentId": "${parentThreadId}",
              "author": "${authorId}",
              "authorName": "${authorName}",
              "text": "${escaped}",
              "ts": ${Date.now()},
              "children": []
            }
          )
          .set(
            "${parentThreadId}",
            match threads.get("${parentThreadId}") {
              Nil => { threads.get("${parentThreadId}") }
              parent => {
                parent.set("children", parent.get("children") ++ ["${newThreadId}"])
              }
            }
          )
      )
    }
  `;
}

export const READ_PLAYERS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@players <<- @"f1r3skein-players") { ret!(players) }
  }
`;

export const READ_THREADS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@threads <<- @"f1r3skein-threads") { ret!(threads) }
  }
`;

export const READ_ROOTS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@roots <<- @"f1r3skein-roots") { ret!(roots) }
  }
`;
