# Chapter 1: Check the GPU Stack Layer by Layer

[:simple-googlecolab: Open this chapter in Colab](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/en/01-setup.ipynb){ .md-button .colab-button target="_blank" }

## Scenario

A small AI team is about to deploy its first model on Kubernetes, on a machine with one NVIDIA T4. Before deploying anything, they want to make sure the GPU works at every level, from the hardware and the driver up to the container and Kubernetes.

In this chapter you check the GPU one layer at a time, starting from the hardware.

## What You'll Understand

- The five layers a GPU passes through on its way from the hardware to a Kubernetes Pod
- Why each layer is checked with a tool that depends only on the layer below
- How a container gets access to a GPU that belongs to the host
- Why Kubernetes does not know about the GPU at the end of this chapter

## Environment

This chapter takes about 15 minutes. Steps 1 to 4 run on Google Colab with the free T4 GPU. Step 5 runs on your laptop in a kind cluster. Install the tools first, see [Install the lab tools](../labs/install-tools.md).

| Component | Version |
| --- | --- |
| GPU | Tesla T4, 15360 MiB |
| NVIDIA driver | 580.82.07 (CUDA 13.0) |
| kind (Step 5) | 0.33.0, Kubernetes v1.37.0 |

Verified on Colab on 2026-11-19. Step 5 verified on 2026-11-18.

## The Principle: Five Layers, Checked Bottom Up

A GPU reaches a Pod through five layers. Each layer only sees what the layer below exposes:

![The five layers of the GPU software stack](../images/gpu-stack.svg#only-light)
![The five layers of the GPU software stack](../images/gpu-stack-dark.svg#only-dark)

The checks in this chapter follow two rules:

- **Check from the bottom up.** A failure at a lower layer also breaks every layer above it. A Pod that cannot see its GPU may have a driver problem, a runtime problem, or a scheduling problem. Start with Layer 1, and when a layer fails, stop there and fix it.
- **Use a check that depends only on the layer below.** The PCI device list comes from the kernel, the module list from the kernel, and `nvidia-smi` from the driver, so each failed check points to one layer.

The layers are described in more detail in [GPU Software Stack Overview](https://project-hami.io/docs/core-concepts/gpu-stack){:target="_blank"}.

## Step 1: Layer 1, Hardware

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Is there an NVIDIA GPU on the PCIe bus? The kernel lists every PCI device under `/sys/bus/pci/devices`, whether a driver is loaded or not. NVIDIA's vendor ID is `0x10de`:

```python
!for d in /sys/bus/pci/devices/*; do [ "$(cat $d/vendor)" = "0x10de" ] && echo "$(basename $d) vendor=$(cat $d/vendor) device=$(cat $d/device)"; done
```

```{.text .output}
0000:00:04.0 vendor=0x10de device=0x1eb8
```

One NVIDIA device, at PCI address `0000:00:04.0`. Device ID `0x1eb8` is the Tesla T4. Step 3 shows the same address as the `Bus-Id`.

## Step 2: Layer 2, Kernel Driver

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

The kernel driver manages the GPU hardware. Check that its modules are loaded:

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

`nvidia` is the core module, and `nvidia_uvm` provides the unified memory that CUDA needs. The modules are explained in [Understanding GPU Drivers](https://project-hami.io/docs/core-concepts/gpu-driver){:target="_blank"}.

The driver exposes the GPU to user space as device files, and reports its own version:

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

`/dev/nvidiactl` is the control device, `/dev/nvidia0` is the first GPU, and `/dev/nvidia-uvm` belongs to the unified memory module. Programs above the kernel reach the GPU through these files.

## Step 3: Layer 3, User-Space Libraries and Tools

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

User-space programs reach the kernel module through libraries such as NVML (`libnvidia-ml.so`) and the CUDA driver library (`libcuda.so`). `nvidia-smi` is a command-line front end for NVML, so it checks this layer:

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

Read three things from this output:

- **Driver Version**: must match the version in `/proc/driver/nvidia/version` from Step 2.
- **CUDA Version**: the highest CUDA version this driver supports. It does not mean a CUDA toolkit is installed. Programs bring their own CUDA runtime, and the driver only has to be new enough for it.
- **Memory-Usage**: this T4 has 15360 MiB in total. Note the number. In Chapter 4, a program sees less than this.

Then check where the libraries live:

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

The libraries that match the kernel module, version 580.82.07, are in `/usr/lib64-nvidia`. The copies under `/usr/local/cuda-13.0` belong to the CUDA toolkit in the image: stubs used when building programs, and a compatibility package. This is why Step 3 compares versions: a program must load the libraries that match the loaded driver.

## Step 4: Layer 4, Container Runtime

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

The Colab runtime is itself a container. The driver and its libraries belong to the host, and they must match the kernel module loaded there, so container images do not include them. Something has to bring them from the host into the container. On a Kubernetes node, that is the NVIDIA Container Toolkit: when a container asks for GPUs through the `NVIDIA_VISIBLE_DEVICES` environment variable, it mounts the host's device files from Step 2 and libraries from Step 3 into the container.

Look at what was mounted into this container:

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

Two things stand out. `NVIDIA_VISIBLE_DEVICES` and `NVIDIA_DRIVER_CAPABILITIES` are the variables the NVIDIA Container Toolkit reads: which GPUs a container gets, and which parts of the driver, where `compute` means the CUDA libraries and `utility` means `nvidia-smi` and NVML. And `/usr/lib64-nvidia` and `/opt/bin/.nvidia` are mounted from the host disk `/dev/sda1`, so the driver libraries from Step 3 come from the host. The image brings none of its own. On a Kubernetes node, the Toolkit does the same for every container that asks for a GPU.

## Step 5: Layer 5, Kubernetes

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Create a kind cluster with one node:

```bash
kind create cluster --name hami-course
```

kind prints its progress and switches `kubectl` to the new cluster. Wait for the node to become ready:

```bash
kubectl wait --for=condition=Ready node --all --timeout=120s
kubectl get nodes
```

```{.text .output}
node/hami-course-control-plane condition met
NAME                        STATUS   ROLES           AGE   VERSION
hami-course-control-plane   Ready    control-plane   21s   v1.37.0
```

Look at what the node offers for scheduling:

```bash
kubectl get node hami-course-control-plane -o jsonpath='{.status.capacity}{"\n"}'
```

```{.text .output}
{"cpu":"8","ephemeral-storage":"73865408512","memory":"8197712Ki","pods":"110"}
```

The capacity lists CPU, memory, storage, and Pods, but no `nvidia.com/gpu`. Your numbers depend on your laptop. This kind node has no GPU, but a real GPU node would look the same at this point: Layers 1 to 4 pass their checks, and the kubelet only reports resources it knows about. Nothing has told it about the GPU yet. Kubernetes cannot schedule a Pod onto a GPU it does not know about. Chapter 2 adds the piece that tells it.

## Verify

| Claim | Evidence |
| --- | --- |
| The GPU is on the PCIe bus | Step 1: a device with vendor `0x10de` |
| The kernel driver owns the GPU | Step 2: `nvidia` modules loaded, `/dev/nvidia*` present |
| User space reaches the GPU through the driver | Step 3: `nvidia-smi` shows the T4, and its driver version matches the kernel module |
| The host's driver files are mounted into the container | Step 4: `/usr/lib64-nvidia` and `/opt/bin/.nvidia` are mounted from the host disk |
| Kubernetes is healthy but does not know about the GPU | Step 5: node `Ready`, no `nvidia.com/gpu` in capacity |

## Common Pitfalls

The pitfalls below are grouped by layer.

**Colab: `nvidia-smi: command not found`.** The notebook runs without a GPU. Choose **Runtime → Change runtime type → T4 GPU** and run the cells again.

**Layer 2: `lsmod` shows no `nvidia` module.** On your own machine, the driver is not loaded. Check `dmesg | grep -i nvidia`. Common causes are a missing reboot after installing the driver, Secure Boot rejecting the unsigned module, the inbox `nouveau` driver holding the GPU, or a kernel upgrade the driver was not rebuilt for.

**Layer 3: `nvidia-smi` reports `Driver/library version mismatch`.** The user-space libraries were upgraded but the old kernel module is still loaded. Compare `/proc/driver/nvidia/version` with the libraries, then reboot the machine or reload the driver modules.

**Layer 4: a container on a GPU node cannot see the GPU.** The NVIDIA Container Toolkit is missing, containerd was not restarted after `nvidia-ctk runtime configure`, or `nvidia` is not the default runtime.

**Layer 5: the node already has `nvidia.com/gpu`.** A device plugin is already running. Find it with `kubectl get daemonsets -A`.

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. `nvidia-smi` works on a host, but not inside a container. Which layer is missing, and what fills it?"

    Layer 4. A container does not get the host's driver libraries or `/dev/nvidia*` device files by itself. The NVIDIA Container Toolkit mounts them when a container asks for GPUs.

??? question "2. `nvidia-smi` shows `CUDA Version: 13.0`. Does that mean CUDA 13.0 is installed?"

    No. It is the highest CUDA version the installed driver supports. The CUDA runtime comes with each program or image, and it must be no newer than what the driver supports.

??? question "3. Why start the checks at the hardware layer?"

    A failure at a low layer also breaks every layer above it. Starting at the bottom, the first failed check shows which layer to fix.

??? question "4. At the end of this chapter, can a Pod request `nvidia.com/gpu: 1`? Why?"

    No. Nothing has registered the GPU with the kubelet, so the node's capacity has no `nvidia.com/gpu` and such a Pod stays `Pending`. Registering the GPU is the job of a device plugin, which Chapter 2 introduces.

<!-- markdownlint-enable MD046 -->

## Hand-off

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Release the Colab runtime with **Runtime → Disconnect and delete runtime**. The next chapter opens its own notebook on a fresh runtime, so nothing from this one carries over, and a runtime left connected keeps using your free GPU time.

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Keep the kind cluster `hami-course` running. Chapter 2 continues in it.

## Further Reading

- [GPU Software Stack Overview](https://project-hami.io/docs/core-concepts/gpu-stack){:target="_blank"}: the five layers in detail
- [Understanding GPU Drivers](https://project-hami.io/docs/core-concepts/gpu-driver){:target="_blank"}: kernel modules, NVML, and bottom-up troubleshooting
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/index.html){:target="_blank"}: how containers get access to the GPU
