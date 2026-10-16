#!/bin/sh
# Launcher for the coturn TURN server, shared by docker-compose.yml and
# docker-compose-ssl.yml so the security-relevant flags cannot drift between the two
# deployment topologies. Add or change flags here, once.
#
# The static auth secret is read from the shared keys volume provisioned by the `init`
# service. coturn runs as the image's default unprivileged user (nobody).
set -eu

secret="$(cat /keys/secret)"

exec turnserver \
  --fingerprint \
  --use-auth-secret \
  --no-multicast-peers \
  --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 \
  --denied-peer-ip=100.64.0.0-100.127.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 \
  --denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --no-cli \
  --realm=filesync.app \
  --static-auth-secret="$secret" \
  --listening-port=3478 \
  --min-port=50000 \
  --max-port=50100
