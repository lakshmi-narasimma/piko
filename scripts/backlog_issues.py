"""Print issues for one backlog phase as JSON: [{title, labels, body}]."""
import json, re, sys

path, phase = sys.argv[1], sys.argv[2]  # e.g. docs/BACKLOG.md P0
text = open(path).read()
tasks = re.findall(
    r"^- \[ \] \*\*(" + phase + r"-\d+) (.+?)\*\* · (.+?) · ([SML])\n((?:  .*\n?)+)",
    text, re.M)
out = []
for tid, name, labels, size, body in tasks:
    lines = [l[2:] if l.startswith("  ") else l for l in body.rstrip().splitlines()]
    body_md = "\n".join(lines) + f"\n\n**Size:** {size}\n\nFrom [docs/BACKLOG.md](../blob/main/docs/BACKLOG.md)."
    out.append({"title": f"{tid} {name}",
                "labels": re.findall(r"`(\w+)`", labels),
                "body": body_md})
print(json.dumps(out, indent=1))
