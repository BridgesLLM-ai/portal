FROM node:22.22.3-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3 AS release-dependencies

ARG SOURCE_DATE_EPOCH

# Dependency lifecycle code receives only the two committed package manifests
# and locks.  The exact source is introduced in a later stage and is therefore
# unreadable, not merely unwritable, during npm ci.
USER root
COPY --chown=0:0 backend/package.json backend/package-lock.json /dependency-locks/backend/
COPY --chown=0:0 frontend/package.json frontend/package-lock.json /dependency-locks/frontend/
RUN --network=none set -eux; \
    test -n "${SOURCE_DATE_EPOCH}"; \
    test "$(/usr/local/bin/node --version)" = "v22.22.3"; \
    test "$(/usr/local/bin/npm --version)" = "10.9.8"; \
    test "$(/usr/bin/python3 --version)" = "Python 3.11.2"; \
    test "$(/usr/bin/make --version | /usr/bin/head -n 1)" = "GNU Make 4.3"; \
    test "$(/usr/bin/g++ --version | /usr/bin/head -n 1)" = "g++ (Debian 12.2.0-14+deb12u1) 12.2.0"; \
    install -d -o node -g node -m 0700 \
      /deps /deps/backend /deps/frontend \
      /npm-cache /npm-cache/backend /npm-cache/frontend; \
    install -d -o node -g node -m 0700 \
      /deps/backend/.release-home /deps/frontend/.release-home; \
    install -o root -g root -m 0444 \
      /dependency-locks/backend/package.json /deps/backend/package.json; \
    install -o root -g root -m 0444 \
      /dependency-locks/backend/package-lock.json /deps/backend/package-lock.json; \
    install -o root -g root -m 0444 \
      /dependency-locks/frontend/package.json /deps/frontend/package.json; \
    install -o root -g root -m 0444 \
      /dependency-locks/frontend/package-lock.json /deps/frontend/package-lock.json

# Lifecycle scripts run only here, as the unprivileged node user, with no host
# mount, no signing key, and no writable committed source.  This layer exits
# before any trusted attestation begins.
USER node
RUN set -eux; \
    /usr/bin/env -i \
      HOME=/deps/backend/.release-home \
      PATH=/usr/local/bin:/usr/bin:/bin \
      SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
      NPM_CONFIG_CACHE=/npm-cache/backend \
      NPM_CONFIG_AUDIT=false \
      NPM_CONFIG_FUND=false \
      NPM_CONFIG_UPDATE_NOTIFIER=false \
      NPM_CONFIG_PROGRESS=false \
      /usr/local/bin/npm --prefix /deps/backend ci \
        --include=dev --include=optional --include=peer \
        --install-strategy=hoisted --ignore-scripts=false \
        --package-lock=true --bin-links=true --global=false --dry-run=false \
        --no-audit --no-fund; \
    /usr/bin/env -i \
      HOME=/deps/frontend/.release-home \
      PATH=/usr/local/bin:/usr/bin:/bin \
      SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
      NPM_CONFIG_CACHE=/npm-cache/frontend \
      NPM_CONFIG_AUDIT=false \
      NPM_CONFIG_FUND=false \
      NPM_CONFIG_UPDATE_NOTIFIER=false \
      NPM_CONFIG_PROGRESS=false \
      /usr/local/bin/npm --prefix /deps/frontend ci \
        --include=dev --include=optional --include=peer \
        --install-strategy=hoisted --ignore-scripts=false \
        --package-lock=true --bin-links=true --global=false --dry-run=false \
        --no-audit --no-fund; \
    /usr/bin/env -i HOME=/deps/backend/.release-home PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/npm --prefix /deps/backend ls --all --json \
        --include=dev --include=optional --include=peer \
        > /deps/backend-npm-tree.raw.json; \
    /usr/bin/env -i HOME=/deps/frontend/.release-home PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/npm --prefix /deps/frontend ls --all --json \
        --include=dev --include=optional --include=peer \
        > /deps/frontend-npm-tree.raw.json

# The Prisma schema engine attested in the dependency stage links libssl.so.3.
# Keep the compiler on the matching full Bookworm image: slim lacks that shared
# library and makes Prisma fall back to a forbidden engine download.
FROM node:22.22.3-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3 AS release-build

ARG SOURCE_DATE_EPOCH

USER root
COPY --chown=0:0 scripts/validation/release-node-tree-manifest.mjs /usr/local/libexec/release-node-tree-manifest.mjs
COPY --chown=0:0 backend /release-source/backend
COPY --chown=0:0 frontend /release-source/frontend

# The lifecycle stage is now dead.  Root freezes its output, attests every
# dependency byte/mode/symlink, and introduces a read-only exact-source build
# tree. Within /build, only the two dist directories are writable by compilers.
# Copy the read-only lifecycle output in the same layer that seals it. A COPY
# in the preceding layer makes chown/chmod copy every dependency up through
# overlayfs again, causing long fsync stalls on otherwise healthy build hosts.
# Materialize hard links as independent files, matching COPY and the attestor.
USER root
RUN --network=none --mount=type=bind,from=release-dependencies,source=/deps,target=/release-dependency-input,readonly set -eux; \
    test -n "${SOURCE_DATE_EPOCH}"; \
    test "$(/usr/local/bin/node --version)" = "v22.22.3"; \
    test ! -e /deps; \
    cp -a --no-preserve=links /release-dependency-input /deps; \
    chmod 0555 /usr/local/libexec/release-node-tree-manifest.mjs; \
    chmod -R a-w /release-source; \
    install -d -o root -g root -m 0700 /attestations /build /out; \
    chown -R root:root /deps; \
    chmod -R a-w /deps; \
    /usr/bin/find /deps -type d -exec chmod 0555 '{}' +; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        manifest /deps/backend/node_modules backend-node-modules \
        > /attestations/backend-node-modules.before.manifest; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        manifest /deps/frontend/node_modules frontend-node-modules \
        > /attestations/frontend-node-modules.before.manifest; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        normalize-npm-tree /deps/backend-npm-tree.raw.json backend \
        > /attestations/backend-npm-tree.json; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        normalize-npm-tree /deps/frontend-npm-tree.raw.json frontend \
        > /attestations/frontend-npm-tree.json; \
    cp -a /release-source/backend /build/backend; \
    cp -a /release-source/frontend /build/frontend; \
    chmod -R a-w /build; \
    chmod 0555 /build; \
    # Prisma's client types are generated from the exact, read-only schema
    # during compilation.  Give that generator a write-only overlay for its
    # derived `.prisma` output while every installed dependency remains an
    # immutable symlink into the attested `/deps` tree.  The overlay is not
    # exported in the release image; the installed runtime regenerates its
    # client from the signed schema independently.
    install -d -o root -g root -m 0755 /build/backend/node_modules; \
    /usr/bin/find /deps/backend/node_modules -mindepth 1 -maxdepth 1 \
      ! -name .prisma ! -name @prisma \
      -exec /usr/bin/ln -s '{}' /build/backend/node_modules/ ';'; \
    install -d -o root -g root -m 0755 /build/backend/node_modules/@prisma; \
    /usr/bin/find /deps/backend/node_modules/@prisma -mindepth 1 -maxdepth 1 \
      ! -name client -exec /usr/bin/ln -s '{}' /build/backend/node_modules/@prisma/ ';'; \
    cp -a /deps/backend/node_modules/@prisma/client \
      /build/backend/node_modules/@prisma/client; \
    chown -R root:root /build/backend/node_modules/@prisma/client; \
    chmod -R a-w /build/backend/node_modules/@prisma/client; \
    /usr/bin/find /build/backend/node_modules/@prisma/client -type d \
      -exec chmod 0555 '{}' +; \
    install -d -o node -g node -m 0755 /build/backend/node_modules/.prisma; \
    ln -s /deps/frontend/node_modules /build/frontend/node_modules; \
    install -d -o node -g node -m 0755 /build/backend/dist /build/frontend/dist

# Dependency-controlled compilers execute alone and unprivileged.  They can
# write output, but cannot modify source, dependencies, attestations, or keys.
USER node
RUN --network=none set -eux; \
    /usr/bin/env -i \
      HOME=/nonexistent-release-home \
      PATH=/usr/local/bin:/usr/bin:/bin \
      SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
      VITE_API_URL=/api VITE_WS_URL= VITE_USE_DIRECT_GATEWAY= \
      /usr/local/bin/npm --prefix /build/frontend --ignore-scripts=false run build; \
    /usr/bin/find /build/frontend/dist -type f -exec chmod 0644 '{}' +; \
    /usr/bin/env -i \
      HOME=/nonexistent-release-home \
      PATH=/usr/local/bin:/usr/bin:/bin \
      SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
      PRISMA_SCHEMA_ENGINE_BINARY=/deps/backend/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x \
      /bin/bash -c 'cd /build/backend && exec ./node_modules/.bin/prisma generate'; \
    /usr/bin/env -i \
      HOME=/nonexistent-release-home \
      PATH=/usr/local/bin:/usr/bin:/bin \
      SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
      /usr/local/bin/npm --prefix /build/backend --ignore-scripts=false run build; \
    /usr/bin/find /build/backend/dist -type f -exec chmod 0644 '{}' +

# The compiler layer has exited, so no untrusted process can race the trusted
# O_NOFOLLOW/fstat attestor.  Root re-attests dependencies before exporting only
# compiled outputs and attestations into the scratch image.
USER root
RUN --network=none set -eux; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        manifest /deps/backend/node_modules backend-node-modules \
        > /attestations/backend-node-modules.after.manifest; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        manifest /deps/frontend/node_modules frontend-node-modules \
        > /attestations/frontend-node-modules.after.manifest; \
    /usr/bin/cmp /attestations/backend-node-modules.before.manifest \
      /attestations/backend-node-modules.after.manifest; \
    /usr/bin/cmp /attestations/frontend-node-modules.before.manifest \
      /attestations/frontend-node-modules.after.manifest; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        manifest /build/backend/dist backend-dist \
        > /attestations/backend-dist.manifest; \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/node /usr/local/libexec/release-node-tree-manifest.mjs \
        manifest /build/frontend/dist frontend-dist \
        > /attestations/frontend-dist.manifest; \
    install -d -o root -g root -m 0755 /out/backend /out/frontend; \
    cp -a /build/backend/dist /out/backend/dist; \
    cp -a /build/frontend/dist /out/frontend/dist; \
    cp -a /attestations /out/attestations; \
    chown -R root:root /out

FROM scratch AS release-output
COPY --from=release-build /out/backend /backend
COPY --from=release-build /out/frontend /frontend
COPY --from=release-build /out/attestations /attestations
CMD ["/nonexistent-release-output"]
