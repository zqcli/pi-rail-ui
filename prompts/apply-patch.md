<!-- Model-facing text of the apply-patch tool. Format: prompts/README.md. -->

## description

Edit files by applying a Codex-style apply-patch patch.

This is not a standard git/unified diff: do not include --- or +++ file headers.

Patch format:

*** Begin Patch
*** Add File: path
+new file line
+
*** Update File: path
@@
-old line
+new line
 unchanged context line
*** Delete File: path
*** End Patch

Update File sections may include *** Move to: new-path before hunks. A single Update File section may contain multiple @@ hunks for separate edits in the same file.

Prefix rules:
- Add File content lines must all start with +. A blank added line is just +.
- Update File hunk lines must start with a space for exact context, - for removed lines, or + for added lines.
- Blank hunk lines still need a prefix: use a single leading space for an unchanged blank line, + for an added blank line, or - for a removed blank line.
- Do not leave literal empty lines inside Add File or Update File sections.

Keep hunk context small but exact; whitespace differences matter. Include enough context or a hunk header to make repeated text unambiguous. Paths may be relative to the current working directory or absolute.

## prompt_snippet

Apply a Codex-style patch to add, update, move, or delete files

## prompt_guidelines

- Use apply-patch for focused file edits when a patch is clearer than edit/write.
- For apply-patch, patch text must start with *** Begin Patch and end with *** End Patch.
- For apply-patch, the format is not a standard unified diff; do not emit --- or +++ file headers.
- For apply-patch, use Add File, Delete File, or Update File headers; a single Update File block may contain multiple @@ hunks for the same file.
- For apply-patch, every Add File content line starts with +, including blank lines, which are written as just +.
- For apply-patch, every Update File hunk line starts with space, -, or +; unchanged blank lines are a single leading space.
- For apply-patch, do not leave literal empty lines inside Add File or Update File sections.
- For apply-patch, keep hunk context small but exact, and include enough context or a hunk header when similar text appears more than once.
