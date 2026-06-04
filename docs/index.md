# HAMi Workshop

HAMi Workshop is a community learning resource for HAMi. The workshop was initiated by [Dynamia](https://dynamia.ai/) and is maintained as part of the HAMi community.

Welcome to the HAMi Workshop! This hands-on workshop teaches you how to install, configure, and operate HAMi on Kubernetes.

## What You'll Learn

- **Concepts**: Understand GPU software stack, drivers, and HAMi architecture
- **Installation**: Deploy HAMi on real clusters or local environments
- **GPU Sharing**: Share GPUs across multiple workloads
- **Scheduling**: Control GPU placement with binpack/spread and priority policies
- **Monitoring**: Observe GPU utilization across your cluster

## Prerequisites

- Kubernetes cluster (v1.23+)
- `kubectl` configured and connected to your cluster
- Nodes with NVIDIA GPUs (or use our Fake GPU for local testing)

## Workshop Sections

### :material-book-open-variant: Concepts

Background knowledge for understanding HAMi.

- [GPU Software Stack Overview](concepts/gpu-stack.md)
- [Understanding GPU Drivers](concepts/gpu-driver.md)
- [HAMi Cluster Architecture](concepts/hami-architecture.md)

### :material-flask: Labs

Hands-on exercises.

- [Lab 1: Online Installation](labs/online-install.md): Install HAMi on a live cluster.
- [Lab 2: Local Fake GPU Setup](labs/local-fake-gpu.md): Set up HAMi locally on macOS.
- [Lab 3: GPU Partitioning](labs/gpu-partitioning.md): Run multiple Pods on one GPU with enforced VRAM and compute limits.
- [Lab 4: GPU Slicing with DRA](labs/hami-dra.md): Slice GPUs through Kubernetes-native Dynamic Resource Allocation (experimental).

## About HAMi

HAMi is a Kubernetes GPU virtualization and scheduling middleware. It supports GPU sharing, memory isolation, and fine-grained scheduling.

- [:octicons-mark-github-16: GitHub](https://github.com/Project-HAMi/HAMi){:target="_blank"}: Source code and contributions.
- [:octicons-globe-16: Official Website](https://project-hami.io){:target="_blank"}: Documentation and community.
