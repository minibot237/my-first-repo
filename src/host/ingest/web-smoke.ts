/**
 * Web ingest smoke test — fetch URLs and dump ContentEnvelopes.
 * Usage: node dist/host/ingest/web-smoke.js [url]
 */

import { ingestWeb, detectScripts } from "./web.js";
import type { WebContent } from "./types.js";

const TEST_URLS = [
  "https://example.com",
  "https://www.duluthtrading.com/mens-flannel/",
  "https://news.ycombinator.com",
];

async function main() {
  const urls = process.argv[2] ? [process.argv[2]] : TEST_URLS;

  for (const url of urls) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`URL: ${url}`);
    console.log("=".repeat(80));

    try {
      const envelope = await ingestWeb(url);
      const content = envelope.content as WebContent;

      console.log(`\nID:        ${envelope.id}`);
      console.log(`Source:    ${envelope.source}`);
      console.log(`SourceId:  ${envelope.sourceId}`);
      console.log(`SourceFit: ${envelope.sourceFit}`);
      console.log(`Type:      ${envelope.type}`);
      console.log(`Ingested:  ${envelope.ingestedAt}`);

      console.log(`\n--- Web Info ---`);
      console.log(`Title:     ${content.title}`);
      console.log(`Final URL: ${content.finalUrl}`);
      console.log(`Redirects: ${content.redirectChain.length > 0 ? content.redirectChain.join(" -> ") : "(none)"}`);
      console.log(`TLS:       valid=${content.tls.valid} issuer="${content.tls.issuer}" expires="${content.tls.expires}"`);

      console.log(`\n--- Meta (${content.meta.length}) ---`);
      for (const m of content.meta.slice(0, 5)) {
        console.log(`  ${m.name}: ${m.content.slice(0, 80)}`);
      }
      if (content.meta.length > 5) console.log(`  ... and ${content.meta.length - 5} more`);

      console.log(`\n--- Parts (${content.parts.length}) ---`);
      for (const part of content.parts) {
        if (part.type === "text") {
          console.log(`  [text] ${part.content.length} chars`);
          console.log(`         "${part.content.slice(0, 120)}..."`);
        } else if (part.type === "link") {
          console.log(`  [link] "${part.text}" -> ${part.href.slice(0, 80)}`);
        } else if (part.type === "image") {
          console.log(`  [img]  alt="${part.alt}" src=${part.src.slice(0, 80)}`);
        } else if (part.type === "form") {
          console.log(`  [form] ${part.method} ${part.action} (${part.fields.length} fields)`);
          for (const f of part.fields) {
            console.log(`         ${f.type} name="${f.name}" label="${f.label}"`);
          }
        } else if (part.type === "script_detected") {
          console.log(`  [script] ${part.context}`);
        }
      }

      // Count summary
      const linkCount = content.parts.filter(p => p.type === "link").length;
      const imgCount = content.parts.filter(p => p.type === "image").length;
      const formCount = content.parts.filter(p => p.type === "form").length;
      console.log(`\n  Summary: ${linkCount} links, ${imgCount} images, ${formCount} forms`);

    } catch (err) {
      console.error(`FAILED: ${err}`);
    }
  }
}

main();
