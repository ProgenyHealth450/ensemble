# Ensemble Plugins — Team Setup

Install the Ensemble plugins and keep them current. Everything installs from
`ProgenyHealth450/ensemble`, ref `stable`.

Run the `claude ...` commands below at a **PowerShell** prompt — including the integrated
terminal in Visual Studio or VS Code. `/ensemble:reinstall-plugins` is different: it is a
slash command, typed inside a running Claude Code session. You can also run any of the
terminal commands from inside a session by prefixing it with `!`.

## Install

### 1. Add the marketplace

```
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

```
claude plugin marketplace list
#   ❯ ensemble
#     Source: Git (https://github.com/ProgenyHealth450/ensemble.git@stable)
```

### 2. Install the plugins

```
claude plugin install ensemble-core@ensemble
claude plugin install ensemble-development@ensemble
claude plugin install ensemble-product@ensemble
claude plugin install ensemble-quality@ensemble
claude plugin install ensemble-git@ensemble
claude plugin install ensemble-dotnet@ensemble
claude plugin install ensemble-xunit@ensemble
claude plugin install ensemble-blazor@ensemble
claude plugin install ensemble-e2e-testing@ensemble
```

These install at **user scope**, so they are available in every repo you open on this
machine. There is nothing to install per project.

27 plugins are available. Add others as you need them — `ensemble-infrastructure`,
`ensemble-metrics`, `ensemble-ai`, `ensemble-router`, `ensemble-permitter`, and
framework packs for React, Rails, Phoenix, NestJS, Jest, pytest, RSpec and ExUnit.

### 3. Restart Claude Code

Plugins are only picked up when a session starts — an already-running one will not see
them. In PowerShell that means exiting and running `claude` again (`claude --continue`
counts, it re-runs discovery). In Visual Studio or VS Code, start a new Claude session.

## What follows you, and what doesn't

Plugins install per user, so the same set is active in **every repo you open and on every
surface** — Claude CLI in PowerShell, Visual Studio, and VS Code all read the same
`~/.claude`. Install once per machine.

Instructions do not work that way. Most repos carry their own `CLAUDE.md`, and there is a
user-level `~/.claude/CLAUDE.md` on top of it. So Claude can behave quite differently in
two repos while running identical plugins — that difference is the repo's `CLAUDE.md`,
not your install.

## Update

```
claude plugin marketplace update ensemble
```

Then inside Claude Code:

```
/ensemble:reinstall-plugins
```

Then restart.

Do not use `claude plugin update` — it reports success and does nothing when the
marketplace content changed but the plugin's version number did not.

## Cleanup: check your install scope

A project-scoped copy shadows the user-scoped one, drifts on its own, and is skipped by
`/ensemble:reinstall-plugins`. Everything should be user scope.

**In the repo you are sitting in:**

```
claude plugin list
```

Every plugin should read `Scope: user`.

**Across every repo at once.** A project install only shows up in its own repo, so the
command above can miss one you set up months ago somewhere else:

```powershell
$reg = "$env:USERPROFILE\.claude\plugins\installed_plugins.json"
$bad = (Get-Content $reg -Raw | ConvertFrom-Json).plugins.PSObject.Properties |
  ForEach-Object { $n = $_.Name; $_.Value | Where-Object { $_.scope -ne 'user' } |
  ForEach-Object { "$n  ($($_.scope) scope)" } }
if ($bad) { $bad } else { "All installs are user scope." }
```

**If it lists anything**, for each plugin it named:

1. `cd` to the repo that install belongs to.
2. Remove it, using the scope the check reported:
   ```
   claude plugin uninstall <plugin>@ensemble -s project
   ```
   (`-s local` if the check said `local`.)
3. Run the check again. If the plugin has now disappeared entirely, it only ever existed
   at project scope — reinstall it:
   ```
   claude plugin install <plugin>@ensemble
   ```
   User is the default. Do not pass `-s`.
4. Restart Claude Code.

**Do not run the uninstall speculatively.** `uninstall -s project` fails when there is no
project install to remove, but a paired `install -s project` will cheerfully create one
where none existed. Only touch the plugins the check actually named, and never pass
`-s project` to `install`.

## Don't

**Don't install `ensemble-full`.** It installs successfully but its skills and library
code arrive as unusable placeholder files on Windows. Install the individual plugins
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
