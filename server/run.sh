#!/bin/bash
set -eu
cd /home/kit/portfolio
node --check server/index.cjs
while true; do
  if NODE_ENV=production node server/index.cjs; then status=0; else status=$?; fi
  echo "Portfolio exited ($status), retrying in 3 seconds"
  sleep 3
done
