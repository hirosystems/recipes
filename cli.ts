#!/usr/bin/env bun
import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { resolve, dirname, basename } from "path";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { join } from "path";

const program = new Command();

// Add this language extension mapping
const languageExtensionMap: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  clarity: "clar",
  bash: "sh",
};

const execAsync = promisify(exec);

async function detectPackageManager(
  directory: string
): Promise<"npm" | "yarn" | "pnpm" | "bun"> {
  // Check for lockfiles first
  if (existsSync(join(directory, "bun.lockb"))) {
    // Verify bun is actually available
    try {
      await execAsync("bun --version");
      return "bun";
    } catch {
      // Fallback if bun command isn't available
    }
  }
  if (existsSync(join(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(directory, "yarn.lock"))) return "yarn";

  // If no lockfile exists, prefer npm for npm-initialized projects
  if (existsSync(join(directory, "package.json"))) {
    try {
      const packageJson = JSON.parse(
        await readFile(join(directory, "package.json"), "utf-8")
      );
      // Check if this was initialized as a Bun project
      if (packageJson.module || packageJson.type === "module") {
        try {
          await execAsync("bun --version");
          return "bun";
        } catch {
          // Fallback if bun isn't available
        }
      }
    } catch {
      // If we can't read package.json, fall back to npm
    }
  }

  return "npm"; // default to npm
}

async function installDependencies(
  directory: string,
  dependencies: Record<string, string>
) {
  if (Object.keys(dependencies).length === 0) return;

  const packageManager = await detectPackageManager(directory);
  const s = p.spinner();
  s.start("Installing dependencies");

  try {
    const deps = Object.entries(dependencies)
      .map(([name, version]) => `${name}@${version}`)
      .join(" ");

    const installCommands = {
      npm: `npm install ${deps}`,
      yarn: `yarn add ${deps}`,
      pnpm: `pnpm add ${deps}`,
      bun: `bun add ${deps}`,
    };

    const command = installCommands[packageManager];
    // Add shell: true for Windows compatibility and PATH resolution
    await execAsync(command, {
      cwd: directory,
      shell: process.platform === "win32" ? "cmd" : "bash",
      env: { ...process.env, PATH: process.env.PATH },
    });
    s.stop("Dependencies installed successfully");
  } catch (error) {
    s.stop("Failed to install dependencies");
    throw error;
  }
}

async function fetchUrl(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}, status: ${response.status}`);
  }
  return response.json();
}

function cleanCodeBlock(code: string, language: string): string {
  // Define comment styles for different languages
  const commentStyles: Record<
    string,
    { single?: string; multi?: [string, string] }
  > = {
    typescript: { single: "//", multi: ["/*", "*/"] },
    javascript: { single: "//", multi: ["/*", "*/"] },
    clarity: { single: ";;" },
    bash: { single: "#" },
  };

  const style = commentStyles[language.toLowerCase()] || { single: "//" };

  // Split into lines for processing
  const lines = code.split("\n");

  // Filter out lines containing special markers
  const cleanedLines = lines.filter((line) => {
    const trimmedLine = line.trim();

    // Check single-line comments with markers
    if (
      style.single &&
      trimmedLine.startsWith(style.single) &&
      trimmedLine.includes("!")
    ) {
      return false;
    }

    // Check multi-line comments with markers if defined
    if (
      style.multi &&
      trimmedLine.startsWith(style.multi[0]) &&
      trimmedLine.includes("!") &&
      trimmedLine.includes(style.multi[1])
    ) {
      return false;
    }

    return true;
  });

  return cleanedLines.join("\n");
}

interface ProjectTemplate {
  label: string;
  value: string;
  hint?: string;
}

const projectTemplates: ProjectTemplate[] = [
  {
    label: "Bun",
    value: "bun",
    hint: "Initialize a basic Bun project",
  },
  {
    label: "Node.js",
    value: "npm",
    hint: "Initialize a basic Node.js project",
  },
  {
    label: "Vite",
    value: "vite",
    hint: "Create a new Vite project",
  },
  {
    label: "Next.js",
    value: "next",
    hint: "Create a new Next.js project",
  },
];

async function initializeProject(directory: string): Promise<string> {
  const hasPackageJson = existsSync(join(directory, "package.json"));

  if (!hasPackageJson) {
    p.log.warn(
      chalk.yellow("\nNo package.json found in the current directory.")
    );

    const shouldInit = await p.confirm({
      message: "Would you like to initialize a new project?",
      initialValue: true,
    });

    if (p.isCancel(shouldInit) || !shouldInit) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const template = await p.select({
      message: "Select a project template:",
      options: projectTemplates,
    });

    if (p.isCancel(template)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const projectLocation = await p.text({
      message: "Where would you like to initialize this project?",
      placeholder:
        template === "next"
          ? "next-app"
          : template === "vite"
          ? "vite-project"
          : "my-app",
      initialValue:
        template === "next"
          ? "next-app"
          : template === "vite"
          ? "vite-project"
          : "my-app",
    });

    if (p.isCancel(projectLocation)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const projectDir = resolve(directory, projectLocation);
    const projectName = basename(projectDir);

    // Check if directory already exists
    if (existsSync(projectDir)) {
      p.log.error(
        chalk.red(
          `Directory ${projectDir} already exists. Please choose a different location.`
        )
      );
      process.exit(1);
    }

    const s = p.spinner();
    s.start("Creating project directory");

    try {
      switch (template) {
        case "bun":
          // Create directory first for bun
          await mkdir(projectDir, { recursive: true });
          s.stop("Project directory created");
          s.start("Initializing project");
          await execAsync("bun init", { cwd: projectDir });
          break;
        case "npm":
          // Create directory first for npm
          await mkdir(projectDir, { recursive: true });
          s.stop("Project directory created");
          s.start("Initializing project");
          await execAsync("npm init -y", { cwd: projectDir });
          break;
        case "vite":
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              "npm",
              [
                "create",
                "vite@latest",
                projectName,
                "--",
                "--template",
                "react-ts",
              ],
              {
                stdio: ["inherit", "pipe", "pipe"],
                cwd: directory,
                env: { ...process.env, PATH: process.env.PATH },
              }
            );

            child.stderr.on("data", (data) => {
              const error = data.toString();
              if (error.includes("ERR!")) {
                p.log.error(chalk.red(error));
              }
            });

            child.on("error", (err) => reject(err));

            child.on("close", (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`Vite process exited with code ${code}`));
              }
            });
          });
          s.stop("Project initialized successfully");
          return projectDir;

        case "next":
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              "npx",
              ["create-next-app@latest", projectName],
              {
                stdio: ["inherit", "pipe", "pipe"],
                cwd: directory,
                env: { ...process.env, PATH: process.env.PATH },
              }
            );

            child.stderr.on("data", (data) => {
              const error = data.toString();
              if (error.includes("ERR!")) {
                p.log.error(chalk.red(error));
              }
            });

            child.on("error", (err) => reject(err));

            child.on("close", (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`Next.js process exited with code ${code}`));
              }
            });
          });
          s.stop("Project initialized successfully");
          return projectDir;
      }
    } catch (error) {
      s.stop("Failed to initialize project");
      // Clean up the directory if initialization failed
      try {
        if (existsSync(projectDir)) {
          await rm(projectDir, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        p.log.warn(chalk.yellow(`Failed to clean up directory ${projectDir}`));
      }
      throw error;
    }
    s.stop("Project initialized successfully");
    return projectDir;
  }

  return directory;
}

async function addRecipe(url: string, targetDir: string = process.cwd()) {
  const s = p.spinner();
  s.start("Writing code blocks");

  try {
    const { recipeId, codeBlocks, dependencies, files, error } = await fetchUrl(
      url
    );

    if (error) {
      s.stop("Error fetching recipe");
      p.log.error(chalk.red(`Error from registry: ${error}`));
      process.exit(1);
    }

    if (!Array.isArray(codeBlocks) || codeBlocks.length === 0) {
      s.stop("No code blocks found");
      p.log.warn(chalk.yellow("No code blocks found in registry response."));
      process.exit(1);
    }

    // Determine if we need a directory or just a single file
    const isSingleFile = files && files.length === 1;
    let workingDir = targetDir;

    if (!isSingleFile) {
      const recipeDir = await p.text({
        message: "Where would you like to save the recipe?",
        placeholder: `./${recipeId || "untitled-recipe"}`,
        initialValue: `./${recipeId || "untitled-recipe"}`,
      });

      if (p.isCancel(recipeDir)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }

      workingDir = resolve(targetDir, recipeDir as string);
    }

    // No second call to `initializeProject` here; we assume we're already in the project directory

    for (const [index, block] of codeBlocks.entries()) {
      let filePath;
      if (isSingleFile) {
        // Use the path from files frontmatter for single file
        const fileInfo = files[0];
        filePath = resolve(workingDir, fileInfo.path);
        // Ensure directory exists for the file
        await mkdir(dirname(filePath), { recursive: true });
      } else {
        // Use the files info if available, otherwise fall back to index-based naming
        const fileInfo = files?.[index];
        if (fileInfo) {
          filePath = resolve(workingDir, fileInfo.path);
          await mkdir(dirname(filePath), { recursive: true });
        } else {
          const mappedExtension = block.language
            ? languageExtensionMap[block.language.toLowerCase()]
            : null;
          let extension = mappedExtension ? `.${mappedExtension}` : ".txt";
          if (
            !mappedExtension &&
            block.language &&
            /^[a-zA-Z0-9]+$/.test(block.language)
          ) {
            extension = `.${block.language}`;
          }
          filePath = resolve(workingDir, `code-block-${index + 1}${extension}`);
        }
      }

      const cleanedCode = cleanCodeBlock(block.code, block.language);
      await writeFile(filePath, cleanedCode, "utf-8");
    }

    s.stop("Code blocks written successfully");

    if (dependencies) {
      await installDependencies(workingDir, dependencies);
    }

    p.outro(
      chalk.green(
        `Recipe '${recipeId}' has been added successfully${
          isSingleFile ? "" : ` to ${workingDir}`
        }`
      )
    );
  } catch (err) {
    s.stop("Error occurred");
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error occurred";
    p.log.error(
      chalk.red(`Failed to fetch or write code blocks: ${errorMessage}`)
    );
    process.exit(1);
  }
}

program
  .name("hiro")
  .description("CLI for managing Hiro recipes")
  .version("1.0.0");

program
  .command("add <url>")
  .description("Add a new recipe from a given URL")
  .action(async (url: string) => {
    try {
      // First, initialize the project if needed
      const projectDir = await initializeProject(process.cwd());

      // Then add the recipe to the initialized project directory
      await addRecipe(url, projectDir);
    } catch (error) {
      p.log.error(chalk.red(`Failed to add recipe: ${error}`));
      process.exit(1);
    }
  });

program.parse();
