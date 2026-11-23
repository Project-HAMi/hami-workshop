# 第 7 章：看得见

## 场景

集群越来越忙，团队的负责人问了两个问题：GPU 被占了多少，实际用了多少。调度器说有一张卡已经超过三分之一满了，团队自己的监控面板却显示模型只用了申请量的一小部分。两边说得都对，因为它们测量的是不同的东西。

## 你将理解

- HAMi 提供的两种视角：调度器分配了多少，容器用了多少
- 每种视角由哪个 HAMi 组件导出，数字从哪里来
- 为什么分配量和用量对不上，什么问题该看哪一个

## 实验环境

本章大约需要 10 分钟。使用 [HAMi 实验：没有 GPU 也能共享 GPU](../labs/hami-lab.md) 的 kind 集群，和第 5 章一样。

| 组件 | 版本 |
| --- | --- |
| kind | 0.33.0，Kubernetes v1.37.0 |
| HAMi | v2.11.0 chart，mock Device Plugin |
| hami-mock-monitor | 0.2.0 |

于 2026-11-18 验证。

## 背后的原理：分配量和用量

HAMi 有两个指标来源：

| 视角 | 导出者 | 端口 | 数字从哪里来 |
| --- | --- | --- | --- |
| 分配量 | HAMi 调度器 | 9395 | 每个 Pod 申请的 `gpumem` 和 `gpucores`，由调度器记录 |
| 用量 | vGPU monitor，每个 GPU 节点一个 | 9394 | HAMi-core 在共享缓存文件里为每个容器记录的用量，加上 NVML 提供的整卡数据 |

vGPU monitor 读取的，就是第 4 章里你用 `CUDA_DEVICE_MEMORY_SHARED_CACHE` 设置的那个缓存文件。第 4 章步骤 3 里，带着这个缓存文件的 `nvidia-smi` 显示的是一个 4096 MiB 的切片，其中用了 2150 MiB。这就是一个 Pod 在真实 GPU 上的用量视角。

这个 kind 集群里没有 GPU，也没有 HAMi-core，所以用 `hami-mock-monitor` 代替 vGPU monitor。它导出同样名字的指标，但用量是编造的。分配量是真实的，它来自真实的 HAMi 调度器。

## 步骤 1：启动一个模型

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

启动一个 Pod，申请 15000 MiB 显存和一张卡的 30% 算力：

```bash
kubectl apply -f examples/course/07-seeing-it/model-a.yaml
kubectl wait --for=condition=Ready pod/model-a --timeout=120s
sleep 15
```

```{.text .output}
pod/model-a created
pod/model-a condition met
```

调度器的部分指标每隔几秒才更新一次，所以命令里会稍等一会儿。指标通过 API server 读取，不需要端口转发。先找到导出指标的两个 Pod：

```bash
SCHED=$(kubectl -n kube-system get pod -l app.kubernetes.io/component=hami-scheduler -o jsonpath='{.items[0].metadata.name}')
MON=$(kubectl -n kube-system get pod -l app.kubernetes.io/name=hami-mock-monitor -o jsonpath='{.items[0].metadata.name}')
```

## 步骤 2：分配量视角

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

```bash
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$SCHED:9395/proxy/metrics" | grep -E '^hami_vgpu_(memory|core)_allocated'
```

```{.text .output}
hami_vgpu_core_allocated_ratio{device_uuid="GPU-mock-1",namespace="default",node="hami-lab-control-plane",pod="model-a",zone="vGPU"} 30
hami_vgpu_memory_allocated_bytes{device_uuid="GPU-mock-1",namespace="default",node="hami-lab-control-plane",pod="model-a",zone="vGPU"} 1.572864e+10
```

`1.572864e+10` 字节正好是 15000 MiB，算力是 30。这些就是 Pod spec 里写的数字，对应调度器选中的那张卡。只要 Pod 还在运行，不管它做什么，这些数字都不会变。

## 步骤 3：用量视角

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

```bash
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$MON:9394/proxy/metrics" | grep -E '^hami_vgpu_memory_(used|limit)_bytes|^hami_container_device_utilization_ratio'
```

```{.text .output}
hami_container_device_utilization_ratio{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 22.786944579865974
hami_vgpu_memory_limit_bytes{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 1.572864e+10
hami_vgpu_memory_used_bytes{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 5.630414637152613e+09
```

限制还是那 15000 MiB。用掉的显存约 5370 MiB，利用率约 23%。等半分钟，再读一次用量：

```bash
sleep 30
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$MON:9394/proxy/metrics" | grep -E '^hami_vgpu_memory_used_bytes|^hami_container_device_utilization_ratio'
```

```{.text .output}
hami_container_device_utilization_ratio{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 25.239333763736777
hami_vgpu_memory_used_bytes{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 7.569339541053274e+09
```

用量一直在变，分配量不变。在这个集群里，用量是模拟出来的。在真实节点上，它是模型进程实际持有的显存和实际运行的负载。

## 步骤 4：同一张卡的两种视角

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

按卡来看，调度器报告显存被分配出去的比例，monitor 报告实际用了多少字节：

```bash
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$SCHED:9395/proxy/metrics" | grep '^hami_node_gpu_memory_allocated_ratio'
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$MON:9394/proxy/metrics" | grep '^hami_host_gpu_memory_used_bytes'
```

```{.text .output}
hami_node_gpu_memory_allocated_ratio{device_index="0",device_type="NVIDIA-A100-SXM4-40GB",device_uuid="GPU-mock-0",node="hami-lab-control-plane",zone="vGPU"} 0
hami_node_gpu_memory_allocated_ratio{device_index="1",device_type="NVIDIA-A100-SXM4-40GB",device_uuid="GPU-mock-1",node="hami-lab-control-plane",zone="vGPU"} 0.3662109375
hami_host_gpu_memory_used_bytes{device_index="0",device_type="NVIDIA-A100-SXM4-40GB",device_uuid="GPU-mock-0",node="hami-lab-control-plane",zone="vGPU"} 0
hami_host_gpu_memory_used_bytes{device_index="1",device_type="NVIDIA-A100-SXM4-40GB",device_uuid="GPU-mock-1",node="hami-lab-control-plane",zone="vGPU"} 5.635781018730492e+09
```

`GPU-mock-1` 分配出去 36.6%，即 40960 MiB 中的 15000 MiB，实际只用了约 13%。差出来的部分，是 `model-a` 占着却没用的显存，其他 Pod 也没法被调度进来。

什么问题看哪个视角：

| 问题 | 视角 |
| --- | --- |
| 下一个 Pod 能不能调度上去？需不需要加卡？ | 分配量。调度器按它放置 Pod |
| 某个团队是不是申请得比用得多？费用怎么分摊？ | 两个都看。两者之间的差距就是浪费 |
| 某个模型现在是忙还是闲？ | 用量 |

## 验证

| 结论 | 证据 |
| --- | --- |
| 调度器导出每个 Pod 分到了多少 | 步骤 2：`model-a` 的 15000 MiB 和 30 |
| monitor 导出每个容器用了多少 | 步骤 3：`model-a` 的显存用量和利用率 |
| 分配量固定，用量变化 | 步骤 3：两次读数用量不同，限制相同 |
| 一张卡的分配量可以远高于用量 | 步骤 4：分配 36.6%，实际约 13% |

## 常见问题

**报 `Error from server (BadRequest): invalid pod request ":9395"`。** 变量 `$SCHED` 或 `$MON` 是空的，比如换了一个新终端。重新执行步骤 1 里的两行查找命令。

**monitor 里没有某个 Pod 的数据。** 在真实节点上，vGPU monitor 只能看到由 HAMi Device Plugin 设置过的容器，因为它读取的是这些容器的缓存文件。没有经过 HAMi 调度的 Pod 没有缓存文件。

**在 Grafana 里数字看起来不对。** 显存指标的单位是字节。除以 1048576 才能和以 MiB 为单位的 `nvidia.com/gpumem` 对比。

## 自测

<!-- markdownlint-disable MD046 -->

??? question "1. 哪个组件导出分配量视角，哪个导出用量视角？"

    HAMi 调度器在 9395 端口导出它分配了多少。每个 GPU 节点上的 vGPU monitor 在 9394 端口导出容器用了多少。

??? question "2. vGPU monitor 从哪里拿到容器的显存用量？"

    从容器里 HAMi-core 写入的共享缓存文件，也就是 `CUDA_DEVICE_MEMORY_SHARED_CACHE` 指定的那个文件。

??? question "3. 一张卡分配了 73%，用了 20%。一个申请半张卡的 Pod 能调度上去吗？"

    不能。调度器按分配量放置 Pod，只剩下 27%。

<!-- markdownlint-enable MD046 -->

## 交接

:material-laptop: **在你电脑上的 kind 里运行**
{: .run-on .run-on-kind }

删除这个 Pod，保持集群运行，第 8 章还要用：

```bash
kubectl delete pod model-a
```

```{.text .output}
pod "model-a" deleted
```

## 延伸阅读

- [可观测性](https://project-hami.io/zh/docs/core-concepts/observability){:target="_blank"}：HAMi 的指标、监控面板和 HAMi WebUI
- [HAMi 实验：没有 GPU 也能共享 GPU](../labs/hami-lab.md)：一个用量随时间变化的模拟推理服务，以及 HAMi WebUI
