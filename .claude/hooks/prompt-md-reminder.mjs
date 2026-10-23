/**
 * PostToolUse hook: reminds Claude to regenerate PROMPT.md when the suite it
 * describes changes.
 *
 * PROMPT.md is the build prompt derived from this repo, so an edit to a spec, a
 * page object, the config or .env.example can leave it describing a suite that
 * no longer exists. Reads the hook payload on stdin and, when the edited file is
 * one PROMPT.md derives from, prints additionalContext back to the model.
 *
 * Silence is the success case: a file outside the watched set prints nothing.
 */

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let file = '';
  try {
    const input = JSON.parse(raw);
    file = input?.tool_input?.file_path ?? input?.tool_response?.filePath ?? '';
  } catch {
    // A payload we can't parse is not worth failing a tool call over.
    process.exit(0);
  }

  // Backslashes on Windows, forward slashes everywhere else.
  const path = String(file).replace(/\\/g, '/');

  const isWatched =
    /\/(src|tests)\//.test(path) ||
    /\/(playwright\.config\.ts|\.env\.example|package\.json)$/.test(path);

  // node_modules matches the package.json rule, and PROMPT.md itself would
  // otherwise re-trigger the reminder that just made us edit it.
  const isExcluded = /node_modules/.test(path) || /PROMPT\.md$/.test(path);

  if (!isWatched || isExcluded) process.exit(0);

  const name = path.split('/').pop();

  console.log(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `${name} just changed, and PROMPT.md is the build prompt derived from ` +
          `this suite. Check whether this change affects it — specs, env vars, ` +
          `safety guards, stock-template rules, app quirks, layout, scripts — and ` +
          `update the matching section before finishing this turn. If nothing in ` +
          `PROMPT.md is affected, say so in one line and move on.`,
      },
    }),
  );
});
