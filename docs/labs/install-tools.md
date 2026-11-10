# Install the lab tools

Every lab needs `kind`, `kubectl`, `helm`, `jq` and `git`, plus a container runtime.

## Container runtime

- **macOS:** Docker Desktop, OrbStack or Colima. Give the VM 4 CPU and 8 GB.
- **Linux:** Docker Engine or Podman.

`docker info` must work before you start.

### macOS: native containers do not work

kind needs a Linux VM that runs Docker. The native macOS container runtimes (Apple `container`, and Docker Desktop's or Colima's options that run each container in its own lightweight VM) have no Docker daemon for kind and no shared Kubernetes node, so `kind create cluster` fails. Use a VM-backed Docker instead, on Apple silicon all lab images are arm64-native, no emulation is needed:

```bash
# Colima
colima start --cpu 4 --memory 8 --vm-type vz
# OrbStack: Settings, System, 4 CPU and 8 GB
# Docker Desktop: Settings, Resources, 4 CPU and 8 GB
docker context ls   # the active context must point at that VM
```

## Before you join: pull once

Conference Wi-Fi cannot serve 30 laptops pulling the same images. Pull everything listed under "Before the session" in your lab at home, once. The setup scripts load what you already have into kind and only pull what is missing. Do not delete the cluster and images between labs, `docker image prune` or `colima delete` throws the downloads away.

## Homebrew

[Homebrew](https://brew.sh) works on macOS and on Linux.

```bash
brew install kind kubectl helm jq git
```

## mise, when kind cannot be installed another way

Use [mise](https://mise.jdx.dev) when you have no Homebrew and no root, for example on a locked-down laptop or a shared Linux host. It installs the tools into your home directory.

```bash
curl https://mise.run | sh
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc   # zsh: ~/.zshrc and "activate zsh"
exec $SHELL
mise use -g kind kubectl helm jq
```

## Check

```bash
kind version && kubectl version --client && helm version && jq --version
```

The labs are tested with kind 0.33, kubectl 1.37 and helm 4.3. Older minor versions usually work.
