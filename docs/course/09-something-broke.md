# Chapter 9: Something Broke

[:simple-googlecolab: Open this chapter in Colab](https://colab.research.google.com/github/Project-HAMi/hami-workshop/blob/main/notebooks/en/09-something-broke.ipynb){ .md-button .colab-button target="_blank" }

## Scenario

Monday morning, four messages arrive: a model sees the whole card although it should have 4 GiB, a model cannot allocate any memory at all, a model fails as soon as another one starts, and two Pods have been `Pending` since Friday. The team has seen every piece of HAMi in the earlier chapters. Now they have to find out which piece is failing.

## What You'll Understand

- How to place a symptom in a layer before looking for a cause
- What a broken HAMi-core setup looks like from inside a program
- How to read the scheduler's reason for a `Pending` Pod
- Which first command to run for each kind of symptom

## Environment

This chapter takes about 20 minutes. Faults 1 to 3 run on Google Colab with the free T4 GPU. Faults 4 and 5 run in the kind cluster from Chapter 5.

| Component | Version |
| --- | --- |
| GPU | Tesla T4, 15360 MiB |
| NVIDIA driver | 580.82.07 (CUDA 13.0) |
| HAMi-core | commit `1721252`, the version shipped with HAMi v2.11.0 |
| kind (Faults 4 and 5) | 0.33.0, Kubernetes v1.37.0 |
| HAMi (Faults 4 and 5) | v2.11.0 chart, mock device plugin |

Verified on Colab on 2026-11-19. Faults 4 and 5 verified on 2026-11-18.

## The Principle: Find the Layer First

Chapter 1 checked the GPU from the hardware up. HAMi adds two places to that stack: the scheduler, which decides where a Pod goes, and HAMi-core, which enforces the limits inside the container. Each symptom points to a layer, and each layer has a first command:

| Symptom | Layer | First command |
| --- | --- | --- |
| `nvidia-smi` fails on the node | driver, Chapter 1 Layers 2 and 3 | `nvidia-smi`, `lsmod \| grep nvidia` |
| A GPU Pod cannot see any GPU | container runtime, Chapter 1 Layer 4 | `kubectl exec <pod> -- ls /dev/nvidia*` |
| The node has no `nvidia.com/gpu` | device plugin, Chapter 2 | `kubectl get node <node> -o jsonpath='{.status.allocatable}'` |
| A Pod is `Pending` | HAMi scheduler, Chapter 5 | `kubectl get events --field-selector involvedObject.name=<pod>` |
| A Pod is refused at creation | quota, Chapter 8 | the error message of `kubectl apply` |
| A program ignores its limit, or every allocation fails | HAMi-core, Chapter 4 | `env \| grep CUDA_DEVICE` and `cat /etc/ld.so.preload` in the container |

Start at the lowest layer the symptom could come from. When that layer is healthy, move up.

Each fault below breaks one thing on purpose. Read the symptom, decide on the layer, then look at the cause and the fix.

## Prepare Colab

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Write the stand-in model and build HAMi-core, as in Chapter 4:

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

## Fault 1: The Limit Is Ignored

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

`model-a` should have a 4096 MiB limit:

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

**Symptom.** The program starts, loads its weights, and sees 14913 MiB, the whole card. The dynamic loader prints that it cannot preload `vgpu.so` and ignores it.

**Layer.** The program runs, but it sees the whole card, so the limit was never applied. That is the HAMi-core layer.

**Cause.** The library is called `libvgpu.so`. When the loader cannot open a file named in `LD_PRELOAD`, it skips it and starts the program anyway, without HAMi-core.

**Fix.** Point `LD_PRELOAD` at `libvgpu.so`. In a cluster, check that `/etc/ld.so.preload` exists in the container and names a file that exists.

## Fault 2: Every Allocation Fails

:simple-googlecolab: **Runs on Colab**
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

**Symptom.** The program sees 0 MiB. HAMi-core refuses the 2 GiB allocation against a limit of 4096, and PyTorch reports a card with a total capacity of 4.00 KiB.

**Layer.** HAMi-core is loaded, since it reports the limit, but the limit is wrong.

**Cause.** `CUDA_DEVICE_MEMORY_LIMIT_0=4096` has no unit, and HAMi-core reads a number without a unit as bytes. The limit is 4 KiB.

**Fix.** Write `4096m`. HAMi's device plugin always adds the unit. This fault comes from setting the variable by hand, for example in a Pod spec.

## Fault 3: A Model Fails Next to Another One

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Two models with 4096 MiB each, started one after the other:

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

**Symptom.** `model-b` sees its 4096 MiB card, yet fails to allocate 3 GiB, although the real card has more than 10 GiB free.

**Layer.** HAMi-core is loaded and the limit is right. The problem is between the two programs.

**Cause.** Both use `/tmp/shared.cache`. HAMi-core treats every process that uses the same cache file as part of one container, so `model-a` and `model-b` share one 4096 MiB limit, and `model-a` already holds 3 GiB of it.

**Fix.** Give each Pod its own cache file. HAMi's device plugin does this for every container. If the variable is missing, HAMi-core builds a path from the `POD_UID` and `CONTAINER_NAME` variables. When those are missing too, it falls back to `/tmp/cudevshr.cache`, which every such process shares.

```python
!pkill -f /content/model.py
```

## Fault 4: Pending, Too Big

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

A Pod asks for 50000 MiB:

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

**Symptom.** `Pending`, with `CardInsufficientMemory` on 2 of 2 cards.

**Layer.** The HAMi scheduler. The event says why it rejected each card.

**Cause.** Each card has 40960 MiB. 50000 MiB cannot fit on one card, however empty the cluster is.

**Fix.** Ask for less memory per card, or for more cards with `nvidia.com/gpu`. If the cards are big enough but full, Chapter 5 shows how placement and policies help.

```bash
kubectl delete -f examples/course/09-something-broke/too-big.yaml
```

## Fault 5: Pending, Wrong Card Type

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

A Pod asks for an H100:

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

**Symptom.** `Pending`, with `CardTypeMismatch` on 2 of 2 cards.

**Layer.** The HAMi scheduler again, this time a filter on the card type.

**Cause.** The cluster has `NVIDIA-A100-SXM4-40GB` cards, as Chapter 5 Step 1 showed. No card type contains `H100`.

**Fix.** Ask for a type that exists. The scheduler retries a `Pending` Pod when it changes, so updating the annotation is enough:

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

`A100` matches part of the type name, which is enough.

```bash
kubectl delete -f examples/course/09-something-broke/wrong-type.yaml
```

## Faults You Cannot Break Here

Some faults need a real GPU node. They are listed with the layer and the first check:

| Fault | Layer | What you see | First check |
| --- | --- | --- | --- |
| The driver is not loaded after a kernel upgrade | driver | `nvidia-smi` fails on the node | `lsmod \| grep nvidia`, `dmesg \| grep -i nvidia` |
| `nvidia` is not containerd's default runtime | container runtime | Pods are scheduled but see no GPU | the containerd configuration, Chapter 1 Layer 4 |
| The GPU node is missing the label `gpu=on` | device plugin | no `hami-device-plugin` Pod on the node, no `nvidia.com/gpu` | `kubectl get node --show-labels`. The chart runs the device plugin only on nodes that match `devicePlugin.nvidiaNodeSelector`, `gpu: "on"` by default |
| The NVIDIA device plugin still runs next to HAMi's | device plugin | both register `nvidia.com/gpu` | `kubectl get daemonsets -A` |

## Verify

| Claim | Evidence |
| --- | --- |
| A wrong preload path leaves the program without limits | Fault 1: `model-a` sees 14913 MiB, and the loader ignores `vgpu.so` |
| A limit without a unit is read as bytes | Fault 2: the limit shows as 4096 bytes, a 4.00 KiB card |
| Processes with the same cache file share one limit | Fault 3: `model-b` fails next to `model-a` |
| The scheduler names the reason for each card | Faults 4 and 5: `CardInsufficientMemory`, `CardTypeMismatch` |
| Changing a `Pending` Pod lets the scheduler retry | Fault 5: `wrong-type` runs after the annotation is fixed |

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. A program in a HAMi Pod sees the whole card. Which layer do you check, and with which command?"

    HAMi-core. Check that `/etc/ld.so.preload` exists in the container and names a file that exists, and that `CUDA_DEVICE_MEMORY_LIMIT_0` is set.

??? question "2. A Pod is `Pending`. Where does HAMi say why?"

    In the Pod's `FailedScheduling` event. It names the reason for each card, such as `CardInsufficientMemory` or `CardTypeMismatch`.

??? question "3. Two Pods on one card fail to allocate although the card has free memory. What do you compare?"

    Their `CUDA_DEVICE_MEMORY_SHARED_CACHE`. Processes with the same cache file share one limit.

<!-- markdownlint-enable MD046 -->

## Hand-off

:simple-googlecolab: **Runs on Colab**
{: .run-on .run-on-colab }

Release the Colab runtime with **Runtime → Disconnect and delete runtime**.

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

This is the last chapter of the Hands-on Course. Delete the kind cluster when you are done:

```bash
kind delete cluster --name hami-lab
```

## Where to Go Next

- [HAMi lab](../labs/hami-lab.md) in this workshop: topology, Volcano, DRA, and the HAMi WebUI
- [Labs on the HAMi website](https://project-hami.io/tutorials/){:target="_blank"}: HAMi with DRA, Volcano, KAI Scheduler, Kueue, Dynamic MIG, Ascend, and more, on real clusters
- [Troubleshooting](https://project-hami.io/docs/troubleshooting){:target="_blank"}: known problems and their fixes
