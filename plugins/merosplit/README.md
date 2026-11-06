# MeroSplit plugin 0.1.1

One remote MCP service and one shared skill for ChatGPT/Codex and Claude Code. The portable entry is `plugin.json` with `mcp.json`; the Claude adapter uses `.claude-plugin/plugin.json` and `.mcp.json`. Both discover `skills/merosplit/SKILL.md` at the same root. There are no hooks, local processes, static headers or bundled credentials.

The endpoint is `https://merosplit.com/mcp`. It uses Streamable HTTP and per-account browser OAuth with dynamic client registration. The `merosplit:mcp` scope allows reads and writes subject to existing account/group permissions. Payment tools record external payments; they never transfer money. The package works without an embedded UI.

The canonical [setup page](https://merosplit.com/mcp/setup) covers client-specific connection. Claude chat/desktop uses a remote connector; the `.claude-plugin` adapter is for Claude Code. Installing the source package or validating its manifest does not authenticate a connection or publish a directory listing.

## Validation and packaging

From the repository root, using the API Python environment (which provides `jsonschema`):

```sh
apps/api/.venv/bin/python scripts/package-merosplit-plugin.py --output /tmp/merosplit-plugin.zip
apps/api/.venv/bin/python -m pytest scripts/test_package_merosplit_plugin.py -q
claude plugin validate plugins/merosplit --strict
```

The ZIP has this directory's contents at its root, including the dotfiles. The build accepts only the reviewed package files, rejects symlinks and produces stable bytes without timestamps from the source checkout. The build script is not shipped in the plugin.

Checked against official documentation on 18 October 2026:

- [OpenAI packaging and DCR configuration](https://developers.openai.com/plugins/build/plugins)
- [Agent Plugins schemas](https://agent-plugins.org/schemas)
- [Claude manifest and validation](https://code.claude.com/docs/en/plugins-reference)

**Schema limitation:** OpenAI documents `mcpServers.<name>.extensions.com.openai.auth`, but the fetched Agent Plugins 1.0.0 MCP schema rejects server extensions. The script reports that expected full-document rejection, validates the portable core against the unchanged official schema, and separately checks our narrow DCR contract against the documented fields. This is not an official OpenAI extension-schema pass; no such linked schema was available. `plugin.json` passes the official portable manifest schema, whose extension contents are intentionally client-defined. Schema snapshots and hashes live beside the repository build script.

Live host OAuth/read-write acceptance and public-directory review remain separate release gates. Neither is established by a schema check, CLI check or ZIP build.

## Public review

The package includes the listing icon, website, [support](https://merosplit.com/support), [privacy policy](https://merosplit.com/privacy), [terms](https://merosplit.com/terms), release notes, and five positive plus three negative review cases. The app and MCP share the existing Django ledger, permissions and retry rules.

Use a dedicated synthetic reviewer account. Seed a group named `Plugin review` with the reviewer, Asha and Dev, and a `Lunch` bill for INR 900 paid by the reviewer and split equally. Run the five positive cases in their listed order. The negative cases must leave the ledger unchanged. Use a different synthetic account for denied-group checks. Reviewer credentials belong in the portal's private review form, never this ZIP.

Before submission, complete publishing-identity and domain verification, verify fresh OAuth consent on ChatGPT mobile and web, run the portal's tool scan, and attach an accessible host walkthrough recording. Reviewer sign-in must work without waiting for email codes or external approval. The current package does not claim those portal or host steps are complete.
