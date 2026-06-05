# HAMi Workshop

HAMi Workshop 是面向 HAMi 的社区学习资源。

欢迎来到 HAMi Workshop！本工作坊将带你从零开始学习 HAMi 在 Kubernetes 上的安装、配置和运维。

## 学习内容

- **概念**，理解 GPU 软件栈、驱动和 HAMi 架构
- **安装**，在真实集群或本地环境部署 HAMi
- **GPU 共享**，跨多个工作负载共享 GPU
- **调度**，通过 binpack/spread 和优先级策略控制 GPU 分配
- **监控**，观察集群内 GPU 使用情况

## 前置条件

- Kubernetes 集群（v1.23+）
- `kubectl` 已配置并连接到集群
- 具有 NVIDIA GPU 的节点（或使用 Fake GPU 进行本地测试）

## 内容导航

### :material-book-open-variant: 概念

HAMi 背景知识。

- [GPU 软件栈全景](concepts/gpu-stack.md)
- [理解 GPU 驱动](concepts/gpu-driver.md)
- [HAMi 集群架构](concepts/hami-architecture.md)

### :material-flask: 实验

动手练习。

- [实验 1: 在线安装 HAMi](labs/online-install.md)，在线环境安装 HAMi
- [实验 2: 本地 Fake GPU 安装](labs/local-fake-gpu.md)，macOS 本地 Fake GPU 环境

## 关于 HAMi

HAMi 是一个 Kubernetes GPU 虚拟化和调度中间件，支持 GPU 共享、显存隔离和细粒度调度。

- [:octicons-mark-github-16: GitHub](https://github.com/Project-HAMi/HAMi){:target="_blank"}，源码与贡献
- [:octicons-globe-16: 官网](https://project-hami.io){:target="_blank"}，文档与社区
