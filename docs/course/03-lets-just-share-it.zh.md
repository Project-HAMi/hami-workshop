# 第 3 章：那就共享吧

[:simple-googlecolab: 在 Colab 中打开本章](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/zh/03-lets-just-share-it.ipynb){ .md-button .colab-button target="_blank" }

## 场景

第 2 章里，一个 2 GiB 的模型占用了整张 T4，第二个模型只能等待。团队不想为一个只用了八分之一显存的模型再买一张卡。NVIDIA Device Plugin 自带一种共享模式叫 time-slicing，改一处配置就能打开。在集群里打开它之前，团队想先弄清楚：几个模型共用一张卡时，卡上到底会发生什么。

## 你将理解

- 几个程序在没有任何限制的情况下共用一张 GPU 时，卡上实际发生了什么
- 为什么一个程序能占走另一个程序需要的显存
- 为什么共用一张 GPU 的程序会互相拖慢
- 为什么 Kubernetes 调度成功的 Pod 仍然可能在 GPU 上运行失败
- time-slicing、MPS 和 MIG 各自共享了什么、隔离了什么

## 实验环境

本章大约需要 20 分钟。在 Google Colab 上运行，使用免费的 T4 GPU。

本章里的每个程序代表一个 Pod。在 Kubernetes 里它们会运行在不同的容器中，这里它们是同一张卡上的不同进程。对 GPU 来说，两种情况看到的都是这些进程。

| 组件 | 版本 |
| --- | --- |
| GPU | Tesla T4，15360 MiB |
| NVIDIA 驱动 | 580.82.07（CUDA 13.0） |
| PyTorch | 2.14.1+cu130 |

于 2026-11-18 在 Colab 上验证。

## 步骤 1：看一眼这张卡

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

```python
!nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv
```

```{.text .output}
name, memory.total [MiB], memory.used [MiB]
Tesla T4, 15360 MiB, 0 MiB
```

一张 15360 MiB 显存的 T4，上面还没有运行任何程序。

## 步骤 2：同时运行两个模型

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

用一个小脚本代替团队的模型。它把指定大小的权重加载到显存里，然后一直等待，就像推理服务一直持有模型一样。它还会打印自己能看到多少显存。把它写入 Colab 的磁盘：

```python
%%writefile /content/model.py
import sys, time, torch
name, gib = sys.argv[1], float(sys.argv[2])
free, total = torch.cuda.mem_get_info()
print(f"{name} sees {total / 2**20:.0f} MiB of GPU memory", flush=True)
weights = torch.empty(int(gib * 2**30), dtype=torch.uint8, device="cuda")
print(f"{name} loaded {gib:g} GiB of weights on {torch.cuda.get_device_name(0)}", flush=True)
time.sleep(365 * 24 * 3600)
```

在后台启动两个模型，每个 2 GiB，然后查看日志：

```python
!nohup python /content/model.py model-a 2 > /content/model-a.log 2>&1 &
!nohup python /content/model.py model-b 2 > /content/model-b.log 2>&1 &
!sleep 15 && cat /content/model-a.log /content/model-b.log
```

```{.text .output}
model-a sees 14913 MiB of GPU memory
model-a loaded 2 GiB of weights on Tesla T4
model-b sees 14913 MiB of GPU memory
model-b loaded 2 GiB of weights on Tesla T4
```

两个模型都运行在同一张卡上：

```python
!nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

```{.text .output}
pid, process_name, used_gpu_memory [MiB]
779, python3, 2150 MiB
782, python3, 2150 MiB
```

两个进程，每个 2150 MiB：2 GiB 权重，加上每个进程都需要的 CUDA context。在集群里打开 time-slicing 后就是这个效果：两个 Pod 都能启动，而且都落在同一张 GPU 上。第 2 章的调度问题解决了。接下来两步看看这两个模型还共享了什么。

## 步骤 3：观察程序争抢显存

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

再看一下刚才的日志。每个模型看到的都是整张卡，14913 MiB。这比 `nvidia-smi` 报告的 15360 MiB 少一点，因为驱动自己保留了一部分显存。没有任何东西告诉 `model-b` 这张卡上有多少属于它，也没有任何东西阻止它用得更多。

为了看清这意味着什么，启动一个程序，它以 1 GiB 为单位不断申请显存，直到卡被占满，然后一直持有：

```python
%%writefile /content/greedy.py
import time, torch
chunks = []
while True:
    try:
        chunks.append(torch.empty(2**30, dtype=torch.uint8, device="cuda"))
    except torch.cuda.OutOfMemoryError:
        break
print(f"greedy holds {len(chunks)} GiB of GPU memory", flush=True)
time.sleep(365 * 24 * 3600)
```

```python
!nohup python /content/greedy.py > /content/greedy.log 2>&1 &
!sleep 15 && grep greedy /content/greedy.log
!nvidia-smi --query-gpu=memory.used,memory.total --format=csv
```

```{.text .output}
greedy holds 10 GiB of GPU memory
memory.used [MiB], memory.total [MiB]
14645 MiB, 15360 MiB
```

日志里还有两行 PyTorch 关于分配失败的警告。`greedy` 本来就预期会失败，所以用 `grep` 只显示它自己那一行。

在集群里，`greedy` 和其他 Pod 一样只向 Kubernetes 申请了一份，却占走了 10 GiB。卡几乎满了。这时第三个同样 2 GiB 的模型来了：

```python
!python /content/model.py model-c 2 2>&1 | tail -1
```

```{.text .output}
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 14.56 GiB of which 165.75 MiB is free. Process 779 has 2.10 GiB memory in use. Process 782 has 2.10 GiB memory in use. Process 860 has 10.10 GiB memory in use. Including non-PyTorch memory, this process has 102.00 MiB memory in use. Of the allocated memory 0 bytes is allocated by PyTorch, and 0 bytes is reserved by PyTorch but unallocated. If reserved but unallocated memory is large try setting PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True to avoid fragmentation.  See documentation for Memory Management  (https://docs.pytorch.org/docs/stable/notes/cuda.html#optimizing-memory-usage-with-pytorch-cuda-alloc-conf)
```

报错里甚至列出了谁占着这张卡：`model-a` 和 `model-b` 各 2.10 GiB，`greedy` 占了 10.10 GiB。

开启 time-slicing 后，Kubernetes 会毫无异议地调度 `model-c`，因为节点上还有空闲的 `nvidia.com/gpu` 副本。可 GPU 上已经没有显存了，模型报 `CUDA out of memory` 失败。调度器数的是副本，GPU 上根本没有副本这个概念。

进入下一步之前，先停掉 `greedy`：

```python
!pkill -f /content/greedy.py
!sleep 5
```

## 步骤 4：观察程序争抢算力

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

接下来看算力。下面这个程序测量自己在 GPU 上做矩阵乘法的速度，每 5 秒打印一次结果：

```python
%%writefile /content/bench.py
import time, torch
a = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
b = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
while True:
    start, n = time.time(), 0
    while time.time() - start < 5:
        for _ in range(10):
            torch.matmul(a, b)
        torch.cuda.synchronize()
        n += 10
    tflops = n * 2 * 4096**3 / (time.time() - start) / 1e12
    print(f"{time.strftime('%H:%M:%S')} {tflops:.1f} TFLOPS", flush=True)
```

同事的训练任务只做一件事，以最快的速度做矩阵乘法：

```python
%%writefile /content/training.py
import torch
a = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
b = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
print("training started", flush=True)
while True:
    torch.matmul(a, b)
```

先启动测速程序，让它单独跑 30 秒，然后在同一张卡上启动训练任务，再等 30 秒：

```python
!nohup python /content/bench.py > /content/bench.log 2>&1 &
!sleep 30
!nohup python /content/training.py > /content/training.log 2>&1 &
!sleep 30 && cat /content/bench.log
```

```{.text .output}
12:53:19 23.7 TFLOPS
12:53:24 24.1 TFLOPS
12:53:30 24.0 TFLOPS
12:53:35 23.8 TFLOPS
12:53:40 23.9 TFLOPS
12:53:45 23.7 TFLOPS
12:53:50 12.0 TFLOPS
12:53:55 10.8 TFLOPS
12:54:00 10.8 TFLOPS
12:54:05 10.7 TFLOPS
12:54:10 10.6 TFLOPS
```

测速程序单独运行时约 24 TFLOPS。`training` 在 12:53:50 这一段启动，此后测速程序一直停在约 11 TFLOPS。测速程序本身什么都没变。GPU 现在在两个繁忙的进程之间来回切换，每个大约分到一半的时间。

## 调度器看到了什么

![开启 time-slicing 后，调度器看到 4 个副本，放了 4 个 Pod，而 GPU 上只有一份显存，进程轮流运行](../images/course-time-slicing-zh.svg#only-light)
![开启 time-slicing 后，调度器看到 4 个副本，放了 4 个 Pod，而 GPU 上只有一份显存，进程轮流运行](../images/course-time-slicing-zh-dark.svg#only-dark)

time-slicing 是 NVIDIA Device Plugin 的一项配置。设置 `replicas: 4` 后，插件把这一张 T4 上报成 4 个 `nvidia.com/gpu` 设备，节点容量显示 `"nvidia.com/gpu":"4"`。调度器最多会往这张卡上放 4 个 Pod。4 个 Pod 拿到的是同一个 GPU UUID，所以它们的进程都运行在同一张 GPU 上，和步骤 2 到 4 里的程序一模一样。

调度器只数副本。它不知道步骤 3 里 `greedy` 占了多少显存，也不知道步骤 4 里 `training` 占了多少算力。所以 `model-c` 会被调度成功，然后运行失败。

## 背后的原理：time-slicing、MPS 和 MIG 共享与隔离了什么

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

time-slicing 只改变 Device Plugin 上报的内容。在 GPU 上，所有 Pod 的进程轮流运行：GPU 按时间片在它们之间切换。没有按 Pod 的显存限制，也没有按 Pod 强制分配的算力份额。步骤 3 和步骤 4 分别证明了这两点。

NVIDIA 还提供了另外两种共享 GPU 的方式：

- **MPS（Multi-Process Service）。** 一个服务进程让多个进程的 kernel 同时在 GPU 上运行。MPS 可以限制每个客户端的显存以及可用的 GPU 线程比例，NVIDIA Device Plugin 也有 MPS 共享模式，会把这些限制平均分配。所有客户端都经过同一个 MPS 服务，一个客户端出现故障可能影响其他客户端。
- **MIG（Multi-Instance GPU）。** 在硬件层面把 GPU 切分成多个实例，每个实例有独立的显存和计算单元。隔离性强，但只有部分数据中心 GPU 支持 MIG，而且每个实例只能使用固定的几种规格。T4 不在支持之列：

```python
!nvidia-smi --query-gpu=name,mig.mode.current --format=csv
```

```{.text .output}
name, mig.mode.current
Tesla T4, [N/A]
```

|  | time-slicing | MPS | MIG |
| --- | --- | --- | --- |
| 多个 Pod 共用一张 GPU | 是 | 是 | 是，每个实例一个 |
| 按 Pod 限制显存 | 否 | 是 | 是，硬件隔离 |
| 按 Pod 限制算力 | 否 | 是 | 是，硬件隔离 |
| 每份的大小 | 没有定义 | Device Plugin 中平均分配 | 固定的 MIG 规格 |
| 支持的 GPU | 一般的 NVIDIA GPU | Volta 及更新的架构（显存和算力限制） | 支持 MIG 的数据中心 GPU，如 A100 和 H100 |

time-slicing 让调度器能在一张 GPU 上放更多 Pod，但它不限制每个 Pod 用多少显存和算力。第 4 章展示 HAMi 如何在同一张 T4 上加上这些限制。

## 验证

| 结论 | 证据 |
| --- | --- |
| 多个程序可以在同一张 GPU 上运行 | 步骤 2：`model-a` 和 `model-b` 都在运行，同一张卡上有两个进程 |
| 每个程序都能看到并使用整张卡的显存 | 步骤 2 和步骤 3：每个模型都看到 14913 MiB，`greedy` 占走了 10 GiB |
| 调度器数得过来的程序，仍然可能在 GPU 上失败 | 步骤 3：`model-c` 报 `CUDA out of memory` |
| 算力靠争抢来分配 | 步骤 4：`training` 启动后，测速程序从约 24 TFLOPS 降到约 11 TFLOPS |
| T4 不能使用 MIG | 背后的原理：`mig.mode.current` 是 `[N/A]` |

## 常见问题

**日志文件是空的。** 模型还在加载。等几秒再运行一次 `cat`。

**步骤 2 里 `model-a` 或 `model-b` 报 `CUDA out of memory`。** 之前运行留下的 `greedy` 进程还占着卡。运行 `!nvidia-smi --query-compute-apps=pid,used_memory --format=csv` 找到它，用 `pkill` 停掉，或者重启 Colab 会话。

**Kubernetes 显示还有空闲 GPU，模型却报 `CUDA out of memory`。** 开启 time-slicing 后，有空闲的副本不代表有空闲的显存。在节点上用 `nvidia-smi` 查看实际用量。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. 设置 `replicas: 4` 后，节点上报 `nvidia.com/gpu: 4`，但只有一张 T4。这 4 个设备代表什么？"

    同一张 GPU 的 4 个副本，由 Device Plugin 的 time-slicing 配置生成。4 个副本都对应同一个 GPU UUID。

??? question "2. 在集群里，`model-c` 会被调度成功然后运行失败。调度器为什么会放它？"

    调度器只检查是否还有空闲的 `nvidia.com/gpu` 副本，当时还有一份。显存不在检查范围内，而显存已经被 `greedy` 占满了。

??? question "3. 训练任务启动后，测速程序为什么变慢了？"

    没有任何机制按固定份额给进程分配 GPU 时间。两个繁忙的进程各自大约分到一半。

??? question "4. 在 T4 上，time-slicing、MPS 和 MIG 中哪一种能限制 Pod 的显存？"

    MPS。time-slicing 没有显存限制，T4 也不支持 MIG。

<!-- markdownlint-enable MD046 -->

## 交接

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

选择 **代码执行程序 → 断开连接并删除运行时**，释放这个 Colab 运行时。下一章会打开自己的 notebook，运行在一个全新的运行时上，这一章的内容不会带过去。不断开的运行时会继续消耗你的免费 GPU 时长。

## 延伸阅读

- [设备共享](https://project-hami.io/zh/docs/key-features/device-sharing){:target="_blank"}：HAMi 如何在 Pod 之间共享一张 GPU
- [Device Plugin 与 DRA](https://project-hami.io/zh/docs/core-concepts/device-plugin-and-dra){:target="_blank"}：GPU 如何变成 Kubernetes 资源
- [Time-slicing GPUs in Kubernetes](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html){:target="_blank"}：NVIDIA 对 time-slicing 及其局限的说明
- [NVIDIA device plugin for Kubernetes](https://github.com/NVIDIA/k8s-device-plugin){:target="_blank"}：time-slicing 和 MPS 共享选项
- [Multi-Process Service](https://docs.nvidia.com/deploy/mps/){:target="_blank"}：MPS 的工作方式和支持的限制
- [MIG User Guide](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/){:target="_blank"}：支持的 GPU 和 MIG 规格
