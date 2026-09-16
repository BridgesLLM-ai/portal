# Native chat.inject schema fixture

`chat-inject.schema.json` is the JSON serialization of the real native
`ChatInjectParamsSchema` (`Dt` export), from OpenClaw **2026.9.3** bundle
`dist/sessions-Bkydhb06.mjs`, not a Portal-authored schema.

Source SHA-256: `f7aaa440002a98d3fad5c4350dafa4dd750191ee5e9c3de077fe371af5493716`.

Export by importing that schema-only module with its TypeBox dependency in an
offline, empty-state sandbox and serializing the exported object. No gateway,
handler, native writer, provider or credentials are needed. The regression
compiles the exported JSON with Ajv, validates serialized adapter output, and
proves both historical payload shapes fail the independent native contract.

## Provider setup contracts

`provider-setup.schemas.json` contains the unmodified native TypeBox exports for
models list/auth-status/probe, config patch, wizard next/cancel, and setup
prepare/detect. `provider-model-config.schemas.json` exports the native Zod
`AgentModelMapSchema` and `AgentModelSchema` as draft-7 JSON Schema (unknown
params remain unconstrained, as in the native schema). The actual Portal HTTP
handler tests validate requests and merged model declarations against these
independent schemas, including negative controls for obsolete fields.

`provider-auth-choices.json` projects only the public auth-choice fields from
the pinned OpenAI, xAI, Google and GitHub Copilot manifests; each entry records
the complete manifest SHA-256. OpenAI's ChatGPT OAuth choice is `openai`, not
`openai-codex`. This core Google manifest has no Gemini CLI OAuth choice.

Exports were produced by importing schema-only modules from the exact 2026.9.3
package, without a Gateway, credentials, provider exchanges or inference.

| Native source | SHA-256 |
|---|---|
| `agents-models-skills-D9z8xWEg.mjs` | `d3c33dbfa15572db8388a0400a9298ecc26478e2d8b5706d5464b4754ff4db51` |
| `sessions-Bkydhb06.mjs` | `f7aaa440002a98d3fad5c4350dafa4dd750191ee5e9c3de077fe371af5493716` |
| `sessions-goal-DvoP5kGZ.mjs` | `6739fba1be63eb793adb5ef255467c311f375ef80ad2c8ff90e75dbbe6d0f148` |
| `src-CxpZ9eYs.mjs` | `7b5f05641d48948cbbee85372cf99c679caf6e6ef517797a049e452df33020d2` |
| `zod-schema.agent-runtime-BigQghiZ.mjs` | `f02fd71c19c17d899f7994f09e23b83e55e570803f549b21ea2f097ce658f6fe` |
| `system-agent-iYEs2ZF1.mjs` | `b756c6bfe143dd6e110f4c41c66bbd5972e7652f6b11d090f85c5faf402589fc` |
| `provider-auth-choice-CWk5gznO.mjs` | `18465ca3e4bfd1642780175b69e1fa5d1ab1d00124d248840bd105a426b08e7f` |
