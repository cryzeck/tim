#!/usr/bin/env python3
"""Assemble the single-file game from src/.

Outputs:
  index.html     standalone document (open it directly in a browser)
  artifact.html  the same page without the document skeleton (for hosting)
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"

IMPORTMAP = """<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/",
    "cannon-es": "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js"
  }
}
</script>"""


def main():
    head = (SRC / "head.html").read_text()
    body = (SRC / "body.html").read_text()
    js = "\n".join(p.read_text() for p in sorted((SRC / "js").glob("*.js")))
    script = f'<script type="module">\n{js}\n</script>'
    content = f"{head}\n{body}\n{IMPORTMAP}\n{script}\n"
    (ROOT / "artifact.html").write_text(content)
    standalone = (
        '<!doctype html>\n<html lang="nb">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        f"{head}\n</head>\n<body>\n{body}\n{IMPORTMAP}\n{script}\n</body>\n</html>\n"
    )
    (ROOT / "index.html").write_text(standalone)
    print(f"built: {len(standalone)//1024} KB, {js.count(chr(10))} lines of JS")


if __name__ == "__main__":
    main()
