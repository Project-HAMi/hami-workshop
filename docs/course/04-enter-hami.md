# Chapter 4: Enter HAMi

[:simple-googlecolab: Open this chapter in Colab](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/en/04-enter-hami.ipynb){ .md-button .colab-button target="_blank" }

## Scenario

Sharing the T4 in Chapter 3 put several models on one card, but every model saw the whole card. `greedy` took 10 GiB, the next model failed with `CUDA out of memory`, and a training job halved the speed of a benchmark next to it. The team needs each model to get a fixed slice of memory and compute. This chapter brings in HAMi and repeats the Chapter 3 experiments.

## What You'll Understand

- Which HAMi component steps in at which point of a Pod's life: the webhook, the scheduler extender, the device plugin, and HAMi-core
- What the device plugin hands to a container, and how HAMi-core uses it
- How a memory limit changes what a program sees and stops it from taking more
- How a compute limit throttles a program, and why it holds on average over time
- Where HAMi's limits stop

## Environment

This chapter takes about 30 minutes. Steps 1 to 6 run on Google Colab with the free T4 GPU, like Chapter 3. Step 7 runs on your laptop in the kind cluster from [HAMi lab: GPU sharing without a GPU](../labs/hami-lab.md).

| Component | Version |
| --- | --- |
| GPU | Tesla T4, 15360 MiB |
| NVIDIA driver | 580.82.07 (CUDA 13.0) |
| PyTorch | 2.14.1+cu130 |
| HAMi-core | commit `1721252`, the version shipped with HAMi v2.11.0 |
| HAMi (Step 7) | v2.11.0 |

Verified on Colab on 2026-11-18, and Step 2 on 2026-11-19. Step 7 verified on 2026-11-18 with kind 0.33, helm 4.3.2, and the HAMi 2.11.0 chart.

## The Principle: Four Components Along the Pod's Path

With the NVIDIA device plugin, one component connected the GPU to Kubernetes, and the scheduler only counted devices. HAMi changes three points on that path and adds a library inside the container:

![HAMi components and the path of a Pod](../images/hami-architecture-flow.svg#only-light)
![HAMi components and the path of a Pod](../images/hami-architecture-flow-dark.svg#only-dark)

- **Mutating webhook.** When a Pod that asks for `nvidia.com/gpu` is created, the webhook sets its `schedulerName` to `hami-scheduler`, so the HAMi scheduler handles it.
- **Scheduler extender.** The HAMi scheduler knows each GPU's memory and compute. When it filters nodes, it checks the Pod's `gpumem` and `gpucores` against what is left on each card. It picks a specific GPU and writes the decision into a Pod annotation.
- **Device plugin.** When the kubelet starts the container, the device plugin reads that decision and turns it into environment variables. It also mounts `/etc/ld.so.preload`, so that every process in the container loads HAMi-core first.
- **HAMi-core (`libvgpu.so`).** A library that sits between the program and the NVIDIA driver. It intercepts CUDA and NVML calls: memory allocations above the limit fail, memory queries report the limit, and kernel launches are throttled to the compute share.

The device plugin's part is small. For a Pod that asks for `nvidia.com/gpumem: 4096` and `nvidia.com/gpucores: 30`, it hands the container these:

| What the device plugin passes | Value | What HAMi-core does with it |
| --- | --- | --- |
| `CUDA_DEVICE_MEMORY_LIMIT_0` | `4096m` | Memory limit for the first visible GPU |
| `CUDA_DEVICE_SM_LIMIT` | `30` | Compute limit, as a percentage of GPU utilization |
| `CUDA_DEVICE_MEMORY_SHARED_CACHE` | a file path, one per container | Where all processes of the container record what they use |
| `/etc/ld.so.preload` | the path of `libvgpu.so` | Makes every process load HAMi-core |

In Steps 2 to 6 you take the device plugin's place. Colab has no Kubernetes, so you set these variables yourself and load HAMi-core with `LD_PRELOAD`, which does for one process what `/etc/ld.so.preload` does for a whole container. In Step 7 you see the webhook and the scheduler make the same decision in a cluster.

## Step 1: Bring Back the Chapter 3 Programs

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

This notebook runs on a fresh runtime, so the programs from Chapter 3 are not there. Write them again:

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

## Step 2: Build HAMi-core

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

HAMi ships HAMi-core inside its device plugin image. Here you build it from source, at the commit that HAMi v2.11.0 uses. Colab already has the CUDA toolkit, CMake, and a C compiler. The options are the ones HAMi-core's own `build.sh` uses, and `make vgpu` builds only the library and skips HAMi-core's test programs:

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

The build takes a few seconds. The result is one shared library, `libvgpu.so`.

## Step 3: Hand a Model Its Limits

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Start `model-a` the way HAMi's device plugin would start it for a Pod with `nvidia.com/gpumem: 4096`: with HAMi-core loaded, a 4096 MiB memory limit, and its own shared cache file.

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

In Chapter 3, `model-a` saw 14913 MiB. Now it sees 4096 MiB. Nothing in `model.py` changed. HAMi-core answered PyTorch's memory query with the limit.

`nvidia-smi` reads memory through NVML, which HAMi-core also intercepts. Run it twice, once as the host sees the card and once as a program inside the Pod would:

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

The host sees the real 15360 MiB card. With HAMi-core loaded and the same shared cache file, `nvidia-smi` sees a 4096 MiB card with only `model-a`'s memory in use. The GPU itself is not split. HAMi-core changes what the programs in one Pod see and what they are allowed to take.

## Step 4: Repeat the Memory Experiment

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Start `model-b` and `greedy` as two more Pods, each with its own 4096 MiB limit and its own cache file:

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

`greedy` stopped at 3 GiB. Its fourth 1 GiB chunk would have gone over 4096 MiB, because the limit also counts the CUDA context, about 100 MiB. HAMi-core refused that allocation and logged it: 4401922048 bytes would have gone over the 4294967296-byte limit. PyTorch retried once, which is why the line appears twice, and reported it to `greedy` as an ordinary `CUDA out of memory`.

Now the model that failed in Chapter 3:

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

`model-c` loaded its weights. `greedy` (PID 2359) holds 3174 MiB, its 3 GiB plus the CUDA context. `greedy` can only take its own 4096 MiB, so the card has room for the others. In a cluster, the HAMi scheduler would also add up the 4096 MiB each Pod asked for and stop placing Pods on the card once the total reached 15360 MiB.

Stop all four before the next step:

```python
!pkill -f '/content/(model|greedy).py'
!sleep 5
```

## Step 5: Two Processes in One Pod

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

A Pod can run more than one process on the GPU. The device plugin gives each container one cache file, and every process in the container records its memory there. Start two processes with the same cache file, as if they ran in the same Pod:

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

`worker-2` sees the same 4096 MiB card with only 1.80 GiB free, and its 2 GiB does not fit next to the 2 GiB `worker-1` already holds. The limit belongs to the Pod and is shared by every process in it.

```python
!pkill -f /content/model.py
!sleep 5
```

## Step 6: Limit Compute

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

First, the benchmark from Chapter 3 on its own. While it runs, sample the GPU utilization from outside once a second:

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

The GPU is busy all the time, and the benchmark runs at about 19 TFLOPS. That is lower than the 24 TFLOPS in Chapter 3: the T4 is limited to 70 W and slows its clock when it runs hot, so the same program can measure differently from one session to the next. Now give it the limit a Pod with `nvidia.com/gpucores: 30` would get:

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

Two things stand out:

- **The utilization jumps around, between 10% and 39%, and its average is 30%.** HAMi-core does not slow the GPU down. It holds back kernel launches. A background thread reads the process's GPU utilization from NVML every 120 ms and gives the process more or fewer launches, so the limit holds over time and each single sample can be well above or below it.
- **Throughput follows only roughly.** Here the benchmark kept about a third of its speed, 6.5 of about 19.4 TFLOPS. Utilization only counts the share of time a kernel is running. It says nothing about how much of the GPU each kernel uses, so throughput and utilization do not move one for one. With other workloads, the same 30% limit can leave noticeably more throughput. Treat `gpucores` as a share of GPU time.

## Step 7: See the Same Decision in a Cluster

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Start the kind cluster from [HAMi lab: GPU sharing without a GPU](../labs/hami-lab.md) by following its Lab 1. It runs the real HAMi webhook and scheduler with a mock device plugin and fake GPUs.

Create a Pod that asks for the same slice as `model-a` plus a compute limit:

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

The webhook set `schedulerName` to `hami-scheduler`. The scheduler picked a GPU and wrote its decision into the annotation: the GPU UUID, the vendor, 4096 MiB of memory, and 30% of compute.

The mock device plugin in this cluster stops here, so the container gets no limits and no HAMi-core:

```bash
kubectl exec model-a -- ls /etc/ld.so.preload
```

```{.text .output}
ls: /etc/ld.so.preload: No such file or directory
command terminated with exit code 1
```

On a node with a real GPU, HAMi's device plugin turns this annotation into the variables from Steps 3 to 6. This output comes from a T4 node running HAMi v2.10.0, for a Pod that asked for `nvidia.com/gpumem: 4096` and no `gpucores`:

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

These are the same variables you set by hand in Colab.

Delete the Pod:

```bash
kubectl delete pod model-a
```

## Where the Limits Stop

HAMi's limits are enforced in software, inside the container. They behave differently from the hardware partitions of MIG:

- **Memory.** HAMi-core checks each allocation against `CUDA_DEVICE_MEMORY_LIMIT_0` and fails the ones that would go over. The limit counts everything the container allocates through CUDA, including the CUDA context, which is why `greedy` stopped at 3 GiB. All processes in a container share the limit through the cache file. The GPU itself is not partitioned: the host still sees one 15360 MiB card.
- **Compute.** HAMi-core holds back kernel launches so that the container's GPU utilization averages out at `CUDA_DEVICE_SM_LIMIT`. Single samples swing above and below it, and throughput follows only roughly.
- **Policy.** In a HAMi cluster, the vGPU monitor on each node decides when to throttle. Under the default policy, it turns throttling on for a container only while another container on the same GPU, with the same or a higher priority, has run kernels recently. A Pod alone on a card runs at full speed, so an idle GPU is not wasted. Colab has no vGPU monitor, and HAMi-core starts with throttling on, which is why Step 6 throttled with no other program on the card. `GPU_CORE_UTILIZATION_POLICY=force` throttles at all times, also in a cluster.
- **Scheduling.** The scheduler counts the `gpumem` and `gpucores` each Pod asked for. Measured usage plays no part. A Pod that asks for more than it uses still holds that share of the card.

Compared with Chapter 3, memory is now isolated per Pod, the scheduler accounts for memory, and compute can be throttled. Memory isolation is strict, and the compute limit is approximate.

## Verify

| Claim | Evidence |
| --- | --- |
| HAMi-core changes what a program sees | Step 3: `model-a` sees 4096 MiB, down from 14913 MiB |
| HAMi-core also changes what `nvidia-smi` sees | Step 3: 4096 MiB with HAMi-core loaded, 15360 MiB without |
| A program cannot use more than its memory limit | Step 4: `greedy` stops at 3 GiB with a HAMi-core OOM |
| Other programs keep their memory | Step 4: `model-c` loads 2 GiB next to `greedy` |
| The memory limit belongs to the Pod | Step 5: `worker-2` fails next to `worker-1` with the same cache file |
| Compute is throttled to an average | Step 6: utilization averages 30% with `CUDA_DEVICE_SM_LIMIT=30` |
| The webhook and scheduler decide the slice | Step 7: `schedulerName` is `hami-scheduler`, the annotation holds 4096 MiB and 30 |

## Common Pitfalls

**The program still sees the whole card.** HAMi-core was not loaded. Check the path in `LD_PRELOAD`. In a cluster, check that `/etc/ld.so.preload` exists in the container.

**Every allocation fails, even a small one.** `CUDA_DEVICE_MEMORY_LIMIT_0` has no unit. HAMi-core reads a number without a unit as bytes, so `4096` is a 4 KiB limit. Write `4096m`. HAMi's device plugin always adds the `m`.

**Two programs that should be separate share one limit.** They use the same cache file. Each Pod needs its own `CUDA_DEVICE_MEMORY_SHARED_CACHE`. If the variable is missing, HAMi-core builds a path from the `POD_UID` and `CONTAINER_NAME` variables. When those are missing too, it falls back to `/tmp/cudevshr.cache`, and every such process shares one file.

**`gpucores` seems to have no effect in a cluster.** Under the default policy, a Pod is throttled only while other Pods on the same GPU are busy. Set `GPU_CORE_UTILIZATION_POLICY=force` to throttle it at all times.

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. Which HAMi component changes the Pod's `schedulerName`, and why is that needed?"

    The mutating webhook. It sends the Pod to the HAMi scheduler, which is the scheduler that knows each GPU's memory and compute.

??? question "2. In Step 3, `model-a` saw a 4096 MiB GPU. What made that happen, and what does the device plugin do in a cluster to get the same result?"

    HAMi-core, loaded with `LD_PRELOAD`, answered the memory query with `CUDA_DEVICE_MEMORY_LIMIT_0`. In a cluster, the device plugin sets that variable from the scheduler's decision and mounts `/etc/ld.so.preload` so that every process loads HAMi-core.

??? question "3. Why did `greedy` stop at 3 GiB and not at 4 GiB?"

    The limit counts everything the process allocates on the GPU, including the CUDA context. A fourth 1 GiB chunk would have gone over 4096 MiB.

??? question "4. With a 30% compute limit, single utilization samples ranged from 10% to 39%. Is the limit broken?"

    No. HAMi-core adjusts kernel launches every 120 ms based on measured utilization, so the limit holds on average over time. Single samples swing around it.

<!-- markdownlint-enable MD046 -->

## Hand-off

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Release the Colab runtime with **Runtime → Disconnect and delete runtime**. A runtime left connected keeps using your free GPU time.

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Keep the kind cluster from Step 7 running. Chapter 5 continues in it and moves from one card to many.

## Further Reading

- [Device resource isolation](https://project-hami.io/docs/key-features/device-resource-isolation){:target="_blank"}: how HAMi isolates memory and compute
- [GPU Virtualization Principles](https://project-hami.io/docs/core-concepts/gpu-virtualization){:target="_blank"}: the full HAMi workflow and how HAMi-core intercepts CUDA and NVML calls
- [Architecture](https://project-hami.io/docs/core-concepts/architecture){:target="_blank"}: every component in a HAMi cluster
- [HAMi-core](https://github.com/Project-HAMi/HAMi-core){:target="_blank"}: the source of `libvgpu.so`
