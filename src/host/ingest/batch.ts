/**
 * Batch ingest — run all .eml files through the parser, report stats and failures.
 * Usage: node dist/host/ingest/batch.js [test-emails-dir]
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ingestEmail } from "./email.js";
import type { ContentEnvelope, EmailContent } from "./types.js";

const TEST_DIR = process.argv[2] ?? join(process.env.HOME ?? "", "Documents/test-emails");

interface Stats {
  total: number;
  success: number;
  failed: number;
  byType: Record<string, number>;
  byAuth: { spfPass: number; dkimPass: number; dmarcPass: number; noAuth: number };
  anomalies: Record<string, number>;
  failures: { file: string; error: string }[];
  partsStats: { text: number; html: number; attachments: number; links: number; images: number };
}

async function main() {
  const stats: Stats = {
    total: 0,
    success: 0,
    failed: 0,
    byType: {},
    byAuth: { spfPass: 0, dkimPass: 0, dmarcPass: 0, noAuth: 0 },
    anomalies: {},
    failures: [],
    partsStats: { text: 0, html: 0, attachments: 0, links: 0, images: 0 },
  };

  const accounts = await readdir(TEST_DIR);
  for (const account of accounts) {
    const dir = join(TEST_DIR, account);
    let files: string[];
    try {
      files = (await readdir(dir)).filter(f => f.endsWith(".eml"));
    } catch {
      continue;
    }

    console.log(`\n${account}: ${files.length} emails`);

    for (const file of files) {
      stats.total++;
      try {
        const envelope = await ingestEmail(join(dir, file));
        stats.success++;
        tally(stats, envelope);
      } catch (err: any) {
        stats.failed++;
        stats.failures.push({ file: `${account}/${file}`, error: err.message ?? String(err) });
      }
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`RESULTS`);
  console.log(`${"=".repeat(80)}`);
  console.log(`Total:   ${stats.total}`);
  console.log(`Success: ${stats.success}`);
  console.log(`Failed:  ${stats.failed}`);

  console.log(`\nContent types:`);
  for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log(`\nAuth:`);
  console.log(`  SPF pass:  ${stats.byAuth.spfPass}`);
  console.log(`  DKIM pass: ${stats.byAuth.dkimPass}`);
  console.log(`  DMARC pass: ${stats.byAuth.dmarcPass}`);
  console.log(`  No auth:   ${stats.byAuth.noAuth}`);

  console.log(`\nParts:`);
  console.log(`  Text bodies:  ${stats.partsStats.text}`);
  console.log(`  HTML bodies:  ${stats.partsStats.html}`);
  console.log(`  Attachments:  ${stats.partsStats.attachments}`);
  console.log(`  Links:        ${stats.partsStats.links}`);
  console.log(`  Images:       ${stats.partsStats.images}`);

  if (Object.keys(stats.anomalies).length > 0) {
    console.log(`\nHeader anomalies:`);
    for (const [signal, count] of Object.entries(stats.anomalies).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${signal}: ${count}`);
    }
  }

  if (stats.failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of stats.failures) {
      console.log(`  ${f.file}`);
      console.log(`    ${f.error}`);
    }
  }
}

function tally(stats: Stats, envelope: ContentEnvelope) {
  stats.byType[envelope.type] = (stats.byType[envelope.type] ?? 0) + 1;

  const content = envelope.content as EmailContent;
  const auth = content.envelope.auth;
  if (auth.spf === "pass") stats.byAuth.spfPass++;
  if (auth.dkim === "pass") stats.byAuth.dkimPass++;
  if (auth.dmarc === "pass") stats.byAuth.dmarcPass++;
  if (auth.spf === "none" && auth.dkim === "none" && auth.dmarc === "none") stats.byAuth.noAuth++;

  for (const part of content.parts) {
    if (part.type === "text") stats.partsStats.text++;
    if (part.type === "html_converted") {
      stats.partsStats.html++;
      stats.partsStats.links += part.links.length;
      stats.partsStats.images += part.images.length;
    }
    if (part.type === "attachment") stats.partsStats.attachments++;
    if (part.type === "header_anomaly") {
      stats.anomalies[part.signal] = (stats.anomalies[part.signal] ?? 0) + 1;
    }
  }
}

main();
