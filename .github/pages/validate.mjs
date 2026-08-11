import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pagesDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(pagesDirectory, "..", "..");
const sourceDirectory = path.join(pagesDirectory, ".build", "source");
const layout = fs.readFileSync(
  path.join(pagesDirectory, "_layouts", "default.html"),
  "utf8",
);
const styles = fs.readFileSync(
  path.join(pagesDirectory, "assets", "css", "page.scss"),
  "utf8",
);
const config = fs.readFileSync(
  path.join(pagesDirectory, "_config.yml"),
  "utf8",
);
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "pages.yml"),
  "utf8",
);
const errors = [];
const generatedReadmes = ["index.md", "README.zh-CN.md"].map((file) =>
  fs.readFileSync(path.join(sourceDirectory, file), "utf8"),
);

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) errors.push(message);
}

function rejectMatch(source, pattern, message) {
  if (pattern.test(source)) errors.push(message);
}

requireMatch(
  layout,
  /<script src="\/shared\/site-shell\.js" defer><\/script>/,
  "Layout must load the shared site shell.",
);
requireMatch(
  layout,
  /<shen-site-header><\/shen-site-header>/,
  "Layout is missing the shared header.",
);
requireMatch(
  layout,
  /<shen-site-footer><\/shen-site-footer>/,
  "Layout is missing the shared footer.",
);
requireMatch(
  layout,
  /href="\{\{ site\.url \}\}\/project\/"/,
  "Layout must link back to the portfolio project page.",
);
rejectMatch(
  layout,
  /\b(?:postMessage|MessageEvent)\b|\/shared\/(?!site-shell\.js)/i,
  "Layout must not duplicate the shared shell.",
);

requireMatch(
  styles,
  /html\[data-theme="dark"\]/,
  "Styles must respond to the shared shell dark theme.",
);
requireMatch(
  styles,
  /@media \(prefers-color-scheme: dark\)/,
  "Styles must retain a system dark-theme fallback.",
);
requireMatch(
  styles,
  /> \.repo-actions \+ div\[align="center"\]/,
  "Styles must target the README hero after the repository actions.",
);
requireMatch(
  styles,
  /\.markdown-body table tr[\s\S]*?background:\s*var\(--repo-bg\)/,
  "Table rows must use a theme-aware background.",
);
requireMatch(
  styles,
  /\.repo-button-primary[\s\S]*?linear-gradient\(/,
  "The primary repository action must retain the compact portfolio treatment.",
);
requireMatch(
  styles,
  /\.markdown-body \.highlight pre[\s\S]*?background:\s*var\(--repo-surface\)/,
  "Highlighted code blocks must use a theme-aware surface.",
);
requireMatch(
  styles,
  /@mixin repo-dark-theme[\s\S]*?\.markdown-body \.highlight span[\s\S]*?color:\s*var\(--repo-text\)/,
  "Dark-mode syntax tokens must remain readable.",
);
requireMatch(
  styles,
  /@mixin repo-dark-theme[\s\S]*?\.markdown-body img[\s\S]*?filter:\s*brightness\(/,
  "Dark-mode content images must reduce light-surface glare.",
);
for (const match of styles.matchAll(/--([\w-]+)\s*:/g)) {
  if (!match[1].startsWith("repo-"))
    errors.push(
      "Page styles may define only repository-scoped custom properties.",
    );
}

requireMatch(
  config,
  /^baseurl:\s*\/paper-daily-feed\s*$/m,
  "Jekyll base URL must match the project page.",
);
requireMatch(
  workflow,
  /node \.github\/pages\/build-source\.mjs/,
  "Pages workflow must prepare the isolated source directory.",
);
requireMatch(
  workflow,
  /actions\/deploy-pages@v5/,
  "Pages workflow must deploy through the supported Pages action.",
);

for (const forbiddenRootPath of [
  "_config.yml",
  "_layouts",
  "assets/css/page.scss",
]) {
  if (fs.existsSync(path.join(repositoryRoot, forbiddenRootPath))) {
    errors.push(
      `Pages implementation must not create ${forbiddenRootPath} at the repository root.`,
    );
  }
}

for (const generatedPath of [
  "index.md",
  "README.zh-CN.md",
  "docs/email_header_example.svg",
  "config/app.example.jsonc",
]) {
  if (!fs.existsSync(path.join(sourceDirectory, generatedPath))) {
    errors.push(`Generated Pages source is missing ${generatedPath}.`);
  }
}

for (const generatedReadme of generatedReadmes) {
  rejectMatch(
    generatedReadme,
    /:(?:email|closed_book|robot):|> \[!TIP\]/,
    "Generated pages must not expose unsupported GitHub Markdown markers.",
  );
  requireMatch(
    generatedReadme,
    /<details markdown="1">/,
    "Details blocks must opt into Kramdown parsing.",
  );
}

if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  process.exitCode = 1;
} else {
  console.log("Validated the isolated Pages source and shared-shell boundary.");
}
