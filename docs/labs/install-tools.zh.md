# 安装实验工具

所有实验都需要 `kind`、`kubectl`、`helm`、`jq`、`git`，以及一个容器运行时。

## 容器运行时

- **macOS：** Docker Desktop、OrbStack 或 Colima，给虚拟机分配 4 CPU 和 8 GB 内存。
- **Linux：** Docker Engine 或 Podman。

开始前确认 `docker info` 能正常执行。

### macOS：原生容器不可用

kind 需要一台运行 Docker 的 Linux 虚拟机。macOS 原生容器运行时（Apple `container`，以及 Docker Desktop、Colima 中每个容器单独一个轻量虚拟机的选项）没有可供 kind 使用的 Docker 守护进程，也没有共享的 Kubernetes 节点，`kind create cluster` 会失败。请改用基于虚拟机的 Docker。Apple 芯片上所有实验镜像都有 arm64 原生版本，无需模拟：

```bash
# Colima
colima start --cpu 4 --memory 8 --vm-type vz
# OrbStack：Settings，System，4 CPU、8 GB
# Docker Desktop：Settings，Resources，4 CPU、8 GB
docker context ls   # 当前 context 必须指向该虚拟机
```

## 参加前：只拉取一次

会场 Wi-Fi 撑不住 30 台笔记本同时拉取同一批镜像。请在家里把实验"准备"一节列出的镜像拉取一次。安装脚本会把本地已有的镜像加载进 kind，只拉取缺少的。实验之间不要删除集群和镜像，`docker image prune` 或 `colima delete` 会把下载的内容丢掉。

## Homebrew

[Homebrew](https://brew.sh) 支持 macOS 和 Linux。

```bash
brew install kind kubectl helm jq git
```

## 无法用其他方式安装 kind 时：mise

没有 Homebrew、也没有 root 权限时（例如受管控的笔记本或共享的 Linux 主机），用 [mise](https://mise.jdx.dev)。它把工具装在你的 home 目录下。

```bash
curl https://mise.run | sh
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc   # zsh 用 ~/.zshrc 和 "activate zsh"
exec $SHELL
mise use -g kind kubectl helm jq
```

## 检查

```bash
kind version && kubectl version --client && helm version && jq --version
```

实验在 kind 0.33、kubectl 1.37、helm 4.3 上测试通过，较旧的小版本一般也能用。
