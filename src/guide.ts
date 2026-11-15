export const INSTRUCTIONS = `agent-memory is long-term memory that survives sessions.

Search with memory_search before assuming a preference, convention, or past decision, and at the start of work in a known project. Search when the user says "as usual", "last time", or "we decided".

Save with memory_add only when something should still be true next week: a preference, a decision, a convention, or a stable fact. One self-contained statement per memory. Set type, importance (1 minor, 5 always apply), and scope (project for this repo, global for the user). Do not store secrets, transcripts, diffs, or temporary notes.

Search and list return short cards. Call memory_get for the full text. When a decision changes, memory_update the old memory instead of saving a contradiction. memory_clear deletes nothing unless you send back the confirmation phrase it gives you.`;

export const GUIDE = `# Using agent-memory

Search before you guess. Save what future sessions would otherwise have to ask again.

## When to search

- At the start of work in a project
- Before choosing a library, style, command, or architecture
- When the user refers to an earlier decision or a personal preference

Call \`memory_search\` with a short query. The default scope is the current project plus global memories. Call \`memory_get\` only when a card is not enough.

## When to save

Save one durable statement:

- Preference: "User wants concise explanations and small diffs."
- Decision: "Use node:sqlite instead of better-sqlite3 so install needs no native build."
- Convention: "Tests use node:test. Do not add Jest."
- Fact: "The production database is SQLite at ~/.agent-memory/memory.db."
- Note: a short reminder that is not a rule

Skip chatter, stack traces, file dumps, and anything that will be stale tomorrow.

## How to write one

- Say the rule, not the meeting that produced it
- Include the project name in the text if the scope is not obvious
- Set importance 5 for rules that should always be applied, 1 for trivia
- Use project scope for this repo and global scope for the user
- Add a few tags such as \`testing\`, \`typescript\`, or \`git\`
- Never store API keys, tokens, passwords, or private keys. Store a pointer: "The API key lives in .env."

## Keeping memory clean

- Search first. \`memory_add\` deduplicates identical text in the same scope and type
- If a decision changed, \`memory_update\` the existing id
- \`memory_delete\` removes one memory
- \`memory_clear\` previews the delete and does nothing until the confirmation phrase is sent back
`;
