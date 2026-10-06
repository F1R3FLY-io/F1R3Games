/**
 * ═══════════════════════════════════════════════════════════════════
 * F1R3SideChat Rholang Contract Templates
 * ═══════════════════════════════════════════════════════════════════
 *
 * Domain model:
 *   - A "story" is a collaborative narrative with chapters
 *   - Two user classes: CONSUMER (reads, comments) and CREATOR (writes)
 *   - Consumer -> Creator transition: "Take the Wheel" on a character
 *   - Chapters can be "published" (read-only) or "open" (writable)
 *   - Characters are entities within the story with a "driver" (creator)
 *   - Comments are free for all users
 *   - Tips reward contributions
 *   - AI co-authoring is a premium engagement (high token cost)
 *
 * Channel naming convention:
 *   f1r3sidechat:<storyId>:meta              — story metadata
 *   f1r3sidechat:<storyId>:chapters           — chapter registry
 *   f1r3sidechat:<storyId>:ch:<chId>:content  — chapter text content
 *   f1r3sidechat:<storyId>:ch:<chId>:comments — per-chapter comments
 *   f1r3sidechat:<storyId>:characters         — character registry
 *   f1r3sidechat:<storyId>:char:<charId>      — per-character state (driver, etc.)
 *   f1r3sidechat:<storyId>:players            — player registry + roles
 *   f1r3sidechat:<storyId>:inbox:<playerId>   — per-player message inbox
 *   f1r3sidechat:<storyId>:tips               — tip ledger
 *   f1r3sidechat:<storyId>:escrow             — token escrow
 *   f1r3sidechat:<storyId>:ai:<sessionId>     — AI co-author session state
 *
 * Rholang patterns (shared with F1R3Pix / F1R3Beat):
 *   Persistent read:   for(@x <<- @channel) { ... }
 *   Consuming read:    for(@x <- @channel) { ... }
 *   Send:              @channel!(data)
 *   Registry lookup:   new rl(`rho:registry:lookup`)
 *   Deploy ID return:  new return(`rho:rchain:deployId`)
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface StoryConfig {
  storyId: string;
  title: string;
  genre: string;
  synopsis: string;
  authorId: string;
  authorPubKey: string;
}

export interface CharacterDef {
  id: string;
  name: string;
  role: string; // e.g., "Protagonist — blind cartographer"
}

export interface ChapterDef {
  id: string;
  num: number;
  title: string;
  status: 'open' | 'published';
}

export type UserRole = 'consumer' | 'creator';

// ─── Token costs (should match UI constants) ──────────────────────

export const TOKEN_COSTS = {
  TAKE_WHEEL:     100,
  AI_COAUTHOR:    500,
  TALK_TO_AUTHOR: 250,
  TIP_MIN:        10,
};

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

export const SideChatContracts = {

  // ═══ STORY LIFECYCLE ════════════════════════════════════════════

  /**
   * Initialize a new story on the shard.
   *
   * Creates:
   *   - Story metadata (title, genre, synopsis, author)
   *   - Empty chapter registry
   *   - Empty character registry
   *   - Player registry (author pre-registered as creator)
   *   - Tip ledger
   *   - Token escrow
   */
  initStory: (config: StoryConfig): string => `
    new
      stdout(\`rho:io:stdout\`)
    in {
      // Story metadata (immutable core, mutable reader count)
      @{"f1r3sidechat:${config.storyId}:meta"}!({
        "storyId": "${config.storyId}",
        "title": "${esc(config.title)}",
        "genre": "${esc(config.genre)}",
        "synopsis": "${esc(config.synopsis)}",
        "authorId": "${config.authorId}",
        "readers": 0,
        "created": ${Date.now()}
      }) |

      // Chapter registry (ordered list)
      @{"f1r3sidechat:${config.storyId}:chapters"}!([]) |

      // Character registry
      @{"f1r3sidechat:${config.storyId}:characters"}!([]) |

      // Player registry (author pre-registered)
      @{"f1r3sidechat:${config.storyId}:players"}!([{
        "id": "${config.authorId}",
        "pubKey": "${config.authorPubKey}",
        "role": "creator",
        "joined": ${Date.now()}
      }]) |

      // Tip ledger: records all tips
      @{"f1r3sidechat:${config.storyId}:tips"}!([]) |

      // Token escrow
      @{"f1r3sidechat:${config.storyId}:escrow"}!({}) |

      // Message bus
      @{"f1r3sidechat:${config.storyId}:msgbus"}!({}) |

      stdout!("F1R3SideChat story initialized: ${config.storyId}")
    }
  `,

  /**
   * Read story metadata.
   */
  getStoryMeta: (storyId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@meta <<- @{"f1r3sidechat:${storyId}:meta"}) {
        return!(meta)
      }
    }
  `,

  /**
   * Increment reader count (when someone opens the story).
   */
  incrementReaders: (storyId: string): string => `
    for(@meta <- @{"f1r3sidechat:${storyId}:meta"}) {
      @{"f1r3sidechat:${storyId}:meta"}!(
        meta.set("readers", meta.get("readers") + 1)
      )
    }
  `,

  // ═══ PLAYER MANAGEMENT ══════════════════════════════════════════

  /**
   * Register a player in the story.
   * New players join as consumers by default.
   */
  registerPlayer: (
    storyId: string, playerId: string, pubKey: string,
  ): string => `
    new ack in {
      for(@players <- @{"f1r3sidechat:${storyId}:players"}) {
        @{"f1r3sidechat:${storyId}:players"}!(
          players ++ [{
            "id": "${playerId}",
            "pubKey": "${pubKey}",
            "role": "consumer",
            "joined": ${Date.now()}
          }]
        )
      } |
      @{"f1r3sidechat:${storyId}:inbox:${playerId}"}!([])
    }
  `,

  getPlayers: (storyId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@players <<- @{"f1r3sidechat:${storyId}:players"}) {
        return!(players)
      }
    }
  `,

  /**
   * Promote a player from consumer to creator.
   *
   * This is triggered by the "Take the Wheel" action.
   * The token payment is handled separately via transferTokens.
   * This contract only updates the role — the caller must verify
   * payment before deploying this.
   */
  promoteToCreator: (storyId: string, playerId: string): string => `
    for(@players <- @{"f1r3sidechat:${storyId}:players"}) {
      @{"f1r3sidechat:${storyId}:players"}!(
        players.map(@p => {
          if (p.get("id") == "${playerId}") {
            p.set("role", "creator").set("promotedAt", ${Date.now()})
          } else { p }
        })
      )
    }
  `,

  // ═══ CHARACTERS ═════════════════════════════════════════════════

  /**
   * Add a character to the story.
   * Characters start with no driver (available for "Take the Wheel").
   */
  addCharacter: (
    storyId: string, charId: string, name: string, role: string,
  ): string => `
    new ack in {
      for(@chars <- @{"f1r3sidechat:${storyId}:characters"}) {
        @{"f1r3sidechat:${storyId}:characters"}!(
          chars ++ [{
            "id": "${charId}",
            "name": "${esc(name)}",
            "role": "${esc(role)}",
            "driver": Nil,
            "created": ${Date.now()}
          }]
        )
      } |
      // Individual channel for character state
      @{"f1r3sidechat:${storyId}:char:${charId}"}!({
        "id": "${charId}",
        "name": "${esc(name)}",
        "role": "${esc(role)}",
        "driver": Nil,
        "driverHistory": []
      })
    }
  `,

  getCharacters: (storyId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@chars <<- @{"f1r3sidechat:${storyId}:characters"}) {
        return!(chars)
      }
    }
  `,

  /**
   * Take the wheel on a character.
   *
   * Sets the player as the character's driver. Only works if:
   *   1. The character has no current driver (driver == Nil)
   *   2. The player has paid the TAKE_WHEEL cost
   *
   * This also promotes the player to creator if they were a consumer.
   */
  takeTheWheel: (
    storyId: string, charId: string, playerId: string,
  ): string => `
    new resultCh in {
      // Update character driver
      for(@char <- @{"f1r3sidechat:${storyId}:char:${charId}"}) {
        if (char.get("driver") == Nil) {
          @{"f1r3sidechat:${storyId}:char:${charId}"}!(
            char
              .set("driver", "${playerId}")
              .set("driverHistory",
                char.get("driverHistory") ++ [{ "player": "${playerId}", "ts": ${Date.now()} }])
          ) |

          // Also update in the character registry list
          for(@chars <- @{"f1r3sidechat:${storyId}:characters"}) {
            @{"f1r3sidechat:${storyId}:characters"}!(
              chars.map(@c => {
                if (c.get("id") == "${charId}") {
                  c.set("driver", "${playerId}")
                } else { c }
              })
            )
          } |

          resultCh!(true)
        } else {
          @{"f1r3sidechat:${storyId}:char:${charId}"}!(char) |
          resultCh!(false)
        }
      }
    }
  `,

  /**
   * Release the wheel on a character (give up driving).
   */
  releaseWheel: (
    storyId: string, charId: string, playerId: string,
  ): string => `
    new resultCh in {
      for(@char <- @{"f1r3sidechat:${storyId}:char:${charId}"}) {
        if (char.get("driver") == "${playerId}") {
          @{"f1r3sidechat:${storyId}:char:${charId}"}!(
            char.set("driver", Nil)
          ) |
          for(@chars <- @{"f1r3sidechat:${storyId}:characters"}) {
            @{"f1r3sidechat:${storyId}:characters"}!(
              chars.map(@c => {
                if (c.get("id") == "${charId}") { c.set("driver", Nil) } else { c }
              })
            )
          } |
          resultCh!(true)
        } else {
          @{"f1r3sidechat:${storyId}:char:${charId}"}!(char) |
          resultCh!(false)
        }
      }
    }
  `,

  // ═══ CHAPTERS ═══════════════════════════════════════════════════

  /**
   * Add a new chapter to the story.
   * Only the story author or a creator with a driven character
   * can add chapters.
   */
  addChapter: (
    storyId: string, chapterId: string, num: number, title: string,
    status: 'open' | 'published', authorId: string,
  ): string => `
    new ack in {
      // Add to chapter registry
      for(@chapters <- @{"f1r3sidechat:${storyId}:chapters"}) {
        @{"f1r3sidechat:${storyId}:chapters"}!(
          chapters ++ [{
            "id": "${chapterId}",
            "num": ${num},
            "title": "${esc(title)}",
            "status": "${status}",
            "author": "${authorId}",
            "created": ${Date.now()}
          }]
        )
      } |

      // Create chapter content channel (starts empty)
      @{"f1r3sidechat:${storyId}:ch:${chapterId}:content"}!({
        "text": "",
        "wordCount": 0,
        "applause": 0,
        "lastEditor": "${authorId}",
        "revisions": [],
        "ts": ${Date.now()}
      }) |

      // Create chapter comments channel
      @{"f1r3sidechat:${storyId}:ch:${chapterId}:comments"}!([])
    }
  `,

  getChapters: (storyId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@chapters <<- @{"f1r3sidechat:${storyId}:chapters"}) {
        return!(chapters)
      }
    }
  `,

  /**
   * Write or append to a chapter's content.
   *
   * Only the chapter's author or a creator driving a character
   * in the story can write. The contract appends text and stores
   * the full revision history on-shard.
   */
  writeChapter: (
    storyId: string, chapterId: string, text: string,
    authorId: string, append: boolean,
  ): string => `
    new resultCh in {
      for(@content <- @{"f1r3sidechat:${storyId}:ch:${chapterId}:content"}) {
        ${append ? `
        // Append mode: add to existing text
        @{"f1r3sidechat:${storyId}:ch:${chapterId}:content"}!(
          content
            .set("text", content.get("text") ++ "\\n\\n${esc(text)}")
            .set("lastEditor", "${authorId}")
            .set("revisions",
              content.get("revisions") ++ [{
                "editor": "${authorId}",
                "action": "append",
                "ts": ${Date.now()}
              }])
            .set("ts", ${Date.now()})
        )` : `
        // Replace mode: overwrite text
        @{"f1r3sidechat:${storyId}:ch:${chapterId}:content"}!(
          content
            .set("text", "${esc(text)}")
            .set("lastEditor", "${authorId}")
            .set("revisions",
              content.get("revisions") ++ [{
                "editor": "${authorId}",
                "action": "replace",
                "ts": ${Date.now()}
              }])
            .set("ts", ${Date.now()})
        )`} |
        resultCh!(true)
      }
    }
  `,

  /**
   * Read a chapter's content.
   */
  getChapterContent: (storyId: string, chapterId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@content <<- @{"f1r3sidechat:${storyId}:ch:${chapterId}:content"}) {
        return!(content)
      }
    }
  `,

  /**
   * Publish a chapter (change status from open to published).
   */
  publishChapter: (storyId: string, chapterId: string, authorId: string): string => `
    for(@chapters <- @{"f1r3sidechat:${storyId}:chapters"}) {
      @{"f1r3sidechat:${storyId}:chapters"}!(
        chapters.map(@ch => {
          if (ch.get("id") == "${chapterId}" and ch.get("author") == "${authorId}") {
            ch.set("status", "published").set("publishedAt", ${Date.now()})
          } else { ch }
        })
      )
    }
  `,

  /**
   * Applaud a chapter (increment applause counter).
   */
  applaudChapter: (storyId: string, chapterId: string): string => `
    for(@content <- @{"f1r3sidechat:${storyId}:ch:${chapterId}:content"}) {
      @{"f1r3sidechat:${storyId}:ch:${chapterId}:content"}!(
        content.set("applause", content.get("applause") + 1)
      )
    }
  `,

  // ═══ COMMENTS ═══════════════════════════════════════════════════
  // Comments are FREE for all users (consumers and creators).
  // Stored per-chapter as an accumulator list.

  addComment: (
    storyId: string, chapterId: string,
    playerId: string, text: string,
  ): string => `
    for(@comments <- @{"f1r3sidechat:${storyId}:ch:${chapterId}:comments"}) {
      @{"f1r3sidechat:${storyId}:ch:${chapterId}:comments"}!(
        comments ++ [{
          "id": ${Date.now()},
          "user": "${playerId}",
          "text": "${esc(text)}",
          "applause": 0,
          "ts": ${Date.now()}
        }]
      )
    }
  `,

  getComments: (storyId: string, chapterId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@comments <<- @{"f1r3sidechat:${storyId}:ch:${chapterId}:comments"}) {
        return!(comments)
      }
    }
  `,

  /**
   * Applaud a specific comment.
   */
  applaudComment: (
    storyId: string, chapterId: string, commentId: number,
  ): string => `
    for(@comments <- @{"f1r3sidechat:${storyId}:ch:${chapterId}:comments"}) {
      @{"f1r3sidechat:${storyId}:ch:${chapterId}:comments"}!(
        comments.map(@c => {
          if (c.get("id") == ${commentId}) {
            c.set("applause", c.get("applause") + 1)
          } else { c }
        })
      )
    }
  `,

  // ═══ TIPS ═══════════════════════════════════════════════════════
  // Tips are token transfers recorded in the tip ledger.
  // The actual transfer uses revVault; the ledger is for display.

  recordTip: (
    storyId: string, fromId: string, toId: string, amount: number,
    context: string, // e.g., "ch1" or "char:maren"
  ): string => `
    for(@tips <- @{"f1r3sidechat:${storyId}:tips"}) {
      @{"f1r3sidechat:${storyId}:tips"}!(
        tips ++ [{
          "from": "${fromId}",
          "to": "${toId}",
          "amount": ${amount},
          "context": "${esc(context)}",
          "ts": ${Date.now()}
        }]
      )
    }
  `,

  getTips: (storyId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@tips <<- @{"f1r3sidechat:${storyId}:tips"}) {
        return!(tips)
      }
    }
  `,

  // ═══ AI CO-AUTHOR SESSIONS ══════════════════════════════════════
  // Premium engagement: costs AI_COAUTHOR tokens.
  // Session state stored on-shard so it persists across connections.

  /**
   * Create an AI co-author session.
   * The session tracks the conversation between the creator
   * and the AI, plus any text the AI generated.
   */
  createAISession: (
    storyId: string, sessionId: string, playerId: string, chapterId: string,
  ): string => `
    @{"f1r3sidechat:${storyId}:ai:${sessionId}"}!({
      "sessionId": "${sessionId}",
      "player": "${playerId}",
      "chapter": "${chapterId}",
      "messages": [],
      "generatedText": [],
      "created": ${Date.now()}
    })
  `,

  /**
   * Append a message to an AI session (user or AI turn).
   */
  appendAIMessage: (
    storyId: string, sessionId: string,
    role: 'user' | 'ai', text: string,
  ): string => `
    for(@session <- @{"f1r3sidechat:${storyId}:ai:${sessionId}"}) {
      @{"f1r3sidechat:${storyId}:ai:${sessionId}"}!(
        session.set("messages",
          session.get("messages") ++ [{
            "role": "${role}",
            "text": "${esc(text)}",
            "ts": ${Date.now()}
          }]
        )
      )
    }
  `,

  getAISession: (storyId: string, sessionId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@session <<- @{"f1r3sidechat:${storyId}:ai:${sessionId}"}) {
        return!(session)
      }
    }
  `,

  // ═══ MESSAGING ══════════════════════════════════════════════════
  // Same accumulator-inbox pattern as F1R3Pix / F1R3Beat.

  sendMessage: (
    storyId: string, fromId: string, toIds: string[], text: string,
  ): string => `
    new ack in {
      ${toIds.map(toId => `
      for(@inbox <- @{"f1r3sidechat:${storyId}:inbox:${toId}"}) {
        @{"f1r3sidechat:${storyId}:inbox:${toId}"}!(
          inbox ++ [{
            "from": "${fromId}",
            "text": "${esc(text)}",
            "ts": ${Date.now()}
          }]
        )
      }`).join(' |\n')}
    }
  `,

  readInbox: (storyId: string, playerId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@inbox <- @{"f1r3sidechat:${storyId}:inbox:${playerId}"}) {
        @{"f1r3sidechat:${storyId}:inbox:${playerId}"}!([]) |
        return!(inbox)
      }
    }
  `,

  peekInbox: (storyId: string, playerId: string): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@inbox <<- @{"f1r3sidechat:${storyId}:inbox:${playerId}"}) {
        return!(inbox)
      }
    }
  `,

  // ═══ TOKEN OPERATIONS ═══════════════════════════════════════════
  // Identical revVault pattern across all F1R3 games.

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
                stdout!("F1R3SideChat transfer OK: ${amount} ${fromRevAddr} -> ${toRevAddr}")
              }
              (false, err) => {
                stdout!(("F1R3SideChat transfer FAIL:", err))
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

  // ═══ STORY DISCOVERY ════════════════════════════════════════════
  // For the per-category browser: list all active stories.

  /**
   * Register a story in the global F1R3SideChat story index.
   * This is deployed to a well-known channel so the browser
   * can discover ongoing stories.
   */
  registerInIndex: (storyId: string, title: string, genre: string, authorId: string): string => `
    for(@index <- @{"f1r3sidechat:index"}) {
      @{"f1r3sidechat:index"}!(
        index ++ [{
          "storyId": "${storyId}",
          "title": "${esc(title)}",
          "genre": "${esc(genre)}",
          "author": "${authorId}",
          "created": ${Date.now()}
        }]
      )
    }
  `,

  /**
   * Read the global story index for browsing.
   */
  getStoryIndex: (): string => `
    new return(\`rho:rchain:deployId\`) in {
      for(@index <<- @{"f1r3sidechat:index"}) {
        return!(index)
      }
    }
  `,

  /**
   * Initialize the global index (deploy once on shard setup).
   */
  initIndex: (): string => `
    @{"f1r3sidechat:index"}!([])
  `,
};
