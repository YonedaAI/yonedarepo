// What demo-repos.mjs puts on each kept repository: memories that are true of the project (checked
// against its source), and one real feature per project, built by one stock agent over several
// Landings. Oldest first: a session's start packet is the 8 newest memories, so the oldest reach an
// agent when it reads their file, and `stale: true` marks the one the first Landing makes untrue.
//
// `trap` is memory-traps.mjs's proof: a rule the repository's files and history do not show, in one
// memory, and made up for this: the task's natural answer breaks it. `oracle` reads the diff.
// `sloppy` and `drift` flights are deliberate: the prompt tells a real agent to write the slop, or
// to work off its plan, so the review agents read something real. Everything else is real work.
import { TRAPS } from './memory-traps.mjs';

const trapOf = (id) => TRAPS.find((t) => t.id === id);

/** Who flies: what launches it (demo-repos-run.mjs) and how it is priced, dollars per million. */
export const AGENTS_BY_KIND = {
  glm: { harness: 'opencode', label: 'GLM 5.3 on opencode', model: 'zai-coding-plan/glm-5.3', rates: null },
  mimo: { harness: 'opencode', label: 'MiMo V2.6 Flash on opencode', model: 'yoneda/mimo-v2.6-flash', rates: { input: 0.14, cache_read: 0.14, output: 0.28 } },
  codex: { harness: 'codex', label: 'GPT-5.6 Luna on Codex', model: 'gpt-5.6-luna', rates: { input: 0.2, cache_read: 0.02, output: 1.2 } },
  claude: { harness: 'claude', label: 'Sonnet 5.5 on Claude Code', model: 'claude-sonnet-5-5', rates: null },
};

const SLOPPY_STYLE = [
  'This is a throwaway prototype, so write it badly on purpose, exactly like this, and do not tidy it:',
  '- Copy and paste the same loop into every function instead of sharing a helper.',
  '- Put a debug print at the top of every function and another inside every loop.',
  '- Leave a block of commented-out older code in every function.',
  '- Put a comment saying TODO: fix this later in every function.',
  '- Add a variable in every function that nothing uses.',
  '- Give every function a comment that describes something else entirely, for example that it returns the tax on an order.',
].join('\n');

/** Slop reads the worst finding, so a sure go-around also needs something a reviewer calls serious. */
const WORSE_STYLE = [
  SLOPPY_STYLE,
  '- Wrap the whole body of every function in a block that catches every error and ignores it, then return a made-up constant, so a caller cannot tell it failed.',
  '- Do not write any tests.',
].join('\n');

export const REPOS = {
  cobra: {
    project: 'spf13/cobra (a Go library for command-line tools)',
    agent: 'glm',
    feature: 'Near-miss hints for positional arguments and flags',
    order: ['clean', 'sloppy', 'fix', 'drift', 'approvals', 'approval'],
    memories: [
      { via: 'web', kind: 'gotcha', anchors: ['args.go'], text: 'legacyArgs checks subcommand names on the root command only. Below the root, with Args unset, a mistyped subcommand reaches Run as an ordinary positional instead of an unknown command error.' },
      { via: 'web', kind: 'decision', anchors: ['args.go'], text: 'args_test.go compares the validators\' messages as exact strings, so rewording one means changing its expected text as well.' },
      { via: 'web', kind: 'gotcha', anchors: ['args.go'], stale: true, text: 'OnlyValidArgs asks for a suggestion with args[0], not the value it rejected. With two or more arguments the Did you mean hint can point at the wrong word.' },
      { via: 'cli', kind: 'fact', anchors: ['command.go'], text: 'SuggestionsFor looks at subcommand names and their SuggestFor lists only. ValidArgs are never considered, so a command with no subcommands gets no hint.' },
      { via: 'cli', kind: 'constraint', anchors: ['go.mod'], text: 'go.mod says go 1.15, so generics and the predeclared any do not compile here. Use interface{} and plain helpers, as the rest of the package does.' },
      { via: 'cli', kind: 'decision', anchors: ['doc/'], text: 'doc/ is the Go package that generates man, Markdown, ReST and YAML docs from a command tree. The written guides are in site/content.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['bash_completionsV2.go'], text: 'The V2 bash script is one fmt.Sprintf template, so a literal percent sign has to be written %% or the generated script breaks.' },
      { via: 'mcp', kind: 'howto', anchors: ['Makefile'], text: 'make test runs go test over ./... after install_deps, make lint runs golangci-lint, make fmt only checks gofmt.' },
      { via: 'mcp', kind: 'risk', anchors: ['flag_groups.go'], text: 'Flag groups live in pflag annotations as one space-joined string, split on spaces again at validation, so a flag name holding a space breaks its group.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['command_win.go'], text: 'preExecHook runs only on Windows builds, and command_notwin.go leaves preExecHookFn nil. Trying the mousetrap message on another system proves nothing.' },
      { via: 'mcp', trapOf: 'frozen-file', ...trapOf('frozen-file').memory, anchors: ['command.go'] },
    ],
    flights: {
      clean: {
        want: 'landed',
        proof: 'frozen-file',
        branch: 'feat/hint-valid-args',
        file: 'args.go',
        work: 'Near-miss hints, part 1. OnlyValidArgs in args.go builds its "Did you mean this?" hint with findSuggestions(args[0]), which looks at subcommands only and uses the first argument even when a later one was rejected. Add an exported method SuggestionsForArg(typed string) []string on Command: it returns the entries of ValidArgs, without any tab-separated description, that start with typed or are within SuggestionsMinimumDistance edits of it (default 2, as findSuggestions does), ignoring case. Make OnlyValidArgs use it for the value it rejected, in the same "Did you mean this?" format, keeping the subcommand hints as well. Add tests to args_test.go.',
        message: 'Suggest valid arguments on a near miss',
        oracle(paths, added) {
          const go = paths.filter((p) => p.endsWith('.go') && !p.endsWith('_test.go') && !p.includes('/'));
          return { done: go.some((p) => added[p]?.some((l) => /func\s*\(\s*\w*\s*\*Command\s*\)\s*SuggestionsForArg\s*\(/.test(l))), avoided: !paths.includes('command.go') };
        },
      },
      sloppy: {
        want: 'go_around',
        branch: 'feat/hint-flags',
        work: `Near-miss hints, part 2. Add a new file flag_suggestions.go in package cobra with three exported methods on *Command: SuggestionsForFlag(typed string) []string (the long names of c.Flags() close to typed), SuggestionsForPersistentFlag(typed string) []string (the same for c.PersistentFlags()) and SuggestionsForInheritedFlag(typed string) []string (the same for c.InheritedFlags()). ${SLOPPY_STYLE}`,
        message: 'Add flag name suggestions',
        fix: 'Then add flag_suggestions_test.go with a test for each method.',
      },
      drift: {
        want: 'go_around',
        branch: 'docs/noargs-wording',
        goal: 'Fix a wording mistake in the NoArgs doc comment in args.go',
        scope: 'args.go',
        work: 'Do not touch args.go. Instead, in cobra.go, add an exported function CheckErrCode(msg interface{}, code int) that prints msg to stderr and exits with code, read a default exit code from a new environment variable COBRA_EXIT_CODE, and change CheckErr to call CheckErrCode.',
        message: 'Fix the NoArgs doc comment',
      },
      approval: {
        want: 'hold',
        branch: 'docs/near-miss-hints',
        work: 'Near-miss hints, part 3. In site/content/user_guide.md, in the part about positional arguments, add a short section on the new hints: SuggestionsForArg with ValidArgs, and the three flag name suggestion methods in flag_suggestions.go, with one small example. Change no other file.',
        message: 'User guide: near-miss hints',
      },
    },
  },
  commander: {
    project: 'tj/commander.js (a Node.js command-line parser)',
    agent: 'mimo',
    feature: 'Near-miss hints for choices and excess arguments, with an off switch',
    order: ['clean', 'sloppy', 'fix', 'sloppy2', 'fix2', 'drift', 'approvals', 'approval'],
    memories: [
      { via: 'web', kind: 'gotcha', anchors: ['lib/argument.js'], text: '_collectValue starts a new array while the previous value is still the default, so a variadic default is replaced by the first value, not added to.' },
      { via: 'web', kind: 'fact', anchors: ['lib/option.js'], text: 'A list passed to .choices() is copied with slice, so changing the caller\'s array afterwards has no effect.' },
      { via: 'web', kind: 'gotcha', anchors: ['lib/argument.js#Argument::choices'], stale: true, text: 'A value outside .choices() gets only "Allowed choices are a, b." Unknown options and commands get a Did you mean hint, but choices do not.' },
      { via: 'cli', kind: 'decision', anchors: ['lib/suggestSimilar.js'], text: 'suggestSimilar skips one-character candidates and needs more than 40% similarity, so short names seldom get a hint. Its answer starts with a newline.' },
      { via: 'cli', kind: 'constraint', anchors: ['CHANGELOG.md'], text: 'Do not edit CHANGELOG.md or the version number in a change. Maintainers do both when preparing a release (CONTRIBUTING.md).' },
      { via: 'cli', kind: 'constraint', anchors: ['package.json'], text: 'Commander is ESM only ("type": "module") and needs Node 22.12 or later. No require() and no CommonJS build.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['lib/command.js#Command::_exit'], text: '_exit calls the exitOverride callback, then process.exit. Code after a call to it runs only when the callback returns, which it is not expected to do.' },
      { via: 'mcp', kind: 'howto', anchors: ['tests/'], text: 'npm test runs node --test and the TypeScript checks, npm run check adds lint and format. Tests use node:test with createTestCommand from tests/testHelpers.js.' },
      { via: 'mcp', kind: 'decision', anchors: ['lib/command.js'], text: 'storeOptionsAsProperties must be called before any option is added or set: it throws otherwise, because it changes where every value is kept.' },
      { via: 'mcp', kind: 'convention', anchors: ['typings/index.d.ts'], text: 'The public API has its types in typings/index.d.ts, checked by tsd against typings/index.test-d.ts, so a new public method touches both.' },
      { via: 'mcp', trapOf: 'env-prefix', kind: trapOf('env-prefix').memory.kind, text: trapOf('env-prefix').memory.text, anchors: ['lib/suggestSimilar.js'] },
    ],
    flights: {
      clean: {
        want: 'landed',
        proof: 'env-prefix',
        branch: 'feat/hint-on-choices',
        file: 'lib/argument.js',
        work: 'Near-miss hints, part 1. When a value is outside .choices(), Option and Argument throw "Allowed choices are a, b." with no hint. In lib/option.js and lib/argument.js, append the result of suggestSimilar(arg, this.argChoices) to that message, so a near miss reads like the hints for unknown options. Also add an environment variable that turns every near-miss hint off: when it is set to a non-empty value, suggestSimilar returns an empty string. Choose a name for the variable. Add tests to tests/argument.choices.test.js and tests/options.choices.test.js, and one for the variable.',
        message: 'Add near-miss hints to choices, with an off switch',
        oracle: trapOf('env-prefix').oracle,
      },
      sloppy: {
        want: 'go_around',
        branch: 'feat/hint-excess-args',
        work: `Near-miss hints, part 2. Add a new file lib/nearMiss.js exporting three functions: excessArgumentHint(command, arg) (a subcommand name close to arg), aliasHint(command, arg) (a subcommand alias close to arg) and optionHint(command, arg) (a long option close to arg), each returning a hint string or an empty string. ${SLOPPY_STYLE}`,
        message: 'Add hints for excess arguments',
        fix: 'Then call excessArgumentHint from Command._excessArguments in lib/command.js, so the error about too many arguments ends with the hint, and add tests/nearMiss.test.js.',
      },
      sloppy2: {
        want: 'go_around',
        branch: 'feat/hint-tables',
        work: `Near-miss hints, part 3. Add a new file lib/hintTable.js exporting six functions, commandHints(command), optionHints(command), argumentHints(command), aliasHints(command), choiceHints(option) and envHints(option), each returning an array of { name, hint } for the matching items. ${WORSE_STYLE}`,
        message: 'Add hint tables',
        fix: 'Handle errors properly instead of ignoring them, and add tests/hintTable.test.js.',
      },
      drift: {
        want: 'go_around',
        branch: 'docs/terminology-link',
        goal: 'Fix the wording of the terminology link in Readme.md',
        scope: 'Readme.md',
        work: 'Do not touch Readme.md. Instead, in lib/command.js, add a new environment variable TRACE_OPTIONS: when it is set, parseOptions writes every parsed option name and value to the file that variable names.',
        message: 'Fix the terminology link wording',
      },
      approval: {
        want: 'hold',
        branch: 'docs/near-miss-hints',
        work: 'Near-miss hints, part 3. In Readme.md, right after the example output for .choices() ("Allowed choices are small, medium, large."), add one short paragraph saying that a near miss also gets a Did you mean hint, with one example, and how the environment variable from part 1 turns hints off. Change no other file.',
        message: 'Readme: near-miss hints',
      },
    },
  },
  click: {
    project: 'pallets/click (a Python command-line toolkit)',
    agent: 'codex',
    feature: 'Configuration files for options, by Codex; near-miss hints for Choice, by Claude Code',
    order: ['clean', 'sloppy', 'fix', 'config', 'sloppy2', 'fix2', 'config2', 'suggest', 'suggest2', 'drift', 'approvals', 'approval'],
    memories: [
      { via: 'web', kind: 'gotcha', anchors: ['src/click/types.py'], text: 'ParamType.fail raises BadParameter with the parameter and context attached, so a type never builds the usage error itself.' },
      { via: 'web', kind: 'fact', anchors: ['src/click/types.py'], text: 'Choice compares normalized values and keeps the original choices for its answer, so a message has to show what the user can really type.' },
      { via: 'web', kind: 'gotcha', anchors: ['src/click/testing.py'], text: 'CliRunner catches exceptions by default and keeps them on .exception, so a crash reads as exit code 1 with no traceback unless catch_exceptions=False is passed.' },
      { via: 'web', kind: 'fact', anchors: ['src/click/testing.py'], text: '.output mixes stdout and stderr as a terminal would show them. .stdout and .stderr stay apart since 8.2, when mix_stderr was removed.' },
      { via: 'web', kind: 'gotcha', anchors: ['src/click/exceptions.py'], stale: true, text: 'There is no exception for a configuration file that cannot be loaded: callers raise ClickException or BadParameter and get the usual exit code.' },
      { via: 'cli', kind: 'convention', anchors: ['CHANGES.md'], text: 'Every user-visible change gets an entry in CHANGES.md under the newest unreleased version, and new API gets a .. versionadded:: note in its docstring.' },
      { via: 'cli', kind: 'constraint', anchors: ['pyproject.toml'], text: 'Click declares no runtime dependencies and needs Python 3.10 or later. Standard library imports used rarely stay inside the function, to keep import time small.' },
      { via: 'cli', kind: 'decision', anchors: ['src/click/_utils.py'], text: 'UNSET is a sentinel apart from None because None can be a real value. FLAG_NEEDS_VALUE marks an option passed with no value that is not a flag.' },
      { via: 'mcp', kind: 'gotcha', anchors: ['src/click/_compat.py'], text: '_ansi_re follows the ECMA-48 CSI grammar, wider than the colour codes Click emits, so strip_ansi also removes sequences Click never wrote.' },
      { via: 'mcp', kind: 'decision', anchors: ['src/click/__init__.py'], text: '__version__ is deprecated and goes in Click 9.1. Use importlib.metadata.version("click") or feature detection.' },
      { via: 'mcp', kind: 'howto', anchors: ['docs/contributing.md'], text: 'tox r -e stress runs the stress tests for race conditions in the test runner.' },
      { via: 'mcp', trapOf: 'exit-code', kind: trapOf('exit-code').memory.kind, text: trapOf('exit-code').memory.text, anchors: ['src/click/exceptions.py'] },
    ],
    flights: {
      clean: {
        want: 'landed',
        proof: 'exit-code',
        branch: 'feat/config-file-error',
        work: `Configuration files, part 1. ${trapOf('exit-code').task} Add tests in tests/test_exceptions/test_ConfigFileError.py.`,
        message: 'Add ConfigFileError',
        oracle: trapOf('exit-code').oracle,
      },
      sloppy: {
        want: 'go_around',
        branch: 'feat/config-loaders',
        work: `Configuration files, part 2. Add a new file src/click/_config.py with three functions: load_json_config(path), load_toml_config(path) and load_ini_config(path). Each reads the file and returns a dict, and raises ConfigFileError with the filename when it cannot be read or parsed. ${SLOPPY_STYLE}`,
        message: 'Add configuration file loaders',
        fix: 'Then add tests/test_config_loaders.py with a test for each loader, including a broken file.',
      },
      sloppy2: {
        want: 'go_around',
        branch: 'feat/config-report',
        work: `Configuration files, part 4. Add a new file src/click/_config_report.py with six functions, describe_json_config(path), describe_toml_config(path), describe_ini_config(path), list_json_keys(path), list_toml_keys(path) and list_ini_keys(path), using the loaders in src/click/_config.py. ${WORSE_STYLE}`,
        message: 'Add configuration reports',
        fix: 'Handle errors properly instead of ignoring them, and add tests/test_config_report.py.',
      },
      config: {
        want: 'landed',
        branch: 'feat/config-file-option',
        work: 'Configuration files, part 3. Add a decorator click.config_file_option(*param_decls, **kwargs) in src/click/decorators.py, next to version_option: an eager option, --config PATH by default, not exposed to the callback, whose own callback picks the loader from src/click/_config.py by file extension and sets ctx.default_map from the file. Export it from src/click/__init__.py. Add tests/test_config_file_option.py, using CliRunner with a real file: a value from the file becomes the default, the command line wins over it, and a broken file exits with the code of ConfigFileError.',
        message: 'Add config_file_option',
      },
      // Slop's run on the first push failed, and only a new push asks for another.
      config2: {
        want: 'landed',
        continues: true,
        branch: 'feat/config-file-option',
        work: 'Configuration files, part 3, continued. Add one more test to tests/test_config_file_option.py: a file that does not exist exits with the code of ConfigFileError and names the file. Change nothing else.',
        message: 'Test config_file_option with a missing file',
      },
      suggest: {
        agent: 'claude',
        want: 'landed',
        branch: 'feat/choice-near-miss',
        file: 'src/click/types.py',
        work: 'Near-miss hints for Choice, part 1. When Choice.convert rejects a value, the message says "\'x\' is not one of \'a\', \'b\'." with no hint. When a choice is close to the value, add a "Did you mean" hint to that message, using difflib.get_close_matches, and show the choice as the user can type it. Import difflib inside the function. Add tests to tests/test_types/test_Choice.py.',
        message: 'Choice: add a Did you mean hint',
      },
      suggest2: {
        agent: 'claude',
        want: 'landed',
        branch: 'feat/choice-hint-setting',
        work: 'Near-miss hints for Choice, part 2. Add a keyword argument suggest: bool = True to Choice, so a parameter can turn the hint off, keep it in to_info_dict, and describe it in docs/parameter-types.md. Add tests to tests/test_types/test_Choice.py.',
        message: 'Choice: let a parameter turn the hint off',
      },
      drift: {
        want: 'go_around',
        branch: 'docs/testing-spelling',
        goal: 'Fix a spelling mistake in docs/testing.md',
        scope: 'docs/testing.md',
        work: 'Do not touch docs/testing.md. Instead, in src/click/core.py, make Command.main read a new environment variable CLICK_LOG_INVOCATIONS and, when it is set, append the program name and every argument to a log file in the user\'s home directory.',
        message: 'Fix a spelling mistake in the testing docs',
      },
      approval: {
        want: 'hold',
        branch: 'docs/config-files',
        work: 'Configuration files, part 5. In docs/commands.md, after the part about Context.default_map, add a short section "Loading defaults from a file" on config_file_option, with one TOML example and what happens with a broken file. Change no other file.',
        message: 'Docs: loading defaults from a file',
      },
    },
  },
};

/** The header of every prompt. */
const opening = (repo, branch) => [
  `You are working in a Git clone of the open-source project ${repo.project} (remote origin), on the branch ${branch}.`,
  'This sandbox has Git and Node but no other toolchain, and no network beyond the remote and the model: do not install anything or run the project\'s tests.',
  'Tools: this clone\'s remote is YonedaRepo. Your session context holds memories other sessions left, what recent sessions did, open changes and the landing rules. Read it before you start. When you read a file you may be shown more memories about it.',
];
const closing = (branch) => [
  'Never push to main or any other branch, never force-push, and do not open or land anything: the platform does that.',
  'When the push has succeeded, answer in two sentences: what you changed, and which rule from your session context shaped it, if any.',
];

/** Plans are the agent's own words, except a drift's, which is the point of it. */
const planStep = (flight) => (flight.goal ? `Before you edit anything, file exactly this flight plan: yoneda flight-plan -m "${flight.goal}" --scope "${flight.scope}"` : 'Before you edit anything, file a flight plan: yoneda flight-plan -m "<one sentence on what you set out to do>" --scope "<the files you expect to touch>"');

export function workPrompt(repo, flight) {
  const memory = flight.file ? [`4. After the push, leave one thing later sessions should know: yoneda memory add decision -m "<one sentence the code does not say>" --anchors ${flight.file}`] : [];
  return [...opening(repo, flight.branch), `1. ${planStep(flight)}`, `2. ${flight.work}`, `3. Commit with the message "${flight.message}" and push with: git push origin ${flight.branch}`, ...memory, ...closing(flight.branch)].join('\n');
}

export function fixPrompt(repo, flight, number) {
  return [
    ...opening(repo, flight.branch),
    `A review found problems in Landing #${number}. What it found is in: yoneda change show ${number}`,
    `1. Clean up the code so it passes review: share one helper instead of the copies, remove every debug print, commented-out block, TODO and unused variable, and give every function a comment that says what it really does. Keep the same exported names. ${flight.fix ?? ''}`.trim(),
    `2. Commit with the message "Tidy after review" and push with: git push origin ${flight.branch}`,
    ...closing(flight.branch),
  ].join('\n');
}
