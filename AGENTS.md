# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
make install    # Create .venv, install mkdocs-material + mkdocs-static-i18n
make serve      # Live preview at http://127.0.0.1:8000
make build      # Static site → site/ (en + zh)
make clean      # rm -rf site
```

Always activate venv first for manual commands: `source .venv/bin/activate`

## Architecture

MkDocs Material site with bilingual support via `mkdocs-static-i18n` plugin.

**Key config:** `mkdocs.yml` — i18n plugin config, nav structure, emoji extensions.

**Bilingual convention:**

- English (default): `docs/page.md`
- Chinese: `docs/page.zh.md`
- Both versions must exist for every page listed in `nav`
- Nav labels translated via `nav_translations` in mkdocs.yml

**Content layout:**

- `docs/concepts/` — background knowledge (GPU stack, drivers, HAMi architecture)
- `docs/labs/` — step-by-step lab instructions
- `docs/images/` — screenshots and diagram SVGs referenced by docs
- `docs/stylesheets/extra.css` — HAMi theme color `rgba(16, 208, 93, 1)` + SVG sizing
- `examples/diagrams/` — diagram-design HTML sources (`<slug>.html` + `<slug>-zh.html`)
- `examples/` — numbered lab code/manifests (e.g. `02-local-fake-gpu/fake-gpu-pod.yaml`)

**Diagram convention (diagram-design skill):**

- Diagrams are hand-authored HTML with inline SVG via the `diagram-design` skill, not mermaid
- Sources: `examples/diagrams/<slug>.html` (English) and `<slug>-zh.html` (Chinese, same geometry, translated labels, Noto Sans SC / PingFang SC fallback)
- Export both to `docs/images/<slug>.svg` / `<slug>-zh.svg` with the skill's `export_svg.py` (no PNG export: no Playwright available)
- Reference from docs as `![Title](../images/<slug>.svg)`; zh pages use the `-zh` SVG
- Tokens come from `BRAND.md`: paper `#f5f8fb`, surface `#ffffff`, border `#d5dee8`, heading `#15324d`, muted `#5a748f`, ink-at-opacity `rgba(21,50,77,x)` for bands and eyebrows
- HAMi accent: box stroke `#10d05d`, tint `rgba(16,208,93,0.12)`, green text and arrows `#0a8f3d` (`#10d05d` fails text contrast). Scheduling (kube-scheduler, extender calls) uses indigo `#7c8cff`; observability (DCGM, Prometheus, WebUI) uses blue `#39c6f4`; everything else stays neutral
- Fonts: Space Grotesk (titles), Source Sans 3 (node names, callouts), IBM Plex Mono (sublabels, eyebrows, arrow labels)
- Accent (green) marks at most 2 focal elements per diagram (usually the HAMi components)
- SVGs are light-only; in the slate theme they show as a light card

**Deployment:** Netlify via `netlify.toml`. Build command: `pip install -r requirements.txt && mkdocs build`. Publish dir: `site/`.

## Style Rules

- No em-dashes (—) in any language. Use commas, colons, or periods instead.
- Write natural prose, avoid AI-sounding patterns.
- Diagram labels in English pages stay English, zh pages get fully translated SVGs.
- When adding new labs, create both `.md` and `.zh.md`, add to `examples/NN-lab-name/`, update nav in mkdocs.yml.
