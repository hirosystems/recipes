import { Hono } from "hono";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import matter from "gray-matter";

const app = new Hono();

const recipesDirectory = join(import.meta.dir, "recipes");

function parseCodeBlocks(mdxContent: string) {
  const codeBlockRegex = /```(\w*)([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = codeBlockRegex.exec(mdxContent)) !== null) {
    const language = match[1];
    const code = match[2].trim();
    blocks.push({ language, code });
  }
  return blocks;
}

interface FileInfo {
  name: string;
  path: string;
  type: string;
}

app.get("/registry/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const filePath = join(recipesDirectory, `${id}.mdx`);
    const content = await readFile(filePath, "utf-8");
    const { data, content: mdxContent } = matter(content);
    const codeBlocks = parseCodeBlocks(mdxContent);
    return c.json({
      recipeId: id,
      codeBlocks,
      dependencies: data.dependencies || {},
      files: data.files as FileInfo[],
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return c.json({ error: "Recipe not found" }, 404);
    }
    console.error(`Error reading recipe ${id}:`, error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/recipes", async (c) => {
  try {
    const files = await readdir(recipesDirectory);
    const recipes = files
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => file.replace(".mdx", ""));
    return c.json(recipes);
  } catch (error) {
    console.error("Error reading recipes directory:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;
