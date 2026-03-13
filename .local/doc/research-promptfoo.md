# Research: Promptfoo Red Teaming & Eval Architecture

Source: `~/projects/security-threats/promptfoo` (cloned 2026-03-12)

## What It Is

Promptfoo is a **testing framework** for LLM applications — it generates adversarial inputs and grades whether the target model was vulnerable. This is fundamentally different from our canary pipeline (a **runtime classifier** scanning inbound content). Different problem, different architecture.

## Their Architecture

- **Plugin system**: ~100+ specialized red team plugins (harmful content, injection, access control, PII, financial abuse, medical, etc.)
- **Strategy layer**: Adversarial prompt generation — iterative jailbreaking, encoding attacks (base64, ROT13, leetspeak, homoglyphs), crescendo escalation, multi-modal
- **Grading**: LLM-as-judge with context-aware rubrics. Every grader references the system's stated **purpose** to decide what's a vulnerability vs. authorized behavior
- **Risk scoring**: `impact x exploitability x humanFactor x strategyWeight` → 0-100 score with critical/high/medium/low/informational levels

## Key Design Patterns

### Context-Aware Rubrics
All graders reference the system's purpose — "what is this model supposed to do?" A shell command in output is only a vulnerability if the system isn't supposed to execute shell commands. This is more nuanced than pattern matching.

### Indirect Prompt Injection (Most Relevant to Us)
`src/redteam/plugins/indirectPromptInjection.ts` — evaluates whether the model obeys instructions injected into user data (not the system prompt). This is exactly our threat model (emails/web pages trying to hijack CORE). Their grader checks: "did the model follow injected instructions instead of original ones?"

### No Regex Pre-Filter
They don't pattern-match to detect injections — LLM-as-judge for everything. Makes sense for a test framework (nuance matters), but for runtime classification at volume, our hybrid approach (code tools -> pre-filter -> LLM) is the right call.

### Datamarking Defense
Their indirect injection plugin suggests inserting delimiter tokens between words in user data to help the model distinguish data from instructions. Could apply to how we format content for the canary — more aggressive delimiting of email content.

### Jailbreak Dataset
`src/redteam/strategies/promptInjections/data.ts` — ~30 hardcoded jailbreak templates (role-playing, authority-based, instruction override, encoding tricks). Useful reference for expanding our synthetic test payloads.

## What We Can Learn From

1. **Purpose-aware classification** — Our canary prompt could be more explicit about CORE's actual capabilities. If CORE can't execute shell commands, shell injection in an email is noise. (V2 thought — ties into agent-capabilities.md)
2. **Indirect injection framing** — Reframe our canary prompt around "is this content trying to command an AI?" rather than generic "is this safe?" (We already partially do this)
3. **Datamarking** — Delimiter tokens in the content we send to canary LLM, so the model knows what's DATA vs. framing
4. **Their risk scoring dimensions** — Impact, exploitability, human factor. More sophisticated than our two-score system but designed for vulnerability reports, not trust deltas

## What Doesn't Apply

- Their test generation (we're classifying inbound content, not generating attacks)
- Their multi-turn strategies (our canary is single-shot classification)
- Their grading architecture (plugin per vulnerability type — we need one fast classifier, not 100 specialized judges)
- Their risk scoring model directly (different output: vulnerability report vs. trust delta)

## Key Files for Reference

- `src/redteam/plugins/base.ts` — Plugin/grader base classes, rubric rendering
- `src/redteam/plugins/indirectPromptInjection.ts` — Most relevant to our threat model
- `src/redteam/strategies/promptInjections/data.ts` — Jailbreak template dataset
- `src/redteam/riskScoring.ts` — Risk scoring model
- `src/assertions/redteam.ts` — Integration with evaluation loop
