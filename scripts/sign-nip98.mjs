#!/usr/bin/env node
// Sign a NIP-98 Authorization header for testing creator-delete endpoints.
// Usage: node scripts/sign-nip98.mjs --nsec <hex> --url <url> --method <POST|GET>
// Output: the full "Nostr <base64>" header value, ready to paste into curl -H "Authorization: ..."

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';

function getArg(argv, name) {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : null;
}

export function signNip98Header(sk, url, method = 'POST') {
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method.toUpperCase()]],
    content: ''
  }, sk);

  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

export function runCli(argv = process.argv.slice(2), processLike = process) {
  let sk;
  const nsecHex = getArg(argv, 'nsec');
  if (nsecHex) {
    sk = hexToBytes(nsecHex);
  } else {
    sk = generateSecretKey();
    processLike.stderr.write(`No --nsec provided. Generated ephemeral key. Pubkey: ${getPublicKey(sk)}\n`);
  }

  const url = getArg(argv, 'url');
  const method = (getArg(argv, 'method') || 'POST').toUpperCase();

  if (!url) {
    processLike.stderr.write('Usage: node scripts/sign-nip98.mjs --nsec <hex> --url <url> [--method POST]\n');
    return 1;
  }

  const header = signNip98Header(sk, url, method);
  processLike.stdout.write(`${header}\n`);
  processLike.stderr.write(`Pubkey: ${getPublicKey(sk)}\n`);
  processLike.stderr.write(`URL: ${url}\n`);
  processLike.stderr.write(`Method: ${method}\n`);
  const eventJson = Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8');
  const event = JSON.parse(eventJson);
  processLike.stderr.write(`Event ID: ${event.id}\n`);
  return 0;
}

const isCliEntrypoint = (() => {
  try {
    return import.meta.url === new URL(process.argv[1], 'file:').href;
  } catch {
    return false;
  }
})();

if (isCliEntrypoint) {
  const code = runCli();
  process.exit(code);
}
