#!/usr/bin/env bun
import { Command } from "commander";
import * as p from "@clack/prompts";
import prompts from "prompts";
import chalk from "chalk";
import { resolve, dirname, basename } from "path";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { API_URL } from "./lib/config";

const program = new Command();

// Add this language extension mapping
const languageExtensionMap: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  clarity: "clar",
  bash: "sh",
};

const execAsync = promisify(exec);

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

async function detectPackageManager(
  directory: string,
  preferredManager?: PackageManager
): Promise<PackageManager> {
  // If preferred manager is specified, verify it's available

  if (preferredManager) {
    try {
      const command =
        preferredManager === "bun"
          ? "bun --version"
          : `${preferredManager} --version`;
      await execAsync(command);
      return preferredManager;
    } catch {
      // Fallback to auto-detection if preferred manager isn't available
      p.log.warn(
        chalk.yellow(
          `${preferredManager} is not available, falling back to auto-detection`
        )
      );
    }
  }

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
  dependencies: Record<string, string>,
  preferredManager?: PackageManager
) {
  if (Object.keys(dependencies).length === 0) return;

  const packageManager = await detectPackageManager(
    directory,
    preferredManager
  );

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
    await execAsync(command, {
      cwd: directory,
      shell: process.platform === "win32" ? "cmd" : "bash",
      env: { ...process.env, PATH: process.env.PATH },
    });
  } catch (error) {
    p.log.error(chalk.red("Failed to install dependencies"));
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
    hint: "bun init",
  },
  {
    label: "Node.js",
    value: "npm",
    hint: "npm init -y",
  },
  {
    label: "Vite",
    value: "vite",
    hint: "npm create vite@latest",
  },
];

async function initializeProject(
  directory: string
): Promise<{ projectDir: string; preferredManager?: PackageManager }> {
  const hasPackageJson = existsSync(join(directory, "package.json"));

  if (!hasPackageJson) {
    p.log.warn(
      chalk.yellow("\nNo package.json found in the current directory.")
    );

    const shouldInit = await p.confirm({
      message: "Add recipe to new project?",
      initialValue: true,
    });

    if (p.isCancel(shouldInit) || !shouldInit) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const template = await p.select({
      message: "Select a template:",
      options: projectTemplates,
    });

    if (p.isCancel(template)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    let projectLocation;
    let projectDir;
    let dirExists = true;

    while (dirExists) {
      projectLocation = await p.text({
        message: "Project name:",
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

      projectDir = resolve(directory, projectLocation);

      if (existsSync(projectDir)) {
        const action = await p.select({
          message: `Target directory "${projectLocation}" is not empty. Please choose how to proceed:`,
          options: [
            { value: "cancel", label: "Cancel operation" },
            { value: "remove", label: "Remove existing files and continue" },
            { value: "try-again", label: "Choose another name" },
          ],
        });

        if (p.isCancel(action) || action === "cancel") {
          p.cancel("Operation cancelled.");
          process.exit(0);
        } else if (action === "remove") {
          try {
            await rm(projectDir, { recursive: true, force: true });
            dirExists = false;
          } catch (error) {
            p.log.error(chalk.red(`Failed to remove directory ${projectDir}`));
            throw error;
          }
        } else if (action === "try-again") {
          continue; // This will loop back to the project name prompt
        }
      } else {
        dirExists = false;
      }
    }

    let preferredManager: PackageManager | undefined;

    if (template === "vite") {
      preferredManager = (await p.select({
        message: "Select package manager:",
        options: [
          { value: "npm", label: "npm" },
          { value: "yarn", label: "yarn" },
          { value: "pnpm", label: "pnpm" },
          { value: "bun", label: "bun" },
        ],
      })) as PackageManager;

      if (p.isCancel(preferredManager)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }
    }

    if (!projectDir) {
      throw new Error("Project directory is undefined");
    }

    const projectName = basename(projectDir);

    try {
      switch (template) {
        case "bun":
          await mkdir(projectDir, { recursive: true });
          await execAsync("bun init", { cwd: projectDir });
          break;
        case "npm":
          await mkdir(projectDir, { recursive: true });
          await execAsync("npm init -y", { cwd: projectDir });
          break;
        case "vite":
          await p.tasks([
            {
              title: "Creating project",
              task: async (message) => {
                const packageManager = await detectPackageManager(
                  directory,
                  preferredManager
                );
                await new Promise<void>((resolve, reject) => {
                  const createCommand =
                    packageManager === "npm"
                      ? [
                          "create",
                          "vite@latest",
                          projectName,
                          "--",
                          "--template",
                          "react-ts",
                        ]
                      : [
                          "create",
                          "vite",
                          projectName,
                          "--template",
                          "react-ts",
                        ];

                  const child = spawn(packageManager, createCommand, {
                    stdio: ["inherit", "pipe", "pipe"],
                    cwd: directory,
                    env: { ...process.env, PATH: process.env.PATH },
                  });

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
                      reject(
                        new Error(`Vite process exited with code ${code}`)
                      );
                    }
                  });
                });
                return "Project created";
              },
            },
          ]);
      }
    } catch (error) {
      p.log.error(chalk.red("Failed to initialize project"));
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
    return { projectDir, preferredManager };
  }

  return { projectDir: directory };
}

async function addRecipe(
  url: string,
  targetDir: string = process.cwd(),
  preferredManager?: PackageManager
): Promise<string> {
  try {
    const { recipeId, codeBlocks, dependencies, files, error } = await fetchUrl(
      url
    );

    if (error) {
      p.log.error(chalk.red(`Error from registry: ${error}`));
      process.exit(1);
    }

    if (!Array.isArray(codeBlocks) || codeBlocks.length === 0) {
      p.log.warn(chalk.yellow("No code blocks found in registry response."));
      process.exit(1);
    }

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

    if (dependencies) {
      await installDependencies(workingDir, dependencies, preferredManager);
    }

    return `'${recipeId}' has been added successfully${
      isSingleFile ? "" : ` to ${workingDir}`
    }`;
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error occurred";
    throw new Error(`Failed to fetch or write code blocks: ${errorMessage}`);
  }
}

program
  .name("hiro")
  .description("CLI for managing Hiro recipes")
  .version("1.0.0");

program
  .command("add [url]")
  .description("Add a new recipe from a URL or select from available recipes")
  .action(async (url?: string) => {
    try {
      if (!url) {
        const response = await fetch(`${API_URL}/recipes`);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch recipes, status: ${response.status}`
          );
        }
        const recipes = await response.json();

        if (!Array.isArray(recipes) || recipes.length === 0) {
          p.log.warn(chalk.yellow("No recipes available."));
          process.exit(0);
        }

        const selectedRecipes = await p.multiselect({
          message: "Hit [SPACE] to select recipes:",
          options: recipes.map((recipe) => ({
            value: recipe,
            label: recipe,
          })),
          required: true,
        });

        if (p.isCancel(selectedRecipes)) {
          p.cancel("Operation cancelled.");
          process.exit(0);
        }

        const { projectDir, preferredManager } = await initializeProject(
          process.cwd()
        );

        if (Array.isArray(selectedRecipes) && selectedRecipes.length > 0) {
          const spinner = p.spinner();
          spinner.start("Adding recipes...");

          const results: string[] = [];
          for (const recipeId of selectedRecipes) {
            try {
              const result = await addRecipe(
                `http://localhost:3000/registry/${recipeId}`,
                projectDir,
                preferredManager
              );
              results.push(result);
            } catch (error) {
              spinner.stop(`Failed to add recipe ${recipeId}: ${error}`);
              process.exit(1);
            }
          }

          if (selectedRecipes.length === 1) {
            spinner.stop("Recipe added");
          } else {
            spinner.stop("All recipes added");
          }

          // Output all results together
          results.forEach((result) => {
            p.log.success(chalk.green(`└ ${result}`));
          });

          p.outro("Done");
        }
      } else {
        // Single URL case
        const { projectDir, preferredManager } = await initializeProject(
          process.cwd()
        );
        const spinner = p.spinner();
        spinner.start("Adding recipe...");

        const result = await addRecipe(url, projectDir, preferredManager);
        spinner.stop("Recipe added");
        p.log.success(chalk.green(`└ ${result}`));
        p.outro("Completed");
      }
    } catch (error) {
      p.log.error(chalk.red(`Failed to add recipe: ${error}`));
      process.exit(1);
    }
  });

program.parse();
