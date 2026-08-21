#!/bin/sh
curl -X POST https://opencode.ai/zen/go/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "input": "Hello from proxy!"
  }'
