#!/usr/bin/env bash
# Lab 1, Step 6: Install HAMi and enable the GPU node.
# Run as root on the VM (sudo su -).
set -euo pipefail

helm repo add hami-charts https://project-hami.github.io/HAMi/
helm repo update

helm install hami hami-charts/hami -n kube-system --version 2.9.0

kubectl get pods -n kube-system | grep hami

# Label the node so HAMi manages its GPU
NODE_NAME=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
kubectl label nodes ${NODE_NAME} gpu=on

# Verify GPU registration (wait a few seconds for the device plugin)
sleep 10
kubectl get node ${NODE_NAME} -o jsonpath='{.metadata.annotations.hami\.io/node-nvidia-register}'
