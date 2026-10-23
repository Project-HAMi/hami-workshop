#!/usr/bin/env bash
# Lab 3: read HAMi metrics through the API server proxy (no port-forward needed).
#   ./metrics.sh scheduler   # allocation: what HAMi reserved (port 9395)
#   ./metrics.sh monitor     # usage: what containers use (port 9394, hami-mock-monitor here)
set -euo pipefail
case "${1:-scheduler}" in
  scheduler) sel=app.kubernetes.io/component=hami-scheduler; port=9395 ;;
  monitor)   sel=app.kubernetes.io/name=hami-mock-monitor;   port=9394 ;;
  *) echo "usage: $0 scheduler|monitor" >&2; exit 2 ;;
esac
pod=$(kubectl -n kube-system get pod -l "${sel}" -o jsonpath='{.items[0].metadata.name}')
kubectl get --raw "/api/v1/namespaces/kube-system/pods/${pod}:${port}/proxy/metrics" | grep '^hami_' | grep -v '^hami_build_info'
