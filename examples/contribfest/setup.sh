#!/usr/bin/env bash
# ContribFest lab environment: kind + HAMi 2.10 + mock device plugin + two fake A100-40GB
# + hami-mock-monitor. No GPU needed. Tested with kind 0.33, kubectl 1.37, helm 4.3.
set -euo pipefail

CLUSTER=${CLUSTER:-hami-lab}
NODE="${CLUSTER}-control-plane"
HAMI_VERSION=${HAMI_VERSION:-2.10.0}
MONITOR_SRC=${MONITOR_SRC:-./hami-mock-monitor}

step() { printf '\n==> %s\n' "$*"; }

step "kind cluster ${CLUSTER}"
kind get clusters | grep -qx "${CLUSTER}" || kind create cluster --name "${CLUSTER}"
kubectl label node "${NODE}" gpu=on --overwrite

step "HAMi ${HAMI_VERSION} with the mock device plugin"
helm repo add hami-charts https://project-hami.github.io/HAMi/ >/dev/null 2>&1 || true
helm repo update hami-charts >/dev/null
helm upgrade --install hami hami-charts/hami -n kube-system --version "${HAMI_VERSION}" \
  --set devicePlugin.enabled=false \
  --set mockDevicePlugin.enabled=true \
  --set mockDevicePlugin.image.tag=latest \
  --wait --timeout 8m

step "Two fake NVIDIA A100-40GB cards on ${NODE}"
kubectl patch node "${NODE}" --subresource=status --type=json \
  -p '[{"op":"add","path":"/status/capacity/nvidia.com~1gpu","value":"20"}]' >/dev/null
kubectl annotate node "${NODE}" --overwrite "hami.io/node-nvidia-register=$(cat "$(dirname "$0")/fake-gpus.json")"

step "hami-mock-monitor (built from source, no published image yet)"
[ -d "${MONITOR_SRC}" ] || git clone https://github.com/fishman/hami-mock-monitor "${MONITOR_SRC}"
docker build -q -t hami-mock-monitor:dev "${MONITOR_SRC}"
kind load docker-image hami-mock-monitor:dev --name "${CLUSTER}"
helm upgrade --install hami-mock-monitor "${MONITOR_SRC}/charts/hami-mock-monitor" -n kube-system \
  --set image.repository=hami-mock-monitor --set image.tag=dev --set image.pullPolicy=IfNotPresent \
  --set completeBinds=true --wait

step "Waiting for the mock plugin to register memory and cores"
for _ in $(seq 1 30); do
  mem=$(kubectl get node "${NODE}" -o jsonpath='{.status.allocatable.nvidia\.com/gpumem}')
  [ -n "${mem}" ] && break
  sleep 5
done
kubectl get node "${NODE}" -o json | jq '.status.allocatable|with_entries(select(.key|test("nvidia.com")))'
echo "Expect gpu=20, gpumem=81920, gpucores=200. Ready for Lab 2."
