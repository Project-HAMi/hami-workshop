# Chapter 6: Running Real Models

[:simple-googlecolab: Open this chapter in Colab](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/en/06-real-models.ipynb){ .md-button .colab-button target="_blank" }

## Scenario

The stand-in models from the earlier chapters only held memory. The team's real services run on vLLM, an inference engine that takes a share of GPU memory when it starts and fills it with its KV cache. The flag is `--gpu-memory-utilization`, 0.9 by default. On a shared card, the team needs to know: 0.9 of what?

## What You'll Understand

- How vLLM decides how much GPU memory to take
- What happens when two vLLM instances share a card without limits
- How HAMi's memory limit changes vLLM's budget
- How to choose `--gpu-memory-utilization` on a GPU slice

## Environment

This chapter takes about 30 minutes, most of it installing vLLM and starting the servers. It runs on Google Colab with the free T4 GPU. Installing vLLM and downloading the model takes several minutes.

| Component | Version |
| --- | --- |
| GPU | Tesla T4, 15360 MiB |
| NVIDIA driver | 580.82.07 (CUDA 13.0) |
| vLLM | 0.34.0, which installs PyTorch 2.14.0+cu130 |
| Model | `Qwen/Qwen2.5-0.5B-Instruct` |
| HAMi-core | commit `1721252`, the version shipped with HAMi v2.11.0 |

Verified on Colab on 2026-11-19.

## The Principle: A Fraction of the Total

When vLLM starts, it asks CUDA for the GPU's free and total memory and computes its budget:

```text
budget = total memory × gpu_memory_utilization
```

vLLM loads the model and turns the rest of the budget into KV cache. If another process already holds most of the card, the budget does not fit, and vLLM fails while it starts. The budget follows whatever total CUDA reports.

HAMi-core answers that same CUDA query with the Pod's limit, as `model-a` showed in Chapter 4. Inside a Pod with `nvidia.com/gpumem: 6144`, the total is 6144 MiB, and `--gpu-memory-utilization 0.9` means 0.9 of the slice.

## Step 1: Install vLLM and Build HAMi-core

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

```python
!pip install -q vllm==0.34.0
!python -c "import vllm, torch; print('vllm', vllm.__version__, 'torch', torch.__version__)"
```

```{.text .output}
vllm 0.34.0 torch 2.14.0+cu130
```

HAMi-core is built the same way as in Chapter 4:

```python
!rm -rf /content/HAMi-core && git clone -q https://github.com/Project-HAMi/HAMi-core /content/HAMi-core
!cd /content/HAMi-core && git checkout -q 17212525d27ac156955ab940c5d51df33d9e0d09 && git log --oneline -1
!cd /content/HAMi-core && mkdir -p build && cd build && (cmake .. -DDLSYM_HOOK_ENABLE=1 -DMULTIPROCESS_LIMIT_ENABLE=1 -DHOOK_MEMINFO_ENABLE=1 -DHOOK_NVML_ENABLE=1 -DCMAKE_BUILD_TYPE=Debug -DTEST_DEVICE_ID=0 && make -j$(nproc) vgpu) > /content/build.log 2>&1; echo "build exit code: $?"
```

```{.text .output}
1721252 (HEAD) Merge pull request #391 from alwaysprince05/fix/vmm-release-while-mapped
build exit code: 0
```

## Step 2: See the Problem First

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Start one vLLM server with the default settings, the way a team would deploy it on a card it believes it shares:

```python
!nohup vllm serve Qwen/Qwen2.5-0.5B-Instruct --port 8001 --dtype half --max-model-len 2048 --enforce-eager > /content/vllm-a.log 2>&1 &
!for i in $(seq 1 120); do curl -s localhost:8001/health && break; sleep 5; done; echo "vllm-a ready"
!grep -E 'Available KV cache memory' /content/vllm-a.log
!nvidia-smi --query-gpu=memory.used,memory.total --format=csv
```

```{.text .output}
vllm-a ready
(EngineCore pid=10870) INFO 11-19 02:36:54 [gpu_worker.py:795] Available KV cache memory: 13.15 GiB
memory.used [MiB], memory.total [MiB]
13467 MiB, 15360 MiB
```

vLLM took 13467 of the 15360 MiB. CUDA reported 14913 MiB in total, as in Chapter 2, and 0.9 of that is about 13420 MiB. The model itself is small, so 13.15 GiB of the budget became KV cache.

Now a second team starts its own server on the same card:

```python
!timeout 300 vllm serve Qwen/Qwen2.5-0.5B-Instruct --port 8002 --dtype half --max-model-len 2048 --enforce-eager > /content/vllm-b.log 2>&1; echo "exit code: $?"
!grep -E 'OutOfMemoryError' /content/vllm-b.log | tail -n 1 | cut -c1-184
```

```{.text .output}
exit code: 1
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 150.00 MiB. GPU 0 has a total capacity of 14.56 GiB of which 43.81 MiB is free. Process 10870 has 13.15 GiB memory in use.
```

The second server exits. It loaded its own copy of the model, then ran out of memory while measuring how much it could use: 43.81 MiB were free, and the first server's engine process, PID 10870, held 13.15 GiB. With the defaults, one server took the card, and nothing told the second team.

Stop the first server:

```python
!pkill -f 'vllm serve'
!sleep 10
```

## Step 3: Give Each Server a Slice

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Start both servers again, each with HAMi-core and a 6144 MiB limit, as two Pods with `nvidia.com/gpumem: 6144` would get. Keep `--gpu-memory-utilization` at its default:

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=6144m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/vllm-a.cache \
  nohup vllm serve Qwen/Qwen2.5-0.5B-Instruct --port 8001 --dtype half --max-model-len 2048 --enforce-eager > /content/vllm-a.log 2>&1 &
!for i in $(seq 1 120); do curl -s localhost:8001/health && break; sleep 5; done; echo "vllm-a ready"
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=6144m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/vllm-b.cache \
  nohup vllm serve Qwen/Qwen2.5-0.5B-Instruct --port 8002 --dtype half --max-model-len 2048 --enforce-eager > /content/vllm-b.log 2>&1 &
!for i in $(seq 1 120); do curl -s localhost:8002/health && break; sleep 5; done; echo "vllm-b ready"
!grep -h 'Available KV cache memory' /content/vllm-a.log /content/vllm-b.log
!nvidia-smi --query-compute-apps=pid,used_memory --format=csv
```

```{.text .output}
vllm-a ready
vllm-b ready
(EngineCore pid=6410) INFO 11-19 02:03:46 [gpu_worker.py:795] Available KV cache memory: 4.61 GiB
(EngineCore pid=6754) INFO 11-19 02:04:37 [gpu_worker.py:795] Available KV cache memory: 4.61 GiB
pid, used_gpu_memory [MiB]
6410, 4776 MiB
6754, 4776 MiB
```

Each server reports 4.61 GiB of KV cache. Its budget was 0.9 of the 6144 MiB slice, about 5530 MiB, and the model and the KV cache fit in it. On the card, `nvidia-smi` shows 4776 MiB for each engine process, and the two servers together leave more than 5 GiB of the card free.

Both servers answer requests:

```python
!for port in 8001 8002; do curl -s localhost:$port/v1/completions -H 'Content-Type: application/json' -d '{"model": "Qwen/Qwen2.5-0.5B-Instruct", "prompt": "GPU sharing means", "max_tokens": 16}' | python -c "import sys, json; print(json.load(sys.stdin)['choices'][0]['text'])"; done
```

```{.text .output}
 that the GPU is shared among multiple cores in a multi-core computer system. It
 that the GPU is shared among multiple cores in a multi-core computer system. It
```

## Step 4: The Fraction Is of the Slice

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

A common mistake is to compute `--gpu-memory-utilization` as the Pod's share of the whole card: 6144 of 15360 MiB is 0.4. Under HAMi, that 0.4 is applied to the 6144 MiB slice:

```python
!pkill -f 'vllm serve'
!sleep 10
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=6144m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/vllm-c.cache \
  nohup vllm serve Qwen/Qwen2.5-0.5B-Instruct --port 8001 --dtype half --max-model-len 2048 --enforce-eager --gpu-memory-utilization 0.4 > /content/vllm-c.log 2>&1 &
!for i in $(seq 1 120); do curl -s localhost:8001/health && break; sleep 5; done; echo "vllm-c ready"
!grep 'Available KV cache memory' /content/vllm-c.log
```

```{.text .output}
vllm-c ready
(EngineCore pid=7172) INFO 11-19 02:05:40 [gpu_worker.py:795] Available KV cache memory: 1.01 GiB
```

With 0.4, the budget is 0.4 of 6144 MiB, about 2460 MiB, and only 1.01 GiB is left for KV cache, less than a quarter of the 4.61 GiB in Step 3. The KV cache decides how many requests and how much context a server can hold at once, so this server would handle far less load on the same slice.

## Choosing the Value on a Slice

- Set `nvidia.com/gpumem` to the memory the service should have, and keep `--gpu-memory-utilization` close to its default. The fraction is of the slice.
- Leave some room below 1.0. Memory outside vLLM's own accounting, such as the CUDA context, counts against the HAMi limit too, as `greedy` showed in Chapter 4.
- Without HAMi, `--gpu-memory-utilization` is the only thing that keeps two servers apart, and each team has to know what the others set.

## Verify

| Claim | Evidence |
| --- | --- |
| vLLM takes a fraction of the total by default | Step 2: `vllm-a` takes 13467 of 15360 MiB |
| A second server on a shared card cannot start | Step 2: `vllm-b` exits with `CUDA out of memory`, 43.81 MiB free |
| Under HAMi, the fraction is of the slice | Step 3: 4.61 GiB of KV cache on a 6144 MiB slice |
| Two servers run side by side on slices | Step 3: both answer requests |
| A fraction computed from the whole card is too small | Step 4: 1.01 GiB of KV cache, down from 4.61 GiB |

## Common Pitfalls

**`pip install vllm==0.34.0` replaces PyTorch.** vLLM pins its own PyTorch version. This chapter pins vLLM to the version it was verified with, since its memory handling changes between releases. Run this chapter in a fresh Colab session, and restart the session if Colab asks for it after the install.

**vLLM fails with `Engine core initialization failed`.** Look for the root cause earlier in the log, for example `grep OutOfMemoryError` on it. A `CUDA out of memory` there means another process already holds memory on the card. On a shared card without HAMi, lower `--gpu-memory-utilization`. Under HAMi, check that the server has its own cache file, since processes with the same cache file share one limit.

**The server is not ready after ten minutes.** Read the end of its log. The first start downloads the model and compiles kernels, which takes longest.

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. What does vLLM multiply `--gpu-memory-utilization` with?"

    The total GPU memory that CUDA reports when vLLM starts. Under HAMi, that is the Pod's `gpumem` limit.

??? question "2. Why could the second server not start in Step 2?"

    The first server had taken 0.9 of the card. The second one also aimed for 0.9 of the card, and ran out of memory with 43.81 MiB free.

??? question "3. A Pod gets 6144 MiB of a 15360 MiB card. What should `--gpu-memory-utilization` be?"

    Close to the default, such as 0.9. The fraction is of the 6144 MiB slice. Setting it to 0.4 would give vLLM 0.4 of the slice.

<!-- markdownlint-enable MD046 -->

## Hand-off

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Release the Colab runtime with **Runtime → Disconnect and delete runtime**. A runtime left connected keeps using your free GPU time.

Chapters 7 to 9 run in the kind cluster from Chapter 5.

## Further Reading

- [vLLM engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html){:target="_blank"}: `--gpu-memory-utilization` and related settings
- [Device resource isolation](https://project-hami.io/docs/key-features/device-resource-isolation){:target="_blank"}: how HAMi isolates memory and compute
