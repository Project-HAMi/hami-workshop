# HAMi 实验：没有 GPU 也能共享 GPU

一个自学式实验，在 Kubernetes 中用 HAMi 共享 GPU。任何笔记本都能运行：HAMi 调度器是真的，GPU 是模拟的。约 80 分钟内，你会在 kind 上安装 HAMi，在 Pod 之间共享模拟的 A100 卡，对比调度策略，了解拓扑、其他调度器和 DRA 的位置，并读懂 HAMi 暴露的两组指标。

- [mock-device-plugin](https://github.com/Project-HAMi/mock-device-plugin) 根据节点注解注册 `nvidia.com/gpumem` 和 `nvidia.com/gpucores` 容量。
- [hami-mock-monitor](https://github.com/fishman/hami-mock-monitor) 用负载源代替 GPU，输出 HAMi 的用量指标（通常由 vGPUmonitor 和 HAMi-core 产生）。

没有 GPU 就**没有**容器内的显存与算力隔离，这部分由 HAMi-core 负责。想在真实硬件上体验，参见 AMD 笔记本的脚注[^amd]。

![实验架构](../images/hami-lab-architecture.svg)

2026-11-09 测试通过：kind 0.33、kubectl 1.37、helm 4.3、HAMi chart 2.11.0、hami-mock-monitor 0.2.0。

## 准备

- Linux 虚拟机中的 Docker（macOS 上用 Docker Desktop、OrbStack 或 Colima），4 CPU、8 GB 空闲内存。macOS 原生容器无法配合 kind 使用，参见[安装实验工具](install-tools.md)。
- `kind`、`kubectl`、`helm`、`jq`、`git`，参见[安装实验工具](install-tools.md)。
- 仅在需要编译 HAMi 或贡献代码时才需要 Go 1.27+。

请在**课前一次性拉好镜像**，不要到现场再拉：

```bash
git clone https://github.com/Project-HAMi/hami-workshop
cd hami-workshop/examples/hami-lab
docker pull kindest/node:v1.37.0
docker pull docker.io/projecthami/hami:v2.11.0
docker pull docker.io/projecthami/mock-device-plugin:latest
docker pull docker.io/liangjw/kube-webhook-certgen:v1.1.1
docker pull busybox:1.36
docker pull ghcr.io/llm-d/llm-d-inference-sim:v0.12.0
docker pull ghcr.io/fishman/hami-mock-monitor:0.2.0
```

`setup.sh` 会把本地已有的镜像导入 kind，只拉取缺少的。

## HAMi 如何协同工作

Pod 请求一张卡的一部分。webhook 把它路由给 HAMi 调度器，调度器选出节点和卡。设备插件配置容器，HAMi-core 强制执行限额：

![Pod 到 GPU 的路径](../images/hami-lab-pod-path.svg)

![HAMi 各组件如何协同工作](../images/hami-lab-components.svg)

## 实验 1：安装 HAMi

```bash
./setup.sh
```

脚本做的事：

1. 创建 kind 集群 `hami-lab`，给节点打标签 `gpu=on`。
2. 把预先拉好的镜像导入集群。
3. 安装 HAMi 2.11.0，关闭真实设备插件，开启 mock 插件。
4. 模拟两张 A100-40GB：计数资源 `nvidia.com/gpu=20`（2 张卡 x 10 份切分），以及来自 `fake-gpus.json` 的节点注解 `hami.io/node-nvidia-register`，这正是真实设备插件读取 NVML 后写入的内容。
5. 安装 hami-mock-monitor，设置 `completeBinds=true`。

结束时应看到：

```json
{ "nvidia.com/gpu": "20", "nvidia.com/gpucores": "200",
  "nvidia.com/gpumem": "81920", "nvidia.com/gpumem-percentage": "200" }
```

四处看看：

```bash
kubectl -n kube-system get pods | grep hami
kubectl -n kube-system get cm hami-scheduler-device -o yaml | less
kubectl get node hami-lab-control-plane -o jsonpath='{.metadata.annotations.hami\.io/node-nvidia-register}' | jq
```

**思考题。** 调度器从哪里获得卡的列表？如果 `health` 为 `false` 会有什么变化？

## 实验 2：共享 GPU

```bash
kubectl apply -f share.yaml -f too-big.yaml
kubectl wait --for=condition=Ready pod/share-1 pod/share-2 pod/share-3 --timeout=120s
kubectl get events --field-selector involvedObject.name=too-big | tail -2
# 0/1 nodes are available: 1 2/2 CardInsufficientMemory.
for p in share-1 share-2 share-3; do
  echo -n "$p "; kubectl get pod $p -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}{"\n"}'
done
# share-1 GPU-mock-1,NVIDIA,15000,30:;
# share-2 GPU-mock-0,NVIDIA,15000,30:;
# share-3 GPU-mock-1,NVIDIA,15000,30:;
```

`too-big` 请求 45000 MB，超过任何一张 40960 MB 的卡，因此一直 `Pending`。分配格式为每个设备 `uuid,type,memory_mb,cores:`，每个容器以 `;` 结尾。

你刚刚看到的链路：

1. 准入 **webhook** 把 `schedulerName` 改写为 `hami-scheduler`。
2. 调度器 **extender** 在 `Filter` 阶段读取 `hami.io/node-nvidia-register`，逐卡检查显存和算力余量，选出卡的 UUID。
3. 在 `Bind` 阶段，它把 `hami.io/vgpu-devices-allocated` 写到 Pod 上，设置 `hami.io/bind-phase=allocating`，并获取节点锁 `hami.io/mutex.lock`。
4. 设备插件的 `Allocate` 挂载设备和 `libvgpu.so`，标记 `success` 并释放锁。mock 插件跳过了这一步，所以 hami-mock-monitor 提供了 `completeBinds`。没有它，下一个 Pod 最多要等 5 分钟才能拿到锁。

## 实验 3：调度策略

| 维度 | 注解 | binpack | spread |
| --- | --- | --- | --- |
| 选哪个节点 | `hami.io/node-scheduler-policy` | 用更少的节点 | 分散到各节点 |
| 节点上选哪张卡 | `hami.io/gpu-scheduler-policy` | 同一张卡 | 分散到各卡 |

```bash
kubectl delete -f share.yaml -f too-big.yaml
kubectl apply -f binpack.yaml
kubectl wait --for=condition=Ready pod/pack-1 pod/pack-2 --timeout=120s
for p in pack-1 pack-2; do
  echo -n "$p "; kubectl get pod $p -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}{"\n"}'
done
kubectl delete -f binpack.yaml
kubectl apply -f spread.yaml
kubectl wait --for=condition=Ready pod/spread-1 pod/spread-2 --timeout=120s
for p in spread-1 spread-2; do
  echo -n "$p "; kubectl get pod $p -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}{"\n"}'
done
```

binpack 把两个 Pod 放在同一张卡上，spread 则每张卡放一个。

### Mutex：从空闲卡开始

`hami.io/gpu-scheduler-policy: mutex`（HAMi v2.10.0 新增）是一个过滤器：只有没有任何租户的卡才是候选。卡上哪怕只有一个很小的负载，也会被排除。保持 spread 的两个 Pod 运行，每张卡一个：

```bash
kubectl apply -f mutex.yaml
kubectl get events --field-selector involvedObject.name=mutex-1 | tail -1
# 0/1 nodes are available: 1 2/2 ExclusiveDeviceAllocateConflict.
kubectl delete pod spread-2
kubectl wait --for=condition=Ready pod/mutex-1 --timeout=120s
kubectl get pod mutex-1 -o jsonpath='{.metadata.annotations.hami\.io/vgpu-devices-allocated}{"\n"}'
# GPU-mock-0,NVIDIA,15000,30:;
kubectl delete -f spread.yaml -f mutex.yaml --ignore-not-found
```

两张卡的显存都够 `mutex-1` 使用，但都不是空的，所以它要等到有一张卡空出来。

- Mutex **只在放置时检查**。之后没有 `mutex` 的 Pod 仍然可以加入这张卡。要在 Pod 整个生命周期内独占一张卡，请申请它的全部显存和算力，或用 `nvidia.com/use-gpuuuid` 固定。
- 自 v2.10.0 起策略可以组合：先执行过滤器（`mutex`、`topology-aware`），再按书写顺序执行排序键（`binpack`、`spread`、`numa`）。`mutex,binpack,numa` 先选空闲卡，再在其中选装得最满的，NUMA 作为平局判定。
- NVIDIA 上的 `mutex,topology-aware`：先筛出空闲卡，再在其中选 NVLink 连接最好的一组。如果最佳组里有卡正被占用，Pod 会得到较差的一组或保持 Pending。

### 拓扑信息从哪里来

调度器从不直接读取硬件。各厂商的设备插件在节点上读取硬件信息并写成节点注解，调度器据此给卡打分：

![拓扑信息从哪里来](../images/hami-lab-topology.svg)

- **NVIDIA：** 设置 `ENABLE_TOPOLOGY_SCORE=true` 后，插件通过 NVML（NVLink、PCIe）为每一对卡打分，写入 `hami.io/node-nvidia-score`。使用策略 `topology-aware` 时，请求一张卡会得到连接最少的那张，请求 N 张卡则得到连接最好的一组。
- **AMD：** `hami.io/node-amd-register` 中每个 GPU 带有 `xgmiPeers` 和 `numa`。Pod 可以请求 `amd.com/numa-bind`、`amd.com/link-bind` 或 `topology-aware`。
- **MetaX：** 厂商插件写入 `metax-tech.com/gpu.topology.scores` 和 `.losses`。优先 MetaXLink，其次 PCIe switch。
- **昆仑芯、AWS Neuron：** 没有链路数据。布局固定，调度器根据卡的序号推导。

### CPU 与 GPU 在同一个 NUMA 节点（阅读）

调度器选 GPU，kubelet 的 Topology Manager 选 CPU。自 HAMi v2.11.0 起，两者不一致时设备插件会请求调度器重新匹配（refit），让 CPU、GPU 和 HAMi 的记账落在同一个 NUMA 节点上。kind 只有一个 NUMA 节点，因此这部分仅作阅读。

```yaml
# kubelet 配置
cpuManagerPolicy: static
topologyManagerPolicy: single-numa-node
topologyManagerScope: container
```

```yaml
metadata:
  annotations:
    hami.io/numa-alignment: best-effort   # 或 strict
```

- Helm：`devices.nvidia.enableNumaTopology`、`devicePlugin.numaRefit.enabled`，以及按节点配置的 `enablegetpreferredallocation`。默认全部关闭。
- `best-effort`：refit 失败时保留 kubelet 的选择并记录日志。`strict`：分配失败。
- 仅适用于整数 CPU 的 Guaranteed QoS Pod，且为 hami-core 模式。详见 [NUMA 对齐指南](https://project-hami.io/docs/userguide/nvidia-device/numa-alignment)。

## 实验 4：Flexible MIG（阅读）

MIG 需要 Ampere 或更新的 GPU，mock 卡无法创建 GPU 实例。

- **静态 MIG：** NVIDIA MIG Manager。整卡布局需提前选定，修改就要排空节点。Pod 申请 `nvidia.com/mig-1g.10gb`。
- **动态 MIG，HAMi v2.5.0：** `knownMigGeometries` 按型号列出整卡模板。调度器选第一个合适的模板，设备插件用 mig-parted 应用。新的 profile 组合意味着切换模板，所以卡必须先空出来。
- **Flexible MIG，HAMi v2.10.0：** 不再需要模板。profile 和合法位置来自 NVML，调度器在 `hami.io/vgpu-mig-allocations` 中预留满足 `gpumem` 请求的最小允许 profile，设备插件在 `Allocate` 时创建实例，并在 Pod 结束时删除。无需排空。
- **v2.11.0：** 每个 MIG 实例一份 CDI spec（v2.10.0 的 MIG 无法配合 CDI 设备注入使用），带回溯的放置打分，`nvidia.com/mig-profile-preference`，以及通过 `devicePlugin.reportNodeCapacity` 支持 Cluster Autoscaler。

```yaml
# 节点配置："operatingmode": "mig"
nvidia:
  migProfileAllowlist:
    - models: ["A100-SXM4-40GB"]
      profiles: ["1g.5gb", "2g.10gb", "3g.20gb", "7g.40gb"]
```

```yaml
metadata:
  annotations:
    nvidia.com/vgpu-mode: "mig"
# limits: nvidia.com/gpu: 1, nvidia.com/gpumem: 8000  -> 2g.10gb
```

Pod 写法与实验 2 相同。有空闲切片但没有合法的连续位置时，Pod 会保持 Pending，HAMi 不会移动正在运行的实例。HAMi 与 NVIDIA MIG Manager 不能管理同一张 GPU。详见 [动态 MIG 支持](https://project-hami.io/docs/userguide/nvidia-device/dynamic-mig-support)。

## 实验 5：默认调度器之外

HAMi 是容量模型加上隔离库 HAMi-core。其他调度器可以替换放置逻辑，同时保留隔离：

![一个隔离层，多种调度大脑](../images/hami-lab-scheduling-brains.svg)

- **KAI Scheduler**（v0.16.4+）：`global.gpuSharing=true` 和 `binder.plugins.hamicore.enabled=true`。KAI 负责放置，HAMi-core 根据 `gpu-fraction` 或 `gpu-memory` 限制显存。
- **Volcano**：`deviceshare` 插件加 volcano-vgpu-device-plugin，资源为 `volcano.sh/vgpu-*`。在共享 GPU 上提供 gang 调度和队列上限。每个 GPU 节点只运行一条设备插件路径。可尝试 [Volcano vGPU 教程](https://project-hami.io/tutorials/labs/volcano-vgpu-gang-queue)。

### 安装 Volcano vGPU 插件

参考 [volcano-vgpu-device-plugin README](https://github.com/Project-HAMi/volcano-vgpu-device-plugin)。插件 v1.13.0 需要 Volcano v1.15.0 或更高版本。在 `volcano-scheduler-configmap`（命名空间 `volcano-system`）中启用 vGPU：

```yaml
- name: deviceshare
  arguments:
    deviceshare.VGPUEnable: true
    deviceshare.SchedulePolicy: binpack  # 或 spread
```

目前还没有发布 Helm 仓库，需要从源码目录安装。`nvmlMock.enabled=true` 可以在没有 GPU 的集群上运行，足以检查调度和注册：

```bash
git clone https://github.com/Project-HAMi/volcano-vgpu-device-plugin
cd volcano-vgpu-device-plugin
helm install volcano-vgpu-device-plugin deployments/helm/volcano-vgpu-device-plugin \
  --set nvmlMock.enabled=true
kubectl get node <node> -o jsonpath='{.status.allocatable}'
```

应能看到 `volcano.sh/vgpu-number` 和 `volcano.sh/vgpu-memory`。不要在运行 HAMi 设备插件的节点上安装它。

### DRA

![设备插件与 DRA 对比](../images/hami-lab-device-plugin-vs-dra.svg)

DRA 有四种对象：**ResourceSlice**（由驱动发布，包含带属性和容量的设备）、**DeviceClass**（用 CEL 选择设备，HAMi 使用 `hami-core-gpu.project-hami.io`）、**ResourceClaim**（Pod 的请求）和 **ResourceClaimTemplate**（每个 Pod 一个 claim）。借助可消耗容量（`DRAConsumableCapacity`，自 1.36 起默认开启），一张卡可以服务多个 claim：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata: { name: single-gpu-0 }
spec:
  devices:
    requests:
    - name: single-gpu
      exactly:
        deviceClassName: hami-core-gpu.project-hami.io
        capacity:
          requests: { cores: 30, memory: "4Gi" }
```

[HAMi-DRA](https://github.com/Project-HAMi/HAMi-DRA) 保留 HAMi 的 Pod 写法：webhook 把 `nvidia.com/gpu` 请求改写为 claim。

![HAMi-DRA](../images/hami-lab-hami-dra.svg)

它需要 Kubernetes 1.34+，以及 containerd 或 CRI-O 中的 CDI，因此在本实验中仅作阅读。

## v2.11.0 新功能（阅读）

### Remote GPU

在没有 GPU、也没有驱动的节点上运行 CUDA，GPU 由 [Lupine](https://github.com/lupinemachines) 通过网络提供。配置为 `operatingmode: remote` 的 GPU 节点作为 Lupine 服务器，而不是公布本地设备。在客户端，init 容器提供 Lupine 客户端库和 `nvidia-smi`，HAMi 注入 `LUPINE_SERVER`。

```yaml
# 在无 GPU 节点上运行 vLLM
resources:
  limits:
    nvidia.com/remote-gpu: 2               # 预留整台服务器
    nvidia.com/remote-gpu-memory: 20480    # 每卡上限，由 HAMi-core 限制
```

通过 `devices.remotegpu.enabled` 启用。服务器可以按 Node 标签分池，用 `hami.io/remote-server` 选择。客户端和服务器节点必须分开，支持的镜像为 CUDA 和 vLLM 0.19 至 0.26。示例：[HAMi examples/remotegpu](https://github.com/Project-HAMi/HAMi/tree/master/examples/remotegpu)。

### AMD Instinct 共享

与 NVIDIA 相同的资源模型，容器内由 amd-hami-core 强制限制：

- **显存：** `amd.com/gpumem` 或 `amd.com/gpumem-percentage`。
- **算力：** `amd.com/gpucores` 通过 `HSA_CU_MASK` 设置计算单元份额。
- **放置：** `amd.com/numa-bind`，用 `amd.com/link-bind` 选择 XGMI 互联的卡，以及 `binpack`、`spread`、`mutex` 和 `topology-aware` 策略。
- **节点侧：** amd-device-plugin v0.0.4 支持 SPX、DPX、QPX 和 CPX 计算分区。amd-dra-driver 在 DRA 路径上提供同样的限制。

详见 [AMD GPU 指南](https://project-hami.io/docs/next/userguide/amd-device/enable-amd-gpu-sharing)。

## 收尾：预留不等于使用

![预留与使用](../images/hami-lab-reservation-usage.svg)

```bash
./metrics.sh scheduler
./metrics.sh monitor
kubectl apply -f sim.yaml
watch -n 5 "./metrics.sh monitor | grep 'pod=\"sim\"'"
```

`sim` 是兼容 vLLM 的模拟器。它的利用率在 0 到 33 之间波动，而显存始终保持在限额的 0.9 倍，因为 vLLM 会预分配 KV cache。

**思考题。** 一张卡显示 73% 显存已分配，但只用了 20%。容量看板应该用哪个数字，成本报表又该用哪个？

## 可选：HAMi WebUI

![WebUI 如何集成](../images/hami-lab-webui.svg)

```bash
docker pull projecthami/hami-webui-be-oss:v1.3.0 projecthami/hami-webui-fe-oss:v1.3.0   # once, at home
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add hami-webui https://project-hami.github.io/HAMi-WebUI
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --version 75.15.1 -n monitoring --create-namespace --set grafana.enabled=false --wait
kubectl apply -f monitoring.yaml -f webui-rules.yaml
helm upgrade --install my-hami-webui hami-webui/hami-webui \
  --set externalPrometheus.enabled=true \
  --set externalPrometheus.address="http://prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090" \
  --set dcgm-exporter.enabled=false \
  --set image.frontend.digest="" --set image.backend.digest="" \
  -n kube-system --wait
kubectl -n kube-system port-forward svc/my-hami-webui 3000:3000
```

`webui-rules.yaml` 把调度器和 mock monitor 较新的指标名记录为 WebUI 查询所用的名称。没有它，分配和用量面板会一直是空的。

如果想改 WebUI：

```bash
git clone https://github.com/Project-HAMi/HAMi-WebUI && cd HAMi-WebUI
make bootstrap && make -C server bootstrap
make -C server run   # Go API on :8000, point server/config/config.yaml at Prometheus
make dev             # Vite on :3000
make verify && make -C server verify
```

## 参与贡献

- **HAMi**：`make test`。从 `pkg/device/nvidia/device.go`（`Fit`）或 `pkg/scheduler/scheduler.go`（`Filter`、`Bind`）入手。
- **HAMi-DRA**：把 `nvidia.com/gpu` 请求转换为 DRA claim 的 webhook。
- **mock-device-plugin**：在 `Allocate` 中完成绑定，或增加一个厂商。
- **hami-mock-monitor**：支持其他厂商，为实验做一个 Grafana 看板。

提交需要 `git commit -s`。找 `good first issue`，然后提一个 draft PR。

## 故障排查

### macOS：给虚拟机足够的资源

kind 把每个节点作为容器跑在 Docker 虚拟机里，虚拟机需要 4 CPU、8 GB 内存。

- **Docker Desktop：** Settings、Resources、Advanced：CPU limit 设为 4，memory limit 设为 8 GB，然后 Apply & restart。
- **Colima：** 默认虚拟机只有 2 CPU、2 GB。用更大的配置重启：

```bash
colima stop
colima start --cpu 4 --memory 8 --vm-type vz
```

`--vm-type` 只对新建的虚拟机生效。如果现有虚拟机用的是 qemu，先执行 `colima delete`（会删除已拉取的镜像）。

### `kind load` 报错 `content digest ... not found`

Docker 的 containerd 镜像存储保存的是多架构镜像，`kind load docker-image` 无法导入（[kind#3795](https://github.com/kubernetes-sigs/kind/issues/3795)）。`setup.sh` 已经绕过了这个问题，但你自己执行 `kind load` 时可能会遇到。查看当前使用的存储：

```bash
docker info -f '{{ .DriverStatus }}'   # 出现 io.containerd.snapshotter.v1 表示使用 containerd 存储
```

关闭方法：

- **Docker Desktop：** Settings、General，取消勾选 "Use containerd for pulling and storing images"，然后 Apply & restart。
- **Colima：** 执行 `colima start --edit`，设置 Docker 守护进程配置：

```yaml
docker:
  features:
    containerd-snapshotter: false
```

两种存储里的镜像互不可见，切换后需要重新拉取。

### Pod 报错 `too many open files`

虚拟机的 inotify 限制对 HAMi 的 Pod 和 kind 来说太低（[kind 已知问题](https://kind.sigs.k8s.io/docs/user/known-issues/#pod-errors-due-to-too-many-open-files)）。在虚拟机内调高，重启虚拟机后失效：

```bash
# Colima
colima ssh -- sudo sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512
# Docker Desktop 或 OrbStack
docker run --rm --privileged alpine sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512
```

### `kind create cluster` 找不到 Docker

`docker context ls` 中当前激活的必须是你刚启动的虚拟机（`colima`、`desktop-linux` 或 `orbstack`）。用 `docker context use colima` 切换。

## 清理

```bash
kind delete cluster --name hami-lab
```

[^amd]: 如果你的笔记本有 AMD APU（例如带 Radeon 780M 核显的 Ryzen），可以在真实硬件上看到 HAMi-core 风格的隔离：[Local AMD GPU with HAMi](local-amd-gpu.md) 在一块集成 GPU 上用 ROCm 运行两个 llama.cpp 服务，每个限制为一半计算单元和 2 GiB 显存。需要带 `/dev/kfd` 的 Linux；在 `gfx1103` 上使用 `HSA_OVERRIDE_GFX_VERSION=11.0.0`。
