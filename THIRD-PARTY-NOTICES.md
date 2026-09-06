# Third-party notices

Model Lab itself is MIT licensed (see [`LICENSE`](LICENSE)). It has **no runtime npm
dependencies** — `package.json` declares an empty `dependencies` block, and everything under
`devDependencies` is build or test tooling.

Two kinds of third-party code nevertheless reach an end user:

## 1. Bundled into the distributed application

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 44.x | MIT | Ships inside `Model Lab.app` / the Windows build. Electron in turn embeds **Chromium** (BSD-3-Clause and a large set of compatible third-party licenses), **Node.js** (MIT) and **V8** (BSD-3-Clause). Electron's own `LICENSE` and its complete `LICENSES.chromium.html` are copied into every packaged build by electron-builder and are viewable inside the application bundle. |
| [React](https://github.com/facebook/react) | 18.3.1 | MIT | Compiled into the renderer bundle. |
| [React DOM](https://github.com/facebook/react) | 18.3.1 | MIT | Compiled into the renderer bundle. |

No modified third-party source is vendored into this repository. Nothing in `src/` is copied from
another project, so nothing here is relicensed.

## 2. Not distributed — required at runtime, installed by the user

| Component | License | Relationship |
| --- | --- | --- |
| [Ollama](https://github.com/ollama/ollama) | MIT | Model Lab talks to Ollama over its local HTTP API. Ollama is **not** bundled, redistributed, modified or installed by Model Lab; you install it yourself and Model Lab only detects and (on request) starts the copy you already have. |
| The language models you benchmark | Each model's own licence | Models are downloaded and stored by Ollama, never by Model Lab, and never copied into Model Lab's evidence store. Their licences are between you and the model publisher. |

## Build and test tooling

`electron-builder`, `electron-vite`, `vite`, `vitest`, `@playwright/test`, `typescript`, `tsx` and
the `@types/*` packages are all MIT licensed and are used only to build and test the project. They
are not part of the distributed application.

Run `npm ls --all --long` for the exhaustive, machine-checked dependency tree of any given checkout.
