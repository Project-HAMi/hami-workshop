"""Turn a course or lab page into a Colab notebook.

Usage: python3 notebooks/page2nb.py docs/course/04-enter-hami.md notebooks/en/04-enter-hami.ipynb

The page is the source. python fences become code cells, the text fence that
follows a python fence (expected output) is dropped, prose becomes markdown
cells, ??? admonitions become <details>, HTML comments are dropped, links to
other pages and images point to the published site, and dark-only images are
left out.
"""
import json, os, re, sys

src, dst = sys.argv[1], sys.argv[2]
# The buttons at the top of a page link to this very notebook or to the kind setup, so they are left out.
lines = [l for l in open(src, encoding="utf-8").read().splitlines() if ".md-button" not in l]

cells, buf = [], []
last_lang = None
ROOT = "https://workshop.project-hami.io/"
SITE = ROOT + ("zh/" if src.endswith(".zh.md") else "")

def site_links(text):
    text = "\n".join(l for l in text.splitlines() if "#only-dark)" not in l)
    text = re.sub(r"\]\(\.\./images/([\w.-]+?)(#only-light)?\)", lambda m: f"]({ROOT}images/{m.group(1)})", text)
    # links to other pages, relative to this page -> the published site
    def page_url(m):
        target = os.path.normpath(os.path.join(os.path.dirname(src), m.group(1)))
        rel = os.path.relpath(target, "docs")[:-3]
        rel = "" if rel == "index" else rel[:-len("index")] if rel.endswith("/index") else rel + "/"
        return f"]({SITE}{rel}{m.group(2) or ''})"
    return re.sub(r"\]\(((?:\.\./)*[\w/-]+\.md)(#[\w-]+)?\)", page_url, text)

def flush_md():
    text = "\n".join(buf).strip("\n")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S).strip("\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = site_links(text)
    text = re.sub(r"^\{:[^}]*\}\n", "", text, flags=re.M)  # block attr_list lines
    text = re.sub(r"\{:[^}]*\}", "", text)  # MkDocs attr_list, unknown to Colab
    text = re.sub(r":(?:material|simple)-[\w-]+: ", "", text)  # MkDocs icons
    text = text.strip("\n")
    if text:
        cells.append({"cell_type": "markdown", "metadata": {}, "source": text})
    buf.clear()

i = 0
while i < len(lines):
    line = lines[i]
    m = re.match(r"^```(?:\{\.(\w+)[^}]*\}|(\w*))", line)
    if m:
        lang = m.group(1) or m.group(2)
        body = []
        i += 1
        while not lines[i].startswith("```"):
            body.append(lines[i])
            i += 1
        i += 1
        prev, last_lang = last_lang, lang
        if lang == "python":
            flush_md()
            cells.append({"cell_type": "code", "metadata": {}, "execution_count": None,
                          "outputs": [], "source": "\n".join(body)})
        elif lang != "text" or prev != "python":
            buf.append(f"```{lang}")
            buf.extend(body)
            buf.append("```")
        continue
    q = re.match(r'^\?\?\? \w+ "(.*)"$', line)
    if q:
        body = []
        i += 1
        while i < len(lines) and (lines[i].startswith("    ") or lines[i] == ""):
            body.append(lines[i][4:])
            i += 1
        buf.append(f"<details><summary>{q.group(1)}</summary>\n")
        buf.append("\n".join(body).strip("\n"))
        buf.append("\n</details>\n")
        continue
    if line.startswith("## "):
        flush_md()
    buf.append(line)
    i += 1
flush_md()

nb = {"cells": cells,
      "metadata": {"accelerator": "GPU", "colab": {"gpuType": "T4", "provenance": []},
                   "kernelspec": {"display_name": "Python 3", "name": "python3"},
                   "language_info": {"name": "python"}},
      "nbformat": 4, "nbformat_minor": 0}
json.dump(nb, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{dst}: {len(cells)} cells, {sum(c['cell_type'] == 'code' for c in cells)} code")
