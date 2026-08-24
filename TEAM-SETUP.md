# Ensemble Plugins — Team Setup

How to install the Ensemble plugins and keep them current. Follow this rather than
improvising: two of the steps below have failure modes that look like success.

Everything here was verified on Windows against Claude Code's actual behaviour on
2026-08-24, not from documentation.

---

## Where the plugins come from

Install from **`ProgenyHealth450/ensemble`, ref `stable`** — a mirror of
[Sunstone-Partners/ensemble](https://github.com/Sunstone-Partners/ensemble) that only
advances past a Windows check. A daily job fast-forwards it and refuses to move `stable`
onto a commit that would not install on Windows. See [README.md](README.md) for how that
works.

Do **not** point at `Sunstone-Partners/ensemble` directly. It is where the code is
developed, so it takes upstream breakage the moment it merges — twice now that has meant
a repo Windows could not clone or a marketplace manifest Claude Code could not parse.
`stable` exists to absorb exactly that.

---

## One-time setup

### 1. Add the marketplace

```bash
claude plugin marketplace add https://github.com/ProgenyHealth450/ensemble.git#stable
```

The `#stable` fragment is required and is the only form that works. Two near-misses:

| What you might type | What happens |
|---|---|
| `...ensemble.git@stable` | Fails — `@stable` is read as part of the URL |
| `...ensemble.git` (no ref) | Fails — the default branch holds no marketplace manifest |
| `ProgenyHealth450/ensemble#stable` | Works, but resolves over **SSH**, so it needs SSH keys |

Confirm it landed:

```bash
claude plugin marketplace list
#   ❯ ensemble
#     Source: Git (https://github.com/ProgenyHealth450/ensemble.git@stable)
```

### 2. Install the plugins

ProgenyHealth is a .NET shop, so this is the set worth having. Everything is **user
scope**, which applies in every repo you open:

```bash
for p in ensemble-core ensemble-development ensemble-product ensemble-quality ensemble-git \
         ensemble-dotnet ensemble-xunit ensemble-blazor ensemble-reqnroll; do
  claude plugin install "$p@ensemble"
done
```

The marketplace offers 27 plugins. Add others as you need them —
`ensemble-e2e-testing`, `ensemble-infrastructure`, `ensemble-metrics`, `ensemble-ai`,
`ensemble-router`, `ensemble-permitter`, and framework packs for React, Rails, Phoenix,
NestJS, Jest, pytest, RSpec, ExUnit.

### 3. Restart Claude Code

Plugin and marketplace changes are picked up during session startup. A running session
will not see them. `--continue` re-runs discovery so it is fine; only `--bare` skips it.

---

## Keeping up to date

Two commands, then restart:

```bash
claude plugin marketplace update ensemble
```

...then inside Claude Code:

```
/ensemble:reinstall-plugins
```

**Why not `claude plugin update`?** It is version-gated. When the marketplace content
changes but a plugin's manifest version number does not, it reports success and does
nothing — you keep running the old copy while being told you are current. That silent
no-op is the single most common way people end up on stale plugins.
`/ensemble:reinstall-plugins` force-refreshes instead, which is why it exists.

---

## Two things that look like success but are not

### Do not add the `dev` marketplace

```bash
# DON'T
claude plugin marketplace add https://github.com/ProgenyHealth450/ensemble.git#dev
```

Both refs declare the same marketplace name (`ensemble`), so this **silently replaces**
your `stable` registration rather than adding a second one. It prints
`✔ Successfully added marketplace: ensemble` — no warning, no mention that `stable` is
gone. You would then be running in-flight, ungated code without knowing.

`dev` exists for deliberately dogfooding work that has not merged upstream yet. If you
need that, ask Mike rather than running the command.

### Do not install `ensemble-full` on Windows

`ensemble-full` is a bundle that pulls in everything at once, and it is assembled out of
**97 symbolic links** to the other packages. Git for Windows leaves `core.symlinks=false`
unless the installer's symlink option was ticked, and such a checkout turns every one of
those links into a small text file containing a path. The bundle installs and reports
success; its skills and library code are text files.

Install the individual plugins listed above instead. They contain real files.

---

## Troubleshooting

**`Filename too long` while adding the marketplace.** Windows' 260-character path limit.
Enable long paths:

```bash
git config --global core.longpaths true
```

Most people will not hit this — the marketplace cache sits at
`C:\Users\<you>\.claude\plugins\marketplaces\ensemble\` and the deepest file in the repo
is 96 characters, so there is normally plenty of headroom.

**A command or agent is missing after an update.** Restart the session — see step 3.

**Not sure what you are actually running.**

```bash
claude plugin marketplace list   # which ref you are pulling from
claude plugin list               # installed plugins, versions, and scope
```

Every plugin should read `Scope: user` and end in `@ensemble`. If any say
`@ensemble-dev`, you are on the ungated ref.

**Never install with `-s project`.** User scope already applies in every repo. A
project-scope copy shadows it, drifts independently, and gets missed by
`/ensemble:reinstall-plugins`.

---

## Reporting a problem

Bugs belong upstream at
[Sunstone-Partners/ensemble](https://github.com/Sunstone-Partners/ensemble) — we
contribute fixes there rather than patching our mirror, so a fix reaches everyone and
survives the next sync. Tell Mike what you hit; if it is Windows-specific it probably
needs a gate check added here too.
