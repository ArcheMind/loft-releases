import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const run = promisify(execFile);

const [action, sourcePath, outputDirectory] = process.argv.slice(2);
const release = JSON.parse(await readFile(sourcePath, "utf8"));
console.info("[manual-release] source metadata", JSON.stringify(release));
if (
  !/^0\.1\.\d+-manual\.\d+$/.test(release.version) ||
  !/^[0-9a-f]{40}$/.test(release.commit)
) {
  throw new Error("Invalid manual release identity");
}
if (release.notarized !== true || release.automaticUpdates !== true) {
  throw new Error(
    "Manual release must be notarized and support automatic updates",
  );
}
if (
  Object.keys(release.files ?? {})
    .sort()
    .join(",") !== "arm64,x64"
) {
  throw new Error("Manual release must include exactly arm64 and x64");
}
for (const arch of ["arm64", "x64"]) {
  for (const kind of ["dmg", "zip"]) {
    const file = release.files[arch][kind];
    if (
      file?.name !== `Loft-${release.version}-${arch}.${kind}` ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0
    ) {
      throw new Error(`Invalid ${arch} ${kind} release metadata`);
    }
  }
}
const tag = `manual-v${release.version}`;
if (action === "metadata") {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${release.version}\ntag=${tag}\ncommit=${release.commit}\n`,
  );
} else if (action === "assets" && outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const releaseBase = `https://github.com/ArcheMind/loft-releases/releases/download/${tag}/`;
  release.hosting = "github-release";
  release.releasePage = `https://github.com/ArcheMind/loft-releases/releases/tag/${tag}`;
  release.downloads = { arm64: {}, x64: {} };
  const checksums = [];
  for (const arch of ["arm64", "x64"]) {
    for (const kind of ["dmg", "zip"]) {
      const file = release.files[arch][kind];
      const sourceUrl = new URL(
        file.name,
        `${process.env.SOURCE_BASE_URL.replace(/\/$/, "")}/`,
      );
      const name = `Loft-manual-latest-${arch}.${kind}`;
      const destination = path.join(outputDirectory, name);
      const args = [
        "--fail",
        "--location",
        "--retry",
        "6",
        "--retry-delay",
        "5",
        sourceUrl.href,
        "--output",
        destination,
      ];
      console.info("[manual-release] download", "curl", JSON.stringify(args));
      const { stdout, stderr } = await run("curl", args);
      console.info("[manual-release] curl output", stdout, stderr);
      const sha256 = createHash("sha256");
      const sha512 = createHash("sha512");
      let size = 0;
      for await (const chunk of createReadStream(destination)) {
        sha256.update(chunk);
        sha512.update(chunk);
        size += chunk.length;
      }
      if (
        size !== file.size ||
        sha256.digest("hex") !== file.sha256 ||
        sha512.digest("base64") !== file.sha512
      ) {
        throw new Error(`Checksum or size mismatch: ${sourceUrl}`);
      }
      console.info(
        "[manual-release] verified",
        name,
        size,
        file.sha256,
        file.sha512,
      );
      release.downloads[arch][kind] = `${releaseBase}${name}`;
      checksums.push(
        `- ${arch} ${kind.toUpperCase()} SHA-256: \`${file.sha256}\``,
      );
    }
  }
  await writeFile(
    path.join(outputDirectory, "release.json"),
    `${JSON.stringify(release, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDirectory, "INSTALL.txt"),
    [
      `Loft manual distribution ${release.version}`,
      "",
      "Native macOS builds for Apple Silicon (arm64) and Intel (x64).",
      "Developer ID signed and notarized by Apple.",
      "Choose the DMG matching your Mac, open it, and drag Loft to Applications.",
      "Turn on automatic updates in Settings to receive newer manual builds.",
      "",
      "Download page: https://loft.archemind.org/download/",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(outputDirectory, "RELEASE_NOTES.md"),
    [
      "## Loft manual beta",
      "",
      "Native macOS builds for Apple Silicon and Intel.",
      "",
      `- Version: \`${release.version}\``,
      `- Source commit: \`${release.commit}\``,
      ...checksums,
      "- Automatic updates: available in Settings",
      "- Apple notarization: complete",
      "",
      "Choose your Mac chip on the [Loft download page](https://loft.archemind.org/download/).",
      "",
    ].join("\n"),
  );
} else {
  throw new Error(
    "Usage: node scripts/prepare-release.mjs <metadata|assets> <source.json> [output-dir]",
  );
}
