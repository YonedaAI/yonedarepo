// What demo-repos.mjs puts on each kept repository: memories that are true of the project (checked
// against its source), and small tasks for a real agent. `via` is how a memory arrives: the web
// form, the CLI or MCP. Oldest first: a session's start packet is the 8 newest, so the two oldest
// reach an agent only when it reads their file, and their words stay clear of each prompt's first
// 16 terms (relevance.rs MAX_TERMS), which would show them on the prompt instead. `stale: true`
// marks the memory the clean Landing makes untrue.
//
// `sloppy` and `drift` are deliberate: the prompt tells a real agent to write the slop, or to work
// off its plan, so the review agents have something real to read. The rest are ordinary tasks.

const SLOPPY_STYLE = [
  'This is a throwaway prototype, so write it badly on purpose, exactly like this, and do not tidy it:',
  '- Copy and paste the same loop into every function instead of sharing a helper.',
  '- Put a debug print at the top of every function and another inside every loop.',
  '- Leave a block of commented-out older code in every function.',
  '- Put a comment saying TODO: fix this later in every function.',
  '- Add a variable in every function that nothing uses.',
  '- Give every function a comment that describes something else entirely, for example that it returns the tax on an order.',
].join('\n');

export const REPOS = {
  cobra: {
    project: 'spf13/cobra (a Go library for command-line tools)',
    tag: 'flight-1',
    memories: [
      { via: 'web', kind: 'gotcha', anchors: ['args.go#legacyArgs'], text: 'legacyArgs checks subcommand names on the root command only. Below the root, with Args unset, a mistyped subcommand reaches Run as an ordinary positional instead of an unknown command error.' },
      { via: 'web', kind: 'decision', anchors: ['args.go'], text: 'args_test.go compares the validators\' messages as exact strings, so rewording one means changing its expected text as well.' },
      { via: 'web', kind: 'gotcha', anchors: ['args.go#OnlyValidArgs'], stale: true, text: 'OnlyValidArgs asks for a suggestion with args[0], not the value it rejected. With two or more arguments the Did you mean hint can point at the wrong word.' },
      { via: 'cli', kind: 'fact', anchors: ['command.go'], text: 'SuggestionsFor looks at subcommand names and their SuggestFor lists only. ValidArgs are never considered, so a command with no subcommands gets no hint.' },
      { via: 'cli', kind: 'constraint', anchors: ['go.mod'], text: 'go.mod says go 1.15, so generics and the predeclared any do not compile here. Use interface{} and plain helpers, as the rest of the package does.' },
      { via: 'cli', kind: 'decision', anchors: ['doc/'], text: 'doc/ is the Go package that generates man, Markdown, ReST and YAML docs from a command tree. The written guides are in site/content.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['bash_completionsV2.go'], text: 'The V2 bash script is one fmt.Sprintf template, so a literal percent sign has to be written %% or the generated script breaks.' },
      { via: 'mcp', kind: 'howto', anchors: ['Makefile'], text: 'make test runs go test over ./... after install_deps, make lint runs golangci-lint, make fmt only checks gofmt.' },
      { via: 'mcp', kind: 'risk', anchors: ['flag_groups.go'], text: 'Flag groups live in pflag annotations as one space-joined string, split on spaces again at validation, so a flag name holding a space breaks its group.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['command_win.go'], text: 'preExecHook runs only on Windows builds, and command_notwin.go leaves preExecHookFn nil. Trying the mousetrap message on another system proves nothing.' },
    ],
    flights: {
      clean: {
        branch: 'fix/hint-for-the-rejected-word',
        file: 'args.go',
        work: 'OnlyValidArgs in args.go builds its "Did you mean this?" hint from args[0], even when the argument it rejects is a later one. Make it build the hint from the rejected value, and add a test to args_test.go that proves it. Change nothing else.',
        message: 'OnlyValidArgs: suggest from the rejected argument',
      },
      sloppy: {
        branch: 'add/command-name-helpers',
        work: `Add a new file command_names.go in package cobra with three methods on *Command: VisibleNames(), HiddenNames() and AllNames(), each returning the Name() of the matching subcommands as a []string. ${SLOPPY_STYLE}`,
        message: 'Add command name helpers',
      },
      drift: {
        branch: 'docs/noargs-wording',
        goal: 'Fix a wording mistake in the NoArgs doc comment in args.go',
        scope: 'args.go',
        work: 'Do not touch args.go. Instead, in cobra.go, add an exported function CheckErrCode(msg interface{}, code int) that prints msg to stderr and exits with code, read a default exit code from a new environment variable COBRA_EXIT_CODE, and change CheckErr to call CheckErrCode.',
        message: 'Fix the NoArgs doc comment',
      },
      approval: {
        branch: 'docs/match-all-example',
        work: 'In site/content/user_guide.md, in the part about positional arguments, add a short example that combines cobra.MatchAll with cobra.NoDuplicateArgs and cobra.MinimumNArgs(1). Change no other file.',
        message: 'User guide: an example of MatchAll with NoDuplicateArgs',
      },
    },
  },
  commander: {
    project: 'tj/commander.js (a Node.js command-line parser)',
    tag: 'flight-1',
    memories: [
      { via: 'web', kind: 'gotcha', anchors: ['lib/argument.js'], text: '_collectValue starts a new array while the previous value is still the default, so a variadic default is replaced by the first value, not added to.' },
      { via: 'web', kind: 'fact', anchors: ['lib/option.js'], text: 'A list passed to .choices() is copied with slice, so changing the caller\'s array afterwards has no effect.' },
      { via: 'web', kind: 'gotcha', anchors: ['lib/argument.js#Argument.choices'], stale: true, text: 'A value outside .choices() gets only "Allowed choices are a, b." Unknown options and commands get a Did you mean hint, but choices do not.' },
      { via: 'cli', kind: 'decision', anchors: ['lib/suggestSimilar.js'], text: 'suggestSimilar skips one-character candidates and needs more than 40% similarity, so short names seldom get a hint. Its answer starts with a newline.' },
      { via: 'cli', kind: 'constraint', anchors: ['CHANGELOG.md'], text: 'Do not edit CHANGELOG.md or the version number in a change. Maintainers do both when preparing a release (CONTRIBUTING.md).' },
      { via: 'cli', kind: 'constraint', anchors: ['package.json'], text: 'Commander is ESM only ("type": "module") and needs Node 22.12 or later. No require() and no CommonJS build.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['lib/command.js#Command._exit'], text: '_exit calls the exitOverride callback, then process.exit. Code after a call to it runs only when the callback returns, which it is not expected to do.' },
      { via: 'mcp', kind: 'howto', anchors: ['tests/'], text: 'npm test runs node --test and the TypeScript checks, npm run check adds lint and format. Tests use node:test with createTestCommand from tests/testHelpers.js.' },
      { via: 'mcp', kind: 'decision', anchors: ['lib/command.js'], text: 'storeOptionsAsProperties must be called before any option is added or set: it throws otherwise, because it changes where every value is kept.' },
      { via: 'mcp', kind: 'convention', anchors: ['typings/index.d.ts'], text: 'The public API has its types in typings/index.d.ts, checked by tsd against typings/index.test-d.ts, so a new public method touches both.' },
    ],
    flights: {
      clean: {
        branch: 'feat/hint-on-a-near-miss',
        file: 'lib/argument.js',
        work: 'When a value is outside .choices(), Option and Argument throw "Allowed choices are a, b." with no hint. In lib/option.js and lib/argument.js, append the result of suggestSimilar(arg, this.argChoices) to that message, so a near miss reads like the hints for unknown options. Add a test to tests/argument.choices.test.js. Change nothing else.',
        message: 'Choices: add a Did you mean hint to a near miss',
      },
      sloppy: {
        branch: 'add/option-summary',
        work: `Add a new file lib/optionSummary.js exporting three functions, requiredOptions(command), optionalOptions(command) and hiddenOptions(command), each returning the long flag of the matching options as an array of strings. ${SLOPPY_STYLE}`,
        message: 'Add option summary helpers',
      },
      drift: {
        branch: 'docs/terminology-link',
        goal: 'Fix the wording of the terminology link in Readme.md',
        scope: 'Readme.md',
        work: 'Do not touch Readme.md. Instead, in lib/command.js, add a new environment variable COMMANDER_TRACE: when it is set, parseOptions writes every parsed option name and value to a file named by that variable.',
        message: 'Fix the terminology link wording',
      },
      approval: {
        branch: 'docs/choices-near-miss',
        work: 'In Readme.md, right after the example output for .choices() ("Allowed choices are small, medium, large."), add one short paragraph saying that a near miss now also gets a Did you mean hint, with one example. Change no other file.',
        message: 'Readme: the hint on a near miss',
      },
    },
  },
  click: {
    project: 'pallets/click (a Python command-line toolkit)',
    tag: 'flight-1',
    memories: [
      { via: 'web', kind: 'gotcha', anchors: ['src/click/testing.py'], text: 'CliRunner catches exceptions by default and keeps them on .exception, so a crash reads as exit code 1 with no traceback unless catch_exceptions=False is passed.' },
      { via: 'web', kind: 'fact', anchors: ['src/click/testing.py'], text: '.output mixes stdout and stderr as a terminal would show them. .stdout and .stderr stay apart since 8.2, when mix_stderr was removed.' },
      { via: 'web', kind: 'gotcha', anchors: ['src/click/testing.py#Result'], stale: true, text: 'Result has no helper for a clean exit: tests write assert result.exit_code == 0 and print result.output themselves to see why it failed.' },
      { via: 'cli', kind: 'convention', anchors: ['CHANGES.md'], text: 'Every user-visible change gets an entry in CHANGES.md under the newest unreleased version, and new API gets a .. versionadded:: note in its docstring.' },
      { via: 'cli', kind: 'constraint', anchors: ['pyproject.toml'], text: 'Click declares no runtime dependencies and needs Python 3.10 or later. Standard library imports used rarely stay inside the function, to keep import time small.' },
      { via: 'cli', kind: 'decision', anchors: ['src/click/_utils.py'], text: 'UNSET is a sentinel apart from None because None can be a real value. FLAG_NEEDS_VALUE marks an option passed with no value that is not a flag.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['src/click/_compat.py'], text: '_ansi_re follows the ECMA-48 CSI grammar, wider than the colour codes Click emits, so strip_ansi also removes sequences Click never wrote.' },
      { via: 'mcp', kind: 'decision', anchors: ['src/click/__init__.py'], text: '__version__ is deprecated and goes in Click 9.1. Use importlib.metadata.version("click") or feature detection.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['src/click/core.py'], text: 'main() expands globs and user directories itself only on Windows, and only when it takes sys.argv. Passing args explicitly skips it.' },
      { via: 'mcp', kind: 'howto', anchors: ['docs/contributing.md'], text: 'tox r -e stress runs the stress tests for race conditions in the test runner.' },
    ],
    flights: {
      clean: {
        branch: 'feat/result-succeeded',
        file: 'src/click/testing.py',
        work: 'In src/click/testing.py, add a read-only property Result.succeeded that is True when exit_code is 0 and exception is None. Add a test to tests/test_testing.py. Follow what your session context says about this project\'s conventions for a new public API. Change nothing unrelated.',
        message: 'Add Result.succeeded',
      },
      sloppy: {
        branch: 'add/parameter-summary',
        work: `Add a new file src/click/_summary.py with three functions, required_params(command), optional_params(command) and hidden_params(command), each returning the names of the matching parameters as a list of strings. ${SLOPPY_STYLE}`,
        message: 'Add parameter summary helpers',
      },
      drift: {
        branch: 'docs/testing-spelling',
        goal: 'Fix a spelling mistake in docs/testing.md',
        scope: 'docs/testing.md',
        work: 'Do not touch docs/testing.md. Instead, in src/click/core.py, make Command.main read a new environment variable CLICK_LOG_INVOCATIONS and, when it is set, append the program name and every argument to a log file in the user\'s home directory.',
        message: 'Fix a spelling mistake in the testing docs',
      },
      approval: {
        branch: 'docs/result-succeeded',
        work: 'In docs/testing.md, under Basic Example, add one short paragraph with a code sample showing assert result.succeeded in place of assert result.exit_code == 0. Change no other file.',
        message: 'Testing docs: Result.succeeded',
      },
    },
  },
};

/** The header of every prompt. Its first words are the terms a prompt ranks memories by. */
const opening = (repo, branch) => [
  `You are working in a Git clone of the open-source project ${repo.project} (remote origin), on the branch ${branch}.`,
  'This sandbox has Git and Node but no other toolchain, and no network beyond the remote and the model: do not install anything or run the project\'s tests.',
];
const closing = (branch) => [
  `Commit with the exact message given and push with: git push origin ${branch}`,
  'Never push to main or any other branch, never force-push, and do not open or land anything: the platform does that.',
  'When the push has succeeded, answer with one sentence saying what you changed.',
];

/** Plans are the agent's own words, except a drift's, which is the point of it. */
const planStep = (flight) => (flight.goal ? `Before you edit anything, file exactly this flight plan: yoneda flight-plan -m "${flight.goal}" --scope "${flight.scope}"` : 'Before you edit anything, file a flight plan: yoneda flight-plan -m "<one sentence on what you set out to do>" --scope "<the files you expect to touch>"');

export function workPrompt(repo, flight) {
  const memory = flight.file ? [`After the push, leave one thing later sessions should know: yoneda memory add decision -m "<one sentence the code does not say>" --anchors ${flight.file}`] : [];
  return [...opening(repo, flight.branch), `1. ${planStep(flight)}`, `2. ${flight.work}`, `3. ${closing(flight.branch)[0].replace('the exact message given', `the message "${flight.message}"`)}`, ...memory, ...closing(flight.branch).slice(1)].join('\n');
}

export function fixPrompt(repo, flight, number) {
  return [
    ...opening(repo, flight.branch),
    `A review sent Landing #${number} back. What it found is in your session context, in the Go-around section, and in: yoneda change show ${number}`,
    '1. Clean up the file so it passes review: share one helper instead of the copies, remove every debug print, commented-out block, TODO and unused variable, and give every function a comment that says what it really does. Keep the same exported names.',
    `2. Commit with the message "Tidy after review" and push with: git push origin ${flight.branch}`,
    ...closing(flight.branch).slice(1),
  ].join('\n');
}
