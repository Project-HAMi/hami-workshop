# HAMi Workshop

Hands-on workshop for learning [HAMi](https://github.com/Project-HAMi/HAMi), the GPU virtualization middleware for Kubernetes. Available in [English](https://workshop.project-hami.io/) and [中文](https://workshop.project-hami.io/zh/).

## What You'll Learn

- How the GPU software stack works, from hardware to Kubernetes scheduling
- Installing HAMi on a real GPU cluster or a local fake GPU environment
- GPU sharing, memory isolation, and fine-grained scheduling
- Monitoring GPU utilization across your cluster

## Quick Start

```bash
# Install dependencies
make install

# Preview locally at http://127.0.0.1:8000
make serve

# Build static site
make build
```

Requires Python 3.12+.

## Repository Structure

```
docs/
  concepts/        Background knowledge (GPU stack, drivers, HAMi architecture)
  labs/             Step-by-step lab instructions
  images/           Screenshots
  stylesheets/      Theme overrides
  javascripts/      Mermaid diagram rendering and zoom
examples/           Lab code, manifests, and configs (numbered by lab)
mkdocs.yml          Site configuration, i18n, navigation
```

## Contributing

1. Docs live in `docs/`. English is the default (`page.md`), Chinese uses the `.zh.md` suffix.
2. Both language versions must exist for every page listed in `nav`.
3. Code and manifests go in `examples/`, numbered by lab.
4. Mermaid diagrams use `%% title:` comments for captions.
5. Run `make build` before pushing to verify there are no broken links.

## License

Apache-2.0
