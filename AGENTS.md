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

**Key config:** `mkdocs.yml` — i18n plugin config, nav structure, mermaid superfences, emoji extensions.

**Bilingual convention:**

- English (default): `docs/page.md`
- Chinese: `docs/page.zh.md`
- Both versions must exist for every page listed in `nav`
- Nav labels translated via `nav_translations` in mkdocs.yml

**Content layout:**

- `docs/concepts/` — background knowledge (GPU stack, drivers, HAMi architecture)
- `docs/labs/` — step-by-step lab instructions
- `docs/images/` — screenshots referenced by labs
- `docs/stylesheets/extra.css` — HAMi theme color `rgba(16, 208, 93, 1)` + mermaid figure styling
- `docs/javascripts/mermaid-zoom.js` — custom mermaid renderer with click-to-zoom lightbox, figure captions from `%% title:` comments
- `examples/` — numbered lab code/manifests (e.g. `02-local-fake-gpu/fake-gpu-pod.yaml`)

**Mermaid diagram convention:**

- Title configured as first-line comment: `%% title: Diagram Title Here`
- JS extracts title, shows as `<figcaption>` below diagram and in lightbox overlay
- SVG forced full-width via CSS override on `.md-typeset .mermaid-figure` (material defaults to `width: fit-content`)

**Deployment:** Netlify via `netlify.toml`. Build command: `pip install -r requirements.txt && mkdocs build`. Publish dir: `site/`.

## Style Rules

- No em-dashes (—) in any language. Use commas, colons, or periods instead.
- Write natural prose, avoid AI-sounding patterns.
- All mermaid diagrams must have `%% title:` comments.
- When adding new labs, create both `.md` and `.zh.md`, add to `examples/NN-lab-name/`, update nav in mkdocs.yml.
