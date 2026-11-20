# Chapter 7: Seeing It

## Scenario

The cluster is busy, and the team's manager asks two questions: how much of the GPUs is taken, and how much is actually used. The scheduler says one card is more than a third full. The team's own dashboards show a model using a fraction of what it asked for. Both are right, because they measure different things.

## What You'll Understand

- The two views HAMi exposes: what the scheduler allocated and what containers use
- Which HAMi component exports each view, and where its numbers come from
- Why allocated and used do not match, and which one to look at for which question

## Environment

This chapter takes about 10 minutes. This chapter runs in the kind cluster from [HAMi lab: GPU sharing without a GPU](../labs/hami-lab.md), as in Chapter 5.

| Component | Version |
| --- | --- |
| kind | 0.33.0, Kubernetes v1.37.0 |
| HAMi | v2.11.0 chart, mock device plugin |
| hami-mock-monitor | 0.2.0 |

Verified on 2026-11-18.

## The Principle: Allocated and Used

HAMi has two sources of metrics:

| View | Exported by | Port | Where the numbers come from |
| --- | --- | --- | --- |
| Allocated | HAMi scheduler | 9395 | the `gpumem` and `gpucores` each Pod asked for, as recorded by the scheduler |
| Used | vGPU monitor, one per GPU node | 9394 | what HAMi-core records for each container in its shared cache file, plus NVML for the whole card |

The vGPU monitor reads the same cache file you set with `CUDA_DEVICE_MEMORY_SHARED_CACHE` in Chapter 4. In Chapter 4 Step 3, `nvidia-smi` with that cache file showed a 4096 MiB slice with 2150 MiB in use. That is the used view of one Pod, on a real GPU.

This kind cluster has no GPU and no HAMi-core, so `hami-mock-monitor` stands in for the vGPU monitor. It exports the same metric names with made-up usage. The allocated view is real: it comes from the real HAMi scheduler.

## Step 1: Start a Model

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Start one Pod that asks for 15000 MiB and 30% of a card:

```bash
kubectl apply -f examples/course/07-seeing-it/model-a.yaml
kubectl wait --for=condition=Ready pod/model-a --timeout=120s
sleep 15
```

```{.text .output}
pod/model-a created
pod/model-a condition met
```

The scheduler updates some of its metrics every few seconds, which is why the commands wait a moment. The metrics are read through the API server, so no port forwarding is needed. Look up the two Pods that export them:

```bash
SCHED=$(kubectl -n kube-system get pod -l app.kubernetes.io/component=hami-scheduler -o jsonpath='{.items[0].metadata.name}')
MON=$(kubectl -n kube-system get pod -l app.kubernetes.io/name=hami-mock-monitor -o jsonpath='{.items[0].metadata.name}')
```

## Step 2: The Allocated View

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

```bash
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$SCHED:9395/proxy/metrics" | grep -E '^hami_vgpu_(memory|core)_allocated'
```

```{.text .output}
hami_vgpu_core_allocated_ratio{device_uuid="GPU-mock-1",namespace="default",node="hami-lab-control-plane",pod="model-a",zone="vGPU"} 30
hami_vgpu_memory_allocated_bytes{device_uuid="GPU-mock-1",namespace="default",node="hami-lab-control-plane",pod="model-a",zone="vGPU"} 1.572864e+10
```

`1.572864e+10` bytes is exactly 15000 MiB, and the compute is 30. These are the numbers in the Pod's spec, tied to the card the scheduler chose. They stay the same for as long as the Pod runs, whatever the Pod does.

## Step 3: The Used View

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

```bash
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$MON:9394/proxy/metrics" | grep -E '^hami_vgpu_memory_(used|limit)_bytes|^hami_container_device_utilization_ratio'
```

```{.text .output}
hami_container_device_utilization_ratio{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 22.786944579865974
hami_vgpu_memory_limit_bytes{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 1.572864e+10
hami_vgpu_memory_used_bytes{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 5.630414637152613e+09
```

The limit is the same 15000 MiB. The used memory is about 5370 MiB, and the utilization about 23%. Wait half a minute and read the usage again:

```bash
sleep 30
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$MON:9394/proxy/metrics" | grep -E '^hami_vgpu_memory_used_bytes|^hami_container_device_utilization_ratio'
```

```{.text .output}
hami_container_device_utilization_ratio{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 25.239333763736777
hami_vgpu_memory_used_bytes{container="model",device_uuid="GPU-mock-1",namespace="default",pod="model-a",vdevice_index="0",zone="vGPU"} 7.569339541053274e+09
```

The used view changes all the time, and the allocated view does not. In this cluster the usage is simulated. On a real node, it is what the model's processes hold and run.

## Step 4: The Same Card, Two Views

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Per card, the scheduler reports which share of the memory is allocated, and the monitor reports how many bytes are in use:

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

`GPU-mock-1` is 36.6% allocated, 15000 of 40960 MiB, and about 13% used. The gap is memory that `model-a` holds a claim on and does not use. No other Pod can be scheduled into it.

Which view answers which question:

| Question | View |
| --- | --- |
| Can the next Pod be scheduled? Do we need more cards? | Allocated. The scheduler places Pods by it. |
| Is a team asking for more than it needs? Who pays for what? | Both. The gap between them is the waste. |
| Is a model running hot or idle right now? | Used |

## Verify

| Claim | Evidence |
| --- | --- |
| The scheduler exports what each Pod was given | Step 2: 15000 MiB and 30 for `model-a` |
| The monitor exports what each container uses | Step 3: used memory and utilization for `model-a` |
| Allocated stays fixed, used changes | Step 3: two readings with different usage, same limit |
| A card can be far more allocated than used | Step 4: 36.6% allocated, about 13% used |

## Common Pitfalls

**`Error from server (BadRequest): invalid pod request ":9395"`.** The variable `$SCHED` or `$MON` is empty, for example in a new terminal. Run the two lookups in Step 1 again. Run the two lookups again and check that both Pods are running.

**The monitor shows no line for a Pod.** On a real node, the vGPU monitor only sees containers that HAMi's device plugin set up, because it reads their cache files. A Pod that was not scheduled through HAMi has no cache file.

**The numbers look odd in Grafana.** Memory metrics are in bytes. Divide by 1048576 to compare them with `nvidia.com/gpumem`, which is in MiB.

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. Which component exports the allocated view, and which the used view?"

    The HAMi scheduler exports what it allocated, on port 9395. The vGPU monitor on each GPU node exports what containers use, on port 9394.

??? question "2. Where does the vGPU monitor get a container's memory usage?"

    From the shared cache file that HAMi-core in the container writes, the one set by `CUDA_DEVICE_MEMORY_SHARED_CACHE`.

??? question "3. A card is 73% allocated and 20% used. Can another Pod that asks for half the card be scheduled on it?"

    No. The scheduler places Pods by what is allocated, and only 27% is left.

<!-- markdownlint-enable MD046 -->

## Hand-off

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Delete the Pod and keep the cluster running for Chapter 8:

```bash
kubectl delete pod model-a
```

```{.text .output}
pod "model-a" deleted
```

## Further Reading

- [Observability](https://project-hami.io/docs/core-concepts/observability){:target="_blank"}: HAMi's metrics, dashboards, and HAMi WebUI
- [HAMi lab: GPU sharing without a GPU](../labs/hami-lab.md): a simulated inference server whose usage moves over time, and HAMi WebUI
