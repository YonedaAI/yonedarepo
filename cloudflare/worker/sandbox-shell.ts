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
/** A check sandbox's checkout, and where each command's output goes. */
export const checkDirectory = '/workspace/check';
export const checkOutputDirectory = '/workspace/check-output';
/** Bytes kept from the end of each command's stdout and stderr. */
export const checkTailBytes = 65_536;
/**
 * `dir out seconds argv...`: one policy command as the evaluator container runs it: in the
 * repository root, environment cleared, stdin closed, in its own process group that is killed
 * at its timeout and after it exits. Prints `exit <code> <stdout bytes> <stderr bytes>` or
 * `timeout <stdout bytes> <stderr bytes>`.
 */
export const checkScript = `dir=$1 out=$2 secs=$3; shift 3
rm -rf "$out" && mkdir -p "$out" /home/agent || exit 2
cd "$dir" || exit 2
setsid env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/agent TMPDIR=/tmp \\
	YONEDA_TEST_BUNDLE=/opt/yoneda/test-bundle "$@" >"$out/stdout" 2>"$out/stderr" </dev/null &
pid=$!
( sleep "$secs"; : >"$out/timeout"; kill -KILL -"$pid" 2>/dev/null ) &
watch=$!
wait "$pid"; code=$?
kill "$watch" 2>/dev/null
kill -KILL -"$pid" 2>/dev/null
o=$(wc -c <"$out/stdout"); e=$(wc -c <"$out/stderr")
if [ -e "$out/timeout" ]; then echo "timeout $o $e"; else echo "exit $code $o $e"; fi`;
/** `dir`: the checkout's HEAD commit and tree, one per line. */
export const revisionScript = `git -C "$1" rev-parse HEAD 'HEAD^{tree}'`;
/**
 * `node -e siteScript <checkout> <static dir>`: the static output as the evaluator captures it
 * (regular files only, no links followed, at most 500 files and 8 MiB, index.html required),
 * printed as `{"files":{path:{content,executable[,encoding]}}}` or `{"error":<diagnostic>}`.
 */
export const siteScript = `const fs=require('node:fs');
const [root,dir]=process.argv.slice(1);
const safe=(p)=>typeof p==='string'&&p.length<=512&&/^[A-Za-z0-9/._-]+$/.test(p)&&!p.split('/').some((s)=>s===''||s==='.'||s==='..');
const fail=(stage,code,path,errno)=>{process.stdout.write(JSON.stringify({error:{version:1,stage,code,path:safe(path)?path:null,errno:errno??null}}));process.exit(0);};
if(!safe(dir))fail('path','UNSAFE_PATH',null);
const parts=dir.split('/');
for(let i=1;i<=parts.length;i++){const rel=parts.slice(0,i).join('/');let st;try{st=fs.lstatSync(root+'/'+rel);}catch(e){fail('walk','IO',rel,Math.abs(e.errno??0)||null);}if(!st.isDirectory())fail('entry','UNSAFE_TYPE',rel);}
const files={};let bytes=0,count=0;
const walk=(rel)=>{let entries;try{entries=fs.readdirSync(root+'/'+rel,{withFileTypes:true});}catch(e){fail('walk','IO',rel,Math.abs(e.errno??0)||null);}
for(const entry of entries){const path=rel+'/'+entry.name;
if(entry.isDirectory()){walk(path);continue;}
if(!entry.isFile())fail('entry','UNSAFE_TYPE',path);
if(!safe(path))fail('workspace','WORKSPACE_LIMIT',dir);
const executable=(fs.lstatSync(root+'/'+path).mode&0o111)!==0;const data=fs.readFileSync(root+'/'+path);
bytes+=data.length;count+=1;if(bytes>8*1024*1024||count>500)fail('limits','WORKSPACE_LIMIT',path);
let file;try{file={content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data),executable};}catch{file={content:data.toString('base64'),executable,encoding:'base64'};}
files[path.slice(dir.length+1)]=file;}};
walk(dir);
if(!files['index.html'])fail('index','MISSING_INDEX',dir+'/index.html');
process.stdout.write(JSON.stringify({files}));`;
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
/**
 * `pushScript`'s arguments, for a team member's resumed work: HEAD keeps its history (the
 * agent's merge of the team branch), so its resolution lands as a merge, not a re-conflict.
 * Whatever is left, a pending merge included, is committed first.
 */
export const historyPushScript = `set -e
cd "$1"
git add -A
if ! git diff --cached --quiet HEAD || [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
	git -c core.hooksPath=/dev/null -c user.name="YonedaRepo agent" -c user.email=agent@yonedarepo.invalid commit --quiet --no-verify -m "$3"
fi
git -c core.hooksPath=/dev/null push --quiet --no-verify --force origin "HEAD:refs/heads/$4"
echo pushed`;
/** `dir branch`: the team branch as `origin/<branch>`, for the agent to merge. */
export const fetchScript = `git -C "$1" fetch --quiet origin "+refs/heads/$2:refs/remotes/origin/$2"`;
