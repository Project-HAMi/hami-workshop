# 第 2 章：一卡一 Pod

[:simple-googlecolab: 在 Colab 中打开本章](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/zh/02-one-gpu-one-pod.ipynb){ .md-button .colab-button target="_blank" }

## 场景

GPU 在每一层都能正常工作，可 Kubernetes 还不知道它的存在。团队的第一个模型很小，只需要 2 GiB 显存，第二个同样大小的模型也在排队。他们以为两个模型都能放进一张 15 GiB 的 T4，还绰绰有余。

## 你将理解

- Device Plugin 如何把 GPU 变成 Kubernetes 资源
- 为什么 `nvidia.com/gpu` 按整张卡计数
- 为什么一个 2 GiB 的模型最后会占住一整张 15 GiB 的卡
- 为什么 Kubernetes 拒绝申请半张 GPU

## 实验环境

本章大约需要 15 分钟。步骤 1 和 2 在 Google Colab 上使用免费的 T4 GPU 运行。步骤 3 到 6 在第 1 章的 kind 集群 `hami-course` 里运行。

| 组件 | 版本 |
| --- | --- |
| GPU | Tesla T4，15360 MiB |
| NVIDIA 驱动 | 580.82.07（CUDA 13.0） |
| PyTorch | 2.14.1+cu130 |
| kind（步骤 3 到 6） | 0.33.0，Kubernetes v1.37.0 |

于 2026-11-19 在 Colab 上验证。步骤 3 到 6 于 2026-11-18 验证。

## 背后的原理：GPU 如何变成 Kubernetes 资源

kubelet 自己认识 CPU 和内存。其他设备要靠 Device Plugin，它是节点上的一个小程序，负责告诉 kubelet 有哪些设备：

![Device Plugin 发现 GPU 并注册到 kubelet，调度器按个数放置 Pod，GPU 被挂载进容器](../images/course-device-plugin-zh.svg#only-light)
![Device Plugin 发现 GPU 并注册到 kubelet，调度器按个数放置 Pod，GPU 被挂载进容器](../images/course-device-plugin-zh-dark.svg#only-dark)

1. **发现。** NVIDIA Device Plugin 通过 NVML 查询节点上有哪些 GPU，每张 GPU 得到一个 ID。
2. **注册。** 它向 kubelet 注册资源名 `nvidia.com/gpu`，并列出设备 ID。kubelet 把设备个数写进节点的容量。
3. **调度。** Pod 申请 `nvidia.com/gpu: 1`。调度器拿这个数字和每个节点的剩余量比较，别的都不看。
4. **分配。** kubelet 启动容器时，询问 Device Plugin 用哪个设备。Device Plugin 把 GPU 的 ID 放在 `NVIDIA_VISIBLE_DEVICES` 里返回，第 1 章的容器运行时再把这张 GPU 挂载进容器。

Kubernetes 把 `nvidia.com/gpu` 当作扩展资源。扩展资源只能用整数计数，也不能超卖。一个设备就是一张 GPU，所以 Pod 要么拿到整张卡，要么什么都拿不到。完整的路径见 [Device Plugin 与 DRA](https://project-hami.io/zh/docs/core-concepts/device-plugin-and-dra){:target="_blank"}。

## 步骤 1：Device Plugin 看到了什么

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

Device Plugin 通过 NVML 发现 GPU，`nvidia-smi` 用的也是这个库。按照它看到的方式列出 GPU：

```python
!nvidia-smi -L
```

```{.text .output}
GPU 0: Tesla T4 (UUID: GPU-f90d8509-a883-06d3-0455-f918b7fcd4e6)
```

一张 GPU，一个 UUID。这台机器上的 Device Plugin 会用这个 ID 注册一个 `nvidia.com/gpu` 设备。这张卡的显存、算力和型号都不在 kubelet 的计数范围内。

## 步骤 2：卡上的一个模型

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

加载团队的第一个模型。每一章都用同一个小脚本代替模型：它把指定大小的权重加载到显存里，然后一直等待，就像推理服务一直持有模型一样。

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
!nohup python /content/model.py model-a 2 > /content/model-a.log 2>&1 &
!sleep 15 && cat /content/model-a.log
!nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv
```

```{.text .output}
model-a sees 14913 MiB of GPU memory
model-a loaded 2 GiB of weights on Tesla T4
memory.used [MiB], memory.total [MiB], utilization.gpu [%]
2153 MiB, 15360 MiB, 0 %
```

模型在 15360 MiB 的卡上用了 2153 MiB，没有请求时 GPU 处于空闲状态。在集群里，这个模型就是一个申请了 `nvidia.com/gpu: 1` 的 Pod，整张卡都归它。接下来几步看看这对第二个模型意味着什么。

```python
!pkill -f /content/model.py
```

## 步骤 3：告诉 kubelet 有一张 GPU

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

kind 节点上没有 GPU，Device Plugin 跑不起来。由你来扮演 Device Plugin，自己往节点容量里加一个 `nvidia.com/gpu`。这和 Kubernetes 文档里 [为节点发布扩展资源](https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/extended-resource-node/){:target="_blank"} 用的是同一个 API，调度器分辨不出它和 Device Plugin 上报的有什么不同：

```bash
kubectl patch node hami-course-control-plane --subresource=status --type=json \
  -p '[{"op":"add","path":"/status/capacity/nvidia.com~1gpu","value":"1"}]'
sleep 15
kubectl get node hami-course-control-plane -o jsonpath='{.status.allocatable}{"\n"}'
```

```{.text .output}
node/hami-course-control-plane patched
{"cpu":"8","ephemeral-storage":"73865408512","memory":"8197712Ki","nvidia.com/gpu":"1","pods":"110"}
```

现在节点提供一个 `nvidia.com/gpu`，就像一个装了一张 T4 和 NVIDIA Device Plugin 的节点。

## 步骤 4：部署第一个模型

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

这个集群里没有 GPU 可以加载模型，所以 Pod 运行的是 `busybox`。这里关心的是调度器的决定。`model-a` 申请一张 GPU：

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
```

```bash
kubectl apply -f examples/course/02-one-gpu-one-pod/model-a.yaml
kubectl wait --for=condition=Ready pod/model-a --timeout=60s
kubectl describe node hami-course-control-plane | grep -A 8 'Allocated resources'
```

```{.text .output}
pod/model-a created
pod/model-a condition met
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests    Limits
  --------           --------    ------
  cpu                950m (11%)  0 (0%)
  memory             290Mi (3%)  340Mi (4%)
  ephemeral-storage  0 (0%)      0 (0%)
  nvidia.com/gpu     1           1
Events:
```

`model-a` 运行起来了，`nvidia.com/gpu` 显示 1 个中已分配 1 个。在真实节点上，`model-a` 会占住整张 T4，而步骤 2 已经看到，它只用了其中一小部分。

## 步骤 5：部署第二个模型

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

`model-b` 和 `model-a` 一样，只是名字不同：

```bash
kubectl apply -f examples/course/02-one-gpu-one-pod/model-b.yaml
sleep 5
kubectl get pods
kubectl get events --field-selector involvedObject.name=model-b -o custom-columns=TYPE:.type,REASON:.reason,MESSAGE:.message
```

```{.text .output}
pod/model-b created
NAME      READY   STATUS    RESTARTS   AGE
model-a   1/1     Running   0          5s
model-b   0/1     Pending   0          5s
TYPE      REASON             MESSAGE
Warning   FailedScheduling   0/1 nodes are available: 1 Insufficient nvidia.com/gpu. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.
```

`model-b` 一直 `Pending`，原因是 `Insufficient nvidia.com/gpu`。卡上还有 13 GiB 以上的空闲显存，但调度器不看显存，它数的是 GPU 个数，而唯一的一张已经被占了。

## 步骤 6：试着申请半张 GPU

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

一张太多，那就申请半张：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: half-gpu
spec:
  containers:
    - name: model
      image: busybox:1.36
      command: ["sleep", "infinity"]
      resources:
        limits:
          nvidia.com/gpu: 0.5
```

```bash
kubectl apply -f examples/course/02-one-gpu-one-pod/half-gpu.yaml
```

```{.text .output}
The Pod "half-gpu" is invalid:
* spec.containers[0].resources.limits[nvidia.com/gpu]: Invalid value: "500m": must be an integer
* spec.containers[0].resources.requests[nvidia.com/gpu]: Invalid value: "500m": must be an integer
```

Pod 还没到调度器，就被 API server 拒绝了。扩展资源必须是整数。使用原生 Device Plugin 时，没有办法申请一张 GPU 的一部分。

## 验证

| 结论 | 证据 |
| --- | --- |
| Device Plugin 把 GPU 看作 ID | 步骤 1：`nvidia-smi -L` 列出一张 GPU 和一个 UUID |
| 小模型只用了卡的一小部分 | 步骤 2：`model-a` 用了 15360 MiB 中的 2153 MiB |
| 调度器按整张 GPU 计数 | 步骤 4：`nvidia.com/gpu` 1 个中已分配 1 个 |
| 第二个 Pod 无法共用这张卡 | 步骤 5：`model-b` 因 `Insufficient nvidia.com/gpu` 处于 `Pending` |
| Kubernetes 拒绝申请 GPU 的一部分 | 步骤 6：`0.5` 被拒绝，报 `must be an integer` |

## 常见问题

**打完补丁后 `allocatable` 里没有马上出现 `nvidia.com/gpu`。** kubelet 在下一次更新节点状态时才会把容量复制到 allocatable。等 10 到 15 秒再查。

**`model-a` 也是 `Pending`。** 容量补丁没有生效，或者之前运行留下的 Pod 还占着 GPU。检查 `kubectl get pods` 和节点的 allocatable。

**报 `Limit must be set for non overcommitable resources`。** Pod 只在 `requests` 里写了 `nvidia.com/gpu`。扩展资源必须写在 `limits` 里。像本章这样只写 `limits` 时，Kubernetes 会把它复制到 `requests`。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. Device Plugin 告诉 kubelet 每张 GPU 的什么信息？"

    它的 ID，挂在资源名 `nvidia.com/gpu` 下面。kubelet 统计 ID 的个数，写进节点的容量。显存和算力都不在其中。

??? question "2. 卡上还有 13 GiB 以上的空闲显存，`model-b` 为什么还是 `Pending`？"

    调度器拿 Pod 申请的 `nvidia.com/gpu` 个数和节点上的剩余个数比较。节点只有一个，已经被 `model-a` 占了。

??? question "3. Pod 为什么不能申请 `nvidia.com/gpu: 0.5`？"

    `nvidia.com/gpu` 是扩展资源，Kubernetes 对扩展资源只接受整数。

<!-- markdownlint-enable MD046 -->

## 交接

:simple-googlecolab: **在 Colab 上运行**
{: .run-on .run-on-colab }

选择 **代码执行程序 → 断开连接并删除运行时**，释放这个 Colab 运行时。下一章会打开自己的 notebook，运行在一个全新的运行时上，这一章的内容不会带过去。不断开的运行时会继续消耗你的免费 GPU 时长。

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

删除 kind 集群。第 3、4 章在 Colab 上运行，第 4 章会使用自己的集群：

```bash
kind delete cluster --name hami-course
```

```{.text .output}
Deleting cluster "hami-course" ...
Deleted nodes: ["hami-course-control-plane"]
```

## 延伸阅读

- [Device Plugin 与 DRA](https://project-hami.io/zh/docs/core-concepts/device-plugin-and-dra){:target="_blank"}：GPU 如何变成 Kubernetes 资源，以及 DRA 带来的变化
- [设备插件](https://kubernetes.io/zh-cn/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/){:target="_blank"}：Kubernetes 的 Device Plugin API
- [为节点发布扩展资源](https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/extended-resource-node/){:target="_blank"}：步骤 3 用到的 API
- [NVIDIA device plugin for Kubernetes](https://github.com/NVIDIA/k8s-device-plugin){:target="_blank"}：真实的 NVIDIA 节点上运行的 Device Plugin
