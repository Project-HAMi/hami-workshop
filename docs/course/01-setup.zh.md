# 第 1 章：逐层检查 GPU 软件栈

[:simple-googlecolab: 在 Colab 中打开本章](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/zh/01-setup.ipynb){ .md-button .colab-button target="_blank" }

## 场景

一个小型 AI 团队准备在 Kubernetes 上部署第一个模型，机器上有一张 NVIDIA T4。部署之前，他们想先确认 GPU 在每一层都能正常工作，从硬件和驱动，一直到容器和 Kubernetes。

本章从硬件开始，逐层检查这张 GPU。

## 你将理解

- GPU 从硬件到 Kubernetes Pod 要经过的五层
- 为什么每一层都要用只依赖下一层的工具来检查
- 容器如何访问属于宿主机的 GPU
- 为什么本章结束时 Kubernetes 还不知道这张 GPU 的存在

## 实验环境

本章大约需要 15 分钟。步骤 1 到 4 在 Google Colab 上使用免费的 T4 GPU 运行。步骤 5 在你电脑上的 kind 集群里运行，先按 [安装实验工具](../labs/install-tools.md) 装好工具。

| 组件 | 版本 |
| --- | --- |
| GPU | Tesla T4，15360 MiB |
| NVIDIA 驱动 | 580.82.07（CUDA 13.0） |
| kind（步骤 5） | 0.33.0，Kubernetes v1.37.0 |

于 2026-11-19 在 Colab 上验证。步骤 5 于 2026-11-18 验证。

## 背后的原理：五层，自下而上检查

GPU 要经过五层才能到达 Pod。每一层只能看到下一层暴露出来的东西：

![GPU 软件栈的五层](../images/gpu-stack-zh.svg#only-light)
![GPU 软件栈的五层](../images/gpu-stack-zh-dark.svg#only-dark)

本章的检查遵循两条规则：

- **自下而上检查。** 下层出问题，上面每一层都会跟着出问题。Pod 看不到 GPU，可能是驱动的问题，可能是运行时的问题，也可能是调度的问题。从第 1 层开始，哪一层检查失败，就停在那一层修好它。
- **使用只依赖下一层的检查方式。** PCI 设备列表来自内核，模块列表来自内核，`nvidia-smi` 依赖驱动，所以每一项检查失败都只指向一层。

各层的详细说明见 [GPU 软件栈全景](https://project-hami.io/zh/docs/core-concepts/gpu-stack){:target="_blank"}。

## 步骤 1：第 1 层，硬件

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

PCIe 总线上有没有 NVIDIA GPU？不管有没有加载驱动，内核都会把每个 PCI 设备列在 `/sys/bus/pci/devices` 下面。NVIDIA 的厂商 ID 是 `0x10de`：

```python
!for d in /sys/bus/pci/devices/*; do [ "$(cat $d/vendor)" = "0x10de" ] && echo "$(basename $d) vendor=$(cat $d/vendor) device=$(cat $d/device)"; done
```

```{.text .output}
0000:00:04.0 vendor=0x10de device=0x1eb8
```

一个 NVIDIA 设备，PCI 地址是 `0000:00:04.0`。设备 ID `0x1eb8` 就是 Tesla T4。步骤 3 里的 `Bus-Id` 也是这个地址。

## 步骤 2：第 2 层，内核驱动

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

内核驱动负责管理 GPU 硬件。检查它的模块是否已加载：

```python
!lsmod | grep nvidia
```

```{.text .output}
nvidia_drm            135168  0
drm_kms_helper        188416  1 nvidia_drm
nvidia_modeset       1916928  1 nvidia_drm
nvidia_uvm           1871872  0
nvidia              15151104  7 nvidia_uvm,nvidia_modeset
drm                   679936  4 drm_kms_helper,nvidia,nvidia_drm
i2c_core              102400  3 drm_kms_helper,nvidia,drm
```

`nvidia` 是核心模块，`nvidia_uvm` 提供 CUDA 需要的统一内存。各个模块的说明见 [理解 GPU 驱动](https://project-hami.io/zh/docs/core-concepts/gpu-driver){:target="_blank"}。

驱动以设备文件的形式把 GPU 暴露给用户态，并报告自己的版本：

```python
!ls -l /dev/nvidia*
!cat /proc/driver/nvidia/version
```

```{.text .output}
crw-rw-rw- 1 root root 195,   0 Nov 19 01:53 /dev/nvidia0
crw-rw-rw- 1 root root 195, 255 Nov 19 01:53 /dev/nvidiactl
crw-rw-rw- 1 root root 241,   0 Nov 19 01:53 /dev/nvidia-uvm
crw-rw-rw- 1 root root 241,   1 Nov 19 01:53 /dev/nvidia-uvm-tools

/dev/nvidia-caps:
total 0
cr-------- 1 root root 244, 1 Nov 19 01:53 nvidia-cap1
cr--r--r-- 1 root root 244, 2 Nov 19 01:53 nvidia-cap2
NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.82.07  Release Build  (builder@6528fb22d0ef)  Thu Oct 22 03:48:14 UTC 2026
GCC version:  Selected multilib: .;@m64
```

`/dev/nvidiactl` 是控制设备，`/dev/nvidia0` 是第一张 GPU，`/dev/nvidia-uvm` 属于统一内存模块。内核之上的程序都通过这些文件访问 GPU。

## 步骤 3：第 3 层，用户态库和工具

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

用户态程序通过 NVML（`libnvidia-ml.so`）和 CUDA 驱动库（`libcuda.so`）这类库访问内核模块。`nvidia-smi` 是 NVML 的命令行前端，可以用它检查这一层：

```python
!nvidia-smi
```

```{.text .output}
Thu Nov 19 01:55:12 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 580.82.07              Driver Version: 580.82.07      CUDA Version: 13.0     |
+-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
|=========================================+========================+======================|
|   0  Tesla T4                       Off |   00000000:00:04.0 Off |                    0 |
| N/A   57C    P8             10W /   70W |       0MiB /  15360MiB |      0%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+

+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI              PID   Type   Process name                        GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
|  No running processes found                                                             |
+-----------------------------------------------------------------------------------------+
```

从输出里读出三项信息：

- **Driver Version**：必须和步骤 2 里 `/proc/driver/nvidia/version` 的版本一致。
- **CUDA Version**：这个驱动支持的最高 CUDA 版本。它不代表装了 CUDA toolkit。程序自带 CUDA runtime，驱动只要足够新就行。
- **Memory-Usage**：这张 T4 总共有 15360 MiB。记住这个数字，第 4 章里程序看到的会比它少。

再看一下这些库在哪里：

```python
!find /usr /opt \( -name 'libcuda.so*' -o -name 'libnvidia-ml.so*' \) 2>/dev/null
!which nvidia-smi
```

```{.text .output}
/usr/local/cuda-13.0/targets/x86_64-linux/lib/stubs/libcuda.so
/usr/local/cuda-13.0/targets/x86_64-linux/lib/stubs/libnvidia-ml.so
/usr/local/cuda-13.0/compat/libcuda.so
/usr/local/cuda-13.0/compat/libcuda.so.580.126.20
/usr/local/cuda-13.0/compat/libcuda.so.1
/usr/lib64-nvidia/libnvidia-ml.so.580.82.07
/usr/lib64-nvidia/libcuda.so.1
/usr/lib64-nvidia/libcuda.so.580.82.07
/usr/lib64-nvidia/libcuda.so
/usr/lib64-nvidia/libnvidia-ml.so.1
/usr/lib64-nvidia/libnvidia-ml.so
/opt/bin/nvidia-smi
```

和内核模块版本一致（580.82.07）的库在 `/usr/lib64-nvidia` 里。`/usr/local/cuda-13.0` 下面的几份属于镜像里的 CUDA toolkit：编译程序时用的 stub，以及一个兼容包。这就是步骤 3 要对比版本的原因：程序必须加载和当前驱动匹配的那一套库。

## 步骤 4：第 4 层，容器运行时

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

Colab 的运行环境本身就是一个容器。驱动和它的库属于宿主机，而且必须和宿主机上加载的内核模块版本一致，所以容器镜像里不会包含它们，必须有人把它们从宿主机带进容器。在 Kubernetes 节点上，这件事由 NVIDIA Container Toolkit 完成：当容器通过 `NVIDIA_VISIBLE_DEVICES` 环境变量申请 GPU 时，它把步骤 2 里宿主机的设备文件和步骤 3 里的库挂载进容器。

看看这个容器里挂载了什么：

```python
!env | grep NVIDIA | cut -c1-100
!mount | grep -E 'nvidia|libcuda' | head -n 8
```

```{.text .output}
NVIDIA_VISIBLE_DEVICES=all
NVIDIA_REQUIRE_CUDA=cuda>=13.0 brand=unknown,driver>=535,driver<536 brand=grid,driver>=535,driver<53
NVIDIA_DRIVER_CAPABILITIES=compute,utility
NVIDIA_PRODUCT_NAME=CUDA
/dev/sda1 on /usr/lib64-nvidia type ext4 (rw,nosuid,nodev,relatime,commit=30)
/dev/sda1 on /opt/bin/.nvidia type ext4 (ro,nosuid,nodev,relatime,commit=30)
```

有两点值得注意。`NVIDIA_VISIBLE_DEVICES` 和 `NVIDIA_DRIVER_CAPABILITIES` 正是 NVIDIA Container Toolkit 读取的变量：容器能拿到哪些 GPU，以及驱动的哪些部分，`compute` 指 CUDA 库，`utility` 指 `nvidia-smi` 和 NVML。另外，`/usr/lib64-nvidia` 和 `/opt/bin/.nvidia` 是从宿主机磁盘 `/dev/sda1` 挂载进来的，所以步骤 3 里的驱动库来自宿主机，镜像里并没有。在 Kubernetes 节点上，Toolkit 会为每个申请 GPU 的容器做同样的事。

## 步骤 5：第 5 层，Kubernetes

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

创建一个单节点的 kind 集群：

```bash
kind create cluster --name hami-course
```

kind 会打印创建进度，并把 `kubectl` 切换到新集群。等待节点就绪：

```bash
kubectl wait --for=condition=Ready node --all --timeout=120s
kubectl get nodes
```

```{.text .output}
node/hami-course-control-plane condition met
NAME                        STATUS   ROLES           AGE   VERSION
hami-course-control-plane   Ready    control-plane   21s   v1.37.0
```

看看节点能提供哪些资源用于调度：

```bash
kubectl get node hami-course-control-plane -o jsonpath='{.status.capacity}{"\n"}'
```

```{.text .output}
{"cpu":"8","ephemeral-storage":"73865408512","memory":"8197712Ki","pods":"110"}
```

容量里有 CPU、内存、存储和 Pod 数，但没有 `nvidia.com/gpu`。具体数字取决于你的电脑。这个 kind 节点没有 GPU，但一个真实的 GPU 节点在这个阶段看起来也是这样：第 1 到 4 层都检查通过了，而 kubelet 只上报它知道的资源，还没有任何组件告诉它这张 GPU 的存在。Kubernetes 没法把 Pod 调度到一张它不知道的 GPU 上。第 2 章会加上负责告诉它的那个组件。

## 验证

| 结论 | 证据 |
| --- | --- |
| GPU 在 PCIe 总线上 | 步骤 1：有一个厂商 ID 为 `0x10de` 的设备 |
| 内核驱动接管了 GPU | 步骤 2：`nvidia` 模块已加载，`/dev/nvidia*` 存在 |
| 用户态通过驱动访问到了 GPU | 步骤 3：`nvidia-smi` 显示了 T4，驱动版本和内核模块一致 |
| 宿主机的驱动文件被挂载进了容器 | 步骤 4：`/usr/lib64-nvidia` 和 `/opt/bin/.nvidia` 是从宿主机磁盘挂载进来的 |
| Kubernetes 正常，但不知道 GPU 的存在 | 步骤 5：节点 `Ready`，容量里没有 `nvidia.com/gpu` |

## 常见问题

下面按层列出常见问题。

**Colab：`nvidia-smi: command not found`。** notebook 运行时没有选 GPU。选择 **代码执行程序 → 更改运行时类型 → T4 GPU**，再重新运行。

**第 2 层：`lsmod` 里没有 `nvidia` 模块。** 在你自己的机器上，说明驱动没有加载。查看 `dmesg | grep -i nvidia`。常见原因有：装完驱动没有重启，Secure Boot 拒绝了未签名的模块，系统自带的 `nouveau` 驱动占用了 GPU，或者内核升级后驱动没有重新编译。

**第 3 层：`nvidia-smi` 报 `Driver/library version mismatch`。** 用户态库升级了，但加载的还是旧的内核模块。对比 `/proc/driver/nvidia/version` 和库的版本，然后重启机器或重新加载驱动模块。

**第 4 层：GPU 节点上的容器看不到 GPU。** 没有安装 NVIDIA Container Toolkit，执行 `nvidia-ctk runtime configure` 后没有重启 containerd，或者 `nvidia` 不是默认运行时。

**第 5 层：节点上已经有 `nvidia.com/gpu`。** 已经有 Device Plugin 在运行。用 `kubectl get daemonsets -A` 找到它。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. `nvidia-smi` 在宿主机上能用，在容器里却不能用。缺了哪一层？由谁来补上？"

    第 4 层。容器本身拿不到宿主机的驱动库和 `/dev/nvidia*` 设备文件。容器申请 GPU 时，由 NVIDIA Container Toolkit 把它们挂载进去。

??? question "2. `nvidia-smi` 显示 `CUDA Version: 13.0`，是不是说明装了 CUDA 13.0？"

    不是。这是已安装的驱动支持的最高 CUDA 版本。CUDA runtime 由每个程序或镜像自带，版本不能高于驱动支持的版本。

??? question "3. 为什么要从硬件层开始检查？"

    下层出问题，上面每一层都会跟着出问题。从最底层开始，第一项失败的检查就指出了该修哪一层。

??? question "4. 本章结束时，Pod 能申请 `nvidia.com/gpu: 1` 吗？为什么？"

    不能。还没有任何组件向 kubelet 注册这张 GPU，节点容量里没有 `nvidia.com/gpu`，这样的 Pod 会一直 `Pending`。注册 GPU 是 Device Plugin 的工作，第 2 章会介绍它。

<!-- markdownlint-enable MD046 -->

## 交接

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

选择 **代码执行程序 → 断开连接并删除运行时**，释放这个 Colab 运行时。下一章会打开自己的 notebook，运行在一个全新的运行时上，这一章的内容不会带过去。不断开的运行时会继续消耗你的免费 GPU 时长。

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

保持 kind 集群 `hami-course` 运行，第 2 章会继续使用它。

## 延伸阅读

- [GPU 软件栈全景](https://project-hami.io/zh/docs/core-concepts/gpu-stack){:target="_blank"}：五层的详细说明
- [理解 GPU 驱动](https://project-hami.io/zh/docs/core-concepts/gpu-driver){:target="_blank"}：内核模块、NVML 和自下而上的排障
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/index.html){:target="_blank"}：容器如何访问 GPU
