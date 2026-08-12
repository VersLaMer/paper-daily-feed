# Agent deployment instructions

[English](./agent-deployment.md) | [简体中文](./agent-deployment.zh-CN.md)

> These instructions are for AI coding agents. Complete the deployment for the user while minimizing the input and actions required from them.

## Deployment principles

**Internal model**

Use the following model internally. Do not recite these implementation concepts to the user unless they ask or need one clarified to make a choice:

- A **fork** is the user's own GitHub copy of this project. Deploy only a fork of the canonical repository, <https://github.com/nehSgnaiL/paper-daily-feed>, under the user's account. Never deploy to the canonical repository or the Agent's account.
- **GitHub Actions** runs the feed automatically in that fork.
- **GitHub Secrets** store credentials such as email passwords and API keys. Their values must not be shown after they are saved.
- **GitHub Variables** store non-secret settings. This project reads the `APP_CONFIG` Actions variable as its application configuration.
- `APP_CONFIG` is JSONC text: JSON that may contain comments and trailing commas. It controls research interests, sources, matching, summaries, and delivery behavior without changing repository files.

Use `APP_CONFIG`, not application code, as the normal customization path. A Variable update takes effect in later workflow runs and creates no Git commit, so the fork can continue following upstream updates without accumulating customization commits.

**Rules before acting**

- Read `@README.md` from beginning to end, especially **Get started**. If this file and the README differ, follow the README.
- Read `@config/app.example.jsonc` before collecting optional settings or proposing configuration. Use only keys, value types, and behavior supported by that current template.
- When the user has an additional requirement, first determine whether `APP_CONFIG` can satisfy it. Prefer the smallest relevant configuration change.
- Do not edit or commit application code, workflow files, `data/journals.config.ts`, or other tracked files for deployment customization. If a requirement truly cannot be represented by `APP_CONFIG`, explain the gap before changing tracked files.
- Confirm the signed-in GitHub account and target fork before changing GitHub state. Reuse an existing fork when possible.
- Prefer `gh` and complete pages, commands, saving, and checks for the user. Ask the user to act only for choices, secure credential entry, sign-in, or two-factor confirmation.

**Evidence requirements**

Treat model memory and search-result snippets as leads, not evidence. Do not invent journal titles, rankings, ISSNs, RSS URLs, configuration keys, service requirements, or successful results.

- Verify project behavior and configuration against the current `@README.md`, `@config/app.example.jsonc`, source, or workflow files before making a claim or saving a value.
- Verify journal identity and ISSNs with the journal or publisher's official page; Crossref may be used as a second source. Verify an RSS or Atom URL by opening the feed and confirming that it returns recognizable entries for that journal.
- If the user asks for “Top” journals, first explain that “Top” depends on a ranking source, metric, category, and year. Name and link the current source used. Never present an unsourced model-generated ordering as a ranking.
- Verify SMTP, Zotero, GitHub, and API requirements with the provider's current official documentation when they affect setup.
- When presenting journal candidates, include the evidence link and clearly separate verified facts from suggestions or inferences. If an important fact cannot be verified, say so and do not silently fill it in.
- Report a check or workflow as successful only after observing its result. Never fabricate a citation, page content, command output, workflow status, or delivered email.

## Deployment flow

Keep the conversation continuous: ask one simple question at a time and use the answer in the next question. Explain only unfamiliar choices that the user needs to decide; keep implementation terms and configuration field names internal unless showing the final configuration or answering a question. Do not jump from a broad research area to an unrelated choice without showing the connection.

1. **Establish the outcome.** Confirm that the user wants a daily paper email, then ask which discipline they work in. Do not front-load implementation details.
2. **Narrow the research interest.** Use their discipline to offer a few relevant broad directions. Narrow the field progressively, then summarize the understood research interest and ask the user to confirm it. Internally, this summary becomes `interests.profile.summary`.
3. **Choose and verify paper sources.** Explain that interests control ranking, while feeds control which papers can enter the candidate pool. Discover journals for the confirmed field, apply the evidence requirements above, and present a verified shortlist. Ask which journals to include, add, or exclude, then show the final names and evidence for confirmation.

   The bundled catalog mainly covers geography. For geography, map confirmed journals to exact entries in `data/journals.config.ts` and use `feeds.catalogSelections`. For other disciplines, use `feeds.includeCatalog: false` and verified feeds in `feeds.customRss`. An empty `catalogSelections` means all bundled journals, not none.
4. **Add optional interest sources.** After the text profile and journals are clear, ask whether the user wants their Zotero library to help determine relevance. If yes, collect `ZOTERO_ID` and a read-only `ZOTERO_KEY` through secure input and ask about collection filters.
5. **Choose summary behavior.** Explain that AI TLDRs are optional and that, when disabled, the original abstract is used. If enabled, confirm the API provider, official API base URL, model identifier, and output language before collecting the API key securely.
6. **Choose recommendation limits.** Ask how many papers the user wants at most in each delivery and whether they prefer stricter or broader matching. Map the answers internally to `matching.paperLimit` and `matching.minScore`; mention the field names only when reviewing the configuration.
7. **Review the configuration.** Build the smallest `APP_CONFIG` that expresses the confirmed choices. Show the complete non-secret JSONC and explain each included section in the same order as the earlier decisions. Validate it with the current configuration parser (`bun run test:config`) using placeholders rather than real credentials, then obtain confirmation before saving or replacing it.
8. **Prepare GitHub and credentials.** Check `gh`, start GitHub web sign-in if needed, confirm the account, and find or create the user's fork. Then collect the receiving address, sending address, SMTP server, and port in that order. Collect passwords, authorization codes, and API keys only through secure input.
9. **Save settings without a customization commit.** Save credentials as Actions Secrets and save the reviewed JSONC as the repository Actions variable `APP_CONFIG`. Do not create or push a commit for these settings.
10. **Enable, test, and hand off.** Enable the required workflows, verify automatic updates, run the test feed, inspect non-secret logs if it fails, and continue until the observed result succeeds and the user confirms receipt.

**Completion checklist**

- [ ] **Prepare GitHub:** Confirm `gh` availability and login, the signed-in account, and the target fork.
- [ ] **Confirm the research profile:** Confirm the progressively narrowed field and the final `interests.profile.summary`.
- [ ] **Confirm paper sources:** Show evidence for journal identity, ISSNs, and working feeds; obtain confirmation for the final selection.
- [ ] **Confirm optional features:** Confirm Zotero, AI summary, output language, paper limit, and minimum score choices.
- [ ] **Review `APP_CONFIG`:** Validate every field against `config/app.example.jsonc`, validate the complete non-secret value with `bun run test:config`, show it, and obtain user confirmation.
- [ ] **Save Secrets:** Save required `RECEIVER`, `SENDER`, `SENDER_PASSWORD`, `SMTP_SERVER`, and `SMTP_PORT`, plus only the credentials required by enabled features.
- [ ] **Save the Variable:** Save the approved configuration as the repository Actions variable `APP_CONFIG`; do not commit it to the fork.
- [ ] **Enable complete auto-updates:** Include workflow files in weekly updates. Create a fine-grained token scoped only to the target fork with **Contents** and **Workflows** read/write access, and save it directly as the Actions secret `MAINTENANCE_SYNC_TOKEN`. Involve the user only if GitHub requires sign-in or two-factor confirmation.
- [ ] **Enable workflows:** Enable Actions, **Daily paper feeds**, **Repository maintenance**, and **Test paper feeds** in the fork.
- [ ] **Verify auto-updates:** Run **Repository maintenance** and observe that weekly keepalive and upstream synchronization, including workflow files, succeed.
- [ ] **Verify delivery:** Run **Test paper feeds**. Inspect only non-secret logs and correct settings through Secrets or Variables. Do not edit tracked files to force a successful run.
- [ ] **Hand off:** Provide the fork link, successful test-run link, daily schedule status, and the simple way to pause **Daily paper feeds**. Never repeat a credential.

## Security and completion

**Protect credentials**

- Never ask the user to paste a password, token, authorization code, or API key into chat. Use an interactive program for entry.
- Never expose credentials in commands, output, logs, temporary files, `APP_CONFIG`, or shell history.
- Use an Agent-created `MAINTENANCE_SYNC_TOKEN` only for weekly updates in the target fork, never for local login or another project.
- Show and confirm a new non-secret `APP_CONFIG` before replacing an existing value.

**Completion requirements**

Finish only after every checklist item is complete, the maintenance workflow has visibly succeeded, the test workflow has visibly succeeded, and the user confirms that the test email arrived. Do not claim success based on expectation, weaken security, or edit application/workflow code to force a successful test.
