// The paths and shell scripts AgentSandbox runs inside the sandbox. Every script takes its
// values as positional arguments (never interpolated), so a brief or path cannot become shell.
// The background-task, probe and CA handling come from Cloudflare's "Build a coding agent
// runner" and "Run background processes" pages.
export const repositoryDirectory = '/workspace/repo';
export const taskDirectory = '/workspace/task';
export const eventsPath = `${taskDirectory}/stdout.log`;
export const stderrPath = `${taskDirectory}/stderr.log`;
export const exitCodePath = `${taskDirectory}/exit-code`;
export const pidPath = `${taskDirectory}/pid`;

const caPath = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
/** The CA alone replaces the system trust store; SandboxOutbound intercepts every request. */
export const trustEnv = {
  NODE_EXTRA_CA_CERTS: caPath,
  GIT_SSL_CAINFO: caPath,
  CURL_CA_BUNDLE: caPath,
  SSL_CERT_FILE: caPath,
};

/** Runs the command in its own process group; records its process ID and then its exit code. */
export const taskScript = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;
/** Succeeds while the process in the file runs and started in this instance. */
export const taskRunningScript = `read -r pid boot <"$1" &&
	[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
	kill -0 "$pid"`;
/** The safety cap: the whole process group gets SIGTERM, then SIGKILL. */
export const stopScript = `read -r pid boot <"$1" || exit 0
kill -TERM -"$pid" 2>/dev/null; sleep 5; kill -KILL -"$pid" 2>/dev/null; exit 0`;
/** `origin repo base dir`: the platform repository on a real disk at the frozen base. */
export const cloneScript = `set -e
git clone --quiet "yoneda::$1/$2" "$4"
git -C "$4" checkout --quiet --detach "$3"`;
/**
 * `dir base message branch`: one commit on the frozen base, whatever the agent committed
 * itself, force-pushed to the attempt branch (a retry replaces it); hooks never run.
 */
export const pushScript = `set -e
cd "$1"
git reset --quiet --soft "$2"
git add -A
if git diff --cached --quiet "$2"; then echo unchanged; exit 0; fi
git -c core.hooksPath=/dev/null -c user.name="YonedaRepo agent" -c user.email=agent@yonedarepo.invalid commit --quiet --no-verify -m "$3"
git -c core.hooksPath=/dev/null push --quiet --no-verify --force origin "HEAD:refs/heads/$4"
echo pushed`;
