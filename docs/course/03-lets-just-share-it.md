# Chapter 3: Let's Just Share It

[:simple-googlecolab: Open this chapter in Colab](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/en/03-lets-just-share-it.ipynb){ .md-button .colab-button target="_blank" }

## Scenario

In Chapter 2, one 2 GiB model took the whole T4 and the second model had to wait. The team does not want to buy a second card for a model that uses an eighth of the first one. NVIDIA's device plugin has a built-in sharing mode called time-slicing, and turning it on takes one configuration change. Before they turn it on in the cluster, the team wants to know what happens on the card itself when several models share it.

## What You'll Understand

- What actually happens on a GPU when several programs share it with no limits
- Why one program can take memory that another program needs
- Why programs on a shared GPU slow each other down
- Why a Pod that Kubernetes schedules successfully can still fail on the GPU
- What time-slicing, MPS, and MIG each share and each isolate

## Environment

This chapter takes about 20 minutes. It runs on Google Colab with the free T4 GPU.

Each program in this chapter stands in for one Pod. Kubernetes would start them in separate containers. Here they run as separate processes on the same card, which is what the GPU sees in both cases.

| Component | Version |
| --- | --- |
| GPU | Tesla T4, 15360 MiB |
| NVIDIA driver | 580.82.07 (CUDA 13.0) |
| PyTorch | 2.14.1+cu130 |

Verified on Colab on 2026-11-18.

## Step 1: Look at the Card

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

```python
!nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv
```

```{.text .output}
name, memory.total [MiB], memory.used [MiB]
Tesla T4, 15360 MiB, 0 MiB
```

One T4 with 15360 MiB of memory, and nothing running on it yet.

## Step 2: Run Two Models

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

The team's models are stood in for by a small script. It loads a given amount of weights into GPU memory and then waits, the way an inference server holds its model. It also prints how much GPU memory it can see. Write it to the Colab disk:

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

Start two models in the background, 2 GiB each, and read their logs:

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

Both models are running on the same card:

```python
!nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

```{.text .output}
pid, process_name, used_gpu_memory [MiB]
779, python3, 2150 MiB
782, python3, 2150 MiB
```

Two processes, 2150 MiB each: the 2 GiB of weights plus the CUDA context every process needs. This is what time-slicing gives you in a cluster: both Pods start, and both land on the same GPU. The scheduling problem from Chapter 2 is gone. The next two steps check what else the two models share.

## Step 3: Watch Programs Compete for Memory

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Look at the log lines again. Each model saw the whole card, 14913 MiB. That is a little less than the 15360 MiB `nvidia-smi` reports, because the driver keeps some memory for itself. Nothing told `model-b` how much of the card belongs to it, and nothing stops it from using more.

To see what that means, start a program that allocates GPU memory in 1 GiB chunks until the card is full, then holds it:

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

The log also holds two warnings from PyTorch about the allocation that failed. `greedy` expects that failure, so `grep` shows only its own line.

In a cluster, `greedy` would have asked Kubernetes for one share, like the others, and then taken 10 GiB. The card is nearly full. Now a third model of the same 2 GiB size arrives:

```python
!python /content/model.py model-c 2 2>&1 | tail -1
```

```{.text .output}
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 14.56 GiB of which 165.75 MiB is free. Process 779 has 2.10 GiB memory in use. Process 782 has 2.10 GiB memory in use. Process 860 has 10.10 GiB memory in use. Including non-PyTorch memory, this process has 102.00 MiB memory in use. Of the allocated memory 0 bytes is allocated by PyTorch, and 0 bytes is reserved by PyTorch but unallocated. If reserved but unallocated memory is large try setting PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True to avoid fragmentation.  See documentation for Memory Management  (https://docs.pytorch.org/docs/stable/notes/cuda.html#optimizing-memory-usage-with-pytorch-cuda-alloc-conf)
```

The error even lists who holds the card: `model-a` and `model-b` with 2.10 GiB each, and `greedy` with 10.10 GiB.

With time-slicing, Kubernetes would have scheduled `model-c` without complaint, because the node still had a free `nvidia.com/gpu` replica. On the GPU there is no memory left, and the model fails with `CUDA out of memory`. The scheduler counts replicas, and the GPU has no notion of replicas.

Stop `greedy` before the next step:

```python
!pkill -f /content/greedy.py
!sleep 5
```

## Step 4: Watch Programs Compete for Compute

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Next, check compute. The following program measures how fast it can multiply two matrices on the GPU and prints the result every 5 seconds:

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

A teammate's training job does nothing but multiply matrices as fast as it can:

```python
%%writefile /content/training.py
import torch
a = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
b = torch.randn(4096, 4096, device="cuda", dtype=torch.float16)
print("training started", flush=True)
while True:
    torch.matmul(a, b)
```

Start the benchmark, let it run alone for 30 seconds, then start the training job on the same card and wait another 30 seconds:

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

The benchmark ran at about 24 TFLOPS on its own. `training` started during the 12:53:50 interval, and from then on the benchmark stayed at about 11 TFLOPS. Nothing in the benchmark changed. The GPU now switches between two busy processes, and each gets roughly half of the time.

## What the Scheduler Sees

![With time-slicing, the scheduler sees four replicas and places four Pods, while the GPU has one memory pool and runs the processes in turns](../images/course-time-slicing.svg#only-light)
![With time-slicing, the scheduler sees four replicas and places four Pods, while the GPU has one memory pool and runs the processes in turns](../images/course-time-slicing-dark.svg#only-dark)

Time-slicing is a setting of the NVIDIA device plugin. With `replicas: 4`, the plugin reports the one T4 as four `nvidia.com/gpu` devices, and the node's capacity shows `"nvidia.com/gpu":"4"`. The scheduler places up to four Pods on the card. All four get the same GPU UUID, so their processes run on one GPU, exactly like the programs in Steps 2 to 4.

The scheduler only counts replicas. It knows nothing about the memory `greedy` took in Step 3 or the compute `training` took in Step 4. That is why `model-c` would be scheduled and then fail.

## The Principle: What Time-Slicing, MPS, and MIG Share and Isolate

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Time-slicing changes only what the device plugin reports. On the GPU, the processes of all Pods run in turns: the GPU switches between them in time slices. No per-Pod memory limit exists, and no per-Pod compute share is enforced. Steps 3 and 4 showed both.

NVIDIA offers two other ways to share a GPU:

- **MPS (Multi-Process Service).** A server process lets kernels from several processes run on the GPU at the same time. MPS can cap each client's GPU memory and the share of GPU threads it may use, and the NVIDIA device plugin has an MPS sharing mode that sets these caps evenly. All clients go through the same MPS server, so a fault in one client can affect the others.
- **MIG (Multi-Instance GPU).** The GPU is split in hardware into instances, each with its own memory and compute units. Isolation is strong, but only some data center GPUs support MIG, and each instance must use one of a fixed set of sizes. The T4 is not one of them:

```python
!nvidia-smi --query-gpu=name,mig.mode.current --format=csv
```

```{.text .output}
name, mig.mode.current
Tesla T4, [N/A]
```

|  | Time-slicing | MPS | MIG |
| --- | --- | --- | --- |
| Several Pods on one GPU | Yes | Yes | Yes, one per instance |
| Per-Pod memory limit | No | Yes | Yes, in hardware |
| Per-Pod compute limit | No | Yes | Yes, in hardware |
| Size of each share | Not defined | Equal shares in the device plugin | Fixed MIG profiles |
| GPU support | NVIDIA GPUs in general | Volta and newer (for memory and compute limits) | MIG-capable data center GPUs, such as A100 and H100 |

Time-slicing lets the scheduler place more Pods on a GPU. It does not limit how much memory or compute each Pod uses. Chapter 4 shows how HAMi adds these limits on the same T4.

## Verify

| Claim | Evidence |
| --- | --- |
| Several programs can run on one GPU | Step 2: `model-a` and `model-b` both run, two processes on the same card |
| Each program sees and can use the whole card's memory | Step 2 and Step 3: each model sees 14913 MiB, `greedy` takes 10 GiB |
| A program that fits the scheduler's count can still fail on the GPU | Step 3: `model-c` fails with `CUDA out of memory` |
| Compute is shared by contention | Step 4: the benchmark drops from about 24 to about 11 TFLOPS when `training` starts |
| The T4 cannot use MIG | The Principle: `mig.mode.current` is `[N/A]` |

## Common Pitfalls

**The log files are empty.** The model is still loading. Wait a few seconds and run `cat` again.

**`model-a` or `model-b` fails with `CUDA out of memory` in Step 2.** A `greedy` process from an earlier run still holds the card. Run `!nvidia-smi --query-compute-apps=pid,used_memory --format=csv` to find it, stop it with `pkill`, or restart the Colab session.

**A model fails with `CUDA out of memory` although Kubernetes shows free GPUs.** With time-slicing, free replicas do not mean free memory. Check the real usage with `nvidia-smi` on the node.

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. With `replicas: 4`, the node reports `nvidia.com/gpu: 4`, but there is one T4. What do the four devices stand for?"

    Four replicas of the same GPU, created by the device plugin's time-slicing setting. All four map to the same GPU UUID.

??? question "2. In a cluster, `model-c` would be scheduled and then fail. Why would the scheduler place it?"

    The scheduler only checks whether a replica of `nvidia.com/gpu` is free, and one was. GPU memory is not part of that check, and `greedy` had already taken it.

??? question "3. Why did the benchmark slow down when the training job started?"

    Nothing shares out GPU time between processes in fixed amounts. With two busy processes, each gets roughly half.

??? question "4. Which of time-slicing, MPS, and MIG can limit a Pod's GPU memory on a T4?"

    MPS. Time-slicing has no memory limit, and the T4 does not support MIG.

<!-- markdownlint-enable MD046 -->

## Hand-off

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Release the Colab runtime with **Runtime → Disconnect and delete runtime**. The next chapter opens its own notebook on a fresh runtime, so nothing from this one carries over, and a runtime left connected keeps using your free GPU time.

## Further Reading

- [Device sharing](https://project-hami.io/docs/key-features/device-sharing){:target="_blank"}: how HAMi shares a GPU between Pods
- [Device Plugin and DRA](https://project-hami.io/docs/core-concepts/device-plugin-and-dra){:target="_blank"}: how a GPU becomes a Kubernetes resource
- [Time-slicing GPUs in Kubernetes](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html){:target="_blank"}: NVIDIA's description of time-slicing and its limits
- [NVIDIA device plugin for Kubernetes](https://github.com/NVIDIA/k8s-device-plugin){:target="_blank"}: the time-slicing and MPS sharing options
- [Multi-Process Service](https://docs.nvidia.com/deploy/mps/){:target="_blank"}: how MPS works and which limits it supports
- [MIG User Guide](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/){:target="_blank"}: supported GPUs and MIG profiles
