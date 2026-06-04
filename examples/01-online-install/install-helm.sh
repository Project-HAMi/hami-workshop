#!/usr/bin/env bash
# Lab 1, Step 2: Install Helm.
# Run as root on the VM (sudo su -).
set -euo pipefail

curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3
chmod 700 get_helm.sh
./get_helm.sh

helm version
