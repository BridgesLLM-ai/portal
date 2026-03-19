# GitHub / Release SOP

This is the standard operating procedure for BridgesLLM Portal public publishing.

## Repos and Roles

### 1) Product source repo
- Path: `/root/bridgesllm-product`
- Purpose: real working source tree
- Contains active development, local build scripts, release logic
- **Do not push this repo directly to public GitHub** without a clean export pass

### 2) Marketing repo
- Path: `/root/bridgesllm-marketing`
- Purpose: static website + release file hosting assets
- Should be its **own standalone git repo**
- Must not inherit `/root/.git`

### 3) Public GitHub repo
- Repo: `BridgesLLM-ai/portal`
- Purpose: public-facing source, README, releases, issues, discussions
- Must only receive sanitized/public-safe source

---

## Release Workflow

1. Make code changes in `/root/bridgesllm-product`
2. Commit in product repo
3. Build release tarball:
   ```bash
   cd /root/bridgesllm-product
   bash scripts/build-release.sh
   ```
4. Verify marketing/site assets updated:
   - `bridgesllm-marketing/dist/install.sh`
   - `bridgesllm-marketing/dist/portal.tar.gz`
   - `bridgesllm-marketing/dist/og-image.png`
5. Export sanitized public source:
   ```bash
   cd /root/bridgesllm-product
   bash scripts/export-public-github.sh
   ```
6. Review export before push
7. Push public-safe source to GitHub
8. Verify:
   - repo homepage
   - README banner
   - release assets
   - `bridgesllm.ai` links
   - install command works

---

## Safety Rules

Never publish these to public GitHub:
- `.env*`
- `backend/.ssh/*`
- user avatars / branding uploads
- local database files
- user projects / uploads
- machine-specific secrets / tokens / private keys

If unsure, export to a temp repo first and inspect it.

---

## Ops Rhythm (after marketing starts)

### Low traffic
- Check GitHub + portal email **2–3 times/day**
- Send Robert one concise traction summary daily

### Medium traffic
- Check **morning / afternoon / night**
- Escalate bugs and install failures same day

### Launch window / heavy traffic
- Check roughly **hourly** while active
- Watch install failures, GitHub issues, release errors, telemetry spikes

---

## What to Report to Robert

For each check-in:
- installs/downloads trend
- new GitHub issues/discussions
- new portal emails
- top breakages / repeated complaints
- urgent security or installer failures

Keep it short. Numbers first, then blockers.

---

## Immediate Cleanup Tasks

- Keep `/root/bridgesllm-marketing` as a standalone git repo
- Stop committing marketing changes through `/root/.git`
- Use public export workflow for `BridgesLLM-ai/portal`
- Avoid direct blind pushes from live working tree
