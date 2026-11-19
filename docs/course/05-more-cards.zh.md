# 第 5 章：卡多了怎么放

## 场景

团队现在有了一个两张卡的节点，每周都有新模型上线。大多数模型很小，但有一个训练任务需要在一张卡上拿到 30000 MiB。两张卡加起来的空闲显存很多，训练任务却启动不了。团队需要弄清楚 HAMi 是怎么选卡的，以及怎么影响它的选择。

## 你将理解

- HAMi 调度器如何为每个 Pod 选卡
- 为什么默认策略可能让每张卡都放不下一个大 Pod
- `binpack`、`spread` 和 `mutex` 如何按 Pod 改变选卡结果
- 如何把 Pod 固定到某种型号或某一张卡上

## 实验环境

本章大约需要 20 分钟。在你电脑上运行，使用 [HAMi 实验：没有 GPU 也能共享 GPU](../labs/hami-lab.md) 的 kind 集群，也就是第 4 章步骤 7 用的那个集群。集群里有真实的 HAMi webhook 和调度器、一个 mock Device Plugin，以及两张各 40960 MiB 的假 NVIDIA A100。

| 组件 | 版本 |
| --- | --- |
| kind | 0.33.0，Kubernetes v1.37.0 |
| HAMi | v2.11.0 chart，mock Device Plugin |

于 2026-11-18 验证。

## 背后的原理：每个 Pod 的两个决定

对申请 GPU 切片的 Pod，HAMi 调度器要做两个决定：放到哪个节点，放到节点上的哪张卡。每个决定都有一个策略：

| 决定 | Pod 上的 annotation | `binpack` | `spread` | 默认值 |
| --- | --- | --- | --- | --- |
| 哪个节点 | `hami.io/node-scheduler-policy` | 优先填满已在使用的节点 | 把 Pod 分散到各个节点 | `binpack` |
| 节点上的哪张卡 | `hami.io/gpu-scheduler-policy` | 优先填满已在使用的卡 | 把 Pod 分散到各张卡 | `spread` |

默认值来自 Helm 配置 `scheduler.defaultSchedulerPolicy.nodeSchedulerPolicy` 和 `gpuSchedulerPolicy`，Pod 可以用 annotation 覆盖它们。`spread` 让 Pod 彼此远离，适合它们会争抢算力的情况。`binpack` 让整张卡保持空闲，适合之后还会来大 Pod 的情况。

调度器只读取 Device Plugin 上报的每张卡的信息：ID、显存、算力、型号和健康状态。这个集群只有一个节点，所以本章关注的是选卡。

## 步骤 1：看一下这两张卡

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

Device Plugin 把每张卡的信息写进节点的 annotation，调度器从这里读取：

```bash
kubectl get node hami-lab-control-plane -o jsonpath='{.metadata.annotations.hami\.io/node-nvidia-register}' | jq -c '.[] | {id, devmem, devcore, type}'
```

```{.text .output}
{"id":"GPU-mock-0","devmem":40960,"devcore":100,"type":"NVIDIA-A100-SXM4-40GB"}
{"id":"GPU-mock-1","devmem":40960,"devcore":100,"type":"NVIDIA-A100-SXM4-40GB"}
```

两张卡，每张 40960 MiB 显存和 100% 算力，总共 81920 MiB。

## 步骤 2：先看到问题

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

先来两个小模型，各 15000 MiB，不带策略 annotation：

```bash
kubectl apply -f examples/course/05-more-cards/small.yaml
kubectl wait --for=condition=Ready pod/small-1 pod/small-2 --timeout=120s
for p in small-1 small-2; do echo "$p $(kubectl get pod $p -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}')"; done
```

```{.text .output}
pod/small-1 created
pod/small-2 created
pod/small-1 condition met
pod/small-2 condition met
small-1 GPU-mock-1,NVIDIA,15000,0:;
small-2 GPU-mock-0,NVIDIA,15000,0:;
```

默认的 `spread` 策略把它们放到了不同的卡上。现在训练任务要在一张卡上拿 30000 MiB：

```bash
kubectl apply -f examples/course/05-more-cards/big.yaml
sleep 10
kubectl get pod big
kubectl get events --field-selector involvedObject.name=big,reason=FailedScheduling -o custom-columns=MESSAGE:.message | tail -1
```

```{.text .output}
pod/big created
NAME   READY   STATUS    RESTARTS   AGE
big    0/1     Pending   0          10s
0/1 nodes are available: 1 2/2 CardInsufficientMemory. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.
```

`big` 一直 `Pending`，两张卡都是 `CardInsufficientMemory`。节点上还有 51920 MiB 空闲，但每张卡只剩 25960 MiB，而一个 Pod 的显存必须放在一张卡上。空闲显存被切碎了。

## 步骤 3：把小 Pod 放在一起

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

给同样的两个小模型加上 `hami.io/gpu-scheduler-policy: binpack`：

```yaml
metadata:
  name: small-1
  annotations:
    hami.io/gpu-scheduler-policy: binpack
```

```bash
kubectl delete -f examples/course/05-more-cards/small.yaml -f examples/course/05-more-cards/big.yaml
kubectl apply -f examples/course/05-more-cards/small-binpack.yaml
kubectl wait --for=condition=Ready pod/small-1 pod/small-2 --timeout=120s
for p in small-1 small-2; do echo "$p $(kubectl get pod $p -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}')"; done
kubectl apply -f examples/course/05-more-cards/big.yaml
kubectl wait --for=condition=Ready pod/big --timeout=120s
echo "big $(kubectl get pod big -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}')"
```

```{.text .output}
pod "small-1" deleted
pod "small-2" deleted
pod "big" deleted
pod/small-1 created
pod/small-2 created
pod/small-1 condition met
pod/small-2 condition met
small-1 GPU-mock-1,NVIDIA,15000,0:;
small-2 GPU-mock-1,NVIDIA,15000,0:;
pod/big created
pod/big condition met
big GPU-mock-0,NVIDIA,30000,0:;
```

两个小模型共用 `GPU-mock-1`，`big` 拿到了空着的 `GPU-mock-0`。总需求没有变，变的只是放置方式。

用哪种策略取决于负载。`binpack` 给大 Pod 留出空间。`spread` 让每个 Pod 分到一张卡更多的算力，第 3 章已经看到，同一张卡上的 Pod 会分享它的时间。

## 步骤 4：申请一张空卡

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

有些负载应该在一张没人用的卡上启动，比如延迟测试。`hami.io/gpu-scheduler-policy: mutex` 只接受上面没有 Pod 的卡。现在两张卡都在使用中：

```bash
kubectl apply -f examples/course/05-more-cards/exclusive.yaml
sleep 10
kubectl get pod exclusive
kubectl get events --field-selector involvedObject.name=exclusive,reason=FailedScheduling -o custom-columns=MESSAGE:.message | tail -1
```

```{.text .output}
pod/exclusive created
NAME        READY   STATUS    RESTARTS   AGE
exclusive   0/1     Pending   0          10s
0/1 nodes are available: 1 2/2 ExclusiveDeviceAllocateConflict. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.
```

两张卡都放得下它的 10000 MiB，但都不是空的。腾出一张：

```bash
kubectl delete pod big
kubectl wait --for=condition=Ready pod/exclusive --timeout=120s
echo "exclusive $(kubectl get pod exclusive -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}')"
```

```{.text .output}
pod "big" deleted
pod/exclusive condition met
exclusive GPU-mock-0,NVIDIA,10000,0:;
```

`GPU-mock-0` 一空出来，`exclusive` 就启动了。

## 步骤 5：把 Pod 固定到一张卡上

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

Pod 也可以用 `nvidia.com/use-gpuuuid` 指定要哪一张卡，或者用 `nvidia.com/use-gputype` 指定卡的型号：

```yaml
metadata:
  name: pinned
  annotations:
    nvidia.com/use-gpuuuid: "GPU-mock-0"
```

```bash
kubectl apply -f examples/course/05-more-cards/pinned.yaml
kubectl wait --for=condition=Ready pod/pinned --timeout=120s
echo "pinned $(kubectl get pod pinned -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}')"
```

```{.text .output}
pod/pinned created
pod/pinned condition met
pinned GPU-mock-0,NVIDIA,10000,0:;
```

`pinned` 落在了 `GPU-mock-0` 上，就在 `exclusive` 旁边。`mutex` 只在放置 `exclusive` 时检查，不会阻止之后的 Pod 使用这张卡。想让一张卡在整个生命周期里只归一个 Pod，就让它申请这张卡的全部显存和算力。

清理：

```bash
kubectl delete -f examples/course/05-more-cards/small-binpack.yaml -f examples/course/05-more-cards/exclusive.yaml -f examples/course/05-more-cards/pinned.yaml
```

```{.text .output}
pod "small-1" deleted
pod "small-2" deleted
pod "exclusive" deleted
pod "pinned" deleted
```

## 不止一个节点

在有多个 GPU 节点的集群里，`hami.io/node-scheduler-policy` 用同样的方式在节点之间做选择。一个 Pod 申请多张卡时，HAMi 还可以通过 `topology-aware` 策略优先选择连接更好的卡，比如通过 NVLink 相连的卡。从 v2.10.0 起，策略可以串联，比如 `mutex,binpack`：先过滤，再按书写顺序排序。[HAMi 实验](../labs/hami-lab.md) 以阅读的形式介绍了拓扑和 NUMA。

## 验证

| 结论 | 证据 |
| --- | --- |
| 调度器从节点读取每张卡的信息 | 步骤 1：两张卡，各 40960 MiB |
| 默认的 `spread` 策略会把空闲显存切碎 | 步骤 2：虽然空闲 51920 MiB，`big` 仍因 `CardInsufficientMemory` 处于 `Pending` |
| `binpack` 为大 Pod 留出一张空卡 | 步骤 3：两个小 Pod 都在 `GPU-mock-1`，`big` 在 `GPU-mock-0` |
| `mutex` 会等待一张空卡 | 步骤 4：删除 `big` 之前一直是 `ExclusiveDeviceAllocateConflict` |
| Pod 可以指定自己的卡 | 步骤 5：`pinned` 在 `GPU-mock-0` 上 |

## 常见问题

**第二个 Pod 一直 `Pending` 好几分钟，却没有 `FailedScheduling` 原因。** 在这个 kind 集群里，mock Device Plugin 不会完成绑定，由开启了 `completeBinds=true` 的 hami-mock-monitor 代为完成。检查 `kube-system` 里的 `hami-mock-monitor` Pod 是否在运行。如果 `setup.sh` 里安装它失败了，再执行一次那一行 `helm upgrade --install`。

**策略 annotation 没有生效。** 检查键和值的拼写。`hami.io/gpu-scheduler-policy` 的取值是 `binpack`、`spread`、`mutex`、`topology-aware`，或用逗号串联的组合。

**带 `nvidia.com/use-gpuuuid` 的 Pod 因 `CardUuidMismatch` 处于 `Pending`。** 没有任何一张卡是这个 UUID。和步骤 1 里的 ID 对比一下。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. 步骤 2 里节点还有 51920 MiB 空闲，`big` 为什么启动不了？"

    一个 Pod 的显存必须放在一张卡上。`spread` 在每张卡上各放了一个小 Pod 之后，每张卡只剩 25960 MiB。

??? question "2. 什么时候该选 `spread`，什么时候该选 `binpack`？"

    当同一张卡上的 Pod 会互相拖慢时，就像第 3 章那样。`spread` 让每个 Pod 分到一张卡更多的时间。`binpack` 为大 Pod 保留整张空卡。

??? question "3. `exclusive` 用了 `mutex`，为什么 `pinned` 还是落在了同一张卡上？"

    `mutex` 只在放置 `exclusive` 时过滤卡。之后不带 `mutex` 的 Pod 仍然可以使用这张卡。

<!-- markdownlint-enable MD046 -->

## 交接

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

本章的 Pod 都已删除。保持 kind 集群运行。第 6 章在 Colab 上运行，第 7 到 9 章还会用到这个集群。

## 延伸阅读

- [调度](https://project-hami.io/zh/docs/core-concepts/scheduling){:target="_blank"}：HAMi 调度器如何过滤节点和卡并打分
- [HAMi 实验：没有 GPU 也能共享 GPU](../labs/hami-lab.md)：同一个集群上的拓扑、NUMA 和其他调度器
