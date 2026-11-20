# Real GPU Isolation on Colab: HAMi-core in 45 Minutes

[:simple-googlecolab: Open this lab in Colab](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/en/hami-core-colab.ipynb){ .md-button .colab-button target="_blank" }

In 45 minutes you run several programs on one real GPU and watch them take each other's memory and compute. Then you load HAMi-core, the library HAMi puts into every GPU container, hand it the limits a Pod would get, and watch each program stay within its own share.

Everything runs in your browser on Google Colab, which gives you a free NVIDIA T4.

Tested on Colab on 2026-11-19 with a Tesla T4 (driver 580.82.07), PyTorch 2.14.1+cu130, and HAMi-core commit `1721252`, the version shipped with HAMi v2.11.0.

## The 45 Minutes

| Time | Part | What you get |
| --- | --- | --- |
| 0:00 | Start | A Colab notebook on a T4, and HAMi-core built from source |
| 0:05 | Lab 1: See the problem | Two programs on one card take each other's memory and compute |
| 0:15 | Lab 2: Be the device plugin | The same programs, each held to its memory and compute share by HAMi-core |
| 0:30 | Lab 3: Calm the noisy neighbor | A training job held to its share, and a benchmark next to it that slows down less |
| 0:40 | Wrap-up | Where the limits stop, and what to try next |

## Before You Start

- A Google account and a browser. Nothing to install on your laptop.

Free Colab GPUs are not guaranteed. If Colab cannot give you a T4 right now, try again later.

## Start: Build HAMi-core

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

HAMi ships HAMi-core inside its device plugin image. Here you build it from source, which takes a few seconds:

```python
!rm -rf /content/HAMi-core && git clone -q https://github.com/Project-HAMi/HAMi-core /content/HAMi-core
!cd /content/HAMi-core && git checkout -q 17212525d27ac156955ab940c5d51df33d9e0d09 && git log --oneline -1
!cd /content/HAMi-core && mkdir -p build && cd build && (cmake .. -DDLSYM_HOOK_ENABLE=1 -DMULTIPROCESS_LIMIT_ENABLE=1 -DHOOK_MEMINFO_ENABLE=1 -DHOOK_NVML_ENABLE=1 -DCMAKE_BUILD_TYPE=Debug -DTEST_DEVICE_ID=0 && make -j$(nproc) vgpu) > /content/build.log 2>&1; echo "build exit code: $?"
!ls -la /content/HAMi-core/build/libvgpu.so
!python -c "import torch; print('torch', torch.__version__)"
```

```{.text .output}
1721252 (HEAD) Merge pull request #391 from alwaysprince05/fix/vmm-release-while-mapped
build exit code: 0
-rwxr-xr-x 1 root root 829488 Nov 19 07:37 /content/HAMi-core/build/libvgpu.so
torch 2.14.1+cu130
```

The options are the ones HAMi-core's own `build.sh` uses. `make vgpu` builds only the library, `libvgpu.so`, and skips HAMi-core's test programs. You use the library in Lab 2.

## Lab 1: See the Problem

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Each program in this lab stands in for one Pod. Kubernetes would start them in separate containers. Here they are separate processes on the same card, which is what the GPU sees in both cases.

The first program stands in for a model: it loads some weights into GPU memory and waits, the way an inference server holds its model.

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

The second one takes GPU memory in 1 GiB chunks until the card is full:

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

### Memory

Start two 2 GiB models and the greedy program, then a third model:

```python
!nohup python /content/model.py model-a 2 > /content/model-a.log 2>&1 &
!nohup python /content/model.py model-b 2 > /content/model-b.log 2>&1 &
!sleep 15 && cat /content/model-a.log /content/model-b.log
!nohup python /content/greedy.py > /content/greedy.log 2>&1 &
!sleep 15 && grep greedy /content/greedy.log
!python /content/model.py model-c 2 2>&1 | tail -1 | cut -c1-190
```

```{.text .output}
model-a sees 14913 MiB of GPU memory
model-a loaded 2 GiB of weights on Tesla T4
model-b sees 14913 MiB of GPU memory
model-b loaded 2 GiB of weights on Tesla T4
greedy holds 10 GiB of GPU memory
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 14.56 GiB of which 165.75 MiB is free. Process 1249 has 2.10 GiB memory in use. Process
```

Every program sees the whole card. `greedy` takes 10 GiB, and `model-c` fails with `CUDA out of memory`. In a cluster with time-slicing, all four would be Pods that asked Kubernetes for one share each. The scheduler counts shares, and the GPU has no notion of them.

```python
!pkill -f '/content/(model|greedy).py'
!sleep 5
```

### Compute

A benchmark that measures how fast it multiplies matrices, and a training job that does nothing else:

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

```python
%%writefile /content/training.py
import torch
a = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
b = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
print("training started", flush=True)
while True:
    torch.matmul(a, b)
```

Run the benchmark alone for 20 seconds, then start the training job next to it:

```python
!nohup python /content/bench.py > /content/bench.log 2>&1 &
!sleep 20
!nohup python /content/training.py > /content/training.log 2>&1 &
!sleep 20 && cat /content/bench.log
!pkill -f '/content/(bench|training).py'
!sleep 5
```

```{.text .output}
07:38:20 23.7 TFLOPS
07:38:25 24.2 TFLOPS
07:38:30 24.1 TFLOPS
07:38:35 24.1 TFLOPS
07:38:40 13.2 TFLOPS
07:38:45 10.9 TFLOPS
07:38:50 10.8 TFLOPS
```

The benchmark runs at about 24 TFLOPS on its own and drops to about 11 TFLOPS once `training` starts. Nothing in the benchmark changed. The GPU switches between two busy processes, and each gets roughly half of the time.

## Lab 2: Be the Device Plugin

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

When a Pod asks HAMi for `nvidia.com/gpumem: 4096` and `nvidia.com/gpucores: 30`, HAMi's device plugin hands its container these:

| What the device plugin passes | Value | What HAMi-core does with it |
| --- | --- | --- |
| `CUDA_DEVICE_MEMORY_LIMIT_0` | `4096m` | Memory limit for the first visible GPU |
| `CUDA_DEVICE_SM_LIMIT` | `30` | Compute limit, as a percentage of GPU utilization |
| `CUDA_DEVICE_MEMORY_SHARED_CACHE` | a file path, one per container | Where all processes of the container record what they use |
| `/etc/ld.so.preload` | the path of `libvgpu.so` | Makes every process load HAMi-core |

Colab has no Kubernetes, so you take the device plugin's place. You set the variables yourself and load HAMi-core with `LD_PRELOAD`, which does for one process what `/etc/ld.so.preload` does for a container.

### Memory

Repeat the memory experiment, now with a 4096 MiB limit and a cache file for each program:

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/model-a.cache \
  nohup python /content/model.py model-a 2 > /content/model-a.log 2>&1 &
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/greedy.cache \
  nohup python /content/greedy.py > /content/greedy.log 2>&1 &
!sleep 15 && grep model-a /content/model-a.log && grep greedy /content/greedy.log
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/model-c.cache \
  nohup python /content/model.py model-c 2 > /content/model-c.log 2>&1 &
!sleep 15 && grep model-c /content/model-c.log
```

```{.text .output}
model-a sees 4096 MiB of GPU memory
model-a loaded 2 GiB of weights on Tesla T4
greedy holds 3 GiB of GPU memory
model-c sees 4096 MiB of GPU memory
model-c loaded 2 GiB of weights on Tesla T4
```

`model-a` and `model-c` see a 4096 MiB card and load their weights. `greedy` stops at 3 GiB: a fourth 1 GiB chunk would go over 4096 MiB, because the limit also counts the CUDA context, about 100 MiB. `model-c`, which failed in Lab 1, now loads, because `greedy` can only take its own share.

`nvidia-smi` reads memory through NVML, which HAMi-core also intercepts. Compare the host's view with the view from inside `model-a`'s slice:

```python
!nvidia-smi --query-gpu=memory.used,memory.total --format=csv
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/model-a.cache \
  nvidia-smi --query-gpu=memory.used,memory.total --format=csv 2>/dev/null
!pkill -f '/content/(model|greedy).py'
!sleep 5
```

```{.text .output}
memory.used [MiB], memory.total [MiB]
7477 MiB, 15360 MiB
memory.used [MiB], memory.total [MiB]
2150 MiB, 4096 MiB
```

The host sees the real 15360 MiB card, with the memory of all three programs in use. From inside `model-a`'s slice, the card has 4096 MiB, and only `model-a`'s 2150 MiB are in use. The GPU itself is not split. HAMi-core changes what a Pod's programs see and what they may take.

### Compute

Give the benchmark the limit a Pod with `nvidia.com/gpucores: 30` would get, and sample the GPU utilization once a second while it runs:

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
19 % 36 % 39 % 36 % 35 % 31 % 21 % 24 % 34 % 39 % 36 % 26 % 26 % 23 % 22 % 34 % 39 % 36 % 32 % 21 %
07:39:42 6.0 TFLOPS
07:39:47 6.8 TFLOPS
07:39:52 6.8 TFLOPS
07:39:57 6.5 TFLOPS
```

The utilization swings between 19% and 39%, and its average is 30%. HAMi-core holds back kernel launches: a background thread reads the process's utilization from NVML every 120 ms and allows more or fewer launches, so the limit holds on average over time. The benchmark keeps about 6.5 TFLOPS, a little under 30% of what it ran at alone in Lab 1.

## Lab 3: Calm the Noisy Neighbor

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Back to the problem from Lab 1: a training job next to the benchmark cut it to less than half its speed. Lab 2 showed how a compute limit works. Now put it where it matters, on the noisy neighbor.

Run the same experiment as in Lab 1, the benchmark alone first and then the training job next to it. This time the training job gets the limit a Pod with `nvidia.com/gpucores: 30` would get. The benchmark gets no limit at all:

```python
!nohup python /content/bench.py > /content/bench.log 2>&1 &
!sleep 20
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_SM_LIMIT=30 \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/training.cache \
  nohup python /content/training.py > /content/training.log 2>&1 &
!sleep 20 && cat /content/bench.log
!pkill -f '/content/(bench|training).py'
!sleep 5
```

```{.text .output}
07:40:12 23.5 TFLOPS
07:40:17 23.7 TFLOPS
07:40:22 23.5 TFLOPS
07:40:27 23.2 TFLOPS
07:40:32 19.8 TFLOPS
07:40:37 17.5 TFLOPS
07:40:42 15.3 TFLOPS
```

The benchmark runs at about 23.5 TFLOPS on its own, as in Lab 1. With the limited training job next to it, it stays between 15 and 20 TFLOPS. In Lab 1 it fell to about 11 TFLOPS. The training job still takes its share of the GPU, so the benchmark does not get back to its full speed. It keeps more of it, and nothing in the benchmark had to change.

In a cluster, the same thing happens when the training Pod asks for `nvidia.com/gpucores: 30`. The Pod next to it gets the rest of the card.

## Wrap-up

- **Memory is a hard limit, per Pod.** HAMi-core refuses any allocation over the limit and reports the limit as the card's size. The limit includes the CUDA context, and all processes of a container share it through the cache file.
- **Compute is an average.** HAMi-core holds back kernel launches so that utilization averages out at the limit. Single samples swing around it, and throughput follows only roughly.
- **The card is not split.** The host still sees one card. Isolation lives in a library inside the container, which is why HAMi works on GPUs without MIG, such as the T4.
- **In a cluster, you do not set the variables yourself.** HAMi's device plugin sets them for every container, from the `nvidia.com/gpumem` and `nvidia.com/gpucores` the Pod asks for. [Chapter 4 of the Hands-on Course](../course/04-enter-hami.md) shows the cluster side.

<!-- markdownlint-disable MD046 -->

??? question "A Pod with `nvidia.com/gpumem: 4096` runs an inference engine that reserves 0.9 of the GPU memory. How much does it reserve, and what would it reserve on the same card without HAMi?"

    About 3686 MiB, 0.9 of the 4096 MiB that HAMi-core reports as the card's total. Without HAMi, the engine sees the whole T4, 14913 MiB as CUDA reports it, and reserves about 13420 MiB. The fraction stays 0.9. The total it applies to follows HAMi's limit.

<!-- markdownlint-enable MD046 -->

Where to go next:

- [Hands-on Course](../course/index.md): the full story in nine chapters, from the GPU stack to quotas and troubleshooting
- [HAMi-core](https://github.com/Project-HAMi/HAMi-core){:target="_blank"}: the source of `libvgpu.so`

## Clean Up

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

When you are done, release the runtime with **Runtime → Disconnect and delete runtime**. Colab removes everything on it.
