#!/usr/bin/env node
// Sign a NIP-98 Authorization header for testing creator-delete endpoints.
// Usage: node scripts/sign-nip98.mjs --nsec <hex> --url <url> --method <POST|GET>
// Output: the full "Nostr <base64>" header value, ready to paste into curl -H "Authorization: ..."

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

let sk;
const nsecHex = getArg('nsec');
if (nsecHex) {
  sk = hexToBytes(nsecHex);
} else {
  sk = generateSecretKey();
  console.error(`No --nsec provided. Generated ephemeral key. Pubkey: ${getPublicKey(sk)}`);
}

const url = getArg('url');
const method = (getArg('method') || 'POST').toUpperCase();

if (!url) {
  console.error('Usage: node scripts/sign-nip98.mjs --nsec <hex> --url <url> [--method POST]');
  process.exit(1);
}

const event = finalizeEvent({
  kind: 27235,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['u', url], ['method', method]],
  content: ''
}, sk);

const encoded = Buffer.from(JSON.stringify(event)).toString('base64');
const header = `Nostr ${encoded}`;

// Print just the header value (for use in curl -H "Authorization: <output>")
console.log(header);

// Metadata to stderr so it doesn't pollute the header output
console.error(`Pubkey: ${getPublicKey(sk)}`);
console.error(`URL: ${url}`);
console.error(`Method: ${method}`);
console.error(`Event ID: ${event.id}`);
