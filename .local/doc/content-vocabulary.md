# Content Vocabulary Specification

The JSON vocabulary for content ingestion, evaluation, and trust tracking in minibot.

All content — email, web, generated — flows through a common structure before reaching the canary pipeline or core agent. This spec defines that structure.

---

## Top-Level Envelope

Every piece of content gets wrapped in a provenance envelope:

```json
{
  "id": "string (uuid)",
  "source": "email" | "web" | "generated",
  "sourceId": "string (sender address, domain, session id)",
  "sourceFit": 0.0-1.0,
  "type": "text" | "code" | "markup" | "data" | "mixed",
  "ingestedAt": "ISO 8601 local timestamp",
  "content": { ... }
}
```

### Fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for this content item |
| `source` | Origin class: `email`, `web`, or `generated` |
| `sourceId` | Identity of the origin — used to look up `sourceFit` from the trust store |
| `sourceFit` | The trust store's current `fit_value` for this source. Looked up at ingestion time, not computed per-item |
| `type` | What kind of content this is (affects how canary evaluates it) |
| `ingestedAt` | When the content entered the system |
| `content` | Source-specific structured content (see below) |

### Source Types

- **`email`** — Inbound email. `sourceId` is the sender address (e.g. `alice@example.com`)
- **`web`** — Fetched from a URL. `sourceId` is the domain (e.g. `craigslist.org`)
- **`generated`** — Produced by the agent. `sourceId` is the session that produced it. `sourceFit` inherits from the inputs — a summary of a trusted email inherits that trust; a summary of hackme.com doesn't

### Content Types

- **`text`** — Natural language, prose, message bodies
- **`code`** — Source code, scripts, config files
- **`markup`** — HTML, XML, structured documents (pre-conversion)
- **`data`** — JSON, CSV, structured data
- **`mixed`** — Contains multiple types (e.g. email with text body + code attachment)

---

## Email Content

```json
{
  "type": "email",
  "envelope": {
    "from": { "name": "string", "address": "string" },
    "to": [{ "name": "string", "address": "string" }],
    "cc": [{ "name": "string", "address": "string" }],
    "subject": "string",
    "date": "ISO 8601",
    "messageId": "string",
    "inReplyTo": "string | null",
    "replyTo": "string | null",
    "returnPath": "string | null",
    "receivedChain": [
      { "from": "string", "by": "string", "timestamp": "string" }
    ],
    "auth": {
      "spf": "pass" | "fail" | "softfail" | "none",
      "dkim": "pass" | "fail" | "none",
      "dmarc": "pass" | "fail" | "none"
    }
  },
  "parts": [ ... ],
  "rawHeaders": [
    { "name": "string", "value": "string" }
  ]
}
```

### Envelope

The envelope captures the metadata the code-based classifiers need. `auth` results are extracted from headers during ingestion — they're deterministic signals that inform `sourceFit` directly.

`rawHeaders` is the full header set, preserved for audit and for code tools that need to inspect unusual headers. Not sent to the LLM.

### Parts

Typed content blocks extracted from the email body:

```json
{ "type": "text", "content": "string" }
```
Plain text body.

```json
{ "type": "html_converted", "content": "string", "links": [ ... ], "images": [ ... ] }
```
HTML body converted to structured text. Links and images extracted as separate entries for independent evaluation.

```json
{ "type": "link", "href": "string", "text": "string", "context": "string" }
```
Individual link. `text` is the display text, `href` is the actual URL, `context` is the surrounding sentence/paragraph. Mismatch between `text` and `href` is a signal.

```json
{ "type": "image", "src": "string", "alt": "string", "context": "string" }
```
Image reference. `alt` text can carry injection. `src` domain can carry reputation signal.

```json
{ "type": "attachment", "filename": "string", "mimeType": "string", "size": "number" }
```
Attachment metadata only — content is not inline. Dangerous mime types, double extensions, unexpected sizes are code-level signals.

```json
{ "type": "header_anomaly", "name": "string", "value": "string", "signal": "string" }
```
Headers that code-based tools flag as interesting. `signal` describes what's unusual (e.g. `"from_returnpath_mismatch"`, `"unusual_x_header"`, `"forged_received"`).

---

## Web Content

```json
{
  "type": "web",
  "url": "string (requested URL)",
  "finalUrl": "string (after redirects)",
  "title": "string",
  "fetchedAt": "ISO 8601",
  "redirectChain": ["string"],
  "tls": {
    "valid": true | false,
    "issuer": "string",
    "expires": "ISO 8601"
  },
  "parts": [ ... ],
  "meta": [ ... ]
}
```

### Web-specific parts

Same `text`, `html_converted`, `link`, `image` types as email, plus:

```json
{ "type": "meta", "name": "string", "content": "string" }
```
OpenGraph tags, meta descriptions, other head metadata. Can carry injection or misleading signals.

```json
{ "type": "form", "action": "string", "method": "string", "fields": [
  { "name": "string", "type": "string", "label": "string" }
]}
```
Forms on the page. Login forms on unexpected domains, hidden fields, credential-harvesting patterns — all code-level signals.

```json
{ "type": "script_detected", "context": "string" }
```
Inline scripts found during conversion. Not the script content itself — just a flag that scripts exist, with context about where they appeared. The presence of unexpected scripts is a signal.

---

## Generated Content

```json
{
  "type": "generated",
  "sessionId": "string",
  "sessionType": "core" | "coder" | "canary",
  "inputRefs": ["string (content ids of inputs)"],
  "parts": [ ... ]
}
```

Generated content links back to its inputs via `inputRefs`. `sourceFit` is derived from the lowest `sourceFit` of the referenced inputs — trust doesn't increase through transformation.

---

## Canary Tool Contracts

The canary pipeline has two layers: **code tools** (deterministic, fast) and **LLM evaluation** (probabilistic, slower). Code tools run first and produce signals. Signals travel with the content to the LLM.

### Code Tools

#### `evaluateEnvelope(envelope) -> EnvelopeSignals`

Deterministic checks on email metadata:

```json
{
  "authScore": 0.0-1.0,
  "signals": [
    { "signal": "spf_fail", "severity": "high" },
    { "signal": "from_returnpath_mismatch", "severity": "medium" },
    { "signal": "recent_domain", "severity": "low", "detail": "domain registered 3 days ago" }
  ],
  "sourceFitDelta": -0.15 to +0.05
}
```

`authScore` summarizes the auth results. `signals` are individual findings. `sourceFitDelta` is the recommended trust adjustment for the source — clamped to `MAX_DELTA` (0.15), applied after evaluation.

#### `evaluateLinks(links[]) -> LinkSignals`

```json
{
  "signals": [
    { "signal": "display_href_mismatch", "severity": "high", "link": { ... } },
    { "signal": "redirect_chain", "severity": "medium", "link": { ... } },
    { "signal": "known_phishing_domain", "severity": "critical", "link": { ... } }
  ]
}
```

URL reputation, redirect detection, display/href mismatch, homograph detection.

#### `evaluateAttachments(attachments[]) -> AttachmentSignals`

```json
{
  "signals": [
    { "signal": "double_extension", "severity": "high", "filename": "invoice.pdf.exe" },
    { "signal": "dangerous_mimetype", "severity": "high", "mimeType": "application/x-msdownload" }
  ]
}
```

#### `evaluateWebMeta(webContent) -> WebSignals`

```json
{
  "signals": [
    { "signal": "url_redirect_mismatch", "severity": "medium", "url": "...", "finalUrl": "..." },
    { "signal": "tls_invalid", "severity": "high" },
    { "signal": "credential_form_detected", "severity": "medium" },
    { "signal": "scripts_detected", "severity": "low", "count": 5 }
  ]
}
```

### LLM Preparation

#### `prepareForLlm(parts[], codeSignals) -> LlmPayload`

Assembles the canary LLM's input. The LLM sees:

```json
{
  "codeSignals": [ ... ],
  "contentBlocks": [
    { "type": "text", "content": "..." },
    { "type": "link", "href": "...", "text": "...", "context": "..." }
  ]
}
```

#### Signal filtering

`formatForCanary()` only passes **high/critical** code signals to the LLM. Low/medium signals (return-path mismatches, reply-to domains, etc.) are metadata concerns already handled by code tools. Passing them to a small model biases it toward "unsafe" before it reads the content — the canary was treating noisy metadata as evidence of a threat.

The LLM's job is narrow: detect prompt injection in the content body. Code tools handle metadata.

### Content Cleaning

Before chunking, content passes through `cleanContent()` to remove noise that confuses the small model. All cleaning is configurable via `CANARY_CONFIG`:

| Step | Config flag | What it does |
|------|------------|-------------|
| Strip URLs | `stripUrls` | Remove `http(s)://...` — links already evaluated by code tools |
| Strip HTML entities | `stripHtmlEntities` | Remove `&#NNN;`, `&name;` — rendering artifacts |
| Collapse whitespace | `collapseWhitespace` | Horizontal runs → single space, 3+ newlines → 2, trim per line |

Real-world reductions: 40–70% for marketing emails (mostly tracking URLs and entity noise).

### Content Chunking

Large content is split into chunks for LLM evaluation. Range-based balanced splitting ensures no runt final chunks.

**Algorithm:**
1. If content ≤ `chunkMax`, evaluate as single chunk
2. Calculate N chunks so each falls within `[chunkMin, chunkMax]`
3. Find break points: prefer period+whitespace (sentence boundary) within `maxChunkExpansion` past target, fall back to last space, then hard cut
4. Apply overlap between chunks if configured
5. Safety cap at `maxChunks`

**Config (`CANARY_CONFIG`):**

```typescript
chunkMin: 8000,            // target minimum chars per chunk
chunkMax: 10000,           // target maximum chars per chunk
maxChunkExpansion: 500,    // search window past chunkMax for sentence break
overlapSize: 0,            // overlap between consecutive chunks
maxChunks: 10,             // safety cap
```

**Aggregation:** Worst verdict wins across chunks. Any chunk flagged → whole content flagged. Fit score = minimum across chunks.

### Prompt Files

System and user prompts live in `src/host/canary/prompts/` as editable text files:

| File | Purpose |
|------|---------|
| `system.txt` | Default system prompt (fallback) |
| `system-{type}.txt` | Per-content-type prompt (e.g., `system-email.txt`) |
| `user.txt` | User message template — `{{content}}` placeholder |
| `response-format.txt` | Shared JSON verdict schema — injected via `{{response_format}}` |

`getSystemPrompt(contentType)` resolves `system-{type}.txt` with fallback to `system.txt`, substituting `{{response_format}}` from the shared file. The pipeline passes `envelope.content.type` automatically.

### LLM Threat Model

The canary LLM's sole concern is **prompt injection** — content that tries to manipulate an AI system. It does NOT evaluate spam, phishing, or social engineering targeting humans. Those are downstream routing concerns (deciding what to surface to the user), not canary concerns.

**Flags (AI-targeted threats only):**
- Instruction overrides targeting an AI/LLM
- Delimiter/tag escape attempts
- Encoded payloads targeting AI safety filters
- System prompt extraction requests
- Multi-step manipulation building toward injection

**Not threats (normal content):**
- Marketing, CTAs, promotional urgency
- Tracking links, ESP redirects, UTM parameters
- News alerts, security notifications, transactional emails
- Human-targeted persuasion (ads, spam, phishing)

The decision question: "Is this text trying to command an AI?" If no, it is safe.

#### Prompt design for small models

The canary runs on Qwen 2.5 3B. Key lesson from tuning: **negative instructions become detection checklists.** Telling the model "do NOT flag marketing language" causes it to pattern-match on "marketing language" and flag it. Positive framing works: "Normal human-to-human content is SAFE, even if it contains sales or promotional language." And a single clear decision heuristic ("Is this trying to command an AI?") outperforms an enumerated threat list.

### LLM Call & Metrics

`callCanaryLlm()` fetches directly from Ollama's OpenAI-compatible endpoint with streaming token capture (`stream_options: { include_usage: true }`).

Per-chunk metrics captured:

| Metric | Description |
|--------|-------------|
| `contentChars` / `contentTokens` | Content in this chunk |
| `overheadChars` / `overheadTokens` | System prompt + user message framing |
| `outputChars` / `outputTokens` | LLM response |
| `ttftMs` | Time to first token |
| `genMs` | Generation time (total − ttft) |
| `totalMs` | Wall clock for this chunk |

Aggregated into `EvalMetrics` with a `chunks: ChunkMetrics[]` breakdown.

### LLM Evaluation Output

The canary LLM returns a verdict (same schema as our existing `EvaluationResult`):

```json
{
  "fitScore": 0.0-0.9,
  "observationScore": 0.0-1.0,
  "verdict": {
    "safe": true | false,
    "confidence": 0.0-1.0,
    "reasoning": "string",
    "flags": ["instructions_directed_at_ai", "delimiter_escape", ...]
  }
}
```

`fitScore` capped at 0.9 — only cryptographic verification reaches 1.0.

### Smoke Tests

- **`smoke.ts`** — Synthetic payloads (injections + benign content). Regex layer + full LLM evaluation.
- **`smoke-emails.ts`** — Real `.eml` files through the full pipeline. Rolling log at `logs/smoke-emails.log` with boxed header/footer per run, config snapshot, per-chunk breakdown, and stats (throughput, latency percentiles, rate).
- **`smoke-streaming.ts`** — A/B test: streaming vs non-streaming overhead comparison.

---

## Trust Store Integration

### Source Seeding (Trust Store Responsibility)

When a source first appears, `DEFAULT_FIT = 0.5` is a fallback, not the goal. The trust store runs a **pre-classifier** before assigning the initial fit_value — code heuristics on source metadata, not content.

Pre-classifier signals by source type:

| Source type | Seeding signals |
|-------------|----------------|
| `email_domain` | Domain age, registrar reputation, MX config, DNSBL presence |
| `email_sender` | Inherits from domain, adjusted by sender-specific history |
| `web_domain` | WHOIS age, TLS history, redirect patterns, blacklist presence |
| `web_url` | Inherits from domain, adjusted by path-level signals |
| `repo` | Account age vs activity velocity, contributor patterns, engagement curve shape (star/download velocity anomalies) |
| `marketplace` | Publisher history, download curve authenticity, review patterns |

The pre-classifier produces an initial fit_value in the 0.0–0.5 range (never above 0.5 for a new source — trust is earned, not assumed). Sources with no external signals available start at 0.5.

**V3 direction:** The agent builds new pre-classifiers when it encounters source types without existing heuristics. These classifiers themselves carry fit_values — meta-trust. How good is this classifier at predicting source reliability?

This is entirely the trust store's concern. The content vocabulary just expects `sourceFit` to be populated by ingestion time.

### fit_value Lifecycle

1. **New source appears** — Trust store runs pre-classifier, sets initial fit_value (default 0.5 if no signals)
2. **Content ingested** — `sourceFit` looked up from trust store, attached to envelope
3. **Code tools run** — Produce `sourceFitDelta` recommendations
4. **Canary LLM evaluates** — Produces content `fitScore`
5. **Trust store updated** — `sourceFitDelta` applied, clamped to `MAX_DELTA` (0.15)
6. **Supervisor decides** — Uses `sourceFit` + content `fitScore` + code signals to route/present/reject

### Trust Update Rules

From the trust spec, adapted for minibot:

- **Explicit only** — No silent trust changes
- **Logged** — Every change recorded with timestamp, reason, content ID
- **Bounded** — Per-event delta clamped to MAX_DELTA (0.15)
- **Asymmetric** — Trust falls faster than it rises (failure: -0.10, success: +0.05)
- **No silent decay** — Trust doesn't erode without explicit events
- **Supervisor override** — Trust is advisory. The supervisor decides.

### Component Types

| Type | Scope | sourceId example |
|------|-------|-----------------|
| `email_sender` | Individual sender | `alice@example.com` |
| `email_domain` | Sender domain | `example.com` |
| `web_domain` | Website domain | `craigslist.org` |
| `session` | Agent session | `coder-abc123` |

### Special Values

| Value | Meaning |
|-------|---------|
| 0.0 | Blocklisted. Rejected by policy or repeated failure. Content still ingested but flagged. |
| 0.5 | Default. Unknown source, no history. |
| 0.9 | Maximum earned trust. Consistent good history. |
| 1.0 | Reserved. Cryptographic verification only. Not achievable through behavior. |

---

## Evolution

This vocabulary will grow as we add:
- Attachment content analysis (OCR, document parsing)
- Scrape builder tool definitions
- Scheduler integration for recurring fetches
- Trust inheritance rules for generated content chains
- Trust store spec (seeding, pre-classifiers, persistence, query interface)
- Agent-built pre-classifiers with meta-trust (V3)

Update this spec first, then update code. Changes without spec updates are incomplete.
