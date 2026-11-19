# Chapter 5: More Cards, Where to Put Them

## Scenario

The team now has a node with two cards, and more models arrive every week. Most are small, but one training job needs 30000 MiB on a single card. Both cards have plenty of free memory in total, yet the training job does not start. The team needs to understand how HAMi chooses a card, and how to steer that choice.

## What You'll Understand

- How the HAMi scheduler picks a card for each Pod
- Why the default policy can leave no card with enough room for a large Pod
- How `binpack`, `spread`, and `mutex` change the choice, per Pod
- How to pin a Pod to a card type or a specific card

## Environment

This chapter takes about 20 minutes. This chapter runs on your laptop in the kind cluster from [HAMi lab: GPU sharing without a GPU](../labs/hami-lab.md), the same cluster as Chapter 4 Step 7. It has the real HAMi webhook and scheduler, a mock device plugin, and two fake NVIDIA A100 cards with 40960 MiB each.

| Component | Version |
| --- | --- |
| kind | 0.33.0, Kubernetes v1.37.0 |
| HAMi | v2.11.0 chart, mock device plugin |

Verified on 2026-11-18.

## The Principle: Two Decisions for Every Pod

The HAMi scheduler makes two decisions for a Pod that asks for a GPU slice: which node, and which card on that node. Each has a policy:

| Decision | Annotation on the Pod | `binpack` | `spread` | Default |
| --- | --- | --- | --- | --- |
| Which node | `hami.io/node-scheduler-policy` | fill nodes that are already in use | spread Pods across nodes | `binpack` |
| Which card on the node | `hami.io/gpu-scheduler-policy` | fill cards that are already in use | spread Pods across cards | `spread` |

The defaults come from the Helm values `scheduler.defaultSchedulerPolicy.nodeSchedulerPolicy` and `gpuSchedulerPolicy`. A Pod can override them with the annotations. `spread` keeps Pods away from each other, which helps when they compete for compute. `binpack` keeps whole cards free, which helps when a large Pod comes later.

The scheduler only reads what the device plugin reports about each card: its ID, memory, cores, type, and health. This cluster has one node, so this chapter looks at the card decision.

## Step 1: Look at the Cards

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

The device plugin writes each card's details into a node annotation. The scheduler reads them from there:

```bash
kubectl get node hami-lab-control-plane -o jsonpath='{.metadata.annotations.hami\.io/node-nvidia-register}' | jq -c '.[] | {id, devmem, devcore, type}'
```

```{.text .output}
{"id":"GPU-mock-0","devmem":40960,"devcore":100,"type":"NVIDIA-A100-SXM4-40GB"}
{"id":"GPU-mock-1","devmem":40960,"devcore":100,"type":"NVIDIA-A100-SXM4-40GB"}
```

Two cards with 40960 MiB and 100% compute each, 81920 MiB in total.

## Step 2: See the Problem First

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Two small models arrive first, 15000 MiB each, with no policy annotation:

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

The default `spread` policy put them on different cards. Now the training job asks for 30000 MiB on one card:

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

`big` stays `Pending` with `CardInsufficientMemory` on both cards. The node has 51920 MiB free, but each card has only 25960 MiB left, and a Pod's memory must fit on one card. The free memory is fragmented.

## Step 3: Pack Small Pods Together

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Run the same two small models with `hami.io/gpu-scheduler-policy: binpack`:

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

Both small models share `GPU-mock-1`, and `big` gets the empty `GPU-mock-0`. The total demand did not change. Only the placement did.

Which policy to use depends on the workloads. `binpack` keeps room for large Pods. `spread` gives each Pod more of a card's compute, since Chapter 3 showed that Pods on one card share its time.

## Step 4: Ask for an Empty Card

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Some workloads should start on a card that nobody else uses, for example a latency benchmark. `hami.io/gpu-scheduler-policy: mutex` only accepts cards with no Pods on them. Both cards are in use now:

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

Both cards have room for its 10000 MiB, but neither is empty. Free one:

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

`exclusive` started as soon as `GPU-mock-0` was empty.

## Step 5: Pin a Pod to a Card

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

A Pod can also name the card it wants with `nvidia.com/use-gpuuuid`, or the card type with `nvidia.com/use-gputype`:

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

`pinned` landed on `GPU-mock-0`, next to `exclusive`. `mutex` is checked only when `exclusive` is placed. It does not keep later Pods off the card. To keep a card for one Pod for its whole life, request all of the card's memory and cores.

Clean up:

```bash
kubectl delete -f examples/course/05-more-cards/small-binpack.yaml -f examples/course/05-more-cards/exclusive.yaml -f examples/course/05-more-cards/pinned.yaml
```

```{.text .output}
pod "small-1" deleted
pod "small-2" deleted
pod "exclusive" deleted
pod "pinned" deleted
```

## Beyond One Node

On a cluster with several GPU nodes, `hami.io/node-scheduler-policy` makes the same choice between nodes. With several cards per Pod, HAMi can also prefer cards that are connected well, for example over NVLink, with the `topology-aware` policy. Since v2.10.0, policies can be chained, such as `mutex,binpack`: filters first, then sort keys in the order written. [HAMi lab](../labs/hami-lab.md) covers topology and NUMA as read-along sections.

## Verify

| Claim | Evidence |
| --- | --- |
| The scheduler reads each card's details from the node | Step 1: two cards with 40960 MiB each |
| The default `spread` policy can fragment free memory | Step 2: `big` is `Pending` with `CardInsufficientMemory`, although 51920 MiB are free |
| `binpack` keeps a card free for a large Pod | Step 3: both small Pods on `GPU-mock-1`, `big` on `GPU-mock-0` |
| `mutex` waits for an empty card | Step 4: `ExclusiveDeviceAllocateConflict` until `big` is deleted |
| A Pod can name its card | Step 5: `pinned` on `GPU-mock-0` |

## Common Pitfalls

**The second Pod stays `Pending` for minutes, with no `FailedScheduling` reason.** In this kind cluster, the mock device plugin does not finish the binding, and hami-mock-monitor with `completeBinds=true` does it instead. Check that the `hami-mock-monitor` Pod in `kube-system` is running. If its install failed in `setup.sh`, run that `helm upgrade --install` line again.

**A policy annotation has no effect.** Check the spelling of the key and the value. `hami.io/gpu-scheduler-policy` takes `binpack`, `spread`, `mutex`, `topology-aware`, or a comma-separated chain.

**A Pod with `nvidia.com/use-gpuuuid` stays `Pending` with `CardUuidMismatch`.** No card has that UUID. Compare it with the IDs in Step 1.

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. In Step 2, the node had 51920 MiB free. Why could `big` not start?"

    A Pod's memory must fit on one card. Each card had only 25960 MiB left after `spread` placed one small Pod on each.

??? question "2. When would you choose `spread`, and when `binpack`?"

    When Pods on the same card would slow each other down, as in Chapter 3. `spread` gives each Pod a larger share of a card's time. `binpack` keeps whole cards free for large Pods.

??? question "3. `exclusive` used `mutex`, yet `pinned` landed on the same card. Why?"

    `mutex` only filters cards when `exclusive` is placed. Later Pods without `mutex` can still use the card.

<!-- markdownlint-enable MD046 -->

## Hand-off

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

No Pods from this chapter are left. Keep the kind cluster running. Chapter 6 runs on Colab, and Chapters 7 to 9 use this cluster again.

## Further Reading

- [Scheduling](https://project-hami.io/docs/core-concepts/scheduling){:target="_blank"}: how the HAMi scheduler filters and scores nodes and cards
- [HAMi lab: GPU sharing without a GPU](../labs/hami-lab.md): topology, NUMA, and other schedulers on the same cluster
