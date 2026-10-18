<div align="center">

# 📊 claude-usage

**See what every prompt costs you in Claude Code: tokens, models and subagents, live.**

`usage-panel` is a Claude Code mod: a live **Usage** pane beside the conversation and a one-line band above the prompt input.

![version](https://img.shields.io/badge/version-0.9.0-7F77DD) ![Claude Code](https://img.shields.io/badge/Claude%20Code-mod-D97757) ![surfaces](https://img.shields.io/badge/desktop%20%2B%20terminal-supported-1D9E75) ![license](https://img.shields.io/badge/license-MIT-888780)

</div>

---

## ⚡ Install

On each device, in any shell:

```bash
gh api repos/jamesnguyen1309/claude-usage/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

Then start a new Claude Code session: the Usage pane opens on its own.

<details>
<summary>Other ways to install</summary>

**Two commands, no script:**

```bash
claude plugin marketplace add jamesnguyen1309/claude-usage
claude plugin install usage-panel@claude-usage --scope user
```

**From inside a terminal `claude` session:**

```
/plugin install usage-panel --marketplace jamesnguyen1309/claude-usage
```

Answer `y` to add the marketplace, then pick the **user** scope.

**Only for one project:** run the script with `SCOPE=project` (shared through the project's `.claude/settings.json`) or `SCOPE=local` (just you).

</details>

## ✨ What you get

### Above the prompt input

One line for the prompt in progress (or the last one):

| | |
| --- | --- |
| **Model** | the main model as a chip, with its full id (`claude-opus-5-5`), plus a chip for each other model its subagents used |
| **Tokens** | the prompt's total across the main conversation and every subagent, and how many were output |
| **Time · cost** | how long it has run, and what it cost |
| **Usage** | a button that shows or hides the pane |

### The Usage pane

| Section | Shows |
| --- | --- |
| **Statistics** | when your tokens next reload (a countdown to the soonest rate-limit reset, and which window it is), model calls and tool calls across the conversation (main and subagents), prompts sent, session cost, context window fill, and the 5-hour and 7-day limits with when each resets; meters turn amber at 70% and red at 90% |
| **This prompt** | total tokens, then figures for input, output, cache reads, cache writes, the cache hit rate and tokens per call; each model that worked on it: name, id, calls, tokens, its share of the prompt's tokens, and whether it ran the main conversation or subagents |
| **Subagents** | each subagent the prompt started, nested under the one that started it, with live status, model, time, calls, tools and tokens |
| **Burn rate** | for the 5-hour and 7-day limits: how fast each is being used (% per hour, % per day), and where that pace leads: *Hits 100% at 14:52, 1h 22m before it reloads* in red, or *On pace for 71% when it reloads* otherwise. A small chart shows the window so far, solid, and the pace carried on to the reload, dashed. Readings are kept across sessions, since the limits are your account's. |
| **Context** | **Export context** writes the conversation, as the context window holds it, to a Markdown file in `~/.claude/context-exports/<project>/`: every message, and each tool call with its input and result (a tool's input or result over 8,000 characters is cut). The newest exports are listed with an **Import** button, which adds that export to this session's context as a note Claude reads with your next prompt. An import takes at most 60% of the free context window; a bigger one keeps its newest part. |

While Claude works, a little animated Claude (the orange pixel crab, stepping and waving) marks what is running: the prompt card, each subagent and the band. The desktop app draws cards, bars and chips; a terminal gets the same figures as text. `/usage-panel` shows or hides the pane.

## 🔄 Update · remove

```bash
# after a new version is pushed (the install script does this too)
claude plugin marketplace update claude-usage && claude plugin update usage-panel@claude-usage

# remove
claude plugin uninstall usage-panel@claude-usage
```

Start a new session afterwards for the change to load.

## 📐 How the figures are counted

- **Tokens** come from each model call's usage as the API reports it, main conversation and subagents together. Cache reads usually dominate: each call re-reads the conversation from cache, at a fraction of the price of fresh input.
- **Cost** is Claude Code's own ledger, the one `/cost` totals. A prompt's cost is how much the session's total grew while it ran, subagents included; subagents show tokens, not dollars.
- **Per session:** each session shows only its own prompts. Nothing leaves your machine.
- Prompts sent before the mod loaded are listed once the conversation has drawn them, without figures.
- The list doesn't jump to a prompt in the conversation: the desktop app doesn't let mods scroll its conversation (Claude Code answers *transcript not scrollable here*).

## 🛠 Develop

```bash
claude plugin validate .   # manifest, marketplace and hooks module
claude plugin test .       # behaviour tests, terminal and desktop
claude --plugin-dir .      # run a session with this working copy
```

| File | Role |
| --- | --- |
| `hooks/register.tsx` | the hooks: bookkeeping, the pane, the band, the terminal views |
| `hooks/draw.ts` | the desktop drawings (SVG) |
| `types/index.d.ts` | the state contract |
| `tests/usage-panel.test.ts` | behaviour tests |
| `install.sh` | installs or updates the mod on a device |
| `.claude-plugin/` | the mod's manifest and the marketplace that lists it |

To release: bump `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, push, then update on each device.
