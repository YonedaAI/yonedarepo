"""Editor-created diagrams grounded in the recorded release evidence."""

from .frames import base, rows, text, MUTED, INK, ACCENT


def concurrency(scene, evidence, target):
    canvas, draw = base(scene, "Measured execution")
    c = evidence["hosted"]["concurrency"]
    starts, ends = c["start_milliseconds"], c["transcript_milliseconds"]
    origin, span = min(starts), max(ends)-min(starts)
    for i, (name, color) in enumerate([
        ("Luna / editorial approach", "#5bb5e5"),
        ("Sonnet / community noticeboard", "#68c3a4"),
    ]):
        y = 245+i*210
        text(draw, name, (92, y), size=39, bold=True)
        left = 92+(starts[i]-origin)/span*1720
        right = 92+(ends[i]-origin)/span*1720
        draw.rounded_rectangle((left, y+74, right, y+140), radius=12, fill=color)
    text(draw, "87.117 seconds of overlapping harness execution", (92, 750),
         size=47, bold=True, width=72)
    text(draw, "Measured from harness_running to trusted transcript registration.",
         (92, 855), size=30, fill=MUTED, width=95)
    canvas.save(target, quality=95)


def diagram(scene, kind, evidence, target):
    if kind == "concurrency":
        return concurrency(scene, evidence, target)
    if kind == "finding":
        records = evidence["hosted"]["run"]["context_records"]
        finding = next(record for record in records
                       if record["id"] == "finding:garden-filter-browser-review")
        canvas, draw = base(scene, "Recorded finding / evidence excerpt")
        text(draw, "Earlier HTML and anchor checks passed", (92, 190),
             size=40, bold=True, width=80)
        text(draw, finding["data"]["statement"], (92, 285),
             size=36, width=83)
        text(draw, "Included in the next approved run", (92, 585),
             size=40, bold=True, width=80)
        text(draw, finding["id"], (92, 660), size=32, fill=ACCENT, width=90)
        text(draw, "Owner-recorded assertion. Actual browser transitions follow.",
             (92, 805), size=31, fill=MUTED, width=95)
        canvas.save(target, quality=95)
        return
    cards = {
        "mcp": [
            ("Fresh local Codex process", "No preceding conversation supplied"),
            ("Scoped MCP reads", "Intent, context, source history, decision and check artifact"),
            ("Finds a stale assumption", "Static acceptance scope did not include membership signup"),
            ("Isolated Git fork and source capture", "An independently checked follow-up changes the copy"),
            ("Awaiting owner review", "0e9551767 is eligible; the earlier publication stays live"),
        ],
        "architecture": [
            ("Browser / local agent", "Authenticated Worker, scoped MCP and Git"),
            ("Rust + Repo Durable Object", "SQLite authority: state, graph, events and outbox commit together"),
            ("Queues + isolated Containers", "Separate coding, fresh capture, evaluation and publication capabilities"),
            ("Artifacts + R2", "Canonical Git and isolated forks; evidence and static manifests"),
            ("D1 / Live projections + Sites Worker", "Discovery and refresh hints; isolated static website hosting"),
        ],
        "deployment": [
            ("1. Provision your Cloudflare resources", "Workers Paid, Artifacts access, D1, R2, Queues and required secrets"),
            ("2. Generate account-specific configuration", "cargo xtask cloudflare-configure --name my-cloudflare ..."),
            ("3. Inspect the dry run", "cargo xtask cloudflare-deploy --name my-cloudflare --dry-run"),
            ("4. Deploy and initialize the starter", "cargo xtask cloudflare-deploy --name my-cloudflare"),
            ("Local checks need no paid inference", "cargo xtask doctor   /   cargo xtask check   /   README prerequisites"),
        ],
        "scope": [
            ("Live evidence", "Luna and Sonnet completed concurrent work and verified publication"),
            ("Gemini", "Native CLI and scoped Rust MCP passed an offline fixture; paid acceptance pending"),
            ("Current publication target", "Static websites hosted through the isolated Sites Worker"),
            ("Future work", "Full-stack hosting, automatic semantic merge and clarification pause/resume"),
        ],
        "links": [
            ("Try YonedaRepo", "yonedarepo-dev.mlong-f01.workers.dev"),
            ("Source / Apache-2.0", "github.com/MagnetonIO/yonedarepo"),
            ("Run it locally or deploy your own", "README: setup, checks, resource provisioning and deployment commands"),
            ("AI presenter and voice", "Actual product captures and recorded run evidence; edited walkthrough"),
        ],
    }
    if kind not in cards:
        raise ValueError(f"Unknown diagram: {kind}")
    rows(scene, cards[kind], target,
         "Try it / source" if kind == "links" else "Architecture / evidence")
