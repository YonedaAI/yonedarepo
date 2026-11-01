// The memory test's traps (memory-flow.mjs): one task per repository, each with a rule no file,
// doc or commit of that repository reveals and exactly one memory explains. The rules are made
// up for this test: the task's natural answer breaks one, and only the memory says so. Each
// trap is a different kind of rule (where code goes, what a name must be, what a value must
// be), so one lucky guess cannot decide the result. `hidden` is what the run scans the fork's
// tree, commit messages and history for before an agent starts; any hit stops the test.
//
// `oracle(paths, added)` reads the agent's result, never runs it: `paths` are the files its
// branch changed, `added` maps each to the lines it added. `done` says the task was done at
// all; `avoided` says the rule held.
//
// The other memories are real-sounding notes on the same repositories, none of which touch a
// task. A fresh clone's start packet is the 8 newest memories (relevance.rs `for_start`, 8 from
// context_cmd.rs), so the trap goes in first: it is the oldest, 12 newer ones keep it out of
// the start packet, and it can only reach the agent the way a real one would, by the file it
// is anchored to being read or by the prompt's words. The two `near` memories sit on the same
// file and are newer, so even there it ranks behind them. The context arm gets all of them but
// the trap (`armMemories`), so it measures what context gives with no rule to find.

const COLOUR = new Set(['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE']);
const isLib = (path) => /^(lib\/.+|index)\.m?js$/.test(path);
const envNames = (lines) => lines.flatMap((l) => [...l.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));

export const TRAPS = [
  {
    id: 'frozen-file',
    repo: 'oss-cobra',
    rule: 'placement',
    task: 'Add an exported method `VisibleCommandNames() []string` on `Command`. It returns the `Name()` of each subcommand that is not `Hidden`, in the order `Commands()` returns them.',
    commit: 'Add VisibleCommandNames',
    memory: {
      kind: 'constraint',
      text: 'command.go is frozen: a downstream distribution carries a patch queue against this file, and any added or moved line breaks its rebase. Put new Command methods in another file of the package, never in command.go. Fixes to existing lines are fine.',
      anchors: [{ path: 'command.go' }],
    },
    hidden: ['patch.?queue', 'command\\.go is frozen'],
    oracle(paths, added) {
      const go = paths.filter((p) => p.endsWith('.go') && !p.endsWith('_test.go') && !p.includes('/'));
      return {
        done: go.some((p) => added[p]?.some((l) => /func\s*\(\s*\w*\s*\*Command\s*\)\s*VisibleCommandNames\s*\(/.test(l))),
        avoided: !paths.includes('command.go'),
      };
    },
    distractors: [
      { near: true, kind: 'gotcha', text: 'Commands() sorts in place and remembers it: holding the slice across AddCommand sees a stale order. Call it again after adding.', anchors: [{ path: 'command.go' }] },
      { near: true, kind: 'decision', text: 'The help subcommand is added lazily by InitDefaultHelpCmd during Execute, so a test that counts subcommands before Execute sees one fewer.', anchors: [{ path: 'command.go' }] },
      { kind: 'decision', text: 'ShellCompDirective is a bit field the generated scripts test by value: add new directives at the end and never renumber them.', anchors: [{ path: 'completions.go' }] },
      { kind: 'gotcha', text: 'The V2 bash script is a Go format string, so a literal percent sign has to be doubled or the script breaks only at generation time.', anchors: [{ path: 'bash_completionsV2.go' }] },
      { kind: 'constraint', text: 'The cobra_annotation_* keys are public: completion scripts and third-party generators read them by name.', anchors: [{ path: 'bash_completions.go' }] },
      { kind: 'howto', text: 'To debug a completion script, set BASH_COMP_DEBUG_FILE to a path; the generated functions append their trace there in every shell.', anchors: [{ path: 'zsh_completions.go' }] },
      { kind: 'decision', text: 'Positional argument validators run after flag parsing on purpose, so a validator can read flag values.', anchors: [{ path: 'args.go' }] },
      { kind: 'gotcha', text: 'The mousetrap message only ever shows on Windows, started from Explorer. Testing it on other systems proves nothing.', anchors: [{ path: 'command_win.go' }] },
      { kind: 'constraint', text: 'pflag and mousetrap stay the only runtime dependencies. Anything heavier belongs in cobra-cli.', anchors: [{ path: 'go.mod' }] },
      { kind: 'gotcha', text: 'PowerShell completion needs the description separator escaped on its own; a fix in the bash script does not carry over.', anchors: [{ path: 'powershell_completions.go' }] },
      { kind: 'decision', text: 'Active Help messages go through the completion output, so printing them to stderr hides them from the shell.', anchors: [{ path: 'active_help.go' }] },
      { kind: 'howto', text: 'Release notes come from pull request labels (.github/labeler.yml); there is no changelog file to edit by hand.', anchors: [] },
    ],
  },
  {
    id: 'env-prefix',
    repo: 'oss-commander',
    rule: 'naming',
    task: 'Add an environment variable that shows hidden items in help: when it is set to a non-empty value, `visibleCommands()` and `visibleOptions()` in lib/help.js also return the commands and options marked hidden. Choose a name for the variable.',
    commit: 'Add an environment variable to show hidden items in help',
    memory: {
      kind: 'constraint',
      text: 'Environment variables this library reads must start with CMDR_: the hosted runners pass only that prefix into tool sandboxes, so any other name silently reads as undefined in production. NO_COLOR, FORCE_COLOR and CLICOLOR_FORCE are the only exceptions.',
      anchors: [{ path: 'lib/help.js' }],
    },
    hidden: ['CMDR_'],
    oracle(paths, added) {
      const lines = paths.filter(isLib).flatMap((p) => added[p] ?? []);
      const fresh = envNames(lines).filter((n) => !COLOUR.has(n));
      return {
        done: lines.some((l) => /process\.env\b/.test(l)),
        avoided: lines.some((l) => /CMDR_[A-Z0-9_]+/.test(l)) && fresh.every((n) => n.startsWith('CMDR_')),
      };
    },
    distractors: [
      { near: true, kind: 'gotcha', text: 'visibleOptions() appends the help option after filtering, so a subclass that sorts must not assume help is last.', anchors: [{ path: 'lib/help.js' }] },
      { near: true, kind: 'decision', text: 'Help.helpWidth stays undefined until prepareContext runs: read it there, not in the constructor.', anchors: [{ path: 'lib/help.js' }] },
      { kind: 'constraint', text: 'typings/index.d.ts is written by hand and checked by typings/index.test-d.ts: change both together.', anchors: [{ path: 'typings/index.d.ts' }] },
      { kind: 'decision', text: 'Option parsing stays free of dependencies. package.json has no runtime dependencies and that is deliberate.', anchors: [{ path: 'package.json' }] },
      { kind: 'gotcha', text: 'Excess arguments are errors by default since v13: a test that passes extra operands needs allowExcessArguments.', anchors: [{ path: 'lib/command.js' }] },
      { kind: 'gotcha', text: 'A negatable option and its positive form share one attribute name; declaring both changes the default.', anchors: [{ path: 'lib/option.js' }] },
      { kind: 'decision', text: 'Variadic arguments must come last. The check throws at definition time so a mistake never reaches users.', anchors: [{ path: 'lib/argument.js' }] },
      { kind: 'howto', text: 'CommanderError keeps exitCode and code apart; a test of exitOverride asserts on code, which stays stable across messages.', anchors: [{ path: 'lib/error.js' }] },
      { kind: 'decision', text: 'Suggestions use edit distance with a fixed cut-off, so short mistyped flags often get none. That is by design.', anchors: [{ path: 'lib/suggestSimilar.js' }] },
      { kind: 'howto', text: 'The zh-CN Readme is maintained separately by volunteers: do not translate changes into it from a pull request.', anchors: [{ path: 'Readme_zh-CN.md' }] },
      { kind: 'gotcha', text: 'Executable subcommands look for the file next to the real path of the entry script, so a symlinked bin behaves differently.', anchors: [{ path: 'lib/command.js' }] },
      { kind: 'howto', text: 'Changelog entries are written at release time from the merged pull requests.', anchors: [{ path: 'CHANGELOG.md' }] },
    ],
  },
  {
    id: 'exit-code',
    repo: 'oss-click',
    rule: 'value',
    task: 'Add an exception `ConfigFileError` to src/click/exceptions.py for a configuration file that cannot be loaded. It subclasses `ClickException`, takes `message` and an optional `filename`, and `format_message()` puts the filename in front of the message when there is one. Export it from src/click/__init__.py.',
    commit: 'Add ConfigFileError',
    memory: {
      kind: 'constraint',
      text: 'Exceptions for a bad configuration must set exit_code = 78 (EX_CONFIG): the fleet supervisor restarts a tool on any other non-zero exit, so a broken config would loop forever. Exit codes 1 and 2 stay reserved for runtime and usage errors.',
      anchors: [{ path: 'src/click/exceptions.py' }],
    },
    hidden: ['EX_CONFIG', 'exit_code[^=]*=[[:space:]]*78'],
    oracle(paths, added) {
      const lines = added['src/click/exceptions.py'] ?? [];
      return {
        done: lines.some((l) => /^\s*class\s+ConfigFileError\b/.test(l)),
        avoided: lines.some((l) => /\bexit_code\b[^=\n]*=\s*(78|(os\.)?EX_CONFIG)\b/.test(l)),
      };
    },
    distractors: [
      { near: true, kind: 'gotcha', text: 'UsageError shows the command help hint only when it has a context, so raising one outside a command prints less.', anchors: [{ path: 'src/click/exceptions.py' }] },
      { near: true, kind: 'decision', text: 'Exception messages are translated with gettext at format time: keep them as _() calls, never f-strings before the call.', anchors: [{ path: 'src/click/exceptions.py' }] },
      { kind: 'gotcha', text: 'Context.max_content_width caps help at 80 columns even on a wider terminal unless a caller changes it.', anchors: [{ path: 'src/click/formatting.py' }] },
      { kind: 'decision', text: 'The parser is a private fork of optparse behaviour: it stays private, and option semantics are decided in core.py.', anchors: [{ path: 'src/click/parser.py' }] },
      { kind: 'gotcha', text: 'CliRunner swaps sys.stdin and friends, so code that caches a stream at import time escapes it.', anchors: [{ path: 'src/click/testing.py' }] },
      { kind: 'constraint', text: 'Shell completion scripts are versioned by the instruction environment variable: changing the protocol needs a new source template.', anchors: [{ path: 'src/click/shell_completion.py' }] },
      { kind: 'gotcha', text: 'Pager selection falls back to plain output when stdout is not a terminal; a test of the pager needs a real tty.', anchors: [{ path: 'src/click/_termui_impl.py' }] },
      { kind: 'decision', text: 'ParamType.convert may receive an already converted value, so each type must accept its own output.', anchors: [{ path: 'src/click/types.py' }] },
      { kind: 'howto', text: 'Every behaviour change gets an entry in CHANGES.md under the unreleased version.', anchors: [{ path: 'CHANGES.md' }] },
      { kind: 'gotcha', text: 'echo() strips ANSI codes when the output is not a terminal, so a colour test must set color=True.', anchors: [{ path: 'src/click/utils.py' }] },
      { kind: 'decision', text: 'The decorators keep the wrapped function reachable through callback; update_wrapper is deliberately not the contract.', anchors: [{ path: 'src/click/decorators.py' }] },
      { kind: 'constraint', text: 'Windows console support stays in _winconsole.py behind the _compat checks: nothing else imports ctypes.', anchors: [{ path: 'src/click/_compat.py' }] },
    ],
  },
];

/** A trap's memories in the order they are added, oldest first: the trap, then the two on its
 * file, then the rest, the newest of which fill the start packet. */
export function seedOrder(trap) {
  const near = trap.distractors.filter((d) => d.near);
  const rest = trap.distractors.filter((d) => !d.near);
  return [{ ...trap.memory, trap: true }, ...near, ...rest];
}

/** What one arm's fork is given: nothing on plain, and the same memories on the other two but
 * for the trap, so the trap memory is the one thing that separates them. */
export function armMemories(trap, arm) {
  if (arm === 'plain') return [];
  return seedOrder(trap).filter((m) => arm === 'memory' || !m.trap);
}

/** Every file a trap's memories anchor to (a fork must hold them, and the dry run's fixture). */
export const anchoredFiles = (trap) => [...new Set(seedOrder(trap).flatMap((m) => m.anchors.map((a) => a.path)))];

const plugin =
  "Tools: this clone's remote is YonedaRepo. The yoneda plugin gives your session the repository's context when it starts: memories other sessions left, what recent sessions did, open changes and the landing rules. When you read a file it adds the memories on that file you have not seen, and each prompt brings what is relevant to it. Read it before you start. Prefer `yoneda grep <query>`, `yoneda symbols <path>`, `yoneda blame <path>` and `yoneda log [path]` over reading many files; `yoneda memory list` shows the memories.";
const paragraph = { plain: 'Tools: this is a plain Git clone (remote origin). Use git and the files in the clone.', context: plugin, memory: plugin };

/** What the agent is told, the task first as a person would write it: the same text in every
 * arm but for the tool paragraph, which the two plugin arms share, on the same branch name of
 * its own fork. */
export function armPrompt(trap, branch, arm) {
  if (!paragraph[arm]) throw new Error(`unknown arm ${arm}`);
  return [
    trap.task,
    '',
    `You are working in a Git clone of the open-source repository ${trap.repo} (remote origin), on the branch ${branch}.`,
    'This sandbox has Git and Node but no other toolchain, and no network beyond the remote and the model: do not install anything or run the repository\'s tests.',
    `Keep the change small, commit with the message "${trap.commit}" and push with: git push origin ${branch}`,
    'Never push to main or any other branch, never force-push and never open a change; the operator does that.',
    'When the push has succeeded, answer with one sentence saying what you changed.',
    '',
    paragraph[arm],
  ].join('\n');
}
