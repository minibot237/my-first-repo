# Email Ingest — Initial Findings

First batch run: 2026-03-10, 1521 .eml files across 4 accounts.

## Results

- **1521/1521 parsed successfully** — zero failures
- 771 gmail, 538 iconq (heavy spam), 196 brewmium, 16 thisoldtoledohouse

## Content Profile

| Metric | Count |
|--------|-------|
| markup (HTML) | 1491 |
| mixed (HTML + attachments) | 23 |
| text only | 7 |
| Text bodies | 1453 |
| HTML bodies | 1510 |
| Attachments | 38 |
| Links extracted | 20,227 |
| Images extracted | 19,787 |

## Auth

| Check | Pass |
|-------|------|
| SPF | 1502 |
| DKIM | 1486 |
| DMARC | 1493 |
| No auth at all | 16 |

The 16 no-auth emails are all from thisoldtoledohouse.com (HostGator). HostGator doesn't stamp Authentication-Results headers — the DKIM signatures exist in the raw headers but are unverified by the receiving server.

## Header Anomalies

| Signal | Count | Notes |
|--------|-------|-------|
| from_returnpath_mismatch | 563 | Many are ESPs not yet whitelisted. Known ESPs (sparkpost, sendgrid, mailchimp, beehiiv, convertkit, etc.) are already filtered. |
| replyto_domain_mismatch | 418 | Common newsletter pattern — send from marketing domain, reply-to goes to a different domain. May not be a true anomaly for newsletters. |

## Known Issues / Future Work

- **ESP whitelist incomplete** — 563 return-path mismatches means more ESPs to identify. Low priority — these get flagged but don't block anything.
- **Reply-to mismatch is noisy** — newsletters legitimately use different reply-to domains. Consider: flag only when reply-to domain has no relationship to from domain (not just different).
- **No auth ≠ no DKIM** — DKIM-Signature headers may be present without Authentication-Results. Future: verify DKIM ourselves when the receiving server didn't.
- **HTML conversion is basic** — regex-based tag stripping. Works for current corpus but will miss edge cases. Acceptable for V1.
- **Link context extraction** — pulls 100 chars before/after from raw HTML, then strips tags. Context quality varies. Good enough for canary evaluation.
