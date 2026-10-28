import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const bash =
  process.env.BASH_PATH ??
  (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const secretNames = [
  "POSTGRES_PASSWORD",
  "POSTGRES_APP_PASSWORD",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SCREEN_PROXY_SECRET",
  "SANDBOX_SUPERVISOR_TOKEN",
];

function fixture(context, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-deploy-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "docs", "deploy");
  const binaryDirectory = path.join(root, "bin");
  mkdirSync(directory, { recursive: true });
  mkdirSync(binaryDirectory);
  mkdirSync(path.join(root, "infra", "compose"), { recursive: true });
  mkdirSync(path.join(root, "infra", "sandboxes", "computer"), { recursive: true });
  for (const filename of [
    "deploy.sh",
    ".env.example",
    "docker-compose.yml",
    "docker-compose.source.yml",
  ]) {
    copyFileSync(path.join(deployDirectory, filename), path.join(directory, filename));
  }
  for (const filename of [
    ".dockerignore",
    "infra/compose/Dockerfile",
    "infra/sandboxes/computer/Dockerfile",
  ]) {
    copyFileSync(path.join(deployDirectory, "../..", filename), path.join(root, filename));
  }
  copyFileSync(
    path.join(deployDirectory, "../../infra/compose/docker-compose.images.yml"),
    path.join(root, "infra/compose/docker-compose.images.yml"),
  );
  writeFileSync(
    path.join(binaryDirectory, "docker"),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$DOCKER_CALLS"
if [[ "$1" == version ]]; then
  printf '%s\\n' '26.1.0'
elif [[ "$1" == compose && "$2" == version ]]; then
  printf '%s\\n' "\${FAKE_COMPOSE_VERSION:-2.24.4}"
elif [[ "$*" == *' config --images api' ]]; then
  [[ "$*" != *'docker-compose.images.yml'* ]] || exit 1
  printf '%s\\n' 'rakazo-server/app:local'
elif [[ "$*" == *' config --images computer' ]]; then
  [[ "$*" != *'docker-compose.images.yml'* ]] || exit 1
  printf '%s\\n' 'rakazo-server/computer:local'
elif [[ "$1" == build ]]; then
  [[ "\${FAKE_BUILD_FAIL:-0}" != 1 ]] || exit 1
  if [[ "$2" == --file ]]; then
    cmp "$3" "$FAKE_ROOT/infra/compose/Dockerfile"
    grep -Fxq 'docs/deploy/backups' "$3.dockerignore"
    grep -Fxq '**/.env' "$3.dockerignore"
  fi
elif [[ "$*" == *' pull'* && "\${FAKE_PULL_FAIL:-0}" == 1 ]]; then
  exit 1
elif [[ "$*" == *' exec -T postgres sh -c '* ]]; then
  [[ "\${FAKE_DUMP_FAIL:-0}" != 1 ]] || exit 1
  printf '%s\\n' 'offline-database-dump'
elif [[ "$*" == *' run --rm --no-deps -T --entrypoint tar data-init -czf - -C /data .' ]]; then
  tar -czf - --files-from /dev/null
elif [[ "$*" == *' exec -T postgres pg_restore --list' ]]; then
  cat >/dev/null
fi
`,
    { mode: 0o755 },
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  environment.PATH = [
    binaryDirectory,
    ...(process.platform === "win32"
      ? ["C:/Program Files/Git/usr/bin", "C:/Program Files/Git/bin"]
      : []),
    process.env.PATH ?? "",
  ].join(path.delimiter);
  environment.DOCKER_CALLS = path.join(root, "docker-calls").replaceAll("\\", "/");
  environment.FAKE_COMPOSE_VERSION = options.composeVersion ?? "2.24.4";
  environment.FAKE_PULL_FAIL = options.pullFailure ? "1" : "0";
  environment.FAKE_DUMP_FAIL = options.dumpFailure ? "1" : "0";
  environment.FAKE_BUILD_FAIL = options.buildFailure ? "1" : "0";
  environment.FAKE_ROOT = root.replaceAll("\\", "/");
  return {
    directory,
    root,
    run(...arguments_) {
      return spawnSync(
        bash,
        [path.join(directory, "deploy.sh").replaceAll("\\", "/"), ...arguments_],
        { env: environment, encoding: "utf8" },
      );
    },
    calls() {
      return existsSync(environment.DOCKER_CALLS)
        ? readFileSync(environment.DOCKER_CALLS, "utf8")
        : "";
    },
  };
}

test("Bash syntax is valid", () => {
  const result = spawnSync(
    bash,
    ["-n", path.join(deployDirectory, "deploy.sh").replaceAll("\\", "/")],
    { encoding: "utf8" },
  );
  assert.ok(result.status === 0, "Bash syntax validation failed");
});

test("Nginx example forwards HTTPS, streaming and WebSocket traffic to loopback", () => {
  const configuration = readFileSync(path.join(deployDirectory, "nginx.conf.example"), "utf8");
  for (const directive of [
    "listen 443 ssl;",
    "ssl_certificate /etc/nginx/tls/fullchain.pem;",
    "ssl_certificate_key /etc/nginx/tls/privkey.pem;",
    "proxy_pass http://127.0.0.1:5173;",
    "proxy_http_version 1.1;",
    "proxy_set_header Host $host;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_set_header Upgrade $http_upgrade;",
    "proxy_set_header Connection $rakazo_connection_upgrade;",
    "proxy_buffering off;",
    "proxy_request_buffering off;",
    "proxy_cache off;",
  ]) {
    assert.ok(configuration.includes(directive), `Nginx must include ${directive}`);
  }
  assert.ok(configuration.includes("map $http_upgrade $rakazo_connection_upgrade {"));
  assert.ok(configuration.includes("'' close;"));
  assert.ok(configuration.includes("return 308 https://app.example.com$request_uri;"));
});

test("init creates matching origins and independent secrets without logging them", (context) => {
  const deployment = fixture(context);
  const result = deployment.run("init", "--host", "127.0.0.1", "--port", "55173");
  assert.ok(result.status === 0, "init must succeed");
  const filename = path.join(deployment.directory, ".env");
  const values = parseEnv(readFileSync(filename, "utf8"));
  assert.ok(values.RAKAZO_HOST === "127.0.0.1");
  assert.ok(values.RAKAZO_BIND_ADDRESS === "127.0.0.1");
  assert.ok(values.RAKAZO_WEB_PORT === "55173");
  for (const name of ["BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL"]) {
    assert.ok(values[name] === "http://127.0.0.1:55173", "public origins must match");
  }
  for (const name of secretNames) {
    const length = name.startsWith("POSTGRES_") ? 32 : 64;
    assert.ok(new RegExp(`^[a-f0-9]{${length}}$`).test(values[name]), "secret shape must be valid");
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes(values[name]),
      "secrets must not reach logs",
    );
  }
  assert.ok(
    new Set(secretNames.map((name) => values[name])).size === secretNames.length,
    "secrets must be independent",
  );
  assert.ok(values.SIGNUPS_ENABLED === "false");
  assert.ok(values.SANDBOX_COMPUTER_EGRESS === "restricted");
  assert.ok(
    Object.hasOwn(values, "OPENROUTER_API_KEY"),
    "optional model configuration must remain available",
  );
  if (process.platform !== "win32") assert.ok((statSync(filename).mode & 0o777) === 0o600);
  assert.ok(deployment.calls() === "", "init must not contact Docker");
});

test("init refuses to overwrite an existing environment", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  const filename = path.join(deployment.directory, ".env");
  const before = readFileSync(filename);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status !== 0);
  assert.ok(before.equals(readFileSync(filename)), "existing secrets must remain unchanged");
});

test("HTTPS init separates public origin from the backend bind address", (context) => {
  const deployment = fixture(context);
  const result = deployment.run(
    "init",
    "--host",
    "127.0.0.1",
    "--origin",
    "https://App.Example.com:443/",
  );
  assert.ok(result.status === 0, "HTTPS initialization must succeed");
  const values = parseEnv(readFileSync(path.join(deployment.directory, ".env"), "utf8"));
  assert.ok(values.RAKAZO_HOST === "app.example.com");
  assert.ok(values.RAKAZO_BIND_ADDRESS === "127.0.0.1");
  assert.ok(values.RAKAZO_WEB_PORT === "5173");
  for (const name of ["BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL"]) {
    assert.ok(values[name] === "https://app.example.com", "public HTTPS origins must match");
  }
});

test("init from-template generates credentials and preserves the original template", (context) => {
  const deployment = fixture(context);
  const filename = path.join(deployment.directory, ".env");
  const template = readFileSync(path.join(deployment.directory, ".env.example"), "utf8");
  writeFileSync(filename, template.replace(/\r?\n/g, "\r\n"));
  const original = readFileSync(filename);
  const result = deployment.run(
    "init",
    "--from-template",
    "--host",
    "127.0.0.1",
    "--origin",
    "https://app.example.com",
  );
  assert.ok(result.status === 0, "an untouched copied template must initialize successfully");
  const values = parseEnv(readFileSync(filename, "utf8"));
  for (const name of secretNames) {
    const length = name.startsWith("POSTGRES_") ? 32 : 64;
    assert.ok(
      new RegExp(`^[a-f0-9]{${length}}$`).test(values[name]),
      "copied template secrets must be generated",
    );
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes(values[name]),
      "generated secrets must not reach logs",
    );
  }
  const backups = readdirSync(deployment.directory).filter((name) =>
    name.startsWith(".env.before-init."),
  );
  assert.ok(backups.length === 1, "the original template must have exactly one backup");
  const backup = path.join(deployment.directory, backups[0]);
  assert.ok(original.equals(readFileSync(backup)), "the backup must preserve the original bytes");
  if (process.platform !== "win32") assert.ok((statSync(backup).mode & 0o777) === 0o600);
  assert.ok(deployment.calls() === "", "template initialization must not contact Docker");
});

test("init from-template never replaces credentials or customized configuration", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  const filename = path.join(deployment.directory, ".env");
  const original = readFileSync(filename);
  assert.ok(deployment.run("init", "--from-template", "--host", "127.0.0.1").status !== 0);
  assert.ok(original.equals(readFileSync(filename)), "existing credentials must remain unchanged");
  const template = readFileSync(path.join(deployment.directory, ".env.example"), "utf8");
  writeFileSync(filename, `${template}\nOPENROUTER_API_KEY=fake-test-key\n`);
  const customized = readFileSync(filename);
  assert.ok(deployment.run("init", "--from-template", "--host", "127.0.0.1").status !== 0);
  assert.ok(customized.equals(readFileSync(filename)), "customized values must remain unchanged");
});

test("HTTPS init rejects non-origin URLs and invalid hostnames", (context) => {
  const deployment = fixture(context);
  for (const origin of [
    "http://app.example.com",
    "https://user:fake-pass@app.example.com",
    "https://app.example.com/path",
    "https://app.example.com?key=fake",
    "https://app.example.com:65536",
    "https://app..example.com",
    "https://-app.example.com",
  ]) {
    assert.ok(
      deployment.run("init", "--host", "127.0.0.1", "--origin", origin).status !== 0,
      "invalid origins must fail",
    );
    assert.ok(!existsSync(path.join(deployment.directory, ".env")));
  }
});

test("init rejects public HTTP hosts, invalid addresses and invalid ports", (context) => {
  const deployment = fixture(context);
  for (const arguments_ of [
    ["--host", "203.0.113.10"],
    ["--host", "127.0.0.999"],
    ["--host", "localhost"],
    ["--host", "127.0.0.1", "--port", "65536"],
    ["--host", "127.0.0.1", "--port", "0"],
  ]) {
    assert.ok(
      deployment.run("init", ...arguments_).status !== 0,
      "invalid configuration must fail",
    );
    assert.ok(!existsSync(path.join(deployment.directory, ".env")));
  }
});

test("check validates configuration without pulling or starting services", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("check").status === 0);
  const calls = deployment.calls();
  assert.ok(calls.includes("config --quiet"));
  assert.ok(calls.includes("--project-name rakazo-server"));
  assert.ok(!calls.includes(" pull"));
  assert.ok(!calls.includes(" up"));
});

test("older Compose fails before configuration is evaluated", (context) => {
  const deployment = fixture(context, { composeVersion: "2.24.3" });
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("check").status !== 0);
  assert.ok(!deployment.calls().includes("config --quiet"));
});

test("up builds source images, pulls only dependencies and waits with a bounded timeout", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("up").status === 0);
  const calls = deployment.calls().split("\n");
  const builds = calls.flatMap((line, index) => (line.startsWith("build ") ? [index] : []));
  const pull = calls.findIndex((line) => line.endsWith(" pull postgres data-init"));
  const start = calls.findIndex((line) =>
    line.endsWith(" up -d --wait --wait-timeout 300 --pull never"),
  );
  assert.ok(builds.length === 2, "both source images must be built");
  assert.ok(builds[1] < pull && start > pull, "startup must follow builds and dependency pulls");
  assert.ok(
    !calls.some((line) => line.endsWith(" pull")),
    "source deployment must not pull application images",
  );
  assert.ok(
    !readdirSync(deployment.directory).some((name) => name.startsWith(".build.")),
    "temporary build files must be removed",
  );
});

test("build does not start services or pull published application images", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("build").status === 0);
  assert.ok(
    deployment
      .calls()
      .split("\n")
      .filter((line) => line.startsWith("build ")).length === 2,
  );
  assert.ok(!deployment.calls().includes(" up "));
  assert.ok(!deployment.calls().includes(" pull"));
});

test("a failed source build prevents deployment and removes temporary build files", (context) => {
  const deployment = fixture(context, { buildFailure: true });
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("up").status !== 0);
  assert.ok(!deployment.calls().includes(" up "));
  assert.ok(!deployment.calls().includes(" pull"));
  assert.ok(!readdirSync(deployment.directory).some((name) => name.startsWith(".build.")));
});

test("up-images explicitly preserves published image deployment", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("up-images").status === 0);
  const calls = deployment.calls();
  assert.ok(calls.split("\n").some((line) => line.endsWith(" pull")));
  assert.ok(!calls.includes("docker-compose.source.yml"));
  assert.ok(!calls.split("\n").some((line) => line.startsWith("build ")));
});

test("stop never deletes volumes and backup requires a computer shutdown acknowledgement", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("stop").status === 0);
  assert.ok(!deployment.calls().includes(" down"));
  assert.ok(deployment.run("backup").status !== 0);
  assert.ok(!existsSync(path.join(deployment.directory, "backups")));
});

test("a failed image pull prevents startup", (context) => {
  const deployment = fixture(context, { pullFailure: true });
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("up").status !== 0);
  assert.ok(!deployment.calls().includes(" up "));
});

test("backup archives application data and configuration without restarting writers", (context) => {
  const deployment = fixture(context);
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  const result = deployment.run("backup", "--computers-stopped");
  assert.ok(result.status === 0, "offline backup command must succeed");
  const calls = deployment.calls();
  assert.ok(
    calls.indexOf(" stop web worker api supervisor") < calls.indexOf(" exec -T postgres sh -c "),
  );
  assert.ok(calls.includes("run --rm --no-deps -T --entrypoint tar data-init"));
  assert.ok(calls.includes("pg_restore --list"));
  assert.ok(!calls.includes(" up "));
  const values = parseEnv(readFileSync(path.join(deployment.directory, ".env"), "utf8"));
  for (const name of secretNames) {
    assert.ok(
      !`${result.stdout}${result.stderr}${calls}`.includes(values[name]),
      "backup must not log secrets",
    );
  }
});

test("a failed database backup leaves services stopped and reports failure", (context) => {
  const deployment = fixture(context, { dumpFailure: true });
  assert.ok(deployment.run("init", "--host", "127.0.0.1").status === 0);
  assert.ok(deployment.run("backup", "--computers-stopped").status !== 0);
  assert.ok(deployment.calls().includes(" stop web worker api supervisor"));
  assert.ok(!deployment.calls().includes("run --rm"));
  assert.ok(!deployment.calls().includes(" up "));
});

for (const mode of ["source", "images"]) {
  test(`real Compose validates ${mode} images, private ports and stable data volumes`, {
    skip: !process.env.COMPOSE_PATH,
  }, (context) => {
    const deployment = fixture(context);
    assert.ok(deployment.run("init", "--host", "127.0.0.1", "--port", "55173").status === 0);
    const commonArguments = [
      "--project-directory",
      deployment.root,
      "--project-name",
      "rakazo-server",
      "--env-file",
      path.join(deployment.directory, ".env"),
    ];
    const arguments_ = [
      ...commonArguments,
      "-f",
      path.join(deployment.root, "infra/compose/docker-compose.images.yml"),
      "-f",
      path.join(deployment.directory, "docker-compose.yml"),
    ];
    if (mode === "source")
      arguments_.push("-f", path.join(deployment.directory, "docker-compose.source.yml"));
    const result = spawnSync(
      process.env.COMPOSE_PATH,
      [...arguments_, "config", "--format", "json"],
      { encoding: "utf8" },
    );
    assert.ok(result.status === 0, "real Compose must accept the merged configuration");
    const configuration = JSON.parse(result.stdout);
    assert.ok(configuration.name === "rakazo-server");
    const { api, web, postgres, supervisor, computer, migrate, worker } = configuration.services;
    assert.ok(!api.ports?.length, "API must not publish host ports");
    assert.ok(!postgres.ports?.length, "database must not publish host ports");
    assert.ok(!supervisor.ports?.length, "supervisor must not publish host ports");
    assert.ok(web.ports.length === 1, "exactly one web port must be published");
    assert.ok(web.ports[0].host_ip === "127.0.0.1");
    assert.ok(String(web.ports[0].published) === "55173");
    assert.ok(api.environment.BETTER_AUTH_URL === "http://127.0.0.1:55173");
    assert.ok(configuration.volumes.pgdata.name === "rakazo-server_pgdata");
    assert.ok(configuration.volumes.appdata.name === "rakazo-server_appdata");
    if (mode === "source") {
      for (const service of [api, web, supervisor, migrate, worker]) {
        assert.ok(
          service.image === "rakazo-server/app:local",
          "application services must share the source image",
        );
      }
      assert.ok(computer.image === "rakazo-server/computer:local");
      assert.ok(supervisor.environment.RAKAZO_COMPUTER_IMAGE === computer.image);
      for (const [serviceName, expectedImage] of Object.entries({
        api: api.image,
        computer: computer.image,
      })) {
        const image = spawnSync(
          process.env.COMPOSE_PATH,
          [
            ...commonArguments,
            "-f",
            path.join(deployment.directory, "docker-compose.source.yml"),
            "config",
            "--images",
            serviceName,
          ],
          { encoding: "utf8" },
        );
        assert.ok(
          image.status === 0 && image.stdout.trim() === expectedImage,
          "source image lookup must return exactly one service image",
        );
      }
    } else {
      assert.ok(api.image === "ghcr.io/elie222/rakazo/app:edge");
      assert.ok(computer.image === "ghcr.io/elie222/rakazo/computer:edge");
    }
  });
}
