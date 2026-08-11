import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pagesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(pagesDirectory, "..", "..");
const buildRoot = path.join(pagesDirectory, ".build");
const sourceDirectory = path.join(buildRoot, "source");
const repositoryUrl = "https://github.com/nehSgnaiL/paper-daily-feed";

fs.rmSync(sourceDirectory, { recursive: true, force: true });
fs.mkdirSync(sourceDirectory, { recursive: true });

function copyIntoSource(sourceRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    fs.cpSync(
      path.join(sourceRoot, relativePath),
      path.join(sourceDirectory, relativePath),
      { recursive: true },
    );
  }
}

copyIntoSource(pagesDirectory, ["_config.yml", "_layouts", "assets"]);
copyIntoSource(repositoryRoot, ["docs", "config/app.example.jsonc"]);

function prepareReadme(relativePath, permalink) {
  const source = fs.readFileSync(
    path.join(repositoryRoot, relativePath),
    "utf8",
  );
  const tipLabel = relativePath === "README.zh-CN.md" ? "提示" : "Tip";
  const pageContent = source
    .replace(
      "[English](./README.md) | [简体中文](./README.zh-CN.md)",
      '<nav class="language-switcher" aria-label="Language"><a href="./">English</a><span aria-hidden="true">·</span><a href="./README.zh-CN.html">简体中文</a></nav>',
    )
    .replaceAll("(../../settings/", `(${repositoryUrl}/settings/`)
    .replaceAll("(../../actions", `(${repositoryUrl}/actions`)
    .replaceAll("(./.github/", `(${repositoryUrl}/blob/main/.github/`)
    .replaceAll(":email:", "Email · ")
    .replaceAll(":closed_book:", "Zotero · ")
    .replaceAll(":robot:", "AI · ")
    .replaceAll("> [!TIP]", `> **${tipLabel}:**`)
    .replaceAll("<details close>", '<details markdown="1">');

  return `---\nlayout: default\npermalink: ${permalink}\n---\n\n${pageContent}`;
}

fs.writeFileSync(
  path.join(sourceDirectory, "index.md"),
  prepareReadme("README.md", "/"),
);
fs.writeFileSync(
  path.join(sourceDirectory, "README.zh-CN.md"),
  prepareReadme("README.zh-CN.md", "/README.zh-CN.html"),
);

console.log(
  `Prepared Pages source in ${path.relative(repositoryRoot, sourceDirectory)}`,
);
