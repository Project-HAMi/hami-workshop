# 第 8 章：多个团队，一个集群

## 场景

第二个团队开始使用这个集群。训练团队在周五晚上提交了四个任务，每个都申请两个 GPU 切片。等推理团队部署一个小模型时，两张卡都已经满了。两个团队商量好，每个团队有一份 GPU 显存预算。现在需要有人来执行这份预算。

## 你将理解

- 为什么共享的集群需要按团队设置 GPU 预算
- Kubernetes ResourceQuota 如何按 namespace 限制 HAMi 的 GPU 显存
- 为什么原生配额会算错多卡 Pod，HAMi 的扩展配额如何解决
- 配额在哪里止步，任务队列从哪里开始

## 实验环境

本章大约需要 15 分钟。使用 [HAMi 实验：没有 GPU 也能共享 GPU](../labs/hami-lab.md) 的 kind 集群，和第 5 章一样。两张假卡各有 40960 MiB。

| 组件 | 版本 |
| --- | --- |
| kind | 0.33.0，Kubernetes v1.37.0 |
| HAMi | v2.11.0 chart，mock Device Plugin |

于 2026-11-18 验证。

## 背后的原理：先准入，再调度

ResourceQuota 在 Pod 创建时检查，那时调度器还没看到这个 Pod。如果 Pod 会让所在的 namespace 超出预算，API server 就拒绝它。Kubernetes 支持对扩展资源设置配额，包括 HAMi 的 `nvidia.com/gpumem`，写法是带 `requests.` 前缀。

原生配额对 GPU 切片有一个盲区：它累加的是每个容器 spec 里写的数字。一个申请 `nvidia.com/gpu: 2` 和 `nvidia.com/gpumem: 10000` 的 Pod，会在两张卡上各拿到 10000 MiB，总共 20000 MiB，但 spec 里只写了 10000。HAMi 的 webhook 为此有自己的配额检查。它读取带 `limits.` 前缀的配额，按显存乘以卡数来计算。

## 步骤 1：先看到问题

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

创建两个团队的 namespace。训练团队的任务申请两张卡，每张 10000 MiB：

```yaml
apiVersion: v1
kind: Pod
metadata:
  generateName: train-
spec:
  containers:
    - name: train
      image: busybox:1.36
      command: ["sleep", "infinity"]
      resources:
        limits:
          nvidia.com/gpu: 2
          nvidia.com/gpumem: 10000
```

提交四个：

```bash
kubectl apply -f examples/course/08-many-teams/teams.yaml
for i in 1 2 3 4; do kubectl create -n team-a -f examples/course/08-many-teams/train.yaml; done
sleep 20
kubectl get pods -n team-a
```

```{.text .output}
namespace/team-a created
namespace/team-b created
pod/train-m8p5q created
pod/train-9z76k created
pod/train-j7rsz created
pod/train-jmrg7 created
NAME          READY   STATUS    RESTARTS   AGE
train-9z76k   1/1     Running   0          21s
train-j7rsz   1/1     Running   0          21s
train-jmrg7   1/1     Running   0          21s
train-m8p5q   1/1     Running   0          21s
```

四个任务在每张卡上占了 40960 MiB 中的 40000 MiB。接着推理团队部署一个需要 8000 MiB 的模型：

```bash
kubectl apply -f examples/course/08-many-teams/serve.yaml
sleep 10
kubectl get pods -n team-b
kubectl get events -n team-b --field-selector involvedObject.name=serve,reason=FailedScheduling -o custom-columns=MESSAGE:.message | tail -1
```

```{.text .output}
pod/serve created
NAME    READY   STATUS    RESTARTS   AGE
serve   0/1     Pending   0          10s
0/1 nodes are available: 1 2/2 CardInsufficientMemory. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.
```

没有任何东西阻止一个团队占满整个集群。进入下一步之前先清理：

```bash
kubectl delete pods -n team-a --all
kubectl delete pod serve -n team-b
```

## 步骤 2：原生配额

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

用原生配额给 `team-a` 设置 30000 MiB 的预算：

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu
  namespace: team-a
spec:
  hard:
    requests.nvidia.com/gpumem: "30000"
```

```bash
kubectl apply -f examples/course/08-many-teams/quota-native.yaml
for i in 1 2 3; do kubectl create -n team-a -f examples/course/08-many-teams/train.yaml; done
kubectl describe resourcequota gpu -n team-a | tail -3
sleep 20
for p in $(kubectl get pods -n team-a -o name); do kubectl get -n team-a $p -o jsonpath='{.metadata.name} {.status.phase} {.metadata.annotations.hami\.io/vgpu-devices-allocated}{"\n"}'; done
```

```{.text .output}
resourcequota/gpu created
pod/train-8cxr8 created
pod/train-qslql created
pod/train-4kx6m created
Resource                    Used  Hard
--------                    ----  ----
requests.nvidia.com/gpumem  30k   30k
train-4kx6m Running GPU-mock-1,NVIDIA,10000,0:GPU-mock-0,NVIDIA,10000,0:;
train-8cxr8 Running GPU-mock-1,NVIDIA,10000,0:GPU-mock-0,NVIDIA,10000,0:;
train-qslql Running GPU-mock-1,NVIDIA,10000,0:GPU-mock-0,NVIDIA,10000,0:;
```

配额算出 30000 MiB，三个任务都放行了。每个任务在两张卡上各占 10000 MiB，三个任务实际占了 60000 MiB，是预算的两倍。每个任务的 10000 MiB 只算了一次，没有按卡数计算。

删除这些任务和原生配额：

```bash
kubectl delete pods -n team-a --all
kubectl delete -f examples/course/08-many-teams/quota-native.yaml
```

## 步骤 3：HAMi 的扩展配额

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

同样的预算，换成 `limits.` 前缀，由 HAMi 的 webhook 执行：

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu
  namespace: team-a
spec:
  hard:
    limits.nvidia.com/gpumem: "30000"
```

```bash
kubectl apply -f examples/course/08-many-teams/quota-hami.yaml
for i in 1 2; do kubectl create -n team-a -f examples/course/08-many-teams/train.yaml; done
kubectl describe resourcequota gpu -n team-a | tail -3
```

```{.text .output}
resourcequota/gpu created
pod/train-64dmf created
Error from server (Forbidden): error when creating "examples/course/08-many-teams/train.yaml": admission webhook "vgpu.hami.io" denied the request: exceeding resource quota for device NVIDIA
Resource                  Used  Hard
--------                  ----  ----
limits.nvidia.com/gpumem  0     30k
```

第一个任务算作 20000 MiB，第二个会让 `team-a` 达到 40000，被 HAMi 的 webhook 拒绝了。注意 `Used` 这一列：Kubernetes 自己不统计扩展资源的 `limits.`，所以显示 0。用量记录在 HAMi 里。

## 步骤 4：查看配额用量

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

HAMi 调度器导出它对每个配额的统计：

```bash
SCHED=$(kubectl -n kube-system get pod -l app.kubernetes.io/component=hami-scheduler -o jsonpath='{.items[0].metadata.name}')
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$SCHED:9395/proxy/metrics" | grep '^hami_resource_quota_used' | grep team-a
```

```{.text .output}
hami_resource_quota_used{limit="0",namespace="team-a",quota_name="nvidia.com/gpucores",zone="vGPU"} 0
hami_resource_quota_used{limit="30000",namespace="team-a",quota_name="nvidia.com/gpumem",zone="vGPU"} 20000
```

30000 MiB 中用了 20000 MiB，正是那个任务在卡上占的量。`gpucores` 的 `limit="0"` 表示没有给算力设置配额。

## 配额在哪里止步

配额在 Pod 创建的那一刻拒绝超出预算的 Pod。它不会把 Pod 留下来，等预算空出来再启动。周五晚上被拒绝的训练任务就直接没了。要排队、要在团队之间分优先级、要对多 Pod 任务做 gang 调度，就需要在调度器前面加一个队列系统。Kueue 和 Volcano 都能和 HAMi 的 GPU 切片配合：

- [Volcano vGPU 的 gang 调度和队列](https://project-hami.io/zh/tutorials/labs/volcano-vgpu-gang-queue){:target="_blank"}
- [Kueue 与 HAMi vGPU](https://project-hami.io/zh/tutorials/labs/kueue-hami-vgpu){:target="_blank"}

## 验证

| 结论 | 证据 |
| --- | --- |
| 没有预算时，一个团队可以占满集群 | 步骤 1：四个任务占满两张卡，`serve` 处于 `Pending` |
| 原生配额对多卡 Pod 只算一次 | 步骤 2：用量 30k 时放行了三个任务，实际占用 60000 MiB |
| HAMi 的扩展配额按每张卡计算 | 步骤 3：第二个任务被 `vgpu.hami.io` 拒绝 |
| HAMi 记录配额用量 | 步骤 4：`hami_resource_quota_used` 是 30000 中的 20000 |

## 常见问题

**`limits.nvidia.com/gpumem` 的 ResourceQuota 没有效果。** HAMi 只对它管理的资源执行配额，而且只认 `limits.` 前缀。检查资源名和配额所在的 namespace，别的 namespace 里的配额不起作用。

**`kubectl describe resourcequota` 里 `limits.nvidia.com/gpumem` 的用量是 0。** 这是正常的。Kubernetes 不统计扩展资源的 `limits.`。HAMi 的用量看 `hami_resource_quota_used`。

**任务被拒绝后再也没有重试。** 配额只负责放行或拒绝。用 Kueue 或 Volcano 让任务排队，等预算允许时再启动。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. ResourceQuota 在什么时候检查？"

    在 Pod 创建时，Pod 还没到调度器。超出预算的 Pod 会被 API server 或 HAMi 的 webhook 拒绝。

??? question "2. 一个 Pod 申请 `nvidia.com/gpu: 2` 和 `nvidia.com/gpumem: 10000`。原生配额算多少，HAMi 算多少？"

    原生配额算 10000 MiB，也就是 spec 里的数字。HAMi 算 20000 MiB，两张卡各 10000，这才是 Pod 实际占用的量。

??? question "3. 已经有了配额，为什么还需要 Kueue 或 Volcano？"

    配额会立即拒绝超出预算的 Pod。队列会把它们留下来，等预算和卡都允许时再启动。

<!-- markdownlint-enable MD046 -->

## 交接

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

删除两个团队的 namespace，保持集群运行，第 9 章还要用：

```bash
kubectl delete -f examples/course/08-many-teams/teams.yaml
```

```{.text .output}
namespace "team-a" deleted
namespace "team-b" deleted
```

## 延伸阅读

- [为 NVIDIA 设备使用扩展的 resourcequota](https://project-hami.io/zh/docs/userguide/nvidia-device/using-resourcequota){:target="_blank"}：HAMi 配额的详细说明
- [资源配额](https://kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas/){:target="_blank"}：Kubernetes ResourceQuota 和扩展资源
