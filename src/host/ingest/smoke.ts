/**
 * Smoke test — parse a real .eml and dump the ContentEnvelope.
 * Usage: node dist/host/ingest/smoke.js [path-to-eml]
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ingestEmail } from "./email.js";

const TEST_DIR = join(process.env.HOME ?? "", "Documents/test-emails");

async function main() {
  const emlPath = process.argv[2];

  if (emlPath) {
    // Parse a specific file
    await parseAndDump(emlPath);
    return;
  }

  // Pick a few diverse samples from each account
  const accounts = await readdir(TEST_DIR);
  for (const account of accounts) {
    const dir = join(TEST_DIR, account);
    let files: string[];
    try {
      files = (await readdir(dir)).filter(f => f.endsWith(".eml"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    // First file from each account
    const sample = files[0];
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Account: ${account} (${files.length} emails)`);
    console.log(`Sample:  ${sample}`);
    console.log("=".repeat(80));
    await parseAndDump(join(dir, sample));
  }
}

async function parseAndDump(path: string) {
  try {
    const envelope = await ingestEmail(path);
    const content = envelope.content as any;

    console.log(`\nID:        ${envelope.id}`);
    console.log(`Source:    ${envelope.source}`);
    console.log(`SourceId:  ${envelope.sourceId}`);
    console.log(`SourceFit: ${envelope.sourceFit}`);
    console.log(`Type:      ${envelope.type}`);
    console.log(`Ingested:  ${envelope.ingestedAt}`);

    console.log(`\n--- Envelope ---`);
    console.log(`From:      ${content.envelope.from.name} <${content.envelope.from.address}>`);
    console.log(`To:        ${content.envelope.to.map((a: any) => a.address).join(", ")}`);
    console.log(`Subject:   ${content.envelope.subject}`);
    console.log(`Date:      ${content.envelope.date}`);
    console.log(`MessageId: ${content.envelope.messageId}`);
    console.log(`ReplyTo:   ${content.envelope.replyTo ?? "(none)"}`);
    console.log(`ReturnPth: ${content.envelope.returnPath ?? "(none)"}`);
    console.log(`SPF:       ${content.envelope.auth.spf}`);
    console.log(`DKIM:      ${content.envelope.auth.dkim}`);
    console.log(`DMARC:     ${content.envelope.auth.dmarc}`);
    console.log(`Received:  ${content.envelope.receivedChain.length} hops`);

    console.log(`\n--- Parts (${content.parts.length}) ---`);
    for (const part of content.parts) {
      if (part.type === "text") {
        console.log(`  [text] ${part.content.length} chars`);
        console.log(`         "${part.content.slice(0, 120)}..."`);
      } else if (part.type === "html_converted") {
        console.log(`  [html] ${part.content.length} chars, ${part.links.length} links, ${part.images.length} images`);
        console.log(`         "${part.content.slice(0, 120)}..."`);
        if (part.links.length > 0) {
          console.log(`         First link: "${part.links[0].text}" -> ${part.links[0].href}`);
        }
      } else if (part.type === "attachment") {
        console.log(`  [att]  ${part.filename} (${part.mimeType}, ${part.size} bytes)`);
      } else if (part.type === "header_anomaly") {
        console.log(`  [!!]   ${part.signal}: ${part.name} = ${part.value}`);
      }
    }

    console.log(`\n--- Raw Headers: ${content.rawHeaders.length} ---`);
  } catch (err) {
    console.error(`FAILED: ${err}`);
  }
}

main();
