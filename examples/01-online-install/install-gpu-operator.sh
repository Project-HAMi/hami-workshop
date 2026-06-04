#!/usr/bin/env bash
# Lab 1, Step 5: Install the NVIDIA GPU Operator.
# Run as root on the VM (sudo su -).
set -euo pipefail

helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# devicePlugin.enabled=false because HAMi ships its own device plugin.
helm install --wait --generate-name \
    -n gpu-operator --create-namespace \
    nvidia/gpu-operator \
    --set devicePlugin.enabled=false \
    --set dcgmExporter.serviceMonitor.enabled=true \
    --version=v25.3.0

kubectl get pods -n gpu-operator
