/** 原文在 sources 中的相对路径是引用标识；兼容直接调用摄取的外部单文件。 */
import { basename, isAbsolute, relative, resolve } from "node:path";

export function sourceFilename(projectPath: string, sourcePath: string): string {
  const path = relative(resolve(projectPath, "raw", "sources"), resolve(sourcePath)).replace(/\\/g, "/");
  return path === ".." || path.startsWith("../") || isAbsolute(path) ? basename(sourcePath) : path;
}
