# Chapter 8: Many Teams, One Cluster

## Scenario

A second team starts using the cluster. The training team submits four jobs on a Friday evening, each asking for two GPU slices, and by the time the serving team deploys a small model, both cards are full. The teams agree that each one gets a budget of GPU memory. Now someone has to enforce it.

## What You'll Understand

- Why a shared cluster needs a per-team GPU budget
- How a Kubernetes ResourceQuota limits HAMi's GPU memory per namespace
- Why the native quota counts multi-GPU Pods wrong, and how HAMi's extended quota fixes it
- Where quotas stop and job queues begin

## Environment

This chapter takes about 15 minutes. This chapter runs in the kind cluster from [HAMi lab: GPU sharing without a GPU](../labs/hami-lab.md), as in Chapter 5. The two fake cards have 40960 MiB each.

| Component | Version |
| --- | --- |
| kind | 0.33.0, Kubernetes v1.37.0 |
| HAMi | v2.11.0 chart, mock device plugin |

Verified on 2026-11-18.

## The Principle: Admission Before Scheduling

A ResourceQuota is checked when a Pod is created, before the scheduler sees it. If the Pod would take its namespace over budget, the API server refuses it. Kubernetes supports quotas on extended resources, which includes HAMi's `nvidia.com/gpumem`, with the `requests.` prefix.

The native quota has one blind spot for GPU slices. It adds up the numbers written in each container's spec. A Pod with `nvidia.com/gpu: 2` and `nvidia.com/gpumem: 10000` gets 10000 MiB on each of two cards, 20000 MiB in total, but the spec only says 10000. HAMi's webhook has its own quota check for this. It reads quotas with the `limits.` prefix and counts memory times the number of cards.

## Step 1: See the Problem First

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Create the two team namespaces. The training team's job asks for two cards with 10000 MiB each:

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

Submit four of them:

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

The four jobs take 40000 of the 40960 MiB on each card. Then the serving team deploys a model that needs 8000 MiB:

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

Nothing stopped one team from taking the whole cluster. Clean up before the next step:

```bash
kubectl delete pods -n team-a --all
kubectl delete pod serve -n team-b
```

## Step 2: A Native Quota

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Give `team-a` a budget of 30000 MiB with a native quota:

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

The quota counts 30000 MiB and admits all three jobs. Each job holds 10000 MiB on both cards, so the three hold 60000 MiB, twice the budget. Each job's 10000 MiB is counted once, although the job holds it on two cards.

Remove the jobs and the native quota:

```bash
kubectl delete pods -n team-a --all
kubectl delete -f examples/course/08-many-teams/quota-native.yaml
```

## Step 3: HAMi's Extended Quota

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

The same budget with the `limits.` prefix, which HAMi's webhook enforces:

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

The first job counts 20000 MiB, so the second one would bring `team-a` to 40000, and HAMi's webhook refuses it. Note the `Used` column: Kubernetes itself does not count `limits.` for extended resources, so it shows 0. The usage lives in HAMi.

## Step 4: Read the Quota Usage

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

The HAMi scheduler exports its view of each quota:

```bash
SCHED=$(kubectl -n kube-system get pod -l app.kubernetes.io/component=hami-scheduler -o jsonpath='{.items[0].metadata.name}')
kubectl get --raw "/api/v1/namespaces/kube-system/pods/$SCHED:9395/proxy/metrics" | grep '^hami_resource_quota_used' | grep team-a
```

```{.text .output}
hami_resource_quota_used{limit="0",namespace="team-a",quota_name="nvidia.com/gpucores",zone="vGPU"} 0
hami_resource_quota_used{limit="30000",namespace="team-a",quota_name="nvidia.com/gpumem",zone="vGPU"} 20000
```

20000 of 30000 MiB used, which is what the job holds on the cards. `limit="0"` for `gpucores` means no quota is set for compute.

## Where Quotas Stop

A quota refuses a Pod that does not fit the budget, at the moment it is created. It does not keep the Pod and start it later when the budget frees up. A training job that is refused on Friday evening is simply gone. For waiting lines, priorities between teams, and gang scheduling of multi-Pod jobs, a queueing system sits in front of the scheduler. Kueue and Volcano both work with HAMi's GPU slices:

- [Volcano vGPU with gang scheduling and queues](https://project-hami.io/tutorials/labs/volcano-vgpu-gang-queue){:target="_blank"}
- [Kueue with HAMi vGPU](https://project-hami.io/tutorials/labs/kueue-hami-vgpu){:target="_blank"}

## Verify

| Claim | Evidence |
| --- | --- |
| Without a budget, one team can fill the cluster | Step 1: four jobs fill both cards, `serve` is `Pending` |
| The native quota counts multi-GPU Pods once | Step 2: three jobs admitted at 30k used, 60000 MiB held |
| HAMi's extended quota counts every card | Step 3: the second job is denied by `vgpu.hami.io` |
| HAMi tracks the quota usage | Step 4: `hami_resource_quota_used` is 20000 of 30000 |

## Common Pitfalls

**A ResourceQuota on `limits.nvidia.com/gpumem` has no effect.** HAMi only enforces quotas on the resources it manages, and only with the `limits.` prefix. Check the resource name and the namespace of the quota. A quota in another namespace does not apply.

**`kubectl describe resourcequota` shows 0 used for `limits.nvidia.com/gpumem`.** This is expected. Kubernetes does not count `limits.` for extended resources. Read HAMi's usage from `hami_resource_quota_used`.

**A job is refused and never retried.** Quotas only admit or refuse. Use Kueue or Volcano to queue jobs until the budget allows them.

## Checkpoint

<!-- markdownlint-disable MD046 -->

??? question "1. When is a ResourceQuota checked?"

    When the Pod is created, before it reaches the scheduler. A Pod over budget is refused by the API server or by HAMi's webhook.

??? question "2. A Pod asks for `nvidia.com/gpu: 2` and `nvidia.com/gpumem: 10000`. How much does the native quota count, and how much does HAMi count?"

    The native quota counts 10000 MiB, the number in the spec. HAMi counts 20000 MiB, 10000 on each of two cards, which is what the Pod holds.

??? question "3. Why does a team need Kueue or Volcano when it already has a quota?"

    A quota refuses Pods over budget immediately. A queue holds them and starts them when the budget and the cards allow.

<!-- markdownlint-enable MD046 -->

## Hand-off

:material-laptop: **Runs in kind on your laptop**
{: .run-on .run-on-kind }

Delete the two team namespaces. Keep the cluster running for Chapter 9:

```bash
kubectl delete -f examples/course/08-many-teams/teams.yaml
```

```{.text .output}
namespace "team-a" deleted
namespace "team-b" deleted
```

## Further Reading

- [Using Extended ResourceQuota for NVIDIA Devices](https://project-hami.io/docs/userguide/nvidia-device/using-resourcequota){:target="_blank"}: HAMi's quota in detail
- [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/){:target="_blank"}: the Kubernetes ResourceQuota and extended resources
