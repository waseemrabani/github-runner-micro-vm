"""Architecture overview diagram -> docs/architecture-overview.svg (+ .png)

Hand-placed layout with orthogonal (right-angle) connectors. Every component
is a plain coloured tile with a short text tag - no third-party icons or
logos - so the SVG is self-contained, renders on GitHub, and is safe to ship
in a public repository. Python standard library only - no Graphviz.

Regenerate after changing the architecture:

    python3 docs/diagrams/architecture_overview.py
    # PNG (2x) via any Chromium:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \\
      --hide-scrollbars --force-device-scale-factor=2 --window-size=1800,1060 \\
      --screenshot="$PWD/docs/architecture-overview.png" "file://$PWD/docs/architecture-overview.svg"

Coordinates are in SVG pixels on an 1800 x 1060 canvas. Tiles are placed by
centre; connectors are listed as polyline points so every bend is explicit.
"""

from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "architecture-overview.svg"

W, H = 1800, 1060
FONT = "'Amazon Ember', 'Helvetica Neue', Helvetica, Arial, sans-serif"
INK = "#232f3e"        # AWS squid ink: request path
MUTED = "#545b64"
TELEMETRY = "#1a73e8"
DEPLOY = "#7d8998"
PINK = "#e7157b"

parts = []


def add(s):
    parts.append(s)


def text(x, y, s, size=12, weight="normal", anchor="middle", color=INK, halo=False, italic=False):
    halo_attr = ' stroke="#ffffff" stroke-width="4" paint-order="stroke" stroke-linejoin="round"' if halo else ""
    style = ' font-style="italic"' if italic else ""
    add(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" '
        f'fill="{color}"{halo_attr}{style}>{escape(s)}</text>')


# kind -> (tag shown in the tile, tile colour). Colours follow AWS's
# category palette; GitHub/Docker tiles use neutral and blue.
TILES = {
    "actions": ("Actions", "#24292f"),
    "github": ("GitHub", "#24292f"),
    "api-gateway": ("API GW", "#8c4fff"),
    "lambda": ("Lambda", "#ed7100"),
    "microvm": ("MicroVM", "#ed7100"),
    "sqs": ("SQS", "#e7157b"),
    "ssm": ("SSM", "#dd344c"),
    "iam": ("IAM", "#dd344c"),
    "image": ("Image", "#3f8624"),
    "docker": ("Docker", "#1d63ed"),
    "logs": ("Logs", "#e7157b"),
    "metrics": ("Metrics", "#e7157b"),
    "alarm": ("Alarms", "#e7157b"),
    "sns": ("SNS", "#e7157b"),
    "s3": ("S3", "#3f8624"),
    "cloudformation": ("CFN", "#e7157b"),
}


def icon(cx, cy, kind, lines, size=64, label="below"):
    """A coloured tile tagged with the component type, then a bold first
    label line and regular following lines."""
    tag, colour = TILES[kind]
    add(f'<rect x="{cx - size / 2}" y="{cy - size / 2}" width="{size}" height="{size}" rx="10" fill="{colour}"/>')
    text(cx, cy + 4.5, tag, size=12 if size >= 56 else 10.5, weight="bold", color="#ffffff")
    if label == "below":
        y = cy + size / 2 + 16
        for i, line in enumerate(lines):
            text(cx, y + i * 14, line, size=12, weight="bold" if i == 0 else "normal")
    else:  # right
        x = cx + size / 2 + 12
        y = cy - (len(lines) - 1) * 7 + 4
        for i, line in enumerate(lines):
            text(x, y + i * 14, line, size=12, weight="bold" if i == 0 else "normal", anchor="start")


def group(x, y, w, h, title, stroke, fill="none", dashed=False):
    dash = ' stroke-dasharray="6 4"' if dashed else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{dash}/>')
    add(f'<rect x="{x}" y="{y}" width="{len(title) * 7.4 + 22}" height="24" rx="6" fill="{stroke}"/>')
    text(x + 11, y + 16, title, size=12.5, weight="bold", anchor="start", color="#ffffff")


MARKERS = {INK: "a-ink", TELEMETRY: "a-blue", MUTED: "a-muted", DEPLOY: "a-deploy", PINK: "a-pink"}


def connector(points, color=INK, width=2.0, dashed=False, both=False, head=True):
    d = "M" + " L".join(f"{x},{y}" for x, y in points)
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    end = f' marker-end="url(#{MARKERS[color]})"' if head else ""
    start = f' marker-start="url(#{MARKERS[color]})"' if both else ""
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linejoin="round"{dash}{end}{start}/>')


def badge(x, y, n):
    add(f'<circle cx="{x}" cy="{y}" r="11" fill="{INK}" stroke="#ffffff" stroke-width="2"/>')
    text(x, y + 4.5, str(n), size=12, weight="bold", color="#ffffff")


# ── canvas ──────────────────────────────────────────────────────────────────
add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}">')
add("<title>GitHub ephemeral runners on AWS Lambda MicroVMs - architecture overview</title>")
add("<defs>")
for color, mid in MARKERS.items():
    add(f'<marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{color}"/></marker>')
add("</defs>")
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(30, 48, "GitHub ephemeral runners on AWS Lambda MicroVMs", size=24, weight="bold", anchor="start")
text(30, 74, "One workflow job → one single-use MicroVM, chosen by a runner-profile label "
     "(arm64 | x86_64 × plain | Docker × small | medium | large).", size=13, anchor="start", color=MUTED)

# ── groups ──────────────────────────────────────────────────────────────────
group(30, 110, 240, 600, "GitHub", "#57606a", fill="#f6f8fa")
group(300, 110, 1470, 920, "AWS Cloud · one Region", INK)
group(1110, 250, 640, 440, "AWS Lambda MicroVMs", "#ed7100", fill="#fff8f1")
group(1130, 300, 250, 370, "Runner profile images", "#ed7100", fill="#ffffff", dashed=True)
group(640, 760, 1110, 250, "Observability", PINK, fill="#fdf2f8")
group(315, 760, 285, 250, "Deploy time", DEPLOY, fill="#f7f8f9", dashed=True)

# ── GitHub ──────────────────────────────────────────────────────────────────
icon(150, 190, "actions", ["Workflow job", "runs-on: [self-hosted,", "mvm-x64-docker-medium]"])
icon(150, 450, "github", ["GitHub App", "webhook + REST API"])

# ── request path, main row (y = 450) ────────────────────────────────────────
icon(400, 450, "api-gateway", ["API Gateway", "HTTP API", "POST /webhook"])
icon(590, 450, "lambda", ["Orchestrator", "Lambda", "verify HMAC,", "pick profile"])
icon(780, 450, "sqs", ["SQS", "work queue"])
icon(970, 450, "lambda", ["Worker", "Lambda", "mint JIT config,", "RunMicrovm"])

icon(470, 650, "ssm", ["SSM Parameter Store", "webhook secret,", "GitHub App key"], size=56)
icon(780, 650, "sqs", ["Dead-letter queue"], size=56)

# ── MicroVMs ────────────────────────────────────────────────────────────────
for cy, name, l1, l2 in (
    (365, "image", "arm64 · plain", "small | medium | large"),
    (445, "image", "x86_64 · plain", "small | medium | large"),
    (525, "docker", "arm64 · Docker", "medium | large"),
    (605, "docker", "x86_64 · Docker", "medium | large"),
):
    icon(1172, cy, name, [l1, l2], size=48, label="right")
icon(1530, 450, "microvm", ["Running MicroVM", "one job, then", "TerminateMicrovm"])
icon(1680, 450, "iam", ["Execution role", "self-terminate,", "logs + metrics"], size=56)

# ── observability ───────────────────────────────────────────────────────────
icon(800, 870, "logs", ["CloudWatch Logs", "Lambdas + one stream", "per runner"])
icon(1150, 870, "metrics", ["CloudWatch metrics", "+ dashboard", "per profile"])
icon(1400, 870, "alarm", ["CloudWatch alarms", "DLQ · backlog · failures", "unroutable · slow start"])
icon(1640, 870, "sns", ["SNS topic", "email · Slack ·", "PagerDuty"])

# ── deploy time ─────────────────────────────────────────────────────────────
icon(385, 870, "s3", ["S3 code bucket", "content-hashed", "zips"], size=56)
icon(525, 870, "cloudformation", ["CloudFormation", "4 stacks; builds", "one image/profile"], size=56)

# ── connectors: request path ────────────────────────────────────────────────
connector([(150, 296), (150, 412)], color=MUTED, dashed=True)                     # job queued
text(142, 360, "job queued", size=11, anchor="end", color=MUTED, italic=True)

connector([(188, 450), (364, 450)])                                                 # 1
badge(232, 450, 1)
text(300, 438, "workflow_job webhook", size=11, halo=True)
connector([(432, 450), (556, 450)])                                                 # 2
badge(494, 450, 2)
text(494, 432, "invoke", size=11, halo=True)
connector([(622, 450), (746, 450)])                                                 # 3
badge(684, 450, 3)
text(684, 432, "enqueue", size=11, halo=True)
connector([(812, 450), (936, 450)])                                                 # 4
badge(874, 450, 4)
text(874, 432, "poll", size=11, halo=True)

connector([(970, 412), (970, 330), (175, 330), (175, 414)], both=True)              # 5
badge(560, 330, 5)
text(560, 318, "App JWT → installation token → JIT runner config", size=11, halo=True)

connector([(1002, 450), (1128, 450)])                                               # 6
badge(1065, 450, 6)
text(1065, 432, "RunMicrovm", size=11, halo=True)
text(1058, 476, "<Project>-<profile>", size=10.5, halo=True, color=MUTED)

connector([(1380, 450), (1494, 450)], color=MUTED, dashed=True)                     # snapshot -> VM
text(1437, 436, "resume from", size=11, halo=True, color=MUTED, italic=True)
text(1437, 470, "snapshot", size=11, halo=True, color=MUTED, italic=True)

connector([(1530, 410), (1530, 200), (186, 200)])                                   # 7
badge(860, 200, 7)
text(860, 188, "runner registers with GitHub (JIT) and runs exactly one job", size=11, halo=True)

connector([(1562, 450), (1648, 450)], color=MUTED, dashed=True, head=False)         # assumes role
text(1606, 440, "assumes", size=10.5, halo=True, color=MUTED, italic=True)

connector([(570, 550), (570, 650), (502, 650)], color=MUTED, dashed=True)          # read secrets
text(562, 600, "read secrets", size=11, anchor="end", color=MUTED, italic=True, halo=True)
connector([(780, 524), (780, 618)], color=PINK, dashed=True)                       # DLQ
text(788, 570, "after 3 failed", size=11, anchor="start", color=PINK, italic=True, halo=True)
text(788, 584, "launches", size=11, anchor="start", color=PINK, italic=True, halo=True)

# ── connectors: telemetry ───────────────────────────────────────────────────
connector([(612, 550), (612, 870), (764, 870)], color=TELEMETRY, width=1.6, dashed=True)          # orchestrator
text(620, 740, "logs + EMF", size=11, anchor="start", color=TELEMETRY, halo=True)
connector([(970, 550), (970, 790), (800, 790), (800, 834)], color=TELEMETRY, width=1.6, dashed=True)  # worker
text(978, 740, "logs + EMF", size=11, anchor="start", color=TELEMETRY, halo=True)
connector([(1530, 536), (1530, 790), (1170, 790), (1170, 834)], color=TELEMETRY, width=1.6, dashed=True)  # 8 VM
badge(1530, 610, 8)
text(1546, 606, "VM log stream,", size=11, anchor="start", color=TELEMETRY, halo=True)
text(1546, 620, "job_summary +", size=11, anchor="start", color=TELEMETRY, halo=True)
text(1546, 634, "PutMetricData", size=11, anchor="start", color=TELEMETRY, halo=True)
connector([(836, 870), (1114, 870)], color=TELEMETRY, width=1.6, dashed=True)
text(975, 860, "metrics extracted", size=11, color=TELEMETRY, halo=True)
connector([(1186, 870), (1364, 870)], color=TELEMETRY, width=1.6, dashed=True)
connector([(1436, 870), (1604, 870)], color=TELEMETRY, width=1.6, dashed=True)
text(1520, 860, "notify", size=11, color=TELEMETRY, halo=True)

# ── connectors: deploy ──────────────────────────────────────────────────────
connector([(413, 870), (497, 870)], color=DEPLOY, dashed=True)

# ── legend ──────────────────────────────────────────────────────────────────
lx, ly = 30, 730
add(f'<rect x="{lx}" y="{ly}" width="240" height="300" rx="6" fill="#ffffff" stroke="#d5dbdb"/>')
text(lx + 14, ly + 26, "Runtime flow", size=13, weight="bold", anchor="start")
steps = [
    "Signed workflow_job webhook",
    "Verify HMAC, pick runner profile",
    "Enqueue runner request",
    "Worker polls (3 tries → DLQ)",
    "GitHub App mints JIT config",
    "RunMicrovm on profile image",
    "Runner registers, runs 1 job",
    "Logs + metrics → alarms",
]
for i, s in enumerate(steps, start=1):
    y = ly + 34 + i * 24
    badge(lx + 24, y - 4, i)
    text(lx + 42, y, s, size=11.5, anchor="start")
y = ly + 34 + 9 * 24 + 6
add(f'<line x1="{lx + 14}" y1="{y}" x2="{lx + 44}" y2="{y}" stroke="{INK}" stroke-width="2"/>')
text(lx + 52, y + 4, "request path", size=11, anchor="start", color=MUTED)
add(f'<line x1="{lx + 14}" y1="{y + 18}" x2="{lx + 44}" y2="{y + 18}" stroke="{TELEMETRY}" '
    f'stroke-width="1.6" stroke-dasharray="6 5"/>')
text(lx + 52, y + 22, "telemetry", size=11, anchor="start", color=MUTED)

add("</svg>")
OUT.write_text("\n".join(parts) + "\n")
print(f"wrote {OUT.relative_to(HERE.parent.parent)} ({OUT.stat().st_size // 1024} KB)")
