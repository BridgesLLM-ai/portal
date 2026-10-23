# Desktop toolchain for Linux Desktop Projects (Python, TypeScript, Rust, C++).
# The installer builds this locally FROM the recorded Project runtime image and
# admits the result by recipe fingerprint, base layers and recorded image ID.
# Downloads are pinned by upstream SHA-256; nothing here is fetched at run time.
ARG DESKTOP_BASE_IMAGE=bridgesllm-project-runtime:bookworm-node22
FROM ${DESKTOP_BASE_IMAGE}
USER 0:0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake curl git pkg-config unzip xz-utils \
    python3 python3-pip python3-venv python3-tk libpython3.11 \
    qt6-base-dev \
    libx11-dev libxi-dev libxcursor-dev libxrandr-dev libxinerama-dev \
    libgl1-mesa-dev libegl1 libxkbcommon0 libxkbcommon-x11-0 \
    libgtk-3-0 libnss3 libasound2 libxss1 libgbm1 \
  && rm -rf /var/lib/apt/lists/*
ARG RUST_VERSION=1.90.0
ARG RUST_SHA256=bff8974f2d3ee6c0e6ac926b533f65bbdd3697d2c2b925bdae5f45b9eed10a67
RUN curl -fsSLo /tmp/rust.tar.xz "https://static.rust-lang.org/dist/rust-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz" \
  && echo "${RUST_SHA256}  /tmp/rust.tar.xz" | sha256sum -c - \
  && mkdir /tmp/rust && tar -xf /tmp/rust.tar.xz -C /tmp/rust --strip-components=1 \
  && /tmp/rust/install.sh --prefix=/opt/desktop-rust \
    --components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu --disable-ldconfig >/dev/null \
  && rm -rf /tmp/rust /tmp/rust.tar.xz
ENV PATH=/opt/desktop-rust/bin:$PATH
ARG ELECTRON_VERSION=44.9.0
ARG ELECTRON_SHA256=ecced7ecb55697f92ca870939c5988557faa8acd8c222c232cae5913d318c8b9
RUN curl -fsSLo /tmp/electron.zip "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip" \
  && echo "${ELECTRON_SHA256}  /tmp/electron.zip" | sha256sum -c - \
  && mkdir -p /opt/desktop-runtime/electron \
  && unzip -q /tmp/electron.zip -d /opt/desktop-runtime/electron \
  && rm /tmp/electron.zip
COPY assemble-runtime.py /tmp/assemble-runtime.py
RUN python3 -I /tmp/assemble-runtime.py && rm /tmp/assemble-runtime.py
# Warm dependency caches for the built-in starters. Brokered builds start from
# these and fetch anything else through the Project egress proxy; offline
# builds can use nothing else.
COPY seed-inputs /tmp/desktop-seed-inputs
RUN set -eu; seed=/opt/desktop-seed; mkdir -p "$seed/npm" "$seed/cargo-home" "$seed/wheels"; \
  for starter in typescript-terminal typescript-gui; do \
    cp -r "/tmp/desktop-seed-inputs/$starter" "/tmp/seed-$starter"; \
    (cd "/tmp/seed-$starter" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund --cache "$seed/npm" >/dev/null); \
    rm -rf "/tmp/seed-$starter"; \
  done; \
  for starter in rust-terminal rust-gui; do \
    cp -r "/tmp/desktop-seed-inputs/$starter" "/tmp/seed-$starter"; mkdir -p "/tmp/seed-$starter/src"; \
    echo 'fn main() {}' > "/tmp/seed-$starter/src/main.rs"; \
    (cd "/tmp/seed-$starter" && CARGO_HOME="$seed/cargo-home" cargo fetch --locked >/dev/null); \
    rm -rf "/tmp/seed-$starter"; \
  done; \
  rm -rf "$seed/cargo-home/registry/src" "$seed/cargo-home/.package-cache"; \
  python3 -m pip download --no-cache-dir --disable-pip-version-check --dest "$seed/wheels" pyinstaller==6.16.0 >/dev/null; \
  rm -rf /tmp/desktop-seed-inputs /root/.npm /root/.cache; \
  find "$seed" /opt/desktop-runtime -type d -exec chmod 755 {} +; \
  find "$seed" /opt/desktop-runtime -type f -exec chmod a+r,go-w,u-s,g-s {} +
# Declared last so a fingerprint change re-labels without invalidating build layers.
ARG DESKTOP_RECIPE_SHA256
LABEL com.bridgesllm.desktop-toolchain.role="desktop-toolchain-v1" \
  com.bridgesllm.desktop-toolchain.recipe-sha256="${DESKTOP_RECIPE_SHA256}" \
  com.bridgesllm.desktop-toolchain.electron-sha256="${ELECTRON_SHA256}"
USER 1000:1000
WORKDIR /workspace/project
ENTRYPOINT []
CMD ["node", "--version"]
