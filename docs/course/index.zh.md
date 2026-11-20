# 实战课程

实战课程从问题出发讲解 HAMi。你会跟着一个小型 AI 团队，从一张 GPU 开始，遇到一个接一个的问题：一个小模型占用了整张卡，共享的卡上模型互相争抢显存和算力，集群变大后又需要调度、监控和配额。每一章都先让你亲眼看到问题，再讲背后的原理，最后展示 HAMi 怎么解决。

## 在哪里运行

每一章会用到下面一种或两种环境，都不需要你自己有 GPU。

| 环境 | 适合做什么 | 你需要准备 |
| --- | --- | --- |
| Google Colab | 一张真实 GPU 上发生的事：显存、算力和 HAMi-core 的限制 | 一个 Google 账号和浏览器。Colab 免费提供一张 NVIDIA T4 |
| 你电脑上的 kind | 集群里发生的事：HAMi 的 webhook、调度器和各种策略 | Docker、`kind`、`kubectl` 和 `helm`，见 [安装实验工具](../labs/install-tools.md) |

每个需要动手的步骤开头，都有一行彩色标记说明它在哪里运行。Colab 上的命令是 notebook 里的 cell，以 `!` 或 `%%` 开头。kind 的命令在你电脑的终端里执行。

Colab 上没有 Kubernetes，kind 里没有真实的 GPU。在 Colab 里，由你扮演 HAMi 的 Device Plugin，亲手把限制交给程序。在 kind 里，你会看到调度器为 Pod 做出同样的决定。

## 章节

| 章节 | 要解决的问题 | 运行环境 | 时长 |
| --- | --- | --- | --- |
| [1. 逐层检查 GPU 软件栈](01-setup.md) | 从 GPU 到 Kubernetes，逐层确认每一层都正常 | Colab、kind | 15 分钟 |
| [2. 一卡一 Pod](02-one-gpu-one-pod.md) | 一个 2 GiB 的模型占用了整张卡 | Colab、kind | 15 分钟 |
| [3. 那就共享吧](03-lets-just-share-it.md) | 共享的程序互相抢占显存和算力 | Colab | 20 分钟 |
| [4. HAMi 登场](04-enter-hami.md) | 给每个 Pod 分配固定的显存和算力 | Colab、kind | 30 分钟 |
| [5. 卡多了怎么放](05-more-cards.md) | 空闲显存被切碎在各张卡上 | kind | 20 分钟 |
| [6. 运行真实模型](06-real-models.md) | 推理引擎按比例拿走整张卡的显存 | Colab | 30 分钟 |
| [7. 看得见](07-seeing-it.md) | 分配量和实际用量对不上 | kind | 10 分钟 |
| [8. 多个团队，一个集群](08-many-teams.md) | 一个团队占满了集群 | kind | 15 分钟 |
| [9. 出故障了](09-something-broke.md) | 逐层定位问题 | Colab、kind | 20 分钟 |

## 每一章的结构

每一章都按同样的顺序展开：场景、你将理解的内容、先看到问题、背后的原理、带真实输出的步骤、验证表、常见问题、几道自测题，以及下一章需要的起始状态。页面上的所有输出都来自真实运行，每章开头写明了版本和验证日期。

背景知识可以阅读 HAMi 官网的 [概念](https://project-hami.io/zh/docs/){:target="_blank"} 页面。
