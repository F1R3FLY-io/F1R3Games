/**
 * F1R3Games Account Contracts
 * Rholang source for shard-native identity management.
 *
 * On-chain channels:
 *   @"f1r3-accounts"  — registry: Map[address → profile]
 *   @"f1r3-contacts"  — social graph: Map[address → Map[contactId → contact]]
 *   @"f1r3-sessions"  — game sessions: Map[sessionId → session]
 *   @"f1r3-invites"   — invitations: Map[sessionId → Map[contactId → invite]]
 */

/**
 * Deploy the account registry contract.
 * Creates the persistent @"f1r3-accounts" channel with an empty map.
 */
export const DEPLOY_ACCOUNT_REGISTRY = `
  new accounts(\`rho:registry:insertArbitrary\`),
      stdout(\`rho:io:stdout\`) in {
    // Initialize empty account registry
    @"f1r3-accounts"!({}) |
    @"f1r3-contacts"!({}) |
    @"f1r3-sessions"!({}) |
    @"f1r3-invites"!({}) |
    stdout!("F1R3Games registry deployed")
  }
`;

/**
 * Register a new account on the shard.
 * Writes { address, name, tags, avatarSeed, createdAt } to the registry.
 */
export function registerAccount(
  address: string,
  name: string,
  tags: string[],
  avatarSeed: number
): string {
  const tagsRho = tags.map(t => `"${t}"`).join(", ");
  return `
    for (@registry <- @"f1r3-accounts") {
      @"f1r3-accounts"!(
        registry.set(
          "${address}",
          {
            "address": "${address}",
            "name": "${name}",
            "tags": [${tagsRho}],
            "avatarSeed": ${avatarSeed},
            "createdAt": ${Date.now()},
            "lastSeen": ${Date.now()}
          }
        )
      )
    }
  `;
}

/**
 * Update an account's profile (name, tags).
 */
export function updateAccount(
  address: string,
  name: string,
  tags: string[]
): string {
  const tagsRho = tags.map(t => `"${t}"`).join(", ");
  return `
    for (@registry <- @"f1r3-accounts") {
      match registry.get("${address}") {
        Nil => { @"f1r3-accounts"!(registry) }
        acct => {
          @"f1r3-accounts"!(
            registry.set(
              "${address}",
              acct.set("name", "${name}")
                  .set("tags", [${tagsRho}])
                  .set("lastSeen", ${Date.now()})
            )
          )
        }
      }
    }
  `;
}

/**
 * Look up an account by address (read-only exploratory deploy).
 */
export function lookupAccount(address: string): string {
  return `
    new ret(\`rho:rchain:deployId\`) in {
      for (@registry <<- @"f1r3-accounts") {
        ret!(registry.get("${address}"))
      }
    }
  `;
}

/**
 * List all registered accounts (read-only).
 */
export const LIST_ACCOUNTS = `
  new ret(\`rho:rchain:deployId\`) in {
    for (@registry <<- @"f1r3-accounts") {
      ret!(registry)
    }
  }
`;

/**
 * Add a contact to the owner's social graph on the shard.
 */
export function addContact(
  ownerAddr: string,
  contactId: string,
  name: string,
  handle: string,
  channel: string
): string {
  return `
    for (@graph <- @"f1r3-contacts") {
      @"f1r3-contacts"!(
        graph.set(
          "${ownerAddr}",
          match graph.get("${ownerAddr}") {
            Nil => {
              { "${contactId}": { "id": "${contactId}", "name": "${name}", "handle": "${handle}", "channel": "${channel}", "addedAt": ${Date.now()} } }
            }
            contacts => {
              contacts.set("${contactId}", { "id": "${contactId}", "name": "${name}", "handle": "${handle}", "channel": "${channel}", "addedAt": ${Date.now()} })
            }
          }
        )
      )
    }
  `;
}

/**
 * Create a game session on the shard.
 */
export function createSession(
  sessionId: string,
  game: string,
  hostAddr: string,
  hostName: string
): string {
  return `
    for (@sessions <- @"f1r3-sessions") {
      @"f1r3-sessions"!(
        sessions.set(
          "${sessionId}",
          {
            "id": "${sessionId}",
            "game": "${game}",
            "hostAddr": "${hostAddr}",
            "hostName": "${hostName}",
            "createdAt": ${Date.now()},
            "status": "lobby"
          }
        )
      )
    }
  `;
}

/**
 * Write an invitation to the shard.
 */
export function sendInvite(
  sessionId: string,
  contactId: string,
  contactName: string,
  contactHandle: string,
  channel: string,
  hostAddr: string,
  game: string
): string {
  return `
    for (@invites <- @"f1r3-invites") {
      @"f1r3-invites"!(
        invites.set(
          "${sessionId}",
          match invites.get("${sessionId}") {
            Nil => {
              { "${contactId}": { "contactId": "${contactId}", "contactName": "${contactName}", "contactHandle": "${contactHandle}", "channel": "${channel}", "hostAddr": "${hostAddr}", "game": "${game}", "status": "sent", "sentAt": ${Date.now()} } }
            }
            existing => {
              existing.set("${contactId}", { "contactId": "${contactId}", "contactName": "${contactName}", "contactHandle": "${contactHandle}", "channel": "${channel}", "hostAddr": "${hostAddr}", "game": "${game}", "status": "sent", "sentAt": ${Date.now()} })
            }
          }
        )
      )
    }
  `;
}
