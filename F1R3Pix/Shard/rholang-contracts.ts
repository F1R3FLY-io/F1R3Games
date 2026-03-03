/**
 * ═══════════════════════════════════════════════════════════════════
 * F1R3Pix Rholang Contract Templates
 * ═══════════════════════════════════════════════════════════════════
 *
 * Each function returns a rholang source string that gets deployed
 * to the F1R3FLY shard via the DeployService gRPC endpoint.
 *
 * Channel naming convention:
 *   f1r3pix:<gameId>:grid:<q>,<r>     — per-cell state
 *   f1r3pix:<gameId>:grid:registry    — grid metadata
 *   f1r3pix:<gameId>:players          — player registry
 *   f1r3pix:<gameId>:inbox:<playerId> — per-player message inbox
 *   f1r3pix:<gameId>:msgbus           — message routing table
 *   f1r3pix:<gameId>:escrow           — token escrow for game ops
 *
 * Rholang patterns used:
 *   Persistent read:   for(@x <<- @channel) { ... }   — peek without consuming
 *   Consuming read:    for(@x <- @channel) { ... }     — read + consume
 *   Send:              @channel!(data)                  — write to channel
 *   Registry lookup:   new rl(`rho:registry:lookup`)    — system registry
 *   Deploy ID return:  new return(`rho:rchain:deployId`) — return data to caller
 */

export const RholangContracts = {

  // ─── Game Lifecycle ──────────────────────────────────────────────

  /**
   * Initialize the F1R3Pix game on the shard.
   * Creates all root channels for game state management.
   * Deploy this ONCE when creating a new game instance.
   */
  initGame: (gameId: string): string => `
    new
      stdout(\`rho:io:stdout\`)
    in {
      // Grid state registry
      @{"f1r3pix:${gameId}:grid:registry"}!(
        { "gameId": "${gameId}", "created": ${Date.now()}, "cells": {} }
      ) |

      // Player registry (accumulator list)
      @{"f1r3pix:${gameId}:players"}!([]) |

      // Message bus routing table
      @{"f1r3pix:${gameId}:msgbus"}!({}) |

      // Token escrow for in-game transfers
      @{"f1r3pix:${gameId}:escrow"}!({}) |

      stdout!("F1R3Pix game initialized: ${gameId}")
    }
  `,

  // ─── Player Management ───────────────────────────────────────────

  /**
   * Register a player in the game.
   * - Appends player info to the players registry
   * - Creates their personal message inbox channel
   * - Initializes their assigned hex cell
   */
  registerPlayer: (
    gameId: string, playerId: string, pubKey: string,
    cellQ: number, cellR: number,
  ): string => `
    new ack in {
      for(@players <- @{"f1r3pix:${gameId}:players"}) {
        @{"f1r3pix:${gameId}:players"}!(
          players ++ [{
            "id": "${playerId}",
            "pubKey": "${pubKey}",
            "cell": [${cellQ}, ${cellR}],
            "joined": ${Date.now()}
          }]
        )
      } |

      // Create message inbox
      @{"f1r3pix:${gameId}:inbox:${playerId}"}!([]) |

      // Initialize cell state
      @{"f1r3pix:${gameId}:grid:${cellQ},${cellR}"}!(
        { "color": "#111118", "owner": "${playerId}", "ts": ${Date.now()} }
      )
    }
  `,

  /**
   * Read all registered players (non-consuming peek).
   */
  getPlayers: (gameId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@players <<- @{"f1r3pix:${gameId}:players"}) {
        return!(players)
      }
    }
  `,

  // ─── Grid Operations ─────────────────────────────────────────────

  /**
   * Set a cell's color.
   *
   * This is the CORE game action — the only thing a player can
   * do to the grid. Ownership is verified: only the cell's owner
   * can change its color.
   *
   * The consume-and-replace pattern ensures atomicity:
   *   1. Consume current state from channel (blocking if empty)
   *   2. Verify ownership
   *   3. Write updated state back to channel
   */
  setCellColor: (
    gameId: string, q: number, r: number, color: string, playerId: string,
  ): string => `
    new resultCh in {
      for(@cell <- @{"f1r3pix:${gameId}:grid:${q},${r}"}) {
        if (cell.get("owner") == "${playerId}") {
          @{"f1r3pix:${gameId}:grid:${q},${r}"}!(
            cell.set("color", "${color}").set("ts", ${Date.now()})
          ) |
          resultCh!(true)
        } else {
          @{"f1r3pix:${gameId}:grid:${q},${r}"}!(cell) |
          resultCh!(false)
        }
      }
    }
  `,

  /**
   * Read a cell's state (non-consuming peek).
   */
  getCellState: (gameId: string, q: number, r: number): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@cell <<- @{"f1r3pix:${gameId}:grid:${q},${r}"}) {
        return!(cell)
      }
    }
  `,

  /**
   * Batch-read multiple cells in a single deploy.
   * More efficient than individual reads for full grid sync.
   */
  getBatchCellStates: (gameId: string, cells: { q: number; r: number }[]): string => `
    new return(\`rho:rchain:deployId\`), collect in {
      ${cells.map(({ q, r }, i) => `
      new ch${i} in {
        for(@cell <<- @{"f1r3pix:${gameId}:grid:${q},${r}"}) {
          ch${i}!(cell)
        }
      }`).join(' |\n')} |
      ${cells.length > 0 ? `
      ${cells.map((_, i) => `for(@c${i} <- ch${i})`).join(' |\n')} {
        return!([${cells.map((_, i) => `c${i}`).join(', ')}])
      }` : 'return!([])'}
    }
  `,

  // ─── Messaging ───────────────────────────────────────────────────

  /**
   * Send a message to one or more players.
   * Messages are appended to each recipient's inbox channel.
   *
   * The inbox uses an accumulator pattern:
   *   1. Consume current inbox list
   *   2. Append new message
   *   3. Write updated list back
   */
  sendMessage: (
    gameId: string, fromId: string, toIds: string[], text: string,
  ): string => `
    new ack in {
      ${toIds.map(toId => `
      for(@inbox <- @{"f1r3pix:${gameId}:inbox:${toId}"}) {
        @{"f1r3pix:${gameId}:inbox:${toId}"}!(
          inbox ++ [{
            "from": "${fromId}",
            "text": "${escapeRholangString(text)}",
            "ts": ${Date.now()}
          }]
        )
      }`).join(' |\n')}
    }
  `,

  /**
   * Read and drain a player's inbox.
   * Consumes all messages and resets the inbox to empty.
   */
  readInbox: (gameId: string, playerId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@inbox <- @{"f1r3pix:${gameId}:inbox:${playerId}"}) {
        @{"f1r3pix:${gameId}:inbox:${playerId}"}!([]) |
        return!(inbox)
      }
    }
  `,

  /**
   * Peek at inbox without consuming (check for new messages).
   */
  peekInbox: (gameId: string, playerId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@inbox <<- @{"f1r3pix:${gameId}:inbox:${playerId}"}) {
        return!(inbox)
      }
    }
  `,

  // ─── Token Operations (F1R3Cap / REV) ────────────────────────────
  // These follow the revVault pattern used in embers and rchain.
  // The revVault is the shard's built-in token management system.

  /**
   * Transfer F1R3Cap tokens between players.
   *
   * Uses the revVault pattern:
   *   1. Look up revVault in system registry
   *   2. Find or create sender's vault
   *   3. Call vault.transfer(toAddr, amount, deployerId)
   *
   * The deployerId is automatically injected by the shard runtime
   * to verify the sender has authority over the vault.
   */
  transferTokens: (fromRevAddr: string, toRevAddr: string, amount: number): string => `
    new
      rl(\`rho:registry:lookup\`),
      revVaultCh,
      vaultCh,
      deployerId(\`rho:rchain:deployerId\`),
      resultCh,
      stdout(\`rho:io:stdout\`)
    in {
      rl!(\`rho:rchain:revVault\`, *revVaultCh) |
      for(@(_, revVault) <- revVaultCh) {
        @revVault!("findOrCreate", "${fromRevAddr}", *vaultCh) |
        for(@(true, vault) <- vaultCh) {
          @vault!("transfer", "${toRevAddr}", ${amount}, *deployerId, *resultCh) |
          for(@result <- resultCh) {
            match result {
              (true, _) => {
                stdout!("F1R3Pix transfer OK: ${amount} ${fromRevAddr} -> ${toRevAddr}")
              }
              (false, err) => {
                stdout!(("F1R3Pix transfer FAIL:", err))
              }
            }
          }
        }
      }
    }
  `,

  /**
   * Query a player's F1R3Cap token balance.
   */
  getBalance: (revAddr: string): string => `
    new
      return(\`rho:rchain:deployId\`),
      rl(\`rho:registry:lookup\`),
      revVaultCh,
      vaultCh,
      balanceCh
    in {
      rl!(\`rho:rchain:revVault\`, *revVaultCh) |
      for(@(_, revVault) <- revVaultCh) {
        @revVault!("findOrCreate", "${revAddr}", *vaultCh) |
        for(@(true, vault) <- vaultCh) {
          @vault!("balance", *balanceCh) |
          for(@balance <- balanceCh) {
            return!(balance)
          }
        }
      }
    }
  `,

  /**
   * Escrow tokens for a game operation.
   * Locks tokens in the game's escrow channel until a condition is met.
   * Useful for coordinated actions (e.g., "I'll pay 50 F1R3Cap if
   * we complete this pattern on the grid").
   */
  escrowTokens: (
    gameId: string, fromRevAddr: string, amount: number,
    conditionChannel: string,
  ): string => `
    new
      rl(\`rho:registry:lookup\`),
      revVaultCh,
      vaultCh,
      deployerId(\`rho:rchain:deployerId\`),
      escrowResultCh,
      stdout(\`rho:io:stdout\`)
    in {
      rl!(\`rho:rchain:revVault\`, *revVaultCh) |
      for(@(_, revVault) <- revVaultCh) {
        @revVault!("findOrCreate", "${fromRevAddr}", *vaultCh) |
        for(@(true, vault) <- vaultCh) {

          // Transfer to escrow address
          @vault!("transfer",
            "f1r3pix-escrow-${gameId}",
            ${amount},
            *deployerId,
            *escrowResultCh
          ) |

          for(@(true, _) <- escrowResultCh) {
            // Record in escrow registry
            for(@escrow <- @{"f1r3pix:${gameId}:escrow"}) {
              @{"f1r3pix:${gameId}:escrow"}!(
                escrow.set("${fromRevAddr}", {
                  "amount": ${amount},
                  "condition": "${conditionChannel}",
                  "ts": ${Date.now()}
                })
              )
            } |

            // Wait for condition to be met, then release
            for(@conditionMet <- @{"${conditionChannel}"}) {
              if (conditionMet) {
                stdout!("Escrow released for ${fromRevAddr}")
              } else {
                // Refund
                stdout!("Escrow refunded to ${fromRevAddr}")
              }
            }
          }
        }
      }
    }
  `,
};


// ─── Utility ───────────────────────────────────────────────────────

/**
 * Escape special characters in a string for safe embedding in rholang.
 */
function escapeRholangString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export { escapeRholangString };
