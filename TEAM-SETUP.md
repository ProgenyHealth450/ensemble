# Ensemble Plugins — Team Setup

Install the Ensemble plugins and keep them current. Everything installs from
`ProgenyHealth450/ensemble`, ref `stable`.

## Install

### 1. Add the marketplace

```bash
claude plugin marketplace add https://github.com/ProgenyHealth450/ensemble.git#stable
```

Only the `#stable` fragment form works:

| Form | Result |
|---|---|
| `...ensemble.git#stable` | works |
| `...ensemble.git@stable` | fails — read as part of the URL |
| `...ensemble.git` | fails — no ref, no manifest |
| `ProgenyHealth450/ensemble#stable` | works, but needs SSH keys |

Confirm:

```bash
claude plugin marketplace list
#   ❯ ensemble
#     Source: Git (https://github.com/ProgenyHealth450/ensemble.git@stable)
```

### 2. Install the plugins

```bash
for p in ensemble-core ensemble-development ensemble-product ensemble-quality ensemble-git \
         ensemble-dotnet ensemble-xunit ensemble-blazor ensemble-e2e-testing; do
  claude plugin install "$p@ensemble"
done
```

27 plugins are available. Add others as you need them — `ensemble-infrastructure`,
`ensemble-metrics`, `ensemble-ai`, `ensemble-router`, `ensemble-permitter`, and
framework packs for React, Rails, Phoenix, NestJS, Jest, pytest, RSpec and ExUnit.

### 3. Restart Claude Code

Plugins are only picked up at session startup. `--continue` re-runs discovery, so it
works; `--bare` does not.

## Update

```bash
claude plugin marketplace update ensemble
```

Then inside Claude Code:

```
/ensemble:reinstall-plugins
```

Then restart.

Do not use `claude plugin update` — it reports success and does nothing when the
marketplace content changed but the plugin's version number did not.

## Don't

**Don't install `ensemble-full` on Windows.** It installs successfully but its skills
and library code arrive as unusable placeholder files. Install the individual plugins
above.

**Don't install with `-s project`.** User scope already applies in every repo, and a
project copy drifts and gets missed by `/ensemble:reinstall-plugins`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Filename too long` while adding | `git config --global core.longpaths true` |
| Command or agent missing after an update | Restart the session |
| Not sure what you are running | `claude plugin marketplace list` and `claude plugin list` |

Every plugin should read `Scope: user` and end in `@ensemble`.

## Problems

Tell Mike. Fixes go upstream to
[Sunstone-Partners/ensemble](https://github.com/Sunstone-Partners/ensemble) rather than
into our mirror.
