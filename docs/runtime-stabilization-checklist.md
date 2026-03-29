# Runtime Stabilization / Adapter Validation Checklist

## Local verification
- [ ] Backend type-check passes (`/root/bridgesllm-dev/run.sh "cd /portal/backend && npm run type-check"`)
- [ ] Backend tests pass (`/root/bridgesllm-dev/run.sh "cd /portal/backend && npm test -- --runInBand"`)
- [ ] Frontend type-check passes (`/root/bridgesllm-dev/run.sh "cd /portal/frontend && npm run type-check"`)
- [ ] Provider capability endpoint exposes adapter + follow-up metadata
- [ ] OpenClaw active-turn send injects live FYI / steer instead of queueing
- [ ] Native CLI providers still queue follow-ups while a run is active

## Test box smoke
- [ ] Build release tarball (`/root/bridgesllm-dev/run.sh "build-release"`)
- [ ] Deploy update to test box (`ssh root@31.97.141.228 "curl -fsSL https://bridgesllm.ai/install.sh -o /tmp/install.sh && bash /tmp/install.sh --update"`)
- [ ] Portal loads at https://bridgesquestions.com
- [ ] Agent chat loads with OpenClaw selected
- [ ] OpenClaw running turn accepts live steer/FYI and shows confirmation in UI
- [ ] Claude/Codex/Gemini show queued-follow-up semantics in UI metadata
- [ ] Logs are clean enough for release consideration (`journalctl -u bridgesllm-product --since '10 min ago' --no-pager | tail -50`)
