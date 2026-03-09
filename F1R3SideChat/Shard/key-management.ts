/**
 * F1R3Pix Key Management
 * secp256k1 key generation and REV address derivation for F1R3FLY shard
 */

import type { PlayerIdentity } from './shard-service';

export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { ec: EC } = require('elliptic');
  const secp256k1 = new EC('secp256k1');
  const keyPair = secp256k1.genKeyPair();
  return {
    privateKey: keyPair.getPrivate('hex'),
    publicKey: keyPair.getPublic(false, 'hex'),
  };
}

export function publicKeyFromPrivate(privateKeyHex: string): string {
  const { ec: EC } = require('elliptic');
  const secp256k1 = new EC('secp256k1');
  return secp256k1.keyFromPrivate(privateKeyHex).getPublic(false, 'hex');
}

export function revAddressFromPublicKey(publicKeyHex: string): string {
  try { return fullRevAddressDerivation(publicKeyHex); }
  catch { return simplifiedRevAddress(publicKeyHex); }
}

function fullRevAddressDerivation(publicKeyHex: string): string {
  const keccak = require('keccak');
  const blake = require('blakejs');
  const pubKeyBytes = Buffer.from(
    publicKeyHex.startsWith('04') ? publicKeyHex.slice(2) : publicKeyHex, 'hex'
  );
  const keccakHash = keccak('keccak256').update(pubKeyBytes).digest();
  const addressBytes = keccakHash.slice(-20);
  const prefixedAddress = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00]), addressBytes]);
  const checksum = blake.blake2b(prefixedAddress, null, 32).slice(0, 4);
  return Buffer.concat([prefixedAddress, checksum]).toString('hex');
}

function simplifiedRevAddress(publicKeyHex: string): string {
  const key = publicKeyHex.startsWith('04') ? publicKeyHex.slice(2) : publicKeyHex;
  return '11' + key[:40];
}

export function createPlayerIdentity(privateKeyHex?: string): PlayerIdentity {
  const keys = privateKeyHex
    ? { privateKey: privateKeyHex, publicKey: publicKeyFromPrivate(privateKeyHex) }
    : generateKeyPair();
  return {
    playerId: 'player-' + keys.publicKey.slice(2, 10),
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    revAddress: revAddressFromPublicKey(keys.publicKey),
  };
}

export function isValidPrivateKey(hex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  try { publicKeyFromPrivate(hex); return true; } catch { return false; }
}

export function serializeIdentity(identity: PlayerIdentity): string {
  return JSON.stringify(identity);
}

export function deserializeIdentity(json: string): PlayerIdentity {
  const parsed = JSON.parse(json);
  if (!parsed.privateKey || !parsed.publicKey || !parsed.revAddress)
    throw new Error('Invalid serialized identity');
  return parsed as PlayerIdentity;
}
