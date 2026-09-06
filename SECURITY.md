# Security policy

## Supported versions

Model Lab is at an early public release. Only the latest release receives fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| older / unreleased builds | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**.
That opens a private advisory visible only to the maintainers.

Please include what you did, what happened, what you expected, your operating system and version, and
the Model Lab version from *Settings & diagnostics*. A proof of concept helps but is not required.

You can expect an acknowledgement within about a week. This is a small project maintained in spare
time, so please be patient with fixes; you will be credited in the release notes unless you prefer
otherwise.

## What Model Lab's threat model actually is

Knowing the design makes it easier to judge whether something is a real issue:

- **Model Lab makes no outbound internet connections.** There is no telemetry, no update check, no
  crash reporting and no account. The only socket it opens is to Ollama on the same computer.
- **Non-loopback endpoints are refused.** The Ollama endpoint setting only accepts `127.0.0.1`,
  `localhost` or `::1`. Anything else is rejected with an error, by design — a benchmark result
  records the hardware that produced it, and a remote host would make that record a lie.
- **Every benchmark prompt is an invented synthetic fixture.** Prompts are sealed test data with a
  `synthetic:` origin and a validator that refuses anything else. Model Lab reads no personal data,
  no files of yours, no contacts, no calendars, nothing.
- **The only download path is explicit.** *Add a model* asks Ollama to pull a model, after you
  confirm it by name. Model Lab never installs Ollama and never downloads a model on its own.
- **The renderer is sandboxed from Node.** `contextIsolation` is on, `nodeIntegration` is off, a
  Content-Security-Policy of `default-src 'self'` is enforced, and every call crosses one narrow
  typed preload bridge (`src/shared/ipc.ts`). External links open in your browser, never in-app.
- **The evidence store is append-only and local.** It lives under your user application-data folder,
  is never uploaded anywhere, and survives uninstalling the app.

Findings that would be especially valuable: a way to make Model Lab reach a non-loopback host, a way
to get a non-synthetic prompt into a run, a path that writes outside the evidence root or the user
data folder, a way to escape the preload bridge, or anything that causes an evidence record to be
overwritten or silently altered.

## Known and accepted

- **Release builds are unsigned.** macOS builds are ad-hoc signed but carry no Apple Developer ID and
  are not notarized; Windows builds are unsigned. You will see Gatekeeper and SmartScreen warnings,
  and you cannot cryptographically verify the origin of a downloaded artifact. Build from source if
  that matters to you. This is a known limitation, not a vulnerability report we need — it is
  documented in the README.
- **Model output is displayed as text, never executed.** Answers from a model are rendered as plain
  text; if you find a way to make model output run as code or markup, that *is* a vulnerability and
  we want to hear about it privately.
