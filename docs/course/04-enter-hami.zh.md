# 第 4 章：HAMi 登场

[:simple-googlecolab: 在 Colab 中打开本章](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/zh/04-enter-hami.ipynb){ .md-button .colab-button target="_blank" }

## 场景

第 3 章共享 T4 之后，几个模型都放上了同一张卡，可每个模型看到的都是整张卡。`greedy` 占走了 10 GiB，下一个模型报 `CUDA out of memory`，训练任务还让旁边测速程序的速度掉了一半。团队需要给每个模型分到固定的一份显存和算力。本章引入 HAMi，重做第 3 章的实验。

## 你将理解

- HAMi 的各个组件在 Pod 生命周期的哪一步介入：webhook、调度器扩展、Device Plugin 和 HAMi-core
- Device Plugin 交给容器的是什么，HAMi-core 怎么用它
- 显存限制如何改变程序看到的显存，并阻止它占用更多
- 算力限制如何压住程序，以及为什么它在一段时间内的平均值上生效，瞬时值会有波动
- HAMi 的限制在哪里止步

## 实验环境

本章大约需要 30 分钟。步骤 1 到 6 和第 3 章一样，在 Google Colab 上使用免费的 T4 GPU 运行。步骤 7 在你的电脑上运行，使用 [HAMi 实验：没有 GPU 也能共享 GPU](../labs/hami-lab.md) 里的 kind 集群。

| 组件 | 版本 |
| --- | --- |
| GPU | Tesla T4，15360 MiB |
| NVIDIA 驱动 | 580.82.07（CUDA 13.0） |
| PyTorch | 2.14.1+cu130 |
| HAMi-core | commit `1721252`，即 HAMi v2.11.0 自带的版本 |
| HAMi（步骤 7） | v2.11.0 |

于 2026-11-18 在 Colab 上验证，步骤 2 于 2026-11-19 验证。步骤 7 于 2026-11-18 使用 kind 0.33、helm 4.3.2 和 HAMi 2.11.0 chart 验证。

## 背后的原理：Pod 路径上的四个组件

使用 NVIDIA Device Plugin 时，只有一个组件把 GPU 接入 Kubernetes，调度器也只会数设备个数。HAMi 改动了这条路径上的三个环节，并在容器里加了一个库：

![HAMi 的组件和 Pod 经过的路径](../images/hami-architecture-flow-zh.svg#only-light)
![HAMi 的组件和 Pod 经过的路径](../images/hami-architecture-flow-zh-dark.svg#only-dark)

- **Mutating webhook。** 创建申请 `nvidia.com/gpu` 的 Pod 时，webhook 把它的 `schedulerName` 改成 `hami-scheduler`，交给 HAMi 调度器处理。
- **调度器扩展。** HAMi 调度器知道每张 GPU 的显存和算力。过滤节点时，它拿 Pod 的 `gpumem` 和 `gpucores` 和每张卡的剩余量比较，选定一张具体的 GPU，并把决定写进 Pod 的 annotation。
- **Device Plugin。** kubelet 启动容器时，Device Plugin 读取这个决定，把它转换成环境变量。它还会挂载 `/etc/ld.so.preload`，让容器里的每个进程都先加载 HAMi-core。
- **HAMi-core（`libvgpu.so`）。** 位于程序和 NVIDIA 驱动之间的一个库。它拦截 CUDA 和 NVML 调用：超过限制的显存申请会失败，查询显存时返回限制值，启动 kernel 的节奏会被压到算力份额以内。

Device Plugin 做的事情其实不多。对一个申请了 `nvidia.com/gpumem: 4096` 和 `nvidia.com/gpucores: 30` 的 Pod，它交给容器的是这些：

| Device Plugin 传入的 | 取值 | HAMi-core 拿它做什么 |
| --- | --- | --- |
| `CUDA_DEVICE_MEMORY_LIMIT_0` | `4096m` | 第一张可见 GPU 的显存限制 |
| `CUDA_DEVICE_SM_LIMIT` | `30` | 算力限制，按 GPU 利用率的百分比计算 |
| `CUDA_DEVICE_MEMORY_SHARED_CACHE` | 一个文件路径，每个容器一个 | 容器里所有进程记录各自用量的地方 |
| `/etc/ld.so.preload` | `libvgpu.so` 的路径 | 让每个进程都加载 HAMi-core |

在步骤 2 到 6 里，由你来扮演 Device Plugin。Colab 上没有 Kubernetes，所以你自己设置这些变量，并用 `LD_PRELOAD` 加载 HAMi-core。`LD_PRELOAD` 对一个进程起的作用，就是 `/etc/ld.so.preload` 对整个容器起的作用。在步骤 7 里，你会看到集群中的 webhook 和调度器做出同样的决定。

## 步骤 1：重新写入第 3 章的程序

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

这个 notebook 运行在一个全新的运行时上，第 3 章的程序不在这里。重新写入：

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

## 步骤 2：编译 HAMi-core

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

HAMi 把 HAMi-core 打包在 Device Plugin 的镜像里。这里你从源码编译，使用 HAMi v2.11.0 对应的 commit。Colab 已经装好了 CUDA toolkit、CMake 和 C 编译器。编译选项和 HAMi-core 自带的 `build.sh` 一致，`make vgpu` 只编译这个库，跳过 HAMi-core 的测试程序：

```python
!rm -rf /content/HAMi-core && git clone -q https://github.com/Project-HAMi/HAMi-core /content/HAMi-core
!cd /content/HAMi-core && git checkout -q 17212525d27ac156955ab940c5d51df33d9e0d09 && git log --oneline -1
!cd /content/HAMi-core && mkdir -p build && cd build && (cmake .. -DDLSYM_HOOK_ENABLE=1 -DMULTIPROCESS_LIMIT_ENABLE=1 -DHOOK_MEMINFO_ENABLE=1 -DHOOK_NVML_ENABLE=1 -DCMAKE_BUILD_TYPE=Debug -DTEST_DEVICE_ID=0 && make -j$(nproc) vgpu) > /content/build.log 2>&1; echo "build exit code: $?"
!ls -la /content/HAMi-core/build/libvgpu.so
```

```{.text .output}
1721252 (HEAD) Merge pull request #391 from alwaysprince05/fix/vmm-release-while-mapped
build exit code: 0
-rwxr-xr-x 1 root root 829488 Nov 19 03:36 /content/HAMi-core/build/libvgpu.so
```

编译只需要几秒钟，结果是一个共享库 `libvgpu.so`。

## 步骤 3：把限制交给模型

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

按照 HAMi Device Plugin 为一个申请了 `nvidia.com/gpumem: 4096` 的 Pod 启动容器的方式，启动 `model-a`：加载 HAMi-core，设置 4096 MiB 的显存限制，并给它一个自己的共享缓存文件。

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/model-a.cache \
  nohup python /content/model.py model-a 2 > /content/model-a.log 2>&1 &
!sleep 15 && grep model-a /content/model-a.log
```

```{.text .output}
model-a sees 4096 MiB of GPU memory
model-a loaded 2 GiB of weights on Tesla T4
```

第 3 章里 `model-a` 看到的是 14913 MiB，现在看到的是 4096 MiB。`model.py` 一行都没改，是 HAMi-core 用限制值回答了 PyTorch 的显存查询。

`nvidia-smi` 通过 NVML 读取显存，而 NVML 也被 HAMi-core 拦截了。运行两次，一次是宿主机看到的样子，一次是 Pod 里的程序看到的样子：

```python
!nvidia-smi --query-gpu=memory.used,memory.total --format=csv
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/model-a.cache \
  nvidia-smi --query-gpu=memory.used,memory.total --format=csv 2>/dev/null
```

```{.text .output}
memory.used [MiB], memory.total [MiB]
2153 MiB, 15360 MiB
memory.used [MiB], memory.total [MiB]
2150 MiB, 4096 MiB
```

宿主机看到的是真实的 15360 MiB。加载 HAMi-core 并使用同一个共享缓存文件后，`nvidia-smi` 看到的是一张 4096 MiB 的卡，已用部分只有 `model-a` 的显存。GPU 本身并没有被切分，HAMi-core 改变的是一个 Pod 里的程序能看到什么、能拿走多少。

## 步骤 4：重做显存实验

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

再启动 `model-b` 和 `greedy`，相当于两个新的 Pod，各自有 4096 MiB 的限制和自己的缓存文件：

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/model-b.cache \
  nohup python /content/model.py model-b 2 > /content/model-b.log 2>&1 &
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/greedy.cache \
  nohup python /content/greedy.py > /content/greedy.log 2>&1 &
!sleep 15 && grep model-b /content/model-b.log
!grep -E 'greedy holds|HAMI-core ERROR' /content/greedy.log
```

```{.text .output}
model-b sees 4096 MiB of GPU memory
model-b loaded 2 GiB of weights on Tesla T4
[HAMI-core ERROR (pid:2359 thread=135546332927808 allocator.c:40)]: Device 0 OOM 4401922048 / 4294967296
[HAMI-core ERROR (pid:2359 thread=135546332927808 allocator.c:40)]: Device 0 OOM 4401922048 / 4294967296
greedy holds 3 GiB of GPU memory
```

`greedy` 停在了 3 GiB。限制把 CUDA context（约 100 MiB）也算在内，所以第 4 块 1 GiB 会超过 4096 MiB。HAMi-core 拒绝了这次申请并记录下来：4401922048 字节会超过 4294967296 字节的限制。PyTorch 重试了一次，所以这一行出现了两次，然后 PyTorch 把它当作普通的 `CUDA out of memory` 报给 `greedy`。

再来看第 3 章里失败的那个模型：

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/model-c.cache \
  nohup python /content/model.py model-c 2 > /content/model-c.log 2>&1 &
!sleep 15 && grep model-c /content/model-c.log
!nvidia-smi --query-compute-apps=pid,used_memory --format=csv
```

```{.text .output}
model-c sees 4096 MiB of GPU memory
model-c loaded 2 GiB of weights on Tesla T4
pid, used_gpu_memory [MiB]
2276, 2150 MiB
2356, 2150 MiB
2359, 3174 MiB
2452, 2150 MiB
```

`model-c` 成功加载了权重。`greedy`（PID 2359）占用 3174 MiB，也就是 3 GiB 加上 CUDA context。`greedy` 只能拿走自己那 4096 MiB，卡上就给其他模型留出了空间。在集群里，HAMi 调度器还会把每个 Pod 申请的 4096 MiB 累加起来，总量达到 15360 MiB 后就不再往这张卡上放 Pod。

进入下一步之前，停掉这四个程序：

```python
!pkill -f '/content/(model|greedy).py'
!sleep 5
```

## 步骤 5：一个 Pod 里的两个进程

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

一个 Pod 可以在 GPU 上运行多个进程。Device Plugin 给每个容器一个缓存文件，容器里的每个进程都在这里记录自己的显存用量。用同一个缓存文件启动两个进程，模拟它们运行在同一个 Pod 里：

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/pod-x.cache \
  nohup python /content/model.py worker-1 2 > /content/worker-1.log 2>&1 &
!sleep 15
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/pod-x.cache \
  timeout 60 python /content/model.py worker-2 2 2>&1 | grep -E 'worker-2|OutOfMemoryError'
```

```{.text .output}
worker-2 sees 4096 MiB of GPU memory
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 4.00 GiB of which 1.80 GiB is free. Process 2554 has 2.10 GiB memory in use. Including non-PyTorch memory, this process has 102.00 MiB memory in use. Of the allocated memory 0 bytes is allocated by PyTorch, and 0 bytes is reserved by PyTorch but unallocated. If reserved but unallocated memory is large try setting PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True to avoid fragmentation.  See documentation for Memory Management  (https://docs.pytorch.org/docs/stable/notes/cuda.html#optimizing-memory-usage-with-pytorch-cuda-alloc-conf)
```

`worker-2` 看到的是同一张 4096 MiB 的卡，可用的只剩 1.80 GiB，`worker-1` 已经占了 2 GiB，它的 2 GiB 放不下了。限制属于整个 Pod，由 Pod 里的所有进程共用。

```python
!pkill -f /content/model.py
!sleep 5
```

## 步骤 6：限制算力

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

先让第 3 章的测速程序单独运行，同时从外面每秒采样一次 GPU 利用率：

```python
!nohup python /content/bench.py > /content/bench.log 2>&1 &
!sleep 5 && timeout 20 nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader -l 1 | tr '\n' ' '; echo
!pkill -f /content/bench.py
!sleep 5 && grep TFLOPS /content/bench.log
```

```{.text .output}
99 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 % 100 %
12:46:00 19.8 TFLOPS
12:46:06 19.6 TFLOPS
12:46:11 19.4 TFLOPS
12:46:16 18.9 TFLOPS
```

GPU 一直处于忙碌状态，测速程序约 19 TFLOPS。这比第 3 章的 24 TFLOPS 低：T4 的功耗上限是 70 W，温度高了会降频，所以同一个程序在不同会话里测出来的数字会有差别。现在给它加上一个申请了 `nvidia.com/gpucores: 30` 的 Pod 会拿到的限制：

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_SM_LIMIT=30 \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/bench.cache \
  nohup python /content/bench.py > /content/bench-30.log 2>&1 &
!sleep 5 && timeout 20 nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader -l 1 | tr '\n' ' '; echo
!pkill -f /content/bench.py
!sleep 5 && grep TFLOPS /content/bench-30.log
```

```{.text .output}
10 % 27 % 35 % 39 % 39 % 31 % 24 % 21 % 23 % 38 % 39 % 36 % 29 % 26 % 20 % 27 % 39 % 36 % 38 % 32 %
12:46:32 5.6 TFLOPS
12:46:37 6.5 TFLOPS
12:46:43 6.5 TFLOPS
12:46:48 6.5 TFLOPS
```

有两点值得注意：

- **利用率在 10% 到 39% 之间跳动，平均值是 30%。** HAMi-core 并没有让 GPU 变慢，它控制的是 kernel 的启动。一个后台线程每 120 毫秒通过 NVML 读取一次进程的 GPU 利用率，据此给进程更多或更少的启动机会。所以限制在一段时间内成立，单次采样可能明显高于或低于它。
- **吞吐只是大致跟着变。** 这里测速程序保留了约三分之一的速度，约 19.4 TFLOPS 中的 6.5。利用率统计的是有 kernel 在运行的时间占比，不反映每个 kernel 用了 GPU 的多少，所以吞吐和利用率不会严格同比变化。换一种负载，同样 30% 的限制可能剩下明显更多的吞吐。可以把 `gpucores` 理解成 GPU 时间的份额。

## 步骤 7：在集群里看到同样的决定

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

按照 [HAMi 实验：没有 GPU 也能共享 GPU](../labs/hami-lab.md) 的实验 1 启动 kind 集群。集群里运行的是真实的 HAMi webhook 和调度器，加上 mock Device Plugin 和假 GPU。

创建一个 Pod，申请和 `model-a` 一样的显存，再加上算力限制：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: model-a
spec:
  containers:
    - name: model
      image: busybox:1.36
      command: ["sleep", "infinity"]
      resources:
        limits:
          nvidia.com/gpu: 1
          nvidia.com/gpumem: 4096
          nvidia.com/gpucores: 30
```

```bash
kubectl apply -f examples/course/04-enter-hami/model-a.yaml
kubectl wait --for=condition=Ready pod/model-a --timeout=120s
kubectl get pod model-a -o jsonpath='{.spec.schedulerName}{"\n"}'
kubectl get pod model-a -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}{"\n"}'
```

```{.text .output}
pod/model-a created
pod/model-a condition met
hami-scheduler
GPU-mock-1,NVIDIA,4096,30:;
```

webhook 把 `schedulerName` 设成了 `hami-scheduler`。调度器选定了一张 GPU，并把决定写进了 annotation：GPU UUID、厂商、4096 MiB 显存和 30% 算力。

这个集群里的 mock Device Plugin 只做到这一步，所以容器既拿不到限制，也没有 HAMi-core：

```bash
kubectl exec model-a -- ls /etc/ld.so.preload
```

```{.text .output}
ls: /etc/ld.so.preload: No such file or directory
command terminated with exit code 1
```

在有真实 GPU 的节点上，HAMi 的 Device Plugin 会把这条 annotation 转换成步骤 3 到 6 里的那些变量。下面的输出来自一个运行 HAMi v2.10.0 的 T4 节点，对应的 Pod 申请了 `nvidia.com/gpumem: 4096`，没有设置 `gpucores`：

```bash
kubectl exec model-a -- env | grep -E "NVIDIA_VISIBLE_DEVICES|CUDA_DEVICE_MEMORY_LIMIT|CUDA_DEVICE_SM_LIMIT"
kubectl exec model-a -- cat /etc/ld.so.preload
```

```{.text .output}
NVIDIA_VISIBLE_DEVICES=GPU-caf9bd30-b03c-04d8-9d4f-8a02f984cc23
CUDA_DEVICE_MEMORY_LIMIT_0=4096m
CUDA_DEVICE_SM_LIMIT=0
/usr/local/vgpu/libvgpu.so
```

这些就是你在 Colab 里手动设置的那些变量。

删除这个 Pod：

```bash
kubectl delete pod model-a
```

## 限制的边界

HAMi 的限制是在容器内由软件实现的，和 MIG 的硬件切分表现不同：

- **显存。** HAMi-core 拿每次申请和 `CUDA_DEVICE_MEMORY_LIMIT_0` 比较，超出的申请直接失败。限制计入容器通过 CUDA 分配的所有显存，包括 CUDA context，所以 `greedy` 停在了 3 GiB。容器里的所有进程通过缓存文件共用这份限制。GPU 本身没有被切分，宿主机看到的仍然是一张 15360 MiB 的卡。
- **算力。** HAMi-core 控制 kernel 的启动，让容器的 GPU 利用率在一段时间内的平均值落在 `CUDA_DEVICE_SM_LIMIT`。单次采样会上下波动，吞吐只是大致跟着变。
- **策略。** 在 HAMi 集群里，由每个节点上的 vGPU monitor 决定什么时候限流。在默认策略下，只有当同一张 GPU 上另一个同优先级或更高优先级的容器最近运行过 kernel 时，它才会对这个容器开启限流。一张卡上只有一个 Pod 时，它可以全速运行，空闲的 GPU 不会被浪费。Colab 上没有 vGPU monitor，而 HAMi-core 启动时默认开启限流，所以步骤 6 在卡上没有其他程序时也被限流了。`GPU_CORE_UTILIZATION_POLICY=force` 会始终限流，在集群里也一样。
- **调度。** 调度器计算的是每个 Pod 申请的 `gpumem` 和 `gpucores`，不看实际用量。一个 Pod 申请得比用得多，仍然会占住那一份。

和第 3 章相比，现在显存按 Pod 隔离，调度器会计算显存，算力也可以被限制。显存隔离是严格的，算力限制是近似的。

## 验证

| 结论 | 证据 |
| --- | --- |
| HAMi-core 改变了程序看到的显存 | 步骤 3：`model-a` 看到 4096 MiB，不再是 14913 MiB |
| HAMi-core 也改变了 `nvidia-smi` 看到的显存 | 步骤 3：加载 HAMi-core 时是 4096 MiB，不加载时是 15360 MiB |
| 程序不能使用超过限制的显存 | 步骤 4：`greedy` 停在 3 GiB，HAMi-core 报 OOM |
| 其他程序保住了自己的显存 | 步骤 4：`model-c` 在 `greedy` 旁边成功加载了 2 GiB |
| 显存限制属于整个 Pod | 步骤 5：使用同一个缓存文件时，`worker-2` 在 `worker-1` 旁边申请失败 |
| 算力被限制在一个平均值上 | 步骤 6：`CUDA_DEVICE_SM_LIMIT=30` 时利用率平均为 30% |
| webhook 和调度器决定每个 Pod 分到多少 | 步骤 7：`schedulerName` 是 `hami-scheduler`，annotation 里是 4096 MiB 和 30 |

## 常见问题

**程序看到的仍然是整张卡。** HAMi-core 没有被加载。检查 `LD_PRELOAD` 里的路径。在集群里，检查容器中是否存在 `/etc/ld.so.preload`。

**每次申请都失败，再小的也不行。** `CUDA_DEVICE_MEMORY_LIMIT_0` 没有写单位。HAMi-core 把不带单位的数字当作字节，`4096` 就是 4 KiB 的限制。应该写成 `4096m`。HAMi 的 Device Plugin 总会带上 `m`。

**两个本该分开的程序共用了一份限制。** 它们使用了同一个缓存文件。每个 Pod 都需要自己的 `CUDA_DEVICE_MEMORY_SHARED_CACHE`。如果没有设置这个变量，HAMi-core 会用 `POD_UID` 和 `CONTAINER_NAME` 两个变量拼出一个路径。这两个变量也没有时，才退回到 `/tmp/cudevshr.cache`，所有这样的进程都共用这一个文件。

**在集群里 `gpucores` 好像没有效果。** 在默认策略下，只有同一张 GPU 上的其他 Pod 在忙时，这个 Pod 才会被限流。设置 `GPU_CORE_UTILIZATION_POLICY=force` 可以让它始终被限流。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. 哪个 HAMi 组件修改了 Pod 的 `schedulerName`？为什么需要这样做？"

    Mutating webhook。它把 Pod 交给 HAMi 调度器，只有这个调度器知道每张 GPU 的显存和算力。

??? question "2. 步骤 3 里 `model-a` 看到的是一张 4096 MiB 的 GPU。这是谁做到的？在集群里 Device Plugin 做了什么来得到同样的结果？"

    通过 `LD_PRELOAD` 加载的 HAMi-core 用 `CUDA_DEVICE_MEMORY_LIMIT_0` 回答了显存查询。在集群里，Device Plugin 根据调度器的决定设置这个变量，并挂载 `/etc/ld.so.preload`，让每个进程都加载 HAMi-core。

??? question "3. 为什么 `greedy` 停在 3 GiB，没有到 4 GiB？"

    限制计入进程在 GPU 上分配的所有显存，包括 CUDA context。第 4 块 1 GiB 会超过 4096 MiB。

??? question "4. 算力限制为 30% 时，单次利用率采样在 10% 到 39% 之间。限制失效了吗？"

    没有。HAMi-core 每 120 毫秒根据测得的利用率调整 kernel 的启动，所以限制在一段时间内的平均值上成立。单次采样会围绕它波动。

<!-- markdownlint-enable MD046 -->

## 交接

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

选择 **代码执行程序 → 断开连接并删除运行时**，释放这个 Colab 运行时。不断开的运行时会继续消耗你的免费 GPU 时长。

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

保持步骤 7 的 kind 集群运行。第 5 章会继续使用它，从一张卡扩展到多张卡。

## 延伸阅读

- [设备资源隔离](https://project-hami.io/zh/docs/key-features/device-resource-isolation){:target="_blank"}：HAMi 如何隔离显存和算力
- [GPU 虚拟化原理](https://project-hami.io/zh/docs/core-concepts/gpu-virtualization){:target="_blank"}：HAMi 的完整工作流程，以及 HAMi-core 如何拦截 CUDA 和 NVML 调用
- [架构设计](https://project-hami.io/zh/docs/core-concepts/architecture){:target="_blank"}：HAMi 集群里的所有组件
- [HAMi-core](https://github.com/Project-HAMi/HAMi-core){:target="_blank"}：`libvgpu.so` 的源码
