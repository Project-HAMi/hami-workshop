# 第 9 章：出故障了

[:simple-googlecolab: 在 Colab 中打开本章](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/zh/09-something-broke.ipynb){ .md-button .colab-button target="_blank" }

## 场景

周一早上来了四条消息：一个本该只有 4 GiB 的模型看到了整张卡，一个模型一点显存都申请不到，一个模型在另一个模型启动后就失败了，还有两个 Pod 从周五起一直 `Pending`。前面几章团队已经见过 HAMi 的每个部件，现在要找出是哪个部件出了问题。

## 你将理解

- 找原因之前，先把症状归到某一层
- HAMi-core 配置出错时，从程序内部看是什么样子
- 如何读懂调度器给出的 `Pending` 原因
- 每一类症状应该先执行哪条命令

## 实验环境

本章大约需要 20 分钟。故障 1 到 3 在 Google Colab 上使用免费的 T4 GPU 运行。故障 4 和 5 在第 5 章的 kind 集群里运行。

| 组件 | 版本 |
| --- | --- |
| GPU | Tesla T4，15360 MiB |
| NVIDIA 驱动 | 580.82.07（CUDA 13.0） |
| HAMi-core | commit `1721252`，即 HAMi v2.11.0 自带的版本 |
| kind（故障 4 和 5） | 0.33.0，Kubernetes v1.37.0 |
| HAMi（故障 4 和 5） | v2.11.0 chart，mock Device Plugin |

于 2026-11-19 在 Colab 上验证。故障 4 和 5 于 2026-11-18 验证。

## 背后的原理：先找到是哪一层

第 1 章从硬件开始逐层检查了 GPU。HAMi 在这个栈里加了两处：决定 Pod 去哪里的调度器，以及在容器里执行限制的 HAMi-core。每种症状指向一层，每一层都有一条首先要执行的命令：

| 症状 | 层 | 首先执行 |
| --- | --- | --- |
| 节点上 `nvidia-smi` 失败 | 驱动，第 1 章第 2、3 层 | `nvidia-smi`、`lsmod \| grep nvidia` |
| GPU Pod 看不到任何 GPU | 容器运行时，第 1 章第 4 层 | `kubectl exec <pod> -- ls /dev/nvidia*` |
| 节点上没有 `nvidia.com/gpu` | Device Plugin，第 2 章 | `kubectl get node <node> -o jsonpath='{.status.allocatable}'` |
| Pod 处于 `Pending` | HAMi 调度器，第 5 章 | `kubectl get events --field-selector involvedObject.name=<pod>` |
| Pod 在创建时被拒绝 | 配额，第 8 章 | `kubectl apply` 的报错信息 |
| 程序无视限制，或者每次申请都失败 | HAMi-core，第 4 章 | 在容器里执行 `env \| grep CUDA_DEVICE` 和 `cat /etc/ld.so.preload` |

从症状可能来自的最低一层开始查。这一层正常，再往上一层。

下面每个故障都故意弄坏一样东西。先看症状，判断是哪一层，再看原因和修复方法。

## 准备 Colab

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

和第 4 章一样，写入替身模型并编译 HAMi-core：

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
!rm -rf /content/HAMi-core && git clone -q https://github.com/Project-HAMi/HAMi-core /content/HAMi-core
!cd /content/HAMi-core && git checkout -q 17212525d27ac156955ab940c5d51df33d9e0d09 && git log --oneline -1
!cd /content/HAMi-core && mkdir -p build && cd build && (cmake .. -DDLSYM_HOOK_ENABLE=1 -DMULTIPROCESS_LIMIT_ENABLE=1 -DHOOK_MEMINFO_ENABLE=1 -DHOOK_NVML_ENABLE=1 -DCMAKE_BUILD_TYPE=Debug -DTEST_DEVICE_ID=0 && make -j$(nproc) vgpu) > /content/build.log 2>&1; echo "build exit code: $?"
```

```{.text .output}
1721252 (HEAD) Merge pull request #391 from alwaysprince05/fix/vmm-release-while-mapped
build exit code: 0
```

## 故障 1：限制被无视

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

`model-a` 本该有 4096 MiB 的限制：

```python
!LD_PRELOAD=/content/HAMi-core/build/vgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/fault-1.cache \
  timeout 30 python /content/model.py model-a 2 2>&1 | grep -E 'model-a|ld.so' | sort -u
```

```{.text .output}
ERROR: ld.so: object '/content/HAMi-core/build/vgpu.so' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.
model-a loaded 2 GiB of weights on Tesla T4
model-a sees 14913 MiB of GPU memory
```

**症状。** 程序启动了，加载了权重，看到的是 14913 MiB，也就是整张卡。动态链接器提示无法预加载 `vgpu.so`，并忽略了它。

**层。** 程序能运行，但看到的是整张卡，说明限制根本没生效。问题在 HAMi-core 这一层。

**原因。** 库的名字是 `libvgpu.so`。动态链接器打不开 `LD_PRELOAD` 里写的文件时，会跳过它，照样启动程序，只是没有 HAMi-core。

**修复。** 把 `LD_PRELOAD` 指向 `libvgpu.so`。在集群里，检查容器中是否存在 `/etc/ld.so.preload`，以及它写的文件是否存在。

## 故障 2：每次申请都失败

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096 \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/fault-2.cache \
  timeout 30 python /content/model.py model-a 2 2>&1 | grep -E 'model-a|OutOfMemoryError|HAMI-core ERROR' | head -n 4
```

```{.text .output}
model-a sees 0 MiB of GPU memory
[HAMI-core ERROR (pid:2484 thread=136522504120128 allocator.c:40)]: Device 0 OOM 2254438400 / 4096
[HAMI-core ERROR (pid:2484 thread=136522504120128 allocator.c:40)]: Device 0 OOM 2254438400 / 4096
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 4.00 KiB of which 0 bytes is free. Including non-PyTorch memory, this process has 102.00 MiB memory in use. Of the allocated memory 0 bytes is allocated by PyTorch, and 0 bytes is reserved by PyTorch but unallocated. If reserved but unallocated memory is large try setting PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True to avoid fragmentation.  See documentation for Memory Management  (https://docs.pytorch.org/docs/stable/notes/cuda.html#optimizing-memory-usage-with-pytorch-cuda-alloc-conf)
```

**症状。** 程序看到的是 0 MiB。HAMi-core 按 4096 的限制拒绝了 2 GiB 的申请，PyTorch 报告这张卡的总容量是 4.00 KiB。

**层。** HAMi-core 已经加载了，因为它报告了限制，但限制的值不对。

**原因。** `CUDA_DEVICE_MEMORY_LIMIT_0=4096` 没有写单位，HAMi-core 把不带单位的数字当作字节，限制就成了 4 KiB。

**修复。** 写成 `4096m`。HAMi 的 Device Plugin 总会带上单位。这个故障出现在手动设置变量的时候，比如写在 Pod spec 里。

## 故障 3：一个模型在另一个旁边失败

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

两个各 4096 MiB 的模型，先后启动：

```python
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/shared.cache \
  nohup python /content/model.py model-a 3 > /content/model-a.log 2>&1 &
!sleep 15 && grep model-a /content/model-a.log
!LD_PRELOAD=/content/HAMi-core/build/libvgpu.so \
  CUDA_DEVICE_MEMORY_LIMIT_0=4096m \
  CUDA_DEVICE_MEMORY_SHARED_CACHE=/tmp/shared.cache \
  timeout 60 python /content/model.py model-b 3 2>&1 | grep -E 'model-b|OutOfMemoryError' | cut -c1-160
```

```{.text .output}
model-a sees 4096 MiB of GPU memory
model-a loaded 3 GiB of weights on Tesla T4
model-b sees 4096 MiB of GPU memory
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 3.00 GiB. GPU 0 has a total capacity of 4.00 GiB of which 820.00 MiB is free. Process 2513 has 3.1
```

**症状。** `model-b` 看到的是自己那张 4096 MiB 的卡，却申请不到 3 GiB，而真实的卡上还有 10 GiB 以上的空闲。

**层。** HAMi-core 已经加载，限制也是对的。问题出在两个程序之间。

**原因。** 两个程序都用了 `/tmp/shared.cache`。HAMi-core 把使用同一个缓存文件的所有进程当作同一个容器，所以 `model-a` 和 `model-b` 共用一份 4096 MiB 的限制，而 `model-a` 已经占了其中的 3 GiB。

**修复。** 给每个 Pod 一个自己的缓存文件。HAMi 的 Device Plugin 会为每个容器这样做。如果没有设置这个变量，HAMi-core 会用 `POD_UID` 和 `CONTAINER_NAME` 两个变量拼出一个路径。这两个变量也没有时，才退回到 `/tmp/cudevshr.cache`，所有这样的进程都共用这一个文件。

```python
!pkill -f /content/model.py
```

## 故障 4：Pending，申请太大

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

一个 Pod 申请 50000 MiB：

```bash
kubectl apply -f examples/course/09-something-broke/too-big.yaml
sleep 10
kubectl get pod too-big
kubectl get events --field-selector involvedObject.name=too-big,reason=FailedScheduling -o custom-columns=MESSAGE:.message | tail -1
```

```{.text .output}
pod/too-big created
NAME      READY   STATUS    RESTARTS   AGE
too-big   0/1     Pending   0          10s
0/1 nodes are available: 1 2/2 CardInsufficientMemory. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.
```

**症状。** `Pending`，两张卡都是 `CardInsufficientMemory`。

**层。** HAMi 调度器。事件里写明了它拒绝每张卡的原因。

**原因。** 每张卡只有 40960 MiB，不管集群多空，50000 MiB 都放不进一张卡。

**修复。** 减少每张卡上的显存申请，或者用 `nvidia.com/gpu` 申请更多张卡。如果卡够大只是满了，第 5 章讲了放置方式和策略能怎么帮忙。

```bash
kubectl delete -f examples/course/09-something-broke/too-big.yaml
```

## 故障 5：Pending，卡的型号不对

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

一个 Pod 申请 H100：

```yaml
metadata:
  name: wrong-type
  annotations:
    nvidia.com/use-gputype: "H100"
```

```bash
kubectl apply -f examples/course/09-something-broke/wrong-type.yaml
sleep 10
kubectl get events --field-selector involvedObject.name=wrong-type,reason=FailedScheduling -o custom-columns=MESSAGE:.message | tail -1
```

```{.text .output}
pod/wrong-type created
0/1 nodes are available: 1 2/2 CardTypeMismatch. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.
```

**症状。** `Pending`，两张卡都是 `CardTypeMismatch`。

**层。** 还是 HAMi 调度器，这次是按卡型号过滤。

**原因。** 第 5 章步骤 1 已经看到，集群里是 `NVIDIA-A100-SXM4-40GB`，没有哪种型号包含 `H100`。

**修复。** 申请一个存在的型号。Pod 处于 `Pending` 时，只要它有变化，调度器就会重试，所以改一下 annotation 就够了：

```bash
kubectl annotate pod wrong-type nvidia.com/use-gputype=A100 --overwrite
kubectl wait --for=condition=Ready pod/wrong-type --timeout=120s
echo "wrong-type $(kubectl get pod wrong-type -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}')"
```

```{.text .output}
pod/wrong-type annotated
pod/wrong-type condition met
wrong-type GPU-mock-1,NVIDIA,4096,0:;
```

`A100` 只要能匹配型号名称的一部分就够了。

```bash
kubectl delete -f examples/course/09-something-broke/wrong-type.yaml
```

## 这里弄不坏的故障

有些故障需要真实的 GPU 节点才能复现。下面列出它们所在的层和首先要做的检查：

| 故障 | 层 | 你会看到 | 首先检查 |
| --- | --- | --- | --- |
| 内核升级后驱动没有加载 | 驱动 | 节点上 `nvidia-smi` 失败 | `lsmod \| grep nvidia`、`dmesg \| grep -i nvidia` |
| `nvidia` 不是 containerd 的默认运行时 | 容器运行时 | Pod 调度成功，但看不到 GPU | containerd 的配置，见第 1 章第 4 层 |
| GPU 节点缺少 `gpu=on` 标签 | Device Plugin | 节点上没有 `hami-device-plugin` Pod，也没有 `nvidia.com/gpu` | `kubectl get node --show-labels`。chart 只在匹配 `devicePlugin.nvidiaNodeSelector` 的节点上运行 Device Plugin，默认是 `gpu: "on"` |
| NVIDIA Device Plugin 还和 HAMi 的一起在运行 | Device Plugin | 两者都在注册 `nvidia.com/gpu` | `kubectl get daemonsets -A` |

## 验证

| 结论 | 证据 |
| --- | --- |
| preload 路径写错，程序就没有任何限制 | 故障 1：`model-a` 看到 14913 MiB，动态链接器忽略了 `vgpu.so` |
| 不带单位的限制被当作字节 | 故障 2：限制被当成 4096 字节，卡只有 4.00 KiB |
| 使用同一个缓存文件的进程共用一份限制 | 故障 3：`model-b` 在 `model-a` 旁边失败 |
| 调度器会写明拒绝每张卡的原因 | 故障 4 和 5：`CardInsufficientMemory`、`CardTypeMismatch` |
| 修改 `Pending` 的 Pod 会让调度器重试 | 故障 5：改好 annotation 后 `wrong-type` 运行起来了 |

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. HAMi Pod 里的程序看到了整张卡。该查哪一层？用什么命令？"

    HAMi-core。检查容器里是否存在 `/etc/ld.so.preload`、它写的文件是否存在，以及 `CUDA_DEVICE_MEMORY_LIMIT_0` 是否设置了。

??? question "2. Pod 处于 `Pending`，HAMi 在哪里说明原因？"

    在 Pod 的 `FailedScheduling` 事件里。它写明了拒绝每张卡的原因，比如 `CardInsufficientMemory` 或 `CardTypeMismatch`。

??? question "3. 同一张卡上的两个 Pod 申请显存失败，卡上却还有空闲。该对比什么？"

    它们的 `CUDA_DEVICE_MEMORY_SHARED_CACHE`。使用同一个缓存文件的进程共用一份限制。

<!-- markdownlint-enable MD046 -->

## 交接

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

选择 **代码执行程序 → 断开连接并删除运行时**，释放这个 Colab 运行时。

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

这是实战课程的最后一章。做完后删除 kind 集群：

```bash
kind delete cluster --name hami-lab
```

## 接下来

- 本工作坊的 [HAMi 实验](../labs/hami-lab.md)：拓扑、Volcano、DRA 和 HAMi WebUI
- [HAMi 官网上的实验](https://project-hami.io/zh/tutorials/){:target="_blank"}：在真实集群上使用 DRA、Volcano、KAI Scheduler、Kueue、Dynamic MIG、Ascend 等
- [故障排查](https://project-hami.io/zh/docs/troubleshooting){:target="_blank"}：已知问题及解决方法
