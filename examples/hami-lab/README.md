# HAMi lab files

Lab guide: [docs/labs/hami-lab.md](../../docs/labs/hami-lab.md). Runs on a laptop, no GPU needed.

- `setup.sh`: kind + HAMi 2.11 + mock device plugin + two fake A100-40GB + hami-mock-monitor
- `fake-gpus.json`: the `hami.io/node-nvidia-register` annotation
- `share.yaml`, `too-big.yaml`: Lab 2
- `binpack.yaml`, `spread.yaml`, `mutex.yaml`: Lab 3
- `sim.yaml`, `metrics.sh`: wrap-up metrics
- `monitoring.yaml`, `webui-rules.yaml`: optional HAMi WebUI
- `diagrams/*.pdg`: [predictygraph](https://pypi.org/project/predictygraph/) sources for the figures. Render with `make diagrams`.
