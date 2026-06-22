# Nap For VS Code

Nap For VS Code brings the Nap coding agent into your editor with a focused chat experience for building, debugging, reviewing, and iterating on software. It connects to the Nap CLI app-server, streams work back into the sidebar, and keeps sessions available as you move through your workspace. Learn more in the [Nap documentation](https://www.nap-code.com/docs).

![Nap For VS Code](https://www.nap-code.com/hero.png)

## Features

- Sidebar chat built for everyday coding workflows in VS Code.
- Streaming agent responses with clean Markdown rendering for paragraphs, lists, code, links, and formatted text.
- Persistent sessions with compact generated names for easier history browsing.
- Inline review summaries for changed files, including quick access to review file diffs.
- Model selection, permissions controls, queue handling, and stop controls from the composer.
- Nap CLI app-server integration for local auth, session state, streaming output, and workspace-aware actions.
- Theme-aware interface designed to blend with your current VS Code theme.

## Getting Started

1. Install Nap For VS Code.
2. Install the Nap CLI with `npm i -g @nap-ai/cli`.
3. Open **Nap** from the Activity Bar.
4. Sign in when prompted.
5. Ask Nap what you want to build, change, debug, or review.

For a Copilot-style right-side layout, run **Nap: Move Chat To Right** from the Command Palette and choose **Secondary Side Bar**.

## Common Workflows

- Plan a feature before editing.
- Generate or revise code.
- Debug failing behavior.
- Review changed files.
- Continue work from a previous session.
- Queue follow-up prompts while a task is running.

## Notes

VS Code does not currently expose a stable public API that lets extensions force a custom view into the Secondary Sidebar by default. Nap provides a movable chat view and a command to help place it on the right.
