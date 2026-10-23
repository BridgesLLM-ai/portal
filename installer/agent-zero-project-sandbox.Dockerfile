ARG A0_BASE_IMAGE=agent0ai/agent-zero@sha256:307a2ceffc8501ba05a1e7253e8b6e4d656d2e1c3b97f0eb943c18b9c40a30fd
FROM ${A0_BASE_IMAGE}

ARG A0_BASE_IMAGE
ARG PORTAL_RECIPE_SHA256
ARG A0_SOURCE_COMMIT
ARG A0_UPSTREAM_DIGEST

LABEL com.bridgesllm.agent-zero-project.recipe-sha256="${PORTAL_RECIPE_SHA256}" \
      com.bridgesllm.agent-zero-project.source-commit="${A0_SOURCE_COMMIT}" \
      com.bridgesllm.agent-zero-project.upstream-digest="${A0_UPSTREAM_DIGEST}" \
      com.bridgesllm.agent-zero-project.runtime-user="1000:1000"

# Agent Zero's upstream image populates /a0 at container startup and launches a
# root-managed multi-process stack. Project Chat instead materializes the exact
# audited source during this immutable build and launches only the UI/connector
# process as the same numeric identity that owns Portal projects on the host.
RUN test "${A0_BASE_IMAGE}" = "agent0ai/agent-zero@${A0_UPSTREAM_DIGEST}" \
  && { \
       test "${A0_UPSTREAM_DIGEST}" = "sha256:307a2ceffc8501ba05a1e7253e8b6e4d656d2e1c3b97f0eb943c18b9c40a30fd" \
         || test "${A0_UPSTREAM_DIGEST}" = "sha256:3b048a33c8698d396688ebd05096daab1f441cf310f299db2ed808a00433bc13"; \
     } \
  && test "${A0_SOURCE_COMMIT}" = "ff2a5b9c9c4e490ba38dd7c313e779510bb2071a" \
  && printf '%s\n' "${PORTAL_RECIPE_SHA256}" | grep -Eq '^[a-f0-9]{64}$' \
  && test "$(git -C /git/agent-zero rev-parse HEAD)" = "${A0_SOURCE_COMMIT}" \
  && test -x /opt/venv-a0/bin/python \
  && test -f /git/agent-zero/run_ui.py \
  && test -f /git/agent-zero/plugins/_a0_connector/api/v1/capabilities.py \
  && test -f /git/agent-zero/plugins/_a0_connector/api/ws_connector.py \
  && rm -rf /a0 \
  && install -d -m 0755 /a0 \
  && cp -a /git/agent-zero/. /a0/ \
  && git config --system --add safe.directory /a0 \
  && install -d -m 0755 /a0/usr/projects /a0/usr/knowledge/main /a0/usr/knowledge/solutions \
  && for seed_dir in \
       /a0/usr/agents \
       /a0/usr/knowledge \
       /a0/usr/knowledge/main \
       /a0/usr/knowledge/solutions \
       /a0/usr/plugins \
       /a0/usr/projects \
       /a0/usr/skills \
       /a0/usr/workdir; do \
       test -d "${seed_dir}" && test ! -L "${seed_dir}"; \
     done \
  && if ! getent group 1000 >/dev/null; then groupadd --gid 1000 project-agent; fi \
  && if getent passwd 1000 >/dev/null; then \
       usermod --gid 1000 --home /a0/usr/home --shell /bin/bash "$(getent passwd 1000 | cut -d: -f1)"; \
     else \
       useradd --uid 1000 --gid 1000 --home-dir /a0/usr/home --shell /bin/bash project-agent; \
     fi \
  && install -d -m 0755 -o 1000 -g 1000 \
       /a0/usr /a0/usr/home /a0/usr/home/.cache /a0/usr/home/.config \
       /a0/usr/home/.local/share /a0/usr/projects /a0/tmp \
  && chown -R 1000:1000 /a0/usr /a0/tmp \
  && for runtime_dir in \
       /a0/usr \
       /a0/usr/agents \
       /a0/usr/home \
       /a0/usr/home/.cache \
       /a0/usr/home/.config \
       /a0/usr/home/.local/share \
       /a0/usr/knowledge \
       /a0/usr/knowledge/main \
       /a0/usr/knowledge/solutions \
       /a0/usr/plugins \
       /a0/usr/projects \
       /a0/usr/skills \
       /a0/usr/workdir \
       /a0/tmp; do \
       test -d "${runtime_dir}" \
         && test ! -L "${runtime_dir}" \
         && test "$(stat -c '%u:%g' "${runtime_dir}")" = "1000:1000"; \
     done \
  && test -d /a0/.git \
  && test "$(git -C /a0 rev-parse HEAD)" = "${A0_SOURCE_COMMIT}" \
  && test "$(stat -c '%u:%g' /a0/.git)" = "0:0"

ENV HOME=/a0/usr/home \
    XDG_CACHE_HOME=/a0/usr/home/.cache \
    XDG_CONFIG_HOME=/a0/usr/home/.config \
    XDG_DATA_HOME=/a0/usr/home/.local/share \
    TMPDIR=/a0/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    A0_PROJECT_SANDBOX=1

USER 1000:1000
WORKDIR /a0
ENTRYPOINT []
CMD ["/opt/venv-a0/bin/python", "/a0/run_ui.py", "--dockerized=true", "--port=80", "--host=0.0.0.0"]
