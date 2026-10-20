import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "loft-mirror-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = {
    version: "0.1.99-manual.1",
    commit: "a".repeat(40),
    notarized: true,
    automaticUpdates: true,
    files: { arm64: {}, x64: {} },
  };
  const bodies = new Map();
  for (const arch of ["arm64", "x64"]) {
    for (const kind of ["dmg", "zip"]) {
      const body = Buffer.from(`${arch} ${kind}`);
      const name = `Loft-0.1.99-manual.1-${arch}.${kind}`;
      bodies.set(`/${name}`, body);
      release.files[arch][kind] = {
        name,
        size: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        sha512: createHash("sha512").update(body).digest("base64"),
      };
    }
  }
  const server = createServer((request, response) => {
    const body = bodies.get(request.url);
    response.writeHead(body ? 200 : 404);
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const output = join(root, "output");
  const source = join(root, "source.json");
  const run = async () => {
    await writeFile(source, JSON.stringify(release));
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["scripts/prepare-release.mjs", "assets", source, output],
        {
          env: {
            ...process.env,
            SOURCE_BASE_URL: `http://127.0.0.1:${server.address().port}/`,
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  };
  return { release, bodies, output, run };
}

test("mirrors four verified native artifacts with architecture-specific public URLs", async (t) => {
  const { output, run } = await fixture(t);
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const mirrored = JSON.parse(
    await readFile(join(output, "release.json"), "utf8"),
  );
  for (const arch of ["arm64", "x64"]) {
    for (const kind of ["dmg", "zip"]) {
      const name = `Loft-manual-latest-${arch}.${kind}`;
      assert.equal(
        await readFile(join(output, name), "utf8"),
        `${arch} ${kind}`,
      );
      assert.equal(
        mirrored.downloads[arch][kind],
        `https://github.com/ArcheMind/loft-releases/releases/download/manual-v0.1.99-manual.1/${name}`,
      );
    }
  }
  assert.match(
    await readFile(join(output, "INSTALL.txt"), "utf8"),
    /Apple Silicon.*Intel/,
  );
  assert.match(
    await readFile(join(output, "RELEASE_NOTES.md"), "utf8"),
    /Apple notarization: complete/,
  );
});

test("refuses metadata missing one architecture", async (t) => {
  const { release, run } = await fixture(t);
  delete release.files.x64;
  const result = await run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /arm64 and x64/);
});

test("refuses corrupted bytes before producing publishable metadata", async (t) => {
  const { bodies, output, run } = await fixture(t);
  bodies.set("/Loft-0.1.99-manual.1-x64.zip", Buffer.from("corrupt"));
  const result = await run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /checksum|size/i);
  await assert.rejects(readFile(join(output, "release.json")), {
    code: "ENOENT",
  });
});
