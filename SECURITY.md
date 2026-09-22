# Security policy

## Supported versions

Cernum is at an early public release. Only the latest release receives fixes.

| Version | Supported |
| --- | --- |
| latest 0.x release | ✅ |
| older / unreleased builds | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**.
That opens a private advisory visible only to the maintainers.

Please include what you did, what happened, what you expected, your operating system and version, and
the Cernum version from *Settings & diagnostics*. A proof of concept helps but is not required.

You can expect an acknowledgement within about a week. This is a small project maintained in spare
time, so please be patient with fixes; you will be credited in the release notes unless you prefer
otherwise.

## What Cernum's threat model actually is

Knowing the design makes it easier to judge whether something is a real issue.

**Where your data goes depends on the route you configure. Cernum does not claim everything stays local.**

- **Local models stay local.** A local route talks to Ollama on this computer only. The Ollama endpoint
  setting accepts `127.0.0.1`, `localhost` or `::1` and nothing else, and the local workspace driver
  applies the same check, so a local model's prompts, the repository files it reads and its answers are
  sent to the local runtime and nowhere else.
- **Configured remote providers receive the task content their inference needs.** If you add a
  frontier route — the Claude or Codex CLI you installed, the OpenCode CLI, or the Anthropic or OpenAI
  API with your own key — the benchmark prompt (and, for a workspace benchmark, the instruction and
  whatever repository files that tool reads) goes to that provider, under that provider's own terms.
  Every campaign that uses such a route says so before it runs. Which routes are used is entirely your
  configuration; nothing is sent to a provider you did not configure.
- **Cernum itself has no telemetry, no update check, no crash reporting and no account.** It does not
  phone home. The only telemetry collector it ever starts is a loopback one for the Codex CLI's own
  export, when you ask for it.
- **Secrets are protected, not trusted to stay out of the way.** Cernum never reads a CLI's stored
  session and never passes a provider key to a tool authenticated by its own session. Agent processes
  get an allow-listed environment, verification commands get no credentials at all, and every row
  written to the evidence store passes through a secret scrubber first.
- **Model-modified code runs only inside an OS sandbox.** Cernum never executes a command a model chose.
  It executes only commands sealed in the benchmark definition, and when one runs on a tree a model has
  edited it runs under macOS Seatbelt: no network, no writes outside the disposable workspace, and no
  reads of your home directory. A machine without that sandbox refuses the run. Third-party agent CLIs
  (Claude, Codex, OpenCode) may run commands as part of being those tools; Cernum records which of
  their own controls applied, and says plainly where a tool's shell is not confined.
- **Every benchmark prompt is sealed test data.** Prompts and workspace fixtures are frozen with a
  validator that refuses anything else. Cernum reads no personal data, no files of yours outside the
  fixtures, no contacts and no calendars.
- **The only download path is explicit.** *Add a model* asks Ollama to pull a model after you confirm
  it by name. Cernum never installs Ollama or a CLI and never downloads a model on its own.
- **The renderer is sandboxed from Node.** `contextIsolation` is on, `nodeIntegration` is off, a
  Content-Security-Policy of `default-src 'self'` is enforced, and every call crosses one narrow typed
  preload bridge (`src/shared/ipc.ts`). External links open in your browser, never in-app.
- **The evidence store is append-only and local.** It lives under your user application-data folder,
  is never uploaded anywhere by Cernum, and survives uninstalling the app.

Findings that would be especially valuable: a way to make a *local* route reach a non-loopback host, a
way to send content to a provider you did not configure, a way for a model to get a command of its
choosing executed by Cernum, an escape from the verification sandbox, a secret reaching the evidence
store, a path that writes outside the evidence root or the user data folder, a way to escape the preload
bridge, or anything that causes an evidence record to be overwritten or silently altered.

## Known and accepted

- **Release builds are unsigned.** macOS builds are ad-hoc signed but carry no Apple Developer ID and
  are not notarized; Windows builds are unsigned. You will see Gatekeeper and SmartScreen warnings,
  and you cannot cryptographically verify the origin of a downloaded artifact. Build from source if
  that matters to you. This is a known limitation, not a vulnerability report we need — it is
  documented in the README.
- **Model output is displayed as text, never executed.** Answers from a model are rendered as plain
  text; if you find a way to make model output run as code or markup, that *is* a vulnerability and
  we want to hear about it privately.
