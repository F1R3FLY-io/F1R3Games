/**
 * ═══════════════════════════════════════════════════════════════════
 * F1R3Beat Rholang Contract Templates
 * ═══════════════════════════════════════════════════════════════════
 *
 * Each function returns a rholang source string deployed to the
 * F1R3FLY shard via DeployService.doDeploy().
 *
 * F1R3Beat-specific domain model:
 *   - A "beat" is a rectangular grid: instruments × sixteenth-notes
 *   - Each cell is boolean (on/off), not a color
 *   - Musical metadata (time sig, BPM, bars, instruments) lives on-shard
 *     so all players share the same musical context
 *   - Future: instrument timbres stored as samples on-shard,
 *     selectable when creating a game
 *
 * Channel naming convention:
 *   f1r3beat:<gameId>:config                — game config (timeSig, bpm, bars, instruments)
 *   f1r3beat:<gameId>:grid:<row>,<col>      — per-cell on/off state
 *   f1r3beat:<gameId>:grid:snapshot         — full grid snapshot (batch sync)
 *   f1r3beat:<gameId>:players               — player registry
 *   f1r3beat:<gameId>:inbox:<playerId>      — per-player message inbox
 *   f1r3beat:<gameId>:escrow                — token escrow
 *   f1r3beat:<gameId>:timbres               — instrument/timbre registry (future)
 *   f1r3beat:<gameId>:transport             — shared transport state (bpm changes)
 *
 * Rholang patterns used (same as F1R3Pix):
 *   Persistent read:   for(@x <<- @channel) { ... }
 *   Consuming read:    for(@x <- @channel) { ... }
 *   Send:              @channel!(data)
 *   Registry lookup:   new rl(`rho:registry:lookup`)
 *   Deploy ID return:  new return(`rho:rchain:deployId`)
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface InstrumentDef {
  id: string;
  name: string;
  row: number;
}

export interface GameConfig {
  gameId: string;
  timeSigLabel: string;
  beatsPerBar: number;
  numBars: number;
  bpm: number;
  instruments: InstrumentDef[];
  totalCols: number; // beatsPerBar * 4 * numBars (sixteenths)
}

// ─── Utility ───────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export { esc as escapeRholangString };

// ─── Contract Templates ────────────────────────────────────────────

export const BeatContracts = {

  // ═══ GAME LIFECYCLE ══════════════════════════════════════════════

  /**
   * Initialize a F1R3Beat game on the shard.
   *
   * Creates:
   *   - Game config channel (time sig, bpm, bars, instrument defs)
   *   - Player registry
   *   - Grid snapshot (initially all off)
   *   - Message bus
   *   - Token escrow
   *   - Transport state channel (shared BPM)
   *
   * This is deployed ONCE when the game creator sets up a new session.
   * The config is immutable after creation (except BPM via transport).
   */
  initGame: (config: GameConfig): string => {
    const instrumentsRho = config.instruments
      .map(i => `{ "id": "${i.id}", "name": "${esc(i.name)}", "row": ${i.row} }`)
      .join(', ');

    // Build initial grid: all cells off
    // Stored as a map of "row,col" -> false
    const totalCells = config.instruments.length * config.totalCols;

    return `
    new
      stdout(\`rho:io:stdout\`)
    in {
      // Game configuration (immutable after init)
      @{"f1r3beat:${config.gameId}:config"}!({
        "gameId": "${config.gameId}",
        "timeSig": "${config.timeSigLabel}",
        "beatsPerBar": ${config.beatsPerBar},
        "numBars": ${config.numBars},
        "bpm": ${config.bpm},
        "instruments": [${instrumentsRho}],
        "totalCols": ${config.totalCols},
        "totalRows": ${config.instruments.length},
        "totalCells": ${totalCells},
        "created": ${Date.now()}
      }) |

      // Player registry
      @{"f1r3beat:${config.gameId}:players"}!([]) |

      // Grid snapshot — starts empty (all off)
      // Each cell is stored individually for atomic updates
      // The snapshot channel holds the last-known full state for sync
      @{"f1r3beat:${config.gameId}:grid:snapshot"}!({}) |

      // Shared transport state (mutable — BPM can be changed)
      @{"f1r3beat:${config.gameId}:transport"}!({
        "bpm": ${config.bpm},
        "playing": false,
        "updatedBy": "",
        "ts": ${Date.now()}
      }) |

      // Message bus
      @{"f1r3beat:${config.gameId}:msgbus"}!({}) |

      // Token escrow
      @{"f1r3beat:${config.gameId}:escrow"}!({}) |

      stdout!("F1R3Beat game initialized: ${config.gameId} (${config.timeSigLabel}, ${config.bpm} BPM, ${config.numBars} bars)")
    }
  `;
  },

  /**
   * Read game configuration (non-consuming peek).
   */
  getConfig: (gameId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@config <<- @{"f1r3beat:${gameId}:config"}) {
        return!(config)
      }
    }
  `,

  // ═══ PLAYER MANAGEMENT ══════════════════════════════════════════

  /**
   * Register a player in the game.
   *
   * Each player is assigned a single cell (row, col) which is
   * their sole point of influence on the grid.
   * Also creates their message inbox.
   */
  registerPlayer: (
    gameId: string,
    playerId: string,
    pubKey: string,
    cellRow: number,
    cellCol: number,
    instrumentId: string,
  ): string => `
    new ack in {
      // Append to player registry
      for(@players <- @{"f1r3beat:${gameId}:players"}) {
        @{"f1r3beat:${gameId}:players"}!(
          players ++ [{
            "id": "${playerId}",
            "pubKey": "${pubKey}",
            "cell": [${cellRow}, ${cellCol}],
            "instrument": "${instrumentId}",
            "joined": ${Date.now()}
          }]
        )
      } |

      // Create message inbox
      @{"f1r3beat:${gameId}:inbox:${playerId}"}!([]) |

      // Initialize cell state (off by default)
      @{"f1r3beat:${gameId}:grid:${cellRow},${cellCol}"}!({
        "on": false,
        "owner": "${playerId}",
        "instrument": "${instrumentId}",
        "ts": ${Date.now()}
      })
    }
  `,

  /**
   * Read player registry.
   */
  getPlayers: (gameId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@players <<- @{"f1r3beat:${gameId}:players"}) {
        return!(players)
      }
    }
  `,

  // ═══ GRID OPERATIONS (BEAT-SPECIFIC) ═════════════════════════════

  /**
   * Toggle a cell on or off.
   *
   * This is THE core game action. Each player can only toggle
   * their own cell. The contract:
   *   1. Consumes current cell state (atomic lock)
   *   2. Verifies the deployer owns the cell
   *   3. Flips the "on" boolean
   *   4. Writes updated state back
   *   5. Also updates the grid snapshot for batch sync
   *
   * The on/off toggle is simpler than F1R3Pix's color selection —
   * it's the minimal possible action, making coordination the
   * entire game.
   */
  toggleCell: (
    gameId: string,
    row: number,
    col: number,
    playerId: string,
  ): string => `
    new resultCh in {
      // Consume current cell state (atomic)
      for(@cell <- @{"f1r3beat:${gameId}:grid:${row},${col}"}) {
        if (cell.get("owner") == "${playerId}") {
          // Flip the on/off state
          @{"f1r3beat:${gameId}:grid:${row},${col}"}!(
            cell.set("on", not cell.get("on")).set("ts", ${Date.now()})
          ) |

          // Update snapshot
          for(@snap <- @{"f1r3beat:${gameId}:grid:snapshot"}) {
            @{"f1r3beat:${gameId}:grid:snapshot"}!(
              snap.set("${row},${col}", not cell.get("on"))
            )
          } |

          resultCh!(true)
        } else {
          // Not the owner — put state back unchanged
          @{"f1r3beat:${gameId}:grid:${row},${col}"}!(cell) |
          resultCh!(false)
        }
      }
    }
  `,

  /**
   * Explicitly set a cell to a specific on/off state.
   * Used for programmatic state sync rather than user toggling.
   */
  setCell: (
    gameId: string,
    row: number,
    col: number,
    on: boolean,
    playerId: string,
  ): string => `
    new resultCh in {
      for(@cell <- @{"f1r3beat:${gameId}:grid:${row},${col}"}) {
        if (cell.get("owner") == "${playerId}") {
          @{"f1r3beat:${gameId}:grid:${row},${col}"}!(
            cell.set("on", ${on}).set("ts", ${Date.now()})
          ) |
          for(@snap <- @{"f1r3beat:${gameId}:grid:snapshot"}) {
            @{"f1r3beat:${gameId}:grid:snapshot"}!(
              snap.set("${row},${col}", ${on})
            )
          } |
          resultCh!(true)
        } else {
          @{"f1r3beat:${gameId}:grid:${row},${col}"}!(cell) |
          resultCh!(false)
        }
      }
    }
  `,

  /**
   * Read a single cell's state (non-consuming peek).
   */
  getCellState: (gameId: string, row: number, col: number): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@cell <<- @{"f1r3beat:${gameId}:grid:${row},${col}"}) {
        return!(cell)
      }
    }
  `,

  /**
   * Read the full grid snapshot.
   *
   * Returns a map of "row,col" -> boolean for every cell that is ON.
   * Cells not in the map are off. This is much more efficient than
   * reading each cell individually (one deploy vs totalCells deploys).
   */
  getGridSnapshot: (gameId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@snap <<- @{"f1r3beat:${gameId}:grid:snapshot"}) {
        return!(snap)
      }
    }
  `,

  /**
   * Batch-read a specific instrument row.
   *
   * Useful for syncing a single instrument's pattern without
   * reading the entire grid. Reads all columns for a given row.
   */
  getInstrumentRow: (gameId: string, row: number, totalCols: number): string => {
    const channels = Array.from({ length: totalCols }, (_, col) => col);
    return `
    new return(\`rho:rchain:deployId\`) in {
      ${channels.map((col, i) => `
      new ch${i} in {
        for(@cell <<- @{"f1r3beat:${gameId}:grid:${row},${col}"}) {
          ch${i}!(cell)
        }
      }`).join(' |\n')} |
      ${channels.map((_, i) => `for(@c${i} <- ch${i})`).join(' |\n')} {
        return!([${channels.map((_, i) => `c${i}`).join(', ')}])
      }
    }
  `;
  },

  // ═══ TRANSPORT ══════════════════════════════════════════════════

  /**
   * Update the shared BPM.
   *
   * Any player can propose a BPM change. In production, this
   * could require a vote or token stake to prevent griefing.
   */
  setBpm: (gameId: string, bpm: number, playerId: string): string => `
    new ack in {
      for(@transport <- @{"f1r3beat:${gameId}:transport"}) {
        @{"f1r3beat:${gameId}:transport"}!(
          transport
            .set("bpm", ${bpm})
            .set("updatedBy", "${playerId}")
            .set("ts", ${Date.now()})
        )
      }
    }
  `,

  /**
   * Read the current transport state.
   */
  getTransport: (gameId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@transport <<- @{"f1r3beat:${gameId}:transport"}) {
        return!(transport)
      }
    }
  `,

  // ═══ MESSAGING ══════════════════════════════════════════════════
  // Identical pattern to F1R3Pix — accumulator inbox per player.

  sendMessage: (
    gameId: string, fromId: string, toIds: string[], text: string,
  ): string => `
    new ack in {
      ${toIds.map(toId => `
      for(@inbox <- @{"f1r3beat:${gameId}:inbox:${toId}"}) {
        @{"f1r3beat:${gameId}:inbox:${toId}"}!(
          inbox ++ [{
            "from": "${fromId}",
            "text": "${esc(text)}",
            "ts": ${Date.now()}
          }]
        )
      }`).join(' |\n')}
    }
  `,

  readInbox: (gameId: string, playerId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@inbox <- @{"f1r3beat:${gameId}:inbox:${playerId}"}) {
        @{"f1r3beat:${gameId}:inbox:${playerId}"}!([]) |
        return!(inbox)
      }
    }
  `,

  peekInbox: (gameId: string, playerId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@inbox <<- @{"f1r3beat:${gameId}:inbox:${playerId}"}) {
        return!(inbox)
      }
    }
  `,

  // ═══ TOKEN OPERATIONS ═══════════════════════════════════════════
  // Identical revVault pattern to F1R3Pix.

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
                stdout!("F1R3Beat transfer OK: ${amount} ${fromRevAddr} -> ${toRevAddr}")
              }
              (false, err) => {
                stdout!(("F1R3Beat transfer FAIL:", err))
              }
            }
          }
        }
      }
    }
  `,

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
   * Escrow tokens for a coordinated beat condition.
   *
   * Example: "I'll pay 100 F1R3Cap if we get a 4-on-the-floor
   * kick pattern going." The condition channel is checked after
   * the escrow is set up, and tokens are released or refunded.
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
          @vault!("transfer",
            "f1r3beat-escrow-${gameId}",
            ${amount},
            *deployerId,
            *escrowResultCh
          ) |
          for(@(true, _) <- escrowResultCh) {
            for(@escrow <- @{"f1r3beat:${gameId}:escrow"}) {
              @{"f1r3beat:${gameId}:escrow"}!(
                escrow.set("${fromRevAddr}", {
                  "amount": ${amount},
                  "condition": "${conditionChannel}",
                  "ts": ${Date.now()}
                })
              )
            } |
            for(@conditionMet <- @{"${conditionChannel}"}) {
              if (conditionMet) {
                stdout!("F1R3Beat escrow released: ${fromRevAddr}")
              } else {
                stdout!("F1R3Beat escrow refunded: ${fromRevAddr}")
              }
            }
          }
        }
      }
    }
  `,

  // ═══ TIMBRE REGISTRY (FUTURE) ═══════════════════════════════════
  // Placeholder for when players can upload samples to the shard
  // and select from available timbres when creating a game.

  /**
   * Register a new timbre/instrument on the shard.
   * In the future, this would store sample data or synthesis
   * parameters on-shard so any game can use them.
   */
  registerTimbre: (
    gameId: string,
    timbreId: string,
    name: string,
    synthParams: string, // JSON-encoded synthesis parameters
    uploadedBy: string,
  ): string => `
    new ack in {
      for(@timbres <- @{"f1r3beat:${gameId}:timbres"}) {
        @{"f1r3beat:${gameId}:timbres"}!(
          timbres ++ [{
            "id": "${timbreId}",
            "name": "${esc(name)}",
            "params": "${esc(synthParams)}",
            "uploadedBy": "${uploadedBy}",
            "ts": ${Date.now()}
          }]
        )
      }
    }
  `,

  getTimbres: (gameId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@timbres <<- @{"f1r3beat:${gameId}:timbres"}) {
        return!(timbres)
      }
    }
  `,
};
