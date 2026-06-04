#!/usr/bin/env bash
# Lab 1, Step 4: Install Prometheus (kube-prometheus-stack).
# Run as root on the VM (sudo su -).
set -euo pipefail

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# serviceMonitorSelectorNilUsesHelmValues=false lets Prometheus pick up the
# GPU Operator's dcgm-exporter ServiceMonitor (it lacks the release label).
helm install prometheus prometheus-community/kube-prometheus-stack \
    -n monitoring --create-namespace \
    --set grafana.enabled=false \
    --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
    --version=75.15.1

kubectl get po -n monitoring
