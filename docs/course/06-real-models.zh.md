# 第 6 章：运行真实模型

[:simple-googlecolab: 在 Colab 中打开本章](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/zh/06-real-models.ipynb){ .md-button .colab-button target="_blank" }

## 场景

前面几章的替身模型只占显存。团队真正的服务跑在 vLLM 上，这是一个推理引擎，启动时会拿走一部分显存，用来存放 KV cache。控制它的参数是 `--gpu-memory-utilization`，默认 0.9。在共享的卡上，团队需要知道：这个 0.9 到底是谁的 0.9？

## 你将理解

- vLLM 如何决定拿走多少显存
- 两个 vLLM 实例在没有限制的情况下共用一张卡会发生什么
- HAMi 的显存限制如何改变 vLLM 的预算
- 在 GPU 切片上如何设置 `--gpu-memory-utilization`

## 实验环境

本章大约需要 30 分钟，大部分时间花在安装 vLLM 和启动服务上。在 Google Colab 上使用免费的 T4 GPU 运行。安装 vLLM 和下载模型需要几分钟。

| 组件 | 版本 |
| --- | --- |
| GPU | Tesla T4，15360 MiB |
| NVIDIA 驱动 | 580.82.07（CUDA 13.0） |
| vLLM | 0.34.0，安装时会装上 PyTorch 2.14.0+cu130 |
| 模型 | `Qwen/Qwen2.5-0.5B-Instruct` |
| HAMi-core | commit `1721252`，即 HAMi v2.11.0 自带的版本 |

于 2026-11-19 在 Colab 上验证。

## 背后的原理：总量的一个比例

vLLM 启动时向 CUDA 查询 GPU 的空闲显存和总显存，然后计算自己的预算：

```text
预算 = 总显存 × gpu_memory_utilization
```

vLLM 加载模型，把预算里剩下的部分变成 KV cache。如果卡上已经有别的进程占了大部分显存，预算就放不下，vLLM 会在启动过程中失败。预算随 CUDA 报告的总显存而变。

HAMi-core 用 Pod 的限制值回答的正是这个 CUDA 查询，第 4 章的 `model-a` 已经展示过。在一个申请了 `nvidia.com/gpumem: 6144` 的 Pod 里，总显存就是 6144 MiB，`--gpu-memory-utilization 0.9` 指的是这个切片的 0.9。

## 步骤 1：安装 vLLM 并编译 HAMi-core

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

```python
!pip install -q vllm==0.34.0
!python -c "import vllm, torch; print('vllm', vllm.__version__, 'torch', torch.__version__)"
```

```{.text .output}
vllm 0.34.0 torch 2.14.0+cu130
```

HAMi-core 的编译方式和第 4 章一样：

```python
!rm -rf /content/HAMi-core && git clone -q https://github.com/Project-HAMi/HAMi-core /content/HAMi-core
!cd /content/HAMi-core && git checkout -q 17212525d27ac156955ab940c5d51df33d9e0d09 && git log --oneline -1
!cd /content/HAMi-core && mkdir -p build && cd build && (cmake .. -DDLSYM_HOOK_ENABLE=1 -DMULTIPROCESS_LIMIT_ENABLE=1 -DHOOK_MEMINFO_ENABLE=1 -DHOOK_NVML_ENABLE=1 -DCMAKE_BUILD_TYPE=Debug -DTEST_DEVICE_ID=0 && make -j$(nproc) vgpu) > /content/build.log 2>&1; echo "build exit code: $?"
```

```{.text .output}
1721252 (HEAD) Merge pull request #391 from alwaysprince05/fix/vmm-release-while-mapped
build exit code: 0
```

## 步骤 2：先看到问题

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

用默认设置启动一个 vLLM 服务，就像一个团队在一张自以为是共享的卡上部署它那样：

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

vLLM 拿走了 15360 MiB 中的 13467 MiB。CUDA 报告的总显存是 14913 MiB，和第 2 章一样，它的 0.9 约为 13420 MiB。模型本身很小，所以预算里有 13.15 GiB 变成了 KV cache。

现在第二个团队在同一张卡上启动自己的服务：

```python
!timeout 300 vllm serve Qwen/Qwen2.5-0.5B-Instruct --port 8002 --dtype half --max-model-len 2048 --enforce-eager > /content/vllm-b.log 2>&1; echo "exit code: $?"
!grep -E 'OutOfMemoryError' /content/vllm-b.log | tail -n 1 | cut -c1-184
```

```{.text .output}
exit code: 1
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 150.00 MiB. GPU 0 has a total capacity of 14.56 GiB of which 43.81 MiB is free. Process 10870 has 13.15 GiB memory in use.
```

第二个服务退出了。它加载了自己的一份模型，接着在测量自己能用多少显存时耗尽了显存：卡上只剩 43.81 MiB，第一个服务的引擎进程（PID 10870）占着 13.15 GiB。按默认设置，一个服务就拿走了整张卡，第二个团队事先却无从知道。

停掉第一个服务：

```python
!pkill -f 'vllm serve'
!sleep 10
```

## 步骤 3：给每个服务一个切片

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

重新启动两个服务，每个都加载 HAMi-core，并设置 6144 MiB 的限制，就像两个申请了 `nvidia.com/gpumem: 6144` 的 Pod 拿到的那样。`--gpu-memory-utilization` 保持默认：

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

每个服务报告的 KV cache 都是 4.61 GiB。它的预算是 6144 MiB 切片的 0.9，约 5530 MiB，模型和 KV cache 都放在里面。在卡上，`nvidia-smi` 显示每个引擎进程占 4776 MiB，两个服务加起来，卡上还剩 5 GiB 以上的空闲。

两个服务都能响应请求：

```python
!for port in 8001 8002; do curl -s localhost:$port/v1/completions -H 'Content-Type: application/json' -d '{"model": "Qwen/Qwen2.5-0.5B-Instruct", "prompt": "GPU sharing means", "max_tokens": 16}' | python -c "import sys, json; print(json.load(sys.stdin)['choices'][0]['text'])"; done
```

```{.text .output}
 that the GPU is shared among multiple cores in a multi-core computer system. It
 that the GPU is shared among multiple cores in a multi-core computer system. It
```

## 步骤 4：比例是切片的比例

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

一个常见的错误是按 Pod 占整张卡的比例来算 `--gpu-memory-utilization`：15360 MiB 中的 6144 MiB 是 0.4。在 HAMi 下，这个 0.4 会作用在 6144 MiB 的切片上：

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

设成 0.4 时，预算是 6144 MiB 的 0.4，约 2460 MiB，留给 KV cache 的只有 1.01 GiB，不到步骤 3 里 4.61 GiB 的四分之一。KV cache 决定了一个服务同时能容纳多少请求、多长的上下文，所以在同样的切片上，这个服务能承担的负载要少得多。

## 在切片上怎么设置

- 用 `nvidia.com/gpumem` 设置服务应该拿到的显存，`--gpu-memory-utilization` 保持在默认值附近。这个比例是切片的比例。
- 在 1.0 以下留一些余量。vLLM 自己不统计的显存，比如 CUDA context，也会计入 HAMi 的限制，第 4 章的 `greedy` 已经展示过。
- 没有 HAMi 时，只有 `--gpu-memory-utilization` 能把两个服务隔开，每个团队都得知道别的团队设了多少。

## 验证

| 结论 | 证据 |
| --- | --- |
| vLLM 默认拿走总显存的一个比例 | 步骤 2：`vllm-a` 拿走了 15360 MiB 中的 13467 MiB |
| 共享的卡上第二个服务无法启动 | 步骤 2：`vllm-b` 报 `CUDA out of memory` 退出，只剩 43.81 MiB 空闲 |
| 在 HAMi 下，这个比例是切片的比例 | 步骤 3：6144 MiB 切片上有 4.61 GiB 的 KV cache |
| 两个服务可以在各自的切片上并排运行 | 步骤 3：两个都能响应请求 |
| 按整张卡算出来的比例太小 | 步骤 4：KV cache 只有 1.01 GiB，不再是 4.61 GiB |

## 常见问题

**`pip install vllm==0.34.0` 替换了 PyTorch。** vLLM 会固定自己需要的 PyTorch 版本。本章把 vLLM 固定在验证时用的版本，因为它的显存处理方式在不同版本之间会变。在一个新的 Colab 会话里运行本章，如果安装后 Colab 提示重启会话，就重启一下。

**vLLM 报 `Engine core initialization failed`。** 到日志前面找根本原因，比如对日志执行 `grep OutOfMemoryError`。如果那里是 `CUDA out of memory`，说明卡上已经有别的进程占着显存。在没有 HAMi 的共享卡上，调低 `--gpu-memory-utilization`。在 HAMi 下，检查这个服务是否有自己的缓存文件，使用同一个缓存文件的进程共用一份限制。

**十分钟后服务还没就绪。** 看一下它日志的末尾。第一次启动要下载模型、编译 kernel，耗时最长。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. vLLM 用 `--gpu-memory-utilization` 乘以什么？"

    vLLM 启动时 CUDA 报告的 GPU 总显存。在 HAMi 下，就是 Pod 的 `gpumem` 限制。

??? question "2. 步骤 2 里第二个服务为什么启动不了？"

    第一个服务已经拿走了整张卡的 0.9。第二个服务也按整张卡的 0.9 来分配，结果在只剩 43.81 MiB 时耗尽了显存。

??? question "3. 一个 Pod 分到了 15360 MiB 卡中的 6144 MiB，`--gpu-memory-utilization` 应该设多少？"

    在默认值附近，比如 0.9。这个比例是 6144 MiB 切片的比例。设成 0.4 的话，vLLM 只会拿到切片的 0.4。

<!-- markdownlint-enable MD046 -->

## 交接

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

选择 **代码执行程序 → 断开连接并删除运行时**，释放这个 Colab 运行时。不断开的运行时会继续消耗你的免费 GPU 时长。

第 7 到 9 章在第 5 章的 kind 集群里运行。

## 延伸阅读

- [vLLM engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html){:target="_blank"}：`--gpu-memory-utilization` 及相关参数
- [设备资源隔离](https://project-hami.io/zh/docs/key-features/device-resource-isolation){:target="_blank"}：HAMi 如何隔离显存和算力
