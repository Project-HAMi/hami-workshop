# ContainerDays 2026 Singapore lab files

Lab guide: [docs/labs/containerdays-singapore.md](../../docs/labs/containerdays-singapore.md)

Workshop: From Zero to Shared GPUs, October 27 2026, 12:30 to 13:15 (45 min). Runs on a laptop, no GPU needed.

- `setup.sh`: kind + HAMi 2.10 + mock device plugin + two fake A100-40GB + hami-mock-monitor
- `fake-gpus.json`: the `hami.io/node-nvidia-register` annotation
- `share.yaml`, `too-big.yaml`: Lab 2
- `binpack.yaml`, `spread.yaml`: Lab 3
- `sim.yaml`, `metrics.sh`: wrap-up metrics
- `monitoring.yaml`, `webui-rules.yaml`: optional HAMi WebUI after the session
- `diagrams/`: SVG sources for the three figures on the lab page, edited via [diagram-design](https://github.com/anthropics/claude-code) conventions; rendered copies live in `docs/images/`
